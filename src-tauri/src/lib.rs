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
use std::collections::HashSet;
use std::io::Write;
use tauri::{Emitter, Manager};

mod llm;
use llm::{LlmConfig, ModelStatus, ModelWithStatus};
mod policy;

struct WorkspaceState {
    path: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    download_state: llm::download::SharedDownloadState,
    loaded_model: Mutex<Option<(String, llm::inference::LoadedModel)>>,
    active_completion_cancel: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    active_rework_cancel: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    policy_engine: Mutex<Option<policy::PolicyEngine>>,
}

pub(crate) fn is_ai_allowed(state: &WorkspaceState, workspace: &Path, note_path: &Path) -> bool {
    let mut policy_lock = state.policy_engine.lock().unwrap();
    if policy_lock.is_none() {
        *policy_lock = Some(policy::PolicyEngine::new(workspace.to_path_buf()));
    }
    policy_lock.as_mut().unwrap().ai_allowed(note_path)
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
    std::fs::rename(&temp_path, path).inspect_err(|_| {
        // Clean up temp file on failure
        let _ = std::fs::remove_file(&temp_path);
    })?;
    
    Ok(())
}

pub fn get_file_mtime(path: &Path) -> std::io::Result<u64> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata.modified()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?;
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
    use std::collections::HashSet;
    let mut visited = HashSet::new();
    let canonical_workspace = std::fs::canonicalize(base)
        .map_err(|e| format!("Failed to canonicalize workspace: {}", e))?;
    build_tree_rec(dir, base, &canonical_workspace, &mut visited)
}

fn build_tree_rec(
    dir: &Path,
    base: &Path,
    canonical_workspace: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    if !dir.exists() {
        return Ok(nodes);
    }

    let canonical_dir = match std::fs::canonicalize(dir) {
        Ok(c) => c,
        Err(_) => return Ok(nodes),
    };

    if !canonical_dir.starts_with(canonical_workspace) {
        return Ok(nodes);
    }

    if !visited.insert(canonical_dir) {
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
            .to_string_lossy()
            .replace('\\', "/");

        let is_dir = path.is_dir();
        let mut children = Vec::new();
        if is_dir {
            children = build_tree_rec(&path, base, canonical_workspace, visited)?;
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

pub(crate) fn resolve_safe_path(workspace: &Path, user_path: &str) -> Result<PathBuf, String> {
    let user_path = Path::new(user_path);
    if user_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    for component in user_path.components() {
        if component == std::path::Component::ParentDir {
            return Err("Path traversal detected: '..' is not allowed".to_string());
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
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            #[cfg(target_os = "windows")]
            let s = if s.starts_with(r"\\?\") { s[4..].to_string() } else { s };
            s.replace('\\', "/")
        })
        .unwrap_or_default()
}

fn has_extension(filename: &str) -> bool {
    let path = Path::new(filename);
    if let Some(file_name) = path.file_name() {
        let name_str = file_name.to_string_lossy();
        if let Some(dot_idx) = name_str.rfind('.') {
            return dot_idx > 0 && dot_idx < name_str.len() - 1;
        }
    }
    false
}

#[tauri::command]
fn create_markdown_file(
    name: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let name_clean = if has_extension(&name) {
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

    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let initial_content = if !title.is_empty() {
        format!("# {}\n\n", title)
    } else {
        String::new()
    };

    write_atomically(&path, initial_content.as_bytes()).map_err(|e| e.to_string())?;
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

#[tauri::command]
fn delete_item(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let resolved = resolve_safe_path(workspace, &path)?;
    if !resolved.exists() {
        return Err("Item does not exist".to_string());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&resolved).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let resolved_old = resolve_safe_path(workspace, &old_path)?;
    let resolved_new = resolve_safe_path(workspace, &new_path)?;
    if !resolved_old.exists() {
        return Err("Source item does not exist".to_string());
    }
    if resolved_new.exists() {
        return Err("Target item already exists".to_string());
    }
    if let Some(parent) = resolved_new.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&resolved_old, &resolved_new).map_err(|e| e.to_string())?;
    Ok(())
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

    // Reset policy engine with the new workspace path
    {
        let mut policy_lock = lock!(state.policy_engine);
        *policy_lock = Some(policy::PolicyEngine::new(new_path.clone()));
    }

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
                    // Invalidate policy cache
                    let state = app_handle.state::<WorkspaceState>();
                    {
                        let mut policy_lock = lock!(state.policy_engine);
                        if let Some(ref mut engine) = *policy_lock {
                            for path in &event.paths {
                                engine.invalidate_path(path);
                            }
                        }
                    }

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
        workspace_path: {
            let s = new_path.to_string_lossy().into_owned();
            #[cfg(target_os = "windows")]
            let s = if s.starts_with(r"\\?\") { s[4..].to_string() } else { s };
            s.replace('\\', "/")
        },
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
        let content = fs::read_to_string(&settings_file).map_err(|e| e.to_string())?;
        
        // Validate JSON
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&content) {
            let backup_file = settings_dir.join("settings.json.corrupt");
            let _ = fs::rename(&settings_file, &backup_file);
            return Err(format!("Settings file was corrupt and has been backed up to settings.json.corrupt. Error: {}", e));
        }
        
        Ok(content)
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
            let is_completion_active = config.completion_model_id.as_ref() == Some(&info.id);
            let is_rework_active = config.rework_model_id.as_ref() == Some(&info.id);

            let status = if is_active && is_downloaded {
                ModelStatus::Active
            } else if is_downloaded {
                ModelStatus::Downloaded
            } else {
                ModelStatus::NotDownloaded
            };

            ModelWithStatus { info, status, is_completion_active, is_rework_active }
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

    // If this was the active model or active completion model, clear it
    let mut config = LlmConfig::load(workspace);
    let mut modified = false;
    if config.active_model_id.as_ref() == Some(&model_id) {
        config.active_model_id = None;
        modified = true;
    }
    if config.completion_model_id.as_ref() == Some(&model_id) {
        config.completion_model_id = None;
        modified = true;
    }
    if config.rework_model_id.as_ref() == Some(&model_id) {
        config.rework_model_id = None;
        modified = true;
    }
    if modified {
        config.save(workspace)?;
    }

    llm::download::delete_model(workspace, &model_id)
}

/// Generate a topic name using the active LLM
#[tauri::command]
async fn generate_topic_name(
    note_snippets: Vec<String>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let (workspace, model_id) = {
        let path_lock = lock!(state.path);
        let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?.clone();
        let config = LlmConfig::load(&workspace);
        let model_id = config.active_model_id.ok_or("No model selected")?;
        (workspace, model_id)
    };

    let mut loaded_model_lock = lock!(state.loaded_model);
    let model = match &mut *loaded_model_lock {
        Some((cached_id, model)) if cached_id == &model_id => model,
        _ => {
            let new_model = llm::inference::LoadedModel::load(&workspace, &model_id)?;
            *loaded_model_lock = Some((model_id.clone(), new_model));
            &mut loaded_model_lock.as_mut().unwrap().1
        }
    };

    llm::inference::generate_topic_name(model, &note_snippets)
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

#[derive(serde::Deserialize, Clone)]
struct CompletionParams {
    path: String,
    text: String,
    cursor_offset: usize,
    max_tokens: usize,
    temperature: Option<f64>,
    top_p: Option<f64>,
    stop: Vec<String>,
    seed: u64,
    #[serde(default)]
    rejected: Vec<String>,
    #[serde(default)]
    context: llm::context::ContextOptions,
}

#[derive(serde::Serialize, Clone)]
struct LinkedMetaDto {
    title: String,
    path: String,
    chars_used: usize,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CompletionMessage {
    Context {
        request_id: String,
        prefix_from: usize,
        prefix_to: usize,
        linked: Vec<LinkedMetaDto>,
        prompt_tokens_est: usize,
    },
    Token {
        request_id: String,
        token: String,
    },
    Stats {
        request_id: String,
        prefill_ms: u64,
        prefill_tokens: usize,
        decode_tokens: usize,
        tok_per_s: f64,
        backend: String,
    },
}

#[derive(serde::Serialize)]
struct ReworkStatsResponse {
    prefill_ms: u64,
    prefill_tokens: usize,
    decode_tokens: usize,
    tok_per_s: f64,
    backend: String,
}

#[derive(serde::Serialize, Clone)]
struct CompletionChunk {
    request_id: String,
    token: String,
}

/// Generate completions streaming tokens via the provided channel
#[tauri::command]
async fn generate_completion(
    request_id: String,
    params: CompletionParams,
    channel: tauri::ipc::Channel<CompletionMessage>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let state = app.state::<WorkspaceState>();

    // 1. Manage/trigger cancellation of any existing completion
    let cancel_token = {
        let mut active_cancel = lock!(state.active_completion_cancel);
        if let Some(ref old_token) = *active_cancel {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *active_cancel = Some(token.clone());
        token
    };

    // 2. Resolve workspace, completion backend and model, checking privacy rules first
    let (workspace, backend, model_id, config, assembled_context) = {
        let path_lock = lock!(state.path);
        let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?.clone();
        
        let resolved = resolve_safe_path(&workspace, &params.path)?;
        if !is_ai_allowed(&state, &workspace, &resolved) {
            return Err("AI context is disabled for this file by privacy policy".to_string());
        }

        let config = LlmConfig::load(&workspace);
        let backend = config.completion_backend.clone();
        
        let model_id = match backend {
            llm::providers::CompletionBackend::Builtin => {
                let id = config.completion_model_id.as_ref()
                    .or(config.active_model_id.as_ref())
                    .ok_or_else(|| "No model selected for completion".to_string())?
                    .clone();
                Some(id)
            }
            llm::providers::CompletionBackend::LlamaCpp => None,
        };

        let assembled = llm::context::assemble_context(&workspace, &resolved, &params.text, params.cursor_offset, &state, &params.context);
        (workspace, backend, model_id, config, assembled)
    };

    // Send Context message immediately
    let context_msg = CompletionMessage::Context {
        request_id: request_id.clone(),
        prefix_from: assembled_context.prefix_range_utf16.0,
        prefix_to: assembled_context.prefix_range_utf16.1,
        linked: assembled_context.linked.iter().map(|meta| LinkedMetaDto {
            title: meta.title.clone(),
            path: meta.path.clone(),
            chars_used: meta.chars_used,
        }).collect(),
        prompt_tokens_est: assembled_context.prompt_token_estimate,
    };
    let _ = channel.send(context_msg);

    let prompt = assembled_context.prompt;

    // 3. Spawn blocking generation task off the main IPC thread
    tauri::async_runtime::spawn_blocking(move || {
        let request_id_clone = request_id.clone();
        let request_id_final = request_id.clone();
        let channel_clone = channel.clone();
        let channel_final = channel.clone();

        match backend {
            llm::providers::CompletionBackend::Builtin => {
                let model_id = model_id.ok_or_else(|| "Model ID missing".to_string())?;
                let state = app.state::<WorkspaceState>();
                let mut loaded_model_lock = lock!(state.loaded_model);
                
                let model = match &mut *loaded_model_lock {
                    Some((cached_id, model)) if cached_id == &model_id => model,
                    _ => {
                        let new_model = match llm::inference::LoadedModel::load(&workspace, &model_id) {
                            Ok(m) => m,
                            Err(e) => return Err(format!("Failed to load model: {}", e)),
                        };
                        *loaded_model_lock = Some((model_id.clone(), new_model));
                        &mut loaded_model_lock.as_mut().unwrap().1
                    }
                };

                match model.generate_stream(
                    &prompt,
                    params.max_tokens,
                    params.temperature,
                    params.top_p,
                    params.seed,
                    &params.stop,
                    &params.rejected,
                    &cancel_token,
                    move |token: &str| {
                        let msg = CompletionMessage::Token {
                            request_id: request_id_clone.clone(),
                            token: token.to_string(),
                        };
                        channel_clone.send(msg).map_err(|e| e.to_string())
                    }
                ) {
                    Ok(stats) => {
                        let stats_msg = CompletionMessage::Stats {
                            request_id: request_id_final,
                            prefill_ms: stats.prefill_ms,
                            prefill_tokens: stats.prefill_tokens,
                            decode_tokens: stats.decode_tokens,
                            tok_per_s: stats.tok_per_s,
                            backend: "Candle".to_string(),
                        };
                        let _ = channel_final.send(stats_msg);
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            }
            llm::providers::CompletionBackend::LlamaCpp => {
                if !params.rejected.is_empty() {
                    eprintln!("[generate_completion] Warning: rejected-suggestions are not supported by the llama.cpp backend");
                }

                let llamacpp_url = config.llamacpp_url.clone();
                let allow_remote = config.allow_remote_endpoints;

                match llm::providers::llamacpp::stream_completion(
                    &llamacpp_url,
                    allow_remote,
                    &prompt,
                    params.max_tokens,
                    params.temperature.unwrap_or(0.7),
                    params.top_p.unwrap_or(0.9),
                    params.seed,
                    config.llamacpp_dry_multiplier,
                    config.llamacpp_dry_base,
                    config.llamacpp_dry_allowed_length,
                    config.llamacpp_dry_penalty_last_n,
                    &params.stop,
                    &cancel_token,
                    move |token: &str| {
                        let msg = CompletionMessage::Token {
                            request_id: request_id_clone.clone(),
                            token: token.to_string(),
                        };
                        channel_clone.send(msg).map_err(|e| e.to_string())
                    }
                ) {
                    Ok(stats) => {
                        let stats_msg = CompletionMessage::Stats {
                            request_id: request_id_final,
                            prefill_ms: stats.prefill_ms,
                            prefill_tokens: stats.prefill_tokens,
                            decode_tokens: stats.decode_tokens,
                            tok_per_s: stats.tok_per_s,
                            backend: "llama.cpp".to_string(),
                        };
                        let _ = channel_final.send(stats_msg);
                        Ok(())
                    }
                    Err(e) => {
                        let mapped = llm::providers::map_provider_error(&e, "LlamaCpp", None);
                        Err(mapped)
                    }
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Spawn blocking failed: {}", e))?
}

/// Explicitly cancel the current completion generation
#[tauri::command]
fn cancel_completion(state: tauri::State<'_, WorkspaceState>) {
    let mut active_cancel = lock!(state.active_completion_cancel);
    if let Some(ref old_token) = *active_cancel {
        old_token.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    *active_cancel = None;
}

/// Get the active completion model ID
#[tauri::command]
fn get_completion_model(state: tauri::State<'_, WorkspaceState>) -> Option<String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref()?;
    let config = LlmConfig::load(workspace);
    config.completion_model_id
}

/// Set the active completion model ID
#[tauri::command]
fn set_completion_model(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;

    if !llm::is_model_downloaded(workspace, &model_id) {
        return Err("Model not downloaded".to_string());
    }

    let mut config = LlmConfig::load(workspace);
    config.completion_model_id = Some(model_id);
    config.save(workspace)
}

/// Get the active rework model ID
#[tauri::command]
fn get_rework_model(state: tauri::State<'_, WorkspaceState>) -> Option<String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref()?;
    let config = LlmConfig::load(workspace);
    config.rework_model_id
}

/// Set the active rework model ID
#[tauri::command]
fn set_rework_model(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;

    if !llm::is_model_downloaded(workspace, &model_id) {
        return Err("Model not downloaded".to_string());
    }

    let mut config = LlmConfig::load(workspace);
    config.rework_model_id = Some(model_id);
    config.save(workspace)
}

fn load_rework_prompt(workspace: &Path) -> String {
    let prompt_path = workspace.join(".sol").join("rework_prompt.md");
    if prompt_path.exists() {
        if let Ok(content) = fs::read_to_string(&prompt_path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "You rewrite text. Reply with ONLY the rewritten text — no preamble, no quotes, no explanations. Do not output any thinking or reasoning, reply directly with the rewrite.".to_string()
}

/// Create/open the rework prompt template file
#[tauri::command]
fn open_rework_prompt_file(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let sol_dir = workspace.join(".sol");
    fs::create_dir_all(&sol_dir).map_err(|e| e.to_string())?;
    let prompt_path = sol_dir.join("rework_prompt.md");
    
    if !prompt_path.exists() {
        let default_content = "You rewrite text. Reply with ONLY the rewritten text — no preamble, no quotes, no explanations. Do not output any thinking or reasoning, reply directly with the rewrite.";
        fs::write(&prompt_path, default_content).map_err(|e| e.to_string())?;
    }
    
    Ok(".sol/rework_prompt.md".to_string())
}

/// Explicitly cancel the current rework generation
#[tauri::command]
fn cancel_rework(state: tauri::State<'_, WorkspaceState>) {
    let mut active_cancel = lock!(state.active_rework_cancel);
    if let Some(ref old_token) = *active_cancel {
        old_token.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    *active_cancel = None;
}

#[derive(serde::Deserialize, Clone)]
struct ReworkParams {
    path: String,
    selection: String,
    instruction: String,
    max_tokens: Option<usize>,
    seed: Option<u64>,
    temperature: Option<f64>,
    top_p: Option<f64>,
}

/// Generate rework streaming tokens via the provided channel
#[tauri::command]
async fn generate_rework(
    request_id: String,
    params: ReworkParams,
    channel: tauri::ipc::Channel<CompletionChunk>,
    app: tauri::AppHandle,
) -> Result<ReworkStatsResponse, String> {
    eprintln!("[generate_rework] Entry: request_id={} path={} instruction={}", request_id, params.path, params.instruction);
    let state = app.state::<WorkspaceState>();

    // 1. Cancel active completion and any existing rework
    {
        let mut active_comp = lock!(state.active_completion_cancel);
        if let Some(ref old_token) = *active_comp {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        *active_comp = None;
    }
    let cancel_token = {
        let mut active_cancel = lock!(state.active_rework_cancel);
        if let Some(ref old_token) = *active_cancel {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *active_cancel = Some(token.clone());
        token
    };

    enum ReworkInput {
        BuiltinPrompt(String),
        OllamaInput { system_prompt: String, instruction: String, selection: String },
        LlamaCppInput { system_prompt: String, instruction: String, selection: String },
    }

    // 2. Resolve workspace and model, checking privacy
    let (workspace, _backend, allow_remote, ollama_url, ollama_model, llamacpp_url, model_id, prompt_or_input) = {
        let path_lock = lock!(state.path);
        let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?.clone();
        
        let resolved = resolve_safe_path(&workspace, &params.path)?;
        if !is_ai_allowed(&state, &workspace, &resolved) {
            return Err("AI context is disabled for this file by privacy policy".to_string());
        }

        let config = LlmConfig::load(&workspace);
        let backend = config.rework_backend.clone();
        let allow_remote = config.allow_remote_endpoints;
        let ollama_url = config.ollama_url.clone();
        let ollama_model = config.ollama_rework_model.clone();
        let llamacpp_url = config.llamacpp_url.clone();
        let system_prompt = load_rework_prompt(&workspace);

        match backend {
            llm::providers::ReworkBackend::Builtin => {
                let model_id = config.rework_model_id
                    .or(config.active_model_id)
                    .ok_or_else(|| "No model selected for rework".to_string())?;

                let sanitized_instruction = llm::context::sanitize_prompt_text(&params.instruction);
                let sanitized_selection = llm::context::sanitize_prompt_text(&params.selection);

                let prompt = format!(
                    "<|im_start|>system\n{}\n<|im_end|>\n<|im_start|>user\nInstruction: {}\n\nText:\n{}<|im_end|>\n<|im_start|>assistant\n",
                    system_prompt,
                    sanitized_instruction,
                    sanitized_selection
                );
                (workspace, backend, allow_remote, ollama_url, ollama_model, llamacpp_url, Some(model_id), ReworkInput::BuiltinPrompt(prompt))
            }
            llm::providers::ReworkBackend::Ollama => {
                eprintln!("[generate_rework] Ollama backend selected. url='{}', model={:?}, allow_remote={}", ollama_url, ollama_model, allow_remote);
                let model = ollama_model.clone().ok_or_else(|| "No Ollama model selected for rework. Please select one in Settings.".to_string())?;
                let sanitized_instruction = llm::context::sanitize_prompt_text(&params.instruction);
                let sanitized_selection = llm::context::sanitize_prompt_text(&params.selection);
                (workspace, backend, allow_remote, ollama_url, Some(model), llamacpp_url, None::<String>, ReworkInput::OllamaInput {
                    system_prompt,
                    instruction: sanitized_instruction,
                    selection: sanitized_selection,
                })
            }
            llm::providers::ReworkBackend::LlamaCpp => {
                eprintln!("[generate_rework] llama.cpp backend selected. url='{}', allow_remote={}", llamacpp_url, allow_remote);
                let sanitized_instruction = llm::context::sanitize_prompt_text(&params.instruction);
                let sanitized_selection = llm::context::sanitize_prompt_text(&params.selection);
                (workspace, backend, allow_remote, ollama_url, None, llamacpp_url.clone(), None::<String>, ReworkInput::LlamaCppInput {
                    system_prompt,
                    instruction: sanitized_instruction,
                    selection: sanitized_selection,
                })
            }
        }
    };

    // 3. Spawn blocking generation task
    tauri::async_runtime::spawn_blocking(move || {
        let max_tokens = params.max_tokens.unwrap_or(256);
        let seed = params.seed.unwrap_or(42);
        let temperature = params.temperature.unwrap_or(0.3);
        let top_p = params.top_p.unwrap_or(0.9);
        let request_id_clone = request_id.clone();
        let channel_clone = channel.clone();

        match prompt_or_input {
            ReworkInput::BuiltinPrompt(prompt) => {
                let model_id = model_id.ok_or_else(|| "Model ID missing".to_string())?;
                let state = app.state::<WorkspaceState>();
                let mut loaded_model_lock = lock!(state.loaded_model);
                
                let model = match &mut *loaded_model_lock {
                    Some((cached_id, model)) if cached_id == &model_id => model,
                    _ => {
                        let new_model = match llm::inference::LoadedModel::load(&workspace, &model_id) {
                            Ok(m) => m,
                            Err(e) => return Err(format!("Failed to load model: {}", e)),
                        };
                        *loaded_model_lock = Some((model_id.clone(), new_model));
                        &mut loaded_model_lock.as_mut().unwrap().1
                    }
                };

                match model.generate_stream(
                    &prompt,
                    max_tokens,
                    Some(temperature),
                    Some(top_p),
                    seed,
                    &[],
                    &[],
                    &cancel_token,
                    move |token: &str| {
                        let chunk = CompletionChunk {
                            request_id: request_id_clone.clone(),
                            token: token.to_string(),
                        };
                        channel_clone.send(chunk).map_err(|e| e.to_string())
                    }
                ) {
                    Ok(stats) => Ok(ReworkStatsResponse {
                        prefill_ms: stats.prefill_ms,
                        prefill_tokens: stats.prefill_tokens,
                        decode_tokens: stats.decode_tokens,
                        tok_per_s: stats.tok_per_s,
                        backend: "Candle".to_string(),
                    }),
                    Err(e) => Err(e),
                }
            }
            ReworkInput::OllamaInput { system_prompt, instruction, selection } => {
                let model_name = ollama_model.ok_or_else(|| "Ollama model missing".to_string())?;
                eprintln!("[generate_rework] Spawning Ollama thread. url='{}', model='{}'", ollama_url, model_name);
                let ollama_max_tokens = std::cmp::max(max_tokens, 1024);
                match llm::providers::ollama::stream_rework(
                    &ollama_url,
                    allow_remote,
                    &model_name,
                    &system_prompt,
                    &instruction,
                    &selection,
                    temperature,
                    top_p,
                    seed,
                    ollama_max_tokens,
                    &cancel_token,
                    move |token: &str| {
                        eprintln!("[generate_rework] Ollama token received: {:?}", token);
                        let chunk = CompletionChunk {
                            request_id: request_id_clone.clone(),
                            token: token.to_string(),
                        };
                        channel_clone.send(chunk).map_err(|e| e.to_string())
                    }
                ) {
                    Ok(stats) => {
                        eprintln!("[generate_rework] Spawning Ollama thread finished.");
                        Ok(ReworkStatsResponse {
                            prefill_ms: stats.prefill_ms,
                            prefill_tokens: stats.prefill_tokens,
                            decode_tokens: stats.decode_tokens,
                            tok_per_s: stats.tok_per_s,
                            backend: "Ollama".to_string(),
                        })
                    }
                    Err(e) => {
                        let mapped = llm::providers::map_provider_error(&e, "Ollama", Some(&model_name));
                        Err(mapped)
                    }
                }
            }
            ReworkInput::LlamaCppInput { system_prompt, instruction, selection } => {
                eprintln!("[generate_rework] Spawning llama.cpp thread. url='{}'", llamacpp_url);
                let llamacpp_max_tokens = std::cmp::max(max_tokens, 1024);
                match llm::providers::llamacpp::stream_rework(
                    &llamacpp_url,
                    allow_remote,
                    &system_prompt,
                    &instruction,
                    &selection,
                    temperature,
                    top_p,
                    seed,
                    llamacpp_max_tokens,
                    &cancel_token,
                    move |token: &str| {
                        eprintln!("[generate_rework] llama.cpp token received: {:?}", token);
                        let chunk = CompletionChunk {
                            request_id: request_id_clone.clone(),
                            token: token.to_string(),
                        };
                        channel_clone.send(chunk).map_err(|e| e.to_string())
                    }
                ) {
                    Ok(stats) => {
                        eprintln!("[generate_rework] Spawning llama.cpp thread finished.");
                        Ok(ReworkStatsResponse {
                            prefill_ms: stats.prefill_ms,
                            prefill_tokens: stats.prefill_tokens,
                            decode_tokens: stats.decode_tokens,
                            tok_per_s: stats.tok_per_s,
                            backend: "llama.cpp".to_string(),
                        })
                    }
                    Err(e) => {
                        let mapped = llm::providers::map_provider_error(&e, "LlamaCpp", None);
                        Err(mapped)
                    }
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Spawn blocking failed: {}", e))?
}

/// Check if AI features are allowed for a note
#[tauri::command]
fn is_note_allowed(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let resolved = resolve_safe_path(workspace, &path)?;
    Ok(is_ai_allowed(&state, workspace, &resolved))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProviderConfig {
    pub completion_backend: llm::providers::CompletionBackend,
    pub rework_backend: llm::providers::ReworkBackend,
    pub ollama_url: String,
    pub ollama_rework_model: Option<String>,
    pub llamacpp_url: String,
    pub allow_remote_endpoints: bool,
}

#[tauri::command]
fn get_provider_config(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<ProviderConfig, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let config = LlmConfig::load(workspace);
    Ok(ProviderConfig {
        completion_backend: config.completion_backend,
        rework_backend: config.rework_backend,
        ollama_url: config.ollama_url,
        ollama_rework_model: config.ollama_rework_model,
        llamacpp_url: config.llamacpp_url,
        allow_remote_endpoints: config.allow_remote_endpoints,
    })
}

#[tauri::command]
fn set_provider_config(
    config: ProviderConfig,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;

    // Validate URLs
    llm::providers::validate_provider_url(&config.ollama_url, config.allow_remote_endpoints)
        .map_err(|e| format!("Ollama URL error: {}", e))?;
    llm::providers::validate_provider_url(&config.llamacpp_url, config.allow_remote_endpoints)
        .map_err(|e| format!("llama.cpp URL error: {}", e))?;

    let mut llm_config = LlmConfig::load(workspace);
    llm_config.completion_backend = config.completion_backend;
    llm_config.rework_backend = config.rework_backend;
    llm_config.ollama_url = config.ollama_url;
    llm_config.ollama_rework_model = config.ollama_rework_model;
    llm_config.llamacpp_url = config.llamacpp_url;
    llm_config.allow_remote_endpoints = config.allow_remote_endpoints;

    llm_config.save(workspace)?;
    Ok(())
}

#[tauri::command]
async fn check_ollama(
    url: String,
    allow_remote: bool,
) -> Result<llm::providers::ollama::OllamaStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        llm::providers::ollama::check_health(&url, allow_remote)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_ollama_models(
    url: String,
    allow_remote: bool,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        llm::providers::ollama::list_models(&url, allow_remote)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_llamacpp(
    url: String,
    allow_remote: bool,
) -> Result<llm::providers::llamacpp::LlamaCppStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        llm::providers::llamacpp::check_health(&url, allow_remote)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create/open the AI policy file
#[tauri::command]
fn open_policy_file(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    let path_lock = lock!(state.path);
    let workspace = path_lock.as_ref().ok_or_else(|| "No active workspace".to_string())?;
    let solai_path = workspace.join(".solai");
    
    if !solai_path.exists() {
        let default_content = b"# Sol AI Policy Configuration File\n\
# Use standard gitignore-like patterns to exclude notes and folders from AI context (embeddings, completions, etc.).\n\
# Prepend a path with '!' to whitelist/allow it even if a parent folder is excluded.\n\n\
# Exclude sensitive folders:\n\
# private/\n\
# secret.md\n";
        std::fs::write(&solai_path, default_content).map_err(|e| e.to_string())?;
    }
    
    Ok(".solai".to_string())
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
                            // Invalidate policy cache
                            let state = app_handle_clone.state::<WorkspaceState>();
                            {
                                let mut policy_lock = lock!(state.policy_engine);
                                if let Some(ref mut engine) = *policy_lock {
                                    for path in &event.paths {
                                        engine.invalidate_path(path);
                                    }
                                }
                            }

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

            let policy_engine = path.as_ref().map(|p| policy::PolicyEngine::new(p.clone()));

            app.manage(WorkspaceState {
                path: Mutex::new(path),
                watcher: Mutex::new(watcher),
                download_state,
                loaded_model: Mutex::new(None),
                active_completion_cancel: Mutex::new(None),
                active_rework_cancel: Mutex::new(None),
                policy_engine: Mutex::new(policy_engine),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            write_markdown_file,
            get_workspace_path,
            create_markdown_file,
            get_file_tree,
            create_directory,
            delete_item,
            rename_item,
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
            is_model_ready,
            generate_completion,
            cancel_completion,
            get_completion_model,
            set_completion_model,
            get_rework_model,
            set_rework_model,
            cancel_rework,
            generate_rework,
            is_note_allowed,
            open_policy_file,
            open_rework_prompt_file,
            get_provider_config,
            set_provider_config,
            check_ollama,
            list_ollama_models,
            check_llamacpp
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

    #[test]
    fn test_llm_config_serde() {
        let temp_dir = std::env::temp_dir();
        let unique_dir = temp_dir.join(format!("sol_config_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&unique_dir).unwrap();
        let workspace = std::fs::canonicalize(&unique_dir).unwrap();

        // Test default loading (when file doesn't exist)
        let config = LlmConfig::load(&workspace);
        assert!(config.active_model_id.is_none());
        assert!(config.completion_model_id.is_none());
        assert!(config.downloaded_models.is_empty());

        // Test saving and loading
        let mut config = LlmConfig::default();
        config.active_model_id = Some("qwen2-0.5b".to_string());
        config.completion_model_id = Some("qwen2.5-0.5b".to_string());
        config.downloaded_models = vec!["qwen2-0.5b".to_string(), "qwen2.5-0.5b".to_string()];
        config.save(&workspace).unwrap();

        let loaded = LlmConfig::load(&workspace);
        assert_eq!(loaded.active_model_id, Some("qwen2-0.5b".to_string()));
        assert_eq!(loaded.completion_model_id, Some("qwen2.5-0.5b".to_string()));
        assert_eq!(loaded.downloaded_models, vec!["qwen2-0.5b".to_string(), "qwen2.5-0.5b".to_string()]);

        // Test loading legacy config without completion_model_id
        let legacy_json = r#"{
            "active_model_id": "qwen2-0.5b",
            "downloaded_models": ["qwen2-0.5b"]
        }"#;
        let sol_dir = workspace.join(".sol");
        std::fs::create_dir_all(&sol_dir).unwrap();
        std::fs::write(sol_dir.join("llm_config.json"), legacy_json).unwrap();

        let loaded_legacy = LlmConfig::load(&workspace);
        assert_eq!(loaded_legacy.active_model_id, Some("qwen2-0.5b".to_string()));
        assert!(loaded_legacy.completion_model_id.is_none());
        assert_eq!(loaded_legacy.downloaded_models, vec!["qwen2-0.5b".to_string()]);

        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn test_policy_engine() {
        let temp_dir = std::env::temp_dir();
        let unique_dir = temp_dir.join(format!("sol_policy_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&unique_dir).unwrap();
        let workspace = std::fs::canonicalize(&unique_dir).unwrap();

        // 1. Setup policy files and folders
        let sensitive_dir = workspace.join("sensitive");
        std::fs::create_dir_all(&sensitive_dir).unwrap();

        let allowed_note = workspace.join("allowed.md");
        let excluded_note = sensitive_dir.join("excluded.md");
        let override_note = sensitive_dir.join("override.md");

        std::fs::write(&allowed_note, "allowed text").unwrap();
        std::fs::write(&excluded_note, "excluded text").unwrap();
        std::fs::write(&override_note, "---\nai: true\n---\noverride text").unwrap();

        // Write .solai policy: exclude "sensitive/"
        let solai_path = workspace.join(".solai");
        std::fs::write(&solai_path, "sensitive/\n").unwrap();

        let mut engine = policy::PolicyEngine::new(workspace.clone());

        // Check allowed note
        assert!(engine.ai_allowed(&allowed_note));

        // Check excluded note
        assert!(!engine.ai_allowed(&excluded_note));

        // Check override note (opts back in even though it's inside sensitive/)
        assert!(engine.ai_allowed(&override_note));

        // Test opt-out in root directory
        let opt_out_note = workspace.join("opt_out.md");
        std::fs::write(&opt_out_note, "---\nai: false\n---\nsome text").unwrap();
        assert!(!engine.ai_allowed(&opt_out_note));

        // 2. Test cache invalidation
        // Change opt_out_note to allowed
        std::fs::write(&opt_out_note, "---\nai: true\n---\nsome text").unwrap();
        // Since it is cached, checking it now should still return false (cached)
        assert!(!engine.ai_allowed(&opt_out_note));

        // Invalidate it
        engine.invalidate_path(&opt_out_note);
        // Now it should retrieve the updated frontmatter and return true
        assert!(engine.ai_allowed(&opt_out_note));

        // 3. Test .solai policy file change invalidation
        let new_allowed_note = sensitive_dir.join("new_allowed.md");
        std::fs::write(&new_allowed_note, "new allowed text").unwrap();
        // Checked and should be excluded because of "sensitive/"
        assert!(!engine.ai_allowed(&new_allowed_note));

        // Modify .solai to whitelist "new_allowed.md" using gitignore rules
        std::fs::write(&solai_path, "sensitive/\n!sensitive/new_allowed.md\n").unwrap();
        // Invalidate the .solai path
        engine.invalidate_path(&solai_path);

        // Checked again, now should be allowed
        assert!(engine.ai_allowed(&new_allowed_note));

        // 4. Test WorkspaceState helper is_ai_allowed integration (no deadlock)
        let state = WorkspaceState {
            path: Mutex::new(Some(workspace.clone())),
            watcher: Mutex::new(None),
            download_state: llm::download::new_download_state(),
            loaded_model: Mutex::new(None),
            active_completion_cancel: Mutex::new(None),
            active_rework_cancel: Mutex::new(None),
            policy_engine: Mutex::new(None),
        };
        assert!(is_ai_allowed(&state, &workspace, &allowed_note));
        assert!(!is_ai_allowed(&state, &workspace, &excluded_note));

        // Clean up
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn test_provider_config_validation() {
        use llm::providers::validate_provider_url;
        
        // Loopback URLs when remote is not allowed
        assert!(validate_provider_url("http://localhost:11434", false).is_ok());
        assert!(validate_provider_url("http://127.0.0.1:8080", false).is_ok());
        assert!(validate_provider_url("http://[::1]:8080", false).is_ok());
        
        // Non-loopback URLs when remote is not allowed
        assert!(validate_provider_url("http://192.168.1.50:11434", false).is_err());
        assert!(validate_provider_url("http://example.com/api", false).is_err());
        
        // Remote URLs allowed
        assert!(validate_provider_url("http://192.168.1.50:11434", true).is_ok());
        assert!(validate_provider_url("https://example.com/api", true).is_ok());
        
        // Invalid schemes
        assert!(validate_provider_url("ftp://localhost:21", true).is_err());
        assert!(validate_provider_url("invalid-url", true).is_err());
    }
}
