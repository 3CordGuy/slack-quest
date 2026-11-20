// The lie of the land and who stands on it: turns taken one fighter at a time, hexes shared by friends and held against
// the other side, cliffs and ladders,
// what height does for a shot and a blow, what becomes of anyone knocked over an edge, a fight being heard, and
// the enemy using all of it (zone.ts, geometry.ts, combat.ts, ai.ts).
//
// Nothing here uses the tests' switch for shared turns: a turn is one fighter's alone, as it is in play.

import { describe, expect, it } from "vitest";
import { STARTING_STATS, allHexesInGrid, hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Biome, Tile } from "../map";
import { makeRng } from "../rng";
import { abilityArea, checkAbility, checkCommon, edgeDc, leavesReach, moveLeft, push, shiftInto, shoveDest } from "./combat";
import { strikeReaches } from "./ai";
import { attackContext, type Ctx } from "./engine";
import { ALERT_RANGE, DEFAULT_ZONE_OPTIONS } from "./gen";
import { HEX_DIRS, HEX_ROOM, HIGH_REACH, MAX_ELEV, elevOf, heldAgainst, isDead, ladderBetween, pitAt, reachFrom, roomAt, sees, stepCost, strikes, unitAt, unitsAt, zoneReach } from "./geometry";
import { ACTION_AP, AP_MAX, AP_TURN, SUMMON_AP_TURN, COMMON_ACTIONS, ENEMY_KIT, ENEMY_MOVE_AP, JUMP_DOWN, JUMP_UP, enemyMove, enemyStrikes, tacticOf } from "./kit";
import { mod, proficiency, rollShown } from "./rules";
import { SITE_IDS, siteInside, siteOpen } from "./sites";
import { HEAR_RANGE, standInHero, stepZone } from "./zone";
import type { Rolled, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

// ---------- helpers ----------

const GRID: HexGrid = { cols: 16, rows: 12 };
/** Offset coordinates (column, row) to a hex, so tests can talk about a flat board. */
const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });
/** The hexes of row `row` from column `from` to column `to`. */
const run = (from: number, to: number, row = 6): HexPos[] => Array.from({ length: to - from + 1 }, (_, i) => at(from + i, row));
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;

type Edit = (tile: Tile) => void;
/** Change these hexes of a board. */
const on = (hexes: HexPos[], change: Partial<Tile>): Edit => (t) => { if (hexes.some((p) => same(p, t))) Object.assign(t, change); };
/** Stand a ladder on `low`, against the cliff of `high` beside it. */
const ladder = (low: HexPos, high: HexPos): Edit => (t) => { if (same(t, low)) t.ladder = (t.ladder ?? 0) | (1 << HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r)); };
const both = (...edits: Edit[]): Edit => (t) => edits.forEach((e) => e(t));

/** A flat, open board with nothing on it, the enemy's AI off. `gone`: hexes with no ground at all. */
function board(edit: Edit = () => {}, gone: HexPos[] = []): ZoneState {
  const tiles: Tile[] = allHexesInGrid(GRID).filter((p) => !gone.some((g) => same(g, p))).map((p) => ({ q: p.q, r: p.r, biome: "plains" as Biome, h: 0.3, elev: 0 }));
  tiles.forEach(edit);
  return { v: 1, code: "TEST", seed: "test", rng: 12345, options: { ...DEFAULT_ZONE_OPTIONS, party: 1 }, map: { grid: GRID, tiles, pois: [] }, start: at(1, 1), units: [], groups: {}, surfaces: {}, encounter: null, seq: 100, aiOff: true };
}

function hero(state: ZoneState, id: string, classId: string, pos: HexPos, abilities: string[] = ["bash"]): Unit {
  const sheet = standInHero(classId, id, 1)!;
  const unit: Unit = {
    id, side: "hero", name: id, kind: classId, level: 1, pos, hp: sheet.maxHp, maxHp: sheet.maxHp, focus: 2, maxFocus: 2,
    stats: STARTING_STATS[classId], armor: 2, power: 1, abilities, conditions: [], down: false, cooldowns: {}, items: { healing: 2, fire: 2 },
  };
  state.units.push(unit);
  return unit;
}

function enemy(state: ZoneState, kind: string, pos: HexPos, group = "g1", hp = ENEMIES[kind].hp): Unit {
  state.groups[group] ??= { alerted: false };
  const unit: Unit = { id: `e${++state.seq}`, side: "enemy", name: ENEMIES[kind].name, kind, level: 1, pos, hp, maxHp: hp, focus: 0, maxFocus: 0, armor: 0, power: 0, abilities: [], conditions: [], down: false, cooldowns: {}, items: {}, group, home: pos };
  state.units.push(unit);
  return unit;
}

/** Apply an action that must succeed; what happened is added to `sink`, and what was earned to `paid`. */
function must(state: ZoneState, action: ZoneAction, sink: ZoneEvent[] = [], paid: ZoneEffect[] = []): ZoneState {
  const step = stepZone(state, action);
  if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
  sink.push(...step.events);
  paid.push(...step.effects);
  return step.state;
}
const fails = (state: ZoneState, action: ZoneAction): string => {
  const step = stepZone(state, action);
  if (step.ok) throw new Error(`${action.type} should have failed`);
  return step.error;
};
const unit = (state: ZoneState, id: string) => state.units.find((u) => u.id === id)!;
const has = (state: ZoneState, id: string, kind: string) => unit(state, id).conditions.some((c) => c.kind === kind);
const endTurn = (id: string, by = id): ZoneAction => ({ type: "end_turn", by, unit: id });
const shove = (target: string, by = "ann"): ZoneAction => ({ type: "common", by, unit: by, what: "shove", target });

/** Pass turns (the enemy's are over at once while its AI is off) until it is `id`'s, and theirs alone. */
function turnOf(state: ZoneState, id: string, sink: ZoneEvent[] = []): ZoneState {
  for (let i = 0; i < 40 && state.encounter && state.encounter.acting[0] !== id; i++) state = must(state, { type: "timeout" }, sink);
  expect(state.encounter?.acting).toEqual([id]);
  return state;
}
/** Set the nearest band on Ann where she stands, and come round to `id`'s turn. */
function fight(state: ZoneState, id = "ann", sink: ZoneEvent[] = []): ZoneState {
  return turnOf(must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, sink), id, sink);
}

interface Outcome {
  state: ZoneState;
  events: ZoneEvent[];
  effects: ZoneEffect[];
}
/** Try the same action from the same state over many seeds of the dice, until `want` says they fell the way looked for. */
function seek(state: ZoneState, action: ZoneAction, want: (o: Outcome) => boolean, tries = 400): Outcome {
  for (let seed = 1; seed <= tries; seed++) {
    const step = stepZone({ ...state, rng: seed }, action);
    if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
    if (want(step)) return step;
  }
  throw new Error("the dice never fell that way");
}

const rolls = (events: ZoneEvent[], label: string) => events.flatMap((e) => (e.t === "roll" && e.roll.label === label ? [e.roll] : []));
const got = <T extends ZoneEvent["t"]>(events: ZoneEvent[], t: T) => events.filter((e): e is Extract<ZoneEvent, { t: T }> => e.t === t);
/** Whether a shove (or what stands in for one) was won, and whether whoever was sent toward an edge caught it. */
const won = (events: ZoneEvent[], label = "Shove") => rolls(events, label).some((r) => r.ok);
const caught = (events: ZoneEvent[]) => rolls(events, "Catch the edge").some((r) => r.ok);
const wentOver = (o: Outcome) => rolls(o.events, "Catch the edge").some((r) => !r.ok);

/** What was rolled for a blow, a fall or a heal adds up, and is what was told. */
function checkDice(dice: Rolled, where: string): void {
  expect(dice.faces.length, where).toBeGreaterThan(0);
  for (const f of dice.faces) {
    expect(Number.isInteger(f), where).toBe(true);
    expect(f, where).toBeGreaterThanOrEqual(1);
    expect(f, where).toBeLessThanOrEqual(dice.d);
  }
  expect(dice.total, where).toBe(Math.max(0, dice.faces.reduce((n, f) => n + f, 0) + dice.plus));
}

// ---------- turns ----------

describe("a turn is one fighter's alone", () => {
  it("gives each hero a turn of their own, in the order, however they fall in it", () => {
    let neighbours = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let state = board();
      for (const [i, id] of ["ann", "bo", "cy"].entries()) hero(state, id, "qa_paladin", at(3, 5 + i));
      const foes = [enemy(state, "bandit", at(8, 5)), enemy(state, "bandit", at(8, 7))];
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      const order = [...state.encounter!.order];
      expect(new Set(order), `seed ${seed}`).toEqual(new Set(["ann", "bo", "cy", ...foes.map((f) => f.id)]));
      const heroes = order.filter((id) => unit(state, id).side === "hero");
      if (order.some((id, i) => heroes.includes(id) && heroes.includes(order[i + 1]))) neighbours++;
      const turns: string[] = [];
      for (let n = 0; n < 9; n++) {
        const enc = state.encounter!;
        expect(enc.acting, `seed ${seed}`).toHaveLength(1);
        const id = enc.acting[0];
        turns.push(id);
        // The budget is theirs alone: nobody else has anything to spend, or a turn to end. (Having spent nothing in
        // the first round, each comes to the next with what they saved on top of the turn's own, as much as can be held.)
        expect(enc.budgets, `seed ${seed}`).toEqual({ [id]: { ap: n < heroes.length ? AP_TURN : AP_MAX, move: 0, stride: enc.budgets[id].stride, disengaged: false } });
        for (const other of heroes.filter((h) => h !== id)) {
          expect(fails(state, endTurn(other))).toMatch(/not your turn/);
          expect(fails(state, { type: "move", by: other, unit: other, to: at(1, 1) })).toMatch(/not your turn/);
        }
        state = must(state, endTurn(id), events);
      }
      // Three rounds: the heroes one after another as the order has them, each once a round.
      expect(turns, `seed ${seed}`).toEqual([...heroes, ...heroes, ...heroes]);
      for (const e of got(events, "turn")) expect(e.ids).toHaveLength(1);
      expect(got(events, "round").map((e) => e.n)).toEqual([2, 3, 4]);
    }
    // Some of those fights had two heroes side by side in the order: they did not share a turn.
    expect(neighbours).toBeGreaterThan(0);
  });

  it("rolls off every tie in initiative, so nobody shares a place in the order, whenever they came into the fight", () => {
    let tied = 0;
    let untied = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let state = board();
      for (const [i, id] of ["ann", "bo", "cy"].entries()) hero(state, id, i === 1 ? "refactor_rogue" : "qa_paladin", at(3, 5 + i));
      hero(state, "di", "devops_mage", at(15, 11));
      for (let row = 4; row <= 7; row++) enemy(state, row % 2 ? "wolf" : "bandit", at(8, row));
      state.rng = seed * 31;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      const strict = (where: string) => {
        const enc = state.encounter!;
        const { order, init } = enc;
        const tie = enc.tie ?? {};
        // Highest initiative first; between two who rolled the same, whoever rolled higher in the roll-off.
        for (let i = 0; i + 1 < order.length; i++) {
          const [a, b] = [order[i], order[i + 1]];
          expect(init[a] > init[b] || (init[a] === init[b] && tie[a] > tie[b]), `${where}: ${a} before ${b}`).toBe(true);
        }
        const shared = order.filter((id) => order.some((o) => o !== id && init[o] === init[id]));
        const breaks = rolls(events, "Tie-break");
        // Everyone who shares a number has rolled off, and nobody else has.
        expect([...new Set(breaks.map((r) => r.id))].sort(), where).toEqual([...shared].sort());
        for (const r of breaks) expect(r, where).toMatchObject({ kind: "initiative", bonus: 0, adv: 0, total: r.kept });
        // What each rolled last is what is kept for them.
        for (const id of shared) expect(tie[id], `${where}: ${id}`).toBe(breaks.filter((r) => r.id === id).pop()!.total);
        if (shared.length === 0) expect(enc.tie, where).toBeUndefined();
        return shared.length;
      };
      expect(state.encounter!.order).toHaveLength(7);
      strict(`seed ${seed}`);
      // Di walks up from far off, and is drawn in: one more roll, and the same holds.
      const before = events.length;
      while (!state.encounter!.order.includes("di")) {
        const reach = zoneReach(state, unit(state, "di"), 6);
        const nearer = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, at(8, 6)) - hexDistance(b.pos, at(8, 6)))[0];
        state = must(state, { type: "move", by: "di", unit: "di", to: nearer.pos }, events);
      }
      expect(events.slice(before)).toContainEqual({ t: "fight_join", id: "di" });
      expect(rolls(events, "Initiative").map((r) => r.id).sort()).toEqual([...state.encounter!.order].sort());
      if (strict(`seed ${seed}, with di`) > 0) tied++;
      else untied++;
    }
    // Both happened: fights with ties to roll off, and fights with none.
    expect(tied).toBeGreaterThan(0);
    expect(untied).toBeGreaterThan(0);
  });

  describe("what a hero calls into the fight", () => {
    /** Ann, who can call a sea turtle, and Bo, in a fight with a dummy, on Ann's turn. */
    function calling(more: (state: ZoneState) => void = () => {}, seed = 12345) {
      let state = board();
      hero(state, "ann", "backend_druid", at(3, 6), ["summon_sea_turtle"]);
      hero(state, "bo", "qa_paladin", at(3, 8));
      enemy(state, "dummy", at(9, 6));
      more(state);
      state.rng = seed;
      state = fight(state);
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "summon_sea_turtle", at: at(4, 6) }, events);
      const turtle = state.units.find((u) => u.summon)!;
      expect(events).toContainEqual({ t: "summoned", id: turtle.id, by: "ann" });
      return { state, turtle: turtle.id };
    }

    it("stands right behind them in the order, and takes a turn of its own as soon as theirs is over", () => {
      let { state, turtle } = calling();
      expect(unit(state, turtle)).toMatchObject({ side: "hero", controller: "ann", summon: { by: "ann" }, pos: at(4, 6) });
      const enc = state.encounter!;
      expect(enc.order.indexOf(turtle)).toBe(enc.order.indexOf("ann") + 1);
      expect(enc.init[turtle]).toBe(enc.init.ann);
      // It is still Ann's turn, and hers alone: the turtle has none until she is done.
      expect(enc.acting).toEqual(["ann"]);
      expect(enc.budgets[turtle]).toBeUndefined();
      expect(fails(state, { type: "move", by: "ann", unit: turtle, to: at(5, 6) })).toMatch(/not your turn/);
      const next: ZoneEvent[] = [];
      state = must(state, endTurn("ann"), next);
      expect(state.encounter!.acting).toEqual([turtle]);
      expect(next).toContainEqual({ t: "turn", ids: [turtle] });
      expect(state.encounter!.budgets[turtle]).toMatchObject({ ap: SUMMON_AP_TURN });
      // Ann's player plays it, and nobody else; Ann herself has to wait.
      expect(fails(state, { type: "move", by: "bo", unit: turtle, to: at(5, 6) })).toMatch(/not yours/);
      expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(2, 6) })).toMatch(/not your turn/);
      state = must(state, { type: "move", by: "ann", unit: turtle, to: at(5, 6) });
      expect(unit(state, turtle).pos).toEqual(at(5, 6));
      state = must(state, endTurn(turtle, "ann"));
      expect(state.encounter!.acting).not.toContain(turtle);
      // And so it goes every round: Ann, then the turtle.
      state = must(turnOf(state, "ann"), endTurn("ann"));
      expect(state.encounter!.acting).toEqual([turtle]);
    });

    it("keeps its place behind them, with no roll of its own, when someone new rolls the very number its caller did", () => {
      // A second band, to be set on Ann next. (A fight in which Ann rolled a number a bandit can roll too.)
      const second = (s: ZoneState) => void enemy(s, "bandit", at(13, 6), "g2");
      const seed = Array.from({ length: 40 }, (_, i) => i + 1).find((n) => {
        const init = calling(second, n).state.encounter!.init.ann;
        return init >= 5 && init <= 18;
      })!;
      const { state, turtle } = calling(second, seed);
      const late = state.units.find((u) => u.group === "g2")!.id;
      const { state: after, events } = seek(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, (o) => o.state.encounter!.init[late] === o.state.encounter!.init.ann);
      const enc = after.encounter!;
      // Ann and the newcomer roll off; the turtle goes where Ann goes.
      expect([...new Set(rolls(events, "Tie-break").map((r) => r.id))].sort()).toEqual(["ann", late].sort());
      expect(events.some((e) => e.t === "roll" && e.roll.id === turtle)).toBe(false);
      expect(enc.order.indexOf(turtle)).toBe(enc.order.indexOf("ann") + 1);
      expect(enc.tie![turtle]).toBeLessThan(enc.tie!.ann);
      expect(enc.tie![turtle]).toBeGreaterThan(enc.tie!.ann - 1);
      expect(enc.order.indexOf(late) < enc.order.indexOf("ann")).toBe(enc.tie![late] > enc.tie!.ann);
    });
  });
});

// ---------- sharing a hex ----------

describe("a hex is one side's or the other's", () => {
  const none = { cost: Infinity, stop: false };
  /** A wall of `biome` right across the board along column 7 (and as many columns east of it as `wide`), with one way through it: along row 6. */
  const gap = (biome: Biome, wide = 1): Edit =>
    on(Array.from({ length: wide }, (_, i) => 7 + i).flatMap((c) => Array.from({ length: GRID.rows }, (_, row) => at(c, row))).filter((p) => p.r !== 6), { biome });
  const col = (p: HexPos) => p.q + Math.floor(p.r / 2);
  /** Nowhere on the board do the two sides stand together, and nowhere do more than HEX_ROOM stand (the dead aside). */
  const apart = (state: ZoneState, where = "") => {
    for (const u of state.units.filter((x) => !isDead(x))) {
      const there = unitsAt(state, u.pos).filter((o) => !isDead(o));
      expect(there.length, where).toBeLessThanOrEqual(HEX_ROOM);
      expect(new Set(there.map((o) => o.side)).size, where).toBe(1);
    }
  };

  it("has room for two of a side and no more; one the other side holds is not stepped onto, stopped on or leapt onto", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(5, 6));
    hero(state, "cy", "qa_paladin", at(3, 7));
    const foe = enemy(state, "bandit", at(7, 6));
    state = fight(state);
    const ann = unit(state, "ann");
    const bandit = unit(state, foe.id);
    // A friend's hex is a step like any other, with room to stop on it.
    expect(stepCost(state, ann, at(4, 6), at(5, 6))).toEqual({ cost: 1, stop: true });
    // The bandit's is closed to her, and Bo's to the bandit: not at a step more, not at all.
    expect(stepCost(state, ann, at(6, 6), at(7, 6))).toEqual(none);
    expect(stepCost(state, bandit, at(6, 6), at(5, 6))).toEqual(none);
    expect(heldAgainst(state, at(7, 6), "hero")).toBe(true);
    expect(heldAgainst(state, at(7, 6), "enemy")).toBe(false);
    expect(heldAgainst(state, at(5, 6), "enemy")).toBe(true);
    expect(heldAgainst(state, at(6, 6), "hero")).toBe(false);
    expect(roomAt(state, at(7, 6), ann)).toBe(false);
    expect(roomAt(state, at(5, 6), ann)).toBe(true);
    expect(roomAt(state, at(5, 6), bandit)).toBe(false);
    // With nobody named, a hex has room only if nobody at all is on it.
    expect(roomAt(state, at(5, 6))).toBe(false);
    expect(roomAt(state, at(6, 6))).toBe(true);
    // However far she could walk, the bandit's hex is nowhere she can get to: she goes round it.
    const far = zoneReach(state, ann, 40);
    expect(far.has(posKey(at(7, 6)))).toBe(false);
    expect(far.get(posKey(at(8, 6)))!.cost).toBeGreaterThan(5);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) })).toMatch(/cannot get there/);
    // And the bandit goes round Bo.
    const foeReach = zoneReach(state, bandit, 40);
    expect(foeReach.has(posKey(at(5, 6)))).toBe(false);
    expect(foeReach.get(posKey(at(4, 6)))!.cost).toBeGreaterThan(3);
    // Ann walks onto Bo's hex: two steps of ground and nothing more, and the two of them stand there together.
    const left = moveLeft(state.encounter!.budgets.ann);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, events);
    expect(got(events, "moved")).toEqual([{ t: "moved", id: "ann", path: run(4, 5) }]);
    expect(moveLeft(state.encounter!.budgets.ann)).toBe(left - 2);
    expect(unitsAt(state, at(5, 6)).map((u) => u.id).sort()).toEqual(["ann", "bo"]);
    // The bandit is two hexes off now: near enough to leap at, but there is no landing on its hex.
    expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(7, 6) })).toMatch(/nowhere to land/);
    // Their hex is full: Cy cannot stop on it or land on it, though it can still be walked through.
    expect(roomAt(state, at(5, 6), unit(state, "cy"))).toBe(false);
    expect(roomAt(state, at(5, 6), unit(state, "ann"))).toBe(true);
    state = turnOf(must(state, endTurn("ann")), "cy");
    const reach = zoneReach(state, unit(state, "cy"), moveLeft(state.encounter!.budgets.cy));
    expect(reach.get(posKey(at(5, 6)))).toMatchObject({ stop: false });
    expect(fails(state, { type: "move", by: "cy", unit: "cy", to: at(5, 6) })).toMatch(/standing there/);
    expect(fails(state, { type: "common", by: "cy", unit: "cy", what: "jump", at: at(5, 6) })).toMatch(/nowhere to land/);
    apart(state);
  });

  it("is walked through when it is full of one's own side, where there is no other way", () => {
    // A lane one hex wide, rock on either side of it, with two friends standing in the middle of it.
    let state = board(on([...run(3, 11, 5), ...run(3, 11, 7)], { biome: "rock" }));
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "qa_paladin", at(7, 6));
    hero(state, "cy", "qa_paladin", at(7, 6));
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) })).toMatch(/standing there/);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }, events);
    expect(got(events, "moved")).toEqual([{ t: "moved", id: "ann", path: run(6, 9) }]);
    expect(unit(state, "ann").pos).toEqual(at(9, 6));
  });

  it("is no way through when the other side holds it: one in a gap shuts it, on their feet or down, and a dead enemy shuts nothing", () => {
    for (const biome of ["rock", "water"] as const) {
      // Ann on one side of the wall (or the water), a bandit standing in the only way through it.
      const state = board(gap(biome));
      const ann = hero(state, "ann", "qa_paladin", at(4, 6));
      const foe = enemy(state, "bandit", at(7, 6));
      const beyond = (reach: Map<string, unknown>) => [...reach.keys()].some((key) => col({ q: Number(key.split(",")[0]), r: Number(key.split(",")[1]) }) > 7);
      expect(beyond(zoneReach(state, ann, 400)), biome).toBe(false);
      expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }), biome).toMatch(/cannot get there/);
      // Nor is it leapt onto; the ground beyond it, two hexes off, is another matter: a leap goes over whoever is between.
      ann.pos = at(6, 6);
      expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(7, 6) }), biome).toMatch(/nowhere to land/);
      expect(checkCommon(state, ann, "jump", { at: at(8, 6) }, null), biome).toBeNull();
      ann.pos = at(4, 6);
      // Dead, it is in nobody's way.
      Object.assign(foe, { hp: 0, down: true });
      expect(beyond(zoneReach(state, ann, 400)), biome).toBe(true);
      // The other way about: a hero in the gap shuts it to the enemy, and still does lying there down.
      const held = board(gap(biome));
      const bo = hero(held, "bo", "qa_paladin", at(7, 6));
      const wolf = enemy(held, "wolf", at(10, 6));
      const near = (reach: Map<string, unknown>) => [...reach.keys()].some((key) => col({ q: Number(key.split(",")[0]), r: Number(key.split(",")[1]) }) < 7);
      expect(near(zoneReach(held, wolf, 400)), biome).toBe(false);
      Object.assign(bo, { hp: 0, down: true });
      expect(near(zoneReach(held, wolf, 400)), biome).toBe(false);
      expect(stepCost(held, wolf, at(8, 6), at(7, 6)), biome).toEqual(none);
      // With nobody in it, it is a way like any other.
      held.units = held.units.filter((u) => u.id !== "bo");
      expect(near(zoneReach(held, wolf, 400)), biome).toBe(true);
    }
  });

  it("held against the enemy playing its own turns: none gets through, two at a time come up to strike, the rest wait behind, and the fight goes on", () => {
    // A doorway in a wall of rock; and a bridge three hexes long over water too wide to leap, held at its near end.
    for (const [biome, wide] of [["rock", 1], ["water", 3]] as const) {
      // Ann stands in the only way through, Bo well behind her; five bandits on the far side.
      let state = board(gap(biome, wide));
      state.aiOff = false;
      hero(state, "ann", "qa_paladin", at(7, 6));
      hero(state, "bo", "qa_paladin", at(3, 6));
      for (const id of ["ann", "bo"]) Object.assign(unit(state, id), { hp: 5000, maxHp: 5000 });
      const band = [at(12, 5), at(12, 6), at(12, 7), at(13, 5), at(13, 6)].map((p) => enemy(state, "bandit", p, "g1", 200).id);
      const events: ZoneEvent[] = [];
      state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      let paired = false;
      for (let i = 0; i < 400 && state.encounter && state.encounter.round <= 9; i++) {
        state = must(state, { type: "timeout" }, events);
        const where = `${biome}, round ${state.encounter?.round}`;
        apart(state, where);
        // Nobody of theirs is ever on Ann's side of the gap, or in it.
        for (const id of band) expect(col(unit(state, id).pos), where).toBeGreaterThan(7);
        expect(unit(state, "ann").pos, where).toEqual(at(7, 6));
        if (unitsAt(state, at(8, 6)).length === HEX_ROOM) paired = true;
      }
      expect(state.encounter?.round, biome).toBeGreaterThan(9);
      // The one hex before her fills with two of them, and once they have come up blows fall on her every round.
      expect(paired, biome).toBe(true);
      const blows: Record<number, number> = {};
      let n = 1;
      for (const e of events) {
        if (e.t === "round") n = e.n;
        else if (e.t === "used" && band.includes(e.id) && e.what === "attack") blows[n] = (blows[n] ?? 0) + 1;
      }
      for (let round = 4; round <= 9; round++) expect(blows[round] ?? 0, `${biome}, round ${round}`).toBeGreaterThanOrEqual(1);
      expect(unit(state, "ann").hp, biome).toBeLessThan(5000);
      expect(unit(state, "bo").hp, biome).toBe(5000);
      // The rest have come up as near as there is room to, and wait there.
      for (const id of band) expect(hexDistance(unit(state, id).pos, at(7, 6)), biome).toBeLessThanOrEqual(3);
      // No enemy walked further in a turn than its two strides.
      expect(got(events, "moved").filter((e) => band.includes(e.id)).every((e) => e.path.length <= ENEMY_MOVE_AP * enemyMove("bandit")), biome).toBe(true);
    }
  });

  it("held only by someone the enemy has no blow to strike at (a hero lying there down), the gap is leapt, where there is ground beyond to land on", () => {
    // Ann has fallen in the doorway; Bo stands well back from it. Three bandits on the far side.
    let state = board(gap("rock"));
    state.aiOff = false;
    hero(state, "ann", "qa_paladin", at(7, 6));
    Object.assign(hero(state, "bo", "qa_paladin", at(3, 6)), { hp: 40, maxHp: 40 });
    const band = [at(9, 6), at(10, 6), at(10, 5)].map((p) => enemy(state, "bandit", p, "g1", 200).id);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    Object.assign(unit(state, "ann"), { hp: 0, down: true });
    // Nobody walks through her: the doorway is shut to them on foot.
    expect(stepCost(state, unit(state, band[0]), at(8, 6), at(7, 6))).toEqual(none);
    for (let i = 0; i < 300 && state.encounter && state.encounter.round <= 30; i++) {
      state = must(state, { type: "timeout" }, events);
      apart(state, `round ${state.encounter?.round}`);
      if (state.encounter) expect(unit(state, "ann").pos).toEqual(at(7, 6));
    }
    // They went over her, each from the hex before the doorway to the hex behind it, and got to Bo: the fight did not hang there.
    const leaps = got(events, "jumped").filter((e) => band.includes(e.id));
    expect(leaps.length).toBeGreaterThanOrEqual(1);
    for (const e of leaps) expect([e.from, e.to]).toEqual([at(8, 6), at(6, 6)]);
    expect(got(events, "hit").some((e) => e.target === "bo")).toBe(true);
    expect(got(events, "fight_end").map((e) => e.outcome)).toEqual(["defeat"]);
  });

  it("is shuffled off by a walker who is stopped on one that is full", () => {
    // Bo and Cy stand together on the straight way; a wolf beside their hex notices Ann the moment she steps onto it.
    let state = board();
    hero(state, "ann", "qa_paladin", at(2, 6));
    hero(state, "bo", "qa_paladin", at(4, 6));
    hero(state, "cy", "qa_paladin", at(4, 6));
    const wolf = enemy(state, "wolf", at(4, 5));
    expect(hexDistance(wolf.pos, at(3, 6))).toBeGreaterThan(ALERT_RANGE);
    expect(hexDistance(wolf.pos, at(4, 6))).toBe(ALERT_RANGE);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, events);
    expect(state.encounter).not.toBeNull();
    // She was stopped on the full hex, and stepped off it to the nearest with room: never onto the wolf's.
    const moved = got(events, "moved").filter((e) => e.id === "ann");
    expect(moved[0].path).toEqual([at(3, 6), at(4, 6)]);
    expect(moved).toHaveLength(2);
    expect(moved[1].path).toEqual([unit(state, "ann").pos]);
    expect(hexDistance(unit(state, "ann").pos, at(4, 6))).toBe(1);
    expect(unit(state, "ann").pos).not.toEqual(unit(state, wolf.id).pos);
    apart(state);
  });

  it("draws a blow only by leaving a reach: round an enemy from one hex beside it to another, nothing; away from it, the blow", () => {
    const beside = board();
    hero(beside, "ann", "qa_paladin", at(5, 6));
    const foe = enemy(beside, "bandit", at(6, 6));
    const round: ZoneEvent[] = [];
    expect(leavesReach(beside, at(6, 6), at(5, 6), at(5, 5))).toBe(false);
    expect(leavesReach(beside, at(6, 6), at(5, 6), at(4, 6))).toBe(true);
    must(fight(beside), { type: "move", by: "ann", unit: "ann", to: at(5, 5) }, round);
    expect(got(round, "reaction")).toEqual([]);
    // Away from it altogether: the blow.
    const away: ZoneEvent[] = [];
    must(fight(beside), { type: "move", by: "ann", unit: "ann", to: at(3, 6) }, away);
    expect(got(away, "reaction")).toEqual([{ t: "reaction", id: foe.id, target: "ann" }]);
    // Disengaged first, she slips away untouched.
    const quiet: ZoneEvent[] = [];
    must(must(fight(beside), { type: "common", by: "ann", unit: "ann", what: "disengage" }), { type: "move", by: "ann", unit: "ann", to: at(3, 6) }, quiet);
    expect(got(quiet, "reaction")).toEqual([]);
    // Friends sharing a hex are in each other's reach, and nobody strikes at a friend for leaving it.
    const pair = board();
    hero(pair, "ann", "qa_paladin", at(5, 6));
    hero(pair, "bo", "qa_paladin", at(5, 6));
    enemy(pair, "dummy", at(12, 2));
    const off: ZoneEvent[] = [];
    must(fight(pair), { type: "move", by: "ann", unit: "ann", to: at(3, 6) }, off);
    expect(got(off, "reaction")).toEqual([]);
  });

  it("is within reach of itself only for a friend: a helping hand reaches whoever shares it, and no swing or blast takes in the user's own hex", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(5, 6), ["bash", "cleave"]);
    hero(state, "bo", "frontend_bard", at(5, 6), ["bellows_blast"]);
    const foe = enemy(state, "bandit", at(6, 6), "g1", 200);
    state = fight(state);
    // A blow by hand reaches the hex beside, where an enemy is; the same hex is in reach too, but only a friend is ever on it.
    expect(strikes(state.map, ann.pos, foe.pos)).toBe(true);
    expect(strikes(state.map, ann.pos, unit(state, "bo").pos)).toBe(true);
    expect(checkAbility(state, unit(state, "ann"), "bash", { target: foe.id })).toBeNull();
    expect(checkAbility(state, unit(state, "ann"), "bash", { target: "bo" })).toMatch(/Pick an enemy/);
    // A swing is the three hexes on the side aimed at, and a blast round the user the six beside them: never their own.
    const swing = abilityArea(state, unit(state, "ann"), "cleave", at(6, 6));
    expect(swing).toHaveLength(3);
    expect(swing.some((p) => same(p, at(5, 6)))).toBe(false);
    expect(swing.some((p) => same(p, at(6, 6)))).toBe(true);
    const round = abilityArea(state, unit(state, "bo"), "bellows_blast");
    expect(round).toHaveLength(6);
    expect(round.some((p) => same(p, at(5, 6)))).toBe(false);
    // Both of them on the one hex strike the bandit beside it, and the blast is not thrown at the friend it is thrown from beside.
    const events: ZoneEvent[] = [];
    let after = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id }, events);
    expect(events.some((e) => e.t === "roll" && e.roll.kind === "attack" && e.roll.target === foe.id)).toBe(true);
    after = turnOf(must(after, endTurn("ann")), "bo");
    const blown: ZoneEvent[] = [];
    must(after, { type: "use", by: "bo", unit: "bo", ability: "bellows_blast" }, blown);
    expect(rolls(blown, "Bellows Blast").map((r) => r.id)).toEqual([foe.id]);
    // A shot with an enemy at the shooter's elbow is an awkward one.
    expect(attackContext(state, unit(state, "bo"), unit(state, foe.id), { melee: false }).notes).toContain("Disadvantage: an enemy is beside you");
    // Someone who has fallen on your own hex is near enough to help up, and gets up on it.
    Object.assign(unit(after, "ann"), { hp: 0, down: true });
    const helped: ZoneEvent[] = [];
    after = must(after, { type: "common", by: "bo", unit: "bo", what: "help", target: "ann" }, helped);
    expect(helped).toContainEqual({ t: "up", id: "ann" });
    expect(unit(after, "ann")).toMatchObject({ down: false, hp: 1, pos: at(5, 6) });
    apart(after);
  });

  it("is where a shove sends nobody across the lines: straight away from the shover, onto a hex of its own side's if there is room, and never onto one of the shover's", () => {
    const here = at(5, 6);
    // Straight away from the shover, whichever side they stand on.
    expect(shoveDest(at(4, 6), here)).toEqual(at(6, 6));
    expect(shoveDest(at(6, 6), here)).toEqual(at(4, 6));
    for (const d of HEX_DIRS) expect(shoveDest({ q: here.q - d.q, r: here.r - d.r }, here)).toEqual({ q: here.q + d.q, r: here.r + d.r });
    // Ann shoves a bandit that has Bo right behind it: there is no going there, so it takes the knock and falls flat, as against a wall.
    let pinned = board();
    hero(pinned, "ann", "qa_paladin", at(5, 6));
    hero(pinned, "bo", "qa_paladin", at(7, 6));
    const foe = enemy(pinned, "bandit", at(6, 6), "g1", 80);
    pinned = fight(pinned);
    expect(shiftInto(pinned, at(6, 6), at(7, 6), unit(pinned, foe.id))).toBeNull();
    const knocked = seek(pinned, shove(foe.id), (o) => won(o.events));
    expect(knocked.events).toContainEqual({ t: "shoved", id: "ann", target: foe.id, from: at(6, 6), to: null });
    const hit = got(knocked.events, "hit").find((e) => e.what === "shove")!;
    expect(hit.dice).toMatchObject({ d: 4, plus: 0 });
    expect(unit(knocked.state, foe.id)).toMatchObject({ pos: at(6, 6), hp: 80 - hit.dice!.total });
    expect(has(knocked.state, foe.id, "prone")).toBe(true);
    apart(knocked.state);
    // With one of its own behind it instead, there is room: it is shoved onto that hex, and the two of them stand there.
    let backed = board();
    hero(backed, "ann", "qa_paladin", at(5, 6));
    const front = enemy(backed, "bandit", at(6, 6), "g1", 80);
    const behind = enemy(backed, "dummy", at(7, 6));
    backed = fight(backed);
    expect(shiftInto(backed, at(6, 6), at(7, 6), unit(backed, front.id))).toEqual({ how: "open", levels: 0 });
    const sent = seek(backed, shove(front.id), (o) => won(o.events));
    expect(sent.events).toContainEqual({ t: "shoved", id: "ann", target: front.id, from: at(6, 6), to: at(7, 6) });
    expect(unitsAt(sent.state, at(7, 6)).map((u) => u.id).sort()).toEqual([front.id, behind.id].sort());
    expect(has(sent.state, front.id, "prone")).toBe(false);
    // And the enemy's shove is stopped the same way by one of its own standing behind the hero.
    let hemmed = board();
    hero(hemmed, "ann", "qa_paladin", at(5, 6));
    const shover = enemy(hemmed, "bandit", at(6, 6));
    enemy(hemmed, "dummy", at(4, 6));
    hemmed = fight(hemmed);
    expect(shiftInto(hemmed, at(5, 6), shoveDest(unit(hemmed, shover.id).pos, at(5, 6)), unit(hemmed, "ann"))).toBeNull();
  });
});

// ---------- height ----------

describe("cliffs and ladders", () => {
  // A block of ground three hexes wide and three rows deep, two levels up (three, along its far side), a cliff all round it,
  // with one ladder up its near side from at(7, 6) to at(8, 6).
  const top = [...run(8, 10, 5), ...run(8, 10, 6), ...run(8, 10, 7)];
  const mesa = (ladders = true): Edit => both(on(top, { elev: 2 }), on([at(10, 5), at(10, 6), at(10, 7)], { elev: 3 }), ladders ? ladder(at(7, 6), at(8, 6)) : () => {});

  it("cost a step for level ground, one more to climb a level, and are not walked at all where the step is two levels or more", () => {
    const state = board(both(mesa(), on([at(3, 6)], { elev: 1 })));
    const ann = hero(state, "ann", "qa_paladin", at(2, 6));
    expect(stepCost(state, ann, at(1, 6), at(2, 6)).cost).toBe(1);
    expect(stepCost(state, ann, at(2, 6), at(3, 6)).cost).toBe(2);
    expect(stepCost(state, ann, at(3, 6), at(4, 6)).cost).toBe(1);
    // A cliff, up or down, where no ladder stands.
    expect(stepCost(state, ann, at(7, 5), at(8, 5)).cost).toBe(Infinity);
    expect(stepCost(state, ann, at(8, 5), at(7, 5)).cost).toBe(Infinity);
    // Up on top, the far side is one level higher: a step like any slope.
    expect(stepCost(state, ann, at(9, 6), at(10, 6)).cost).toBe(2);
  });

  it("are crossed on foot by a ladder: a step and one more for each level up it, two steps down it", () => {
    let state = board(both(mesa(), on([at(11, 6)], { elev: 0 }), ladder(at(11, 6), at(10, 6))));
    const ann = hero(state, "ann", "qa_paladin", at(5, 6));
    expect(ladderBetween(state.map, at(7, 6), at(8, 6))).toBe(true);
    expect(ladderBetween(state.map, at(8, 6), at(7, 6))).toBe(true);
    // It joins the two hexes it stands between, and no others.
    expect(ladderBetween(state.map, at(7, 5), at(8, 5))).toBe(false);
    expect(ladderBetween(state.map, at(7, 6), at(6, 6))).toBe(false);
    expect(stepCost(state, ann, at(7, 6), at(8, 6))).toEqual({ cost: 1 + 2, stop: true });
    expect(stepCost(state, ann, at(8, 6), at(7, 6))).toEqual({ cost: 2, stop: true });
    // Three levels of it on the far side.
    expect(stepCost(state, ann, at(11, 6), at(10, 6)).cost).toBe(1 + 3);
    expect(stepCost(state, ann, at(10, 6), at(11, 6)).cost).toBe(2);
    // So she walks up onto the top, by way of the ladder.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }, events);
    expect(got(events, "moved")).toEqual([{ t: "moved", id: "ann", path: run(6, 9) }]);
    expect(elevOf(state.map, unit(state, "ann").pos)).toBe(2);
    // With no ladder there is no walking up it, or down off it, at all.
    const bare = board(mesa(false));
    hero(bare, "ann", "qa_paladin", at(5, 6));
    hero(bare, "bo", "qa_paladin", at(9, 6));
    expect(fails(bare, { type: "move", by: "ann", unit: "ann", to: at(9, 6) })).toMatch(/cannot get there/);
    expect(fails(bare, { type: "move", by: "bo", unit: "bo", to: at(5, 6) })).toMatch(/cannot get there/);
    expect([...zoneReach(bare, unit(bare, "bo"), 500).keys()].sort()).toEqual(top.map(posKey).sort());
  });

  it("in a fight a ladder is paid for out of the turn's movement like any ground", () => {
    let state = board(mesa());
    hero(state, "ann", "qa_paladin", at(6, 6));
    enemy(state, "dummy", at(6, 9));
    state = fight(state);
    const left = moveLeft(state.encounter!.budgets.ann);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) });
    expect(moveLeft(state.encounter!.budgets.ann)).toBe(left - 1 - 3);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(moveLeft(state.encounter!.budgets.ann)).toBe(left - 1 - 3 - 2);
  });

  it("stop a blow by hand: it reaches the same hex or the next, a level apart at most, unless a ladder joins them", () => {
    const state = board(both(mesa(), on([at(3, 6)], { elev: 1 })));
    const { map } = state;
    expect(strikes(map, at(2, 6), at(2, 6))).toBe(true);
    expect(strikes(map, at(1, 6), at(2, 6))).toBe(true);
    expect(strikes(map, at(1, 6), at(3, 6))).toBe(false);
    // A slope is no bar, either way.
    expect(strikes(map, at(2, 6), at(3, 6))).toBe(true);
    expect(strikes(map, at(3, 6), at(2, 6))).toBe(true);
    // A cliff is, either way; the ladder is not.
    expect(strikes(map, at(7, 5), at(8, 5))).toBe(false);
    expect(strikes(map, at(8, 5), at(7, 5))).toBe(false);
    expect(strikes(map, at(7, 6), at(8, 6))).toBe(true);
    expect(strikes(map, at(8, 6), at(7, 6))).toBe(true);
  });

  it("so nothing done by hand crosses a cliff: no blow, no swing, no shove, no helping hand, and no blow drawn by walking away", () => {
    let state = board(mesa());
    hero(state, "ann", "qa_paladin", at(7, 5), ["bash", "cleave"]);
    hero(state, "bo", "qa_paladin", at(8, 5));
    const above = enemy(state, "bandit", at(8, 5));
    state = fight(state);
    const ann = unit(state, "ann");
    expect(checkAbility(state, ann, "bash", { target: above.id })).toMatch(/out of reach up there/);
    expect(checkAbility(state, unit(state, "bo"), "bash", { target: above.id })).toBeNull();
    expect(checkAbility(state, { ...unit(state, "bo"), pos: at(8, 5) }, "bash", { target: above.id })).toBeNull();
    expect(checkAbility(state, ann, "cleave", { at: at(8, 5) })).toMatch(/No enemy is in that swing/);
    expect(fails(state, shove(above.id))).toMatch(/next to it/);
    // From the top, looking down at someone at the foot of it.
    const below = enemy(state, "bandit", at(7, 6));
    state.encounter!.order.push(below.id);
    unit(state, "bo").pos = at(8, 7);
    expect(strikes(state.map, at(8, 7), at(7, 7))).toBe(false);
    unit(state, below.id).pos = at(7, 7);
    expect(checkAbility(state, unit(state, "bo"), "bash", { target: below.id })).toMatch(/out of reach down there/);
    // Bo falls up there: Ann, right below, cannot reach to help.
    Object.assign(unit(state, "bo"), { hp: 0, down: true });
    unit(state, "ann").pos = at(7, 7);
    expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "help", target: "bo" })).toMatch(/next to them/);
    // Ann walks away from under the bandit on the cliff top: it cannot strike at her, so it does not.
    unit(state, "ann").pos = at(7, 5);
    unit(state, below.id).pos = at(1, 1);
    expect(leavesReach(state, above.pos, at(7, 5), at(6, 5))).toBe(false);
    const events: ZoneEvent[] = [];
    must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 5) }, events);
    expect(got(events, "reaction")).toEqual([]);
  });

  it("but a fight goes on up and down a ladder: the one at the top strikes at +2, the one at the foot at -2, and leaving it draws the blow", () => {
    let state = board(mesa());
    hero(state, "ann", "qa_paladin", at(7, 6));
    hero(state, "bo", "qa_paladin", at(8, 5));
    const foe = enemy(state, "bandit", at(8, 6), "g1", 200);
    state = fight(state);
    const [ann, bandit, bo] = [unit(state, "ann"), unit(state, foe.id), unit(state, "bo")];
    expect(checkAbility(state, ann, "bash", { target: foe.id })).toBeNull();
    const up = attackContext(state, ann, bandit, { melee: true });
    expect(up.mods).toBe(-2);
    expect(up.notes).toContain("-2 striking up a ladder");
    const down = attackContext(state, bandit, ann, { melee: true });
    expect(down.mods).toBe(2);
    expect(down.notes).toContain("+2 striking down a ladder");
    // On a level with it, neither.
    expect(attackContext(state, bo, bandit, { melee: true }).mods).toBe(0);
    // The blow she lands is rolled with it.
    const events: ZoneEvent[] = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id }, events);
    const roll = events.flatMap((e) => (e.t === "roll" && e.roll.kind === "attack" ? [e.roll] : []))[0];
    expect(roll.bonus).toBe(proficiency(1) + mod(ann.stats!.str) - 2);
    // Stepping back from the foot of the ladder takes her out of its reach: it strikes.
    const away: ZoneEvent[] = [];
    must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, away);
    expect(got(away, "reaction")).toEqual([{ t: "reaction", id: foe.id, target: "ann" }]);
  });
});

describe("high ground", () => {
  it("hides what lies beyond it: no line is drawn over ground higher than both its ends", () => {
    const ridge = board(on([at(5, 6)], { elev: 2 }));
    expect(sees(ridge.map, at(3, 6), at(7, 6))).toBe(false);
    expect(sees(ridge.map, at(7, 6), at(3, 6))).toBe(false);
    // The ridge itself is in plain view, and so is what lies beside the line.
    expect(sees(ridge.map, at(3, 6), at(5, 6))).toBe(true);
    expect(sees(ridge.map, at(3, 5), at(7, 5))).toBe(true);
    // From as high as the ridge, or higher, it hides nothing; from lower than it, still everything.
    expect(sees(board(on([at(5, 6), at(7, 6)], { elev: 2 })).map, at(3, 6), at(7, 6))).toBe(true);
    expect(sees(board(both(on([at(5, 6)], { elev: 2 }), on([at(3, 6)], { elev: 4 }))).map, at(3, 6), at(7, 6))).toBe(true);
    expect(sees(board(both(on([at(5, 6)], { elev: 3 }), on([at(3, 6)], { elev: 2 }))).map, at(3, 6), at(7, 6))).toBe(false);
    expect(sees(board().map, at(3, 6), at(7, 6))).toBe(true);
    // So no shot is had across it.
    hero(ridge, "ann", "refactor_rogue", at(3, 6), ["bow_shot"]);
    const foe = enemy(ridge, "dummy", at(7, 6));
    expect(checkAbility(ridge, unit(ridge, "ann"), "bow_shot", { target: foe.id })).toMatch(/no clear line/);
  });

  it("lets a shot or a spell reach a hex further for each level it looks down, two at the most, and no further for looking up", () => {
    const range = tacticOf("bow_shot").range;
    const map = board(both(on([at(1, 6)], { elev: 1 }), on([at(1, 7)], { elev: 2 }), on([at(1, 8)], { elev: MAX_ELEV }))).map;
    expect(reachFrom(map, at(1, 5), at(9, 5), range)).toBe(range);
    expect(reachFrom(map, at(1, 6), at(9, 5), range)).toBe(range + 1);
    expect(reachFrom(map, at(1, 7), at(9, 5), range)).toBe(range + 2);
    expect(reachFrom(map, at(1, 8), at(9, 5), range)).toBe(range + HIGH_REACH);
    expect(reachFrom(map, at(9, 5), at(1, 8), range)).toBe(range);
    // An archer three levels up a tower reaches two hexes past her bow's range; from the ground she does not.
    const tower = board(on([at(1, 6)], { elev: 3 }));
    const ann = hero(tower, "ann", "refactor_rogue", at(1, 6), ["bow_shot"]);
    const far = enemy(tower, "dummy", at(1 + range + HIGH_REACH, 6));
    const further = enemy(tower, "dummy", at(2 + range + HIGH_REACH, 6));
    expect(checkAbility(tower, ann, "bow_shot", { target: far.id })).toBeNull();
    expect(checkAbility(tower, ann, "bow_shot", { target: further.id })).toMatch(/Out of range/);
    expect(checkAbility(tower, { ...ann, pos: at(1, 7) }, "bow_shot", { target: unit(tower, far.id).id })).toMatch(/Out of range/);
    // And lands better for it: +2 from above, -2 shooting up.
    expect(attackContext(tower, ann, unit(tower, far.id), { melee: false }).notes).toContain("+2 high ground");
    expect(attackContext(tower, { ...ann, pos: at(5, 6) }, { ...unit(tower, far.id), pos: at(1, 6) }, { melee: false }).notes).toContain("-2 shooting uphill");
    // The enemy's archers reckon it the same way.
    const volley = enemyStrikes("archer", 1).find((s) => s.range > 1)!;
    const archer = enemy(tower, "archer", at(1, 6), "g2");
    const mark = { ...ann, pos: at(1 + volley.range + HIGH_REACH, 6) };
    expect(strikeReaches(tower, archer, at(1, 6), volley, mark)).toBe(true);
    expect(strikeReaches(tower, archer, at(1, 7), volley, mark)).toBe(false);
  });
});

describe("a jump", () => {
  const jump = (to: HexPos): ZoneAction => ({ type: "common", by: "ann", unit: "ann", what: "jump", at: to });
  /** Ann on a hex `from` levels up, with a hex `to` levels up beside her. */
  const ledge = (from: number, to: number) => {
    const state = board(both(on([at(5, 6)], { elev: from }), on([at(6, 6)], { elev: to })));
    hero(state, "ann", "qa_paladin", at(5, 6));
    return state;
  };

  it("goes up a ledge two levels high, and no higher", () => {
    expect(JUMP_UP).toBe(2);
    const events: ZoneEvent[] = [];
    const up = must(ledge(0, 2), jump(at(6, 6)), events);
    expect(unit(up, "ann").pos).toEqual(at(6, 6));
    expect(events).toContainEqual({ t: "jumped", id: "ann", from: at(5, 6), to: at(6, 6) });
    expect(got(events, "fell")).toEqual([]);
    expect(fails(ledge(0, 3), jump(at(6, 6)))).toMatch(/Too high/);
    expect(fails(ledge(2, MAX_ELEV), jump(at(6, 6)))).toMatch(/Too high/);
  });

  it("comes down two levels unhurt; from higher it is a fall: a d4 for each level past the second, and landing flat", () => {
    expect(JUMP_DOWN).toBe(2);
    const soft: ZoneEvent[] = [];
    const landed = must(ledge(2, 0), jump(at(6, 6)), soft);
    expect(unit(landed, "ann")).toMatchObject({ pos: at(6, 6), hp: unit(landed, "ann").maxHp, conditions: [] });
    expect(got(soft, "fell")).toEqual([]);
    for (const levels of [3, 5]) {
      const events: ZoneEvent[] = [];
      const state = must(ledge(levels, 0), jump(at(6, 6)), events);
      expect(events).toContainEqual({ t: "fell", id: "ann", levels });
      const hit = got(events, "hit").find((e) => e.what === "fall")!;
      // Her own leap: nobody did it to her.
      expect(hit).toMatchObject({ actor: null, target: "ann", crit: false });
      expect(hit.dice).toMatchObject({ d: 4, plus: 0 });
      expect(hit.dice!.faces).toHaveLength(levels - JUMP_DOWN);
      checkDice(hit.dice!, `${levels} levels`);
      expect(hit.amount).toBe(hit.dice!.total);
      expect(unit(state, "ann").hp).toBe(unit(state, "ann").maxHp - hit.amount);
      expect(has(state, "ann", "prone")).toBe(true);
    }
  });

  it("in a fight takes its AP, and a hard landing ends the turn's walking", () => {
    let state = ledge(3, 0);
    enemy(state, "dummy", at(12, 6));
    state = fight(state);
    state = must(state, jump(at(6, 6)));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - COMMON_ACTIONS.jump.cost, stride: 0, move: 0 });
    expect(has(state, "ann", "prone")).toBe(true);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) })).toMatch(/cannot get there/);
    // She can still strike from where she lies, with what AP she has.
    expect(state.encounter!.budgets.ann.ap).toBeGreaterThanOrEqual(ACTION_AP);
  });
});

// ---------- over the edge ----------

describe("knocked toward a drop", () => {
  /** Ann beside a bandit on high ground, with a drop of `levels` right behind it. In a fight, on her turn. */
  function atTheEdge(levels: number, kind = "bandit", classId = "qa_paladin") {
    let state = board(on(run(3, 6), { elev: levels }));
    hero(state, "ann", classId, at(5, 6));
    const foe = enemy(state, kind, at(6, 6), "g1", 80);
    enemy(state, "dummy", at(12, 2));
    state = fight(state);
    return { state, foe: foe.id };
  }

  it("a shove first has to be won; then whoever is shoved rolls Agility to catch the edge, against the shover's strength", () => {
    const { state, foe } = atTheEdge(2);
    const ann = unit(state, "ann");
    expect(shiftInto(state, at(6, 6), at(7, 6), unit(state, foe))).toEqual({ how: "drop", levels: 2 });
    // Lost: no edge comes into it.
    const lost = seek(state, shove(foe), (o) => !won(o.events));
    expect(rolls(lost.events, "Catch the edge")).toEqual([]);
    expect(lost.events).toContainEqual({ t: "miss", actor: "ann", target: foe, what: "shove" });
    expect(unit(lost.state, foe).pos).toEqual(at(6, 6));
    // Won: the save, against 10, her Strength and half her practice.
    const any = seek(state, shove(foe), (o) => won(o.events));
    const [save] = rolls(any.events, "Catch the edge");
    expect(save).toMatchObject({ kind: "save", id: foe, vs: 10 + mod(ann.stats!.str) + Math.floor(proficiency(1) / 2), adv: 0 });
    expect(save.vs).toBe(edgeDc(state, ann));
    expect(state.encounter!.budgets.ann.ap - any.state.encounter!.budgets.ann.ap).toBe(COMMON_ACTIONS.shove.cost);
  });

  it("the save made, it holds on and stays where it is", () => {
    const { state, foe } = atTheEdge(2);
    const held = seek(state, shove(foe), (o) => won(o.events) && caught(o.events));
    expect(held.events).toContainEqual({ t: "held", id: foe, at: at(7, 6) });
    expect(got(held.events, "shoved")).toEqual([]);
    expect(got(held.events, "fell")).toEqual([]);
    expect(unit(held.state, foe)).toMatchObject({ pos: at(6, 6), hp: 80, conditions: [] });
  });

  it("the save failed, it goes over: a d4 for each level past the first, and it lands flat at the bottom", () => {
    for (const levels of [2, 3, 5]) {
      const { state, foe } = atTheEdge(levels);
      const over = seek(state, shove(foe), wentOver);
      expect(over.events).toContainEqual({ t: "shoved", id: "ann", target: foe, from: at(6, 6), to: at(7, 6) });
      expect(over.events).toContainEqual({ t: "fell", id: foe, levels });
      const hit = got(over.events, "hit").find((e) => e.what === "fall")!;
      expect(hit).toMatchObject({ actor: "ann", target: foe });
      expect(hit.dice).toMatchObject({ d: 4, plus: 0 });
      expect(hit.dice!.faces).toHaveLength(levels - 1);
      checkDice(hit.dice!, `${levels} levels`);
      expect(unit(over.state, foe)).toMatchObject({ pos: at(7, 6), hp: 80 - hit.dice!.total });
      expect(has(over.state, foe, "prone")).toBe(true);
      // In that order: shoved, fell, hurt, flat.
      const order = over.events.map((e) => (e.t === "hit" ? "hit" : e.t === "condition" ? e.kind : e.t)).filter((t) => ["shoved", "fell", "hit", "prone"].includes(t));
      expect(order).toEqual(["shoved", "fell", "hit", "prone"]);
    }
  });

  it("a drop of one level is no edge at all: it is simply shoved down it", () => {
    const { state, foe } = atTheEdge(1);
    const down = seek(state, shove(foe), (o) => won(o.events));
    expect(rolls(down.events, "Catch the edge")).toEqual([]);
    expect(got(down.events, "fell")).toEqual([]);
    expect(unit(down.state, foe)).toMatchObject({ pos: at(7, 6), hp: 80 });
  });

  it("a boss catches at the edge with advantage, and anyone lying flat with disadvantage", () => {
    const boss = atTheEdge(2, "alpha");
    expect(ENEMIES.alpha.boss).toBe(true);
    const tried = seek(boss.state, shove(boss.foe), (o) => won(o.events));
    expect(rolls(tried.events, "Catch the edge")[0]).toMatchObject({ adv: 1 });
    expect(rolls(tried.events, "Catch the edge")[0].d20).toHaveLength(2);
    const flat = atTheEdge(2);
    unit(flat.state, flat.foe).conditions.push({ kind: "prone", rounds: 2 });
    const kicked = seek(flat.state, shove(flat.foe), (o) => won(o.events));
    expect(rolls(kicked.events, "Catch the edge")[0]).toMatchObject({ adv: -1 });
  });

  it("what is in the way is still in the way: against rock, a cliff face, a hex full of its own side or one the shover's side holds, it takes a knock and falls flat where it stands", () => {
    const blocked: [string, ZoneState, string][] = [];
    const make = (why: string, edit: Edit, crowd: "own" | "other" | null = null) => {
      let state = board(edit);
      hero(state, "ann", "qa_paladin", at(5, 6));
      const foe = enemy(state, "bandit", at(6, 6), "g1", 80);
      if (crowd === "own") for (let i = 0; i < HEX_ROOM; i++) enemy(state, "dummy", at(7, 6));
      if (crowd === "other") hero(state, "bo", "qa_paladin", at(7, 6));
      state = fight(state);
      blocked.push([why, state, foe.id]);
    };
    make("rock", on([at(7, 6)], { biome: "rock" }));
    make("a cliff face", on([at(7, 6)], { elev: 2 }));
    make("a wall", on([at(7, 6)], { prop: "wall" }));
    make("a full hex", () => {}, "own");
    make("a hex the shover's side holds", () => {}, "other");
    for (const [why, state, foe] of blocked) {
      expect(shiftInto(state, at(6, 6), at(7, 6), unit(state, foe)), why).toBeNull();
      const { state: after, events } = seek(state, shove(foe), (o) => won(o.events));
      expect(events, why).toContainEqual({ t: "shoved", id: "ann", target: foe, from: at(6, 6), to: null });
      expect(rolls(events, "Catch the edge"), why).toEqual([]);
      const hit = got(events, "hit").find((e) => e.what === "shove")!;
      expect(hit.dice, why).toMatchObject({ d: 4, plus: 0 });
      expect(hit.dice!.faces, why).toHaveLength(1);
      expect(unit(after, foe), why).toMatchObject({ pos: at(6, 6), hp: 80 - hit.dice!.total });
      expect(has(after, foe, "prone"), why).toBe(true);
    }
  });
});

describe("knocked into a pit", () => {
  /** Ann beside a bandit that has `what` right behind it, and another bandit far off, in a fight on her turn. */
  function atThePit(what: "water" | "lava" | "void", kind = "bandit") {
    const pit = at(7, 6);
    let state = what === "void" ? board(() => {}, [pit]) : board(on([pit], { biome: "water", ...(what === "lava" ? { clime: "ash" as const } : {}) }));
    hero(state, "ann", "qa_paladin", at(5, 6));
    const foe = enemy(state, kind, at(6, 6));
    const other = enemy(state, "bandit", at(12, 2));
    state = fight(state);
    return { state, foe: foe.id, other: other.id, pit };
  }

  it("deep water, lava and the edge of the land are each one: nobody walks into it", () => {
    for (const what of ["water", "lava", "void"] as const) {
      const { state, pit } = atThePit(what);
      expect(pitAt(state.map, pit)).toBe(what);
      expect(pitAt(state.map, at(6, 6))).toBeNull();
      expect(stepCost(state, unit(state, "ann"), at(6, 6), pit).cost).toBe(Infinity);
      expect(shiftInto(state, at(6, 6), pit, unit(state, "ann"))).toEqual({ how: "pit", pit: what });
    }
  });

  it("an enemy that fails to catch the edge is lost: down for good where it stood, and nothing of it left to search when the fight is over", () => {
    for (const what of ["water", "lava", "void"] as const) {
      const { state, foe, other, pit } = atThePit(what);
      const paid: ZoneEffect[] = [];
      const sunk = seek(state, shove(foe), wentOver);
      expect(sunk.events, what).toContainEqual({ t: "sunk", id: foe, by: "ann", from: at(6, 6), into: pit, pit: what });
      expect(sunk.events, what).toContainEqual({ t: "down", id: foe });
      expect(got(sunk.events, "shoved"), what).toEqual([]);
      // It is in the fight's order still, fallen, and marked as gone.
      expect(unit(sunk.state, foe), what).toMatchObject({ down: true, hp: 0, lost: what, pos: at(6, 6) });
      expect(sunk.state.encounter!.order, what).toContain(foe);
      expect(sunk.state.loot ?? [], what).toEqual([]);
      // The other falls to the sword, and the fight is won: one body lies there, and it is not the lost one's.
      Object.assign(unit(sunk.state, other), { hp: 0, down: true });
      const events: ZoneEvent[] = [];
      const after = must(sunk.state, endTurn("ann"), events, paid);
      expect(events, what).toContainEqual({ t: "fight_end", outcome: "victory" });
      expect(after.units.some((u) => u.side === "enemy"), what).toBe(false);
      expect((after.loot ?? []).map((s) => s.id), what).toEqual([other]);
      // It was beaten all the same: its XP is paid with the other's.
      expect(paid, what).toEqual([{ type: "grant", heroId: "ann", xp: 2 * ENEMIES.bandit.xp, resources: {} }]);
    }
  });

  it("the save made, it stays on the brink", () => {
    const { state, foe, pit } = atThePit("water");
    const held = seek(state, shove(foe), (o) => won(o.events) && caught(o.events));
    expect(held.events).toContainEqual({ t: "held", id: foe, at: pit });
    expect(unit(held.state, foe)).toMatchObject({ down: false, pos: at(6, 6) });
    expect(unit(held.state, foe).lost).toBeUndefined();
  });

  it("stays lost if the fight is then lost: the rest of its band go home healed, and it does not come back", () => {
    const { state, foe, other } = atThePit("water");
    const sunk = seek(state, shove(foe), wentOver);
    Object.assign(unit(sunk.state, "ann"), { hp: 0, down: true });
    const events: ZoneEvent[] = [];
    const after = must(sunk.state, { type: "timeout" }, events);
    expect(events).toContainEqual({ t: "fight_end", outcome: "defeat" });
    expect(unit(after, other)).toMatchObject({ down: false, hp: unit(after, other).maxHp });
    expect(after.units.some((u) => u.id === foe)).toBe(false);
    expect(after.loot ?? []).toEqual([]);
  });

  it("a hero who goes in is hauled back to the brink, down where they stood, to be got up like anyone who has fallen", () => {
    for (const what of ["water", "lava", "void"] as const) {
      const { state, foe, pit } = atThePit(what);
      // The bandit shoves her instead: she stands with her back to it.
      unit(state, "ann").pos = at(6, 6);
      unit(state, foe).pos = at(5, 6);
      let sunk: Ctx | null = null;
      for (let seed = 1; seed < 200 && !sunk; seed++) {
        const ctx: Ctx = { state: structuredClone(state), rng: makeRng(seed), events: [], effects: [] };
        if (push(ctx, at(5, 6), unit(ctx.state, "ann"), foe) === "lost") sunk = ctx;
      }
      expect(sunk, what).not.toBeNull();
      const [save] = rolls(sunk!.events, "Catch the edge");
      expect(save, what).toMatchObject({ id: "ann", ok: false, vs: edgeDc(state, unit(state, foe)) });
      expect(sunk!.events, what).toContainEqual({ t: "sunk", id: "ann", by: foe, from: at(6, 6), into: pit, pit: what });
      const ann = unit(sunk!.state, "ann");
      expect(ann, what).toMatchObject({ down: true, hp: 0, pos: at(6, 6) });
      expect(ann.lost, what).toBeUndefined();
    }
  });

  it("what flies is carried out over water, not into it, and is stopped at the edge of the land", () => {
    const wet = atThePit("water", "bat");
    expect(shiftInto(wet.state, at(6, 6), wet.pit, unit(wet.state, wet.foe))).toEqual({ how: "open", levels: 0 });
    const over = seek(wet.state, shove(wet.foe), (o) => won(o.events));
    expect(rolls(over.events, "Catch the edge")).toEqual([]);
    expect(unit(over.state, wet.foe)).toMatchObject({ pos: wet.pit, down: false });
    const edge = atThePit("void", "bat");
    expect(shiftInto(edge.state, at(6, 6), edge.pit, unit(edge.state, edge.foe))).toBeNull();
    const stopped = seek(edge.state, shove(edge.foe), (o) => won(o.events));
    expect(stopped.events).toContainEqual({ t: "shoved", id: "ann", target: edge.foe, from: at(6, 6), to: null });
    expect(unit(stopped.state, edge.foe).pos).toEqual(at(6, 6));
  });
});

describe("abilities that move someone", () => {
  /** A hero with one ability, and a tough bandit, in a fight on the hero's turn. */
  function versus(classId: string, ability: string, heroAt: HexPos, foeAt: HexPos, edit: Edit, gone: HexPos[] = []) {
    let state = board(edit, gone);
    hero(state, "ann", classId, heroAt, [ability]);
    const foe = enemy(state, "bandit", foeAt, "g1", 200);
    state = fight(state);
    return { state, foe: foe.id };
  }
  const use = (ability: string, aim: { target?: string; at?: HexPos }): ZoneAction => ({ type: "use", by: "ann", unit: "ann", ability, ...aim });

  it("Overwhelm: driven to an edge, it catches it or goes over, and either way the drive ends there with no stun", () => {
    // High ground as far as at(7, 6), and a drop of two beyond.
    const { state, foe } = versus("sre_warden", "overwhelm", at(5, 6), at(6, 6), on(run(3, 7), { elev: 2 }));
    const over = seek(state, use("overwhelm", { target: foe }), wentOver);
    expect(over.events).toContainEqual({ t: "shoved", id: "ann", target: foe, from: at(6, 6), to: at(7, 6) });
    expect(over.events).toContainEqual({ t: "shoved", id: "ann", target: foe, from: at(7, 6), to: at(8, 6) });
    expect(over.events).toContainEqual({ t: "fell", id: foe, levels: 2 });
    expect(unit(over.state, foe).pos).toEqual(at(8, 6));
    expect(has(over.state, foe, "prone")).toBe(true);
    expect(has(over.state, foe, "stunned")).toBe(false);
    const held = seek(state, use("overwhelm", { target: foe }), (o) => caught(o.events));
    expect(held.events).toContainEqual({ t: "held", id: foe, at: at(8, 6) });
    expect(unit(held.state, foe).pos).toEqual(at(7, 6));
    expect(has(held.state, foe, "stunned")).toBe(false);
    // With the edge right behind it, it is the first hex of the drive that goes over.
    const brink = versus("sre_warden", "overwhelm", at(6, 6), at(7, 6), on(run(3, 7), { elev: 2 }));
    const first = seek(brink.state, use("overwhelm", { target: brink.foe }), wentOver);
    expect(got(first.events, "shoved")).toHaveLength(1);
    expect(unit(first.state, brink.foe).pos).toEqual(at(8, 6));
  });

  it("Overwhelm: driven into water, it is lost", () => {
    const { state, foe } = versus("sre_warden", "overwhelm", at(5, 6), at(6, 6), on([at(8, 6)], { biome: "water" }));
    const sunk = seek(state, use("overwhelm", { target: foe }), wentOver);
    expect(sunk.events).toContainEqual({ t: "sunk", id: foe, by: "ann", from: at(7, 6), into: at(8, 6), pit: "water" });
    // The only enemy there was: the fight is won, and there is no body.
    expect(sunk.state.encounter).toBeNull();
    expect(sunk.state.units.some((u) => u.id === foe)).toBe(false);
    expect(sunk.state.loot ?? []).toEqual([]);
  });

  it("Tidal Wave: sweeps whoever fails to brace along the line as far as it is level, and then over the edge it runs off", () => {
    // The wave runs from at(4, 6) to at(8, 6); the high ground ends at at(6, 6).
    const { state, foe } = versus("devops_mage", "tidal_wave", at(3, 6), at(5, 6), on(run(1, 6), { elev: 2 }));
    const swept = (o: Outcome) => rolls(o.events, "Tidal Wave").some((r) => !r.ok);
    const over = seek(state, use("tidal_wave", { at: at(4, 6) }), (o) => swept(o) && wentOver(o));
    expect(got(over.events, "shoved")).toEqual([
      { t: "shoved", id: "ann", target: foe, from: at(5, 6), to: at(6, 6) },
      { t: "shoved", id: "ann", target: foe, from: at(6, 6), to: at(7, 6) },
    ]);
    expect(over.events).toContainEqual({ t: "fell", id: foe, levels: 2 });
    expect(unit(over.state, foe).pos).toEqual(at(7, 6));
    expect(has(over.state, foe, "prone")).toBe(true);
    // Caught at the edge, it is left standing on the last of the high ground.
    const held = seek(state, use("tidal_wave", { at: at(4, 6) }), (o) => swept(o) && caught(o.events));
    expect(unit(held.state, foe).pos).toEqual(at(6, 6));
    // Braced against the wave itself, it does not move at all, and takes half.
    const braced = seek(state, use("tidal_wave", { at: at(4, 6) }), (o) => !swept(o));
    expect(unit(braced.state, foe).pos).toEqual(at(5, 6));
    expect(got(braced.events, "hit")[0].dice).toMatchObject({ halved: true });
    expect(rolls(braced.events, "Catch the edge")).toEqual([]);
  });

  it("Tidal Wave: a line that ends at the water's edge, or runs out over the edge of the land, carries them in", () => {
    const swept = (o: Outcome) => rolls(o.events, "Tidal Wave").some((r) => !r.ok);
    // Water just past the far end of the line.
    const shore = versus("devops_mage", "tidal_wave", at(3, 6), at(5, 6), on([at(9, 6)], { biome: "water" }));
    const drowned = seek(shore.state, use("tidal_wave", { at: at(4, 6) }), (o) => swept(o) && wentOver(o));
    expect(drowned.events).toContainEqual({ t: "shoved", id: "ann", target: shore.foe, from: at(5, 6), to: at(8, 6) });
    expect(drowned.events).toContainEqual({ t: "sunk", id: shore.foe, by: "ann", from: at(8, 6), into: at(9, 6), pit: "water" });
    // No ground at all two hexes on: the land ends in the middle of the line.
    const brink = versus("devops_mage", "tidal_wave", at(3, 6), at(5, 6), () => {}, [at(7, 6), at(8, 6)]);
    const gone = seek(brink.state, use("tidal_wave", { at: at(4, 6) }), (o) => swept(o) && wentOver(o));
    expect(gone.events).toContainEqual({ t: "sunk", id: brink.foe, by: "ann", from: at(6, 6), into: at(7, 6), pit: "void" });
    // The water the wave leaves lies on the land only.
    expect(Object.keys(gone.state.surfaces).sort()).toEqual([at(4, 6), at(5, 6), at(6, 6)].map(posKey).sort());
  });

  it("Throw Pike: dragged off a height toward the thrower, it falls; dragged into water, it is lost", () => {
    // The bandit stands two hexes back on a ledge; the Warden is on the ground below it.
    const high = versus("sre_warden", "throw_pike", at(5, 6), at(8, 6), on(run(7, 9), { elev: 2 }));
    const hit = (o: Outcome) => o.events.some((e) => e.t === "roll" && e.roll.kind === "attack" && e.roll.ok);
    const fell = seek(high.state, use("throw_pike", { target: high.foe }), (o) => hit(o) && wentOver(o));
    expect(got(fell.events, "shoved")).toEqual([
      { t: "shoved", id: "ann", target: high.foe, from: at(8, 6), to: at(7, 6), pulled: 1 },
      { t: "shoved", id: "ann", target: high.foe, from: at(7, 6), to: at(6, 6), pulled: 2 },
    ]);
    expect(fell.events).toContainEqual({ t: "fell", id: high.foe, levels: 2 });
    expect(unit(fell.state, high.foe).pos).toEqual(at(6, 6));
    expect(has(fell.state, high.foe, "prone")).toBe(true);
    const held = seek(high.state, use("throw_pike", { target: high.foe }), (o) => hit(o) && caught(o.events));
    expect(unit(held.state, high.foe).pos).toEqual(at(7, 6));
    // A pool between them.
    const pool = versus("sre_warden", "throw_pike", at(5, 6), at(8, 6), on([at(6, 6)], { biome: "water" }));
    const sunk = seek(pool.state, use("throw_pike", { target: pool.foe }), (o) => hit(o) && wentOver(o));
    expect(sunk.events).toContainEqual({ t: "sunk", id: pool.foe, by: "ann", from: at(7, 6), into: at(6, 6), pit: "water" });
  });
});

// ---------- a fight is heard ----------

describe("a fight is heard", () => {
  /** Ann and a bandit beside her; a second band HEAR_RANGE off, and a third a hex beyond that from anyone. */
  function threeBands() {
    const state = board();
    hero(state, "ann", "qa_paladin", at(2, 6));
    const first = enemy(state, "bandit", at(3, 6), "g1", 200);
    const near = [enemy(state, "bandit", at(2 + HEAR_RANGE, 6), "g2", 200), enemy(state, "bandit", at(2 + HEAR_RANGE, 7), "g2", 200)];
    const far = enemy(state, "bandit", at(2 + 2 * HEAR_RANGE + 1, 6), "g3", 200);
    return { state, first: first.id, near: near.map((u) => u.id), far: far.id };
  }

  it("at the start of each round, a band with one of its own within earshot of someone still fighting comes to join it", () => {
    expect(HEAR_RANGE).toBeGreaterThan(ALERT_RANGE);
    const made = threeBands();
    const { first, near, far } = made;
    const events: ZoneEvent[] = [];
    let state = fight(made.state, "ann", events);
    // The first round: the fight is Ann's and the one bandit's, and nobody else has stirred.
    expect([...state.encounter!.order].sort()).toEqual(["ann", first].sort());
    expect(state.groups).toMatchObject({ g1: { alerted: true }, g2: { alerted: false }, g3: { alerted: false } });
    expect(got(events, "noise")).toEqual([]);
    // Round the order once: the second band has heard it.
    const round: ZoneEvent[] = [];
    while (state.encounter!.round === 1) state = must(state, { type: "timeout" }, round);
    const told = round.map((e) => e.t);
    expect(round).toContainEqual({ t: "noise", group: "g2" });
    expect(told.indexOf("noise")).toBeGreaterThan(told.indexOf("round"));
    expect(round).toContainEqual({ t: "alert", group: "g2", by: "ann" });
    for (const id of near) expect(round).toContainEqual({ t: "fight_join", id });
    expect(rolls(round, "Initiative").map((r) => r.id).sort()).toEqual([...near].sort());
    expect([...state.encounter!.order].sort()).toEqual(["ann", first, ...near].sort());
    expect(state.groups).toMatchObject({ g2: { alerted: true }, g3: { alerted: false } });
    // The third is a hex too far from every one of them, and stays where it is, round after round.
    expect(Math.min(...state.encounter!.order.map((id) => hexDistance(unit(state, id).pos, unit(state, far).pos)))).toBe(HEAR_RANGE + 1);
    const later: ZoneEvent[] = [];
    while (state.encounter!.round < 5) state = must(state, { type: "timeout" }, later);
    expect(got(later, "noise")).toEqual([]);
    expect(state.encounter!.order).not.toContain(far);
    expect(state.groups.g3.alerted).toBe(false);
  });

  it("the fallen make no noise: a band near only someone who is down hears nothing", () => {
    const made = threeBands();
    let state = fight(made.state);
    // Ann moves well away from the second band; the bandit she was fighting lies dead within its earshot.
    unit(state, "ann").pos = at(1, 1);
    unit(state, made.first).pos = at(4, 6);
    const live = enemy(state, "bandit", at(1, 2), "g1", 200);
    state.encounter!.order.push(live.id);
    state.encounter!.init[live.id] = 0;
    Object.assign(unit(state, made.first), { hp: 0, down: true });
    const events: ZoneEvent[] = [];
    while (state.encounter!.round < 3) state = must(state, { type: "timeout" }, events);
    expect(got(events, "noise")).toEqual([]);
    expect(state.groups.g2.alerted).toBe(false);
  });

  it("with the enemy playing its own turns, those who come running get there and fight", () => {
    const made = threeBands();
    made.state.aiOff = false;
    unit(made.state, "ann").hp = unit(made.state, "ann").maxHp = 500;
    const events: ZoneEvent[] = [];
    let state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    for (let i = 0; i < 12 && state.encounter && state.encounter.round < 4; i++) state = must(state, { type: "timeout" }, events);
    for (const id of made.near) {
      expect(got(events, "moved").some((e) => e.id === id)).toBe(true);
      expect(events.some((e) => e.t === "used" && e.id === id && e.what === "attack" && e.target === "ann")).toBe(true);
    }
  });
});

// ---------- the dice, as they are told ----------

describe("dice told with a blow or a heal", () => {
  it("keeps what each die showed: a critical hit rolls twice as many, and the flat part is added once", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plain = rollShown(makeRng(seed), { n: 2, d: 6, plus: 3 }, 2);
      expect(plain).toEqual({ d: 6, faces: plain.faces, plus: 5, total: plain.faces[0] + plain.faces[1] + 5 });
      expect(plain.faces).toHaveLength(2);
      const crit = rollShown(makeRng(seed), { n: 2, d: 6, plus: 3 }, 2, true);
      expect(crit.faces).toHaveLength(4);
      expect(crit.crit).toBe(true);
      // The same dice as far as they go: a critical hit is two more of them.
      expect(crit.faces.slice(0, 2)).toEqual(plain.faces);
      checkDice(plain, `seed ${seed}`);
      checkDice(crit, `seed ${seed}`);
    }
    // What comes to less than nothing is nothing.
    expect(rollShown(makeRng(1), { n: 1, d: 4, plus: -9 }).total).toBe(0);
  });

  it("is carried on every blow, blast and heal that was rolled, and adds up to what was dealt", () => {
    const seen = { crit: 0, halved: 0, whole: 0, heal: 0, enemy: 0, blocked: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      // Ann and a bandit that hits back, toe to toe, for three rounds: a blow, a potion, a bomb at both their feet, more blows.
      let state = board();
      state.aiOff = false;
      const ann = hero(state, "ann", "qa_paladin", at(5, 6), ["bash", "block"]);
      ann.hp = ann.maxHp = 400;
      ann.hp = 200;
      ann.focus = ann.maxFocus = 9;
      const foe = enemy(state, "bandit", at(6, 6), "g1", 400);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      const plan: ZoneAction[][] = [
        [{ type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id, focus: true }, { type: "drink", by: "ann", unit: "ann", item: "healing" }, { type: "use", by: "ann", unit: "ann", ability: "block" }],
        [{ type: "throw", by: "ann", unit: "ann", item: "fire", at: at(6, 6) }, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id, focus: true }],
        [{ type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id, focus: true }, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id, focus: true }],
      ];
      for (const turn of plan) {
        state = turnOf(state, "ann", events);
        for (const action of turn) state = must(state, action, events);
        state = must(state, endTurn("ann"), events);
      }
      for (const e of events) {
        const where = `seed ${seed} ${e.t}`;
        if (e.t === "heal" && e.dice) {
          checkDice(e.dice, where);
          expect(e.amount, where).toBeLessThanOrEqual(e.dice.total);
          seen.heal++;
        }
        if (e.t !== "hit") continue;
        // Every blow here was rolled for: a strike, a bomb, a bandit's own.
        expect(e.dice, where).toBeDefined();
        const dice = e.dice!;
        checkDice(dice, where);
        expect(!!dice.crit, where).toBe(e.crit);
        if (dice.crit) expect(dice.faces.length % 2, where).toBe(0);
        // What it cost: the dice (half, saved against), never less than 1; a guard up or a shield takes its share of that.
        const due = Math.max(1, dice.halved ? Math.floor(dice.total / 2) : dice.total);
        const guarded = e.target === "ann" && e.amount + (e.blocked ?? 0) < due;
        if (guarded) expect(e.amount + (e.blocked ?? 0), where).toBe(Math.ceil(due / 2));
        else expect(e.amount + (e.blocked ?? 0), where).toBe(due);
        if (e.crit) seen.crit++;
        if (dice.halved) seen.halved++;
        else if (e.what === "throw:fire") seen.whole++;
        if (e.actor === foe.id) seen.enemy++;
        if (e.blocked) seen.blocked++;
      }
    }
    // All of it came up: critical hits, saves made and failed against the bomb, a potion drunk, the bandit's blows, a shield spent.
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(0);
  });
});

// ---------- the enemy knows the ground ----------

describe("the enemy uses the ground", () => {
  /**
   * Play a fight between Ann and one enemy from its start until the enemy has had `turns` turns, and no more (Ann
   * does nothing on hers), over one seed. Its turns are played as Ann's end, so they are counted off the turns begun.
   */
  function play(state: ZoneState, seed: number, turns = 1): Outcome {
    const events: ZoneEvent[] = [];
    let after = must({ ...state, rng: seed }, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    // (Over already: it went first, and that was the end of it.)
    if (!after.encounter) return { state: after, events, effects: [] };
    const first = after.encounter.order[0] !== "ann";
    const had = () => (first ? Math.ceil(after.encounter!.turnNo / 2) : Math.floor(after.encounter!.turnNo / 2));
    while (after.encounter && had() < turns) after = must(after, { type: "timeout" }, events);
    return { state: after, events, effects: [] };
  }
  /** What the enemy did, in order: its common actions and attacks by name. */
  const did = (events: ZoneEvent[], id: string) => got(events, "used").filter((e) => e.id === id).map((e) => e.what);

  /** A Mage with a drop of `levels` behind her, and one enemy beside her on the high ground. AI on. */
  function backToTheDrop(kind: string, levels: number, pit = false) {
    const state = board(both(on(run(3, 7), { elev: levels }), pit ? on([at(8, 6)], { biome: "water" }) : () => {}));
    state.aiOff = false;
    const ann = hero(state, "ann", "devops_mage", at(7, 6), ["shock"]);
    ann.hp = ann.maxHp = 300;
    const foe = enemy(state, kind, at(6, 6), "g1", 200);
    return { state, foe: foe.id };
  }

  it("one with hands shoves a hero who has a long drop behind them, before it does anything else", () => {
    const { state, foe } = backToTheDrop("bandit", 3);
    expect(ENEMY_KIT.bandit.shoves).toBe(true);
    let fell = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state: after, events } = play(state, seed);
      // The shove first, for its AP, and that once only (if she kept her feet it is not tried again this turn); then a blow if she is still there to hit.
      expect(did(events, foe)[0], `seed ${seed}`).toBe("shove");
      expect(did(events, foe).filter((what) => what === "shove"), `seed ${seed}`).toHaveLength(1);
      expect(got(events, "used").find((e) => e.id === foe)).toMatchObject({ what: "shove", target: "ann" });
      expect(did(events, foe).length * 1, `seed ${seed}`).toBeLessThanOrEqual(AP_TURN);
      const over = events.findIndex((e) => e.t === "fell");
      if (over < 0) {
        expect(unit(after, "ann").pos, `seed ${seed}`).toEqual(at(7, 6));
        expect(did(events, foe), `seed ${seed}`).toContain("attack");
        continue;
      }
      fell++;
      expect(events[over], `seed ${seed}`).toEqual({ t: "fell", id: "ann", levels: 3 });
      expect(unit(after, "ann").pos, `seed ${seed}`).toEqual(at(8, 6));
      const hit = got(events, "hit").find((e) => e.what === "fall")!;
      expect(hit).toMatchObject({ actor: foe, target: "ann" });
      expect(hit.dice!.faces).toHaveLength(2);
      expect(has(after, "ann", "prone") || unit(after, "ann").conditions.length === 0, `seed ${seed}`).toBe(true);
      // She is out of its reach down there: it has no blow at her for the rest of this turn.
      expect(did(events.slice(over), foe), `seed ${seed}`).toEqual([]);
    }
    expect(fell).toBeGreaterThan(0);
  });

  it("shoves once a turn at the most: a hero who catches the edge is struck with what AP is left, and shoved at again only on its next turn", () => {
    const { state, foe } = backToTheDrop("bandit", 3);
    /** What the enemy did on each of its turns. (There are the two of them, and only a hero's turn is announced: all it does between one of Ann's turns and her next is one turn of its own.) */
    const turnsOf = (events: ZoneEvent[]) => {
      const out: string[][] = [[]];
      for (const e of events) {
        if (e.t === "turn") out.push([]);
        else if (e.t === "used" && e.id === foe) out[out.length - 1].push(e.what);
      }
      return out.filter((did) => did.length > 0);
    };
    let [held, again] = [0, 0];
    for (let seed = 1; seed <= 60; seed++) {
      const { state: after, events } = play(state, seed, 3);
      const turns = turnsOf(events);
      expect(turns.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      for (const [i, did] of turns.entries()) expect(did.filter((what) => what === "shove").length, `seed ${seed} turn ${i + 1}`).toBeLessThanOrEqual(1);
      // She kept her feet on its first turn (it won the shove and she caught the edge, or it lost it): it has AP left
      // for a second go at the edge, and spends them on blows instead.
      if (turns[0][0] === "shove" && !events.some((e) => e.t === "fell") && hexDistance(unit(after, "ann").pos, at(7, 6)) === 0) {
        held++;
        expect(turns[0].slice(1).length, `seed ${seed}`).toBeGreaterThan(0);
        expect(new Set(turns[0].slice(1)), `seed ${seed}`).toEqual(new Set(["attack"]));
        // Next turn she still has her back to the drop, and it tries again: once.
        if (turns.length > 1 && turns[1][0] === "shove") again++;
      }
    }
    expect(held).toBeGreaterThan(0);
    expect(again).toBeGreaterThan(0);
  });

  it("shoves her into the water if that is what is behind her: she goes down on the brink, and is not lost", () => {
    const { state, foe } = backToTheDrop("bandit", 0, true);
    const sunk = (() => {
      for (let seed = 1; seed <= 200; seed++) {
        const o = play(state, seed);
        if (got(o.events, "sunk").length > 0) return o;
      }
      throw new Error("she never went in");
    })();
    expect(sunk.events).toContainEqual({ t: "sunk", id: "ann", by: foe, from: at(7, 6), into: at(8, 6), pit: "water" });
    // The only hero in it is down: the fight is lost, and she wakes at the start like anyone beaten.
    expect(sunk.events).toContainEqual({ t: "fight_end", outcome: "defeat" });
    expect(unit(sunk.state, "ann")).toMatchObject({ down: false, hp: 1 });
    expect(unit(sunk.state, "ann").lost).toBeUndefined();
    expect(hexDistance(unit(sunk.state, "ann").pos, sunk.state.start)).toBeLessThanOrEqual(1);
  });

  it("does not bother where there is no edge, where the drop is a short one, or if it is not the shoving kind", () => {
    const flat = backToTheDrop("bandit", 0);
    const short = backToTheDrop("bandit", 1);
    const wolf = backToTheDrop("wolf", 3);
    expect(ENEMY_KIT.wolf.shoves).toBeFalsy();
    for (let seed = 1; seed <= 10; seed++) {
      for (const made of [flat, short, wolf]) {
        const { events } = play(made.state, seed);
        expect(did(events, made.foe)).not.toContain("shove");
        expect(did(events, made.foe)).toContain("attack");
      }
    }
  });

  /** A hero alone on top of a block `levels` high with no way up it on foot (more of it behind her), and a bandit at its foot. AI on. */
  function onTheLedge(levels: number, withLadder = false) {
    const state = board(both(on(run(9, 11), { elev: levels }), withLadder ? ladder(at(8, 6), at(9, 6)) : () => {}));
    state.aiOff = false;
    const ann = hero(state, "ann", "qa_paladin", at(10, 6));
    ann.hp = ann.maxHp = 300;
    const foe = enemy(state, "bandit", at(8, 6), "g1", 200);
    return { state, foe: foe.id };
  }

  it("leaps a ledge two levels high to get a blow in, when there is none to be had on foot", () => {
    const { state, foe } = onTheLedge(2);
    for (let seed = 1; seed <= 8; seed++) {
      const { state: after, events } = play(state, seed);
      expect(did(events, foe), `seed ${seed}`).toEqual(["jump", "attack"]);
      const [leap] = got(events, "jumped");
      expect(leap).toMatchObject({ id: foe, from: at(8, 6) });
      expect(elevOf(after.map, leap.to)).toBe(2);
      expect(unit(after, foe).pos).toEqual(leap.to);
      expect(strikes(after.map, unit(after, foe).pos, unit(after, "ann").pos)).toBe(true);
      // The leap and the blow took all it had.
      expect(COMMON_ACTIONS.jump.cost + ACTION_AP).toBe(AP_TURN);
      expect(got(events, "moved").filter((e) => e.id === foe)).toEqual([]);
    }
  });

  it("cannot leap one three levels high: it stays below, with no blow to strike", () => {
    const { state, foe } = onTheLedge(3);
    const { state: after, events } = play(state, 1, 2);
    expect(did(events, foe)).toEqual([]);
    expect(elevOf(after.map, unit(after, foe).pos)).toBe(0);
    expect(unit(after, "ann").hp).toBe(300);
  });

  it("walks up a ladder as it would any way, and strikes from the top of it", () => {
    const { state, foe } = onTheLedge(3, true);
    const { state: after, events } = play(state, 1);
    expect(got(events, "jumped")).toEqual([]);
    expect(got(events, "moved").filter((e) => e.id === foe).flatMap((e) => e.path)).toEqual([at(9, 6)]);
    expect(did(events, foe)).toContain("attack");
    expect(elevOf(after.map, unit(after, foe).pos)).toBe(3);
  });
});

// ---------- a fight in the open rouses the place ----------

describe("a fight in the open rouses the place", () => {
  /** Ann and a bandit beside her at an open-air site; two more bands far off; and a Great Bear with its own, further still. */
  function place(edit: Edit = () => {}, gone: HexPos[] = [], site = "keep") {
    const state = board(edit, gone);
    state.scene = { site, backdrop: "mist" };
    hero(state, "ann", "qa_paladin", at(1, 6));
    const first = enemy(state, "bandit", at(2, 6), "g1", 200);
    const second = [enemy(state, "bandit", at(6, 3), "g2", 200), enemy(state, "archer", at(7, 3), "g2", 200)];
    const third = enemy(state, "bandit", at(14, 10), "g3", 200);
    const den = [enemy(state, "great_bear", at(14, 1), "g4", 200), enemy(state, "wolf", at(15, 1), "g4", 200)];
    return { state, first: first.id, second: second.map((u) => u.id), third: third.id, den: den.map((u) => u.id) };
  }

  it("every band that can get to the fight is in it from the first round, told as one crowd", () => {
    const made = place();
    const events: ZoneEvent[] = [];
    const state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    const roused = got(events, "roused");
    expect(roused).toHaveLength(1);
    expect([...roused[0].groups].sort()).toEqual(["g2", "g3"]);
    expect([...roused[0].units].sort()).toEqual([...made.second, made.third].sort());
    expect([...state.encounter!.order].sort()).toEqual(["ann", made.first, ...made.second, made.third].sort());
    expect(state.groups).toMatchObject({ g1: { alerted: true }, g2: { alerted: true }, g3: { alerted: true } });
    // Each rolled for their place; none is announced one by one, and nothing was "heard".
    expect(rolls(events, "Initiative").map((r) => r.id).sort()).toEqual(["ann", made.first, ...made.second, made.third].sort());
    expect(got(events, "fight_join")).toEqual([]);
    expect(got(events, "noise")).toEqual([]);
    expect(state.encounter!.round).toBe(1);
  });

  it("whoever stands in the way does not make it no way: a band comes though the one gap between it and the fight is held, by a hero or by its own", () => {
    // A wall of rock right across the board along column 10, with one gap in it; the third band is beyond it.
    const wall = on(Array.from({ length: GRID.rows }, (_, row) => at(10, row)).filter((p) => p.r !== 6), { biome: "rock" });
    const west = (reach: Map<string, unknown>) => [...reach.keys()].some((key) => Number(key.split(",")[0]) + Math.floor(Number(key.split(",")[1]) / 2) < 10);
    for (const holder of ["hero", "enemy"] as const) {
      const made = place(wall);
      made.state.units = made.state.units.filter((u) => !made.den.includes(u.id));
      if (holder === "hero") hero(made.state, "bo", "qa_paladin", at(10, 6));
      else for (let i = 0; i < HEX_ROOM; i++) enemy(made.state, "dummy", at(10, 6), "g5");
      const third = unit(made.state, made.third);
      // As things stand a hero in the gap leaves it nowhere to walk to on the fight's side of the wall; its own would let it through.
      expect(west(zoneReach(made.state, third, 400)), holder).toBe(holder === "enemy");
      expect(west(zoneReach({ ...made.state, units: [] }, third, 400)), holder).toBe(true);
      const events: ZoneEvent[] = [];
      const state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      expect(got(events, "roused").flatMap((e) => e.groups), holder).toContain("g3");
      expect(state.encounter!.order, holder).toContain(made.third);
      expect(state.groups.g3.alerted, holder).toBe(true);
    }
    // With no gap at all, it is the ground that says no, and it stays.
    const shut = place(on(Array.from({ length: GRID.rows }, (_, row) => at(10, row)), { biome: "rock" }));
    shut.state.units = shut.state.units.filter((u) => !shut.den.includes(u.id));
    const stayed = must(shut.state, { type: "dev", by: "ann", dev: { op: "start_fight" } });
    expect(stayed.encounter!.order).not.toContain(shut.third);
    expect(stayed.groups.g3.alerted).toBe(false);
  });

  it("a band with a boss in it keeps its den, until the fight is near enough to hear", () => {
    const made = place();
    let state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } });
    while (state.encounter!.round < 4) state = must(state, { type: "timeout" });
    for (const id of made.den) expect(state.encounter!.order).not.toContain(id);
    expect(state.groups.g4.alerted).toBe(false);
    // Someone in the fight comes within earshot of the den: at the next round they are in it.
    unit(state, made.third).pos = at(14 - HEAR_RANGE, 1);
    const round = state.encounter!.round;
    const events: ZoneEvent[] = [];
    while (state.encounter!.round === round) state = must(state, { type: "timeout" }, events);
    expect(events).toContainEqual({ t: "noise", group: "g4" });
    for (const id of made.den) expect(state.encounter!.order).toContain(id);
  });

  it("a band with no way to the fight stays where it is, and comes once there is one", () => {
    // The third band stands on ground cut off from the rest by a gap two hexes wide.
    const cut = [...Array.from({ length: 12 }, (_, row) => at(11, row)), ...Array.from({ length: 12 }, (_, row) => at(12, row))];
    const made = place(undefined, cut);
    unit(made.state, made.den[0]).hp = 0;
    made.state.units = made.state.units.filter((u) => !made.den.includes(u.id));
    const events: ZoneEvent[] = [];
    let state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    expect(got(events, "roused").map((e) => e.groups)).toEqual([["g2"]]);
    expect(state.encounter!.order).not.toContain(made.third);
    while (state.encounter!.round < 3) state = must(state, { type: "timeout" }, events);
    expect(state.groups.g3.alerted).toBe(false);
    // A bridge is laid over the gap: at the next round they come.
    for (const col of [11, 12]) state.map.tiles.push({ q: at(col, 10).q, r: at(col, 10).r, biome: "plains" as Biome, h: 0.3, elev: 0 });
    const round = state.encounter!.round;
    const after: ZoneEvent[] = [];
    while (state.encounter!.round === round) state = must(state, { type: "timeout" }, after);
    expect(got(after, "roused").map((e) => e.groups)).toEqual([["g3"]]);
    expect(state.encounter!.order).toContain(made.third);
  });

  it("with no site (a cave, a sea cave) nothing is roused: only those near enough to hear come", () => {
    const made = place();
    delete made.state.scene;
    const events: ZoneEvent[] = [];
    const state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    expect(got(events, "roused")).toEqual([]);
    expect([...state.encounter!.order].sort()).toEqual(["ann", made.first].sort());
  });

  it("under a roof or under ground (a citadel, a crypt, a cavern, a hollow) nothing is roused either: walls keep the noise in, and only those near enough to hear come", () => {
    for (const site of SITE_IDS.filter(siteInside)) {
      const made = place(undefined, [], site);
      made.state.scene = { site, backdrop: "dark" };
      const events: ZoneEvent[] = [];
      let state = must(made.state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      // The one band met, and nobody else: not the two bands with a clear way to the fight, which the open air would have brought.
      expect(got(events, "roused"), site).toEqual([]);
      expect(got(events, "alert"), site).toEqual([{ t: "alert", group: "g1", by: "ann" }]);
      expect([...state.encounter!.order].sort(), site).toEqual(["ann", made.first].sort());
      expect(state.groups, site).toMatchObject({ g1: { alerted: true }, g2: { alerted: false }, g3: { alerted: false }, g4: { alerted: false } });
      // Nor at any later round, while they are out of earshot.
      while (state.encounter!.round < 4) state = must(state, { type: "timeout" }, events);
      expect(got(events, "roused"), site).toEqual([]);
      expect(got(events, "noise"), site).toEqual([]);
      expect(state.groups, site).toMatchObject({ g2: { alerted: false }, g3: { alerted: false }, g4: { alerted: false } });
      // Someone in the fight comes within earshot of the second band: at the next round it is in it, heard and not roused, and still alone.
      unit(state, made.first).pos = at(6 - HEAR_RANGE, 3);
      const round = state.encounter!.round;
      const after: ZoneEvent[] = [];
      while (state.encounter!.round === round) state = must(state, { type: "timeout" }, after);
      expect(after, site).toContainEqual({ t: "noise", group: "g2" });
      expect(got(after, "roused"), site).toEqual([]);
      for (const id of made.second) expect(state.encounter!.order, site).toContain(id);
      expect(state.groups, site).toMatchObject({ g2: { alerted: true }, g3: { alerted: false }, g4: { alerted: false } });
    }
  });

  it("only a place out under the sky is roused: a scene that is no site at all is not", () => {
    for (const site of SITE_IDS.filter(siteOpen)) {
      const events: ZoneEvent[] = [];
      must(place(undefined, [], site).state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      expect(got(events, "roused").map((e) => [...e.groups].sort()), site).toEqual([["g2", "g3"]]);
    }
    const events: ZoneEvent[] = [];
    must(place(undefined, [], "nowhere").state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
    expect(got(events, "roused")).toEqual([]);
  });
});
