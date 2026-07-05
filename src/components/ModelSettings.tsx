import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ModelWithStatus, DownloadProgress } from "../types";

export const ModelSettings: React.FC = () => {
  const [models, setModels] = useState<ModelWithStatus[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());

  const loadModels = async () => {
    try {
      console.log("Loading models...");
      const modelList = await invoke<ModelWithStatus[]>("get_models");
      console.log("Models loaded:", modelList);
      setModels(modelList);
      const active = await invoke<string | null>("get_active_model");
      console.log("Active model:", active);
      setActiveModelId(active);
    } catch (err) {
      console.error("Error loading models:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    loadModels();

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
      <h3>AI Models</h3>
      <p className="settings-description">
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

          return (
            <div
              key={model.id}
              className={`model-card ${isActive ? "active" : ""} ${(status === "downloaded" || status === "active") ? "clickable" : ""}`}
              onClick={() => {
                if ((status === "downloaded" || status === "active") && !isActive) {
                  handleSetActive(model.id);
                }
              }}
              style={{ cursor: (status === "downloaded" || status === "active") && !isActive ? "pointer" : "default" }}
            >
              <div className="model-header">
                <div className="model-info">
                  <span className="model-name">{model.name}</span>
                  <span className="model-size">{formatSize(model.size_bytes)}</span>
                </div>
                {isActive && <span className="active-badge">Active</span>}
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

                {(status === "downloaded" || status === "active") && (
                  <>
                    {!isActive && (
                      <button type="button" onClick={() => handleSetActive(model.id)} className="btn-activate">
                        Use This Model
                      </button>
                    )}
                    <button type="button" onClick={() => handleDelete(model.id)} className="btn-delete">
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ModelSettings;
