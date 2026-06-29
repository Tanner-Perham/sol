use std::fs;
use std::path::Path;

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
fn get_workspace_path() -> String {
    "..".to_string()
}

#[tauri::command]
fn list_workspace_files() -> Result<Vec<String>, String> {
    let dir = "..";
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
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
fn create_markdown_file(name: String) -> Result<String, String> {
    let name_clean = if name.ends_with(".md") { name } else { format!("{}.md", name) };
    let path = Path::new("..").join(&name_clean);
    if path.exists() {
        return Err("File already exists".to_string());
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Failed to convert path to string".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            display,
            read_markdown_file,
            write_markdown_file,
            get_workspace_path,
            list_workspace_files,
            create_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
