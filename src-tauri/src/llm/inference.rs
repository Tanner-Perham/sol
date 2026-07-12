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
use std::collections::{HashMap, HashSet};

use super::models_dir;

/// Map of 3-token key -> set of banned 4th tokens, built from a token sequence.
fn build_ngram_index(tokens: &[u32], index: &mut HashMap<[u32; 3], HashSet<u32>>) {
    for w in tokens.windows(4) {
        index.entry([w[0], w[1], w[2]]).or_default().insert(w[3]);
    }
}

/// Set logits of banned continuations to -inf. Mirrors the vec-roundtrip
/// pattern of candle_transformers::utils::apply_repeat_penalty.
fn ban_ngram_continuations(
    logits: &Tensor,
    last_three: Option<[u32; 3]>,
    index: &HashMap<[u32; 3], HashSet<u32>>,
) -> Result<Tensor, String> {
    if let Some(key) = last_three {
        if let Some(banned_tokens) = index.get(&key) {
            if !banned_tokens.is_empty() {
                let mut logits_vec = logits.to_vec1::<f32>().map_err(|e| e.to_string())?;
                for &tok in banned_tokens {
                    if (tok as usize) < logits_vec.len() {
                        logits_vec[tok as usize] = f32::NEG_INFINITY;
                    }
                }
                return Tensor::from_vec(logits_vec, logits.shape(), logits.device())
                    .map_err(|e| format!("Tensor creation in ban_ngram_continuations failed: {}", e));
            }
        }
    }
    Ok(logits.clone())
}

fn read_eos_token_ids(model_dir: &Path, default_ids: &[u32]) -> Vec<u32> {
    let gen_config_path = model_dir.join("generation_config.json");
    if gen_config_path.exists() {
        if let Ok(gen_config_data) = std::fs::read_to_string(&gen_config_path) {
            if let Ok(gen_val) = serde_json::from_str::<serde_json::Value>(&gen_config_data) {
                if let Some(eos_id) = gen_val.get("eos_token_id") {
                    if let Some(id_u64) = eos_id.as_u64() {
                        return vec![id_u64 as u32];
                    } else if let Some(id_arr) = eos_id.as_array() {
                        let ids: Vec<u32> = id_arr
                            .iter()
                            .filter_map(|v| v.as_u64().map(|id| id as u32))
                            .collect();
                        if !ids.is_empty() {
                            return ids;
                        }
                    }
                }
            }
        }
    }
    default_ids.to_vec()
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
    eos_token_ids: Vec<u32>,
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

/// Check if the period character at `idx` in `text` is the end of a sentence
/// (excluding abbreviations, acronyms, or multiple consecutive periods/ellipses).
fn is_sentence_end_period(text: &str, idx: usize) -> bool {
    let bytes = text.as_bytes();
    // 1. Check for ellipsis / multiple dots
    if idx > 0 && bytes[idx - 1] == b'.' {
        return false;
    }
    if idx + 1 < bytes.len() && bytes[idx + 1] == b'.' {
        return false;
    }

    // 2. Extract the word immediately preceding the period
    let mut start = idx;
    while start > 0 {
        let prev_char = text[..start].chars().next_back().unwrap();
        if prev_char.is_alphanumeric() || prev_char == '\'' || prev_char == '-' {
            start -= prev_char.len_utf8();
        } else {
            break;
        }
    }
    let word = &text[start..idx];
    if word.is_empty() {
        return true;
    }

    // 3. Check for single-letter initials (middle initials, acronyms like U.S.)
    if word.chars().count() == 1 && word.chars().next().unwrap().is_alphabetic() {
        return false;
    }

    // 4. Check against common abbreviations
    let lower_word = word.to_lowercase();
    let common_abbrevs = [
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "ie", "eg", "etc", 
        "al", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        "st", "rd", "th", "ave", "blvd", "co", "corp", "inc", "ltd", "approx", "ca"
    ];
    if common_abbrevs.contains(&lower_word.as_str()) {
        return false;
    }

    true
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GenerationStats {
    pub prefill_ms: u64,
    pub prefill_tokens: usize,
    pub decode_tokens: usize,
    pub tok_per_s: f64,
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

        let (model, eos_token_ids) = if use_quantized {
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
                    let eos_ids = read_eos_token_ids(&model_dir, &[2]);
                    (Model::QuantizedLlama(model), eos_ids)
                }
                "qwen2" => {
                    eprintln!("[LLM] Loading as quantized Qwen2 model");
                    let model = QuantizedQwen2::from_gguf(gguf_content, &mut file, &device)
                        .map_err(|e| format!("Failed to load quantized Qwen2: {}", e))?;
                    let eos_ids = read_eos_token_ids(&model_dir, &[151643]);
                    (Model::QuantizedQwen2(model), eos_ids)
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
                    let eos_ids = read_eos_token_ids(&model_dir, &[2]);
                    (Model::Llama { model, config }, eos_ids)
                }
                _ => {
                    let config: Qwen2Config = serde_json::from_str(&config_data)
                        .map_err(|e| format!("Failed to parse Qwen2 config: {}", e))?;
                    let model = Qwen2Model::new(&config, vb)
                        .map_err(|e| format!("Failed to create Qwen2 model: {}", e))?;
                    let eos_ids = read_eos_token_ids(&model_dir, &[151643]);
                    (Model::Qwen2(model), eos_ids)
                }
            }
        };

        Ok(Self {
            model,
            tokenizer,
            device,
            eos_token_ids,
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

        let mut ngram_index = HashMap::new();
        build_ngram_index(&tokens, &mut ngram_index);

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

            // Repeat penalty (A2)
            let penalty_tokens = &tokens[tokens.len().saturating_sub(64)..];
            let logits = candle_transformers::utils::apply_repeat_penalty(&logits, 1.15, penalty_tokens)
                .map_err(|e| format!("Repeat penalty failed: {}", e))?;

            // N-gram blocking (A1)
            let logits = if tokens.len() >= 3 {
                let tail = [
                    tokens[tokens.len() - 3],
                    tokens[tokens.len() - 2],
                    tokens[tokens.len() - 1],
                ];
                ban_ngram_continuations(&logits, Some(tail), &ngram_index)?
            } else {
                logits
            };

            let next_token = logits_processor
                .sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            if self.eos_token_ids.contains(&next_token) {
                break;
            }

            tokens.push(next_token);
            if tokens.len() >= 4 {
                build_ngram_index(&tokens[tokens.len() - 4..], &mut ngram_index);
            }
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
        rejected: &[String],
        cancel_token: &std::sync::atomic::AtomicBool,
        mut on_token: F,
    ) -> Result<GenerationStats, String>
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

        let mut ngram_index = HashMap::new();
        build_ngram_index(&tokens, &mut ngram_index);

        // Prepend prompt tail to each rejected string and index its 4-grams
        for rej in rejected {
            if let Ok(encoding) = self.tokenizer.encode(rej.as_str(), true) {
                let rej_ids = encoding.get_ids();
                let prompt_tail = &tokens[tokens.len().saturating_sub(3)..];
                let mut combined = Vec::with_capacity(prompt_tail.len() + rej_ids.len());
                combined.extend_from_slice(prompt_tail);
                combined.extend_from_slice(rej_ids);
                build_ngram_index(&combined, &mut ngram_index);
            }
        }

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

        let mut prefill_time = None;
        let start_time = std::time::Instant::now();
        let mut tokens_decoded = 0;

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

            // Repeat penalty (A2)
            let penalty_tokens = &tokens[tokens.len().saturating_sub(64)..];
            let logits = candle_transformers::utils::apply_repeat_penalty(&logits, 1.15, penalty_tokens)
                .map_err(|e| format!("Repeat penalty failed: {}", e))?;

            // N-gram blocking (A1)
            let logits = if tokens.len() >= 3 {
                let tail = [
                    tokens[tokens.len() - 3],
                    tokens[tokens.len() - 2],
                    tokens[tokens.len() - 1],
                ];
                ban_ngram_continuations(&logits, Some(tail), &ngram_index)?
            } else {
                logits
            };

            let next_token = logits_processor
                .sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            if step == 0 {
                prefill_time = Some(start_time.elapsed());
                eprintln!(
                    "[LLM] prefill: {} tokens in {:?}",
                    input_ids.len(),
                    prefill_time.unwrap()
                );
            }

            if self.eos_token_ids.contains(&next_token) {
                break;
            }

            tokens.push(next_token);
            if tokens.len() >= 4 {
                build_ngram_index(&tokens[tokens.len() - 4..], &mut ngram_index);
            }
            tokens_decoded += 1;

            // Decode current sequence
            let current_raw = self
                .tokenizer
                .decode(&tokens[input_ids.len()..], true)
                .map_err(|e| format!("Decoding failed: {}", e))?;

            // Drop leading whitespace/newlines: models frequently open with '\n',
            // which must not trigger the '\n' stop sequence or be emitted as ghost text.
            let current_text = current_raw.trim_start();

            // Check stop sequences
            let mut earliest_stop = None;
            for stop_seq in stop_sequences {
                let mut start_search = 0;
                while let Some(relative_idx) = current_text[start_search..].find(stop_seq) {
                    let idx = start_search + relative_idx;
                    
                    if stop_seq == "." && !is_sentence_end_period(current_text, idx) {
                        start_search = idx + stop_seq.len();
                        continue;
                    }

                    match earliest_stop {
                        None => earliest_stop = Some((idx, stop_seq.len(), stop_seq.clone())),
                        Some((earliest_idx, _, _)) if idx < earliest_idx => {
                            earliest_stop = Some((idx, stop_seq.len(), stop_seq.clone()));
                        }
                        _ => {}
                    }
                    break;
                }
            }

            if let Some((idx, len, stop_seq)) = earliest_stop {
                let include_len = if stop_seq == "." {
                    len
                } else {
                    0
                };
                let final_text = &current_text[..idx + include_len];
                if final_text.len() > decoded_text.len() {
                    let new_part = &final_text[decoded_text.len()..];
                    on_token(new_part)?;
                }
                break;
            } else {
                if current_text.len() > decoded_text.len() {
                    let new_part = &current_text[decoded_text.len()..];
                    on_token(new_part)?;
                    decoded_text = current_text.to_string();
                }
            }
        }

        let total_duration = start_time.elapsed();
        let mut prefill_ms = 0;
        let prefill_tokens = input_ids.len();
        let decode_tokens = tokens_decoded;
        let mut tok_per_s = 0.0;

        if let Some(prefill) = prefill_time {
            prefill_ms = prefill.as_millis() as u64;
            let decode_duration = total_duration.saturating_sub(prefill);
            tok_per_s = if decode_duration.as_secs_f64() > 0.0 {
                tokens_decoded as f64 / decode_duration.as_secs_f64()
            } else {
                0.0
            };
            eprintln!(
                "[LLM] decode: {} tokens in {:?} ({:.1} tok/s)",
                tokens_decoded,
                decode_duration,
                tok_per_s
            );
        }

        Ok(GenerationStats {
            prefill_ms,
            prefill_tokens,
            decode_tokens,
            tok_per_s,
        })
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

    #[test]
    fn test_read_eos_token_ids() {
        let temp_dir = std::env::temp_dir().join(format!(
            "sol_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let gen_config_path = temp_dir.join("generation_config.json");

        // Test array
        std::fs::write(&gen_config_path, r#"{"eos_token_id": [151645, 151643]}"#).unwrap();
        let ids = read_eos_token_ids(&temp_dir, &[2]);
        assert_eq!(ids, vec![151645, 151643]);

        // Test scalar
        std::fs::write(&gen_config_path, r#"{"eos_token_id": 2}"#).unwrap();
        let ids = read_eos_token_ids(&temp_dir, &[151643]);
        assert_eq!(ids, vec![2]);

        // Test missing / fallback
        std::fs::remove_file(&gen_config_path).unwrap();
        let ids = read_eos_token_ids(&temp_dir, &[100, 200]);
        assert_eq!(ids, vec![100, 200]);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_is_sentence_end_period() {
        // End of sentence
        assert!(is_sentence_end_period("Hello world.", 11));
        assert!(is_sentence_end_period("This is a sentence. And another.", 18));
        assert!(is_sentence_end_period("This is a sentence. And another.", 31));

        // Ellipsis / multiple dots
        assert!(!is_sentence_end_period("Wait...", 4));
        assert!(!is_sentence_end_period("Wait...", 5));
        assert!(!is_sentence_end_period("Wait...", 6));

        // Acronyms / initials
        assert!(!is_sentence_end_period("U.S.A.", 1));
        assert!(!is_sentence_end_period("U.S.A.", 3));
        assert!(!is_sentence_end_period("U.S.A.", 5));
        // Acronyms / initials
        assert!(!is_sentence_end_period("Mr. Smith", 2));
        assert!(!is_sentence_end_period("i.e. something", 3));
        assert!(!is_sentence_end_period("etc. and so on", 3));
    }

    #[test]
    fn test_ngram_blocking() {
        let dev = Device::Cpu;
        let mut index = HashMap::new();
        // Index a sample prompt: "the cat sat on the mat"
        // Let's mock token ids:
        // the: 1, cat: 2, sat: 3, on: 4, mat: 5
        let tokens = vec![1, 2, 3, 4, 1, 5];
        build_ngram_index(&tokens, &mut index);

        // Assert 4-grams indexed:
        // [1, 2, 3] -> 4 (the cat sat -> on)
        // [2, 3, 4] -> 1 (cat sat on -> the)
        // [3, 4, 1] -> 5 (sat on the -> mat)
        assert!(index.get(&[1, 2, 3]).unwrap().contains(&4));
        assert!(index.get(&[2, 3, 4]).unwrap().contains(&1));
        assert!(index.get(&[3, 4, 1]).unwrap().contains(&5));

        // Test logits banning
        // Vocabulary size 6: 0..5
        let logits = Tensor::new(&[1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0], &dev).unwrap();
        
        // Context: last 3 are [1, 2, 3] -> should ban 4
        let banned = ban_ngram_continuations(&logits, Some([1, 2, 3]), &index).unwrap();
        let banned_vec = banned.to_vec1::<f32>().unwrap();
        assert_eq!(banned_vec[4], f32::NEG_INFINITY);
        assert_eq!(banned_vec[3], 4.0); // other indices unaffected
    }
}
