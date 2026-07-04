use fastembed::{TextEmbedding, InitOptions, EmbeddingModel};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Metadata about an indexed note
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub last_modified: u64,  // Unix timestamp
    pub word_count: usize,
    pub title: String,
}

/// Status of the embedding index
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingStatus {
    pub indexed_count: usize,
    pub is_ready: bool,
    pub model_name: String,
}

/// A note with its similarity score
#[derive(Debug, Clone, Serialize)]
pub struct SimilarNote {
    pub path: String,
    pub score: f32,
    pub title: String,
}

/// Persistent embedding index data (serialized to disk)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IndexData {
    embeddings: HashMap<String, Vec<f32>>,
    metadata: HashMap<String, NoteMetadata>,
    version: u32,
}

/// The embedding index for semantic search.
/// Stores embeddings for notes and provides kNN search.
pub struct EmbeddingIndex {
    model: Option<TextEmbedding>,
    data: IndexData,
    model_loaded: bool,
}

impl Default for EmbeddingIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl EmbeddingIndex {
    /// Create a new empty embedding index.
    /// The model is lazily loaded on first embed operation.
    pub fn new() -> Self {
        Self {
            model: None,
            data: IndexData::default(),
            model_loaded: false,
        }
    }

    /// Ensure the embedding model is loaded.
    fn ensure_model(&mut self) -> Result<(), String> {
        if self.model.is_some() {
            return Ok(());
        }

        // Initialize with the default all-MiniLM-L6-v2 model (384 dimensions)
        let mut options = InitOptions::default();
        options.model_name = EmbeddingModel::AllMiniLML6V2;
        options.show_download_progress = true;

        let model = TextEmbedding::try_new(options)
            .map_err(|e| format!("Failed to load embedding model: {}", e))?;

        self.model = Some(model);
        self.model_loaded = true;
        Ok(())
    }

    /// Get the status of the embedding index
    pub fn status(&self) -> EmbeddingStatus {
        EmbeddingStatus {
            indexed_count: self.data.embeddings.len(),
            is_ready: self.model_loaded,
            model_name: "all-MiniLM-L6-v2".to_string(),
        }
    }

    /// Embed a single note's content and store it in the index.
    pub fn embed_note(&mut self, path: &str, content: &str, last_modified: u64) -> Result<(), String> {
        self.ensure_model()?;

        let model = self.model.as_ref().ok_or("Model not loaded")?;

        // Get the title (first line or filename)
        let title = content
            .lines()
            .next()
            .map(|l| l.trim_start_matches('#').trim())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                Path::new(path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled")
            })
            .to_string();

        // Count words
        let word_count = content.split_whitespace().count();

        // Generate embedding
        let embeddings = model.embed(vec![content], None)
            .map_err(|e| format!("Embedding failed: {}", e))?;

        if let Some(embedding) = embeddings.into_iter().next() {
            self.data.embeddings.insert(path.to_string(), embedding);
            self.data.metadata.insert(path.to_string(), NoteMetadata {
                last_modified,
                word_count,
                title,
            });
        }

        Ok(())
    }

    /// Remove a note from the index.
    pub fn remove_note(&mut self, path: &str) {
        self.data.embeddings.remove(path);
        self.data.metadata.remove(path);
    }

    /// Check if a note needs re-embedding based on modification time.
    pub fn needs_update(&self, path: &str, last_modified: u64) -> bool {
        if let Some(meta) = self.data.metadata.get(path) {
            meta.last_modified < last_modified
        } else {
            true // Not in index, needs embedding
        }
    }

    /// Get the embedding for a note, if it exists.
    pub fn get_embedding(&self, path: &str) -> Option<&Vec<f32>> {
        self.data.embeddings.get(path)
    }

    /// Embed a query string and return its vector.
    pub fn embed_query(&mut self, query: &str) -> Result<Vec<f32>, String> {
        self.ensure_model()?;

        let model = self.model.as_ref().ok_or("Model not loaded")?;

        let embeddings = model.embed(vec![query], None)
            .map_err(|e| format!("Query embedding failed: {}", e))?;

        embeddings.into_iter().next()
            .ok_or_else(|| "No embedding returned".to_string())
    }

    /// Compute cosine similarity between two vectors.
    pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        if a.len() != b.len() {
            return 0.0;
        }

        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }

        dot / (norm_a * norm_b)
    }

    /// Find the k nearest neighbors to a query vector.
    /// Returns paths sorted by similarity (highest first).
    pub fn knn(&self, query: &[f32], k: usize) -> Vec<SimilarNote> {
        // Compute similarities in parallel using rayon
        let mut similarities: Vec<(String, f32)> = self.data.embeddings
            .par_iter()
            .map(|(path, embedding)| {
                let sim = Self::cosine_similarity(query, embedding);
                (path.clone(), sim)
            })
            .collect();

        // Sort by similarity descending
        similarities.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top k and convert to SimilarNote
        similarities.into_iter()
            .take(k)
            .map(|(path, score)| {
                let title = self.data.metadata
                    .get(&path)
                    .map(|m| m.title.clone())
                    .unwrap_or_else(|| path.clone());
                SimilarNote { path, score, title }
            })
            .collect()
    }

    /// Search for notes similar to a query string.
    pub fn search(&mut self, query: &str, k: usize) -> Result<Vec<SimilarNote>, String> {
        let query_embedding = self.embed_query(query)?;
        Ok(self.knn(&query_embedding, k))
    }

    /// Get all indexed paths.
    pub fn indexed_paths(&self) -> Vec<String> {
        self.data.embeddings.keys().cloned().collect()
    }

    /// Save the index to disk.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let encoded = bincode::serialize(&self.data)
            .map_err(|e| format!("Failed to serialize index: {}", e))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        fs::write(path, encoded)
            .map_err(|e| format!("Failed to write index: {}", e))
    }

    /// Load the index from disk.
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }

        let data = fs::read(path)
            .map_err(|e| format!("Failed to read index: {}", e))?;

        let index_data: IndexData = bincode::deserialize(&data)
            .map_err(|e| format!("Failed to deserialize index: {}", e))?;

        Ok(Self {
            model: None,
            data: index_data,
            model_loaded: false,
        })
    }
}

/// Helper to get the modification time of a file as a Unix timestamp.
pub fn get_file_mtime(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    let duration = modified.duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((EmbeddingIndex::cosine_similarity(&a, &b) - 1.0).abs() < 0.001);

        let c = vec![0.0, 1.0, 0.0];
        assert!((EmbeddingIndex::cosine_similarity(&a, &c) - 0.0).abs() < 0.001);

        let d = vec![-1.0, 0.0, 0.0];
        assert!((EmbeddingIndex::cosine_similarity(&a, &d) - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn test_empty_index() {
        let index = EmbeddingIndex::new();
        assert_eq!(index.status().indexed_count, 0);
        assert!(!index.status().is_ready);
    }
}
