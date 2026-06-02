// Pure hex grid math for tactical combat.
//
// Uses axial coordinates (q, r) with pointy-top hexes. The third cube
// coordinate s = -q - r is used internally for distance and LOS math.
//
// All functions are pure — no side effects, no imports from game logic.

export type HexPos = { q: number; r: number };
export type HexGrid = { cols: number; rows: number };
export type MonsterSpecial =
  | "charge"         // once per fight: double move when out of range
  | "reach"          // melee range extends to 2 hexes
  | "volley"         // ranged AoE within radius 2 of a target
  | "entangle_on_hit" // applies entangled status on melee hit
  | "guardian_aura"  // adjacent fighters can't flee; move range halved
  | "pounce";        // teleport adjacent to farthest fighter when out of range

// Cosmetic obstacle kind. The engine treats all obstacles identically — kind
// only drives the rendered sprite + tooltip text.
export type ObstacleKind = "boulder" | "pillar" | "crate" | "tree" | "rubble";

// Battlefield obstacle: blocks movement AND blocks line of sight.
export interface Obstacle {
  pos: HexPos;
  kind: ObstacleKind;
}

// Loot tile kind. `gold` drops a sack of coins; `item` rolls into a real
// inventory item at pickup time (worker-side, since rollItem lives in
// flavor.ts and uses Math.random()). Tiles do NOT block movement or LOS —
// fighters walk over them and pick them up automatically.
export type LootKind = "gold" | "item";

export interface LootTile {
  id: string;          // deterministic ID (e.g. "loot-seed-idx") for client/server sync
  pos: HexPos;
  kind: LootKind;
  // Tier of the source combat — feeds gold amount and item-roll level.
  tier: number;
}

// Portrait-oriented battlefield: narrower and taller so it fits mobile
// screens without crushing the hex size. Party spawns near the TOP, monsters
// near the BOTTOM, giving roughly 10 hex rows of vertical play space.
export const GRID_DEFAULT: HexGrid = { cols: 9, rows: 11 };

// Six axial directions (pointy-top hex), clockwise from top-right.
const DIRECTIONS: readonly HexPos[] = [
  { q: 1, r: -1 }, // top-right
  { q: 1, r: 0 },  // right
  { q: 0, r: 1 },  // bottom-right
  { q: -1, r: 1 }, // bottom-left
  { q: -1, r: 0 }, // left
  { q: 0, r: -1 }, // top-left
] as const;

// Brick-layout bounds: valid hexes form a vertical rectangle with even rows
// holding `grid.cols` hexes and odd rows holding `grid.cols - 1` hexes
// (shifted right by half a hex). In axial storage, this means the valid
// q range slides left by 1 every 2 rows so the visual leftmost column
// stays aligned.
//
//   row 0: q ∈ [0,             cols-1]    (cols hexes)
//   row 1: q ∈ [0,             cols-2]    (cols-1 hexes, half-offset right)
//   row 2: q ∈ [-1,            cols-2]
//   row 3: q ∈ [-1,            cols-3]
//   row 4: q ∈ [-2,            cols-3]
//   ...
//
// (The leftmost VISUAL column stays at offset col 0; axial coords drift
// because the rendering formula already shifts +sqrt(3)/2 per row.)
export function inBounds(pos: HexPos, grid: HexGrid): boolean {
  if (pos.r < 0 || pos.r >= grid.rows) return false;
  const rowShift = Math.floor(pos.r / 2);
  const rowWidth = pos.r % 2 === 0 ? grid.cols : grid.cols - 1;
  const offsetCol = pos.q + rowShift;
  return offsetCol >= 0 && offsetCol < rowWidth;
}

// Iterates every valid hex in the grid. Used by inBounds-aware helpers like
// generateObstacles.
export function allHexesInGrid(grid: HexGrid): HexPos[] {
  const result: HexPos[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const rowShift = Math.floor(r / 2);
    const rowWidth = r % 2 === 0 ? grid.cols : grid.cols - 1;
    for (let oc = 0; oc < rowWidth; oc++) {
      result.push({ q: oc - rowShift, r });
    }
  }
  return result;
}

export function posKey(pos: HexPos): string {
  return `${pos.q},${pos.r}`;
}

// The six in-bounds neighbors of a hex.
export function hexNeighbors(pos: HexPos, grid: HexGrid): HexPos[] {
  const result: HexPos[] = [];
  for (const d of DIRECTIONS) {
    const n = { q: pos.q + d.q, r: pos.r + d.r };
    if (inBounds(n, grid)) result.push(n);
  }
  return result;
}

// Hex distance using cube coordinate max-abs formula.
export function hexDistance(a: HexPos, b: HexPos): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

// Round floating-point axial coordinates to the nearest integer hex.
function hexRound(fq: number, fr: number): HexPos {
  const fs = -fq - fr;
  let rq = Math.round(fq);
  let rr = Math.round(fr);
  let rs = Math.round(fs);
  const qdiff = Math.abs(rq - fq);
  const rdiff = Math.abs(rr - fr);
  const sdiff = Math.abs(rs - fs);
  if (qdiff > rdiff && qdiff > sdiff) {
    rq = -rr - rs;
  } else if (rdiff > sdiff) {
    rr = -rq - rs;
  }
  return { q: rq, r: rr };
}

// True if there is line-of-sight from `from` to `to`. LOS is blocked by any
// hex in `obstacles`; unit positions do NOT block LOS (MVP design choice).
// Accepts either bare hex positions or full Obstacle objects.
export function hexLos(
  from: HexPos,
  to: HexPos,
  obstacles: (HexPos | Obstacle)[],
): boolean {
  const dist = hexDistance(from, to);
  if (dist <= 1 || obstacles.length === 0) return true;
  const blocked = new Set(obstacles.map((o) => posKey("pos" in o ? o.pos : o)));
  for (let i = 1; i < dist; i++) {
    const t = i / dist;
    const pt = hexRound(
      from.q + (to.q - from.q) * t,
      from.r + (to.r - from.r) * t,
    );
    if (blocked.has(posKey(pt))) return false;
  }
  return true;
}

// Extracts hex positions from an array of obstacles or bare hex positions.
// Use this when feeding obstacles into `hexReachable` / `hexPath` as occupied.
export function obstaclePositions(obstacles: (HexPos | Obstacle)[]): HexPos[] {
  return obstacles.map((o) => ("pos" in o ? o.pos : o));
}

// BFS: all hexes reachable within `range` steps from `from`, excluding
// `occupied` hexes. The starting hex itself is NOT included in the result.
export function hexReachable(
  from: HexPos,
  range: number,
  occupied: HexPos[],
  grid: HexGrid,
): HexPos[] {
  const occupiedSet = new Set(occupied.map(posKey));
  const visited = new Set<string>([posKey(from)]);
  const result: HexPos[] = [];
  let frontier: HexPos[] = [from];
  for (let step = 0; step < range; step++) {
    const next: HexPos[] = [];
    for (const pos of frontier) {
      for (const n of hexNeighbors(pos, grid)) {
        const key = posKey(n);
        if (!visited.has(key) && !occupiedSet.has(key)) {
          visited.add(key);
          next.push(n);
          result.push(n);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return result;
}

// BFS: shortest path from `from` toward `to`, avoiding `occupied` hexes.
// Returns the sequence of hexes to step through (not including `from`,
// INCLUDING `to`). Returns [] if already at `to` or no path exists.
// The destination hex is allowed in the path even if it's in `occupied`
// (so monsters can path toward a fighter's tile and stop adjacent).
export function hexPath(
  from: HexPos,
  to: HexPos,
  occupied: HexPos[],
  grid: HexGrid,
): HexPos[] {
  const fromKey = posKey(from);
  const toKey = posKey(to);
  if (fromKey === toKey) return [];
  const occupiedSet = new Set(occupied.map(posKey));
  occupiedSet.delete(toKey); // allow pathfinding into the target hex
  const visited = new Set<string>([fromKey]);
  const parentKey = new Map<string, string>();
  const parentPos = new Map<string, HexPos>();
  let queue: HexPos[] = [from];
  let head = 0;
  while (head < queue.length) {
    const pos = queue[head++];
    for (const n of hexNeighbors(pos, grid)) {
      const key = posKey(n);
      if (!visited.has(key) && !occupiedSet.has(key)) {
        visited.add(key);
        parentKey.set(key, posKey(pos));
        parentPos.set(key, pos);
        if (key === toKey) {
          // Reconstruct path from `from` to `to`
          const path: HexPos[] = [];
          let cur = n;
          let curKey = key;
          while (curKey !== fromKey) {
            path.unshift(cur);
            const pk = parentKey.get(curKey)!;
            cur = parentPos.get(curKey)!;
            curKey = pk;
          }
          return path;
        }
        queue.push(n);
      }
    }
  }
  return [];
}

// All hexes within `radius` hex-distance of `center` (excluding center).
export function hexDisk(center: HexPos, radius: number, grid: HexGrid): HexPos[] {
  const result: HexPos[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      if (dq === 0 && dr === 0) continue;
      const pos = { q: center.q + dq, r: center.r + dr };
      if (inBounds(pos, grid)) result.push(pos);
    }
  }
  return result;
}

// All hexes at exactly `radius` hex-distance from `center`.
export function hexRing(center: HexPos, radius: number, grid: HexGrid): HexPos[] {
  if (radius === 0) return inBounds(center, grid) ? [{ ...center }] : [];
  const result: HexPos[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      // Only the ring: |dq| + |dr| + |dq+dr| == radius * 2
      if (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr) !== radius * 2) continue;
      const pos = { q: center.q + dq, r: center.r + dr };
      if (inBounds(pos, grid)) result.push(pos);
    }
  }
  return result;
}

// ── Initial placement ─────────────────────────────────────────────────────────

// Spreads `count` actors across one side of the grid. Fills the center of
// the chosen edge first, expanding outward.
//
//   "left"   → q=1  varying r           (horizontal grid, party-left)
//   "right"  → q=cols-2 varying r       (horizontal grid, monsters-right)
//   "top"    → r=1  varying q           (vertical grid, party at the top)
//   "bottom" → r=rows-2 varying q       (vertical grid, monsters at the bottom)
export function initialHexPositions(
  count: number,
  side: "left" | "right" | "top" | "bottom",
  grid: HexGrid,
): HexPos[] {
  const positions: HexPos[] = [];
  const seen = new Set<string>();

  function tryAdd(pos: HexPos): void {
    if (positions.length >= count || !inBounds(pos, grid)) return;
    const k = posKey(pos);
    if (!seen.has(k)) { seen.add(k); positions.push(pos); }
  }

  if (side === "left" || side === "right") {
    const mid = Math.floor(grid.rows / 2);
    const q1 = side === "left" ? 1 : grid.cols - 2;
    const q0 = side === "left" ? 0 : grid.cols - 1;
    for (let dist = 0; dist <= mid && positions.length < count; dist++) {
      tryAdd({ q: q1, r: mid + dist });
      if (dist > 0) tryAdd({ q: q1, r: mid - dist });
    }
    for (let dist = 0; dist <= mid && positions.length < count; dist++) {
      tryAdd({ q: q0, r: mid + dist });
      if (dist > 0) tryAdd({ q: q0, r: mid - dist });
    }
  } else {
    // Brick layout: walk rows from the chosen edge inward and fill from the
    // center column outward. Axial q = offsetCol - floor(row / 2).
    const r1 = side === "top" ? 1 : grid.rows - 2;
    const r0 = side === "top" ? 0 : grid.rows - 1;
    for (const r of [r1, r0]) {
      if (positions.length >= count) break;
      const rowShift = Math.floor(r / 2);
      const rowWidth = r % 2 === 0 ? grid.cols : grid.cols - 1;
      const mid = Math.floor(rowWidth / 2);
      for (let dist = 0; dist <= mid && positions.length < count; dist++) {
        tryAdd({ q: (mid + dist) - rowShift, r });
        if (dist > 0) tryAdd({ q: (mid - dist) - rowShift, r });
      }
    }
  }

  return positions;
}

// ── Stat-derived range helpers ────────────────────────────────────────────────

// Move range in hexes per turn, derived from AGI stat.
//
// Capped at MAX_MOVE_RANGE so stacked AGI equipment (boots + pants + ring,
// each potentially +5/+6 at high tier) can't trivially let a fighter cross
// the entire grid in one move and skip tactical positioning. The cap roughly
// corresponds to half the grid height, so a high-AGI build can comfortably
// reposition but still can't reach the back line in one step.
export const MAX_MOVE_RANGE = 5;
export function deriveMoveRange(agi: number): number {
  return Math.min(MAX_MOVE_RANGE, 2 + Math.floor(Math.max(0, agi - 5) / 3));
}

// Weapon range in hexes, derived from weapon type and relevant stat.
// melee = 1 (always); focus = 3 + INT bonus; ranged = 5 + DEX bonus.
export function deriveRangeTiles(
  weaponRange: "melee" | "ranged" | "focus",
  intStat = 5,
  dex = 5,
): number {
  switch (weaponRange) {
    case "melee": return 1;
    case "focus": return 3 + Math.floor(Math.max(0, intStat - 5) / 4);
    case "ranged": return 5 + Math.floor(Math.max(0, dex - 5) / 4);
  }
}

// ── Obstacle generation ──────────────────────────────────────────────────────

// Mulberry32: a tiny, deterministic PRNG. Same seed → same sequence, every
// time. Pure (no Date.now / no Math.random), so obstacle layouts are stable
// across DO restarts and player resumes.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Picks an obstacle kind appropriate for the given scene. Accepts both the
// generic kind names (cave/forest/...) and the gantt-quest themed scene
// keys (server_catacomb/cubicle_forest/...).
function obstacleKindForScene(scene: string, rng: () => number): ObstacleKind {
  const palette: Record<string, ObstacleKind[]> = {
    // Generic
    cave: ["boulder", "rubble", "pillar"],
    forest: ["tree", "boulder", "rubble"],
    ruins: ["pillar", "rubble", "crate"],
    castle: ["crate", "pillar", "rubble"],
    swamp: ["tree", "boulder", "rubble"],
    tower: ["pillar", "crate", "rubble"],
    // Themed (mapped to closest visual analog)
    server_catacomb: ["pillar", "rubble", "crate"],   // ruined data hall
    cubicle_forest: ["crate", "pillar", "tree"],      // office plants + cubicle walls
    warehouse_floor: ["crate", "crate", "rubble"],    // boxes everywhere
    fluorescent_office: ["crate", "pillar", "rubble"], // file cabinets + columns
    neon_basement: ["pillar", "crate", "rubble"],     // exposed beams
    deadline_dungeon: ["pillar", "rubble", "boulder"], // stone + debris
  };
  const pool = palette[scene] ?? ["boulder", "rubble", "pillar"];
  return pool[Math.floor(rng() * pool.length)];
}

// Generates 2–4 obstacles for a battlefield. Deterministic given `seed`.
//
// Rules:
//   - Never on a party or monster start hex
//   - Never adjacent to a party or monster start hex (so no one's boxed in)
//   - Biased toward the middle columns (q in [4, 9]) — most tactical impact
//   - At least 2 hexes apart from each other (no clustering)
//   - Count = 2 + (seed % 3) → 2, 3, or 4 obstacles
export function generateObstacles(
  grid: HexGrid,
  partyPositions: HexPos[],
  monsterPositions: HexPos[],
  seed: number,
  scene: string = "cave",
): Obstacle[] {
  const rng = mulberry32(seed);
  const count = 2 + (Math.abs(seed) % 3);

  // Build the forbidden set: every actor start hex and every immediate neighbor.
  const forbidden = new Set<string>();
  for (const start of [...partyPositions, ...monsterPositions]) {
    forbidden.add(posKey(start));
    for (const n of hexNeighbors(start, grid)) forbidden.add(posKey(n));
  }

  // Candidate pool: all in-bounds non-forbidden hexes (brick-layout aware).
  const allHexes = allHexesInGrid(grid).filter((h) => !forbidden.has(posKey(h)));

  // Weight middle rows higher — for a portrait brick grid, middle-band
  // obstacles between party and monster zones are the most tactically
  // interesting (force flanking or repositioning).
  const midRow = Math.floor(grid.rows / 2);
  const isMiddle = (h: HexPos) => Math.abs(h.r - midRow) <= 2;
  const weighted = allHexes
    .map((h) => ({ h, key: (isMiddle(h) ? 0 : 1) + rng() }))
    .sort((a, b) => a.key - b.key);

  // Greedy pick respecting minimum spacing of 2 hexes.
  const placed: Obstacle[] = [];
  for (const { h } of weighted) {
    if (placed.length >= count) break;
    const tooClose = placed.some((p) => hexDistance(p.pos, h) < 2);
    if (tooClose) continue;
    placed.push({ pos: h, kind: obstacleKindForScene(scene, rng) });
  }
  return placed;
}

// ── Loot tile generation ─────────────────────────────────────────────────────

// Generates 1–3 loot tiles for a battlefield, deterministic given `seed`.
//
// Rules:
//   - Never on a party / monster start hex (or their neighbors — same
//     "don't box people in" rule as obstacles)
//   - Never on an obstacle hex
//   - Biased toward the MID-FIELD between party and monsters (so picking
//     them up is a real tactical detour, not a free top-row pickup)
//   - At least 2 hexes apart from each other and from any obstacle
//   - Count scales with `tier`: tier ≤ 3 → 1 tile, 4–6 → 2 tiles, 7+ → 3 tiles
//   - 60% gold / 40% item, rolled per tile from the seeded RNG
export function generateLootTiles(
  grid: HexGrid,
  partyPositions: HexPos[],
  monsterPositions: HexPos[],
  obstacles: (HexPos | Obstacle)[],
  seed: number,
  tier: number,
): LootTile[] {
  // Use a different seed bias from obstacles so loot tile positions don't
  // collide with the same first-picks the obstacle generator burned through.
  const rng = mulberry32((seed ^ 0x9E3779B9) >>> 0);
  const count = tier <= 3 ? 1 : tier <= 6 ? 2 : 3;

  const forbidden = new Set<string>();
  for (const start of [...partyPositions, ...monsterPositions]) {
    forbidden.add(posKey(start));
    for (const n of hexNeighbors(start, grid)) forbidden.add(posKey(n));
  }
  for (const o of obstacles) forbidden.add(posKey("pos" in o ? o.pos : o));

  const allHexes = allHexesInGrid(grid).filter((h) => !forbidden.has(posKey(h)));

  // Bias toward the middle 3 rows — same "tactical detour" reasoning as
  // obstacles, only tighter so loot tiles consistently land in the danger
  // zone rather than the safe top or bottom edges.
  const midRow = Math.floor(grid.rows / 2);
  const isMiddle = (h: HexPos) => Math.abs(h.r - midRow) <= 1;
  const weighted = allHexes
    .map((h) => ({ h, key: (isMiddle(h) ? 0 : 1) + rng() }))
    .sort((a, b) => a.key - b.key);

  const obstaclePosList = obstacles.map((o) => ("pos" in o ? o.pos : o));
  const placed: LootTile[] = [];
  for (const { h } of weighted) {
    if (placed.length >= count) break;
    const tooClose =
      placed.some((p) => hexDistance(p.pos, h) < 2)
      || obstaclePosList.some((op) => hexDistance(op, h) < 2);
    if (tooClose) continue;
    const kind: LootKind = rng() < 0.6 ? "gold" : "item";
    placed.push({
      id: `loot-${seed}-${placed.length}`,
      pos: h,
      kind,
      tier,
    });
  }
  return placed;
}

// Gold amount a "gold" loot tile pays out. Pure helper so worker + engine
// stay aligned on the formula. Scales gently with tier — picking up two
// loot tiles in a tier-5 fight is worth ~30g, a meaningful but not
// dominant chunk vs. the 50–150g victory split.
export function lootTileGold(tier: number): number {
  return 6 + Math.max(0, tier) * 2;
}

// Item-roll level for an "item" loot tile. One tier BELOW the source
// combat so battlefield-tile items don't outclass the victory drops.
export function lootTileItemTier(tier: number): number {
  return Math.max(1, tier - 1);
}
