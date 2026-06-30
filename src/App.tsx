import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { prosePreviewPlugin } from "./prosePreviewPlugin";

export type PaneId = string;

export interface LeafPane {
  type: "leaf";
  id: PaneId;
  activeFile: string | null;
  tabs: string[];
}

export interface SplitPane {
  type: "split";
  id: PaneId;
  direction: "vertical" | "horizontal";
  children: PaneNode[];
}

export type PaneNode = LeafPane | SplitPane;

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

function computeWordCount(content: string): number {
  return content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

// Tree helpers
const findLeafNode = (node: PaneNode, targetId: PaneId): LeafPane | null => {
  if (node.type === "leaf") {
    return node.id === targetId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeafNode(child, targetId);
    if (found) return found;
  }
  return null;
};

const getLeafPaneIds = (node: PaneNode): PaneId[] => {
  if (node.type === "leaf") {
    return [node.id];
  }
  return node.children.flatMap(getLeafPaneIds);
};

const removePaneFromTree = (root: PaneNode, paneIdToRemove: PaneId): PaneNode | null => {
  if (root.type === "leaf") {
    if (root.id === paneIdToRemove) {
      return null;
    }
    return root;
  }

  const newChildren = root.children
    .map(child => removePaneFromTree(child, paneIdToRemove))
    .filter((child): child is PaneNode => child !== null);

  if (newChildren.length === 0) {
    return null;
  }
  if (newChildren.length === 1) {
    return newChildren[0];
  }

  return {
    ...root,
    children: newChildren
  };
};

function App() {
  const [workspacePath, setWorkspacePath] = useState("");
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [creatingNode, setCreatingNode] = useState<{ type: "file" | "dir"; parentPath: string } | null>(null);
  const [newInputName, setNewInputName] = useState("");
  
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

  const [vimMode, setVimMode] = useState(true);
  const [livePreview, setLivePreview] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [vimModeName, setVimModeName] = useState("NORMAL");
  const [focusedComponent, setFocusedComponent] = useState<"editor" | "sidebar">("editor");
  const [sidebarSelectedIndex, setSidebarSelectedIndex] = useState(0);

  // Derived state
  const activeLeaf = findLeafNode(layout, activePaneId);
  const activeFile = activeLeaf ? activeLeaf.activeFile : null;

  // Refs
  const editorViewsRef = useRef<Map<PaneId, EditorView | null>>(new Map());
  const paneStatesRef = useRef<Map<PaneId, { isDirty: boolean; wordCount: number }>>(new Map());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const reloadTreeRef = useRef<any>(null);
  const prevActiveFileRef = useRef<string | null>(null);
  const inputFocusedRef = useRef(false);

  // Tree helpers
  const findFirstMdFile = (nodes: FileNode[]): string | null => {
    for (const node of nodes) {
      if (!node.is_dir && node.path.endsWith(".md")) {
        return node.path;
      }
    }
    for (const node of nodes) {
      if (node.is_dir) {
        const found = findFirstMdFile(node.children);
        if (found) return found;
      }
    }
    return null;
  };

  const findDefaultFile = (nodes: FileNode[]): string | null => {
    const rootTest = nodes.find(n => !n.is_dir && n.path === "test.md");
    if (rootTest) return "test.md";
    return findFirstMdFile(nodes);
  };

  // Load workspace path and files
  const loadWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string>("get_workspace_path");
      setWorkspacePath(path);
      const tree = await invoke<FileNode[]>("get_file_tree");
      setFileTree(tree);

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

  // Run on mount
  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Open a file
  const openFile = async (fileName: string, wsPath?: string) => {
    if (!activePaneId) return;
    const leaf = findLeafNode(layout, activePaneId);
    if (!leaf) return;

    if (leaf.activeFile === fileName) {
      // Just focus it
      setFocusedComponent("editor");
      editorViewsRef.current.get(activePaneId)?.focus();
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

    const currentWS = wsPath || workspacePath;
    const filePath = `${currentWS}/${fileName}`;
    try {
      const content = await invoke<string>("read_markdown_file", { path: filePath });
      
      paneStatesRef.current.set(activePaneId, { isDirty: false, wordCount: computeWordCount(content) });
      setIsDirty(false);
      setWordCount(computeWordCount(content));

      const updateActivePane = (node: PaneNode): PaneNode => {
        if (node.type === "leaf") {
          if (node.id === activePaneId) {
            const nextTabs = node.tabs.includes(fileName) ? node.tabs : [...node.tabs, fileName];
            return {
              ...node,
              tabs: nextTabs,
              activeFile: fileName
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

  // Flattened visible items for tree list keyboard/mouse selection
  interface VisibleItem {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    node: FileNode;
  }

  const visibleItems = useMemo(() => {
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
        if (!showHidden && node.name.startsWith(".")) {
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
  }, [fileTree, expandedPaths, showHidden, creatingNode, newInputName]);

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
  const registerView = useCallback((paneId: PaneId, view: EditorView | null) => {
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

  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { activePaneIdRef.current = activePaneId; }, [activePaneId]);
  useEffect(() => { prefixActiveRef.current = prefixActive; }, [prefixActive]);
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);
  useEffect(() => { closeTabRef.current = closeTab; }, [closeTab]);
  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);
  useEffect(() => { splitActivePaneRef.current = splitActivePane; }, [splitActivePane]);
  useEffect(() => { closeActivePaneRef.current = closeActivePane; }, [closeActivePane]);
  useEffect(() => { navigateFocusRef.current = navigateFocus; }, [navigateFocus]);

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

      // Enter prefix mode
      if (e.ctrlKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setPrefixActive(true);
        if (prefixTimeoutRef.current) clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = setTimeout(() => {
          setPrefixActive(false);
        }, 3000);
        return;
      }

      // Ctrl+S to save
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveFileRef.current();
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
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

  // Sidebar key bindings
  const handleSidebarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (creatingNode) return;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        setSidebarSelectedIndex((i) => Math.min(i + 1, visibleItems.length - 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        setSidebarSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        {
          const currentItem = visibleItems[sidebarSelectedIndex];
          if (currentItem) {
            if (currentItem.isDir && expandedPaths.has(currentItem.path)) {
              setExpandedPaths(prev => {
                const next = new Set(prev);
                next.delete(currentItem.path);
                return next;
              });
            } else {
              const parts = currentItem.path.split("/");
              if (parts.length > 1) {
                const parentPath = parts.slice(0, -1).join("/");
                const parentIdx = visibleItems.findIndex(item => item.path === parentPath);
                if (parentIdx !== -1) {
                  setSidebarSelectedIndex(parentIdx);
                }
              }
            }
          }
        }
        break;
      case "l":
      case "ArrowRight":
        e.preventDefault();
        {
          const currentItem = visibleItems[sidebarSelectedIndex];
          if (currentItem) {
            if (currentItem.isDir) {
              if (!expandedPaths.has(currentItem.path)) {
                setExpandedPaths(prev => {
                  const next = new Set(prev);
                  next.add(currentItem.path);
                  return next;
                });
              } else {
                setSidebarSelectedIndex((i) => Math.min(i + 1, visibleItems.length - 1));
              }
            } else {
              openFile(currentItem.path);
              setFocusedComponent("editor");
            }
          }
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        {
          const currentItem = visibleItems[sidebarSelectedIndex];
          if (currentItem) {
            if (currentItem.isDir) {
              setExpandedPaths(prev => {
                const next = new Set(prev);
                if (next.has(currentItem.path)) next.delete(currentItem.path);
                else next.add(currentItem.path);
                return next;
              });
            } else {
              openFile(currentItem.path);
              setFocusedComponent("editor");
            }
          }
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
          vimMode={vimMode}
          livePreview={livePreview}
          workspacePath={workspacePath}
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
            <div className="sidebar-header-actions">
              <button
                className="btn-header-action"
                onClick={() => {
                  inputFocusedRef.current = false;
                  setCreatingNode({ type: "file", parentPath: "" });
                  setNewInputName("untitled.md");
                }}
                title="New File (Root)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </button>
              <button
                className="btn-header-action"
                onClick={() => {
                  inputFocusedRef.current = false;
                  setCreatingNode({ type: "dir", parentPath: "" });
                  setNewInputName("untitled");
                }}
                title="New Folder (Root)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </button>
              <button
                className={`btn-header-action ${showHidden ? "active" : ""}`}
                onClick={() => setShowHidden(prev => !prev)}
                title="Toggle Hidden Files"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                  {!showHidden && <line x1="1" y1="1" x2="23" y2="23" />}
                </svg>
              </button>
            </div>
          </div>

          <div
            ref={sidebarRef}
            className="file-list"
            tabIndex={0}
            onKeyDown={handleSidebarKeyDown}
            onFocus={() => setFocusedComponent("sidebar")}
          >
            {visibleItems.length === 0 && !creatingNode && (
              <div className="file-list-empty">
                No files found in workspace. Use buttons in the header to get started.
              </div>
            )}
            {visibleItems.map((item, idx) => {
              const isSelected = idx === sidebarSelectedIndex;

              if (item.path === "__creating__") {
                return (
                  <div
                    key="__creating__"
                    className="file-item-creating-wrapper"
                    style={{ paddingLeft: `${8 + item.depth * 16}px` }}
                  >
                    <span className="file-item-icon-wrapper">
                      {item.isDir ? (
                        <svg className="file-item-icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      ) : (
                        <svg className="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      )}
                    </span>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleNewNodeSubmit(false);
                      }}
                      className="new-node-form"
                      style={{ flex: 1 }}
                    >
                      <input
                        ref={(el) => {
                          if (el && !inputFocusedRef.current) {
                            inputFocusedRef.current = true;
                            el.focus();
                            const dotIdx = el.value.lastIndexOf(".");
                            if (dotIdx > 0 && !item.isDir) {
                              el.setSelectionRange(0, dotIdx);
                            } else {
                              el.select();
                            }
                          }
                        }}
                        className="new-node-input"
                        value={newInputName}
                        onChange={(e) => setNewInputName(e.target.value)}
                        onBlur={() => handleNewNodeSubmit(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            inputFocusedRef.current = false;
                            setCreatingNode(null);
                            setNewInputName("");
                          }
                        }}
                        placeholder={item.isDir ? "Folder..." : "File.md..."}
                      />
                    </form>
                  </div>
                );
              }

              const isActive = activeFile === item.path;
              const isExpanded = item.isDir && expandedPaths.has(item.path);

              return (
                <div
                  key={item.path}
                  className={`file-tree-row ${isActive ? "active" : ""} ${isSelected && focusedComponent === "sidebar" ? "kb-selected" : ""}`}
                  style={{ paddingLeft: `${8 + item.depth * 16}px` }}
                  onClick={() => {
                    setSidebarSelectedIndex(idx);
                    if (item.isDir) {
                      setExpandedPaths(prev => {
                        const next = new Set(prev);
                        if (next.has(item.path)) next.delete(item.path);
                        else next.add(item.path);
                        return next;
                      });
                    } else {
                      openFile(item.path);
                      setFocusedComponent("editor");
                    }
                  }}
                >
                  <span className="tree-chevron-wrapper">
                    {item.isDir && (
                      <svg
                        className={`tree-chevron ${isExpanded ? "expanded" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    )}
                  </span>
                  <span className="file-item-icon-wrapper">
                    {item.isDir ? (
                      <svg className="file-item-icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    ) : (
                      <svg className="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    )}
                  </span>
                  <span className="file-item-name">
                    {item.isDir ? item.name : item.name.replace(/\.md$/, "")}
                  </span>
                  {item.isDir && (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn-row-action"
                        onClick={() => {
                          inputFocusedRef.current = false;
                          setCreatingNode({ type: "file", parentPath: item.path });
                          setNewInputName("untitled.md");
                          setExpandedPaths(prev => {
                            const next = new Set(prev);
                            next.add(item.path);
                            return next;
                          });
                        }}
                        title="New File inside folder"
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="12" y1="18" x2="12" y2="12" />
                          <line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                      </button>
                      <button
                        className="btn-row-action"
                        onClick={() => {
                          inputFocusedRef.current = false;
                          setCreatingNode({ type: "dir", parentPath: item.path });
                          setNewInputName("untitled");
                          setExpandedPaths(prev => {
                            const next = new Set(prev);
                            next.add(item.path);
                            return next;
                          });
                        }}
                        title="New Folder inside folder"
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          <line x1="12" y1="18" x2="12" y2="12" />
                          <line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="app-main">
          {renderPaneNode(layout)}
        </main>
      </div>

      <footer className="app-status-bar">
        <div className="status-section">
          <span className="status-filename">{activeFile || "No file open"}</span>
          {isDirty && <span className="status-dirty-dot" title="Unsaved changes" />}
        </div>
        {prefixActive && (
          <div className="status-section" style={{ animation: "pulse 1s infinite" }}>
            <span style={{
              background: "var(--accent)",
              color: "var(--bg-dark)",
              padding: "1px 6px",
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.05em"
            }}>PREFIX</span>
          </div>
        )}
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

interface EditorPaneProps {
  paneId: string;
  activeFile: string | null;
  tabs: string[];
  isActive: boolean;
  vimMode: boolean;
  livePreview: boolean;
  workspacePath: string;
  onFocus: () => void;
  onCloseTab: (paneId: string, file: string) => void;
  onOpenFile: (file: string) => void;
  registerView: (paneId: string, view: EditorView | null) => void;
  registerState: (paneId: string, isDirty: boolean, wordCount: number) => void;
  onDocChange: (paneId: string, content: string) => void;
  onVimModeChange: (mode: string) => void;
}

const EditorPaneComponent: React.FC<EditorPaneProps> = ({
  paneId,
  activeFile,
  tabs,
  isActive,
  vimMode,
  livePreview,
  workspacePath,
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
  const [content, setContent] = useState("");
  const [isLocalDirty, setIsLocalDirty] = useState(false);

  // Load content when activeFile changes
  useEffect(() => {
    if (!activeFile) {
      setContent("");
      setIsLocalDirty(false);
      registerState(paneId, false, 0);
      return;
    }

    const loadContent = async () => {
      try {
        const filePath = `${workspacePath}/${activeFile}`;
        const fileContent = await invoke<string>("read_markdown_file", { path: filePath });
        setContent(fileContent);
        setIsLocalDirty(false);
        const wCount = computeWordCount(fileContent);
        registerState(paneId, false, wCount);
      } catch (err) {
        console.error("Failed to load pane file", err);
      }
    };
    loadContent();
  }, [activeFile, workspacePath, paneId]);

  // CodeMirror initialization & lifecycle
  useEffect(() => {
    if (!containerRef.current || !activeFile) return;

    const extensions = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const docString = update.state.doc.toString();
          const wCount = computeWordCount(docString);
          setIsLocalDirty(true);
          registerState(paneId, true, wCount);
          onDocChange(paneId, docString);
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
      doc: content,
      extensions
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current
    });

    viewRef.current = view;
    registerView(paneId, view);

    if (isActive) {
      view.focus();
    }

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
      view.destroy();
      viewRef.current = null;
      registerView(paneId, null);
    };
  }, [activeFile, content, vimMode, livePreview, paneId]);

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

export default App;

