use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod llm;
use llm::{LlmConfig, ModelStatus, ModelWithStatus};

struct WorkspaceState {
    path: Mutex<PathBuf>,
    watcher: Mutex<RecommendedWatcher>,
    download_state: llm::download::SharedDownloadState,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

fn build_tree(dir: &Path, base: &Path) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    if !dir.exists() {
        return Ok(nodes);
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if name.is_empty() {
            continue;
        }

        let relative_path = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_str()
            .unwrap_or("")
            .to_string();

        let is_dir = path.is_dir();
        let mut children = Vec::new();
        if is_dir {
            children = build_tree(&path, base)?;
            children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
        }

        nodes.push(FileNode {
            name,
            path: relative_path,
            is_dir,
            children,
        });
    }

    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

fn resolve_safe_path(workspace: &Path, user_path: &str) -> Result<PathBuf, String> {
    let user_path = Path::new(user_path);
    if user_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    for component in user_path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Path traversal detected: '..' is not allowed".to_string());
            }
            _ => {}
        }
    }

    let joined = workspace.join(user_path);
    
    // Find the closest existing ancestor
    let mut ancestor = joined.as_path();
    let mut remaining = Vec::new();
    while !ancestor.exists() {
        if let Some(parent) = ancestor.parent() {
            if let Some(file_name) = ancestor.file_name() {
                remaining.push(file_name);
            }
            ancestor = parent;
        } else {
            break;
        }
    }
    
    // Canonicalize the ancestor (which exists)
    let canonical_ancestor = std::fs::canonicalize(ancestor)
        .map_err(|e| format!("Failed to canonicalize ancestor path: {}", e))?;
    
    // Canonicalize the workspace path to compare
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|e| format!("Failed to canonicalize workspace path: {}", e))?;
        
    // Check if the canonicalized ancestor starts with the canonicalized workspace
    if !canonical_ancestor.starts_with(&canonical_workspace) {
        return Err("Path traversal detected: path is outside the workspace".to_string());
    }
    
    // Reconstruct the full canonical path by joining the remaining components onto the canonical ancestor
    let mut final_path = canonical_ancestor;
    for part in remaining.into_iter().rev() {
        // Double check that each part is a normal component (no ".." or similar)
        let part_path = Path::new(part);
        for component in part_path.components() {
            match component {
                std::path::Component::Normal(_) => {}
                _ => return Err("Invalid path component in new file/directory path".to_string()),
            }
        }
        final_path.push(part);
    }
    
    Ok(final_path)
}

#[tauri::command]
fn read_markdown_file(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<String, String> {
    let workspace = state.path.lock().unwrap();
    let resolved = resolve_safe_path(&workspace, &path)?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_markdown_file(path: String, content: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let workspace = state.path.lock().unwrap();
    let resolved = resolve_safe_path(&workspace, &path)?;
    fs::write(&resolved, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workspace_path(state: tauri::State<'_, WorkspaceState>) -> String {
    state.path.lock().unwrap().to_string_lossy().into_owned()
}

#[tauri::command]
fn list_workspace_files(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<String>, String> {
    let workspace = state.path.lock().unwrap();
    let entries = fs::read_dir(&*workspace).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        files.push(name.to_string());
                    }
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
fn create_markdown_file(
    name: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let name_clean = if name.ends_with(".md") {
        name
    } else {
        format!("{}.md", name)
    };
    let workspace = state.path.lock().unwrap();
    let path = resolve_safe_path(&workspace, &name_clean)?;
    if path.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Failed to convert path to string".to_string())
}

#[tauri::command]
fn get_file_tree(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<FileNode>, String> {
    let workspace = state.path.lock().unwrap();
    build_tree(&workspace, &workspace)
}

#[tauri::command]
fn create_directory(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let workspace = state.path.lock().unwrap();
    let full_path = resolve_safe_path(&workspace, &path)?;
    if full_path.exists() {
        return Err("Directory or file already exists".to_string());
    }
    fs::create_dir_all(&full_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn select_directory() -> Option<String> {
    rfd::AsyncFileDialog::new().pick_folder().await.map(|p| {
        let path = p.path().to_path_buf();
        std::fs::canonicalize(&path)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    })
}

#[tauri::command]
fn set_workspace_path(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<FileNode>, String> {
    let new_path = std::fs::canonicalize(PathBuf::from(&path)).map_err(|e| e.to_string())?;
    if !new_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    // Allow in asset protocol scope
    let _ = app.asset_protocol_scope().allow_directory(&new_path, true);

    let mut path_lock = state.path.lock().unwrap();
    let old_path = path_lock.clone();
    *path_lock = new_path.clone();

    let mut watcher_lock = state.watcher.lock().unwrap();
    let _ = watcher_lock.unwatch(&old_path);
    watcher_lock
        .watch(&new_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    build_tree(&new_path, &new_path)
}

#[tauri::command]
fn read_settings(state: tauri::State<'_, WorkspaceState>) -> Result<String, String> {
    let workspace = state.path.lock().unwrap();
    let settings_dir = workspace.join(".sol");
    let settings_file = settings_dir.join("settings.json");
    if !settings_file.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&settings_file).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_settings(
    settings_json: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let workspace = state.path.lock().unwrap();
    let settings_dir = workspace.join(".sol");
    if !settings_dir.exists() {
        fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
    }
    let settings_file = settings_dir.join("settings.json");
    fs::write(&settings_file, settings_json).map_err(|e| e.to_string())
}

// ============================================================================
// LLM / Model Management Commands
// ============================================================================

/// Get list of available models with their status
#[tauri::command]
fn get_models(state: tauri::State<'_, WorkspaceState>) -> Vec<ModelWithStatus> {
    let workspace = state.path.lock().unwrap().clone();
    let config = LlmConfig::load(&workspace);

    llm::registry::get_available_models()
        .into_iter()
        .map(|info| {
            let is_downloaded = llm::is_model_downloaded(&workspace, &info.id);
            let is_active = config.active_model_id.as_ref() == Some(&info.id);

            let status = if is_active && is_downloaded {
                ModelStatus::Active
            } else if is_downloaded {
                ModelStatus::Downloaded
            } else {
                ModelStatus::NotDownloaded
            };

            ModelWithStatus { info, status }
        })
        .collect()
}

/// Get the currently active model ID
#[tauri::command]
fn get_active_model(state: tauri::State<'_, WorkspaceState>) -> Option<String> {
    let workspace = state.path.lock().unwrap().clone();
    let config = LlmConfig::load(&workspace);
    config.active_model_id
}

/// Set the active model
#[tauri::command]
fn set_active_model(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let workspace = state.path.lock().unwrap().clone();

    if !llm::is_model_downloaded(&workspace, &model_id) {
        return Err("Model not downloaded".to_string());
    }

    let mut config = LlmConfig::load(&workspace);
    config.active_model_id = Some(model_id);
    config.save(&workspace)
}

/// Start downloading a model
#[tauri::command]
fn start_model_download(
    model_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let workspace = state.path.lock().unwrap().clone();
    let download_state = state.download_state.clone();

    // Check and set in_flight atomically
    {
        let mut ds = download_state.lock().unwrap();
        if *ds.in_flight.get(&model_id).unwrap_or(&false) {
            return Err("Download already in progress".to_string());
        }
        ds.in_flight.insert(model_id.clone(), true);
    }

    // Spawn download in background thread
    std::thread::spawn(move || {
        let result = llm::download::download_model(&workspace, &model_id, &app, &download_state);
        
        // Reset in_flight state
        {
            let mut ds = download_state.lock().unwrap();
            ds.in_flight.insert(model_id.clone(), false);
        }

        if let Err(e) = result {
            let _ = app.emit(
                "model-download-progress",
                llm::download::DownloadProgress {
                    model_id: model_id.clone(),
                    file_name: "".to_string(),
                    file_index: 0,
                    total_files: 0,
                    bytes_downloaded: 0,
                    total_bytes: 0,
                    status: "error".to_string(),
                    error: Some(e),
                },
            );
        }
    });

    Ok(())
}

/// Pause a model download
#[tauri::command]
fn pause_model_download(model_id: String, state: tauri::State<'_, WorkspaceState>) {
    llm::download::pause_download(&model_id, &state.download_state);
}

/// Resume a model download
#[tauri::command]
fn resume_model_download(model_id: String, state: tauri::State<'_, WorkspaceState>) {
    llm::download::resume_download(&model_id, &state.download_state);
}

/// Cancel a model download
#[tauri::command]
fn cancel_model_download(model_id: String, state: tauri::State<'_, WorkspaceState>) {
    llm::download::cancel_download(&model_id, &state.download_state);
}

/// Delete a downloaded model
#[tauri::command]
fn delete_model(model_id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let workspace = state.path.lock().unwrap().clone();

    // If this was the active model, clear it
    let mut config = LlmConfig::load(&workspace);
    if config.active_model_id.as_ref() == Some(&model_id) {
        config.active_model_id = None;
        config.save(&workspace)?;
    }

    llm::download::delete_model(&workspace, &model_id)
}

/// Generate a topic name using the active LLM
#[tauri::command]
fn generate_topic_name(
    note_snippets: Vec<String>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let workspace = state.path.lock().unwrap().clone();
    let config = LlmConfig::load(&workspace);

    let model_id = config.active_model_id.ok_or("No model selected")?;

    llm::inference::generate_topic_name(&workspace, &model_id, &note_snippets)
}

/// Check if a model is ready (downloaded and can be selected)
#[tauri::command]
fn is_model_ready(state: tauri::State<'_, WorkspaceState>) -> bool {
    let workspace = state.path.lock().unwrap().clone();
    let config = LlmConfig::load(&workspace);

    if let Some(model_id) = config.active_model_id {
        llm::is_model_downloaded(&workspace, &model_id)
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let mut watcher =
                notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                    if let Ok(_event) = res {
                        let _ = app_handle.emit("workspace-changed", ());
                    }
                })
                .map_err(|e| e.to_string())?;

            let default_path = std::fs::canonicalize("..").unwrap_or_else(|_| PathBuf::from(".."));
            watcher
                .watch(&default_path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;

            // Allow default_path in asset protocol scope
            let _ = app.asset_protocol_scope().allow_directory(&default_path, true);

            // Create download state for LLM model downloads
            let download_state = llm::download::new_download_state();

            app.manage(WorkspaceState {
                path: Mutex::new(default_path),
                watcher: Mutex::new(watcher),
                download_state,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            write_markdown_file,
            get_workspace_path,
            list_workspace_files,
            create_markdown_file,
            get_file_tree,
            create_directory,
            select_directory,
            set_workspace_path,
            read_settings,
            write_settings,
            // LLM commands
            get_models,
            get_active_model,
            set_active_model,
            start_model_download,
            pause_model_download,
            resume_model_download,
            cancel_model_download,
            delete_model,
            generate_topic_name,
            is_model_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_safe_path() {
        let temp_dir = std::env::temp_dir();
        let unique_dir = temp_dir.join(format!("sol_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&unique_dir).unwrap();
        let workspace = std::fs::canonicalize(&unique_dir).unwrap();

        // 1. Valid file directly in workspace
        let res = resolve_safe_path(&workspace, "test.md");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), workspace.join("test.md"));

        // 2. Valid file in subdirectory
        let res = resolve_safe_path(&workspace, "sub/dir/test.md");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), workspace.join("sub/dir/test.md"));

        // 3. Absolute path should be rejected
        let res = resolve_safe_path(&workspace, "/etc/passwd");
        assert!(res.is_err());

        // 4. Directory traversal attempting to escape workspace
        let res = resolve_safe_path(&workspace, "../escape.md");
        assert!(res.is_err());

        let res = resolve_safe_path(&workspace, "subdir/../../escape.md");
        assert!(res.is_err());

        let _ = std::fs::remove_dir_all(&workspace);
    }
}
