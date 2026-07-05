use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::embedding::{EmbeddingIndex, SimilarNote};

/// An anchored label - a user-defined semantic anchor point
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnchoredLabel {
    pub id: String,
    pub name: String,
    pub embedding: Vec<f32>,
    pub created_at: u64,
}

/// Store for managing anchored labels
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LabelStore {
    labels: HashMap<String, AnchoredLabel>,
    version: u32,
}

impl LabelStore {
    /// Create a new empty label store
    pub fn new() -> Self {
        Self {
            labels: HashMap::new(),
            version: 1,
        }
    }

    /// Create a new label with an embedding generated from its name
    pub fn create_label(
        &mut self,
        name: &str,
        embedding_index: &mut EmbeddingIndex,
    ) -> Result<AnchoredLabel, String> {
        // Generate embedding from the label name
        let embedding = embedding_index.embed_query(name)?;

        let id = Uuid::new_v4().to_string();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let label = AnchoredLabel {
            id: id.clone(),
            name: name.to_string(),
            embedding,
            created_at,
        };

        self.labels.insert(id, label.clone());
        Ok(label)
    }

    /// Rename an existing label (re-embeds with new name)
    pub fn rename_label(
        &mut self,
        id: &str,
        new_name: &str,
        embedding_index: &mut EmbeddingIndex,
    ) -> Result<AnchoredLabel, String> {
        let label = self.labels.get_mut(id)
            .ok_or_else(|| format!("Label not found: {}", id))?;

        // Re-embed with new name
        let new_embedding = embedding_index.embed_query(new_name)?;

        label.name = new_name.to_string();
        label.embedding = new_embedding;

        Ok(label.clone())
    }

    /// Delete a label
    pub fn delete_label(&mut self, id: &str) -> Result<(), String> {
        self.labels.remove(id)
            .ok_or_else(|| format!("Label not found: {}", id))?;
        Ok(())
    }

    /// Get all labels
    pub fn get_labels(&self) -> Vec<AnchoredLabel> {
        self.labels.values().cloned().collect()
    }

    /// Get a specific label by ID
    pub fn get_label(&self, id: &str) -> Option<&AnchoredLabel> {
        self.labels.get(id)
    }

    /// Get notes related to a label (kNN on label embedding)
    pub fn get_related_notes(
        &self,
        label_id: &str,
        embedding_index: &EmbeddingIndex,
        k: usize,
    ) -> Result<Vec<SimilarNote>, String> {
        let label = self.labels.get(label_id)
            .ok_or_else(|| format!("Label not found: {}", label_id))?;

        Ok(embedding_index.knn(&label.embedding, k))
    }

    /// Save the label store to disk
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let encoded = bincode::serialize(&self)
            .map_err(|e| format!("Failed to serialize labels: {}", e))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        fs::write(path, encoded)
            .map_err(|e| format!("Failed to write labels: {}", e))
    }

    /// Load the label store from disk
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }

        let data = fs::read(path)
            .map_err(|e| format!("Failed to read labels: {}", e))?;

        bincode::deserialize(&data)
            .map_err(|e| format!("Failed to deserialize labels: {}", e))
    }

    /// Get the number of labels
    pub fn len(&self) -> usize {
        self.labels.len()
    }

    /// Check if store is empty
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_store() {
        let store = LabelStore::new();
        assert!(store.is_empty());
        assert_eq!(store.len(), 0);
    }
}
