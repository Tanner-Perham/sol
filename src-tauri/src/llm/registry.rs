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
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 659,
                    sha256: Some("168aa1bd401abc3bc262ba15ba4e499627a8b4e006e9d050b47c22de20660185".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: Some("f7c9b2dba4a296b1aa76c16a34b8225c0c118978400d4bb66bff0902d702f5b8".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: Some("e558847a8b4402616f1273797b015104dc266fe4b520056fca88823ba8f8ebe6".to_string()),
                    repo_id: None,
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
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 660,
                    sha256: Some("a58e896d2756a7947f23f3db55667c19ca3b8524188a30c8c640cd7ff72a5136".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7028015,
                    sha256: Some("f7c9b2dba4a296b1aa76c16a34b8225c0c118978400d4bb66bff0902d702f5b8".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: Some("e558847a8b4402616f1273797b015104dc266fe4b520056fca88823ba8f8ebe6".to_string()),
                    repo_id: None,
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
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 608,
                    sha256: Some("486bedda3a6988332e60d9638a09ca4b260d34ebcf1b19e22cf3b140b63d8fe9".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 1842767,
                    sha256: Some("bcd04f0eadf90287bd26e1a183ac487d8a141b09b06aecb7725bbdd343640f2e".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 124,
                    sha256: Some("18046d04f5bd8b4998095ecabdd17a1bf0053d9acdccead4a05be4a3575f3c5c".to_string()),
                    repo_id: None,
                },
            ],
        },
        ModelInfo {
            id: "qwen2.5-0.5b".to_string(),
            name: "Qwen2.5 0.5B (Base)".to_string(),
            description: "Base 0.5B model, excellent for fast continuation completion".to_string(),
            size_bytes: 988_000_000,
            repo_id: "Qwen/Qwen2.5-0.5B".to_string(),
            files: vec![
                ModelFile {
                    name: "model.safetensors".to_string(),
                    size: 988097824,
                    sha256: Some("88c142557820ccad55bb59756bfcfcf891de9cc6202816bd346445188a0ed342".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 681,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7031645,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 138,
                    sha256: None,
                    repo_id: None,
                },
            ],
        },
        ModelInfo {
            id: "smollm2-360m".to_string(),
            name: "SmolLM2 360M (Base)".to_string(),
            description: "Extremely lightweight base model, ultra-fast for completions".to_string(),
            size_bytes: 723_000_000,
            repo_id: "HuggingFaceTB/SmolLM2-360M".to_string(),
            files: vec![
                ModelFile {
                    name: "model.safetensors".to_string(),
                    size: 723674912,
                    sha256: Some("7aaff6661428bed033abba9522bec81938678642cca3181fe752b6ca9e1e540f".to_string()),
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 689,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 2104556,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 111,
                    sha256: None,
                    repo_id: None,
                },
            ],
        },
        // Quantized models - faster inference with 4-bit weights
        ModelInfo {
            id: "qwen2.5-0.5b-q4".to_string(),
            name: "Qwen2.5 0.5B Q4 (Instruct, Quantized)".to_string(),
            description: "Instruct-tuned 4-bit quantized model, 2-4x faster than F32. Better suited to topic naming than completion.".to_string(),
            size_bytes: 499_000_000,
            repo_id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF".to_string(),
            files: vec![
                ModelFile {
                    name: "qwen2.5-0.5b-instruct-q4_k_m.gguf".to_string(),
                    size: 491400032,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 659,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B-Instruct".to_string()),
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7031645,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B-Instruct".to_string()),
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 242,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B-Instruct".to_string()),
                },
            ],
        },
        ModelInfo {
            id: "qwen2.5-0.5b-base-q4".to_string(),
            name: "Qwen2.5 0.5B Base Q4 (Quantized)".to_string(),
            description: "Base 4-bit quantized model, ultra-fast for completions".to_string(),
            size_bytes: 399_000_000,
            repo_id: "QuantFactory/Qwen2.5-0.5B-GGUF".to_string(),
            files: vec![
                ModelFile {
                    name: "Qwen2.5-0.5B.Q4_K_M.gguf".to_string(),
                    size: 397807488,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 681,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B".to_string()),
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 7031645,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B".to_string()),
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 138,
                    sha256: None,
                    repo_id: Some("Qwen/Qwen2.5-0.5B".to_string()),
                },
            ],
        },
        ModelInfo {
            id: "smollm2-360m-q4".to_string(),
            name: "SmolLM2 360M Q4 (Base, Quantized)".to_string(),
            description: "4-bit quantized ultra-lightweight model, fastest inference".to_string(),
            size_bytes: 273_300_000,
            repo_id: "HuggingFaceTB/SmolLM2-360M".to_string(),
            files: vec![
                ModelFile {
                    name: "SmolLM2-360M.Q4_K_M.gguf".to_string(),
                    size: 270589952,
                    sha256: None,
                    repo_id: Some("QuantFactory/SmolLM2-360M-GGUF".to_string()),
                },
                ModelFile {
                    name: "config.json".to_string(),
                    size: 689,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "tokenizer.json".to_string(),
                    size: 2104556,
                    sha256: None,
                    repo_id: None,
                },
                ModelFile {
                    name: "generation_config.json".to_string(),
                    size: 111,
                    sha256: None,
                    repo_id: None,
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
