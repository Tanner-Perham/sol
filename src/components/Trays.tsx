import React, { useMemo } from "react";

interface RightTrayProps {
  isOpen: boolean;
  width: number;
  activeTab: "outline" | "info";
  setActiveTab: (tab: "outline" | "info") => void;
  activeFile: string | null;
  content: string;
  wordCount: number;
  onClose: () => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
  scrollToHeader: (header: string) => void;
}

export const RightTray: React.FC<RightTrayProps> = ({
  isOpen,
  width,
  activeTab,
  setActiveTab,
  activeFile,
  content,
  wordCount,
  onClose,
  onResizeMouseDown,
  scrollToHeader
}) => {
  // Parse headings from markdown content
  const headings = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const result: { level: number; text: string; id: string }[] = [];
    lines.forEach((line, idx) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        result.push({
          level: match[1].length,
          text: match[2].trim(),
          id: `${idx}-${match[2]}`
        });
      }
    });
    return result;
  }, [content]);

  // Compute character and paragraph count for info tab
  const stats = useMemo(() => {
    if (!content) return { chars: 0, paragraphs: 0, readTime: 0 };
    const chars = content.length;
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
    const readTime = Math.ceil(wordCount / 200); // 200 WPM average reading speed
    return { chars, paragraphs, readTime };
  }, [content, wordCount]);

  if (!isOpen) return null;

  return (
    <aside
      className="app-right-tray"
      style={{ width: `${width}px` }}
    >
      <div className="right-tray-resizer" onMouseDown={onResizeMouseDown} />
      
      <div className="tray-header">
        <div className="tray-tabs">
          <button
            className={`tray-tab-btn ${activeTab === "outline" ? "active" : ""}`}
            onClick={() => setActiveTab("outline")}
            title="Note Outline"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
            <span>Outline</span>
          </button>
          <button
            className={`tray-tab-btn ${activeTab === "info" ? "active" : ""}`}
            onClick={() => setActiveTab("info")}
            title="File Properties"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>Info</span>
          </button>
        </div>
        <button className="btn-close-tray" onClick={onClose} title="Close Panel">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div className="tray-body scrollable">
        {!activeFile ? (
          <div className="tray-empty-state">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
              <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
            <p>No file open to inspect</p>
          </div>
        ) : activeTab === "outline" ? (
          <div className="outline-tab">
            {headings.length === 0 ? (
              <div className="tray-empty-state mini">
                <p>No headings found in this note</p>
              </div>
            ) : (
              <div className="outline-list">
                {headings.map(h => (
                  <button
                    key={h.id}
                    className="outline-item"
                    onClick={() => scrollToHeader(h.text)}
                    style={{ paddingLeft: `${(h.level - 1) * 12 + 12}px` }}
                  >
                    <span className="outline-bullet">{"#".repeat(h.level)}</span>
                    <span className="outline-text">{h.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="info-tab">
            <div className="info-section">
              <h4>Vault Path</h4>
              <div className="info-path-box" title={activeFile}>
                {activeFile}
              </div>
            </div>
            
            <div className="info-section">
              <h4>Statistics</h4>
              <div className="info-grid">
                <div className="info-grid-card">
                  <span className="info-grid-val">{wordCount.toLocaleString()}</span>
                  <span className="info-grid-lbl">Words</span>
                </div>
                <div className="info-grid-card">
                  <span className="info-grid-val">{stats.chars.toLocaleString()}</span>
                  <span className="info-grid-lbl">Characters</span>
                </div>
                <div className="info-grid-card">
                  <span className="info-grid-val">{stats.paragraphs}</span>
                  <span className="info-grid-lbl">Paragraphs</span>
                </div>
                <div className="info-grid-card">
                  <span className="info-grid-val">{stats.readTime} min</span>
                  <span className="info-grid-lbl">Reading Time</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};


interface LogEntry {
  id: string;
  time: string;
  text: string;
  type: "info" | "success" | "warn" | "error";
}

interface BottomTrayProps {
  isOpen: boolean;
  height: number;
  activeTab: "console" | "ai" | "scratchpad";
  setActiveTab: (tab: "console" | "ai" | "scratchpad") => void;
  logs: LogEntry[];
  aiDebugInfo: {
    charCount: number;
    linkedCount: number;
    tokensEst: number;
    prefillMs?: number;
    tokPerS?: number;
    backend?: string;
  } | null;
  scratchpadContent: string;
  setScratchpadContent: (content: string) => void;
  onClose: () => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
}

export const BottomTray: React.FC<BottomTrayProps> = ({
  isOpen,
  height,
  activeTab,
  setActiveTab,
  logs,
  aiDebugInfo,
  scratchpadContent,
  setScratchpadContent,
  onClose,
  onResizeMouseDown
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="app-bottom-tray"
      style={{ height: `${height}px` }}
    >
      <div className="bottom-tray-resizer" onMouseDown={onResizeMouseDown} />

      <div className="tray-header">
        <div className="tray-tabs">
          <button
            className={`tray-tab-btn ${activeTab === "console" ? "active" : ""}`}
            onClick={() => setActiveTab("console")}
            title="System Actions Console"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
            <span>Console</span>
          </button>
          <button
            className={`tray-tab-btn ${activeTab === "ai" ? "active" : ""}`}
            onClick={() => setActiveTab("ai")}
            title="Local AI Inference Logs"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <span>AI Logs</span>
          </button>
          <button
            className={`tray-tab-btn ${activeTab === "scratchpad" ? "active" : ""}`}
            onClick={() => setActiveTab("scratchpad")}
            title="Persistent Scratchpad"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
            <span>Scratchpad</span>
          </button>
        </div>
        
        <button className="btn-close-tray" onClick={onClose} title="Close Panel">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div className="tray-body">
        {activeTab === "console" ? (
          <div className="console-tab scrollable">
            <div className="logs-container">
              {logs.map((log) => (
                <div key={log.id} className={`log-row ${log.type}`}>
                  <span className="log-time">[{log.time}]</span>
                  <span className="log-text">{log.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : activeTab === "ai" ? (
          <div className="ai-logs-tab scrollable">
            {aiDebugInfo ? (
              <div className="ai-debug-grid">
                <div className="ai-debug-row">
                  <span className="ai-debug-lbl">Backend Engine</span>
                  <span className="ai-debug-val">{aiDebugInfo.backend || "llama.cpp (Local)"}</span>
                </div>
                <div className="ai-debug-row">
                  <span className="ai-debug-lbl">Active Note Context</span>
                  <span className="ai-debug-val">{(aiDebugInfo.charCount || 0).toLocaleString()} characters</span>
                </div>
                <div className="ai-debug-row">
                  <span className="ai-debug-lbl">Linked Context Notes</span>
                  <span className="ai-debug-val">+{aiDebugInfo.linkedCount || 0} files</span>
                </div>
                <div className="ai-debug-row">
                  <span className="ai-debug-lbl">Total Estimated Tokens</span>
                  <span className="ai-debug-val">~{(aiDebugInfo.tokensEst || 0).toLocaleString()} tokens</span>
                </div>
                {aiDebugInfo.prefillMs !== undefined && (
                  <div className="ai-debug-row">
                    <span className="ai-debug-lbl">Prefill Response Time</span>
                    <span className="ai-debug-val">{aiDebugInfo.prefillMs} ms</span>
                  </div>
                )}
                {aiDebugInfo.tokPerS !== undefined && (
                  <div className="ai-debug-row">
                    <span className="ai-debug-lbl">Generation Speed</span>
                    <span className="ai-debug-val highlight">{aiDebugInfo.tokPerS.toFixed(2)} tokens/sec</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="tray-empty-state mini">
                <p>No active local AI generation logs yet. Type to trigger suggestions.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="scratchpad-tab">
            <textarea
              className="scratchpad-textarea"
              value={scratchpadContent}
              onChange={(e) => setScratchpadContent(e.target.value)}
              placeholder="Type your transient ideas here... This persistent scratchpad is saved automatically in this workspace."
            />
          </div>
        )}
      </div>
    </div>
  );
};
