// The grove: where a felled tree comes down. Pure helpers for felling in
// gather.ts.
//
// Nine trees stand on a 3×3 grid, row 0 to the north. The player picks a
// tree and the side to notch it (north, east, south or west), then stops the
// swinging axe. A clean stop drops it where it was notched; a worse one lets
// the wind carry it round by 45° or 90°. A tree falls one cell, or two if it
// is tall, and the first thing along that line decides what happens to it:
//
//   - open ground: it lands clear and pays;
//   - a tree still standing: it hangs up in that tree and pays nothing;
//   - the creek along the north edge: it is washed away and pays nothing;
//   - the log pile off the south-east corner: it smashes the pile and the
//     outing's haul is lost, unless both rolls landed.

import type { TimingGrade } from "./gather";
import type { Rng } from "./rng";

/** Grid side. Matches FELLING_SIDE in gather.ts. */
export const GROVE_SIDE = 3;
/** Knocks an outing allows. A knock says what a tree is and costs nothing else. */
export const GROVE_KNOCKS = 3;
/** Chance a tree is tall (falls two cells, and pays one more when it lands clear). */
export const GROVE_TALL = 0.45;
/** Chance a rotten tree shows bracket fungus. */
export const GROVE_FUNGUS = 0.5;

/** Eight directions, clockwise from north: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW. */
export type Dir8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** The four sides a tree can be notched on. */
export const NOTCH_DIRS: readonly Dir8[] = [0, 2, 4, 6];
export const DIR_NAMES = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;
const STEP: readonly [number, number][] = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];

/** The log pile and its cart: off the south-east corner, as [row, col]. */
export const GROVE_PILE: readonly [number, number][] = [[3, 2], [3, 3], [2, 3]];

/** 0 calm, 1 a breeze, 2 gusting. */
export type WindStrength = 0 | 1 | 2;
export interface Wind {
  /** Which way it blows (towards). */
  dir: Dir8;
  strength: WindStrength;
}
export const WIND_NAMES = ["calm", "a breeze", "gusting"] as const;

export type FallOutcome = "clear" | "hung" | "creek" | "pile";

export interface Fall {
  /** Where it was notched. */
  aimed: Dir8;
  /** Where it actually went. */
  dir: Dir8;
  outcome: FallOutcome;
}

export interface Grove {
  /** Falls one cell, or two when tall. Per tree. */
  tall: boolean[];
  /** Bracket fungus showing on the trunk. Only rotten trees have it. */
  fungus: boolean[];
  wind: Wind;
  /** Trees knocked so far, in order. */
  knocked: number[];
  /** How each felled tree came down, by cell. */
  falls: Record<number, Fall>;
}

/**
 * How far a stop lets the wind turn the fall, in 45° steps, by wind strength
 * then grade. A clean stop always falls true.
 */
export const DRIFT: Record<WindStrength, Record<TimingGrade, number>> = {
  0: { perfect: 0, good: 0, close: 0, miss: 1, late: 1 },
  1: { perfect: 0, good: 1, close: 1, miss: 2, late: 2 },
  2: { perfect: 0, good: 1, close: 2, miss: 2, late: 2 },
};

export const isDir8 = (n: unknown): n is Dir8 => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 8;
const wrap = (n: number) => (((n % 8) + 8) % 8) as Dir8;

/** Set up the grove for a stand of trees. Rotten trees may show fungus. */
export function seedGrove(rng: Rng, rotten: readonly boolean[]): Grove {
  const tall = rotten.map(() => rng.chance(GROVE_TALL));
  const fungus = rotten.map((r) => r && rng.chance(GROVE_FUNGUS));
  const wind: Wind = { dir: rng.int(0, 7) as Dir8, strength: rng.int(0, 2) as WindStrength };
  return { tall, fungus, wind, knocked: [], falls: {} };
}

/**
 * Turn a fall `steps` × 45° towards where the wind blows, never past it. A
 * wind straight along the line, or straight against it, does not turn it.
 */
export function windDrift(fall: Dir8, wind: Wind, steps: number): Dir8 {
  const diff = wrap(wind.dir - fall);
  if (diff === 0 || diff === 4 || steps <= 0) return fall;
  return diff < 4 ? wrap(fall + Math.min(steps, diff)) : wrap(fall - Math.min(steps, 8 - diff));
}

/** The cells a fall crosses, nearest first, as [row, col]. Some may be off the grid. */
export function fallLine(cell: number, dir: Dir8, length: number): [number, number][] {
  const row = Math.floor(cell / GROVE_SIDE);
  const col = cell % GROVE_SIDE;
  const [dr, dc] = STEP[dir];
  return Array.from({ length }, (_, i) => [row + dr * (i + 1), col + dc * (i + 1)] as [number, number]);
}

/** What lies at a place: a cell of the grid (its index), the pile, the creek, or open ground. */
export function groundAt(row: number, col: number): number | "pile" | "creek" | "open" {
  if (GROVE_PILE.some(([r, c]) => r === row && c === col)) return "pile";
  if (row >= 0 && col >= 0 && row < GROVE_SIDE && col < GROVE_SIDE) return row * GROVE_SIDE + col;
  if (row < 0) return "creek";
  return "open";
}

/** What a fall along `dir` would hit first, given which trees are already down. */
export function fallOutcome(cell: number, dir: Dir8, length: number, down: readonly number[]): FallOutcome {
  for (const [r, c] of fallLine(cell, dir, length)) {
    const at = groundAt(r, c);
    if (at === "pile") return "pile";
    if (at === "creek") return "creek";
    if (typeof at === "number" && !down.includes(at)) return "hung";
  }
  return "clear";
}

/**
 * Where a tree notched on `aimed` really goes. A sound tree (or a den) is
 * turned by the wind as far as the stop allows; a rotten one twists a seeded
 * 45° or 90° either way, whatever the stop.
 */
export function fallDir(aimed: Dir8, wind: Wind, grade: TimingGrade, rotten: boolean, rng: Rng): Dir8 {
  if (rotten) return wrap(aimed + rng.int(1, 2) * (rng.chance(0.5) ? 1 : -1));
  return windDrift(aimed, wind, DRIFT[wind.strength][grade]);
}

/** The wind between one tree and the next: it veers a step at most, and may rise or drop. */
export function shiftWind(wind: Wind, rng: Rng): Wind {
  const dir = wrap(wind.dir + rng.pick([-1, 0, 0, 1]));
  const strength = Math.max(0, Math.min(2, wind.strength + rng.pick([-1, 0, 0, 1]))) as WindStrength;
  return { dir, strength };
}
