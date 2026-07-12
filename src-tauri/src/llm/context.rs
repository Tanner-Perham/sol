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

fn normalize_for_dedup(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut last_was_whitespace = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !last_was_whitespace {
                normalized.push(' ');
                last_was_whitespace = true;
            }
        } else if c.is_alphanumeric() {
            normalized.push(c.to_ascii_lowercase());
            last_was_whitespace = false;
        }
    }
    normalized.trim().to_string()
}

pub fn assemble_context(
    workspace: &Path,
    note_path: &Path,
    buffer_text: &str,
    cursor_offset: usize,
    state: &crate::WorkspaceState,
) -> String {
    // 1. Get prefix up to cursor_offset and truncate to last 800 characters
    let prefix = if cursor_offset <= buffer_text.len() {
        &buffer_text[..cursor_offset]
    } else {
        buffer_text
    };
    let sanitized_prefix = sanitize_prompt_text(prefix);
    let char_count = sanitized_prefix.chars().count();
    let truncated_prefix: String = if char_count > 800 {
        sanitized_prefix.chars().skip(char_count - 800).collect()
    } else {
        sanitized_prefix
    };

    let normalized_prefix = normalize_for_dedup(&truncated_prefix);

    // 2. Extract outbound links from the full buffer_text
    let targets = extract_wikilinks(buffer_text);
    
    // 3. Resolve and gate linked notes
    let mut linked_excerpts = Vec::new();
    let mut linked_count = 0;
    
    for target in targets {
        if linked_count >= 1 {
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

                    // Take up to 150 characters (char count)
                    let excerpt: String = sanitized.chars().take(150).collect();
                    
                    let normalized_excerpt = normalize_for_dedup(&excerpt);
                    if !normalized_excerpt.is_empty() && normalized_prefix.contains(&normalized_excerpt) {
                        // Excerpt substantially appears in prefix, skip it
                        continue;
                    }

                    let title = resolved_path.file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| target.clone());
                    
                    linked_excerpts.push(format!("<!-- Reference: {} -->\n{}\n", title, excerpt));
                    linked_count += 1;
                }
            }
        }
    }
    
    // 4. Combine everything
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
            active_rework_cancel: std::sync::Mutex::new(None),
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

    #[test]
    fn test_normalize_for_dedup() {
        assert_eq!(normalize_for_dedup("Hello, world!"), "hello world");
        assert_eq!(normalize_for_dedup("Café   🚀  test"), "café test");
        assert_eq!(normalize_for_dedup("\nNew\t  Line\r"), "new line");
    }

    #[test]
    fn test_context_excerpt_deduplication() {
        let temp_dir = std::env::temp_dir();
        let unique_dir = temp_dir.join(format!("sol_dedup_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&unique_dir).unwrap();
        let workspace = std::fs::canonicalize(&unique_dir).unwrap();

        // Create linked note A (its content will appear in the prefix)
        let note_a = workspace.join("Note A.md");
        std::fs::write(&note_a, "---\nai: true\n---\nHello this is Note A content").unwrap();

        // Create linked note B (its content won't appear in the prefix)
        let note_b = workspace.join("Note B.md");
        std::fs::write(&note_b, "---\nai: true\n---\nContent of Note B is completely unique").unwrap();

        let current_note = workspace.join("Current.md");
        let current_body = "We already have hello this is Note A content here in the prefix. And we link to [[Note A]] and [[Note B]]. cursor here";
        std::fs::write(&current_note, current_body).unwrap();

        let state = crate::WorkspaceState {
            path: std::sync::Mutex::new(Some(workspace.clone())),
            watcher: std::sync::Mutex::new(None),
            download_state: crate::llm::download::new_download_state(),
            loaded_model: std::sync::Mutex::new(None),
            active_completion_cancel: std::sync::Mutex::new(None),
            active_rework_cancel: std::sync::Mutex::new(None),
            policy_engine: std::sync::Mutex::new(None),
        };

        let cursor_offset = current_body.find("cursor here").unwrap();
        let prompt = assemble_context(&workspace, &current_note, current_body, cursor_offset, &state);

        // Note A should be skipped because its content is already in the prefix
        assert!(!prompt.contains("<!-- Reference: Note A -->"));
        assert!(!prompt.contains("Hello this is Note A content\n\n")); // Only one copy of Note A content should exist (in the prefix)
        
        // Note B should be included because it is not in the prefix
        assert!(prompt.contains("<!-- Reference: Note B -->"));
        assert!(prompt.contains("Content of Note B is completely unique"));

        let _ = std::fs::remove_dir_all(&workspace);
    }
}
