use std::path::{Path, PathBuf};
use std::collections::HashMap;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

pub struct PolicyEngine {
    workspace: PathBuf,
    gitignore: Option<Gitignore>,
    cache: HashMap<PathBuf, bool>,
}

impl PolicyEngine {
    pub fn new(workspace: PathBuf) -> Self {
        let mut engine = Self {
            workspace,
            gitignore: None,
            cache: HashMap::new(),
        };
        engine.rebuild_gitignore();
        engine
    }

    pub fn rebuild_gitignore(&mut self) {
        let solai_path = self.workspace.join(".solai");
        if solai_path.exists() {
            let mut builder = GitignoreBuilder::new(&self.workspace);
            if let Some(err) = builder.add(&solai_path) {
                eprintln!("[Policy] Error parsing .solai: {:?}", err);
            }
            match builder.build() {
                Ok(gi) => self.gitignore = Some(gi),
                Err(e) => {
                    eprintln!("[Policy] Error building gitignore: {:?}", e);
                    self.gitignore = None;
                }
            }
        } else {
            self.gitignore = None;
        }
        self.cache.clear();
    }

    pub fn invalidate_path(&mut self, path: &Path) {
        if path.file_name().and_then(|n| n.to_str()) == Some(".solai") {
            println!("[Policy] .solai changed, rebuilding policy");
            self.rebuild_gitignore();
        } else {
            // Remove resolved canonical path from cache
            if let Ok(canonical) = std::fs::canonicalize(path) {
                self.cache.remove(&canonical);
            }
            self.cache.remove(path);
        }
    }

    pub fn ai_allowed(&mut self, note_path: &Path) -> bool {
        let resolved_path = match std::fs::canonicalize(note_path) {
            Ok(p) => p,
            Err(_) => note_path.to_path_buf(),
        };

        if let Some(&allowed) = self.cache.get(&resolved_path) {
            return allowed;
        }

        let allowed = self.compute_ai_allowed(&resolved_path);
        self.cache.insert(resolved_path, allowed);
        allowed
    }

    fn compute_ai_allowed(&self, resolved_path: &Path) -> bool {
        // 1. Check per-note frontmatter override first (beats folder rules in both directions)
        if let Ok(content) = std::fs::read_to_string(resolved_path) {
            if let Some(frontmatter_ai) = parse_frontmatter_ai(&content) {
                return frontmatter_ai;
            }
        }

        // 2. Check folder/path rules from .solai
        if let Some(ref gitignore) = self.gitignore {
            let is_dir = false;
            let relative_path = resolved_path.strip_prefix(&self.workspace)
                .unwrap_or(resolved_path);
            
            let m = gitignore.matched_path_or_any_parents(relative_path, is_dir);
            if m.is_ignore() {
                return false;
            } else if m.is_whitelist() {
                return true;
            }
        }

        // 3. Default: allow
        true
    }
}

pub fn parse_frontmatter_ai(content: &str) -> Option<bool> {
    let normalized = content.replace("\r\n", "\n");
    if !normalized.starts_with("---") {
        return None;
    }
    
    let mut lines = normalized.lines();
    lines.next(); // Skip "---"
    
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(colon_idx) = trimmed.find(':') {
            let key = trimmed[..colon_idx].trim();
            let val = trimmed[colon_idx + 1..].trim();
            if key == "ai" {
                if val == "true" {
                    return Some(true);
                } else if val == "false" {
                    return Some(false);
                }
            }
        }
    }
    None
}
