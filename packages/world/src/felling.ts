// Felling: two thirty-second rounds in the tree line, seen through the hero's
// eyes. Pure helpers for gather.ts.
//
// 1. Chopping. Three trees stand in front of you: small, medium and large.
//    Each tap is one swing at the tree you choose, no faster than an axe can
//    swing. A tree falls after its number of chops and a new one of the same
//    size stands in its place a moment later. Big trees take longer but give
//    more logs, so it is a race and a choice: a tree still standing when the
//    time is up gives nothing.
// 2. Splitting. Each log goes on the block in turn, and a marker sweeps across
//    it. Strike when it is over the split: bang on the middle is a perfect,
//    two pieces of wood; anywhere on the mark is good, one piece. Off the mark
//    the axe just bites, and you go again on the same log. The wood goes on a
//    pile that holds what one outing can carry home; once it is full, splits
//    pay no more wood, but a perfect still earns XP (harborxp.ts).
//
// The client plays each round and reports what it did with times measured
// from the round's start: every chop, then every strike. The server stamps
// when each round began and replays the report against these rules,
// dropping anything an axe could not have done (too fast, too late, before a
// new tree stood). Logs are rolled on the server; wood follows from the grades.

import { rollCheck, type CheckResult } from "./check";
import type { Rng } from "./rng";
import { makeRng } from "./rng";
import { markerAt, timingEase, type Motion } from "./timing";

/** Each round lasts this long. */
export const FELL_ROUND_MS = 30_000;
/** The fastest an axe swings: one chop or strike this often at most. */
export const SWING_MS = 380;
/** After a tree comes down, how long before a new one stands there to chop. */
export const REGROW_MS = 1200;
/** After a log is split, how long before the next is on the block and its marker starts. */
export const NEXT_LOG_MS = 800;
/** Allowance for timer jitter when checking the gaps a report claims. */
const JITTER_MS = 40;
/** The most chops or strikes a report is read for. More than an axe could swing in a round. */
export const MAX_REPORTED = 120;

export type TreeSize = "small" | "medium" | "large";
/** The three trees, left to right. A chop names its tree by its place here. */
export const TREE_SLOTS: readonly TreeSize[] = ["small", "medium", "large"];

export interface TreeDef {
  name: string;
  plural: string;
  /** Chops to bring it down. */
  chops: number;
  /** Logs it always gives. */
  logs: number;
  /** Strength rolls for more: one log each. */
  rolls: number;
}

export const TREES: Record<TreeSize, TreeDef> = {
  small: { name: "Sapling", plural: "saplings", chops: 6, logs: 1, rolls: 0 },
  medium: { name: "Ash", plural: "ashes", chops: 12, logs: 1, rolls: 1 },
  large: { name: "Old oak", plural: "old oaks", chops: 18, logs: 2, rolls: 2 },
};

export type SplitGrade = "perfect" | "good" | "miss";
/** Wood a split puts on the pile. A miss gets none and the log stays on the block. */
export const SPLIT_WOOD: Record<SplitGrade, number> = { perfect: 2, good: 1, miss: 0 };

/** Wood a split adds to a pile holding `piled` of at most `pile`. */
export const splitWood = (grade: SplitGrade, piled: number, pile: number): number => Math.max(0, Math.min(SPLIT_WOOD[grade], pile - piled));

/** One swing in the chopping round: at which tree, and when (ms after the round began). */
export interface Chop {
  slot: number;
  at: number;
}

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

/** Times in a report that a round of `windowMs` (as the server saw it) could hold. */
const inRound = (at: number, windowMs: number) => Number.isFinite(at) && at >= 0 && at <= Math.min(FELL_ROUND_MS, windowMs);

/**
 * Replay the chopping round: which trees came down, and when. Chops an axe
 * could not have made are dropped: out of order, quicker than a swing, at a
 * tree still growing back, or outside the round.
 */
export function replayChops(chops: readonly Chop[], windowMs: number): { size: TreeSize; at: number }[] {
  const felled: { size: TreeSize; at: number }[] = [];
  const done = [0, 0, 0];
  const regrownAt = [0, 0, 0];
  let last = -Infinity;
  for (const chop of chops.slice(0, MAX_REPORTED)) {
    const slot = Number(chop?.slot);
    const at = Number(chop?.at);
    if (!Number.isInteger(slot) || slot < 0 || slot >= TREE_SLOTS.length) continue;
    if (!inRound(at, windowMs) || at - last < SWING_MS - JITTER_MS || at < regrownAt[slot] - JITTER_MS) continue;
    last = at;
    const size = TREE_SLOTS[slot];
    if (++done[slot] >= TREES[size].chops) {
      felled.push({ size, at });
      done[slot] = 0;
      regrownAt[slot] = at + REGROW_MS;
    }
  }
  return felled;
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
