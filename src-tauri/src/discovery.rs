use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::embedding::EmbeddingIndex;
use crate::labels::LabelStore;
use crate::tfidf::CTfIdf;

/// A discovered topic candidate
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryCandidate {
    pub id: String,
    pub suggested_name: String,
    pub centroid: Vec<f32>,
    pub note_paths: Vec<String>,
    pub scan_count: usize,
    pub first_seen: u64,
    pub last_seen: u64,
    pub score: f32,  // Cohesion score
}

/// Discovery engine state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DiscoveryState {
    pub candidates: HashMap<String, DiscoveryCandidate>,
    pub last_scan: u64,
    pub version: u32,
}

impl DiscoveryState {
    pub fn new() -> Self {
        Self {
            candidates: HashMap::new(),
            last_scan: 0,
            version: 1,
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let encoded = bincode::serialize(self)
            .map_err(|e| format!("Failed to serialize discovery state: {}", e))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        fs::write(path, encoded)
            .map_err(|e| format!("Failed to write discovery state: {}", e))
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }

        let data = fs::read(path)
            .map_err(|e| format!("Failed to read discovery state: {}", e))?;

        bincode::deserialize(&data)
            .map_err(|e| format!("Failed to deserialize discovery state: {}", e))
    }
}

/// Discovery engine for finding emerging topics
pub struct DiscoveryEngine;

impl DiscoveryEngine {
    /// Find notes that aren't well covered by existing labels
    /// Returns paths of notes whose max similarity to any label is below threshold
    pub fn find_residual_notes(
        index: &EmbeddingIndex,
        labels: &LabelStore,
        threshold: f32,
    ) -> Vec<String> {
        let all_labels = labels.get_labels();
        if all_labels.is_empty() {
            // No labels, all notes are residual
            return index.indexed_paths();
        }

        let mut residual = Vec::new();

        for path in index.indexed_paths() {
            if let Some(note_embedding) = index.get_embedding(&path) {
                let max_sim = all_labels.iter()
                    .map(|label| EmbeddingIndex::cosine_similarity(note_embedding, &label.embedding))
                    .fold(f32::NEG_INFINITY, f32::max);

                if max_sim < threshold {
                    residual.push(path);
                }
            }
        }

        residual
    }

    /// Simple k-means clustering on embeddings
    /// Returns cluster assignments for each note
    pub fn cluster_notes(
        index: &EmbeddingIndex,
        note_paths: &[String],
        k: usize,
        max_iterations: usize,
    ) -> Vec<usize> {
        if note_paths.is_empty() || k == 0 {
            return Vec::new();
        }

        let k = k.min(note_paths.len());

        // Get embeddings
        let embeddings: Vec<&Vec<f32>> = note_paths.iter()
            .filter_map(|p| index.get_embedding(p))
            .collect();

        if embeddings.is_empty() {
            return vec![0; note_paths.len()];
        }

        let dim = embeddings[0].len();

        // Initialize centroids with first k embeddings (could use k-means++ for better init)
        let mut centroids: Vec<Vec<f32>> = embeddings.iter()
            .take(k)
            .map(|e| (*e).clone())
            .collect();

        let mut assignments = vec![0usize; embeddings.len()];

        for _ in 0..max_iterations {
            let old_assignments = assignments.clone();

            // Assign each point to nearest centroid
            for (i, emb) in embeddings.iter().enumerate() {
                let mut best_cluster = 0;
                let mut best_sim = f32::NEG_INFINITY;

                for (c, centroid) in centroids.iter().enumerate() {
                    let sim = EmbeddingIndex::cosine_similarity(emb, centroid);
                    if sim > best_sim {
                        best_sim = sim;
                        best_cluster = c;
                    }
                }

                assignments[i] = best_cluster;
            }

            // Check for convergence
            if assignments == old_assignments {
                break;
            }

            // Update centroids
            for c in 0..k {
                let cluster_points: Vec<&Vec<f32>> = embeddings.iter()
                    .zip(assignments.iter())
                    .filter(|(_, &a)| a == c)
                    .map(|(e, _)| *e)
                    .collect();

                if !cluster_points.is_empty() {
                    let mut new_centroid = vec![0.0f32; dim];
                    for point in &cluster_points {
                        for (j, &val) in point.iter().enumerate() {
                            new_centroid[j] += val;
                        }
                    }
                    let n = cluster_points.len() as f32;
                    for val in &mut new_centroid {
                        *val /= n;
                    }
                    // Normalize
                    let norm: f32 = new_centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
                    if norm > 0.0 {
                        for val in &mut new_centroid {
                            *val /= norm;
                        }
                    }
                    centroids[c] = new_centroid;
                }
            }
        }

        assignments
    }

    /// Compute cohesion score for a cluster (average pairwise similarity)
    pub fn cluster_cohesion(
        index: &EmbeddingIndex,
        note_paths: &[String],
    ) -> f32 {
        if note_paths.len() < 2 {
            return 1.0;
        }

        let embeddings: Vec<&Vec<f32>> = note_paths.iter()
            .filter_map(|p| index.get_embedding(p))
            .collect();

        if embeddings.len() < 2 {
            return 1.0;
        }

        let mut total_sim = 0.0f32;
        let mut count = 0;

        for i in 0..embeddings.len() {
            for j in (i + 1)..embeddings.len() {
                total_sim += EmbeddingIndex::cosine_similarity(embeddings[i], embeddings[j]);
                count += 1;
            }
        }

        if count > 0 {
            total_sim / count as f32
        } else {
            1.0
        }
    }

    /// Compute centroid of a cluster
    pub fn compute_centroid(
        index: &EmbeddingIndex,
        note_paths: &[String],
    ) -> Option<Vec<f32>> {
        let embeddings: Vec<&Vec<f32>> = note_paths.iter()
            .filter_map(|p| index.get_embedding(p))
            .collect();

        if embeddings.is_empty() {
            return None;
        }

        let dim = embeddings[0].len();
        let mut centroid = vec![0.0f32; dim];

        for emb in &embeddings {
            for (j, &val) in emb.iter().enumerate() {
                centroid[j] += val;
            }
        }

        let n = embeddings.len() as f32;
        for val in &mut centroid {
            *val /= n;
        }

        // Normalize
        let norm: f32 = centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in &mut centroid {
                *val /= norm;
            }
        }

        Some(centroid)
    }

    /// Run a discovery scan
    /// Returns updated discovery state with new/updated candidates
    pub fn run_scan(
        state: &mut DiscoveryState,
        index: &EmbeddingIndex,
        labels: &LabelStore,
        note_contents: &HashMap<String, String>,
        num_clusters: usize,
        residual_threshold: f32,
    ) -> Vec<DiscoveryCandidate> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        state.last_scan = now;

        // Find residual notes
        let residual = Self::find_residual_notes(index, labels, residual_threshold);

        if residual.len() < 3 {
            // Not enough notes to cluster
            return state.candidates.values().cloned().collect();
        }

        // Cluster residual notes
        let k = num_clusters.min(residual.len() / 2).max(1);
        let assignments = Self::cluster_notes(index, &residual, k, 20);

        // Group notes by cluster
        let mut clusters: HashMap<usize, Vec<String>> = HashMap::new();
        for (path, &cluster_id) in residual.iter().zip(assignments.iter()) {
            clusters.entry(cluster_id).or_default().push(path.clone());
        }

        // Get contents for c-TF-IDF
        let contents: Vec<String> = residual.iter()
            .filter_map(|p| note_contents.get(p).cloned())
            .collect();

        let ctfidf = CTfIdf::new(&contents, &assignments);

        // Process each cluster
        for (cluster_id, paths) in clusters {
            if paths.len() < 2 {
                continue;  // Skip tiny clusters
            }

            let centroid = match Self::compute_centroid(index, &paths) {
                Some(c) => c,
                None => continue,
            };

            let cohesion = Self::cluster_cohesion(index, &paths);
            let suggested_name = ctfidf.generate_label(cluster_id);

            // Check if this matches an existing candidate (by centroid similarity)
            let mut matched_id: Option<String> = None;
            for (id, candidate) in state.candidates.iter() {
                let sim = EmbeddingIndex::cosine_similarity(&centroid, &candidate.centroid);
                if sim > 0.8 {
                    matched_id = Some(id.clone());
                    break;
                }
            }

            if let Some(id) = matched_id {
                // Update existing candidate
                if let Some(candidate) = state.candidates.get_mut(&id) {
                    candidate.scan_count += 1;
                    candidate.last_seen = now;
                    candidate.note_paths = paths;
                    candidate.score = cohesion;
                    // Optionally update name if it's better
                    if suggested_name.len() > candidate.suggested_name.len() {
                        candidate.suggested_name = suggested_name;
                    }
                }
            } else {
                // New candidate
                let id = Uuid::new_v4().to_string();
                state.candidates.insert(id.clone(), DiscoveryCandidate {
                    id,
                    suggested_name,
                    centroid,
                    note_paths: paths,
                    scan_count: 1,
                    first_seen: now,
                    last_seen: now,
                    score: cohesion,
                });
            }
        }

        // Remove stale candidates (not seen in last 3 scans)
        let stale_threshold = 3;
        state.candidates.retain(|_, c| {
            // Keep if seen recently or has survived enough scans
            c.scan_count >= stale_threshold || c.last_seen == now
        });

        state.candidates.values().cloned().collect()
    }

    /// Get candidates that are ready to surface (survived enough scans)
    pub fn get_surfaced_candidates(state: &DiscoveryState, min_scans: usize) -> Vec<DiscoveryCandidate> {
        state.candidates.values()
            .filter(|c| c.scan_count >= min_scans)
            .cloned()
            .collect()
    }

    /// Accept a candidate - remove it from discovery and return its data for label creation
    pub fn accept_candidate(state: &mut DiscoveryState, candidate_id: &str) -> Option<DiscoveryCandidate> {
        state.candidates.remove(candidate_id)
    }

    /// Dismiss a candidate
    pub fn dismiss_candidate(state: &mut DiscoveryState, candidate_id: &str) -> bool {
        state.candidates.remove(candidate_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discovery_state() {
        let state = DiscoveryState::new();
        assert!(state.candidates.is_empty());
        assert_eq!(state.last_scan, 0);
    }
}
