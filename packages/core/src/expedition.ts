// Expedition map — pure deterministic generation + state machine.
//
// See docs/expedition-map.md for the full design. This module contains:
//   * Node + edge types
//   * Seeded PRNG (mulberry32 inline; no Date.now / Math.random)
//   * Deterministic map generation from (expedition_id, party_signature)
//   * State reducers (resolveNode, availablePicks)
//
// Strictly NO I/O. Every public function is a pure transform over its inputs.
//
// Hard rules enforced by `generateExpeditionMap`:
//   - Depth 0 (immediately after START):  always `combat`
//   - Depth (D-1) (immediately before BOSS): always `camp`
//   - No two `elite` adjacent on the same lane
//   - Every lane has at least one `shrine` reachable
//   - Edges never cross (geometric constraint; adjacent-lane edges only)
//   - Single boss at end
//   - Solo (1 player) gets 3 lanes; 2+ players get 4 lanes

// ---------- types ----------

export type NodeKind =
  | "start"
  | "combat"
  | "elite"
  | "event"
  | "shrine"
  | "camp"
  | "treasure"
  | "boss";

export interface ExpeditionNode {
  /** Stable id of the form `n_{depth}_{lane}` (or `start` / `boss`). */
  id: string;
  kind: NodeKind;
  depth: number; // 0 = first row past START; D-1 = camp row; boss is depth D
  lane: number;  // 0..laneCount-1
}

export interface ExpeditionEdge {
  from: string;
  to: string;
}

export interface ExpeditionMap {
  seed: string;
  laneCount: number;
  /** Intermediate depth count (excludes START and BOSS rows). */
  depth: number;
  start: ExpeditionNode;
  boss: ExpeditionNode;
  /** All nodes (start + intermediate + boss). Order is generation order. */
  nodes: ExpeditionNode[];
  edges: ExpeditionEdge[];
}

// ---------- seeded PRNG ----------

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 * Pure: same seed → same sequence, forever.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string → 32-bit seed (FNV-1a). */
export function stringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Compose `(expedition_id, party_signature)` into a deterministic seed. */
export function expeditionSeed(
  expeditionId: number | string,
  partyCharacterIds: readonly string[],
): string {
  // Sort party ids so two parties of the same members produce the same seed
  // regardless of join order — keeps generation reproducible for debugging.
  const sig = [...partyCharacterIds].sort().join(",");
  return `${expeditionId}|${sig}`;
}

// ---------- helpers ----------

function randInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function weightedPick<T extends string>(
  rng: () => number,
  weights: Readonly<Record<T, number>>,
): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

// ---------- generation ----------

/** Frequency table (matches the design doc, sums to ~95%; remainder smoothed in). */
const KIND_WEIGHTS: Readonly<Record<Exclude<NodeKind, "start" | "boss" | "camp">, number>> = {
  combat: 50,
  elite: 10,
  event: 15,
  shrine: 5,
  treasure: 5,
  // camp is forced for the pre-boss row, but also appears organically
  // elsewhere — the design doc lists ~10% camp.
} as const;

const CAMP_INTERMEDIATE_WEIGHT = 10;

export interface GenerateMapArgs {
  seed: string;
  partySize: number;
  /** Intermediate depth (excludes START and BOSS). Defaults to 13 for v1. */
  depth?: number;
}

const DEFAULT_DEPTH = 13;

export function laneCountForParty(partySize: number): number {
  return partySize >= 2 ? 4 : 3;
}

export function generateExpeditionMap(args: GenerateMapArgs): ExpeditionMap {
  const depth = args.depth ?? DEFAULT_DEPTH;
  if (depth < 3) {
    throw new Error(`expedition depth must be >= 3, got ${depth}`);
  }
  const laneCount = laneCountForParty(args.partySize);
  const rng = mulberry32(stringToSeed(args.seed));

  // Step 1: build the per-depth grid of node slots. Each (depth, lane) is a
  // potential node — but we don't pre-populate all of them; we walk forward
  // and only realize slots that have at least one incoming edge from depth-1
  // (or, for depth 0, every lane gets a node since START fans out fully).
  const nodes: ExpeditionNode[] = [];
  const edges: ExpeditionEdge[] = [];

  const start: ExpeditionNode = { id: "start", kind: "start", depth: -1, lane: -1 };
  const boss: ExpeditionNode = { id: "boss", kind: "boss", depth, lane: -1 };

  // grid[d] = set of lanes that have a realized node at depth d
  const realized: Set<number>[] = Array.from({ length: depth }, () => new Set<number>());

  // Depth 0: START fans out to every lane (canonical StS shape).
  for (let lane = 0; lane < laneCount; lane++) {
    realized[0].add(lane);
  }

  // For depths 1..depth-1, each realized node at d-1 picks 1..3 forward edges
  // to adjacent lanes at d (lane-1, lane, lane+1 — clamped to bounds).
  // Edges are added immediately so we can detect crossings.
  //
  // No-crossing rule (StS-style): if node at depth d, lane L has an edge to
  // depth d+1, lane L+1, then the node at depth d, lane L+1 cannot have an
  // edge to depth d+1, lane L. We enforce this by tracking "right-going"
  // edges at each depth and forbidding the symmetric "left-going" edge from
  // the lane to its right.
  for (let d = 0; d < depth - 1; d++) {
    const fromLanes = [...realized[d]].sort((a, b) => a - b);
    /** lanes at depth d that emitted a right-going edge (d, L) -> (d+1, L+1) */
    const rightFromLane = new Set<number>();

    for (const lane of fromLanes) {
      // Candidate target lanes: lane-1, lane, lane+1 (clamped).
      const candidates: number[] = [];
      if (lane - 1 >= 0) {
        // Forbid (d, lane) -> (d+1, lane-1) if (d, lane-1) already emitted
        // a right-going edge (would cross).
        if (!rightFromLane.has(lane - 1)) candidates.push(lane - 1);
      }
      candidates.push(lane);
      if (lane + 1 < laneCount) {
        // Forbid (d, lane) -> (d+1, lane+1) if (d, lane+1) already emitted
        // a left-going edge. lane+1 hasn't been processed yet (we walk in
        // ascending order), so it can't have emitted yet — but we still
        // need to record that emitting *here* would prevent it from going
        // left below.
        candidates.push(lane + 1);
      }

      // Number of outgoing edges: weighted 1/2/3 (slight bias toward 2).
      const edgeCount = weightedPick(rng, { 1: 35, 2: 45, 3: 20 } as const) as
        | "1"
        | "2"
        | "3";
      const want = parseInt(edgeCount, 10);
      const k = Math.min(want, candidates.length);

      // Shuffle candidates (Fisher–Yates) and take k.
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const targets = shuffled.slice(0, k).sort((a, b) => a - b);

      for (const tlane of targets) {
        // Re-check crossing constraint at the moment of emission. (For the
        // right neighbor we couldn't pre-check because it hadn't been
        // processed yet — but here we're committing.)
        if (tlane === lane + 1) {
          rightFromLane.add(lane);
          // Tell the right-neighbor (when processed) not to go left here.
          // We walk lanes in ascending order, so the right neighbor will see
          // `rightFromLane.has(lane)` when building its candidate list and
          // exclude its own left-going edge — that's enough to prevent the
          // symmetric crossing pair. No `leftFromLane` set is needed.
        }
        const toId = `n_${d + 1}_${tlane}`;
        const fromId = `n_${d}_${lane}`;
        edges.push({ from: fromId, to: toId });
        realized[d + 1].add(tlane);
      }
    }

    // Repair: ensure every depth has at least one realized lane (it should,
    // but if a degenerate seed produced zero we forcibly seed lane 0).
    if (realized[d + 1].size === 0) {
      realized[d + 1].add(0);
      edges.push({ from: `n_${d}_${[...realized[d]][0]}`, to: `n_${d + 1}_0` });
    }
  }

  // Step 2: connect START -> every realized lane at depth 0.
  for (const lane of realized[0]) {
    edges.push({ from: "start", to: `n_0_${lane}` });
  }

  // Step 3: connect every realized node at depth-1 to BOSS.
  for (const lane of realized[depth - 1]) {
    edges.push({ from: `n_${depth - 1}_${lane}`, to: "boss" });
  }

  // Step 4: assign kinds.
  //
  // Hard-row constraints:
  //   - depth 0  → combat
  //   - depth D-1 → camp
  // Otherwise sample from KIND_WEIGHTS + camp's intermediate weight, with
  // the "no two elites adjacent on same lane" guard applied as we go.
  //
  // We track, per lane, whether the previous depth's node on that lane was
  // an elite. "Adjacent on the same lane" interprets the lane as the column
  // — a node at (d, L) is lane-adjacent to (d-1, L), (d-2, L), etc.
  // Specifically the doc says "no two elite adjacent on the same lane",
  // which we enforce strictly for immediately consecutive depths in the
  // same lane.
  const kindByNodeId = new Map<string, NodeKind>();
  const prevLaneKind = new Map<number, NodeKind>(); // lane -> kind at last depth this lane appeared

  for (let d = 0; d < depth; d++) {
    for (const lane of [...realized[d]].sort((a, b) => a - b)) {
      const nodeId = `n_${d}_${lane}`;
      let kind: NodeKind;
      if (d === 0) {
        kind = "combat";
      } else if (d === depth - 1) {
        kind = "camp";
      } else {
        // Build sample weights for this slot
        const w: Record<Exclude<NodeKind, "start" | "boss">, number> = {
          combat: KIND_WEIGHTS.combat,
          elite: KIND_WEIGHTS.elite,
          event: KIND_WEIGHTS.event,
          shrine: KIND_WEIGHTS.shrine,
          treasure: KIND_WEIGHTS.treasure,
          camp: CAMP_INTERMEDIATE_WEIGHT,
        };
        // No-adjacent-elite guard: if the previous depth's same-lane node
        // was elite, zero the elite weight here.
        if (prevLaneKind.get(lane) === "elite") {
          w.elite = 0;
        }
        kind = weightedPick(rng, w);
      }
      kindByNodeId.set(nodeId, kind);
      prevLaneKind.set(lane, kind);
    }
  }

  // Step 5: enforce "every lane has a shrine reachable."
  // "Lane" here means: any node reachable by starting from depth 0 at lane L
  // and walking forward to BOSS through any chain of edges. We compute the
  // set of nodes reachable from each depth-0 lane via forward-BFS, then
  // check whether at least one is a shrine. If not, we mutate the kind of
  // a deterministically-chosen node in that reachable set to `shrine`
  // (preferring mid-depth `event` or `treasure` slots over combat).
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e.to);
  }
  for (let lane = 0; lane < laneCount; lane++) {
    if (!realized[0].has(lane)) continue; // shouldn't happen — depth 0 fans out fully
    const seed0 = `n_0_${lane}`;
    const seen = new Set<string>([seed0]);
    const stack = [seed0];
    while (stack.length) {
      const id = stack.pop()!;
      const outs = outgoing.get(id) ?? [];
      for (const to of outs) {
        if (to === "boss") continue;
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    const reachable = [...seen];
    const hasShrine = reachable.some((id) => kindByNodeId.get(id) === "shrine");
    if (!hasShrine) {
      // Promote a deterministically-chosen node to a shrine.
      // Preference order: event > treasure > combat (we never displace camp
      // at depth-1 or combat at depth-0).
      const priority: NodeKind[] = ["event", "treasure", "combat"];
      let promoted = false;
      for (const wanted of priority) {
        if (promoted) break;
        for (const id of reachable) {
          // Skip locked rows
          const m = /^n_(\d+)_(\d+)$/.exec(id);
          if (!m) continue;
          const dd = parseInt(m[1], 10);
          if (dd === 0 || dd === depth - 1) continue;
          if (kindByNodeId.get(id) === wanted) {
            kindByNodeId.set(id, "shrine");
            promoted = true;
            break;
          }
        }
      }
      // Fallback: if even after the priority sweep we found nothing, just
      // grab the first non-locked node in the reachable set.
      if (!promoted) {
        for (const id of reachable) {
          const m = /^n_(\d+)_(\d+)$/.exec(id);
          if (!m) continue;
          const dd = parseInt(m[1], 10);
          if (dd === 0 || dd === depth - 1) continue;
          kindByNodeId.set(id, "shrine");
          promoted = true;
          break;
        }
      }
    }
  }

  // Build the final node list.
  nodes.length = 0;
  nodes.push(start);
  for (let d = 0; d < depth; d++) {
    for (const lane of [...realized[d]].sort((a, b) => a - b)) {
      const id = `n_${d}_${lane}`;
      const kind = kindByNodeId.get(id) ?? "combat";
      nodes.push({ id, kind, depth: d, lane });
    }
  }
  nodes.push(boss);

  return { seed: args.seed, laneCount, depth, start, boss, nodes, edges };
}

// ---------- queries ----------

export function nodeById(map: ExpeditionMap, id: string): ExpeditionNode | null {
  return map.nodes.find((n) => n.id === id) ?? null;
}

export function outgoingEdges(map: ExpeditionMap, fromId: string): ExpeditionEdge[] {
  return map.edges.filter((e) => e.from === fromId);
}

/**
 * Available picks given the expedition's current_node state.
 *
 * - null current_node → picks are START's outgoing nodes (all depth-0 lanes).
 * - any other node    → picks are that node's outgoing nodes.
 * - boss reached      → no picks (expedition is at end).
 */
export function availablePicks(
  map: ExpeditionMap,
  currentNodeId: string | null,
): ExpeditionNode[] {
  const fromId = currentNodeId ?? "start";
  if (fromId === "boss") return [];
  const outs = outgoingEdges(map, fromId).map((e) => e.to);
  return outs
    .map((id) => nodeById(map, id))
    .filter((n): n is ExpeditionNode => n != null);
}

// ---------- state machine reducers ----------
//
// Reducers are pure: (state, action) -> state. The worker owns I/O (D1 writes,
// spawning quests, etc.); this layer just decides *what should happen*.

/**
 * TODO(pass-2): persistence for between-node HP/mana carry.
 *
 * The design doc ("Party HP/mana between nodes", open question #1) requires
 * HP and mana to carry across nodes within a single expedition — this is what
 * makes camp/shrine nodes meaningful. This type is the in-memory shape Pass 2
 * will read/write, but Pass 1 deliberately does NOT persist it:
 *
 *   - No DB column on `expeditions` or `expedition_party` for current HP/mana
 *     yet — Pass 2 will add `current_hp`, `current_mana`, `max_hp`, `max_mana`
 *     columns to `expedition_party` (or a sibling table) when wiring the
 *     combat-node spawn + post-resolve callback.
 *   - The reducer carries `party: ExpeditionPartyHp[]` through state purely
 *     in-memory today; the worker doesn't read or write it. That's intentional
 *     — the natural place to thread HP/mana through is the combat-node
 *     spawn/resolve cycle, which lands in Pass 2.
 *
 * When Pass 2 lands, this type stays; the migration adds columns; the worker
 * loads the values into `ExpeditionState.party` on read and writes them back
 * on each node-resolve.
 */
export interface ExpeditionPartyHp {
  characterId: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
}

export interface ExpeditionState {
  expeditionId: number;
  map: ExpeditionMap;
  /** Currently-occupied node id; null until first pick. */
  currentNode: string | null;
  /** node_id -> outcome JSON (mirrors expedition_node_progress rows). */
  resolved: Record<string, unknown>;
  /** HP/mana per party member carries across nodes. */
  party: ExpeditionPartyHp[];
  status: "active" | "completed" | "failed" | "abandoned";
}

export type ExpeditionAction =
  | { type: "pick"; nodeId: string }
  | { type: "resolve"; nodeId: string; outcome: unknown }
  | { type: "abandon" };

export interface ReducerResult {
  state: ExpeditionState;
  /** Side-effects the caller must perform (kept declarative so I/O lives in the worker). */
  dispatch: Dispatch | null;
}

export type Dispatch =
  | { kind: "spawn_combat"; nodeId: string; tier: "standard" | "elite" | "boss" }
  | { kind: "spawn_event"; nodeId: string }
  | { kind: "spawn_shrine"; nodeId: string }
  | { kind: "spawn_camp"; nodeId: string }
  | { kind: "spawn_treasure"; nodeId: string }
  | { kind: "complete_expedition" };

/**
 * Pure reducer: given the current state and an action, produce the next
 * state + the side-effect the worker must dispatch. I/O is the caller's
 * problem.
 */
export function reduceExpedition(
  state: ExpeditionState,
  action: ExpeditionAction,
): ReducerResult {
  switch (action.type) {
    case "abandon":
      return {
        state: { ...state, status: "abandoned" },
        dispatch: null,
      };

    case "pick": {
      if (state.status !== "active") {
        throw new Error(`cannot pick — expedition is ${state.status}`);
      }
      const picks = availablePicks(state.map, state.currentNode);
      if (!picks.some((p) => p.id === action.nodeId)) {
        throw new Error(
          `node ${action.nodeId} is not a valid pick from current ${state.currentNode ?? "start"}`,
        );
      }
      const node = nodeById(state.map, action.nodeId);
      if (!node) throw new Error(`unknown node ${action.nodeId}`);
      const next: ExpeditionState = { ...state, currentNode: action.nodeId };
      const dispatch = dispatchForNode(node);
      return { state: next, dispatch };
    }

    case "resolve": {
      if (state.status !== "active") {
        throw new Error(`cannot resolve — expedition is ${state.status}`);
      }
      const resolved = { ...state.resolved, [action.nodeId]: action.outcome };
      const node = nodeById(state.map, action.nodeId);
      if (node && node.kind === "boss") {
        return {
          state: { ...state, resolved, status: "completed" },
          dispatch: { kind: "complete_expedition" },
        };
      }
      return { state: { ...state, resolved }, dispatch: null };
    }
  }
}

function dispatchForNode(node: ExpeditionNode): Dispatch | null {
  switch (node.kind) {
    case "combat":
      return { kind: "spawn_combat", nodeId: node.id, tier: "standard" };
    case "elite":
      return { kind: "spawn_combat", nodeId: node.id, tier: "elite" };
    case "boss":
      return { kind: "spawn_combat", nodeId: node.id, tier: "boss" };
    case "event":
      return { kind: "spawn_event", nodeId: node.id };
    case "shrine":
      return { kind: "spawn_shrine", nodeId: node.id };
    case "camp":
      return { kind: "spawn_camp", nodeId: node.id };
    case "treasure":
      return { kind: "spawn_treasure", nodeId: node.id };
    case "start":
      return null;
  }
}

// ---------- frequency summary (test helper) ----------

export interface KindCounts {
  combat: number;
  elite: number;
  event: number;
  shrine: number;
  camp: number;
  treasure: number;
  boss: number;
  start: number;
}

export function countKinds(map: ExpeditionMap): KindCounts {
  const c: KindCounts = {
    combat: 0,
    elite: 0,
    event: 0,
    shrine: 0,
    camp: 0,
    treasure: 0,
    boss: 0,
    start: 0,
  };
  for (const n of map.nodes) {
    c[n.kind] += 1;
  }
  return c;
}
