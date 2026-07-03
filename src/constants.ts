import { Keybindings, AppSettings } from "./types";

export const DEFAULT_KEYBINDINGS: Keybindings = {
  save: "mod+s",
  togglePreview: "mod+p",
  toggleSidebar: "mod+e",
  toggleFocus: "tab",
  prefixMode: "ctrl+a"
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "sol-dark",
  fontFamily: "serif",
  fontSize: 17,
  lineHeight: 1.8,
  lineWrapping: true,
  vimMode: true,
  livePreview: true,
  showHidden: false,
  keybindings: DEFAULT_KEYBINDINGS
};
