// A fishing sitting: one gathering outing that lasts as long as the player
// likes. Cast, wait for the bite, set the hook, fight it, then keep it or
// throw it back; again, until they call it a day or the creel is full.
//
// It is a GatherState like any outing (one at a time, held by the server),
// with its own state under `sitting`. Unlike the other outings, it spends its
// stamina when it ends, not when it starts: the server does that as it closes
// the outing, whichever way it closed (stopping, a full creel, or being left
// idle). A snapped line loses the fish on it, never the creel.
//
// The server rolls everything. At the cast the client is told when the bite
// comes and how the fish will fight (it must draw both), but not what it is;
// it learns that when the fish is landed, or after it gets away.

import { statPct } from "./check";
import { FISH, type FishDef } from "./fishcatalog";
import { FIGHT_OUTCOME_TEXT, edgesProblem, fightEase, makeFightScript, replayFight, type FightEase, type FightOutcome, type FightScript } from "./fishfight";
import { FISH_SPOTS, FISH_SPOT_IDS, castMetres, formatLength, formatWeight, rollCatch, rollSize, type FishSpot } from "./fishing";
import type { GatherChoice, GatherState, GatherStep } from "./gather";
import type { Resources } from "./hut";
import { makeRng } from "./rng";

/** A sitting left this long without a cast, a reel or a choice ends by itself, the catch kept. */
export const SITTING_IDLE_MS = 15 * 60_000;
/** The creel holds this much, plus CREEL_PER_STR_G for each point of Strength. */
export const CREEL_BASE_G = 25_000;
export const CREEL_PER_STR_G = 1_000;
/** How far behind the server's clock a reported hook may be, as a timed stop is judged (gather.ts on the server). */
export const HOOK_SLACK_MS = 3000;
/** When the real bite comes after the cast lands, and the nibbles before it. */
export const BITE_MS: [number, number] = [2500, 9000];
export const NIBBLES_MAX = 3;
/** How long after the bite a press still sets the hook, before Dexterity widens it. */
export const HOOK_WINDOW_MS = 350;
export const HOOK_WINDOW_DEX_MS = 250;
/** How long after the hook window closes the client may still claim it pressed in it. */
const HOOK_LATE_MS = HOOK_WINDOW_MS + HOOK_WINDOW_DEX_MS;

/** A catch as it is kept: what it is, how big, and where and when it came up. */
export interface CaughtFish {
  species: string;
  grams: number;
  mm: number;
  specimen: boolean;
  spot: FishSpot;
  /** Server clock. */
  at: number;
  /** Hauls that pay gold: how much, rolled when it came up. */
  gold?: number;
  /** Set once it has been kept or thrown back. */
  kept?: boolean;
}

/** The line in the water. */
export interface CastState {
  /** Server clock when the cast was made; the bite and nibbles are timed from it. */
  at: number;
  /** How hard it was thrown, 0 to 1, and how far out that put it. */
  power: number;
  metres: number;
  biteMs: number;
  nibbles: number[];
  windowMs: number;
  /** What is down there. Never shown to the client while it is on the line. */
  fish: CaughtFish;
  script: FightScript;
  /** Server clock when the hook was set, once it is. */
  hookedAt: number | null;
}

export interface Sitting {
  spot: FishSpot;
  /** Afloat in a boat. Always null until boats. */
  vessel: null;
  startedAt: number;
  lastActiveAt: number;
  ease: FightEase;
  creelLimitG: number;
  creelGrams: number;
  /** Every catch landed, kept or thrown back, in order. */
  landed: CaughtFish[];
  /** What got away after it was hooked, by species: the Catch Book's "got away". */
  lost: string[];
  cast: CastState | null;
  /** Landed and waiting to be kept or thrown back. */
  pending: CaughtFish | null;
  /** How the last fight ended, for the client to show. */
  last: { outcome: FightOutcome; species: string } | null;
}

/** The sitting as the client sees it: the line in the water without what is on it. */
export interface SittingView {
  spot: FishSpot;
  creelGrams: number;
  creelLimitG: number;
  landed: CaughtFish[];
  lost: string[];
  ease: FightEase;
  /** When it ends by itself if left alone, server clock. */
  idleAt: number;
  cast: { power: number; metres: number; biteMs: number; nibbles: number[]; windowMs: number; script: FightScript; hooked: boolean } | null;
  pending: CaughtFish | null;
  last: Sitting["last"];
}

/** What a hero brings to the pier. Stat values, gear included. */
export interface AnglerStats {
  str: number;
  dex: number;
}

const def = (species: string): FishDef => FISH[species];

/** Begin a sitting at `spot`. The caller has checked the spot is open and the hero has stamina left. */
export function startSitting(spot: FishSpot, seed: number, stats: AnglerStats, now: number): GatherState {
  const dex = statPct(stats.dex);
  const sitting: Sitting = {
    spot,
    vessel: null,
    startedAt: now,
    lastActiveAt: now,
    ease: fightEase(statPct(stats.str), dex),
    creelLimitG: CREEL_BASE_G + CREEL_PER_STR_G * Math.max(0, Math.floor(stats.str)),
    creelGrams: 0,
    landed: [],
    lost: [],
    cast: null,
    pending: null,
    last: null,
  };
  return { spot: "fishing", seed: seed >>> 0, rng: makeRng(seed).state(), pct: dex, status: "active", step: 0, haul: {}, log: [], trees: [], picked: [], sitting };
}

/** Has this sitting been left long enough to end by itself? */
export const sittingIdle = (state: GatherState, now: number): boolean =>
  state.status === "active" && !!state.sitting && now - state.sitting.lastActiveAt > SITTING_IDLE_MS;

const describe = (f: CaughtFish) => `${def(f.species).name}, ${formatWeight(f.grams)}${def(f.species).kind === "haul" ? "" : ` and ${formatLength(f.mm)}`}`;

/** End the sitting, keeping whatever is landed and waiting. `how` is the last line of its log. */
function close(state: GatherState, s: Sitting, how: string, now: number): GatherState {
  const landed = s.pending ? [...s.landed, { ...s.pending, kept: true }] : s.landed;
  const lost = s.cast?.hookedAt != null ? [...s.lost, s.cast.fish.species] : s.lost;
  const creelGrams = s.pending ? s.creelGrams + s.pending.grams : s.creelGrams;
  return {
    ...state,
    status: "banked",
    haul: sittingMaterials(landed),
    sitting: { ...s, landed, lost, creelGrams, pending: null, cast: null, lastActiveAt: now },
    log: [...state.log, { text: how, check: null, gained: {} }],
  };
}

/** End a sitting that has been left too long. */
export function closeIdleSitting(state: GatherState, now: number): GatherState {
  if (!state.sitting || state.status !== "active") return state;
  return close(state, state.sitting, "You nodded off on the pier. Somebody packed up your catch for you.", now);
}

/** Materials the kept hauls pay. */
export function sittingMaterials(landed: CaughtFish[]): Resources {
  const out: Resources = {};
  for (const f of landed) {
    if (!f.kept) continue;
    for (const [kind, n] of Object.entries(def(f.species).yields ?? {}) as [keyof Resources, number][]) out[kind] = (out[kind] ?? 0) + n;
  }
  return out;
}

/** Gold the kept hauls pay. */
export const sittingGold = (landed: CaughtFish[]): number => landed.reduce((a, f) => a + (f.kept ? f.gold ?? 0 : 0), 0);

/** What a sitting leaves as items: kept fish and creatures, and the hauls worth keeping (a ship's bell). */
export const sittingItems = (landed: CaughtFish[]): CaughtFish[] => landed.filter((f) => f.kept && (def(f.species).kind !== "haul" || def(f.species).keep));

/** Apply one choice to a sitting. `now` is the server's clock, filled in by the server. Never mutates `state`. */
export function stepSitting(state: GatherState, choice: GatherChoice): GatherStep {
  const s = state.sitting!;
  const now = Math.floor(Number("now" in choice ? choice.now : 0) || 0);
  const busy = { ...s, lastActiveAt: now };
  const log = (text: string) => [...state.log, { text, check: null, gained: {} }];

  if (choice.t === "bank") {
    const caught = s.landed.filter((f) => f.kept).length + (s.pending ? 1 : 0);
    return { state: close(state, s, caught === 0 ? "You wind in and head back with nothing but the walk." : "You wind in, pack the creel and head back.", now) };
  }

  if (choice.t === "cast") {
    if (s.pending) return { state, error: "Keep it or throw it back first." };
    if (s.cast?.hookedAt != null) return { state, error: "You have one on the line." };
    // A sitting is not tied to one spot: walk to another pier and cast from there.
    const from = choice.spot ?? s.spot;
    if (!FISH_SPOT_IDS.includes(from)) return { state, error: "You cannot fish from there." };
    if (FISH_SPOTS[from].closed) return { state, error: FISH_SPOTS[from].closed };
    const spot = FISH_SPOTS[from];
    const power = Math.max(0, Math.min(1, Number(choice.power) || 0));
    const reach = power * spot.maxCast;
    const rng = makeRng(state.rng);
    const caught = rollCatch(rng, spot.water, reach);
    const size = rollSize(rng, caught, reach);
    const metres = castMetres(reach);
    const biteMs = rng.int(BITE_MS[0], BITE_MS[1]);
    const nibbles = Array.from({ length: rng.int(0, NIBBLES_MAX) }, () => rng.int(800, Math.max(900, biteMs - 600))).sort((a, b) => a - b);
    const fish: CaughtFish = { species: caught.id, ...size, spot: from, at: now, ...(caught.gold ? { gold: rng.int(caught.gold[0], caught.gold[1]) } : {}) };
    const script = makeFightScript(rng, caught, size.grams / 1000, metres);
    const cast: CastState = { at: now, power, metres, biteMs, nibbles, windowMs: Math.round(HOOK_WINDOW_MS + HOOK_WINDOW_DEX_MS * s.ease.dex), fish, script, hookedAt: null };
    return { state: { ...state, rng: rng.state(), step: state.step + 1, sitting: { ...busy, spot: from, cast, last: null } } };
  }

  if (choice.t === "reel") {
    if (!s.cast) return { state: { ...state, sitting: busy } };
    if (s.cast.hookedAt != null) {
      // Cutting the line on a hooked fish: it is gone, and the Catch Book hears of it.
      return { state: { ...state, log: log("You cut the line."), sitting: { ...busy, cast: null, lost: [...s.lost, s.cast.fish.species], last: { outcome: "snapped", species: s.cast.fish.species } } } };
    }
    return { state: { ...state, sitting: { ...busy, cast: null } } };
  }

  if (choice.t === "hook") {
    const cast = s.cast;
    if (!cast) return { state, error: "Your line is not in the water." };
    if (cast.hookedAt != null) return { state, error: "It is already hooked." };
    // Believe when the client says the player pressed, if it is within a round trip of when the request arrived.
    const elapsed = now - cast.at;
    const said = Number(choice.at);
    const at = Number.isFinite(said) && said >= 0 && said <= elapsed + 50 && said >= elapsed - HOOK_SLACK_MS ? said : Math.max(0, elapsed - 150);
    if (at >= cast.biteMs && at <= cast.biteMs + cast.windowMs) {
      return { state: { ...state, log: log("Fish on!"), sitting: { ...busy, cast: { ...cast, hookedAt: cast.at + at } } } };
    }
    const text = at < cast.biteMs ? "Too soon. It was only nibbling, and now it has gone." : "Too slow. It spat the hook out.";
    return { state: { ...state, log: log(text), sitting: { ...busy, cast: null } } };
  }

  if (choice.t === "fought") {
    const cast = s.cast;
    if (!cast || cast.hookedAt == null) return { state, error: "Nothing is on the line." };
    const problem = edgesProblem(choice.edges);
    if (problem) return { state, error: problem };
    const end = replayFight(cast.script, s.ease, choice.edges);
    // A fight cannot end later than the server has seen it run (with a little for the clock it started on).
    if (end.t > now - cast.hookedAt + 100) return { state, error: "That fight is not over yet." };
    const species = cast.fish.species;
    const last = { outcome: end.outcome!, species };
    if (end.outcome === "landed") {
      return { state: { ...state, log: log(`Landed: ${describe(cast.fish)}.`), sitting: { ...busy, cast: null, pending: { ...cast.fish, at: now }, last } } };
    }
    return { state: { ...state, log: log(`${FIGHT_OUTCOME_TEXT[end.outcome!]} It was a ${def(species).name}.`), sitting: { ...busy, cast: null, lost: [...s.lost, species], last } } };
  }

  if (choice.t === "keep" || choice.t === "release") {
    const fish = s.pending;
    if (!fish) return { state, error: "There is nothing to keep." };
    if (choice.t === "release") {
      return { state: { ...state, log: log(`You let the ${def(fish.species).name.toLowerCase()} go.`), sitting: { ...busy, pending: null, landed: [...s.landed, { ...fish, kept: false }] } } };
    }
    const next: Sitting = { ...busy, pending: null, landed: [...s.landed, { ...fish, kept: true }], creelGrams: s.creelGrams + fish.grams };
    const kept: GatherState = { ...state, log: log(`Into the creel: ${describe(fish)}.`), haul: sittingMaterials(next.landed), sitting: next };
    // The one that fills it is kept, however big it is.
    if (next.creelGrams >= next.creelLimitG) return { state: close(kept, next, "That is all you can carry. You head back with a full creel.", now) };
    return { state: kept };
  }

  return { state, error: "Unknown choice." };
}

/** What the client may see of a sitting. */
export function sittingView(s: Sitting): SittingView {
  return {
    spot: s.spot,
    creelGrams: s.creelGrams,
    creelLimitG: s.creelLimitG,
    landed: s.landed,
    lost: s.lost,
    ease: s.ease,
    idleAt: s.lastActiveAt + SITTING_IDLE_MS,
    cast: s.cast ? { power: s.cast.power, metres: s.cast.metres, biteMs: s.cast.biteMs, nibbles: s.cast.nibbles, windowMs: s.cast.windowMs, script: s.cast.script, hooked: s.cast.hookedAt != null } : null,
    pending: s.pending,
    last: s.last,
  };
}
