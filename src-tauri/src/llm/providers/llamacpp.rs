use serde::{Deserialize, Serialize};
use reqwest::blocking::Client;
use std::time::Duration;
use std::io::{BufRead, BufReader};
use std::sync::atomic::AtomicBool;
use super::validate_provider_url;
use crate::llm::inference::GenerationStats;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LlamaCppStatus {
    pub available: bool,
    pub model: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
struct LlamaCppRequest {
    model: String,
    stream: bool,
    temperature: f64,
    top_p: f64,
    seed: u64,
    max_tokens: usize,
    messages: Vec<LlamaCppMessage>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LlamaCppMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct LlamaCppChunk {
    choices: Vec<LlamaCppChoice>,
}

#[derive(Debug, Deserialize)]
struct LlamaCppChoice {
    delta: LlamaCppDelta,
}

#[derive(Debug, Deserialize)]
struct LlamaCppDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LlamaCppProps {
    default_generation_settings: LlamaCppPropsSettings,
}

#[derive(Debug, Deserialize)]
struct LlamaCppPropsSettings {
    model: String,
}

/// Query llama.cpp server health and properties to check availability and loaded model name.
pub fn check_health(url_str: &str, allow_remote: bool) -> Result<LlamaCppStatus, String> {
    let url = validate_provider_url(url_str, allow_remote)?;
    
    // 1. Query /health
    let health_url = url.join("health").map_err(|e| e.to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
        
    let resp = match client.get(health_url).send() {
        Ok(r) => r,
        Err(e) => {
            return Ok(LlamaCppStatus {
                available: false,
                model: None,
                error: Some(format!("Failed to connect to llama.cpp server: {}", e)),
            });
        }
    };
    
    if !resp.status().is_success() {
        return Ok(LlamaCppStatus {
            available: false,
            model: None,
            error: Some(format!("llama.cpp server health check returned HTTP {}", resp.status())),
        });
    }

    // 2. Query /props to get model name
    let props_url = url.join("props").map_err(|e| e.to_string())?;
    let props_resp = match client.get(props_url).send() {
        Ok(r) => r,
        Err(e) => {
            return Ok(LlamaCppStatus {
                available: true,
                model: None,
                error: Some(format!("Server is online, but failed to fetch model properties: {}", e)),
            });
        }
    };

    if !props_resp.status().is_success() {
        return Ok(LlamaCppStatus {
            available: true,
            model: None,
            error: Some(format!("Server is online, but model properties check returned HTTP {}", props_resp.status())),
        });
    }

    let props_body = props_resp.text().map_err(|e| e.to_string())?;
    let props: LlamaCppProps = match serde_json::from_str(&props_body) {
        Ok(p) => p,
        Err(_) => {
            return Ok(LlamaCppStatus {
                available: true,
                model: Some("llama.cpp default model".to_string()),
                error: None,
            });
        }
    };

    Ok(LlamaCppStatus {
        available: true,
        model: Some(props.default_generation_settings.model),
        error: None,
    })
}

/// Stream text rework selection rewrite from llama.cpp v1/chat/completions SSE endpoint.
pub fn stream_rework<F>(
    url_str: &str,
    allow_remote: bool,
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
    let url = validate_provider_url(url_str, allow_remote)?;
    let chat_url = url.join("v1/chat/completions").map_err(|e| e.to_string())?;

    let req_body = LlamaCppRequest {
        model: "ignored-by-server".to_string(),
        stream: true,
        temperature,
        top_p,
        seed,
        max_tokens,
        messages: vec![
            LlamaCppMessage {
                role: "system".to_string(),
                content: "You rewrite text. Reply with ONLY the rewritten text — no preamble, no quotes, no explanations.".to_string(),
            },
            LlamaCppMessage {
                role: "user".to_string(),
                content: format!("Instruction: {}\n\nText:\n{}", instruction, selection),
            },
        ],
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::to_string(&req_body).map_err(|e| e.to_string())?;

    let response = client
        .post(chat_url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("Failed to send request to llama.cpp: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let err_body = response.text().unwrap_or_default();
        return Err(format!("llama.cpp returned error: HTTP {} - {}", status, err_body));
    }

    let start_time = std::time::Instant::now();
    let mut decode_tokens = 0;

    let mut reader = BufReader::new(response);
    let mut line_bytes = Vec::new();

    loop {
        line_bytes.clear();
        let num_bytes = reader.read_until(b'\n', &mut line_bytes)
            .map_err(|e| format!("Failed to read stream: {}", e))?;
        if num_bytes == 0 {
            break; // EOF
        }

        if cancel_token.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }

        let line_str = std::str::from_utf8(&line_bytes)
            .map_err(|e| format!("Invalid UTF-8 from stream: {}", e))?;
        let trimmed = line_str.trim();
        if trimmed.is_empty() {
            continue;
        }

        // SSE chunks start with "data: "
        if !trimmed.starts_with("data: ") {
            continue; // Tolerate comments or malformed lines
        }

        let data = &trimmed[6..].trim();
        if data == &"[DONE]" {
            break; // Finished
        }

        let chunk: LlamaCppChunk = match serde_json::from_str(data) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Llama.cpp Client] Failed to parse JSON chunk: {} data={:?}", e, data);
                continue;
            }
        };

        if let Some(choice) = chunk.choices.first() {
            if let Some(ref content) = choice.delta.content {
                if !content.is_empty() {
                    on_token(content)?;
                    decode_tokens += 1;
                }
            }
        }
    }

    let elapsed = start_time.elapsed();
    let tok_per_s = if elapsed.as_secs_f64() > 0.0 {
        decode_tokens as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };

    Ok(GenerationStats {
        prefill_ms: 0,
        prefill_tokens: 0,
        decode_tokens,
        tok_per_s,
    })
}

#[derive(Debug, Serialize)]
struct LlamaCppCompletionRequest<'a> {
    prompt: &'a str,
    stream: bool,
    n_predict: usize,
    temperature: f64,
    top_p: f64,
    seed: u64,
    repeat_penalty: f64,
    repeat_last_n: usize,
    dry_multiplier: f32,
    dry_base: f32,
    dry_allowed_length: u32,
    dry_penalty_last_n: i32,
}

#[derive(Debug, Deserialize)]
struct LlamaCppCompletionChunk {
    content: String,
    stop: bool,
}

/// Stream text completion from llama.cpp server's native /completion endpoint.
pub fn stream_completion<F>(
    url_str: &str,
    allow_remote: bool,
    prompt: &str,
    max_tokens: usize,
    temperature: f64,
    top_p: f64,
    seed: u64,
    dry_multiplier: f32,
    dry_base: f32,
    dry_allowed_length: u32,
    dry_penalty_last_n: i32,
    stop_sequences: &[String],
    cancel_token: &AtomicBool,
    mut on_token: F,
) -> Result<GenerationStats, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    use crate::llm::stream::{StreamPostProcessor, ProcessResult};

    let url = validate_provider_url(url_str, allow_remote)?;
    let completion_url = url.join("completion").map_err(|e| e.to_string())?;

    let req_body = LlamaCppCompletionRequest {
        prompt,
        stream: true,
        n_predict: max_tokens,
        temperature,
        top_p,
        seed,
        repeat_penalty: 1.15,
        repeat_last_n: 64,
        dry_multiplier,
        dry_base,
        dry_allowed_length,
        dry_penalty_last_n,
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::to_string(&req_body).map_err(|e| e.to_string())?;

    let response = client
        .post(completion_url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("Failed to send completion request to llama.cpp: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let err_body = response.text().unwrap_or_default();
        return Err(format!("llama.cpp completion returned error: HTTP {} - {}", status, err_body));
    }

    let start_time = std::time::Instant::now();
    let mut decode_tokens = 0;
    let mut post_processor = StreamPostProcessor::new(stop_sequences.to_vec());

    let mut reader = BufReader::new(response);
    let mut line_bytes = Vec::new();

    loop {
        line_bytes.clear();
        let num_bytes = reader.read_until(b'\n', &mut line_bytes)
            .map_err(|e| format!("Failed to read stream: {}", e))?;
        if num_bytes == 0 {
            break; // EOF
        }

        if cancel_token.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }

        let line_str = std::str::from_utf8(&line_bytes)
            .map_err(|e| format!("Invalid UTF-8 from stream: {}", e))?;
        let trimmed = line_str.trim();
        if trimmed.is_empty() {
            continue;
        }

        if !trimmed.starts_with("data: ") {
            continue; // Tolerate comments or malformed lines
        }

        let data = &trimmed[6..].trim();
        let chunk: LlamaCppCompletionChunk = match serde_json::from_str(data) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Llama.cpp Completion] Failed to parse JSON chunk: {} data={:?}", e, data);
                continue;
            }
        };

        if !chunk.content.is_empty() {
            match post_processor.push(&chunk.content) {
                ProcessResult::Emit(token) => {
                    on_token(&token)?;
                }
                ProcessResult::Stop(token) => {
                    if !token.is_empty() {
                        on_token(&token)?;
                    }
                    break;
                }
                ProcessResult::Continue => {}
            }
            decode_tokens += 1;
        }

        if chunk.stop {
            break;
        }
    }

    let elapsed = start_time.elapsed();
    let tok_per_s = if elapsed.as_secs_f64() > 0.0 {
        decode_tokens as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };

    Ok(GenerationStats {
        prefill_ms: 0,
        prefill_tokens: 0,
        decode_tokens,
        tok_per_s,
    })
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
                .and(path("/health"))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server)
                .await;

            Mock::given(method("GET"))
                .and(path("/props"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "default_generation_settings": {
                        "model": "meta-llama-3-8b-instruct.Q4_K_M.gguf"
                    }
                })))
                .mount(&server)
                .await;

            let status = check_health(&server.uri(), true).unwrap();
            assert!(status.available);
            assert_eq!(status.model, Some("meta-llama-3-8b-instruct.Q4_K_M.gguf".to_string()));
            assert!(status.error.is_none());
        });
    }

    #[test]
    fn test_check_health_fail() {
        let status = check_health("http://127.0.0.1:54323", false).unwrap();
        assert!(!status.available);
        assert!(status.error.is_some());
    }

    #[test]
    fn test_stream_rework_happy_path() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let chunk1 = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
            let chunk2 = "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n";
            let chunk3 = "data: [DONE]\n\n";
            let full_body = format!("{}{}{}", chunk1, chunk2, chunk3);

            Mock::given(method("POST"))
                .and(path("/v1/chat/completions"))
                .respond_with(ResponseTemplate::new(200)
                    .set_body_string(full_body)
                    .insert_header("content-type", "text/event-stream"))
                .mount(&server)
                .await;

            let cancel = AtomicBool::new(false);
            let tokens = Arc::new(StdMutex::new(Vec::new()));
            
            let tokens_clone = tokens.clone();
            let stats = stream_rework(
                &server.uri(),
                true,
                "make detailed",
                "original text",
                0.3,
                0.9,
                42,
                128,
                &cancel,
                move |tok| {
                    tokens_clone.lock().unwrap().push(tok.to_string());
                    Ok(())
                }
            ).unwrap();

            assert_eq!(stats.decode_tokens, 2);
            let accumulated = tokens.lock().unwrap().join("");
            assert_eq!(accumulated, "Hello world");
        });
    }

    #[test]
    fn test_stream_rework_cancellation() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let chunk1 = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
            let chunk2 = "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n";
            let full_body = format!("{}{}", chunk1, chunk2);

            Mock::given(method("POST"))
                .and(path("/v1/chat/completions"))
                .respond_with(ResponseTemplate::new(200)
                    .set_body_string(full_body)
                    .insert_header("content-type", "text/event-stream"))
                .mount(&server)
                .await;

            let cancel = AtomicBool::new(true); // Pre-cancelled
            let res = stream_rework(
                &server.uri(),
                true,
                "make detailed",
                "original text",
                0.3,
                0.9,
                42,
                128,
                &cancel,
                |_tok| Ok(())
            );

            assert!(res.is_err());
            assert_eq!(res.unwrap_err(), "cancelled");
        });
    }

    #[test]
    fn test_stream_completion_happy_path() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let chunk1 = "data: {\"content\":\"Hello\",\"stop\":false}\n\n";
            let chunk2 = "data: {\"content\":\" world\",\"stop\":false}\n\n";
            let chunk3 = "data: {\"content\":\"\\n\",\"stop\":false}\n\n";
            let full_body = format!("{}{}{}", chunk1, chunk2, chunk3);

            Mock::given(method("POST"))
                .and(path("/completion"))
                .respond_with(ResponseTemplate::new(200)
                    .set_body_string(full_body)
                    .insert_header("content-type", "text/event-stream"))
                .mount(&server)
                .await;

            let cancel = AtomicBool::new(false);
            let tokens = Arc::new(StdMutex::new(Vec::new()));
            
            let tokens_clone = tokens.clone();
            let stats = stream_completion(
                &server.uri(),
                true,
                "The prompt",
                80,
                0.7,
                0.9,
                42,
                0.8,
                1.75,
                2,
                -1,
                &["\n".to_string()],
                &cancel,
                move |tok| {
                    tokens_clone.lock().unwrap().push(tok.to_string());
                    Ok(())
                }
            ).unwrap();

            assert_eq!(stats.decode_tokens, 2);
            let accumulated = tokens.lock().unwrap().join("");
            assert_eq!(accumulated, "Hello world");
        });
    }

    #[test]
    fn test_stream_completion_cancellation() {
        tauri::async_runtime::block_on(async {
            let server = MockServer::start().await;

            let chunk1 = "data: {\"content\":\"Hello\",\"stop\":false}\n\n";
            let full_body = format!("{}", chunk1);

            Mock::given(method("POST"))
                .and(path("/completion"))
                .respond_with(ResponseTemplate::new(200)
                    .set_body_string(full_body)
                    .insert_header("content-type", "text/event-stream"))
                .mount(&server)
                .await;

            let cancel = AtomicBool::new(true); // Pre-cancelled
            let res = stream_completion(
                &server.uri(),
                true,
                "The prompt",
                80,
                0.7,
                0.9,
                42,
                0.8,
                1.75,
                2,
                -1,
                &["\n".to_string()],
                &cancel,
                |_tok| Ok(())
            );

            assert!(res.is_err());
            assert_eq!(res.unwrap_err(), "cancelled");
        });
    }
}
