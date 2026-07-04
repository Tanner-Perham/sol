import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  onSelectNote,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);

  useEffect(() => {
    const init = async () => {
      try {
        const embeddingStatus = await invoke<EmbeddingStatus>("get_embedding_status");
        setStatus(embeddingStatus);

        const indexableFiles = await invoke<string[]>("get_indexable_files");
        setFiles(indexableFiles);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    };

    init();

    // Listen for embedding progress events
    const unlisten = listen<EmbeddingProgress>("embedding-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.phase === "complete") {
        // Clear progress after a short delay
        setTimeout(() => setProgress(null), 1000);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
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

  return (
    <div className="semantic-cloud-container">
      {/* Loading state */}
      {isLoading && (
        <div className="semantic-cloud-loading">
          <div className="loading-spinner" />
          <span>Loading semantic cloud...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="semantic-cloud-error">
          <span>Error: {error}</span>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      {/* Indexing progress */}
      {isIndexing && progress && (
        <div className="semantic-cloud-empty">
          <h3>Building Index</h3>
          <div style={{ width: 400, marginBottom: 16, minHeight: 80, textAlign: 'center' }}>
            <div style={{
              width: '100%',
              height: 8,
              background: 'var(--bg-hover)',
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${(progress.current / progress.total) * 100}%`,
                height: '100%',
                background: 'var(--accent-color, #4a9eff)',
                transition: 'width 0.2s ease',
              }} />
            </div>
            <p style={{ fontSize: 12, color: '#888', marginTop: 8, height: 18, textAlign: 'center', maxWidth: 'none', width: '100%' }}>
              {progress.phase === 'initializing' && 'Initializing...'}
              {progress.phase === 'embedding' && `Processing ${progress.current} of ${progress.total}`}
              {progress.phase === 'saving' && 'Saving index...'}
              {progress.phase === 'complete' && 'Complete!'}
            </p>
            <p style={{
              fontSize: 11,
              color: '#666',
              marginTop: 4,
              height: 16,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'center',
              maxWidth: 'none',
              width: '100%',
            }}>
              {progress.current_file}
            </p>
          </div>
        </div>
      )}

      {/* Empty state - no notes indexed */}
      {!isLoading && !error && !isIndexing && (!status || status.indexed_count === 0) && (
        <div className="semantic-cloud-empty">
          <h3>No notes indexed</h3>
          <p>Build the embedding index to see your semantic cloud.</p>
          <p style={{ fontSize: 12, color: '#888' }}>
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
      )}

      {/* Has indexed notes - show simple list for now */}
      {!isLoading && !error && !isIndexing && status && status.indexed_count > 0 && (
        <div className="semantic-cloud-empty">
          <h3>Semantic Cloud</h3>
          <p>{status.indexed_count} notes indexed</p>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            (Full visualization coming soon)
          </p>
          <div style={{ maxHeight: 300, overflow: 'auto', width: '100%', maxWidth: 400 }}>
            {files.slice(0, 20).map((file) => (
              <div
                key={file}
                onClick={() => onSelectNote(file)}
                style={{
                  padding: '8px 12px',
                  margin: '4px 0',
                  background: 'var(--bg-hover)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {file.replace(/\.md$/, '')}
              </div>
            ))}
            {files.length > 20 && (
              <p style={{ fontSize: 12, color: '#888' }}>
                ...and {files.length - 20} more
              </p>
            )}
          </div>
          <button
            onClick={handleRebuildIndex}
            disabled={isIndexing}
            className="btn-primary"
            style={{ marginTop: 16 }}
          >
            {isIndexing ? "Rebuilding..." : "Rebuild Index"}
          </button>
        </div>
      )}
    </div>
  );
};

export default SemanticCloud;
