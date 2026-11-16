// Felling: one thirty-second round in the tree line, seen through the hero's
// eyes. Pure helpers for gather.ts.
//
// Three trees stand in front of you: a thin sapling, an ash and a thick old
// oak. Pick one, set the angle of your cut (from above, sloping down into the
// trunk, or from below, sloping up) and click to chop: there is no swing to
// wait for, so the faster you click the faster it goes. A cut only goes so
// deep before the axe binds in it; to go deeper, cut from the other side to
// meet it, and the wedge between the two pops out as a chunk (a notch). Each
// notch takes the trunk deeper. With only an eighth of it left, the tree
// topples, and a new one stands in its place a moment later.
//
// The angle is a choice: a flat cut bites deep with each chop but binds
// early, so it takes more notches; a steep one bites less each time but runs
// further before it binds. A thick tree takes longer and gives more logs, so
// the round is a race and a choice: a tree still standing when the time is up
// gives nothing. Each log is a piece of firewood for now.
//
// LATER: splitting logs into firewood is to be its own minigame (the old
// second round, kept below: a marker sweeping over the log on the block,
// strike on the mark). Until it is built, felling pays a piece of wood a log;
// when it is, felling should pay logs and the splitting game turn them into
// wood. splitMotion, splitGrade and replayStrikes are kept for it.
//
// The client plays the round and reports every chop (which tree, when, at
// what angle) when it ends. The server stamps when the round began and
// replays the report against these rules, dropping anything that could not
// have happened (too fast, too late, at a tree still growing back). Logs are
// rolled on the server. The replay uses only + − × / on the numbers given, so
// both sides get the same answer.

import { rollCheck, type CheckResult } from "./check";
import type { Rng } from "./rng";
import { makeRng } from "./rng";
import { markerAt, timingEase, type Motion } from "./timing";

/** The round lasts this long. */
export const FELL_ROUND_MS = 30_000;
/** The quickest two chops can follow each other and both count: quicker than anyone clicks, slower than a script. */
export const CHOP_GAP_MS = 55;
/** The splitting game's quickest swing (kept for when it returns). */
export const SWING_MS = 380;
/** After a tree comes down, how long before a new one stands there to chop. */
export const REGROW_MS = 1200;
/** After a log is split, how long before the next is on the block and its marker starts. */
export const NEXT_LOG_MS = 800;
/** Allowance for timer jitter when checking the gaps a report claims. */
const JITTER_MS = 15;
/** The most chops a report is read for: more than anyone could click in a round. */
export const MAX_CHOPS = 600;
/** The most strikes a splitting report is read for. */
export const MAX_REPORTED = 120;

/** How deep the notch must go (as a share of the trunk's width) for the tree to topple: all but an eighth. */
export const FELL_DEPTH = 7 / 8;
/** A cut's angle off level, in degrees: no flatter than this, no steeper than that. Positive cuts from above. */
export const ANGLE_MIN = 20;
export const ANGLE_MAX = 60;
/** How much of a sapling's width one level chop takes; thicker trees take less, steeper cuts less again. */
const BITE = 0.11;
/** How deep past the notch a cut can go before the axe binds: this much on the level, up to REACH0 + REACH1 at the steepest. */
const REACH0 = 0.15;
const REACH1 = 0.35;

export type TreeSize = "small" | "medium" | "large";
/** The three trees, left to right. A chop names its tree by its place here. */
export const TREE_SLOTS: readonly TreeSize[] = ["small", "medium", "large"];

export interface TreeDef {
  name: string;
  plural: string;
  /** How thick the trunk is, the sapling's being 1: chops take less of a thicker one, and it needs more notches. */
  thick: number;
  /** Logs it always gives. */
  logs: number;
  /** Strength rolls for more: one log each. */
  rolls: number;
}

export const TREES: Record<TreeSize, TreeDef> = {
  small: { name: "Sapling", plural: "saplings", thick: 1, logs: 1, rolls: 0 },
  medium: { name: "Ash", plural: "ashes", thick: 1.5, logs: 1, rolls: 1 },
  large: { name: "Old oak", plural: "old oaks", thick: 2.2, logs: 2, rolls: 2 },
};

/** One chop: at which tree, when (ms after the round began), and at what angle (degrees, positive from above). */
export interface Chop {
  slot: number;
  at: number;
  angle: number;
}

/** A wedge that came out of the trunk: how deep its point reached, and the angles of the cuts above and below it. */
export interface Notch {
  depth: number;
  top: number;
  bottom: number;
}

/**
 * Where the chopping of one tree has got. Depths are shares of the trunk's
 * width, in from the side being cut. `floor` is how deep the notch is; each
 * cut runs from it, at its own angle, as deep as `top` or `bottom` (equal to
 * the floor where there is no cut yet on that side).
 */
export interface TreeCut {
  floor: number;
  top: number;
  topAngle: number;
  bottom: number;
  bottomAngle: number;
  /** Every chunk that has come out, first to last. */
  notches: Notch[];
}

export const freshCut = (): TreeCut => ({ floor: 0, top: 0, topAngle: 45, bottom: 0, bottomAngle: 45, notches: [] });

/** What a chop did: bit in, could go no deeper (the axe binds), knocked a chunk out, or brought the tree down. */
export type ChopResult = "bite" | "bound" | "chunk" | "felled";

/** An angle as the rules take it: whole degrees, at least ANGLE_MIN and at most ANGLE_MAX either way. Null if it is not a number. */
export function cutAngle(raw: unknown): number | null {
  const a = Number(raw);
  if (!Number.isFinite(a)) return null;
  const size = Math.min(ANGLE_MAX, Math.max(ANGLE_MIN, Math.round(Math.abs(a))));
  return a < 0 ? -size : size;
}

/** cos of an angle in degrees (0 to 90), with only + − × / (Bhaskara's): close enough, and the same on every engine. */
function cosDeg(deg: number): number {
  const x = (deg * 3.141592653589793) / 180;
  const pi2 = 9.869604401089358;
  return (pi2 - 4 * x * x) / (pi2 + x * x);
}

/** The size of an angle as the rules take it (see cutAngle). */
const steep = (angle: number) => Math.abs(cutAngle(angle) ?? ANGLE_MIN);
/** How deep one chop at `angle` goes into a tree of `size`, as a share of its width. */
export const biteOf = (size: TreeSize, angle: number): number => (BITE * cosDeg(steep(angle))) / TREES[size].thick;
/** How far past the notch a cut at `angle` can go before the axe binds. */
export const reachOf = (size: TreeSize, angle: number): number => (REACH0 + REACH1 * cosDeg(90 - steep(angle))) / TREES[size].thick;

/**
 * One chop at a tree. The cut on that side (from above for a positive angle)
 * goes deeper, as far as it can before the axe binds, and takes the chop's
 * angle. Once the cuts from both sides have bitten past the notch, the one
 * just made meeting the other (or binding short of it) frees the wedge
 * between them: the notch goes as deep as the shallower of the two, and both
 * start again from there. Never mutates `cut`.
 */
export function chopTree(cut: TreeCut, size: TreeSize, angle: number): { cut: TreeCut; result: ChopResult; notch?: Notch } {
  const a = cutAngle(angle) ?? ANGLE_MIN;
  const fromTop = a > 0;
  const cur = fromTop ? cut.top : cut.bottom;
  const other = fromTop ? cut.bottom : cut.top;
  const limit = Math.min(1, cut.floor + reachOf(size, a));
  const next: TreeCut = { ...cut, notches: cut.notches };
  if (fromTop) next.topAngle = a;
  else next.bottomAngle = a;
  const bitten = other > cut.floor;
  let deep = cur;
  let result: ChopResult = "bound";
  if (cur < limit) {
    deep = Math.min(limit, cur + biteOf(size, a));
    result = "bite";
  }
  if (fromTop) next.top = deep;
  else next.bottom = deep;
  if (bitten && (deep >= other || deep >= limit)) {
    const floor = Math.min(deep, other);
    const notch: Notch = { depth: floor, top: next.topAngle, bottom: next.bottomAngle };
    const freed: TreeCut = { floor, top: floor, topAngle: next.topAngle, bottom: floor, bottomAngle: next.bottomAngle, notches: [...cut.notches, notch] };
    return { cut: freed, result: floor >= FELL_DEPTH ? "felled" : "chunk", notch };
  }
  return { cut: next, result };
}

/** Times in a report that a round of `windowMs` (as the server saw it) could hold. */
const inRound = (at: number, windowMs: number) => Number.isFinite(at) && at >= 0 && at <= Math.min(FELL_ROUND_MS, windowMs);

/**
 * Replay the round: which trees came down, and when. Chops that could not
 * have happened are dropped: out of order, quicker than CHOP_GAP_MS, at a
 * tree still growing back, at no tree, at no angle, or outside the round.
 */
export function replayChops(chops: readonly Chop[], windowMs: number): { size: TreeSize; at: number }[] {
  const felled: { size: TreeSize; at: number }[] = [];
  const cuts = TREE_SLOTS.map(freshCut);
  const regrownAt = [0, 0, 0];
  let last = -Infinity;
  for (const chop of chops.slice(0, MAX_CHOPS)) {
    const slot = Number(chop?.slot);
    const at = Number(chop?.at);
    const angle = cutAngle(chop?.angle);
    if (!Number.isInteger(slot) || slot < 0 || slot >= TREE_SLOTS.length || angle === null) continue;
    if (!inRound(at, windowMs) || at - last < CHOP_GAP_MS - JITTER_MS || at < regrownAt[slot] - JITTER_MS) continue;
    last = at;
    const size = TREE_SLOTS[slot];
    const { cut, result } = chopTree(cuts[slot], size, angle);
    cuts[slot] = cut;
    if (result === "felled") {
      felled.push({ size, at });
      cuts[slot] = freshCut();
      regrownAt[slot] = at + REGROW_MS;
    }
  }
  return felled;
}

export type SplitGrade = "perfect" | "good" | "miss";
/** Wood a split puts on the pile. A miss gets none and the log stays on the block. */
export const SPLIT_WOOD: Record<SplitGrade, number> = { perfect: 2, good: 1, miss: 0 };

/** Wood a split adds to a pile holding `piled` of at most `pile`. */
export const splitWood = (grade: SplitGrade, piled: number, pile: number): number => Math.max(0, Math.min(SPLIT_WOOD[grade], pile - piled));

export interface FelledTree {
  size: TreeSize;
  /** When it came down, ms into the round. */
  at: number;
  logs: number;
  check: CheckResult | null;
}

export interface Split {
  log: number;
  at: number;
  grade: Exclude<SplitGrade, "miss">;
  /** What it put on the pile: its grade's share, less whatever did not fit. */
  wood: number;
  /** Outings split before wood was fixed by the grade rolled for it here; null since. */
  check: CheckResult | null;
}

/** "ready-split" and "split" are only on outings from when felling had a splitting round; they are carried home as they stand. */
export type FellingPhase = "ready-chop" | "chop" | "ready-split" | "split" | "done";

export interface FellingState {
  phase: FellingPhase;
  /** The server's clock when the round under way began; 0 before one has. */
  startedAt: number;
  felled: FelledTree[];
  /** Logs from the chopping round, to split. */
  logs: number;
  splits: Split[];
  /** Strikes off the mark. */
  misses: number;
  wood: number;
}

export function newFelling(): FellingState {
  return { phase: "ready-chop", startedAt: 0, felled: [], logs: 0, splits: [], misses: 0, wood: 0 };
}

/** The marker over log `log` (0 first): seeded per outing, eased by the hero's chance per roll like every timed stop. */
export function splitMotion(seed: number, log: number, pct: number): Motion {
  const r = makeRng((seed ^ Math.imul(log + 1, 0x9e3779b1)) >>> 0);
  const { width, pace } = timingEase(pct);
  return { kind: "swing", period: Math.round(1600 * pace), phase: r.next(), zone: 0.2 + r.next() * 0.6, width: 0.24 * width };
}

/** How a strike `ms` after the log's marker started lands. There is no "too slow" on the block: the marker keeps sweeping. */
export function splitGrade(m: Motion, ms: number): SplitGrade {
  const off = Math.abs(markerAt(m, ms) - m.zone);
  if (off <= m.width * 0.18) return "perfect";
  if (off <= m.width / 2) return "good";
  return "miss";
}

/**
 * Replay the splitting round: each strike against the marker over the log on
 * the block. A split puts its wood on the pile (up to `pile`) and brings the
 * next log up after NEXT_LOG_MS, its marker starting then; a miss leaves the
 * log where it is. Strikes an axe could not have made are dropped, as are any
 * after the last log. A full pile does not end the round: splits go on, for
 * the perfects.
 */
export function replayStrikes(strikes: readonly number[], logs: number, motion: (log: number) => Motion, windowMs: number, pile: number): { splits: Split[]; misses: number } {
  const splits: Split[] = [];
  let misses = 0;
  let piled = 0;
  let log = 0;
  let logAt = 0;
  let last = -Infinity;
  for (const raw of strikes.slice(0, MAX_REPORTED)) {
    if (log >= logs) break;
    const at = Number(raw);
    if (!inRound(at, windowMs) || at - last < SWING_MS - JITTER_MS || at < logAt - JITTER_MS) continue;
    last = at;
    const grade = splitGrade(motion(log), Math.max(0, at - logAt));
    if (grade === "miss") {
      misses++;
      continue;
    }
    const wood = splitWood(grade, piled, pile);
    piled += wood;
    splits.push({ log, at, grade, wood, check: null });
    log++;
    logAt = at + NEXT_LOG_MS;
  }
  return { splits, misses };
}

/** Logs from the trees that came down: each gives its share, plus a log for each Strength roll that lands. */
export function rollLogs(rng: Rng, felled: readonly { size: TreeSize; at: number }[], pct: number): FelledTree[] {
  return felled.map(({ size, at }) => {
    const def = TREES[size];
    const check = def.rolls > 0 ? rollCheck(rng, { label: def.name, stat: "str", pct, count: def.rolls }) : null;
    return { size, at, logs: def.logs + (check?.successes ?? 0), check };
  });
}
