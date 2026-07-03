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
  showHidden: boolean;
  keybindings?: Keybindings;
}
