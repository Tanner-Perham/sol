import React from "react";
import { AppSettings, Keybindings } from "../types";
import { DEFAULT_KEYBINDINGS } from "../constants";
import { ModelSettings } from "./ModelSettings";

export type SettingsTabType = "general" | "appearance" | "hotkeys" | "models";

export interface SettingsModalProps {
  showSettingsModal: boolean;
  setShowSettingsModal: (show: boolean) => void;
  activeSettingsTab: SettingsTabType;
  setActiveSettingsTab: (tab: SettingsTabType) => void;
  settings: AppSettings;
  updateSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
  recordingHotkey: keyof Keybindings | null;
  setRecordingHotkey: (hotkey: keyof Keybindings | null) => void;
  openPolicyFile?: () => Promise<void>;
}

const renderShortcutBadges = (shortcutStr: string) => {
  const isMac = navigator.userAgent.indexOf("Mac") !== -1;
  const parts = shortcutStr.split("+");
  return parts.map((part, idx) => {
    let label = part;
    if (part === "mod") {
      label = isMac ? "⌘ Cmd" : "Ctrl";
    } else if (part === "ctrl") {
      label = "Ctrl";
    } else if (part === "meta") {
      label = isMac ? "⌘ Cmd" : "Win";
    } else if (part === "alt") {
      label = isMac ? "⌥ Opt" : "Alt";
    } else if (part === "shift") {
      label = "Shift";
    } else if (part === "tab") {
      label = "Tab";
    } else if (part === "esc" || part === "escape") {
      label = "Esc";
    } else {
      label = part.charAt(0).toUpperCase() + part.slice(1);
    }
    return (
      <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
        {idx > 0 && <span style={{ fontSize: "10px", color: "var(--text-muted)", opacity: 0.6, margin: "0 2px" }}>+</span>}
        <kbd className="keybind-badge">{label}</kbd>
      </span>
    );
  });
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  showSettingsModal,
  setShowSettingsModal,
  activeSettingsTab,
  setActiveSettingsTab,
  settings,
  updateSettings,
  recordingHotkey,
  setRecordingHotkey,
  openPolicyFile
}) => {
  return (
    <div className={`settings-modal-overlay ${showSettingsModal ? "open" : ""}`} onClick={() => setShowSettingsModal(false)}>
      <div className="settings-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <button className="btn-close-modal" onClick={() => setShowSettingsModal(false)} title="Close Settings">
            ×
          </button>
        </div>

        <div className="settings-modal-container">
          {/* Left Sidebar */}
          <div className="settings-modal-sidebar">
            <button
              className={`settings-tab-btn ${activeSettingsTab === "general" ? "active" : ""}`}
              onClick={() => setActiveSettingsTab("general")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              General
            </button>
            <button
              className={`settings-tab-btn ${activeSettingsTab === "appearance" ? "active" : ""}`}
              onClick={() => setActiveSettingsTab("appearance")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>
              Appearance
            </button>
            <button
              className={`settings-tab-btn ${activeSettingsTab === "hotkeys" ? "active" : ""}`}
              onClick={() => setActiveSettingsTab("hotkeys")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                <line x1="6" y1="8" x2="6" y2="8" />
                <line x1="10" y1="8" x2="10" y2="8" />
                <line x1="14" y1="8" x2="14" y2="8" />
                <line x1="18" y1="8" x2="18" y2="8" />
                <line x1="6" y1="12" x2="6" y2="12" />
                <line x1="10" y1="12" x2="10" y2="12" />
                <line x1="14" y1="12" x2="14" y2="12" />
                <line x1="18" y1="12" x2="18" y2="12" />
                <line x1="7" y1="16" x2="17" y2="16" />
              </svg>
              Hotkeys
            </button>
            <button
              className={`settings-tab-btn ${activeSettingsTab === "models" ? "active" : ""}`}
              onClick={() => setActiveSettingsTab("models")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              AI Models
            </button>
          </div>

          {/* Right Content Area */}
          <div className="settings-modal-content">
            {activeSettingsTab === "general" && (
              <div className="settings-section">
                <span className="settings-section-title">General Preferences</span>
                
                {/* Vim Mode */}
                <div className="settings-control-row">
                  <div className="settings-control-label">
                    <span>Vim Mode</span>
                    <span className="settings-control-desc">Enable Vim key bindings and commands</span>
                  </div>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={settings.vimMode}
                      onChange={(e) => updateSettings({ vimMode: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>

                {/* Live Preview */}
                <div className="settings-control-row">
                  <div className="settings-control-label">
                    <span>Live Preview</span>
                    <span className="settings-control-desc">Show dynamic rich markdown formatting</span>
                  </div>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={settings.livePreview}
                      onChange={(e) => updateSettings({ livePreview: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>

                {/* Show Hidden Files */}
                <div className="settings-control-row">
                  <div className="settings-control-label">
                    <span>Show Hidden Files</span>
                    <span className="settings-control-desc">Display files and folders starting with a dot</span>
                  </div>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={settings.showHidden}
                      onChange={(e) => updateSettings({ showHidden: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>
            )}

            {activeSettingsTab === "appearance" && (
              <>
                {/* Theme Section */}
                <div className="settings-section">
                  <span className="settings-section-title">Theme</span>
                  <div className="themes-grid">
                    {[
                      { id: "sol-dark", name: "Sol Dark", colors: ["#131312", "#cfb18c", "#e8e6e3"] },
                      { id: "nord", name: "Nord Night", colors: ["#2e3440", "#88c0d0", "#d8dee9"] },
                      { id: "monokai", name: "Monokai Aura", colors: ["#1a1a1a", "#ae81ff", "#f8f8f2"] },
                      { id: "forest", name: "Forest Moss", colors: ["#141715", "#87af92", "#e3e8e4"] },
                      { id: "sepia", name: "Sepia", colors: ["#fbf8f3", "#c07a34", "#433422"] },
                      { id: "light", name: "Sol Light", colors: ["#fafafa", "#3b82f6", "#171717"] },
                      { id: "lego", name: "Lego Block 🧩", colors: ["#0055a5", "#e60012", "#ffffff"] }
                    ].map((t) => (
                      <div
                        key={t.id}
                        className={`theme-card-option ${settings.theme === t.id ? "active" : ""}`}
                        onClick={() => updateSettings({ theme: t.id as any })}
                      >
                        <div className="theme-color-preview">
                          <div className="color-dot" style={{ backgroundColor: t.colors[0] }} title="Background" />
                          <div className="color-dot" style={{ backgroundColor: t.colors[1] }} title="Accent" />
                          <div className="color-dot" style={{ backgroundColor: t.colors[2] }} title="Text" />
                        </div>
                        <span className="theme-card-name">{t.name}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Typography Section */}
                <div className="settings-section">
                  <span className="settings-section-title">Typography</span>
                  
                  {/* Font Family */}
                  <div className="settings-control-row">
                    <div className="settings-control-label">
                      <span>Font Family</span>
                      <span className="settings-control-desc">Font used in the editor area</span>
                    </div>
                    <div className="segmented-control">
                      {[
                        { id: "serif", label: "Serif" },
                        { id: "sans", label: "Sans" },
                        { id: "mono", label: "Mono" }
                      ].map((f) => (
                        <button
                          key={f.id}
                          className={`segment-btn ${settings.fontFamily === f.id ? "active" : ""}`}
                          onClick={() => updateSettings({ fontFamily: f.id as any })}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Font Size */}
                  <div className="settings-control-row">
                    <div className="settings-control-label">
                      <span>Font Size</span>
                      <span className="settings-control-desc">Adjust size of text in editor</span>
                    </div>
                    <div className="slider-container">
                      <input
                        type="range"
                        min="12"
                        max="24"
                        value={settings.fontSize}
                        onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value) })}
                        className="settings-slider"
                      />
                      <span className="slider-value">{settings.fontSize}px</span>
                    </div>
                  </div>

                  {/* Line Height */}
                  <div className="settings-control-row">
                    <div className="settings-control-label">
                      <span>Line Height</span>
                      <span className="settings-control-desc">Vertical spacing between text lines</span>
                    </div>
                    <div className="slider-container">
                      <input
                        type="range"
                        min="1.4"
                        max="2.2"
                        step="0.1"
                        value={settings.lineHeight}
                        onChange={(e) => updateSettings({ lineHeight: parseFloat(e.target.value) })}
                        className="settings-slider"
                      />
                      <span className="slider-value">{settings.lineHeight}</span>
                    </div>
                  </div>

                  {/* Line Wrapping */}
                  <div className="settings-control-row">
                    <div className="settings-control-label">
                      <span>Line Wrapping</span>
                      <span className="settings-control-desc">Wrap long text lines to fit the view</span>
                    </div>
                    <label className="settings-switch">
                      <input
                        type="checkbox"
                        checked={settings.lineWrapping}
                        onChange={(e) => updateSettings({ lineWrapping: e.target.checked })}
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                </div>
              </>
            )}

            {activeSettingsTab === "hotkeys" && (
              <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
                <div>
                  <span className="settings-section-title">Customizable Shortcuts</span>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px" }}>
                    Click the edit icon to record a new key combination, or the reset icon to restore the default.
                  </div>
                  <div className="keybind-list">
                    {[
                      { id: "save", name: "Save Document", desc: "Saves changes in active editor pane", vim: ":w" },
                      { id: "togglePreview", name: "Toggle Live Preview", desc: "Toggle visual rendering style" },
                      { id: "toggleSidebar", name: "Toggle Sidebar Panel", desc: "Show or hide the file tree sidebar" },
                      { id: "toggleFocus", name: "Toggle Sidebar / Editor Focus", desc: "Quick focus toggle between panels" },
                      { id: "prefixMode", name: "Enter Split Pane Prefix Mode", desc: "Enter window splitting mode (trigger \\ or - splits next)" }
                    ].map((kb) => {
                      const currentVal = settings.keybindings?.[kb.id as keyof Keybindings] || DEFAULT_KEYBINDINGS[kb.id as keyof Keybindings];
                      const isRecording = recordingHotkey === kb.id;
                      return (
                        <div key={kb.id} className={`keybind-row ${isRecording ? "recording" : ""}`}>
                          <div className="keybind-info">
                            <span className="keybind-name">{kb.name}</span>
                            <span className="keybind-desc">{kb.desc}</span>
                          </div>
                          <div className="keybind-badge-container">
                            {isRecording ? (
                              <kbd className="keybind-badge recording" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
                                Press keys (Esc to cancel)...
                              </kbd>
                            ) : (
                              <>
                                {renderShortcutBadges(currentVal)}
                                <button
                                  className="btn-record-key"
                                  onClick={() => setRecordingHotkey(kb.id as keyof Keybindings)}
                                  title="Record custom shortcut"
                                  style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--text-muted)",
                                    cursor: "pointer",
                                    padding: "4px",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    transition: "color 0.2s ease"
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z" />
                                  </svg>
                                </button>
                                {settings.keybindings?.[kb.id as keyof Keybindings] && settings.keybindings[kb.id as keyof Keybindings] !== DEFAULT_KEYBINDINGS[kb.id as keyof Keybindings] && (
                                  <button
                                    className="btn-reset-key"
                                    onClick={() => {
                                      updateSettings({
                                        keybindings: {
                                          ...(settings.keybindings || DEFAULT_KEYBINDINGS),
                                          [kb.id]: DEFAULT_KEYBINDINGS[kb.id as keyof Keybindings]
                                        }
                                      });
                                    }}
                                    title="Reset to default"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "var(--text-muted)",
                                      cursor: "pointer",
                                      padding: "4px",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      transition: "color 0.2s ease"
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                    </svg>
                                  </button>
                                )}
                              </>
                            )}
                            {kb.vim && (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "8px" }}>
                                <span style={{ fontSize: "11px", color: "var(--accent)", fontWeight: "600" }} title="Vim Ex Command">Vim:</span>
                                <kbd className="keybind-badge" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>{kb.vim}</kbd>
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span className="settings-section-title">Built-in Reference</span>
                  <div className="keybind-list" style={{ marginTop: "6px" }}>
                    {[
                      { name: "Switch Workspace Tab", desc: "Activate tab index 1-9 in active pane", keys: ["Alt", "1-9"] },
                      { name: "Vim Visual Block Mode", desc: "Toggle visual block column editing", keys: ["Ctrl", "V"], alternative: ["Ctrl", "Q"] },
                      { name: "Exit Active Mode", desc: "Return to normal editing mode", keys: ["Esc"] }
                    ].map((kb, idx) => (
                      <div key={idx} className="keybind-row" style={{ opacity: 0.85 }}>
                        <div className="keybind-info">
                          <span className="keybind-name">{kb.name}</span>
                          <span className="keybind-desc">{kb.desc}</span>
                        </div>
                        <div className="keybind-badge-container">
                          {kb.keys.map((k, i) => (
                            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                              {i > 0 && <span style={{ fontSize: "10px", color: "var(--text-muted)", opacity: 0.6, margin: "0 2px" }}>+</span>}
                              <kbd className="keybind-badge">{k}</kbd>
                            </span>
                          ))}
                          {kb.alternative && (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                              <span style={{ fontSize: "10px", color: "var(--text-muted)", margin: "0 4px" }}>/</span>
                              {kb.alternative.map((k, i) => (
                                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                                  {i > 0 && <span style={{ fontSize: "10px", color: "var(--text-muted)", opacity: 0.6, margin: "0 2px" }}>+</span>}
                                  <kbd className="keybind-badge">{k}</kbd>
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeSettingsTab === "models" && (
              <ModelSettings openPolicyFile={openPolicyFile} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
