use std::fs;
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

    format!("{html_output}")
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .invoke_handler(tauri::generate_handler![display])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
