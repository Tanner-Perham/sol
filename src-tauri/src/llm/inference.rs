use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::qwen2::{Config, ModelForCausalLM as Qwen2Model};
use std::path::PathBuf;
use tokenizers::Tokenizer;

use super::models_dir;

/// Loaded model ready for inference
pub struct LoadedModel {
    model: Qwen2Model,
    tokenizer: Tokenizer,
    device: Device,
}

impl LoadedModel {
    /// Load a model from disk
    pub fn load(workspace: &PathBuf, model_id: &str) -> Result<Self, String> {
        let model_dir = models_dir(workspace).join(model_id);

        if !model_dir.exists() {
            return Err(format!("Model not found: {}", model_id));
        }

        let device = Device::Cpu;

        // Load config
        let config_path = model_dir.join("config.json");
        let config_data = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: Config = serde_json::from_str(&config_data)
            .map_err(|e| format!("Failed to parse config: {}", e))?;

        // Load tokenizer
        let tokenizer_path = model_dir.join("tokenizer.json");
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        // Load model weights
        let weights_path = model_dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)
                .map_err(|e| format!("Failed to load weights: {}", e))?
        };

        let model =
            Qwen2Model::new(&config, vb).map_err(|e| format!("Failed to create model: {}", e))?;

        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    /// Generate text given a prompt
    pub fn generate(&mut self, prompt: &str, max_tokens: usize) -> Result<String, String> {
        // Tokenize input
        let encoding = self
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;

        let input_ids = encoding.get_ids();
        let mut tokens: Vec<u32> = input_ids.to_vec();

        let mut logits_processor = LogitsProcessor::new(42, Some(0.7), Some(0.9));

        // Generate tokens one by one
        for _ in 0..max_tokens {
            let input = Tensor::new(&tokens[..], &self.device)
                .map_err(|e| format!("Tensor creation failed: {}", e))?
                .unsqueeze(0)
                .map_err(|e| format!("Unsqueeze failed: {}", e))?;

            let logits = self
                .model
                .forward(&input, tokens.len())
                .map_err(|e| format!("Forward pass failed: {}", e))?;

            let logits = logits
                .squeeze(0)
                .map_err(|e| format!("Squeeze failed: {}", e))?;

            let logits = logits
                .get(logits.dim(0).map_err(|e| e.to_string())? - 1)
                .map_err(|e| format!("Get last logits failed: {}", e))?;

            let next_token = logits_processor
                .sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            // Check for EOS token (Qwen2 uses 151643 as EOS)
            const EOS_TOKEN_ID: u32 = 151643;
            if next_token == EOS_TOKEN_ID {
                break;
            }

            tokens.push(next_token);
        }

        // Decode output (skip input tokens)
        let output_tokens = &tokens[input_ids.len()..];
        let output = self
            .tokenizer
            .decode(output_tokens, true)
            .map_err(|e| format!("Decoding failed: {}", e))?;

        Ok(output.trim().to_string())
    }
}

/// Generate a topic name for a cluster of notes
pub fn generate_topic_name(
    workspace: &PathBuf,
    model_id: &str,
    note_snippets: &[String],
) -> Result<String, String> {
    let mut model = LoadedModel::load(workspace, model_id)?;

    // Build prompt
    let combined_snippets = note_snippets
        .iter()
        .take(3) // Use first 3 notes
        .map(|s| {
            // Prevent prompt injection by replacing ChatML tags
            let sanitized = s
                .replace("<|im_start|>", "[im_start]")
                .replace("<|im_end|>", "[im_end]")
                .replace("<|endoftext|>", "[endoftext]");

            // Take first 200 chars of each safely (using chars() instead of byte-slicing)
            if sanitized.chars().count() > 200 {
                let truncated: String = sanitized.chars().take(200).collect();
                format!("{}...", truncated)
            } else {
                sanitized
            }
        })
        .collect::<Vec<_>>()
        .join("\n---\n");

    let prompt = format!(
        "<|im_start|>system
You are a helpful assistant that creates short, descriptive topic names.
<|im_end|>
<|im_start|>user
What topic connects these notes? Reply with only 2-4 words, no explanation.

{}
<|im_end|>
<|im_start|>assistant
",
        combined_snippets
    );

    let response = model.generate(&prompt, 20)?;

    // Clean up response - take first line, remove quotes, limit length
    let cleaned = response
        .lines()
        .next()
        .unwrap_or(&response)
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();

    // Capitalize first letter of each word
    let topic_name = cleaned
        .split_whitespace()
        .take(4) // Max 4 words
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().chain(chars).collect(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if topic_name.is_empty() {
        Ok("Unnamed Topic".to_string())
    } else {
        Ok(topic_name)
    }
}
