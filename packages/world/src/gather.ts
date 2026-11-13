// Gathering: three short, solo, push-your-luck outings at the Harbor's edges
// that pay hut materials. Fishing off the shore (Dexterity), felling in the
// tree line (Strength) and the quarry (Vitality).
//
// Each one gives the player something to read. Felling: the wind, fungus on
// a trunk, and a knock on the bark; the grove (grove.ts) decides where a
// felled tree comes down. Fishing: every cast says how near the
// school was and which way, and the school drifts. The quarry is played
// differently: thirty seconds at a rock face hunting for the glinting seam
// (mine.ts). The hero's stat sets the chance of each roll; reading the signs
// well decides what those rolls are spent on.
//
// Pure functions. An outing is a GatherState made from a seed; the player
// either pushes on (one rollCheck against their stat) or banks what they
// have. The server holds the state: `gatherView` is what a client may see,
// and leaves out the seed, the RNG and anything still hidden.

import type { StatKey } from "@gantt-quest/core";
import { rollCheck, statPct, MAX_PCT, MIN_PCT, type CheckResult } from "./check";
import type { ResourceKind, Resources } from "./hut";
import { makeRng, type Rng } from "./rng";
import { MINE_CHARGE_MS, landBlows, mineView, rockYield, seedMine, type Blow, type MineState, type MineView } from "./mine";
import { DIR_NAMES, GROVE_KNOCKS, NOTCH_DIRS, fallDir, fallOutcome, isDir8, seedGrove, shiftWind, type Dir8, type Fall, type Grove, type Wind } from "./grove";

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
    blurb: "Pick where to cast. Each cast tells you how near the school was and which way; it drifts a little between casts. Over the school your rolls are better, far from it worse. The line pulls tighter every cast, and if both rolls miss it snaps and the catch is gone.",
  },
  felling: {
    id: "felling",
    name: "Felling in the tree line",
    stat: "str",
    pays: ["wood", "fur"],
    blurb: "Pick a tree, the side to notch it, then stop the axe on the mark. A clean swing drops it where you notched it; a poor one lets the wind carry it round. It must land clear: in a standing tree it hangs up, in the creek it washes away, and on your log pile it smashes the lot unless both rolls land. Two of the nine are rotten and pay nothing; knock to tell.",
  },
  quarry: {
    id: "quarry",
    name: "The quarry",
    stat: "vit",
    pays: ["stone", "iron", "copper", "gem"],
    blurb: "Thirty seconds at the rock face. Somewhere in it a seam of ore runs across, and it glints through the junk around it (though loose mica glints too). Tap the pick for a quick blow; hold it to charge a heavy one that cracks the rocks around as well. Rubble breaks easily and sometimes gives stone; hard rock wants a charged swing. Breaking a rock shows what is in the ones beside it, so follow the seam once you find it. Mind what is above: a gap brings the rocks over it down, and one the fall breaks is lost with whatever was in it. Gems are rare: look for the sparkle.",
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
/** Fishing: places to cast, in a row along the shore. */
export const FISHING_CELLS = 5;
/** Fishing: points added to each roll when the cast lands on the school, and taken off when it is two or more away. */
export const FISHING_READ = 15;
// ---------- timing ----------
//
// Fishing and the quarry are timed. Having chosen where, the player stops a
// marker moving along a bar, and how close it is to the mark shifts the
// chance of each roll. The marker's motion is set by the server from the
// outing's seed; the server also times the stop itself, and only believes the
// moment the client reports within a round trip of what it saw.

/** How a marker moves: a fish darting about a line, or a pick swinging back and forth. */
export interface Motion {
  kind: "dart" | "swing";
  /** Milliseconds for one full cycle. */
  period: number;
  /** Where in its cycle the marker starts, 0 to 1. */
  phase: number;
  /** The mark: its centre on the bar (0 to 1) and its full width. */
  zone: number;
  width: number;
}

/** What a stop was worth: how it is named, and the points it adds to each roll. */
export const TIMING = {
  perfect: { label: "Perfect", bonus: 20 },
  good: { label: "Good", bonus: 10 },
  close: { label: "Close", bonus: 0 },
  miss: { label: "Missed", bonus: -15 },
  late: { label: "Too slow", bonus: -15 },
} as const;
export type TimingGrade = keyof typeof TIMING;
/** Longer than this and the moment has passed. */
export const TIMING_LIMIT_MS = 10_000;

/**
 * How much a hero's stat eases the timing. `pct` is their chance per roll for the spot's stat (20 to 95):
 * the weakest get a mark 0.7 times as wide and a marker 0.85 times as slow; the strongest 1.4 and 1.25.
 */
export function timingEase(pct: number): { width: number; pace: number } {
  const t = Math.max(0, Math.min(1, (pct - 20) / 75));
  return { width: 0.7 + 0.7 * t, pace: 0.85 + 0.4 * t };
}

/** Where the marker is on the bar, 0 to 1, `ms` after it started moving. */
export function markerAt(m: Motion, ms: number): number {
  const turn = ms / m.period + m.phase;
  if (m.kind === "swing") return 0.5 - 0.5 * Math.cos(2 * Math.PI * turn);
  // A fish: a long run back and forth with a quicker flick on top.
  const x = 0.5 + 0.4 * Math.sin(2 * Math.PI * turn) + 0.08 * Math.sin(2 * Math.PI * turn * 2.7 + m.phase * 9);
  return Math.max(0, Math.min(1, x));
}

/** How good a stop `ms` after the start was. No moment at all (an outing from before timing) counts as close. */
export function timingGrade(m: Motion, ms: number | undefined): TimingGrade {
  if (ms === undefined || !Number.isFinite(ms)) return "close";
  if (ms > TIMING_LIMIT_MS) return "late";
  const off = Math.abs(markerAt(m, ms) - m.zone);
  if (off <= m.width * 0.18) return "perfect";
  if (off <= m.width / 2) return "good";
  if (off <= m.width) return "close";
  return "miss";
}

type TreeKind = "sound" | "den" | "rotten";
/** How a cast landed: on the school, one place off, or further. */
export type FishRead = "on" | "near" | "far";

export interface Cast {
  cell: number;
  read: FishRead;
  /** Which way the school lay from the cast: -1 west, 1 east, 0 right there. */
  dir: -1 | 0 | 1;
}

export interface GatherEntry {
  text: string;
  check: CheckResult | null;
  gained: Resources;
  /** How well a timed stop went. */
  timing?: TimingGrade;
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
  /** Quarry, before the rock face: cracks in the roof and the old 3×3 face. Such an outing can only be hauled out. */
  cracks?: number;
  face?: unknown;
  /** Quarry: the rock face and its clock. */
  mine?: MineState;
  /** Fishing: where the school is now (hidden), where the gulls were at the start, and each cast so far. */
  water?: { school: number; gulls: number; casts: Cast[] };
  /** Where the player has chosen (and, felling, the side notched), and the marker they now have to stop. Cleared by the stop. */
  aim?: { cell: number; startedAt: number; motion: Motion; dir?: Dir8 };
  /** Felling: heights, fungus, the wind, knocks and falls. Missing on outings from before the grove. */
  grove?: Grove;
  /** Set on outings that are timed. Older outings in progress are played without it. */
  timed?: boolean;
}

export type GatherChoice =
  /**
   * Choose where (a place along the shore, 0 to 4, a block or a tree, 0 to 8) and set the marker moving.
   * Felling also names the side to notch (`dir`: 0 north, 2 east, 4 south, 6 west). `now` is the server's
   * clock, filled in by the server.
   */
  | { t: "aim"; cell: number; dir?: number; now?: number }
  /** Stop the marker. `at` is how long after it started, in ms, as the server has judged it. */
  | { t: "push"; cell?: number; at?: number }
  /** Felling: knock on a tree to tell what it is. Free, a few times an outing. */
  | { t: "knock"; cell: number }
  /** Quarry: ready at the face; the clock starts now (`now` is the server's clock, filled in by the server). */
  | { t: "dig"; now?: number }
  /** Quarry: the blows struck since the last report, each with when it landed. `now` is the server's clock. */
  | { t: "blows"; blows: Blow[]; now?: number }
  | { t: "bank" };

/** A tree as the client sees it. What it is stays hidden until it is knocked, felled, or the outing is over. */
export interface GroveTreeView {
  picked: boolean;
  kind: TreeKind | null;
  tall: boolean;
  fungus: boolean;
  knocked: boolean;
  fall: Fall | null;
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
  /** Felling: the grove, its wind and knocks. Null elsewhere, and on a felling outing from before the grove. */
  grove: { trees: GroveTreeView[]; wind: Wind; knocksLeft: number } | null;
  /** Quarry: the rock face, its glints, and the clock. Null elsewhere, and on a quarry outing from before the face. */
  mine: MineView | null;
  /** The marker to stop, while one is moving. The client starts it when it receives this. */
  aim: { cell: number; motion: Motion; dir: Dir8 | null } | null;
  /** Fishing: where the gulls were circling at the start (within one place of the school), each cast, and the school itself once it is over. */
  water: { cells: number; gulls: number; casts: Cast[]; school: number | null; read: number } | null;
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
  let grove: Grove | undefined;
  if (spot === "felling") {
    const cells = FELLING_SIDE * FELLING_SIDE;
    trees = shuffled(rng, [
      ...Array<TreeKind>(FELLING_ROTTEN).fill("rotten"),
      ...Array<TreeKind>(FELLING_DENS).fill("den"),
      ...Array<TreeKind>(cells - FELLING_ROTTEN - FELLING_DENS).fill("sound"),
    ]);
    grove = seedGrove(rng, trees.map((k) => k === "rotten"));
  }
  // Vitality charges the pick quicker: the same easing that widens the other spots' marks.
  const mine = spot === "quarry" ? seedMine(rng, MINE_CHARGE_MS / timingEase(statPct(stat)).pace) : undefined;
  let water: GatherState["water"];
  if (spot === "fishing") {
    const school = rng.int(0, FISHING_CELLS - 1);
    water = { school, gulls: Math.max(0, Math.min(FISHING_CELLS - 1, school + rng.int(-1, 1))), casts: [] };
  }
  return { spot, seed: seed >>> 0, rng: rng.state(), pct: statPct(stat), status: "active", step: 0, haul: {}, log: [], trees, picked: [], water, grove, mine, timed: true };
}

/** Chance per roll of the next push, before what the cast's place does to it. Only fishing changes it as the outing goes on. */
export function gatherPct(state: Pick<GatherState, "spot" | "pct" | "step">): number {
  return state.spot === "fishing" ? Math.max(MIN_PCT, state.pct - FISHING_TENSION * state.step) : state.pct;
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
  // A felling outing from before the grove can only be carried home.
  if (state.spot === "felling" && !state.grove) return { state, error: "The light has gone on this stand. Carry it home." };
  if (state.spot === "quarry") return mineStep(state, choice);
  if (choice.t === "knock") return knock(state, choice.cell);
  if (choice.t === "aim") {
    if (!state.timed) return { state, error: "Unknown choice." };
    if (state.aim) return { state, error: "Stop the one you have going first." };
    const cell = Number(choice.cell);
    if (state.spot === "fishing" && !(Number.isInteger(cell) && cell >= 0 && cell < FISHING_CELLS)) return { state, error: "Pick a place to cast." };
    let dir: Dir8 | undefined;
    if (state.spot === "felling") {
      if (!Number.isInteger(cell) || cell < 0 || cell >= state.trees.length) return { state, error: "Pick a tree." };
      if (state.picked.includes(cell)) return { state, error: "That tree is already down." };
      const d = Number(choice.dir);
      if (!isDir8(d) || !NOTCH_DIRS.includes(d)) return { state, error: "Pick the side to notch it." };
      dir = d;
    }
    const r = makeRng(state.rng);
    // The hero's stat for the spot (Dexterity for fishing) makes the mark wider and the marker slower.
    const { width, pace } = timingEase(state.pct);
    const motion: Motion =
      state.spot === "fishing"
        ? // The fish gets livelier with every cast, as the line tightens.
          { kind: "dart", period: Math.round(Math.max(800, 1700 - 200 * state.step) * pace), phase: r.next(), zone: 0.3 + r.next() * 0.4, width: 0.18 * width }
        : { kind: "swing", period: Math.round(1500 * pace), phase: r.next(), zone: 0.15 + r.next() * 0.7, width: 0.16 * width };
    return { state: { ...state, rng: r.state(), aim: { cell, startedAt: Math.floor(Number(choice.now) || 0), motion, ...(dir !== undefined ? { dir } : {}) } } };
  }
  if (choice.t !== "push") return { state, error: "Unknown choice." };
  if (state.timed && !state.aim) return { state, error: state.spot === "fishing" ? "Pick a place to cast." : "Pick a tree and the side to notch it." };
  // A timed stop shifts every roll of this check; an untimed push (felling, or an older outing) does not.
  const timing = state.aim ? timingGrade(state.aim.motion, choice.at) : undefined;
  const bonus = timing ? TIMING[timing].bonus : 0;
  if (state.aim) choice = { ...choice, cell: state.aim.cell };

  const def = GATHER_SPOTS[state.spot];
  const rng = makeRng(state.rng);
  const next: GatherState = { ...state, aim: undefined, haul: { ...state.haul }, log: [...state.log], picked: [...state.picked], step: state.step + 1 };
  const roll = (label: string) => rollCheck(rng, { label, stat: def.stat, pct: Math.max(MIN_PCT, Math.min(MAX_PCT, gatherPct(state) + bonus)), count: GATHER_ROLLS });
  let check!: CheckResult;
  let gained: Resources = {};
  let text = "";
  let bust = false;

  if (state.spot === "fishing") {
    // An outing saved before casts had places is fished from the middle.
    const water = state.water ?? { school: Math.floor(FISHING_CELLS / 2), gulls: Math.floor(FISHING_CELLS / 2), casts: [] };
    const asked = Number(choice.cell);
    const cell = Number.isInteger(asked) && asked >= 0 && asked < FISHING_CELLS ? asked : (water.casts.at(-1)?.cell ?? water.gulls);
    const off = water.school - cell;
    const read: FishRead = off === 0 ? "on" : Math.abs(off) === 1 ? "near" : "far";
    const dir = Math.sign(off) as -1 | 0 | 1;
    const pct = Math.max(MIN_PCT, Math.min(MAX_PCT, gatherPct(state) + bonus + (read === "on" ? FISHING_READ : read === "far" ? -FISHING_READ : 0)));
    check = rollCheck(rng, { label: `Cast ${next.step}`, stat: def.stat, pct, count: GATHER_ROLLS });
    const where = dir < 0 ? "west" : "east";
    if (check.fumble) {
      bust = true;
      text = "The line snaps. Everything on it is gone.";
    } else {
      // Over the school there is one more on the hook.
      gained = draw(rng, check.successes + (read === "on" ? 1 : 0), [["bone", 65], ["copper", 35]]);
      text = read === "on" ? "Right over the school: the float goes straight under."
        : read === "near" ? `Close. The water is boiling just to the ${where}.`
        : `Quiet water here. The gulls are working well to the ${where}.`;
    }
    // The school wanders a place at most between casts.
    const drift = rng.pick([-1, 0, 0, 1]);
    next.water = { school: Math.max(0, Math.min(FISHING_CELLS - 1, water.school + drift)), gulls: water.gulls, casts: [...water.casts, { cell, read, dir }] };
  } else {
    const grove = state.grove!;
    const cell = state.aim!.cell;
    const aimed = state.aim!.dir ?? 4;
    next.picked.push(cell);
    const kind = state.trees[cell];
    check = roll(`Tree ${next.step}`);
    const dir = fallDir(aimed, grove.wind, timing ?? "close", kind === "rotten", rng);
    const outcome = fallOutcome(cell, dir, grove.tall[cell] ? 2 : 1, state.picked);
    const turned = dir === aimed ? "" : kind === "rotten" ? `It goes ${DIR_NAMES[dir]}. ` : `The wind takes it ${DIR_NAMES[dir]}. `;
    const rot = kind === "rotten" ? "Rotten through, it twists as it goes. " : "";
    if (outcome === "pile") {
      if (check.perfect) text = `${rot}${turned}It comes down across the pile, but you had it under control: not a log out of place.`;
      else {
        bust = true;
        text = `${rot}${turned}It comes down on the pile and smashes the lot.`;
      }
    } else if (outcome === "hung") text = `${rot}${turned}It hangs up in the next tree and won't come free.`;
    else if (outcome === "creek") text = `${rot}${turned}It drops in the creek and the water takes it.`;
    else if (kind === "rotten") text = `${rot}${turned}It lands clear, but there is nothing in it worth carrying.`;
    else {
      const what: ResourceKind = kind === "den" ? "fur" : "wood";
      const n = check.successes + (check.successes > 0 && grove.tall[cell] ? 1 : 0);
      if (n > 0) gained = { [what]: n };
      text = check.fumble ? `${turned}It lands clear, but the axe split it to kindling.`
        : kind === "den" ? `${turned}Down it comes, and an old den in the roots is lined with fur.`
        : `${turned}Timber! It lands clear${grove.tall[cell] ? ", a good long trunk" : ""}.`;
    }
    next.grove = { ...grove, falls: { ...grove.falls, [cell]: { aimed, dir, outcome } }, wind: shiftWind(grove.wind, rng) };
  }

  next.rng = rng.state();
  if (bust) {
    next.status = "bust";
    next.haul = {};
  } else {
    for (const [kind, n] of Object.entries(gained) as [ResourceKind, number][]) next.haul[kind] = (next.haul[kind] ?? 0) + n;
  }
  next.log.push({ text, check, gained, ...(timing ? { timing } : {}) });
  if (!bust && next.step >= GATHER_MAX_STEPS) {
    next.status = "banked";
    next.log.push({ text: state.spot === "fishing" ? "The light is going. You land the last of it." : "Your arms are done for the day.", check: null, gained: {} });
  }
  return { state: next };
}

const FIND_TEXT: Record<string, string> = {
  iron: "Iron in the seam.",
  copper: "Copper, bright in the cut.",
  gem: "A gem, loose in the ore!",
};

/** Quarry: start the clock, or land the blows struck since the last report and roll what each broken rock gives. */
function mineStep(state: GatherState, choice: GatherChoice): GatherStep {
  const mine = state.mine;
  if (!mine) return { state, error: "This face was cut the old way. Haul out what you have and start again." };
  if (choice.t === "dig") {
    if (mine.startedAt !== null) return { state, error: "The clock is already running." };
    return { state: { ...state, mine: { ...mine, startedAt: Math.floor(Number(choice.now) || 0) } } };
  }
  if (choice.t !== "blows") return { state, error: "Swing the pick at the face." };
  const now = Number(choice.now);
  const landed = landBlows(mine, choice.blows, Number.isFinite(now) && mine.startedAt !== null ? now - mine.startedAt : Infinity);
  if (typeof landed === "string") return { state, error: landed };
  const rng = makeRng(state.rng);
  const next: GatherState = { ...state, haul: { ...state.haul }, log: [...state.log], step: state.step + landed.broken.filter((id) => !landed.mine.rocks[id].lost).length, mine: landed.mine };
  for (const id of landed.broken) {
    const rock = landed.mine.rocks[id];
    if (rock.lost) {
      if (rock.kind === "geode") next.log.push({ text: "The geode came down and burst on the floor. The gems in it are dust.", check: null, gained: {} });
      else if (rock.kind === "seam") next.log.push({ text: "A piece of the seam came down and smashed. Its ore is lost.", check: null, gained: {} });
      continue;
    }
    const got = rockYield(rng, rock);
    rock.got = got;
    for (const [kind, n] of Object.entries(got) as [ResourceKind, number][]) next.haul[kind] = (next.haul[kind] ?? 0) + n;
    if (rock.kind === "geode") next.log.push({ text: `A geode! It splits open on ${plural(got.gem ?? 0, "gem")}.`, check: null, gained: got });
    else if (rock.kind === "seam") {
      const kind = Object.keys(got)[0];
      next.log.push({ text: FIND_TEXT[kind] ?? "Ore in the seam.", check: null, gained: got });
    }
  }
  next.rng = rng.state();
  return { state: next };
}

/** Felling: knock on a standing tree. Says what it is; uses up one of the outing's knocks and nothing else. */
function knock(state: GatherState, asked: number): GatherStep {
  if (state.spot !== "felling" || !state.grove) return { state, error: "There is nothing to knock on here." };
  if (state.aim) return { state, error: "Swing first." };
  const cell = Number(asked);
  if (!Number.isInteger(cell) || cell < 0 || cell >= state.trees.length) return { state, error: "Pick a tree." };
  if (state.picked.includes(cell)) return { state, error: "That tree is already down." };
  if (state.grove.knocked.includes(cell)) return { state, error: "You have knocked on that one." };
  if (state.grove.knocked.length >= GROVE_KNOCKS) return { state, error: "Your knuckles are raw. No more knocking." };
  const kind = state.trees[cell];
  const text = kind === "rotten" ? "Bonk. Hollow: it's rotten." : kind === "den" ? "Tok, and something scurries in the roots." : "Tok. Sound wood.";
  return { state: { ...state, grove: { ...state.grove, knocked: [...state.grove.knocked, cell] }, log: [...state.log, { text, check: null, gained: {} }] } };
}

/**
 * What an outing pays. Nothing while it is still going or after a bust; a
 * banked haul pays itself, and never less than GATHER_MIN_BANK.
 */
export function gatherPayout(state: GatherState): Resources {
  if (state.status !== "banked") return {};
  const out: Resources = {};
  let left = GATHER_MAX_UNITS;
  // At the quarry the cap keeps the rarest finds: a gem is never left behind for a piece of stone.
  const pays = GATHER_SPOTS[state.spot].pays;
  for (const kind of state.spot === "quarry" ? [...pays].reverse() : pays) {
    const n = Math.min(left, Math.max(0, Math.floor(state.haul[kind] ?? 0)));
    if (n > 0) out[kind] = n;
    left -= n;
  }
  if (units(out) < GATHER_MIN_BANK) out[GATHER_SPOTS[state.spot].pays[0]] = GATHER_MIN_BANK;
  return out;
}

/** What the client is shown: no seed, no RNG, and no tree it has not earned a look at. `now` sets the quarry's clock. */
export function gatherView(state: GatherState, now?: number): GatherView {
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
    grove: !state.grove ? null : {
      trees: state.trees.map((kind, cell) => {
        const picked = state.picked.includes(cell);
        const knocked = state.grove!.knocked.includes(cell);
        return { picked, kind: picked || knocked || over ? kind : null, tall: state.grove!.tall[cell], fungus: state.grove!.fungus[cell], knocked, fall: state.grove!.falls[cell] ?? null };
      }),
      wind: state.grove.wind,
      knocksLeft: Math.max(0, GROVE_KNOCKS - state.grove.knocked.length),
    },
    mine: state.mine ? mineView(state.mine, over, now) : null,
    aim: state.aim ? { cell: state.aim.cell, motion: state.aim.motion, dir: state.aim.dir ?? null } : null,
    water: !state.water ? null : { cells: FISHING_CELLS, gulls: state.water.gulls, casts: state.water.casts, school: over ? state.water.school : null, read: FISHING_READ },
  };
}

// ---------- resting ----------

/** How long a player must wait between rests. */
export const REST_COOLDOWN_MS = 20 * 60 * 1000;
/**
 * Outings a rest gives back: one on a bedroll under the sky; in a shack of
 * your own, all of them. Both wait out the same cooldown.
 */
export const REST_OUTINGS = { bedroll: 1, hut: GATHER_DAILY_OUTINGS } as const;
export type RestPlace = keyof typeof REST_OUTINGS;

/** When a player who last rested at `restedAt` may rest again, in ms. Zero if they never have. */
export const restReadyAt = (restedAt: number | null | undefined): number => (restedAt ? restedAt + REST_COOLDOWN_MS : 0);

/** Why a rest would do nothing right now, or null if it would help. */
export function restProblem(record: { day: string; used: number; rested_at?: number | null } | null | undefined, now: number): string | null {
  if (outingsLeft(record, now) >= GATHER_DAILY_OUTINGS) return "You are not tired. Rest when you have been out gathering.";
  const ready = restReadyAt(record?.rested_at);
  if (now < ready) return `You have not long been up. You can rest again in ${Math.ceil((ready - now) / 60_000)} min.`;
  return null;
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
