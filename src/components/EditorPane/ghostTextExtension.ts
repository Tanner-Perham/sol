import { StateField, StateEffect, Annotation, RangeSetBuilder, Prec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { invoke, Channel } from "@tauri-apps/api/core";
import { syntaxTree } from "@codemirror/language";
import { AppSettings } from "../../types";

export interface GhostTextState {
  requestId: string | null;
  prefixAnchor: number | null;
  text: string | null;
  status: "idle" | "loading" | "active";
}

// Effects and Annotations for state changes
export const setSuggestion = StateEffect.define<{ text: string; requestId: string; anchor: number }>();
export const clearSuggestion = StateEffect.define<void>();
export const setCompletionStatus = StateEffect.define<"idle" | "loading" | "active">();
export const acceptCompletionAnnotation = Annotation.define<boolean>();

// Widget for rendering the ghost text suggestion inline
class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    span.style.color = "var(--text-muted)";
    span.style.fontStyle = "italic";
    span.style.opacity = "0.55";
    span.style.userSelect = "none";
    span.style.pointerEvents = "none";
    span.style.whiteSpace = "pre-wrap";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }

  eq(other: GhostTextWidget): boolean {
    return this.text === other.text;
  }
}

// State field that manages the suggestion data and registers decorations
export const ghostTextStateField = StateField.define<GhostTextState>({
  create() {
    return { requestId: null, prefixAnchor: null, text: null, status: "idle" };
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) {
        return {
          requestId: effect.value.requestId,
          prefixAnchor: effect.value.anchor,
          text: effect.value.text,
          status: "active"
        };
      }
      if (effect.is(clearSuggestion)) {
        return { requestId: null, prefixAnchor: null, text: null, status: "idle" };
      }
      if (effect.is(setCompletionStatus)) {
        return { ...value, status: effect.value };
      }
    }

    // Clear suggestions on edits or movements, unless it is an accept action
    if (tr.docChanged || tr.selection) {
      const isAccept = tr.annotation(acceptCompletionAnnotation);
      if (!isAccept && value.text !== null) {
        return { requestId: null, prefixAnchor: null, text: null, status: "idle" };
      }
    }

    return value;
  },

  provide: (f) => [
    EditorView.decorations.from(f, (ghostState) => {
      if (ghostState.text && ghostState.prefixAnchor !== null) {
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(
          ghostState.prefixAnchor,
          ghostState.prefixAnchor,
          Decoration.widget({
            widget: new GhostTextWidget(ghostState.text),
            side: 1 // renders inline, after the cursor position
          })
        );
        return builder.finish();
      }
      return Decoration.none;
    })
  ]
});

// Helper to calculate the next word from a text suggestion
export const getNextWord = (text: string): string => {
  // Capture optional leading whitespace, next non-whitespace word, and optional trailing spaces
  const match = /^\s*\S+\s*/.exec(text);
  if (match) {
    return match[0];
  }
  return text;
};

// Command to accept the entire suggestion
export const acceptAllCommand = (view: EditorView): boolean => {
  const state = view.state.field(ghostTextStateField);
  if (!state.text || state.prefixAnchor === null) return false;

  const insertText = state.text;
  const insertPos = state.prefixAnchor;

  view.dispatch({
    changes: { from: insertPos, insert: insertText },
    selection: { anchor: insertPos + insertText.length },
    effects: clearSuggestion.of(),
    annotations: acceptCompletionAnnotation.of(true)
  });

  view.focus();
  return true;
};

// Command to accept only the next word of the suggestion
export const acceptWordCommand = (view: EditorView): boolean => {
  const state = view.state.field(ghostTextStateField);
  if (!state.text || state.prefixAnchor === null) return false;

  const nextWord = getNextWord(state.text);
  const remaining = state.text.slice(nextWord.length);
  const insertPos = state.prefixAnchor;

  if (remaining.length > 0) {
    view.dispatch({
      changes: { from: insertPos, insert: nextWord },
      selection: { anchor: insertPos + nextWord.length },
      effects: setSuggestion.of({
        text: remaining,
        requestId: state.requestId || "",
        anchor: insertPos + nextWord.length
      }),
      annotations: acceptCompletionAnnotation.of(true)
    });
  } else {
    view.dispatch({
      changes: { from: insertPos, insert: nextWord },
      selection: { anchor: insertPos + nextWord.length },
      effects: clearSuggestion.of(),
      annotations: acceptCompletionAnnotation.of(true)
    });
  }

  view.focus();
  return true;
};

// Highest precedence keymap bindings
export const ghostTextKeymap = Prec.highest(
  keymap.of([
    {
      key: "Ctrl-y",
      run: acceptAllCommand
    },
    {
      key: "Ctrl-ArrowRight",
      run: acceptWordCommand
    }
  ])
);

// ViewPlugin managing the debounce logic and Tauri generation requests
export const ghostTextTriggerPlugin = (
  settings: AppSettings,
  activeFile: string | null
) =>
  ViewPlugin.fromClass(
    class {
      debounceTimer: any = null;
      lastRequestId: string | null = null;
      lastRejectedPrefix: string = "";

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (update.docChanged) {
          const isAccept = update.transactions.some((tr) => tr.annotation(acceptCompletionAnnotation));
          if (!isAccept) {
            this.cancelActiveRequest();
            this.scheduleTrigger();
          }
        } else if (update.selectionSet) {
          const isAccept = update.transactions.some((tr) => tr.annotation(acceptCompletionAnnotation));
          if (!isAccept) {
            this.cancelActiveRequest();
          }
        }
      }

      destroy() {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
      }

      scheduleTrigger() {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        // Suppress triggers if features are disabled
        if (!settings.completionEnabled || !activeFile) {
          return;
        }

        const cm = getCM(this.view);
        const isInsertMode = cm?.state?.vim?.insertMode === true;
        if (cm && !isInsertMode) {
          // Vim is active but not in insert mode
          return;
        }

        this.debounceTimer = setTimeout(() => {
          this.triggerCompletion();
        }, 400);
      }

      cancelActiveRequest() {
        if (this.lastRequestId) {
          this.lastRequestId = null;
          invoke("cancel_completion").catch(() => {});
        }
        
        // Only clear if active suggestion exists
        const currentField = this.view.state.field(ghostTextStateField, false);
        if (currentField && currentField.text !== null) {
          this.view.dispatch({ effects: clearSuggestion.of() });
        }
      }

      async triggerCompletion() {
        // First check privacy allowed status
        try {
          const allowed = await invoke<boolean>("is_note_allowed", { path: activeFile });
          if (!allowed) {
            return;
          }
        } catch (err) {
          return;
        }

        const state = this.view.state;
        const pos = state.selection.main.head;

        // 1. Suppress if cursor inside fenced code blocks
        let insideCode = false;
        let parent: any = syntaxTree(state).resolveInner(pos, -1);
        while (parent) {
          if (parent.name === "FencedCode" || parent.name === "CodeBlock" || parent.name === "CodeText") {
            insideCode = true;
            break;
          }
          parent = parent.parent;
        }
        if (insideCode) return;

        // 2. Validate prefix text
        const text = state.doc.toString();
        const prefixText = text.slice(0, pos);
        if (!prefixText.trim()) return;

        // 3. Suppress if it matches a rejected prefix
        if (this.lastRejectedPrefix && prefixText.endsWith(this.lastRejectedPrefix)) {
          return;
        }

        const requestId = Math.random().toString(36).substring(7);
        this.lastRequestId = requestId;

        // Set status to loading
        this.view.dispatch({ effects: setCompletionStatus.of("loading") });

        const channel = new Channel<any>();
        channel.onmessage = (message) => {
          // Verify that this is the active request
          if (this.lastRequestId === requestId) {
            const currentGhost = this.view.state.field(ghostTextStateField);
            const appendedText = (currentGhost.text || "") + message.token;
            
            const currentAnchor = currentGhost.prefixAnchor !== null ? currentGhost.prefixAnchor : pos;
            this.view.dispatch({
              effects: setSuggestion.of({
                text: appendedText,
                requestId,
                anchor: currentAnchor
              })
            });
          }
        };

        try {
          // Cancel in-flight generation
          await invoke("cancel_completion");
          
          if (this.lastRequestId !== requestId) return;

          // Start generation
          await invoke("generate_completion", {
            requestId,
            params: {
              path: activeFile,
              text,
              cursor_offset: pos,
              max_tokens: 100,
              temperature: 0.1,
              top_p: 0.95,
              stop: ["\n"],
              seed: Math.floor(Math.random() * 100000)
            },
            channel
          });

          // Reset status to idle if completed but no suggestion text was generated
          if (this.lastRequestId === requestId) {
            const currentGhost = this.view.state.field(ghostTextStateField);
            if (!currentGhost.text) {
              this.view.dispatch({ effects: setCompletionStatus.of("idle") });
            }
          }
        } catch (err) {
          // Only log and update if this request wasn't already superceded
          if (this.lastRequestId === requestId) {
            console.error("Predictive Completion Error:", err);
            this.view.dispatch({ effects: setCompletionStatus.of("idle") });
          }
        }
      }
    }
  );

// Combined export for easy inclusion in EditorPane
export function ghostTextExtension(
  settings: AppSettings,
  activeFile: string | null
) {
  return [
    ghostTextStateField,
    ghostTextKeymap,
    ghostTextTriggerPlugin(settings, activeFile)
  ];
}
