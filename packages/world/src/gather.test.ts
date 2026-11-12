import { describe, expect, it } from "vitest";
import {
  ENEMY_DROP_UNITS,
  FELLING_DENS,
  FELLING_ROTTEN,
  GATHER_DAILY_OUTINGS,
  REST_COOLDOWN_MS,
  REST_OUTINGS,
  restProblem,
  restReadyAt,
  GATHER_MAX_STEPS,
  GATHER_MAX_UNITS,
  GATHER_MIN_BANK,
  GATHER_SPOTS,
  GATHER_SPOT_IDS,
  FISHING_CELLS,
  FISHING_READ,
  QUARRY_ORE,
  TIMING,
  TIMING_LIMIT_MS,
  markerAt,
  timingEase,
  timingGrade,
  QUARRY_WEAK,
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


/**
 * Step an outing as a player would. A push on a timed spot (fishing, the quarry) first aims at the cell (for fishing,
 * where it last cast or under the gulls; for the quarry, the first block standing) and then stops the marker with no
 * moment given, which counts as "close" and leaves the chance as it is.
 */
function play(state: GatherState, choice: GatherChoice): ReturnType<typeof stepGather> {
  if (choice.t === "push" && state.timed && !state.aim && state.status === "active") {
    const cell = choice.cell ?? (state.spot === "fishing" ? (state.water!.casts.at(-1)?.cell ?? state.water!.gulls) : state.face!.findIndex((_, i) => !state.picked.includes(i)));
    const aimed = stepGather(state, { t: "aim", cell });
    if (aimed.error) return aimed;
    return stepGather(aimed.state, { t: "push", at: choice.at });
  }
  return stepGather(state, choice);
}

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

/** Push until the outing ends, always taking the first tree still standing. */
function playOut(spot: GatherSpot, seed: number, stat: number, bankAfter = Infinity): GatherState {
  let state = startGather(spot, seed, stat);
  while (state.status === "active") {
    // Felling and the quarry take the first tree or block still standing; fishing casts where it last did.
    const cell = state.spot === "felling" ? state.trees.findIndex((_, i) => !state.picked.includes(i)) : undefined;
    const choice: GatherChoice = state.step >= bankAfter ? { t: "bank" } : { t: "push", cell };
    const step = play(state, choice);
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
      play(state, { t: "push", cell: 0 });
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it("uses the hero's stat for the chance per roll", () => {
    for (const spot of GATHER_SPOT_IDS) {
      expect(startGather(spot, 1, 4).pct).toBe(statPct(4));
      expect(startGather(spot, 1, 15).pct).toBe(statPct(15));
      const fresh = startGather(spot, 1, 15);
      // Fishing shifts the chance by how near the cast is, so cast one place off the school, where it does not.
      const cell = spot === "fishing" ? (fresh.water!.school > 0 ? fresh.water!.school - 1 : 1) : 0;
      const step = play(fresh, { t: "push", cell }).state;
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
      const empty = play(startGather(spot, 3, 9), { t: "bank" }).state;
      expect(empty.status).toBe("banked");
      expect(gatherPayout(empty)).toEqual({ [GATHER_SPOTS[spot].pays[0]]: GATHER_MIN_BANK });

      // Find an outing that has something after one push, then bank it.
      for (let seed = 1; ; seed++) {
        const one = play(startGather(spot, seed, 15), { t: "push", cell: 0 }).state;
        if (one.status !== "active" || units(one.haul) === 0) continue;
        expect(gatherPayout(one)).toEqual({});
        const banked = play(one, { t: "bank" }).state;
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
    expect(play(over, { t: "push" })).toEqual({ state: over, error: expect.any(String) });
    expect(play(over, { t: "bank" }).error).toBeDefined();

    const trees = startGather("felling", 5, 30);
    for (const cell of [-1, 9, 1.5, undefined]) expect(play(trees, { t: "push", cell }).error).toBeDefined();
    const safe = trees.trees.findIndex((k) => k !== "rotten");
    const one = play(trees, { t: "push", cell: safe }).state;
    expect(play(one, { t: "push", cell: safe })).toEqual({ state: one, error: expect.any(String) });
    expect(play(trees, { t: "nope" } as unknown as GatherChoice).error).toBeDefined();
  });

  it("fishing: the line tightens with every cast", () => {
    let state = startGather("fishing", seedEnding("fishing", "banked", 20), 20);
    const seen: number[] = [];
    while (state.status === "active") {
      seen.push(gatherPct(state));
      state = play(state, { t: "push" }).state;
    }
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("fishing: a cast reads how near the school is and which way, and nearer is better", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const state = startGather("fishing", seed, 9);
      const { school, gulls } = state.water!;
      // The gulls start within a place of the school.
      expect(Math.abs(gulls - school)).toBeLessThanOrEqual(1);
      for (let cell = 0; cell < FISHING_CELLS; cell++) {
        const cast = play(state, { t: "push", cell }).state;
        const off = school - cell;
        expect(cast.water!.casts[0]).toEqual({ cell, read: off === 0 ? "on" : Math.abs(off) === 1 ? "near" : "far", dir: Math.sign(off) });
        expect(cast.log[0].check!.pct).toBe(statPct(9) + (off === 0 ? FISHING_READ : Math.abs(off) === 1 ? 0 : -FISHING_READ));
        // The school drifts a place at most.
        expect(Math.abs(cast.water!.school - school)).toBeLessThanOrEqual(1);
      }
    }
    expect(play(startGather("fishing", 3, 9), { t: "push", cell: 99 }).error).toBeDefined();
  });

  it("fishing: following the reads lands more than casting blind", () => {
    const total = (follow: boolean) => {
      let sum = 0;
      for (let seed = 1; seed <= 600; seed++) {
        let state = startGather("fishing", seed, 9);
        let cell = follow ? state.water!.gulls : 0;
        while (state.status === "active") {
          state = play(state, { t: "push", cell }).state;
          const last = state.water!.casts.at(-1)!;
          if (follow) cell = Math.max(0, Math.min(FISHING_CELLS - 1, cell + last.dir * (last.read === "far" ? 2 : last.read === "near" ? 1 : 0)));
        }
        sum += units(gatherPayout(state));
      }
      return sum;
    };
    expect(total(true)).toBeGreaterThan(total(false) * 1.3);
  });

  it("felling: a fixed mix of trees; a rotten one needs both rolls", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const state = startGather("felling", seed, 9);
      expect(state.trees).toHaveLength(9);
      expect(state.trees.filter((k) => k === "rotten")).toHaveLength(FELLING_ROTTEN);
      expect(state.trees.filter((k) => k === "den")).toHaveLength(FELLING_DENS);
      const rotten = play(state, { t: "push", cell: state.trees.indexOf("rotten") }).state;
      const check = rotten.log[0].check!;
      expect(rotten.status).toBe(check.perfect ? "active" : "bust");
      expect(rotten.haul).toEqual({});
      const den = play(state, { t: "push", cell: state.trees.indexOf("den") }).state;
      expect(den.haul).toEqual(den.log[0].check!.successes ? { fur: den.log[0].check!.successes } : {});
    }
  });

  it("quarry: a fixed mix of blocks; a weak one is two cracks, a double miss is one", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const start = startGather("quarry", seed, 9);
      expect(start.face).toHaveLength(9);
      expect(start.face!.filter((k) => k === "weak")).toHaveLength(QUARRY_WEAK);
      expect(start.face!.filter((k) => k === "ore")).toHaveLength(QUARRY_ORE);
      const weak = play(start, { t: "push", cell: start.face!.indexOf("weak") }).state;
      expect(weak.cracks).toBe(2);
      expect(weak.haul).toEqual({});
      const stone = play(start, { t: "push", cell: start.face!.indexOf("stone") }).state;
      const check = stone.log[0].check!;
      expect(stone.cracks).toBe(check.fumble ? 1 : 0);
      expect(stone.haul).toEqual(check.successes ? { stone: check.successes } : {});
      const ore = play(start, { t: "push", cell: start.face!.indexOf("ore") }).state;
      expect(Object.keys(ore.haul).every((k) => k === "iron" || k === "copper")).toBe(true);
      // The second weak block brings the roof down.
      const both = play(weak, { t: "push", cell: start.face!.lastIndexOf("weak") }).state;
      expect(both.status).toBe("bust");
      expect(play(weak, { t: "push", cell: start.face!.indexOf("weak") }).error).toBeDefined();
    }
  });

  it("quarry: the dust along each row and column counts its weak blocks, and never names them", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const state = startGather("quarry", seed, 9);
      const view = gatherView(state);
      expect(view.face!.rows.reduce((a, n) => a + n, 0)).toBe(QUARRY_WEAK);
      expect(view.face!.cols.reduce((a, n) => a + n, 0)).toBe(QUARRY_WEAK);
      state.face!.forEach((kind, i) => {
        if (kind === "weak") expect(view.face!.rows[Math.floor(i / 3)]).toBeGreaterThan(0);
      });
      expect(view.face!.blocks.every((b) => b.kind === null && b.oreNear === null)).toBe(true);
      const cut = gatherView(play(state, { t: "push", cell: state.face!.indexOf("stone") }).state);
      expect(cut.face!.blocks.filter((b) => b.kind !== null)).toHaveLength(1);
      expect(cut.face!.blocks[state.face!.indexOf("stone")].oreNear).toBeTypeOf("number");
    }
  });

  it("quarry: reading the dust caves in far less often than cutting blind", () => {
    const busts = (read: boolean) => {
      let n = 0;
      for (let seed = 1; seed <= 600; seed++) {
        let state = startGather("quarry", seed, 9);
        const view = gatherView(state).face!;
        // A block is certainly safe if its row or its column has no dust.
        const safe = state.face!.map((_, i) => i).filter((i) => view.rows[Math.floor(i / 3)] === 0 || view.cols[i % 3] === 0);
        while (state.status === "active") {
          const open = (read ? safe : state.face!.map((_, i) => i)).filter((i) => !state.picked.includes(i));
          state = play(state, open.length > 0 ? { t: "push", cell: open[0] } : { t: "bank" }).state;
        }
        if (state.status === "bust") n++;
      }
      return n;
    };
    expect(busts(true)).toBeLessThan(busts(false) / 2);
  });

  it("shows the client no seed, no RNG and no unpicked tree", () => {
    const state = startGather("felling", 11, 30);
    const safe = state.trees.findIndex((k) => k === "sound");
    const one = play(state, { t: "push", cell: safe }).state;
    const view = gatherView(one);
    expect(view).not.toHaveProperty("seed");
    expect(view).not.toHaveProperty("rng");
    expect(JSON.stringify(view)).not.toContain(String(one.seed));
    expect(view.trees!.filter((t) => t.kind !== null)).toHaveLength(1);
    expect(view.trees![safe]).toMatchObject({ picked: true, kind: "sound" });
    expect(view.trees![safe].near).toBeTypeOf("number");
    // Once it is over the whole stand is shown.
    expect(gatherView(play(one, { t: "bank" }).state).trees!.every((t) => t.kind !== null)).toBe(true);
    expect(gatherView(startGather("fishing", 1, 9)).trees).toBeNull();
    // Nor where the school is, until the outing is over.
    const water = startGather("fishing", 7, 9);
    expect(gatherView(water).water!.school).toBeNull();
    expect(gatherView(play(water, { t: "bank" }).state).water!.school).toBe(water.water!.school);
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

describe("resting", () => {
  const noon = Date.UTC(2026, 10, 11, 12);
  const today = gatherDay(noon);

  it("does nothing for someone who is not tired, and waits out its cooldown", () => {
    expect(restProblem(null, noon)).toMatch(/not tired/);
    expect(restProblem({ day: today, used: 0 }, noon)).toMatch(/not tired/);
    expect(restProblem({ day: "2020-01-01", used: 3 }, noon)).toMatch(/not tired/);
    expect(restProblem({ day: today, used: 2 }, noon)).toBeNull();
    expect(restProblem({ day: today, used: 2, rested_at: noon - 5 * 60_000 }, noon)).toMatch(/15 min/);
    expect(restProblem({ day: today, used: 2, rested_at: noon - REST_COOLDOWN_MS }, noon)).toBeNull();
    expect(restReadyAt(null)).toBe(0);
    expect(restReadyAt(noon)).toBe(noon + 20 * 60_000);
  });

  it("gives back more at home than on a bedroll, and never more than a day's outings", () => {
    expect(REST_OUTINGS.hut).toBeGreaterThan(REST_OUTINGS.bedroll);
    expect(REST_OUTINGS.hut).toBeLessThan(GATHER_DAILY_OUTINGS);
  });
});

describe("timed gathering", () => {
  it("makes fishing and the quarry aim first, and felling not", () => {
    for (const spot of ["fishing", "quarry"] as const) {
      const state = startGather(spot, 4, 9);
      expect(state.timed).toBe(true);
      expect(stepGather(state, { t: "push" }).error).toBeDefined();
      const aimed = stepGather(state, { t: "aim", cell: 1, now: 1000 }).state;
      expect(aimed.aim).toMatchObject({ cell: 1, startedAt: 1000 });
      expect(gatherView(aimed).aim!.motion).toEqual(aimed.aim!.motion);
      expect(gatherView(aimed)).not.toHaveProperty("aim.startedAt");
      // One marker at a time.
      expect(stepGather(aimed, { t: "aim", cell: 2 }).error).toBeDefined();
      const stopped = stepGather(aimed, { t: "push", at: 300 }).state;
      expect(stopped.aim).toBeUndefined();
      expect(stopped.log.at(-1)!.timing).toBeDefined();
    }
    expect(stepGather(startGather("felling", 4, 9), { t: "aim", cell: 0 }).error).toBeDefined();
  });

  it("grades a stop by how near the marker was to the mark, and too slow is a miss", () => {
    const m = { kind: "swing" as const, period: 1500, phase: 0, zone: 0.5, width: 0.16 };
    // A swing starts at one end and crosses the middle a quarter of the way through.
    expect(markerAt(m, 0)).toBeCloseTo(0, 5);
    expect(markerAt(m, 375)).toBeCloseTo(0.5, 5);
    expect(timingGrade(m, 375)).toBe("perfect");
    expect(timingGrade(m, 0)).toBe("miss");
    expect(timingGrade(m, TIMING_LIMIT_MS + 1)).toBe("late");
    expect(timingGrade(m, undefined)).toBe("close");
    for (let ms = 0; ms < 1500; ms += 7) expect(markerAt(m, ms)).toBeGreaterThanOrEqual(0);
  });

  it("moves the chance per roll by the grade", () => {
    const aimed = stepGather(startGather("quarry", 8, 9), { t: "aim", cell: 0, now: 0 }).state;
    const m = aimed.aim!.motion;
    // Find a perfect moment and a missed one in the first cycle.
    let perfect = -1;
    let miss = -1;
    for (let ms = 0; ms < m.period && (perfect < 0 || miss < 0); ms++) {
      const g = timingGrade(m, ms);
      if (g === "perfect" && perfect < 0) perfect = ms;
      if (g === "miss" && miss < 0) miss = ms;
    }
    const good = stepGather(aimed, { t: "push", at: perfect }).state.log.at(-1)!;
    const bad = stepGather(aimed, { t: "push", at: miss }).state.log.at(-1)!;
    expect(good.timing).toBe("perfect");
    expect(bad.timing).toBe("miss");
    expect(good.check!.pct - bad.check!.pct).toBe(TIMING.perfect.bonus - TIMING.miss.bonus);
  });

  it("gives a stronger hero a wider mark and a slower marker", () => {
    for (const spot of ["fishing", "quarry"] as const) {
      const weak = stepGather(startGather(spot, 6, 2), { t: "aim", cell: 0 }).state.aim!.motion;
      const strong = stepGather(startGather(spot, 6, 20), { t: "aim", cell: 0 }).state.aim!.motion;
      expect(strong.width).toBeGreaterThan(weak.width);
      expect(strong.period).toBeGreaterThan(weak.period);
    }
    expect(timingEase(20)).toEqual({ width: 0.7, pace: 0.85 });
    expect(timingEase(95)).toEqual({ width: 1.4, pace: 1.25 });
  });

  it("speeds the fish up as the line tightens", () => {
    let state = startGather("fishing", 12, 9);
    const periods: number[] = [];
    while (state.status === "active" && periods.length < 3) {
      state = stepGather(state, { t: "aim", cell: state.water!.gulls }).state;
      periods.push(state.aim!.motion.period);
      state = stepGather(state, { t: "push", at: 0 }).state;
    }
    expect(periods).toEqual([...periods].sort((a, b) => b - a));
  });
});
