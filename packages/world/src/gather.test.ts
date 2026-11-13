import { describe, expect, it } from "vitest";
import {
  ENEMY_DROP_UNITS,
  FELL_ROUND_MS,
  MAX_REPORTED,
  NEXT_LOG_MS,
  REGROW_MS,
  SPLIT_ROLLS,
  SWING_MS,
  TREES,
  TREE_SLOTS,
  replayChops,
  replayStrikes,
  splitGrade,
  splitMotion,
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
  type Chop,
  type Motion,
  type Resources,
} from "./index";


/** The spots played a push at a time. Felling is two timed rounds instead (see fellOut). */
const PUSH_SPOTS = ["fishing", "quarry"] as const;

/** Chops that bring down the given trees (by slot) one after another, as fast as an axe swings, waiting out any regrowth. */
function chopsFor(trees: number[], from = 0): Chop[] {
  const chops: Chop[] = [];
  let at = from - SWING_MS;
  const regrown = [0, 0, 0];
  for (const slot of trees) {
    for (let i = 0; i < TREES[TREE_SLOTS[slot]].chops; i++) {
      at = Math.max(at + SWING_MS, regrown[slot]);
      chops.push({ slot, at });
    }
    regrown[slot] = at + REGROW_MS;
  }
  return chops;
}

/** The first moment, from `from`, at which a strike on this marker lands with the grade wanted. */
function momentFor(m: Motion, grade: "perfect" | "good" | "miss", from = 0): number {
  for (let ms = from; ms < from + 20_000; ms++) if (splitGrade(m, ms) === grade) return ms;
  throw new Error(`no ${grade} moment`);
}

/** Strikes on each log in turn with the given grades (one a log, the last repeated), each as soon as it can land. */
function strikesFor(motions: Motion[], grades: ("perfect" | "good" | "miss")[]): number[] {
  const strikes: number[] = [];
  let logAt = 0;
  let last = -SWING_MS;
  motions.forEach((m, i) => {
    const grade = grades[Math.min(i, grades.length - 1)];
    const at = logAt + momentFor(m, grade, Math.max(0, last + SWING_MS - logAt));
    if (at > FELL_ROUND_MS) return;
    strikes.push(at);
    last = at;
    logAt = at + NEXT_LOG_MS;
  });
  return strikes;
}

const T0 = 1_000_000;

/** A whole felling outing: the given trees chopped (by default old oaks until time runs out), then each log struck with the given grades. */
function fellOut(seed: number, stat: number, opts: { trees?: number[]; grades?: ("perfect" | "good" | "miss")[]; bankAfterChop?: boolean } = {}): GatherState {
  let s = startGather("felling", seed, stat);
  s = stepGather(s, { t: "begin", now: T0 }).state;
  const trees = opts.trees ?? Array(10).fill(2);
  const chops = chopsFor(trees).filter((c) => c.at <= FELL_ROUND_MS);
  s = stepGather(s, { t: "chopped", chops, now: T0 + FELL_ROUND_MS }).state;
  if (s.status !== "active") return s;
  if (opts.bankAfterChop) return stepGather(s, { t: "bank" }).state;
  s = stepGather(s, { t: "begin", now: T0 + 60_000 }).state;
  const strikes = strikesFor(gatherView(s).felling!.motions, opts.grades ?? ["perfect"]);
  return stepGather(s, { t: "split", strikes, now: T0 + 60_000 + FELL_ROUND_MS }).state;
}

/**
 * Step an outing as a player would. A push first aims at the cell (for fishing, where it last cast or under the
 * gulls; for the quarry, the first block standing) and then stops the marker with no moment given, which counts as
 * "close" and leaves the chance as it is.
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

/** Push until the outing ends (the quarry the first block still standing, fishing where it last cast). Felling plays both rounds. */
function playOut(spot: GatherSpot, seed: number, stat: number, bankAfter = Infinity): GatherState {
  if (spot === "felling") return bankAfter === 0 ? stepGather(startGather(spot, seed, stat), { t: "bank" }).state : fellOut(seed, stat, { bankAfterChop: bankAfter === 1 });
  let state = startGather(spot, seed, stat);
  while (state.status === "active") {
    const choice: GatherChoice = state.step >= bankAfter ? { t: "bank" } : { t: "push" };
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
    for (const spot of PUSH_SPOTS) {
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
    // Tens of thousands of outings: about 2s locally, but past the 5s default
    // on a busy CI runner, where it failed a staging deploy.
  }, 30_000);

  it("caps the payout even if a stored haul were inflated", () => {
    const state = { ...startGather("quarry", 1, 9), status: "banked" as const, haul: { stone: 50, iron: 50, wood: 9 } };
    expect(gatherPayout(state)).toEqual({ stone: GATHER_MAX_UNITS });
  });

  it("banks: an early bank always pays something and keeps the haul", () => {
    for (const spot of PUSH_SPOTS) {
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
    for (const spot of PUSH_SPOTS) {
      const end = playOut(spot, seedEnding(spot, "banked", 20), 20);
      expect(end.step).toBe(GATHER_MAX_STEPS);
      expect(units(gatherPayout(end))).toBeGreaterThan(0);
    }
  });

  it("busts: the haul is lost and nothing is paid", () => {
    for (const spot of PUSH_SPOTS) {
      const end = playOut(spot, seedEnding(spot, "bust"), 9);
      expect(end.haul).toEqual({});
      expect(gatherPayout(end)).toEqual({});
      expect(gatherView(end).payout).toEqual({});
    }
  });

  it("refuses choices once an outing is over, and unknown ones", () => {
    const over = playOut("fishing", 1, 9, 0);
    expect(play(over, { t: "push" })).toEqual({ state: over, error: expect.any(String) });
    expect(play(over, { t: "bank" }).error).toBeDefined();
    for (const spot of GATHER_SPOT_IDS) expect(play(startGather(spot, 5, 30), { t: "nope" } as unknown as GatherChoice).error).toBeDefined();
    const felled = fellOut(5, 9);
    expect(stepGather(felled, { t: "begin", now: 1 }).error).toBeDefined();
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

  it("felling: two rounds, chopping then splitting, each begun by the server's clock", () => {
    const fresh = startGather("felling", 3, 9);
    expect(fresh.felling).toMatchObject({ phase: "ready-chop", logs: 0, wood: 0 });
    expect(gatherView(fresh).felling).toMatchObject({ phase: "ready-chop", roundMs: FELL_ROUND_MS, motions: [] });
    // Nothing to report before a round begins, and no pushing or aiming.
    expect(stepGather(fresh, { t: "chopped", chops: [], now: 5 }).error).toBeDefined();
    expect(stepGather(fresh, { t: "push" }).error).toBeDefined();
    expect(stepGather(fresh, { t: "aim", cell: 0 }).error).toBeDefined();
    const chopping = stepGather(fresh, { t: "begin", now: 777 }).state;
    expect(chopping.felling).toMatchObject({ phase: "chop", startedAt: 777 });
    expect(stepGather(chopping, { t: "begin", now: 800 }).error).toBeDefined();
    expect(stepGather(chopping, { t: "split", strikes: [], now: 800 }).error).toBeDefined();
    const chopped = stepGather(chopping, { t: "chopped", chops: chopsFor([2, 0]), now: 777 + FELL_ROUND_MS }).state;
    expect(chopped.felling!.phase).toBe("ready-split");
    expect(chopped.felling!.felled.map((t) => t.size)).toEqual(["large", "small"]);
    const splitting = stepGather(chopped, { t: "begin", now: 99_000 }).state;
    expect(splitting.felling).toMatchObject({ phase: "split", startedAt: 99_000 });
    const done = stepGather(splitting, { t: "split", strikes: strikesFor(gatherView(splitting).felling!.motions, ["perfect"]), now: 99_000 + FELL_ROUND_MS }).state;
    expect(done.status).toBe("banked");
    expect(done.felling!.phase).toBe("done");
    expect(done.haul).toEqual(done.felling!.wood ? { wood: done.felling!.wood } : {});
    expect(gatherPayout(done)).toEqual({ wood: Math.max(GATHER_MIN_BANK, Math.min(GATHER_MAX_UNITS, done.felling!.wood)) });
  });

  it("felling: a tree falls after its chops, and gives its logs plus a log for each Strength roll", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const end = fellOut(seed, 9, { trees: [0, 1, 2] });
      const felled = end.felling!.felled;
      expect(felled.map((t) => t.size)).toEqual(["small", "medium", "large"]);
      for (const t of felled) {
        const def = TREES[t.size];
        expect(t.logs).toBe(def.logs + (t.check?.successes ?? 0));
        expect(t.check?.rolls.length ?? 0).toBe(def.rolls);
      }
      expect(end.felling!.logs).toBe(felled.reduce((a, t) => a + t.logs, 0));
    }
    expect(TREES.small.chops).toBeLessThan(TREES.medium.chops);
    expect(TREES.medium.chops).toBeLessThan(TREES.large.chops);
  });

  it("felling: a tree still standing when the time is up gives nothing", () => {
    // Twelve of an old oak's thirteen chops.
    const chops = chopsFor([2]).slice(0, TREES.large.chops - 1);
    expect(replayChops(chops, FELL_ROUND_MS)).toEqual([]);
    // Partial work on one tree is kept while you fell another.
    const mixed = [...chopsFor([2]).slice(0, 6)];
    const small = chopsFor([0], mixed.at(-1)!.at + SWING_MS);
    const rest = chopsFor([2], small.at(-1)!.at + SWING_MS).slice(6);
    expect(replayChops([...mixed, ...small, ...rest], FELL_ROUND_MS).map((t) => t.size)).toEqual(["small", "large"]);
  });

  it("felling: drops chops no axe could make", () => {
    const fast = Array.from({ length: 20 }, (_, i) => ({ slot: 0, at: i * 100 }));
    // A swing every 100 ms counts one in four: twenty taps fell one sapling at most, not five.
    expect(replayChops(fast, FELL_ROUND_MS).length).toBeLessThanOrEqual(1);
    // Chopping a tree that has not grown back yet.
    const early = [...chopsFor([0]), { slot: 0, at: chopsFor([0]).at(-1)!.at + SWING_MS }];
    expect(replayChops([...early, ...chopsFor([0], early.at(-1)!.at + SWING_MS).slice(0, 3)], FELL_ROUND_MS)).toHaveLength(1);
    // Out of the round, before it began, at no tree, or later than the server says the round has run.
    expect(replayChops([{ slot: 0, at: -5 }, { slot: 3, at: 400 }, { slot: 1.5, at: 800 }, { slot: 0, at: FELL_ROUND_MS + 1 }], FELL_ROUND_MS)).toEqual([]);
    expect(replayChops(chopsFor([0]), 1000)).toEqual([]);
    // Out of order.
    expect(replayChops([...chopsFor([0])].reverse(), FELL_ROUND_MS)).toEqual([]);
    // Only so much of a report is read.
    expect(replayChops(chopsFor(Array(60).fill(0)), Infinity).length).toBeLessThanOrEqual(Math.ceil(MAX_REPORTED / TREES.small.chops));
  });

  it("felling: a report cannot claim more time than the server has seen the round run", () => {
    const s = stepGather(startGather("felling", 8, 9), { t: "begin", now: T0 }).state;
    // Reported five seconds in: only the chops in those five seconds count.
    const early = stepGather(s, { t: "chopped", chops: chopsFor(Array(10).fill(0)), now: T0 + 5000 }).state;
    expect(early.felling!.felled.every((t) => t.at <= 5050)).toBe(true);
    expect(early.felling!.felled.length).toBeGreaterThan(0);
  });

  it("felling: a split lands by the marker; a perfect rolls twice, a good once, and a miss leaves the log on the block", () => {
    const m: Motion = { kind: "swing", period: 1250, phase: 0, zone: 0.5, width: 0.24 };
    expect(splitGrade(m, momentFor(m, "perfect"))).toBe("perfect");
    // The marker never stops: no "too slow" on the block.
    expect(splitGrade(m, momentFor(m, "perfect", 60_000))).toBe("perfect");
    expect(SPLIT_ROLLS).toEqual({ perfect: 2, good: 1, miss: 0 });
    const motions = [m, m, m];
    const miss = momentFor(m, "miss");
    const hit = momentFor(m, "perfect", miss + SWING_MS);
    const { splits, misses } = replayStrikes([miss, hit], 3, () => m, FELL_ROUND_MS);
    expect(misses).toBe(1);
    expect(splits).toEqual([{ log: 0, at: hit, grade: "perfect" }]);
    // The next log's marker starts after it is up on the block.
    const next = hit + NEXT_LOG_MS + momentFor(m, "good");
    expect(replayStrikes([hit, next], 3, () => m, FELL_ROUND_MS).splits.map((x) => x.grade)).toEqual(["perfect", "good"]);
    // No more splits than logs, and none quicker than a swing.
    expect(replayStrikes(strikesFor([m, m, m, m, m], ["perfect"]), 2, () => m, FELL_ROUND_MS).splits).toHaveLength(2);
    expect(replayStrikes([hit, hit + 10], 3, () => m, FELL_ROUND_MS).splits).toHaveLength(1);
    void motions;
    for (let seed = 1; seed <= 100; seed++) {
      const end = fellOut(seed, 9, { trees: [2, 2], grades: ["perfect", "good"] });
      for (const sp of end.felling!.splits) {
        expect(sp.check.rolls).toHaveLength(SPLIT_ROLLS[sp.grade]);
        expect(sp.wood).toBe(sp.check.successes);
      }
      expect(end.felling!.wood).toBe(end.felling!.splits.reduce((a, x) => a + x.wood, 0));
    }
  });

  it("felling: accuracy and speed both pay", () => {
    const wood = (grades: ("perfect" | "good" | "miss")[], trees?: number[]) => {
      let sum = 0;
      for (let seed = 1; seed <= 300; seed++) sum += units(gatherPayout(fellOut(seed, 9, { grades, trees })));
      return sum;
    };
    expect(wood(["perfect"])).toBeGreaterThan(wood(["good"]));
    // A handful of saplings is not the haul of a round spent on old oaks.
    expect(wood(["perfect"], [0, 0])).toBeLessThan(wood(["perfect"]));
  });

  it("felling: no logs means no splitting round, and a bank pays at least the minimum", () => {
    const s = stepGather(startGather("felling", 2, 9), { t: "begin", now: T0 }).state;
    const none = stepGather(s, { t: "chopped", chops: [], now: T0 + FELL_ROUND_MS }).state;
    expect(none.status).toBe("banked");
    expect(gatherPayout(none)).toEqual({ wood: GATHER_MIN_BANK });
    const walked = stepGather(s, { t: "bank" }).state;
    expect(walked.status).toBe("banked");
    expect(gatherPayout(walked)).toEqual({ wood: GATHER_MIN_BANK });
  });

  it("felling: each log's marker comes from the seed, and a stronger hero gets a wider, slower one", () => {
    expect(splitMotion(4, 2, 50)).toEqual(splitMotion(4, 2, 50));
    expect(splitMotion(4, 2, 50)).not.toEqual(splitMotion(4, 3, 50));
    expect(splitMotion(4, 2, 90).width).toBeGreaterThan(splitMotion(4, 2, 30).width);
    expect(splitMotion(4, 2, 90).period).toBeGreaterThan(splitMotion(4, 2, 30).period);
  });

  it("felling: an outing from before the two rounds can only be carried home", () => {
    for (const old of [
      { ...startGather("felling", 9, 9), felling: undefined, timed: false, haul: { wood: 2 } },
      { ...startGather("felling", 9, 9), felling: undefined, grove: { knocked: [] }, haul: { wood: 2 } } as GatherState,
    ]) {
      expect(stepGather(old, { t: "begin", now: 1 }).error).toMatch(/carry it home/i);
      expect(stepGather(old, { t: "push", cell: 0 }).error).toBeDefined();
      expect(gatherView(old).felling).toBeNull();
      expect(gatherPayout(stepGather(old, { t: "bank" }).state)).toEqual({ wood: 2 });
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

  it("shows the client no seed and no RNG", () => {
    const one = fellOut(2_946_311_877, 30);
    const view = gatherView(one);
    expect(view).not.toHaveProperty("seed");
    expect(view).not.toHaveProperty("rng");
    expect(JSON.stringify(view)).not.toContain(String(one.seed));
    expect(view.felling!.motions).toHaveLength(one.felling!.logs);
    expect(gatherView(startGather("fishing", 1, 9)).felling).toBeNull();
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

  it("gives back one outing on a bedroll and all of them at home", () => {
    expect(REST_OUTINGS.bedroll).toBe(1);
    expect(REST_OUTINGS.hut).toBe(GATHER_DAILY_OUTINGS);
  });
});

describe("timed gathering", () => {
  it("makes fishing and the quarry aim first", () => {
    for (const spot of PUSH_SPOTS) {
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
