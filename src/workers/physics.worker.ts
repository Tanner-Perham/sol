/**
 * Physics WebWorker for Semantic Cloud
 * Runs ForceAtlas2 layout algorithm off the main thread
 */

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

// ForceAtlas2 settings type (defined locally as the library doesn't export it well)
interface ForceAtlas2Settings {
  gravity?: number;
  scalingRatio?: number;
  slowDown?: number;
  barnesHutOptimize?: boolean;
  barnesHutTheta?: number;
  strongGravityMode?: boolean;
  outboundAttractionDistribution?: boolean;
  linLogMode?: boolean;
  adjustSizes?: boolean;
  edgeWeightInfluence?: number;
}

interface NodeData {
  id: string;
  x: number;
  y: number;
  size: number;
  label: string;
  type: "note" | "label";
}

interface EdgeData {
  source: string;
  target: string;
  weight: number;
}

interface InitMessage {
  type: "init";
  nodes: NodeData[];
  edges: EdgeData[];
  settings?: Partial<ForceAtlas2Settings>;
}

interface StartMessage {
  type: "start";
  iterations?: number;
}

interface StopMessage {
  type: "stop";
}

interface AddNodeMessage {
  type: "addNode";
  node: NodeData;
  edges: EdgeData[];
}

interface RemoveNodeMessage {
  type: "removeNode";
  nodeId: string;
}

interface UpdateSettingsMessage {
  type: "updateSettings";
  settings: Partial<ForceAtlas2Settings>;
}

type WorkerMessage =
  | InitMessage
  | StartMessage
  | StopMessage
  | AddNodeMessage
  | RemoveNodeMessage
  | UpdateSettingsMessage;

interface PositionUpdate {
  type: "positions";
  positions: Record<string, { x: number; y: number }>;
  iteration: number;
  converged: boolean;
}

interface ErrorMessage {
  type: "error";
  message: string;
}


// State
let graph: Graph | null = null;
let isRunning = false;
let currentIteration = 0;
let maxIterations = 500;
let settings: ForceAtlas2Settings = {
  gravity: 1,
  scalingRatio: 10,
  slowDown: 1,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
  strongGravityMode: false,
  outboundAttractionDistribution: false,
  linLogMode: false,
  adjustSizes: false,
  edgeWeightInfluence: 1,
};

function sendPositions(converged: boolean = false) {
  if (!graph) return;

  const positions: Record<string, { x: number; y: number }> = {};
  graph.forEachNode((node, attrs) => {
    positions[node] = { x: attrs.x, y: attrs.y };
  });

  const response: PositionUpdate = {
    type: "positions",
    positions,
    iteration: currentIteration,
    converged,
  };

  self.postMessage(response);
}

function runLayoutStep() {
  if (!graph || !isRunning) return;

  // Run a batch of iterations
  const batchSize = 5;
  for (let i = 0; i < batchSize && currentIteration < maxIterations; i++) {
    forceAtlas2.assign(graph, { iterations: 1, settings });
    currentIteration++;
  }

  // Send position update
  const converged = currentIteration >= maxIterations;
  sendPositions(converged);

  if (converged) {
    isRunning = false;
  } else {
    // Schedule next batch
    setTimeout(runLayoutStep, 16); // ~60fps
  }
}

function initGraph(nodes: NodeData[], edges: EdgeData[]) {
  graph = new Graph();

  // Add nodes
  for (const node of nodes) {
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: node.size,
      label: node.label,
      type: node.type,
    });
  }

  // Add edges
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      try {
        graph.addEdge(edge.source, edge.target, { weight: edge.weight });
      } catch {
        // Edge already exists, skip
      }
    }
  }

  currentIteration = 0;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init": {
        isRunning = false;
        if (msg.settings) {
          settings = { ...settings, ...msg.settings };
        }
        initGraph(msg.nodes, msg.edges);
        // Send initial positions
        sendPositions(false);
        break;
      }

      case "start": {
        if (!graph) {
          throw new Error("Graph not initialized");
        }
        maxIterations = msg.iterations ?? 500;
        currentIteration = 0;
        isRunning = true;
        runLayoutStep();
        break;
      }

      case "stop": {
        isRunning = false;
        break;
      }

      case "addNode": {
        if (!graph) {
          throw new Error("Graph not initialized");
        }

        const { node, edges } = msg;

        // Add the node if it doesn't exist
        if (!graph.hasNode(node.id)) {
          graph.addNode(node.id, {
            x: node.x,
            y: node.y,
            size: node.size,
            label: node.label,
            type: node.type,
          });
        }

        // Add edges
        for (const edge of edges) {
          if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
            try {
              graph.addEdge(edge.source, edge.target, { weight: edge.weight });
            } catch {
              // Edge already exists
            }
          }
        }

        // Reset iteration count to allow more settling
        currentIteration = Math.max(0, currentIteration - 50);
        break;
      }

      case "removeNode": {
        if (!graph) {
          throw new Error("Graph not initialized");
        }

        if (graph.hasNode(msg.nodeId)) {
          graph.dropNode(msg.nodeId);
        }
        break;
      }

      case "updateSettings": {
        settings = { ...settings, ...msg.settings };
        break;
      }

      default:
        // Unknown message type
        break;
    }
  } catch (error) {
    const errorResponse: ErrorMessage = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(errorResponse);
  }
};

// Signal that worker is ready
self.postMessage({ type: "ready" });
