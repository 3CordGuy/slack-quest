// Gathering: three short, solo, push-your-luck outings at the Harbor's edges
// that pay hut materials. Fishing off the shore (Dexterity), felling in the
// tree line (Strength) and the quarry (Vitality).
//
// Fishing gives the player something to read: every cast says how near the
// school was and which way, and the school drifts. The hero's stat sets the
// chance of each roll; reading the signs well decides what those rolls are
// spent on.
//
// Felling and the quarry are different: played in the world, first person,
// against a thirty-second clock. Felling is two rounds, chopping then
// splitting, reported whole (felling.ts); the quarry is a rock face dug for
// the glinting seam, its blows reported as they break rocks (mine.ts).
//
// Pure functions. An outing is a GatherState made from a seed; the player
// either pushes on (one rollCheck against their stat) or banks what they
// have. The server holds the state: `gatherView` is what a client may see,
// and leaves out the seed, the RNG and anything still hidden.

import type { StatKey } from "@gantt-quest/core";
import { rollCheck, statPct, MAX_PCT, MIN_PCT, type CheckResult } from "./check";
import type { ResourceKind, Resources } from "./hut";
import { makeRng, type Rng } from "./rng";
import { FELL_ROUND_MS, MAX_REPORTED, TREES, newFelling, replayChops, replayStrikes, rollLogs, rollWood, splitMotion, type Chop, type FellingState, type FelledTree, type Split } from "./felling";
import { TIMING, timingEase, timingGrade, type Motion, type TimingGrade } from "./timing";
import { MINE_CHARGE_MS, landBlows, mineView, rockYield, seedMine, type Blow, type MineState, type MineView } from "./mine";

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
    pays: ["wood"],
    blurb: "Two rounds of thirty seconds. First chop: three trees, small, medium and large. Small falls fastest; the old oak takes longest but gives the most logs, and a tree still standing at the end gives nothing. Then split: strike each log when the marker is over the split. A perfect is two rolls at a piece of wood, a good is one, and a miss means swinging again.",
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
/** Fishing: places to cast, in a row along the shore. */
export const FISHING_CELLS = 5;
/** Fishing: points added to each roll when the cast lands on the school, and taken off when it is two or more away. */
export const FISHING_READ = 15;

/** What a felling outing from before the two rounds stored: a grid of trees, some rotten, some dens. */
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
  /** Felling, on outings from before the two rounds: what each tree is. Empty now. */
  trees: TreeKind[];
  picked: number[];
  /** Quarry, before the rock face: cracks in the roof and the old 3×3 face. Such an outing can only be hauled out. */
  cracks?: number;
  face?: unknown;
  /** Quarry: the rock face and its clock. */
  mine?: MineState;
  /** Fishing: where the school is now (hidden), where the gulls were at the start, and each cast so far. */
  water?: { school: number; gulls: number; casts: Cast[] };
  /** Fishing: where the player has chosen, and the marker they now have to stop. Cleared by the stop. */
  aim?: { cell: number; startedAt: number; motion: Motion };
  /** Felling: the two rounds. Missing on felling outings from before them, which can only be carried home. */
  felling?: FellingState;
  /** Set on outings that are timed. Older outings in progress are played without it. */
  timed?: boolean;
}

export type GatherChoice =
  /** Fishing: choose where (a place along the shore, 0 to 4) and set the marker moving. `now` is the server's clock, filled in by the server. */
  | { t: "aim"; cell: number; now?: number }
  /** Stop the marker. `at` is how long after it started, in ms, as the server has judged it. */
  | { t: "push"; cell?: number; at?: number }
  /** Felling: start the next round. `now` is the server's clock, filled in by the server. */
  | { t: "begin"; now?: number }
  /** Felling: the chopping round is over; every chop in it, timed from its start. */
  | { t: "chopped"; chops: Chop[]; now?: number }
  /** Felling: the splitting round is over; every strike in it, timed from its start. */
  | { t: "split"; strikes: number[]; now?: number }
  /** Quarry: ready at the face; the clock starts now (`now` is the server's clock, filled in by the server). */
  | { t: "dig"; now?: number }
  /** Quarry: the blows struck since the last report, each with when it landed. `now` is the server's clock. */
  | { t: "blows"; blows: Blow[]; now?: number }
  | { t: "bank" };

/** Felling as the client sees it: the round it is on, what came of the chopping, and the markers for each log. */
export interface FellingView {
  phase: FellingState["phase"];
  roundMs: number;
  felled: { size: FelledTree["size"]; logs: number; check: FelledTree["check"] }[];
  logs: number;
  splits: { grade: Split["grade"]; wood: number; check: Split["check"] }[];
  misses: number;
  wood: number;
  /** The marker over each log, first to last. Shown once there are logs to split. */
  motions: Motion[];
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
  /** Felling: the two rounds. Null elsewhere, and on a felling outing from before them. */
  felling: FellingView | null;
  /** Quarry: the rock face, its glints, and the clock. Null elsewhere, and on a quarry outing from before the face. */
  mine: MineView | null;
  /** The marker to stop, while one is moving. The client starts it when it receives this. */
  aim: { cell: number; motion: Motion } | null;
  /** Fishing: where the gulls were circling at the start (within one place of the school), each cast, and the school itself once it is over. */
  water: { cells: number; gulls: number; casts: Cast[]; school: number | null; read: number } | null;
}

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

/** Begin an outing. `stat` is the hero's value for the spot's stat, gear included. */
export function startGather(spot: GatherSpot, seed: number, stat: number): GatherState {
  const rng = makeRng(seed);
  const trees: TreeKind[] = [];
  // Vitality charges the pick quicker: the same easing that widens fishing's mark.
  const mine = spot === "quarry" ? seedMine(rng, MINE_CHARGE_MS / timingEase(statPct(stat)).pace) : undefined;
  let water: GatherState["water"];
  if (spot === "fishing") {
    const school = rng.int(0, FISHING_CELLS - 1);
    water = { school, gulls: Math.max(0, Math.min(FISHING_CELLS - 1, school + rng.int(-1, 1))), casts: [] };
  }
  return { spot, seed: seed >>> 0, rng: rng.state(), pct: statPct(stat), status: "active", step: 0, haul: {}, log: [], trees, picked: [], water, ...(mine ? { mine } : {}), ...(spot === "felling" ? { felling: newFelling() } : {}), timed: spot === "fishing" };
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
  if (state.spot === "felling") {
    // A felling outing from before the two rounds can only be carried home.
    if (!state.felling) return { state, error: "The light has gone on this stand. Carry it home." };
    return stepFelling(state, state.felling, choice);
  }
  if (state.spot === "quarry") return mineStep(state, choice);
  if (choice.t === "aim") {
    if (!state.timed) return { state, error: "Unknown choice." };
    if (state.aim) return { state, error: "Stop the one you have going first." };
    const cell = Number(choice.cell);
    if (state.spot === "fishing" && !(Number.isInteger(cell) && cell >= 0 && cell < FISHING_CELLS)) return { state, error: "Pick a place to cast." };
    const r = makeRng(state.rng);
    // The hero's Dexterity makes the mark wider and the marker slower.
    const { width, pace } = timingEase(state.pct);
    // The fish gets livelier with every cast, as the line tightens.
    const motion: Motion = { kind: "dart", period: Math.round(Math.max(800, 1700 - 200 * state.step) * pace), phase: r.next(), zone: 0.3 + r.next() * 0.4, width: 0.18 * width };
    return { state: { ...state, rng: r.state(), aim: { cell, startedAt: Math.floor(Number(choice.now) || 0), motion } } };
  }
  if (choice.t !== "push") return { state, error: "Unknown choice." };
  if (state.timed && !state.aim) return { state, error: "Pick a place to cast." };
  // A timed stop shifts every roll of this check; an untimed push (an older outing) does not.
  const timing = state.aim ? timingGrade(state.aim.motion, choice.at) : undefined;
  const bonus = timing ? TIMING[timing].bonus : 0;
  if (state.aim) choice = { ...choice, cell: state.aim.cell };

  const def = GATHER_SPOTS[state.spot];
  const rng = makeRng(state.rng);
  const next: GatherState = { ...state, aim: undefined, haul: { ...state.haul }, log: [...state.log], picked: [...state.picked], step: state.step + 1 };
  let check: CheckResult;
  let gained: Resources = {};
  let text: string;
  let bust = false;

  {
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
    next.log.push({ text: "The light is going. You land the last of it.", check: null, gained: {} });
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

/**
 * Felling: begin a round, or take the report of one that has ended. The
 * server fills in `now`; a report is judged against how long the round has
 * really run, so nothing in it can come from after the request arrived.
 */
function stepFelling(state: GatherState, f: FellingState, choice: GatherChoice): GatherStep {
  const now = "now" in choice ? Number(choice.now) || 0 : 0;
  if (choice.t === "bank") {
    return { state: { ...state, status: "banked", felling: { ...f, phase: "done" }, log: [...state.log, { text: "You leave the axe in the stump and head back.", check: null, gained: {} }] } };
  }
  if (choice.t === "begin") {
    if (f.phase === "ready-chop") return { state: { ...state, felling: { ...f, phase: "chop", startedAt: now } } };
    if (f.phase === "ready-split") return { state: { ...state, felling: { ...f, phase: "split", startedAt: now } } };
    return { state, error: f.phase === "done" ? "That outing is over." : "A round is already under way." };
  }
  // How long the round has run by the server's clock: a report can claim nothing later than this.
  const ran = Math.max(0, now - f.startedAt + 50);
  const rng = makeRng(state.rng);
  if (choice.t === "chopped") {
    if (f.phase !== "chop") return { state, error: "You are not chopping." };
    const chops = Array.isArray(choice.chops) ? choice.chops.slice(0, MAX_REPORTED) : [];
    const felled = rollLogs(rng, replayChops(chops, ran), state.pct);
    const logs = felled.reduce((a, t) => a + t.logs, 0);
    const count = (size: FelledTree["size"]) => felled.filter((t) => t.size === size).length;
    const kinds = (["small", "medium", "large"] as const).filter((k) => count(k)).map((k) => `${count(k)} ${count(k) === 1 ? TREES[k].name.toLowerCase() : TREES[k].plural}`);
    const text = felled.length === 0 ? "Nothing came down before the time was up." : `Down came ${kinds.join(", ")}: ${plural(logs, "log")} to split.`;
    const next: GatherState = { ...state, rng: rng.state(), step: state.step + 1, log: [...state.log, { text, check: null, gained: {} }], felling: { ...f, phase: logs > 0 ? "ready-split" : "done", startedAt: 0, felled, logs } };
    if (logs === 0) {
      next.status = "banked";
      next.log.push({ text: "No logs to split. You gather an armful of kindling instead.", check: null, gained: {} });
    }
    return { state: next };
  }
  if (choice.t === "split") {
    if (f.phase !== "split") return { state, error: "You are not splitting." };
    const strikes = Array.isArray(choice.strikes) ? choice.strikes.slice(0, MAX_REPORTED) : [];
    const { splits: graded, misses } = replayStrikes(strikes, f.logs, (log) => splitMotion(state.seed, log, state.pct), ran);
    const splits = rollWood(rng, graded, state.pct);
    const wood = splits.reduce((a, s) => a + s.wood, 0);
    const perfect = splits.filter((s) => s.grade === "perfect").length;
    const text = splits.length === 0 ? "Not one log split clean." : `${plural(splits.length, "log")} split (${perfect} perfect)${misses ? `, ${plural(misses, "swing")} off the mark` : ""}: ${plural(wood, "piece")} of firewood.`;
    return {
      state: {
        ...state,
        rng: rng.state(),
        step: state.step + 1,
        status: "banked",
        haul: wood > 0 ? { wood } : {},
        log: [...state.log, { text, check: null, gained: wood > 0 ? { wood } : {} }],
        felling: { ...f, phase: "done", startedAt: 0, splits, misses, wood },
      },
    };
  }
  return { state, error: f.phase === "ready-chop" || f.phase === "ready-split" ? "Start the round first." : "Unknown choice." };
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

/** What the client is shown: no seed, no RNG, and nothing it has not earned a look at. `now` sets the quarry's clock. */
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
    felling: !state.felling ? null : {
      phase: state.felling.phase,
      roundMs: FELL_ROUND_MS,
      felled: state.felling.felled.map(({ size, logs, check }) => ({ size, logs, check })),
      logs: state.felling.logs,
      splits: state.felling.splits.map(({ grade, wood, check }) => ({ grade, wood, check })),
      misses: state.felling.misses,
      wood: state.felling.wood,
      motions: Array.from({ length: state.felling.logs }, (_, log) => splitMotion(state.seed, log, state.pct)),
    },
    mine: state.mine ? mineView(state.mine, over, now) : null,
    aim: state.aim ? { cell: state.aim.cell, motion: state.aim.motion } : null,
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
