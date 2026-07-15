pub mod ollama;
pub mod llamacpp;

use serde::{Deserialize, Serialize};
use reqwest::Url;

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
        let host = url.host_str().ok_or_else(|| "URL has no host".to_string())?;
        
        // Loopback forms
        let is_loopback = host == "localhost" 
            || host == "127.0.0.1" 
            || host == "[::1]" 
            || host == "::1";
            
        if !is_loopback {
            return Err("Only loopback URLs (localhost, 127.0.0.1, [::1]) are allowed unless remote endpoints are explicitly enabled".to_string());
        }
    }
    
    Ok(url)
}
