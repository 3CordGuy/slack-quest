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
const PAWN_TWEEN_MS = 308;
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
  | "poison" | "bleed" | "heal" | "shield" | "crit" | "magic" | "loot" | "death";

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
  /** Draw path. Defaults to "circle" when unset. */
  shape?: ParticleShape;
  /** Current rotation in radians (snowflakes / sparks). */
  rot?: number;
  /** Rotation speed in rad/ms. */
  rotSpeed?: number;
  /** When true, alpha is modulated by a sine over time for a candle-like
   *  flicker (embers / snowflake glints). */
  flicker?: boolean;
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

const SWING_DURATION_MS = 286;
const SWING_ARC_RADIANS = (140 * Math.PI) / 180;

interface ActiveRiseEffect {
  id: string;
  kind: RiseKind;
  fromActorId?: string;
  born: number;
  duration: number;
}
const RISE_DURATION_MS = 1540;

const SWING_COLOR_BY_ELEMENT: Record<string, string> = {
  fire: "#fb923c",
  ice: "#7dd3fc",
  lightning: "#fde047",
  poison: "#a3e635",
  default: "#fef3c7",
};

// ParticleShape drives the per-particle draw path inside the render loop.
// "circle" is the legacy disc; the others read like what they describe so
// fire impacts actually look like rising embers, ice like falling crystals,
// and lightning like sharp electric sparks. New shapes plug in here.
type ParticleShape = "circle" | "ember" | "snowflake" | "spark";

interface ParticleConfig {
  count: number;
  speed: number;
  size: number;
  life: number;
  colors: string[];
  gravity: number;
  /** Shape drawn per particle; defaults to "circle". */
  shape?: ParticleShape;
  /** When true, particles flicker their alpha for a candle-like feel. */
  flicker?: boolean;
  /** When true, particles tumble — used for snowflakes / spark forks. */
  rotates?: boolean;
}

const PARTICLE_CONFIG: Record<ParticleKind, ParticleConfig> = {
  physical: { count: 6, speed: 0.055, size: 2.5, life: 160, colors: ["#fde68a", "#facc15", "#ffffff"], gravity: 0.0002 },
  // Fire — long-lived embers that rise + flicker. Lifetime intentionally
  // ~2s so impacts feel like the tile is briefly on fire even when no burn
  // status procced. Higher count + ember shape + strong upward gravity.
  fire:     { count: 36, speed: 0.18, size: 4, life: 1900, colors: ["#ff2a00", "#ff6a00", "#ffae00", "#fde047"], gravity: -0.0009, shape: "ember", flicker: true },
  // Ice — slow-falling snowflakes that drift and twinkle. Long lifetime so
  // the chill lingers; rotation gives crystal shapes visual identity.
  ice:      { count: 28, speed: 0.10, size: 4, life: 1900, colors: ["#e0f2fe", "#bae6fd", "#7dd3fc", "#ffffff"], gravity: 0.00045, shape: "snowflake", rotates: true, flicker: true },
  // Lightning — tight spark burst, dissipates within ~2 tiles.
  lightning:{ count: 18, speed: 0.13, size: 3, life: 380, colors: ["#fef9c3", "#fde047", "#a78bfa", "#ffffff"], gravity: 0.0001, shape: "spark", rotates: true },
  poison:   { count: 10, speed: 0.08, size: 4, life: 650, colors: ["#84cc16", "#a3e635", "#65a30d"], gravity: 0.001 },
  bleed:    { count: 10, speed: 0.10, size: 3, life: 600, colors: ["#dc2626", "#ef4444", "#7f1d1d"], gravity: 0.0012 },
  heal:     { count: 16, speed: 0.14, size: 3, life: 900, colors: ["#86efac", "#bbf7d0", "#ffffff"], gravity: -0.0008 },
  shield:   { count: 12, speed: 0.16, size: 3, life: 550, colors: ["#7dd3fc", "#bae6fd", "#ffffff"], gravity: 0 },
  crit:     { count: 10, speed: 0.09, size: 3, life: 240, colors: ["#fde047", "#facc15", "#fb923c", "#ffffff"], gravity: 0 },
  magic:    { count: 12, speed: 0.09, size: 3, life: 480, colors: ["#c4b5fd", "#a78bfa", "#ffffff"], gravity: 0 },
  loot:     { count: 14, speed: 0.10, size: 3, life: 450, colors: ["#fde047", "#fbbf24", "#fde68a", "#ffffff"], gravity: -0.0003 },
  // Death poof — warm dust that drifts upward and fades. Replaces the actor
  // token right as it disappears so the eye has somewhere to rest.
  death:    { count: 12, speed: 0.06, size: 3.5, life: 520, colors: ["#d4c8b0", "#b3a487", "#c8bca4", "#e8dfd0"], gravity: -0.0003 },
};

// Hand-authored Path2D shapes — one per ParticleShape, built once at module
// load and reused for every particle. Cheaper than the per-particle
// imperative draws they replaced (a single fill() vs. multiple beginPath +
// moveTo/lineTo chains) and cheaper than fetching game-icons SVGs (no
// network, no parse, no async). All paths are normalized to a [-1, 1]
// unit space; the render loop scales by the particle's size.
function buildEmberPath(): Path2D {
  // Teardrop pointing up (-y). One quadratic curve per side.
  const p = new Path2D();
  p.moveTo(0, -1);                              // sharp tip
  p.quadraticCurveTo(0.85, -0.15, 0, 0.85);     // right belly down to base
  p.quadraticCurveTo(-0.85, -0.15, 0, -1);      // left belly back up
  p.closePath();
  return p;
}
function buildSnowflakePath(): Path2D {
  // Six arms with two short bristles each — reads as a crystal at small
  // sizes. Stroked, not filled (lineWidth set in the render loop).
  const p = new Path2D();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const cx = Math.cos(a), cy = Math.sin(a);
    p.moveTo(0, 0);
    p.lineTo(cx, cy);
    const bx = cx * 0.6, by = cy * 0.6;
    const ba = a + Math.PI / 3;
    const bristleCos = Math.cos(ba) * 0.28, bristleSin = Math.sin(ba) * 0.28;
    p.moveTo(bx, by);
    p.lineTo(bx + bristleCos, by + bristleSin);
    p.moveTo(bx, by);
    p.lineTo(bx - bristleCos, by - bristleSin);
  }
  return p;
}
function buildSparkPath(): Path2D {
  // Three-segment forked streak. Stroked, asymmetric so rotation reads.
  const p = new Path2D();
  p.moveTo(-1, 0);
  p.lineTo(0.15, 0.18);
  p.lineTo(0.45, -0.05);
  p.lineTo(1, 0.05);
  return p;
}
const SHAPE_PATHS: Record<Exclude<ParticleShape, "circle">, Path2D> = {
  ember: buildEmberPath(),
  snowflake: buildSnowflakePath(),
  spark: buildSparkPath(),
};

// Projectile flight time. Bumped fire/ice from ~300ms to ~600ms so they
// actually read as travelling — at 300ms the trail barely registered before
// the impact burst started. Lightning stays near-instant by design.
const PROJECTILE_DURATION: Record<ProjectileKind, number> = {
  arrow: 385, fire: 682, ice: 682, lightning: 132, poison: 506, magic: 418,
};

// Mid-flight vertical lift in pixels — controls how much each projectile
// arcs vs. flies straight. Fire rockets nearly flat; arrows lob (gravity);
// magic floats up and curves down; lightning is dead straight.
const PROJECTILE_ARC: Record<ProjectileKind, number> = {
  arrow: 22, fire: 6, ice: 4, lightning: 0, poison: 18, magic: 14,
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

// Maps a GroundEffectKind to the matching basic-elemental ParticleKind used by
// the single-tile elemental procs (fire/ice/magic/etc.). Used by CombatPage to
// emit bursts on ground_placed / ground_tick / ground_triggered so the new
// ground abilities visually match the existing single-tile elemental effects.
export function particleKindForGroundKind(kind: import("@gantt-quest/core").GroundEffectKind): ParticleKind {
  switch (kind) {
    case "fire": return "fire";
    case "frost": return "ice";
    case "brambles": return "poison";
    case "consecrated": return "heal";
    case "caltrops": return "physical";
    case "rune": return "magic";
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

// Vitals readout drawn below each pawn: a thin HP bar, plus an optional
// shield bar and (for fighters) a mana bar stacked underneath. The
// combined stack height is roughly the same as the original solo HP bar,
// so it doesn't fight pawn art for screen real estate.
function drawPawnVitals(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  hp: number,
  maxHp: number,
  shield: number,
  shieldMax: number,
  mana: number,
  maxMana: number,
) {
  const barH = 2;
  const gap = 1;
  const x = cx - w / 2;
  let y = cy;

  // HP
  const hpPct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(x, y, w, barH);
  ctx.fillStyle = hpPct > 0.5 ? "#22c55e" : hpPct > 0.25 ? "#facc15" : "#ef4444";
  ctx.fillRect(x, y, w * hpPct, barH);

  // Shield (only when the pawn can actually wear shield)
  if (shieldMax > 0) {
    y += barH + gap;
    const sPct = Math.max(0, Math.min(1, shield / shieldMax));
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x, y, w, barH);
    ctx.fillStyle = sPct > 0 ? "#60a5fa" : "#7f1d1d";
    ctx.fillRect(x, y, w * sPct, barH);
  }

  // Mana (fighters only)
  if (maxMana > 0) {
    y += barH + gap;
    const mPct = Math.max(0, Math.min(1, mana / maxMana));
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x, y, w, barH);
    ctx.fillStyle = "#8b5cf6";
    ctx.fillRect(x, y, w * mPct, barH);
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CombatHexGridHandle {
  emitParticle: (p: ParticleEmit) => void;
  emitProjectile: (p: ProjectileEmit, onArrive: () => void) => void;
  /** Fire a melee swing arc that originates at the attacker, sweeps in the
   *  direction of the target, and invokes onArrive when the swing reaches
   *  peak (so impact particles fire on contact, not at the start). */
  emitSwing: (p: SwingEmit, onArrive: () => void) => void;
  /** Brief "popup" rise effect — a small kind-specific colored icon plus
   *  matching sparkles float up from the pawn over ~1.4 s. Used for
   *  one-shot event indicators (taunt, marked, vulnerable, foreseen,
   *  test-coverage shield, delivery bonus) that don't live on the
   *  persistent effects array. */
  emitRiseEffect: (p: RiseEffectEmit) => void;
  shake: () => void;
  /** Shake a single pawn token for a brief impact wiggle. */
  shakePawn: (actorId: string) => void;
}

export type RiseKind =
  | "taunt"        // angry red shout
  | "marked"       // orange crosshair
  | "vulnerable"   // cracked shield, amber
  | "foreseen"     // blue eye / forecast
  | "test_coverage" // green checkmark
  | "delivery_bonus" // gold coin
  | "ill_omen";     // dark hex / curse forewarning

export interface RiseEffectEmit {
  id: string;
  kind: RiseKind;
  /** Pawn to glue the rise to. Falls back to canvas center if unknown. */
  actorId?: string;
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
  server_rack: "Server Rack",
  desktop_computer: "Workstation",
  printer: "Printer",
  file_cabinet: "File Cabinet",
  watercooler: "Water Cooler",
  cubicle_wall: "Cubicle Wall",
  k8s_cluster: "k8s Cluster",
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
  // Active "popup" rise effects — kind-specific colored icon + sparkles
  // floating up from the actor for ~1.4 s, then auto-removed in the rAF
  // loop. Used for transient event indicators (taunt/marked/etc.) that
  // don't sit on the persistent effects array.
  const risesRef = useRef<ActiveRiseEffect[]>([]);
  const shakeRef = useRef<{ start: number; duration: number } | null>(null);
  const pawnShakesRef = useRef<Record<string, { start: number; duration: number }>>({});
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
  //
  // Local-dev override: in `vite dev`, the client probes
  // `/dev-battlefield/<scene>.png` first. When found it's used instead of
  // the worker-provided R2 URL — lets contributors drop a curated PNG into
  // `apps/web/public/dev-battlefield/` and see it immediately without
  // uploading to R2. In production builds (`import.meta.env.DEV === false`)
  // the probe is skipped entirely.
  useEffect(() => {
    backgroundReadyRef.current = false;

    function loadFinal(src: string | null): void {
      if (!src) { backgroundImageRef.current = null; return; }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { backgroundReadyRef.current = true; };
      img.onerror = () => { backgroundReadyRef.current = false; };
      img.src = src;
      backgroundImageRef.current = img;
    }

    const scene = state.scene;
    if (import.meta.env.DEV && scene) {
      const devUrl = `/dev-battlefield/${scene}.png`;
      const probe = new Image();
      probe.onload = () => loadFinal(devUrl);
      probe.onerror = () => loadFinal(backgroundUrl ?? null);
      probe.src = devUrl;
    } else {
      loadFinal(backgroundUrl ?? null);
    }
  }, [backgroundUrl, state.scene]);

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
      return { reachable: new Set<string>(), inRange: new Set<string>(), attackArea: new Set<string>(), losBlocked: new Set<string>() };
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
        attackArea: new Set<string>(),
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
      // attackArea = every hex within range, LOS-permitting for non-melee.
      // Drawn as a green tile tint so the player sees the reach of the
      // primed action at a glance. Gated on aimActive so the wash only
      // appears once an attack or ability has been selected — during the
      // open attack phase (no action primed yet) the grid stays clean and
      // click-to-target still works via the inRange set.
      const attackArea = new Set<string>();
      if (aimActive) {
        const disk = hexDisk(actorPos, rangeTiles, grid);
        const isMelee = fighter.weapon_range === "melee";
        for (const p of disk) {
          if (!isMelee && !hexLos(actorPos, p, obstacles)) continue;
          attackArea.add(posKey(p));
        }
      }
      return { reachable: new Set<string>(), inRange, attackArea, losBlocked };
    }

    return { reachable: new Set<string>(), inRange: new Set<string>(), attackArea: new Set<string>(), losBlocked: new Set<string>() };
  }, [currentActor, isMyTurn, turnPhase, aimActive, aimRangeTiles, state.fighters, state.monsters, state.obstacles, grid]);

  // Pointer move during an active pan drag. Uses pointer events because
  // setPointerCapture redirects pointer (not mouse) events to the captured
  // element — onMouseMove fires inconsistently mid-drag, and right-button
  // drags in particular get eaten by the browser's context-menu handling
  // so onMouseMove never fires at all between pointerdown and pointerup.
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    // Update tracked touch position first so pinch math sees the latest
    // finger location.
    if (e.pointerType === "touch" && activeTouchesRef.current.has(e.pointerId)) {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Two-finger pinch — drives zoom anchored at the midpoint between the
    // touches so the world point under the midpoint stays put as the
    // user zooms in/out.
    if (e.pointerType === "touch" && activeTouchesRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(activeTouchesRef.current.values());
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0) return;
      const start = pinchStartRef.current;
      const factor = dist / start.dist;
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, start.zoom * factor));
      const realFactor = newZoom / start.zoom;
      // Same midpoint-anchor math as the wheel handler. Use the snapshot
      // pan/zoom (`start.*`) as the reference frame so the gesture is
      // stable across the whole pinch.
      const startOffX = (w - natural.w * baseScale * start.zoom) / 2 + start.pan.x;
      const startOffY = (h - natural.h * baseScale * start.zoom) / 2 + start.pan.y;
      const worldX = (start.midX - startOffX) / (baseScale * start.zoom);
      const worldY = (start.midY - startOffY) / (baseScale * start.zoom);
      const wantNewOffX = start.midX - worldX * baseScale * newZoom;
      const wantNewOffY = start.midY - worldY * baseScale * newZoom;
      const newPanX = wantNewOffX - (w - natural.w * baseScale * newZoom) / 2;
      const newPanY = wantNewOffY - (h - natural.h * baseScale * newZoom) / 2;
      void realFactor;
      setZoom(newZoom);
      setPan(clampPan({ x: newPanX, y: newPanY }));
      return;
    }
    // Single-pointer pan path (mouse drag OR single-touch on mobile).
    if (!panDragRef.current) return;
    if (panDragRef.current.pointerId !== e.pointerId) return;
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
      const lootHere = (state.loot_tiles ?? []).find((t) => posKey(t.pos) === posKey(hex));
      if (currentActor.pos && posKey(currentActor.pos) === posKey(hex)) {
        info = { pos: hex, reason: "self", label: "You are here", cursor: "default" };
      } else if (overlay.reachable.has(posKey(hex))) {
        const pickupLabel = lootHere
          ? (lootHere.kind === "gold" ? "Move here · pick up gold" : "Move here · pick up chest")
          : "Move here";
        info = { pos: hex, reason: "reachable", label: pickupLabel, cursor: "pointer" };
      } else if (lootHere) {
        info = {
          pos: hex,
          reason: "blocked",
          label: lootHere.kind === "gold" ? "Gold pile · out of move range" : "Mystery chest · out of move range",
          cursor: "not-allowed",
        };
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
  // Pan drag (middle button OR right button OR shift+left, OR single
  // touch-pointer on mobile). Tracked in a ref so mid-drag re-renders don't
  // lose accumulated state. `pointerId` keeps the captured pointer's
  // identifier so multi-touch can route correctly (the pan pointer keeps
  // panning; a second touch-finger triggers pinch mode instead of
  // appending to the pan).
  const panDragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  // Active touch points keyed by pointerId. Drives pinch-zoom on mobile:
  // when two touches are down we treat it as a pinch (compute the distance
  // between them per frame and scale `zoom` proportionally). A single
  // touch falls through to the pan handler.
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Snapshot of the pinch state at the moment the second finger went
  // down — used as the divisor when computing the current zoom multiplier.
  const pinchStartRef = useRef<{ dist: number; zoom: number; midX: number; midY: number; pan: { x: number; y: number } } | null>(null);
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
    const canvas = canvasRef.current;
    // Touch: register the contact in the multi-touch map. The 2nd touch
    // becomes the start of a pinch; a single touch becomes a single-
    // finger pan (mobile).
    if (e.pointerType === "touch") {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (activeTouchesRef.current.size === 2) {
        // Pinch begin — snapshot start distance, zoom, mid, and pan so the
        // current pan also follows the pinch midpoint deterministically.
        const pts = Array.from(activeTouchesRef.current.values());
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        const dist = Math.hypot(dx, dy);
        const rect = canvas?.getBoundingClientRect();
        if (rect) {
          const scaleX = canvas!.width / rect.width;
          const scaleY = canvas!.height / rect.height;
          const midX = (((pts[0].x + pts[1].x) / 2) - rect.left) * scaleX;
          const midY = (((pts[0].y + pts[1].y) / 2) - rect.top)  * scaleY;
          pinchStartRef.current = { dist, zoom, midX, midY, pan: { x: pan.x, y: pan.y } };
        }
        // While pinching, suppress any in-flight single-touch pan so the
        // gesture doesn't fight itself.
        panDragRef.current = null;
        return;
      }
      // Single touch — start a pan.
      panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: false };
      return;
    }
    // Mouse: middle button, right button, or shift+left starts panning.
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: false };
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
    const canvas = canvasRef.current;
    // Touch cleanup — drop the contact and end pinch mode if it was active.
    if (e.pointerType === "touch") {
      const wasPinching = activeTouchesRef.current.size === 2;
      activeTouchesRef.current.delete(e.pointerId);
      try { canvas?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasPinching) {
        // Pinch ended (one finger lifted). Drop the pinch snapshot. The
        // remaining finger could keep panning, but for simplicity we
        // require lift+retouch to start a new pan to avoid surprising
        // jumps from where the pinch ended.
        pinchStartRef.current = null;
        panDragRef.current = null;
        return;
      }
      // Single-touch pan release. Suppress the synthetic click the
      // browser fires on a tap that registered as a pan.
      if (panDragRef.current?.pointerId === e.pointerId) {
        const moved = panDragRef.current.moved;
        panDragRef.current = null;
        if (moved) suppressNextClickRef.current = true;
      }
      return;
    }
    // Mouse path.
    if (!panDragRef.current) return;
    if (panDragRef.current.pointerId !== e.pointerId) return;
    const wasLeft = e.button === 0;
    const moved = panDragRef.current.moved;
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
        // For "ember" particles we bias initial velocity upward so the
        // dome of embers reads as fire rising from the impact, not a
        // circular ring blasting outward. Snowflakes and sparks keep the
        // even radial spread but add per-particle rotation.
        for (let i = 0; i < cfg.count; i++) {
          let vx: number;
          let vy: number;
          const speed = cfg.speed * (0.7 + Math.random() * 0.6);
          if (cfg.shape === "ember") {
            // Cone upward: -135° to -45° (where 0° points right, -90° up).
            const ang = -Math.PI / 4 - (Math.PI / 2) * Math.random();
            vx = Math.cos(ang) * speed;
            vy = Math.sin(ang) * speed * 1.2; // a touch more vertical thrust
          } else if (cfg.shape === "spark") {
            // Wide radial blast but with a bias so a few sparks always
            // jet sideways — reads as electricity arcing along the ground.
            const ang = (Math.PI * 2 * i) / cfg.count + (Math.random() - 0.5) * 1.1;
            vx = Math.cos(ang) * speed * (1 + Math.random() * 0.6);
            vy = Math.sin(ang) * speed * (1 + Math.random() * 0.6);
          } else {
            const ang = (Math.PI * 2 * i) / cfg.count + (Math.random() - 0.5) * 0.3;
            vx = Math.cos(ang) * speed;
            vy = Math.sin(ang) * speed;
          }
          particlesRef.current.push({
            x: center.x,
            y: center.y,
            vx,
            vy,
            ax: 0,
            ay: cfg.gravity,
            size: cfg.size * (0.6 + Math.random() * 0.8),
            color: cfg.colors[i % cfg.colors.length],
            born: now,
            life: cfg.life * (0.85 + Math.random() * 0.3), // jitter so they don't all die at once
            shape: cfg.shape,
            rot: cfg.rotates ? Math.random() * Math.PI * 2 : undefined,
            rotSpeed: cfg.rotates ? (Math.random() - 0.5) * 0.012 : undefined,
            flicker: cfg.flicker,
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
      emitRiseEffect(p) {
        risesRef.current.push({
          id: p.id,
          kind: p.kind,
          fromActorId: p.actorId,
          born: performance.now(),
          duration: RISE_DURATION_MS,
        });
      },
      shake() {
        shakeRef.current = { start: performance.now(), duration: 240 };
      },
      shakePawn(actorId: string) {
        pawnShakesRef.current[actorId] = { start: performance.now(), duration: 260 };
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

      // Apply the world→screen transform so every subsequent drawing call
      // (tiles, obstacles, pawns, particles, projectiles) can stay in world
      // space — hexToPixel coords flow straight to the canvas without
      // per-call scaling. Composes with shake by translating first.
      ctx!.translate(offsetX, offsetY);
      ctx!.scale(effectiveScale, effectiveScale);

      // 0. Battlefield art (curated terrain or AI-generated ground texture).
      //    Drawn in WORLD space so it pans and zooms with the hex grid as a
      //    single attached layer — never stretches to fit the viewport.
      //    Anchored to the grid's natural bounding box; the image is sized so
      //    its "playable interior" (the inner region excluding decorative
      //    rock/tree borders) covers the grid bounds. Borders extend outward
      //    into the canvas padding to frame the play area.
      if (backgroundReadyRef.current && backgroundImageRef.current) {
        const img = backgroundImageRef.current;
        const imgW = img.naturalWidth || 1024;
        const imgH = img.naturalHeight || 1024;
        // Native grid bounding box at default settings (hexSize=26, pad=18,
        // 9 cols × 11 rows) is 442 × 478 world pixels. When BG_MODE = "native"
        // and the curated PNG is generated at that aspect (or any multiple:
        // 884×956, 1326×1434, 1768×1912 — see docs/curated-battlefield-art.md),
        // the image is downscaled to fit the natural grid bounds 1:1 — no
        // scale knobs, only X/Y offset to align. COVER mode keeps the
        // earlier behavior for square-ish curated art that needs to oversize
        // to frame the grid.
        const BG_MODE: "native" | "cover" = "cover";

        // X/Y offset in world pixels. Positive X = right, positive Y = down.
        // Used in both modes to nudge the image into final alignment.
        const BG_OFFSET_X = -13;
        const BG_OFFSET_Y = 10;

        let drawW: number;
        let drawH: number;
        if (BG_MODE === "native") {
          // Lay the image down at the grid's natural width while preserving
          // the image's aspect ratio. If you generate at exactly 442×478 (or
          // a multiple), drawW=natural.w and drawH=natural.h — pixel-perfect
          // overlap, no aspect distortion.
          drawW = natural.w;
          drawH = imgH * (natural.w / imgW);
        } else {
          // Per-side border allowance for COVER mode: how much of the image
          // is decorative border that should extend OUTSIDE the playable
          // grid area. Only consulted in COVER mode.
          const BG_BORDER_FRAC = 0.015;
          const interior = 1 - 2 * BG_BORDER_FRAC;
          // Final multiplier layered on top of COVER fit (1.0 = pure cover).
          const BG_SCALE_ADJUST = 0.90;
          const scale = Math.max(
            natural.w / (imgW * interior),
            natural.h / (imgH * interior),
          ) * BG_SCALE_ADJUST;
          drawW = imgW * scale;
          drawH = imgH * scale;
        }
        const drawX = natural.w / 2 - drawW / 2 + BG_OFFSET_X;
        const drawY = natural.h / 2 - drawH / 2 + BG_OFFSET_Y;
        ctx!.globalAlpha = 0.55;
        ctx!.drawImage(img, drawX, drawY, drawW, drawH);
        ctx!.globalAlpha = 1;
      }

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

      // 1.6 Ground effects (fire walls, caltrops, consecrated, etc.). Drawn
      // BELOW obstacles and pawns so a fighter standing on a fire tile reads
      // as "on top of the effect." Static tinted highlight + a small per-kind
      // glyph for v1 — fancier VFX deferred to a follow-up.
      drawGroundEffects(ctx!, state, hexToPixel, hexSize, now);

      // 2. Obstacles (between tiles and pawns so pawns can stand "near" them)
      drawObstacles(ctx!, state, hexToPixel, hexSize);

      // 2b. Loot tiles — drawn over the tile fill so the sparkle ring shows,
      // but underneath pawns so a fighter who walks onto a tile visually
      // covers it for the brief tween before pickup fires.
      drawLootTiles(ctx!, state, hexToPixel, hexSize, now);

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

      // Apply per-pawn shake offsets — create a shallow copy only when shakes
      // are active so the hot path (no active shakes) stays allocation-free.
      let drawPositions: typeof anim = anim;
      const pawnShakes = pawnShakesRef.current;
      const shakeKeys = Object.keys(pawnShakes);
      if (shakeKeys.length > 0) {
        drawPositions = { ...anim };
        for (const actorId of shakeKeys) {
          const sh = pawnShakes[actorId];
          const elapsed = now - sh.start;
          if (elapsed >= sh.duration) {
            delete pawnShakes[actorId];
          } else if (drawPositions[actorId]) {
            const t = 1 - elapsed / sh.duration;
            drawPositions[actorId] = {
              ...drawPositions[actorId],
              x: drawPositions[actorId].x + (Math.random() - 0.5) * 8 * t,
              y: drawPositions[actorId].y + (Math.random() - 0.5) * 6 * t,
            };
          }
        }
      }

      // 3. Actor tokens — use animated positions so moves slide smoothly.
      drawActors(
        ctx!, state, drawPositions, hexSize,
        targetMonsterId ?? null, currentActorId, turnPhase,
        previewedTargetIds ?? null, previewedTargetKind,
        overlay.inRange, aimActive, aimRangeTiles, now,
        (url) => {
          if (!url) return null;
          const entry = portraitCacheRef.current.get(url);
          return entry?.ready ? entry.img : null;
        },
      );

      // 3. Projectiles (update + draw, fire onArrive on completion).
      // Per-kind arc + trail emission live here so drawProjectile can stay
      // focused on the silhouette of the projectile itself.
      const stillFlying: ActiveProjectile[] = [];
      for (const proj of projectilesRef.current) {
        const t = (now - proj.born) / proj.duration;
        if (t >= 1) {
          try { proj.onArrive(); } catch { /* swallow */ }
          continue;
        }
        const arc = PROJECTILE_ARC[proj.kind];
        const x = proj.fromX + (proj.toX - proj.fromX) * t;
        const y = proj.fromY + (proj.toY - proj.fromY) * t - Math.sin(t * Math.PI) * arc;
        drawProjectile(ctx!, proj, x, y, t);
        // Trail emission: fire and ice projectiles shed element-themed
        // motes as they fly. Throttled so the trail reads as a stream
        // (every ~28ms ≈ 35 fps of trail particles, plenty for the eye).
        if (proj.kind === "fire" || proj.kind === "ice") {
          const lastTrail = (proj as ActiveProjectile & { lastTrail?: number }).lastTrail ?? 0;
          if (now - lastTrail > 28) {
            (proj as ActiveProjectile & { lastTrail?: number }).lastTrail = now;
            if (proj.kind === "fire") {
              // Tiny rising embers behind the fireball
              particlesRef.current.push({
                x: x + (Math.random() - 0.5) * 4,
                y: y + (Math.random() - 0.5) * 4,
                vx: (Math.random() - 0.5) * 0.08,
                vy: -0.05 - Math.random() * 0.08,
                ax: 0, ay: -0.0006,
                size: 2.5 + Math.random() * 1.5,
                color: ["#ff5500", "#ff8c00", "#fbbf24"][Math.floor(Math.random() * 3)],
                born: now,
                life: 520,
                shape: "ember",
                flicker: true,
              });
            } else {
              // Slow falling ice motes behind the frost shard
              particlesRef.current.push({
                x: x + (Math.random() - 0.5) * 4,
                y: y + (Math.random() - 0.5) * 4,
                vx: (Math.random() - 0.5) * 0.04,
                vy: 0.03 + Math.random() * 0.04,
                ax: 0, ay: 0.0003,
                size: 2 + Math.random() * 1.2,
                color: ["#e0f2fe", "#bae6fd", "#ffffff"][Math.floor(Math.random() * 3)],
                born: now,
                life: 600,
                shape: "snowflake",
                rot: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * 0.01,
              });
            }
          }
        }
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

      // 3c. Rise effects — kind-specific colored icon + sparkles floating
      // up from each glued pawn. Auto-removed when past duration.
      const stillRising: ActiveRiseEffect[] = [];
      for (const rise of risesRef.current) {
        const age = now - rise.born;
        if (age >= rise.duration) continue;
        const t = age / rise.duration;
        const anchor = rise.fromActorId ? animatedPosRef.current[rise.fromActorId] : null;
        if (anchor) drawRiseEffect(ctx!, anchor.x, anchor.y, hexSize, rise.kind, t);
        stillRising.push(rise);
      }
      risesRef.current = stillRising;

      // 4. Particles (update + draw). Shape-aware: each shape renders with
      // its own geometry + blend so fire/ice/lightning impacts read as
      // their element instead of "yet another colored circle." Lifetime
      // is intentionally long for the elemental impacts (~2s) so the
      // animation feels like the tile is briefly on fire / frozen / arcing.
      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        const age = now - p.born;
        if (age >= p.life) continue;
        p.vx += p.ax * dt;
        p.vy += p.ay * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.rotSpeed) p.rot = (p.rot ?? 0) + p.rotSpeed * dt;
        const lifeT = age / p.life;
        // Embers fade slowly at first then ramp out near death so the heart
        // of the burst stays bright; circles use the legacy linear fade.
        const baseAlpha = p.shape === "ember"
          ? 1 - Math.pow(lifeT, 1.8)
          : p.shape === "snowflake"
            ? 1 - Math.pow(lifeT, 1.4)
            : 1 - lifeT;
        const flick = p.flicker
          ? 0.75 + 0.25 * Math.sin(age * 0.025 + p.x * 0.13)
          : 1;
        const alpha = Math.max(0, Math.min(1, baseAlpha * flick));
        const sz = p.size * (1 - lifeT * 0.35);

        if (p.shape === "ember") {
          // Soft additive halo (a single arc) + the pre-built ember
          // teardrop on top. The teardrop is filled with the particle's
          // color; the halo gives it the white-hot glow.
          ctx!.save();
          ctx!.globalCompositeOperation = "lighter";
          ctx!.globalAlpha = alpha * 0.55;
          ctx!.fillStyle = p.color;
          ctx!.beginPath();
          ctx!.arc(p.x, p.y, sz * 2.4, 0, Math.PI * 2);
          ctx!.fill();
          // Pre-built teardrop, scaled + tinted per particle.
          ctx!.globalAlpha = alpha;
          ctx!.translate(p.x, p.y);
          // Slight wobble around the upward axis so embers don't look
          // identical — uses the particle's birth time as a stable seed.
          ctx!.rotate(Math.sin(age * 0.004 + p.born * 0.0003) * 0.15);
          ctx!.scale(sz * 0.9, sz * 0.9);
          ctx!.fillStyle = p.color;
          ctx!.fill(SHAPE_PATHS.ember);
          // Hot white tip
          ctx!.fillStyle = "#ffffff";
          ctx!.globalAlpha = alpha * 0.85;
          ctx!.beginPath();
          ctx!.arc(0, -0.5, 0.28, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.restore();
        } else if (p.shape === "snowflake") {
          // Single stroke of the pre-built 6-arm crystal + a center pip.
          ctx!.save();
          ctx!.translate(p.x, p.y);
          ctx!.rotate(p.rot ?? 0);
          const arm = sz * 1.6;
          ctx!.scale(arm, arm);
          ctx!.globalAlpha = alpha * 0.9;
          ctx!.strokeStyle = p.color;
          ctx!.lineWidth = Math.max(0.04, 0.2 / arm * sz); // ≈ sz*0.18 px in screen space
          ctx!.lineCap = "round";
          ctx!.stroke(SHAPE_PATHS.snowflake);
          // Bright center pip (in unit-space coords now)
          ctx!.globalAlpha = alpha;
          ctx!.fillStyle = "#ffffff";
          ctx!.beginPath();
          ctx!.arc(0, 0, 0.22, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.restore();
        } else if (p.shape === "spark") {
          // Pre-built forked streak, stroked twice — wide color underlay
          // and a thin white-hot core on top.
          ctx!.save();
          ctx!.translate(p.x, p.y);
          ctx!.rotate(p.rot ?? 0);
          const halfLen = sz * 3.5;
          ctx!.scale(halfLen, halfLen);
          ctx!.globalCompositeOperation = "lighter";
          ctx!.globalAlpha = alpha;
          ctx!.lineCap = "round";
          ctx!.lineJoin = "round";
          // Wide color stroke
          ctx!.strokeStyle = p.color;
          ctx!.lineWidth = Math.max(0.06, sz * 0.7 / halfLen);
          ctx!.stroke(SHAPE_PATHS.spark);
          // Thin white-hot core
          ctx!.strokeStyle = "#ffffff";
          ctx!.lineWidth = Math.max(0.03, sz * 0.3 / halfLen);
          ctx!.stroke(SHAPE_PATHS.spark);
          ctx!.restore();
        } else {
          // Legacy circle path — used by everything that doesn't opt into
          // a custom shape (poison droplets, bleed splats, heal motes…).
          ctx!.globalAlpha = alpha;
          ctx!.fillStyle = p.color;
          ctx!.beginPath();
          ctx!.arc(p.x, p.y, sz, 0, Math.PI * 2);
          ctx!.fill();
        }
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
  overlay: { reachable: Set<string>; inRange: Set<string>; attackArea: Set<string>; losBlocked: Set<string> },
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

      let fill = "rgba(30, 41, 59, 0.14)";
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
      } else if (overlay.attackArea.has(key)) {
        // Attack-phase reach: every hex within range + LOS tinted emerald
        // green. Mirrors the move-phase cyan fill so range reads at the
        // same glance. The inRange (monster-targetable) tint sits inside
        // this same green wash — the hex with the targeted monster gets
        // its own gold/orange border so the active pick still stands out.
        fill = "rgba(34, 197, 94, 0.28)";
        stroke = "rgba(34, 197, 94, 0.75)";
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
  // Sprite footprints are kept inside the hex inscribed circle (~0.866 × hexSize
  // wide at the flats, narrowing to 0 at the points). Earlier versions had
  // canopies and capitals that visibly spilled across hex borders, which made
  // ranged attacks "look" blocked when the hex math line skirted past the
  // obstacle's actual tile. Tighter sprites keep the visual and the LOS math
  // in sync.
  ctx.save();
  switch (kind) {
    case "boulder": {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.42, hexSize * 0.40, hexSize * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7c7a78";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.05, hexSize * 0.48, hexSize * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a8a6a3";
      ctx.beginPath();
      ctx.ellipse(cx - hexSize * 0.12, cy - hexSize * 0.05, hexSize * 0.27, hexSize * 0.22, -0.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "pillar": {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.46, hexSize * 0.38, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a8a09a";
      const colW = hexSize * 0.46;
      const colH = hexSize * 0.86;
      ctx.fillRect(cx - colW / 2, cy - colH * 0.55, colW, colH);
      ctx.fillStyle = "#c0b8b0";
      ctx.fillRect(cx - colW * 0.58, cy - colH * 0.55 - hexSize * 0.10, colW * 1.16, hexSize * 0.10);
      ctx.fillRect(cx - colW * 0.58, cy + colH * 0.45, colW * 1.16, hexSize * 0.10);
      break;
    }
    case "crate": {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.42, hexSize * 0.42, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      const s = hexSize * 0.72;
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
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.48, hexSize * 0.38, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(cx - hexSize * 0.08, cy - hexSize * 0.05, hexSize * 0.16, hexSize * 0.55);
      ctx.fillStyle = "#3d6b3a";
      ctx.beginPath();
      ctx.arc(cx, cy - hexSize * 0.15, hexSize * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4d7b4a";
      ctx.beginPath();
      ctx.arc(cx - hexSize * 0.14, cy - hexSize * 0.26, hexSize * 0.22, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rubble": {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.34, hexSize * 0.42, hexSize * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      const stones: Array<[number, number, number, string]> = [
        [-0.24, 0.08, 0.18, "#7c7a78"],
        [0.0, -0.04, 0.22, "#a8a6a3"],
        [0.24, 0.12, 0.14, "#5a5856"],
        [-0.04, 0.24, 0.12, "#6b6967"],
        [0.16, -0.16, 0.11, "#8c8a88"],
      ];
      for (const [dx, dy, r, color] of stones) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx + dx * hexSize, cy + dy * hexSize, r * hexSize, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "server_rack": {
      // Tall dark chassis with 3 rows of LED status lights and a faint cable
      // drape at the bottom — reads as a 1U server pile from across the grid.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.46, hexSize * 0.36, hexSize * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      const w = hexSize * 0.52;
      const h = hexSize * 0.82;
      const x0 = cx - w / 2;
      const y0 = cy - h * 0.52;
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = "#0b1320";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = "#374151";
      ctx.fillRect(x0, y0, w, hexSize * 0.08);
      const rowYs = [0.20, 0.45, 0.70];
      for (let row = 0; row < rowYs.length; row++) {
        const ry = y0 + h * rowYs[row];
        ctx.fillStyle = "#0b1320";
        ctx.fillRect(x0 + w * 0.08, ry, w * 0.84, hexSize * 0.06);
        const ledColor = row === 1 ? "#fbbf24" : "#22d3ee";
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = ledColor;
          ctx.beginPath();
          ctx.arc(x0 + w * (0.16 + i * 0.13), ry + hexSize * 0.03, hexSize * 0.022, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 + w * 0.25, y0 + h);
      ctx.quadraticCurveTo(x0 + w * 0.3, y0 + h + hexSize * 0.10, x0 + w * 0.18, y0 + h + hexSize * 0.18);
      ctx.moveTo(x0 + w * 0.65, y0 + h);
      ctx.quadraticCurveTo(x0 + w * 0.7, y0 + h + hexSize * 0.12, x0 + w * 0.82, y0 + h + hexSize * 0.18);
      ctx.stroke();
      break;
    }
    case "desktop_computer": {
      // Boxy monitor on a small stand with a glowing screen + side tower.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.42, hexSize * 0.42, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      const monW = hexSize * 0.56;
      const monH = hexSize * 0.42;
      const mx = cx - hexSize * 0.06 - monW / 2;
      const my = cy - hexSize * 0.18;
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(mx, my, monW, monH);
      const grad = ctx.createLinearGradient(mx, my, mx, my + monH);
      grad.addColorStop(0, "#22d3ee");
      grad.addColorStop(1, "#0ea5e9");
      ctx.fillStyle = grad;
      ctx.fillRect(mx + 2, my + 2, monW - 4, monH - 4);
      ctx.fillStyle = "#475569";
      ctx.fillRect(cx - hexSize * 0.10, my + monH, hexSize * 0.08, hexSize * 0.10);
      ctx.fillRect(cx - hexSize * 0.20, my + monH + hexSize * 0.10, hexSize * 0.28, hexSize * 0.04);
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(cx + hexSize * 0.24, my + monH * 0.20, hexSize * 0.14, hexSize * 0.30);
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.arc(cx + hexSize * 0.31, my + monH * 0.46, hexSize * 0.018, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "printer": {
      // Squat off-white box, paper tray peeks out the top, blinking LED.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.40, hexSize * 0.46, hexSize * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      const w = hexSize * 0.74;
      const h = hexSize * 0.46;
      const x0 = cx - w / 2;
      const y0 = cy - hexSize * 0.10;
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = "#f9fafb";
      ctx.fillRect(x0 + w * 0.20, y0 - hexSize * 0.10, w * 0.60, hexSize * 0.10);
      ctx.strokeStyle = "#cbd5e1";
      ctx.strokeRect(x0 + w * 0.20, y0 - hexSize * 0.10, w * 0.60, hexSize * 0.10);
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(x0 + w * 0.08, y0 + h * 0.20, w * 0.26, h * 0.16);
      ctx.fillStyle = "#34d399";
      ctx.beginPath();
      ctx.arc(x0 + w * 0.82, y0 + h * 0.30, hexSize * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(x0 + w * 0.10, y0 + h * 0.55, w * 0.80, hexSize * 0.04);
      break;
    }
    case "file_cabinet": {
      // Tall narrow metal cabinet with 4 drawers and small pull handles.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.46, hexSize * 0.34, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      const w = hexSize * 0.48;
      const h = hexSize * 0.86;
      const x0 = cx - w / 2;
      const y0 = cy - h * 0.54;
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = "#4b5563";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, w, h);
      for (let i = 0; i < 4; i++) {
        const dy = y0 + (h / 4) * i;
        ctx.strokeStyle = "#6b7280";
        ctx.beginPath();
        ctx.moveTo(x0, dy);
        ctx.lineTo(x0 + w, dy);
        ctx.stroke();
        ctx.fillStyle = "#374151";
        ctx.fillRect(x0 + w * 0.35, dy + (h / 4) * 0.55, w * 0.30, hexSize * 0.04);
      }
      break;
    }
    case "watercooler": {
      // Translucent blue jug atop a white base with a spigot. Air bubbles inside.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.46, hexSize * 0.34, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      const baseW = hexSize * 0.50;
      const baseH = hexSize * 0.36;
      const bx = cx - baseW / 2;
      const by = cy + hexSize * 0.10;
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(bx, by, baseW, baseH);
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, baseW, baseH);
      ctx.fillStyle = "#1e3a8a";
      ctx.fillRect(bx + baseW * 0.40, by + baseH * 0.50, baseW * 0.20, hexSize * 0.08);
      ctx.fillStyle = "#94a3b8";
      ctx.fillRect(bx + baseW * 0.20, by + baseH - hexSize * 0.04, baseW * 0.60, hexSize * 0.04);
      const jugW = hexSize * 0.40;
      const jugH = hexSize * 0.42;
      const jx = cx - jugW / 2;
      const jy = by - jugH + hexSize * 0.06;
      ctx.fillStyle = "rgba(56, 189, 248, 0.55)";
      ctx.fillRect(jx, jy, jugW, jugH);
      ctx.strokeStyle = "#0284c7";
      ctx.strokeRect(jx, jy, jugW, jugH);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.arc(jx + jugW * 0.30, jy + jugH * 0.30, hexSize * 0.025, 0, Math.PI * 2);
      ctx.arc(jx + jugW * 0.65, jy + jugH * 0.55, hexSize * 0.020, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "cubicle_wall": {
      // Gray fabric panel with a darker frame and a couple of sticky notes.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.46, hexSize * 0.42, hexSize * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      const w = hexSize * 0.78;
      const h = hexSize * 0.72;
      const x0 = cx - w / 2;
      const y0 = cy - h * 0.55;
      ctx.fillStyle = "#475569";
      ctx.fillRect(x0 + w, y0 + hexSize * 0.04, hexSize * 0.06, h - hexSize * 0.04);
      ctx.fillStyle = "#94a3b8";
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, w, h);
      ctx.strokeStyle = "rgba(71,85,105,0.4)";
      ctx.lineWidth = 0.6;
      for (let i = 1; i < 4; i++) {
        const tx = x0 + (w / 4) * i;
        ctx.beginPath();
        ctx.moveTo(tx, y0 + 2);
        ctx.lineTo(tx, y0 + h - 2);
        ctx.stroke();
      }
      ctx.fillStyle = "#fde047";
      ctx.fillRect(x0 + w * 0.15, y0 + h * 0.20, hexSize * 0.14, hexSize * 0.14);
      ctx.fillStyle = "#f9a8d4";
      ctx.fillRect(x0 + w * 0.55, y0 + h * 0.45, hexSize * 0.14, hexSize * 0.14);
      break;
    }
    case "k8s_cluster": {
      // 3×3 grid of small dark node cubes with cyan LEDs — reads as a humming
      // pod cluster at a glance.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + hexSize * 0.44, hexSize * 0.44, hexSize * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();
      const span = hexSize * 0.70;
      const step = span / 2;
      const node = hexSize * 0.16;
      for (let row = 0; row < 3; row++) {
        for (let c = 0; c < 3; c++) {
          const nx = cx - span / 2 + c * step;
          const ny = cy - span / 2 + row * step;
          ctx.fillStyle = "#1e293b";
          ctx.fillRect(nx - node / 2, ny - node / 2, node, node);
          ctx.strokeStyle = "#0ea5e9";
          ctx.lineWidth = 1;
          ctx.strokeRect(nx - node / 2, ny - node / 2, node, node);
          ctx.fillStyle = (row + c) % 2 === 0 ? "#34d399" : "#22d3ee";
          ctx.beginPath();
          ctx.arc(nx + node * 0.30, ny + node * 0.30, hexSize * 0.018, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = "rgba(34,211,238,0.5)";
      for (let row = 0; row < 3; row++) {
        for (let c = 0; c < 2; c++) {
          const nx = cx - span / 2 + (c + 0.5) * step;
          const ny = cy - span / 2 + row * step;
          ctx.beginPath();
          ctx.arc(nx, ny, hexSize * 0.012, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
  }
  ctx.restore();
}

// ── Layer 2b: loot tiles ─────────────────────────────────────────────────────

function drawLootTiles(
  ctx: CanvasRenderingContext2D,
  state: CombatState,
  hexToPixel: (pos: HexPos) => { x: number; y: number },
  hexSize: number,
  now: number,
) {
  for (const t of state.loot_tiles ?? []) {
    const { x, y } = hexToPixel(t.pos);
    if (t.kind === "gold") drawGoldPile(ctx, x, y, hexSize, now);
    else drawLootChest(ctx, x, y, hexSize, now);
  }
}

// ── Layer 1.6: ground effects ──────────────────────────────────────────────
//
// Per-kind colour + glyph palette. Tints the hex with a soft fill plus a
// 1.5px dashed stroke so the effect reads as "marked terrain" without
// overpowering the pawn art. The glyph is a single emoji-style character
// drawn dimmer at the hex centre. See docs/ground-effects.md.
// Tile colors only — the per-kind identity now comes from the particle bursts
// (see particleKindForGroundKind), not a center glyph. Keeps the tile clean so
// a standing pawn isn't fighting an emoji underneath it.
const GROUND_PALETTE: Record<string, { fill: string; stroke: string }> = {
  fire:         { fill: "rgba(239,68,68,0.32)",  stroke: "#f97316" },
  brambles:     { fill: "rgba(132,204,22,0.30)", stroke: "#65a30d" },
  frost:        { fill: "rgba(125,211,252,0.35)",stroke: "#38bdf8" },
  caltrops:     { fill: "rgba(161,161,170,0.32)",stroke: "#a1a1aa" },
  consecrated:  { fill: "rgba(250,204,21,0.28)", stroke: "#facc15" },
  rune:         { fill: "rgba(168,85,247,0.32)", stroke: "#a855f7" },
};

function drawGroundEffects(
  ctx: CanvasRenderingContext2D,
  state: CombatState,
  hexToPixel: (pos: HexPos) => { x: number; y: number },
  hexSize: number,
  now: number,
) {
  const effects = state.ground_effects;
  if (!effects || effects.length === 0) return;
  for (const ge of effects) {
    const palette = GROUND_PALETTE[ge.kind] ?? GROUND_PALETTE.fire;
    for (const h of ge.hexes) {
      const { x, y } = hexToPixel(h);
      // Tinted hex fill — slight pulse so the effect breathes (10% alpha
      // wobble over ~1.6s). Static enough not to distract, animated enough
      // to read as "live."
      const pulse = 0.85 + Math.sin(now / 800) * 0.15;
      ctx.save();
      ctx.globalAlpha = pulse;
      drawHex(ctx, x, y, hexSize * 0.92, palette.fill, "rgba(0,0,0,0)", 0);
      // Dashed stroke marquee around the perimeter.
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.lineDashOffset = -now / 90;
      drawHex(ctx, x, y, hexSize * 0.92, "rgba(0,0,0,0)", palette.stroke, 1.5);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

function drawSparkleRing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radius: number,
  count: number,
  now: number,
  color: string,
  seed: number,
) {
  const phase = (now / 900) % (Math.PI * 2);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const ang = phase + (i / count) * Math.PI * 2 + (seed + i) * 0.1;
    const r = radius + Math.sin(now / 240 + i) * 1.5;
    const sx = cx + Math.cos(ang) * r;
    const sy = cy + Math.sin(ang) * r * 0.55; // squashed into a flatter orbit
    const twinkle = 0.5 + 0.5 * Math.sin(now / 320 + i * 1.3);
    ctx.globalAlpha = 0.45 + 0.45 * twinkle;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, 1.4 + twinkle * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGoldPile(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  hexSize: number,
  now: number,
) {
  ctx.save();
  // Ground shadow
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.ellipse(cx, cy + hexSize * 0.36, hexSize * 0.40, hexSize * 0.10, 0, 0, Math.PI * 2);
  ctx.fill();
  // Coin mound — three rows of slightly offset golden discs
  const coins: Array<[number, number, number]> = [
    [-0.18, 0.20, 0.10],
    [0.00,  0.20, 0.11],
    [0.18,  0.20, 0.10],
    [-0.10, 0.06, 0.11],
    [0.10,  0.06, 0.11],
    [0.00, -0.06, 0.10],
  ];
  for (const [dx, dy, r] of coins) {
    const x = cx + dx * hexSize;
    const y = cy + dy * hexSize;
    // Coin face (gold)
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.arc(x, y, r * hexSize, 0, Math.PI * 2);
    ctx.fill();
    // Inner shading
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(x, y, r * hexSize * 0.7, 0, Math.PI * 2);
    ctx.fill();
    // Highlight glint
    ctx.fillStyle = "#fde68a";
    ctx.beginPath();
    ctx.arc(x - r * hexSize * 0.3, y - r * hexSize * 0.3, r * hexSize * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Tiny pile-on-top coin
  ctx.fillStyle = "#fcd34d";
  ctx.beginPath();
  ctx.arc(cx, cy - hexSize * 0.18, hexSize * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.beginPath();
  ctx.arc(cx - hexSize * 0.025, cy - hexSize * 0.20, hexSize * 0.025, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Sparkle aura — orbits the pile so the player notices it across the grid
  drawSparkleRing(ctx, cx, cy, hexSize * 0.46, 6, now, "#fde047", Math.round(cx + cy));
}

function drawLootChest(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  hexSize: number,
  now: number,
) {
  ctx.save();
  // Ground shadow
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.ellipse(cx, cy + hexSize * 0.38, hexSize * 0.44, hexSize * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  const w = hexSize * 0.66;
  const bodyH = hexSize * 0.32;
  const lidH = hexSize * 0.22;
  const x0 = cx - w / 2;
  const bodyY = cy + hexSize * 0.04;
  const lidY = bodyY - lidH;
  // Body (dark walnut)
  ctx.fillStyle = "#6b3f1d";
  ctx.fillRect(x0, bodyY, w, bodyH);
  // Body strapping
  ctx.fillStyle = "#3f2412";
  ctx.fillRect(x0, bodyY + bodyH - hexSize * 0.04, w, hexSize * 0.04);
  // Lid (lighter band)
  ctx.fillStyle = "#8b5e3c";
  ctx.beginPath();
  ctx.moveTo(x0, lidY + lidH);
  ctx.lineTo(x0, lidY + lidH * 0.30);
  ctx.quadraticCurveTo(cx, lidY - lidH * 0.20, x0 + w, lidY + lidH * 0.30);
  ctx.lineTo(x0 + w, lidY + lidH);
  ctx.closePath();
  ctx.fill();
  // Brass bands
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0 + w * 0.15, lidY);
  ctx.quadraticCurveTo(x0 + w * 0.15, lidY - lidH * 0.05, x0 + w * 0.15, bodyY + bodyH);
  ctx.moveTo(x0 + w * 0.85, lidY);
  ctx.quadraticCurveTo(x0 + w * 0.85, lidY - lidH * 0.05, x0 + w * 0.85, bodyY + bodyH);
  ctx.stroke();
  // Lock plate
  ctx.fillStyle = "#fbbf24";
  ctx.fillRect(cx - hexSize * 0.06, bodyY + bodyH * 0.20, hexSize * 0.12, hexSize * 0.16);
  ctx.fillStyle = "#0b1320";
  ctx.fillRect(cx - hexSize * 0.015, bodyY + bodyH * 0.32, hexSize * 0.03, hexSize * 0.06);
  // Frame outline
  ctx.strokeStyle = "#3f2412";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0, bodyY, w, bodyH);
  ctx.restore();
  // Sparkle ring with brass tones
  drawSparkleRing(ctx, cx, cy, hexSize * 0.48, 8, now, "#fbbf24", Math.round(cx + cy));
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
      || e.type === "poisoned" || e.type === "bleeding"
      || e.type === "stunned" || e.type === "regen"
      || e.type === "empowered" || e.type === "entangled"
      || e.type === "hexed" || e.type === "barkskin"
      || e.type === "animal_form") {
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
    else if (e.type === "stunned") drawContainerized(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "regen") drawRegenPluses(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "empowered") drawEmpoweredAura(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "entangled") drawDeadlockedChain(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "hexed") drawHexedWisps(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "barkskin") drawFirewalled(ctx, cx, cy, baseRadius, now, seed);
    else if (e.type === "animal_form") drawScaledUpAura(ctx, cx, cy, baseRadius, now, seed);
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

  const bleeding = effects.some((e) => e.type === "bleeding" && e.remaining > 0);
  if (bleeding) {
    // Blood smears at the lower rim — small irregular red splotches that
    // shift position slowly so the wound feels like it's seeping. Drawn
    // inside the portrait clip so the avatar takes the marks instead of
    // floating over it.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    // Dim the portrait slightly — pale loss-of-color from blood loss.
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    // Six slow-moving smears across the lower half. Positions seeded by
    // pawn coords so neighboring bleeding pawns don't smear identically.
    ctx.globalCompositeOperation = "source-over";
    const SEED = Math.round(cx) ^ Math.round(cy);
    for (let i = 0; i < 6; i++) {
      // Slower smear cycle — was 2200ms, now 4800ms, so the splotches feel
      // like a slow seep rather than fast-moving paint.
      const phase = ((now / 4800 + i * 0.17 + (Math.sin(SEED + i) + 1) * 0.5) % 1);
      const ang = Math.PI * (0.15 + (i / 6) * 0.7);
      const r0 = radius * 0.85;
      const x0 = cx + Math.cos(ang) * r0;
      const y0 = cy + Math.sin(ang) * r0;
      const dy = phase * radius * 0.55;
      const size = radius * (0.14 + 0.05 * Math.sin(SEED * 7 + i));
      const alpha = 0.75 * (0.6 + 0.4 * Math.sin(SEED * 3 + i * 1.3));
      ctx.globalAlpha = alpha;
      // Dark crimson splotch.
      ctx.fillStyle = "#7f1d1d";
      ctx.beginPath();
      ctx.ellipse(x0, y0 + dy, size * 1.1, size * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      // Brighter highlight on the trailing edge so it reads as wet, not scab.
      ctx.fillStyle = "#dc2626";
      ctx.globalAlpha = alpha * 0.85;
      ctx.beginPath();
      ctx.ellipse(x0 - size * 0.2, y0 + dy - size * 0.1, size * 0.7, size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  const poisoned = effects.some((e) => e.type === "poisoned" && e.remaining > 0);
  if (poisoned) {
    // Sickly chartreuse cast — slow nauseating throb so the avatar feels
    // wrong, not energetic. Multiply pulls the underlying skin tones into
    // a greener register.
    const pulse = 0.65 + 0.15 * Math.sin(now / 480);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgba(132, 204, 22, ${0.55 * pulse})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Faint inner haze — radial gradient gives the surface a wet/sickly
    // sheen as if sweat or venom is beading at the center of the figure.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, "rgba(163, 230, 53, 0.30)");
    grad.addColorStop(0.6, "rgba(101, 163, 13, 0.15)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  const shocked = effects.some((e) => e.type === "shocked" && e.remaining > 0);
  if (shocked) {
    // Strobing electric flash — yellow-white overlay with a high-frequency
    // pulse so the pawn looks like it's being zapped. Period chosen short
    // enough to feel jittery but not so fast it strobes unpleasantly.
    const strobe = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 65));
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = `rgba(254, 240, 138, ${0.45 * strobe})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Brief high-frequency white flash that lands on every ~6th frame so
    // the pawn occasionally pops with a hot electric burst.
    const tick = Math.floor(now / 220);
    if ((tick % 3) === 0) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = "#fefce8";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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

// "Scaled Up" — orange energy surge around the pawn. Reads as compute
// provisioning: a hot upward draft of streaks rising from below the
// figure, a swelling halo, and ringed concentric pulses expanding
// outward from the feet. Matches the Druid's Scale Up ability blurb
// ("Compute provisioned — stats surged while active").
function drawScaledUpAura(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  ctx.save();

  // Pulsing orange halo behind everything else.
  const halo = 0.55 + 0.2 * Math.sin(now / 500);
  const haloGrad = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.55);
  haloGrad.addColorStop(0, "rgba(249, 115, 22, 0)");
  haloGrad.addColorStop(0.5, `rgba(249, 115, 22, ${0.40 * halo})`);
  haloGrad.addColorStop(1, "rgba(180, 83, 9, 0)");
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.55, 0, Math.PI * 2);
  ctx.fill();

  // Concentric rings expanding outward from the pawn's base, fading as
  // they grow — reads as resources scaling up beneath the actor.
  const RINGS = 3;
  const RING_CYCLE = 1500;
  for (let i = 0; i < RINGS; i++) {
    const phase = ((now + i * (RING_CYCLE / RINGS)) % RING_CYCLE) / RING_CYCLE;
    const ringR = r * (0.95 + phase * 0.7);
    const alpha = (1 - phase) * 0.6;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = Math.max(1.2, r * 0.07 * (1 - phase * 0.5));
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.65, ringR, ringR * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Upward-rising energy streaks emanating from the lower hemisphere —
  // hot yellow inner with orange-red outer for that scale-up burst feel.
  const STREAKS = 9;
  const STREAK_CYCLE = 900;
  ctx.lineCap = "round";
  for (let i = 0; i < STREAKS; i++) {
    const phase = ((now + i * (STREAK_CYCLE / STREAKS) + rng01(seed, i + 700) * STREAK_CYCLE) % STREAK_CYCLE) / STREAK_CYCLE;
    // Origin point spread across the bottom of the pawn — slight side jitter.
    const baseAng = Math.PI * (0.05 + (i / STREAKS) * 0.9);
    const x0 = cx + Math.cos(baseAng) * r * 0.85;
    const y0 = cy + Math.sin(baseAng) * r * 0.85;
    // Each streak rises upward + slightly outward; length grows with phase
    // and fades at both ends so they don't pop.
    const len = r * (0.4 + phase * 0.95);
    const tipX = x0 + (rng01(seed, i + 720) - 0.5) * r * 0.4;
    const tipY = y0 - len;
    const alpha = (phase < 0.2 ? phase / 0.2 : 1) * (phase > 0.7 ? (1 - phase) / 0.3 : 1) * 0.95;
    // Outer warm body — orange.
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = Math.max(1.5, r * 0.10);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // Hot inner core — yellow.
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fef3c7";
    ctx.lineWidth = Math.max(0.6, r * 0.03);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
  }

  // Bright crown highlight at the top of the pawn — adds the "ascending"
  // feel without obscuring the avatar's face.
  const crownPulse = 0.5 + 0.5 * Math.sin(now / 380);
  ctx.globalAlpha = 0.55 * crownPulse;
  const crownGrad = ctx.createRadialGradient(cx, cy - r * 0.9, 0, cx, cy - r * 0.9, r * 0.85);
  crownGrad.addColorStop(0, "rgba(254, 240, 138, 0.8)");
  crownGrad.addColorStop(0.5, "rgba(251, 146, 60, 0.45)");
  crownGrad.addColorStop(1, "rgba(180, 83, 9, 0)");
  ctx.fillStyle = crownGrad;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.9, r * 0.85, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// "Firewalled" (key: `barkskin`) — translucent green hex-tile barrier
// orbiting the pawn, with individual tiles flickering in/out at random
// intervals to suggest packets being inspected and dropped. Replaces the
// older bark + leaves visual now that the canonical name is engineering
// vocabulary (druid Firewall ability — "Configure inbound rules: deny
// all"). Uses the EFFECT_META.barkskin.color (#a3e635 lime green).
function drawFirewalled(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  ctx.save();

  // Soft glow halo behind the mesh — gives the barrier presence even
  // between hex flickers and conveys "active shield."
  const haloPulse = 0.6 + 0.25 * Math.sin(now / 480);
  const haloGrad = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 1.5);
  haloGrad.addColorStop(0, "rgba(163, 230, 53, 0)");
  haloGrad.addColorStop(0.55, `rgba(132, 204, 22, ${0.30 * haloPulse})`);
  haloGrad.addColorStop(1, "rgba(132, 204, 22, 0)");
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
  ctx.fill();

  // Hex barrier tiles arranged around the pawn — 12 tiles on a ring,
  // each flickering at its own phase so it looks like packets are
  // continuously hitting and being denied.
  const TILES = 12;
  const ringR = r * 1.25;
  const tileR = r * 0.22;
  const ringRotation = now / 4800; // very slow CW rotation
  for (let i = 0; i < TILES; i++) {
    const ang = ringRotation + (i / TILES) * Math.PI * 2;
    const tx = cx + Math.cos(ang) * ringR;
    const ty = cy + Math.sin(ang) * ringR;
    // Per-tile flicker phase keyed by seed + index so neighbouring
    // pawns flicker independently.
    const flickerCycle = 800 + rng01(seed, i + 800) * 600;
    const flickerPhase = ((now + rng01(seed, i + 820) * flickerCycle) % flickerCycle) / flickerCycle;
    // Tile alpha pulses bright at the start of its cycle then dims —
    // simulates a quick "drop packet" flash.
    const flicker = flickerPhase < 0.15
      ? 1
      : flickerPhase < 0.5
        ? 0.35 + 0.4 * (1 - (flickerPhase - 0.15) / 0.35)
        : 0.35;
    drawFirewallHexTile(ctx, tx, ty, tileR, flicker);
  }

  // Scanline sweep — a thin bright bar slowly rotating around the pawn,
  // like a radar arm or active inspection beam.
  const scanAng = (now / 1800) * Math.PI * 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(scanAng);
  const scanGrad = ctx.createLinearGradient(0, -r * 1.35, 0, r * 1.35);
  scanGrad.addColorStop(0, "rgba(217, 249, 157, 0)");
  scanGrad.addColorStop(0.48, "rgba(217, 249, 157, 0)");
  scanGrad.addColorStop(0.5, "rgba(217, 249, 157, 0.65)");
  scanGrad.addColorStop(0.52, "rgba(217, 249, 157, 0)");
  scanGrad.addColorStop(1, "rgba(217, 249, 157, 0)");
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = scanGrad;
  ctx.fillRect(-r * 1.35, -r * 1.35, r * 2.7, r * 2.7);
  ctx.restore();

  ctx.restore();
}

// Single firewall-barrier hex panel: translucent body + bright outline,
// alpha modulated by the caller's flicker value.
function drawFirewallHexTile(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number, flicker: number,
) {
  ctx.save();
  // Flat-top hex path.
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i;
    const x = cx + Math.cos(ang) * size;
    const y = cy + Math.sin(ang) * size;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  // Translucent panel body.
  ctx.globalAlpha = 0.30 * flicker;
  ctx.fillStyle = "#84cc16";
  ctx.fill();
  // Bright outline so the panel reads as a discrete cell.
  ctx.globalAlpha = 0.85 * flicker;
  ctx.strokeStyle = "#a3e635";
  ctx.lineWidth = Math.max(0.6, size * 0.16);
  ctx.stroke();
  // Inner highlight stroke for a touch of dimension.
  ctx.globalAlpha = 0.65 * flicker;
  ctx.strokeStyle = "#ecfccb";
  ctx.lineWidth = Math.max(0.3, size * 0.06);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i;
    const x = cx + Math.cos(ang) * size * 0.72;
    const y = cy + Math.sin(ang) * size * 0.72;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// Bark patches anchored to the pawn rim + a slow drift of small leaves
// around the actor — kept here for reference. Replaced by drawFirewalled
// once the canonical effect name became "Firewalled."
function drawBarkskinLeaves(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  // Static bark plates fixed to the pawn rim — small wedge shapes that
  // suggest armor segments grown over the figure. Position seeded by the
  // pawn so plates don't move and can't be confused for damage particles.
  const PLATES = 6;
  ctx.save();
  for (let i = 0; i < PLATES; i++) {
    // Distribute around the upper hemisphere so the plates read as a
    // shoulder/back coating rather than a full enclosure.
    const ang = Math.PI * (1.05 + (i / PLATES) * 0.9 + rng01(seed, i + 500) * 0.12);
    const plateR = r * 0.97;
    const px = cx + Math.cos(ang) * plateR;
    const py = cy + Math.sin(ang) * plateR;
    const tx = -Math.sin(ang);
    const ty = Math.cos(ang);
    const w = r * (0.20 + 0.04 * rng01(seed, i + 520));
    const h = r * (0.12 + 0.03 * rng01(seed, i + 540));
    // Draw a small flattened rounded rectangle aligned tangentially.
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(ty, tx));
    // Dark bark base.
    ctx.fillStyle = "#4d2d10";
    roundRect(ctx, -w / 2, -h / 2, w, h, h * 0.45);
    ctx.fill();
    // Brighter wood-grain stripe along the top.
    ctx.fillStyle = "#854d0e";
    roundRect(ctx, -w / 2 + 0.5, -h / 2 + 0.6, w - 1, h * 0.45, h * 0.25);
    ctx.fill();
    // Tiny moss highlight so each plate has a hint of green growth.
    ctx.fillStyle = "rgba(163, 230, 53, 0.55)";
    ctx.fillRect(-w * 0.3, -h * 0.45, w * 0.18, 0.6);
    ctx.restore();
  }

  // Slow-drifting leaves around the pawn. Each leaf orbits gently with a
  // sin-bob and rotates on its own axis. Reads as living wood.
  const LEAVES = 5;
  const CYCLE = 4800;
  for (let i = 0; i < LEAVES; i++) {
    const phase = ((now + i * (CYCLE / LEAVES) + rng01(seed, i + 600) * CYCLE) % CYCLE) / CYCLE;
    // Each leaf circles the pawn at a slow ang speed (fraction of a full
    // orbit per cycle) so multiple leaves orbit at different angles.
    const orbitR = r * (1.05 + 0.18 * Math.sin(now / 800 + i * 1.4));
    const orbitAng = phase * Math.PI * 2 + i * 1.2;
    const x = cx + Math.cos(orbitAng) * orbitR;
    const y = cy + Math.sin(orbitAng) * orbitR;
    const rot = now / 700 + i * 1.3;
    const size = r * 0.18;
    // Fade in and out across cycle so leaves don't pop in/out at the boundary.
    const alpha = 0.85 * (
      phase < 0.15 ? phase / 0.15
      : phase > 0.85 ? (1 - phase) / 0.15
      : 1
    );
    ctx.globalAlpha = alpha;
    drawLeaf(ctx, x, y, size, rot);
  }
  ctx.restore();
}

function drawLeaf(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number, rot: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Almond-shape body: two arcs meeting at the tip and stem.
  ctx.beginPath();
  ctx.moveTo(-size, 0);
  ctx.quadraticCurveTo(0, -size * 0.65, size, 0);
  ctx.quadraticCurveTo(0,  size * 0.65, -size, 0);
  ctx.closePath();
  ctx.fillStyle = "#65a30d"; // healthy lime green
  ctx.fill();
  // Mid-vein.
  ctx.strokeStyle = "rgba(20, 83, 45, 0.7)";
  ctx.lineWidth = Math.max(0.6, size * 0.1);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-size * 0.92, 0);
  ctx.lineTo(size * 0.92, 0);
  ctx.stroke();
  ctx.restore();
}

// Cursed purple wisps swirling around the pawn — slow counter-clockwise
// drift with arcing trails so the hex reads as a death-skull curse
// rather than just a colored halo. Inner pulse adds the breath of an
// active malediction.
function drawHexedWisps(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  // Dim sickly purple halo behind the wisps — pulses slowly so the curse
  // feels alive without flickering.
  const halo = 0.55 + 0.2 * Math.sin(now / 760);
  const haloGrad = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.5);
  haloGrad.addColorStop(0, "rgba(168, 85, 247, 0)");
  haloGrad.addColorStop(0.45, `rgba(126, 34, 206, ${0.45 * halo})`);
  haloGrad.addColorStop(1, "rgba(126, 34, 206, 0)");
  ctx.save();
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const WISPS = 5;
  const ORBIT_MS = 4200; // counter-clockwise (slower than empowered)
  const t = -now / ORBIT_MS; // negative = counter-clockwise
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < WISPS; i++) {
    const angBase = t * Math.PI * 2 + (i / WISPS) * Math.PI * 2 + rng01(seed, i) * 0.5;
    // Each wisp is a short trailing arc — sample 10 points along the
    // orbit, plot a curve through them with decreasing alpha so it reads
    // as a smoky trail.
    const ARC_SAMPLES = 10;
    const ARC_LEN = 0.55; // fraction of orbit covered by one wisp
    const orbitRBase = r * (1.08 + 0.06 * Math.sin(now / 600 + i));
    // Smoke breathes slightly in/out radially over time so the wisps
    // feel airier than a fixed-radius spinner.
    for (let s = 0; s < ARC_SAMPLES; s++) {
      const sFrac = s / (ARC_SAMPLES - 1);
      const ang = angBase + sFrac * ARC_LEN;
      // Radius wobble per sample so the wisp curves rather than tracing
      // a perfect circle.
      const orbitR = orbitRBase + Math.sin(now / 400 + i * 1.7 + sFrac * 5) * r * 0.04;
      const x0 = cx + Math.cos(ang) * orbitR;
      const y0 = cy + Math.sin(ang) * orbitR;
      const sizeFrac = 1 - sFrac; // bright head, fading tail
      const size = r * 0.13 * (0.5 + sizeFrac * 0.6);
      const alpha = 0.75 * sizeFrac * sizeFrac;
      ctx.globalAlpha = alpha;
      // Inner-to-outer wisp body: bright violet core + dim purple haze.
      ctx.fillStyle = "#c084fc";
      ctx.beginPath();
      ctx.arc(x0, y0, size, 0, Math.PI * 2);
      ctx.fill();
      // Dark mauve halo around each puff for that classic curse-smoke
      // feel — soft, fuzzy, slightly threatening.
      ctx.globalAlpha = alpha * 0.45;
      ctx.fillStyle = "#581c87";
      ctx.beginPath();
      ctx.arc(x0, y0, size * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// "Deadlocked" (key: `entangled`) — interlocking chain ring orbiting
// the pawn. Reads as the actor being locked into a circular dependency
// (the canonical EFFECT_META blurb is "Held by an upstream dependency.
// -4 to attack rolls."). Alternating link orientation gives the chain
// 3D presence; slow rotation conveys "still stuck after all this time."
function drawDeadlockedChain(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, _seed: number,
) {
  ctx.save();
  // More links, smaller per-link size — reads as a finer, longer chain
  // wrapping the pawn rather than a few chunky shackles. Even count so
  // the alternating tangential/radial orientation closes cleanly.
  const LINKS = 18;
  const ringR = r * 1.18;
  // arcSpan = chord-length between adjacent link centers along the ring.
  // Link length 1.35× arcSpan keeps tangential links visibly interlocking
  // with their neighbours even at the higher count.
  const arcSpan = (Math.PI * 2 * ringR) / LINKS;
  const linkLen = arcSpan * 1.35;
  const linkW = r * 0.18;
  const rotation = now / 5200; // very slow CW drift
  // Per-link pulse — synchronized so the entire chain breathes in/out
  // together (signaling the lock holds tight).
  const breathing = 0.95 + 0.05 * Math.sin(now / 700);

  for (let i = 0; i < LINKS; i++) {
    const ang = rotation + (i / LINKS) * Math.PI * 2;
    const lx = cx + Math.cos(ang) * ringR * breathing;
    const ly = cy + Math.sin(ang) * ringR * breathing;
    // Alternate "tangential" vs "radial" link orientation so every
    // other link is turned 90° (real chain look). The radial links
    // hook through the tangential ones visually because their length
    // crosses the chain centerline.
    const tangent = ang + Math.PI / 2;
    const localRot = tangent + (i % 2 === 0 ? 0 : Math.PI / 2);
    drawChainLink(ctx, lx, ly, linkLen, linkW, localRot);
  }

  // Subtle dim green halo behind the chain — gives the lock-down state
  // some body and a tint of the canonical entangled color.
  const halo = 0.55 + 0.2 * Math.sin(now / 900);
  const grad = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * 1.45);
  grad.addColorStop(0, "rgba(134, 239, 172, 0)");
  grad.addColorStop(0.55, `rgba(101, 163, 13, ${0.22 * halo})`);
  grad.addColorStop(1, "rgba(101, 163, 13, 0)");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = grad;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Single chain link rendered as a thick stadium (rounded rectangle)
// stroke, centered at (cx, cy) and rotated by `rot` radians. Uses a
// dark outer stroke with a lighter inner highlight for that classic
// metallic chain look.
function drawChainLink(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, length: number, width: number, rot: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  // Outer dark body of the link.
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = width * 0.65;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-length / 2, 0);
  ctx.lineTo( length / 2, 0);
  ctx.stroke();
  // Mid-tone metallic body.
  ctx.strokeStyle = "#4b5563";
  ctx.lineWidth = width * 0.45;
  ctx.beginPath();
  ctx.moveTo(-length / 2 + 1, 0);
  ctx.lineTo( length / 2 - 1, 0);
  ctx.stroke();
  // Bright highlight stripe along the upper edge — sells the 3D feel.
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = width * 0.12;
  ctx.beginPath();
  ctx.moveTo(-length / 2 + 1, -width * 0.08);
  ctx.lineTo( length / 2 - 1, -width * 0.08);
  ctx.stroke();
  ctx.restore();
}

// Jagged dark roots wrap inward from the hex edge with thorns sticking
// out along their length. Reads as the actor being snared / held in
// place. Roots have a slow constricting wiggle so the binding feels
// alive, not static. Kept here for reference; replaced by
// drawDeadlockedChain once the canonical effect name became "Deadlocked."
function drawEntangledRoots(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const ROOT_COUNT = 5;
  // Reach outward to roughly the hex edge (hex tile is drawn at
  // ~hexSize * 0.94 from center, and the pawn radius is ~hexSize * 0.55).
  // baseRadius here IS the pawn radius, so root tip lives ~1.55× r out.
  const tipR = r * 1.5;
  const baseR = r * 0.9;
  // Constricting wiggle — very slow, looks like the roots are slowly
  // pulling tight around the actor.
  const breathing = 1 - 0.04 * Math.sin(now / 1600);
  ctx.save();
  for (let i = 0; i < ROOT_COUNT; i++) {
    // Even angular spread around the pawn with deterministic jitter so
    // adjacent entangled pawns aren't identical.
    const angBase = (i / ROOT_COUNT) * Math.PI * 2;
    const angJitter = (rng01(seed, i + 400) - 0.5) * 0.5;
    const ang = angBase + angJitter;
    // Tip position (out near hex edge) and base (just outside pawn rim).
    const tipX = cx + Math.cos(ang) * tipR * breathing;
    const tipY = cy + Math.sin(ang) * tipR * breathing;
    const baseX = cx + Math.cos(ang) * baseR;
    const baseY = cy + Math.sin(ang) * baseR;
    // Each root curves — use a quadratic bezier with the control point
    // offset perpendicular to the root direction, jittered per-root so
    // each branch hooks a different way.
    const perpX = -Math.sin(ang);
    const perpY = Math.cos(ang);
    const curveSide = rng01(seed, i + 410) > 0.5 ? 1 : -1;
    const curveMag = (0.18 + rng01(seed, i + 420) * 0.18) * tipR;
    const wobble = Math.sin(now / 900 + i * 1.2) * 0.05 * tipR;
    const midX = (tipX + baseX) / 2 + perpX * (curveSide * curveMag + wobble);
    const midY = (tipY + baseY) / 2 + perpY * (curveSide * curveMag + wobble);
    // Root body — dark mossy brown stroke with a slight gradient feel
    // (two passes: dark outer, brighter inner for dimension).
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#451a03";
    ctx.lineWidth = Math.max(2, r * 0.16);
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.quadraticCurveTo(midX, midY, baseX, baseY);
    ctx.stroke();
    ctx.strokeStyle = "#65a30d";
    ctx.lineWidth = Math.max(0.8, r * 0.06);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.quadraticCurveTo(midX, midY, baseX, baseY);
    ctx.stroke();
    // Thorns — 3 along each root pointing outward perpendicular to the
    // root tangent. Length jitters per thorn.
    for (let t = 1; t <= 3; t++) {
      // Position along the bezier at parameter `s` (0 = tip, 1 = base).
      const s = t / 4;
      // Quadratic bezier formula and tangent.
      const px = (1 - s) * (1 - s) * tipX + 2 * (1 - s) * s * midX + s * s * baseX;
      const py = (1 - s) * (1 - s) * tipY + 2 * (1 - s) * s * midY + s * s * baseY;
      const tx = 2 * (1 - s) * (midX - tipX) + 2 * s * (baseX - midX);
      const ty = 2 * (1 - s) * (midY - tipY) + 2 * s * (baseY - midY);
      const tLen = Math.hypot(tx, ty) || 1;
      // Thorn perpendicular — alternate side per thorn.
      const sideThorn = (t % 2 === 0) ? 1 : -1;
      const nx = -ty / tLen * sideThorn;
      const ny =  tx / tLen * sideThorn;
      const thornLen = r * (0.22 + 0.06 * rng01(seed, i * 7 + t));
      const tipThornX = px + nx * thornLen;
      const tipThornY = py + ny * thornLen;
      // Triangle thorn — base perpendicular to root, point sticks outward.
      const baseHalf = r * 0.06;
      const baseAx = px - (tx / tLen) * baseHalf;
      const baseAy = py - (ty / tLen) * baseHalf;
      const baseBx = px + (tx / tLen) * baseHalf;
      const baseBy = py + (ty / tLen) * baseHalf;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#1c1917";
      ctx.beginPath();
      ctx.moveTo(baseAx, baseAy);
      ctx.lineTo(tipThornX, tipThornY);
      ctx.lineTo(baseBx, baseBy);
      ctx.closePath();
      ctx.fill();
      // Slight green highlight on the trailing edge so the thorn reads
      // as wood/plant rather than pure ink.
      ctx.strokeStyle = "#3f6212";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Anime "power up" speed lines — short violet/white spokes radiating
// outward from the pawn rim, jittering in length on every frame so the
// burst feels like crackling energy. Lines are biased upward (more
// density above the head than below) so the silhouette reads as
// rising-power rather than evenly-haloed.
function drawEmpoweredAura(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const COUNT = 14;
  // Fast tick — lines snap to slightly different lengths every frame so
  // the whole burst vibrates like motion-line effects in shonen anime.
  const tick = Math.floor(now / 65);
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < COUNT; i++) {
    // Spread evenly around the pawn with a small per-line angle jitter.
    const baseAng = (i / COUNT) * Math.PI * 2;
    const jitter = (rng01(seed ^ tick, i) - 0.5) * 0.25;
    const ang = baseAng + jitter;
    // Upper-hemisphere density bias: shorten/dim lines pointing downward
    // so the visual weight rides above the pawn.
    const vertical = Math.sin(ang); // -1 (up) to 1 (down) — canvas y inverted
    const upBias = 1 - Math.max(0, vertical) * 0.6;
    // Line length jitters between 50% and 100% of max — that's the "vibrate".
    const lengthFrac = 0.5 + rng01(seed ^ tick, i + 50) * 0.5;
    const innerR = r * 1.05;
    const outerR = r * (1.05 + 0.55 * lengthFrac * upBias);
    const x0 = cx + Math.cos(ang) * innerR;
    const y0 = cy + Math.sin(ang) * innerR;
    const x1 = cx + Math.cos(ang) * outerR;
    const y1 = cy + Math.sin(ang) * outerR;
    // Two-tone stroke: bright violet body with a hotter inner core for
    // the front-most spokes.
    ctx.globalAlpha = 0.85 * upBias;
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // White-violet core inside the line.
    ctx.globalAlpha = 0.85 * upBias;
    ctx.strokeStyle = "#ede9fe";
    ctx.lineWidth = Math.max(0.4, r * 0.025);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // Subtle pulsing violet halo over the upper rim — the "aura" backdrop
  // behind the speed lines so they don't look like floating sticks.
  ctx.globalAlpha = 0.55;
  const pulse = 0.5 + 0.5 * Math.sin(now / 280);
  const grad = ctx.createRadialGradient(cx, cy - r * 0.4, r * 0.8, cx, cy - r * 0.4, r * 1.6);
  grad.addColorStop(0, "rgba(167, 139, 250, 0)");
  grad.addColorStop(0.55, `rgba(167, 139, 250, ${0.35 * pulse})`);
  grad.addColorStop(1, "rgba(167, 139, 250, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.4, r * 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Light-green medical "+" signs floating gently up + sideways-bobbing.
// Same rising-particle structure as burning embers, but the symbol is a
// healing cross and the motion is much slower and softer.
function drawRegenPluses(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const COUNT = 5;
  const CYCLE = 2600; // ms — full rise + fade
  ctx.save();
  for (let i = 0; i < COUNT; i++) {
    const phase = ((now + i * (CYCLE / COUNT) + rng01(seed, i + 200) * CYCLE) % CYCLE) / CYCLE;
    // Horizontal start position around the pawn, with a gentle sideways
    // bob as it rises so each plus drifts left-right while floating.
    const baseX = (rng01(seed, i + 220) - 0.5) * r * 1.6;
    const bob = Math.sin(now / 700 + i * 1.4 + rng01(seed, i + 240) * 6) * r * 0.15;
    const x = cx + baseX + bob;
    // Rise: starts near the pawn's mid-bottom, drifts up and slightly past
    // the top, slower than burning embers (lower rise distance).
    const y = cy + r * 0.4 - phase * r * 1.9;
    // Size pulses softly, peaks mid-life.
    const size = r * (0.16 + 0.04 * Math.sin(now / 540 + i));
    // Soft fade: ramp up over first 20%, hold, ramp down last 30%.
    const alpha = phase < 0.2
      ? (phase / 0.2) * 0.8
      : phase > 0.7
        ? ((1 - phase) / 0.3) * 0.8
        : 0.8;
    ctx.globalAlpha = alpha;
    // Light, pastel green so it reads as healing/restoration.
    drawPlus(ctx, x, y, size, "#86efac");
  }
  ctx.restore();
}

function drawPlus(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number, color: string,
) {
  // Thick "+" with rounded ends — slightly chunkier so it reads as a
  // medical symbol rather than a math operator.
  const arm = size;
  const thickness = Math.max(1.5, size * 0.42);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(20, 83, 45, 0.55)";
  ctx.lineWidth = Math.max(0.5, size * 0.12);
  ctx.lineJoin = "round";
  // Vertical bar.
  roundRect(ctx, x - thickness / 2, y - arm, thickness, arm * 2, thickness * 0.3);
  ctx.fill();
  ctx.stroke();
  // Horizontal bar.
  roundRect(ctx, x - arm, y - thickness / 2, arm * 2, thickness, thickness * 0.3);
  ctx.fill();
  ctx.stroke();
  // Center highlight so the plus has a touch of dimension.
  ctx.fillStyle = "rgba(220, 252, 231, 0.55)";
  ctx.beginPath();
  ctx.arc(x, y, thickness * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ── Rise effects (one-shot popups) ────────────────────────────────────────
// Each rise renders for ~1.4 s on top of the pawn: the symbol icon floats
// straight up while a cloud of small sparkles in the matching color fan
// out around it. Alpha follows a sin(πt) envelope so the rise fades in
// and out smoothly. Kind palettes live in RISE_PALETTE.

const RISE_PALETTE: Record<RiseKind, { color: string; spark: string }> = {
  taunt:           { color: "#ef4444", spark: "#fecaca" }, // angry red
  marked:          { color: "#fb923c", spark: "#fed7aa" }, // hunt orange
  vulnerable:      { color: "#f59e0b", spark: "#fde68a" }, // amber crack
  foreseen:        { color: "#38bdf8", spark: "#bae6fd" }, // forecast cyan
  test_coverage:   { color: "#34d399", spark: "#bbf7d0" }, // covered green
  delivery_bonus:  { color: "#fbbf24", spark: "#fef3c7" }, // gold coin
  ill_omen:        { color: "#a855f7", spark: "#e9d5ff" }, // dark hex purple
};

function drawRiseEffect(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, kind: RiseKind, t: number,
) {
  const pal = RISE_PALETTE[kind];
  // Icon rises straight up from just above the pawn over its lifetime.
  const yLift = r * 1.8 * t;
  const iconY = cy - r * 0.9 - yLift;
  const iconX = cx;
  // Envelope: ease-in fade up to ~25%, hold, fade out from ~70%.
  const alpha = t < 0.25 ? t / 0.25 : t > 0.7 ? (1 - t) / 0.3 : 1;
  const size = r * (0.55 + 0.10 * Math.sin(t * Math.PI));

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  // Halo behind the icon — soft radial in the kind color so the symbol
  // doesn't get lost against busy backgrounds.
  const halo = ctx.createRadialGradient(iconX, iconY, 0, iconX, iconY, size * 1.6);
  halo.addColorStop(0, hexToRgba(pal.color, 0.55));
  halo.addColorStop(0.6, hexToRgba(pal.color, 0.20));
  halo.addColorStop(1, hexToRgba(pal.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(iconX, iconY, size * 1.6, 0, Math.PI * 2);
  ctx.fill();

  // Kind-specific glyph.
  ctx.fillStyle = pal.color;
  ctx.strokeStyle = pal.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (kind) {
    case "taunt":          drawRiseExclamation(ctx, iconX, iconY, size, pal); break;
    case "marked":         drawRiseCrosshair(ctx, iconX, iconY, size, pal); break;
    case "vulnerable":     drawRiseCrackedShield(ctx, iconX, iconY, size, pal); break;
    case "foreseen":       drawRiseEye(ctx, iconX, iconY, size, pal); break;
    case "test_coverage":  drawRiseCheck(ctx, iconX, iconY, size, pal); break;
    case "delivery_bonus": drawRiseCoin(ctx, iconX, iconY, size, pal); break;
    case "ill_omen":       drawRiseHexRune(ctx, iconX, iconY, size, pal); break;
  }

  // Sparkle cloud — small dots fanning out from the icon position, each
  // travelling outward as the rise progresses. Spread is deterministic
  // per-rise so the cluster looks chosen, not randomized every frame.
  const SPARKS = 8;
  for (let i = 0; i < SPARKS; i++) {
    const ang = (i / SPARKS) * Math.PI * 2 + t * 0.6;
    const dist = r * (0.35 + t * 1.1);
    const sx = iconX + Math.cos(ang) * dist;
    const sy = iconY + Math.sin(ang) * dist - r * 0.2 * t; // also drift up
    const sparkR = r * 0.07 * (1 - t * 0.5);
    ctx.globalAlpha = Math.max(0, alpha) * (0.7 - t * 0.5);
    ctx.fillStyle = pal.spark;
    ctx.beginPath();
    ctx.arc(sx, sy, sparkR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Tiny helper: convert an #rrggbb hex string to an rgba() form with alpha.
// Used by the rise halo gradients.
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Rise glyphs ───────────────────────────────────────────────────────────

function drawRiseExclamation(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Bold "!" — vertical bar tapered downward + a round dot below.
  ctx.fillStyle = pal.color;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.10, y - s * 0.42);
  ctx.lineTo(x + s * 0.10, y - s * 0.42);
  ctx.lineTo(x + s * 0.06, y + s * 0.10);
  ctx.lineTo(x - s * 0.06, y + s * 0.10);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + s * 0.30, s * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

function drawRiseCrosshair(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  ctx.strokeStyle = pal.color;
  ctx.lineWidth = s * 0.10;
  ctx.beginPath();
  ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  // Four ticks at cardinal points.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + dx * s * 0.45, y + dy * s * 0.45);
    ctx.lineTo(x + dx * s * 0.65, y + dy * s * 0.65);
    ctx.stroke();
  }
  // Center dot.
  ctx.fillStyle = pal.color;
  ctx.beginPath();
  ctx.arc(x, y, s * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawRiseCrackedShield(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Simple heater shield silhouette with a zigzag crack down the middle.
  ctx.fillStyle = pal.color;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.42, y - s * 0.4);
  ctx.lineTo(x + s * 0.42, y - s * 0.4);
  ctx.lineTo(x + s * 0.42, y);
  ctx.quadraticCurveTo(x + s * 0.42, y + s * 0.5, x, y + s * 0.55);
  ctx.quadraticCurveTo(x - s * 0.42, y + s * 0.5, x - s * 0.42, y);
  ctx.closePath();
  ctx.fill();
  // Dark zigzag crack overlay.
  ctx.strokeStyle = "#1c1917";
  ctx.lineWidth = s * 0.08;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.06, y - s * 0.32);
  ctx.lineTo(x + s * 0.08, y - s * 0.10);
  ctx.lineTo(x - s * 0.08, y + s * 0.12);
  ctx.lineTo(x + s * 0.06, y + s * 0.42);
  ctx.stroke();
}

function drawRiseEye(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Almond eye shape + pupil — reads as "seen" / "foreseen."
  ctx.fillStyle = pal.spark;
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.5, s * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  // Iris.
  ctx.fillStyle = pal.color;
  ctx.beginPath();
  ctx.arc(x, y, s * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // Pupil + sparkle.
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(x, y, s * 0.10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x - s * 0.07, y - s * 0.07, s * 0.05, 0, Math.PI * 2);
  ctx.fill();
}

function drawRiseCheck(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Bold checkmark — for Test Coverage / shield_of_faith.
  ctx.strokeStyle = pal.color;
  ctx.lineWidth = s * 0.18;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.35, y + s * 0.05);
  ctx.lineTo(x - s * 0.10, y + s * 0.35);
  ctx.lineTo(x + s * 0.40, y - s * 0.30);
  ctx.stroke();
}

function drawRiseCoin(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Gold coin disk with $ embossed.
  ctx.fillStyle = pal.color;
  ctx.beginPath();
  ctx.arc(x, y, s * 0.50, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#92400e";
  ctx.lineWidth = s * 0.05;
  ctx.stroke();
  ctx.fillStyle = "#78350f";
  ctx.font = `bold ${Math.max(6, s * 0.55)}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", x, y);
}

function drawRiseHexRune(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number,
  pal: { color: string; spark: string },
) {
  // Hexagonal rune outline + an angular sigil inside — used for hex /
  // ill_omen events that warn of an incoming curse burst.
  ctx.strokeStyle = pal.color;
  ctx.lineWidth = s * 0.10;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i - Math.PI / 2;
    const px = x + Math.cos(ang) * s * 0.48;
    const py = y + Math.sin(ang) * s * 0.48;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  // Three small intersecting strokes inside — abstract "rune."
  ctx.beginPath();
  ctx.moveTo(x - s * 0.18, y - s * 0.10);
  ctx.lineTo(x + s * 0.18, y + s * 0.10);
  ctx.moveTo(x + s * 0.18, y - s * 0.10);
  ctx.lineTo(x - s * 0.18, y + s * 0.10);
  ctx.moveTo(x, y - s * 0.22);
  ctx.lineTo(x, y + s * 0.22);
  ctx.lineWidth = s * 0.06;
  ctx.stroke();
}

// "Containerized" — translucent shipping-container box clamped over the
// pawn. Reads as the actor being wrapped/boxed up (matches the mage
// Containerize ability + the EFFECT_META.stunned emoji 📦). Subtle
// shake jitter so it looks like the container is being banged on from
// the inside but won't open.
function drawContainerized(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, _seed: number,
) {
  // Small repeating bang animation — every ~600ms the container jolts
  // briefly as if the actor inside is trying to break out.
  const bangCycle = 600;
  const bangPhase = (now % bangCycle) / bangCycle;
  const bang = bangPhase < 0.12 ? Math.sin(bangPhase / 0.12 * Math.PI) : 0;
  const jx = bang * 1.2;
  const jy = bang * 0.4;

  ctx.save();
  ctx.translate(cx + jx, cy + jy);

  // Container dimensions — box hugs the pawn, slightly oversized so the
  // avatar reads through but the silhouette is clearly enclosed.
  const w = r * 1.55;
  const h = r * 1.75;
  const depth = r * 0.32; // isometric back-offset

  const FACE = "rgba(124, 58, 237, 0.20)"; // translucent purple fill
  const EDGE = "#a78bfa";
  const HIGHLIGHT = "#ddd6fe";

  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  ctx.lineWidth = Math.max(1.2, r * 0.07);

  // Top face — parallelogram giving an isometric peek of the lid.
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo( w / 2, -h / 2);
  ctx.lineTo( w / 2 + depth, -h / 2 - depth);
  ctx.lineTo(-w / 2 + depth, -h / 2 - depth);
  ctx.closePath();
  ctx.fillStyle = "rgba(167, 139, 250, 0.25)";
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.stroke();

  // Right side face — visible because of the iso skew.
  ctx.beginPath();
  ctx.moveTo( w / 2, -h / 2);
  ctx.lineTo( w / 2 + depth, -h / 2 - depth);
  ctx.lineTo( w / 2 + depth,  h / 2 - depth);
  ctx.lineTo( w / 2,  h / 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(91, 33, 182, 0.30)";
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.stroke();

  // Front face — translucent so the avatar shows through, but with the
  // box's defining vertical ridges painted on so it reads as a container.
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = FACE;
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.stroke();

  // Vertical ridges (corrugated container panels) — three thin lines
  // dividing the front face into segments. Skip the center so the
  // avatar's face stays unobscured.
  ctx.strokeStyle = "rgba(167, 139, 250, 0.65)";
  ctx.lineWidth = Math.max(0.6, r * 0.03);
  for (const fx of [-0.32, 0.32]) {
    ctx.beginPath();
    ctx.moveTo(fx * w, -h / 2);
    ctx.lineTo(fx * w,  h / 2);
    ctx.stroke();
  }

  // Top edge highlight — bright violet line catching light.
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = Math.max(0.8, r * 0.04);
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 1, -h / 2 + 1);
  ctx.lineTo( w / 2 - 1, -h / 2 + 1);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Latches: small rectangles on the upper corners where the container
  // lid would clamp shut.
  ctx.fillStyle = "#c4b5fd";
  for (const lx of [-0.42, 0.42]) {
    ctx.fillRect(lx * w - r * 0.06, -h / 2 - 1, r * 0.12, r * 0.10);
  }

  // "CNTR" stencil marking — small monospaced label stamped on the
  // upper-left of the front face so it reads unambiguously as a
  // shipping container.
  ctx.fillStyle = "rgba(196, 181, 253, 0.85)";
  ctx.font = `bold ${Math.max(6, r * 0.18)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("CNTR", -w / 2 + r * 0.12, -h / 2 + r * 0.12);

  ctx.restore();
}

// Classic cartoon "seeing stars" — small gold 5-pointed stars on a slow
// elliptical orbit above the pawn's head. Each star spins on its own
// axis at a different rate so the cluster doesn't move in lockstep.
// Kept here in case "stunned" ever needs to revert to the classic
// visualization; currently drawContainerized is wired in instead.
function drawStunnedStars(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, now: number, seed: number,
) {
  const STARS = 3;
  const ORBIT_MS = 1800; // one full orbit
  const orbitRX = r * 0.85;
  const orbitRY = r * 0.32; // squashed ellipse — perspective from above
  const orbitCY = cy - r * 0.95; // center of orbit above the head
  const baseAng = (now / ORBIT_MS) * Math.PI * 2;
  ctx.save();
  for (let i = 0; i < STARS; i++) {
    const ang = baseAng + (i / STARS) * Math.PI * 2;
    const x = cx + Math.cos(ang) * orbitRX;
    const y = orbitCY + Math.sin(ang) * orbitRY;
    // Far-side stars (sin(ang) > 0 means lower on the squashed orbit → in
    // front of pawn). Apply a perspective scale so the cluster reads as
    // moving in 3D — bigger in front, smaller behind.
    const depth = Math.sin(ang); // -1 (behind) to 1 (front)
    const scale = 0.7 + 0.3 * ((depth + 1) / 2);
    const starR = r * 0.22 * scale;
    const rot = now / 600 + i * 1.7 + rng01(seed, i) * 6;
    ctx.globalAlpha = 0.85 + 0.15 * depth;
    drawStar(ctx, x, y, starR, rot);
  }
  ctx.restore();
}

// Filled 5-pointed star centered at (x,y) with outer radius r, rotated by
// `rot` radians. Gold body with a brighter inner core so it pops without
// needing an outline.
function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number, rot: number,
) {
  const SPIKES = 5;
  const innerR = r * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < SPIKES * 2; i++) {
    const ang = (i / (SPIKES * 2)) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 2 === 0 ? r : innerR;
    const px = Math.cos(ang) * radius;
    const py = Math.sin(ang) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = "#fde047"; // bright gold body
  ctx.fill();
  // Subtle stroke so the star reads against bright backgrounds too.
  ctx.lineWidth = Math.max(0.5, r * 0.1);
  ctx.strokeStyle = "rgba(120, 53, 15, 0.6)";
  ctx.stroke();
  // Bright inner highlight for a touch of dimension.
  ctx.beginPath();
  ctx.arc(0, 0, innerR * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = "#fef9c3";
  ctx.fill();
  ctx.restore();
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
  // Slower cycle — drips were skittering too fast, looked twitchy. Slowing
  // them lets each fall read as one continuous drop rather than a shower.
  const CYCLE = 2000;
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

  // Attack range used to draw a rotating dashed circle around the active
  // fighter. The green attackArea tile tint (see drawTiles) communicates
  // the same reach with less visual noise, so the ring is gone.

  for (const f of state.fighters) {
    const a = animatedPos[f.id];
    if (!a) continue;
    const { x, y } = a;
    const downed = f.hp <= 0;
    const radius = hexSize * 0.55;
    if (!downed && previewSet?.has(f.id)) drawPreviewGlow(x, y, radius, isReachable(f as never));
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
    if (!downed) {
      const armorMax = Math.floor((f.armor_power ?? 0) / 2);
      drawPawnVitals(
        ctx,
        x,
        y + hexSize * 0.62,
        hexSize * 1.2,
        f.hp,
        f.max_hp,
        f.shield ?? 0,
        armorMax,
        f.mana ?? 0,
        f.max_mana ?? 0,
      );
    }
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
    if (!downed) {
      // Monster armor mirrors the docked card: armorMax = floor((2*tier)/2) = tier.
      const armorMax = m.tier ?? 0;
      drawPawnVitals(
        ctx,
        x,
        y + radius + 4,
        hexSize * (m.is_boss ? 1.7 : 1.25),
        m.hp,
        m.max_hp,
        m.shield ?? 0,
        armorMax,
        0,
        0,
      );
    }
    if (!downed && m.effects) drawStatusOverlay(ctx, x, y, radius, m.effects as never, now);
    ctx.globalAlpha = 1;
  }
}

// ── Layer 3: projectiles ─────────────────────────────────────────────────────

function drawProjectile(ctx: CanvasRenderingContext2D, proj: ActiveProjectile, x: number, y: number, t: number) {
  const color = PROJECTILE_COLOR[proj.kind];
  // Direction unit-vector — used by every kind to orient heads + tails.
  const dx = proj.toX - proj.fromX;
  const dy = proj.toY - proj.fromY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const angle = Math.atan2(dy, dx);

  switch (proj.kind) {
    case "lightning": {
      // Forked zigzag bolt with a soft glow halo and one branch fork.
      // Instant — the whole thing renders for the brief projectile window.
      const segments = 7;
      const points: Array<[number, number]> = [[proj.fromX, proj.fromY]];
      for (let i = 1; i < segments; i++) {
        const segT = i / segments;
        const sx = proj.fromX + dx * segT + (Math.random() - 0.5) * 14;
        const sy = proj.fromY + dy * segT + (Math.random() - 0.5) * 14;
        points.push([sx, sy]);
      }
      points.push([proj.toX, proj.toY]);
      // Outer halo
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 7;
      ctx.globalAlpha = 0.35 * (1 - t);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
      // Bright core
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
      // Yellow electrified outline on top
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
      // One stubby branch fork off the middle joint
      const mid = points[Math.floor(points.length / 2)];
      const forkAngle = angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 4);
      const forkLen = 14 + Math.random() * 10;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(mid[0], mid[1]);
      ctx.lineTo(mid[0] + Math.cos(forkAngle) * forkLen, mid[1] + Math.sin(forkAngle) * forkLen);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case "fire": {
      // Pulsing fireball with radial gradient core + warm halo. The
      // trailing embers are emitted by the projectile loop separately.
      const pulse = 0.85 + 0.15 * Math.sin(t * 14);
      const r = 7 * pulse;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      // Outer halo
      const halo = ctx.createRadialGradient(x, y, 1, x, y, r * 3.2);
      halo.addColorStop(0, "rgba(255, 200, 60, 0.95)");
      halo.addColorStop(0.4, "rgba(255, 100, 0, 0.45)");
      halo.addColorStop(1, "rgba(255, 0, 0, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      // Hot core
      const core = ctx.createRadialGradient(x, y, 0, x, y, r);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(0.45, "#fde047");
      core.addColorStop(1, "#ff5500");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    case "ice": {
      // Sharp crystalline shard pointing forward. Rotates slightly so it
      // glints. The frost trail is emitted separately by the projectile loop.
      const len2 = 14;
      const wid = 5;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      // Soft cyan halo
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.55;
      const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, 18);
      halo.addColorStop(0, "rgba(186, 230, 253, 0.9)");
      halo.addColorStop(1, "rgba(125, 211, 252, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      // Diamond shard
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#e0f2fe";
      ctx.strokeStyle = "#7dd3fc";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(len2, 0);
      ctx.lineTo(0, wid);
      ctx.lineTo(-len2 * 0.6, 0);
      ctx.lineTo(0, -wid);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Hot-white center stripe
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-len2 * 0.5, 0);
      ctx.lineTo(len2 * 0.85, 0);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case "arrow": {
      // Slim shaft with a triangular head + small fletching at the tail.
      const shaftLen = 18;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      // Shaft
      ctx.strokeStyle = "#92400e";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-shaftLen, 0);
      ctx.lineTo(shaftLen * 0.6, 0);
      ctx.stroke();
      // Head (triangle)
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(shaftLen, 0);
      ctx.lineTo(shaftLen * 0.5, -3);
      ctx.lineTo(shaftLen * 0.5, 3);
      ctx.closePath();
      ctx.fill();
      // Fletching (two angled lines at tail)
      ctx.strokeStyle = "#fef3c7";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-shaftLen, 0);
      ctx.lineTo(-shaftLen + 4, -3);
      ctx.moveTo(-shaftLen, 0);
      ctx.lineTo(-shaftLen + 4, 3);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case "magic": {
      // Three orbiting motes around a soft purple core. Spirals as it flies.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(x, y, 0, x, y, 14);
      halo.addColorStop(0, "rgba(196, 181, 253, 0.95)");
      halo.addColorStop(1, "rgba(167, 139, 250, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      // Core
      ctx.fillStyle = "#ddd6fe";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      // Orbiting motes
      const orbit = 9;
      for (let i = 0; i < 3; i++) {
        const a = t * 18 + (i * Math.PI * 2) / 3;
        ctx.fillStyle = ["#fde047", "#c4b5fd", "#ffffff"][i];
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * orbit, y + Math.sin(a) * orbit, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    case "poison":
    default: {
      // Default: small dripping orb with a trailing tail line. Used for
      // poison + any future generic kind.
      const tailX = x - ux * 18;
      const tailY = y - uy * 18;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
  }
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
