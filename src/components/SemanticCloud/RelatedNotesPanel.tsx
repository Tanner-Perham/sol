import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SimilarNote } from "../../types";

interface RelatedNotesPanelProps {
  notes: SimilarNote[];
  onSelectNote: (path: string) => void;
  title?: string;
  workspacePath: string;
}

export const RelatedNotesPanel: React.FC<RelatedNotesPanelProps> = ({
  notes,
  onSelectNote,
  title = "Related Notes",
  workspacePath,
}) => {
  const [previewNote, setPreviewNote] = useState<SimilarNote | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Load preview content when a note is selected for preview
  useEffect(() => {
    if (!previewNote) {
      setPreviewContent("");
      return;
    }

    const loadPreview = async () => {
      setIsLoadingPreview(true);
      try {
        const fullPath = `${workspacePath}/${previewNote.path}`;
        const content = await invoke<string>("read_markdown_file", { path: fullPath });
        // Truncate for preview (first ~1000 chars)
        setPreviewContent(content.slice(0, 1500));
      } catch (err) {
        setPreviewContent("Failed to load preview");
      } finally {
        setIsLoadingPreview(false);
      }
    };

    loadPreview();
  }, [previewNote, workspacePath]);

  const handleNoteClick = (note: SimilarNote) => {
    // Toggle preview - if same note clicked, deselect
    if (previewNote?.path === note.path) {
      setPreviewNote(null);
    } else {
      setPreviewNote(note);
    }
  };

  const handleOpenNote = () => {
    if (previewNote) {
      onSelectNote(previewNote.path);
    }
  };

  if (notes.length === 0) {
    return (
      <div className="related-notes-panel related-notes-empty">
        <p>No related notes found</p>
      </div>
    );
  }

  return (
    <div className="related-notes-panel">
      <h4>{title}</h4>

      <div className="related-notes-layout">
        {/* Notes list */}
        <div className="related-notes-list">
          {notes.map((note) => (
            <div
              key={note.path}
              className={`related-note-item ${previewNote?.path === note.path ? "selected" : ""}`}
              onClick={() => handleNoteClick(note)}
              onDoubleClick={() => onSelectNote(note.path)}
            >
              <span className="related-note-title">{note.path.replace(/\.md$/, '').split('/').pop()}</span>
              <span className="related-note-score">
                {Math.round(note.score * 100)}%
              </span>
            </div>
          ))}
        </div>

        {/* Preview panel */}
        {previewNote && (
          <div className="note-preview-panel">
            <div className="preview-header">
              <span className="preview-title">{previewNote.title}</span>
              <button className="btn-open" onClick={handleOpenNote}>
                Open
              </button>
            </div>
            <div className="preview-content">
              {isLoadingPreview ? (
                <span className="preview-loading">Loading...</span>
              ) : (
                <pre>{previewContent}{previewContent.length >= 1500 && "\n\n..."}</pre>
              )}
            </div>
          </div>
        )}
      </div>

      {!previewNote && (
        <p className="preview-hint">Click a note to preview, double-click to open</p>
      )}
    </div>
  );
};

export default RelatedNotesPanel;
