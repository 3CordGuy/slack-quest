// Expedition map — pure SVG render of the node graph.
//
// Props are intentionally narrow so this component can be reused for
// "view a completed run" later. No data fetching, no state.
//
// Visual language borrows from Town.tsx's WardMap:
//   * dark surface, kind-coded glyphs
//   * available picks glow with the accent gold border
//   * resolved nodes greyed with a checkmark overlay
//   * the current node is highlighted with a halo
//
// Layout: nodes are placed on an integer (depth, lane) grid. Depth runs
// left-to-right (start on the left, boss on the right). Lanes stack
// vertically; we center each depth's realized lanes within the column to
// avoid empty rows.

import type { ExpeditionMap, ExpeditionNode, NodeKind } from "@gantt-quest/core";

export interface ExpeditionMapViewProps {
  map: ExpeditionMap;
  /** node_id the party is currently sitting on. null = start. */
  currentNode: string | null;
  /** node_ids that have a recorded outcome. */
  resolvedNodeIds: ReadonlySet<string>;
  /** node_ids the player may pick right now (next move). */
  availablePickIds: ReadonlySet<string>;
  /** Click handler — fires only for nodes in availablePickIds. */
  onPick: (nodeId: string) => void;
}

// Visual constants
const NODE_R = 18;
const COL_W = 86;
const ROW_H = 60;
const PAD_X = 40;
const PAD_Y = 40;

const KIND_GLYPH: Record<NodeKind, string> = {
  start: "▶",
  combat: "⚔",
  elite: "★",
  event: "?",
  shrine: "✦",
  camp: "△",
  treasure: "◆",
  boss: "☠",
};

const KIND_COLOR: Record<NodeKind, string> = {
  start: "#9aa0a6",
  combat: "#d9534f",
  elite: "#e6b85c",
  event: "#5bc0de",
  shrine: "#a78bfa",
  camp: "#7bd389",
  treasure: "#f0ad4e",
  boss: "#c9303c",
};

const KIND_LABEL: Record<NodeKind, string> = {
  start: "Start",
  combat: "Combat",
  elite: "Elite",
  event: "Event",
  shrine: "Shrine",
  camp: "Camp",
  treasure: "Treasure",
  boss: "Boss",
};

export function ExpeditionMapView({
  map,
  currentNode,
  resolvedNodeIds,
  availablePickIds,
  onPick,
}: ExpeditionMapViewProps) {
  // Position each node. Depth is the X axis, lane is the Y axis. START
  // sits at depth=-1 (rendered as column 0) and BOSS at depth=map.depth.
  // Centerline lane (laneCount/2) sits in the middle of the canvas.
  const laneCount = map.laneCount;
  const cols = map.depth + 2; // start + intermediate depths + boss
  const width = PAD_X * 2 + cols * COL_W;
  const height = PAD_Y * 2 + laneCount * ROW_H;

  function nodePos(node: ExpeditionNode): { x: number; y: number } {
    if (node.kind === "start") {
      // Vertically centered at the left.
      return { x: PAD_X + COL_W / 2, y: PAD_Y + (laneCount * ROW_H) / 2 };
    }
    if (node.kind === "boss") {
      return { x: PAD_X + (cols - 0.5) * COL_W, y: PAD_Y + (laneCount * ROW_H) / 2 };
    }
    const col = node.depth + 1; // shift to leave column 0 for start
    const x = PAD_X + (col + 0.5) * COL_W;
    const y = PAD_Y + (node.lane + 0.5) * ROW_H;
    return { x, y };
  }

  // Pre-position all nodes once.
  const positions = new Map<string, { x: number; y: number }>();
  for (const n of map.nodes) positions.set(n.id, nodePos(n));

  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 12,
        overflowX: "auto",
        boxSizing: "border-box",
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", maxWidth: "100%", height: "auto" }}
      >
        {/* Edges first so node glyphs render over them. */}
        {map.edges.map((e, i) => {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          if (!a || !b) return null;
          // Color reflects whether the path has been traveled.
          const isResolvedEdge =
            (e.from === "start" || resolvedNodeIds.has(e.from)) &&
            (e.to === "boss" ? false : resolvedNodeIds.has(e.to) || currentNode === e.to);
          const fromIsCurrent = e.from === (currentNode ?? "start");
          const isAvailable = fromIsCurrent && availablePickIds.has(e.to);
          const stroke = isResolvedEdge
            ? "var(--fg-mute)"
            : isAvailable
              ? "var(--accent-gold)"
              : "var(--border-faint)";
          const opacity = isAvailable ? 0.9 : 0.55;
          return (
            <line
              key={`e-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={isAvailable ? 2.5 : 1.5}
              opacity={opacity}
            />
          );
        })}

        {/* Nodes */}
        {map.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const resolved = resolvedNodeIds.has(n.id);
          const isCurrent = currentNode === n.id || (currentNode == null && n.kind === "start");
          const isAvailable = availablePickIds.has(n.id);
          const fill = isCurrent ? "var(--bg-elev)" : "var(--bg-card)";
          const stroke = isAvailable
            ? "var(--accent-gold)"
            : isCurrent
              ? KIND_COLOR[n.kind]
              : resolved
                ? "var(--border-faint)"
                : "var(--border-base)";
          const strokeWidth = isAvailable ? 3 : isCurrent ? 2 : 1;
          const glyphColor = resolved ? "var(--fg-faint)" : KIND_COLOR[n.kind];
          const cursor = isAvailable ? "pointer" : "default";
          const opacity = resolved ? 0.6 : 1;
          return (
            <g
              key={n.id}
              onClick={isAvailable ? () => onPick(n.id) : undefined}
              style={{ cursor }}
            >
              {/* Outer glow for available picks */}
              {isAvailable && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={NODE_R + 6}
                  fill="none"
                  stroke="var(--accent-gold)"
                  strokeOpacity={0.35}
                  strokeWidth={2}
                />
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={NODE_R}
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
                opacity={opacity}
              />
              <text
                x={p.x}
                y={p.y + 5}
                textAnchor="middle"
                fontSize={16}
                fontWeight={700}
                fill={glyphColor}
                opacity={opacity}
                style={{ userSelect: "none" }}
              >
                {KIND_GLYPH[n.kind]}
              </text>
              {/* Resolved checkmark overlay */}
              {resolved && (
                <text
                  x={p.x + NODE_R - 4}
                  y={p.y - NODE_R + 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--fg-mute)"
                  style={{ userSelect: "none" }}
                >
                  ✓
                </text>
              )}
              {/* Kind label below node, smaller and only on first-time reveal */}
              <text
                x={p.x}
                y={p.y + NODE_R + 12}
                textAnchor="middle"
                fontSize={9}
                fill={resolved ? "var(--fg-faintest)" : "var(--fg-mute)"}
                opacity={0.85}
                style={{ userSelect: "none", textTransform: "uppercase", letterSpacing: 0.5 }}
              >
                {KIND_LABEL[n.kind]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
