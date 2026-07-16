use serde::{Deserialize, Serialize};
use reqwest::blocking::Client;
use std::time::Duration;
use std::io::{BufRead, BufReader};
use std::sync::atomic::AtomicBool;
use super::validate_provider_url;
use crate::llm::inference::GenerationStats;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct OllamaStatus {
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReworkRequest {
    model: String,
    stream: bool,
    think: bool,
    options: ReworkOptions,
    keep_alive: String,
    messages: Vec<ReworkMessage>,
}

#[derive(Debug, Serialize)]
struct ReworkOptions {
    temperature: f64,
    top_p: f64,
    seed: u64,
    #[serde(rename = "num_predict")]
    num_predict: usize,
}

#[derive(Debug, Serialize)]
struct ReworkMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaChunk {
    message: Option<OllamaChunkMessage>,
    done: bool,
    eval_count: Option<usize>,
    eval_duration: Option<u64>,
    prompt_eval_count: Option<usize>,
    prompt_eval_duration: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaChunkMessage {
    content: Option<String>,
    thinking: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTags {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

/// Query tags endpoint to verify if Ollama is running and available.
pub fn check_health(url_str: &str, allow_remote: bool) -> Result<OllamaStatus, String> {
    let url = match validate_provider_url(url_str, allow_remote) {
        Ok(u) => u,
        Err(e) => return Ok(OllamaStatus { available: false, error: Some(e) }),
    };

    let tags_url = match url.join("api/tags") {
        Ok(u) => u,
        Err(e) => return Ok(OllamaStatus { available: false, error: Some(e.to_string()) }),
    };

    let client = match Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build() {
            Ok(c) => c,
            Err(e) => return Ok(OllamaStatus { available: false, error: Some(e.to_string()) }),
        };

    match client.get(tags_url).send() {
        Ok(resp) => {
            if resp.status().is_success() {
                Ok(OllamaStatus { available: true, error: None })
            } else {
                let err_msg = format!("HTTP status {}", resp.status());
                let mapped = super::map_provider_error(&err_msg, "Ollama", None);
                Ok(OllamaStatus { available: false, error: Some(mapped) })
            }
        }
        Err(e) => {
            let mapped = super::map_provider_error(&e.to_string(), "Ollama", None);
            Ok(OllamaStatus { available: false, error: Some(mapped) })
        }
    }
}

/// List pulled models on the Ollama server.
pub fn list_models(url_str: &str, allow_remote: bool) -> Result<Vec<String>, String> {
    let url = validate_provider_url(url_str, allow_remote)?;
    let tags_url = url.join("api/tags").map_err(|e| e.to_string())?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(tags_url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP status {}", resp.status()));
    }

    let tags: OllamaTags = serde_json::from_reader(resp).map_err(|e| e.to_string())?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

/// Streams rework tokens using Ollama's chat API.
pub fn stream_rework<F>(
    url_str: &str,
    allow_remote: bool,
    model_name: &str,
    instruction: &str,
    selection: &str,
    temperature: f64,
    top_p: f64,
    seed: u64,
    max_tokens: usize,
    cancel_token: &AtomicBool,
    mut on_token: F,
) -> Result<GenerationStats, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    eprintln!("[Ollama Client] Validating URL {} (allow_remote={})", url_str, allow_remote);
    let url = validate_provider_url(url_str, allow_remote)?;
    let chat_url = url.join("api/chat").map_err(|e| e.to_string())?;
    eprintln!("[Ollama Client] Resolved chat URL: {}", chat_url);

    let req = ReworkRequest {
        model: model_name.to_string(),
        stream: true,
        think: false,
        options: ReworkOptions {
            temperature,
            top_p,
            seed,
            num_predict: max_tokens,
        },
        keep_alive: "10m".to_string(),
        messages: vec![
            ReworkMessage {
                role: "system".to_string(),
                content: "You rewrite text. Reply with ONLY the rewritten text — no preamble, no quotes, no explanations. Do not output any thinking or reasoning, reply directly with the rewrite.".to_string(),
            },
            ReworkMessage {
                role: "user".to_string(),
                content: format!("Instruction: {}\n\nText:\n{}", instruction, selection),
            },
        ],
    };

    let client = Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;

    let body_bytes = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    eprintln!("[Ollama Client] Sending request bytes: size={}", body_bytes.len());
    let response = client.post(chat_url)
        .body(body_bytes)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .map_err(|e| e.to_string())?;

    let status = response.status();
    eprintln!("[Ollama Client] Response received: status={}", status);

    if !status.is_success() {
        let err_body = response.text().unwrap_or_default();
        eprintln!("[Ollama Client] Error body received: {}", err_body);
        return Err(format!("Ollama returned error: HTTP {} - {}", status, err_body));
    }

    let mut reader = BufReader::new(response);
    let mut line_bytes = Vec::new();
    
    let mut final_stats = GenerationStats {
        prefill_ms: 0,
        prefill_tokens: 0,
        decode_tokens: 0,
        tok_per_s: 0.0,
    };

    eprintln!("[Ollama Client] Starting stream read loop...");
    loop {
        line_bytes.clear();
        let num_bytes = reader.read_until(b'\n', &mut line_bytes)
            .map_err(|e| format!("Failed to read stream: {}", e))?;
        if num_bytes == 0 {
            eprintln!("[Ollama Client] EOF reached");
            break; // EOF
        }

        if cancel_token.load(std::sync::atomic::Ordering::SeqCst) {
            eprintln!("[Ollama Client] Stream cancelled");
            return Err("cancelled".to_string());
        }

        let line_str = std::str::from_utf8(&line_bytes)
            .map_err(|e| format!("Invalid UTF-8 from stream: {}", e))?;
        let trimmed = line_str.trim();
        if trimmed.is_empty() {
            continue;
        }
        eprintln!("[Ollama Client] CHUNK: {}", trimmed);

        let chunk: OllamaChunk = serde_json::from_str(trimmed)
            .map_err(|e| format!("Failed to parse JSON chunk: {}", e))?;

        if let Some(msg) = chunk.message {
            let token = if let Some(ref content) = msg.content {
                if !content.is_empty() {
                    Some(content.as_str())
                } else {
                    msg.thinking.as_deref()
                }
            } else {
                msg.thinking.as_deref()
            };

            if let Some(t) = token {
                if !t.is_empty() {
                    on_token(t)?;
                }
            }
        }

        if chunk.done {
            eprintln!("[Ollama Client] Done flag received in chunk");
            let prefill_tokens = chunk.prompt_eval_count.unwrap_or(0);
            let decode_tokens = chunk.eval_count.unwrap_or(0);
            let prefill_ms = chunk.prompt_eval_duration.unwrap_or(0) / 1_000_000;
            let eval_duration_s = chunk.eval_duration.unwrap_or(0) as f64 / 1_000_000_000.0;
            let tok_per_s = if eval_duration_s > 0.0 {
                decode_tokens as f64 / eval_duration_s
            } else {
                0.0
            };

            final_stats = GenerationStats {
                prefill_ms,
                prefill_tokens,
                decode_tokens,
                tok_per_s,
            };
            break;
        }
    }

    Ok(final_stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{MockServer, Mock, ResponseTemplate};
    use wiremock::matchers::{method, path};
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    #[test]
    fn test_check_health_ok() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;
            
            Mock::given(method("GET"))
                .and(path("/api/tags"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "models": [
                        { "name": "qwen2.5:14b" }
                    ]
                })))
                .mount(&server)
                .await;

            let status = check_health(&server.uri(), true).unwrap();
            assert!(status.available);
            assert!(status.error.is_none());
        });
    }

    #[test]
    fn test_check_health_fail() {
        let status = check_health("http://127.0.0.1:54321", false).unwrap();
        assert!(!status.available);
        assert!(status.error.is_some());
    }

    #[test]
    fn test_list_models_ok() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            Mock::given(method("GET"))
                .and(path("/api/tags"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "models": [
                        { "name": "qwen2.5:0.5b" },
                        { "name": "llama3:8b" }
                    ]
                })))
                .mount(&server)
                .await;

            let models = list_models(&server.uri(), true).unwrap();
            assert_eq!(models, vec!["qwen2.5:0.5b".to_string(), "llama3:8b".to_string()]);
        });
    }

    #[test]
    fn test_list_models_empty() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            Mock::given(method("GET"))
                .and(path("/api/tags"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "models": []
                })))
                .mount(&server)
                .await;

            let models = list_models(&server.uri(), true).unwrap();
            assert!(models.is_empty());
        });
    }

    #[test]
    fn test_stream_rework_happy_path() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let body_chunk_1 = "{\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n";
            let body_chunk_2 = "{\"message\":{\"role\":\"assistant\",\"content\":\" world\"},\"done\":false}\n";
            let body_chunk_3 = "{\"done\":true,\"prompt_eval_count\":10,\"prompt_eval_duration\":50000000,\"eval_count\":20,\"eval_duration\":200000000}\n";

            let full_body = format!("{}{}{}", body_chunk_1, body_chunk_2, body_chunk_3);

            Mock::given(method("POST"))
                .and(path("/api/chat"))
                .respond_with(ResponseTemplate::new(200).set_body_string(full_body))
                .mount(&server)
                .await;

            let cancel_token = AtomicBool::new(false);
            let tokens = Arc::new(StdMutex::new(Vec::new()));
            let tokens_clone = tokens.clone();

            let stats = stream_rework(
                &server.uri(),
                true,
                "some-model",
                "rewrite",
                "hello text",
                0.3,
                0.9,
                42,
                256,
                &cancel_token,
                move |tok| {
                    tokens_clone.lock().unwrap().push(tok.to_string());
                    Ok(())
                }
            ).unwrap();

            let final_tokens = tokens.lock().unwrap();
            assert_eq!(final_tokens.len(), 2);
            assert_eq!(final_tokens[0], "hello");
            assert_eq!(final_tokens[1], " world");

            assert_eq!(stats.prefill_tokens, 10);
            assert_eq!(stats.decode_tokens, 20);
            assert_eq!(stats.prefill_ms, 50);
            assert_eq!(stats.tok_per_s, 100.0); // 20 tokens / 0.2 seconds = 100 tok/s
        });
    }

    #[test]
    fn test_stream_rework_cancellation() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let body_chunk_1 = "{\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n";
            let body_chunk_2 = "{\"message\":{\"role\":\"assistant\",\"content\":\" world\"},\"done\":false}\n";

            let full_body = format!("{}{}", body_chunk_1, body_chunk_2);

            Mock::given(method("POST"))
                .and(path("/api/chat"))
                .respond_with(ResponseTemplate::new(200).set_body_string(full_body))
                .mount(&server)
                .await;

            let cancel_token = AtomicBool::new(false);
            let cancel_token_ptr = &cancel_token;
            let tokens = Arc::new(StdMutex::new(Vec::new()));
            let tokens_clone = tokens.clone();

            let res = stream_rework(
                &server.uri(),
                true,
                "some-model",
                "rewrite",
                "hello text",
                0.3,
                0.9,
                42,
                256,
                cancel_token_ptr,
                move |tok| {
                    tokens_clone.lock().unwrap().push(tok.to_string());
                    cancel_token_ptr.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            );

            assert!(res.is_err());
            assert_eq!(res.unwrap_err(), "cancelled");

            let final_tokens = tokens.lock().unwrap();
            // Should have only received the first chunk before cancel triggered
            assert_eq!(final_tokens.len(), 1);
            assert_eq!(final_tokens[0], "hello");
        });
    }
}
