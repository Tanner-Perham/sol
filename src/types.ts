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

export interface AppSettings {
  theme: "sol-dark" | "nord" | "monokai" | "forest" | "sepia" | "light" | "lego";
  fontFamily: "sans" | "serif" | "mono";
  fontSize: number;
  lineHeight: number;
  lineWrapping: boolean;
  vimMode: boolean;
  livePreview: boolean;
  completionEnabled?: boolean;
  showHidden: boolean;
  keybindings?: Keybindings;
}

export interface ModelFile {
  name: string;
  size: number;
  sha256?: string;
}

// LLM Model types
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  size_bytes: number;
  repo_id: string;
  files: ModelFile[];
}

export type ModelStatusType =
  | { status: "not_downloaded" }
  | { status: "downloading"; progress: number }
  | { status: "paused"; progress: number }
  | { status: "downloaded" }
  | { status: "active" };

export interface ModelWithStatus extends ModelInfo {
  status: ModelStatusType["status"];
  is_completion_active: boolean;
  is_rework_active: boolean;
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
