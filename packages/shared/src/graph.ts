import type { ModuleGraph } from "./types";

/**
 * The module map as Mermaid source.
 *
 * Mermaid is the one diagram format that renders natively in a GitHub README,
 * which is why the web report offers it as copyable text beside the drawn SVG.
 * A terminal cannot draw the SVG at all, so for the CLI this is not a
 * convenience — it is the only way the graph leaves the tool.
 *
 * Pure, and deliberately not a component: it was defined inside `ModuleMap.tsx`,
 * where nothing outside the web app could reach it. Reimplementing it for the
 * CLI would have been a second emitter for one graph, which is the shape this
 * project's own `duplicate-logic` signal exists to flag.
 *
 * Edges are filtered against the node set because `ModuleGraph` is capped at a
 * readable number of directories, and an edge pointing at an omitted node would
 * render as a phantom box with no label.
 */
export function toMermaid(graph: ModuleGraph): string {
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
