import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState, Compartment, Transaction, Prec, RangeSet } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, GutterMarker, lineNumberMarkers } from "@codemirror/view";

class CursorLineGutterMarker extends GutterMarker {
  elementClass = "cm-activeLineGutter";
  constructor(public line: number) {
    super();
  }
  eq(other: CursorLineGutterMarker) {
    return this.line === other.line;
  }
}
import { defaultKeymap, historyKeymap, history, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { autocompletion } from "@codemirror/autocomplete";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { Strikethrough } from "@lezer/markdown";
import { prosePreviewPlugin } from "../../prosePreviewPlugin";
import { PaneId, AppSettings, FileNode } from "../../types";
import { customSelectionHighlightPlugin } from "./editorPlugins";
import { ghostTextExtension } from "./ghostTextExtension";
import { reworkExtension, activeFileField, openReworkCommand } from "./reworkExtension";
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
  onCloseTabs: (paneId: string, files: string[]) => void;
  onOpenFile: (file: string) => void;
  registerView: (paneId: string, view: EditorView | null) => void;
  registerState: (paneId: string, isDirty: boolean, wordCount: number) => void;
  onDocChange: (paneId: string, content: string, changes?: any) => void;
  onVimModeChange: (mode: string) => void;
  onAiDebugInfo?: (info: any) => void;
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

export function saveEditorState(paneId: string, file: string, view: EditorView) {
  const cacheKey = `${paneId}:${file}`;
  const selection = view.state.selection;
  const scrollTop = view.scrollDOM ? view.scrollDOM.scrollTop : 0;
  const scrollLeft = view.scrollDOM ? view.scrollDOM.scrollLeft : 0;
  editorStates.set(cacheKey, { selection, scrollTop, scrollLeft });
  fileEditorStates.set(cacheKey, view.state);
}

export function renameEditorState(paneId: string, oldFile: string, newFile: string) {
  const oldKey = `${paneId}:${oldFile}`;
  const newKey = `${paneId}:${newFile}`;

  const state = editorStates.get(oldKey);
  if (state) {
    editorStates.set(newKey, state);
    editorStates.delete(oldKey);
  }

  const edState = fileEditorStates.get(oldKey);
  if (edState) {
    fileEditorStates.set(newKey, edState);
    fileEditorStates.delete(oldKey);
  }
}

const toggleFormatting = (view: EditorView, prefix: string, suffix: string): boolean => {
  const selection = view.state.selection;
  const mainRange = selection.main;
  if (mainRange.empty) {
    const insertText = prefix + suffix;
    view.dispatch({
      changes: { from: mainRange.from, insert: insertText },
      selection: { anchor: mainRange.from + prefix.length }
    });
  } else {
    const selectedText = view.state.doc.sliceString(mainRange.from, mainRange.to);
    view.dispatch({
      changes: { from: mainRange.from, to: mainRange.to, insert: prefix + selectedText + suffix },
      selection: { anchor: mainRange.from + prefix.length, head: mainRange.from + prefix.length + selectedText.length }
    });
  }
  return true;
};


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
  onCloseTabs,
  onOpenFile,
  registerView,
  registerState,
  onDocChange,
  onVimModeChange,
  onAiDebugInfo
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastScrollTimeRef = useRef<number>(0);
  const frameRequestedRef = useRef<boolean>(false);
  const [fileData, setFileData] = useState<{ file: string; content: string } | null>(null);
  const [isLocalDirty, setIsLocalDirty] = useState(false);
  const isLocalDirtyRef = useRef(isLocalDirty);
  useEffect(() => {
    isLocalDirtyRef.current = isLocalDirty;
  }, [isLocalDirty]);

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tab?: string;
    type: "tab" | "editor";
    hasSelection?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = (e: MouseEvent) => {
      const menuEl = document.getElementById(`context-menu-${paneId}`);
      if (menuEl && menuEl.contains(e.target as Node)) {
        return;
      }
      setContextMenu(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", handleClose);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("contextmenu", handleClose);
    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("contextmenu", handleClose);
    };
  }, [contextMenu, paneId]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tab: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      tab,
      type: "tab"
    });
  }, []);

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    const view = viewRef.current;
    if (!view) return;

    e.preventDefault();
    e.stopPropagation();

    const mainRange = view.state.selection.main;
    const hasSelection = !mainRange.empty;

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      type: "editor",
      hasSelection
    });
  }, []);

  const { vimMode, livePreview, lineWrapping, theme } = settings;

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        registerView(paneId, null);
      }
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
      lineNumbers({
        formatNumber: (lineNo, state) => {
          const cursorLine = state.doc.lineAt(state.selection.main.head).number;
          const diff = Math.abs(lineNo - cursorLine);
          return diff.toString();
        }
      }),
      lineNumberMarkers.compute(["selection"], (state) => {
        const cursorLine = state.doc.lineAt(state.selection.main.head).number;
        const linePos = state.doc.line(cursorLine).from;
        return RangeSet.of([new CursorLineGutterMarker(cursorLine).range(linePos)]);
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-b",
            run: (view) => toggleFormatting(view, "**", "**")
          },
          {
            key: "Mod-i",
            run: (view) => toggleFormatting(view, "*", "*")
          },
          {
            key: "Mod-u",
            run: (view) => toggleFormatting(view, "<u>", "</u>")
          },
          {
            key: "Mod-Shift-s",
            run: (view) => toggleFormatting(view, "~~", "~~")
          },
          {
            key: "Mod-Shift-x",
            run: (view) => toggleFormatting(view, "~~", "~~")
          }
        ])
      ),
      history(),
      EditorView.inputHandler.of((view, from, to, text) => {
        const cm = getCM(view);
        if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
          return true; // block input if vim mode is active and not in insert mode
        }
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
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap
      ]),
      markdown({ codeLanguages: languages, extensions: [Strikethrough] }),
      syntaxHighlighting(classHighlighter),
      vimCompartment.of(vimMode ? [Prec.highest(vim())] : []),
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
      ghostTextExtension(settingsRef, activeFile, onAiDebugInfo),
      reworkExtension(settingsRef),
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
  }, [paneId, workspacePath, vimMode, lineWrapping, livePreview, theme, settingsRef, activeFile, vimCompartment, wrapCompartment, previewCompartment, themeCompartment, onDocChange, registerState, onAiDebugInfo]);

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

    if (!state || state.field(activeFileField) !== activeFile) {
      const savedState = editorStates.get(cacheKey);
      const isNewState = !savedState;
      let selection = undefined;
      if (savedState && savedState.selection) {
        const maxPos = loadedContent.length;
        const savedSel = savedState.selection;
        if (savedSel.main && savedSel.main.to <= maxPos) {
          selection = savedSel;
        }
      } else {
        const firstLineEnd = loadedContent.indexOf("\n");
        const pos = firstLineEnd !== -1 ? firstLineEnd : loadedContent.length;
        selection = { anchor: pos };
      }

      state = EditorState.create({
        doc: loadedContent,
        selection,
        extensions: [
          ...buildExtensions(),
          activeFileField.init(() => activeFile)
        ]
      });
      fileEditorStates.set(cacheKey, state);

      if (isNewState && vimMode) {
        setTimeout(() => {
          const currentView = viewRef.current;
          if (currentView) {
            const cm = getCM(currentView);
            if (cm && cm.state && cm.state.vim && !cm.state.vim.insertMode) {
              Vim.handleKey(cm, "i", "mapping");
            }
          }
        }, 50);
      }
    }

    let view = viewRef.current;
    if (!view) {
      view = new EditorView({
        state,
        parent: containerRef.current
      });
      viewRef.current = view;
      registerView(paneId, view);
      if (state.doc.toString() !== loadedContent && !isLocalDirtyRef.current) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: loadedContent },
          annotations: Transaction.userEvent.of("reload")
        });
      }
    } else {
      view.setState(state);
      if (state.doc.toString() !== loadedContent && !isLocalDirtyRef.current) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: loadedContent },
          annotations: Transaction.userEvent.of("reload")
        });
      }
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

      const cm = getCM(view);

      // Scroll overrun prevention for j/k in Vim normal/visual mode
      const isNormalModeVim = cm && cm.state && cm.state.vim && !cm.state.vim.insertMode;
      if (isNormalModeVim && (e.key === "j" || e.key === "k")) {
        if (e.repeat) {
          const now = performance.now();
          if (frameRequestedRef.current || now - lastScrollTimeRef.current < 20) {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
          frameRequestedRef.current = true;
          lastScrollTimeRef.current = now;
          requestAnimationFrame(() => {
            frameRequestedRef.current = false;
          });
        }
      }

      const isCtrlV = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.altKey && !e.shiftKey;
      const isCtrlQ = e.ctrlKey && e.key.toLowerCase() === 'q' && !e.altKey && !e.shiftKey && !e.metaKey;
      const isShiftI = e.shiftKey && e.key === 'I';
      const isEscape = e.key === 'Escape';
      const isX = e.key === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

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
      if (loadedFile && view && viewRef.current === view) {
        saveEditorState(paneId, loadedFile, view);
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
          vimCompartment.reconfigure(vimMode ? [Prec.highest(vim())] : []),
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
                onContextMenu={(e) => handleTabContextMenu(e, tab)}
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
      <div className="editor-wrapper" style={{ flex: 1, overflow: "hidden", position: "relative" }} onClick={onFocus} onContextMenu={handleEditorContextMenu}>
        {activeFile ? (
          <div ref={containerRef} key="editor-inner" className="editor-inner" style={{ height: "100%" }} />
        ) : (
          <div key="editor-empty" className="editor-empty-state">
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

      {contextMenu && (
        <div
          id={`context-menu-${paneId}`}
          className="tab-context-menu"
          style={{
            position: "fixed",
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 1000
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {contextMenu.type === "tab" && contextMenu.tab ? (
            <>
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  onCloseTab(paneId, contextMenu.tab!);
                  setContextMenu(null);
                }}
              >
                <span>Close</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Alt+W</span>
              </div>
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  const others = tabs.filter(t => t !== contextMenu.tab);
                  onCloseTabs(paneId, others);
                  setContextMenu(null);
                }}
              >
                <span>Close Others</span>
              </div>
              {tabs.indexOf(contextMenu.tab) < tabs.length - 1 && (
                <div
                  className="tab-context-menu-item"
                  onClick={() => {
                    const tabIdx = tabs.indexOf(contextMenu.tab!);
                    const toRight = tabs.slice(tabIdx + 1);
                    onCloseTabs(paneId, toRight);
                    setContextMenu(null);
                  }}
                >
                  <span>Close to the Right</span>
                </div>
              )}
              {tabs.indexOf(contextMenu.tab) > 0 && (
                <div
                  className="tab-context-menu-item"
                  onClick={() => {
                    const tabIdx = tabs.indexOf(contextMenu.tab!);
                    const toLeft = tabs.slice(0, tabIdx);
                    onCloseTabs(paneId, toLeft);
                    setContextMenu(null);
                  }}
                >
                  <span>Close to the Left</span>
                </div>
              )}
              <div className="tab-context-menu-separator" />
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  onCloseTabs(paneId, tabs);
                  setContextMenu(null);
                }}
              >
                <span>Close All</span>
              </div>
            </>
          ) : contextMenu.type === "editor" ? (
            <>
              <div
                className={`tab-context-menu-item ${!contextMenu.hasSelection ? "disabled" : ""}`}
                style={{
                  opacity: !contextMenu.hasSelection ? 0.4 : 1,
                  pointerEvents: !contextMenu.hasSelection ? "none" : "auto",
                  cursor: !contextMenu.hasSelection ? "not-allowed" : "pointer"
                }}
                onClick={() => {
                  const view = viewRef.current;
                  if (view && contextMenu.hasSelection) {
                    openReworkCommand(view);
                  }
                  setContextMenu(null);
                }}
              >
                <span>Rework Selection</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Alt+K</span>
              </div>
              <div className="tab-context-menu-separator" />
              <div
                className={`tab-context-menu-item ${!contextMenu.hasSelection ? "disabled" : ""}`}
                style={{
                  opacity: !contextMenu.hasSelection ? 0.4 : 1,
                  pointerEvents: !contextMenu.hasSelection ? "none" : "auto",
                  cursor: !contextMenu.hasSelection ? "not-allowed" : "pointer"
                }}
                onClick={() => {
                  const view = viewRef.current;
                  if (!view || !contextMenu.hasSelection) return;
                  const mainRange = view.state.selection.main;
                  if (mainRange.empty) return;
                  const text = view.state.doc.sliceString(mainRange.from, mainRange.to);
                  navigator.clipboard.writeText(text)
                    .then(() => {
                      view.dispatch({
                        changes: { from: mainRange.from, to: mainRange.to, insert: "" },
                        selection: { anchor: mainRange.from }
                      });
                    })
                    .catch(err => console.error(err));
                  setContextMenu(null);
                }}
              >
                <span>Cut</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Ctrl+X</span>
              </div>
              <div
                className={`tab-context-menu-item ${!contextMenu.hasSelection ? "disabled" : ""}`}
                style={{
                  opacity: !contextMenu.hasSelection ? 0.4 : 1,
                  pointerEvents: !contextMenu.hasSelection ? "none" : "auto",
                  cursor: !contextMenu.hasSelection ? "not-allowed" : "pointer"
                }}
                onClick={() => {
                  const view = viewRef.current;
                  if (!view || !contextMenu.hasSelection) return;
                  const mainRange = view.state.selection.main;
                  if (mainRange.empty) return;
                  const text = view.state.doc.sliceString(mainRange.from, mainRange.to);
                  navigator.clipboard.writeText(text).catch(err => console.error(err));
                  setContextMenu(null);
                }}
              >
                <span>Copy</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Ctrl+C</span>
              </div>
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  navigator.clipboard.readText()
                    .then((text) => {
                      const mainRange = view.state.selection.main;
                      view.dispatch({
                        changes: { from: mainRange.from, to: mainRange.to, insert: text },
                        selection: { anchor: mainRange.from + text.length }
                      });
                    })
                    .catch(err => console.error(err));
                  setContextMenu(null);
                }}
              >
                <span>Paste</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Ctrl+V</span>
              </div>
              <div className="tab-context-menu-separator" />
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  view.dispatch({
                    selection: { anchor: 0, head: view.state.doc.length }
                  });
                  setContextMenu(null);
                }}
              >
                <span>Select All</span>
                <span className="kbd-shortcut" style={{ fontSize: "9px" }}>Ctrl+A</span>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default EditorPaneComponent;
