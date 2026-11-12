import { describe, expect, it } from "vitest";
import {
  ENEMY_DROP_UNITS,
  FELLING_DENS,
  FELLING_ROTTEN,
  GATHER_DAILY_OUTINGS,
  GATHER_MAX_STEPS,
  GATHER_MAX_UNITS,
  GATHER_MIN_BANK,
  GATHER_SPOTS,
  GATHER_SPOT_IDS,
  QUARRY_MAX_CRACKS,
  gatherDay,
  gatherPayout,
  gatherPct,
  gatherResetAt,
  gatherView,
  outingsLeft,
  startGather,
  statPct,
  stepGather,
  type GatherChoice,
  type GatherSpot,
  type GatherState,
  type Resources,
} from "./index";

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

/** Push until the outing ends, always taking the first tree still standing. */
function playOut(spot: GatherSpot, seed: number, stat: number, bankAfter = Infinity): GatherState {
  let state = startGather(spot, seed, stat);
  while (state.status === "active") {
    const choice: GatherChoice = state.step >= bankAfter ? { t: "bank" } : { t: "push", cell: state.trees.findIndex((_, i) => !state.picked.includes(i)) };
    const step = stepGather(state, choice);
    expect(step.error).toBeUndefined();
    state = step.state;
  }
  return state;
}

/** The first seed whose full push ends the given way. */
function seedEnding(spot: GatherSpot, status: GatherState["status"], stat = 9): number {
  for (let seed = 1; seed < 5000; seed++) if (playOut(spot, seed, stat).status === status) return seed;
  throw new Error(`no ${status} seed for ${spot}`);
}

describe("gathering", () => {
  it("replays exactly from a seed and the same choices", () => {
    for (const spot of GATHER_SPOT_IDS) {
      for (const seed of [1, 42, 99999, 0xdeadbeef]) {
        expect(playOut(spot, seed, 9)).toEqual(playOut(spot, seed, 9));
        expect(playOut(spot, seed, 9, 2)).toEqual(playOut(spot, seed, 9, 2));
      }
    }
  });

  it("gives different outings for different seeds", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const logs = new Set(Array.from({ length: 30 }, (_, seed) => JSON.stringify(playOut(spot, seed + 1, 9).log)));
      expect(logs.size).toBeGreaterThan(5);
    }
  });

  it("does not mutate the state it is given", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const state = startGather(spot, 7, 9);
      const before = JSON.stringify(state);
      stepGather(state, { t: "push", cell: 0 });
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it("uses the hero's stat for the chance per roll", () => {
    for (const spot of GATHER_SPOT_IDS) {
      expect(startGather(spot, 1, 4).pct).toBe(statPct(4));
      expect(startGather(spot, 1, 15).pct).toBe(statPct(15));
      const step = stepGather(startGather(spot, 1, 15), { t: "push", cell: 0 }).state;
      expect(step.log[0].check).toMatchObject({ stat: GATHER_SPOTS[spot].stat, pct: statPct(15) });
      expect(step.log[0].check!.rolls).toHaveLength(2);
    }
    // A stronger hero busts less often.
    const busts = (stat: number) => Array.from({ length: 400 }, (_, s) => playOut("quarry", s + 1, stat)).filter((s) => s.status === "bust").length;
    expect(busts(20)).toBeLessThan(busts(4));
  });

  it("pays only the spot's materials, within the bounds, whatever happens", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const pays = GATHER_SPOTS[spot].pays as string[];
      let best = 0;
      for (let seed = 1; seed <= 600; seed++) {
        for (const stat of [4, 9, 30]) {
          for (const bankAfter of [0, 1, 2, Infinity]) {
            const end = playOut(spot, seed, stat, bankAfter);
            const paid = gatherPayout(end);
            expect(Object.keys(paid).every((k) => pays.includes(k))).toBe(true);
            expect(Object.values(paid).every((n) => Number.isInteger(n) && n! > 0)).toBe(true);
            expect(units(paid)).toBeLessThanOrEqual(GATHER_MAX_UNITS);
            expect(end.step).toBeLessThanOrEqual(GATHER_MAX_STEPS);
            if (end.status === "banked") expect(units(paid)).toBeGreaterThanOrEqual(GATHER_MIN_BANK);
            else expect(paid).toEqual({});
            best = Math.max(best, units(paid));
          }
        }
      }
      // The best possible outing is worth about a fight: no more than three enemies' drops.
      expect(best).toBeGreaterThanOrEqual(4);
      expect(best).toBeLessThanOrEqual(3 * ENEMY_DROP_UNITS[1]);
    }
  });

  it("caps the payout even if a stored haul were inflated", () => {
    const state = { ...startGather("quarry", 1, 9), status: "banked" as const, haul: { stone: 50, iron: 50, wood: 9 } };
    expect(gatherPayout(state)).toEqual({ stone: GATHER_MAX_UNITS });
  });

  it("banks: an early bank always pays something and keeps the haul", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const empty = stepGather(startGather(spot, 3, 9), { t: "bank" }).state;
      expect(empty.status).toBe("banked");
      expect(gatherPayout(empty)).toEqual({ [GATHER_SPOTS[spot].pays[0]]: GATHER_MIN_BANK });

      // Find an outing that has something after one push, then bank it.
      for (let seed = 1; ; seed++) {
        const one = stepGather(startGather(spot, seed, 15), { t: "push", cell: 0 }).state;
        if (one.status !== "active" || units(one.haul) === 0) continue;
        expect(gatherPayout(one)).toEqual({});
        const banked = stepGather(one, { t: "bank" }).state;
        expect(gatherPayout(banked)).toEqual(one.haul);
        break;
      }
    }
  });

  it("banks by itself after the last push", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const end = playOut(spot, seedEnding(spot, "banked", 20), 20);
      expect(end.step).toBe(GATHER_MAX_STEPS);
      expect(units(gatherPayout(end))).toBeGreaterThan(0);
    }
  });

  it("busts: the haul is lost and nothing is paid", () => {
    for (const spot of GATHER_SPOT_IDS) {
      const end = playOut(spot, seedEnding(spot, "bust"), 9);
      expect(end.haul).toEqual({});
      expect(gatherPayout(end)).toEqual({});
      expect(gatherView(end).payout).toEqual({});
    }
  });

  it("refuses choices once an outing is over, and bad trees", () => {
    const over = playOut("fishing", 1, 9, 0);
    expect(stepGather(over, { t: "push" })).toEqual({ state: over, error: expect.any(String) });
    expect(stepGather(over, { t: "bank" }).error).toBeDefined();

    const trees = startGather("felling", 5, 30);
    for (const cell of [-1, 9, 1.5, undefined]) expect(stepGather(trees, { t: "push", cell }).error).toBeDefined();
    const safe = trees.trees.findIndex((k) => k !== "rotten");
    const one = stepGather(trees, { t: "push", cell: safe }).state;
    expect(stepGather(one, { t: "push", cell: safe })).toEqual({ state: one, error: expect.any(String) });
    expect(stepGather(trees, { t: "nope" } as unknown as GatherChoice).error).toBeDefined();
  });

  it("fishing: the line tightens with every reel", () => {
    let state = startGather("fishing", seedEnding("fishing", "banked", 20), 20);
    const seen: number[] = [];
    while (state.status === "active") {
      seen.push(gatherPct(state));
      state = stepGather(state, { t: "push" }).state;
    }
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(seen.length);
    expect(state.log.filter((e) => e.check).map((e) => e.check!.pct)).toEqual(seen);
  });

  it("felling: a fixed mix of trees; a rotten one needs both rolls", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const state = startGather("felling", seed, 9);
      expect(state.trees).toHaveLength(9);
      expect(state.trees.filter((k) => k === "rotten")).toHaveLength(FELLING_ROTTEN);
      expect(state.trees.filter((k) => k === "den")).toHaveLength(FELLING_DENS);
      const rotten = stepGather(state, { t: "push", cell: state.trees.indexOf("rotten") }).state;
      const check = rotten.log[0].check!;
      expect(rotten.status).toBe(check.perfect ? "active" : "bust");
      expect(rotten.haul).toEqual({});
      const den = stepGather(state, { t: "push", cell: state.trees.indexOf("den") }).state;
      expect(den.haul).toEqual(den.log[0].check!.successes ? { fur: den.log[0].check!.successes } : {});
    }
  });

  it("quarry: every missed roll is a crack, and the third brings the roof down", () => {
    for (let seed = 1; seed <= 300; seed++) {
      let state = startGather("quarry", seed, 9);
      let misses = 0;
      while (state.status === "active") {
        state = stepGather(state, { t: "push" }).state;
        misses = state.log.filter((e) => e.check).reduce((a, e) => a + e.check!.rolls.filter((r) => !r).length, 0);
        expect(state.cracks).toBe(misses);
      }
      expect(state.status === "bust").toBe(misses >= QUARRY_MAX_CRACKS);
    }
  });

  it("shows the client no seed, no RNG and no unpicked tree", () => {
    const state = startGather("felling", 11, 30);
    const safe = state.trees.findIndex((k) => k === "sound");
    const one = stepGather(state, { t: "push", cell: safe }).state;
    const view = gatherView(one);
    expect(view).not.toHaveProperty("seed");
    expect(view).not.toHaveProperty("rng");
    expect(JSON.stringify(view)).not.toContain(String(one.seed));
    expect(view.trees!.filter((t) => t.kind !== null)).toHaveLength(1);
    expect(view.trees![safe]).toMatchObject({ picked: true, kind: "sound" });
    expect(view.trees![safe].near).toBeTypeOf("number");
    // Once it is over the whole stand is shown.
    expect(gatherView(stepGather(one, { t: "bank" }).state).trees!.every((t) => t.kind !== null)).toBe(true);
    expect(gatherView(startGather("fishing", 1, 9)).trees).toBeNull();
  });
});

describe("gathering stamina", () => {
  const noon = Date.UTC(2026, 10, 11, 12);

  it("allows three outings a day and no more", () => {
    expect(GATHER_DAILY_OUTINGS).toBe(3);
    expect(outingsLeft(null, noon)).toBe(3);
    const day = gatherDay(noon);
    expect(day).toBe("2026-11-11");
    expect(outingsLeft({ day, used: 1 }, noon)).toBe(2);
    expect(outingsLeft({ day, used: 3 }, noon)).toBe(0);
    expect(outingsLeft({ day, used: 7 }, noon)).toBe(0);
  });

  it("resets at UTC midnight", () => {
    const day = gatherDay(noon);
    const midnight = Date.UTC(2026, 10, 12);
    expect(gatherResetAt(noon)).toBe(midnight);
    expect(outingsLeft({ day, used: 3 }, midnight - 1)).toBe(0);
    expect(outingsLeft({ day, used: 3 }, midnight)).toBe(3);
    expect(gatherResetAt(midnight)).toBe(midnight + 86_400_000);
  });
});
