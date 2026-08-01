pub mod llamacpp;
pub mod ollama;

use reqwest::Url;
use serde::{Deserialize, Serialize};

/// IMPORTANT ARCHITECTURAL INVARIANT:
/// StreamPostProcessor (defined in llm/stream.rs) is the new "reload" annotation.
/// All three backends (Builtin, Ollama, LlamaCpp) must route token deltas through it.
/// The leading-whitespace trim and period-stop heuristic live there and nowhere else.
/// Any future backend added without this will exhibit the exact bugs that were
/// diagnosed and fixed in the Candle path.

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub enum CompletionBackend {
    #[default]
    Builtin,
    LlamaCpp,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub enum ReworkBackend {
    #[default]
    Builtin,
    Ollama,
    LlamaCpp,
}

/// Validate if the URL is correct and handles loopback policy.
pub fn validate_provider_url(url_str: &str, allow_remote: bool) -> Result<Url, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {}", e))?;

    // Check scheme is http or https
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("URL scheme must be http or https".to_string());
    }

    if !allow_remote {
        let host = url
            .host_str()
            .ok_or_else(|| "URL has no host".to_string())?;

        // Loopback forms
        let is_loopback =
            host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1";

        if !is_loopback {
            return Err("Only loopback URLs (localhost, 127.0.0.1, [::1]) are allowed unless remote endpoints are explicitly enabled".to_string());
        }
    }

    Ok(url)
}

/// Translate connection failures or model errors into user-friendly diagnostic guidance.
pub fn map_provider_error(err: &str, backend: &str, model_name: Option<&str>) -> String {
    let lower = err.to_lowercase();
    if lower.contains("connection refused")
        || lower.contains("connect error")
        || lower.contains("dns error")
        || lower.contains("unreachable")
        || lower.contains("timed out")
        || lower.contains("failed to connect")
    {
        match backend {
            "Ollama" => "Ollama is not running. Start it with `ollama serve`.".to_string(),
            "LlamaCpp" => "llama-server is not running.".to_string(),
            _ => err.to_string(),
        }
    } else if backend == "Ollama"
        && (lower.contains("not found")
            || lower.contains("does not exist")
            || lower.contains("404"))
    {
        let name = model_name.unwrap_or("selected model");
        format!(
            "Model '{}' is not available. Pull it with `ollama pull {}`.",
            name, name
        )
    } else if backend == "LlamaCpp" && (lower.contains("loading") || lower.contains("503")) {
        "llama-server is still loading the model. Try again in a moment.".to_string()
    } else {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_url_validation() {
        assert!(validate_provider_url("http://localhost:11434", false).is_ok());
        assert!(validate_provider_url("http://127.0.0.1:11434", false).is_ok());
        assert!(validate_provider_url("http://[::1]:11434", false).is_ok());
        assert!(validate_provider_url("http://example.com:11434", false).is_err());
        assert!(validate_provider_url("http://example.com:11434", true).is_ok());
    }

    #[test]
    fn test_map_provider_error() {
        assert_eq!(
            map_provider_error("connection refused", "Ollama", None),
            "Ollama is not running. Start it with `ollama serve`."
        );
        assert_eq!(
            map_provider_error(
                "Failed to connect to llama.cpp server: connect error",
                "LlamaCpp",
                None
            ),
            "llama-server is not running."
        );
        assert_eq!(
            map_provider_error("model qwen not found", "Ollama", Some("qwen")),
            "Model 'qwen' is not available. Pull it with `ollama pull qwen`."
        );
        assert_eq!(
            map_provider_error("HTTP status 503 Service Unavailable", "LlamaCpp", None),
            "llama-server is still loading the model. Try again in a moment."
        );
        assert_eq!(
            map_provider_error("some random error", "Ollama", None),
            "some random error"
        );
    }
}
