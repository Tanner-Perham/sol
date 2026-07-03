import { PaneNode, LeafPane, PaneId, FileNode } from "../types";

export const findLeafNode = (node: PaneNode, targetId: PaneId): LeafPane | null => {
  if (node.type === "leaf") {
    return node.id === targetId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeafNode(child, targetId);
    if (found) return found;
  }
  return null;
};

export const getLeafPaneIds = (node: PaneNode): PaneId[] => {
  if (node.type === "leaf") {
    return [node.id];
  }
  return node.children.flatMap(getLeafPaneIds);
};

export const removePaneFromTree = (root: PaneNode, paneIdToRemove: PaneId): PaneNode | null => {
  if (root.type === "leaf") {
    if (root.id === paneIdToRemove) {
      return null;
    }
    return root;
  }

  const newChildren = root.children
    .map(child => removePaneFromTree(child, paneIdToRemove))
    .filter((child): child is PaneNode => child !== null);

  if (newChildren.length === 0) {
    return null;
  }
  if (newChildren.length === 1) {
    return newChildren[0];
  }

  return {
    ...root,
    children: newChildren
  };
};

export const findFirstMdFile = (nodes: FileNode[]): string | null => {
  for (const node of nodes) {
    if (!node.is_dir && node.path.endsWith(".md")) {
      return node.path;
    }
  }
  for (const node of nodes) {
    if (node.is_dir) {
      const found = findFirstMdFile(node.children);
      if (found) return found;
    }
  }
  return null;
};

export const findDefaultFile = (nodes: FileNode[]): string | null => {
  const rootTest = nodes.find(n => !n.is_dir && n.path === "test.md");
  if (rootTest) return "test.md";
  return findFirstMdFile(nodes);
};
