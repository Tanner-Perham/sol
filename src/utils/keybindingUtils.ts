export const matchKeybinding = (e: KeyboardEvent, keybindingStr: string): boolean => {
  if (!keybindingStr) return false;
  
  const parts = keybindingStr.toLowerCase().split("+");
  const baseKey = parts[parts.length - 1];
  
  const isMac = navigator.userAgent.indexOf("Mac") !== -1;
  const needsMod = parts.includes("mod");
  const needsMeta = parts.includes("cmd") || parts.includes("command") || parts.includes("meta");
  const needsCtrl = parts.includes("ctrl") || parts.includes("control");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt") || parts.includes("option");
  
  const hasCtrl = e.ctrlKey;
  const hasMeta = e.metaKey;
  const hasShift = e.shiftKey;
  const hasAlt = e.altKey;
  
  let matchMod = false;
  if (needsMod) {
    if (isMac) {
      if (hasMeta || hasCtrl) matchMod = true;
    } else {
      if (hasCtrl || hasMeta) matchMod = true;
    }
  } else {
    matchMod = true;
  }
  
  if (needsCtrl !== hasCtrl && !needsMod) return false;
  if (needsMeta !== hasMeta && !needsMod) return false;
  if (needsMod && !matchMod) return false;
  
  if (needsShift !== hasShift) return false;
  if (needsAlt !== hasAlt) return false;
  
  const actualKey = e.key.toLowerCase();
  const actualCode = e.code.toLowerCase();
  
  return actualKey === baseKey || actualCode === baseKey || actualCode === `key${baseKey}`;
};
