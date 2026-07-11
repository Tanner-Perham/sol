use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

use super::{models_dir, registry};

/// Download progress event
#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub file_name: String,
    pub file_index: usize,
    pub total_files: usize,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub status: String, // "downloading", "completed", "error", "cancelled"
    pub error: Option<String>,
}

/// Download state for tracking active downloads
#[derive(Default)]
pub struct DownloadState {
    /// Map of model_id -> whether download is cancelled
    pub cancelled: HashMap<String, bool>,
    /// Map of model_id -> whether download is paused
    pub paused: HashMap<String, bool>,
}

pub type SharedDownloadState = Arc<Mutex<DownloadState>>;

pub fn new_download_state() -> SharedDownloadState {
    Arc::new(Mutex::new(DownloadState::default()))
}

/// Build HuggingFace download URL for a file
fn hf_download_url(repo_id: &str, filename: &str) -> String {
    format!(
        "https://huggingface.co/{}/resolve/main/{}",
        repo_id, filename
    )
}

/// Download a model from HuggingFace Hub using direct HTTP requests
pub fn download_model(
    workspace: &PathBuf,
    model_id: &str,
    app_handle: &tauri::AppHandle,
    download_state: &SharedDownloadState,
) -> Result<(), String> {
    println!("[LLM] Starting download for model: {}", model_id);

    let info = registry::get_model_info(model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    println!("[LLM] Model info: {:?}", info.repo_id);

    let model_dir = models_dir(workspace).join(model_id);
    println!("[LLM] Model directory: {:?}", model_dir);
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    // Reset cancelled/paused state
    {
        let mut state = download_state.lock().unwrap();
        state.cancelled.insert(model_id.to_string(), false);
        state.paused.insert(model_id.to_string(), false);
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("sol-app/0.1")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let total_files = info.files.len();

    for (idx, file) in info.files.iter().enumerate() {
        // Check if cancelled
        {
            let state = download_state.lock().unwrap();
            if *state.cancelled.get(model_id).unwrap_or(&false) {
                let _ = app_handle.emit("model-download-progress", DownloadProgress {
                    model_id: model_id.to_string(),
                    file_name: file.clone(),
                    file_index: idx,
                    total_files,
                    bytes_downloaded: 0,
                    total_bytes: 0,
                    status: "cancelled".to_string(),
                    error: None,
                });
                return Err("Download cancelled".to_string());
            }
        }

        // Wait while paused
        loop {
            let is_paused = {
                let state = download_state.lock().unwrap();
                *state.paused.get(model_id).unwrap_or(&false)
            };
            if !is_paused {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));

            // Check for cancel while paused
            let is_cancelled = {
                let state = download_state.lock().unwrap();
                *state.cancelled.get(model_id).unwrap_or(&false)
            };
            if is_cancelled {
                return Err("Download cancelled".to_string());
            }
        }

        let file_name = file.split('/').last().unwrap_or(file);
        let url = hf_download_url(&info.repo_id, file);
        let dest_path = model_dir.join(file_name);

        println!("[LLM] Downloading file {}/{}: {}", idx + 1, total_files, file);
        println!("[LLM] URL: {}", url);

        // Start the download
        let response = client.get(&url)
            .send()
            .map_err(|e| {
                println!("[LLM] ERROR starting download: {}", e);
                format!("Failed to start download for {}: {}", file, e)
            })?;

        if !response.status().is_success() {
            let status = response.status();
            println!("[LLM] ERROR: HTTP {}", status);
            return Err(format!("HTTP error {} downloading {}", status, file));
        }

        let total_size = response.content_length().unwrap_or(0);
        println!("[LLM] File size: {} bytes", total_size);

        // Create output file
        let mut output_file = std::fs::File::create(&dest_path)
            .map_err(|e| format!("Failed to create file {}: {}", file_name, e))?;

        // Download with progress
        let mut downloaded: u64 = 0;
        let mut last_emit_time = std::time::Instant::now();

        // Read in chunks
        let mut reader = response;
        let mut buffer = [0u8; 65536]; // 64KB chunks

        loop {
            // Check for cancellation
            {
                let state = download_state.lock().unwrap();
                if *state.cancelled.get(model_id).unwrap_or(&false) {
                    drop(output_file);
                    let _ = std::fs::remove_file(&dest_path);
                    return Err("Download cancelled".to_string());
                }
            }

            // Check for pause
            loop {
                let is_paused = {
                    let state = download_state.lock().unwrap();
                    *state.paused.get(model_id).unwrap_or(&false)
                };
                if !is_paused {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            use std::io::Read;
            let bytes_read = reader.read(&mut buffer)
                .map_err(|e| format!("Failed to read data: {}", e))?;

            if bytes_read == 0 {
                break; // EOF
            }

            output_file.write_all(&buffer[..bytes_read])
                .map_err(|e| format!("Failed to write data: {}", e))?;

            downloaded += bytes_read as u64;

            // Emit progress every 100ms or so
            if last_emit_time.elapsed().as_millis() >= 100 {
                let _ = app_handle.emit("model-download-progress", DownloadProgress {
                    model_id: model_id.to_string(),
                    file_name: file_name.to_string(),
                    file_index: idx,
                    total_files,
                    bytes_downloaded: downloaded,
                    total_bytes: total_size,
                    status: "downloading".to_string(),
                    error: None,
                });
                last_emit_time = std::time::Instant::now();
            }
        }

        output_file.flush().map_err(|e| format!("Failed to flush file: {}", e))?;
        println!("[LLM] File {} complete ({} bytes)", file_name, downloaded);
    }

    // Emit completion
    let _ = app_handle.emit("model-download-progress", DownloadProgress {
        model_id: model_id.to_string(),
        file_name: "".to_string(),
        file_index: total_files,
        total_files,
        bytes_downloaded: info.size_bytes,
        total_bytes: info.size_bytes,
        status: "completed".to_string(),
        error: None,
    });

    println!("[LLM] Download complete for model: {}", model_id);

    Ok(())
}

/// Cancel a model download
pub fn cancel_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = download_state.lock().unwrap();
    state.cancelled.insert(model_id.to_string(), true);
}

/// Pause a model download
pub fn pause_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = download_state.lock().unwrap();
    state.paused.insert(model_id.to_string(), true);
}

/// Resume a model download
pub fn resume_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = download_state.lock().unwrap();
    state.paused.insert(model_id.to_string(), false);
}

/// Delete a downloaded model
pub fn delete_model(workspace: &PathBuf, model_id: &str) -> Result<(), String> {
    let model_dir = models_dir(workspace).join(model_id);
    if model_dir.exists() {
        std::fs::remove_dir_all(&model_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
