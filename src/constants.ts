import { Keybindings, AppSettings } from "./types";

export const DEFAULT_KEYBINDINGS: Keybindings = {
  newNote: "mod+n",
  save: "mod+s",
  togglePreview: "mod+p",
  toggleSidebar: "mod+e",
  toggleFocus: "tab",
  prefixMode: "ctrl+a"
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "sol-dark",
  fontFamily: "mono",
  fontSize: 17,
  lineHeight: 1.8,
  lineWrapping: true,
  vimMode: true,
  livePreview: true,
  completionEnabled: true,
  showHidden: false,
  keybindings: DEFAULT_KEYBINDINGS,
  completionDebounceMs: 400,
  completionMaxTokens: 100,
  completionTemperature: 0.35,
  completionTopP: 0.95,
  contextPrefixChars: 800,
  contextMaxLinkedNotes: 1,
  contextExcerptChars: 150,
  aiDebugEnabled: false,
  reworkTemperature: 0.3,
  reworkMaxTokensCap: 512
};
