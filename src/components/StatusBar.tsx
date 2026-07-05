import React from "react";
import { AppSettings } from "../types";

export interface EmbeddingStatusInfo {
  indexedCount: number;
  isReady: boolean;
  isIndexing?: boolean;
}

export interface StatusBarProps {
  activeFile: string | null;
  isDirty: boolean;
  prefixActive: boolean;
  vimMode: boolean;
  vimModeName: string;
  wordCount: number;
  viewMode: "editor" | "cloud";
  embeddingStatus?: EmbeddingStatusInfo;
  updateSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeFile,
  isDirty,
  prefixActive,
  vimMode,
  vimModeName,
  wordCount,
  viewMode,
  embeddingStatus,
  updateSettings
}) => {
  return (
    <footer className="app-status-bar">
      <div className="status-section">
        {viewMode === "editor" ? (
          <>
            <span className="status-filename">{activeFile || "No file open"}</span>
            {isDirty && <span className="status-dirty-dot" title="Unsaved changes" />}
          </>
        ) : (
          <>
            <span className="status-filename">Semantic Cloud</span>
            {embeddingStatus && (
              <span className="status-embedding" title="Embedding index status">
                {embeddingStatus.isIndexing ? "Indexing..." : `${embeddingStatus.indexedCount} notes`}
              </span>
            )}
          </>
        )}
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
        onClick={() => updateSettings({ vimMode: !vimMode })}
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
  );
};
