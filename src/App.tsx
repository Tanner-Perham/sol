import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Vim } from "@replit/codemirror-vim";

// Shared Types and Constants
import { PaneId, LeafPane, PaneNode, FileNode, Keybindings, AppSettings } from "./types";
import { DEFAULT_KEYBINDINGS, DEFAULT_SETTINGS } from "./constants";

// Utilities
import { matchKeybinding } from "./utils/keybindingUtils";
import { findLeafNode, getLeafPaneIds, removePaneFromTree, findDefaultFile } from "./utils/treeUtils";
import { computeWordCount, findHeaderLine } from "./utils/editorUtils";

// Components
import { Sidebar, VisibleItem } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { EditorPaneComponent } from "./components/EditorPane/EditorPane";

function App() {
  const [workspacePath, setWorkspacePath] = useState("");
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"general" | "appearance" | "hotkeys">("general");
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

  const updateSettings = useCallback(async (newSettings: Partial<AppSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      invoke("write_settings", { settingsJson: JSON.stringify(updated, null, 2) })
        .catch(err => console.error("Failed to save settings", err));
      return updated;
    });
  }, []);

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

  // Refs
  const editorViewsRef = useRef<Map<PaneId, any>>(new Map());
  const paneStatesRef = useRef<Map<PaneId, { isDirty: boolean; wordCount: number }>>(new Map());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const reloadTreeRef = useRef<any>(null);
  const prevActiveFileRef = useRef<string | null>(null);
  const inputFocusedRef = useRef(false);

  // Load workspace path and files
  const loadWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string>("get_workspace_path");
      setWorkspacePath(path);
      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);

      // Load settings
      try {
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
        // Create test.md automatically if workspace is empty
        await invoke<string>("create_markdown_file", { name: "test.md" });
        const updatedTree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(updatedTree);
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: "test.md",
          tabs: ["test.md"]
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
          const currentActiveFilePath = `${workspacePath}/${activeLeaf.activeFile}`;
          try {
            await invoke("write_markdown_file", { path: currentActiveFilePath, content });
          } catch (err) {
            console.error("Failed to auto-save file on workspace change", err);
          }
        }
      }

      const selectedPath = await invoke<string | null>("select_directory");
      if (!selectedPath) return;

      const newTree = await invoke<FileNode[]>("set_workspace_path", { path: selectedPath });
      setWorkspacePath(selectedPath);
      setFileTree(newTree);
      setExpandedPaths(new Set());
      setSidebarSelectedIndex(0);

      // Load settings for the new workspace
      try {
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
        await invoke("create_markdown_file", { name: "test.md" });
        const updatedTree = await invoke<FileNode[]>("get_file_tree");
        setFileTree(updatedTree);
        setLayout({
          type: "leaf",
          id: "pane-root",
          activeFile: "test.md",
          tabs: ["test.md"]
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
  const openFile = async (fileName: string, wsPath?: string) => {
    if (!activePaneId) return;
    const leaf = findLeafNode(layout, activePaneId);
    if (!leaf) return;

    // Split fileName into relativePath and header
    const hashIdx = fileName.indexOf("#");
    const relativePath = hashIdx !== -1 ? fileName.substring(0, hashIdx) : fileName;
    const header = hashIdx !== -1 ? fileName.substring(hashIdx + 1) : null;

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
      const currentActiveFilePath = `${workspacePath}/${leaf.activeFile}`;
      try {
        await invoke("write_markdown_file", { path: currentActiveFilePath, content });
      } catch (err) {
        console.error("Failed to auto-save file on switch", err);
      }
    }

    // Save pending header in ref if present
    if (header) {
      pendingHeadersRef.current.set(activePaneId, header);
    }

    const currentWS = wsPath || workspacePath;
    const filePath = `${currentWS}/${relativePath}`;
    try {
      const content = await invoke<string>("read_markdown_file", { path: filePath });
      
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

  // Close a tab
  const closeTab = async (paneId: PaneId, fileName: string) => {
    const leaf = findLeafNode(layout, paneId);
    if (!leaf) return;

    const view = editorViewsRef.current.get(paneId);
    const paneState = paneStatesRef.current.get(paneId);
    if (leaf.activeFile === fileName && paneState?.isDirty && view) {
      const content = view.state.doc.toString();
      try {
        await invoke("write_markdown_file", { path: `${workspacePath}/${fileName}`, content });
      } catch (err) {
        console.error("Failed to auto-save file on close", err);
      }
    }

    const closedIdx = leaf.tabs.indexOf(fileName);
    const newTabs = leaf.tabs.filter((t) => t !== fileName);

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
          try {
            await invoke("write_markdown_file", {
              path: `${workspacePathRef.current}/${tab}`,
              content,
            });
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
      expandParentsOfFile(activeFile);
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
      unlisten = await listen("workspace-changed", () => {
        triggerTreeReload();
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

    const filePath = `${workspacePath}/${leaf.activeFile}`;
    try {
      const currentContent = activeView.state.doc.toString();
      await invoke("write_markdown_file", { path: filePath, content: currentContent });
      
      paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: computeWordCount(currentContent) });
      setIsDirty(false);

      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to save file", err);
    }
  }, [activePaneId, layout, workspacePath]);

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
          const newPaneId = `pane-${Date.now()}`;
          return {
            type: "split",
            id: `split-${Date.now()}`,
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
      invoke("write_markdown_file", {
        path: `${workspacePath}/${activeLeafNode.activeFile}`,
        content
      }).catch(err => console.error("Auto-save before split failed", err));
      paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: activePaneState.wordCount });
      setIsDirty(false);
    }

    setLayout(prevLayout => splitNode(prevLayout));
  }, [activePaneId, layout, workspacePath]);

  // Close active pane
  const closeActivePane = useCallback(async () => {
    if (!activePaneId) return;

    const leaf = findLeafNode(layout, activePaneId);
    const view = editorViewsRef.current.get(activePaneId);
    const paneState = paneStatesRef.current.get(activePaneId);
    if (leaf && leaf.activeFile && paneState?.isDirty && view) {
      const content = view.state.doc.toString();
      try {
        await invoke("write_markdown_file", { path: `${workspacePath}/${leaf.activeFile}`, content });
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

  const saveTimeoutRef = useRef<any>(null);

  const onDocChange = useCallback((paneId: string, content: string) => {
    const currentLayout = layoutRef.current;
    const leaf = findLeafNode(currentLayout, paneId);
    if (!leaf || !leaf.activeFile) return;

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
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      const filePath = `${workspacePath}/${fileName}`;
      try {
        await invoke("write_markdown_file", { path: filePath, content });

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
      } catch (err) {
        console.error("Auto-save failed", err);
      }
    }, 300);
  }, [workspacePath]);

  const onVimModeChange = useCallback((mode: string) => {
    setVimModeName(mode);
  }, []);

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

  useEffect(() => { layoutRef.current = layout; }, [layout]);
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

  // Register Vim custom Ex commands
  useEffect(() => {
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
            if (activeFile) {
              const fullTarget = headerPart ? `${activeFile}#${headerPart}` : activeFile;
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
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
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

    const relativePath = creatingNode.parentPath ? `${creatingNode.parentPath}/${name}` : name;

    try {
      if (creatingNode.type === "file") {
        const nameWithExt = relativePath.endsWith(".md") ? relativePath : `${relativePath}.md`;
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
          onFocus={() => {
            setActivePaneId(node.id);
            setFocusedComponent("editor");
          }}
          onCloseTab={closeTab}
          onOpenFile={openFile}
          registerView={registerView}
          registerState={registerState}
          onDocChange={onDocChange}
          onVimModeChange={onVimModeChange}
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
        />

        <main className="app-main">
          {renderPaneNode(layout)}
        </main>
      </div>

      <StatusBar
        activeFile={activeFile}
        isDirty={isDirty}
        prefixActive={prefixActive}
        vimMode={settings.vimMode}
        vimModeName={vimModeName}
        wordCount={wordCount}
        updateSettings={updateSettings}
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
      />
    </div>
  );
}

export default App;
