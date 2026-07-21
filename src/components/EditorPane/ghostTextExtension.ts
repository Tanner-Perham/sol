import { StateField, StateEffect, Annotation, RangeSetBuilder, Prec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { invoke, Channel } from "@tauri-apps/api/core";
import { syntaxTree } from "@codemirror/language";
import { AppSettings } from "../../types";
import { reworkStateField } from "./reworkExtension";

export interface GhostTextState {
  requestId: string | null;
  prefixAnchor: number | null;
  text: string | null;
  status: "idle" | "loading" | "active";
  attempt: number;
  rejected: string[];
  contextHighlight: { from: number; to: number } | null;
}

// Effects and Annotations for state changes
export const setSuggestion = StateEffect.define<{ text: string; requestId: string; anchor: number }>();
export const clearSuggestion = StateEffect.define<void>();
export const setCompletionStatus = StateEffect.define<"idle" | "loading" | "active">();
export const acceptCompletionAnnotation = Annotation.define<boolean>();
export const rejectSuggestion = StateEffect.define<{ text: string }>();
export const incrementAttempt = StateEffect.define<void>();
export const retryCompletionEffect = StateEffect.define<void>();
export const setContextHighlight = StateEffect.define<{ from: number; to: number } | null>();

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
    return { requestId: null, prefixAnchor: null, text: null, status: "idle", attempt: 0, rejected: [], contextHighlight: null };
  },

  update(value, tr) {
    let isRetry = false;
    for (const effect of tr.effects) {
      if (effect.is(retryCompletionEffect)) {
        isRetry = true;
      }
    }

    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) {
        return {
          ...value,
          requestId: effect.value.requestId,
          prefixAnchor: effect.value.anchor,
          text: effect.value.text,
          status: "active"
        };
      }
      if (effect.is(clearSuggestion)) {
        return { ...value, requestId: null, prefixAnchor: null, text: null, status: "idle", contextHighlight: null };
      }
      if (effect.is(rejectSuggestion)) {
        return {
          ...value,
          requestId: null,
          prefixAnchor: null,
          text: null,
          status: "idle",
          rejected: [...value.rejected, effect.value.text],
          attempt: value.attempt + 1,
          contextHighlight: null
        };
      }
      if (effect.is(incrementAttempt)) {
        return {
          ...value,
          attempt: value.attempt + 1
        };
      }
      if (effect.is(setCompletionStatus)) {
        return { ...value, status: effect.value };
      }
      if (effect.is(setContextHighlight)) {
        return {
          ...value,
          contextHighlight: effect.value
        };
      }
    }

    // Clear suggestions on edits or movements, unless it is an accept or retry action
    if (tr.docChanged || tr.selection) {
      const isAccept = tr.annotation(acceptCompletionAnnotation);
      if (!isAccept && !isRetry) {
        return { requestId: null, prefixAnchor: null, text: null, status: "idle", attempt: 0, rejected: [], contextHighlight: null };
      }
    }

    return value;
  },

  provide: (f) => [
    EditorView.decorations.compute([f], (state) => {
      const ghostState = state.field(f);
      const builder = new RangeSetBuilder<Decoration>();

      // 1. Context highlight
      if (ghostState.contextHighlight) {
        const from = Math.min(ghostState.contextHighlight.from, state.doc.length);
        const to = Math.min(ghostState.contextHighlight.to, state.doc.length);
        if (from < to) {
          builder.add(
            from,
            to,
            Decoration.mark({ class: "cm-ai-context" })
          );
        }
      }

      // 2. Ghost text widget
      if (ghostState.text && ghostState.prefixAnchor !== null) {
        const anchor = Math.min(ghostState.prefixAnchor, state.doc.length);
        builder.add(
          anchor,
          anchor,
          Decoration.widget({
            widget: new GhostTextWidget(ghostState.text),
            side: 1
          })
        );
      }

      return builder.finish();
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

export const retryCommand = (view: EditorView): boolean => {
  const state = view.state.field(ghostTextStateField);
  const hasGhost = state.text !== null;
  const hasRejections = state.rejected.length > 0;
  
  if (!hasGhost && !hasRejections) {
    return false;
  }

  const effects: StateEffect<any>[] = [retryCompletionEffect.of()];
  if (state.text) {
    effects.push(rejectSuggestion.of({ text: state.text }));
  } else {
    effects.push(incrementAttempt.of());
  }

  view.dispatch({
    effects
  });
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
    },
    {
      key: "Alt-r",
      run: retryCommand
    }
  ])
);

function normalizeText(str: string): string {
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

function isDuplicateSuggestion(suggestion: string, buffer: string): boolean {
  const normSuggestion = normalizeText(suggestion);
  if (normSuggestion.length <= 20) {
    return false;
  }
  const normBuffer = normalizeText(buffer);
  return normBuffer.includes(normSuggestion);
}

// ViewPlugin managing the debounce logic and Tauri generation requests
export const ghostTextTriggerPlugin = (
  settingsRef: { current: AppSettings },
  activeFile: string | null,
  onAiDebugInfo?: (info: any) => void
) =>
  ViewPlugin.fromClass(
    class {
      debounceTimer: any = null;
      lastRequestId: string | null = null;
      lastRejectedPrefix: string = "";

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        let shouldRetry = false;
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(retryCompletionEffect)) {
              shouldRetry = true;
            }
          }
        }

        if (shouldRetry) {
          this.cancelActiveRequest();
          this.triggerCompletion(true); // true = immediate
          return;
        }

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

        const ghostState = update.state.field(ghostTextStateField);
        if (!ghostState.text && !ghostState.requestId && onAiDebugInfo) {
          onAiDebugInfo(null);
        }
      }

      destroy() {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        if (this.lastRequestId) {
          this.lastRequestId = null;
          invoke("cancel_completion").catch(() => {});
        }
        if (onAiDebugInfo) {
          onAiDebugInfo(null);
        }
      }

      scheduleTrigger() {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        // Suppress triggers if features are disabled
        if (!settingsRef.current.completionEnabled || !activeFile) {
          return;
        }

        const cm = getCM(this.view);
        const isInsertMode = cm?.state?.vim?.insertMode === true;
        if (cm && !isInsertMode) {
          // Vim is active but not in insert mode
          return;
        }

        const debounceMs = settingsRef.current.completionDebounceMs ?? 400;
        this.debounceTimer = setTimeout(() => {
          this.triggerCompletion();
        }, debounceMs);
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
        if (onAiDebugInfo) {
          onAiDebugInfo(null);
        }
      }

      async triggerCompletion(immediate = false) {
        // Suppress completions if rework session is active
        const reworkSession = this.view.state.field(reworkStateField, false);
        if (reworkSession) {
          return;
        }

        // Suppress triggers if features are disabled
        if (!settingsRef.current.completionEnabled || !activeFile) {
          return;
        }

        if (!immediate) {
          const cm = getCM(this.view);
          const isInsertMode = cm?.state?.vim?.insertMode === true;
          if (cm && !isInsertMode) {
            // Vim is active but not in insert mode
            return;
          }
        }

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

        // 1. Check if cursor inside fenced code blocks
        let insideCode = false;
        let parent: any = syntaxTree(state).resolveInner(pos, -1);
        while (parent) {
          if (parent.name === "FencedCode" || parent.name === "CodeBlock" || parent.name === "CodeText") {
            insideCode = true;
            break;
          }
          parent = parent.parent;
        }

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
        if (onAiDebugInfo) {
          onAiDebugInfo(null);
        }

        const channel = new Channel<any>();
        channel.onmessage = (message) => {
          // Verify that this is the active request and completions are still enabled
          if (this.lastRequestId === requestId && settingsRef.current.completionEnabled) {
            if (message.type === "token") {
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
            } else if (message.type === "context") {
              if (settingsRef.current.aiDebugEnabled) {
                this.view.dispatch({
                  effects: setContextHighlight.of({ from: message.prefix_from, to: message.prefix_to })
                });
              }
              if (onAiDebugInfo) {
                onAiDebugInfo({
                  charCount: message.prefix_to - message.prefix_from,
                  linkedCount: message.linked.length,
                  tokensEst: message.prompt_tokens_est
                });
              }
            } else if (message.type === "stats") {
              if (onAiDebugInfo) {
                onAiDebugInfo((prev: any) => {
                  if (!prev) return null;
                  return {
                    ...prev,
                    prefillMs: message.prefill_ms,
                    tokPerS: message.tok_per_s,
                    backend: message.backend
                  };
                });
              }
            }
          }
        };

        try {
          // Cancel in-flight generation
          await invoke("cancel_completion");
          
          if (this.lastRequestId !== requestId) return;

          const ghostState = this.view.state.field(ghostTextStateField);
          const baseTemp = settingsRef.current.completionTemperature ?? 0.35;
          const tempLadder = [baseTemp, baseTemp + 0.25, baseTemp + 0.5];
          const temperature = tempLadder[Math.min(ghostState.attempt, 2)];
          const seed = Math.floor(Math.random() * 100000);
          const rejected = ghostState.rejected;

          const maxTokens = settingsRef.current.completionMaxTokens ?? 100;
          const topP = settingsRef.current.completionTopP ?? 0.95;
          
          const contextOpts = {
            prefix_chars: settingsRef.current.contextPrefixChars ?? 800,
            max_linked_notes: settingsRef.current.contextMaxLinkedNotes ?? 1,
            excerpt_chars: settingsRef.current.contextExcerptChars ?? 150
          };

          const stop = insideCode ? ["\n", "```"] : ["\n", "."];

          // Start generation
          await invoke("generate_completion", {
            requestId,
            params: {
              path: activeFile,
              text,
              cursor_offset: pos,
              max_tokens: maxTokens,
              temperature,
              top_p: topP,
              stop,
              seed,
              rejected,
              context: contextOpts
            },
            channel
          });

          // Reset status to idle or reject duplicate suggestions
          if (this.lastRequestId === requestId) {
            const currentGhost = this.view.state.field(ghostTextStateField);
            if (currentGhost.text) {
              if (isDuplicateSuggestion(currentGhost.text, text)) {
                this.view.dispatch({
                  effects: rejectSuggestion.of({ text: currentGhost.text })
                });
              } else {
                this.view.dispatch({ effects: setCompletionStatus.of("idle") });
              }
            } else {
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
  settingsRef: { current: AppSettings },
  activeFile: string | null,
  onAiDebugInfo?: (info: any) => void
) {
  return [
    ghostTextStateField,
    ghostTextKeymap,
    ghostTextTriggerPlugin(settingsRef, activeFile, onAiDebugInfo)
  ];
}
