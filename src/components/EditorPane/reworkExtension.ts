import { StateField, StateEffect, Prec } from "@codemirror/state";
import { Decoration, EditorView, ViewUpdate, keymap, showTooltip, WidgetType } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { invoke, Channel } from "@tauri-apps/api/core";
import { acceptCompletionAnnotation } from "./ghostTextExtension";
import { AppSettings } from "../../types";

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

export const settingsField = StateField.define<{ current: AppSettings } | null>({
  create: () => null,
  update: (value) => value
});

class ReworkGhostBlockWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-rework-ghost-block";
    div.style.color = "var(--text-muted, #808080)";
    div.style.opacity = "0.65";
    div.style.borderLeft = "2px solid var(--accent, #a78bfa)";
    div.style.paddingLeft = "8px";
    div.style.marginLeft = "4px";
    div.style.whiteSpace = "pre-wrap";
    div.style.fontFamily = "var(--font-mono, monospace)";
    div.style.fontSize = "12px";
    div.style.userSelect = "none";
    div.style.pointerEvents = "none";
    div.style.marginTop = "4px";
    div.style.marginBottom = "4px";
    div.textContent = this.text;
    return div;
  }
}

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
          requestId: effect.value.requestId !== undefined ? effect.value.requestId : value.requestId,
          instruction: effect.value.instruction !== undefined ? effect.value.instruction : value.instruction
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
        const deco = [
          Decoration.mark({ class: "cm-rework-source" }).range(session.range.from, session.range.to)
        ];
        if ((session.status === "streaming" || session.status === "done") && session.result) {
          deco.push(
            Decoration.widget({
              widget: new ReworkGhostBlockWidget(session.result + (session.status === "streaming" ? "█" : "")),
              block: true,
              side: 1
            }).range(session.range.to)
          );
        }
        return Decoration.set(deco);
      }
      return Decoration.none;
    }),
    showTooltip.from(f, (session) => {
      if (!session) return null;
      return {
        pos: session.range.to,
        above: true,
        arrow: true,
        create: createReworkTooltip
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
  replaceBtn!: HTMLButtonElement;
  insertBelowBtn!: HTMLButtonElement;
  retryBtn!: HTMLButtonElement;
  cancelBtn!: HTMLButtonElement; // Acts as Abandon / Cancel
  settingsRef: { current: AppSettings } | null = null;

  constructor(readonly view: EditorView) {
    this.settingsRef = view.state.field(settingsField, false) || null;
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
    this.dom.style.width = "360px";
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

    this.cancelBtn = this.createButton("Abandon", "transparent", true);
    this.cancelBtn.addEventListener("click", () => {
      view.dispatch({ effects: closeRework.of() });
      view.focus();
    });
    this.actions.appendChild(this.cancelBtn);

    this.retryBtn = this.createButton("Retry", "transparent", true);
    this.retryBtn.addEventListener("click", () => this.submit());
    this.actions.appendChild(this.retryBtn);

    this.insertBelowBtn = this.createButton("Insert Below", "transparent", true);
    this.insertBelowBtn.addEventListener("click", () => this.insertBelow());
    this.actions.appendChild(this.insertBelowBtn);

    this.submitBtn = this.createButton("Rewrite", "var(--accent)");
    this.submitBtn.addEventListener("click", () => this.submit());
    this.actions.appendChild(this.submitBtn);

    this.replaceBtn = this.createButton("Replace", "var(--accent)");
    this.replaceBtn.addEventListener("click", () => this.accept());
    this.actions.appendChild(this.replaceBtn);

    this.dom.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const currentSession = view.state.field(reworkStateField);
      if (e.key === "Escape") {
        e.preventDefault();
        view.dispatch({ effects: closeRework.of() });
        view.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          if (currentSession && currentSession.status === "done") {
            this.insertBelow();
          }
        } else {
          if (currentSession && (currentSession.status === "input" || currentSession.status === "done" || currentSession.status === "error")) {
            this.submit();
          }
        }
      } else if (e.key === "y" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (currentSession && currentSession.status === "done") {
          this.accept();
        }
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (currentSession && currentSession.status === "done") {
          if (e.shiftKey) {
            this.insertBelow();
          } else {
            this.accept();
          }
        }
      } else if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (currentSession && currentSession.status === "done") {
          this.insertBelow();
        }
      } else if (e.key === "r" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (currentSession && (currentSession.status === "done" || currentSession.status === "error")) {
          this.submit();
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

    this.input.disabled = session.status !== "input";

    if (session.status === "input") {
      this.preview.style.display = "none";
      this.cancelBtn.style.display = "inline-block";
      this.cancelBtn.textContent = "Cancel";
      this.submitBtn.style.display = "inline-block";
      this.submitBtn.textContent = "Rewrite";
      this.submitBtn.disabled = false;
      this.replaceBtn.style.display = "none";
      this.insertBelowBtn.style.display = "none";
      this.retryBtn.style.display = "none";
    } else if (session.status === "streaming") {
      this.preview.style.display = "none";
      this.cancelBtn.style.display = "inline-block";
      this.cancelBtn.textContent = "Cancel";
      this.submitBtn.style.display = "inline-block";
      this.submitBtn.textContent = "Streaming...";
      this.submitBtn.disabled = true;
      this.replaceBtn.style.display = "none";
      this.insertBelowBtn.style.display = "none";
      this.retryBtn.style.display = "none";
    } else if (session.status === "done") {
      this.preview.style.display = "none";
      this.cancelBtn.style.display = "inline-block";
      this.cancelBtn.textContent = "Abandon";
      this.submitBtn.style.display = "none";
      this.replaceBtn.style.display = "inline-block";
      this.insertBelowBtn.style.display = "inline-block";
      this.retryBtn.style.display = "inline-block";
    } else if (session.status === "error") {
      this.preview.style.display = "block";
      this.preview.textContent = "Error: " + session.result;
      this.preview.style.color = "var(--red, #f87171)";
      this.cancelBtn.style.display = "inline-block";
      this.cancelBtn.textContent = "Abandon";
      this.submitBtn.style.display = "none";
      this.replaceBtn.style.display = "none";
      this.insertBelowBtn.style.display = "none";
      this.retryBtn.style.display = "inline-block";
    }
  }

  async submit() {
    const session = this.view.state.field(reworkStateField);
    if (!session) return;

    const instruction = this.input.value.trim();
    if (!instruction) return;

    await executeRework(this.view, session, instruction);
  }

  accept() {
    const session = this.view.state.field(reworkStateField);
    if (!session || !session.result) return;

    const cleaned = cleanResult(session.result);

    this.view.dispatch({
      changes: { from: session.range.from, to: session.range.to, insert: cleaned },
      selection: { anchor: session.range.from + cleaned.length },
      effects: closeRework.of(),
      annotations: [acceptCompletionAnnotation.of(true)]
    });

    this.view.focus();
  }

  insertBelow() {
    const session = this.view.state.field(reworkStateField);
    if (!session || !session.result) return;

    const cleaned = cleanResult(session.result);

    const line = this.view.state.doc.lineAt(session.range.to);
    const insertPos = line.to;
    const insertText = "\n" + cleaned;

    this.view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: insertText },
      selection: { anchor: insertPos + insertText.length },
      effects: closeRework.of(),
      annotations: [acceptCompletionAnnotation.of(true)]
    });

    this.view.focus();
  }
}

function cleanResult(text: string): string {
  let cleaned = text.trim();
  
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1).trim();
  } else if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    const newlineIdx = cleaned.indexOf("\n");
    if (newlineIdx !== -1) {
      cleaned = cleaned.slice(newlineIdx + 1, -3).trim();
    }
  }

  const labels = ["rewritten text:", "rewritten:", "result:", "output:", "here is the rewritten text:"];
  for (const label of labels) {
    if (cleaned.toLowerCase().startsWith(label)) {
      cleaned = cleaned.slice(label.length).trim();
    }
  }

  return cleaned;
}

function createReworkTooltip(view: EditorView) {
  return new ReworkTooltip(view);
}

export async function executeRework(view: EditorView, session: ReworkSession, instruction: string) {
  const selection = view.state.doc.sliceString(session.range.from, session.range.to);
  const requestId = Math.random().toString(36).substring(7);

  view.dispatch({
    effects: updateReworkResult.of({
      result: "",
      status: "streaming",
      requestId,
      instruction
    })
  });
  view.focus();

  const settingsRef = view.state.field(settingsField, false) || null;
  const maxTokensCap = settingsRef?.current?.reworkMaxTokensCap ?? 512;
  const reworkTemperature = settingsRef?.current?.reworkTemperature ?? 0.3;

  const channel = new Channel<any>();
  let accumulated = "";
  channel.onmessage = (message) => {
    const current = view.state.field(reworkStateField);
    if (current && current.requestId === requestId && current.status === "streaming") {
      accumulated += message.token;
      view.dispatch({
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
        max_tokens: Math.min(selection.length * 2 + 64, maxTokensCap),
        seed: Math.floor(Math.random() * 100000),
        temperature: reworkTemperature,
        top_p: 0.9
      },
      channel
    });

    const finalSession = view.state.field(reworkStateField);
    if (finalSession && finalSession.requestId === requestId) {
      view.dispatch({
        effects: updateReworkResult.of({
          result: accumulated,
          status: "done"
        })
      });
      view.focus();
    }
  } catch (err) {
    const finalSession = view.state.field(reworkStateField);
    if (finalSession && finalSession.requestId === requestId) {
      view.dispatch({
        effects: updateReworkResult.of({
          result: String(err),
          status: "error"
        })
      });
      view.focus();
    }
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

export const acceptReworkCommand = (view: EditorView): boolean => {
  const session = view.state.field(reworkStateField);
  if (!session || session.status !== "done") return false;

  const cleaned = cleanResult(session.result);

  view.dispatch({
    changes: { from: session.range.from, to: session.range.to, insert: cleaned },
    selection: { anchor: session.range.from + cleaned.length },
    effects: closeRework.of(),
    annotations: [acceptCompletionAnnotation.of(true)]
  });

  view.focus();
  return true;
};

export const insertBelowReworkCommand = (view: EditorView): boolean => {
  const session = view.state.field(reworkStateField);
  if (!session || session.status !== "done") return false;

  const cleaned = cleanResult(session.result);

  const line = view.state.doc.lineAt(session.range.to);
  const insertPos = line.to;
  const insertText = "\n" + cleaned;

  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: insertText },
    selection: { anchor: insertPos + insertText.length },
    effects: closeRework.of(),
    annotations: [acceptCompletionAnnotation.of(true)]
  });

  view.focus();
  return true;
};

export const cancelReworkCommand = (view: EditorView): boolean => {
  const session = view.state.field(reworkStateField);
  if (!session) return false;

  view.dispatch({ effects: closeRework.of() });
  view.focus();
  return true;
};

export const retryReworkCommand = (view: EditorView): boolean => {
  const session = view.state.field(reworkStateField);
  if (!session || !session.instruction || (session.status !== "done" && session.status !== "error")) return false;

  executeRework(view, session, session.instruction);
  return true;
};

export const reworkKeymap = Prec.highest(
  keymap.of([
    {
      key: "Alt-k",
      run: openReworkCommand
    },
    {
      key: "Ctrl-y",
      run: acceptReworkCommand
    },
    {
      key: "Ctrl-Enter",
      run: acceptReworkCommand
    },
    {
      key: "Ctrl-b",
      run: insertBelowReworkCommand
    },
    {
      key: "Ctrl-Shift-Enter",
      run: insertBelowReworkCommand
    },
    {
      key: "Escape",
      run: cancelReworkCommand
    },
    {
      key: "Ctrl-r",
      run: retryReworkCommand
    }
  ])
);

export function reworkExtension(settingsRef?: { current: AppSettings }) {
  return [
    activeFileField,
    settingsField.init(() => settingsRef || null),
    reworkStateField,
    reworkKeymap,
    EditorView.domEventHandlers({
      keydown(event, view) {
        const session = view.state.field(reworkStateField);
        if (!session) return false;

        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelReworkCommand(view);
          return true;
        }

        if (session.status === "done") {
          const isCtrlOrMeta = event.ctrlKey || event.metaKey;
          if (event.key === "y" && isCtrlOrMeta) {
            event.preventDefault();
            event.stopPropagation();
            acceptReworkCommand(view);
            return true;
          }
          if (event.key === "Enter" && isCtrlOrMeta) {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) {
              insertBelowReworkCommand(view);
            } else {
              acceptReworkCommand(view);
            }
            return true;
          }
          if (event.key === "b" && isCtrlOrMeta) {
            event.preventDefault();
            event.stopPropagation();
            insertBelowReworkCommand(view);
            return true;
          }
          if (event.key === "r" && isCtrlOrMeta) {
            event.preventDefault();
            event.stopPropagation();
            retryReworkCommand(view);
            return true;
          }
        } else if (session.status === "error") {
          const isCtrlOrMeta = event.ctrlKey || event.metaKey;
          if (event.key === "r" && isCtrlOrMeta) {
            event.preventDefault();
            event.stopPropagation();
            retryReworkCommand(view);
            return true;
          }
        }

        return false;
      }
    })
  ];
}
