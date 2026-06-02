// Canvas-based tactical hex grid for combat.
//
// Renders the hex arena, actor tokens, hover highlights, projectiles, and
// particle bursts. Purely visual — game logic lives in @gantt-quest/core.
// Receives CombatState as props and emits hex-click events to the parent.
//
// Rendering layers (drawn each rAF in order):
//   1. Hex tiles (base + range / reachable / hover overlays)
//   2. Actor tokens (circle + class color + name + HP bar)
//   3. Projectiles (in-flight ranged/magic attacks)
//   4. Particle bursts (impact, heal, shield, crit, etc.)
//
// Hover state drives both the canvas overlay (tinted hex) and a React
// tooltip absolutely positioned above the canvas — keeps text accessible
// and consistently styled with the rest of the UI.

import { useEffect, useMemo, useRef, useState } from "react";
import { charPortraitUrl, classPortraitUrl, monsterPortraitUrl } from "./CombatShared";
import {
  GRID_DEFAULT,
  deriveMoveRange,
  deriveRangeTiles,
  hexDistance,
  hexLos,
  hexDisk,
  hexReachable,
  inBounds,
  isMonsterActor,
  posKey,
  type CombatFighter,
  type CombatMonster,
  type CombatState,
  type HexPos,
  type Obstacle,
  type ObstacleKind,
} from "@gantt-quest/core";

// ── Layout constants ─────────────────────────────────────────────────────────

const DEFAULT_HEX_SIZE = 26;
const CANVAS_PAD = 18;
const PAWN_TWEEN_MS = 280;
// Zoom clamps — 0.5× lets the player pull back for a strategic overview;
// 2.5× zooms in tight enough to read pawn details at small hex sizes.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
// Wheel sensitivity — per pixel of wheel deltaY. Small enough that a single
// notch (typically 100px) feels like a deliberate zoom step.
const WHEEL_ZOOM_RATE = 0.0015;
// Pan clamp slack — extra hexes beyond the grid edge a user can scroll past,
// so they're not jammed against an invisible wall when zoomed in.
const PAN_SLACK_HEXES = 2;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

// Status-effect ambient overlay palette. Each entry is the color used to
// draw an arc segment around the pawn (one segment per active effect) so
// a player can see who's afflicted at a glance without opening callouts.
// Order matters: higher-priority effects (debuffs, hard CC) draw first.
const EFFECT_VISUAL: Record<string, { color: string; weight: number }> = {
  burning:    { color: "#fb923c", weight: 10 }, // urgent — orange flicker
  frozen:     { color: "#7dd3fc", weight:  9 },
  stunned:    { color: "#a3a3a3", weight:  9 },
  shocked:    { color: "#fbbf24", weight:  8 },
  poisoned:   { color: "#84cc16", weight:  7 },
  bleeding:   { color: "#dc2626", weight:  7 },
  hexed:      { color: "#c084fc", weight:  6 },
  entangled:  { color: "#65a30d", weight:  6 },
  empowered:  { color: "#a78bfa", weight:  5 }, // buff
  regen:      { color: "#22c55e", weight:  4 }, // buff
  barkskin:   { color: "#84cc16", weight:  3 },
  animal_form:{ color: "#22c55e", weight:  3 },
};

function hexToPixelAt(pos: HexPos, size: number): { x: number; y: number } {
  const x = size * (Math.sqrt(3) * pos.q + (Math.sqrt(3) / 2) * pos.r) + CANVAS_PAD;
  const y = size * ((3 / 2) * pos.r) + CANVAS_PAD + size;
  return { x, y };
}

function pixelToHexAt(px: number, py: number, size: number): HexPos {
  const x = px - CANVAS_PAD;
  const y = py - CANVAS_PAD - size;
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const qd = Math.abs(rq - q);
  const rd = Math.abs(rr - r);
  const sd = Math.abs(rs - s);
  if (qd > rd && qd > sd) rq = -rr - rs;
  else if (rd > sd) rr = -rq - rs;
  return { q: rq, r: rr };
}

function canvasSizeAt(grid: { cols: number; rows: number }, size: number): { w: number; h: number } {
  // Brick layout: the rightmost visual column lives at offset col cols-1
  // in even rows. Compute its pixel x using the equivalent axial coord
  // (q = cols-1, r = 0). Height comes from the last row's pixel y.
  const rightmost = hexToPixelAt({ q: grid.cols - 1, r: 0 }, size);
  const bottommost = hexToPixelAt({ q: -Math.floor((grid.rows - 1) / 2), r: grid.rows - 1 }, size);
  return {
    w: Math.ceil(rightmost.x + size * Math.sqrt(3) + CANVAS_PAD),
    h: Math.ceil(bottommost.y + size + CANVAS_PAD),
  };
}

// ── Color helpers ────────────────────────────────────────────────────────────

const CLASS_COLORS: Record<string, string> = {
  "DevOps Mage": "#a78bfa",
  "QA Paladin": "#fbbf24",
  "Backend Druid": "#65a30d",
  "Frontend Bard": "#f472b6",
  "Staff Sage": "#60a5fa",
  "Refactor Rogue": "#94a3b8",
  "SRE Warden": "#fb923c",
  "Data Warlock": "#7c3aed",
};

function classColor(className: string): string {
  return CLASS_COLORS[className] ?? "#9ca3af";
}

// ── Particle and projectile types ────────────────────────────────────────────

export type ParticleKind =
  | "physical" | "fire" | "ice" | "lightning"
  | "poison" | "bleed" | "heal" | "shield" | "crit" | "magic";

export interface ParticleEmit {
  id: string;
  kind: ParticleKind;
  /** Hex position where the burst happens. Used as a fallback when no
   *  actor id is supplied. */
  at: HexPos;
  /** Optional actor id. When provided, the burst fires at the actor's
   *  currently-animated pawn position instead of the destination hex —
   *  important so particles stay glued to the pawn during move tweens
   *  (the pawn is mid-flight during multi-event monster turns like
   *  monster_moved → monster_attack). */
  actorId?: string;
}

export type ProjectileKind = "arrow" | "fire" | "ice" | "lightning" | "poison" | "magic";

export interface ProjectileEmit {
  id: string;
  kind: ProjectileKind;
  from: HexPos;
  to: HexPos;
  /** Optional actor ids — when provided, the projectile's endpoints use the
   *  currently-animated pawn positions so they stay glued to pawns mid-tween. */
  fromActorId?: string;
  toActorId?: string;
}

interface Particle {
  x: number; y: number;        // current position (px)
  vx: number; vy: number;      // velocity (px/ms)
  ax: number; ay: number;      // acceleration (gravity)
  size: number;                // radius (px)
  color: string;
  born: number;                // ms timestamp
  life: number;                // total lifetime (ms)
}

interface ActiveProjectile {
  kind: ProjectileKind;
  fromX: number; fromY: number;
  toX: number; toY: number;
  born: number;
  duration: number;
  onArrive: () => void;
}

// Melee swing — drawn as a rotating arc anchored at the attacker that sweeps
// in a ~140° wedge toward the target. The peak (when the arc faces the
// target most directly) triggers onArrive so impact particles land then,
// not at the start.
interface ActiveSwing {
  fromActorId: string;
  toActorId: string;
  born: number;
  duration: number;
  /** Center angle (radians) of the swing. Points from attacker → target. */
  centerAngle: number;
  /** Element color tint. */
  color: string;
  onArrive: () => void;
  arrived: boolean;
}

const SWING_DURATION_MS = 260;
const SWING_ARC_RADIANS = (140 * Math.PI) / 180;

const SWING_COLOR_BY_ELEMENT: Record<string, string> = {
  fire: "#fb923c",
  ice: "#7dd3fc",
  lightning: "#fde047",
  poison: "#a3e635",
  default: "#fef3c7",
};

const PARTICLE_CONFIG: Record<ParticleKind, { count: number; speed: number; size: number; life: number; colors: string[]; gravity: number; }> = {
  physical: { count: 14, speed: 0.18, size: 3, life: 450, colors: ["#fde68a", "#facc15", "#ffffff"], gravity: 0.0004 },
  fire:     { count: 22, speed: 0.20, size: 4, life: 700, colors: ["#ff4500", "#ff8c00", "#fbbf24"], gravity: -0.0006 },
  ice:      { count: 18, speed: 0.15, size: 3, life: 850, colors: ["#bfdbfe", "#dbeafe", "#93c5fd"], gravity: 0.0008 },
  lightning:{ count: 24, speed: 0.35, size: 2, life: 320, colors: ["#fbbf24", "#fef08a", "#ffffff"], gravity: 0 },
  poison:   { count: 14, speed: 0.12, size: 4, life: 1000, colors: ["#84cc16", "#a3e635", "#65a30d"], gravity: 0.001 },
  bleed:    { count: 12, speed: 0.14, size: 3, life: 800, colors: ["#dc2626", "#ef4444", "#7f1d1d"], gravity: 0.0012 },
  heal:     { count: 16, speed: 0.14, size: 3, life: 900, colors: ["#86efac", "#bbf7d0", "#ffffff"], gravity: -0.0008 },
  shield:   { count: 12, speed: 0.16, size: 3, life: 550, colors: ["#7dd3fc", "#bae6fd", "#ffffff"], gravity: 0 },
  crit:     { count: 32, speed: 0.28, size: 4, life: 600, colors: ["#fde047", "#facc15", "#fb923c", "#ffffff"], gravity: 0 },
  magic:    { count: 20, speed: 0.18, size: 3, life: 700, colors: ["#c4b5fd", "#a78bfa", "#ffffff"], gravity: 0 },
};

const PROJECTILE_DURATION: Record<ProjectileKind, number> = {
  arrow: 350, fire: 300, ice: 320, lightning: 80, poison: 400, magic: 300,
};

const PROJECTILE_COLOR: Record<ProjectileKind, string> = {
  arrow: "#fde68a", fire: "#ff8c00", ice: "#bfdbfe", lightning: "#fef08a", poison: "#a3e635", magic: "#c4b5fd",
};

// ── Helpers to map combat events → particles/projectiles ─────────────────────

// Maps a CombatEvent to a particle kind. Returns null if no particle should
// fire (e.g., turn_start, roll). Used by the parent CombatPage to emit
// particles when events arrive from the WS stream.
export function particleKindForEvent(damage_type?: string, isHeal?: boolean, isShield?: boolean, isCrit?: boolean): ParticleKind {
  if (isCrit) return "crit";
  if (isHeal) return "heal";
  if (isShield) return "shield";
  switch (damage_type) {
    case "fire": return "fire";
    case "ice": return "ice";
    case "lightning": return "lightning";
    case "poison": return "poison";
    case "magic": return "magic";
    default: return "physical";
  }
}

export function projectileKindForAttack(weaponRange: string, element?: string): ProjectileKind | null {
  // Melee attacks don't fire projectiles — the lunge animation handles them.
  if (weaponRange === "melee") return null;
  if (element === "fire") return "fire";
  if (element === "ice") return "ice";
  if (element === "lightning") return "lightning";
  if (weaponRange === "ranged") return "arrow";
  if (weaponRange === "focus") return "magic";
  return null;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function drawHex(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, fill: string, stroke: string, lineWidth = 1) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (lineWidth > 0) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function drawHpBar(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, hp: number, maxHp: number) {
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(cx - w / 2, cy, w, h);
  ctx.fillStyle = pct > 0.5 ? "#22c55e" : pct > 0.25 ? "#facc15" : "#ef4444";
  ctx.fillRect(cx - w / 2, cy, w * pct, h);
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CombatHexGridHandle {
  emitParticle: (p: ParticleEmit) => void;
  emitProjectile: (p: ProjectileEmit, onArrive: () => void) => void;
  /** Fire a melee swing arc that originates at the attacker, sweeps in the
   *  direction of the target, and invokes onArrive when the swing reaches
   *  peak (so impact particles fire on contact, not at the start). */
  emitSwing: (p: SwingEmit, onArrive: () => void) => void;
  shake: () => void;
}

export interface SwingEmit {
  id: string;
  fromActorId: string;
  toActorId: string;
  /** Optional element color tint. Defaults to a steel-white slash. */
  element?: "fire" | "ice" | "lightning" | "poison" | null;
}

export interface CombatHexGridProps {
  state: CombatState;
  myActorId: string | null;
  // Current actor's turn. The grid renders move/attack overlays only when
  // this matches myActorId.
  currentActorId: string | null;
  // Whether the local user controls the current actor.
  isMyTurn: boolean;
  // "move" or "attack" — drives hover semantics and overlay colors.
  turnPhase: "move" | "attack";
  // Called when the user clicks a hex. Caller resolves to a TurnAction.
  onHexClick: (pos: HexPos) => void;
  // Called whenever the hovered pawn changes (or null on mouse leave). The
  // battlefield-first layout uses this to expand the corresponding callout.
  onPawnHoverChange?: (actorId: string | null) => void;
  // Pawn screen positions for the battlefield-first layout. The hex grid
  // computes these from `hexToPixel(actor.pos)` and reports them via this
  // callback whenever the state changes so the parent can position callouts.
  onPawnPositionsChange?: (positions: Record<string, { x: number; y: number; radius: number }>) => void;
  // Size of the visible canvas area (display px, not intrinsic). Used by
  // the parent to clamp callouts inside the container.
  onCanvasResize?: (size: { w: number; h: number }) => void;
  // Expose imperative API so the parent can fire particles/projectiles
  // from the WebSocket event handler.
  apiRef?: React.MutableRefObject<CombatHexGridHandle | null>;
  // Hex radius in px. Defaults to 26.
  hexSize?: number;
  // Optional AI-generated battlefield ground texture. Drawn as Layer 0 at
  // ~30% alpha so the hex grid stays readable on top. Null/undefined falls
  // back to the flat tinted canvas background.
  backgroundUrl?: string | null;
  // Currently selected target monster id (for attack-phase aiming). Drawn
  // with an orange ring so the player knows what their next Attack/ability
  // will hit.
  targetMonsterId?: string | null;
  // Pawns that the currently-hovered ability button would affect. Painted
  // with a soft glow ring (red for enemies, green for allies) so the player
  // sees AoE scope before committing.
  previewedTargetIds?: string[];
  previewedTargetKind?: "enemy" | "ally";
  // When true, the player is in "aim mode" and the canvas should only paint
  // strong target glows on pawns that are actually reachable by the current
  // actor (in range + LOS). Unreachable previewed targets get a dim/gray
  // glow and a "not-allowed" hover cursor.
  aimActive?: boolean;
  // Optional range override for aim mode. When set, overrides the default
  // weapon-range computation so the canvas highlights a different reach
  // ring around the current actor (e.g. a long-reach ability on a melee
  // fighter). When unset, the actor's weapon range is used.
  aimRangeTiles?: number;
  // Optional blast radius for AoE abilities. When set, the canvas paints
  // a radius preview around the hovered target hex so the player sees
  // who'll be hit by the splash. The primary target is always included.
  aimAoeRadiusTiles?: number;
  // Viewport dimensions to fill. When provided, the canvas grows to this
  // size and the hex grid is centered + scaled to fit, with user zoom/pan
  // applied on top. When omitted, falls back to legacy intrinsic sizing
  // (canvas matches the natural grid bounding box).
  viewportWidth?: number;
  viewportHeight?: number;
}

interface HoverInfo {
  pos: HexPos;
  reason: "reachable" | "blocked" | "in_range" | "out_of_range" | "no_los" | "self" | "ally" | "obstacle";
  label: string;
  cursor: string;
}

const OBSTACLE_LABEL: Record<ObstacleKind, string> = {
  boulder: "Boulder",
  pillar: "Pillar",
  crate: "Crate",
  tree: "Tree",
  rubble: "Rubble",
};

export function CombatHexGrid({
  state, myActorId, currentActorId, isMyTurn, turnPhase, onHexClick, apiRef,
  onPawnHoverChange, onPawnPositionsChange, onCanvasResize,
  hexSize = DEFAULT_HEX_SIZE,
  backgroundUrl,
  targetMonsterId,
  previewedTargetIds,
  previewedTargetKind = "enemy",
  aimActive = false,
  aimRangeTiles,
  aimAoeRadiusTiles,
  viewportWidth,
  viewportHeight,
}: CombatHexGridProps) {
  void myActorId;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const grid = state.grid ?? GRID_DEFAULT;
  // Natural (unscaled) grid bounding box — used both for legacy intrinsic
  // sizing and as the world-space the new viewport transform fits into.
  const natural = useMemo(() => canvasSizeAt(grid, hexSize), [grid.cols, grid.rows, hexSize]);
  const fillViewport = typeof viewportWidth === "number" && typeof viewportHeight === "number"
    && viewportWidth > 0 && viewportHeight > 0;
  // Canvas pixel size — viewport dims when filling, natural bounding box otherwise.
  const w = fillViewport ? viewportWidth! : natural.w;
  const h = fillViewport ? viewportHeight! : natural.h;
  // Auto-fit scale: how much to shrink the natural grid to fit the viewport
  // with a small breathing margin. = 1 when not filling viewport (legacy).
  const baseScale = useMemo(() => {
    if (!fillViewport) return 1;
    const sx = (w - CANVAS_PAD * 2) / natural.w;
    const sy = (h - CANVAS_PAD * 2) / natural.h;
    return Math.max(0.1, Math.min(sx, sy));
  }, [fillViewport, w, h, natural.w, natural.h]);
  // User-controlled zoom on top of baseScale. Wheel adjusts.
  const [zoom, setZoom] = useState(1);
  // User-controlled pan offset (in screen pixels). Dragging adjusts.
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const effectiveScale = baseScale * zoom;
  // Top-left of the scaled grid inside the viewport (auto-centered + pan).
  const offsetX = (w - natural.w * effectiveScale) / 2 + pan.x;
  const offsetY = (h - natural.h * effectiveScale) / 2 + pan.y;
  const hexToPixel = useMemo(() => (pos: HexPos) => hexToPixelAt(pos, hexSize), [hexSize]);
  const pixelToHex = useMemo(() => (px: number, py: number) => pixelToHexAt(px, py, hexSize), [hexSize]);
  // World-space (hexToPixel output) → screen pixel within the canvas.
  // Used by mouse handlers and the parent-facing pawn-position callback so
  // tooltips/callouts line up with the visually-scaled grid.
  const worldToScreen = (wx: number, wy: number) => ({
    x: wx * effectiveScale + offsetX,
    y: wy * effectiveScale + offsetY,
  });
  const screenToWorld = (sx: number, sy: number) => ({
    x: (sx - offsetX) / effectiveScale,
    y: (sy - offsetY) / effectiveScale,
  });

  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [tooltipPx, setTooltipPx] = useState<{ x: number; y: number } | null>(null);

  // Sync tween state with the latest actor positions. When a pawn's target
  // pixel changes, start a new tween from the current animated position so
  // moves slide rather than snap. Newly-spawned actors land instantly.
  // Also emits final target positions to the parent so callouts know where
  // to anchor — their own CSS `transition: top/left` handles smoothing.
  useEffect(() => {
    // World-space (hexToPixel) targets — drive the internal pawn tween +
    // canvas draw which runs UNDER the world→screen transform. Particles
    // and projectiles glue to these too via animatedPosRef.
    const targets: Record<string, { x: number; y: number; radius: number }> = {};
    // Screen-space report — for the parent's DockedPawnCard, status arcs
    // overlay, hover-pin chip, etc. These need to map to actual canvas
    // pixels visible on screen.
    const screenReport: Record<string, { x: number; y: number; radius: number }> = {};
    for (const f of state.fighters) {
      if (f.pos && f.hp > 0) {
        const w0 = hexToPixel(f.pos);
        targets[f.id] = { x: w0.x, y: w0.y, radius: hexSize * 0.55 };
        const s = worldToScreen(w0.x, w0.y);
        screenReport[f.id] = { x: s.x, y: s.y, radius: hexSize * 0.55 * effectiveScale };
      }
    }
    for (const m of state.monsters) {
      if (m.id && m.pos && m.hp > 0) {
        const w0 = hexToPixel(m.pos);
        targets[m.id] = { x: w0.x, y: w0.y, radius: hexSize * 0.6 };
        const s = worldToScreen(w0.x, w0.y);
        screenReport[m.id] = { x: s.x, y: s.y, radius: hexSize * 0.6 * effectiveScale };
      }
    }

    const next = animatedPosRef.current;
    const nowMs = performance.now();
    for (const id of Object.keys(targets)) {
      const t = targets[id];
      const cur = next[id];
      if (!cur) {
        // Spawn — instant placement, no tween.
        next[id] = { x: t.x, y: t.y, fromX: t.x, fromY: t.y, toX: t.x, toY: t.y, startMs: 0 };
      } else if (Math.abs(cur.toX - t.x) > 0.5 || Math.abs(cur.toY - t.y) > 0.5) {
        // Target changed — start a new tween from the current animated point.
        next[id] = {
          x: cur.x, y: cur.y,
          fromX: cur.x, fromY: cur.y,
          toX: t.x, toY: t.y,
          startMs: nowMs,
        };
      }
    }
    // Drop dead / removed actors so leftover entries don't haunt the canvas.
    for (const id of Object.keys(next)) {
      if (!(id in targets)) delete next[id];
    }

    onPawnPositionsChange?.(screenReport);
  }, [state.fighters, state.monsters, hexToPixel, hexSize, effectiveScale, offsetX, offsetY, onPawnPositionsChange]);

  // Report canvas display size so the parent's callout container can clamp.
  useEffect(() => {
    if (!onCanvasResize) return;
    onCanvasResize({ w, h });
  }, [w, h, onCanvasResize]);

  // Notify the parent when the hovered pawn changes (driven by the canvas
  // hover handler below).
  const hoveredPawnIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onPawnHoverChange) return;
    let id: string | null = null;
    if (hover) {
      const occupant =
        state.fighters.find((f) => f.hp > 0 && f.pos && posKey(f.pos) === posKey(hover.pos)) ??
        state.monsters.find((m) => m.hp > 0 && m.pos && posKey(m.pos) === posKey(hover.pos));
      if (occupant) id = occupant.id;
    }
    if (id !== hoveredPawnIdRef.current) {
      hoveredPawnIdRef.current = id;
      onPawnHoverChange(id);
    }
  }, [hover, state.fighters, state.monsters, onPawnHoverChange]);

  // Mutable refs for in-flight particles, projectiles, and shake offset.
  const particlesRef = useRef<Particle[]>([]);
  const projectilesRef = useRef<ActiveProjectile[]>([]);
  const swingsRef = useRef<ActiveSwing[]>([]);
  const shakeRef = useRef<{ start: number; duration: number } | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Per-actor animated pixel positions for smooth move tweens. When state
  // updates a pawn's pos, we capture the old animated position as `from`,
  // set the new pixel as `to`, and the rAF loop interpolates from→to over
  // TWEEN_MS using cubic ease-out. `drawActors` reads from this ref so the
  // pawn slides along its move path instead of snapping.
  const animatedPosRef = useRef<Record<string, {
    x: number; y: number;
    fromX: number; fromY: number;
    toX: number; toY: number;
    startMs: number; // 0 = no active tween
  }>>({});
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  const backgroundReadyRef = useRef<boolean>(false);

  // Preload the AI-generated battlefield art whenever the URL changes.
  // Image is drawn as Layer 0 in the rAF loop once loaded.
  useEffect(() => {
    backgroundReadyRef.current = false;
    if (!backgroundUrl) {
      backgroundImageRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { backgroundReadyRef.current = true; };
    img.onerror = () => { backgroundReadyRef.current = false; };
    img.src = backgroundUrl;
    backgroundImageRef.current = img;
  }, [backgroundUrl]);

  // Portrait cache keyed by URL. Fighters use char art (with class art as
  // fallback); monsters use whatever art_url the server provides. The cache
  // outlives any single rAF frame so loaded images survive React re-renders.
  // Each entry stores the image + a "ready" flag — drawing checks ready
  // before invoking drawImage so failures (404, CORS) fall back to the
  // initial-letter token without crashing the frame.
  type PortraitCacheEntry = { img: HTMLImageElement; ready: boolean };
  const portraitCacheRef = useRef<Map<string, PortraitCacheEntry>>(new Map());
  function loadPortrait(url: string): PortraitCacheEntry | null {
    if (!url) return null;
    const cache = portraitCacheRef.current;
    const existing = cache.get(url);
    if (existing) return existing;
    const img = new Image();
    // No crossOrigin: portraits are same-origin (served by the worker at
    // /img/...) and drawImage doesn't need CORS for tainted canvases when
    // we're not reading pixels back out. Setting crossOrigin="anonymous"
    // here would FAIL the load whenever the response omitted CORS headers,
    // silently dropping us to the initial-letter fallback.
    const entry: PortraitCacheEntry = { img, ready: false };
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { entry.ready = false; };
    img.src = url;
    cache.set(url, entry);
    return entry;
  }
  // Eagerly preload all current actors' portraits whenever the roster
  // changes so the first frame after a state update has them ready.
  useEffect(() => {
    for (const f of state.fighters) {
      loadPortrait(charPortraitUrl(f.name));
      const fallback = classPortraitUrl(f.class);
      if (fallback) loadPortrait(fallback);
    }
    for (const m of state.monsters) {
      if (m.art_url) loadPortrait(m.art_url);
      // Fallback to the deterministic R2 URL by monster name — covers the
      // case where art was generated AFTER scene creation (resumed quest)
      // and never made it onto the live state's art_url field.
      if (m.name) loadPortrait(monsterPortraitUrl(m.name));
    }
  }, [state.fighters, state.monsters]);

  // Current actor (for move/attack overlay computation).
  const currentActor = useMemo(() => {
    if (!currentActorId) return null;
    return state.fighters.find((f) => f.id === currentActorId)
        ?? state.monsters.find((m) => m.id === currentActorId)
        ?? null;
  }, [currentActorId, state.fighters, state.monsters]);

  // Compute reachable / attackable hexes for the current actor.
  const overlay = useMemo(() => {
    if (!currentActor || !currentActor.pos || !isMyTurn) {
      return { reachable: new Set<string>(), inRange: new Set<string>(), losBlocked: new Set<string>() };
    }
    const actorPos = currentActor.pos;
    const isFighter = "class" in currentActor;
    const occupied: HexPos[] = [];
    for (const f of state.fighters) if (f.hp > 0 && f.pos && f.id !== currentActor.id) occupied.push(f.pos);
    for (const m of state.monsters) if (m.hp > 0 && m.pos && m.id !== currentActor.id) occupied.push(m.pos);
    for (const o of state.obstacles ?? []) occupied.push(o.pos);

    if (turnPhase === "move" && isFighter) {
      const moveRange = deriveMoveRange((currentActor as CombatFighter).stats?.agi ?? 5);
      const reachable = hexReachable(actorPos, moveRange, occupied, grid);
      return {
        reachable: new Set(reachable.map(posKey)),
        inRange: new Set<string>(),
        losBlocked: new Set<string>(),
      };
    }

    // In-range / LOS-blocked sets are useful during ATTACK phase AND aim
    // mode (which can fire during MOVE phase too — the engine auto-skips
    // move). Compute once and reuse for highlights + click validation.
    if ((turnPhase === "attack" || aimActive) && isFighter) {
      const fighter = currentActor as CombatFighter;
      // aimRangeTiles wins when in aim mode (e.g. an ability with custom
      // range). Otherwise fall back to the actor's weapon range.
      const rangeTiles = aimRangeTiles ?? deriveRangeTiles(
        fighter.weapon_range,
        fighter.stats?.int_stat,
        fighter.stats?.dex,
      );
      const inRange = new Set<string>();
      const losBlocked = new Set<string>();
      const obstacles = state.obstacles ?? [];
      for (const m of state.monsters) {
        if (m.hp <= 0 || !m.pos) continue;
        const dist = hexDistance(actorPos, m.pos);
        if (dist > rangeTiles) continue;
        if (fighter.weapon_range !== "melee" && !hexLos(actorPos, m.pos, obstacles)) {
          losBlocked.add(posKey(m.pos));
          continue;
        }
        inRange.add(posKey(m.pos));
      }
      return { reachable: new Set<string>(), inRange, losBlocked };
    }

    return { reachable: new Set<string>(), inRange: new Set<string>(), losBlocked: new Set<string>() };
  }, [currentActor, isMyTurn, turnPhase, aimActive, aimRangeTiles, state.fighters, state.monsters, state.obstacles, grid]);

  // Pointer move during an active pan drag. Uses pointer events because
  // setPointerCapture redirects pointer (not mouse) events to the captured
  // element — onMouseMove fires inconsistently mid-drag, and right-button
  // drags in particular get eaten by the browser's context-menu handling
  // so onMouseMove never fires at all between pointerdown and pointerup.
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!panDragRef.current) return;
    const dx = e.clientX - panDragRef.current.lastX;
    const dy = e.clientY - panDragRef.current.lastY;
    panDragRef.current.lastX = e.clientX;
    panDragRef.current.lastY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      panDragRef.current.moved = true;
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }));
    }
  }

  // Mouse hover handler — converts screen → hex, computes overlay state.
  // Skips during active pan so the cursor stays "grabbing" and the hover
  // overlay doesn't flicker.
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (panDragRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // Canvas-pixel position relative to the canvas top-left, then unwound
    // through the same offset/scale transform we apply when drawing so the
    // mouse maps back to world-space (hexToPixel coords) and on to a hex.
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    const world = screenToWorld(cx, cy);
    const hex = pixelToHex(world.x, world.y);
    if (!inBounds(hex, grid)) {
      setHover(null);
      setTooltipPx(null);
      return;
    }

    let info: HoverInfo | null = null;
    const occupant =
      state.fighters.find((f) => f.hp > 0 && f.pos && posKey(f.pos) === posKey(hex)) ??
      state.monsters.find((m) => m.hp > 0 && m.pos && posKey(m.pos) === posKey(hex));
    const obstacle = (state.obstacles ?? []).find((o) => posKey(o.pos) === posKey(hex));

    // Obstacles take priority — they can't be moved into or attacked through.
    if (obstacle) {
      info = {
        pos: hex,
        reason: "obstacle",
        label: `Blocked · ${OBSTACLE_LABEL[obstacle.kind as ObstacleKind] ?? obstacle.kind}`,
        cursor: "not-allowed",
      };
    } else if (previewedTargetIds && previewedTargetIds.length > 0 && occupant && previewedTargetIds.includes(occupant.id)) {
      // Aim-mode (or hovered ability) target. Differentiate reachable from
      // unreachable pawns: only an in-range, LOS-clear pawn is clickable;
      // out-of-range gets "not allowed" + a clear reason.
      const occupantKey = occupant.pos ? posKey(occupant.pos) : "";
      const reachable = overlay.inRange.has(occupantKey);
      const losOut = overlay.losBlocked.has(occupantKey);
      if (reachable) {
        info = { pos: hex, reason: "in_range", label: `Target ${occupant.name}`, cursor: "crosshair" };
      } else if (losOut) {
        info = { pos: hex, reason: "no_los", label: `${occupant.name} · no line of sight`, cursor: "not-allowed" };
      } else {
        info = { pos: hex, reason: "out_of_range", label: `${occupant.name} · out of range`, cursor: "not-allowed" };
      }
    } else if (!isMyTurn || !currentActor) {
      if (occupant) {
        info = { pos: hex, reason: "self", label: occupant.name, cursor: "default" };
      }
    } else if (turnPhase === "move") {
      if (currentActor.pos && posKey(currentActor.pos) === posKey(hex)) {
        info = { pos: hex, reason: "self", label: "You are here", cursor: "default" };
      } else if (overlay.reachable.has(posKey(hex))) {
        info = { pos: hex, reason: "reachable", label: "Move here", cursor: "pointer" };
      } else {
        info = { pos: hex, reason: "blocked", label: "Can't move here", cursor: "not-allowed" };
      }
    } else if (turnPhase === "attack") {
      if (overlay.inRange.has(posKey(hex))) {
        info = { pos: hex, reason: "in_range", label: `Attack ${occupant?.name ?? "target"}`, cursor: "crosshair" };
      } else if (overlay.losBlocked.has(posKey(hex))) {
        info = { pos: hex, reason: "no_los", label: "No line of sight", cursor: "not-allowed" };
      } else if (occupant && state.fighters.some((f) => f.id === occupant.id)) {
        info = { pos: hex, reason: "ally", label: occupant.name, cursor: "default" };
      } else if (occupant) {
        info = { pos: hex, reason: "out_of_range", label: "Out of range", cursor: "not-allowed" };
      } else {
        info = { pos: hex, reason: "blocked", label: "", cursor: "default" };
      }
    }

    setHover(info);
    canvas.style.cursor = info?.cursor ?? "default";
    if (info?.label) {
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (containerRect) {
        setTooltipPx({
          x: e.clientX - containerRect.left + 14,
          y: e.clientY - containerRect.top + 14,
        });
      }
    } else {
      setTooltipPx(null);
    }
  }

  function handleMouseLeave() {
    setHover(null);
    setTooltipPx(null);
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A shift+drag pan that ended on this canvas suppresses the click that
    // the browser fires on release — otherwise releasing a pan would
    // trigger a hex-move action on the destination.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    const world = screenToWorld(cx, cy);
    const hex = pixelToHex(world.x, world.y);
    if (!inBounds(hex, grid)) return;
    onHexClick(hex);
  }

  // ── Zoom + pan plumbing ────────────────────────────────────────────────────
  // Pan drag (middle button OR right button OR shift+left). Tracked in a ref
  // so mid-drag re-renders don't lose accumulated state.
  const panDragRef = useRef<{ lastX: number; lastY: number; moved: boolean } | null>(null);
  // Clamp a candidate pan so the grid can't be dragged completely off-screen.
  // Allow PAN_SLACK_HEXES worth of overscroll past the edges so the player
  // can compose shots near corners without fighting an invisible wall.
  function clampPan(p: { x: number; y: number }): { x: number; y: number } {
    if (!fillViewport) return p;
    const slack = hexSize * Math.sqrt(3) * PAN_SLACK_HEXES * effectiveScale;
    const scaledW = natural.w * effectiveScale;
    const scaledH = natural.h * effectiveScale;
    // When the scaled grid is smaller than the viewport, allow pan equal to
    // half the leftover space; when larger, allow pan up to the overflow.
    const maxX = Math.max((scaledW - w) / 2 + slack, slack);
    const maxY = Math.max((scaledH - h) / 2 + slack, slack);
    return {
      x: Math.max(-maxX, Math.min(maxX, p.x)),
      y: Math.max(-maxY, Math.min(maxY, p.y)),
    };
  }
  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!fillViewport) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    // Trackpad pinch on macOS arrives as wheel + ctrlKey with a different
    // sensitivity; the deltaY ratio still maps cleanly through the same
    // multiplier.
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
    setZoom((z) => {
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor));
      const realFactor = newZoom / z;
      if (realFactor === 1) return z;
      // Anchor zoom at the cursor: shift pan so the world point under the
      // mouse stays under the mouse after the scale changes.
      setPan((p) => {
        const newOffX = (w - natural.w * baseScale * newZoom) / 2 + p.x;
        const newOffY = (h - natural.h * baseScale * newZoom) / 2 + p.y;
        // Solve for pan that keeps (cx, cy) → same world point:
        //   worldX = (cx - oldOffX) / (baseScale * z)
        //         = (cx - newOffX') / (baseScale * newZoom)
        const worldX = (cx - offsetX) / effectiveScale;
        const worldY = (cy - offsetY) / effectiveScale;
        const wantNewOffX = cx - worldX * baseScale * newZoom;
        const wantNewOffY = cy - worldY * baseScale * newZoom;
        // newPanX such that newOffX (with newPanX) equals wantNewOffX:
        const newPanX = wantNewOffX - (w - natural.w * baseScale * newZoom) / 2;
        const newPanY = wantNewOffY - (h - natural.h * baseScale * newZoom) / 2;
        void newOffX; void newOffY;
        return clampPan({ x: newPanX, y: newPanY });
      });
      return newZoom;
    });
  }
  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Middle button, right button, or shift+left starts panning.
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      panDragRef.current = { lastX: e.clientX, lastY: e.clientY, moved: false };
      const canvas = canvasRef.current;
      if (canvas) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        canvas.style.cursor = "grabbing";
      }
    }
  }
  // Brief click-suppression after a LEFT-button pan ends. Right/middle drags
  // don't need this — they don't fire onClick anyway. Without the gate, a
  // shift+drag pan would release into a hex-move click on the destination.
  const suppressNextClickRef = useRef(false);
  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!panDragRef.current) return;
    const wasLeft = e.button === 0;
    const moved = panDragRef.current.moved;
    const canvas = canvasRef.current;
    if (canvas) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      canvas.style.cursor = "default";
    }
    panDragRef.current = null;
    if (wasLeft && moved) suppressNextClickRef.current = true;
  }
  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  function bumpZoom(delta: number) {
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + delta)));
  }

  // Expose imperative API via ref.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      emitParticle(p) {
        // Prefer the animated pawn position when an actor id is given —
        // ensures bursts glue to the pawn even when it's mid-tween from a
        // recent move. Falls back to the static hex pixel otherwise.
        const live = p.actorId ? animatedPosRef.current[p.actorId] : null;
        const center = live ? { x: live.x, y: live.y } : hexToPixel(p.at);
        const cfg = PARTICLE_CONFIG[p.kind];
        const now = performance.now();
        for (let i = 0; i < cfg.count; i++) {
          const angle = (Math.PI * 2 * i) / cfg.count + (Math.random() - 0.5) * 0.3;
          const speed = cfg.speed * (0.7 + Math.random() * 0.6);
          particlesRef.current.push({
            x: center.x,
            y: center.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            ax: 0,
            ay: cfg.gravity,
            size: cfg.size * (0.6 + Math.random() * 0.8),
            color: cfg.colors[i % cfg.colors.length],
            born: now,
            life: cfg.life,
          });
        }
      },
      emitProjectile(p, onArrive) {
        // Same actor-glue treatment as particles: when actor ids are passed,
        // use their live animated pawn positions so the trail starts/ends
        // right at the pawn even during a move tween.
        const liveFrom = p.fromActorId ? animatedPosRef.current[p.fromActorId] : null;
        const liveTo = p.toActorId ? animatedPosRef.current[p.toActorId] : null;
        const from = liveFrom ? { x: liveFrom.x, y: liveFrom.y } : hexToPixel(p.from);
        const to = liveTo ? { x: liveTo.x, y: liveTo.y } : hexToPixel(p.to);
        projectilesRef.current.push({
          kind: p.kind,
          fromX: from.x, fromY: from.y,
          toX: to.x, toY: to.y,
          born: performance.now(),
          duration: PROJECTILE_DURATION[p.kind],
          onArrive,
        });
      },
      emitSwing(p, onArrive) {
        // Anchor at the attacker's live position; aim arc center at the
        // target's live position. Both come from the animated-position
        // ref so the arc stays glued to the pawn even mid-tween.
        const from = animatedPosRef.current[p.fromActorId];
        const to = animatedPosRef.current[p.toActorId];
        if (!from || !to) { onArrive(); return; }
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const centerAngle = Math.atan2(dy, dx);
        const color = p.element ? SWING_COLOR_BY_ELEMENT[p.element] : SWING_COLOR_BY_ELEMENT.default;
        swingsRef.current.push({
          fromActorId: p.fromActorId,
          toActorId: p.toActorId,
          born: performance.now(),
          duration: SWING_DURATION_MS,
          centerAngle,
          color,
          onArrive,
          arrived: false,
        });
      },
      shake() {
        shakeRef.current = { start: performance.now(), duration: 240 };
      },
    };
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef]);

  // Render loop (requestAnimationFrame).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    function frame(now: number) {
      const dt = lastTimeRef.current === 0 ? 16 : Math.min(48, now - lastTimeRef.current);
      lastTimeRef.current = now;

      // Shake offset
      let shakeX = 0;
      let shakeY = 0;
      if (shakeRef.current) {
        const elapsed = now - shakeRef.current.start;
        if (elapsed >= shakeRef.current.duration) {
          shakeRef.current = null;
        } else {
          const t = 1 - elapsed / shakeRef.current.duration;
          shakeX = (Math.random() - 0.5) * 6 * t;
          shakeY = (Math.random() - 0.5) * 6 * t;
        }
      }

      ctx!.save();
      ctx!.clearRect(0, 0, w, h);
      ctx!.translate(shakeX, shakeY);

      // 0. Battlefield art (AI-generated ground texture, ~30% alpha so the
      //    hex grid stays readable on top). Drawn in SCREEN space (no
      //    transform) so the terrain fills the canvas regardless of where
      //    the player has panned/zoomed — the ground feels stable while the
      //    grid moves over it.
      if (backgroundReadyRef.current && backgroundImageRef.current) {
        const img = backgroundImageRef.current;
        ctx!.globalAlpha = 0.40;
        ctx!.drawImage(img, 0, 0, w, h);
        ctx!.globalAlpha = 1;
      }

      // Apply the world→screen transform so every subsequent drawing call
      // (tiles, obstacles, pawns, particles, projectiles) can stay in world
      // space — hexToPixel coords flow straight to the canvas without
      // per-call scaling. Composes with shake by translating first.
      ctx!.translate(offsetX, offsetY);
      ctx!.scale(effectiveScale, effectiveScale);

      // 1. Hex tiles
      drawTiles(ctx!, state, grid, overlay, hover, currentActor, hexToPixel, hexSize, targetMonsterId ?? null, now);

      // 1.5 AoE blast radius preview — paints a translucent red overlay on
      // every hex within `aimAoeRadiusTiles` of the currently-hovered enemy
      // during aim mode, so the player sees the splash before clicking.
      if (aimActive && aimAoeRadiusTiles && aimAoeRadiusTiles > 0 && hover?.reason === "in_range") {
        const blastHexes = hexDisk(hover.pos, aimAoeRadiusTiles, grid);
        ctx!.save();
        ctx!.globalAlpha = 0.30;
        ctx!.fillStyle = "#f87171";
        for (const h of blastHexes) {
          const { x, y } = hexToPixel(h);
          drawHex(ctx!, x, y, hexSize * 0.92, "#f87171", "rgba(0,0,0,0)", 0);
        }
        ctx!.globalAlpha = 0.85;
        ctx!.strokeStyle = "#fb923c";
        ctx!.lineWidth = 2;
        ctx!.setLineDash([5, 4]);
        ctx!.lineDashOffset = -now / 50;
        for (const h of blastHexes) {
          const { x, y } = hexToPixel(h);
          drawHex(ctx!, x, y, hexSize * 0.92, "rgba(0,0,0,0)", "#fb923c", 2);
        }
        ctx!.setLineDash([]);
        ctx!.restore();
      }

      // 2. Obstacles (between tiles and pawns so pawns can stand "near" them)
      drawObstacles(ctx!, state, hexToPixel, hexSize);

      // Advance any in-flight pawn-move tweens.
      const anim = animatedPosRef.current;
      for (const id of Object.keys(anim)) {
        const a = anim[id];
        if (a.startMs === 0) continue;
        const tt = Math.min(1, (now - a.startMs) / PAWN_TWEEN_MS);
        const k = easeOutCubic(tt);
        a.x = a.fromX + (a.toX - a.fromX) * k;
        a.y = a.fromY + (a.toY - a.fromY) * k;
        if (tt >= 1) {
          a.startMs = 0;
          a.x = a.toX; a.y = a.toY;
        }
      }

      // 3. Actor tokens — use animated positions so moves slide smoothly.
      drawActors(
        ctx!, state, animatedPosRef.current, hexSize,
        targetMonsterId ?? null, currentActorId, turnPhase,
        previewedTargetIds ?? null, previewedTargetKind,
        overlay.inRange, aimActive, aimRangeTiles, now,
        (url) => {
          if (!url) return null;
          const entry = portraitCacheRef.current.get(url);
          return entry?.ready ? entry.img : null;
        },
      );

      // 3. Projectiles (update + draw, fire onArrive on completion)
      const stillFlying: ActiveProjectile[] = [];
      for (const proj of projectilesRef.current) {
        const t = (now - proj.born) / proj.duration;
        if (t >= 1) {
          try { proj.onArrive(); } catch { /* swallow */ }
          continue;
        }
        const x = proj.fromX + (proj.toX - proj.fromX) * t;
        const y = proj.fromY + (proj.toY - proj.fromY) * t - (proj.kind !== "lightning" ? Math.sin(t * Math.PI) * 16 : 0);
        drawProjectile(ctx!, proj, x, y, t);
        stillFlying.push(proj);
      }
      projectilesRef.current = stillFlying;

      // 3b. Melee swings (arc anchored at attacker, sweeps toward target).
      const stillSwinging: ActiveSwing[] = [];
      for (const sw of swingsRef.current) {
        const t = (now - sw.born) / sw.duration;
        if (t >= 1) continue;
        const from = animatedPosRef.current[sw.fromActorId];
        if (!from) continue;
        // Fire onArrive at the peak (when the arc is squarely facing target).
        if (!sw.arrived && t >= 0.45) {
          sw.arrived = true;
          try { sw.onArrive(); } catch { /* swallow */ }
        }
        drawSwing(ctx!, from.x, from.y, hexSize, sw, t);
        stillSwinging.push(sw);
      }
      // Edge case: any swing that completed without firing onArrive (e.g.
      // missed the 0.45 frame) — fire it now so impact still lands.
      for (const sw of swingsRef.current) {
        if (sw.arrived) continue;
        if ((now - sw.born) >= sw.duration) {
          try { sw.onArrive(); } catch { /* swallow */ }
        }
      }
      swingsRef.current = stillSwinging;

      // 4. Particles (update + draw)
      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        const age = now - p.born;
        if (age >= p.life) continue;
        p.vx += p.ax * dt;
        p.vy += p.ay * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const lifeT = age / p.life;
        const alpha = 1 - lifeT;
        ctx!.globalAlpha = alpha;
        ctx!.fillStyle = p.color;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size * (1 - lifeT * 0.4), 0, Math.PI * 2);
        ctx!.fill();
        ctx!.globalAlpha = 1;
        alive.push(p);
      }
      particlesRef.current = alive;

      ctx!.restore();
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [state, grid, overlay, hover, currentActor, w, h, effectiveScale, offsetX, offsetY]);

  // Cosmetic horizontal nudge — only applied in legacy intrinsic-size mode
  // since fill-viewport mode auto-centers the grid via the world→screen
  // transform.
  const gridShiftX = fillViewport ? 0 : Math.round((Math.sqrt(3) / 2) * hexSize);

  // Keyboard zoom — bound to the container while focused so the player can
  // tap +/- without leaving the battlefield.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!fillViewport) return;
      // Ignore when typing in inputs / textareas (combat doesn't have any
      // inside this scope today, but cheap insurance).
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); bumpZoom(0.15); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); bumpZoom(-0.15); }
      else if (e.key === "0") { e.preventDefault(); resetView(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fillViewport]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        display: "block",
        width: w,
        height: h,
        marginLeft: gridShiftX,
      }}
    >
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        style={{
          display: "block",
          width: w,
          height: h,
          backgroundColor: "rgba(15, 23, 42, 0.55)",
          borderRadius: 8,
          border: "1px solid rgba(148, 163, 184, 0.25)",
          touchAction: fillViewport ? "none" : undefined,
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onWheel={fillViewport ? handleWheel : undefined}
        onPointerDown={fillViewport ? handlePointerDown : undefined}
        onPointerMove={fillViewport ? handlePointerMove : undefined}
        onPointerUp={fillViewport ? handlePointerUp : undefined}
        onPointerCancel={fillViewport ? handlePointerUp : undefined}
        onContextMenu={fillViewport ? (e) => e.preventDefault() : undefined}
      />
      {/* Zoom controls — bottom-right corner of the canvas. Hidden in
          legacy intrinsic mode since the canvas has no extra room. */}
      {fillViewport && (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            zIndex: 5,
          }}
        >
          <ZoomControl label="+" title="Zoom in (+)" onClick={() => bumpZoom(0.2)} />
          <ZoomControl label="−" title="Zoom out (−)" onClick={() => bumpZoom(-0.2)} />
          <ZoomControl label="⌖" title="Reset view (0)" onClick={resetView} />
        </div>
      )}
      {tooltipPx && hover?.label && (
        <div
          style={{
            position: "absolute",
            left: tooltipPx.x,
            top: tooltipPx.y,
            background: "rgba(15, 23, 42, 0.95)",
            color: "#e5e7eb",
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid rgba(148, 163, 184, 0.4)",
            fontSize: 12,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 50,
          }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

// Floating zoom button — small slate chip with a single glyph. Used by the
// fill-viewport mode for [+] / [−] / [⌖] in the canvas corner.
function ZoomControl({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 30, height: 30,
        background: "rgba(15, 23, 42, 0.85)",
        border: "1px solid rgba(148, 163, 184, 0.45)",
        borderRadius: 6,
        color: "#e5e7eb",
        cursor: "pointer",
        fontSize: 16,
        lineHeight: "28px",
        padding: 0,
        boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
      }}
    >
      {label}
    </button>
  );
}

// ── Layer 1: tiles ───────────────────────────────────────────────────────────

function drawTiles(
  ctx: CanvasRenderingContext2D,
  state: CombatState,
  grid: { cols: number; rows: number },
  overlay: { reachable: Set<string>; inRange: Set<string>; losBlocked: Set<string> },
  hover: HoverInfo | null,
  currentActor: CombatFighter | CombatMonster | null,
  hexToPixel: (pos: HexPos) => { x: number; y: number },
  hexSize: number,
  targetMonsterId: string | null,
  now: number,
) {
  const obstacles = new Set((state.obstacles ?? []).map((o) => posKey(o.pos)));
  // Resolve the target's hex up front so the tile pass can mark it with a
  // subtle dashed border (replaces the old pawn-orbit ring).
  let targetKey: string | null = null;
  if (targetMonsterId) {
    const t = state.monsters.find((m) => m.id === targetMonsterId);
    if (t?.pos && t.hp > 0) targetKey = posKey(t.pos);
  }
  // Brick layout: walk the valid axial coords per row. Even rows have `cols`
  // hexes, odd rows have `cols - 1` hexes (shifted right by half).
  for (let r = 0; r < grid.rows; r++) {
    const rowShift = Math.floor(r / 2);
    const rowWidth = r % 2 === 0 ? grid.cols : grid.cols - 1;
    for (let oc = 0; oc < rowWidth; oc++) {
      const q = oc - rowShift;
      const pos: HexPos = { q, r };
      const { x, y } = hexToPixel(pos);
      const key = posKey(pos);

      let fill = "rgba(30, 41, 59, 0.55)";
      let stroke = "rgba(100, 116, 139, 0.35)";
      let lineWidth = 1;

      if (obstacles.has(key)) {
        fill = "rgba(71, 85, 105, 0.85)";
        stroke = "rgba(148, 163, 184, 0.5)";
      } else if (overlay.reachable.has(key)) {
        // Cyan, not green — green-tinted battlefield art (forest/swamp/desk
        // scenes) makes a 0.18-alpha green fill disappear. Cyan pops against
        // every scene palette and the higher alpha keeps the reachable area
        // unambiguous when the AI ground art is busy.
        fill = "rgba(56, 189, 248, 0.32)";
        stroke = "rgba(56, 189, 248, 0.85)";
      } else if (overlay.inRange.has(key)) {
        fill = "rgba(248, 113, 113, 0.18)";
        stroke = "rgba(248, 113, 113, 0.55)";
      } else if (overlay.losBlocked.has(key)) {
        fill = "rgba(148, 163, 184, 0.15)";
        stroke = "rgba(148, 163, 184, 0.35)";
      }

      // Mark the current actor's hex
      if (currentActor?.pos && posKey(currentActor.pos) === key) {
        stroke = "rgba(250, 204, 21, 0.95)";
        lineWidth = 2.5;
      }

      // Hover highlight
      if (hover && posKey(hover.pos) === key) {
        switch (hover.reason) {
          case "reachable":
            fill = "rgba(56, 189, 248, 0.55)"; break;
          case "blocked":
            fill = "rgba(239, 68, 68, 0.30)"; break;
          case "in_range":
            fill = "rgba(248, 113, 113, 0.42)"; break;
          case "out_of_range":
          case "no_los":
            fill = "rgba(148, 163, 184, 0.30)"; break;
          case "obstacle":
            fill = "rgba(239, 68, 68, 0.20)"; break;
        }
      }

      drawHex(ctx, x, y, hexSize * 0.94, fill, stroke, lineWidth);

      // Target marker: subtle slow-drifting dashed border on the targeted
      // monster's hex. Replaces the old pawn-orbit ring so the pawn itself
      // stays uncluttered for status-effect particles.
      if (targetKey === key) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#fb923c";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -now / 60;
        drawHex(ctx, x, y, hexSize * 0.94, "rgba(0,0,0,0)", "#fb923c", 1.5);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }
}

// ── Layer 2: obstacles ───────────────────────────────────────────────────────

function drawObstacles(
  ctx: CanvasRenderingContext2D,
  state: CombatState,
  hexToPixel: (pos: HexPos) => { x: number; y: number },
  hexSize: number,
) {
  for (const o of state.obstacles ?? []) {
    const { x, y } = hexToPixel(o.pos);
    drawObstacleSprite(ctx, x, y, hexSize, o.kind as ObstacleKind);
  }
}

function drawObstacleSprite(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hexSize: number,
  kind: ObstacleKind,
) {
  ctx.save();
  switch (kind) {
    case "boulder": {
      // Filled grey blob with shadow underneath.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.55, hexSize * 0.55, hexSize * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7c7a78";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.08, hexSize * 0.62, hexSize * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a8a6a3";
      ctx.beginPath();
      ctx.ellipse(cx - hexSize * 0.15, cy - hexSize * 0.05, hexSize * 0.35, hexSize * 0.28, -0.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "pillar": {
      // Vertical column with capital + base.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.6, hexSize * 0.5, hexSize * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a8a09a";
      const colW = hexSize * 0.6;
      const colH = hexSize * 1.1;
      ctx.fillRect(cx - colW / 2, cy - colH * 0.6, colW, colH);
      // Capital
      ctx.fillStyle = "#c0b8b0";
      ctx.fillRect(cx - colW * 0.62, cy - colH * 0.6 - hexSize * 0.12, colW * 1.24, hexSize * 0.12);
      // Base
      ctx.fillRect(cx - colW * 0.62, cy + colH * 0.5, colW * 1.24, hexSize * 0.12);
      break;
    }
    case "crate": {
      // Wooden box with X braces.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.55, hexSize * 0.55, hexSize * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      const s = hexSize * 0.95;
      ctx.fillStyle = "#8b5e3c";
      ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      ctx.strokeStyle = "#5a3a22";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
      ctx.beginPath();
      ctx.moveTo(cx - s / 2, cy - s / 2);
      ctx.lineTo(cx + s / 2, cy + s / 2);
      ctx.moveTo(cx + s / 2, cy - s / 2);
      ctx.lineTo(cx - s / 2, cy + s / 2);
      ctx.stroke();
      break;
    }
    case "tree": {
      // Trunk + circular canopy.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.6, hexSize * 0.5, hexSize * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(cx - hexSize * 0.1, cy - hexSize * 0.1, hexSize * 0.2, hexSize * 0.7);
      ctx.fillStyle = "#3d6b3a";
      ctx.beginPath();
      ctx.arc(cx, cy - hexSize * 0.2, hexSize * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4d7b4a";
      ctx.beginPath();
      ctx.arc(cx - hexSize * 0.18, cy - hexSize * 0.35, hexSize * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rubble": {
      // Scattered small stones.
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.4, hexSize * 0.55, hexSize * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      const stones: Array<[number, number, number, string]> = [
        [-0.3, 0.1, 0.22, "#7c7a78"],
        [0.0, -0.05, 0.28, "#a8a6a3"],
        [0.3, 0.15, 0.18, "#5a5856"],
        [-0.05, 0.3, 0.16, "#6b6967"],
        [0.2, -0.2, 0.14, "#8c8a88"],
      ];
      for (const [dx, dy, r, color] of stones) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx + dx * hexSize, cy + dy * hexSize, r * hexSize, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// ── Layer 3: actor tokens ────────────────────────────────────────────────────

// Draws colored arc segments around a pawn — one per active status effect.
// Each effect gets an arc slice sized proportionally to how many effects are
// active, so a fighter with three statuses gets three thirds of the ring.
// The ring lives just outside the pawn body so it doesn't compete with the
// class/monster border.
// Per-effect ambient visualizations: fire embers, frost glints, lightning
// sparks, poison bubbles, bleed drips. Each effect with a particle look
// owns its own draw function; effects without one (stunned, taunt, marked,
// vulnerable, foreseen, etc.) fall back to a thin arc on the orbit ring.
function drawStatusOverlay(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, baseRadius: number,
  effects: readonly { type: string; remaining: number }[],
  now: number,
) {
  if (!effects || effects.length === 0) return;
  const live = effects.filter((e) => e.remaining > 0 && EFFECT_VISUAL[e.type]);
  if (live.length === 0) return;

  // Deterministic per-pawn jitter so two adjacent burning pawns don't ember
  // in sync. Uses the integer-rounded position as a stable seed.
  const seed = Math.round(cx) * 73856093 ^ Math.round(cy) * 19349663;

  // Split into "ambient" (custom particles) vs "ring" (arc segments). Ring
  // is used for status types without a custom visualizer so they still
  // appear, just less expressively.
  const ambient: typeof live = [];
  const ringEffects: typeof live = [];
  for (const e of live) {
    if (e.type === "burning" || e.type === "frozen" || e.type === "shocked"
      || e.type === "poisoned" || e.type === "bleeding") {
      ambient.push(e);
    } else {
      ringEffects.push(e);
    }
  }

  for (const e of ambient) {
    if (e.type === "burning") drawBurningEmbers(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "frozen") drawFrostGlints(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "shocked") drawShockSparks(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "poisoned") drawPoisonBubbles(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "bleeding") drawBleedDrips(ctx, cx, cy, baseRadius, now, seed);
  }

  if (ringEffects.length > 0) {
    const ringRadius = baseRadius + 4;
    const slice = (Math.PI * 2) / ringEffects.length;
    const driftStart = (now / 2400) % (Math.PI * 2);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let i = 0; i < ringEffects.length; i++) {
      const e = ringEffects[i];
      const v = EFFECT_VISUAL[e.type];
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = v.color;
      const start = driftStart + slice * i + slice * 0.08;
      const end = driftStart + slice * (i + 1) - slice * 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, start, end);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// Tiny deterministic pseudo-random: cheap LCG keyed by an integer seed.
// Returns a value in [0,1). Use to spread particle positions per pawn
// without burning a real PRNG instance per frame.
function rng01(seed: number, salt: number): number {
  const x = Math.sin(seed * 9301 + salt * 49297) * 233280;
  return x - Math.floor(x);
}

// Rising orange→red embers that drift up off the pawn and fade.
// Status-driven tint applied INSIDE the pawn-portrait clip. Layered on top
// of the portrait so the avatar still reads through, with an animated icy
// sheen for frozen specifically. Adding more tints (charred/red for burning,
// sickly green for poisoned, etc.) is just another branch on `type`.
function drawPortraitTint(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  effects: readonly { type: string; remaining: number }[],
  now: number,
) {
  if (!effects || effects.length === 0) return;
  const frozen = effects.some((e) => e.type === "frozen" && e.remaining > 0);
  if (frozen) {
    // Cool-blue color overlay: blend with the underlying portrait so the
    // image still shows through but reads as frozen-over. Multiply darkens
    // shadows; the rgba alpha controls intensity.
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(125, 211, 252, 0.85)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Drifting icy sheen — a soft white diagonal sweep that slowly travels
    // across the pawn so the surface looks like polished ice catching light.
    const sweepCycle = 4200;
    const t = ((now % sweepCycle) / sweepCycle) * 2 - 0.5; // -0.5 → 1.5
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    // 45° gradient band moving from upper-left to lower-right.
    const span = radius * 2.4;
    const cxBand = cx - radius + span * t;
    const cyBand = cy - radius + span * t;
    const grad = ctx.createLinearGradient(
      cxBand - span * 0.25, cyBand - span * 0.25,
      cxBand + span * 0.25, cyBand + span * 0.25,
    );
    grad.addColorStop(0,    "rgba(255, 255, 255, 0)");
    grad.addColorStop(0.45, "rgba(240, 249, 255, 0.55)");
    grad.addColorStop(0.55, "rgba(186, 230, 253, 0.65)");
    grad.addColorStop(1,    "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  const burning = effects.some((e) => e.type === "burning" && e.remaining > 0);
  if (burning) {
    // Warm flicker — multiply orange over the portrait so highlights blow
    // into a fire-lit warmth instead of just darkening. Intensity flickers
    // at ~7Hz so the surface looks like it's licked by flames.
    const flicker = 0.65 + 0.25 * Math.sin(now / 90) * 0.5 + 0.15 * Math.sin(now / 53);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgba(251, 146, 60, ${0.55 + 0.2 * flicker})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Bright inner glow at the bottom of the pawn — like flames licking up
    // from underneath. Radial gradient anchored low so the fire seems to
    // come from the ground.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    const glow = ctx.createRadialGradient(cx, cy + radius * 0.7, 0, cx, cy + radius * 0.7, radius * 1.4);
    glow.addColorStop(0, `rgba(254, 240, 138, ${0.55 * flicker})`);
    glow.addColorStop(0.45, `rgba(251, 146, 60, ${0.35 * flicker})`);
    glow.addColorStop(1, "rgba(127, 29, 29, 0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = glow;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }
}

function drawBurningEmbers(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const COUNT = 7;
  const CYCLE = 1100; // ms — full rise+fade
  ctx.save();
  for (let i = 0; i < COUNT; i++) {
    const phase = ((now + i * (CYCLE / COUNT) + rng01(seed, i) * CYCLE) % CYCLE) / CYCLE;
    // Horizontal start jitter spans the pawn width, with a slight inward bias.
    const hx = (rng01(seed, i + 100) - 0.5) * r * 1.6;
    // Slight horizontal sway so embers feel buoyant.
    const sway = Math.sin(now / 280 + i * 1.7) * r * 0.08;
    const x = cx + hx + sway;
    // Rise from pawn's lower hemisphere → past the top.
    const y = cy + r * 0.7 - phase * r * 2.4;
    const size = Math.max(0.5, r * 0.18 * (1 - phase * 0.7));
    const alpha = phase < 0.15 ? phase / 0.15 : 1 - (phase - 0.15) / 0.85;
    // Color shifts orange → red → dim red as it rises and cools.
    const t = phase;
    const rch = Math.round(255 * (1 - t * 0.2));
    const gch = Math.round(140 * (1 - t * 0.8));
    const bch = Math.round(40 * (1 - t));
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * 0.95;
    ctx.fillStyle = `rgb(${rch},${gch},${bch})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    // Bright core for the youngest embers.
    if (phase < 0.4) {
      ctx.globalAlpha = (1 - phase / 0.4) * 0.8;
      ctx.fillStyle = "#fef08a";
      ctx.beginPath();
      ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Frost halo on the pawn + jagged icicles hanging from the rim.
function drawFrostGlints(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  ctx.save();
  // Frosted rim — soft icy-blue glow so the viewer reads "this thing is
  // cold" even before the icicles register.
  const haloPulse = 0.55 + 0.2 * Math.sin(now / 700);
  const grad = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * 1.35);
  grad.addColorStop(0, "rgba(186, 230, 253, 0)");
  grad.addColorStop(0.55, `rgba(125, 211, 252, ${0.55 * haloPulse})`);
  grad.addColorStop(1, "rgba(125, 211, 252, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
  ctx.fill();

  // Icicles hang from the LOWER rim — gravity reads correctly with pointy
  // tips dripping down. Six icicles distributed across the bottom half
  // (ang in [0, π], where 0 = right, π/2 = bottom, π = left in canvas
  // y-flipped coords).
  const COUNT = 6;
  for (let i = 0; i < COUNT; i++) {
    // Spread across bottom half; tiny per-pawn jitter avoids lockstep.
    const t = (i + 0.5) / COUNT;
    const ang = Math.PI * (t - 0.05) + rng01(seed, i) * 0.12;
    const rimX = cx + Math.cos(ang) * r * 0.96;
    const rimY = cy + Math.sin(ang) * r * 0.96;
    // Length pulses subtly so the icicles feel like they're slowly growing.
    const lenPulse = 0.85 + 0.15 * Math.sin(now / 540 + i * 1.3);
    const len = r * (0.45 + 0.25 * rng01(seed, i + 13)) * lenPulse;
    const width = r * (0.22 + 0.08 * rng01(seed, i + 31));
    // Icicle direction: from the rim point AWAY from pawn center, biased
    // toward straight-down so they read as gravity-anchored.
    const radialDx = Math.cos(ang);
    const radialDy = Math.sin(ang);
    const dirX = radialDx * 0.35;
    const dirY = radialDy * 0.35 + 1; // gravity bias
    const dirLen = Math.hypot(dirX, dirY);
    const ux = dirX / dirLen, uy = dirY / dirLen;
    drawIcicle(ctx, rimX, rimY, ux, uy, len, width, seed * 17 + i);
  }

  // Occasional water drip from the tip of one icicle — slow cycle so it's
  // noticed in passing, not constant motion.
  const dripCycle = 1800;
  const dripPhase = (now % dripCycle) / dripCycle;
  if (dripPhase < 0.55) {
    const which = Math.floor(now / dripCycle) % COUNT;
    const t = (which + 0.5) / COUNT;
    const ang = Math.PI * (t - 0.05) + rng01(seed, which) * 0.12;
    const rimX = cx + Math.cos(ang) * r * 0.96;
    const rimY = cy + Math.sin(ang) * r * 0.96;
    const tipY = rimY + r * 0.55;
    const dy = dripPhase * r * 1.6;
    ctx.globalAlpha = 0.75 * (1 - dripPhase / 0.55);
    ctx.fillStyle = "#bae6fd";
    ctx.beginPath();
    ctx.arc(rimX, tipY + dy, Math.max(1, r * 0.07), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Single jagged icicle: tapered shape from (sx, sy) along (ux, uy) for
// `len` px, `width` px wide at the base, narrowing to a point. Sides are
// slightly notched to look like an irregular natural icicle.
function drawIcicle(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  ux: number, uy: number,
  len: number, width: number,
  seed: number,
) {
  // Perpendicular vector — gives us the "across" axis for the icicle width.
  const px = -uy, py = ux;
  const baseHalf = width / 2;
  // Walk one side of the icicle from base to tip with small jagged notches,
  // then the other side back. Path closes into a tapered, notched diamond.
  const SEGS = 5;
  ctx.beginPath();
  // Left side base.
  ctx.moveTo(sx + px * baseHalf, sy + py * baseHalf);
  for (let i = 1; i <= SEGS; i++) {
    const t = i / SEGS;
    // Width tapers quadratically so the tip stays sharp.
    const w = baseHalf * (1 - t) * (1 - t * 0.6);
    // Tiny perpendicular notch alternating in/out.
    const notch = (rng01(seed, i + 100) - 0.5) * baseHalf * 0.35;
    const x = sx + ux * len * t + px * (w + notch);
    const y = sy + uy * len * t + py * (w + notch);
    ctx.lineTo(x, y);
  }
  // Right side tip → base.
  for (let i = SEGS - 1; i >= 0; i--) {
    const t = i / SEGS;
    const w = baseHalf * (1 - t) * (1 - t * 0.6);
    const notch = (rng01(seed, i + 200) - 0.5) * baseHalf * 0.35;
    const x = sx + ux * len * t - px * (w + notch);
    const y = sy + uy * len * t - py * (w + notch);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  // Fill: icy-blue translucent body so the pawn rim shows faintly behind.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "rgba(186, 230, 253, 0.88)";
  ctx.fill();
  // Highlight stripe along the leading edge.
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = "#f0f9ff";
  ctx.lineWidth = Math.max(0.6, width * 0.18);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(sx + px * baseHalf * 0.2, sy + py * baseHalf * 0.2);
  ctx.lineTo(sx + ux * len * 0.95, sy + uy * len * 0.95);
  ctx.stroke();
  // Dark shadow on the trailing edge to give some 3D feel.
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = "rgba(30, 64, 175, 0.55)";
  ctx.lineWidth = Math.max(0.5, width * 0.12);
  ctx.beginPath();
  ctx.moveTo(sx - px * baseHalf * 0.4, sy - py * baseHalf * 0.4);
  ctx.lineTo(sx + ux * len * 0.9, sy + uy * len * 0.9);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Forking sparks that snap to random rim points for a single frame.
function drawShockSparks(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  // ~6 sparks/sec — fast strobe so it reads as electric.
  const tick = Math.floor(now / 160);
  ctx.save();
  ctx.strokeStyle = "#fef08a";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 2; i++) {
    const ang = rng01(seed ^ tick, i) * Math.PI * 2;
    const x0 = cx + Math.cos(ang) * r;
    const y0 = cy + Math.sin(ang) * r;
    // Zigzag of 3 segments outward.
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    let px = x0, py = y0;
    for (let s = 1; s <= 3; s++) {
      const dx = Math.cos(ang + (rng01(seed ^ tick, i * 10 + s) - 0.5) * 1.4) * r * 0.22;
      const dy = Math.sin(ang + (rng01(seed ^ tick, i * 10 + s) - 0.5) * 1.4) * r * 0.22;
      px += dx; py += dy;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Slow rising green bubbles that swell and pop above the pawn.
function drawPoisonBubbles(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const COUNT = 5;
  const CYCLE = 1600;
  ctx.save();
  for (let i = 0; i < COUNT; i++) {
    const phase = ((now + i * (CYCLE / COUNT) + rng01(seed, i + 50) * CYCLE) % CYCLE) / CYCLE;
    const hx = (rng01(seed, i + 30) - 0.5) * r * 1.4;
    const x = cx + hx;
    const y = cy + r * 0.6 - phase * r * 1.8;
    const size = r * 0.14 * (0.5 + phase * 0.8);
    const alpha = phase < 0.1 ? phase / 0.1 : phase > 0.85 ? (1 - phase) / 0.15 : 1;
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = "rgba(132, 204, 22, 0.7)";
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#a3e635";
    ctx.lineWidth = 1;
    ctx.globalAlpha = alpha * 0.9;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Falling red drips that streak down from random points on the lower rim.
function drawBleedDrips(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const COUNT = 4;
  const CYCLE = 900;
  ctx.save();
  for (let i = 0; i < COUNT; i++) {
    const phase = ((now + i * (CYCLE / COUNT) + rng01(seed, i + 90) * CYCLE) % CYCLE) / CYCLE;
    const ang = Math.PI * 0.25 + rng01(seed, i + 80) * Math.PI * 0.5; // bottom arc
    const x0 = cx + Math.cos(ang) * r;
    const y0 = cy + Math.abs(Math.sin(ang)) * r;
    const y = y0 + phase * r * 1.3;
    const size = r * 0.11 * (1 - phase * 0.5);
    const alpha = phase < 0.15 ? phase / 0.15 : 1 - (phase - 0.5) / 0.5;
    ctx.globalAlpha = Math.max(0, alpha) * 0.85;
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    // Teardrop: small circle at the head with a smear above it.
    ctx.arc(x0, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = Math.max(0, alpha) * 0.45;
    ctx.fillStyle = "#991b1b";
    ctx.beginPath();
    ctx.moveTo(x0 - size * 0.5, y);
    ctx.lineTo(x0, y - size * 1.4);
    ctx.lineTo(x0 + size * 0.5, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawActors(
  ctx: CanvasRenderingContext2D,
  state: CombatState,
  animatedPos: Record<string, { x: number; y: number }>,
  hexSize: number,
  targetMonsterId: string | null,
  currentActorId: string | null,
  turnPhase: "move" | "attack",
  previewedTargetIds: string[] | null,
  previewedTargetKind: "enemy" | "ally",
  reachableHexKeys: Set<string>,
  aimActive: boolean,
  aimRangeTiles: number | undefined,
  now: number,
  resolvePortrait: (url: string | null | undefined) => HTMLImageElement | null,
) {
  const previewSet = previewedTargetIds && previewedTargetIds.length > 0
    ? new Set(previewedTargetIds)
    : null;
  const previewColor = previewedTargetKind === "ally" ? "#22c55e" : "#f87171";

  // Aim mode: split the preview targets into "reachable" (in range + LOS clear)
  // and "unreachable". Reachable gets the strong pulsing glow; unreachable
  // gets a dim gray static ring so the player can still SEE the enemy but
  // knows it can't be targeted.
  function isReachable(pawn: { id: string; pos?: { q: number; r: number } | null }): boolean {
    if (!aimActive) return true;
    if (!pawn.pos) return false;
    return reachableHexKeys.has(`${pawn.pos.q},${pawn.pos.r}`);
  }

  function drawPreviewGlow(cx: number, cy: number, baseRadius: number, reachable: boolean) {
    const pulse = 0.55 + 0.45 * Math.sin(now / 200);
    ctx.save();
    if (reachable) {
      ctx.globalAlpha = 0.30 + 0.25 * pulse;
      ctx.fillStyle = previewColor;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius + hexSize * 0.30, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.7 + 0.3 * pulse;
      ctx.strokeStyle = previewColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius + hexSize * 0.30, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Unreachable: dim gray static ring so the player sees the enemy exists
      // but knows it can't be hit from here.
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius + hexSize * 0.22, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Phase-tinted pulse ring drawn under the current actor's pawn.
  // Yellow during MOVE, orange during ATTACK.
  function drawCurrentActorPulse(x: number, y: number, baseRadius: number) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    const ringRadius = baseRadius + hexSize * (0.18 + 0.10 * pulse);
    ctx.save();
    ctx.globalAlpha = 0.45 + 0.35 * pulse;
    ctx.strokeStyle = turnPhase === "move" ? "#facc15" : "#fb923c";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Current actor's attack-range ring: a faint dashed circle around the
  // active fighter during ATTACK phase. Helps players judge reach without
  // having to read the highlighted hexes.
  function drawAttackRangeRing(cx: number, cy: number, rangeTiles: number) {
    // Convert hex-range to pixel-range. One hex is sqrt(3)*hexSize wide for
    // pointy-top, so distance in pixels ≈ rangeTiles * sqrt(3) * hexSize.
    const r = rangeTiles * Math.sqrt(3) * hexSize;
    ctx.save();
    ctx.globalAlpha = 0.30;
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -now / 60;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  for (const f of state.fighters) {
    const a = animatedPos[f.id];
    if (!a) continue;
    const { x, y } = a;
    const downed = f.hp <= 0;
    const radius = hexSize * 0.55;
    if (!downed && previewSet?.has(f.id)) drawPreviewGlow(x, y, radius, isReachable(f as never));
    if (!downed && f.id === currentActorId) {
      // No pawn-level "current actor" pulse — the hex tile already paints
      // a gold border around the active hex, the class-color rim on the
      // pawn already says "yours," and the on-canvas overlays for status
      // effects (icicles, embers, sparks) need that visual budget so they
      // can stand out. Reach ring is still useful: shows attack range.
      // Reach ring around the current actor. Uses the aim mode's override
      // range when present (e.g. an ability with custom range), otherwise
      // the actor's weapon range. Only draws when ≥2 (melee adjacency is
      // already obvious from the neighbor hexes).
      const weaponRangeTiles = f.weapon_range
        ? (f.weapon_range === "melee" ? 1
          : f.weapon_range === "focus" ? (3 + Math.floor(Math.max(0, (f.stats?.int_stat ?? 5) - 5) / 4))
          : (5 + Math.floor(Math.max(0, (f.stats?.dex ?? 5) - 5) / 4)))
        : 1;
      const effectiveRange = aimActive && aimRangeTiles ? aimRangeTiles : weaponRangeTiles;
      if ((turnPhase === "attack" || aimActive) && effectiveRange >= 2) {
        drawAttackRangeRing(x, y, effectiveRange);
      }
    }
    ctx.globalAlpha = downed ? 0.4 : 1;
    // Fighter token: portrait clipped to circle if available, else slate
    // fill + class-color rim + initial. The rim sits at radius regardless
    // so the class color always reads.
    const fPortrait =
      resolvePortrait(charPortraitUrl(f.name))
      ?? resolvePortrait(classPortraitUrl(f.class));
    if (fPortrait) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      // Cover-crop: paint the source image so the shorter dimension fills
      // the circle and the longer one bleeds off, keeping faces centered.
      const d = radius * 2;
      const sw = fPortrait.naturalWidth || 1;
      const sh = fPortrait.naturalHeight || 1;
      const srcAspect = sw / sh;
      let drawW = d, drawH = d;
      if (srcAspect > 1) drawW = d * srcAspect;
      else drawH = d / srcAspect;
      ctx.drawImage(fPortrait, x - drawW / 2, y - drawH / 2, drawW, drawH);
      // Status tints stay INSIDE the clip so the colored overlay never bleeds
      // past the circular pawn frame.
      drawPortraitTint(ctx, x, y, radius, (f.effects ?? []) as never, now);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.fill();
      ctx.fillStyle = "#e5e7eb";
      ctx.font = `bold ${hexSize * 0.5}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((f.name ?? "?").charAt(0).toUpperCase(), x, y - 2);
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = classColor(f.class);
    ctx.stroke();
    if (!downed) drawHpBar(ctx, x, y + hexSize * 0.62, hexSize * 1.2, 4, f.hp, f.max_hp);
    if (!downed && f.effects) drawStatusOverlay(ctx, x, y, radius, f.effects as never, now);
    ctx.globalAlpha = 1;
  }
  for (const m of state.monsters) {
    if (!m.id) continue;
    const a = animatedPos[m.id];
    if (!a) continue;
    const { x, y } = a;
    const downed = m.hp <= 0;
    // Boss pawns are visibly larger so threat reads instantly.
    const radius = hexSize * (m.is_boss ? 0.78 : 0.6);
    if (!downed && previewSet?.has(m.id)) drawPreviewGlow(x, y, radius, isReachable(m as never));
    // Monster current-actor pulse intentionally dropped — same reasoning as
    // the fighter side. The hex tile border + gold rim already mark active
    // turn; the ambient effects need room to breathe.
    // Selected-target indicator: the target's HEX TILE gets a dashed orange
    // border (drawn in the tile pass, not here). No pawn-ring orbit — the
    // tile marker carries the targeting cue and leaves the pawn clean for
    // status-effect particles. (Code intentionally left empty for clarity.)
    ctx.globalAlpha = downed ? 0.35 : 1;
    const mPortrait =
      resolvePortrait(m.art_url)
      ?? (m.name ? resolvePortrait(monsterPortraitUrl(m.name)) : null);
    if (mPortrait) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const d = radius * 2;
      const sw = mPortrait.naturalWidth || 1;
      const sh = mPortrait.naturalHeight || 1;
      const srcAspect = sw / sh;
      let drawW = d, drawH = d;
      if (srcAspect > 1) drawW = d * srcAspect;
      else drawH = d / srcAspect;
      ctx.drawImage(mPortrait, x - drawW / 2, y - drawH / 2, drawW, drawH);
      drawPortraitTint(ctx, x, y, radius, (m.effects ?? []) as never, now);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = m.is_boss ? "rgba(127, 29, 29, 0.95)" : "rgba(76, 5, 25, 0.92)";
      ctx.fill();
      ctx.fillStyle = "#fee2e2";
      ctx.font = `bold ${hexSize * (m.is_boss ? 0.72 : 0.55)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((m.name ?? "?").charAt(0).toUpperCase(), x, y - 2);
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.lineWidth = m.is_boss ? 4 : 2.5;
    ctx.strokeStyle = m.is_boss ? "#fbbf24" : "#fca5a5"; // bosses get a gold rim
    ctx.stroke();
    if (!downed) drawHpBar(ctx, x, y + radius + 4, hexSize * (m.is_boss ? 1.7 : 1.25), m.is_boss ? 5 : 4, m.hp, m.max_hp);
    if (!downed && m.effects) drawStatusOverlay(ctx, x, y, radius, m.effects as never, now);
    ctx.globalAlpha = 1;
  }
}

// ── Layer 3: projectiles ─────────────────────────────────────────────────────

function drawProjectile(ctx: CanvasRenderingContext2D, proj: ActiveProjectile, x: number, y: number, t: number) {
  const color = PROJECTILE_COLOR[proj.kind];
  if (proj.kind === "lightning") {
    // Instant zigzag bolt
    const segments = 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 + (1 - t) * 2;
    ctx.globalAlpha = 1 - t;
    ctx.beginPath();
    ctx.moveTo(proj.fromX, proj.fromY);
    for (let i = 1; i < segments; i++) {
      const segT = i / segments;
      const sx = proj.fromX + (proj.toX - proj.fromX) * segT + (Math.random() - 0.5) * 12;
      const sy = proj.fromY + (proj.toY - proj.fromY) * segT + (Math.random() - 0.5) * 12;
      ctx.lineTo(sx, sy);
    }
    ctx.lineTo(proj.toX, proj.toY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  // Trail
  const dx = proj.toX - proj.fromX;
  const dy = proj.toY - proj.fromY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const tailX = x - (dx / len) * 18;
  const tailY = y - (dy / len) * 18;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // Head
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// ── Melee swing arc ─────────────────────────────────────────────────────────
// Renders an in-flight swing as a curved blade-trail anchored at the
// attacker's pawn edge. The sweep rotates through SWING_ARC_RADIANS over the
// swing duration; the head leads, the trail fades behind it. Eased so it
// accelerates into the contact frame around t=0.45.
function drawSwing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  hexSize: number,
  sw: ActiveSwing,
  t: number,
) {
  // Eased progress — faster in the middle so contact lands at t≈0.45 visually.
  const eased = t < 0.5
    ? 2 * t * t
    : 1 - Math.pow(-2 * t + 2, 2) / 2;
  // The arc starts at -ARC/2 of centerAngle and sweeps to +ARC/2.
  const startAngle = sw.centerAngle - SWING_ARC_RADIANS / 2;
  const headAngle = startAngle + SWING_ARC_RADIANS * eased;
  // Inner / outer radii (the swing is a curved band, not a thin line).
  const rInner = hexSize * 0.65;
  const rOuter = hexSize * 1.10;
  // Trail length grows toward the contact frame, then shrinks.
  const trailSpan = SWING_ARC_RADIANS * 0.45 * (1 - Math.abs(0.5 - t) * 1.4);
  const trailStart = Math.max(startAngle, headAngle - trailSpan);

  ctx.save();
  // Soft glow halo behind the blade
  ctx.globalAlpha = 0.20 + 0.25 * (1 - Math.abs(0.5 - t) * 2);
  ctx.strokeStyle = sw.color;
  ctx.lineWidth = (rOuter - rInner) * 1.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, (rInner + rOuter) / 2, trailStart, headAngle);
  ctx.stroke();
  // Sharp leading edge
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, headAngle - 0.05, headAngle + 0.05);
  ctx.stroke();
  // Inner streak in the element color
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = sw.color;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(cx, cy, (rInner + rOuter) / 2, headAngle - 0.10, headAngle);
  ctx.stroke();
  ctx.restore();
}
