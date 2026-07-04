use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use notify::{Watcher, RecommendedWatcher, RecursiveMode};
use tauri::{Emitter, Manager};

mod privacy;
mod embedding;

use embedding::{EmbeddingIndex, EmbeddingStatus, SimilarNote};

struct WorkspaceState {
    path: Mutex<PathBuf>,
    watcher: Mutex<RecommendedWatcher>,
    embedding_index: Mutex<EmbeddingIndex>,
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

            app.manage(WorkspaceState {
                path: Mutex::new(default_path),
                watcher: Mutex::new(watcher),
                embedding_index: Mutex::new(embedding_index),
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
