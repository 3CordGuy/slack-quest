import { describe, expect, it } from "vitest";
import {
  GATHER_MAX_UNITS,
  GATHER_SPOTS,
  MINE_COLS,
  MINE_CRUSH_DAMAGE,
  MINE_FALL_DAMAGE,
  MINE_MS,
  MINE_RECOVER_MS,
  MINE_ROWS,
  blowGap,
  gatherPayout,
  gatherView,
  landBlows,
  mineGrid,
  mineNeighbours,
  powerFor,
  startGather,
  stepGather,
  type Blow,
  type BlowPower,
  type GatherState,
  type MineState,
  type Resources,
  type Rock,
} from "./index";

const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);
const rowOf = (cell: number) => Math.floor(cell / MINE_COLS);
const colOf = (cell: number) => cell % MINE_COLS;

/** A quarry outing with the clock started at 0 on the server's clock. */
function dug(seed: number, stat = 9): GatherState {
  const step = stepGather(startGather("quarry", seed, stat), { t: "dig", now: 0 });
  expect(step.error).toBeUndefined();
  return step.state;
}

/** Report blows as the server would, `now` ms after the start. */
function hit(state: GatherState, blows: Blow[], now = MINE_MS) {
  return stepGather(state, { t: "blows", blows, now });
}

/** A started face laid out by hand: one rock per place, rubble with 9 hp unless `set` says otherwise. */
function face(set: Record<number, Partial<Rock>> = {}): MineState {
  const rocks: Rock[] = Array.from({ length: MINE_COLS * MINE_ROWS }, (_, cell) => ({ kind: "rubble", cell, hp: 9, dmg: 0, broken: false, glint: 0, ...set[cell] }));
  return { rocks, chargeMs: 900, startedAt: 0, lastAt: null };
}
const at = (row: number, col: number) => row * MINE_COLS + col;

/**
 * Play a whole thirty seconds with a strategy that picks the next rock (by id) from what the client can see, and
 * swings at it as hard as it needs, as fast as the rules allow. Reports every blow as it lands.
 */
function playFace(seed: number, pick: (state: GatherState, rng: () => number) => number | null, charge: boolean): GatherState {
  let state = dug(seed);
  let last: number | null = null;
  let r = seed * 7919;
  const rng = () => ((r = (r * 48271) % 2147483647) / 2147483647);
  for (;;) {
    const id = pick(state, rng);
    if (id === null) break;
    const rock = state.mine!.rocks[id];
    const left = rock.hp - rock.dmg;
    const power: BlowPower = !charge ? 1 : left >= 3 ? 3 : left === 2 ? 2 : 1;
    const when: number = last === null ? 0 : last + blowGap(power, state.mine!.chargeMs);
    if (when > MINE_MS) break;
    const step = hit(state, [{ cell: rock.cell, power, at: when }], when);
    expect(step.error).toBeUndefined();
    state = step.state;
    last = when;
  }
  return stepGather(state, { t: "bank" }).state;
}

type SeenRock = ReturnType<typeof gatherView>["mine"] extends infer M ? (M extends { rocks: (infer R)[] } ? R : never) : never;
const value = (r: SeenRock) => (r.kind === "geode" ? 100 : r.kind === "seam" ? 50 : 0) + r.glint * 10 - (r.hp - r.dmg);

/** Reads the face: follows any seam it has opened, else the brightest glint, the softest first. Takes no care over what is above. */
const reader = (state: GatherState) => {
  const open = gatherView(state).mine!.rocks.filter((r) => !r.broken);
  return open.length === 0 ? null : open.sort((a, b) => value(b) - value(a))[0].id;
};
/** Reads the face the same way, but never digs under anything that glints or shows ore: works from the top down. */
const careful = (state: GatherState) => {
  const rocks = gatherView(state).mine!.rocks.filter((r) => !r.broken);
  if (rocks.length === 0) return null;
  const precious = (r: SeenRock) => r.kind === "seam" || r.kind === "geode" || (r.kind === null && r.glint >= 2);
  // Breaking a rock drops what is above it, and the lowest of that lands on the rock below it.
  const at = (cell: number) => rocks.find((o) => o.cell === cell);
  const undermines = (r: SeenRock) =>
    rocks.some((o) => o !== r && precious(o) && colOf(o.cell) === colOf(r.cell) && rowOf(o.cell) < rowOf(r.cell)) ||
    (!!at(r.cell - MINE_COLS) && !!at(r.cell + MINE_COLS) && precious(at(r.cell + MINE_COLS)!));
  return rocks.sort((a, b) => value(b) - 200 * +undermines(b) - (value(a) - 200 * +undermines(a)))[0].id;
};
/** Swings at whatever, taps only. */
const blind = (state: GatherState, rng: () => number) => {
  const open = state.mine!.rocks.flatMap((r, id) => (r.broken ? [] : [id]));
  return open.length === 0 ? null : open[Math.floor(rng() * open.length)];
};

describe("the quarry's rock face", () => {
  it("lays out a face with one seam, joined edge to edge, and at most one geode against it", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const mine = startGather("quarry", seed, 9).mine!;
      expect(mine.rocks).toHaveLength(MINE_COLS * MINE_ROWS);
      expect(mine.rocks.map((r) => r.cell)).toEqual(mine.rocks.map((_, i) => i));
      const seam = mine.rocks.flatMap((r, i) => (r.kind === "seam" ? [i] : []));
      expect(seam.length).toBeGreaterThanOrEqual(MINE_COLS - 4);
      // Never at the very top or bottom.
      for (const c of seam) expect(rowOf(c) > 0 && rowOf(c) < MINE_ROWS - 1).toBe(true);
      // Joined: every seam rock reaches every other through seam rocks.
      const seen = new Set([seam[0]]);
      const todo = [seam[0]];
      while (todo.length) for (const n of mineNeighbours(todo.pop()!)) if (seam.includes(n) && !seen.has(n)) (seen.add(n), todo.push(n));
      expect(seen.size).toBe(seam.length);
      const geodes = mine.rocks.flatMap((r, i) => (r.kind === "geode" ? [i] : []));
      expect(geodes.length).toBeLessThanOrEqual(1);
      for (const g of geodes) expect(mineNeighbours(g).some((n) => seam.includes(n))).toBe(true);
      // The seam always glints, if not always brightly; how hard a rock is never says what it is for sure.
      for (const r of mine.rocks) {
        if (r.kind === "seam") expect(r.glint).toBeGreaterThanOrEqual(1);
        expect(r.hp).toBeGreaterThanOrEqual(1);
        expect(r.hp).toBeLessThanOrEqual(4);
      }
      expect(mine.startedAt).toBeNull();
    }
  });

  it("charges quicker for a hero with more Vitality", () => {
    expect(startGather("quarry", 1, 20).mine!.chargeMs).toBeLessThan(startGather("quarry", 1, 2).mine!.chargeMs);
  });

  it("takes no swings before the clock starts, and starts it once", () => {
    const fresh = startGather("quarry", 3, 9);
    expect(hit(fresh, [{ cell: 0, power: 1, at: 0 }]).error).toBeDefined();
    const started = dug(3);
    expect(started.mine!.startedAt).toBe(0);
    expect(stepGather(started, { t: "dig", now: 5 }).error).toBeDefined();
    // The other spots' choices mean nothing here.
    expect(stepGather(started, { t: "push" }).error).toBeDefined();
    expect(stepGather(started, { t: "aim", cell: 0 }).error).toBeDefined();
  });

  it("refuses blows too quick, from the future, after the clock, or at nothing", () => {
    const s = dug(4);
    const charge = s.mine!.chargeMs;
    expect(hit(s, [{ cell: 0, power: 1, at: 0 }, { cell: 1, power: 1, at: MINE_RECOVER_MS - 100 }]).error).toMatch(/quick/);
    expect(hit(s, [{ cell: 0, power: 1, at: 0 }, { cell: 1, power: 3, at: MINE_RECOVER_MS + charge / 2 }]).error).toMatch(/quick/);
    expect(hit(s, [{ cell: 0, power: 1, at: 0 }, { cell: 1, power: 3, at: MINE_RECOVER_MS + charge }]).error).toBeUndefined();
    expect(hit(s, [{ cell: 0, power: 1, at: 5000 }], 1000).error).toMatch(/not happened/);
    expect(hit(s, [{ cell: 0, power: 1, at: MINE_MS + 1 }], MINE_MS + 2000).error).toMatch(/up/);
    for (const bad of [{ cell: -1, power: 1, at: 0 }, { cell: MINE_COLS * MINE_ROWS, power: 1, at: 0 }, { cell: 0, power: 4, at: 0 }, { cell: 0, power: 1, at: -5 }, { cell: 0.5, power: 1, at: 0 }]) {
      expect(hit(s, [bad as Blow]).error).toBeDefined();
    }
    expect(hit(s, []).error).toBeDefined();
    expect(stepGather(s, { t: "blows", blows: "x" } as never).error).toBeDefined();
    // The spacing holds across reports too.
    const one = hit(s, [{ cell: 0, power: 1, at: 1000 }]).state;
    expect(hit(one, [{ cell: 1, power: 1, at: 1100 }]).error).toMatch(/quick/);
    expect(hit(one, [{ cell: 1, power: 1, at: 1000 + MINE_RECOVER_MS }]).error).toBeUndefined();
  });

  it("a tap is one, half a charge two, a full charge three and a knock on each rock beside it", () => {
    expect(powerFor(0, 900)).toBe(1);
    expect(powerFor(449, 900)).toBe(1);
    expect(powerFor(450, 900)).toBe(2);
    expect(powerFor(900, 900)).toBe(3);
    const mid = at(3, 3);
    const full = landBlows(face(), [{ cell: mid, power: 3, at: 0 }], MINE_MS);
    if (typeof full === "string") throw new Error(full);
    expect(full.mine.rocks[mid].dmg).toBe(3);
    for (const n of mineNeighbours(mid)) expect(full.mine.rocks[n].dmg).toBe(1);
    const tap = landBlows(face(), [{ cell: mid, power: 1, at: 0 }], MINE_MS);
    if (typeof tap === "string") throw new Error(tap);
    for (const n of mineNeighbours(mid)) expect(tap.mine.rocks[n].dmg).toBe(0);
  });

  it("brings the rocks above a gap down, a point of damage a row", () => {
    // Break the rock in the bottom row of column 2; the six above it each drop one row.
    const mine = face({ [at(MINE_ROWS - 1, 2)]: { hp: 1 } });
    const res = landBlows(mine, [{ cell: at(MINE_ROWS - 1, 2), power: 1, at: 0 }], MINE_MS);
    if (typeof res === "string") throw new Error(res);
    expect(res.broken).toEqual([at(MINE_ROWS - 1, 2)]);
    expect(res.falls).toHaveLength(MINE_ROWS - 1);
    for (let row = 0; row < MINE_ROWS - 1; row++) {
      const r = res.mine.rocks[at(row, 2)];
      expect(r.cell).toBe(at(row + 1, 2));
      expect(r.dmg).toBe(MINE_FALL_DAMAGE);
      expect(r.fell).toBe(1);
    }
    // The top of the column is open now; other columns did not move.
    expect(mineGrid(res.mine.rocks)[at(0, 2)]).toBe(-1);
    expect(res.mine.rocks[at(0, 3)].cell).toBe(at(0, 3));
    // A blow at the gap is wasted, not refused.
    const again = landBlows(res.mine, [{ cell: at(0, 2), power: 1, at: 1000 }], MINE_MS);
    if (typeof again === "string") throw new Error(again);
    expect(again.broken).toEqual([]);
  });

  it("loses what is in a rock the fall breaks, and lets the rocks above it fall further", () => {
    // Column 4, from the bottom: a 1-hp rock to break, a seam rock that a one-row fall will break, a geode above it.
    const bottom = at(MINE_ROWS - 1, 4);
    const seam = at(MINE_ROWS - 2, 4);
    const geode = at(MINE_ROWS - 3, 4);
    const mine = face({ [bottom]: { hp: 1 }, [seam]: { kind: "seam", hp: 2, dmg: 1 }, [geode]: { kind: "geode", hp: 4 } });
    const res = landBlows(mine, [{ cell: bottom, power: 1, at: 0 }], MINE_MS);
    if (typeof res === "string") throw new Error(res);
    expect(res.broken).toEqual([bottom, seam]);
    expect(res.mine.rocks[seam]).toMatchObject({ broken: true, lost: true });
    // With the seam rock gone, the geode came down two rows: two points of damage, and it survives.
    expect(res.mine.rocks[geode]).toMatchObject({ cell: bottom, dmg: 2 * MINE_FALL_DAMAGE, broken: false });
    expect(res.falls.find((f) => f.id === seam)).toMatchObject({ lost: true });

    // Through the server: the lost rock pays nothing and says so.
    const s = { ...dug(1), mine: { ...mine, startedAt: 0 } };
    const after = hit(s, [{ cell: bottom, power: 1, at: 0 }]).state;
    expect(after.mine!.rocks[seam].got).toBeUndefined();
    expect(after.log.at(-1)!.text).toMatch(/lost/);
    expect(gatherView(after).mine!.rocks[seam]).toMatchObject({ lost: true, broken: true, got: null });
  });

  it("crushes the rock a falling rock lands on, and loses what is in it if that breaks it", () => {
    // Column 5: break a rock in the middle. The two above it drop a row onto the rock below the gap.
    const mid = at(3, 5);
    const below = at(4, 5);
    const sturdy = landBlows(face({ [mid]: { hp: 1 } }), [{ cell: mid, power: 1, at: 0 }], MINE_MS);
    if (typeof sturdy === "string") throw new Error(sturdy);
    expect(sturdy.mine.rocks[below]).toMatchObject({ cell: below, dmg: MINE_CRUSH_DAMAGE, broken: false });
    // Only the lowest of the falling stack lands on it.
    expect(sturdy.crushes).toEqual([{ id: below, by: at(2, 5), lost: false }]);
    // Nothing falls on a rock when the gap is at the floor.
    const floor = landBlows(face({ [at(MINE_ROWS - 1, 5)]: { hp: 1 } }), [{ cell: at(MINE_ROWS - 1, 5), power: 1, at: 0 }], MINE_MS);
    if (typeof floor === "string") throw new Error(floor);
    expect(floor.crushes).toEqual([]);

    // A seam rock under the gap with one hit left is crushed, its ore lost, and the stack comes down further onto the next.
    const crushed = landBlows(face({ [mid]: { hp: 1 }, [below]: { kind: "seam", hp: 2, dmg: 1 } }), [{ cell: mid, power: 1, at: 0 }], MINE_MS);
    if (typeof crushed === "string") throw new Error(crushed);
    expect(crushed.mine.rocks[below]).toMatchObject({ broken: true, lost: true });
    expect(crushed.crushes[0]).toMatchObject({ id: below, lost: true });
    expect(crushed.mine.rocks[at(2, 5)]).toMatchObject({ cell: below, fell: 2 });
    expect(crushed.mine.rocks[at(5, 5)].dmg).toBe(MINE_CRUSH_DAMAGE);
    // Through the server: the crushed rock pays nothing and says so.
    const s = { ...dug(1), mine: { ...face({ [mid]: { hp: 1 }, [below]: { kind: "seam", hp: 2, dmg: 1 } }) } };
    const after = hit(s, [{ cell: mid, power: 1, at: 0 }]).state;
    expect(after.mine!.rocks[below].got).toBeUndefined();
    expect(after.log.at(-1)!.text).toMatch(/lost/);
  });

  it("shows the hardness and glints, and what a rock is only once it has been opened up", () => {
    const s = dug(6);
    const view = gatherView(s).mine!;
    expect(view.rocks.every((r) => r.kind === null)).toBe(true);
    expect(view.rocks.map((r) => r.glint)).toEqual(s.mine!.rocks.map((r) => r.glint));
    expect(JSON.stringify(gatherView(s))).not.toContain('"seam"');
    // Break a rubble rock in the top row with one tap: nothing falls into a gap at the top.
    const id = s.mine!.rocks.findIndex((r) => r.hp === 1 && rowOf(r.cell) === 0);
    expect(id).toBeGreaterThanOrEqual(0);
    const one = hit(s, [{ cell: id, power: 1, at: 0 }]).state;
    const after = gatherView(one).mine!;
    expect(after.rocks[id]).toMatchObject({ broken: true, kind: s.mine!.rocks[id].kind });
    const known = after.rocks.flatMap((r) => (r.kind !== null ? [r.cell] : [])).sort((a, b) => a - b);
    expect(known).toEqual([id, ...mineNeighbours(id)].sort((a, b) => a - b));
    // Once it is over the whole face is shown.
    expect(gatherView(stepGather(one, { t: "bank" }).state).mine!.rocks.every((r) => r.kind !== null)).toBe(true);
  });

  it("tells the client how much of the clock is left", () => {
    const s = dug(7);
    expect(gatherView(startGather("quarry", 7, 9), 123).mine!.leftMs).toBeNull();
    expect(gatherView(s, 10_000).mine!.leftMs).toBe(MINE_MS - 10_000);
    expect(gatherView(s, MINE_MS * 2).mine!.leftMs).toBe(0);
  });

  it("pays from what breaks: stone from junk, ore from the seam, gems from a geode, nothing from a fall", () => {
    const seen = new Set<string>();
    let lost = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const state = playFace(seed, blind, false);
      for (const rock of state.mine!.rocks) {
        if (!rock.broken) continue;
        const got = Object.keys(rock.got ?? {});
        if (rock.lost) {
          lost++;
          expect(got).toEqual([]);
          continue;
        }
        if (rock.kind === "rubble" || rock.kind === "granite") expect(got.every((k) => k === "stone")).toBe(true);
        if (rock.kind === "seam") expect(got).toHaveLength(1);
        if (rock.kind === "geode") expect(got).toEqual(["gem"]);
        got.forEach((k) => seen.add(k));
      }
      const haul: Resources = {};
      for (const r of state.mine!.rocks) for (const [k, n] of Object.entries(r.got ?? {})) haul[k as keyof Resources] = (haul[k as keyof Resources] ?? 0) + n!;
      expect(state.haul).toEqual(haul);
    }
    expect([...seen].sort()).toEqual(["copper", "gem", "iron", "stone"]);
    expect(lost).toBeGreaterThan(0);
  });

  it("keeps the rarest finds when the haul is over the cap, and pays only quarry materials", () => {
    const s = { ...startGather("quarry", 1, 9), status: "banked" as const, haul: { stone: 9, iron: 4, copper: 3, gem: 2, wood: 5 } };
    expect(gatherPayout(s)).toEqual({ gem: 2, copper: 3, iron: GATHER_MAX_UNITS - 5 });
    expect(GATHER_SPOTS.quarry.pays).toEqual(["stone", "iron", "copper", "gem"]);
    // An empty early haul still pays a piece of stone.
    expect(gatherPayout(stepGather(startGather("quarry", 2, 9), { t: "bank" }).state)).toEqual({ stone: 1 });
  });

  it("is never lost outright: the outing only ends by hauling out", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const end = playFace(seed, blind, false);
      expect(end.status).toBe("banked");
      expect(units(gatherPayout(end))).toBeGreaterThanOrEqual(1);
      expect(units(gatherPayout(end))).toBeLessThanOrEqual(GATHER_MAX_UNITS);
    }
  });

  it("rewards reading the glints over swinging blind, and minding what is above over not", () => {
    const rare = (s: GatherState) => (s.haul.iron ?? 0) + (s.haul.copper ?? 0) + 3 * (s.haul.gem ?? 0);
    const lostSeam = (s: GatherState) => s.mine!.rocks.filter((r) => r.lost && (r.kind === "seam" || r.kind === "geode")).length;
    const N = 300;
    const tally = { careful: 0, reader: 0, blind: 0, carefulLost: 0, readerLost: 0, carefulUnits: 0 };
    for (let seed = 1; seed <= N; seed++) {
      const c = playFace(seed, careful, true);
      const r = playFace(seed, reader, true);
      const b = playFace(seed, blind, false);
      tally.careful += rare(c);
      tally.reader += rare(r);
      tally.blind += rare(b);
      tally.carefulLost += lostSeam(c);
      tally.readerLost += lostSeam(r);
      tally.carefulUnits += units(gatherPayout(c));
    }
    expect(tally.reader).toBeGreaterThan(tally.blind * 1.5);
    expect(tally.careful).toBeGreaterThan(tally.reader);
    expect(tally.carefulLost).toBeLessThan(tally.readerLost);
    expect(tally.carefulUnits / N).toBeGreaterThan(5);
  });

  it("an outing from the old 3×3 face can only be hauled out", () => {
    const old = { ...startGather("quarry", 1, 9), mine: undefined, face: ["stone"], cracks: 1, haul: { stone: 2 } } as GatherState;
    expect(stepGather(old, { t: "dig", now: 0 }).error).toBeDefined();
    expect(gatherView(old).mine).toBeNull();
    expect(gatherPayout(stepGather(old, { t: "bank" }).state)).toEqual({ stone: 2 });
  });
});
