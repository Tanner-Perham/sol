import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion } from "@codemirror/autocomplete";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { prosePreviewPlugin } from "../../prosePreviewPlugin";
import { PaneId, AppSettings, FileNode } from "../../types";
import { customSelectionHighlightPlugin } from "./editorPlugins";
import { findHeaderLine, computeWordCount, wikiCompletionSource } from "../../utils/editorUtils";

export interface EditorPaneProps {
  paneId: string;
  activeFile: string | null;
  tabs: string[];
  isActive: boolean;
  settings: AppSettings;
  workspacePath: string;
  fileTree: FileNode[];
  pendingHeadersRef: React.MutableRefObject<Map<PaneId, string>>;
  fileMtimesRef: React.MutableRefObject<Map<string, number>>;
  fileBasesRef: React.MutableRefObject<Map<string, string>>;
  onFocus: () => void;
  onCloseTab: (paneId: string, file: string) => void;
  onOpenFile: (file: string) => void;
  registerView: (paneId: string, view: EditorView | null) => void;
  registerState: (paneId: string, isDirty: boolean, wordCount: number) => void;
  onDocChange: (paneId: string, content: string, changes?: any) => void;
  onVimModeChange: (mode: string) => void;
}

interface SavedEditorState {
  selection: any;
  scrollTop: number;
  scrollLeft: number;
}

const editorStates = new Map<string, SavedEditorState>();
const fileEditorStates = new Map<string, EditorState>();

export function pruneEditorState(paneId: string, file: string) {
  const key = `${paneId}:${file}`;
  editorStates.delete(key);
  fileEditorStates.delete(key);
}

export function clearAllEditorStates() {
  editorStates.clear();
  fileEditorStates.clear();
}

export const EditorPaneComponent: React.FC<EditorPaneProps> = ({
  paneId,
  activeFile,
  tabs,
  isActive,
  settings,
  workspacePath,
  fileTree,
  pendingHeadersRef,
  fileMtimesRef,
  fileBasesRef,
  onFocus,
  onCloseTab,
  onOpenFile,
  registerView,
  registerState,
  onDocChange,
  onVimModeChange
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [fileData, setFileData] = useState<{ file: string; content: string } | null>(null);
  const [isLocalDirty, setIsLocalDirty] = useState(false);

  const { vimMode, livePreview, lineWrapping, theme } = settings;

  const vimCompartment = useMemo(() => new Compartment(), []);
  const wrapCompartment = useMemo(() => new Compartment(), []);
  const previewCompartment = useMemo(() => new Compartment(), []);
  const themeCompartment = useMemo(() => new Compartment(), []);

  const markdownFilesSet = useMemo(() => {
    const set = new Set<string>();
    const collect = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (!node.is_dir) {
          if (node.name.toLowerCase().endsWith(".md")) {
            set.add(node.name);
          }
        } else {
          collect(node.children);
        }
      }
    };
    collect(fileTree);
    return set;
  }, [fileTree]);

  const markdownFilesSetRef = useRef(markdownFilesSet);
  useEffect(() => {
    markdownFilesSetRef.current = markdownFilesSet;
  }, [markdownFilesSet]);

  // Clear saved editor states when workspace path changes
  useEffect(() => {
    clearAllEditorStates();
  }, [workspacePath]);

  // Load content when activeFile changes
  useEffect(() => {
    if (!activeFile) {
      setFileData(null);
      setIsLocalDirty(false);
      registerState(paneId, false, 0);
      return;
    }

    let active = true;
    const loadContent = async () => {
      try {
        const res = await invoke<{ content: string; mtime: number }>("read_markdown_file", { path: activeFile });
        if (!active) return;
        fileMtimesRef.current.set(activeFile, res.mtime);
        fileBasesRef.current.set(activeFile, res.content);
        setFileData({ file: activeFile, content: res.content });
        setIsLocalDirty(false);
        const wCount = computeWordCount(res.content);
        registerState(paneId, false, wCount);
      } catch (err) {
        if (active) {
          console.error("Failed to load pane file", err);
        }
      }
    };
    loadContent();
    return () => {
      active = false;
    };
  }, [activeFile, workspacePath, paneId]);

  const buildExtensions = useCallback(() => {
    return [
      history(),
      EditorView.inputHandler.of((view, from, to, text) => {
        if (text === "[") {
          if (from > 0 && view.state.doc.sliceString(from - 1, from) === "[") {
            view.dispatch({
              changes: { from, to, insert: "[]]" },
              selection: { anchor: from + 1 }
            });
            return true;
          }
        } else if (text === "]") {
          if (from < view.state.doc.length && view.state.doc.sliceString(from, from + 1) === "]") {
            view.dispatch({
              selection: { anchor: from + 1 }
            });
            return true;
          }
        }
        return false;
      }),
      autocompletion({
        override: [
          (context) => wikiCompletionSource(context, markdownFilesSetRef.current)
        ]
      }),
      keymap.of([
        {
          key: "Mod-v",
          run: (view) => {
            const cm = getCM(view);
            if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
              Vim.handleKey(cm, "<C-v>", "mapping");
              return true;
            }
            return false;
          }
        },
        {
          key: "Ctrl-q",
          run: (view) => {
            const cm = getCM(view);
            if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
              Vim.handleKey(cm, "<C-q>", "mapping");
              return true;
            }
            return false;
          }
        },
        ...defaultKeymap,
        ...historyKeymap
      ]),
      markdown(),
      vimCompartment.of(vimMode ? [vim()] : []),
      wrapCompartment.of(lineWrapping ? [EditorView.lineWrapping] : []),
      previewCompartment.of(livePreview ? [prosePreviewPlugin(workspacePath, markdownFilesSet)] : []),
      themeCompartment.of(EditorView.theme({
        "&": {
          backgroundColor: "var(--bg-dark)",
          height: "100%",
          color: "var(--text-primary)",
        },
        ".cm-scroller": {
          overflow: "auto",
          height: "100%",
        },
        ".cm-content": {
          caretColor: "var(--accent)",
        },
        ".cm-cursor:not(.cm-fat-cursor)": {
          borderLeftColor: "var(--accent) !important",
          borderLeftWidth: "2px !important",
        },
        ".cm-fat-cursor": {
          backgroundColor: "var(--accent) !important",
          borderLeft: "none !important",
        },
        ".cm-activeLine": {
          backgroundColor: "transparent",
        },
      }, { dark: !["sepia", "light"].includes(theme) })),
      customSelectionHighlightPlugin,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const isReload = update.transactions.some(tr => tr.annotation(Transaction.userEvent) === "reload");
          if (isReload) return;

          const docString = update.state.doc.toString();
          const wCount = computeWordCount(docString);
          setIsLocalDirty(true);
          registerState(paneId, true, wCount);
          onDocChange(paneId, docString, update.changes);
        }
      })
    ];
  }, [paneId, workspacePath, vimMode, lineWrapping, livePreview, theme, vimCompartment, wrapCompartment, previewCompartment, themeCompartment, onDocChange, registerState]);

  // Clean up view on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        registerView(paneId, null);
      }
    };
  }, [paneId, registerView]);

  // CodeMirror initialization & tab state changes
  useEffect(() => {
    if (!containerRef.current || !fileData) return;

    const { file: loadedFile, content: loadedContent } = fileData;
    const cacheKey = `${paneId}:${loadedFile}`;

    let state = fileEditorStates.get(cacheKey);

    if (!state) {
      const savedState = editorStates.get(cacheKey);
      let selection = undefined;
      if (savedState && savedState.selection) {
        const maxPos = loadedContent.length;
        const savedSel = savedState.selection;
        if (savedSel.main && savedSel.main.to <= maxPos) {
          selection = savedSel;
        }
      }

      state = EditorState.create({
        doc: loadedContent,
        selection,
        extensions: buildExtensions()
      });
      fileEditorStates.set(cacheKey, state);
    }

    let view = viewRef.current;
    if (!view) {
      view = new EditorView({
        state,
        parent: containerRef.current
      });
      viewRef.current = view;
      registerView(paneId, view);
    } else {
      view.setState(state);
    }

    // Scroll to pending header if exists, otherwise restore scroll position
    const pendingHeader = pendingHeadersRef.current.get(paneId);
    if (pendingHeader) {
      pendingHeadersRef.current.delete(paneId);
      setTimeout(() => {
        if (!view) return;
        const lineNum = findHeaderLine(view.state.doc, pendingHeader);
        if (lineNum !== null) {
          const line = view.state.doc.line(lineNum);
          view.dispatch({
            selection: { anchor: line.from },
            scrollIntoView: true
          });
        }
      }, 50);
    } else {
      const savedState = editorStates.get(cacheKey);
      if (savedState) {
        const restoreScroll = () => {
          if (view && view.scrollDOM) {
            view.scrollDOM.scrollTop = savedState.scrollTop;
            view.scrollDOM.scrollLeft = savedState.scrollLeft;
          }
        };
        restoreScroll();
        setTimeout(restoreScroll, 10);
        setTimeout(restoreScroll, 50);
      }
    }

    if (isActive) {
      view.focus();
    }

    const handlePaste = (e: ClipboardEvent) => {
      if (!view) return;
      const cm = getCM(view);
      if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
        e.preventDefault();
      }
    };
    view.dom.addEventListener("paste", handlePaste, true);

    // Track visual block selection for blockwise insert
    let savedBlockSelection: { startLine: number; endLine: number; col: number; originalText: string } | null = null;
    let isReplayingBlockInsert = false;

    // Global keydown handler to intercept Ctrl+V, Ctrl+Q, Shift+I, and x in visual block
    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      if (!view || !view.hasFocus || isReplayingBlockInsert) return;

      const isCtrlV = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.altKey && !e.shiftKey;
      const isCtrlQ = e.ctrlKey && e.key.toLowerCase() === 'q' && !e.altKey && !e.shiftKey && !e.metaKey;
      const isShiftI = e.shiftKey && e.key === 'I';
      const isEscape = e.key === 'Escape';
      const isX = e.key === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

      const cm = getCM(view);

      if (isCtrlV || isCtrlQ) {
        if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
          e.preventDefault();
          e.stopPropagation();
          const vimKey = isCtrlV ? "<C-v>" : "<C-q>";
          Vim.handleKey(cm, vimKey, "keydown");
          return false;
        }
      } else if (isShiftI && cm && cm.state && cm.state.vim) {
        const vimState = cm.state.vim;
        if (vimState.visualBlock && vimState.sel) {
          const anchor = vimState.sel.anchor;
          const head = vimState.sel.head;
          const startLine = Math.min(anchor.line, head.line);
          const endLine = Math.max(anchor.line, head.line);
          const col = Math.min(anchor.ch, head.ch);

          const firstLine = view.state.doc.line(startLine + 1);
          const originalText = firstLine.text;

          savedBlockSelection = { startLine, endLine, col, originalText };
        }
      } else if (isX && cm && cm.state && cm.state.vim) {
        const vimState = cm.state.vim;
        if (vimState.visualBlock && vimState.sel) {
          e.preventDefault();
          e.stopPropagation();

          const anchor = vimState.sel.anchor;
          const head = vimState.sel.head;
          const startLineNum = Math.min(anchor.line, head.line);
          const endLineNum = Math.max(anchor.line, head.line);
          const startCol = Math.min(anchor.ch, head.ch);
          const endCol = Math.max(anchor.ch, head.ch) + 1;

          const changes: { from: number; to: number; insert: string }[] = [];

          for (let lineNum = startLineNum; lineNum <= endLineNum; lineNum++) {
            if (lineNum + 1 > view.state.doc.lines) continue;
            const line = view.state.doc.line(lineNum + 1);
            const lineStartCol = Math.min(startCol, line.text.length);
            const lineEndCol = Math.min(endCol, line.text.length);

            if (lineStartCol < lineEndCol) {
              const from = line.from + lineStartCol;
              const to = line.from + lineEndCol;
              changes.push({ from, to, insert: "" });
            }
          }

          if (changes.length > 0) {
            Vim.exitVisualMode(cm as any, false);
            view.dispatch({ changes });
          }

          return false;
        }
      } else if (isEscape && savedBlockSelection && cm && cm.state && cm.state.vim) {
        const { col, originalText } = savedBlockSelection;
        const blockSel = savedBlockSelection;
        savedBlockSelection = null;

        setTimeout(() => {
          if (!view || !cm) return;
          const firstLine = view.state.doc.line(blockSel.startLine + 1);
          const newText = firstLine.text;

          // Precise diff formula
          const insertedText = newText.slice(col, newText.length - (originalText.length - col));

          if (insertedText.length > 0) {
            isReplayingBlockInsert = true;
            Vim.handleKey(cm, "u", "mapping");

            setTimeout(() => {
              if (!view) {
                isReplayingBlockInsert = false;
                return;
              }
              const changes: { from: number; to: number; insert: string }[] = [];

              for (let lineNum = blockSel.startLine; lineNum <= blockSel.endLine; lineNum++) {
                if (lineNum + 1 > view.state.doc.lines) continue;
                const line = view.state.doc.line(lineNum + 1);
                const insertPos = line.from + Math.min(col, line.text.length);
                changes.push({ from: insertPos, to: insertPos, insert: insertedText });
              }

              if (changes.length > 0) {
                view.dispatch({ changes });
              }
              isReplayingBlockInsert = false;
            }, 10);
          }
        }, 20);
      }
    };
    document.addEventListener("keydown", handleDocumentKeyDown, true);

    if (vimMode) {
      const cm = getCM(view);
      if (cm) {
        cm.on("vim-mode-change", (e: any) => {
          if (e && e.mode) {
            onVimModeChange(e.mode.toUpperCase());
          }
        });
      }
    }

    return () => {
      if (loadedFile && view) {
        const selection = view.state.selection;
        const scrollTop = view.scrollDOM ? view.scrollDOM.scrollTop : 0;
        const scrollLeft = view.scrollDOM ? view.scrollDOM.scrollLeft : 0;
        editorStates.set(cacheKey, { selection, scrollTop, scrollLeft });
        fileEditorStates.set(cacheKey, view.state);
      }

      if (view) {
        view.dom.removeEventListener("paste", handlePaste, true);
      }
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [fileData, paneId, buildExtensions, isActive, pendingHeadersRef, registerView, onVimModeChange, vimMode]);

  // Reconfigure settings compartments on settings changes
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: [
          vimCompartment.reconfigure(vimMode ? [vim()] : []),
          wrapCompartment.reconfigure(lineWrapping ? [EditorView.lineWrapping] : []),
          previewCompartment.reconfigure(livePreview ? [prosePreviewPlugin(workspacePath, markdownFilesSet)] : []),
          themeCompartment.reconfigure(EditorView.theme({
            "&": {
              backgroundColor: "var(--bg-dark)",
              height: "100%",
              color: "var(--text-primary)",
            },
            ".cm-scroller": {
              overflow: "auto",
              height: "100%",
            },
            ".cm-content": {
              caretColor: "var(--accent)",
            },
            ".cm-cursor:not(.cm-fat-cursor)": {
              borderLeftColor: "var(--accent) !important",
              borderLeftWidth: "2px !important",
            },
            ".cm-fat-cursor": {
              backgroundColor: "var(--accent) !important",
              borderLeft: "none !important",
            },
            ".cm-activeLine": {
              backgroundColor: "transparent",
            },
          }, { dark: !["sepia", "light"].includes(theme) }))
        ]
      });
    }
  }, [vimMode, lineWrapping, livePreview, theme, workspacePath, markdownFilesSet, vimCompartment, wrapCompartment, previewCompartment, themeCompartment]);

  // Handle focus sync
  useEffect(() => {
    if (isActive && viewRef.current) {
      viewRef.current.focus();
    }
  }, [isActive]);

  return (
    <div
      className={`editor-pane ${isActive ? "active" : ""}`}
      onClick={onFocus}
      data-pane-id={paneId}
      tabIndex={0}
    >
      {tabs.length > 0 && (
        <div className="editor-tabs">
          {tabs.map((tab, idx) => {
            const isTabActive = activeFile === tab;
            const isTabDirty = isTabActive && isLocalDirty;
            return (
              <div
                key={tab}
                className={`editor-tab ${isTabActive ? "active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(tab);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(paneId, tab);
                  }
                }}
                title={`${tab} (Alt+${idx + 1})`}
              >
                <span className="tab-name">{tab.replace(/\.md$/, "")}</span>
                {isTabDirty && <span className="tab-dirty-dot" title="Unsaved changes" />}
                <button
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(paneId, tab);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="editor-wrapper" style={{ flex: 1, overflow: "hidden", position: "relative" }} onClick={onFocus}>
        {activeFile ? (
          <div ref={containerRef} className="editor-inner" style={{ height: "100%" }} />
        ) : (
          <div className="editor-empty-state">
            <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="15" x2="15" y2="15" />
              <line x1="12" y1="12" x2="12" y2="18" />
            </svg>
            <h3>No documents open</h3>
            <p>Select a document from the sidebar, or create a new one to begin writing.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EditorPaneComponent;
