import React from "react";
import { AppSettings } from "../types";

export interface StatusBarProps {
  activeFile: string | null;
  isDirty: boolean;
  prefixActive: boolean;
  vimMode: boolean;
  vimModeName: string;
  wordCount: number;
  updateSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
  aiStatus: "allowed" | "excluded" | "loading";
  completionEnabled: boolean;
  aiDebugEnabled?: boolean;
  aiDebugInfo?: {
    charCount: number;
    linkedCount: number;
    tokensEst: number;
    prefillMs?: number;
    tokPerS?: number;
  } | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeFile,
  isDirty,
  prefixActive,
  vimMode,
  vimModeName,
  wordCount,
  updateSettings,
  aiStatus,
  completionEnabled,
  aiDebugEnabled,
  aiDebugInfo
}) => {
  return (
    <footer className="app-status-bar">
      <div className="status-section">
        <span className="status-filename">{activeFile || "No file open"}</span>
        {isDirty && <span className="status-dirty-dot" title="Unsaved changes" />}
      </div>
      {activeFile && (
        <div className="status-section">
          {aiStatus === "loading" && (
            <span style={{ color: "var(--text-muted)", opacity: 0.7, display: "inline-flex", alignItems: "center" }}>
              AI: Loading...
            </span>
          )}
          {aiStatus === "allowed" && (
            <span style={{ color: "#a6e3a1", fontWeight: 600 }} title="AI context allowed for this note">
              AI: Allowed
            </span>
          )}
          {aiStatus === "excluded" && (
            <span style={{ color: "#f9e2af", fontWeight: 600 }} title="AI context excluded for this note by policy">
              AI: Excluded
            </span>
          )}
        </div>
      )}
      {activeFile && aiDebugEnabled && aiDebugInfo && (
        <div className="status-section status-ai-debug" style={{ color: "var(--accent)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <span>
            ctx: {aiDebugInfo.charCount}ch +{aiDebugInfo.linkedCount} linked (~{aiDebugInfo.tokensEst} tok)
          </span>
          {aiDebugInfo.prefillMs !== undefined && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>prefill {aiDebugInfo.prefillMs}ms</span>
            </>
          )}
          {aiDebugInfo.tokPerS !== undefined && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>{aiDebugInfo.tokPerS.toFixed(1)} tok/s</span>
            </>
          )}
        </div>
      )}
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
      <button
        className={`status-toggle ${completionEnabled ? "active" : ""}`}
        onClick={() => updateSettings({ completionEnabled: !completionEnabled })}
        title="Toggle AI Completion"
        style={{ marginLeft: "4px" }}
      >
        AI Completion
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
