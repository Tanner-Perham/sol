import { StateField, StateEffect, Prec } from "@codemirror/state";
import { Decoration, EditorView, ViewUpdate, keymap, showTooltip } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { invoke, Channel } from "@tauri-apps/api/core";
import { acceptCompletionAnnotation } from "./ghostTextExtension";

export interface ReworkSession {
  range: { from: number; to: number };
  path: string;
  instruction: string;
  result: string;
  status: "idle" | "input" | "streaming" | "done" | "error";
  requestId: string | null;
}

// Effects and annotations
export const openRework = StateEffect.define<{ from: number; to: number; path: string }>();
export const updateReworkResult = StateEffect.define<{ result: string; status: ReworkSession["status"]; requestId?: string | null }>();
export const closeRework = StateEffect.define<void>();

export const activeFileField = StateField.define<string | null>({
  create: () => null,
  update: (value) => value
});

export const reworkStateField = StateField.define<ReworkSession | null>({
  create() {
    return null;
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openRework)) {
        return {
          range: { from: effect.value.from, to: effect.value.to },
          path: effect.value.path,
          instruction: "",
          result: "",
          status: "input",
          requestId: null
        };
      }
      if (effect.is(updateReworkResult)) {
        if (!value) return null;
        return {
          ...value,
          result: effect.value.result,
          status: effect.value.status,
          requestId: effect.value.requestId !== undefined ? effect.value.requestId : value.requestId
        };
      }
      if (effect.is(closeRework)) {
        return null;
      }
    }

    // Cancel rework if document changes (excluding accept transaction changes)
    if (tr.docChanged && value) {
      const isAccept = tr.annotation(acceptCompletionAnnotation);
      if (!isAccept) {
        return null;
      }
    }

    return value;
  },

  provide: (f) => [
    EditorView.decorations.from(f, (session) => {
      if (session && session.range) {
        return Decoration.set([
          Decoration.mark({ class: "cm-rework-source" }).range(session.range.from, session.range.to)
        ]);
      }
      return Decoration.none;
    }),
    showTooltip.from(f, (session) => {
      if (!session) return null;
      return {
        pos: session.range.to,
        above: true,
        arrow: true,
        create(view) {
          return new ReworkTooltip(view);
        }
      };
    })
  ]
});

class ReworkTooltip {
  dom: HTMLElement;
  input!: HTMLInputElement;
  preview!: HTMLPreElement;
  actions!: HTMLDivElement;
  submitBtn!: HTMLButtonElement;
  acceptBtn!: HTMLButtonElement;
  retryBtn!: HTMLButtonElement;
  cancelBtn!: HTMLButtonElement;

  constructor(readonly view: EditorView) {
    const session = view.state.field(reworkStateField);
    if (!session) {
      this.dom = document.createElement("div");
      return;
    }

    this.dom = document.createElement("div");
    this.dom.className = "cm-rework-tooltip";
    this.dom.style.background = "var(--bg-card, #1a1a20)";
    this.dom.style.border = "1px solid var(--border, #2d2d38)";
    this.dom.style.borderRadius = "8px";
    this.dom.style.padding = "10px";
    this.dom.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.4)";
    this.dom.style.display = "flex";
    this.dom.style.flexDirection = "column";
    this.dom.style.gap = "8px";
    this.dom.style.width = "300px";
    this.dom.style.fontFamily = "var(--font-sans, system-ui, sans-serif)";
    this.dom.style.zIndex = "100";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Instruction (e.g. make concise)...";
    this.input.value = session.instruction || "";
    this.input.style.width = "100%";
    this.input.style.background = "var(--bg-dark, #101014)";
    this.input.style.border = "1px solid var(--border, #2d2d38)";
    this.input.style.borderRadius = "4px";
    this.input.style.padding = "6px 8px";
    this.input.style.color = "var(--text-primary, #ffffff)";
    this.input.style.fontSize = "12px";
    this.input.style.outline = "none";
    this.input.style.boxSizing = "border-box";
    this.dom.appendChild(this.input);

    this.preview = document.createElement("pre");
    this.preview.style.margin = "0";
    this.preview.style.padding = "6px 8px";
    this.preview.style.background = "var(--bg-dark, #101014)";
    this.preview.style.border = "1px solid var(--border, #2d2d38)";
    this.preview.style.borderRadius = "4px";
    this.preview.style.maxHeight = "100px";
    this.preview.style.overflowY = "auto";
    this.preview.style.whiteSpace = "pre-wrap";
    this.preview.style.wordBreak = "break-all";
    this.preview.style.fontSize = "12px";
    this.preview.style.color = "var(--text-primary, #ffffff)";
    this.preview.style.display = "none";
    this.dom.appendChild(this.preview);

    this.actions = document.createElement("div");
    this.actions.style.display = "flex";
    this.actions.style.justifyContent = "flex-end";
    this.actions.style.gap = "6px";
    this.dom.appendChild(this.actions);

    this.cancelBtn = this.createButton("Cancel", "transparent", true);
    this.cancelBtn.addEventListener("click", () => {
      view.dispatch({ effects: closeRework.of() });
      view.focus();
    });
    this.actions.appendChild(this.cancelBtn);

    this.submitBtn = this.createButton("Rewrite", "var(--accent)");
    this.submitBtn.addEventListener("click", () => this.submit());
    this.actions.appendChild(this.submitBtn);

    this.acceptBtn = this.createButton("Accept", "var(--accent)");
    this.acceptBtn.style.display = "none";
    this.acceptBtn.addEventListener("click", () => this.accept());
    this.actions.appendChild(this.acceptBtn);

    this.retryBtn = this.createButton("Retry", "transparent", true);
    this.retryBtn.style.display = "none";
    this.retryBtn.addEventListener("click", () => this.submit());
    this.actions.appendChild(this.retryBtn);

    this.dom.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        view.dispatch({ effects: closeRework.of() });
        view.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const currentSession = view.state.field(reworkStateField);
        if (currentSession && (currentSession.status === "input" || currentSession.status === "done" || currentSession.status === "error")) {
          this.submit();
        }
      } else if (e.key === "y" && e.ctrlKey) {
        e.preventDefault();
        const currentSession = view.state.field(reworkStateField);
        if (currentSession && currentSession.status === "done") {
          this.accept();
        }
      }
    });

    setTimeout(() => this.input.focus(), 50);
  }

  createButton(text: string, bg: string, border = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.background = bg;
    btn.style.color = bg === "var(--accent)" ? "var(--bg-dark, #101014)" : "var(--text-primary, #ffffff)";
    btn.style.border = border ? "1px solid var(--border, #2d2d38)" : "none";
    btn.style.borderRadius = "4px";
    btn.style.padding = "4px 8px";
    btn.style.fontSize = "11px";
    btn.style.fontWeight = "600";
    btn.style.cursor = "pointer";
    return btn;
  }

  update(update: ViewUpdate) {
    const session = update.state.field(reworkStateField);
    if (!session) return;

    if (session.status === "streaming" || session.status === "done" || session.status === "error") {
      this.preview.style.display = "block";
      if (session.status === "streaming") {
        this.preview.textContent = session.result + "█";
        this.preview.style.color = "var(--text-primary)";
        this.submitBtn.style.display = "none";
        this.acceptBtn.style.display = "none";
        this.retryBtn.style.display = "none";
      } else if (session.status === "done") {
        this.preview.textContent = session.result;
        this.preview.style.color = "var(--text-primary)";
        this.submitBtn.style.display = "none";
        this.acceptBtn.style.display = "inline-block";
        this.retryBtn.style.display = "inline-block";
      } else {
        this.preview.textContent = "Error: " + session.result;
        this.preview.style.color = "var(--red, #f87171)";
        this.submitBtn.style.display = "none";
        this.acceptBtn.style.display = "none";
        this.retryBtn.style.display = "inline-block";
      }
    } else {
      this.preview.style.display = "none";
      this.submitBtn.style.display = "inline-block";
      this.acceptBtn.style.display = "none";
      this.retryBtn.style.display = "none";
    }
  }

  async submit() {
    const session = this.view.state.field(reworkStateField);
    if (!session) return;

    const instruction = this.input.value.trim();
    if (!instruction) return;

    const selection = this.view.state.doc.sliceString(session.range.from, session.range.to);
    const requestId = Math.random().toString(36).substring(7);

    this.view.dispatch({
      effects: updateReworkResult.of({
        result: "",
        status: "streaming",
        requestId
      })
    });

    const channel = new Channel<any>();
    let accumulated = "";
    channel.onmessage = (message) => {
      const current = this.view.state.field(reworkStateField);
      if (current && current.requestId === requestId && current.status === "streaming") {
        accumulated += message.token;
        this.view.dispatch({
          effects: updateReworkResult.of({
            result: accumulated,
            status: "streaming"
          })
        });
      }
    };

    try {
      await invoke("cancel_rework");
      await invoke("generate_rework", {
        requestId,
        params: {
          path: session.path,
          selection,
          instruction,
          max_tokens: Math.min(selection.length * 2 + 64, 512),
          seed: Math.floor(Math.random() * 100000)
        },
        channel
      });

      const finalSession = this.view.state.field(reworkStateField);
      if (finalSession && finalSession.requestId === requestId) {
        this.view.dispatch({
          effects: updateReworkResult.of({
            result: accumulated,
            status: "done"
          })
        });
      }
    } catch (err) {
      const finalSession = this.view.state.field(reworkStateField);
      if (finalSession && finalSession.requestId === requestId) {
        this.view.dispatch({
          effects: updateReworkResult.of({
            result: String(err),
            status: "error"
          })
        });
      }
    }
  }

  accept() {
    const session = this.view.state.field(reworkStateField);
    if (!session || !session.result) return;

    let cleaned = session.result.trim();
    
    // Cleanup wrapping quotes
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1).trim();
    } else if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    
    // Cleanup markdown fences
    if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
      const newlineIdx = cleaned.indexOf("\n");
      if (newlineIdx !== -1) {
        cleaned = cleaned.slice(newlineIdx + 1, -3).trim();
      }
    }

    // Cleanup leading labels
    const labels = ["rewritten text:", "rewritten:", "result:", "output:", "here is the rewritten text:"];
    for (const label of labels) {
      if (cleaned.toLowerCase().startsWith(label)) {
        cleaned = cleaned.slice(label.length).trim();
      }
    }

    this.view.dispatch({
      changes: { from: session.range.from, to: session.range.to, insert: cleaned },
      selection: { anchor: session.range.from + cleaned.length },
      effects: closeRework.of(),
      annotations: [acceptCompletionAnnotation.of(true)]
    });

    this.view.focus();
  }
}

export const openReworkCommand = (view: EditorView): boolean => {
  const session = view.state.field(reworkStateField);
  if (session) return false;

  const main = view.state.selection.main;
  if (main.empty) return false;

  const path = view.state.field(activeFileField);
  if (!path) return false;

  const cm = getCM(view);
  if (cm && (cm.state as any)?.vim?.visualMode) {
    Vim.exitVisualMode(cm as any, false);
  }

  view.dispatch({
    effects: openRework.of({ from: main.from, to: main.to, path })
  });
  return true;
};

export const reworkKeymap = Prec.highest(
  keymap.of([
    {
      key: "Alt-k",
      run: openReworkCommand
    }
  ])
);

export function reworkExtension() {
  return [
    activeFileField,
    reworkStateField,
    reworkKeymap
  ];
}
