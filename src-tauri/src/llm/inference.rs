use candle_core::{DType, Device, IndexOp, Tensor};
use candle_core::quantized::gguf_file;
use candle_nn::VarBuilder;
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::qwen2::{Config as Qwen2Config, ModelForCausalLM as Qwen2Model};
use candle_transformers::models::llama::{Llama as LlamaModel, LlamaConfig, Config as LlamaConfigRaw, Cache as LlamaCache};
use candle_transformers::models::quantized_qwen2::ModelWeights as QuantizedQwen2;
use candle_transformers::models::quantized_llama::ModelWeights as QuantizedLlama;

use std::path::{Path, PathBuf};
use tokenizers::Tokenizer;

use super::models_dir;

fn read_eos_token_id(model_dir: &Path, default_id: u32) -> u32 {
    let gen_config_path = model_dir.join("generation_config.json");
    if gen_config_path.exists() {
        if let Ok(gen_config_data) = std::fs::read_to_string(&gen_config_path) {
            if let Ok(gen_val) = serde_json::from_str::<serde_json::Value>(&gen_config_data) {
                if let Some(eos_id) = gen_val.get("eos_token_id") {
                    if let Some(id_u64) = eos_id.as_u64() {
                        return id_u64 as u32;
                    } else if let Some(id_arr) = eos_id.as_array() {
                        if let Some(first_id) = id_arr.first().and_then(|v| v.as_u64()) {
                            return first_id as u32;
                        }
                    }
                }
            }
        }
    }
    default_id
}

pub enum Model {
    Qwen2(Qwen2Model),
    Llama {
        model: LlamaModel,
        config: LlamaConfigRaw,
    },
    QuantizedQwen2(QuantizedQwen2),
    QuantizedLlama(QuantizedLlama),
}

/// Loaded model ready for inference
pub struct LoadedModel {
    model: Model,
    tokenizer: Tokenizer,
    device: Device,
    eos_token_id: u32,
}

/// Extract the last-position logits as a 1-D (vocab,) tensor, handling both
/// candle output conventions: (batch, seq, vocab) [qwen2 ModelForCausalLM]
/// and (batch, vocab) [llama, quantized_llama, quantized_qwen2].
fn last_token_logits(logits: &Tensor) -> Result<Tensor, String> {
    match logits.rank() {
        3 => {
            let seq_len = logits.dim(1).map_err(|e| e.to_string())?;
            logits
                .i((0, seq_len - 1, ..))
                .map_err(|e| format!("Logits indexing failed: {}", e))
        }
        2 => logits
            .i((0, ..))
            .map_err(|e| format!("Logits indexing failed: {}", e)),
        r => Err(format!("Unexpected logits rank {} (shape {:?})", r, logits.shape())),
    }
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
        let config_val: serde_json::Value = serde_json::from_str(&config_data)
            .map_err(|e| format!("Failed to parse config as JSON: {}", e))?;

        let model_type = config_val
            .get("model_type")
            .and_then(|v| v.as_str())
            .unwrap_or("qwen2");

        // Load tokenizer
        let tokenizer_path = model_dir.join("tokenizer.json");
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        // Check if any GGUF file exists (prioritize quantized models)
        let gguf_path = std::fs::read_dir(&model_dir)
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry.path().extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| ext.eq_ignore_ascii_case("gguf"))
                            .unwrap_or(false)
                    })
                    .map(|entry| entry.path())
            });

        let use_quantized = gguf_path.is_some();

        let (model, eos_token_id) = if use_quantized {
            // Load quantized GGUF model
            let gguf_file_path = gguf_path.ok_or_else(|| "GGUF file not found".to_string())?;
            eprintln!("[LLM] Loading quantized GGUF model from {:?}", gguf_file_path);

            let mut file = std::fs::File::open(&gguf_file_path)
                .map_err(|e| format!("Failed to open GGUF file: {}", e))?;
            let gguf_content = gguf_file::Content::read(&mut file)
                .map_err(|e| format!("Failed to read GGUF content: {}", e))?;

            // Read architecture from GGUF metadata
            let arch: String = match gguf_content.metadata.get("general.architecture") {
                Some(v) => v.to_string().map(|s| s.to_string()).unwrap_or_else(|_| model_type.to_string()),
                None => {
                    eprintln!("[LLM] No general.architecture in GGUF, falling back to config model_type: {}", model_type);
                    model_type.to_string()
                }
            };

            eprintln!("[LLM] GGUF architecture: {}", arch);

            match arch.as_str() {
                "llama" => {
                    eprintln!("[LLM] Loading as quantized Llama model");
                    let model = QuantizedLlama::from_gguf(gguf_content, &mut file, &device)
                        .map_err(|e| format!("Failed to load quantized Llama: {}", e))?;
                    let eos_id = read_eos_token_id(&model_dir, 2);
                    (Model::QuantizedLlama(model), eos_id)
                }
                "qwen2" => {
                    eprintln!("[LLM] Loading as quantized Qwen2 model");
                    let model = QuantizedQwen2::from_gguf(gguf_content, &mut file, &device)
                        .map_err(|e| format!("Failed to load quantized Qwen2: {}", e))?;
                    let eos_id = read_eos_token_id(&model_dir, 151643);
                    (Model::QuantizedQwen2(model), eos_id)
                }
                other => {
                    return Err(format!("Unsupported GGUF architecture: {}. Supported: llama, qwen2", other));
                }
            }
        } else {
            // Load F32 safetensors model
            let weights_path = model_dir.join("model.safetensors");
            let vb = unsafe {
                VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)
                    .map_err(|e| format!("Failed to load weights: {}", e))?
            };

            match model_type {
                "llama" => {
                    let llama_config: LlamaConfig = serde_json::from_str(&config_data)
                        .map_err(|e| format!("Failed to parse Llama config: {}", e))?;
                    let config = llama_config.into_config(false);
                    let model = LlamaModel::load(vb, &config)
                        .map_err(|e| format!("Failed to create Llama model: {}", e))?;
                    let eos_id = read_eos_token_id(&model_dir, 2);
                    (Model::Llama { model, config }, eos_id)
                }
                _ => {
                    let config: Qwen2Config = serde_json::from_str(&config_data)
                        .map_err(|e| format!("Failed to parse Qwen2 config: {}", e))?;
                    let model = Qwen2Model::new(&config, vb)
                        .map_err(|e| format!("Failed to create Qwen2 model: {}", e))?;
                    let eos_id = read_eos_token_id(&model_dir, 151643);
                    (Model::Qwen2(model), eos_id)
                }
            }
        };

        Ok(Self {
            model,
            tokenizer,
            device,
            eos_token_id,
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

        if let Model::Qwen2(model) = &mut self.model {
            model.clear_kv_cache();
        }

        // Initialize Llama cache if needed
        let mut llama_cache = match &self.model {
            Model::Llama { config, .. } => {
                let cache = LlamaCache::new(true, DType::F32, config, &self.device)
                    .map_err(|e| format!("Failed to create Llama cache: {}", e))?;
                Some(cache)
            }
            _ => None,
        };

        // Position offset
        let mut pos_offset = 0;

        // Generate tokens one by one
        for step in 0..max_tokens {
            let input_slice = if step == 0 {
                &tokens[..]
            } else {
                &tokens[tokens.len() - 1..]
            };

            let input = Tensor::new(input_slice, &self.device)
                .map_err(|e| format!("Tensor creation failed: {}", e))?
                .unsqueeze(0)
                .map_err(|e| format!("Unsqueeze failed: {}", e))?;

            let logits = match &mut self.model {
                Model::Qwen2(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Qwen2 forward pass failed: {}", e))?
                }
                Model::Llama { model, .. } => {
                    let cache = llama_cache.as_mut().ok_or("Llama cache missing")?;
                    model.forward(&input, pos_offset, cache)
                        .map_err(|e| format!("Llama forward pass failed: {}", e))?
                }
                Model::QuantizedQwen2(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Quantized Qwen2 forward pass failed: {}", e))?
                }
                Model::QuantizedLlama(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Quantized Llama forward pass failed: {}", e))?
                }
            };

            pos_offset += input_slice.len();

            let logits = last_token_logits(&logits)?;

            let next_token = logits_processor
                .sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            if next_token == self.eos_token_id {
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

    /// Generate text streaming tokens and checking stop sequences/cancellation
    pub fn generate_stream<F>(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: Option<f64>,
        top_p: Option<f64>,
        seed: u64,
        stop_sequences: &[String],
        cancel_token: &std::sync::atomic::AtomicBool,
        mut on_token: F,
    ) -> Result<(), String>
    where
        F: FnMut(&str) -> Result<(), String>,
    {
        // Tokenize input
        let encoding = self
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;

        let input_ids = encoding.get_ids();
        let mut tokens: Vec<u32> = input_ids.to_vec();

        let mut logits_processor = LogitsProcessor::new(seed, temperature, top_p);

        if let Model::Qwen2(model) = &mut self.model {
            model.clear_kv_cache();
        }

        // Initialize Llama cache if needed
        let mut llama_cache = match &self.model {
            Model::Llama { config, .. } => {
                let cache = LlamaCache::new(true, DType::F32, config, &self.device)
                    .map_err(|e| format!("Failed to create Llama cache: {}", e))?;
                Some(cache)
            }
            _ => None,
        };

        // Position offset
        let mut pos_offset = 0;

        let mut decoded_text = String::new();

        // Generate tokens one by one
        for step in 0..max_tokens {
            if cancel_token.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }

            let input_slice = if step == 0 {
                &tokens[..]
            } else {
                &tokens[tokens.len() - 1..]
            };

            let input = Tensor::new(input_slice, &self.device)
                .map_err(|e| format!("Tensor creation failed: {}", e))?
                .unsqueeze(0)
                .map_err(|e| format!("Unsqueeze failed: {}", e))?;

            let logits = match &mut self.model {
                Model::Qwen2(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Qwen2 forward pass failed: {}", e))?
                }
                Model::Llama { model, .. } => {
                    let cache = llama_cache.as_mut().ok_or("Llama cache missing")?;
                    model.forward(&input, pos_offset, cache)
                        .map_err(|e| format!("Llama forward pass failed: {}", e))?
                }
                Model::QuantizedQwen2(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Quantized Qwen2 forward pass failed: {}", e))?
                }
                Model::QuantizedLlama(model) => {
                    model.forward(&input, pos_offset)
                        .map_err(|e| format!("Quantized Llama forward pass failed: {}", e))?
                }
            };

            pos_offset += input_slice.len();

            let logits = last_token_logits(&logits)?;

            let next_token = logits_processor
                .sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            if next_token == self.eos_token_id {
                break;
            }

            tokens.push(next_token);

            // Decode current sequence
            let current_text = self
                .tokenizer
                .decode(&tokens[input_ids.len()..], true)
                .map_err(|e| format!("Decoding failed: {}", e))?;

            // Check stop sequences
            let mut earliest_stop = None;
            for stop_seq in stop_sequences {
                if let Some(idx) = current_text.find(stop_seq) {
                    match earliest_stop {
                        None => earliest_stop = Some((idx, stop_seq.len())),
                        Some((earliest_idx, _)) if idx < earliest_idx => {
                            earliest_stop = Some((idx, stop_seq.len()));
                        }
                        _ => {}
                    }
                }
            }

            if let Some((idx, _len)) = earliest_stop {
                let final_text = &current_text[..idx];
                if final_text.len() > decoded_text.len() {
                    let new_part = &final_text[decoded_text.len()..];
                    on_token(new_part)?;
                }
                break;
            } else {
                if current_text.len() > decoded_text.len() {
                    let new_part = &current_text[decoded_text.len()..];
                    on_token(new_part)?;
                    decoded_text = current_text;
                }
            }
        }

        Ok(())
    }
}

/// Generate a topic name for a cluster of notes using a pre-loaded model
pub fn generate_topic_name(
    model: &mut LoadedModel,
    note_snippets: &[String],
) -> Result<String, String> {

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_token_logits_rank3() {
        let dev = Device::Cpu;
        // (batch=1, seq=3, vocab=4); last position = [8,9,10,11]
        let t = Tensor::arange(0f32, 12., &dev).unwrap().reshape((1, 3, 4)).unwrap();
        let out = last_token_logits(&t).unwrap();
        assert_eq!(out.dims(), &[4]);
        assert_eq!(out.to_vec1::<f32>().unwrap(), vec![8., 9., 10., 11.]);
    }

    #[test]
    fn last_token_logits_rank2() {
        let dev = Device::Cpu;
        // (batch=1, vocab=4)
        let t = Tensor::arange(0f32, 4., &dev).unwrap().reshape((1, 4)).unwrap();
        let out = last_token_logits(&t).unwrap();
        assert_eq!(out.dims(), &[4]);
        assert_eq!(out.to_vec1::<f32>().unwrap(), vec![0., 1., 2., 3.]);
    }

    #[test]
    fn last_token_logits_rejects_rank1() {
        let dev = Device::Cpu;
        let t = Tensor::arange(0f32, 4., &dev).unwrap();
        assert!(last_token_logits(&t).is_err());
    }
}
