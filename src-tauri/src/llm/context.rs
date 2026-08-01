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

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct ContextOptions {
    pub prefix_chars: usize,
    pub max_linked_notes: usize,
    pub excerpt_chars: usize,
}

impl Default for ContextOptions {
    fn default() -> Self {
        Self {
            prefix_chars: 800,
            max_linked_notes: 1,
            excerpt_chars: 150,
        }
    }
}

pub struct LinkedExcerptMeta {
    pub title: String,
    pub path: String,
    pub chars_used: usize,
}

pub struct AssembledContext {
    pub prompt: String,
    pub prefix_range_utf16: (usize, usize),
    pub linked: Vec<LinkedExcerptMeta>,
    pub prompt_token_estimate: usize,
}

struct LinkedExcerpt {
    title: String,
    path: String,
    excerpt_str: String,
    chars_used: usize,
}

/// Convert a UTF-16 code-unit offset (CodeMirror position) to a byte offset.
pub fn utf16_to_byte_offset(text: &str, utf16_offset: usize) -> usize {
    let mut u16_count = 0;
    for (byte_idx, ch) in text.char_indices() {
        if u16_count >= utf16_offset {
            return byte_idx;
        }
        u16_count += ch.len_utf16();
    }
    text.len()
}

/// Convert a byte offset to a UTF-16 code-unit offset.
pub fn byte_to_utf16_offset(text: &str, byte_offset: usize) -> usize {
    let mut u16_count = 0;
    for (byte_idx, ch) in text.char_indices() {
        if byte_idx >= byte_offset {
            return u16_count;
        }
        u16_count += ch.len_utf16();
    }
    u16_count
}

/// Convert a character index to a UTF-16 code-unit offset.
pub fn char_index_to_utf16_offset(text: &str, char_index: usize) -> usize {
    let mut u16_count = 0;
    for (i, ch) in text.chars().enumerate() {
        if i >= char_index {
            break;
        }
        u16_count += ch.len_utf16();
    }
    u16_count
}

pub fn assemble_context(
    workspace: &Path,
    note_path: &Path,
    buffer_text: &str,
    cursor_offset: usize,
    state: &crate::WorkspaceState,
    options: &ContextOptions,
) -> AssembledContext {
    // Convert cursor_offset (UTF-16) to byte index
    let byte_offset = utf16_to_byte_offset(buffer_text, cursor_offset);

    // 1. Get prefix up to byte_offset and truncate to last prefix_chars characters
    let prefix = if byte_offset <= buffer_text.len() {
        &buffer_text[..byte_offset]
    } else {
        buffer_text
    };
    let sanitized_prefix = sanitize_prompt_text(prefix);
    let char_count = sanitized_prefix.chars().count();
    let truncated_prefix: String = if char_count > options.prefix_chars {
        sanitized_prefix.chars().skip(char_count - options.prefix_chars).collect()
    } else {
        sanitized_prefix
    };

    let prefix_chars_count = prefix.chars().count();
    let prefix_from_char = prefix_chars_count.saturating_sub(options.prefix_chars);
    let prefix_from_utf16 = char_index_to_utf16_offset(prefix, prefix_from_char);
    let prefix_to_utf16 = byte_to_utf16_offset(buffer_text, byte_offset);

    let normalized_prefix = normalize_for_dedup(&truncated_prefix);

    // 2. Extract outbound links from the full buffer_text
    let targets = extract_wikilinks(buffer_text);
    
    // 3. Resolve and gate linked notes
    let mut linked_excerpts = Vec::new();
    let mut linked_count = 0;
    
    for target in targets {
        if linked_count >= options.max_linked_notes {
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

                    // Take up to excerpt_chars characters
                    let excerpt: String = sanitized.chars().take(options.excerpt_chars).collect();
                    
                    let normalized_excerpt = normalize_for_dedup(&excerpt);
                    if !normalized_excerpt.is_empty() && normalized_prefix.contains(&normalized_excerpt) {
                        // Excerpt substantially appears in prefix, skip it
                        continue;
                    }

                    let title = resolved_path.file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| target.clone());

                    let rel_path = resolved_path.strip_prefix(workspace)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| resolved_path.to_string_lossy().to_string());
                    
                    let excerpt_str = format!("<!-- Reference: {} -->\n{}\n", title, excerpt);
                    let chars_used = excerpt.chars().count();
                    
                    linked_excerpts.push(LinkedExcerpt {
                        title,
                        path: rel_path,
                        excerpt_str,
                        chars_used,
                    });
                    linked_count += 1;
                }
            }
        }
    }
    
    // 4. Combine everything
    let mut final_prompt = String::new();
    for excerpt in &linked_excerpts {
        final_prompt.push_str(&excerpt.excerpt_str);
        final_prompt.push('\n');
    }
    final_prompt.push_str(&truncated_prefix);

    let prompt_token_estimate = final_prompt.chars().count() / 4;

    AssembledContext {
        prompt: final_prompt,
        prefix_range_utf16: (prefix_from_utf16, prefix_to_utf16),
        linked: linked_excerpts.into_iter().map(|le| LinkedExcerptMeta {
            title: le.title,
            path: le.path,
            chars_used: le.chars_used,
        }).collect(),
        prompt_token_estimate,
    }
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
    fn test_utf16_boundary_conversions() {
        let text = "a😊c";
        // bytes:
        // 'a': [97] at idx 0 (len 1, len_utf16 1)
        // '😊': [240, 159, 152, 138] at idx 1 (len 4, len_utf16 2)
        // 'c': [99] at idx 5 (len 1, len_utf16 1)
        // total len = 6 bytes, 4 utf16 code units, 3 chars

        // utf16 -> byte offset
        assert_eq!(utf16_to_byte_offset(text, 0), 0);
        assert_eq!(utf16_to_byte_offset(text, 1), 1);
        assert_eq!(utf16_to_byte_offset(text, 2), 5); // lands mid-emoji, returns start of next char ('c')
        assert_eq!(utf16_to_byte_offset(text, 3), 5);
        assert_eq!(utf16_to_byte_offset(text, 4), 6);
        assert_eq!(utf16_to_byte_offset(text, 10), 6);

        // byte -> utf16 offset
        assert_eq!(byte_to_utf16_offset(text, 0), 0);
        assert_eq!(byte_to_utf16_offset(text, 1), 1);
        assert_eq!(byte_to_utf16_offset(text, 2), 3); // mid-emoji, returns start of 'c' (offset 3)
        assert_eq!(byte_to_utf16_offset(text, 5), 3);
        assert_eq!(byte_to_utf16_offset(text, 6), 4);
        assert_eq!(byte_to_utf16_offset(text, 20), 4);

        // char index -> utf16 offset
        assert_eq!(char_index_to_utf16_offset(text, 0), 0);
        assert_eq!(char_index_to_utf16_offset(text, 1), 1);
        assert_eq!(char_index_to_utf16_offset(text, 2), 3);
        assert_eq!(char_index_to_utf16_offset(text, 3), 4);
        assert_eq!(char_index_to_utf16_offset(text, 10), 4);
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
        let assembled = assemble_context(&workspace, &current_note, current_body, cursor_offset, &state, &ContextOptions::default());

        // Assert prompt contains Note A's content and does NOT contain Note B's content (due to ai: false)
        assert!(assembled.prompt.contains("Content of note A"));
        assert!(!assembled.prompt.contains("Content of note B"));
        assert!(assembled.prompt.contains("This is a note linking to"));
        assert!(assembled.prompt.contains("<!-- Reference: Note A -->"));
        
        // Assert telemetry fields are filled
        assert_eq!(assembled.prefix_range_utf16.1, cursor_offset);
        assert_eq!(assembled.linked.len(), 1);
        assert_eq!(assembled.linked[0].title, "Note A");

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
        let assembled = assemble_context(&workspace, &current_note, current_body, cursor_offset, &state, &ContextOptions::default());

        // Note A should be skipped because its content is already in the prefix
        assert!(!assembled.prompt.contains("<!-- Reference: Note A -->"));
        assert!(!assembled.prompt.contains("Hello this is Note A content\n\n")); // Only one copy of Note A content should exist (in the prefix)
        
        // Note B should be included because it is not in the prefix
        assert!(assembled.prompt.contains("<!-- Reference: Note B -->"));
        assert!(assembled.prompt.contains("Content of Note B is completely unique"));

        let _ = std::fs::remove_dir_all(&workspace);
    }
}
