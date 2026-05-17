// Grid dungeon generator. Produces a DungeonGraph laid out on a 2D grid with
// room shapes derived from exit directions, lockable doors between rooms, and
// first-class room contents (encounter, loot, trap, lockbox, npc, merchant,
// boss). Used by the web worker when starting a dungeon variant quest.
//
// Design notes:
// - Pure logic. No D1, no AI calls. AI flavor (room descriptions, monster
//   names, loot names) is layered on top by the caller after layout.
// - Deterministic given a `seed` for testability.
// - Generation is constraint-based: random walk from entry, ensuring exactly
//   one boss room placed at the largest Manhattan distance, with doors mostly
//   open but with locked/barred shortcuts so the dungeon has multiple paths.

import type {
  DungeonDirection,
  DungeonGraph,
  DungeonNode,
  GridDoor,
  GridRoomContent,
  KeyTier,
  LootOption,
  MonsterSpec,
  TrapChoice,
} from "./db";
import { shapeFromExits } from "./db";

// ── Random helpers ───────────────────────────────────────────────────────────

// Mulberry32 — small fast PRNG. Used so a given seed always produces the same
// dungeon (helpful for tests and for reproducing player-reported layouts).
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ── Grid + directions ────────────────────────────────────────────────────────

const ALL_DIRS: DungeonDirection[] = ["n", "e", "s", "w"];

function dirVector(dir: DungeonDirection): { dx: number; dy: number } {
  if (dir === "n") return { dx: 0, dy: -1 };
  if (dir === "e") return { dx: 1, dy: 0 };
  if (dir === "s") return { dx: 0, dy: 1 };
  return { dx: -1, dy: 0 };
}

function opposite(dir: DungeonDirection): DungeonDirection {
  return dir === "n" ? "s" : dir === "s" ? "n" : dir === "e" ? "w" : "e";
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function roomId(x: number, y: number): string {
  return `r_${x}_${y}`;
}

// ── Layout pass ──────────────────────────────────────────────────────────────

interface RawCell {
  x: number;
  y: number;
  exits: Set<DungeonDirection>;
  distFromEntry: number;
}

interface LayoutResult {
  cells: Map<string, RawCell>;
  entry: RawCell;
  boss: RawCell;
  width: number;
  height: number;
}

// Random-walk + branch generator. Lays down `targetRoomCount` rooms starting
// from the entry. Each step picks an unvisited adjacent cell (in-bounds) and
// places a room there, connected to the parent via a corridor. Occasional
// branches create a tree, not a single path.
function layoutGrid(rng: () => number, width: number, height: number, targetRoomCount: number): LayoutResult {
  const cells = new Map<string, RawCell>();
  // Entry: random edge cell so the dungeon "enters" from outside.
  const edges: Array<{ x: number; y: number }> = [];
  for (let x = 0; x < width; x++) { edges.push({ x, y: 0 }); edges.push({ x, y: height - 1 }); }
  for (let y = 1; y < height - 1; y++) { edges.push({ x: 0, y }); edges.push({ x: width - 1, y }); }
  const ep = edges[Math.floor(rng() * edges.length)];
  const entry: RawCell = { x: ep.x, y: ep.y, exits: new Set(), distFromEntry: 0 };
  cells.set(cellKey(entry.x, entry.y), entry);

  // Active set for random-walk + branching. We bias toward extending the most
  // recent room (depth-first) but occasionally pop a random earlier room to
  // create a branch.
  const frontier: RawCell[] = [entry];
  while (cells.size < targetRoomCount && frontier.length > 0) {
    // 70% pick last (depth-first), 30% pick random (branch).
    const idx = rng() < 0.7 ? frontier.length - 1 : Math.floor(rng() * frontier.length);
    const here = frontier[idx];
    // Try each direction in random order.
    const dirs = [...ALL_DIRS].sort(() => rng() - 0.5);
    let extended = false;
    for (const dir of dirs) {
      const { dx, dy } = dirVector(dir);
      const nx = here.x + dx, ny = here.y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (cells.has(cellKey(nx, ny))) continue;
      // Place a new room.
      const next: RawCell = { x: nx, y: ny, exits: new Set([opposite(dir)]), distFromEntry: here.distFromEntry + 1 };
      here.exits.add(dir);
      cells.set(cellKey(nx, ny), next);
      frontier.push(next);
      extended = true;
      break;
    }
    if (!extended) {
      // Cell has no unvisited neighbours — drop it from the frontier.
      frontier.splice(idx, 1);
    }
  }

  // Pick the boss as the room with the highest distFromEntry. Ties broken by
  // selecting one with only a single exit (a true dead-end feels more boss-like).
  let boss: RawCell = entry;
  for (const c of cells.values()) {
    if (c.distFromEntry > boss.distFromEntry) boss = c;
    else if (c.distFromEntry === boss.distFromEntry && c.exits.size < boss.exits.size) boss = c;
  }

  // Add occasional shortcut corridors between adjacent existing rooms (creates
  // loops). ~25% of adjacent pairs that aren't connected get a corridor.
  const ckeys = [...cells.keys()];
  for (const k of ckeys) {
    const c = cells.get(k)!;
    for (const dir of ALL_DIRS) {
      if (c.exits.has(dir)) continue;
      const { dx, dy } = dirVector(dir);
      const adj = cells.get(cellKey(c.x + dx, c.y + dy));
      if (!adj) continue;
      // Skip 75% of potential shortcuts so the dungeon stays tree-like overall.
      if (rng() > 0.25) continue;
      c.exits.add(dir);
      adj.exits.add(opposite(dir));
    }
  }

  return { cells, entry, boss, width, height };
}

// ── Content placement ────────────────────────────────────────────────────────

// Loot-roll dependencies are supplied by the caller (varies by tier). The
// grid generator is pure; loot tables and AI flavor live elsewhere.
export interface GridGenInputs {
  seed: number;
  tier: number;
  width: number;
  height: number;
  targetRoomCount: number;
  // Caller-supplied generators so this stays pure-data:
  rollMonsterPack(isBoss: boolean): MonsterSpec[];
  rollLoot(tier: number, kind: "loot" | "treasure" | "merchant" | "npc"): LootOption[];
  rollTrap(tier: number): TrapChoice[];
  npcGreeting(): string;
  merchantGreeting(): string;
  // Returns the public URL of a pre-rendered NPC portrait, randomly picked
  // from a pool. Optional so callers without an art pool can return null.
  npcArtUrl?: () => string | null;
  merchantArtUrl?: () => string | null;
  // Default flavor descriptions per content kind. Caller can rewrite with AI.
  describeRoom(kind: GridRoomContent["kind"], shape: string): string;
}

// Build the full DungeonGraph (grid-aware) from the inputs.
export function generateGridDungeon(inputs: GridGenInputs): DungeonGraph {
  const rng = mulberry32(inputs.seed);
  const layout = layoutGrid(rng, inputs.width, inputs.height, inputs.targetRoomCount);

  // First pass: assign content kinds to each cell.
  const cells = [...layout.cells.values()];
  const others = cells.filter((c) => c !== layout.entry && c !== layout.boss);

  // Shuffle deterministically using rng so content placement is reproducible.
  others.sort(() => rng() - 0.5);

  const contents = new Map<RawCell, GridRoomContent>();
  contents.set(layout.entry, { kind: "entry" });
  contents.set(layout.boss, {
    kind: "boss",
    monsters: inputs.rollMonsterPack(true),
    cleared: false,
    treasure: inputs.rollLoot(inputs.tier + 1, "treasure"),
  });

  // Content quota (scales with room count).
  const n = others.length;
  const quota = {
    encounter: Math.max(2, Math.floor(n * 0.35)),
    loot: Math.max(1, Math.floor(n * 0.15)),
    trap: Math.max(1, Math.floor(n * 0.12)),
    lockbox: Math.max(1, Math.floor(n * 0.1)),
    npc: rng() < 0.6 ? 1 : 0,
    merchant: rng() < 0.5 ? 1 : 0,
    key_pickup: Math.max(1, Math.floor(n * 0.12)),
  };

  let i = 0;
  function takeNext(): RawCell | undefined { return others[i++]; }

  for (let k = 0; k < quota.encounter; k++) {
    const c = takeNext();
    if (!c) break;
    contents.set(c, {
      kind: "encounter",
      monsters: inputs.rollMonsterPack(false),
      cleared: false,
    });
  }
  for (let k = 0; k < quota.loot; k++) {
    const c = takeNext();
    if (!c) break;
    contents.set(c, { kind: "loot", items: inputs.rollLoot(inputs.tier, "loot"), taken: false });
  }
  for (let k = 0; k < quota.trap; k++) {
    const c = takeNext();
    if (!c) break;
    contents.set(c, { kind: "trap", choices: inputs.rollTrap(inputs.tier), resolved: false });
  }
  for (let k = 0; k < quota.lockbox; k++) {
    const c = takeNext();
    if (!c) break;
    const tier: KeyTier = rng() < 0.5 ? "bronze" : rng() < 0.7 ? "silver" : "gold";
    contents.set(c, {
      kind: "lockbox",
      lock_tier: tier,
      options: inputs.rollLoot(inputs.tier + 1, "loot"),
      resolved: false,
    });
  }
  if (quota.npc > 0) {
    const c = takeNext();
    if (c) {
      const offers = inputs.rollLoot(inputs.tier, "npc");
      contents.set(c, {
        kind: "npc",
        greeting: inputs.npcGreeting(),
        offer: offers[0],
        resolved: false,
        art_url: inputs.npcArtUrl ? inputs.npcArtUrl() : null,
      });
    }
  }
  if (quota.merchant > 0) {
    const c = takeNext();
    if (c) {
      contents.set(c, {
        kind: "merchant",
        greeting: inputs.merchantGreeting(),
        stock: inputs.rollLoot(inputs.tier, "merchant"),
        resolved: false,
        art_url: inputs.merchantArtUrl ? inputs.merchantArtUrl() : null,
      });
    }
  }
  for (let k = 0; k < quota.key_pickup; k++) {
    const c = takeNext();
    if (!c) break;
    // Pick a tier matching the locked doors we'll create later. We just bias:
    // bronze most common, gold rare.
    const tier: KeyTier = rng() < 0.6 ? "bronze" : rng() < 0.85 ? "silver" : "gold";
    contents.set(c, { kind: "key_pickup", tier, taken: false });
  }
  // Anything left is empty.
  for (; i < others.length; i++) {
    contents.set(others[i], { kind: "empty" });
  }

  // Second pass: assign door state to each edge. Doors are stored on the
  // room with the smaller (x,y) for canonical-ness; lookup helper resolves
  // both sides.
  // Strategy:
  // - Most doors are `open`.
  // - On non-tree shortcut edges (the loops we added) sometimes drop a locked
  //   or barred door so the player has multiple traversal options.
  // - Place locked doors only on edges where a key_pickup of that tier exists
  //   in a room reachable WITHOUT crossing the locked door (avoid soft-locks).
  // For simplicity v1: place 1-3 locked doors and 0-2 barred doors near the
  // middle of the dungeon. We don't formally verify reachability — the player
  // can always bash a barred door, and locked doors fail gracefully (turn back).
  type Edge = { a: RawCell; b: RawCell; dir: DungeonDirection };
  const edges: Edge[] = [];
  for (const c of cells) {
    for (const dir of c.exits) {
      const { dx, dy } = dirVector(dir);
      const adj = layout.cells.get(cellKey(c.x + dx, c.y + dy));
      if (!adj) continue;
      // Canonical-order so each edge appears once.
      if (c.x < adj.x || (c.x === adj.x && c.y < adj.y)) {
        edges.push({ a: c, b: adj, dir });
      }
    }
  }
  // Shuffle, then mark a few as locked/barred.
  const shuffled = [...edges].sort(() => rng() - 0.5);
  const numLocked = Math.min(rollInt(rng, 1, 3), Math.floor(edges.length / 4));
  const numBarred = Math.min(rollInt(rng, 0, 2), Math.floor(edges.length / 5));
  const doors = new Map<string, GridDoor>(); // keyed by `${a.x},${a.y}|${dir}`

  function edgeKey(a: RawCell, dir: DungeonDirection): string {
    return `${a.x},${a.y}|${dir}`;
  }

  // Budget key supply per tier: keys_placed − lockboxes_of_that_tier. This
  // is the surplus the player can spend on doors AFTER opening every
  // matching chest. We never lock more doors than the surplus, so a player
  // who burns their bronze key on a chest can still reach the boss.
  // Higher-tier keys also open lower-tier locks (matches Slack +
  // pickKeyForLock), so gold/silver keys count toward bronze budget.
  const TIER_RANK: Record<KeyTier, number> = { bronze: 0, silver: 1, gold: 2 };
  const keysByTier: Record<KeyTier, number> = { bronze: 0, silver: 0, gold: 0 };
  const lockboxesByTier: Record<KeyTier, number> = { bronze: 0, silver: 0, gold: 0 };
  for (const [, content] of contents) {
    if (content.kind === "key_pickup") keysByTier[content.tier]++;
    if (content.kind === "lockbox") lockboxesByTier[content.lock_tier]++;
  }
  // Net surplus = keys at this tier or higher, minus locks (chests +
  // already-placed doors) at this tier or higher. Computed lazily inside
  // the placement loop so each placement consumes the budget.
  function surplusFor(tier: KeyTier, doorLocksByTier: Record<KeyTier, number>): number {
    let supply = 0, demand = 0;
    for (const t of ["bronze", "silver", "gold"] as KeyTier[]) {
      if (TIER_RANK[t] >= TIER_RANK[tier]) supply += keysByTier[t];
    }
    // A bronze chest can be opened by silver or gold too, so when sizing
    // the "bronze budget" we count ALL chests of bronze tier as demanding
    // *something*. Conservative model: every chest at-or-below `tier` may
    // pull a key of `tier`-or-higher. Picks the cheapest, but worst case
    // it pulls a tier-or-higher key.
    for (const t of ["bronze", "silver", "gold"] as KeyTier[]) {
      if (TIER_RANK[t] <= TIER_RANK[tier]) demand += lockboxesByTier[t];
    }
    demand += doorLocksByTier[tier];
    return supply - demand;
  }

  // Edges incident to the boss room are never locked — the boss path must
  // remain reachable even when the player spends every key on chests.
  function touchesBoss(edge: Edge): boolean {
    return edge.a === layout.boss || edge.b === layout.boss;
  }

  let lockedPlaced = 0, barredPlaced = 0;
  const doorLocksByTier: Record<KeyTier, number> = { bronze: 0, silver: 0, gold: 0 };
  for (const edge of shuffled) {
    // Skip the entry room's doors so the player can always start.
    if (edge.a === layout.entry || edge.b === layout.entry) continue;
    if (lockedPlaced < numLocked && !touchesBoss(edge)) {
      // Find the cheapest tier whose budget still has surplus. Prefer the
      // tier-of-most-keys so we use them up evenly. Fall through to barred
      // if every tier is over-budget.
      const tierChoice = (["bronze", "silver", "gold"] as KeyTier[])
        .filter((t) => keysByTier[t] > 0 && surplusFor(t, doorLocksByTier) > 0)[0];
      if (tierChoice) {
        doors.set(edgeKey(edge.a, edge.dir), {
          state: "locked",
          lock_tier: tierChoice,
          pick_dc: 10 + inputs.tier + (tierChoice === "gold" ? 4 : tierChoice === "silver" ? 2 : 0),
          bash_dc: 12 + inputs.tier + (tierChoice === "gold" ? 4 : tierChoice === "silver" ? 2 : 0),
        });
        doorLocksByTier[tierChoice]++;
        lockedPlaced++;
        continue;
      }
    }
    if (barredPlaced < numBarred && !touchesBoss(edge)) {
      doors.set(edgeKey(edge.a, edge.dir), {
        state: "barred",
        bash_dc: 11 + inputs.tier,
      });
      barredPlaced++;
      continue;
    }
  }

  // Build the final DungeonNode map.
  const nodes: Record<string, DungeonNode> = {};
  for (const c of cells) {
    const id = roomId(c.x, c.y);
    const exits: Partial<Record<DungeonDirection, string>> = {};
    const nodeDoors: Partial<Record<DungeonDirection, GridDoor>> = {};
    for (const dir of c.exits) {
      const { dx, dy } = dirVector(dir);
      const adj = layout.cells.get(cellKey(c.x + dx, c.y + dy));
      if (!adj) continue;
      exits[dir] = roomId(adj.x, adj.y);
      // Look up the door (canonical or reverse).
      const fwd = doors.get(edgeKey(c, dir));
      if (fwd) {
        nodeDoors[dir] = fwd;
      } else {
        const rev = doors.get(edgeKey(adj, opposite(dir)));
        if (rev) nodeDoors[dir] = rev;
      }
    }
    const content = contents.get(c) ?? { kind: "empty" as const };
    const shape = shapeFromExits(c.exits, content.kind);
    nodes[id] = {
      id,
      description: inputs.describeRoom(content.kind, shape),
      exits,
      doors: nodeDoors,
      content,
      shape,
      x: c.x,
      y: c.y,
      objects: [], // legacy field; grid-mode uses `content` instead
      visited: c === layout.entry,
    };
  }

  return {
    nodes,
    current: roomId(layout.entry.x, layout.entry.y),
    visited: [roomId(layout.entry.x, layout.entry.y)],
    grid_width: layout.width,
    grid_height: layout.height,
  };
}

// Door interaction helpers used by HTTP routes and tests.

// Result of attempting to traverse a door. Caller mutates the room state and
// optionally applies HP damage / consumes a key based on the result.
export type DoorActionResult =
  | { kind: "moved"; toRoomId: string }
  | { kind: "needs_key"; tier: KeyTier }
  | { kind: "must_skill_check"; pick_dc?: number; bash_dc?: number }
  | { kind: "blocked"; reason: string };

// Direct attempt to move through a door. Picking / bashing / key-use are
// separate calls (so the UI can roll dice with animation), each returning
// a fresh DoorActionResult with state updated.
export function tryMove(
  graph: DungeonGraph,
  fromId: string,
  dir: DungeonDirection,
): DoorActionResult {
  const from = graph.nodes[fromId];
  if (!from) return { kind: "blocked", reason: "current room missing" };
  const toId = from.exits[dir];
  if (!toId) return { kind: "blocked", reason: "no exit that way" };
  const door = from.doors?.[dir];
  if (!door || door.state === "open" || door.state === "broken") {
    return { kind: "moved", toRoomId: toId };
  }
  if (door.state === "locked") return { kind: "needs_key", tier: door.lock_tier ?? "bronze" };
  if (door.state === "barred") return { kind: "must_skill_check", bash_dc: door.bash_dc };
  return { kind: "blocked", reason: "door is sealed" };
}

// Apply a successful key-use, pick, or bash. Mutates BOTH sides of the door
// so re-entering the room shows it open. Returns true if applied.
export function openDoor(
  graph: DungeonGraph,
  fromId: string,
  dir: DungeonDirection,
  newState: "open" | "broken",
): boolean {
  const from = graph.nodes[fromId];
  if (!from) return false;
  const toId = from.exits[dir];
  if (!toId) return false;
  const to = graph.nodes[toId];
  if (!to) return false;
  if (from.doors?.[dir]) from.doors[dir]!.state = newState;
  const back = opposite(dir);
  if (to.doors?.[back]) to.doors[back]!.state = newState;
  return true;
}
