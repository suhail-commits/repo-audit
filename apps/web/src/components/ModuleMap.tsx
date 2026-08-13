import type { ModuleGraph } from "@vibe/shared";

/**
 * The shape of the codebase, drawn from the imports the index already resolved.
 *
 * Laid out and rendered by hand rather than through a diagram library. This
 * project flags dependency bloat with six runtime dependencies of its own, and
 * a chart package is a large one to add for a picture of twelve boxes — the
 * layered layout below is about forty lines.
 *
 * **Layered by dependency depth, not alphabetically.** The whole claim a
 * diagram like this makes is "things at the top use things at the bottom", so
 * the vertical position has to carry that or the picture is decorative.
 */

const NODE_WIDTH = 150;
const NODE_HEIGHT = 38;
const GAP_X = 22;
const GAP_Y = 58;
const PADDING = 8;

export function ModuleMap({ graph }: { graph: ModuleGraph }) {
  const layers = layerNodes(graph);
  const widest = Math.max(...layers.map((l) => l.length));
  const width = widest * NODE_WIDTH + (widest - 1) * GAP_X + PADDING * 2;
  const height = layers.length * NODE_HEIGHT + (layers.length - 1) * GAP_Y + PADDING * 2;

  const at = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, row) => {
    // Centre each row against the widest one, so a narrow layer does not sit
    // hard against the left edge.
    const rowWidth = layer.length * NODE_WIDTH + (layer.length - 1) * GAP_X;
    const left = PADDING + (width - PADDING * 2 - rowWidth) / 2;
    layer.forEach((node, column) => {
      at.set(node, {
        x: left + column * (NODE_WIDTH + GAP_X),
        y: PADDING + row * (NODE_HEIGHT + GAP_Y),
      });
    });
  });

  const heaviest = Math.max(...graph.edges.map((e) => e.count), 1);

  return (
    <div className="module-map">
      <div className="module-map-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`Module map: ${graph.nodes.length} directories, ${graph.edges.length} dependencies between them`}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {graph.edges.map((edge, i) => {
            const from = at.get(edge.from);
            const to = at.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={i}
                x1={from.x + NODE_WIDTH / 2}
                y1={from.y + NODE_HEIGHT}
                x2={to.x + NODE_WIDTH / 2}
                y2={to.y}
                className="module-edge"
                // One hue, thickness varying by how many imports the edge
                // stands for. A colour per edge would be a categorical
                // encoding of a magnitude.
                strokeWidth={1 + (edge.count / heaviest) * 2.5}
                markerEnd="url(#arrow)"
              />
            );
          })}

          {graph.nodes.map((node) => {
            const pos = at.get(node.path);
            if (!pos) return null;
            return (
              <g key={node.path} transform={`translate(${pos.x} ${pos.y})`}>
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx="4"
                  className="module-node"
                />
                <text x={NODE_WIDTH / 2} y="17" className="module-node-label">
                  {truncate(node.path)}
                </text>
                <text x={NODE_WIDTH / 2} y="30" className="module-node-meta">
                  {node.files} {node.files === 1 ? "file" : "files"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="hint hint-flush">
        Directories, not files &mdash; a file-by-file diagram of a project this
        size is unreadable. Arrows point from a directory to what it imports;
        thicker means more imports.
        {graph.omitted > 0
          ? ` ${graph.omitted} smaller ${graph.omitted === 1 ? "directory is" : "directories are"} not shown.`
          : ""}
      </p>

      {/*
        The same graph as text. GitHub renders Mermaid in Markdown, so this is
        the half someone can actually put in their own README — which is the
        point of building it at all.
      */}
      <details className="breakdown-details">
        <summary>
          Mermaid source
          <span className="meta"> &mdash; paste into a README</span>
        </summary>
        <pre className="mermaid-source">
          <code>{toMermaid(graph)}</code>
        </pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** `packages/engine/src` is unreadable in a 150px box; the tail is the part that identifies it. */
function truncate(path: string, max = 22): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

/**
 * Assign each directory to a row by how deep it sits in the dependency order.
 *
 * A plain longest-path walk would not terminate on a cycle, and cycles between
 * directories are common and legitimate — two modules importing each other's
 * types. Visited tracking bounds it, and anything inside a cycle simply lands
 * on the first row that reached it.
 */
function layerNodes(graph: ModuleGraph): string[][] {
  const dependsOn = new Map<string, string[]>();
  for (const edge of graph.edges) {
    dependsOn.set(edge.from, [...(dependsOn.get(edge.from) ?? []), edge.to]);
  }

  const depth = new Map<string, number>();
  const walk = (node: string, seen: Set<string>): number => {
    const cached = depth.get(node);
    if (cached !== undefined) return cached;
    if (seen.has(node)) return 0;

    seen.add(node);
    const children = dependsOn.get(node) ?? [];
    const own =
      children.length === 0
        ? 0
        : 1 + Math.max(...children.map((c) => walk(c, seen)));
    seen.delete(node);
    depth.set(node, own);
    return own;
  };

  for (const node of graph.nodes) walk(node.path, new Set());

  const maxDepth = Math.max(...graph.nodes.map((n) => depth.get(n.path) ?? 0));
  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of graph.nodes) {
    // Deepest dependents on top, so arrows read downward.
    layers[maxDepth - (depth.get(node.path) ?? 0)]!.push(node.path);
  }

  return layers.filter((l) => l.length > 0);
}

function toMermaid(graph: ModuleGraph): string {
  const id = new Map<string, string>();
  graph.nodes.forEach((node, i) => id.set(node.path, `n${i}`));

  return [
    "graph TD",
    ...graph.nodes.map(
      (n) => `  ${id.get(n.path)}["${n.path}<br/>${n.files} files"]`,
    ),
    ...graph.edges
      .filter((e) => id.has(e.from) && id.has(e.to))
      .map((e) => `  ${id.get(e.from)} --> ${id.get(e.to)}`),
  ].join("\n");
}
