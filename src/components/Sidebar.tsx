import React, { useRef } from "react";
import { FileNode, AppSettings } from "../types";

export interface VisibleItem {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  node: FileNode;
}

export interface SidebarProps {
  sidebarOpen: boolean;
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  focusedComponent: "editor" | "sidebar";
  setFocusedComponent: (comp: "editor" | "sidebar") => void;
  visibleItems: VisibleItem[];
  sidebarSelectedIndex: number;
  setSidebarSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  expandedPaths: Set<string>;
  setExpandedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  creatingNode: { type: "file" | "dir"; parentPath: string } | null;
  setCreatingNode: (node: { type: "file" | "dir"; parentPath: string } | null) => void;
  newInputName: string;
  setNewInputName: (name: string) => void;
  showHidden: boolean;
  updateSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
  changeWorkspace: () => void;
  openFile: (fileName: string) => Promise<void>;
  activeFile: string | null;
  handleNewNodeSubmit: (isBlur?: boolean) => Promise<void>;
  inputFocusedRef: React.MutableRefObject<boolean>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sidebarOpen,
  sidebarRef,
  focusedComponent,
  setFocusedComponent,
  visibleItems,
  sidebarSelectedIndex,
  setSidebarSelectedIndex,
  expandedPaths,
  setExpandedPaths,
  creatingNode,
  setCreatingNode,
  newInputName,
  setNewInputName,
  showHidden,
  updateSettings,
  changeWorkspace,
  openFile,
  activeFile,
  handleNewNodeSubmit,
  inputFocusedRef
}) => {
  const sidebarVimBufferRef = useRef<string>("");

  const getTargetParentPath = (): string => {
    const currentItem = visibleItems[sidebarSelectedIndex];
    if (!currentItem) return "";
    if (currentItem.isDir) {
      return currentItem.path;
    } else {
      const lastSlashIdx = currentItem.path.lastIndexOf("/");
      return lastSlashIdx !== -1 ? currentItem.path.substring(0, lastSlashIdx) : "";
    }
  };

  const handleSidebarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (creatingNode) return;

    const buffer = sidebarVimBufferRef.current;

    // Check if it's a digit prefix (counts)
    if (/^[1-9]$/.test(e.key) || (e.key === "0" && buffer.length > 0 && /^\d+$/.test(buffer))) {
      e.preventDefault();
      sidebarVimBufferRef.current += e.key;
      return;
    }

    const parseCount = (): number => {
      const match = buffer.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 1;
    };

    // Handle `g` key (gg)
    if (e.key === "g") {
      e.preventDefault();
      if (buffer.endsWith("g")) {
        const count = parseCount();
        if (buffer.match(/^\d+/)) {
          // [count]gg -> go to line [count] (index count - 1)
          setSidebarSelectedIndex(Math.max(0, Math.min(count - 1, visibleItems.length - 1)));
        } else {
          // gg -> go to first line (index 0)
          setSidebarSelectedIndex(0);
        }
        sidebarVimBufferRef.current = "";
      } else {
        sidebarVimBufferRef.current += "g";
      }
      return;
    }

    // Handle `G` key
    if (e.key === "G") {
      e.preventDefault();
      const count = parseCount();
      if (buffer.match(/^\d+/)) {
        // [count]G -> go to line [count] (index count - 1)
        setSidebarSelectedIndex(Math.max(0, Math.min(count - 1, visibleItems.length - 1)));
      } else {
        // G -> go to last line
        setSidebarSelectedIndex(visibleItems.length - 1);
      }
      sidebarVimBufferRef.current = "";
      return;
    }

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        {
          const count = parseCount();
          setSidebarSelectedIndex((i) => Math.min(i + count, visibleItems.length - 1));
          sidebarVimBufferRef.current = "";
        }
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        {
          const count = parseCount();
          setSidebarSelectedIndex((i) => Math.max(i - count, 0));
          sidebarVimBufferRef.current = "";
        }
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
          sidebarVimBufferRef.current = "";
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
          sidebarVimBufferRef.current = "";
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
          sidebarVimBufferRef.current = "";
        }
        break;
      case "Escape":
        e.preventDefault();
        setFocusedComponent("editor");
        sidebarVimBufferRef.current = "";
        break;
      default:
        sidebarVimBufferRef.current = "";
        break;
    }
  };

  return (
    <aside className={`app-sidebar ${sidebarOpen ? "" : "collapsed"}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">Documents</span>
        <div className="sidebar-header-actions">
          <button
            className="btn-header-action"
            onClick={changeWorkspace}
            title="Open Folder (Change Workspace)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className="btn-header-action"
            onClick={() => {
              const targetPath = getTargetParentPath();
              inputFocusedRef.current = false;
              setCreatingNode({ type: "file", parentPath: targetPath });
              setNewInputName("untitled.md");
              if (targetPath) {
                setExpandedPaths(prev => {
                  const next = new Set(prev);
                  next.add(targetPath);
                  return next;
                });
              }
            }}
            title="New File"
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
              const targetPath = getTargetParentPath();
              inputFocusedRef.current = false;
              setCreatingNode({ type: "dir", parentPath: targetPath });
              setNewInputName("untitled");
              if (targetPath) {
                setExpandedPaths(prev => {
                  const next = new Set(prev);
                  next.add(targetPath);
                  return next;
                });
              }
            }}
            title="New Folder"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </button>
          <button
            className={`btn-header-action ${showHidden ? "active" : ""}`}
            onClick={() => updateSettings({ showHidden: !showHidden })}
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
  );
};
