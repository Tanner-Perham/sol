use super::{ModelInfo, ModelFile};

/// Get the list of available models
pub fn get_available_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "qwen2-0.5b".to_string(),
            name: "Qwen2 0.5B".to_string(),
            description: "Compact 0.5B parameter model, fast inference, good for topic naming"
                .to_string(),
            size_bytes: 988_000_000,
            repo_id: "Qwen/Qwen2-0.5B-Instruct".to_string(),
            files: vec![
                ModelFile {
                    name: "model.safetensors".to_string(),
                    size: 988097824,
                    sha256: Some("130282af0dfa9fe5840737cc49a0d339d06075f83c5a315c3372c9a0740d0b96".to_string()),
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 659,
                    sha256: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: None,
                },
            ],
        },
        ModelInfo {
            id: "qwen2-1.5b".to_string(),
            name: "Qwen2 1.5B".to_string(),
            description: "Larger 1.5B model, better quality but slower".to_string(),
            size_bytes: 3_087_000_000,
            repo_id: "Qwen/Qwen2-1.5B-Instruct".to_string(),
            files: vec![
                ModelFile {
                    name: "model.safetensors".to_string(),
                    size: 3087467144,
                    sha256: Some("302e327795994403cb1e3cb6a3345c76b246b894d14078c936b570c83a4e9057".to_string()),
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 660,
                    sha256: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: None,
                },
            ],
        },
        ModelInfo {
            id: "tinyllama-1.1b".to_string(),
            name: "TinyLlama 1.1B".to_string(),
            description: "Fast 1.1B model, good balance of speed and quality".to_string(),
            size_bytes: 2_200_000_000,
            repo_id: "TinyLlama/TinyLlama-1.1B-Chat-v1.0".to_string(),
            files: vec![
                ModelFile {
                    name: "model.safetensors".to_string(),
                    size: 2200119864,
                    sha256: Some("6e6001da2106d4757498752a021df6c2bdc332c650aae4bae6b0c004dcf14933".to_string()),
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 608,
                    sha256: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 1842767,
                    sha256: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 124,
                    sha256: None,
                },
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
