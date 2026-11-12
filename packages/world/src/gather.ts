// Gathering: three short, solo, push-your-luck outings at the Harbor's edges
// that pay hut materials. Fishing off the shore (Dexterity), felling in the
// tree line (Strength) and the quarry (Vitality).
//
// Pure functions. An outing is a GatherState made from a seed; the player
// either pushes on (one rollCheck against their stat) or banks what they
// have. The server holds the state: `gatherView` is what a client may see,
// and leaves out the seed, the RNG and anything still hidden.

import type { StatKey } from "@gantt-quest/core";
import { rollCheck, statPct, MIN_PCT, type CheckResult } from "./check";
import type { ResourceKind, Resources } from "./hut";
import { makeRng, type Rng } from "./rng";

export type GatherSpot = "fishing" | "felling" | "quarry";
export const GATHER_SPOT_IDS: GatherSpot[] = ["fishing", "felling", "quarry"];

export interface GatherSpotDef {
  id: GatherSpot;
  name: string;
  stat: StatKey;
  /** What it can pay. The first is what a banked, empty haul is topped up with. */
  pays: ResourceKind[];
  blurb: string;
}

export const GATHER_SPOTS: Record<GatherSpot, GatherSpotDef> = {
  fishing: {
    id: "fishing",
    name: "Fishing off the shore",
    stat: "dex",
    pays: ["bone", "copper"],
    blurb: "Each reel brings more in, and the line pulls tighter every time. If both rolls miss, it snaps and the catch is gone.",
  },
  felling: {
    id: "felling",
    name: "Felling in the tree line",
    stat: "str",
    pays: ["wood", "fur"],
    blurb: "Pick a tree to fell. Two of the nine are rotten: unless both rolls land, one comes down on your pile. A felled tree tells you how many rotten ones stand next to it.",
  },
  quarry: {
    id: "quarry",
    name: "The quarry",
    stat: "vit",
    pays: ["stone", "iron", "copper"],
    blurb: "Each strike is two rolls. A hit breaks a piece loose; a miss cracks the roof. Three cracks and it caves in on the lot.",
  },
};

/** Rolls in every gathering check. */
export const GATHER_ROLLS = 2;
/** Pushes before an outing ends by itself with the haul banked. */
export const GATHER_MAX_STEPS = 4;
/** The most one outing can pay: about one fight's worth (three enemies at 1 to 3 units each). */
export const GATHER_MAX_UNITS = GATHER_ROLLS * GATHER_MAX_STEPS;
/** Banking always pays at least this much. */
export const GATHER_MIN_BANK = 1;
/** Outings a player may start per UTC day, across all spots. */
export const GATHER_DAILY_OUTINGS = 3;

/** Fishing: percentage points each reel takes off the next one. */
export const FISHING_TENSION = 5;
/** Felling: a square grid of trees, some rotten, some with a den that pays fur. */
export const FELLING_SIDE = 3;
export const FELLING_ROTTEN = 2;
export const FELLING_DENS = 2;
/** Quarry: missed rolls the roof can take. */
export const QUARRY_MAX_CRACKS = 3;

type TreeKind = "sound" | "den" | "rotten";

export interface GatherEntry {
  text: string;
  check: CheckResult | null;
  gained: Resources;
}

export interface GatherState {
  spot: GatherSpot;
  seed: number;
  /** Seeded RNG state, advanced by every check. */
  rng: number;
  /** Chance per roll before anything the outing itself does to it. */
  pct: number;
  status: "active" | "banked" | "bust";
  /** Pushes made so far. */
  step: number;
  haul: Resources;
  log: GatherEntry[];
  /** Felling: what each tree is, and which have been picked. */
  trees: TreeKind[];
  picked: number[];
  /** Quarry: cracks in the roof. */
  cracks: number;
}

export type GatherChoice =
  /** Reel, fell or strike. `cell` is the tree to fell, 0 to 8, row by row. */
  | { t: "push"; cell?: number }
  | { t: "bank" };

/** A tree as the client sees it. Unpicked trees say nothing until the outing is over. */
export interface TreeView {
  picked: boolean;
  kind: TreeKind | null;
  /** For a picked tree that was not rotten: rotten trees next to it, diagonals included. */
  near: number | null;
}

export interface GatherView {
  spot: GatherSpot;
  status: GatherState["status"];
  step: number;
  maxSteps: number;
  /** Chance per roll of the next push. */
  pct: number;
  rolls: number;
  haul: Resources;
  /** What the outing paid. Empty until it is over. */
  payout: Resources;
  log: GatherEntry[];
  trees: TreeView[] | null;
  cracks: number | null;
  maxCracks: number | null;
}

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

function shuffled<T>(rng: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Begin an outing. `stat` is the hero's value for the spot's stat, gear included. */
export function startGather(spot: GatherSpot, seed: number, stat: number): GatherState {
  const rng = makeRng(seed);
  let trees: TreeKind[] = [];
  if (spot === "felling") {
    const cells = FELLING_SIDE * FELLING_SIDE;
    trees = shuffled(rng, [
      ...Array<TreeKind>(FELLING_ROTTEN).fill("rotten"),
      ...Array<TreeKind>(FELLING_DENS).fill("den"),
      ...Array<TreeKind>(cells - FELLING_ROTTEN - FELLING_DENS).fill("sound"),
    ]);
  }
  return { spot, seed: seed >>> 0, rng: rng.state(), pct: statPct(stat), status: "active", step: 0, haul: {}, log: [], trees, picked: [], cracks: 0 };
}

/** Chance per roll of the next push. Only fishing changes it as the outing goes on. */
export function gatherPct(state: Pick<GatherState, "spot" | "pct" | "step">): number {
  return state.spot === "fishing" ? Math.max(MIN_PCT, state.pct - FISHING_TENSION * state.step) : state.pct;
}

function rottenNear(trees: readonly TreeKind[], cell: number): number {
  const row = Math.floor(cell / FELLING_SIDE);
  const col = cell % FELLING_SIDE;
  let n = 0;
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (r < 0 || c < 0 || r >= FELLING_SIDE || c >= FELLING_SIDE || (r === row && c === col)) continue;
      if (trees[r * FELLING_SIDE + c] === "rotten") n++;
    }
  }
  return n;
}

/** `n` units, each drawn from weighted kinds. */
function draw(rng: Rng, n: number, weights: [ResourceKind, number][]): Resources {
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const out: Resources = {};
  for (let i = 0; i < n; i++) {
    let roll = rng.next() * total;
    const kind = (weights.find(([, w]) => (roll -= w) < 0) ?? weights[0])[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface GatherStep {
  state: GatherState;
  /** Set when the choice was refused; the state is then unchanged. */
  error?: string;
}

/** Apply one choice. Never mutates `state`. */
export function stepGather(state: GatherState, choice: GatherChoice): GatherStep {
  if (state.status !== "active") return { state, error: "That outing is over." };
  if (choice.t === "bank") {
    const empty = units(state.haul) === 0;
    return { state: { ...state, status: "banked", log: [...state.log, { text: empty ? "You head back with what little you can carry." : "You pack up and head back.", check: null, gained: {} }] } };
  }
  if (choice.t !== "push") return { state, error: "Unknown choice." };

  const def = GATHER_SPOTS[state.spot];
  const rng = makeRng(state.rng);
  const next: GatherState = { ...state, haul: { ...state.haul }, log: [...state.log], picked: [...state.picked], step: state.step + 1 };
  const roll = (label: string) => rollCheck(rng, { label, stat: def.stat, pct: gatherPct(state), count: GATHER_ROLLS });
  let check: CheckResult;
  let gained: Resources = {};
  let text: string;
  let bust = false;

  if (state.spot === "fishing") {
    check = roll(`Reel ${next.step}`);
    if (check.fumble) {
      bust = true;
      text = "The line snaps. Everything on it is gone.";
    } else {
      gained = draw(rng, check.successes, [["bone", 65], ["copper", 35]]);
      text = check.perfect ? "A clean pull: two more on the bank." : "One more on the bank. The line hums.";
    }
  } else if (state.spot === "felling") {
    const cell = Number(choice.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= state.trees.length) return { state, error: "Pick a tree." };
    if (state.picked.includes(cell)) return { state, error: "That tree is already down." };
    next.picked.push(cell);
    const kind = state.trees[cell];
    check = roll(`Tree ${next.step}`);
    if (kind === "rotten") {
      if (check.perfect) text = "Rotten through. You drop it clear of the pile and get nothing from it.";
      else {
        bust = true;
        text = "Rotten through. It twists as it falls and smashes the pile.";
      }
    } else {
      const what: ResourceKind = kind === "den" ? "fur" : "wood";
      if (check.successes > 0) gained = { [what]: check.successes };
      const near = `${plural(rottenNear(state.trees, cell), "rotten tree")} next to it.`;
      text = check.fumble ? `The axe glances off and the trunk splits to nothing. ${near}`
        : kind === "den" ? `An old den in the roots, lined with fur. ${near}`
        : `Down it comes. ${near}`;
    }
  } else {
    check = roll(`Strike ${next.step}`);
    next.cracks = state.cracks + (GATHER_ROLLS - check.successes);
    if (next.cracks >= QUARRY_MAX_CRACKS) {
      bust = true;
      text = "The roof lets go. The seam and everything you cut are under it.";
    } else {
      gained = draw(rng, check.successes, [["stone", 60], ["iron", 25], ["copper", 15]]);
      text = check.perfect ? "Two clean pieces come away." : check.fumble ? "Nothing but dust, and the roof groans." : "One piece comes away, and a crack runs overhead.";
    }
  }

  next.rng = rng.state();
  if (bust) {
    next.status = "bust";
    next.haul = {};
  } else {
    for (const [kind, n] of Object.entries(gained) as [ResourceKind, number][]) next.haul[kind] = (next.haul[kind] ?? 0) + n;
  }
  next.log.push({ text, check, gained });
  if (!bust && next.step >= GATHER_MAX_STEPS) {
    next.status = "banked";
    next.log.push({ text: state.spot === "fishing" ? "The last of it is landed." : state.spot === "felling" ? "Your arms are done for the day." : "The seam is worked out.", check: null, gained: {} });
  }
  return { state: next };
}

/**
 * What an outing pays. Nothing while it is still going or after a bust; a
 * banked haul pays itself, and never less than GATHER_MIN_BANK.
 */
export function gatherPayout(state: GatherState): Resources {
  if (state.status !== "banked") return {};
  const out: Resources = {};
  let left = GATHER_MAX_UNITS;
  for (const kind of GATHER_SPOTS[state.spot].pays) {
    const n = Math.min(left, Math.max(0, Math.floor(state.haul[kind] ?? 0)));
    if (n > 0) out[kind] = n;
    left -= n;
  }
  if (units(out) < GATHER_MIN_BANK) out[GATHER_SPOTS[state.spot].pays[0]] = GATHER_MIN_BANK;
  return out;
}

/** What the client is shown: no seed, no RNG, and no tree it has not earned a look at. */
export function gatherView(state: GatherState): GatherView {
  const over = state.status !== "active";
  return {
    spot: state.spot,
    status: state.status,
    step: state.step,
    maxSteps: GATHER_MAX_STEPS,
    pct: gatherPct(state),
    rolls: GATHER_ROLLS,
    haul: { ...state.haul },
    payout: gatherPayout(state),
    log: state.log,
    trees: state.spot !== "felling" ? null : state.trees.map((kind, cell) => {
      const picked = state.picked.includes(cell);
      return { picked, kind: picked || over ? kind : null, near: picked && kind !== "rotten" ? rottenNear(state.trees, cell) : null };
    }),
    cracks: state.spot === "quarry" ? state.cracks : null,
    maxCracks: state.spot === "quarry" ? QUARRY_MAX_CRACKS : null,
  };
}

// ---------- stamina ----------

/** The UTC day a moment belongs to, as YYYY-MM-DD. Stamina resets when it changes. */
export const gatherDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The next UTC midnight after `now`, in ms. */
export const gatherResetAt = (now: number): number => (Math.floor(now / 86_400_000) + 1) * 86_400_000;

/** Outings a player can still start today, given the day and count last stored for them. */
export function outingsLeft(record: { day: string; used: number } | null | undefined, now: number): number {
  if (!record || record.day !== gatherDay(now)) return GATHER_DAILY_OUTINGS;
  return Math.max(0, GATHER_DAILY_OUTINGS - record.used);
}
