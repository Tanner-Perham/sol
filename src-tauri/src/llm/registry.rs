use super::ModelInfo;

/// Get the list of available models
pub fn get_available_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "qwen2-0.5b".to_string(),
            name: "Qwen2 0.5B".to_string(),
            description: "Compact 0.5B parameter model, fast inference, good for topic naming"
                .to_string(),
            size_bytes: 500_000_000, // ~500MB
            repo_id: "Qwen/Qwen2-0.5B-Instruct".to_string(),
            files: vec![
                "model.safetensors".to_string(),
                "config.json".to_string(),
                "tokenizer.json".to_string(),
                "generation_config.json".to_string(),
            ],
        },
        ModelInfo {
            id: "qwen2-1.5b".to_string(),
            name: "Qwen2 1.5B".to_string(),
            description: "Larger 1.5B model, better quality but slower".to_string(),
            size_bytes: 1_500_000_000, // ~1.5GB
            repo_id: "Qwen/Qwen2-1.5B-Instruct".to_string(),
            files: vec![
                "model.safetensors".to_string(),
                "config.json".to_string(),
                "tokenizer.json".to_string(),
                "generation_config.json".to_string(),
            ],
        },
        ModelInfo {
            id: "tinyllama-1.1b".to_string(),
            name: "TinyLlama 1.1B".to_string(),
            description: "Fast 1.1B model, good balance of speed and quality".to_string(),
            size_bytes: 1_100_000_000, // ~1.1GB
            repo_id: "TinyLlama/TinyLlama-1.1B-Chat-v1.0".to_string(),
            files: vec![
                "model.safetensors".to_string(),
                "config.json".to_string(),
                "tokenizer.json".to_string(),
                "generation_config.json".to_string(),
            ],
        },
    ]
}

/// Get info for a specific model
pub fn get_model_info(model_id: &str) -> Option<ModelInfo> {
    get_available_models()
        .into_iter()
        .find(|m| m.id == model_id)
}
