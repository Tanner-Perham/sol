pub mod download;
pub mod inference;
pub mod registry;
pub mod context;
pub mod stream;
pub mod providers;

use serde::{Deserialize, Serialize};
use providers::{CompletionBackend, ReworkBackend};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
    /// Optional override repo_id for this specific file (for hybrid downloads)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
}

/// Information about an available model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
    pub repo_id: String,
    pub files: Vec<ModelFile>,
}

/// Status of a model
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status")]
pub enum ModelStatus {
    #[serde(rename = "not_downloaded")]
    NotDownloaded,
    #[serde(rename = "downloading")]
    Downloading { progress: f32 },
    #[serde(rename = "paused")]
    Paused { progress: f32 },
    #[serde(rename = "downloaded")]
    Downloaded,
    #[serde(rename = "active")]
    Active,
}

/// Model with its current status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelWithStatus {
    #[serde(flatten)]
    pub info: ModelInfo,
    #[serde(flatten)]
    pub status: ModelStatus,
    pub is_completion_active: bool,
    pub is_rework_active: bool,
}

fn default_ollama_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_llamacpp_url() -> String {
    "http://localhost:8080".to_string()
}

fn default_dry_multiplier() -> f32 { 0.8 }
fn default_dry_base() -> f32 { 1.75 }
fn default_dry_allowed_length() -> u32 { 2 }
fn default_dry_penalty_last_n() -> i32 { -1 }

/// LLM configuration stored in settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default)]
    pub active_model_id: Option<String>,
    #[serde(default)]
    pub completion_model_id: Option<String>,
    #[serde(default)]
    pub rework_model_id: Option<String>,
    #[serde(default)]
    pub downloaded_models: Vec<String>,

    #[serde(default)]
    pub completion_backend: CompletionBackend,
    #[serde(default)]
    pub rework_backend: ReworkBackend,

    #[serde(default = "default_ollama_url")]
    pub ollama_url: String,
    #[serde(default)]
    pub ollama_rework_model: Option<String>,

    #[serde(default = "default_llamacpp_url")]
    pub llamacpp_url: String,

    #[serde(default)]
    pub allow_remote_endpoints: bool,

    #[serde(default = "default_dry_multiplier")]
    pub llamacpp_dry_multiplier: f32,

    #[serde(default = "default_dry_base")]
    pub llamacpp_dry_base: f32,

    #[serde(default = "default_dry_allowed_length")]
    pub llamacpp_dry_allowed_length: u32,

    #[serde(default = "default_dry_penalty_last_n")]
    pub llamacpp_dry_penalty_last_n: i32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            active_model_id: None,
            completion_model_id: None,
            rework_model_id: None,
            downloaded_models: Vec::new(),
            completion_backend: CompletionBackend::default(),
            rework_backend: ReworkBackend::default(),
            ollama_url: default_ollama_url(),
            ollama_rework_model: None,
            llamacpp_url: default_llamacpp_url(),
            allow_remote_endpoints: false,
            llamacpp_dry_multiplier: 0.8,
            llamacpp_dry_base: 1.75,
            llamacpp_dry_allowed_length: 2,
            llamacpp_dry_penalty_last_n: -1,
        }
    }
}

impl LlmConfig {
    pub fn load(workspace: &PathBuf) -> Self {
        let config_path = workspace.join(".sol").join("llm_config.json");
        if config_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str(&data) {
                    return config;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, workspace: &PathBuf) -> Result<(), String> {
        let sol_dir = workspace.join(".sol");
        std::fs::create_dir_all(&sol_dir).map_err(|e| e.to_string())?;
        let config_path = sol_dir.join("llm_config.json");
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::write_atomically(&config_path, data.as_bytes()).map_err(|e| e.to_string())
    }
}

/// Get the models directory
pub fn models_dir(workspace: &PathBuf) -> PathBuf {
    workspace.join(".sol").join("models")
}

/// Check if a model is downloaded
pub fn is_model_downloaded(workspace: &PathBuf, model_id: &str) -> bool {
    let model_dir = models_dir(workspace).join(model_id);
    if !model_dir.exists() {
        return false;
    }

    // Check if all required files exist and match sizes
    let info = registry::get_model_info(model_id);
    if let Some(info) = info {
        for file in &info.files {
            let file_path = model_dir.join(&file.name);
            if !file_path.exists() {
                return false;
            }
            if let Ok(metadata) = std::fs::metadata(&file_path) {
                if metadata.len() != file.size {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    } else {
        false
    }
}
