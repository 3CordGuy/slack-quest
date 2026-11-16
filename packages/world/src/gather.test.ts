import { describe, expect, it } from "vitest";
import {
  ENEMY_DROP_UNITS,
  ANGLE_MAX,
  ANGLE_MIN,
  CHOP_GAP_MS,
  FELL_DEPTH,
  FELL_ROUND_MS,
  MAX_CHOPS,
  NEXT_LOG_MS,
  REGROW_MS,
  SPLIT_WOOD,
  biteOf,
  chopTree,
  cutAngle,
  freshCut,
  reachOf,
  splitWood,
  SWING_MS,
  TREES,
  TREE_SLOTS,
  replayChops,
  replayStrikes,
  splitGrade,
  splitMotion,
  type TreeSize,
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
  MINE_MS,
  MINE_RECOVER_MS,
  TIMING,
  TIMING_LIMIT_MS,
  markerAt,
  timingEase,
  timingGrade,
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
/** The spots played by pushing on: only fishing now. Felling and the quarry are played in the world (felling.test, mine.test). */
const PUSH_SPOTS = ["fishing"] as const;

/**
 * The chops that bring down one tree of `size`, the way a player would: cut from above until the axe binds, then
 * from below to meet it, notch after notch, at `angle` degrees, a chop every `gap` ms from `from`.
 */
function treeChops(slot: number, from: number, gap = 120, angle = 40): Chop[] {
  const size = TREE_SLOTS[slot];
  const chops: Chop[] = [];
  let cut = freshCut();
  let side = 1;
  for (let at = from; chops.length < 500; at += gap) {
    chops.push({ slot, at, angle: side * angle });
    const r = chopTree(cut, size, side * angle);
    if (r.result === "felled") return chops;
    cut = r.cut;
    if (r.result === "chunk") side = 1;
    else if (side > 0 && cut.top >= Math.min(1, cut.floor + reachOf(size, angle)) - 1e-9) side = -1;
  }
  throw new Error("never fell");
}

/** Chops that bring down the given trees (by slot) one after another, waiting out any regrowth. */
function chopsFor(trees: number[], from = 0, gap = 120, angle = 40): Chop[] {
  const chops: Chop[] = [];
  const regrown = [0, 0, 0];
  let at = from;
  for (const slot of trees) {
    at = Math.max(at, regrown[slot]);
    const one = treeChops(slot, at, gap, angle);
    chops.push(...one);
    at = one.at(-1)!.at + gap;
    regrown[slot] = one.at(-1)!.at + REGROW_MS;
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

/** A whole felling outing: the given trees chopped (by default old oaks until time runs out), reported when the round ends. */
function fellOut(seed: number, stat: number, opts: { trees?: number[]; gap?: number } = {}): GatherState {
  let s = startGather("felling", seed, stat);
  s = stepGather(s, { t: "begin", now: T0 }).state;
  const trees = opts.trees ?? Array(10).fill(2);
  const chops = chopsFor(trees, 0, opts.gap).filter((c) => c.at <= FELL_ROUND_MS);
  return stepGather(s, { t: "chopped", chops, now: T0 + FELL_ROUND_MS }).state;
}

/**
 * Step an outing as a player would. A push first aims at the cell (where it last cast or under the gulls) and then
 * stops the marker with no moment given, which counts as "close" and leaves the chance as it is.
 */
function play(state: GatherState, choice: GatherChoice): ReturnType<typeof stepGather> {
  if (choice.t === "push" && state.timed && !state.aim && state.status === "active") {
    const cell = choice.cell ?? state.water!.casts.at(-1)?.cell ?? state.water!.gulls;
    const aimed = stepGather(state, { t: "aim", cell });
    if (aimed.error) return aimed;
    return stepGather(aimed.state, { t: "push", at: choice.at });
  }
  return stepGather(state, choice);
}

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

/**
 * The quarry, played plainly: start the clock and tap the first rock still standing as fast as the pick allows,
 * hauling out once `bankAfter` rocks have given way or the clock runs out.
 */
function mineOut(seed: number, stat: number, bankAfter = Infinity): GatherState {
  let state = stepGather(startGather("quarry", seed, stat), { t: "dig", now: 0 }).state;
  for (let at = 0; at <= MINE_MS && state.step < bankAfter; at += MINE_RECOVER_MS) {
    const id = state.mine!.rocks.findIndex((r) => !r.broken);
    if (id < 0) break;
    const step = stepGather(state, { t: "blows", blows: [{ cell: state.mine!.rocks[id].cell, power: 1, at }], now: at });
    expect(step.error).toBeUndefined();
    state = step.state;
  }
  return stepGather(state, { t: "bank" }).state;
}

/** Push until the outing ends (fishing where it last cast). Felling plays its round; the quarry taps away at its face. */
function playOut(spot: GatherSpot, seed: number, stat: number, bankAfter = Infinity): GatherState {
  if (spot === "felling") return bankAfter === 0 ? stepGather(startGather(spot, seed, stat), { t: "bank" }).state : fellOut(seed, stat);
  if (spot === "quarry") return mineOut(seed, stat, bankAfter);
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
      // Felling played the same way only differs by its Strength rolls for logs.
      expect(logs.size).toBeGreaterThan(spot === "felling" ? 2 : 5);
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
    const busts = (stat: number) => Array.from({ length: 400 }, (_, s) => playOut("fishing", s + 1, stat)).filter((s) => s.status === "bust").length;
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
            if (spot === "fishing") expect(end.step).toBeLessThanOrEqual(GATHER_MAX_STEPS);
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
    const state = { ...startGather("fishing", 1, 9), status: "banked" as const, haul: { bone: 50, copper: 50, wood: 9 } };
    expect(gatherPayout(state)).toEqual({ bone: GATHER_MAX_UNITS });
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

  it("felling: one round, begun by the server's clock, paying a piece of firewood a log", () => {
    const fresh = startGather("felling", 3, 9);
    expect(fresh.felling).toMatchObject({ phase: "ready-chop", logs: 0, wood: 0 });
    expect(gatherView(fresh).felling).toMatchObject({ phase: "ready-chop", roundMs: FELL_ROUND_MS });
    // Nothing to report before the round begins, and no pushing or aiming.
    expect(stepGather(fresh, { t: "chopped", chops: [], now: 5 }).error).toBeDefined();
    expect(stepGather(fresh, { t: "push" }).error).toBeDefined();
    expect(stepGather(fresh, { t: "aim", cell: 0 }).error).toBeDefined();
    const chopping = stepGather(fresh, { t: "begin", now: 777 }).state;
    expect(chopping.felling).toMatchObject({ phase: "chop", startedAt: 777 });
    expect(stepGather(chopping, { t: "begin", now: 800 }).error).toBeDefined();
    const done = stepGather(chopping, { t: "chopped", chops: chopsFor([2, 0]), now: 777 + FELL_ROUND_MS }).state;
    expect(done.status).toBe("banked");
    expect(done.felling!.phase).toBe("done");
    expect(done.felling!.felled.map((t) => t.size)).toEqual(["large", "small"]);
    expect(done.felling!.wood).toBe(Math.min(GATHER_MAX_UNITS, done.felling!.logs));
    expect(done.haul).toEqual({ wood: done.felling!.wood });
    expect(gatherPayout(done)).toEqual({ wood: Math.max(GATHER_MIN_BANK, done.felling!.wood) });
  });

  it("felling: a tree falls once the notch is down to an eighth, and gives its logs plus a log for each Strength roll", () => {
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
    // The last chunk out is the one that takes the notch past seven eighths; none before it does.
    for (const size of TREE_SLOTS) {
      const chops = treeChops(TREE_SLOTS.indexOf(size), 0);
      let cut = freshCut();
      for (const [i, c] of chops.entries()) {
        const r = chopTree(cut, size, c.angle);
        expect(r.result === "felled").toBe(i === chops.length - 1);
        if (r.result === "felled") expect(r.notch!.depth).toBeGreaterThanOrEqual(FELL_DEPTH);
        else expect(r.cut.floor).toBeLessThan(FELL_DEPTH);
        cut = r.cut;
      }
    }
    // Thicker trees take more chops.
    const count = (slot: number) => treeChops(slot, 0).length;
    expect(count(0)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThan(count(2));
  });

  it("felling: a cut only goes so deep; the chunk comes out when a cut from the other side meets it", () => {
    let cut = freshCut();
    // From above alone: it bites, then binds, and never comes down however long you go at it.
    const results = [];
    for (let i = 0; i < 200; i++) {
      const r = chopTree(cut, "small", 40);
      results.push(r.result);
      cut = r.cut;
    }
    expect(results[0]).toBe("bite");
    expect(results.at(-1)).toBe("bound");
    expect(results).not.toContain("chunk");
    expect(cut.floor).toBe(0);
    expect(cut.top).toBeCloseTo(reachOf("small", 40));
    expect(cut.notches).toEqual([]);
    // From below, until the cuts meet: out comes the wedge, as deep as the cut above went, with both angles.
    let r = chopTree(cut, "small", -40);
    expect(r.result).toBe("bite");
    while (r.result === "bite") r = chopTree(r.cut, "small", -40);
    expect(r.result).toBe("chunk");
    expect(r.notch).toEqual({ depth: cut.top, top: 40, bottom: -40 });
    expect(r.cut).toMatchObject({ floor: cut.top, top: cut.top, bottom: cut.top });
    // A cut that binds short of the other frees the wedge as far as it got.
    let shallow = chopTree(freshCut(), "large", 65).cut;
    for (let i = 0; i < 100; i++) shallow = chopTree(shallow, "large", 65).cut;
    let low = chopTree(shallow, "large", -20);
    while (low.result === "bite") low = chopTree(low.cut, "large", -20);
    expect(low.result).toBe("chunk");
    expect(low.notch!.depth).toBeCloseTo(reachOf("large", -20));
    expect(low.notch!.depth).toBeLessThan(shallow.top);
  });

  it("felling: a flat cut bites deeper, a steep one runs further before it binds", () => {
    for (const size of TREE_SLOTS) {
      expect(biteOf(size, 20)).toBeGreaterThan(biteOf(size, 45));
      expect(biteOf(size, 45)).toBeGreaterThan(biteOf(size, 65));
      expect(reachOf(size, 20)).toBeLessThan(reachOf(size, 45));
      expect(reachOf(size, 45)).toBeLessThan(reachOf(size, -65));
      expect(biteOf(size, -30)).toBe(biteOf(size, 30));
    }
    expect(biteOf("small", 30)).toBeGreaterThan(biteOf("large", 30));
    // Angles are whole degrees, kept between the flattest and steepest a cut may go.
    expect([cutAngle(5), cutAngle(-5), cutAngle(0), cutAngle(80), cutAngle(-33.4), cutAngle("x"), cutAngle(NaN)]).toEqual([ANGLE_MIN, -ANGLE_MIN, ANGLE_MIN, ANGLE_MAX, -33, null, null]);
    // Steep cuts take fewer notches; flat ones fewer chops.
    const notches = (angle: number) => {
      let cut = freshCut();
      let n = 0;
      for (const c of treeChops(2, 0, 120, angle)) {
        const r = chopTree(cut, "large", c.angle);
        if (r.notch) n++;
        cut = r.cut;
      }
      return n;
    };
    expect(notches(65)).toBeLessThan(notches(20));
    expect(treeChops(2, 0, 120, 20).length).toBeLessThan(treeChops(2, 0, 120, 65).length);
  });

  it("felling: the quicker you chop, the more comes down; a tree still standing when the time is up gives nothing", () => {
    // All but the last chop of an old oak.
    expect(replayChops(treeChops(2, 0).slice(0, -1), FELL_ROUND_MS)).toEqual([]);
    // Work on one tree is kept while you fell another.
    const oak = treeChops(2, 0);
    const half = oak.slice(0, 20);
    const sapling = treeChops(0, half.at(-1)!.at + 100);
    const rest = oak.slice(20).map((c, i) => ({ ...c, at: sapling.at(-1)!.at + 100 * (i + 1) }));
    expect(replayChops([...half, ...sapling, ...rest], FELL_ROUND_MS).map((t) => t.size)).toEqual(["small", "large"]);
    // Clicking faster fells more in the round.
    const felled = (gap: number) => fellOut(4, 9, { gap }).felling!.felled.length;
    expect(felled(90)).toBeGreaterThan(felled(250));
  });

  it("felling: drops chops that could not have happened", () => {
    // Quicker than CHOP_GAP_MS: only every few count.
    const fast = treeChops(0, 0, 10);
    expect(replayChops(fast, FELL_ROUND_MS)).toEqual([]);
    expect(replayChops(treeChops(0, 0, CHOP_GAP_MS), FELL_ROUND_MS)).toHaveLength(1);
    // Chopping a tree that has not grown back yet.
    const first = treeChops(0, 0);
    const again = treeChops(0, first.at(-1)!.at + 100);
    expect(replayChops([...first, ...again], FELL_ROUND_MS)).toHaveLength(1);
    expect(replayChops([...first, ...treeChops(0, first.at(-1)!.at + REGROW_MS)], FELL_ROUND_MS)).toHaveLength(2);
    // Out of the round, before it began, at no tree, at no angle, or later than the server says the round has run.
    const bad = [{ slot: 0, at: -5, angle: 30 }, { slot: 3, at: 400, angle: 30 }, { slot: 1.5, at: 800, angle: 30 }, { slot: 0, at: FELL_ROUND_MS + 1, angle: 30 }, { slot: 0, at: 900, angle: "up" as unknown as number }];
    expect(replayChops(bad, FELL_ROUND_MS)).toEqual([]);
    expect(replayChops(treeChops(0, 0), 500)).toEqual([]);
    // Out of order.
    expect(replayChops([...treeChops(0, 0)].reverse(), FELL_ROUND_MS)).toEqual([]);
    // Only so much of a report is read.
    expect(replayChops(chopsFor(Array(200).fill(0), 0, CHOP_GAP_MS), Infinity).length).toBeLessThanOrEqual(Math.ceil(MAX_CHOPS / 10));
  });

  it("felling: a report cannot claim more time than the server has seen the round run", () => {
    const s = stepGather(startGather("felling", 8, 9), { t: "begin", now: T0 }).state;
    // Reported five seconds in: only the chops in those five seconds count.
    const early = stepGather(s, { t: "chopped", chops: chopsFor(Array(10).fill(0)), now: T0 + 5000 }).state;
    expect(early.felling!.felled.every((t) => t.at <= 5050)).toBe(true);
    expect(early.felling!.felled.length).toBeGreaterThan(0);
  });

  it("felling: a round on the old oaks out-yields one on saplings, and a round of nothing pays the minimum", () => {
    const wood = (trees: number[]) => {
      let sum = 0;
      for (let seed = 1; seed <= 200; seed++) sum += units(gatherPayout(fellOut(seed, 9, { trees })));
      return sum;
    };
    expect(wood(Array(10).fill(2))).toBeGreaterThan(wood(Array(20).fill(0)));
    expect(wood([0, 0])).toBeLessThan(wood(Array(10).fill(2)));
    const s = stepGather(startGather("felling", 2, 9), { t: "begin", now: T0 }).state;
    const none = stepGather(s, { t: "chopped", chops: [], now: T0 + FELL_ROUND_MS }).state;
    expect(none.status).toBe("banked");
    expect(gatherPayout(none)).toEqual({ wood: GATHER_MIN_BANK });
    const walked = stepGather(s, { t: "bank" }).state;
    expect(walked.status).toBe("banked");
    expect(gatherPayout(walked)).toEqual({ wood: GATHER_MIN_BANK });
  });

  it("felling: an outing caught between the old chopping and splitting rounds carries its logs home as firewood", () => {
    const base = startGather("felling", 6, 9);
    for (const phase of ["ready-split", "split"] as const) {
      const old: GatherState = { ...base, felling: { ...base.felling!, phase, logs: 5 } };
      for (const choice of [{ t: "begin", now: 1 }, { t: "split", strikes: [], now: 1 }, { t: "bank" }] as GatherChoice[]) {
        const end = stepGather(old, choice).state;
        expect(end.status).toBe("banked");
        expect(gatherPayout(end)).toEqual({ wood: 5 });
      }
    }
  });

  it("felling: an outing from before the rounds can only be carried home", () => {
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

  // Splitting is to be a game of its own (see felling.ts); its rules are kept, and tested, for it.
  it("splitting: a split lands by the marker; a perfect is two wood, a good one, and a miss leaves the log on the block", () => {
    const m: Motion = { kind: "swing", period: 1250, phase: 0, zone: 0.5, width: 0.24 };
    expect(splitGrade(m, momentFor(m, "perfect"))).toBe("perfect");
    // The marker never stops: no "too slow" on the block.
    expect(splitGrade(m, momentFor(m, "perfect", 60_000))).toBe("perfect");
    expect(SPLIT_WOOD).toEqual({ perfect: 2, good: 1, miss: 0 });
    const miss = momentFor(m, "miss");
    const hit = momentFor(m, "perfect", miss + SWING_MS);
    const { splits, misses } = replayStrikes([miss, hit], 3, () => m, FELL_ROUND_MS, GATHER_MAX_UNITS);
    expect(misses).toBe(1);
    expect(splits).toEqual([{ log: 0, at: hit, grade: "perfect", wood: 2, check: null }]);
    // The next log's marker starts after it is up on the block.
    const next = hit + NEXT_LOG_MS + momentFor(m, "good");
    expect(replayStrikes([hit, next], 3, () => m, FELL_ROUND_MS, GATHER_MAX_UNITS).splits.map((x) => [x.grade, x.wood])).toEqual([["perfect", 2], ["good", 1]]);
    // No more splits than logs, and none quicker than a swing.
    expect(replayStrikes(strikesFor([m, m, m, m, m], ["perfect"]), 2, () => m, FELL_ROUND_MS, GATHER_MAX_UNITS).splits).toHaveLength(2);
    expect(replayStrikes([hit, hit + 10], 3, () => m, FELL_ROUND_MS, GATHER_MAX_UNITS).splits).toHaveLength(1);
  });

  it("splitting: the pile holds one outing's carry; splits after it fills pay no wood but go on", () => {
    expect(splitWood("perfect", 0, 8)).toBe(2);
    expect(splitWood("perfect", 7, 8)).toBe(1);
    expect(splitWood("good", 8, 8)).toBe(0);
    const m: Motion = { kind: "swing", period: 1250, phase: 0, zone: 0.5, width: 0.24 };
    const strikes = strikesFor(Array(7).fill(m), ["perfect"]);
    const { splits } = replayStrikes(strikes, 7, () => m, FELL_ROUND_MS * 2, GATHER_MAX_UNITS);
    expect(splits).toHaveLength(7);
    expect(splits.map((x) => x.wood)).toEqual([2, 2, 2, 2, 0, 0, 0]);
  });

  it("splitting: each log's marker comes from the seed, and a stronger hero gets a wider, slower one", () => {
    expect(splitMotion(4, 2, 50)).toEqual(splitMotion(4, 2, 50));
    expect(splitMotion(4, 2, 50)).not.toEqual(splitMotion(4, 3, 50));
    expect(splitMotion(4, 2, 90).width).toBeGreaterThan(splitMotion(4, 2, 30).width);
    expect(splitMotion(4, 2, 90).period).toBeGreaterThan(splitMotion(4, 2, 30).period);
  });

  it("shows the client no seed and no RNG", () => {
    const one = fellOut(2_946_311_877, 30);
    const view = gatherView(one);
    expect(view).not.toHaveProperty("seed");
    expect(view).not.toHaveProperty("rng");
    expect(JSON.stringify(view)).not.toContain(String(one.seed));
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
  it("makes fishing aim first", () => {
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
    const aimed = stepGather(startGather("fishing", 8, 9), { t: "aim", cell: 1, now: 0 }).state;
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
    for (const spot of ["fishing"] as const) {
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
