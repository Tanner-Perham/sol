import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Vim } from "@replit/codemirror-vim";
import { Transaction } from "@codemirror/state";
// Shared Types and Constants
import { PaneId, LeafPane, PaneNode, FileNode, Keybindings, AppSettings } from "./types";
import { DEFAULT_KEYBINDINGS, DEFAULT_SETTINGS } from "./constants";

// Utilities
import { matchKeybinding } from "./utils/keybindingUtils";
import { findLeafNode, getLeafPaneIds, removePaneFromTree, findDefaultFile } from "./utils/treeUtils";
import { computeWordCount, findHeaderLine, threeWayMerge, computeSimpleLineDiff } from "./utils/editorUtils";

// Components
import { Sidebar, VisibleItem } from "./components/Sidebar";
import { SettingsModal, SettingsTabType } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { EditorPaneComponent, pruneEditorState, renameEditorState, saveEditorState } from "./components/EditorPane/EditorPane";
import { clearSuggestion } from "./components/EditorPane/ghostTextExtension";
import { RightTray, BottomTray } from "./components/Trays";

function App() {
  const [workspacePath, setWorkspacePath] = useState("");
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [aiDebugInfo, setAiDebugInfo] = useState<any>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabType>("general");
  const [recordingHotkey, setRecordingHotkey] = useState<keyof Keybindings | null>(null);

  const [creatingNode, setCreatingNode] = useState<{ type: "file" | "dir"; parentPath: string } | null>(null);
  const [newInputName, setNewInputName] = useState("");
  const [pathToHighlight, setPathToHighlight] = useState<string | null>(null);
  
  // Layout state
  const [layout, setLayout] = useState<PaneNode>({
    type: "leaf",
    id: "pane-root",
    activeFile: null,
    tabs: []
  });
  const [activePaneId, setActivePaneId] = useState<PaneId>("pane-root");
  const [prefixActive, setPrefixActive] = useState(false);
  
  // Global mirror state for the active editor (updated from active pane callbacks)
  const [isDirty, setIsDirty] = useState(false);
  const [wordCount, setWordCount] = useState(0);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [vimModeName, setVimModeName] = useState("NORMAL");
  const [focusedComponent, setFocusedComponent] = useState<"editor" | "sidebar">("editor");
  const [sidebarSelectedIndex, setSidebarSelectedIndex] = useState(0);

  // Bottom and Right Tray States & Persistence
  const [bottomTrayOpen, setBottomTrayOpen] = useState(() => {
    return localStorage.getItem("sol_bottom_tray_open") === "true";
  });
  const [rightTrayOpen, setRightTrayOpen] = useState(() => {
    return localStorage.getItem("sol_right_tray_open") === "true";
  });
  const [bottomTrayHeight, setBottomTrayHeight] = useState(() => {
    const saved = localStorage.getItem("sol_bottom_tray_height");
    return saved ? parseInt(saved, 10) : 200;
  });
  const [rightTrayWidth, setRightTrayWidth] = useState(() => {
    const saved = localStorage.getItem("sol_right_tray_width");
    return saved ? parseInt(saved, 10) : 260;
  });
  const [activeContent, setActiveContent] = useState("");
  const [activeBottomTab, setActiveBottomTab] = useState<"console" | "ai" | "scratchpad">("console");
  const [activeRightTab, setActiveRightTab] = useState<"outline" | "info">("outline");
  const [scratchpadContent, setScratchpadContent] = useState(() => {
    return localStorage.getItem("sol_scratchpad_content") || "";
  });

  interface LogEntry {
    id: string;
    time: string;
    text: string;
    type: "info" | "success" | "warn" | "error";
  }
  const [consoleLogs, setConsoleLogs] = useState<LogEntry[]>([
    { id: "init", time: new Date().toLocaleTimeString(), text: "Sol initialized.", type: "info" }
  ]);

  const addConsoleLog = useCallback((text: string, type: "info" | "success" | "warn" | "error" = "info") => {
    setConsoleLogs(prev => [
      ...prev,
      { id: Math.random().toString(), time: new Date().toLocaleTimeString(), text, type }
    ].slice(-100));
  }, []);

  const toggleBottomTray = useCallback(() => {
    setBottomTrayOpen(prev => !prev);
  }, []);

  const scrollToHeader = useCallback((headerText: string) => {
    if (!activePaneIdRef.current) return;
    const view = editorViewsRef.current.get(activePaneIdRef.current);
    if (view) {
      view.focus();
      const lineNum = findHeaderLine(view.state.doc, headerText);
      if (lineNum !== null) {
        const line = view.state.doc.line(lineNum);
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true
        });
      }
    }
  }, []);

  // Sync state changes to localStorage
  useEffect(() => {
    localStorage.setItem("sol_bottom_tray_open", bottomTrayOpen ? "true" : "false");
  }, [bottomTrayOpen]);

  useEffect(() => {
    localStorage.setItem("sol_right_tray_open", rightTrayOpen ? "true" : "false");
  }, [rightTrayOpen]);

  useEffect(() => {
    localStorage.setItem("sol_bottom_tray_height", bottomTrayHeight.toString());
  }, [bottomTrayHeight]);

  useEffect(() => {
    localStorage.setItem("sol_right_tray_width", rightTrayWidth.toString());
  }, [rightTrayWidth]);

  useEffect(() => {
    localStorage.setItem("sol_scratchpad_content", scratchpadContent);
  }, [scratchpadContent]);

  // Handle Bottom Tray Resize Dragging
  const [isBottomTrayResizing, setIsBottomTrayResizing] = useState(false);
  const handleBottomTrayMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsBottomTrayResizing(true);
  }, []);

  useEffect(() => {
    if (!isBottomTrayResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const bottomLimit = window.innerHeight - 32;
      const newHeight = Math.max(100, Math.min(500, bottomLimit - e.clientY));
      setBottomTrayHeight(newHeight);
    };
    const handleMouseUp = () => {
      setIsBottomTrayResizing(false);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isBottomTrayResizing]);

  // Handle Right Tray Resize Dragging
  const [isRightTrayResizing, setIsRightTrayResizing] = useState(false);
  const handleRightTrayMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsRightTrayResizing(true);
  }, []);

  useEffect(() => {
    if (!isRightTrayResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(500, window.innerWidth - e.clientX));
      setRightTrayWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsRightTrayResizing(false);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isRightTrayResizing]);

  const prevBottomTrayOpenRef = useRef(bottomTrayOpen);

  useEffect(() => {
    if (prevBottomTrayOpenRef.current && !bottomTrayOpen) {
      if (activePaneId) {
        const view = editorViewsRef.current.get(activePaneId);
        if (view) {
          view.focus();
          setFocusedComponent("editor");
        }
      }
    }
    prevBottomTrayOpenRef.current = bottomTrayOpen;
  }, [bottomTrayOpen, activePaneId]);



  const updateSettings = useCallback(async (newSettings: Partial<AppSettings>) => {
    if (newSettings.completionEnabled === false) {
      invoke("cancel_completion").catch(() => {});
      // Clear suggestions immediately on all active editors
      editorViewsRef.current.forEach((view) => {
        try {
          view.dispatch({ effects: clearSuggestion.of() });
        } catch (e) {
          // ignore if view is not initialized or state field is not present
        }
      });
    }
    setSettings(prev => ({ ...prev, ...newSettings }));
  }, []);

  useEffect(() => {
    if (!workspacePath) return;
    if (isSettingsLoadingRef.current) {
      isSettingsLoadingRef.current = false;
      return;
    }
    invoke("write_settings", { settingsJson: JSON.stringify(settings, null, 2) })
      .catch(err => console.error("Failed to save settings", err));
  }, [settings, workspacePath]);

  // Recording keybindings effect
  useEffect(() => {
    if (!recordingHotkey) return;

    const handleRecordKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = e.key;

      // Ignore individual modifier key presses
      if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
        return;
      }

      // Escape key cancels the recording
      if (key === "Escape") {
        setRecordingHotkey(null);
        return;
      }

      const parts: string[] = [];
      const isMac = navigator.userAgent.indexOf("Mac") !== -1;

      // Standardize meta/ctrl as "mod"
      if (e.metaKey) {
        parts.push(isMac ? "mod" : "meta");
      } else if (e.ctrlKey) {
        parts.push(isMac ? "ctrl" : "mod");
      }

      if (e.altKey) {
        parts.push("alt");
      }

      if (e.shiftKey) {
        parts.push("shift");
      }

      // Standardize key names
      let baseKey = key.toLowerCase();
      if (baseKey === " ") baseKey = "space";
      else if (baseKey === "arrowup") baseKey = "up";
      else if (baseKey === "arrowdown") baseKey = "down";
      else if (baseKey === "arrowleft") baseKey = "left";
      else if (baseKey === "arrowright") baseKey = "right";

      parts.push(baseKey);
      const newHotkeyStr = parts.join("+");

      // Save custom keybinding
      updateSettings({
        keybindings: {
          ...(settings.keybindings || DEFAULT_KEYBINDINGS),
          [recordingHotkey]: newHotkeyStr
        }
      });

      setRecordingHotkey(null);
    };

    window.addEventListener("keydown", handleRecordKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordKeyDown, true);
    };
  }, [recordingHotkey, settings.keybindings, updateSettings]);

  // Derived state
  const activeLeaf = findLeafNode(layout, activePaneId);
  const activeFile = activeLeaf ? activeLeaf.activeFile : null;

  const activeFileRef = useRef<string | null>(null);
  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  // Refs
  const editorViewsRef = useRef<Map<PaneId, any>>(new Map());
  const paneStatesRef = useRef<Map<PaneId, { isDirty: boolean; wordCount: number }>>(new Map());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const reloadTreeRef = useRef<any>(null);
  const prevActiveFileRef = useRef<string | null>(null);
  const inputFocusedRef = useRef(false);
  const skipExpandRef = useRef(false);
  const fileMtimesRef = useRef<Map<string, number>>(new Map());
  const fileBasesRef = useRef<Map<string, string>>(new Map());
  const isSettingsLoadingRef = useRef(false);

  const [conflictInfo, setConflictInfo] = useState<{ path: string; localContent: string; diskContent: string } | null>(null);
  const conflictResolveRef = useRef<((value: "overwrite" | "reload" | "cancel") => void) | null>(null);

  const [aiStatus, setAiStatus] = useState<'allowed' | 'excluded' | 'loading'>('allowed');

  const checkFileAiStatus = useCallback(async (relativePath: string | null) => {
    if (!relativePath) {
      setAiStatus("allowed");
      return;
    }
    try {
      setAiStatus("loading");
      const allowed = await invoke<boolean>("is_note_allowed", { path: relativePath });
      setAiStatus(allowed ? "allowed" : "excluded");
    } catch (err) {
      console.error("Error checking AI status:", err);
      setAiStatus("allowed");
    }
  }, []);

  useEffect(() => {
    checkFileAiStatus(activeFile);
  }, [activeFile, checkFileAiStatus]);

  useEffect(() => {
    if (!activeFile) {
      setActiveContent("");
      return;
    }
    const view = activePaneId ? editorViewsRef.current.get(activePaneId) : null;
    if (view) {
      setActiveContent(view.state.doc.toString());
    } else {
      invoke<{ content: string; mtime: number }>("read_markdown_file", { path: activeFile })
        .then((res) => {
          setActiveContent(res.content);
        })
        .catch((err) => {
          console.error("Error pre-reading active file", err);
          setActiveContent("");
        });
    }
  }, [activeFile, activePaneId]);


  useEffect(() => {
    return () => {
      if (conflictResolveRef.current) {
        conflictResolveRef.current("cancel");
        conflictResolveRef.current = null;
      }
      setConflictInfo(null);
    };
  }, [workspacePath]);

  const writeMarkdownFileWithConflictCheck = useCallback(async (relativePath: string, content: string, force: boolean = false) => {
    const expectedMtime = force ? undefined : fileMtimesRef.current.get(relativePath);
    try {
      const newMtime = await invoke<number>("write_markdown_file", {
        path: relativePath,
        content,
        expectedMtime
      });
      fileMtimesRef.current.set(relativePath, newMtime);
      fileBasesRef.current.set(relativePath, content);
      return true;
    } catch (err: any) {
      if (err === "conflict") {
        console.log(`Conflict detected for ${relativePath}`);
        addConsoleLog(`Conflict detected for ${relativePath}`, "warn");
        let diskRes;
        try {
          diskRes = await invoke<{ content: string; mtime: number }>("read_markdown_file", { path: relativePath });
        } catch (readErr) {
          console.error("Failed to read conflicting file from disk", readErr);
          alert(`Failed to save: ${err}`);
          return false;
        }

        const baseContent = fileBasesRef.current.get(relativePath) || "";
        const mergeRes = threeWayMerge(baseContent, content, diskRes.content);
        if (mergeRes.success) {
          console.log(`Auto-merged external changes successfully for ${relativePath}`);
          addConsoleLog(`Auto-merged external changes successfully for ${relativePath}`, "success");
          try {
            const newMtime = await invoke<number>("write_markdown_file", {
              path: relativePath,
              content: mergeRes.mergedText,
              expectedMtime: undefined
            });
            fileMtimesRef.current.set(relativePath, newMtime);
            fileBasesRef.current.set(relativePath, mergeRes.mergedText);

            const currentLayout = layoutRef.current;
            const leafIds = getLeafPaneIds(currentLayout);
            leafIds.forEach((pId) => {
              const leaf = findLeafNode(currentLayout, pId);
              if (leaf && leaf.activeFile === relativePath) {
                const view = editorViewsRef.current.get(pId);
                if (view) {
                  view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: mergeRes.mergedText }
                  });
                }
                paneStatesRef.current.set(pId, { isDirty: false, wordCount: computeWordCount(mergeRes.mergedText) });
                if (pId === activePaneIdRef.current) {
                  setIsDirty(false);
                  setWordCount(computeWordCount(mergeRes.mergedText));
                }
              }
            });
            return true;
          } catch (mergeWriteErr) {
            console.error("Failed to write merged content", mergeWriteErr);
          }
        }

        const choice = await new Promise<"overwrite" | "reload" | "cancel">((resolve) => {
          conflictResolveRef.current = resolve;
          setConflictInfo({ path: relativePath, localContent: content, diskContent: diskRes.content });
        });
        setConflictInfo(null);
        conflictResolveRef.current = null;

        if (choice === "overwrite") {
          try {
            const newMtime = await invoke<number>("write_markdown_file", {
              path: relativePath,
              content,
              expectedMtime: undefined
            });
            fileMtimesRef.current.set(relativePath, newMtime);
            fileBasesRef.current.set(relativePath, content);
            return true;
          } catch (retryErr) {
            console.error("Force write failed", retryErr);
            alert(`Failed to save: ${retryErr}`);
            return false;
          }
        } else if (choice === "reload") {
          fileMtimesRef.current.set(relativePath, diskRes.mtime);
          fileBasesRef.current.set(relativePath, diskRes.content);
          
          const currentLayout = layoutRef.current;
          const leafIds = getLeafPaneIds(currentLayout);
          leafIds.forEach((pId) => {
            const leaf = findLeafNode(currentLayout, pId);
            if (leaf && leaf.activeFile === relativePath) {
              const view = editorViewsRef.current.get(pId);
              if (view) {
                view.dispatch({
                  changes: { from: 0, to: view.state.doc.length, insert: diskRes.content }
                });
              }
              paneStatesRef.current.set(pId, { isDirty: false, wordCount: computeWordCount(diskRes.content) });
              if (pId === activePaneIdRef.current) {
                setIsDirty(false);
                setWordCount(computeWordCount(diskRes.content));
              }
            }
          });
          return false;
        } else {
          return false;
        }
      } else {
        console.error("Failed to write file:", err);
        alert(`Failed to save: ${err}`);
        return false;
      }
    }
  }, []);

  // Load workspace path and files
  const loadWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string>("get_workspace_path");
      if (!path) {
        setWorkspacePath("");
        setFileTree([]);
        return;
      }
      setWorkspacePath(path);
      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);

      // Load settings
      try {
        isSettingsLoadingRef.current = true;
        const settingsStr = await invoke<string>("read_settings");
        const parsed = JSON.parse(settingsStr);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (err) {
        console.error("Failed to load settings", err);
      }

      const defaultFile = findDefaultFile(tree);
      if (defaultFile) {
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: defaultFile,
          tabs: [defaultFile]
        });
        setActivePaneId("pane-root");
      } else {
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: null,
          tabs: []
        });
        setActivePaneId("pane-root");
      }
    } catch (err) {
      console.error("Failed to load workspace", err);
    }
  }, []);

  const changeWorkspace = async () => {
    try {
      // Auto-save active file if dirty before switching workspace
      if (activePaneId && activeLeaf && activeLeaf.activeFile) {
        const view = editorViewsRef.current.get(activePaneId);
        const paneState = paneStatesRef.current.get(activePaneId);
        if (paneState?.isDirty && view) {
          const content = view.state.doc.toString();
          const timeout = saveTimeoutsRef.current.get(activeLeaf.activeFile);
          if (timeout) {
            clearTimeout(timeout);
            saveTimeoutsRef.current.delete(activeLeaf.activeFile);
          }
          try {
            await writeMarkdownFileWithConflictCheck(activeLeaf.activeFile, content);
          } catch (err) {
            console.error("Failed to auto-save file on workspace change", err);
          }
        }
      }

      interface ChangeWorkspaceResult {
        workspace_path: string;
        tree: FileNode[];
      }
      const res = await invoke<ChangeWorkspaceResult | null>("change_workspace");
      if (!res) return;

      const { workspace_path: selectedPath, tree: newTree } = res;
      setWorkspacePath(selectedPath);
      setFileTree(newTree);
      setExpandedPaths(new Set());
      setSidebarSelectedIndex(0);

      // Load settings for the new workspace
      try {
        isSettingsLoadingRef.current = true;
        const settingsStr = await invoke<string>("read_settings");
        const parsed = JSON.parse(settingsStr);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (err) {
        console.error("Failed to load settings on workspace change", err);
      }

      const defaultFile = findDefaultFile(newTree);
      if (defaultFile) {
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: defaultFile,
          tabs: [defaultFile]
        });
        setActivePaneId("pane-root");
      } else {
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: null,
          tabs: []
        });
        setActivePaneId("pane-root");
      }
    } catch (err) {
      console.error("Failed to change workspace", err);
    }
  };

  // Dynamically apply settings as CSS variables and classes to the root
  useEffect(() => {
    const root = document.documentElement;
    
    // Remove previous themes
    root.classList.forEach(cls => {
      if (cls.startsWith("theme-")) {
        root.classList.remove(cls);
      }
    });

    // Add current theme class
    root.classList.add(`theme-${settings.theme}`);

    // Update typography CSS variables
    root.style.setProperty("--editor-font-family", `var(--font-${settings.fontFamily})`);
    root.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
    root.style.setProperty("--editor-line-height", `${settings.lineHeight}`);
  }, [settings.theme, settings.fontFamily, settings.fontSize, settings.lineHeight]);

  // Run on mount
  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Open a file
  const openFile = async (fileName: string) => {
    if (!activePaneId) return;
    const leaf = findLeafNode(layout, activePaneId);
    if (!leaf) return;

    // Split fileName into relativePath and header
    const hashIdx = fileName.indexOf("#");
    const relativePath = hashIdx !== -1 ? fileName.substring(0, hashIdx) : fileName;
    const header = hashIdx !== -1 ? fileName.substring(hashIdx + 1) : null;

    addConsoleLog(`Opening note: ${relativePath}${header ? ` at #${header}` : ""}`, "info");

    if (leaf.activeFile === relativePath) {
      // Just focus it and scroll to header if present
      setFocusedComponent("editor");
      const view = editorViewsRef.current.get(activePaneId);
      if (view) {
        view.focus();
        if (header) {
          const lineNum = findHeaderLine(view.state.doc, header);
          if (lineNum !== null) {
            const line = view.state.doc.line(lineNum);
            view.dispatch({
              selection: { anchor: line.from },
              scrollIntoView: true
            });
          }
        }
      }
      return;
    }

    // Auto-save current active file in the active pane if it is dirty
    const view = editorViewsRef.current.get(activePaneId);
    const paneState = paneStatesRef.current.get(activePaneId);
    if (leaf.activeFile && paneState?.isDirty && view) {
      const content = view.state.doc.toString();
      const timeout = saveTimeoutsRef.current.get(leaf.activeFile);
      if (timeout) {
        clearTimeout(timeout);
        saveTimeoutsRef.current.delete(leaf.activeFile);
      }
      try {
        await writeMarkdownFileWithConflictCheck(leaf.activeFile, content);
      } catch (err) {
        console.error("Failed to auto-save file on switch", err);
      }
    }

    // Save pending header in ref if present
    if (header) {
      pendingHeadersRef.current.set(activePaneId, header);
    }

    try {
      const res = await invoke<{ content: string; mtime: number }>("read_markdown_file", { path: relativePath });
      fileMtimesRef.current.set(relativePath, res.mtime);
      fileBasesRef.current.set(relativePath, res.content);
      const content = res.content;
      
      paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: computeWordCount(content) });
      setIsDirty(false);
      setWordCount(computeWordCount(content));

      const updateActivePane = (node: PaneNode): PaneNode => {
        if (node.type === "leaf") {
          if (node.id === activePaneId) {
            const nextTabs = node.tabs.includes(relativePath) ? node.tabs : [...node.tabs, relativePath];
            return {
              ...node,
              tabs: nextTabs,
              activeFile: relativePath
            };
          }
          return node;
        }
        return {
          ...node,
          children: node.children.map(updateActivePane)
        };
      };

      setLayout(updateActivePane(layout));
      setFocusedComponent("editor");
    } catch (err) {
      console.error("Failed to read file", err);
    }
  };

  const openPeriodicNote = async (relativePath: string) => {
    try {
      skipExpandRef.current = true;
      let exists = false;
      try {
        await invoke("read_markdown_file", { path: relativePath });
        exists = true;
      } catch (e) {
        exists = false;
      }

      if (!exists) {
        await invoke("create_markdown_file", { name: relativePath });
        const tree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(tree);
      }

      await openFile(relativePath);
    } catch (err) {
      console.error("Failed to open or create periodic note:", err);
    }
  };

  const openPolicyFile = useCallback(async () => {
    try {
      setShowSettingsModal(false);
      const policyFile = await invoke<string>("open_policy_file");
      await openFile(policyFile);
    } catch (err) {
      console.error("Failed to open policy file:", err);
    }
  }, [openFile]);

  const openPolicyFileRef = useRef(openPolicyFile);
  useEffect(() => {
    openPolicyFileRef.current = openPolicyFile;
  }, [openPolicyFile]);

  const openReworkPromptFile = useCallback(async () => {
    try {
      setShowSettingsModal(false);
      const reworkPromptFile = await invoke<string>("open_rework_prompt_file");
      await openFile(reworkPromptFile);
    } catch (err) {
      console.error("Failed to open rework prompt file:", err);
    }
  }, [openFile]);

  // Close a tab
  const closeTab = async (paneId: PaneId, fileName: string) => {
    const leaf = findLeafNode(layout, paneId);
    if (!leaf) return;

    const view = editorViewsRef.current.get(paneId);
    const paneState = paneStatesRef.current.get(paneId);
    if (leaf.activeFile === fileName && paneState?.isDirty && view) {
      const content = view.state.doc.toString();
      const timeout = saveTimeoutsRef.current.get(fileName);
      if (timeout) {
        clearTimeout(timeout);
        saveTimeoutsRef.current.delete(fileName);
      }
      try {
        await writeMarkdownFileWithConflictCheck(fileName, content);
      } catch (err) {
        console.error("Failed to auto-save file on close", err);
      }
    }

    const closedIdx = leaf.tabs.indexOf(fileName);
    const newTabs = leaf.tabs.filter((t) => t !== fileName);

    pruneEditorState(paneId, fileName);

    let nextActiveFile = leaf.activeFile;
    if (leaf.activeFile === fileName) {
      if (newTabs.length > 0) {
        const nextActiveIdx = Math.min(closedIdx, newTabs.length - 1);
        nextActiveFile = newTabs[nextActiveIdx];
      } else {
        nextActiveFile = null;
      }
    }

    const updatePaneInTree = (node: PaneNode): PaneNode => {
      if (node.type === "leaf") {
        if (node.id === paneId) {
          return {
            ...node,
            tabs: newTabs,
            activeFile: nextActiveFile
          };
        }
        return node;
      }
      return {
        ...node,
        children: node.children.map(updatePaneInTree)
      };
    };

    let updatedLayout = updatePaneInTree(layout);

    if (newTabs.length === 0) {
      const cleanTree = removePaneFromTree(updatedLayout, paneId);
      if (cleanTree) {
        updatedLayout = cleanTree;
      } else {
        updatedLayout = {
          type: "leaf",
          id: "pane-root",
          activeFile: null,
          tabs: []
        };
      }
      editorViewsRef.current.delete(paneId);
      paneStatesRef.current.delete(paneId);
    }

    setLayout(updatedLayout);
 
     const leafIds = getLeafPaneIds(updatedLayout);
     if (!leafIds.includes(activePaneId)) {
       const nextActivePaneId = leafIds[0] || "pane-root";
       setActivePaneId(nextActivePaneId);
       
       const nextState = paneStatesRef.current.get(nextActivePaneId) || { isDirty: false, wordCount: 0 };
       setIsDirty(nextState.isDirty);
       setWordCount(nextState.wordCount);
     }
   };
 
   // Close multiple tabs in a pane
   const closeTabs = async (paneId: PaneId, fileNamesToClose: string[]) => {
     const leaf = findLeafNode(layout, paneId);
     if (!leaf) return;
 
     // 1. Save the active file if it is in the list of files to close, is dirty, and has a view
     const view = editorViewsRef.current.get(paneId);
     const paneState = paneStatesRef.current.get(paneId);
     if (leaf.activeFile && fileNamesToClose.includes(leaf.activeFile) && paneState?.isDirty && view) {
       const content = view.state.doc.toString();
       const timeout = saveTimeoutsRef.current.get(leaf.activeFile);
       if (timeout) {
         clearTimeout(timeout);
         saveTimeoutsRef.current.delete(leaf.activeFile);
       }
       try {
         await writeMarkdownFileWithConflictCheck(leaf.activeFile, content);
       } catch (err) {
         console.error("Failed to auto-save file on closeTabs", err);
       }
     }
 
     // 2. Clear timeouts and prune editor states for all closed files
     fileNamesToClose.forEach((fileName) => {
       const timeout = saveTimeoutsRef.current.get(fileName);
       if (timeout) {
         clearTimeout(timeout);
         saveTimeoutsRef.current.delete(fileName);
       }
       pruneEditorState(paneId, fileName);
     });
 
     const newTabs = leaf.tabs.filter((t) => !fileNamesToClose.includes(t));
 
     // 3. Find next active file if current active file is being closed
     let nextActiveFile = leaf.activeFile;
     if (leaf.activeFile && fileNamesToClose.includes(leaf.activeFile)) {
       const closedIdx = leaf.tabs.indexOf(leaf.activeFile);
       let found = false;
       for (let i = closedIdx + 1; i < leaf.tabs.length; i++) {
         if (!fileNamesToClose.includes(leaf.tabs[i])) {
           nextActiveFile = leaf.tabs[i];
           found = true;
           break;
         }
       }
       if (!found) {
         for (let i = closedIdx - 1; i >= 0; i--) {
           if (!fileNamesToClose.includes(leaf.tabs[i])) {
             nextActiveFile = leaf.tabs[i];
             found = true;
             break;
           }
         }
       }
       if (!found) {
         nextActiveFile = null;
       }
     }
 
     const updatePaneInTree = (node: PaneNode): PaneNode => {
       if (node.type === "leaf") {
         if (node.id === paneId) {
           return {
             ...node,
             tabs: newTabs,
             activeFile: nextActiveFile
           };
         }
         return node;
       }
       return {
         ...node,
         children: node.children.map(updatePaneInTree)
       };
     };
 
     let updatedLayout = updatePaneInTree(layout);
 
     if (newTabs.length === 0) {
       const cleanTree = removePaneFromTree(updatedLayout, paneId);
       if (cleanTree) {
         updatedLayout = cleanTree;
       } else {
         updatedLayout = {
           type: "leaf",
           id: "pane-root",
           activeFile: null,
           tabs: []
         };
       }
       editorViewsRef.current.delete(paneId);
       paneStatesRef.current.delete(paneId);
     }
 
     setLayout(updatedLayout);
 
     const leafIds = getLeafPaneIds(updatedLayout);
     if (!leafIds.includes(activePaneId)) {
       const nextActivePaneId = leafIds[0] || "pane-root";
       setActivePaneId(nextActivePaneId);
       
       const nextState = paneStatesRef.current.get(nextActivePaneId) || { isDirty: false, wordCount: 0 };
       setIsDirty(nextState.isDirty);
       setWordCount(nextState.wordCount);
     }
   };

  // Rename a path inside layout node and migrate states
  const renamePathInLayout = (node: PaneNode, oldPath: string, newPath: string, isDir: boolean): PaneNode => {
    const mapPath = (p: string) => {
      if (isDir) {
        if (p === oldPath) return newPath;
        if (p.startsWith(oldPath + "/")) {
          return newPath + p.slice(oldPath.length);
        }
      } else {
        if (p === oldPath) return newPath;
      }
      return p;
    };

    if (node.type === "leaf") {
      const newTabs = node.tabs.map(mapPath);
      const nextActive = node.activeFile ? mapPath(node.activeFile) : null;
      
      node.tabs.forEach(t => {
        const mapped = mapPath(t);
        if (mapped !== t) {
          renameEditorState(node.id, t, mapped);
          
          if (fileMtimesRef.current.has(t)) {
            fileMtimesRef.current.set(mapped, fileMtimesRef.current.get(t)!);
            fileMtimesRef.current.delete(t);
          }
          if (fileBasesRef.current.has(t)) {
            fileBasesRef.current.set(mapped, fileBasesRef.current.get(t)!);
            fileBasesRef.current.delete(t);
          }
        }
      });

      return {
        ...node,
        tabs: newTabs,
        activeFile: nextActive
      };
    }

    return {
      ...node,
      children: node.children.map(c => renamePathInLayout(c, oldPath, newPath, isDir))
    };
  };

  const deleteItem = async (itemPath: string, isDir: boolean) => {
    const baseName = itemPath.split(/[/\\]/).pop() || itemPath;
    if (!window.confirm(`Are you sure you want to delete "${baseName}"?${isDir ? " This will delete all contents inside this directory." : ""}`)) {
      return;
    }

    try {
      await invoke("delete_item", { path: itemPath });

      const shouldClose = (tabPath: string) => {
        if (isDir) {
          return tabPath === itemPath || tabPath.startsWith(itemPath + "/");
        } else {
          return tabPath === itemPath;
        }
      };

      const closeTabsForDeleted = (node: PaneNode): PaneNode => {
        if (node.type === "leaf") {
          const newTabs = node.tabs.filter(t => !shouldClose(t));
          let nextActive = node.activeFile;
          if (node.activeFile && shouldClose(node.activeFile)) {
            nextActive = newTabs.length > 0 ? newTabs[0] : null;
            pruneEditorState(node.id, node.activeFile);
          }
          return {
            ...node,
            tabs: newTabs,
            activeFile: nextActive
          };
        }
        return {
          ...node,
          children: node.children.map(closeTabsForDeleted)
        };
      };

      setLayout(prevLayout => closeTabsForDeleted(prevLayout));

      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to delete item", err);
    }
  };

  const renameItem = async (oldPath: string, newName: string, isDir: boolean, isBlur: boolean) => {
    const parts = oldPath.split("/");
    
    // Auto-append .md if renaming a file and they didn't specify an extension
    let finalNewName = newName;
    if (!isDir) {
      const hasExtension = (pathStr: string): boolean => {
        const dotIndex = pathStr.lastIndexOf('.');
        return dotIndex > 0 && dotIndex < pathStr.length - 1;
      };
      finalNewName = hasExtension(newName) ? newName : `${newName}.md`;
    }

    parts[parts.length - 1] = finalNewName;
    const newPath = parts.join("/");

    if (newPath === oldPath) return;

    // 1. Force save all active editor views to the cache to capture current scroll/selection
    const leafIds = getLeafPaneIds(layout);
    leafIds.forEach(paneId => {
      const leaf = findLeafNode(layout, paneId);
      const view = editorViewsRef.current.get(paneId);
      if (leaf && leaf.activeFile && view) {
        saveEditorState(paneId, leaf.activeFile, view);
      }
    });

    // 2. Save any dirty files inside oldPath before renaming on disk
    const shouldSave = (p: string) => {
      if (isDir) {
        return p === oldPath || p.startsWith(oldPath + "/");
      } else {
        return p === oldPath;
      }
    };

    for (const paneId of leafIds) {
      const leaf = findLeafNode(layout, paneId);
      if (leaf && leaf.activeFile && shouldSave(leaf.activeFile)) {
        const view = editorViewsRef.current.get(paneId);
        const paneState = paneStatesRef.current.get(paneId);
        if (paneState?.isDirty && view) {
          const content = view.state.doc.toString();
          const timeout = saveTimeoutsRef.current.get(leaf.activeFile);
          if (timeout) {
            clearTimeout(timeout);
            saveTimeoutsRef.current.delete(leaf.activeFile);
          }
          try {
            await writeMarkdownFileWithConflictCheck(leaf.activeFile, content);
          } catch (err) {
            console.error("Failed to auto-save file on rename", err);
          }
        }
      }
    }

    try {
      await invoke("rename_item", { oldPath, newPath });

      // 3. Update expanded paths for folder renames
      if (isDir) {
        setExpandedPaths(prev => {
          const next = new Set<string>();
          prev.forEach(p => {
            if (p === oldPath) {
              next.add(newPath);
            } else if (p.startsWith(oldPath + "/")) {
              next.add(newPath + p.slice(oldPath.length));
            } else {
              next.add(p);
            }
          });
          return next;
        });
      }

      // 4. Migrate active save timeouts to the new path
      const mapPath = (p: string) => {
        if (isDir) {
          if (p === oldPath) return newPath;
          if (p.startsWith(oldPath + "/")) {
            return newPath + p.slice(oldPath.length);
          }
        } else {
          if (p === oldPath) return newPath;
        }
        return p;
      };

      saveTimeoutsRef.current.forEach((timeout, p) => {
        const mapped = mapPath(p);
        if (mapped !== p) {
          saveTimeoutsRef.current.set(mapped, timeout);
          saveTimeoutsRef.current.delete(p);
        }
      });

      // 5. Update layout and migrate editor/selection caches
      setLayout(prevLayout => renamePathInLayout(prevLayout, oldPath, newPath, isDir));

      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to rename item", err);
      if (!isBlur) {
        alert(`Rename failed: ${err}`);
      }
    }
  };

  const closeAllTabs = useCallback(async () => {
    const getAllLeaves = (node: PaneNode): LeafPane[] => {
      if (node.type === "leaf") return [node];
      return node.children.flatMap(getAllLeaves);
    };

    const leaves = getAllLeaves(layoutRef.current);
    for (const leaf of leaves) {
      for (const tab of leaf.tabs) {
        const paneState = paneStatesRef.current.get(leaf.id);
        const view = editorViewsRef.current.get(leaf.id);
        if (leaf.activeFile === tab && paneState?.isDirty && view) {
          const content = view.state.doc.toString();
          const timeout = saveTimeoutsRef.current.get(tab);
          if (timeout) {
            clearTimeout(timeout);
            saveTimeoutsRef.current.delete(tab);
          }
          try {
            await writeMarkdownFileWithConflictCheck(tab, content);
          } catch (err) {
            console.error("Failed to auto-save file on close all", err);
          }
        }
      }
    }

    editorViewsRef.current.clear();
    paneStatesRef.current.clear();

    setLayout({
      type: "leaf",
      id: "pane-root",
      activeFile: null,
      tabs: []
    });
    setActivePaneId("pane-root");
    setIsDirty(false);
    setWordCount(0);
  }, []);

  const visibleItems = useMemo<VisibleItem[]>(() => {
    const items: VisibleItem[] = [];

    const traverse = (nodes: FileNode[], depth: number, parentPath: string) => {
      if (creatingNode && creatingNode.parentPath === parentPath) {
        items.push({
          path: "__creating__",
          name: newInputName,
          isDir: creatingNode.type === "dir",
          depth,
          node: { name: "", path: "__creating__", is_dir: creatingNode.type === "dir", children: [] }
        });
      }

      for (const node of nodes) {
        if (!settings.showHidden && node.name.startsWith(".")) {
          continue;
        }

        items.push({
          path: node.path,
          name: node.name,
          isDir: node.is_dir,
          depth,
          node
        });

        if (node.is_dir && expandedPaths.has(node.path)) {
          traverse(node.children, depth + 1, node.path);
        }
      }
    };

    traverse(fileTree, 0, "");
    return items;
  }, [fileTree, expandedPaths, settings.showHidden, creatingNode, newInputName]);

  const expandParentsOfFile = useCallback((filePath: string) => {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;
    setExpandedPaths(prev => {
      const next = new Set(prev);
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        next.add(current);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (activeFile) {
      if (skipExpandRef.current) {
        skipExpandRef.current = false;
      } else {
        expandParentsOfFile(activeFile);
      }
    }
  }, [activeFile, expandParentsOfFile]);

  // Sync index only when activeFile actually changes (prevent resetting when user toggles folders or on watcher refreshes)
  useEffect(() => {
    if (activeFile !== prevActiveFileRef.current) {
      prevActiveFileRef.current = activeFile;
      if (activeFile) {
        const idx = visibleItems.findIndex(item => item.path === activeFile);
        if (idx !== -1) {
          setSidebarSelectedIndex(idx);
        }
      }
    }
  }, [activeFile, visibleItems]);

  // Focus and select a newly created folder once it appears in visibleItems
  useEffect(() => {
    if (pathToHighlight) {
      const idx = visibleItems.findIndex(item => item.path === pathToHighlight);
      if (idx !== -1) {
        setSidebarSelectedIndex(idx);
        setPathToHighlight(null);
      }
    }
  }, [visibleItems, pathToHighlight]);

  const triggerTreeReload = useCallback(() => {
    if (reloadTreeRef.current) clearTimeout(reloadTreeRef.current);
    reloadTreeRef.current = setTimeout(async () => {
      try {
        const tree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(tree);
      } catch (err) {
        console.error("Failed to reload file tree", err);
      }
    }, 30);
  }, []);

  // Listen to filesystem events emitted by backend
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setupListener = async () => {
      unlisten = await listen<string[]>("workspace-changed", async (event) => {
        triggerTreeReload();

        const modifiedPaths = event.payload;
        if (!modifiedPaths || !Array.isArray(modifiedPaths)) return;

        // Re-check AI policy status if policy or the active file changed
        if (modifiedPaths.includes(".solai") || (activeFileRef.current && modifiedPaths.includes(activeFileRef.current))) {
          checkFileAiStatus(activeFileRef.current);
        }

        const currentLayout = layoutRef.current;
        const leafIds = getLeafPaneIds(currentLayout);

        for (const pId of leafIds) {
          const leaf = findLeafNode(currentLayout, pId);
          if (leaf && leaf.activeFile) {
            const openFile = leaf.activeFile;
            if (modifiedPaths.includes(openFile)) {
              // Check if it is dirty in any pane showing it
              const isDirtyInAnyPane = leafIds.some(otherId => {
                const otherLeaf = findLeafNode(currentLayout, otherId);
                return otherLeaf && otherLeaf.activeFile === openFile && paneStatesRef.current.get(otherId)?.isDirty;
              });

              if (!isDirtyInAnyPane) {
                try {
                  const res = await invoke<{ content: string; mtime: number }>("read_markdown_file", { path: openFile });
                  
                  // Re-check dirty state after await to prevent overwriting user typing
                  const isDirtyNow = leafIds.some(otherId => {
                    const otherLeaf = findLeafNode(currentLayout, otherId);
                    return otherLeaf && otherLeaf.activeFile === openFile && paneStatesRef.current.get(otherId)?.isDirty;
                  });
                  if (isDirtyNow) {
                    continue;
                  }

                  const knownMtime = fileMtimesRef.current.get(openFile);
                  if (res.mtime === knownMtime) {
                    continue;
                  }

                  fileMtimesRef.current.set(openFile, res.mtime);
                  fileBasesRef.current.set(openFile, res.content);

                  leafIds.forEach((pId2) => {
                    const l2 = findLeafNode(currentLayout, pId2);
                    if (l2 && l2.activeFile === openFile) {
                      const view = editorViewsRef.current.get(pId2);
                      if (view) {
                        if (view.state.doc.toString() !== res.content) {
                          view.dispatch({
                            changes: { from: 0, to: view.state.doc.length, insert: res.content },
                            annotations: Transaction.userEvent.of("reload")
                          });
                        }
                      }
                      paneStatesRef.current.set(pId2, { isDirty: false, wordCount: computeWordCount(res.content) });
                      if (pId2 === activePaneIdRef.current) {
                        setIsDirty(false);
                        setWordCount(computeWordCount(res.content));
                      }
                    }
                  });
                } catch (reloadErr) {
                  console.error("Auto-reload failed for external change", reloadErr);
                }
              }
            }
          }
        }
      });
    };
    setupListener();
    return () => {
      if (reloadTreeRef.current) clearTimeout(reloadTreeRef.current);
      if (unlisten) unlisten();
    };
  }, [triggerTreeReload]);

  // Save the current file
  const saveFile = useCallback(async () => {
    if (!activePaneId) return;
    const leaf = findLeafNode(layout, activePaneId);
    if (!leaf || !leaf.activeFile) return;

    const activeView = editorViewsRef.current.get(activePaneId);
    if (!activeView) return;

    const timeout = saveTimeoutsRef.current.get(leaf.activeFile);
    if (timeout) {
      clearTimeout(timeout);
      saveTimeoutsRef.current.delete(leaf.activeFile);
    }

    try {
      const currentContent = activeView.state.doc.toString();
      const success = await writeMarkdownFileWithConflictCheck(leaf.activeFile, currentContent);
      
      if (success) {
        paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: computeWordCount(currentContent) });
        setIsDirty(false);
      }

    } catch (err) {
      console.error("Failed to save file", err);
    }
  }, [activePaneId, layout, workspacePath, writeMarkdownFileWithConflictCheck]);

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

  // Sync active pane states
  useEffect(() => {
    if (!activePaneId) return;
    const activeState = paneStatesRef.current.get(activePaneId) || { isDirty: false, wordCount: 0 };
    setIsDirty(activeState.isDirty);
    setWordCount(activeState.wordCount);
  }, [activePaneId]);

  // Split active pane
  const splitActivePane = useCallback((direction: "vertical" | "horizontal") => {
    if (!activePaneId) return;

    const splitNode = (node: PaneNode): PaneNode => {
      if (node.type === "leaf") {
        if (node.id === activePaneId) {
          const newPaneId = `pane-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
          return {
            type: "split",
            id: `split-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
            direction,
            children: [
              {
                type: "leaf",
                id: node.id,
                activeFile: node.activeFile,
                tabs: [...node.tabs]
              },
              {
                type: "leaf",
                id: newPaneId,
                activeFile: node.activeFile,
                tabs: [...node.tabs]
              }
            ]
          };
        }
        return node;
      }

      return {
        ...node,
        children: node.children.map(splitNode)
      };
    };

    const activeView = editorViewsRef.current.get(activePaneId);
    const activePaneState = paneStatesRef.current.get(activePaneId);
    const activeLeafNode = findLeafNode(layout, activePaneId);
    if (activeView && activePaneState?.isDirty && activeLeafNode?.activeFile) {
      const content = activeView.state.doc.toString();
      const timeout = saveTimeoutsRef.current.get(activeLeafNode.activeFile);
      if (timeout) {
        clearTimeout(timeout);
        saveTimeoutsRef.current.delete(activeLeafNode.activeFile);
      }
      writeMarkdownFileWithConflictCheck(activeLeafNode.activeFile, content)
        .catch(err => console.error("Auto-save before split failed", err));
      paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: activePaneState.wordCount });
      setIsDirty(false);
    }

    setLayout(prevLayout => splitNode(prevLayout));
  }, [activePaneId, layout, workspacePath, writeMarkdownFileWithConflictCheck]);

  // Close active pane
  const closeActivePane = useCallback(async () => {
    if (!activePaneId) return;

    const leaf = findLeafNode(layout, activePaneId);
    const view = editorViewsRef.current.get(activePaneId);
    const paneState = paneStatesRef.current.get(activePaneId);
    if (leaf && leaf.activeFile && paneState?.isDirty && view) {
      const content = view.state.doc.toString();
      const timeout = saveTimeoutsRef.current.get(leaf.activeFile);
      if (timeout) {
        clearTimeout(timeout);
        saveTimeoutsRef.current.delete(leaf.activeFile);
      }
      try {
        await writeMarkdownFileWithConflictCheck(leaf.activeFile, content);
      } catch (err) {
        console.error("Failed to auto-save file on pane close", err);
      }
    }

    const cleanTree = removePaneFromTree(layout, activePaneId);
    let updatedLayout: PaneNode;
    if (cleanTree) {
      updatedLayout = cleanTree;
    } else {
      updatedLayout = {
        type: "leaf",
        id: "pane-root",
        activeFile: null,
        tabs: []
      };
    }

    editorViewsRef.current.delete(activePaneId);
    paneStatesRef.current.delete(activePaneId);

    setLayout(updatedLayout);

    const leafIds = getLeafPaneIds(updatedLayout);
    const nextActivePaneId = leafIds[0] || "pane-root";
    setActivePaneId(nextActivePaneId);

    const nextState = paneStatesRef.current.get(nextActivePaneId) || { isDirty: false, wordCount: 0 };
    setIsDirty(nextState.isDirty);
    setWordCount(nextState.wordCount);
  }, [activePaneId, layout, workspacePath]);

  // 2D focus navigation
  const navigateFocus = useCallback((direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => {
    let currentEl = document.activeElement;
    if (currentEl) {
      const container = currentEl.closest(".editor-pane, .file-list");
      if (container) {
        currentEl = container;
      }
    }
    if (!currentEl) {
      currentEl = document.querySelector(".editor-pane.active") || document.querySelector(".file-list");
    }
    if (!currentEl) return;
    const currentRect = currentEl.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + currentRect.width / 2,
      y: currentRect.top + currentRect.height / 2
    };

    const targets = Array.from(document.querySelectorAll(".editor-pane, .file-list")) as HTMLElement[];
    let bestTarget: HTMLElement | null = null;
    let bestDistance = Infinity;

    for (const target of targets) {
      if (target === currentEl) continue;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };

      const dx = center.x - currentCenter.x;
      const dy = center.y - currentCenter.y;

      let isCorrectDirection = false;
      if (direction === "ArrowLeft" && dx < -5) {
        isCorrectDirection = true;
      } else if (direction === "ArrowRight" && dx > 5) {
        isCorrectDirection = true;
      } else if (direction === "ArrowUp" && dy < -5) {
        isCorrectDirection = true;
      } else if (direction === "ArrowDown" && dy > 5) {
        isCorrectDirection = true;
      }

      if (!isCorrectDirection) continue;

      let distance;
      if (direction === "ArrowUp" || direction === "ArrowDown") {
        distance = Math.abs(dy) + Math.abs(dx) * 5;
      } else {
        distance = Math.abs(dx) + Math.abs(dy) * 5;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestTarget = target;
      }
    }

    if (bestTarget) {
      if (bestTarget.classList.contains("file-list")) {
        setFocusedComponent("sidebar");
        sidebarRef.current?.focus();
      } else {
        const paneId = bestTarget.getAttribute("data-pane-id");
        if (paneId) {
          setActivePaneId(paneId);
          setFocusedComponent("editor");
          const view = editorViewsRef.current.get(paneId);
          view?.focus();
        }
      }
    }
  }, []);

  // Registrars for child panes
  const registerView = useCallback((paneId: PaneId, view: any) => {
    if (view === null) {
      editorViewsRef.current.delete(paneId);
    } else {
      editorViewsRef.current.set(paneId, view);
    }
  }, []);

  const registerState = useCallback((paneId: PaneId, isDirtyVal: boolean, wordCountVal: number) => {
    paneStatesRef.current.set(paneId, { isDirty: isDirtyVal, wordCount: wordCountVal });
    if (paneId === activePaneIdRef.current) {
      setIsDirty(isDirtyVal);
      setWordCount(wordCountVal);
    }
  }, []);

  const saveTimeoutsRef = useRef<Map<string, any>>(new Map());

  const onDocChange = useCallback((paneId: string, content: string) => {
    const currentLayout = layoutRef.current;
    const leaf = findLeafNode(currentLayout, paneId);
    if (!leaf || !leaf.activeFile) return;

    if (paneId === activePaneIdRef.current) {
      setActiveContent(content);
    }

    const fileName = leaf.activeFile;

    // 1. Sync content in-memory to all other panes displaying this file
    const leafIds = getLeafPaneIds(currentLayout);
    leafIds.forEach((otherPaneId) => {
      if (otherPaneId === paneId) return;

      const otherLeaf = findLeafNode(currentLayout, otherPaneId);
      if (otherLeaf && otherLeaf.activeFile === fileName) {
        const otherView = editorViewsRef.current.get(otherPaneId);
        if (otherView && otherView.state.doc.toString() !== content) {
          otherView.dispatch({
            changes: { from: 0, to: otherView.state.doc.length, insert: content }
          });
        }
      }
    });

    // 2. Mark all panes displaying this file as dirty
    leafIds.forEach((pId) => {
      const pLeaf = findLeafNode(currentLayout, pId);
      if (pLeaf && pLeaf.activeFile === fileName) {
        paneStatesRef.current.set(pId, { isDirty: true, wordCount: computeWordCount(content) });
        if (pId === activePaneIdRef.current) {
          setIsDirty(true);
          setWordCount(computeWordCount(content));
        }
      }
    });

    // 3. Trigger debounced save
    let fileTimeout = saveTimeoutsRef.current.get(fileName);
    if (fileTimeout) clearTimeout(fileTimeout);
    fileTimeout = setTimeout(async () => {
      saveTimeoutsRef.current.delete(fileName);
      const success = await writeMarkdownFileWithConflictCheck(fileName, content);
      if (success) {
        addConsoleLog(`Auto-saved note: ${fileName}`, "success");
        // Auto-save completed: Mark all panes displaying this file as clean
        const latestLayout = layoutRef.current;
        const latestLeafIds = getLeafPaneIds(latestLayout);
        latestLeafIds.forEach((pId) => {
          const pLeaf = findLeafNode(latestLayout, pId);
          if (pLeaf && pLeaf.activeFile === fileName) {
            paneStatesRef.current.set(pId, { isDirty: false, wordCount: computeWordCount(content) });
            if (pId === activePaneIdRef.current) {
              setIsDirty(false);
            }
          }
        });
      }
    }, 300);
    saveTimeoutsRef.current.set(fileName, fileTimeout);
  }, [workspacePath, writeMarkdownFileWithConflictCheck, addConsoleLog]);

  const onVimModeChange = useCallback((mode: string) => {
    setVimModeName(mode);
  }, []);

  const handleCreateNewNote = useCallback(() => {
    let targetPath = "";
    const currentItem = visibleItems[sidebarSelectedIndex];
    if (currentItem && currentItem.path !== "__creating__") {
      if (currentItem.isDir) {
        targetPath = currentItem.path;
      } else {
        const lastSlashIdx = currentItem.path.lastIndexOf("/");
        targetPath = lastSlashIdx !== -1 ? currentItem.path.substring(0, lastSlashIdx) : "";
      }
    } else if (activeFileRef.current) {
      const lastSlashIdx = activeFileRef.current.lastIndexOf("/");
      targetPath = lastSlashIdx !== -1 ? activeFileRef.current.substring(0, lastSlashIdx) : "";
    }

    setSidebarOpen(true);
    setFocusedComponent("sidebar");
    inputFocusedRef.current = false;
    setCreatingNode({ type: "file", parentPath: targetPath });
    setNewInputName("untitled.md");
    if (targetPath) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(targetPath);
        return next;
      });
    }
  }, [visibleItems, sidebarSelectedIndex]);

  // Refs to avoid stale closures in global keydown listener
  const layoutRef = useRef(layout);
  const activePaneIdRef = useRef(activePaneId);
  const prefixActiveRef = useRef(prefixActive);
  const prefixTimeoutRef = useRef<any>(null);
  const openFileRef = useRef(openFile);
  const closeTabRef = useRef(closeTab);
  const saveFileRef = useRef(saveFile);
  const splitActivePaneRef = useRef(splitActivePane);
  const closeActivePaneRef = useRef(closeActivePane);
  const navigateFocusRef = useRef(navigateFocus);
  const closeAllTabsRef = useRef(closeAllTabs);
  const workspacePathRef = useRef(workspacePath);
  const fileTreeRef = useRef(fileTree);
  const pendingHeadersRef = useRef<Map<PaneId, string>>(new Map());
  const settingsRef = useRef(settings);
  const updateSettingsRef = useRef(updateSettings);
  const handleCreateNewNoteRef = useRef(handleCreateNewNote);

  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { updateSettingsRef.current = updateSettings; }, [updateSettings]);
  useEffect(() => { activePaneIdRef.current = activePaneId; }, [activePaneId]);
  useEffect(() => { prefixActiveRef.current = prefixActive; }, [prefixActive]);
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);
  useEffect(() => { closeTabRef.current = closeTab; }, [closeTab]);
  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);
  useEffect(() => { splitActivePaneRef.current = splitActivePane; }, [splitActivePane]);
  useEffect(() => { closeActivePaneRef.current = closeActivePane; }, [closeActivePane]);
  useEffect(() => { navigateFocusRef.current = navigateFocus; }, [navigateFocus]);
  useEffect(() => { closeAllTabsRef.current = closeAllTabs; }, [closeAllTabs]);
  useEffect(() => { workspacePathRef.current = workspacePath; }, [workspacePath]);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { handleCreateNewNoteRef.current = handleCreateNewNote; }, [handleCreateNewNote]);

  // Register Vim custom Ex commands
  useEffect(() => {
    Vim.defineEx("new", "new", () => {
      handleCreateNewNoteRef.current();
    });

    Vim.defineEx("newnote", "newnote", () => {
      handleCreateNewNoteRef.current();
    });
    Vim.defineEx("quit", "q", () => {
      const currentActivePaneId = activePaneIdRef.current;
      const leaf = findLeafNode(layoutRef.current, currentActivePaneId);
      if (leaf && leaf.activeFile) {
        closeTabRef.current(currentActivePaneId, leaf.activeFile);
      }
    });

    Vim.defineEx("qall", "qa", () => {
      closeAllTabsRef.current();
    });

    Vim.defineEx("policy", "policy", () => {
      openPolicyFileRef.current();
    });

    Vim.defineEx("solai", "solai", () => {
      openPolicyFileRef.current();
    });

    Vim.defineEx("completion", "completion", () => {
      const current = settingsRef.current.completionEnabled !== false;
      updateSettingsRef.current({ completionEnabled: !current });
    });

    Vim.defineEx("togglecompletion", "togglecompletion", () => {
      const current = settingsRef.current.completionEnabled !== false;
      updateSettingsRef.current({ completionEnabled: !current });
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

      // Direct pane navigation: Ctrl + h/j/k/l (no prefix required)
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === "h" || key === "j" || key === "k" || key === "l") {
          e.preventDefault();
          e.stopPropagation();
          let dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
          if (key === "h") dir = "ArrowLeft";
          else if (key === "l") dir = "ArrowRight";
          else if (key === "k") dir = "ArrowUp";
          else dir = "ArrowDown";
          navigateFocusRef.current(dir);
          return;
        }
      }

      // Check if prefix is active
      if (prefixActiveRef.current) {
        e.preventDefault();
        setPrefixActive(false);

        // Splitting vertical
        if (e.key === "\\") {
          splitActivePaneRef.current("vertical");
          return;
        }

        // Splitting horizontal
        if (e.key === "-") {
          splitActivePaneRef.current("horizontal");
          return;
        }

        // Focus navigation (Arrow keys or h/j/k/l)
        if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown" ||
            e.key.toLowerCase() === "h" || e.key.toLowerCase() === "l" || e.key.toLowerCase() === "k" || e.key.toLowerCase() === "j") {
          let dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
          if (e.key === "ArrowLeft" || e.key.toLowerCase() === "h") dir = "ArrowLeft";
          else if (e.key === "ArrowRight" || e.key.toLowerCase() === "l") dir = "ArrowRight";
          else if (e.key === "ArrowUp" || e.key.toLowerCase() === "k") dir = "ArrowUp";
          else dir = "ArrowDown";

          navigateFocusRef.current(dir);
          return;
        }

        // Close pane
        if (e.key.toLowerCase() === "x") {
          closeActivePaneRef.current();
          return;
        }

        return;
      }

      const keybindings = settingsRef.current.keybindings || DEFAULT_KEYBINDINGS;

      // Ctrl+N (mod+n) to create a new note
      if (matchKeybinding(e, keybindings.newNote) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n" && !e.altKey && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        handleCreateNewNoteRef.current();
        return;
      }

      // Enter prefix mode
      if (matchKeybinding(e, keybindings.prefixMode)) {
        e.preventDefault();
        setPrefixActive(true);
        if (prefixTimeoutRef.current) clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = setTimeout(() => {
          setPrefixActive(false);
        }, 3000);
        return;
      }

      // Ctrl+S to save
      if (matchKeybinding(e, keybindings.save)) {
        e.preventDefault();
        saveFileRef.current();
        return;
      }

      // Ctrl+` or Ctrl+Backquote or Ctrl+' to toggle bottom tray
      const isBacktick = e.key === "`" || e.code === "Backquote" || e.keyCode === 192 || e.key === "Dead";
      const isSingleQuote = e.key === "'" || e.code === "Quote" || e.keyCode === 222;
      if (e.ctrlKey && (isBacktick || isSingleQuote)) {
        e.preventDefault();
        e.stopPropagation();
        setBottomTrayOpen(prev => !prev);
        return;
      }

      // Ctrl+E or Ctrl+\ to toggle sidebar
      if (matchKeybinding(e, keybindings.toggleSidebar) || (e.key === "\\" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        setSidebarOpen(prev => {
          const next = !prev;
          if (next) {
            setFocusedComponent("sidebar");
          } else {
            setFocusedComponent("editor");
          }
          return next;
        });
        return;
      }

      // Ctrl+P to toggle Live Preview
      if (matchKeybinding(e, keybindings.togglePreview)) {
        e.preventDefault();
        setSettings(prev => {
          const nextVal = !prev.livePreview;
          invoke("write_settings", { settingsJson: JSON.stringify({ ...prev, livePreview: nextVal }, null, 2) })
            .catch(err => console.error("Failed to save settings", err));
          return { ...prev, livePreview: nextVal };
        });
        return;
      }

      // Ctrl+H (or Ctrl+Shift+H/Tab) to focus sidebar / editor
      if (matchKeybinding(e, keybindings.toggleFocus) && !isEditing) {
        e.preventDefault();
        setFocusedComponent(prev => (prev === "editor" ? "sidebar" : "editor"));
        return;
      }

      // Alt + [1-9] to switch tabs
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const currentActivePaneId = activePaneIdRef.current;
        const leaf = findLeafNode(layoutRef.current, currentActivePaneId);
        if (leaf && idx < leaf.tabs.length) {
          openFileRef.current(leaf.tabs[idx]);
        }
        return;
      }

      // Alt + H / L or Alt + ArrowLeft / ArrowRight to cycle tabs
      if (e.altKey && (e.key.toLowerCase() === "h" || e.key.toLowerCase() === "l" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const currentActivePaneId = activePaneIdRef.current;
        const leaf = findLeafNode(layoutRef.current, currentActivePaneId);
        if (!leaf || leaf.tabs.length <= 1) return;

        const idx = leaf.tabs.indexOf(leaf.activeFile || "");
        if (idx !== -1) {
          let nextIdx;
          if (e.key.toLowerCase() === "h" || e.key === "ArrowLeft") {
            nextIdx = (idx - 1 + leaf.tabs.length) % leaf.tabs.length;
          } else {
            nextIdx = (idx + 1) % leaf.tabs.length;
          }
          openFileRef.current(leaf.tabs[nextIdx]);
        }
        return;
      }

      // Alt + W to close current tab
      if (e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const currentActivePaneId = activePaneIdRef.current;
        const leaf = findLeafNode(layoutRef.current, currentActivePaneId);
        if (leaf && leaf.activeFile) {
          closeTabRef.current(currentActivePaneId, leaf.activeFile);
        }
        return;
      }
    };

    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const linkEl = target.closest(".cm-prose-link");
      if (linkEl) {
        e.preventDefault();
        e.stopPropagation();

        const noteLink = linkEl.getAttribute("data-note-link");
        if (noteLink) {
          e.preventDefault();
          e.stopPropagation();

          const hashIdx = noteLink.indexOf("#");
          const namePart = hashIdx !== -1 ? noteLink.substring(0, hashIdx).trim() : noteLink.trim();
          const headerPart = hashIdx !== -1 ? noteLink.substring(hashIdx + 1).trim() : null;

          // If it is a heading-only link (starts with #)
          if (namePart === "") {
            const currentActiveFile = activeFileRef.current;
            if (currentActiveFile) {
              const fullTarget = headerPart ? `${currentActiveFile}#${headerPart}` : currentActiveFile;
              openFileRef.current(fullTarget);
            }
            return;
          }

          const targetFileName = namePart.endsWith(".md") ? namePart : `${namePart}.md`;

          // Helper to find file in tree recursively
          const findFileInTree = (nodes: FileNode[], targetName: string): string | null => {
            for (const node of nodes) {
              if (!node.is_dir) {
                if (node.name.toLowerCase() === targetName.toLowerCase()) {
                  return node.path;
                }
              } else {
                const found = findFileInTree(node.children, targetName);
                if (found) return found;
              }
            }
            return null;
          };

          const openTarget = async () => {
            let foundPath = findFileInTree(fileTreeRef.current, targetFileName);
            if (!foundPath) {
              try {
                await invoke("create_markdown_file", { name: targetFileName });
                const tree = await invoke<FileNode[]>("get_file_tree");
                setFileTree(tree);
                foundPath = targetFileName;
              } catch (err) {
                console.error("Failed to auto-create markdown file from note link", err);
              }
            }
            if (foundPath) {
              const fullTarget = headerPart ? `${foundPath}#${headerPart}` : foundPath;
              openFileRef.current(fullTarget);
            }
          };

          openTarget();
          return;
        }

        const href = linkEl.getAttribute("href") || linkEl.getAttribute("title");
        if (href) {
          import("@tauri-apps/plugin-opener").then(opener => {
            opener.openUrl(href).catch((err: any) => console.error("Failed to open link", err));
          });
        }
      }
    };

    window.addEventListener("mousedown", handleGlobalClick, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handleGlobalClick, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (prefixTimeoutRef.current) clearTimeout(prefixTimeoutRef.current);
      saveTimeoutsRef.current.forEach((t) => clearTimeout(t));
      saveTimeoutsRef.current.clear();
    };
  }, []);

  // Handle focus switching
  useEffect(() => {
    if (creatingNode) return; // Do not switch focus during creation to allow editing the input
    if (focusedComponent === "editor") {
      if (activePaneId) {
        editorViewsRef.current.get(activePaneId)?.focus();
      }
    } else if (focusedComponent === "sidebar") {
      sidebarRef.current?.focus();
    }
  }, [focusedComponent, activePaneId, creatingNode]);

  // Submit handler for inline directory/file creation input
  const handleNewNodeSubmit = async (isBlur: boolean = false) => {
    const name = newInputName.trim();
    if (!name || !creatingNode) {
      inputFocusedRef.current = false;
      setCreatingNode(null);
      setNewInputName("");
      return;
    }

    const isDefault = name === "untitled.md" || name === "untitled";
    if (isBlur && isDefault) {
      inputFocusedRef.current = false;
      setCreatingNode(null);
      setNewInputName("");
      return;
    }

    const hasExtension = (pathStr: string): boolean => {
      const parts = pathStr.split(/[/\\]/);
      const baseName = parts[parts.length - 1];
      const dotIndex = baseName.lastIndexOf('.');
      return dotIndex > 0 && dotIndex < baseName.length - 1;
    };

    const relativePath = creatingNode.parentPath ? `${creatingNode.parentPath}/${name}` : name;

    try {
      if (creatingNode.type === "file") {
        const nameWithExt = hasExtension(relativePath) ? relativePath : `${relativePath}.md`;
        await invoke("create_markdown_file", { name: nameWithExt });
        if (creatingNode.parentPath) {
          setExpandedPaths(prev => {
            const next = new Set(prev);
            next.add(creatingNode.parentPath);
            return next;
          });
        }
        const tree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(tree);
        await openFile(nameWithExt);
        setFocusedComponent("editor");
      } else {
        await invoke("create_directory", { path: relativePath });
        if (creatingNode.parentPath) {
          setExpandedPaths(prev => {
            const next = new Set(prev);
            next.add(creatingNode.parentPath);
            return next;
          });
        }
        const tree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(tree);
        setPathToHighlight(relativePath);
        setFocusedComponent("sidebar");
      }
    } catch (err) {
      console.error("Failed to create item", err);
    } finally {
      inputFocusedRef.current = false;
      setCreatingNode(null);
      setNewInputName("");
    }
  };

  // Recursive pane renderer
  const renderPaneNode = (node: PaneNode): React.ReactNode => {
    if (node.type === "leaf") {
      return (
        <EditorPaneComponent
          key={node.id}
          paneId={node.id}
          activeFile={node.activeFile}
          tabs={node.tabs}
          isActive={node.id === activePaneId}
          settings={settings}
          workspacePath={workspacePath}
          fileTree={fileTree}
          pendingHeadersRef={pendingHeadersRef}
          fileMtimesRef={fileMtimesRef}
          fileBasesRef={fileBasesRef}
          onFocus={() => {
            setActivePaneId(node.id);
            setFocusedComponent("editor");
          }}
          onCloseTab={closeTab}
          onCloseTabs={closeTabs}
          onOpenFile={openFile}
          registerView={registerView}
          registerState={registerState}
          onDocChange={onDocChange}
          onVimModeChange={onVimModeChange}
          onAiDebugInfo={setAiDebugInfo}
        />
      );
    }

    return (
      <div
        key={node.id}
        className="pane-split"
        style={{
          display: "flex",
          flexDirection: node.direction === "vertical" ? "row" : "column",
          flex: 1,
          width: "100%",
          height: "100%",
          gap: "4px",
          backgroundColor: "var(--border)"
        }}
      >
        {node.children.map((child) => (
          <div key={child.id} style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {renderPaneNode(child)}
          </div>
        ))}
      </div>
    );
  };

  if (!workspacePath) {
    return (
      <div className="landing-container fade-in">
        <header className="app-header">
          <div className="app-title-group">
            <svg className="logo-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="app-title">SOL</span>
            <span className="app-subtitle">no workspace</span>
          </div>

          <div className="app-actions">
            <button
              className="btn-header-action"
              onClick={() => {
                setShowSettingsModal(true);
                setActiveSettingsTab("general");
              }}
              title="Settings"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px", width: "30px", height: "30px" }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        <div className="landing-body">
          <div className="landing-backdrop-glow"></div>
          <div className="landing-card">
            <div className="landing-logo-badge">
              <svg className="landing-sol-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            
            <h1 className="landing-title">Welcome to Sol</h1>
            <p className="landing-description">
              A secure, privacy-first markdown vault for your local notes.
              Organize your thoughts and discover patterns with local AI.
            </p>

            <div className="landing-features">
              <div className="landing-feature-chip">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                <span>Local & Private</span>
              </div>
              <div className="landing-feature-chip">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
                <span>Vim & Split Panes</span>
              </div>
              <div className="landing-feature-chip">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 16v-4"></path>
                  <path d="M12 8h.01"></path>
                </svg>
                <span>Local AI Assistant</span>
              </div>
            </div>

            <button className="landing-btn-primary" onClick={changeWorkspace}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>Open Workspace Folder</span>
            </button>
          </div>
        </div>

        <SettingsModal
          showSettingsModal={showSettingsModal}
          setShowSettingsModal={setShowSettingsModal}
          activeSettingsTab={activeSettingsTab}
          setActiveSettingsTab={setActiveSettingsTab}
          settings={settings}
          updateSettings={updateSettings}
          recordingHotkey={recordingHotkey}
          setRecordingHotkey={setRecordingHotkey}
          openPolicyFile={openPolicyFile}
        />
      </div>
    );
  }

  return (
    <div className="app-container fade-in">
      <header className="app-header">
        <div className="app-title-group">
          <svg className="logo-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="app-title">SOL</span>
          <span className="app-subtitle" title={workspacePath}>
            {workspacePath ? (workspacePath.split(/[/\\]/).filter(Boolean).pop() || workspacePath) : "workspace"}
          </span>
        </div>

        <div className="app-actions">
          <button
            className={`status-toggle ${settings.livePreview ? "active" : ""}`}
            onClick={() => updateSettings({ livePreview: !settings.livePreview })}
            title="Toggle Live Preview (Ctrl+P)"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px" }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            className={`btn-header-action ${rightTrayOpen ? "active" : ""}`}
            onClick={() => {
              setRightTrayOpen(prev => !prev);
            }}
            title="Toggle Inspector Panel"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px", width: "30px", height: "30px" }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="3" x2="16" y2="21"/>
            </svg>
          </button>
          <button
            className="btn-header-action"
            onClick={() => {
              setShowSettingsModal(true);
              setActiveSettingsTab("general");
            }}
            title="Settings"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px", width: "30px", height: "30px" }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>
 
      <div className="app-body">
        <Sidebar
          sidebarOpen={sidebarOpen}
          sidebarRef={sidebarRef}
          focusedComponent={focusedComponent}
          setFocusedComponent={setFocusedComponent}
          visibleItems={visibleItems}
          sidebarSelectedIndex={sidebarSelectedIndex}
          setSidebarSelectedIndex={setSidebarSelectedIndex}
          expandedPaths={expandedPaths}
          setExpandedPaths={setExpandedPaths}
          creatingNode={creatingNode}
          setCreatingNode={setCreatingNode}
          newInputName={newInputName}
          setNewInputName={setNewInputName}
          showHidden={settings.showHidden}
          updateSettings={updateSettings}
          changeWorkspace={changeWorkspace}
          openFile={openFile}
          activeFile={activeFile}
          handleNewNodeSubmit={handleNewNodeSubmit}
          inputFocusedRef={inputFocusedRef}
          deleteItem={deleteItem}
          renameItem={renameItem}
          fileTree={fileTree}
          openPeriodicNote={openPeriodicNote}
          settings={settings}
        />

        <main className="app-main">
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {renderPaneNode(layout)}
          </div>
          <BottomTray
            isOpen={bottomTrayOpen}
            height={bottomTrayHeight}
            activeTab={activeBottomTab}
            setActiveTab={setActiveBottomTab}
            logs={consoleLogs}
            aiDebugInfo={aiDebugInfo}
            scratchpadContent={scratchpadContent}
            setScratchpadContent={setScratchpadContent}
            onClose={() => setBottomTrayOpen(false)}
            onResizeMouseDown={handleBottomTrayMouseDown}
          />
        </main>

        <RightTray
          isOpen={rightTrayOpen}
          width={rightTrayWidth}
          activeTab={activeRightTab}
          setActiveTab={setActiveRightTab}
          activeFile={activeFile}
          content={activeContent}
          wordCount={wordCount}
          onClose={() => setRightTrayOpen(false)}
          onResizeMouseDown={handleRightTrayMouseDown}
          scrollToHeader={scrollToHeader}
        />
      </div>

      <StatusBar
        activeFile={activeFile}
        isDirty={isDirty}
        prefixActive={prefixActive}
        vimMode={settings.vimMode}
        vimModeName={vimModeName}
        wordCount={wordCount}
        updateSettings={updateSettings}
        aiStatus={aiStatus}
        completionEnabled={settings.completionEnabled !== false}
        aiDebugEnabled={settings.aiDebugEnabled}
        aiDebugInfo={aiDebugInfo}
        bottomTrayOpen={bottomTrayOpen}
        onToggleBottomTray={toggleBottomTray}
      />

      <SettingsModal
        showSettingsModal={showSettingsModal}
        setShowSettingsModal={setShowSettingsModal}
        activeSettingsTab={activeSettingsTab}
        setActiveSettingsTab={setActiveSettingsTab}
        settings={settings}
        updateSettings={updateSettings}
        recordingHotkey={recordingHotkey}
        setRecordingHotkey={setRecordingHotkey}
        openPolicyFile={openPolicyFile}
        openReworkPromptFile={openReworkPromptFile}
      />

      {conflictInfo && (
        <div className="conflict-modal-overlay">
          <div className="conflict-modal-card">
            <div className="conflict-modal-header">
              <h2>Conflict Detected: {conflictInfo.path}</h2>
            </div>
            <div className="conflict-modal-body">
              <p className="conflict-modal-desc">
                This file was modified externally. Below are the differences between your local changes (red/minus) and the version on disk (green/plus).
              </p>
              <div className="conflict-diff-container">
                {computeSimpleLineDiff(conflictInfo.localContent, conflictInfo.diskContent).map((line, idx) => (
                  <div key={idx} className={`diff-line ${line.type}`}>
                    <span className="diff-marker">
                      {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                    </span>
                    <pre className="diff-text">{line.value}</pre>
                  </div>
                ))}
              </div>
            </div>
            <div className="conflict-modal-footer">
              <button
                className="btn-conflict-action overwrite"
                onClick={() => conflictResolveRef.current?.("overwrite")}
              >
                Overwrite Disk Version
              </button>
              <button
                className="btn-conflict-action reload"
                onClick={() => conflictResolveRef.current?.("reload")}
              >
                Reload from Disk
              </button>
              <button
                className="btn-conflict-action cancel"
                onClick={() => conflictResolveRef.current?.("cancel")}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
