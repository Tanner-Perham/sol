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
                    sha256: Some("168aa1bd401abc3bc262ba15ba4e499627a8b4e006e9d050b47c22de20660185".to_string()),
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: Some("f7c9b2dba4a296b1aa76c16a34b8225c0c118978400d4bb66bff0902d702f5b8".to_string()),
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: Some("e558847a8b4402616f1273797b015104dc266fe4b520056fca88823ba8f8ebe6".to_string()),
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
                    sha256: Some("a58e896d2756a7947f23f3db55667c19ca3b8524188a30c8c640cd7ff72a5136".to_string()),
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: Some("f7c9b2dba4a296b1aa76c16a34b8225c0c118978400d4bb66bff0902d702f5b8".to_string()),
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: Some("e558847a8b4402616f1273797b015104dc266fe4b520056fca88823ba8f8ebe6".to_string()),
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
                    sha256: Some("486bedda3a6988332e60d9638a09ca4b260d34ebcf1b19e22cf3b140b63d8fe9".to_string()),
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 1842767,
                    sha256: Some("bcd04f0eadf90287bd26e1a183ac487d8a141b09b06aecb7725bbdd343640f2e".to_string()),
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 124,
                    sha256: Some("18046d04f5bd8b4998095ecabdd17a1bf0053d9acdccead4a05be4a3575f3c5c".to_string()),
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
