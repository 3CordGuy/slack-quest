import { describe, expect, it } from "vitest";
import { FISH } from "./fishcatalog";
import { playFight } from "./fishbot";
import { gatherPayout, gatherView, stepGather, type GatherChoice, type GatherState } from "./gather";
import { sittingXp } from "./harborxp";
import { CREEL_BASE_G, CREEL_PER_STR_G, SITTING_IDLE_MS, closeIdleSitting, sittingGold, sittingIdle, sittingItems, sittingMaterials, startSitting, type CaughtFish } from "./sitting";

const T0 = 1_800_000_000_000;
const STATS = { str: 9, dex: 9 };

function step(state: GatherState, choice: GatherChoice): GatherState {
  const r = stepGather(state, choice);
  if (r.error) throw new Error(r.error);
  return r.state;
}

/** Cast, hook it on the bite, and fight it out as the bot would. Returns the state after the fight and when it ended. */
function catchOne(state: GatherState, at: number): { state: GatherState; now: number } {
  let s = step(state, { t: "cast", power: 0.6, now: at });
  const cast = s.sitting!.cast!;
  const hookAt = cast.biteMs + 20;
  s = step(s, { t: "hook", at: hookAt, now: at + hookAt + 40 });
  expect(s.sitting!.cast!.hookedAt).toBe(at + hookAt);
  const { end, edges } = playFight(cast.script, s.sitting!.ease);
  const now = at + hookAt + end.t + 300;
  return { state: step(s, { t: "fought", edges, now }), now };
}

/** Keep catching until something is landed. */
function landOne(state: GatherState, at: number): { state: GatherState; now: number } {
  let s = state;
  let now = at;
  for (let i = 0; i < 50; i++) {
    ({ state: s, now } = catchOne(s, now + 1000));
    if (s.sitting!.pending) return { state: s, now };
  }
  throw new Error("Nothing landed in fifty casts.");
}

describe("a sitting", () => {
  it("starts with an empty creel sized by Strength", () => {
    const s = startSitting("west", 1, STATS, T0);
    expect(s.status).toBe("active");
    expect(s.sitting!.creelLimitG).toBe(CREEL_BASE_G + 9 * CREEL_PER_STR_G);
    expect(s.sitting!.landed).toEqual([]);
  });

  it("tells the client when the bite comes and how it will fight, but not what it is", () => {
    const s = step(startSitting("east", 2, STATS, T0), { t: "cast", power: 1, now: T0 });
    const view = gatherView(s, T0);
    expect(view.sitting!.cast!.biteMs).toBeGreaterThan(0);
    expect(view.sitting!.cast!.script.segments.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain(s.sitting!.cast!.fish.species);
  });

  it("puts the bite after every nibble", () => {
    for (let seed = 0; seed < 50; seed++) {
      const cast = step(startSitting("middle", seed, STATS, T0), { t: "cast", power: 0.5, now: T0 }).sitting!.cast!;
      for (const n of cast.nibbles) expect(n).toBeLessThan(cast.biteMs);
    }
  });

  it("loses the fish to a strike on a nibble, or one too late", () => {
    const cast = step(startSitting("west", 3, STATS, T0), { t: "cast", power: 0.5, now: T0 });
    const bite = cast.sitting!.cast!.biteMs;
    const early = step(cast, { t: "hook", at: bite - 200, now: T0 + bite - 150 });
    expect(early.sitting!.cast).toBeNull();
    expect(early.log.at(-1)!.text).toMatch(/Too soon/);
    const late = step(cast, { t: "hook", at: bite + 2000, now: T0 + bite + 2050 });
    expect(late.sitting!.cast).toBeNull();
    expect(late.log.at(-1)!.text).toMatch(/Too slow/);
  });

  it("does not believe a strike timed from the future", () => {
    const cast = step(startSitting("west", 3, STATS, T0), { t: "cast", power: 0.5, now: T0 });
    const bite = cast.sitting!.cast!.biteMs;
    // Claims to have pressed on the bite, but the request came long before it.
    const s = step(cast, { t: "hook", at: bite + 10, now: T0 + 500 });
    expect(s.sitting!.cast).toBeNull();
  });

  it("refuses a fight reported before it could have ended", () => {
    let s = step(startSitting("west", 4, STATS, T0), { t: "cast", power: 0.5, now: T0 });
    const cast = s.sitting!.cast!;
    s = step(s, { t: "hook", at: cast.biteMs + 10, now: T0 + cast.biteMs + 30 });
    const { end, edges } = playFight(cast.script, s.sitting!.ease);
    expect(stepGather(s, { t: "fought", edges, now: T0 + cast.biteMs + 10 + end.t - 1000 }).error).toMatch(/not over/);
  });

  it("lands a fish, keeps it in the creel, and counts what got away", () => {
    let { state } = landOne(startSitting("middle", 5, STATS, T0), T0);
    const pending = state.sitting!.pending!;
    expect(FISH[pending.species]).toBeTruthy();
    expect(gatherView(state, T0).sitting!.pending!.species).toBe(pending.species);
    state = step(state, { t: "keep", now: T0 + 999_999 });
    expect(state.sitting!.creelGrams).toBe(pending.grams);
    expect(state.sitting!.landed.at(-1)).toMatchObject({ species: pending.species, kept: true });
    expect(state.status).toBe("active");
  });

  it("throws back without filling the creel", () => {
    let { state } = landOne(startSitting("middle", 6, STATS, T0), T0);
    state = step(state, { t: "release", now: T0 + 999_999 });
    expect(state.sitting!.creelGrams).toBe(0);
    expect(state.sitting!.landed.at(-1)!.kept).toBe(false);
  });

  it("will not cast again until the landed catch is kept or thrown back", () => {
    const { state } = landOne(startSitting("west", 7, STATS, T0), T0);
    expect(stepGather(state, { t: "cast", power: 0.5, now: T0 + 999_999 }).error).toBeTruthy();
  });

  it("ends when the creel is full, keeping the one that filled it", () => {
    let state = startSitting("east", 8, { str: 0, dex: 9 }, T0);
    let now = T0;
    for (let i = 0; i < 400 && state.status === "active"; i++) {
      ({ state, now } = landOne(state, now));
      state = step(state, { t: "keep", now: now + 10 });
    }
    expect(state.status).toBe("banked");
    expect(state.sitting!.creelGrams).toBeGreaterThanOrEqual(CREEL_BASE_G);
    expect(state.log.at(-1)!.text).toMatch(/all you can carry/);
    expect(stepGather(state, { t: "cast", power: 1, now: now + 20 }).error).toBeTruthy();
  });

  it("ends when the player stops, keeping a landed catch not yet put away", () => {
    const { state, now } = landOne(startSitting("west", 9, STATS, T0), T0);
    const done = step(state, { t: "bank", now: now + 10 });
    expect(done.status).toBe("banked");
    expect(done.sitting!.landed.at(-1)!.kept).toBe(true);
    expect(done.sitting!.pending).toBeNull();
  });

  it("counts a fish still on the line when the player stops as one that got away", () => {
    let s = step(startSitting("west", 10, STATS, T0), { t: "cast", power: 0.5, now: T0 });
    const cast = s.sitting!.cast!;
    s = step(s, { t: "hook", at: cast.biteMs + 10, now: T0 + cast.biteMs + 30 });
    s = step(s, { t: "bank", now: T0 + cast.biteMs + 500 });
    expect(s.sitting!.lost).toEqual([cast.fish.species]);
  });

  it("ends by itself when left alone, the catch kept", () => {
    const { state, now } = landOne(startSitting("west", 11, STATS, T0), T0);
    const kept = step(state, { t: "keep", now: now + 10 });
    expect(sittingIdle(kept, now + 10 + SITTING_IDLE_MS)).toBe(false);
    expect(sittingIdle(kept, now + 11 + SITTING_IDLE_MS)).toBe(true);
    const closed = closeIdleSitting(kept, now + 11 + SITTING_IDLE_MS);
    expect(closed.status).toBe("banked");
    expect(closed.sitting!.landed).toEqual(kept.sitting!.landed);
  });

  it("pays hauls as materials and gold, and keeps fish and treasure as items", () => {
    const at = T0;
    const landed: CaughtFish[] = [
      { species: "driftwood", grams: 3000, mm: 900, specimen: false, spot: "west", at, kept: true },
      { species: "fish_skeleton", grams: 800, mm: 400, specimen: false, spot: "west", at, kept: true },
      { species: "lockbox", grams: 5000, mm: 350, specimen: false, spot: "west", at, gold: 30, kept: true },
      { species: "ships_bell", grams: 20000, mm: 400, specimen: false, spot: "west", at, kept: true },
      { species: "mackerel", grams: 900, mm: 400, specimen: false, spot: "west", at, kept: true },
      { species: "herring", grams: 200, mm: 250, specimen: false, spot: "west", at, kept: false },
      { species: "kettle", grams: 2000, mm: 250, specimen: false, spot: "west", at, kept: false },
    ];
    expect(sittingMaterials(landed)).toEqual({ wood: 1, bone: 1 });
    expect(sittingGold(landed)).toBe(30);
    expect(sittingItems(landed).map((f) => f.species)).toEqual(["ships_bell", "mackerel"]);
  });

  it("pays XP like a banked haul, more for a bigger catch", () => {
    const base = startSitting("west", 12, STATS, T0);
    const fish = (n: number): CaughtFish[] => Array.from({ length: n }, () => ({ species: "herring", grams: 200, mm: 250, specimen: false, spot: "west", at: T0, kept: true }));
    expect(sittingXp(base)).toBe(0);
    const ended = (n: number) => ({ ...base, status: "banked" as const, sitting: { ...base.sitting!, landed: fish(n) } });
    expect(sittingXp(ended(0))).toBe(4);
    expect(sittingXp(ended(5))).toBe(6);
    expect(sittingXp(ended(30))).toBe(8);
    expect(gatherPayout(ended(3))).toEqual({});
  });
});

describe("moving about", () => {
  it("casts from another pier when told to, and refuses the open sea", () => {
    const s = step(startSitting("west", 20, STATS, T0), { t: "cast", power: 0.5, spot: "east", now: T0 });
    expect(s.sitting!.spot).toBe("east");
    expect(s.sitting!.cast!.fish.spot).toBe("east");
    expect(stepGather(startSitting("west", 20, STATS, T0), { t: "cast", power: 0.5, spot: "sea", now: T0 }).error).toMatch(/boat/);
  });
});
