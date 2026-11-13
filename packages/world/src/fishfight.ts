// The fight: one fish on the line, one button.
//
// A fixed-step simulation, 50 ms a tick. The fish follows a script rolled
// when it bit (runs, rests, head-shakes, jumps); the player's button becomes
// pressure. Hold is full pressure; a tap is a short pulse of half; nothing is
// none. When the fish runs, pressure tires it but piles tension on the line;
// when it rests, pressure reels it in. Tire it out and land it before the
// line snaps, runs out, or goes slack long enough to throw the hook.
//
// The client runs this live from the button and reports every press when the
// fight ends; the server runs it again from those presses and its result
// stands. Both must get the same answer, so the tick uses only + − × / and
// comparisons on numbers fixed in the script: no Math.sin, exp or pow, whose
// last bits can differ between JavaScript engines.

import type { FightStyle, FishDef, FishRarity } from "./fishcatalog";
import type { Rng } from "./rng";

export const FIGHT_TICK_MS = 50;
/** Line on the spool, in metres. A fish that takes it all breaks it. */
export const LINE_M = 60;
/** Close enough to lift it out. */
export const LAND_M = 1;
/** A fight this long ends with the fish slipping the hook. */
export const FIGHT_MAX_MS = 180_000;
/** Presses and releases a report may carry. */
export const FIGHT_MAX_EDGES = 600;
/** A press shorter than this is a tap: half pressure, for a pulse. Longer, it is a hold. */
export const TAP_MS = 200;
/** How long a tap's half pressure lasts, from the press. */
export const PULSE_MS = 250;
/** Tension below this, on a run with no pressure, is a slack line: long enough and the hook falls out. */
export const SLACK_T = 0.15;
/** Below this the fish is spent and only rests. */
export const EXHAUSTED = 0.05;

export type FightMode = "run" | "rest" | "shake" | "jump" | "drag";

export interface FightSegment {
  mode: FightMode;
  ms: number;
  /** How hard this part of the fight pulls, against the fish's own power. */
  power: number;
}

/**
 * How a hooked fish will fight. The client is given this (it needs it to
 * draw the fight), but not what the fish is.
 */
export interface FightScript {
  style: FightStyle;
  /** Pull at full strength, where 1 is the line's breaking point at full pressure. */
  power: number;
  /** Seconds of hard pressure, on a run, to tire it out from fresh. */
  staminaS: number;
  /** Metres per second it takes line on a run, fresh and unchecked. */
  runSpeed: number;
  /** Metres per second the reel brings it in, before Strength. */
  reelSpeed: number;
  /** How long it can run against a slack line before the hook falls out, before Dexterity. */
  slackMs: number;
  /** Where it bit, metres out. */
  startM: number;
  segments: FightSegment[];
}

/** How much the hero's stats help, each 0 to 1, from their chance per roll (20 to 95). */
export interface FightEase {
  str: number;
  dex: number;
}

export const fightEase = (strPct: number, dexPct: number): FightEase => ({
  str: Math.max(0, Math.min(1, (strPct - 20) / 75)),
  dex: Math.max(0, Math.min(1, (dexPct - 20) / 75)),
});

const STYLE: Record<FightStyle, { power: number; stamina: number; run: number }> = {
  darter: { power: 0.9, stamina: 0.8, run: 3.5 },
  diver: { power: 1.15, stamina: 1.2, run: 2.5 },
  thrasher: { power: 1, stamina: 1, run: 2 },
  plodder: { power: 1, stamina: 1.5, run: 1.2 },
  leaper: { power: 1, stamina: 0.9, run: 3 },
  dead: { power: 0.7, stamina: 1, run: 0 },
};

/** The rarer the fish, the harder it pulls for its weight. */
const RARITY_POWER: Record<FishRarity, number> = { common: 1, uncommon: 1, rare: 1.05, legendary: 1.15, mythic: 1.25 };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Roll how a fish of `kg` fights, having bitten `startM` out. */
export function makeFightScript(rng: Rng, def: Pick<FishDef, "style" | "rarity">, kg: number, startM: number): FightScript {
  const s = STYLE[def.style];
  const root = Math.sqrt(Math.max(0, kg));
  const script: FightScript = {
    style: def.style,
    power: round3((0.6 + 0.35 * Math.pow(Math.max(0.01, kg), 0.3)) * s.power * RARITY_POWER[def.rarity]),
    staminaS: round3((4 + 2.2 * root) * s.stamina),
    runSpeed: round3(s.run + 0.3 * Math.pow(Math.max(0.01, kg), 0.3)),
    reelSpeed: 1.6,
    slackMs: 1400 + rng.int(0, 800),
    startM,
    segments: [],
  };
  if (def.style === "dead") {
    script.segments.push({ mode: "drag", ms: FIGHT_MAX_MS, power: 1 });
    return script;
  }
  const seg = (mode: FightMode, lo: number, hi: number, p0 = 0.8, p1 = 1.1) => script.segments.push({ mode, ms: rng.int(lo, hi), power: round3(p0 + (p1 - p0) * rng.next()) });
  let total = 0;
  while (total < FIGHT_MAX_MS) {
    const start = script.segments.length;
    // Every fight opens with the run it bit on.
    switch (def.style) {
      case "darter":
        seg("run", 600, 1400);
        seg("rest", 1000, 2600, 1, 1);
        break;
      case "diver":
        seg("run", 2500, 5000, 0.9, 1.2);
        seg("rest", 2000, 4000, 1, 1);
        break;
      case "thrasher":
        seg("run", 1000, 2000);
        for (let i = rng.int(1, 2); i > 0; i--) seg("shake", 300, 700);
        seg("rest", 1200, 3000, 1, 1);
        break;
      case "plodder":
        seg("run", 3000, 6000, 0.7, 1);
        seg("rest", 1000, 2000, 1, 1);
        break;
      case "leaper":
        seg("run", 800, 1500);
        seg("jump", 600, 900, 0.9, 1.2);
        seg("rest", 1200, 3000, 1, 1);
        break;
    }
    for (let i = start; i < script.segments.length; i++) total += script.segments[i].ms;
  }
  return script;
}

export type FightOutcome = "landed" | "snapped" | "spooled" | "thrown" | "slipped";

export interface FightState {
  /** Milliseconds since the hook was set. */
  t: number;
  /** The fish's strength, 1 fresh to 0 spent. */
  S: number;
  /** Tension on the line, 1 is breaking. */
  T: number;
  /** Metres from the rod tip to the fish. */
  D: number;
  /** The part of the script it is on, and how long it has been on it. */
  seg: number;
  segT: number;
  /** What the fish is doing this tick (a spent fish only rests). */
  mode: FightMode;
  /** How long the line has been over breaking, and slack on a run. */
  over: number;
  slack: number;
  outcome: FightOutcome | null;
}

export const startFight = (script: FightScript): FightState => ({
  t: 0,
  S: 1,
  T: 0,
  D: script.startM,
  seg: 0,
  segT: 0,
  mode: script.segments[0]?.mode ?? "rest",
  over: 0,
  slack: 0,
  outcome: null,
});

/** How long the line can stay over breaking before it goes, for a hero's Dexterity. */
export const snapGraceMs = (ease: FightEase) => 200 + 200 * ease.dex;

const DT = FIGHT_TICK_MS / 1000;
const REST: FightSegment = { mode: "rest", ms: FIGHT_MAX_MS, power: 1 };

/** Advance one tick at `pressure` (0, 0.5 or 1). Never mutates `s`. */
export function fightTick(s: FightState, script: FightScript, ease: FightEase, pressure: number): FightState {
  if (s.outcome) return s;
  const P = pressure;
  let { seg, segT, S, T, D, over, slack } = s;
  // A run ends sooner the more tired the fish is.
  for (;;) {
    const cur = script.segments[seg] ?? REST;
    const length = cur.mode === "run" ? cur.ms * (0.4 + 0.6 * S) : cur.ms;
    if (segT < length || seg >= script.segments.length) break;
    seg += 1;
    segT = 0;
  }
  const cur = script.segments[seg] ?? REST;
  const mode: FightMode = cur.mode !== "drag" && cur.mode !== "rest" && S < EXHAUSTED ? "rest" : cur.mode;
  const pull = script.power * (0.35 + 0.65 * S) * cur.power;
  const steady = 1.1 - 0.25 * ease.dex;
  const tiring = (0.8 + 0.5 * ease.str) / script.staminaS;
  const reel = script.reelSpeed * (0.8 + 0.6 * ease.str);
  let target = 0;
  if (mode === "run") {
    target = pull * (0.3 + 0.9 * P) * steady;
    S -= DT * (0.25 + P) * tiring;
    D += DT * script.runSpeed * cur.power * (0.4 + 0.6 * S) * (1 - 0.7 * P);
  } else if (mode === "shake") {
    target = pull * 1.2 * (0.3 + 0.9 * P) * steady;
    S -= DT * (0.25 + P) * tiring * 0.8;
    D += DT * 0.3 * script.runSpeed * (1 - 0.7 * P);
  } else if (mode === "jump") {
    // In the air the line goes slack; it comes down on it hard.
    if (segT < cur.ms / 2) target = 0.02;
    else target = pull * 1.4 * (0.3 + 0.9 * P) * steady;
    S -= DT * (0.25 + P) * tiring * 1.5;
  } else if (mode === "drag") {
    target = (0.2 + 0.6 * P) * script.power * steady;
    D -= DT * P * reel * 0.6;
  } else {
    target = 0.12 * P;
    D -= DT * P * reel;
    if (P > 0) S -= DT * 0.3 * P * tiring;
    else S += DT * 0.15 / script.staminaS;
  }
  T += (target - T) * 0.3;
  S = S < 0 ? 0 : S > 1 ? 1 : S;
  D = D < 0 ? 0 : D;
  over = T > 1 ? over + FIGHT_TICK_MS : 0;
  slack = mode === "run" && P === 0 && T < SLACK_T ? slack + FIGHT_TICK_MS : 0;
  const t = s.t + FIGHT_TICK_MS;
  let outcome: FightOutcome | null = null;
  if (over > snapGraceMs(ease)) outcome = "snapped";
  else if (D > LINE_M) outcome = "spooled";
  else if (slack > script.slackMs + 600 * ease.dex) outcome = "thrown";
  else if (D <= LAND_M) outcome = "landed";
  else if (t >= FIGHT_MAX_MS) outcome = "slipped";
  return { t, S, T, D, seg, segT: segT + FIGHT_TICK_MS, mode, over, slack, outcome };
}

/**
 * The pressure at `t` from a list of press and release times (ms from the
 * hook): down, up, down, up… A press held is a tap for its first TAP_MS (half
 * pressure, as it might yet be one) and a hold after; a tap's half pressure
 * lasts PULSE_MS from its press. A final press with no release is still held.
 */
export function pressureAt(edges: readonly number[], t: number): number {
  let p = 0;
  for (let i = 0; i < edges.length; i += 2) {
    const down = edges[i];
    if (down > t) break;
    const up = i + 1 < edges.length ? edges[i + 1] : Infinity;
    if (t < up) p = Math.max(p, t - down < TAP_MS ? 0.5 : 1);
    else if (up - down < TAP_MS && t < down + PULSE_MS) p = Math.max(p, 0.5);
  }
  return p;
}

/** Why a report of presses cannot be played, or null if it can. */
export function edgesProblem(edges: unknown): string | null {
  if (!Array.isArray(edges)) return "Report the fight.";
  if (edges.length > FIGHT_MAX_EDGES) return "That is a lot of reeling.";
  let last = -1;
  for (const e of edges) {
    if (typeof e !== "number" || !Number.isFinite(e) || e < 0 || e > FIGHT_MAX_MS) return "That fight makes no sense.";
    if (e < last) return "That fight makes no sense.";
    last = e;
  }
  return null;
}

/** Play a whole fight from its presses, to its end. Its end is always reached by FIGHT_MAX_MS. */
export function replayFight(script: FightScript, ease: FightEase, edges: readonly number[]): FightState {
  let s = startFight(script);
  while (!s.outcome) s = fightTick(s, script, ease, pressureAt(edges, s.t));
  return s;
}

export const FIGHT_OUTCOME_TEXT: Record<FightOutcome, string> = {
  landed: "Landed!",
  snapped: "The line snaps.",
  spooled: "It takes every metre of line, and the line goes.",
  thrown: "The line goes slack, and the hook comes back empty.",
  slipped: "It wears you out, and slips the hook.",
};
