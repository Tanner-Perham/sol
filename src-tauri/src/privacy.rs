use glob::Pattern;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Access policy for controlling which files are included in AI features like semantic indexing.
/// Files matching exclude patterns or paths are structurally absent from embeddings and the cloud.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccessPolicy {
    /// Glob patterns to exclude (e.g., "journal/**", "*.private.md")
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Explicit relative paths to exclude
    #[serde(default)]
    pub exclude_paths: Vec<String>,
}

impl AccessPolicy {
    /// Load access policy from the workspace's .sol/settings.json
    pub fn load(workspace: &Path) -> Self {
        let settings_file = workspace.join(".sol").join("settings.json");
        if !settings_file.exists() {
            return Self::default();
        }

        let contents = match fs::read_to_string(&settings_file) {
            Ok(c) => c,
            Err(_) => return Self::default(),
        };

        // Parse the settings JSON and extract accessPolicy field
        let json: serde_json::Value = match serde_json::from_str(&contents) {
            Ok(v) => v,
            Err(_) => return Self::default(),
        };

        if let Some(policy) = json.get("accessPolicy") {
            match serde_json::from_value(policy.clone()) {
                Ok(p) => p,
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Check if a path (relative to workspace) is allowed by the policy.
    /// Returns true if the path passes all filters (not excluded).
    pub fn is_path_allowed(&self, relative_path: &str) -> bool {
        // Check explicit path exclusions
        for excluded in &self.exclude_paths {
            if relative_path == excluded || relative_path.starts_with(&format!("{}/", excluded)) {
                return false;
            }
        }

        // Check glob pattern exclusions
        for pattern_str in &self.exclude_patterns {
            if let Ok(pattern) = Pattern::new(pattern_str) {
                if pattern.matches(relative_path) {
                    return false;
                }
            }
        }

        true
    }

    /// Filter a list of file paths, returning only those allowed by the policy.
    pub fn filter_allowed(&self, paths: Vec<PathBuf>, workspace: &Path) -> Vec<PathBuf> {
        paths
            .into_iter()
            .filter(|path| {
                if let Ok(relative) = path.strip_prefix(workspace) {
                    let relative_str = relative.to_string_lossy();
                    self.is_path_allowed(&relative_str)
                } else {
                    // If we can't get relative path, allow it (shouldn't happen normally)
                    true
                }
            })
            .collect()
    }
}

/// Collect all markdown files in a workspace directory recursively.
pub fn collect_markdown_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_markdown_files_recursive(dir, &mut files)?;
    Ok(files)
}

fn collect_markdown_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() || !dir.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip hidden files and directories
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            collect_markdown_files_recursive(&path, files)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("md") {
                    files.push(path);
                }
            }
        }
    }

    Ok(())
}

/// Get all indexable markdown files in a workspace, respecting the access policy.
pub fn get_indexable_files(workspace: &Path) -> Result<Vec<PathBuf>, String> {
    let policy = AccessPolicy::load(workspace);
    let all_files = collect_markdown_files(workspace)?;
    Ok(policy.filter_allowed(all_files, workspace))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_policy_allows_all() {
        let policy = AccessPolicy::default();
        assert!(policy.is_path_allowed("notes/hello.md"));
        assert!(policy.is_path_allowed("any/path/file.md"));
    }

    #[test]
    fn test_exclude_paths() {
        let policy = AccessPolicy {
            exclude_paths: vec!["journal".to_string(), "private/secrets".to_string()],
            exclude_patterns: vec![],
        };

        assert!(!policy.is_path_allowed("journal"));
        assert!(!policy.is_path_allowed("journal/2024-01-01.md"));
        assert!(!policy.is_path_allowed("private/secrets"));
        assert!(!policy.is_path_allowed("private/secrets/deep/file.md"));
        assert!(policy.is_path_allowed("notes/hello.md"));
        assert!(policy.is_path_allowed("private/public.md"));
    }

    #[test]
    fn test_exclude_patterns() {
        let policy = AccessPolicy {
            exclude_paths: vec![],
            exclude_patterns: vec!["*.private.md".to_string(), "drafts/**".to_string()],
        };

        assert!(!policy.is_path_allowed("secret.private.md"));
        assert!(!policy.is_path_allowed("notes/todo.private.md"));
        assert!(policy.is_path_allowed("notes/todo.md"));
    }
}
