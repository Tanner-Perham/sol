pub mod download;
pub mod inference;
pub mod registry;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
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
}

/// LLM configuration stored in settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmConfig {
    pub active_model_id: Option<String>,
    pub downloaded_models: Vec<String>,
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
        std::fs::write(&config_path, data).map_err(|e| e.to_string())
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
