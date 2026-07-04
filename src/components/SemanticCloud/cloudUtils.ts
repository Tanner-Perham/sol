/**
 * Utility functions for the Semantic Cloud visualization
 */

export interface CloudNode {
  id: string;
  type: "note" | "label";
  label: string;
  x: number;
  y: number;
  size: number;
  embedding?: number[];
}

export interface CloudEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * Project high-dimensional embeddings to 2D using simple random projection.
 * This provides a quick initial layout that the physics engine will refine.
 */
export function projectEmbeddings(
  embeddings: Map<string, number[]>,
  width: number,
  height: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  if (embeddings.size === 0) return positions;

  // Get embedding dimension
  const firstEmbedding = embeddings.values().next().value;
  if (!firstEmbedding) return positions;

  const dim = firstEmbedding.length;

  // Create random projection matrix (2 x dim)
  // Use a seeded random for reproducibility
  const seed = 42;
  const projMatrix: number[][] = [[], []];
  for (let i = 0; i < dim; i++) {
    // Simple LCG random
    const r1 = Math.sin(seed * (i + 1)) * 10000;
    const r2 = Math.sin(seed * (i + 2)) * 10000;
    projMatrix[0].push((r1 - Math.floor(r1)) * 2 - 1);
    projMatrix[1].push((r2 - Math.floor(r2)) * 2 - 1);
  }

  // Project each embedding
  const projectedPoints: { id: string; x: number; y: number }[] = [];

  embeddings.forEach((embedding, id) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i++) {
      x += embedding[i] * projMatrix[0][i];
      y += embedding[i] * projMatrix[1][i];
    }
    projectedPoints.push({ id, x, y });
  });

  // Normalize to fit within bounds with padding
  const padding = 50;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const p of projectedPoints) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  for (const p of projectedPoints) {
    const normX = (p.x - minX) / rangeX;
    const normY = (p.y - minY) / rangeY;
    positions.set(p.id, {
      x: padding + normX * (width - 2 * padding),
      y: padding + normY * (height - 2 * padding),
    });
  }

  return positions;
}

/**
 * Compute similarity edges between nodes based on their embeddings.
 * Only creates edges above the similarity threshold.
 */
export function computeSimilarityEdges(
  embeddings: Map<string, number[]>,
  threshold: number = 0.3
): CloudEdge[] {
  const edges: CloudEdge[] = [];
  const ids = Array.from(embeddings.keys());

  for (let i = 0; i < ids.length; i++) {
    const embA = embeddings.get(ids[i])!;
    for (let j = i + 1; j < ids.length; j++) {
      const embB = embeddings.get(ids[j])!;
      const sim = cosineSimilarity(embA, embB);

      if (sim > threshold) {
        edges.push({
          source: ids[i],
          target: ids[j],
          weight: sim,
        });
      }
    }
  }

  return edges;
}

/**
 * Compute node size based on connectivity or other metrics.
 * Nodes with more connections are larger.
 */
export function computeNodeSizes(
  nodeIds: string[],
  edges: CloudEdge[],
  minSize: number = 8,
  maxSize: number = 24
): Map<string, number> {
  const sizes = new Map<string, number>();

  // Count connections per node
  const connectionCounts = new Map<string, number>();
  for (const id of nodeIds) {
    connectionCounts.set(id, 0);
  }

  for (const edge of edges) {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + edge.weight);
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + edge.weight);
  }

  // Find min and max
  let minCount = Infinity;
  let maxCount = 0;
  connectionCounts.forEach((count) => {
    minCount = Math.min(minCount, count);
    maxCount = Math.max(maxCount, count);
  });

  const range = maxCount - minCount || 1;

  // Normalize to size range
  connectionCounts.forEach((count, id) => {
    const normalized = (count - minCount) / range;
    sizes.set(id, minSize + normalized * (maxSize - minSize));
  });

  return sizes;
}

/**
 * Get a color for a node based on its type
 */
export function getNodeColor(type: "note" | "label", isSelected: boolean): string {
  if (isSelected) {
    return "var(--accent)";
  }
  return type === "label" ? "var(--accent)" : "var(--text-muted)";
}

/**
 * Extract display label from a note path
 */
export function pathToLabel(path: string): string {
  // Remove extension and get filename
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.md$/, "");
}
