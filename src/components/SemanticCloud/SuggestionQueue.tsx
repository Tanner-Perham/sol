import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiscoveryCandidate, AnchoredLabel } from "../../types";

interface SuggestionQueueProps {
  suggestions: DiscoveryCandidate[];
  onAccept: (label: AnchoredLabel) => void;
  onDismiss: (candidateId: string) => void;
  onScan: () => void;
  isScanning: boolean;
}

export const SuggestionQueue: React.FC<SuggestionQueueProps> = ({
  suggestions,
  onAccept,
  onDismiss,
  onScan,
  isScanning,
}) => {
  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleAccept = async (candidate: DiscoveryCandidate) => {
    setProcessingId(candidate.id);
    try {
      const label = await invoke<AnchoredLabel>("accept_suggestion", {
        candidateId: candidate.id,
      });
      onAccept(label);
    } catch (err) {
      console.error("Failed to accept suggestion:", err);
    } finally {
      setProcessingId(null);
    }
  };

  const handleDismiss = async (candidateId: string) => {
    setProcessingId(candidateId);
    try {
      await invoke("dismiss_suggestion", { candidateId });
      onDismiss(candidateId);
    } catch (err) {
      console.error("Failed to dismiss suggestion:", err);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div className="suggestion-queue">
      <div className="suggestion-header">
        <h4>Discovered Topics</h4>
        <button
          onClick={onScan}
          disabled={isScanning}
          className="btn-scan"
        >
          {isScanning ? "Scanning..." : "Scan"}
        </button>
      </div>

      {suggestions.length === 0 ? (
        <div className="suggestion-empty">
          <p>No topic suggestions yet.</p>
          <p className="hint">
            Click "Scan" to discover emerging topics in your notes.
          </p>
        </div>
      ) : (
        <div className="suggestion-list">
          {suggestions.map((candidate) => (
            <div key={candidate.id} className="suggestion-item">
              <div className="suggestion-info">
                <span className="suggestion-name">{candidate.suggested_name}</span>
                <span className="suggestion-meta">
                  {candidate.note_paths.length} notes · {candidate.scan_count} scans
                </span>
              </div>
              <div className="suggestion-actions">
                <button
                  onClick={() => handleAccept(candidate)}
                  disabled={processingId === candidate.id}
                  className="btn-accept"
                  title="Create label from this topic"
                >
                  ✓
                </button>
                <button
                  onClick={() => handleDismiss(candidate.id)}
                  disabled={processingId === candidate.id}
                  className="btn-dismiss"
                  title="Dismiss this suggestion"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <p className="suggestion-hint">
          Topics that persist across multiple scans are more likely to be meaningful.
        </p>
      )}
    </div>
  );
};

export default SuggestionQueue;
