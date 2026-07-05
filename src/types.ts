export type PaneId = string;

export interface LeafPane {
  type: "leaf";
  id: PaneId;
  activeFile: string | null;
  tabs: string[];
}

export interface SplitPane {
  type: "split";
  id: PaneId;
  direction: "vertical" | "horizontal";
  children: PaneNode[];
}

export type PaneNode = LeafPane | SplitPane;

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

export interface Keybindings {
  save: string;
  togglePreview: string;
  toggleSidebar: string;
  toggleFocus: string;
  prefixMode: string;
}

// Privacy/Access Policy - controls which files are included in AI features
export interface AccessPolicy {
  excludePatterns: string[];  // Glob patterns like "journal/**", "*.private.md"
  excludePaths: string[];     // Explicit relative paths to exclude
}

export interface AppSettings {
  theme: "sol-dark" | "nord" | "monokai" | "forest" | "sepia" | "light" | "lego";
  fontFamily: "sans" | "serif" | "mono";
  fontSize: number;
  lineHeight: number;
  lineWrapping: boolean;
  vimMode: boolean;
  livePreview: boolean;
  showHidden: boolean;
  keybindings?: Keybindings;
  accessPolicy?: AccessPolicy;
}

// Anchored label - a user-defined semantic anchor point
export interface AnchoredLabel {
  id: string;
  name: string;
  embedding: number[];
  created_at: number;
}

// A note with its similarity score from semantic search
export interface SimilarNote {
  path: string;
  score: number;
  title: string;
}

// A discovered topic candidate from the discovery engine
export interface DiscoveryCandidate {
  id: string;
  suggested_name: string;
  centroid: number[];
  note_paths: string[];
  scan_count: number;
  first_seen: number;
  last_seen: number;
  score: number;
}

// LLM Model types
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  size_bytes: number;
  repo_id: string;
  files: string[];
}

export type ModelStatusType =
  | { status: "not_downloaded" }
  | { status: "downloading"; progress: number }
  | { status: "paused"; progress: number }
  | { status: "downloaded" }
  | { status: "active" };

export interface ModelWithStatus extends ModelInfo {
  status: ModelStatusType["status"];
}

export interface DownloadProgress {
  model_id: string;
  file_name: string;
  file_index: number;
  total_files: number;
  bytes_downloaded: number;
  total_bytes: number;
  status: "downloading" | "completed" | "error" | "cancelled";
  error?: string;
}
