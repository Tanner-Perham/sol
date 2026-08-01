
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use sha2::{Sha256, Digest};

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
    pub status: String, // "downloading", "completed", "error", "cancelled", "paused"
    pub error: Option<String>,
}

/// Download state for tracking active downloads
#[derive(Default)]
pub struct DownloadState {
    /// Map of model_id -> whether download is cancelled
    pub cancelled: HashMap<String, bool>,
    /// Map of model_id -> whether download is paused
    pub paused: HashMap<String, bool>,
    /// Map of model_id -> whether download is in flight
    pub in_flight: HashMap<String, bool>,
}

pub type SharedDownloadState = Arc<Mutex<DownloadState>>;

pub fn new_download_state() -> SharedDownloadState {
    Arc::new(Mutex::new(DownloadState::default()))
}

/// Compute SHA-256 hash of a file
pub fn compute_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536]; // 64KB chunks
    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
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
    workspace: &Path,
    model_id: &str,
    app_handle: &tauri::AppHandle,
    download_state: &SharedDownloadState,
) -> Result<(), String> {
    let result = download_model_inner(workspace, model_id, app_handle, download_state);
    if let Err(ref e) = result {
        let was_cancelled = {
            let state = lock!(download_state);
            *state.cancelled.get(model_id).unwrap_or(&false)
        };
        let was_paused = {
            let state = lock!(download_state);
            *state.paused.get(model_id).unwrap_or(&false)
        };
        
        if was_cancelled {
            let _ = app_handle.emit(
                "model-download-progress",
                DownloadProgress {
                    model_id: model_id.to_string(),
                    file_name: "".to_string(),
                    file_index: 0,
                    total_files: 0,
                    bytes_downloaded: 0,
                    total_bytes: 0,
                    status: "cancelled".to_string(),
                    error: None,
                },
            );
        } else if was_paused {
            let _ = app_handle.emit(
                "model-download-progress",
                DownloadProgress {
                    model_id: model_id.to_string(),
                    file_name: "".to_string(),
                    file_index: 0,
                    total_files: 0,
                    bytes_downloaded: 0,
                    total_bytes: 0,
                    status: "paused".to_string(),
                    error: None,
                },
            );
        } else {
            let _ = app_handle.emit(
                "model-download-progress",
                DownloadProgress {
                    model_id: model_id.to_string(),
                    file_name: "".to_string(),
                    file_index: 0,
                    total_files: 0,
                    bytes_downloaded: 0,
                    total_bytes: 0,
                    status: "error".to_string(),
                    error: Some(e.clone()),
                },
            );
        }
    }
    result
}

fn download_model_inner(
    workspace: &Path,
    model_id: &str,
    app_handle: &tauri::AppHandle,
    download_state: &SharedDownloadState,
) -> Result<(), String> {
    println!("[LLM] Starting download for model: {}", model_id);

    let info =
        registry::get_model_info(model_id).ok_or_else(|| format!("Unknown model: {}", model_id))?;

    println!("[LLM] Model info: {:?}", info.repo_id);

    let model_dir = models_dir(workspace).join(model_id);
    println!("[LLM] Model directory: {:?}", model_dir);
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    // Reset cancelled/paused state
    {
        let mut state = lock!(download_state);
        state.cancelled.insert(model_id.to_string(), false);
        state.paused.insert(model_id.to_string(), false);
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("sol-app/0.1")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(None)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let total_files = info.files.len();

    for (idx, file) in info.files.iter().enumerate() {
        // Check if cancelled or paused
        {
            let state = lock!(download_state);
            if *state.cancelled.get(model_id).unwrap_or(&false) {
                return Err("Download cancelled".to_string());
            }
            if *state.paused.get(model_id).unwrap_or(&false) {
                return Err("Download paused".to_string());
            }
        }

        let file_name = &file.name;
        let effective_repo_id = file.repo_id.as_ref().unwrap_or(&info.repo_id);
        let url = hf_download_url(effective_repo_id, file_name);
        let dest_path = model_dir.join(file_name);
        let part_path = model_dir.join(format!("{}.part", file_name));

        // Skip downloading if it already exists and is fully valid
        let mut file_ok = false;
        if dest_path.exists() {
            if let Ok(metadata) = std::fs::metadata(&dest_path) {
                if metadata.len() == file.size {
                    file_ok = true;
                    if let Some(ref expected_sha) = file.sha256 {
                        if let Ok(computed_sha) = compute_sha256(&dest_path) {
                            if computed_sha != *expected_sha {
                                file_ok = false;
                            }
                        } else {
                            file_ok = false;
                        }
                    }
                }
            }
        }

        if file_ok {
            println!("[LLM] File {} already exists and is valid, skipping", file_name);
            continue;
        }

        println!(
            "[LLM] Downloading file {}/{}: {}",
            idx + 1,
            total_files,
            file_name
        );
        println!("[LLM] URL: {}", url);

        // Range resume logic
        let mut downloaded: u64 = 0;
        let mut open_options = std::fs::OpenOptions::new();
        
        if part_path.exists() {
            if let Ok(metadata) = std::fs::metadata(&part_path) {
                downloaded = metadata.len();
            }
        }

        let response = if downloaded > 0 {
            // Try sending a Range request
            let range_header = format!("bytes={}-", downloaded);
            let req = client.get(&url).header(reqwest::header::RANGE, range_header);
            match req.send() {
                Ok(resp) if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT => {
                    println!("[LLM] Resuming download from byte {}", downloaded);
                    open_options.append(true);
                    resp
                }
                _ => {
                    // Fallback: download from scratch
                    println!("[LLM] Range request not supported or failed, downloading from scratch");
                    downloaded = 0;
                    open_options.write(true).truncate(true).create(true);
                    client.get(&url).send().map_err(|e| {
                        let _ = std::fs::remove_file(&part_path);
                        format!("Failed to start download for {}: {}", file_name, e)
                    })?
                }
            }
        } else {
            open_options.write(true).truncate(true).create(true);
            client.get(&url).send().map_err(|e| {
                let _ = std::fs::remove_file(&part_path);
                format!("Failed to start download for {}: {}", file_name, e)
            })?
        };

        if !response.status().is_success() {
            let status = response.status();
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("HTTP error {} downloading {}", status, file_name));
        }

        let total_size = response.content_length().unwrap_or(0) + downloaded;

        // Open/create the file
        let mut output_file = open_options.open(&part_path)
            .map_err(|e| format!("Failed to open file {}.part: {}", file_name, e))?;

        let mut last_emit_time = std::time::Instant::now();
        let mut reader = response;
        let mut buffer = [0u8; 65536]; // 64KB chunks

        loop {
            // Check for cancellation or pause
            {
                let state = lock!(download_state);
                if *state.cancelled.get(model_id).unwrap_or(&false) {
                    drop(output_file);
                    let _ = std::fs::remove_file(&part_path);
                    return Err("Download cancelled".to_string());
                }
                if *state.paused.get(model_id).unwrap_or(&false) {
                    drop(output_file);
                    return Err("Download paused".to_string());
                }
            }

            let bytes_read = match reader.read(&mut buffer) {
                Ok(n) => n,
                Err(e) => {
                    drop(output_file);
                    return Err(format!("Failed to read data: {}", e));
                }
            };

            if bytes_read == 0 {
                break; // EOF
            }

            if let Err(e) = output_file.write_all(&buffer[..bytes_read]) {
                drop(output_file);
                return Err(format!("Failed to write data: {}", e));
            }

            downloaded += bytes_read as u64;

            // Emit progress every 100ms or so
            if last_emit_time.elapsed().as_millis() >= 100 {
                let _ = app_handle.emit(
                    "model-download-progress",
                    DownloadProgress {
                        model_id: model_id.to_string(),
                        file_name: file_name.to_string(),
                        file_index: idx,
                        total_files,
                        bytes_downloaded: downloaded,
                        total_bytes: total_size,
                        status: "downloading".to_string(),
                        error: None,
                    },
                );
                last_emit_time = std::time::Instant::now();
            }
        }

        output_file
            .flush()
            .map_err(|e| {
                let _ = std::fs::remove_file(&part_path);
                format!("Failed to flush file: {}", e)
            })?;
        drop(output_file);

        // Verify size
        let metadata = std::fs::metadata(&part_path)
            .map_err(|e| {
                let _ = std::fs::remove_file(&part_path);
                format!("Failed to read metadata of downloaded file: {}", e)
            })?;
        if metadata.len() != file.size {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("Downloaded file size mismatch for {}: expected {}, got {}", file_name, file.size, metadata.len()));
        }

        // Verify SHA-256 if expected
        if let Some(ref expected_sha) = file.sha256 {
            println!("[LLM] Verifying SHA-256 for {}...", file_name);
            let computed_sha = compute_sha256(&part_path)
                .map_err(|e| {
                    let _ = std::fs::remove_file(&part_path);
                    format!("Failed to compute SHA-256 for {}: {}", file_name, e)
                })?;
            if computed_sha != *expected_sha {
                let _ = std::fs::remove_file(&part_path);
                return Err(format!("SHA-256 checksum mismatch for {}: expected {}, got {}", file_name, expected_sha, computed_sha));
            }
            println!("[LLM] SHA-256 verification successful!");
        }

        // Rename .part to final file
        std::fs::rename(&part_path, &dest_path)
            .map_err(|e| {
                let _ = std::fs::remove_file(&part_path);
                format!("Failed to rename part file to final destination: {}", e)
            })?;

        println!("[LLM] File {} complete ({} bytes)", file_name, downloaded);
    }

    // Emit completion
    let _ = app_handle.emit(
        "model-download-progress",
        DownloadProgress {
            model_id: model_id.to_string(),
            file_name: "".to_string(),
            file_index: total_files,
            total_files,
            bytes_downloaded: info.size_bytes,
            total_bytes: info.size_bytes,
            status: "completed".to_string(),
            error: None,
        },
    );

    println!("[LLM] Download complete for model: {}", model_id);

    Ok(())
}

/// Cancel a model download
pub fn cancel_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = lock!(download_state);
    state.cancelled.insert(model_id.to_string(), true);
}

/// Pause a model download
pub fn pause_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = lock!(download_state);
    state.paused.insert(model_id.to_string(), true);
}

/// Resume a model download
pub fn resume_download(model_id: &str, download_state: &SharedDownloadState) {
    let mut state = lock!(download_state);
    state.paused.insert(model_id.to_string(), false);
}

/// Delete a downloaded model
pub fn delete_model(workspace: &Path, model_id: &str) -> Result<(), String> {
    let model_dir = models_dir(workspace).join(model_id);
    if model_dir.exists() {
        std::fs::remove_dir_all(&model_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
