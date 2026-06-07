// Expedition map — pure SVG render of the node graph.
//
// Props are intentionally narrow so this component can be reused for
// "view a completed run" later. No data fetching, no state.
//
// Visual language: aged parchment background (CSS for now — flux-generated
// variants are queued as a follow-up), SVG icons via the shared <Icon>
// component, dim dashed lines for potential routes, solid colored lines
// for the path the party has already walked.
//
// Layout: nodes are placed on an integer (depth, lane) grid. Depth runs
// left-to-right on desktop, top-to-bottom on mobile (vertical rotation
// based on useIsMobile so a 15-node graph fits a phone column cleanly).

import type { ExpeditionMap, ExpeditionNode, NodeKind } from "@gantt-quest/core";
import { useIsMobile } from "../CombatShared";
import { Icon } from "../icons";

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
  /**
   * Flux-generated parchment background. When set, renders inside the SVG
   * behind nodes/edges. When null/undefined, the CSS parchment gradient
   * carries the look (PR #221 baseline + cache miss).
   */
  artUrl?: string | null;
}

// Visual constants
const NODE_R = 20;
const ICON_SIZE = 22;
const COL_W = 90;
const ROW_H = 64;
const PAD_X = 44;
const PAD_Y = 44;

// Per-kind iconography — drawn from /public/icons/*. Kind→icon picks
// aim for "reads at a glance": crossed swords for combat, a spinning
// sword for elite, a quill scroll for unknown events, a star altar
// for shrines, a tent for camps, a treasure chest for treasure, a
// skull for the boss, footprints for the start.
const KIND_ICON: Record<NodeKind, string> = {
  start: "footprint",
  combat: "broadsword",
  elite: "brutal-helm",
  event: "scroll-quill",
  shrine: "star-altar",
  camp: "camping-tent",
  treasure: "chest",
  boss: "death-skull",
};

// Colors picked to read on a warm parchment background — slightly muted,
// closer to ink and seal-wax than the high-saturation tones the prior dark
// theme used. Adjust here if the parchment background changes hue.
const KIND_COLOR: Record<NodeKind, string> = {
  start: "#6b5e4a",
  combat: "#a83232",
  elite: "#b88a2c",
  event: "#3a7ca8",
  shrine: "#7a5cb8",
  camp: "#3f7b3f",
  treasure: "#b8772c",
  boss: "#7a1f1f",
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
  artUrl,
}: ExpeditionMapViewProps) {
  // Desktop: depth on X (start left, boss right), lanes stacked vertically.
  // Mobile portrait: rotate 90° — depth on Y (start top, boss bottom).
  const vertical = useIsMobile(640);
  const laneCount = map.laneCount;
  const cols = map.depth + 2;
  const depthExtent = PAD_X * 2 + cols * COL_W;
  const laneExtent = PAD_Y * 2 + laneCount * ROW_H;
  const width = vertical ? laneExtent : depthExtent;
  const height = vertical ? depthExtent : laneExtent;

  function nodePos(node: ExpeditionNode): { x: number; y: number } {
    let depthAxis: number;
    let laneAxis: number;
    if (node.kind === "start") {
      depthAxis = PAD_X + COL_W / 2;
      laneAxis = PAD_Y + (laneCount * ROW_H) / 2;
    } else if (node.kind === "boss") {
      depthAxis = PAD_X + (cols - 0.5) * COL_W;
      laneAxis = PAD_Y + (laneCount * ROW_H) / 2;
    } else {
      const col = node.depth + 1;
      depthAxis = PAD_X + (col + 0.5) * COL_W;
      laneAxis = PAD_Y + (node.lane + 0.5) * ROW_H;
    }
    return vertical ? { x: laneAxis, y: depthAxis } : { x: depthAxis, y: laneAxis };
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of map.nodes) positions.set(n.id, nodePos(n));

  return (
    <div
      style={{
        // Outer card — warm parchment + a vignette to suggest aged paper
        // edges. The SVG <filter id="parchment-noise"> below adds a subtle
        // grain on top so it doesn't read as a flat color block. Flux-
        // generated illustrated variants will replace this in a follow-up;
        // until then this pure-CSS layer carries the vibe.
        background: `
          radial-gradient(ellipse at 50% 40%, #f0e3c2 0%, #d9c69a 70%, #b89c69 100%),
          #d9c69a
        `,
        border: "1px solid #8a6f3e",
        borderRadius: "var(--radius-2xl)",
        padding: 16,
        overflowX: "auto",
        boxSizing: "border-box",
        // Subtle shadow inside the card to deepen the parchment look —
        // not a real torn-edge but it leans the same direction.
        boxShadow: "inset 0 0 40px rgba(122, 92, 50, 0.35)",
        position: "relative",
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        // Mode-aware sizing:
        //  - vertical (mobile): style width: 100% so the narrow intrinsic
        //    SVG scales UP to fill the card; nodes become tappable.
        //    preserveAspectRatio keeps proportions; height auto-scales.
        //  - horizontal (desktop): use the intrinsic SVG width/height
        //    attributes so the wide map renders at full natural size and
        //    the wrapper's overflowX: auto provides a horizontal scroll
        //    when the card isn't wide enough. style: maxWidth: 100%
        //    still lets it shrink on truly narrow viewports.
        {...(vertical ? {} : { width, height })}
        style={vertical
          ? {
              display: "block",
              width: "100%",
              height: "auto",
              marginLeft: "auto",
              marginRight: "auto",
            }
          : {
              display: "block",
              maxWidth: "100%",
              height: "auto",
              marginLeft: "auto",
              marginRight: "auto",
            }
        }
      >
        <defs>
          {/* SVG noise filter applied to a rect across the full viewBox to
              give the parchment paper texture without a raster asset. */}
          <filter id="parchment-noise" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0.45
                      0 0 0 0 0.32
                      0 0 0 0 0.20
                      0 0 0 0.18 0"
            />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
          {/* Drop shadow on nodes — subtle, like a wax seal sitting on
              paper rather than a flat dark border. */}
          <filter id="node-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" />
            <feOffset dx="0" dy="1" />
            <feComponentTransfer><feFuncA type="linear" slope="0.5" /></feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Flux-generated parchment art when available. Slice-fit so the
            image fills the canvas without distortion. Capped at ~55%
            opacity so the parchment underneath bleeds through — flux's
            high-contrast forest patches were drowning the node labels at
            full strength. */}
        {artUrl && (
          <image
            href={artUrl}
            x={0}
            y={0}
            width={width}
            height={height}
            preserveAspectRatio="xMidYMid slice"
            opacity={0.55}
          />
        )}

        {/* Warm cream wash on top of the art to flatten the dynamic range
            into a readable backdrop. Without art this is a no-op (no
            rect). */}
        {artUrl && (
          <rect
            width={width}
            height={height}
            fill="#e8d5a8"
            opacity={0.28}
          />
        )}

        {/* Paper grain texture — covers full canvas. With art behind it the
            noise reads as parchment fiber; without art it carries the look
            on its own. */}
        <rect
          width={width}
          height={height}
          fill="transparent"
          filter="url(#parchment-noise)"
          opacity={artUrl ? 0.35 : 1}
        />

        {/* Edges */}
        {map.edges.map((e, i) => {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          if (!a || !b) return null;
          // Path classification:
          //  - traveled: from-node is start or resolved AND to-node is current
          //    or resolved. Solid ink line.
          //  - available: the player can pick this edge's "to" right now.
          //    Slightly brighter dashed line (the route they're about to take).
          //  - potential: everything else — every speculative future route.
          //    Dim, short dashes. Reads as "you might go here later."
          const isTraveled =
            (e.from === "start" || resolvedNodeIds.has(e.from)) &&
            (e.to !== "boss" && (resolvedNodeIds.has(e.to) || currentNode === e.to));
          const fromIsCurrent = e.from === (currentNode ?? "start");
          const isAvailable = fromIsCurrent && availablePickIds.has(e.to);

          let stroke: string;
          let strokeWidth: number;
          let dasharray: string | undefined;
          let opacity: number;
          if (isTraveled) {
            stroke = "#5b4326";
            strokeWidth = 2.5;
            dasharray = undefined;
            opacity = 0.95;
          } else if (isAvailable) {
            stroke = "#8a5a1e";
            strokeWidth = 2;
            dasharray = "6 4";
            opacity = 0.85;
          } else {
            stroke = "#7a623e";
            strokeWidth = 1.2;
            dasharray = "3 5";
            opacity = 0.42;
          }
          return (
            <line
              key={`e-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={dasharray}
              opacity={opacity}
              strokeLinecap="round"
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
          const fill = isCurrent ? "#fff5e0" : "#f7eed3";
          const stroke = isAvailable
            ? "#8a5a1e"
            : isCurrent
              ? KIND_COLOR[n.kind]
              : resolved
                ? "#a89171"
                : "#8a7350";
          const strokeWidth = isAvailable ? 3 : isCurrent ? 2.5 : 1.5;
          const iconColor = resolved ? "#a89171" : KIND_COLOR[n.kind];
          const cursor = isAvailable ? "pointer" : "default";
          const opacity = resolved ? 0.55 : 1;
          const iconName = KIND_ICON[n.kind];
          return (
            <g
              key={n.id}
              onClick={isAvailable ? () => onPick(n.id) : undefined}
              style={{ cursor }}
            >
              {/* Pulsing glow ring for available picks — draws the eye to
                  what's tappable. */}
              {isAvailable && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={NODE_R + 7}
                  fill="none"
                  stroke="#c89642"
                  strokeOpacity={0.55}
                  strokeWidth={2}
                  strokeDasharray="2 3"
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
                filter="url(#node-shadow)"
              />
              {/* SVG icon via foreignObject so the shared <Icon> component
                  (mask-image based, supports any CSS color) renders inside
                  the SVG without a separate sprite system. */}
              <foreignObject
                x={p.x - ICON_SIZE / 2}
                y={p.y - ICON_SIZE / 2}
                width={ICON_SIZE}
                height={ICON_SIZE}
                style={{ pointerEvents: "none", opacity }}
              >
                <Icon name={iconName} size={ICON_SIZE} color={iconColor} />
              </foreignObject>
              {/* Resolved check tucked in the top-right corner */}
              {resolved && (
                <text
                  x={p.x + NODE_R - 4}
                  y={p.y - NODE_R + 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#5b4326"
                  style={{ userSelect: "none", fontWeight: 700 }}
                >
                  ✓
                </text>
              )}
              {/* Kind label in a serif-ish stroke beneath the node. The
                  paint-order/stroke combo paints a thin cream halo first,
                  then the dark label fill on top — keeps it readable over
                  flux's busy forest patches without darkening the art. */}
              <text
                x={p.x}
                y={p.y + NODE_R + 14}
                textAnchor="middle"
                fontSize={9.5}
                fill={resolved ? "#a89171" : "#5b4326"}
                stroke="#f3e6c3"
                strokeWidth={2.5}
                paintOrder="stroke"
                opacity={0.95}
                style={{
                  userSelect: "none",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  fontFamily: "var(--font-display, serif)",
                  fontWeight: 600,
                }}
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
