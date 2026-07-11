use std::path::{Path, PathBuf};
use regex::Regex;

pub fn extract_wikilinks(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut seen = std::collections::HashSet::new();
    
    // Match optional '!' followed by [[target]] or [[target|alias]]
    // Group 1 is the '!' prefix (if present)
    // Group 2 is the target name
    if let Ok(re) = Regex::new(r"(!?)\[\[([^\]\r\n|]+)(?:\|[^\]\r\n]+)?\]\]") {
        for cap in re.captures_iter(text) {
            let is_image = !cap[1].is_empty();
            if !is_image {
                let target = cap[2].trim().to_string();
                if !target.is_empty() && seen.insert(target.clone()) {
                    links.push(target);
                }
            }
        }
    }
    links
}

pub fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    let next_char = content.chars().nth(3);
    if next_char != Some('\n') && next_char != Some('\r') && next_char.is_some() {
        return content; // Not a frontmatter separator (e.g. ---something)
    }

    let rest = &content[3..];
    if let Some(idx) = rest.find("\n---") {
        let after_dash = &rest[idx + 4..];
        if let Some(newline_idx) = after_dash.find('\n') {
            &after_dash[newline_idx + 1..]
        } else {
            if after_dash.trim().is_empty() {
                ""
            } else {
                after_dash
            }
        }
    } else {
        content
    }
}

pub fn resolve_link_target(workspace: &Path, current_note: &Path, target: &str) -> Option<PathBuf> {
    let clean_target = target.split('#').next()?.trim();
    if clean_target.is_empty() {
        return None;
    }

    let mut target_str = clean_target.to_string();
    if !target_str.contains('.') && !target_str.starts_with("http://") && !target_str.starts_with("https://") {
        target_str.push_str(".md");
    }

    // Try relative to current note's parent directory
    if let Some(parent) = current_note.parent() {
        if let Ok(rel_to_workspace) = parent.strip_prefix(workspace) {
            let relative_target = rel_to_workspace.join(&target_str);
            if let Ok(path) = crate::resolve_safe_path(workspace, &relative_target.to_string_lossy()) {
                if path.exists() && path.is_file() {
                    return Some(path);
                }
            }
        }
    }

    // Try relative to workspace root
    if let Ok(path) = crate::resolve_safe_path(workspace, &target_str) {
        if path.exists() && path.is_file() {
            return Some(path);
        }
    }

    None
}

pub fn sanitize_prompt_text(text: &str) -> String {
    text.replace("<|im_start|>", "[im_start]")
        .replace("<|im_end|>", "[im_end]")
        .replace("<|endoftext|>", "[endoftext]")
}

pub fn assemble_context(
    workspace: &Path,
    note_path: &Path,
    buffer_text: &str,
    cursor_offset: usize,
    state: &crate::WorkspaceState,
) -> String {
    // 1. Get prefix up to cursor_offset
    let prefix = if cursor_offset <= buffer_text.len() {
        &buffer_text[..cursor_offset]
    } else {
        buffer_text
    };

    // 2. Extract outbound links from the full buffer_text
    let targets = extract_wikilinks(buffer_text);
    
    // 3. Resolve and gate linked notes
    let mut linked_excerpts = Vec::new();
    let mut linked_count = 0;
    
    for target in targets {
        if linked_count >= 3 {
            break;
        }
        if let Some(resolved_path) = resolve_link_target(workspace, note_path, &target) {
            // Exclude current note
            if resolved_path == note_path {
                continue;
            }
            // Check privacy gating
            if crate::is_ai_allowed(state, workspace, &resolved_path) {
                if let Ok(content) = std::fs::read_to_string(&resolved_path) {
                    let body = strip_frontmatter(&content).trim();
                    let sanitized = sanitize_prompt_text(body);
                    
                    // Take up to 400 characters (char count)
                    let excerpt: String = sanitized.chars().take(400).collect();
                    
                    let title = resolved_path.file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| target.clone());
                    
                    linked_excerpts.push(format!("<!-- Reference: {} -->\n{}\n", title, excerpt));
                    linked_count += 1;
                }
            }
        }
    }
    
    // 4. Truncate current note's prefix to last 2800 characters
    let sanitized_prefix = sanitize_prompt_text(prefix);
    let char_count = sanitized_prefix.chars().count();
    let truncated_prefix: String = if char_count > 2800 {
        sanitized_prefix.chars().skip(char_count - 2800).collect()
    } else {
        sanitized_prefix
    };

    // 5. Combine everything
    let mut final_prompt = String::new();
    for excerpt in linked_excerpts {
        final_prompt.push_str(&excerpt);
        final_prompt.push('\n');
    }
    final_prompt.push_str(&truncated_prefix);
    final_prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_wikilinks() {
        let text = "Hello [[Note A]] and [[Note B|Alias]]. Avoid ![[Image.png]] link.";
        let links = extract_wikilinks(text);
        assert_eq!(links, vec!["Note A".to_string(), "Note B".to_string()]);
    }

    #[test]
    fn test_strip_frontmatter() {
        let doc1 = "---\ntitle: doc\nai: false\n---\nHello World";
        assert_eq!(strip_frontmatter(doc1), "Hello World");

        let doc2 = "Hello World";
        assert_eq!(strip_frontmatter(doc2), "Hello World");

        let doc3 = "---\nHello World"; // malformed frontmatter
        assert_eq!(strip_frontmatter(doc3), "---\nHello World");

        let doc4 = "---\r\nlayout: post\r\n---\r\nHello Windows";
        assert_eq!(strip_frontmatter(doc4).trim(), "Hello Windows");
    }

    #[test]
    fn test_assemble_context() {
        let temp_dir = std::env::temp_dir();
        let unique_dir = temp_dir.join(format!("sol_context_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&unique_dir).unwrap();
        let workspace = std::fs::canonicalize(&unique_dir).unwrap();

        // Create linked note A
        let note_a = workspace.join("Note A.md");
        std::fs::write(&note_a, "---\nai: true\n---\nContent of note A").unwrap();

        // Create linked note B (excluded)
        let note_b = workspace.join("Note B.md");
        std::fs::write(&note_b, "---\nai: false\n---\nContent of note B").unwrap();

        // Create current note
        let current_note = workspace.join("Current.md");
        let current_body = "This is a note linking to [[Note A]] and [[Note B]] and [[Nonexistent Note]]. Here is the cursor position.";
        std::fs::write(&current_note, current_body).unwrap();

        let state = crate::WorkspaceState {
            path: std::sync::Mutex::new(Some(workspace.clone())),
            watcher: std::sync::Mutex::new(None),
            download_state: crate::llm::download::new_download_state(),
            loaded_model: std::sync::Mutex::new(None),
            active_completion_cancel: std::sync::Mutex::new(None),
            policy_engine: std::sync::Mutex::new(None),
        };

        let cursor_offset = current_body.find("Here is the cursor").unwrap();
        let prompt = assemble_context(&workspace, &current_note, current_body, cursor_offset, &state);

        // Assert prompt contains Note A's content and does NOT contain Note B's content (due to ai: false)
        assert!(prompt.contains("Content of note A"));
        assert!(!prompt.contains("Content of note B"));
        assert!(prompt.contains("This is a note linking to"));
        assert!(prompt.contains("<!-- Reference: Note A -->"));

        // Cleanup
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
