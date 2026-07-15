import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ModelWithStatus, DownloadProgress } from "../types";

export interface ProviderConfig {
  completion_backend: "Builtin" | "LlamaCpp";
  rework_backend: "Builtin" | "Ollama" | "LlamaCpp";
  ollama_url: string;
  ollama_rework_model: string | null;
  llamacpp_url: string;
  allow_remote_endpoints: boolean;
}

export interface ModelSettingsProps {
  openPolicyFile?: () => Promise<void>;
}

export const ModelSettings: React.FC<ModelSettingsProps> = ({ openPolicyFile }) => {
  const [models, setModels] = useState<ModelWithStatus[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [completionModelId, setCompletionModelId] = useState<string | null>(null);
  const [reworkModelId, setReworkModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());

  // Provider states
  const [providerConfig, setProviderConfig] = useState<ProviderConfig | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<{ available: boolean; error: string | null } | null>(null);
  const [testingOllama, setTestingOllama] = useState(false);

  const fetchOllamaModels = async (url: string, allowRemote: boolean) => {
    try {
      const list = await invoke<string[]>("list_ollama_models", { url, allowRemote });
      setOllamaModels(list);
    } catch (err) {
      console.error("Error listing Ollama models:", err);
      setOllamaModels([]);
    }
  };

  const checkOllamaStatus = async (url: string, allowRemote: boolean) => {
    setTestingOllama(true);
    try {
      const status = await invoke<{ available: boolean; error: string | null }>("check_ollama", { url, allowRemote });
      setOllamaStatus(status);
    } catch (err) {
      setOllamaStatus({ available: false, error: String(err) });
    } finally {
      setTestingOllama(false);
    }
  };

  const loadProviderConfig = async () => {
    try {
      const config = await invoke<ProviderConfig>("get_provider_config");
      setProviderConfig(config);
      if (config.rework_backend === "Ollama") {
        fetchOllamaModels(config.ollama_url, config.allow_remote_endpoints);
        checkOllamaStatus(config.ollama_url, config.allow_remote_endpoints);
      }
    } catch (err) {
      console.error("Error loading provider config:", err);
    }
  };

  const handleUpdateProviderConfig = async (updates: Partial<ProviderConfig>) => {
    if (!providerConfig) return;
    const nextConfig = { ...providerConfig, ...updates };
    setProviderConfig(nextConfig);
    try {
      await invoke("set_provider_config", { config: nextConfig });
      setError(null);
      if (
        updates.rework_backend === "Ollama" ||
        (nextConfig.rework_backend === "Ollama" &&
          (updates.ollama_url !== undefined || updates.allow_remote_endpoints !== undefined))
      ) {
        fetchOllamaModels(nextConfig.ollama_url, nextConfig.allow_remote_endpoints);
        checkOllamaStatus(nextConfig.ollama_url, nextConfig.allow_remote_endpoints);
      }
    } catch (err) {
      console.error("Error saving provider config:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadModels = async () => {
    try {
      console.log("Loading models...");
      const modelList = await invoke<ModelWithStatus[]>("get_models");
      console.log("Models loaded:", modelList);
      setModels(modelList);
      const active = await invoke<string | null>("get_active_model");
      console.log("Active model:", active);
      setActiveModelId(active);
      const completion = await invoke<string | null>("get_completion_model");
      console.log("Completion model:", completion);
      setCompletionModelId(completion);
      const rework = await invoke<string | null>("get_rework_model");
      console.log("Rework model:", rework);
      setReworkModelId(rework);
    } catch (err) {
      console.error("Error loading models:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    loadModels();
    loadProviderConfig();

    // Listen for download progress events
    const unlisten = listen<DownloadProgress>("model-download-progress", (event) => {
      const progress = event.payload;
      console.log("Download progress event:", progress);

      setDownloadProgress((prev) => ({
        ...prev,
        [progress.model_id]: progress,
      }));

      // Handle errors
      if (progress.status === "error") {
        console.error("Download error:", progress.error);
        setError(progress.error || "Download failed");
        setDownloadingModels(prev => {
          const next = new Set(prev);
          next.delete(progress.model_id);
          return next;
        });
        // Clear progress after showing error
        setTimeout(() => {
          setDownloadProgress((prev) => {
            const { [progress.model_id]: _, ...rest } = prev;
            return rest;
          });
          loadModels();
        }, 3000);
        return;
      }

      // Reload models when download completes
      if (progress.status === "completed") {
        setDownloadingModels(prev => {
          const next = new Set(prev);
          next.delete(progress.model_id);
          return next;
        });
        loadModels();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleDownload = async (modelId: string) => {
    // Prevent multiple clicks
    if (downloadingModels.has(modelId)) {
      console.log("Download already in progress for:", modelId);
      return;
    }

    console.log("handleDownload called for:", modelId);
    setDownloadingModels(prev => new Set(prev).add(modelId));

    try {
      setError(null);
      await invoke("start_model_download", { modelId });
    } catch (err) {
      console.error("Download error:", err);
      setError(err instanceof Error ? err.message : String(err));
      setDownloadingModels(prev => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  const handlePause = async (modelId: string) => {
    await invoke("pause_model_download", { modelId });
  };

  const handleResume = async (modelId: string) => {
    await invoke("resume_model_download", { modelId });
  };

  const handleCancel = async (modelId: string) => {
    await invoke("cancel_model_download", { modelId });
    setDownloadProgress((prev) => {
      const { [modelId]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleDelete = async (modelId: string) => {
    try {
      await invoke("delete_model", { modelId });
      loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetActive = async (modelId: string) => {
    try {
      await invoke("set_active_model", { modelId });
      setActiveModelId(modelId);
      loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetCompletion = async (modelId: string) => {
    try {
      await invoke("set_completion_model", { modelId });
      setCompletionModelId(modelId);
      loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetRework = async (modelId: string) => {
    try {
      await invoke("set_rework_model", { modelId });
      setReworkModelId(modelId);
      loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes >= 1_000_000_000) {
      return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    }
    return `${(bytes / 1_000_000).toFixed(0)} MB`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes >= 1_000_000_000) {
      return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    }
    if (bytes >= 1_000_000) {
      return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }
    if (bytes >= 1_000) {
      return `${(bytes / 1_000).toFixed(0)} KB`;
    }
    return `${bytes} B`;
  };

  const getModelStatus = (model: ModelWithStatus) => {
    const progress = downloadProgress[model.id];
    if (progress && progress.status === "downloading") {
      return "downloading";
    }
    return model.status;
  };

  return (
    <div className="model-settings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h3 style={{ margin: 0 }}>AI Models</h3>
        {openPolicyFile && (
          <button
            type="button"
            className="btn-header-action"
            onClick={openPolicyFile}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-light)",
              color: "var(--text-normal)",
              cursor: "pointer",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Manage AI Policy
          </button>
        )}
      </div>
      <p className="settings-description" style={{ marginTop: 0 }}>
        Download and manage AI models for topic discovery. Models are stored locally.
      </p>

      {error && (
        <div className="model-error">
          {error}
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="model-list">
        {models.length === 0 && <p style={{ color: "var(--text-muted)" }}>No models available. Check console for errors.</p>}
        {models.map((model) => {
          const status = getModelStatus(model);
          console.log("Rendering model:", model.id, "status:", status, "raw model:", model);
          const progress = downloadProgress[model.id];
          const isActive = activeModelId === model.id;
          const isCompletion = completionModelId === model.id;
          const isRework = reworkModelId === model.id;
          const hasAnyRole = isActive || isCompletion || isRework;

          return (
            <div
              key={model.id}
              className={`model-card ${hasAnyRole ? "active" : ""}`}
            >
              <div className="model-header">
                <div className="model-info">
                  <span className="model-name">{model.name}</span>
                  <span className="model-size">{formatSize(model.size_bytes)}</span>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  {isActive && <span className="active-badge">General</span>}
                  {isCompletion && <span className="active-badge" style={{ background: "var(--accent-glow)", color: "var(--accent)" }}>Completion</span>}
                  {isRework && <span className="active-badge" style={{ background: "var(--accent-glow)", color: "var(--accent)" }}>Rework</span>}
                </div>
              </div>

              <p className="model-description">{model.description}</p>

              {status === "downloading" && progress && (
                <div className="download-progress">
                  <div className="progress-bar">
                    <div
                      className="progress-fill downloading"
                      style={{
                        width: progress.total_bytes > 0
                          ? `${(progress.bytes_downloaded / progress.total_bytes) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <span className="progress-text">
                    <span className="download-spinner" />
                    {progress.file_name} ({progress.file_index + 1}/{progress.total_files})
                    {" — "}
                    {formatBytes(progress.bytes_downloaded)} / {formatBytes(progress.total_bytes)}
                  </span>
                </div>
              )}

              <div className="model-actions" onClick={(e) => { console.log("model-actions clicked"); e.stopPropagation(); }}>
                {status === "not_downloaded" && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDownload(model.id); }}
                    className="btn-download"
                    disabled={downloadingModels.has(model.id)}
                  >
                    {downloadingModels.has(model.id) ? "Starting..." : "Download"}
                  </button>
                )}

                {status === "downloading" && (
                  <>
                    <button type="button" onClick={() => handlePause(model.id)} className="btn-pause">
                      Pause
                    </button>
                    <button type="button" onClick={() => handleCancel(model.id)} className="btn-cancel">
                      Cancel
                    </button>
                  </>
                )}

                {status === "paused" && (
                  <>
                    <button type="button" onClick={() => handleResume(model.id)} className="btn-resume">
                      Resume
                    </button>
                    <button type="button" onClick={() => handleCancel(model.id)} className="btn-cancel">
                      Cancel
                    </button>
                  </>
                )}

                {(status === "downloaded" || status === "active" || hasAnyRole) && (
                  <button type="button" onClick={() => handleDelete(model.id)} className="btn-delete">
                    Delete
                  </button>
                )}
              </div>

              {(status === "downloaded" || status === "active" || hasAnyRole) && (
                <div className="model-roles" style={{ display: "flex", gap: "16px", marginTop: "12px", borderTop: "1px solid var(--border)", paddingTop: "12px" }} onClick={(e) => e.stopPropagation()}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", marginRight: "auto" }}>Assign Roles:</span>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer", color: isActive ? "var(--accent)" : "var(--text-muted)" }}>
                    <input
                      type="radio"
                      name={`general-model-${model.id}`}
                      checked={isActive}
                      onChange={() => handleSetActive(model.id)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    General
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer", color: isCompletion ? "var(--accent)" : "var(--text-muted)" }}>
                    <input
                      type="radio"
                      name={`completion-model-${model.id}`}
                      checked={isCompletion}
                      onChange={() => handleSetCompletion(model.id)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    Completion
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer", color: isRework ? "var(--accent)" : "var(--text-muted)" }}>
                    <input
                      type="radio"
                      name={`rework-model-${model.id}`}
                      checked={isRework}
                      onChange={() => handleSetRework(model.id)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    Rework
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {providerConfig && (
        <div className="provider-settings" style={{ marginTop: "24px", borderTop: "1px solid var(--border)", paddingTop: "20px" }}>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "15px" }}>Inference Providers</h4>
          <p className="settings-description" style={{ marginTop: 0, marginBottom: "16px" }}>
            Configure external backends for completion and text rework.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Completion Backend Selector */}
            <div className="settings-control-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="settings-control-label">
                <span style={{ fontWeight: 600, fontSize: "13px" }}>Completion Backend</span>
                <span className="settings-control-desc" style={{ fontSize: "11px", color: "var(--text-muted)", display: "block" }}>
                  Backend engine for autocomplete suggestions
                </span>
              </div>
              <div className="segmented-control" style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  className={`segment-btn ${providerConfig.completion_backend === "Builtin" ? "active" : ""}`}
                  onClick={() => handleUpdateProviderConfig({ completion_backend: "Builtin" })}
                  style={{ padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}
                >
                  Built-in (Candle)
                </button>
                <button
                  type="button"
                  className={`segment-btn ${providerConfig.completion_backend === "LlamaCpp" ? "active" : ""}`}
                  disabled
                  title="llama.cpp completion coming in M3"
                  style={{ padding: "4px 10px", fontSize: "12px", opacity: 0.5, cursor: "not-allowed" }}
                >
                  llama.cpp (M3)
                </button>
              </div>
            </div>

            {/* Rework Backend Selector */}
            <div className="settings-control-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="settings-control-label">
                <span style={{ fontWeight: 600, fontSize: "13px" }}>Rework Backend</span>
                <span className="settings-control-desc" style={{ fontSize: "11px", color: "var(--text-muted)", display: "block" }}>
                  Backend engine for rewriting text selections
                </span>
              </div>
              <div className="segmented-control" style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  className={`segment-btn ${providerConfig.rework_backend === "Builtin" ? "active" : ""}`}
                  onClick={() => handleUpdateProviderConfig({ rework_backend: "Builtin" })}
                  style={{ padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}
                >
                  Built-in (Candle)
                </button>
                <button
                  type="button"
                  className={`segment-btn ${providerConfig.rework_backend === "Ollama" ? "active" : ""}`}
                  onClick={() => handleUpdateProviderConfig({ rework_backend: "Ollama" })}
                  style={{ padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}
                >
                  Ollama
                </button>
                <button
                  type="button"
                  className={`segment-btn ${providerConfig.rework_backend === "LlamaCpp" ? "active" : ""}`}
                  disabled
                  title="llama.cpp rework coming in M2"
                  style={{ padding: "4px 10px", fontSize: "12px", opacity: 0.5, cursor: "not-allowed" }}
                >
                  llama.cpp (M2)
                </button>
              </div>
            </div>

            {/* Remote endpoints toggle */}
            <div className="settings-control-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="settings-control-label">
                <span style={{ fontWeight: 600, fontSize: "13px" }}>Allow Remote Endpoints</span>
                <span className="settings-control-desc" style={{ fontSize: "11px", color: "var(--text-muted)", display: "block" }}>
                  Allow connections to non-loopback IPs (e.g. homelab servers)
                </span>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={providerConfig.allow_remote_endpoints}
                  onChange={(e) => handleUpdateProviderConfig({ allow_remote_endpoints: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>

            {/* Ollama Details Panel */}
            {providerConfig.rework_backend === "Ollama" && (
              <div style={{
                background: "var(--bg-light)",
                borderRadius: "8px",
                padding: "12px 16px",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                marginTop: "4px"
              }}>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", marginBottom: "4px" }}>
                      Ollama API URL
                    </label>
                    <input
                      type="text"
                      className="settings-input"
                      value={providerConfig.ollama_url}
                      onChange={(e) => handleUpdateProviderConfig({ ollama_url: e.target.value })}
                      style={{
                        width: "100%",
                        padding: "6px 10px",
                        fontSize: "12px",
                        borderRadius: "6px",
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text-normal)"
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", marginBottom: "4px" }}>
                      Status
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", height: "30px" }}>
                      {ollamaStatus ? (
                        <>
                          <span style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: ollamaStatus.available ? "#22c55e" : "#ef4444",
                            display: "inline-block"
                          }} />
                          <span style={{ fontSize: "12px", color: ollamaStatus.available ? "#22c55e" : "#ef4444" }}>
                            {ollamaStatus.available ? "Online" : "Offline"}
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Unknown</span>
                      )}
                    </div>
                  </div>

                  <div style={{ alignSelf: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => {
                        fetchOllamaModels(providerConfig.ollama_url, providerConfig.allow_remote_endpoints);
                        checkOllamaStatus(providerConfig.ollama_url, providerConfig.allow_remote_endpoints);
                      }}
                      disabled={testingOllama}
                      style={{
                        padding: "6px 12px",
                        fontSize: "12px",
                        borderRadius: "6px",
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text-normal)",
                        cursor: "pointer"
                      }}
                    >
                      {testingOllama ? "Testing..." : "Test & Refresh"}
                    </button>
                  </div>
                </div>

                {ollamaStatus && ollamaStatus.error && (
                  <div style={{ fontSize: "11px", color: "#ef4444", background: "rgba(239, 68, 68, 0.08)", padding: "8px 12px", borderRadius: "6px" }}>
                    {ollamaStatus.error}
                  </div>
                )}

                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", marginBottom: "4px" }}>
                    Ollama Rework Model
                  </label>
                  <select
                    value={providerConfig.ollama_rework_model || ""}
                    onChange={(e) => handleUpdateProviderConfig({ ollama_rework_model: e.target.value || null })}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      fontSize: "12px",
                      borderRadius: "6px",
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-normal)"
                    }}
                  >
                    <option value="">-- Select a model --</option>
                    {ollamaModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSettings;
