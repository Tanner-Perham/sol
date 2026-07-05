use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use notify::{Watcher, RecommendedWatcher, RecursiveMode};
use tauri::{Emitter, Manager};

mod privacy;
mod embedding;
mod labels;
mod tfidf;
mod discovery;
mod llm;

use embedding::{EmbeddingIndex, EmbeddingStatus, SimilarNote};
use labels::{AnchoredLabel, LabelStore};
use discovery::{DiscoveryCandidate, DiscoveryEngine, DiscoveryState};
use llm::{ModelStatus, ModelWithStatus, LlmConfig};

struct WorkspaceState {
    path: Mutex<PathBuf>,
    watcher: Mutex<RecommendedWatcher>,
    embedding_index: Mutex<EmbeddingIndex>,
    label_store: Mutex<LabelStore>,
    discovery_state: Mutex<DiscoveryState>,
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
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if name.is_empty() {
            continue;
        }

        let relative_path = path.strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_str()
            .unwrap_or("")
            .to_string();

        let is_dir = path.is_dir();
        let mut children = Vec::new();
        if is_dir {
            children = build_tree(&path, base)?;
            children.sort_by(|a, b| {
                match (a.is_dir, b.is_dir) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                }
            });
        }

        nodes.push(FileNode {
            name,
            path: relative_path,
            is_dir,
            children,
        });
    }

    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

#[tauri::command]
fn display() -> String {
    let file_path = "../test.md";
    println!("In file {file_path}");

    let contents = fs::read_to_string(file_path)
        .expect("Should have been able to read the file");

    println!("With text:\n{contents}");

    let parser = pulldown_cmark::Parser::new(&contents);

    let mut html_output = String::new();
    pulldown_cmark::html::push_html(&mut html_output, parser);

    html_output
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
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
fn create_markdown_file(name: String, state: tauri::State<'_, WorkspaceState>) -> Result<String, String> {
    let name_clean = if name.ends_with(".md") { name } else { format!("{}.md", name) };
    let workspace = state.path.lock().unwrap();
    let path = workspace.join(&name_clean);
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

/// Returns all markdown files that pass the privacy/access policy filter.
/// These are the files eligible for semantic indexing.
#[tauri::command]
fn get_indexable_files(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<String>, String> {
    let workspace = state.path.lock().unwrap();
    let files = privacy::get_indexable_files(&workspace)?;

    // Convert to relative paths as strings
    let relative_paths: Vec<String> = files
        .iter()
        .filter_map(|p| {
            p.strip_prefix(&*workspace)
                .ok()
                .and_then(|rel| rel.to_str())
                .map(|s| s.to_string())
        })
        .collect();

    Ok(relative_paths)
}

// ============================================================================
// Embedding / Semantic Search Commands
// ============================================================================

/// Get the current status of the embedding index.
#[tauri::command]
fn get_embedding_status(state: tauri::State<'_, WorkspaceState>) -> EmbeddingStatus {
    let index = state.embedding_index.lock().unwrap();
    index.status()
}

/// Search for notes semantically similar to a query string.
#[tauri::command]
fn search_similar_notes(
    query: String,
    k: usize,
    state: tauri::State<'_, WorkspaceState>
) -> Result<Vec<SimilarNote>, String> {
    let mut index = state.embedding_index.lock().unwrap();
    index.search(&query, k)
}

/// Progress event for embedding operations
#[derive(serde::Serialize, Clone)]
pub struct EmbeddingProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub phase: String,
}

/// Rebuild the embedding index for all indexable files.
/// Emits progress events as it processes each file.
#[tauri::command]
async fn rebuild_embedding_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<EmbeddingStatus, String> {
    let workspace = state.path.lock().unwrap().clone();
    let files = privacy::get_indexable_files(&workspace)?;
    let total = files.len();

    // Emit initial progress
    let _ = app.emit("embedding-progress", EmbeddingProgress {
        current: 0,
        total,
        current_file: "Starting...".to_string(),
        phase: "initializing".to_string(),
    });

    // Process files one by one, emitting progress
    for (i, file_path) in files.iter().enumerate() {
        let relative_path = file_path
            .strip_prefix(&workspace)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        // Emit progress before processing
        let _ = app.emit("embedding-progress", EmbeddingProgress {
            current: i + 1,
            total,
            current_file: relative_path.clone(),
            phase: "embedding".to_string(),
        });

        let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        let mtime = embedding::get_file_mtime(&file_path)?;

        // Lock the index just for the embedding operation
        {
            let mut index = state.embedding_index.lock().unwrap();
            index.embed_note(&relative_path, &content, mtime)?;
        }

        // Yield to allow UI to update (small delay)
        tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
    }

    // Save the index
    let _ = app.emit("embedding-progress", EmbeddingProgress {
        current: total,
        total,
        current_file: "Saving index...".to_string(),
        phase: "saving".to_string(),
    });

    let index_path = workspace.join(".sol").join("embedding_index.bin");
    {
        let index = state.embedding_index.lock().unwrap();
        index.save(&index_path)?;
    }

    // Emit completion
    let _ = app.emit("embedding-progress", EmbeddingProgress {
        current: total,
        total,
        current_file: "Complete!".to_string(),
        phase: "complete".to_string(),
    });

    let index = state.embedding_index.lock().unwrap();
    Ok(index.status())
}

/// Update embeddings incrementally for changed files only.
#[tauri::command]
fn update_embedding_index(state: tauri::State<'_, WorkspaceState>) -> Result<EmbeddingStatus, String> {
    let workspace = state.path.lock().unwrap().clone();
    let files = privacy::get_indexable_files(&workspace)?;

    let mut index = state.embedding_index.lock().unwrap();

    // Track which paths are still valid
    let current_paths: std::collections::HashSet<String> = files
        .iter()
        .filter_map(|p| {
            p.strip_prefix(&workspace)
                .ok()
                .map(|rel| rel.to_string_lossy().to_string())
        })
        .collect();

    // Remove deleted files from index
    let indexed_paths = index.indexed_paths();
    for path in indexed_paths {
        if !current_paths.contains(&path) {
            index.remove_note(&path);
        }
    }

    // Update or add files that have changed
    for file_path in files {
        let relative_path = file_path
            .strip_prefix(&workspace)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        let mtime = embedding::get_file_mtime(&file_path)?;

        if index.needs_update(&relative_path, mtime) {
            let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
            index.embed_note(&relative_path, &content, mtime)?;
        }
    }

    // Save the index
    let index_path = workspace.join(".sol").join("embedding_index.bin");
    index.save(&index_path)?;

    Ok(index.status())
}

/// Get notes similar to a specific note (by path).
#[tauri::command]
fn get_similar_to_note(
    note_path: String,
    k: usize,
    state: tauri::State<'_, WorkspaceState>
) -> Result<Vec<SimilarNote>, String> {
    let index = state.embedding_index.lock().unwrap();

    let embedding = index.get_embedding(&note_path)
        .ok_or_else(|| format!("Note not in index: {}", note_path))?
        .clone();

    // Get k+1 neighbors and filter out the query note itself
    let mut results = index.knn(&embedding, k + 1);
    results.retain(|n| n.path != note_path);
    results.truncate(k);

    Ok(results)
}

// ============================================================================
// Label Commands
// ============================================================================

/// Get all anchored labels.
#[tauri::command]
fn get_labels(state: tauri::State<'_, WorkspaceState>) -> Vec<AnchoredLabel> {
    let store = state.label_store.lock().unwrap();
    store.get_labels()
}

/// Create a new anchored label.
#[tauri::command]
fn create_label(
    name: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<AnchoredLabel, String> {
    let mut store = state.label_store.lock().unwrap();
    let mut index = state.embedding_index.lock().unwrap();

    let label = store.create_label(&name, &mut index)?;

    // Save the label store
    let workspace = state.path.lock().unwrap();
    let labels_path = workspace.join(".sol").join("labels.bin");
    store.save(&labels_path)?;

    Ok(label)
}

/// Rename an existing label.
#[tauri::command]
fn rename_label(
    id: String,
    new_name: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<AnchoredLabel, String> {
    let mut store = state.label_store.lock().unwrap();
    let mut index = state.embedding_index.lock().unwrap();

    let label = store.rename_label(&id, &new_name, &mut index)?;

    // Save the label store
    let workspace = state.path.lock().unwrap();
    let labels_path = workspace.join(".sol").join("labels.bin");
    store.save(&labels_path)?;

    Ok(label)
}

/// Delete a label.
#[tauri::command]
fn delete_label(
    id: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<(), String> {
    let mut store = state.label_store.lock().unwrap();
    store.delete_label(&id)?;

    // Save the label store
    let workspace = state.path.lock().unwrap();
    let labels_path = workspace.join(".sol").join("labels.bin");
    store.save(&labels_path)?;

    Ok(())
}

/// Get notes related to a specific label.
#[tauri::command]
fn get_label_notes(
    label_id: String,
    k: usize,
    state: tauri::State<'_, WorkspaceState>
) -> Result<Vec<SimilarNote>, String> {
    let store = state.label_store.lock().unwrap();
    let index = state.embedding_index.lock().unwrap();
    store.get_related_notes(&label_id, &index, k)
}

// ============================================================================
// Discovery Commands
// ============================================================================

/// Get discovery suggestions that have survived enough scans
#[tauri::command]
fn get_discovery_suggestions(
    state: tauri::State<'_, WorkspaceState>
) -> Vec<DiscoveryCandidate> {
    let discovery = state.discovery_state.lock().unwrap();
    DiscoveryEngine::get_surfaced_candidates(&discovery, 2) // Require 2+ scans
}

/// Trigger a discovery scan
#[tauri::command]
fn trigger_discovery_scan(
    state: tauri::State<'_, WorkspaceState>
) -> Result<Vec<DiscoveryCandidate>, String> {
    let workspace = state.path.lock().unwrap().clone();
    let index = state.embedding_index.lock().unwrap();
    let labels = state.label_store.lock().unwrap();
    let mut discovery = state.discovery_state.lock().unwrap();

    // Read note contents for c-TF-IDF
    let mut note_contents: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for path in index.indexed_paths() {
        let full_path = workspace.join(&path);
        if let Ok(content) = fs::read_to_string(&full_path) {
            note_contents.insert(path, content);
        }
    }

    // Run the scan
    let candidates = DiscoveryEngine::run_scan(
        &mut discovery,
        &index,
        &labels,
        &note_contents,
        5,    // num_clusters
        0.5,  // residual_threshold
    );

    // Save discovery state
    let discovery_path = workspace.join(".sol").join("discovery.bin");
    discovery.save(&discovery_path)?;

    Ok(candidates)
}

/// Accept a discovery suggestion and create a label from it
#[tauri::command]
fn accept_suggestion(
    candidate_id: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<AnchoredLabel, String> {
    let workspace = state.path.lock().unwrap().clone();
    let mut discovery = state.discovery_state.lock().unwrap();
    let mut labels = state.label_store.lock().unwrap();
    let mut index = state.embedding_index.lock().unwrap();

    // Get and remove the candidate
    let candidate = DiscoveryEngine::accept_candidate(&mut discovery, &candidate_id)
        .ok_or_else(|| format!("Candidate not found: {}", candidate_id))?;

    // Create a label from it
    let label = labels.create_label(&candidate.suggested_name, &mut index)?;

    // Save both stores
    let labels_path = workspace.join(".sol").join("labels.bin");
    labels.save(&labels_path)?;

    let discovery_path = workspace.join(".sol").join("discovery.bin");
    discovery.save(&discovery_path)?;

    Ok(label)
}

/// Dismiss a discovery suggestion
#[tauri::command]
fn dismiss_suggestion(
    candidate_id: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<bool, String> {
    let workspace = state.path.lock().unwrap().clone();
    let mut discovery = state.discovery_state.lock().unwrap();

    let removed = DiscoveryEngine::dismiss_candidate(&mut discovery, &candidate_id);

    // Save discovery state
    let discovery_path = workspace.join(".sol").join("discovery.bin");
    discovery.save(&discovery_path)?;

    Ok(removed)
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
    state: tauri::State<'_, WorkspaceState>
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
    state: tauri::State<'_, WorkspaceState>
) -> Result<(), String> {
    let workspace = state.path.lock().unwrap().clone();
    let download_state = state.download_state.clone();

    // Spawn download in background thread
    std::thread::spawn(move || {
        let result = llm::download::download_model(&workspace, &model_id, &app, &download_state);
        if let Err(e) = result {
            let _ = app.emit("model-download-progress", llm::download::DownloadProgress {
                model_id: model_id.clone(),
                file_name: "".to_string(),
                file_index: 0,
                total_files: 0,
                bytes_downloaded: 0,
                total_bytes: 0,
                status: "error".to_string(),
                error: Some(e),
            });
        }
    });

    Ok(())
}

/// Pause a model download
#[tauri::command]
fn pause_model_download(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>
) {
    llm::download::pause_download(&model_id, &state.download_state);
}

/// Resume a model download
#[tauri::command]
fn resume_model_download(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>
) {
    llm::download::resume_download(&model_id, &state.download_state);
}

/// Cancel a model download
#[tauri::command]
fn cancel_model_download(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>
) {
    llm::download::cancel_download(&model_id, &state.download_state);
}

/// Delete a downloaded model
#[tauri::command]
fn delete_model(
    model_id: String,
    state: tauri::State<'_, WorkspaceState>
) -> Result<(), String> {
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
    state: tauri::State<'_, WorkspaceState>
) -> Result<String, String> {
    let workspace = state.path.lock().unwrap().clone();
    let config = LlmConfig::load(&workspace);

    let model_id = config.active_model_id
        .ok_or("No model selected")?;

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

#[tauri::command]
fn create_directory(path: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let workspace = state.path.lock().unwrap();
    let full_path = workspace.join(&path);
    if full_path.exists() {
        return Err("Directory or file already exists".to_string());
    }
    fs::create_dir_all(&full_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn select_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|p| {
            let path = p.path().to_path_buf();
            std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().into_owned()
        })
}

#[tauri::command]
fn set_workspace_path(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<FileNode>, String> {
    let new_path = std::fs::canonicalize(PathBuf::from(&path)).map_err(|e| e.to_string())?;
    if !new_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

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
fn write_settings(settings_json: String, state: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let workspace = state.path.lock().unwrap();
    let settings_dir = workspace.join(".sol");
    if !settings_dir.exists() {
        fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
    }
    let settings_file = settings_dir.join("settings.json");
    fs::write(&settings_file, settings_json).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                if let Ok(_event) = res {
                    let _ = app_handle.emit("workspace-changed", ());
                }
            }).map_err(|e| e.to_string())?;

            let default_path = std::fs::canonicalize("..").unwrap_or_else(|_| PathBuf::from(".."));
            watcher.watch(&default_path, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

            // Load or create the embedding index
            let index_path = default_path.join(".sol").join("embedding_index.bin");
            let embedding_index = EmbeddingIndex::load(&index_path).unwrap_or_default();

            // Load or create the label store
            let labels_path = default_path.join(".sol").join("labels.bin");
            let label_store = LabelStore::load(&labels_path).unwrap_or_default();

            // Load or create the discovery state
            let discovery_path = default_path.join(".sol").join("discovery.bin");
            let discovery_state = DiscoveryState::load(&discovery_path).unwrap_or_default();

            // Create download state for LLM model downloads
            let download_state = llm::download::new_download_state();

            app.manage(WorkspaceState {
                path: Mutex::new(default_path),
                watcher: Mutex::new(watcher),
                embedding_index: Mutex::new(embedding_index),
                label_store: Mutex::new(label_store),
                discovery_state: Mutex::new(discovery_state),
                download_state,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            display,
            read_markdown_file,
            write_markdown_file,
            get_workspace_path,
            list_workspace_files,
            create_markdown_file,
            get_file_tree,
            get_indexable_files,
            // Embedding commands
            get_embedding_status,
            search_similar_notes,
            rebuild_embedding_index,
            update_embedding_index,
            get_similar_to_note,
            // Label commands
            get_labels,
            create_label,
            rename_label,
            delete_label,
            get_label_notes,
            // Discovery commands
            get_discovery_suggestions,
            trigger_discovery_scan,
            accept_suggestion,
            dismiss_suggestion,
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
            // File/directory commands
            create_directory,
            select_directory,
            set_workspace_path,
            read_settings,
            write_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
