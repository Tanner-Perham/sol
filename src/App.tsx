import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { prosePreviewPlugin } from "./prosePreviewPlugin";

function computeWordCount(content: string): number {
  return content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

function App() {
  const [workspacePath, setWorkspacePath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [vimMode, setVimMode] = useState(true);
  const [livePreview, setLivePreview] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [vimModeName, setVimModeName] = useState("NORMAL");
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [focusedComponent, setFocusedComponent] = useState<"editor" | "sidebar">("editor");
  const [sidebarSelectedIndex, setSidebarSelectedIndex] = useState(0);

  const editorContainer = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  // Load workspace path and files
  const loadWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string>("get_workspace_path");
      setWorkspacePath(path);
      const fileList = await invoke<string[]>("list_workspace_files");
      setFiles(fileList);

      if (fileList.length > 0) {
        // Auto-open test.md if it exists, otherwise the first file
        const defaultFile = fileList.find(f => f === "test.md") || fileList[0];
        await openFile(defaultFile, path);
      } else {
        // Create test.md automatically if workspace is empty
        await invoke<string>("create_markdown_file", { name: "test.md" });
        const updatedList = await invoke<string[]>("list_workspace_files");
        setFiles(updatedList);
        await openFile("test.md", path);
      }
    } catch (err) {
      console.error("Failed to load workspace", err);
    }
  }, []);

  // Run on mount
  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Open a file
  const openFile = async (fileName: string, wsPath?: string) => {
    const currentWS = wsPath || workspacePath;
    const filePath = `${currentWS}/${fileName}`;
    try {
      const content = await invoke<string>("read_markdown_file", { path: filePath });
      setActiveFile(fileName);
      setActiveFileContent(content);
      setIsDirty(false);
      setWordCount(computeWordCount(content));
    } catch (err) {
      console.error("Failed to read file", err);
    }
  };

  // Sync index when files or activeFile changes
  useEffect(() => {
    if (activeFile) {
      const idx = files.indexOf(activeFile);
      if (idx !== -1) {
        setSidebarSelectedIndex(idx);
      }
    }
  }, [activeFile, files]);

  // Save the current file
  const saveFile = useCallback(async () => {
    if (!activeFile) return;
    const filePath = `${workspacePath}/${activeFile}`;
    try {
      const currentContent = editorViewRef.current
        ? editorViewRef.current.state.doc.toString()
        : activeFileContent;

      await invoke("write_markdown_file", { path: filePath, content: currentContent });
      setIsDirty(false);
      setActiveFileContent(currentContent);

      // Refresh files list
      const fileList = await invoke<string[]>("list_workspace_files");
      setFiles(fileList);
    } catch (err) {
      console.error("Failed to save file", err);
    }
  }, [activeFile, workspacePath, activeFileContent]);

  // Save ref for Vim ex-command handler
  const triggerSaveRef = useRef(saveFile);
  useEffect(() => {
    triggerSaveRef.current = saveFile;
  }, [saveFile]);

  // Vim listeners configuration (Register global ex commands once)
  useEffect(() => {
    Vim.defineEx("w", "w", () => {
      triggerSaveRef.current();
    });
    Vim.defineEx("write", "write", () => {
      triggerSaveRef.current();
    });
  }, []);

  // Global key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Ctrl+S to save
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveFile();
        return;
      }

      // Ctrl+E or Ctrl+\ to toggle sidebar
      if ((e.key === "e" && (e.ctrlKey || e.metaKey)) || (e.key === "\\" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        setSidebarOpen(prev => !prev);
        return;
      }

      // Ctrl+P to toggle Live Preview
      if (e.key === "p" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setLivePreview(prev => !prev);
        return;
      }

      // Ctrl+H (or Ctrl+Shift+H/Tab) to focus sidebar / editor
      if (e.key === "Tab" && !isEditing) {
        e.preventDefault();
        setFocusedComponent(prev => (prev === "editor" ? "sidebar" : "editor"));
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveFile]);

  // Handle focus switching
  useEffect(() => {
    if (focusedComponent === "editor") {
      editorViewRef.current?.focus();
    } else if (focusedComponent === "sidebar") {
      sidebarRef.current?.focus();
    }
  }, [focusedComponent]);

  // Focus input when creating a file
  useEffect(() => {
    if (creatingFile) {
      newFileInputRef.current?.focus();
    }
  }, [creatingFile]);

  // Sidebar key bindings
  const handleSidebarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (creatingFile) return;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        setSidebarSelectedIndex((i) => Math.min(i + 1, files.length - 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        setSidebarSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (files[sidebarSelectedIndex]) {
          openFile(files[sidebarSelectedIndex]);
          setFocusedComponent("editor");
        }
        break;
      case "Escape":
        e.preventDefault();
        setFocusedComponent("editor");
        break;
      default:
        break;
    }
  };

  // Create file submit
  const handleNewFileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFileName.trim();
    if (!name) {
      setCreatingFile(false);
      return;
    }

    const nameWithExt = name.endsWith(".md") ? name : `${name}.md`;
    try {
      await invoke("create_markdown_file", { name: nameWithExt });
      setCreatingFile(false);
      setNewFileName("");

      const fileList = await invoke<string[]>("list_workspace_files");
      setFiles(fileList);
      await openFile(nameWithExt);
      setFocusedComponent("editor");
    } catch (err) {
      console.error("Failed to create file", err);
    }
  };

  // CodeMirror initialization & lifecycle
  useEffect(() => {
    if (!editorContainer.current || !activeFile) return;

    const extensions = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          setIsDirty(true);
          const docString = update.state.doc.toString();
          setWordCount(computeWordCount(docString));
        }
      }),
      EditorView.theme({
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
        ".cm-cursor": {
          borderLeftColor: "var(--accent) !important",
        },
        ".cm-activeLine": {
          backgroundColor: "transparent",
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: "rgba(207, 177, 140, 0.2) !important",
        },
      }, { dark: true })
    ];

    if (vimMode) {
      extensions.unshift(vim());
    }

    if (livePreview) {
      extensions.push(prosePreviewPlugin);
    }

    const startState = EditorState.create({
      doc: activeFileContent,
      extensions
    });

    const view = new EditorView({
      state: startState,
      parent: editorContainer.current
    });

    editorViewRef.current = view;

    if (vimMode) {
      const cm = getCM(view);
      if (cm) {
        cm.on("vim-mode-change", (e: any) => {
          if (e && e.mode) {
            setVimModeName(e.mode.toUpperCase());
          }
        });
      }
    }

    if (focusedComponent === "editor") {
      view.focus();
    }

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
    // Recreate editor ONLY when file itself, vim mode toggle, or live preview toggle changes
  }, [activeFile, vimMode, livePreview]);

  return (
    <div className="app-container fade-in">
      <header className="app-header">
        <div className="app-title-group">
          <svg className="logo-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="app-title">SOL</span>
          <span className="app-subtitle">workspace</span>
        </div>

        <div className="app-actions">
          <button
            className={`status-toggle ${livePreview ? "active" : ""}`}
            onClick={() => setLivePreview(prev => !prev)}
            title="Toggle Live Preview (Ctrl+P)"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px" }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className={`app-sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="sidebar-header">
            <span className="sidebar-title">Documents</span>
            <button
              className="btn-new-file"
              onClick={() => setCreatingFile(true)}
              title="Create new markdown file"
            >
              + New
            </button>
          </div>

          {creatingFile && (
            <form onSubmit={handleNewFileSubmit} className="new-file-form">
              <input
                ref={newFileInputRef}
                className="new-file-input"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onBlur={() => {
                  setCreatingFile(false);
                  setNewFileName("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreatingFile(false);
                    setNewFileName("");
                  }
                  e.stopPropagation();
                }}
                placeholder="filename.md"
              />
            </form>
          )}

          <div
            ref={sidebarRef}
            className="file-list"
            tabIndex={0}
            onKeyDown={handleSidebarKeyDown}
            onFocus={() => setFocusedComponent("sidebar")}
          >
            {files.length === 0 && !creatingFile && (
              <div className="file-list-empty">
                No files found in workspace. Click "+ New" to get started.
              </div>
            )}
            {files.map((file, idx) => {
              const isActive = activeFile === file;
              const isSelected = idx === sidebarSelectedIndex;
              return (
                <button
                  key={file}
                  className={`file-item ${isActive ? "active" : ""} ${isSelected && focusedComponent === "sidebar" ? "kb-selected" : ""}`}
                  onClick={() => {
                    setSidebarSelectedIndex(idx);
                    openFile(file);
                    setFocusedComponent("editor");
                  }}
                >
                  <svg className="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span>{file.replace(/\.md$/, "")}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="app-main">
          <div className="editor-wrapper" onClick={() => setFocusedComponent("editor")}>
            <div
              key={activeFile}
              ref={editorContainer}
              className="editor-inner"
            />
          </div>

        </main>
      </div>

      <footer className="app-status-bar">
        <div className="status-section">
          <span className="status-filename">{activeFile || "No file open"}</span>
          {isDirty && <span className="status-dirty-dot" title="Unsaved changes" />}
        </div>
        <button
          className={`status-toggle ${vimMode ? "active" : ""}`}
          onClick={() => setVimMode(prev => !prev)}
          title="Toggle Vim Mode"
        >
          Vim
        </button>
        <div className="status-spacer" />
        {vimMode && (
          <div className="status-section">
            <span className="status-badge-vim">VIM</span>
            <span className="status-badge-mode">{vimModeName}</span>
          </div>
        )}
        <div className="status-section">
          <span>{wordCount.toLocaleString()} words</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
