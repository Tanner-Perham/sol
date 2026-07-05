import React, { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AnchoredLabel, SimilarNote, DiscoveryCandidate } from "../../types";
import { RelatedNotesPanel } from "./RelatedNotesPanel";
import { SuggestionQueue } from "./SuggestionQueue";

interface EmbeddingStatus {
  indexed_count: number;
  is_ready: boolean;
  model_name: string;
}

interface EmbeddingProgress {
  current: number;
  total: number;
  current_file: string;
  phase: string;
}

export interface SemanticCloudProps {
  workspacePath: string;
  onSelectNote: (path: string) => void;
}

export const SemanticCloud: React.FC<SemanticCloudProps> = ({
  workspacePath,
  onSelectNote,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);

  // Label state
  const [labels, setLabels] = useState<AnchoredLabel[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<AnchoredLabel | null>(null);
  const [relatedNotes, setRelatedNotes] = useState<SimilarNote[]>([]);
  const [newLabelName, setNewLabelName] = useState("");
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    label: AnchoredLabel;
  } | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Discovery state
  const [suggestions, setSuggestions] = useState<DiscoveryCandidate[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // Model state
  const [showModelPrompt, setShowModelPrompt] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        // Check if an LLM model is ready for topic naming
        const isModelReady = await invoke<boolean>("is_model_ready");
        if (!isModelReady) {
          setShowModelPrompt(true);
        }

        const embeddingStatus = await invoke<EmbeddingStatus>("get_embedding_status");
        setStatus(embeddingStatus);

        const indexableFiles = await invoke<string[]>("get_indexable_files");
        setFiles(indexableFiles);

        const existingLabels = await invoke<AnchoredLabel[]>("get_labels");
        setLabels(existingLabels);

        // Load existing suggestions
        const existingSuggestions = await invoke<DiscoveryCandidate[]>("get_discovery_suggestions");
        setSuggestions(existingSuggestions);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    };

    init();

    const unlisten = listen<EmbeddingProgress>("embedding-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.phase === "complete") {
        setTimeout(() => setProgress(null), 1000);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // Focus edit input when editing
  useEffect(() => {
    if (editingLabel && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLabel]);

  // Keyboard shortcut: Ctrl+L to focus label input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        labelInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleRebuildIndex = async () => {
    setIsIndexing(true);
    setError(null);

    try {
      const newStatus = await invoke<EmbeddingStatus>("rebuild_embedding_index");
      setStatus(newStatus);
      const indexableFiles = await invoke<string[]>("get_indexable_files");
      setFiles(indexableFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsIndexing(false);
    }
  };

  const handleCreateLabel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabelName.trim() || isCreatingLabel) return;

    setIsCreatingLabel(true);
    try {
      const label = await invoke<AnchoredLabel>("create_label", { name: newLabelName.trim() });
      setLabels([...labels, label]);
      setNewLabelName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreatingLabel(false);
    }
  };

  const handleSelectLabel = async (label: AnchoredLabel) => {
    setSelectedLabel(label);
    try {
      const notes = await invoke<SimilarNote[]>("get_label_notes", {
        labelId: label.id,
        k: 10,
      });
      setRelatedNotes(notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleContextMenu = (e: React.MouseEvent, label: AnchoredLabel) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, label });
  };

  const handleRename = () => {
    if (!contextMenu) return;
    setEditingLabel(contextMenu.label.id);
    setEditName(contextMenu.label.name);
    setContextMenu(null);
  };

  const handleRenameSubmit = async (labelId: string) => {
    if (!editName.trim()) {
      setEditingLabel(null);
      return;
    }

    try {
      const updated = await invoke<AnchoredLabel>("rename_label", {
        id: labelId,
        newName: editName.trim(),
      });
      setLabels(labels.map((l) => (l.id === labelId ? updated : l)));
      if (selectedLabel?.id === labelId) {
        setSelectedLabel(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditingLabel(null);
    }
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const labelId = contextMenu.label.id;
    setContextMenu(null);

    try {
      await invoke("delete_label", { id: labelId });
      setLabels(labels.filter((l) => l.id !== labelId));
      if (selectedLabel?.id === labelId) {
        setSelectedLabel(null);
        setRelatedNotes([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Discovery handlers
  const handleDiscoveryScan = async () => {
    setIsScanning(true);
    try {
      const candidates = await invoke<DiscoveryCandidate[]>("trigger_discovery_scan");
      // Filter to only show surfaced candidates (2+ scans)
      setSuggestions(candidates.filter(c => c.scan_count >= 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsScanning(false);
    }
  };

  const handleAcceptSuggestion = (label: AnchoredLabel) => {
    setLabels([...labels, label]);
    setSuggestions(suggestions.filter(s => s.suggested_name !== label.name));
  };

  const handleDismissSuggestion = (candidateId: string) => {
    setSuggestions(suggestions.filter(s => s.id !== candidateId));
  };

  // Render loading/error/progress states
  if (isLoading) {
    return (
      <div className="semantic-cloud-container">
        <div className="semantic-cloud-loading">
          <div className="loading-spinner" />
          <span>Loading semantic cloud...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="semantic-cloud-container">
        <div className="semantic-cloud-error">
          <span>Error: {error}</span>
          <button onClick={() => { setError(null); window.location.reload(); }}>Reload</button>
        </div>
      </div>
    );
  }

  // Show model prompt overlay when no model is ready
  const ModelPromptOverlay = () => (
    <div className="model-prompt-overlay">
      <div className="model-prompt-dialog">
        <h3>AI Model Required</h3>
        <p>
          The Semantic Cloud uses an AI model to generate meaningful topic names.
          Please download a model in Settings to enable this feature.
        </p>
        <div className="model-prompt-actions">
          <button
            onClick={() => setShowModelPrompt(false)}
            className="btn-secondary"
          >
            Continue Anyway
          </button>
          <button
            onClick={() => {
              // Emit event to open settings modal on AI Models tab
              window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "models" } }));
              setShowModelPrompt(false);
            }}
            className="btn-primary"
          >
            Open Settings
          </button>
        </div>
      </div>
    </div>
  );

  if (isIndexing && progress) {
    return (
      <div className="semantic-cloud-container">
        <div className="semantic-cloud-empty">
          <h3>Building Index</h3>
          <div style={{ width: 400, marginBottom: 16, minHeight: 80, textAlign: "center" }}>
            <div style={{
              width: "100%",
              height: 8,
              background: "var(--bg-hover)",
              borderRadius: 4,
              overflow: "hidden",
            }}>
              <div style={{
                width: `${(progress.current / progress.total) * 100}%`,
                height: "100%",
                background: "var(--accent-color, #4a9eff)",
                transition: "width 0.2s ease",
              }} />
            </div>
            <p style={{ fontSize: 12, color: "#888", marginTop: 8, height: 18, textAlign: "center", maxWidth: "none", width: "100%" }}>
              {progress.phase === "initializing" && "Initializing..."}
              {progress.phase === "embedding" && `Processing ${progress.current} of ${progress.total}`}
              {progress.phase === "saving" && "Saving index..."}
              {progress.phase === "complete" && "Complete!"}
            </p>
            <p style={{
              fontSize: 11,
              color: "#666",
              marginTop: 4,
              height: 16,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: "center",
              maxWidth: "none",
              width: "100%",
            }}>
              {progress.current_file}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Empty state - no notes indexed
  if (!status || status.indexed_count === 0) {
    return (
      <div className="semantic-cloud-container">
        <div className="semantic-cloud-empty">
          <h3>No notes indexed</h3>
          <p>Build the embedding index to see your semantic cloud.</p>
          <p style={{ fontSize: 12, color: "#888" }}>
            Found {files.length} indexable files in workspace.
          </p>
          <button
            onClick={handleRebuildIndex}
            disabled={isIndexing}
            className="btn-primary"
          >
            {isIndexing ? "Indexing..." : "Build Index"}
          </button>
        </div>
      </div>
    );
  }

  // Main cloud view with labels
  return (
    <div className="semantic-cloud-container">
      {showModelPrompt && <ModelPromptOverlay />}
      <div className="semantic-cloud-main">
        {/* Left panel - Labels */}
        <div className="semantic-cloud-sidebar">
          <div className="label-header">
            <h3>Labels</h3>
            <span className="label-count">{labels.length}</span>
          </div>

          {/* Create label form */}
          <form onSubmit={handleCreateLabel} className="create-label-form">
            <input
              ref={labelInputRef}
              type="text"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              placeholder="New label..."
              disabled={isCreatingLabel}
            />
            <button type="submit" disabled={!newLabelName.trim() || isCreatingLabel}>
              +
            </button>
          </form>

          {/* Label list */}
          <div className="label-list">
            {labels.map((label) => (
              <div
                key={label.id}
                className={`label-item ${selectedLabel?.id === label.id ? "selected" : ""}`}
                onClick={() => handleSelectLabel(label)}
                onContextMenu={(e) => handleContextMenu(e, label)}
              >
                {editingLabel === label.id ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRenameSubmit(label.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(label.id);
                      if (e.key === "Escape") setEditingLabel(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="label-name">{label.name}</span>
                )}
              </div>
            ))}
            {labels.length === 0 && (
              <p className="no-labels">No labels yet. Create one above.</p>
            )}
          </div>

          {/* Index status */}
          <div className="index-status">
            <span>{status.indexed_count} notes indexed</span>
            <button
              onClick={handleRebuildIndex}
              disabled={isIndexing}
              className="btn-small"
            >
              Rebuild
            </button>
          </div>
        </div>

        {/* Right panel - Related notes and suggestions */}
        <div className="semantic-cloud-content">
          {selectedLabel ? (
            <RelatedNotesPanel
              notes={relatedNotes}
              onSelectNote={onSelectNote}
              title={`Notes related to "${selectedLabel.name}"`}
              workspacePath={workspacePath}
            />
          ) : (
            <SuggestionQueue
              suggestions={suggestions}
              onAccept={handleAcceptSuggestion}
              onDismiss={handleDismissSuggestion}
              onScan={handleDiscoveryScan}
              isScanning={isScanning}
            />
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button onClick={handleRename}>Rename</button>
          <button onClick={handleDelete} className="danger">Delete</button>
        </div>
      )}
    </div>
  );
};

export default SemanticCloud;
