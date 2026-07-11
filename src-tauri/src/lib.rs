#[macro_export]
macro_rules! lock {
    ($mutex:expr) => {
        $mutex.lock().unwrap_or_else(|e| e.into_inner())
    };
}

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::io::Write;
use tauri::{Emitter, Manager};

mod llm;
use llm::{LlmConfig, ModelStatus, ModelWithStatus};

struct WorkspaceState {
    path: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    download_state: llm::download::SharedDownloadState,
}

fn get_saved_workspace(app: &tauri::AppHandle) -> Option<PathBuf> {
    let config_dir = app.path().app_config_dir().ok()?;
    let config_file = config_dir.join("config.json");
    if config_file.exists() {
        if let Ok(content) = std::fs::read_to_string(config_file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(path_str) = val.get("last_workspace").and_then(|v| v.as_str()) {
                    let path = PathBuf::from(path_str);
                    if path.is_dir() {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

pub fn write_atomically(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Path has no parent directory")
    })?;
    
    // Generate a temporary file name in the same directory
    let temp_name = format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("temp"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let temp_path = parent.join(temp_name);
    
    // Write content to temp file
    {
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
    }
    
    // Rename temp file to target file
    std::fs::rename(&temp_path, path).map_err(|e| {
        // Clean up temp file on failure
        let _ = std::fs::remove_file(&temp_path);
        e
    })?;
    
    Ok(())
}

pub fn get_file_mtime(path: &Path) -> std::io::Result<u64> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata.modified()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    Ok(duration.as_millis() as u64)
}

fn is_ignored_path(path: &Path, workspace: &Path) -> bool {
    if let Ok(relative) = path.strip_prefix(workspace) {
        if relative.starts_with(".sol") {
            return true;
        }
        if let Some(file_name) = path.file_name() {
            let name_str = file_name.to_string_lossy();
            if name_str.starts_with('.') && name_str.contains(".tmp-") {
                return true;
            }
        }
    }
    false
}

fn save_workspace(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_file = config_dir.join("config.json");
    let mut map = serde_json::Map::new();
    map.insert(
        "last_workspace".to_string(),
        serde_json::Value::String(path.to_string_lossy().into_owned()),
    );
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|e| e.to_string())?;
    write_atomically(&config_file, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
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

#[derive(serde::Serialize)]
struct ReadFileResponse {
    content: String,
    mtime: u64,
}

#[tauri::command]
fn read_markdown_file(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<ReadFileResponse, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let resolved = resolve_safe_path(workspace, &path)?;
    let content = fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
    let mtime = get_file_mtime(&resolved).unwrap_or(0);
    Ok(ReadFileResponse { content, mtime })
}

#[tauri::command]
fn write_markdown_file(
    path: String,
    content: String,
    expected_mtime: Option<u64>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<u64, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let resolved = resolve_safe_path(workspace, &path)?;
    
    if resolved.exists() {
        if let Some(expected) = expected_mtime {
            let actual = get_file_mtime(&resolved).map_err(|e| e.to_string())?;
            if actual != expected {
                return Err("conflict".to_string());
            }
        }
    }
    
    write_atomically(&resolved, content.as_bytes()).map_err(|e| e.to_string())?;
    let new_mtime = get_file_mtime(&resolved).map_err(|e| e.to_string())?;
    Ok(new_mtime)
}

#[tauri::command]
fn get_workspace_path(state: tauri::State<'_, WorkspaceState>) -> String {
    lock!(state.path)
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn list_workspace_files(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<String>, String> {
    let path_lock = lock!(state.path);
    if let Some(ref workspace) = *path_lock {
        let entries = fs::read_dir(workspace).map_err(|e| e.to_string())?;
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
    } else {
        Ok(Vec::new())
    }
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
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let path = resolve_safe_path(workspace, &name_clean)?;
    if path.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomically(&path, b"").map_err(|e| e.to_string())?;
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Failed to convert path to string".to_string())
}

#[tauri::command]
fn get_file_tree(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<FileNode>, String> {
    let path_lock = lock!(state.path);
    if let Some(ref workspace) = *path_lock {
        build_tree(workspace, workspace)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn create_directory(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let full_path = resolve_safe_path(workspace, &path)?;
    if full_path.exists() {
        return Err("Directory or file already exists".to_string());
    }
    fs::create_dir_all(&full_path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ChangeWorkspaceResult {
    workspace_path: String,
    tree: Vec<FileNode>,
}

#[tauri::command]
async fn change_workspace(
    state: tauri::State<'_, WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Option<ChangeWorkspaceResult>, String> {
    let selected_path = match rfd::AsyncFileDialog::new().pick_folder().await {
        Some(p) => p.path().to_path_buf(),
        None => return Ok(None),
    };

    let new_path = std::fs::canonicalize(&selected_path)
        .map_err(|e| format!("Failed to canonicalize path: {}", e))?;

    if !new_path.is_dir() {
        return Err("Selected path is not a directory".to_string());
    }

    let old_path = {
        let mut path_lock = lock!(state.path);
        let old = path_lock.clone();
        *path_lock = Some(new_path.clone());
        old
    };

    if let Some(old) = old_path {
        let _ = app.asset_protocol_scope().forbid_directory(&old, true);
        
        let mut watcher_lock = lock!(state.watcher);
        if let Some(ref mut watcher) = *watcher_lock {
            let _ = watcher.unwatch(&old);
        }
    }

    let _ = app.asset_protocol_scope().allow_directory(&new_path, true);

    {
        let mut watcher_lock = lock!(state.watcher);
        let app_handle = app.clone();
        let new_path_clone = new_path.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    let mut modified_paths = Vec::new();
                    for path in event.paths {
                        if is_ignored_path(&path, &new_path_clone) {
                            continue;
                        }
                        if let Ok(rel_path) = path.strip_prefix(&new_path_clone) {
                            if let Some(rel_str) = rel_path.to_str() {
                                modified_paths.push(rel_str.to_string());
                            }
                        }
                    }
                    if !modified_paths.is_empty() {
                        let _ = app_handle.emit("workspace-changed", modified_paths);
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        watcher
            .watch(&new_path, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
            
        *watcher_lock = Some(watcher);
    }

    save_workspace(&app, &new_path)?;

    let tree = build_tree(&new_path, &new_path)?;
    Ok(Some(ChangeWorkspaceResult {
        workspace_path: new_path.to_string_lossy().into_owned(),
        tree,
    }))
}

#[tauri::command]
fn read_settings(state: tauri::State<'_, WorkspaceState>) -> Result<String, String> {
    let path_lock = lock!(state.path);
    if let Some(ref workspace) = *path_lock {
        let settings_dir = workspace.join(".sol");
        let settings_file = settings_dir.join("settings.json");
        if !settings_file.exists() {
            return Ok("{}".to_string());
        }
        fs::read_to_string(&settings_file).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[tauri::command]
fn write_settings(
    settings_json: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    if let Some(ref workspace) = *path_lock {
        let settings_dir = workspace.join(".sol");
        if !settings_dir.exists() {
            fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
        }
        let settings_file = settings_dir.join("settings.json");
        write_atomically(&settings_file, settings_json.as_bytes()).map_err(|e| e.to_string())
    } else {
        Err("No workspace active".to_string())
    }
}

// ============================================================================
// LLM / Model Management Commands
// ============================================================================

/// Get list of available models with their status
#[tauri::command]
fn get_models(state: tauri::State<'_, WorkspaceState>) -> Vec<ModelWithStatus> {
    let path_lock = lock!(state.path);
    let workspace = match path_lock.as_ref() {
        Some(w) => w.clone(),
        None => return Vec::new(),
    };
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
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref()?;
    let config = LlmConfig::load(workspace);
    config.active_model_id
}

/// Set the active model
#[tauri::command]
fn set_active_model(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;

    if !llm::is_model_downloaded(workspace, &model_id) {
        return Err("Model not downloaded".to_string());
    }

    let mut config = LlmConfig::load(workspace);
    config.active_model_id = Some(model_id);
    config.save(workspace)
}

struct DownloadDropGuard {
    model_id: String,
    download_state: llm::download::SharedDownloadState,
}

impl Drop for DownloadDropGuard {
    fn drop(&mut self) {
        let mut ds = lock!(self.download_state);
        ds.in_flight.insert(self.model_id.clone(), false);
    }
}

/// Start downloading a model
#[tauri::command]
fn start_model_download(
    model_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?.clone();
    let download_state = state.download_state.clone();

    // Check and set in_flight atomically
    {
        let mut ds = lock!(download_state);
        if *ds.in_flight.get(&model_id).unwrap_or(&false) {
            return Err("Download already in progress".to_string());
        }
        ds.in_flight.insert(model_id.clone(), true);
    }

    // Spawn download in background thread
    std::thread::spawn(move || {
        let _guard = DownloadDropGuard {
            model_id: model_id.clone(),
            download_state: download_state.clone(),
        };
        let result = llm::download::download_model(&workspace, &model_id, &app, &download_state);
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
fn resume_model_download(
    model_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    llm::download::resume_download(&model_id, &state.download_state);
    start_model_download(model_id, app, state)
}

/// Cancel a model download
#[tauri::command]
fn cancel_model_download(model_id: String, state: tauri::State<'_, WorkspaceState>) {
    llm::download::cancel_download(&model_id, &state.download_state);
}

/// Delete a downloaded model
#[tauri::command]
fn delete_model(model_id: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;

    // If this was the active model, clear it
    let mut config = LlmConfig::load(workspace);
    if config.active_model_id.as_ref() == Some(&model_id) {
        config.active_model_id = None;
        config.save(workspace)?;
    }

    llm::download::delete_model(workspace, &model_id)
}

/// Generate a topic name using the active LLM
#[tauri::command]
fn generate_topic_name(
    note_snippets: Vec<String>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let config = LlmConfig::load(workspace);

    let model_id = config.active_model_id.ok_or("No model selected")?;

    llm::inference::generate_topic_name(workspace, &model_id, &note_snippets)
}

/// Check if a model is ready (downloaded and can be selected)
#[tauri::command]
fn is_model_ready(state: tauri::State<'_, WorkspaceState>) -> bool {
    let path_lock = lock!(state.path);
    if let Some(ref workspace) = *path_lock {
        let config = LlmConfig::load(workspace);
        if let Some(model_id) = config.active_model_id {
            llm::is_model_downloaded(workspace, &model_id)
        } else {
            false
        }
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
            let saved_path = get_saved_workspace(&app_handle);

            let (path, watcher) = if let Some(p) = saved_path {
                let p_clone = p.clone();
                let app_handle_clone = app_handle.clone();
                let mut watcher =
                    notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                        if let Ok(event) = res {
                            let mut modified_paths = Vec::new();
                            for path in event.paths {
                                if is_ignored_path(&path, &p_clone) {
                                    continue;
                                }
                                if let Ok(rel_path) = path.strip_prefix(&p_clone) {
                                    if let Some(rel_str) = rel_path.to_str() {
                                        modified_paths.push(rel_str.to_string());
                                    }
                                }
                            }
                            if !modified_paths.is_empty() {
                                let _ = app_handle_clone.emit("workspace-changed", modified_paths);
                            }
                        }
                    })
                    .map_err(|e| e.to_string())?;

                watcher
                    .watch(&p, RecursiveMode::Recursive)
                    .map_err(|e| e.to_string())?;

                let _ = app.asset_protocol_scope().allow_directory(&p, true);
                (Some(p), Some(watcher))
            } else {
                (None, None)
            };

            // Create download state for LLM model downloads
            let download_state = llm::download::new_download_state();

            app.manage(WorkspaceState {
                path: Mutex::new(path),
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
            change_workspace,
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
    fn test_write_atomically() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join(format!("test_atomic_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        
        let content = b"hello atomic write";
        let res = write_atomically(&file_path, content);
        assert!(res.is_ok());
        
        let read = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(read, "hello atomic write");
        
        let _ = std::fs::remove_file(&file_path);
    }

    #[test]
    fn test_get_file_mtime() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join(format!("test_mtime_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        
        std::fs::write(&file_path, "hello").unwrap();
        let mtime = get_file_mtime(&file_path);
        assert!(mtime.is_ok());
        assert!(mtime.unwrap() > 0);
        
        let _ = std::fs::remove_file(&file_path);
    }

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

        // 5. Symlinks pointing outside workspace
        let outside_dir = temp_dir.join(format!("sol_outside_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&outside_dir).unwrap();
        
        let link_path = workspace.join("link");
        #[cfg(unix)]
        let link_created = std::os::unix::fs::symlink(&outside_dir, &link_path).is_ok();
        #[cfg(windows)]
        let link_created = std::os::windows::fs::symlink_dir(&outside_dir, &link_path).is_ok();
        
        if link_created {
            let res = resolve_safe_path(&workspace, "link/x.md");
            assert!(res.is_err());
        }
        
        let _ = std::fs::remove_dir_all(&outside_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
