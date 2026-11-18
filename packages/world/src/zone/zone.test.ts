import { describe, expect, it } from "vitest";
import { STARTING_STATS, allHexesInGrid, hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ABILITIES, EFFECT_TICK, ENEMIES, WEAPONS, abilitiesFor } from "../content";
import type { Biome, Tile } from "../map";
import { makeRng } from "../rng";
import { walk } from "./combat";
import { attackContext, damage, type Ctx } from "./engine";
import { ALERT_RANGE, DEFAULT_ZONE_OPTIONS, JOIN_RANGE, generateZone, zoneOptions } from "./gen";
import { adjacent, blast, flies, sees, solid, unitAt, zoneReach } from "./geometry";
import { AURAS, BOLSTER, ENEMY_BURST, SHIELD_WALL, ENEMY_KIT, EXPLORE_ROUND_MS, FLEE_RANGE, LIGHT_RADIUS, SHIELD_SET_ASIDE, TACTICS, TORCH_GROUND_ROUNDS, TORCH_HELD_ROUNDS, TORCH_ROUND_MS, commonCost, enemyHp, enemyStrikes, tacticOf } from "./kit";
import { MAX_CATCHUP_ROUNDS } from "./clock";
import { defenceOf } from "./engine";
import { abilityArea, checkAbility, crateBlow, enemyAct, wayBetween } from "./combat";
import { d20, diceAverage, diceFor, heroMove, hitChance } from "./rules";
import { createZone, ensureMouth, standInHero, stepZone, zoneView } from "./zone";
import { DELVE_CRATES, generateDelve } from "./delve";
import { litHexes } from "./light";
import { poolFor } from "../classabilities";
import { CHEST_PAY, unopened } from "./loot";
import { CRATE_HP, CRATE_PAY } from "./crates";
import { NOISE_RANGE } from "./doors";
import { GLOWCAP_MUSHROOMS } from "./forage";
import { DELVE_GLOWCAPS as GLOWCAP_COUNT } from "./delve";
import type { SurfaceKind, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

// ---------- helpers ----------

const GRID: HexGrid = { cols: 16, rows: 12 };
/** Offset coordinates (column, row) to a hex, so tests can talk about a flat board. */
const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });

/** A flat, open board with nothing on it. */
function board(edit: (tile: Tile) => void = () => {}): ZoneState {
  const tiles: Tile[] = allHexesInGrid(GRID).map((p) => ({ q: p.q, r: p.r, biome: "plains" as Biome, h: 0.3, elev: 0 }));
  tiles.forEach(edit);
  return { v: 1, code: "TEST", seed: "test", rng: 12345, options: { ...DEFAULT_ZONE_OPTIONS, party: 1 }, map: { grid: GRID, tiles, pois: [] }, start: at(2, 6), units: [], groups: {}, surfaces: {}, encounter: null, seq: 100 };
}
const tileEdit = (pos: HexPos, change: Partial<Tile>) => (t: Tile) => { if (t.q === pos.q && t.r === pos.r) Object.assign(t, change); };

function hero(state: ZoneState, id: string, classId: string, pos: HexPos): Unit {
  const sheet = standInHero(classId, id, 1)!;
  const unit: Unit = {
    id, side: "hero", name: id, kind: classId, level: 1, pos, hp: sheet.maxHp, maxHp: sheet.maxHp, focus: 2, maxFocus: 2,
    stats: STARTING_STATS[classId], armor: 2, power: 1, abilities: classId === "refactor_rogue" ? ["aimed_shot", "quick_stab"] : classId === "devops_mage" ? ["firebolt", "mend"] : ["smite", "shield_wall"],
    conditions: [], down: false, cooldowns: {}, items: { healing: 2, poison: 2, fire: 1, oil: 1, water: 1 },
  };
  state.units.push(unit);
  return unit;
}

function enemy(state: ZoneState, kind: string, pos: HexPos, group = "g1"): Unit {
  state.groups[group] ??= { alerted: false };
  const unit: Unit = { id: `e${++state.seq}`, side: "enemy", name: ENEMIES[kind].name, kind, level: 1, pos, hp: ENEMIES[kind].hp, maxHp: ENEMIES[kind].hp, focus: 0, maxFocus: 0, armor: 0, power: 0, abilities: [], conditions: [], down: false, cooldowns: {}, items: {}, group, home: pos };
  state.units.push(unit);
  return unit;
}

/** Apply an action that must succeed; events are added to `sink`. */
function must(state: ZoneState, action: ZoneAction, sink: ZoneEvent[] = []): ZoneState {
  const step = stepZone(state, action);
  if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
  sink.push(...step.events);
  return step.state;
}
const fails = (state: ZoneState, action: ZoneAction): string => {
  const step = stepZone(state, action);
  if (step.ok) throw new Error(`${action.type} should have failed`);
  return step.error;
};
const unit = (state: ZoneState, id: string) => state.units.find((u) => u.id === id)!;
const zoneBlastCount = (state: ZoneState, pos: HexPos) => blast(state.map, pos, 1).length;
const paint = (state: ZoneState, kind: SurfaceKind | null, hexes: HexPos[]) => must(state, { type: "dev", by: "dev", dev: { op: "paint", kind, hexes } });
/** Set the nearest group on a hero where they stand, without anyone having to walk up to anyone. */
const provoke = (state: ZoneState, by = "ann", sink: ZoneEvent[] = []) => must(state, { type: "dev", by, dev: { op: "start_fight" } }, sink);
/** Put a hero in a fight with one enemy, with the enemy AI off, and it is the hero's turn. */
function duel(kind = "bandit", classId = "qa_paladin", heroAt = at(5, 6), enemyAt = at(8, 6)) {
  let state = board();
  state.aiOff = true;
  hero(state, "ann", classId, heroAt);
  const foe = enemy(state, kind, enemyAt);
  // A step toward it, and the fight is on (by walking up to it, if that step did; set on them, if not).
  state = must(state, { type: "move", by: "ann", unit: "ann", to: { q: heroAt.q + 1, r: heroAt.r } });
  if (!state.encounter) state = provoke(state);
  // The enemy's turn (if it won initiative) passes with the AI off.
  expect(state.encounter?.acting).toEqual(["ann"]);
  return { state, foe: foe.id };
}

// ---------- the dice ----------

describe("dice", () => {
  it("turns an old damage number into dice that average about the same", () => {
    for (const amount of [2, 4, 5, 6, 7, 9, 12, 13]) expect(Math.abs(diceAverage(diceFor(amount)) - amount)).toBeLessThanOrEqual(0.75);
  });

  it("keeps the better of two with advantage and the worse with disadvantage", () => {
    for (let seed = 1; seed < 40; seed++) {
      const up = d20(makeRng(seed), { kind: "attack", id: "a", label: "", bonus: 0, vs: 10, adv: 1 });
      const down = d20(makeRng(seed), { kind: "attack", id: "a", label: "", bonus: 0, vs: 10, adv: -1 });
      expect(up.kept).toBe(Math.max(...up.d20));
      expect(down.kept).toBe(Math.min(...down.d20));
      expect(up.d20).toEqual(down.d20);
    }
  });

  it("always hits on a natural 20 and never on a natural 1", () => {
    expect(hitChance(-10, 30, 0)).toBeCloseTo(0.05);
    expect(hitChance(30, 5, 0)).toBeCloseTo(0.95);
    expect(hitChance(5, 15, 1)).toBeGreaterThan(hitChance(5, 15, 0));
    expect(hitChance(5, 15, -1)).toBeLessThan(hitChance(5, 15, 0));
  });

  it("gives a hero 4 to 8 steps a turn by Agility", () => {
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 1 })).toBe(4);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 5 })).toBe(5);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 30 })).toBe(8);
  });
});

// ---------- the kit ----------

describe("the kit", () => {
  it("has a tactical entry for every ability", () => {
    for (const id of Object.keys(ABILITIES)) expect(TACTICS[id], id).toBeDefined();
    for (const id of Object.keys(TACTICS)) expect(ABILITIES[id], id).toBeDefined();
  });

  it("has an entry for every enemy, naming only attacks that enemy has", () => {
    for (const kind of Object.keys(ENEMIES)) {
      expect(ENEMY_KIT[kind], kind).toBeDefined();
      for (const name of Object.keys(ENEMY_KIT[kind].attacks ?? {})) expect(ENEMIES[kind].attacks.some((a) => a.name === name), `${kind}: ${name}`).toBe(true);
      expect(enemyStrikes(kind, 1).length).toBe(ENEMIES[kind].attacks.length);
    }
  });

  it("gives melee abilities a reach of one hex and everything else a range", () => {
    for (const [id, t] of Object.entries(TACTICS)) {
      if (t.reach === "melee") expect(t.range, id).toBe(1);
      else if (t.shape !== "self" && t.shape !== "burst") expect(t.range, id).toBeGreaterThan(1);
    }
  });
});

// ---------- generation ----------

describe("zone generation", () => {
  it("makes the same map from the same seed and options", () => {
    const a = generateZone("seed-1", DEFAULT_ZONE_OPTIONS);
    const b = generateZone("seed-1", DEFAULT_ZONE_OPTIONS);
    expect(a).toEqual(b);
    expect(generateZone("seed-2", DEFAULT_ZONE_OPTIONS)).not.toEqual(a);
  });

  it("keeps the start clear, puts every group out of sight of it, and leaves a way to each", () => {
    for (const biome of ["meadow", "woods", "caves", "shore"] as const) {
      for (const size of ["small", "medium", "large"] as const) {
        for (let seed = 0; seed < 6; seed++) {
          const options = zoneOptions({ size, biome, groups: 3, elevation: 3, obstacles: 3, clear: 4, party: 2 });
          const state = createZone("GEN", `${biome}-${size}-${seed}`, options);
          const where = `${biome} ${size} ${seed}`;
          const foes = state.units.filter((u) => u.side === "enemy");
          expect(foes.length, where).toBeGreaterThan(0);
          for (const f of foes) expect(hexDistance(f.pos, state.start), where).toBeGreaterThan(options.clear + ALERT_RANGE);
          // No two on one hex, and nobody in rock or water.
          expect(new Set(foes.map((f) => posKey(f.pos))).size, where).toBe(foes.length);
          // Open, level ground all round the start (the map's own edge aside).
          for (const t of state.map.tiles) if (hexDistance(t, state.start) <= options.clear && hexNeighbors(t, state.map.grid).length === 6) expect(solid(t) || (t.elev ?? 0) !== 0, where).toBe(false);
          // A hero standing at the start can walk to a hex beside every enemy.
          const walker = hero(state, "ann", "qa_paladin", state.start);
          for (const f of foes) {
            // The ground itself has to allow it: the enemy's own friends standing in the way do not count.
            const alone = { ...state, units: [walker, f] };
            expect([...zoneReach(alone, walker, 400).values()].some((r) => adjacent(r.pos, f.pos)), `${where}: ${f.kind} cut off`).toBe(true);
          }
        }
      }
    }
  });

  it("makes options safe", () => {
    expect(zoneOptions({ size: "huge", groups: 99, kinds: ["wolf", "dragon"], clear: -3 })).toEqual({ ...DEFAULT_ZONE_OPTIONS, groups: 6, kinds: ["wolf"], clear: 2 });
    expect(zoneOptions(null)).toEqual(DEFAULT_ZONE_OPTIONS);
  });
});

// ---------- walking, and walking into a fight ----------

describe("free walking", () => {
  it("lets a hero walk anywhere with no fight on, and takes no turns", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(2, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(12, 3) }, events);
    expect(unit(state, "ann").pos).toEqual(at(12, 3));
    expect(state.encounter).toBeNull();
    expect(events.filter((e) => e.t === "moved")).toHaveLength(1);
  });

  it("refuses rock, water, cliffs and somebody else's hero", () => {
    let state = board((t) => { tileEdit(at(4, 6), { biome: "rock" })(t); tileEdit(at(2, 3), { elev: 2 })(t); });
    hero(state, "ann", "qa_paladin", at(2, 6));
    hero(state, "bo", "qa_paladin", at(2, 7));
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(4, 6) })).toMatch(/cannot get there/);
    // A lone hex two levels up is a cliff on every side.
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(2, 3) })).toMatch(/cannot get there/);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(2, 7) })).toMatch(/standing there/);
    expect(fails(state, { type: "move", by: "ann", unit: "bo", to: at(3, 7) })).toMatch(/not yours/);
  });
});

describe("starting a fight", () => {
  it("starts when a hero runs right up to an enemy, and not before", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(1, 6));
    const wolf = enemy(state, "wolf", at(10, 6));
    const mate = enemy(state, "wolf", at(11, 6));
    // Two hexes off, in plain sight: nothing.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) });
    expect(state.encounter).toBeNull();
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }, events);
    expect(hexDistance(unit(state, "ann").pos, wolf.pos)).toBe(ALERT_RANGE);
    expect(state.encounter).not.toBeNull();
    expect(new Set(state.encounter!.order)).toEqual(new Set(["ann", wolf.id, mate.id]));
    expect(state.groups.g1.alerted).toBe(true);
    expect(events.some((e) => e.t === "fight_start")).toBe(true);
    expect(events.filter((e) => e.t === "roll" && e.roll.kind === "initiative")).toHaveLength(3);
  });

  it("stops a hero who walks past an enemy on the first hex beside it", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const wolf = enemy(state, "wolf", at(7, 5));
    // The straight way to the far side runs right under its nose.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(12, 6) });
    expect(state.encounter).not.toBeNull();
    expect(hexDistance(unit(state, "ann").pos, wolf.pos)).toBe(1);
    expect(unit(state, "ann").pos).not.toEqual(at(12, 6));
  });

  it("leaves a hero far away free to walk, and pulls them in when they come near", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(5, 2));
    hero(state, "bo", "qa_paladin", at(1, 10));
    enemy(state, "wolf", at(7, 2));
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 2) });
    expect(state.encounter!.order).not.toContain("bo");
    // Bo is in no fight: no turn to wait for, and the walk costs nothing.
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(1, 8) });
    expect(unit(state, "bo").pos).toEqual(at(1, 8));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(6, 3) }, events);
    expect(state.encounter!.order).toContain("bo");
    expect(events.some((e) => e.t === "fight_join" && e.id === "bo")).toBe(true);
    // Stopped where they came into range, short of where they were going.
    expect(Math.min(...state.units.filter((u) => u.id !== "bo" && state.encounter!.order.includes(u.id)).map((u) => hexDistance(u.pos, unit(state, "bo").pos)))).toBe(JOIN_RANGE);
  });

  it("pulls a second group in when a fighter comes within its sight", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "refactor_rogue", at(4, 2));
    enemy(state, "wolf", at(6, 2), "g1");
    const far = enemy(state, "bandit", at(4, 4), "g2");
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 2) });
    expect(state.encounter!.order).not.toContain(far.id);
    while (state.encounter!.acting[0] !== "ann") state = must(state, { type: "timeout" });
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(4, 3) });
    expect(state.groups.g2.alerted).toBe(true);
    expect(state.encounter!.order).toContain(far.id);
  });
});

// ---------- turns ----------

describe("turns", () => {
  it("gives heroes next to each other in the order one shared turn", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "qa_paladin", at(5, 7));
    enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }));
    const enc = state.encounter!;
    const a = enc.order.indexOf("ann");
    const b = enc.order.indexOf("bo");
    if (Math.abs(a - b) === 1) {
      while (state.encounter!.acting.length !== 2) state = must(state, { type: "timeout" });
      expect(new Set(state.encounter!.acting)).toEqual(new Set(["ann", "bo"]));
      // Either can go first, and the turn passes only when both have ended theirs.
      state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
      expect(state.encounter!.acting).toContain("ann");
      expect(fails(state, { type: "end_turn", by: "bo", unit: "bo" })).toMatch(/not your turn/);
      const turn = state.encounter!.turnNo;
      state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
      expect(state.encounter!.turnNo).toBeGreaterThan(turn);
    } else {
      // The dummy rolled between them: each has a turn alone.
      expect(state.encounter!.acting.length).toBe(1);
    }
  });

  it("spends an Action, a Bonus action and movement, and refuses a second of each", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(8, 6));
    const budget = () => state.encounter!.budgets.ann;
    expect(budget()).toMatchObject({ action: true, bonus: true });
    const move = budget().move;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(budget().move).toBe(move - 1);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: foe });
    expect(budget().action).toBe(false);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: foe })).toMatch(/used your Action/);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "shield_wall" });
    expect(budget().bonus).toBe(false);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "guarded")).toBe(true);
    expect(fails(state, { type: "drink", by: "ann", unit: "ann", item: "healing" })).toMatch(/Bonus action/);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(1, 1) })).toMatch(/movement/);
  });

  it("charges 2 for forest, 1 more to climb, and Dash doubles what is left to spend", () => {
    let state = board((t) => { tileEdit(at(7, 6), { biome: "forest" })(t); tileEdit(at(6, 5), { elev: 1 })(t); });
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(5, 6));
    enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }));
    const budget = () => state.encounter!.budgets.ann;
    const max = budget().moveMax;
    expect(budget().move).toBe(max);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(budget().move).toBe(max - 2);
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "dash" });
    expect(budget().move).toBe(max - 2 + max);
    const before = budget().move;
    const up = at(6, 5);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: up });
    // One step, onto open ground a level up: 1 + 1.
    expect(before - budget().move).toBe(2);
  });

  it("ends the turn when its timer runs out", () => {
    let { state } = duel("dummy");
    const turn = state.encounter!.turnNo;
    state = must(state, { type: "timeout" });
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
  });
});

// ---------- attacks ----------

describe("attacks", () => {
  it("needs a melee target adjacent, and a ranged one in range with a clear line", () => {
    let state = board((t) => tileEdit(at(7, 6), { biome: "rock" })(t));
    state.aiOff = true;
    hero(state, "ann", "refactor_rogue", at(4, 6));
    const foe = enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }));
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "quick_stab", target: foe.id })).toMatch(/next to it/);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "aimed_shot", target: foe.id })).toMatch(/clear line/);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 5) });
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "aimed_shot", target: foe.id }, events);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll).toBeDefined();
    expect(events.some((e) => e.t === "hit" || e.t === "miss")).toBe(true);
  });

  it("gives advantage and disadvantage for the reasons it says, and they cancel", () => {
    const state = board((t) => { tileEdit(at(5, 5), { elev: 1 })(t); tileEdit(at(9, 5), { biome: "forest" })(t); });
    const ann = hero(state, "ann", "refactor_rogue", at(5, 6));
    const foe = enemy(state, "bandit", at(9, 6));
    const far = { melee: false };
    expect(attackContext(state, ann, foe, far)).toMatchObject({ adv: 0, mods: 0 });
    foe.conditions = [{ kind: "exposed", rounds: 2 }];
    expect(attackContext(state, ann, foe, far).adv).toBe(1);
    ann.conditions = [{ kind: "poisoned", rounds: 2 }];
    expect(attackContext(state, ann, foe, far).adv).toBe(0);
    foe.conditions = [];
    expect(attackContext(state, ann, foe, far).adv).toBe(-1);
    ann.conditions = [];
    // Focus is advantage; so is a Prone target, but only up close.
    expect(attackContext(state, ann, foe, { melee: false, focus: true }).adv).toBe(1);
    foe.conditions = [{ kind: "prone", rounds: 1 }];
    expect(attackContext(state, ann, foe, { melee: true }).adv).toBe(1);
    expect(attackContext(state, ann, foe, far).adv).toBe(-1);
    foe.conditions = [];
    // High ground, and a target among trees.
    expect(attackContext(state, { ...ann, pos: at(5, 5) }, foe, far).mods).toBe(2);
    expect(attackContext(state, ann, { ...foe, pos: at(9, 5) }, far).mods).toBe(-2);
    expect(attackContext(state, ann, { ...foe, pos: at(9, 5) }, { melee: true }).mods).toBe(0);
  });

  it("makes shooting with an enemy beside you harder", () => {
    const { state, foe } = duel("dummy", "refactor_rogue", at(5, 6), at(8, 6));
    const ann = unit(state, "ann");
    expect(attackContext(state, ann, unit(state, foe), { melee: false }).adv).toBe(0);
    expect(attackContext(state, { ...ann, pos: at(7, 6) }, unit(state, foe), { melee: false }).adv).toBe(-1);
  });

  it("puts an ability with a cooldown out of use for that many turns", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(6, 6), at(8, 6));
    unit(state, "ann").abilities = ["cleave"];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "cleave" });
    const wait = tacticOf("cleave").cooldown!;
    for (let turn = 0; turn < wait; turn++) {
      state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
      expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "cleave" }), `turn ${turn}`).toMatch(/not ready/);
    }
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    must(state, { type: "use", by: "ann", unit: "ann", ability: "cleave" });
    expect(foe).toBeDefined();
  });

  it("spends Focus for advantage", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(6, 6), at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: foe, focus: true }, events);
    expect(unit(state, "ann").focus).toBe(1);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll && roll.t === "roll" && roll.roll.adv).toBe(1);
  });
});

describe("opportunity attacks", () => {
  it("strikes a hero who walks out of an enemy's reach, once a round, and not one who disengaged", () => {
    let { state, foe } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, events);
    expect(events.some((e) => e.t === "reaction" && e.id === foe && e.target === "ann")).toBe(true);
    expect(state.encounter!.reacted).toContain(foe);
    // Back in and out again in the same round: its reaction is spent.
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    const again: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, again);
    expect(again.some((e) => e.t === "reaction")).toBe(false);
  });

  it("lets a hero who disengaged walk away untouched, and does not strike for moving around within reach", () => {
    let { state } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const round: ZoneEvent[] = [];
    // From one hex beside it to another beside it.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 5) }, round);
    expect(round.some((e) => e.t === "reaction")).toBe(false);
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "disengage" });
    const away: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 4) }, away);
    expect(away.some((e) => e.t === "reaction")).toBe(false);
  });

  it("lets a hero strike an enemy that walks away from them", () => {
    const { state, foe } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const bandit = unit(state, foe);
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state, rng: makeRng(7), events, effects: [] };
    walk(ctx, bandit, [at(9, 6), at(10, 6)], { action: true, bonus: true, move: 5, moveMax: 5, disengaged: false });
    expect(events.some((e) => e.t === "reaction" && e.id === "ann" && e.target === foe)).toBe(true);
    expect(events.some((e) => e.t === "roll" && e.roll.id === "ann" && e.roll.kind === "attack")).toBe(true);
    expect(state.encounter!.reacted).toContain("ann");
  });
});

// ---------- the ground ----------

describe("surfaces", () => {
  it("hurts and poisons whoever walks into poison, and wears off after its rounds", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(8, 6));
    state = paint(state, "poison", [at(6, 6)]);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, events);
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(events.some((e) => e.t === "tick" && e.kind === "poison")).toBe(true);
    const rounds = state.surfaces[posKey(at(6, 6))].rounds;
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + rounds) state = must(state, { type: "timeout" });
    expect(state.surfaces[posKey(at(6, 6))]).toBeUndefined();
  });

  it("runs fire through every joined hex of oil", () => {
    let state = board();
    state = paint(state, "oil", [at(5, 6), at(6, 6), at(7, 6), at(10, 2)]);
    state = paint(state, "fire", [at(5, 6)]);
    for (const p of [at(5, 6), at(6, 6), at(7, 6)]) expect(state.surfaces[posKey(p)].kind).toBe("fire");
    expect(state.surfaces[posKey(at(10, 2))].kind).toBe("oil");
  });

  it("sets poison off as a burst that hurts whoever stands in it", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(6, 6));
    state = paint(state, "poison", [at(6, 6), at(7, 6)]);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "dev", by: "dev", dev: { op: "paint", kind: "fire", hexes: [at(7, 6)] } }, events);
    expect(events.some((e) => e.t === "burst")).toBe(true);
    expect(state.surfaces[posKey(at(6, 6))].kind).toBe("fire");
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(ann.id).toBe("ann");
  });

  it("puts fire out with water, freezes water, and melts ice", () => {
    let state = board();
    state = paint(state, "fire", [at(5, 6)]);
    state = paint(state, "water", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))]).toBeUndefined();
    state = paint(state, "water", [at(5, 6)]);
    state = paint(state, "ice", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))].kind).toBe("ice");
    state = paint(state, "fire", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))].kind).toBe("water");
  });

  it("makes oil cost a step more, and soaks whoever crosses water so they cannot burn", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(9, 6));
    state = paint(state, "oil", [at(6, 6)]);
    state = paint(state, "water", [at(7, 6)]);
    state = paint(state, "fire", [at(8, 5)]);
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter!.budgets.ann.move).toBe(10 - 2);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "wet")).toBe(true);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 5) });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "burning")).toBe(false);
  });

  it("makes slime cost a step more and slow whoever walks in; fire burns it off and water washes it away", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(9, 6));
    state = paint(state, "slime", [at(6, 6)]);
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    // A step onto it costs two, and the slowing halves what is left.
    expect(state.encounter!.budgets.ann.move).toBe(Math.floor((10 - 2) / 2));
    expect(unit(state, "ann").conditions.some((c) => c.kind === "slowed")).toBe(true);
    let ground = board();
    ground = paint(ground, "slime", [at(5, 6), at(6, 6)]);
    ground = paint(ground, "fire", [at(5, 6)]);
    expect(ground.surfaces[posKey(at(5, 6))]).toMatchObject({ kind: "fire", rounds: 1 });
    // Fire does not run along slime as it does along oil.
    expect(ground.surfaces[posKey(at(6, 6))].kind).toBe("slime");
    ground = paint(ground, "water", [at(6, 6)]);
    expect(ground.surfaces[posKey(at(6, 6))]).toBeUndefined();
    // Slime thrown on a fire smothers it.
    ground = paint(ground, "fire", [at(8, 6)]);
    ground = paint(ground, "slime", [at(8, 6)]);
    expect(ground.surfaces[posKey(at(8, 6))]).toBeUndefined();
  });

  it("leaves those an acid flask splashes Exposed unless they dodge, and lays a slick where a slime flask lands", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6)).items = { acid: 1, slime: 1 };
    const foes = [enemy(state, "dummy", at(8, 6)), enemy(state, "dummy", at(9, 6)), enemy(state, "dummy", at(8, 7))];
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "acid", at: foes[0].pos }, events);
    expect(unit(state, "ann").items.acid ?? 0).toBe(0);
    for (const f of foes) {
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === f.id);
      expect(save).toBeDefined();
      const exposed = unit(state, f.id).conditions.some((c) => c.kind === "exposed");
      expect(exposed).toBe(save!.t === "roll" && !save!.roll.ok);
    }
    expect(events.some((e) => e.t === "hit" && e.what === "throw:acid")).toBe(true);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "slime", at: at(6, 3) });
    expect(state.surfaces[posKey(at(6, 3))]).toMatchObject({ kind: "slime", rounds: 3 });
  });

  it("lays poison where a flask lands, and starts the fight if it lands on a group", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const wolf = enemy(state, "wolf", at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "poison", at: wolf.pos }, events);
    expect(state.surfaces[posKey(wolf.pos)].kind).toBe("poison");
    expect(Object.keys(state.surfaces)).toHaveLength(7);
    expect(unit(state, "ann").items.poison).toBe(1);
    expect(unit(state, wolf.id).conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(state.encounter).not.toBeNull();
    // Laid on open ground with nobody near, it starts nothing.
    let quiet = board();
    hero(quiet, "ann", "qa_paladin", at(3, 6));
    enemy(quiet, "wolf", at(14, 6));
    quiet = must(quiet, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(6, 6) });
    expect(quiet.encounter).toBeNull();
    expect(fails(quiet, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(15, 2) })).toMatch(/Too far/);
  });
});

describe("light and the dark", () => {
  /** A cave board: dark but where a torch or a fire lights it. */
  const cave = () => {
    const state = board();
    state.options = { ...state.options, biome: "caves" };
    return state;
  };

  it("lights a torch from the pack to hold, for a Bonus action in a fight, and not a second while one burns", () => {
    let { state } = duel("dummy");
    state.options = { ...state.options, biome: "caves" };
    unit(state, "ann").items.torch = 2;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "light", by: "ann", unit: "ann" }, events);
    expect(unit(state, "ann")).toMatchObject({ torch: TORCH_HELD_ROUNDS, items: { torch: 1 } });
    expect(state.encounter!.budgets.ann.bonus).toBe(false);
    expect(events).toContainEqual({ t: "lit", id: "ann" });
    expect(fails(state, { type: "light", by: "ann", unit: "ann" })).toMatch(/already/);
  });

  it("hides an enemy in the dark from the party, and shows it once a torch or a hero is near", () => {
    let state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items.torch = 1;
    const wolf = enemy(state, "wolf", at(9, 6));
    expect(zoneView(state, "ann").units.map((u) => u.id)).toEqual(["ann"]);
    state = must(state, { type: "light", by: "ann", unit: "ann" });
    expect(zoneView(state, "ann").units.map((u) => u.id)).toEqual(["ann"]);
    // Walked up within the torch's reach, it is seen.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9 - LIGHT_RADIUS, 6) });
    expect(zoneView(state, "ann").units.map((u) => u.id)).toContain(wolf.id);
    // Out of the caves nothing is hidden.
    const open = board();
    hero(open, "ann", "qa_paladin", at(3, 6));
    enemy(open, "wolf", at(14, 6));
    expect(zoneView(open, "ann").units).toHaveLength(2);
  });

  it("will not pick out an enemy in the dark, and strikes blind at one beside you that is unlit", () => {
    let state = cave();
    state.aiOff = true;
    const ann = hero(state, "ann", "refactor_rogue", at(3, 6));
    const far = enemy(state, "dummy", at(6, 6));
    expect(checkAbility(state, ann, "aimed_shot", { target: far.id })).toMatch(/too dark/);
    const near = enemy(state, "dummy", at(4, 6), "g2");
    expect(attackContext(state, ann, near, { melee: true }).notes).toContain("Disadvantage: the target is in the dark");
    ann.torch = 5;
    expect(checkAbility(state, ann, "aimed_shot", { target: far.id })).toBeNull();
    expect(attackContext(state, ann, near, { melee: true }).notes).not.toContain("Disadvantage: the target is in the dark");
    // The enemy sees in the dark.
    ann.torch = undefined;
    expect(attackContext(state, near, ann, { melee: true }).notes.some((n) => n.includes("dark"))).toBe(false);
    expect(state.units).toHaveLength(3);
  });

  it("throws a torch down to burn where it lands, setting oil alight, and it burns out round by round", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(12, 2));
    state.options = { ...state.options, biome: "caves" };
    unit(state, "ann").items.torch = 1;
    state = paint(state, "oil", [at(7, 6), at(8, 6)]);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(7, 6) }, events);
    expect(unit(state, "ann").items.torch ?? 0).toBe(0);
    expect(state.lights?.[posKey(at(7, 6))]).toMatchObject({ rounds: TORCH_GROUND_ROUNDS });
    for (const p of [at(7, 6), at(8, 6)]) expect(state.surfaces[posKey(p)].kind).toBe("fire");
    expect(events).toContainEqual({ t: "light", at: at(7, 6), on: true });
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + TORCH_GROUND_ROUNDS) state = must(state, { type: "timeout" });
    expect(state.lights?.[posKey(at(7, 6))]).toBeUndefined();
  });

  it("throws the lit torch from the hand with none left in the pack, and goes out in water", () => {
    let state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = {};
    ann.torch = 4;
    state = paint(state, "water", [at(6, 2)]);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(5, 6) });
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(state.lights?.[posKey(at(5, 6))]).toMatchObject({ rounds: 4 });
    expect(fails(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(5, 6) })).toMatch(/no torch/);
    unit(state, "ann").items.torch = 1;
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(6, 2) });
    expect(state.lights?.[posKey(at(6, 2))]).toBeUndefined();
    // Water thrown over a burning torch puts it out.
    state = paint(state, "water", [at(5, 6)]);
    expect(state.lights?.[posKey(at(5, 6))]).toBeUndefined();
  });

  it("swings a torch lit in the main hand as a weapon that may set its target Burning, the weapon put away till it goes", () => {
    let { state, foe } = duel("dummy");
    const ann = unit(state, "ann");
    ann.items.torch = 1;
    ann.outfit = { off_hand: { icon: "round-shield", ref: "buckler", rarity: "common" } };
    const guarded = defenceOf(ann);
    const weapon = [...ann.abilities];
    state = must(state, { type: "light", by: "ann", unit: "ann", hand: "main" });
    expect(unit(state, "ann")).toMatchObject({ torchHand: "main", abilities: ["torch_swing"], stowed: weapon });
    // The shield is still on the other arm.
    expect(defenceOf(unit(state, "ann"))).toBe(guarded);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: weapon[0], target: foe })).toMatch(/do not have/);
    // Swung until it lands: a hit offers the target a save against catching fire, and a failed one sets it Burning.
    let burned = false;
    let saved = false;
    for (let seed = 1; seed < 60 && !(burned && saved); seed++) {
      const tryIt = structuredClone(state);
      tryIt.rng = seed;
      const target = unit(tryIt, foe);
      target.pos = { q: unit(tryIt, "ann").pos.q + 1, r: unit(tryIt, "ann").pos.r };
      const step = stepZone(tryIt, { type: "use", by: "ann", unit: "ann", ability: "torch_swing", target: foe });
      if (!step.ok) throw new Error(step.error);
      const resist = step.events.find((e) => e.t === "roll" && e.roll.kind === "save");
      if (!resist || resist.t !== "roll") continue;
      const burning = unit(step.state, foe).conditions.some((c) => c.kind === "burning");
      expect(burning).toBe(!resist.roll.ok);
      if (burning) burned = true;
      else saved = true;
    }
    expect(burned).toBe(true);
    // Thrown down, the weapon is taken up again.
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(3, 3) });
    expect(unit(state, "ann").abilities).toEqual(weapon);
    expect(unit(state, "ann").torchHand).toBeUndefined();
  });

  it("burns a held torch down only while a fight goes on, and sets the shield aside while it is held", () => {
    let { state } = duel("dummy");
    const ann = unit(state, "ann");
    ann.outfit = { off_hand: { icon: "round-shield", ref: "buckler", rarity: "common" } };
    const guarded = defenceOf(ann);
    ann.torch = 2;
    expect(defenceOf(ann)).toBe(guarded - SHIELD_SET_ASIDE);
    const events: ZoneEvent[] = [];
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + 2) state = must(state, { type: "timeout" }, events);
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(events).toContainEqual({ t: "torch_out", id: "ann" });
    expect(defenceOf(unit(state, "ann"))).toBe(guarded);
  });
});

describe("time out of a fight", () => {
  const T0 = 1_000_000;
  const tell = (state: ZoneState, now: number, sink: ZoneEvent[] = []) => must(state, { type: "time", now }, sink);

  it("starts counting from the first time it is told, without anything passing", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).torch = 3;
    state = paint(state, "poison", [at(8, 6)]);
    const rounds = state.surfaces[posKey(at(8, 6))].rounds;
    state = tell(state, T0);
    expect(state.clock).toEqual({ at: T0, torchAt: T0 });
    expect(state.surfaces[posKey(at(8, 6))].rounds).toBe(rounds);
    expect(unit(state, "ann").torch).toBe(3);
  });

  it("counts every six seconds out of a fight as a round: the ground wears, burning burns, conditions run down", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.conditions = [{ kind: "burning", rounds: 2 }, { kind: "slowed", rounds: 5 }];
    state = paint(state, "oil", [at(8, 6)]);
    const oil = state.surfaces[posKey(at(8, 6))].rounds;
    state = tell(state, T0);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    // Two rounds and a bit: two rounds pass, and the bit is kept for next time.
    state = tell(state, T0 + 2 * EXPLORE_ROUND_MS + 2_000, events);
    expect(state.clock!.at).toBe(T0 + 2 * EXPLORE_ROUND_MS);
    expect(state.surfaces[posKey(at(8, 6))].rounds).toBe(oil - 2);
    expect(unit(state, "ann").hp).toBe(hp - 2 * EFFECT_TICK.burning!);
    expect(unit(state, "ann").conditions).toEqual([{ kind: "slowed", rounds: 3 }]);
    expect(events.filter((e) => e.t === "tick" && e.kind === "burning")).toHaveLength(2);
  });

  it("counts a long absence as a few rounds at most, and catches the clock up", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).conditions = [{ kind: "bleeding", rounds: 30 }];
    state = tell(state, T0);
    const events: ZoneEvent[] = [];
    state = tell(state, T0 + 3_600_000, events);
    expect(events.filter((e) => e.t === "tick")).toHaveLength(MAX_CATCHUP_ROUNDS);
    expect(state.clock!.at).toBe(T0 + 3_600_000);
  });

  it("burns torches on a far kinder clock out of a fight, held or lying on the ground", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).torch = 2;
    state.lights = { [posKey(at(6, 6))]: { rounds: 1, by: "ann" } };
    state = tell(state, T0);
    // A minute and a half less a moment: nothing yet, though the ground has had its rounds.
    state = tell(state, T0 + TORCH_ROUND_MS - 1);
    expect(unit(state, "ann").torch).toBe(2);
    expect(state.lights![posKey(at(6, 6))]).toBeDefined();
    const events: ZoneEvent[] = [];
    state = tell(state, T0 + TORCH_ROUND_MS, events);
    expect(unit(state, "ann").torch).toBe(1);
    expect(state.lights![posKey(at(6, 6))]).toBeUndefined();
    expect(events).toContainEqual({ t: "light", at: at(6, 6), on: false });
    state = tell(state, T0 + 2 * TORCH_ROUND_MS, events);
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(events).toContainEqual({ t: "torch_out", id: "ann" });
  });

  it("leaves time to the fight's own rounds while one is on", () => {
    let { state } = duel("dummy");
    unit(state, "ann").torch = 3;
    state = tell(state, T0);
    state = tell(state, T0 + 10 * TORCH_ROUND_MS);
    expect(unit(state, "ann").torch).toBe(3);
    expect(state.clock).toEqual({ at: T0 + 10 * TORCH_ROUND_MS, torchAt: T0 + 10 * TORCH_ROUND_MS });
  });
});

describe("picking up a torch", () => {
  it("takes a torch burning on the ground into a free hand, with what it has left to burn", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).items = {};
    state.lights = { [posKey(at(4, 6))]: { rounds: 5, by: "bo" } };
    const events: ZoneEvent[] = [];
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) }, events);
    expect(unit(state, "ann").torch).toBe(5);
    expect(state.lights![posKey(at(4, 6))]).toBeUndefined();
    expect(events).toContainEqual({ t: "took_torch", id: "ann", at: at(4, 6), stowed: false });
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) })).toMatch(/no torch/);
  });

  it("puts it out and stows it in the pack with a torch already in hand, and wants you beside it", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = { torch: 1 };
    ann.torch = 7;
    state.lights = { [posKey(at(4, 6))]: { rounds: 2, by: null }, [posKey(at(9, 6))]: { rounds: 2, by: null } };
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(9, 6) })).toMatch(/Go up to it/);
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) });
    expect(unit(state, "ann")).toMatchObject({ torch: 7, items: { torch: 2 } });
  });

  it("costs a Bonus action in a fight", () => {
    let { state } = duel("dummy");
    state.lights = { [posKey(at(5, 5))]: { rounds: 3, by: null }, [posKey(at(5, 7))]: { rounds: 3, by: null } };
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(5, 5) });
    expect(state.encounter!.budgets.ann.bonus).toBe(false);
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(5, 7) })).toMatch(/Bonus/);
  });
});

describe("items", () => {
  it("heals the drinker in full for a Bonus action, and uses the potion up", () => {
    let { state } = duel("dummy");
    unit(state, "ann").hp = 5;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "drink", by: "ann", unit: "ann", item: "healing" }, events);
    const healed = events.find((e) => e.t === "heal");
    expect(healed && healed.t === "heal" && healed.amount).toBeGreaterThanOrEqual(8);
    expect(unit(state, "ann").items.healing).toBe(1);
    expect(state.encounter!.budgets.ann).toMatchObject({ action: true, bonus: false });
    expect(fails(state, { type: "drink", by: "ann", unit: "ann", item: "poison" })).toMatch(/not for drinking/);
  });

  it("heals whoever a thrown potion lands on, and half as much those on the six hexes round them", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6));
    const centre = hero(state, "bo", "qa_paladin", at(6, 6));
    const edge = hero(state, "cy", "qa_paladin", at(7, 6));
    const outside = hero(state, "di", "qa_paladin", at(8, 6));
    for (const h of [centre, edge, outside]) h.hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "healing", at: at(6, 6) }, events);
    const got = (id: string) => events.find((e) => e.t === "heal" && e.target === id);
    const full = got("bo");
    const half = got("cy");
    expect(full && full.t === "heal" && half && half.t === "heal" && half.amount).toBe(Math.ceil((full && full.t === "heal" ? full.amount : 0) / 2));
    expect(got("di")).toBeUndefined();
    expect(unit(state, "di").hp).toBe(1);
    // Seven hexes in all: the one it lands on and the six around.
    expect(zoneBlastCount(state, at(6, 6))).toBe(7);
    expect(unit(state, "ann").items.healing).toBe(1);
  });
});

// ---------- the enemy ----------

describe("threat", () => {
  it("makes the enemy tougher, sharper and more numerous as it rises", () => {
    expect(enemyHp("wolf", 1, 1)).toBe(ENEMIES.wolf.hp);
    expect(enemyHp("wolf", 1, 2)).toBeGreaterThan(enemyHp("wolf", 1, 1) * 1.5);
    expect(enemyHp("wolf", 1, 3)).toBeGreaterThan(enemyHp("wolf", 1, 2));
    expect(enemyStrikes("wolf", 1, 3)[0].bonus).toBe(enemyStrikes("wolf", 1, 1)[0].bonus + 2);
    const count = (threat: number) => createZone("T", "threat", zoneOptions({ groups: 2, kinds: ["wolf"], party: 2, threat })).units.filter((u) => u.side === "enemy").length;
    expect(count(1)).toBe(4);
    expect(count(2)).toBe(6);
    expect(count(3)).toBe(8);
    // A zone made before there was a threat is a fair fight.
    expect(zoneOptions({}).threat).toBe(2);
  });
});

describe("the enemy's turn", () => {
  it("runs when nothing is in reach, giving up its attack for twice the ground", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(1, 6));
    const bear = enemy(state, "bear", at(13, 6));
    const events: ZoneEvent[] = [];
    state = provoke(state, "ann", events);
    for (let i = 0; i < 3 && !events.some((e) => e.t === "moved" && e.id === bear.id); i++) state = must(state, { type: "timeout" }, events);
    const walked = events.filter((e): e is Extract<ZoneEvent, { t: "moved" }> => e.t === "moved" && e.id === bear.id).flatMap((e) => e.path);
    expect(events.some((e) => e.t === "used" && e.id === bear.id && e.what === "dash")).toBe(true);
    // A bear covers 5 a turn: dashing, more than that in one go.
    expect(walked.length).toBeGreaterThan(5);
  });

  it("closes on a hero and attacks", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(4, 6));
    const wolf = enemy(state, "wolf", at(9, 6));
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
    for (let i = 0; i < 4 && !events.some((e) => e.t === "used" && e.id === wolf.id); i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "used" && e.id === wolf.id)).toBe(true);
    expect(adjacent(unit(state, wolf.id).pos, unit(state, "ann").pos)).toBe(true);
  });

  it("walks round fire or poison when there is a clean way", () => {
    for (const kind of ["fire", "poison"] as const) {
      let state = board();
      hero(state, "ann", "qa_paladin", at(4, 6));
      const wolf = enemy(state, "wolf", at(9, 6));
      // A puddle right on the straight line between them, with open ground either side.
      state = paint(state, kind, [at(7, 6), at(6, 6)]);
      const events: ZoneEvent[] = [];
      state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
      for (let i = 0; i < 3 && !events.some((e) => e.t === "moved" && e.id === wolf.id); i++) state = must(state, { type: "timeout" }, events);
      const walked = events.filter((e): e is Extract<ZoneEvent, { t: "moved" }> => e.t === "moved" && e.id === wolf.id).flatMap((e) => e.path);
      expect(walked.length, kind).toBeGreaterThan(0);
      expect(walked.some((p) => state.surfaces[posKey(p)]), kind).toBe(false);
      expect(events.some((e) => e.t === "tick" && e.target === wolf.id), kind).toBe(false);
    }
  });

  it("keeps an archer at a distance when it can shoot from where it is", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(4, 6));
    const archer = enemy(state, "archer", at(9, 6));
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
    for (let i = 0; i < 3 && !events.some((e) => e.t === "used" && e.id === archer.id); i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "used" && e.id === archer.id)).toBe(true);
    expect(hexDistance(unit(state, archer.id).pos, unit(state, "ann").pos)).toBeGreaterThan(1);
  });
});

// ---------- winning and losing ----------

describe("the end of a fight", () => {
  it("is won when every enemy in it is down: the dead are cleared and the fallen get up", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(6, 6));
    const bo = hero(state, "bo", "qa_paladin", at(6, 7));
    const foe = enemy(state, "bat", at(7, 6));
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "shove", target: foe.id });
    expect(state.encounter).not.toBeNull();
    unit(state, "bo").down = true;
    unit(state, "bo").hp = 0;
    unit(state, foe.id).hp = 1;
    const events: ZoneEvent[] = [];
    for (let i = 0; i < 40 && state.encounter; i++) {
      const actor = state.encounter.acting.find((id) => !state.encounter!.done.includes(id) && id === "ann");
      if (!actor) { state = must(state, { type: "timeout" }, events); continue; }
      const target = unit(state, foe.id);
      if (!adjacent(target.pos, unit(state, "ann").pos)) {
        const reach = zoneReach(state, unit(state, "ann"), state.encounter.budgets.ann.move);
        const spot = [...reach.values()].filter((r) => r.stop && adjacent(r.pos, target.pos)).sort((a, b) => a.cost - b.cost)[0];
        if (spot) state = must(state, { type: "move", by: "ann", unit: "ann", to: spot.pos }, events);
      }
      const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: foe.id, focus: unit(state, "ann").focus > 0 });
      if (step.ok) { state = step.state; events.push(...step.events); }
      if (state.encounter) state = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    }
    expect(state.encounter).toBeNull();
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    expect(state.units.some((u) => u.side === "enemy")).toBe(false);
    expect(state.groups).toEqual({});
    expect(unit(state, "bo")).toMatchObject({ down: false, hp: 1 });
    expect(bo.id).toBe("bo");
  });

  it("is lost when every hero in it is down: they wake at the start and the enemy go home healed", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.hp = 1;
    const bear = enemy(state, "bear", at(9, 6));
    bear.hp = 3;
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) }), "ann", events);
    for (let i = 0; i < 60 && state.encounter; i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "defeat")).toBe(true);
    expect(state.encounter).toBeNull();
    expect(unit(state, "ann")).toMatchObject({ down: false, hp: 1 });
    expect(hexDistance(unit(state, "ann").pos, state.start)).toBeLessThanOrEqual(1);
    expect(unit(state, bear.id)).toMatchObject({ hp: unit(state, bear.id).maxHp, pos: bear.home });
    expect(state.groups.g1.alerted).toBe(false);
  });

  it("pays a won fight's XP and what the fallen left to each player's hero, never a stand-in's, and says when the map is cleared", () => {
    let { state, foe } = duel("skeleton");
    const helper = hero(state, "bo", "devops_mage", at(3, 9));
    helper.controller = "ann";
    state.encounter!.order.push("bo");
    unit(state, foe).hp = 1;
    const events: ZoneEvent[] = [];
    const effects: ZoneEffect[] = [];
    for (let i = 0; i < 20 && state.encounter; i++) {
      if (!state.encounter.acting.includes("ann") || state.encounter.done.includes("ann")) { state = must(state, { type: "timeout" }, events); continue; }
      const target = unit(state, foe);
      if (!adjacent(target.pos, unit(state, "ann").pos)) {
        const reach = zoneReach(state, unit(state, "ann"), state.encounter.budgets.ann.move);
        const spot = [...reach.values()].filter((r) => r.stop && adjacent(r.pos, target.pos)).sort((a, b) => a.cost - b.cost)[0];
        if (spot) state = must(state, { type: "move", by: "ann", unit: "ann", to: spot.pos }, events);
      }
      const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: foe });
      if (step.ok) { state = step.state; events.push(...step.events); effects.push(...step.effects); }
      if (state.encounter) state = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    }
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    expect(effects).toHaveLength(1);
    const grant = effects[0];
    expect(grant).toMatchObject({ type: "grant", heroId: "ann", xp: ENEMIES.skeleton.xp });
    // A skeleton leaves bone and iron, and only those.
    expect(Object.keys(grant.resources).every((k) => k === "bone" || k === "iron")).toBe(true);
    expect(Object.values(grant.resources).reduce((a, b) => a + (b ?? 0), 0)).toBeGreaterThan(0);
    expect(events).toContainEqual({ t: "spoils", id: "ann", xp: grant.xp, resources: grant.resources });
    expect(events.some((e) => e.t === "cleared")).toBe(true);
  });

  it("says nothing of a cleared map while another group still stands", () => {
    let { state, foe } = duel("skeleton");
    enemy(state, "bat", at(14, 2), "g2");
    unit(state, foe).hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events);
    expect(events.some((e) => e.t === "cleared")).toBe(false);
  });

  it("plays whole fights on generated maps without breaking its own rules", () => {
    for (let seed = 0; seed < 9; seed++) {
      let state = createZone("PLAY", `play-${seed}`, zoneOptions({ size: "small", biome: (["meadow", "woods", "caves", "shore"] as const)[seed % 4], groups: 2, party: 2, clear: 3, obstacles: 2, elevation: 2, threat: (seed % 3) + 1 }));
      state = must(state, { type: "join", hero: standInHero("refactor_rogue", "ann", 3)! });
      state = must(state, { type: "join", hero: standInHero("devops_mage", "bo", 3)! });
      const check = () => {
        const where = `seed ${seed}`;
        const up = state.units.filter((u) => !u.down);
        expect(new Set(up.map((u) => posKey(u.pos))).size, where).toBe(up.length);
        for (const u of state.units) {
          expect(u.hp, where).toBeGreaterThanOrEqual(0);
          expect(u.hp, where).toBeLessThanOrEqual(u.maxHp);
          // Only what flies may be over water.
          if (!flies(u)) expect(solid(state.map.tiles.find((t) => t.q === u.pos.q && t.r === u.pos.r)), where).toBe(false);
        }
        if (state.encounter) for (const id of state.encounter.acting) expect(state.encounter.order, where).toContain(id);
      };
      for (let step = 0; step < 150; step++) {
        if (!state.units.some((u) => u.side === "enemy" && !u.down)) break;
        for (const id of ["ann", "bo"]) {
          const me = unit(state, id);
          if (me.down) continue;
          const fighting = !!state.encounter?.order.includes(id);
          if (fighting && (!state.encounter!.acting.includes(id) || state.encounter!.done.includes(id))) continue;
          const target = state.units.filter((u) => u.side === "enemy" && !u.down).sort((a, b) => hexDistance(a.pos, me.pos) - hexDistance(b.pos, me.pos))[0];
          if (!target) continue;
          const ability = me.abilities[0];
          let tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          if (!tried.ok) {
            // Walk as near as the turn allows.
            const reach = zoneReach(state, me, fighting ? state.encounter!.budgets[id].move : 12);
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
            if (spot && hexDistance(spot.pos, target.pos) < hexDistance(me.pos, target.pos)) state = must(state, { type: "move", by: id, unit: id, to: spot.pos });
            tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          }
          if (tried.ok) state = tried.state;
          check();
          if (state.encounter?.acting.includes(id) && !state.encounter.done.includes(id)) state = must(state, { type: "end_turn", by: id, unit: id });
          check();
        }
        if (state.encounter && !state.encounter.acting.some((id) => !state.encounter!.done.includes(id))) state = must(state, { type: "timeout" });
      }
      // Either the map is cleared or it ran long; either way the state is whole.
      check();
    }
  }, 60_000);
});

// ---------- fleeing ----------

describe("fleeing", () => {
  const flee = (id = "ann"): ZoneAction => ({ type: "common", by: id, unit: id, what: "flee" });
  /** Ann and Bo in a fight with a wolf, AI off, and it is Ann's turn. */
  function pair(annClass = "qa_paladin") {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", annClass, at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 8));
    const wolf = enemy(state, "wolf", at(9, 6));
    state = provoke(state);
    expect(new Set(state.encounter!.order)).toEqual(new Set(["ann", "bo", wolf.id]));
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, wolf: wolf.id };
  }

  it("is for a fight, on your turn, once no enemy in it is within 2 hexes, and costs the Action (a Rogue's Bonus action)", () => {
    const alone = board();
    hero(alone, "ann", "qa_paladin", at(3, 6));
    expect(fails(alone, flee())).toMatch(/for a fight/);
    // Two hexes off: too close.
    const { state: near } = duel("bandit", "qa_paladin", at(5, 6), at(8, 6));
    expect(hexDistance(unit(near, "ann").pos, near.units.find((u) => u.side === "enemy")!.pos)).toBe(FLEE_RANGE);
    expect(fails(near, flee())).toMatch(/too close to get away/);
    // Clear of it, but the Action is gone.
    const { state: clear } = duel("bandit", "qa_paladin", at(3, 6), at(9, 6));
    clear.encounter!.budgets.ann.action = false;
    expect(fails(clear, flee())).toMatch(/used your Action/);
    // A Rogue runs for a Bonus action.
    expect(commonCost("flee", "refactor_rogue")).toBe("bonus");
    const { state: rogue } = duel("bandit", "refactor_rogue", at(3, 6), at(9, 6));
    rogue.encounter!.budgets.ann.action = false;
    expect(stepZone(rogue, flee()).ok).toBe(true);
  });

  it("ends the fight with nobody winning when the last hero gets away: nothing paid, nobody moved, the enemy home and whole again", () => {
    let { state, foe } = duel("bandit", "qa_paladin", at(3, 6), at(9, 6));
    const bandit = unit(state, foe);
    bandit.hp -= 4;
    bandit.conditions.push({ kind: "bleeding", rounds: 3 });
    bandit.pos = at(7, 6);
    unit(state, "ann").hp -= 3;
    unit(state, "ann").cooldowns = { smite: 2 };
    const before = structuredClone(unit(state, "ann"));
    const step = stepZone(state, flee());
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(step.events).toContainEqual({ t: "used", id: "ann", what: "flee", name: "Flee", target: undefined, at: undefined });
    expect(step.events).toContainEqual({ t: "fled", id: "ann" });
    expect(step.events).toContainEqual({ t: "fight_end", outcome: "fled" });
    expect(step.events.some((e) => e.t === "spoils" || e.t === "cleared")).toBe(false);
    expect(step.effects).toEqual([]);
    expect(state.encounter).toBeNull();
    // No worse off than losing: where she stood, as hurt as she was, never knocked down to 1 HP.
    expect(unit(state, "ann")).toMatchObject({ pos: before.pos, hp: before.hp, down: false, cooldowns: {} });
    // The bandit is back at its post with its wounds bound, so fleeing is no way to wear it down, and has stopped looking.
    expect(unit(state, foe)).toMatchObject({ pos: at(9, 6), hp: bandit.maxHp, down: false, conditions: [] });
    expect(state.groups.g1.alerted).toBe(false);
    // She walks free, and walking right up to it again starts a new fight.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter).toBeNull();
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) });
    expect(state.encounter?.order).toContain(foe);
  });

  it("goes on for whoever is still in it, and draws the one who fled back only when an enemy in it is within 2 hexes", () => {
    let { state, wolf } = pair();
    state = must(state, flee());
    expect(state.encounter).not.toBeNull();
    expect(state.encounter!.order).toEqual(expect.arrayContaining(["bo", wolf]));
    expect(state.encounter!.order).not.toContain("ann");
    expect(state.encounter!.fled).toEqual(["ann"]);
    // Walking is free again, and well inside JOIN_RANGE of the fight she stays out of it.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(unit(state, "ann").pos).toEqual(at(6, 6));
    expect(state.encounter!.order).not.toContain("ann");
    // Within 2 of the wolf: back in, and stopped there.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) }, events);
    expect(events).toContainEqual({ t: "fight_join", id: "ann" });
    expect(hexDistance(unit(state, "ann").pos, unit(state, wolf).pos)).toBe(FLEE_RANGE);
    expect(state.encounter!.order).toContain("ann");
    expect(state.encounter!.fled).toEqual([]);
  });

  it("draws a hero who fled back in when an enemy in the fight comes within 2 hexes of them", () => {
    let { state, wolf } = pair();
    state = must(state, flee());
    // The wolf, after Bo, comes past her.
    state.units.find((u) => u.id === wolf)!.pos = at(5, 6);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "time", now: 1 }, events);
    expect(events).toContainEqual({ t: "fight_join", id: "ann" });
    expect(state.encounter!.order).toContain("ann");
  });

  it("keeps a hero who fled from reaching back into the fight from outside it, but not from looking after themselves", () => {
    const { state: start, wolf } = pair("devops_mage");
    const out = must(start, flee());
    // Sturdy enough to outlast a firebolt, so the fight is still on to be in.
    Object.assign(unit(out, wolf), { hp: 200, maxHp: 200 });
    // Out of the fight there is no Action to spend and no cooldown running: a blow, a heal or a flask for anyone in
    // it would come free and off the turn order, every time they fled. They go back to it instead.
    expect(fails(out, { type: "use", by: "ann", unit: "ann", ability: "firebolt", target: wolf })).toMatch(/got away from that fight/);
    expect(fails(out, { type: "use", by: "ann", unit: "ann", ability: "mend", target: "bo" })).toMatch(/got away from that fight/);
    expect(fails(out, { type: "throw", by: "ann", unit: "ann", item: "healing", at: unit(out, "bo").pos })).toMatch(/got away from that fight/);
    const self = must(out, { type: "use", by: "ann", unit: "ann", ability: "mend", target: "ann" });
    expect(self.encounter!.order).not.toContain("ann");
    // A hero who never was in it, shooting in from further off than JOIN_RANGE, is in it too.
    let far = board();
    far.aiOff = true;
    hero(far, "ann", "qa_paladin", at(3, 2));
    const archer = hero(far, "cy", "refactor_rogue", at(12, 2));
    const foe = enemy(far, "bandit", at(5, 2));
    Object.assign(foe, { hp: 200, maxHp: 200 });
    far = provoke(far);
    expect(far.encounter!.order).not.toContain(archer.id);
    expect(Math.min(hexDistance(archer.pos, foe.pos), hexDistance(archer.pos, at(3, 2)))).toBeGreaterThan(JOIN_RANGE);
    far = must(far, { type: "use", by: "cy", unit: "cy", ability: "aimed_shot", target: foe.id });
    expect(far.encounter!.order).toContain("cy");
  });

  /**
   * Bo and Ann sharing a turn, Bo first and Ann last of the two, the wolf after them, AI off: the order set out by
   * hand so it is the same every time.
   */
  function shared() {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 9));
    const wolf = enemy(state, "wolf", at(9, 6)).id;
    state = provoke(state);
    const fresh = { action: true, bonus: true, move: 5, moveMax: 5, disengaged: false };
    Object.assign(state.encounter!, { order: ["bo", "ann", wolf], init: { bo: 20, ann: 15, [wolf]: 5 }, acting: ["bo", "ann"], done: [], budgets: { bo: { ...fresh }, ann: { ...fresh } } });
    return { state, wolf };
  }

  it("brings one who fled back in the place they had, to wait for the next round: no second turn out of it", () => {
    let { state, wolf } = shared();
    const { round } = state.encounter!;
    state = must(state, flee());
    expect(state.encounter!.acting).toEqual(["bo"]);
    expect(state.encounter!.waits).toEqual(["ann"]);
    // Straight back within 2 of the wolf, while Bo still has the turn: in again, with no fresh roll for it.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) }, events);
    expect(hexDistance(unit(state, "ann").pos, unit(state, wolf).pos)).toBe(FLEE_RANGE);
    expect(events.some((e) => e.t === "roll")).toBe(false);
    expect(state.encounter!.init.ann).toBe(15);
    expect(state.encounter!.order).toEqual(["bo", "ann", wolf]);
    // Bo ends the turn: next in the order is Ann, but she has had this round's. The wolf goes, then a new round.
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter!.round).toBe(round + 1);
    expect(state.encounter!.acting).toEqual(["bo", "ann"]);
    expect(state.encounter!.waits).toBeUndefined();
  });

  it("still burns, and runs down what is on them, while a hero who fled is out of a fight that goes on", () => {
    let { state } = shared();
    unit(state, "ann").conditions.push({ kind: "burning", rounds: 3 }, { kind: "slowed", rounds: 2 });
    state = must(state, flee());
    const hp = unit(state, "ann").hp;
    // A round of the fight goes by (Bo ends the turn, the wolf does nothing): the same as a round out of one.
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter).not.toBeNull();
    expect(state.encounter!.order).not.toContain("ann");
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(unit(state, "ann").conditions.find((c) => c.kind === "slowed")?.rounds ?? 0).toBeLessThan(2);
  });

  it("hands the turn on to whoever came after a hero who fled on a turn of their own", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 9));
    const a = enemy(state, "wolf", at(9, 6));
    const b = enemy(state, "wolf", at(9, 9));
    state = provoke(state);
    const turnOf = (order: string[]) => {
      const s = structuredClone(state);
      Object.assign(s.encounter!, { order, acting: ["ann"], done: [], budgets: { ann: { action: true, bonus: true, move: 5, moveMax: 5, disengaged: false } } });
      return s;
    };
    const { round, turnNo } = state.encounter!;
    // In the middle of the round: the wolf after her goes next (and does nothing, with the AI off), then Bo.
    const mid = must(turnOf([a.id, "ann", b.id, "bo"]), flee());
    expect(mid.encounter).toMatchObject({ round, turnNo: turnNo + 2, acting: ["bo"], order: [a.id, b.id, "bo"] });
    expect(mid.encounter!.resume).toBeUndefined();
    // Last in the order: a new round, from the top.
    const last = must(turnOf([a.id, "bo", b.id, "ann"]), flee());
    expect(last.encounter).toMatchObject({ round: round + 1, turnNo: turnNo + 2, acting: ["bo"] });
    // Sharing a turn with Bo: it is still Bo's.
    const sharing = turnOf([a.id, "ann", "bo", b.id]);
    sharing.encounter!.acting = ["ann", "bo"];
    sharing.encounter!.budgets.bo = { action: true, bonus: true, move: 5, moveMax: 5, disengaged: false };
    const after = must(sharing, flee());
    expect(after.encounter).toMatchObject({ turnNo, acting: ["bo"], done: [] });
  });

  it("leaves the fight lost for the fallen when the last hero standing gets away from them", () => {
    let { state, wolf } = pair();
    unit(state, "bo").down = true;
    unit(state, "bo").hp = 0;
    unit(state, wolf).hp -= 3;
    const annBefore = structuredClone(unit(state, "ann"));
    const events: ZoneEvent[] = [];
    state = must(state, flee(), events);
    expect(events).toContainEqual({ t: "fight_end", outcome: "defeat" });
    expect(state.encounter).toBeNull();
    // The fallen wake at the start, as from any lost fight; the one who ran is where she ran to.
    expect(unit(state, "bo")).toMatchObject({ down: false, hp: 1 });
    expect(hexDistance(unit(state, "bo").pos, state.start)).toBeLessThanOrEqual(1);
    expect(unit(state, "ann")).toMatchObject({ pos: annBefore.pos, hp: annBefore.hp });
    expect(unit(state, wolf)).toMatchObject({ hp: unit(state, wolf).maxHp, pos: at(9, 6) });
  });

  it("leaves the enemy who fell fallen, heals the rest, and finds a post taken by a hero the nearest free hex", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const fallen = enemy(state, "bandit", at(9, 6));
    const other = enemy(state, "bandit", at(9, 4));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    Object.assign(unit(state, fallen.id), { hp: 0, down: true });
    // The other has come out to her: she has got round it to stand on its post.
    unit(state, other.id).pos = at(5, 3);
    unit(state, other.id).hp = 2;
    unit(state, "ann").pos = at(9, 4);
    const step = stepZone(state, flee());
    if (!step.ok) throw new Error(step.error);
    expect(step.effects).toEqual([]);
    expect(step.state.units.some((u) => u.id === fallen.id)).toBe(false);
    const back = step.state.units.find((u) => u.id === other.id)!;
    expect(hexDistance(back.pos, at(9, 4))).toBe(1);
    expect(back.hp).toBe(back.maxHp);
    expect(unit(step.state, "ann").pos).toEqual(at(9, 4));
  });

  it("draws nobody whose player has left into a fight, nor lets its blows land on them, until they come back", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 8));
    const mate = hero(state, "s1", "devops_mage", at(2, 9));
    mate.controller = "bo";
    const ogre = enemy(state, "ogre", at(4, 7));
    expect([hexDistance(ogre.pos, at(3, 6)), hexDistance(ogre.pos, at(3, 8))]).toEqual([ENEMY_BURST, ENEMY_BURST]);
    // Bo has gone, and the stand-in Bo plays with him.
    state = must(state, { type: "away", player: "bo", away: true });
    expect([unit(state, "bo").away, unit(state, "s1").away, unit(state, "ann").away]).toEqual([true, true, undefined]);
    state = provoke(state);
    expect(state.encounter!.order).toEqual(expect.arrayContaining(["ann", ogre.id]));
    expect(state.encounter!.order).not.toContain("bo");
    expect(state.encounter!.order).not.toContain("s1");
    // The ogre stamps the ground: Ann, in the fight, is caught; Bo, beside her and not in it, is not.
    const stomp = enemyStrikes("ogre", 1).find((s) => s.burst)!;
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state: structuredClone(state), rng: makeRng(3), events, effects: [] };
    enemyAct(ctx, unit(ctx.state, ogre.id), stomp, null);
    expect(events.some((e) => (e.t === "hit" || e.t === "roll") && ("target" in e ? e.target === "ann" : e.roll.id === "ann"))).toBe(true);
    expect(events.some((e) => (e.t === "hit" && e.target === "bo") || (e.t === "roll" && e.roll.id === "bo"))).toBe(false);
    // He comes back: he is here again, and near the fight he is in it.
    const back: ZoneEvent[] = [];
    state = must(state, { type: "join", hero: standInHero("qa_paladin", "bo", 1)! }, back);
    expect(unit(state, "bo").away).toBeUndefined();
    expect(unit(state, "s1").away).toBeUndefined();
    expect(back).toContainEqual({ t: "fight_join", id: "bo" });
    expect(state.encounter!.order).toContain("s1");
  });

  it("brings a hero's class abilities with them, after the weapon's, and refreshes them on a return", () => {
    const sheet = standInHero("qa_paladin", "cy", 3)!;
    let state = must(board(), { type: "join", hero: { ...sheet, classAbilities: ["firebolt", "smite"] } });
    const weapon = abilitiesFor(sheet.weapon);
    expect(unit(state, "cy").abilities).toEqual([...new Set([...weapon, "firebolt", "smite"])]);
    state = must(state, { type: "join", hero: { ...sheet, classAbilities: [] } });
    expect(unit(state, "cy").abilities).toEqual(weapon);
  });

  it("keeps a hero whose player leaves in the middle of a fight in it", () => {
    let { state } = pair();
    state = must(state, { type: "away", player: "ann", away: true });
    expect(state.encounter!.order).toContain("ann");
  });

  it("keeps its own rules through whole fights where heroes run off and get caught again", () => {
    let ran = 0;
    for (let seed = 0; seed < 8; seed++) {
      let state = createZone("RUN", `run-${seed}`, zoneOptions({ size: "small", biome: (["meadow", "caves"] as const)[seed % 2], groups: 2, party: 2, clear: 3, obstacles: 1, elevation: 1, threat: 1 }));
      state = must(state, { type: "join", hero: standInHero("refactor_rogue", "ann", 3)! });
      state = must(state, { type: "join", hero: standInHero("qa_paladin", "bo", 3)! });
      const dice = makeRng(seed + 1);
      const check = () => {
        const where = `seed ${seed}`;
        const up = state.units.filter((u) => !u.down);
        expect(new Set(up.map((u) => posKey(u.pos))).size, where).toBe(up.length);
        const enc = state.encounter;
        if (!enc) return;
        for (const id of enc.acting) expect(enc.order, where).toContain(id);
        for (const id of enc.fled ?? []) expect(enc.order, where).not.toContain(id);
        expect(enc.resume, where).toBeUndefined();
        expect(enc.order.some((id) => unit(state, id).side === "hero"), where).toBe(true);
      };
      for (let step = 0; step < 150; step++) {
        if (!state.units.some((u) => u.side === "enemy" && !u.down)) break;
        for (const id of ["ann", "bo"]) {
          const me = unit(state, id);
          if (me.down) continue;
          const enc = state.encounter;
          const fighting = !!enc?.order.includes(id);
          if (fighting && (!enc!.acting.includes(id) || enc!.done.includes(id))) continue;
          const foes = state.units.filter((u) => u.side === "enemy" && !u.down && (!fighting || enc!.order.includes(u.id)));
          if (fighting && dice.int(1, 3) === 1) {
            // Run: as far from them as this turn goes (blows and all), then off, if that got clear.
            const reach = zoneReach(state, me, enc!.budgets[id].move);
            const far = (p: HexPos) => Math.min(...foes.map((f) => hexDistance(f.pos, p)));
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => far(b.pos) - far(a.pos))[0];
            if (spot && spot.cost > 0) state = must(state, { type: "move", by: id, unit: id, to: spot.pos });
            check();
            const out = stepZone(state, flee(id));
            if (out.ok) {
              state = out.state;
              ran += 1;
              check();
              continue;
            }
            if (unit(state, id).down || !state.encounter?.budgets[id]) continue;
          }
          const now = unit(state, id);
          const target = foes.sort((a, b) => hexDistance(a.pos, now.pos) - hexDistance(b.pos, now.pos))[0];
          if (!target) continue;
          const ability = now.abilities[0];
          let tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          if (!tried.ok) {
            const me = now;
            const reach = zoneReach(state, me, state.encounter?.order.includes(id) ? (state.encounter.budgets[id]?.move ?? 0) : 12);
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
            if (spot && hexDistance(spot.pos, target.pos) < hexDistance(me.pos, target.pos)) state = must(state, { type: "move", by: id, unit: id, to: spot.pos });
            tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          }
          if (tried.ok) state = tried.state;
          check();
          if (state.encounter?.acting.includes(id) && !state.encounter.done.includes(id)) state = must(state, { type: "end_turn", by: id, unit: id });
          check();
        }
        if (state.encounter && !state.encounter.acting.some((id) => !state.encounter!.done.includes(id))) state = must(state, { type: "timeout" });
        check();
      }
    }
    expect(ran).toBeGreaterThan(0);
  }, 60_000);
});

// ---------- a delve ----------

describe("a delve", () => {
  const delveOptions = (party = 2) => zoneOptions({ biome: "caves", delve: true, party, level: 3 });
  /** Every open hex walkable from the mouth. */
  const fromMouth = (state: ZoneState) => {
    // A locked door can be opened, so the way through it counts.
    const open = new Set(state.map.tiles.filter((t) => !solid(t) || t.biome === "gate").map((t) => posKey(t)));
    const seen = new Set([posKey(state.start)]);
    const queue = [state.start];
    for (let i = 0; i < queue.length; i++) {
      for (const n of hexNeighbors(queue[i], state.map.grid)) {
        if (!open.has(posKey(n)) || seen.has(posKey(n))) continue;
        seen.add(posKey(n));
        queue.push(n);
      }
    }
    return seen;
  };
  const tileOf = (state: ZoneState, p: HexPos) => state.map.tiles.find((t) => t.q === p.q && t.r === p.r);

  it("is the caverns' own layout: chambers and tunnels from the mouth, its bands as groups, and chests to open", () => {
    for (let seed = 0; seed < 12; seed++) {
      const where = `seed ${seed}`;
      const plan = generateDelve(`d${seed}`, delveOptions());
      expect(generateDelve(`d${seed}`, delveOptions()), where).toEqual(plan);
      // Every locked door is a door to work, standing where the caverns put it.
      const gates = plan.map.tiles.filter((t) => t.biome === "gate");
      expect(plan.map.pois.filter((p) => p.kind === "gate").map((p) => posKey(p.pos)).sort(), where).toEqual(gates.map((t) => posKey(t)).sort());
      expect(plan.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos), where).toEqual([plan.start]);
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const reach = fromMouth(state);
      // Every band stands where the party can walk to it, under its chamber's name; every chest can be reached.
      for (const u of state.units) expect(reach.has(posKey(u.pos)), where).toBe(true);
      expect(Object.keys(state.groups).length, where).toBeGreaterThanOrEqual(2);
      for (const id of Object.keys(state.groups)) expect(id, where).toMatch(/^(band\d+|lair)$/);
      const caches = state.map.pois.filter((p) => p.kind === "cache");
      expect(caches.length, where).toBeGreaterThan(0);
      for (const c of caches) expect([...hexNeighbors(c.pos, state.map.grid), c.pos].some((n) => reach.has(posKey(n))), where).toBe(true);
      // The hoard is there, guarded by the haunt.
      const hoard = caches.find((c) => c.loot === "hoard");
      if (hoard) {
        expect(hoard.guard, where).toBe("lair");
        expect(state.units.some((u) => u.group === "lair" && u.kind === "haunt"), where).toBe(true);
      }
      // Nobody stands on the mouth, so the party always has room to arrive.
      expect(state.units.some((u) => posKey(u.pos) === posKey(state.start)), where).toBe(false);
    }
  });

  it("lets daylight in at the mouth: the hexes round it are lit with no torch", () => {
    const state = createZone("DLVE", "d2", delveOptions());
    const lit = litHexes(state)!;
    expect(lit.has(posKey(state.start))).toBe(true);
    for (const n of hexNeighbors(state.start, state.map.grid)) if (!solid(state.map.tiles.find((t) => t.q === n.q && t.r === n.r))) expect(lit.has(posKey(n))).toBe(true);
    // Far down the tunnels it is still dark.
    expect(state.map.tiles.some((t) => t.biome === "cave" && !lit.has(posKey(t)))).toBe(true);
  });

  /** A delve seed with a locked door, and a hero standing beside it with nobody else about. */
  const atDoor = () => {
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const door = state.map.pois.find((p) => p.kind === "gate");
      if (!door) continue;
      const beside = hexNeighbors(door.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave" && !state.units.some((u) => posKey(u.pos) === posKey(n)));
      if (!beside) continue;
      return { state, door, beside, seed };
    }
    throw new Error("no delve with a door in sixty seeds");
  };

  it("shuts a room or two behind a locked door: a wall that blocks the way and the view until it opens", () => {
    let doors = 0;
    for (let seed = 0; seed < 30; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      for (const door of state.map.pois.filter((p) => p.kind === "gate")) {
        doors++;
        expect(solid(tileOf(state, door.pos))).toBe(true);
        expect(door.cleared).toBe(false);
      }
    }
    expect(doors).toBeGreaterThan(0);
  });

  it("unlocks a door quietly with a key off the ring, and uses the key up", () => {
    const { state, door, beside } = atDoor();
    hero(state, "ann", "qa_paladin", beside);
    expect(fails(state, { type: "unlock", by: "ann", unit: "ann", poi: "gate99" })).toMatch(/no door/);
    state.keys = 1;
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "unlock", by: "ann", unit: "ann", poi: door.id }, events);
    expect(next.keys).toBe(0);
    expect(next.map.pois.find((p) => p.id === door.id)!.cleared).toBe(true);
    expect(tileOf(next, door.pos)!.biome).toBe("cave");
    expect(events).toContainEqual({ t: "door", id: "ann", poi: door.id, how: "key" });
    expect(events.some((e) => e.t === "noise" || e.t === "roll")).toBe(false);
    expect(fails(next, { type: "unlock", by: "ann", unit: "ann", poi: door.id })).toMatch(/open already/);
  });

  it("forces a door without a key on a Strength roll, and the crash brings the nearest band that has not noticed anyone", () => {
    let held = false;
    let forced = false;
    for (let rng = 1; rng < 80 && !(held && forced); rng++) {
      const { state, door, beside } = atDoor();
      state.rng = rng;
      hero(state, "ann", "qa_paladin", beside);
      const near = state.units.filter((u) => u.side === "enemy" && hexDistance(u.pos, door.pos) <= NOISE_RANGE);
      const events: ZoneEvent[] = [];
      const step = stepZone(state, { type: "unlock", by: "ann", unit: "ann", poi: door.id });
      if (!step.ok) throw new Error(step.error);
      events.push(...step.events);
      const roll = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      expect(roll).toBeDefined();
      const ok = roll!.t === "roll" && roll!.roll.ok;
      expect(step.state.map.pois.find((p) => p.id === door.id)!.cleared).toBe(ok);
      expect(events).toContainEqual({ t: "door", id: "ann", poi: door.id, how: ok ? "forced" : "held" });
      // Heard either way, if a band is near enough.
      expect(events.some((e) => e.t === "noise")).toBe(near.length > 0);
      if (near.length > 0) expect(step.state.encounter).not.toBeNull();
      if (ok) forced = true;
      else held = true;
    }
    expect(forced && held).toBe(true);
  });

  it("puts a key on the ring from a chest that holds one, and from a band that carried one once it is beaten", () => {
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const keyChest = state.map.pois.find((p) => p.kind === "cache" && p.key);
      const band = state.keyHolders?.[0];
      if (!keyChest && !band) continue;
      if (keyChest) {
        state.units = state.units.filter((u) => u.side === "hero" || (u.group !== keyChest.guard && hexDistance(u.pos, keyChest.pos) > 3));
        const beside = hexNeighbors(keyChest.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave")!;
        hero(state, "ann", "qa_paladin", beside);
        const events: ZoneEvent[] = [];
        const next = must(state, { type: "open", by: "ann", unit: "ann", poi: keyChest.id }, events);
        expect(next.keys).toBe(1);
        expect(events).toContainEqual({ t: "key", keys: 1, from: "chest", id: "ann" });
      }
      if (band) {
        const fresh = createZone("DLVE", `d${seed}`, delveOptions());
        const one = fresh.units.find((u) => u.group === band)!;
        hero(fresh, "ann", "qa_paladin", hexNeighbors(one.pos, fresh.map.grid).find((n) => tileOf(fresh, n)?.biome === "cave" && !fresh.units.some((u) => posKey(u.pos) === posKey(n)))!);
        let s = must(fresh, { type: "dev", by: "ann", dev: { op: "start_fight" } });
        const events: ZoneEvent[] = [];
        s = must(s, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events);
        if (!s.units.some((u) => u.group === band && !u.down)) {
          expect(s.keys).toBe(1);
          expect(events).toContainEqual({ t: "key", keys: 1, from: "band" });
          expect(s.keyHolders ?? []).not.toContain(band);
        }
      }
      return;
    }
    throw new Error("no delve with a key in sixty seeds");
  });

  it("sets out no chest or crate where it blocks the way up to a locked door", () => {
    let doors = 0;
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const things = new Set(state.map.pois.filter((p) => p.kind === "cache" || p.kind === "crate").map((p) => posKey(p.pos)));
      const seen = new Set([posKey(state.start)]);
      const queue = [state.start];
      for (let i = 0; i < queue.length; i++) {
        for (const n of hexNeighbors(queue[i], state.map.grid)) {
          if (seen.has(posKey(n)) || things.has(posKey(n)) || solid(tileOf(state, n))) continue;
          seen.add(posKey(n));
          queue.push(n);
        }
      }
      for (const door of state.map.pois.filter((p) => p.kind === "gate")) {
        doors++;
        // Some floor beside the door can be walked to from the mouth, round every chest and crate.
        expect(hexNeighbors(door.pos, state.map.grid).some((n) => seen.has(posKey(n))), `seed ${seed} ${door.id}`).toBe(true);
      }
    }
    expect(doors).toBeGreaterThan(0);
  });

  it("puts no chest where it shuts off any of the floor: one in the only way through is set aside in its chamber", () => {
    for (let seed = 0; seed < 60; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `x${seed}`, delveOptions());
      const chests = state.map.pois.filter((p) => p.kind === "cache");
      const walk = (blocked: Set<string>) => {
        const seen = new Set([posKey(state.start)]);
        const queue = [state.start];
        for (let i = 0; i < queue.length; i++) {
          for (const n of hexNeighbors(queue[i], state.map.grid)) {
            if (seen.has(posKey(n)) || blocked.has(posKey(n)) || solid(tileOf(state, n))) continue;
            seen.add(posKey(n));
            queue.push(n);
          }
        }
        return seen;
      };
      const keys = new Set(chests.map((c) => posKey(c.pos)));
      const round = walk(keys);
      for (const key of walk(new Set())) if (!keys.has(key)) expect(round.has(key), `${where} ${key}`).toBe(true);
      expect(chests.some((c) => posKey(c.pos) === posKey(state.start)), where).toBe(false);
    }
  });

  it("gives a cave with no mouth one where heroes arrive, once, and leaves other maps alone", () => {
    const open = createZone("OPEN", "o1", zoneOptions({ biome: "caves", size: "small", groups: 1 }));
    expect(open.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos)).toEqual([open.start]);
    // A cave saved before mouths were given out gets one as it is loaded, and only one however often.
    const old = structuredClone(open);
    old.map.pois = [];
    ensureMouth(ensureMouth(old));
    expect(old.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos)).toEqual([old.start]);
    // A delve keeps the mouth it has; a meadow gets none.
    const delve = createZone("DLVE", "d1", delveOptions());
    expect(delve.map.pois.filter((p) => p.kind === "landing")).toHaveLength(1);
    expect(createZone("MEAD", "m1", zoneOptions({ biome: "meadow", size: "small" })).map.pois.some((p) => p.kind === "landing")).toBe(false);
  });

  it("grows a few clusters of glowing mushrooms against the rock, each lighting the dark round it until it is picked", () => {
    for (let seed = 0; seed < 12; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `g${seed}`, delveOptions());
      const caps = state.map.pois.filter((p) => p.kind === "glowcap");
      expect(caps.length, where).toBeGreaterThanOrEqual(GLOWCAP_COUNT[0]);
      expect(caps.length, where).toBeLessThanOrEqual(GLOWCAP_COUNT[1]);
      const lit = litHexes(state)!;
      for (const c of caps) {
        expect(tileOf(state, c.pos)?.biome, where).toBe("cave");
        expect(state.map.pois.filter((p) => posKey(p.pos) === posKey(c.pos)), where).toHaveLength(1);
        expect(state.units.some((u) => posKey(u.pos) === posKey(c.pos)), where).toBe(false);
        expect(hexDistance(c.pos, state.start), where).toBeGreaterThan(2);
        expect(lit.has(posKey(c.pos)), where).toBe(true);
      }
      for (const a of caps) for (const b of caps) if (a !== b) expect(hexDistance(a.pos, b.pos), where).toBeGreaterThanOrEqual(4);
    }
  });

  it("lets a hero pick glowing mushrooms from beside them for a few mushrooms, once, and puts the glow out", () => {
    const state = createZone("DLVE", "g1", delveOptions());
    const cap = state.map.pois.find((p) => p.kind === "glowcap")!;
    state.units = state.units.filter((u) => u.side === "hero" || hexDistance(u.pos, cap.pos) > 4);
    hero(state, "ann", "qa_paladin", state.start);
    expect(fails(state, { type: "forage", by: "ann", unit: "ann", poi: cap.id })).toMatch(/Go up to them/);
    unit(state, "ann").pos = hexNeighbors(cap.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave" && !state.units.some((u) => posKey(u.pos) === posKey(n)))!;
    const step = stepZone(state, { type: "forage", by: "ann", unit: "ann", poi: cap.id });
    if (!step.ok) throw new Error(step.error);
    const grant = step.effects.find((e) => e.heroId === "ann")!;
    expect(grant.resources.mushrooms).toBeGreaterThanOrEqual(GLOWCAP_MUSHROOMS[0]);
    expect(grant.resources.mushrooms).toBeLessThanOrEqual(GLOWCAP_MUSHROOMS[1]);
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann" && e.resources.mushrooms === grant.resources.mushrooms)).toBe(true);
    expect(step.state.map.pois.find((p) => p.id === cap.id)!.cleared).toBe(true);
    // Picked, it lights nothing (unless something else does).
    const others = step.state.map.pois.filter((p) => (p.kind === "glowcap" && !p.cleared) || p.kind === "landing").some((p) => hexDistance(p.pos, cap.pos) <= 3);
    if (!others) expect(litHexes(step.state)!.has(posKey(cap.pos))).toBe(false);
    expect(fails(step.state, { type: "forage", by: "ann", unit: "ann", poi: cap.id })).toMatch(/Picked already/);
  });

  it("sends a lone hero against smaller bands, and the haunt alone", () => {
    const solo = createZone("DLVE", "d3", delveOptions(1));
    const crew = createZone("DLVE", "d3", delveOptions(4));
    expect(solo.units.length).toBeLessThan(crew.units.length);
    expect(solo.units.filter((u) => u.group === "lair").map((u) => u.kind)).toEqual(["haunt"]);
  });

  it("opens a chest from beside it once its guards are gone, and pays its opener", () => {
    let state = createZone("DLVE", "d1", delveOptions());
    const chest = state.map.pois.find((p) => p.kind === "cache" && p.loot === "chest")!;
    expect(chest).toBeDefined();
    const ann = hero(state, "ann", "qa_paladin", state.start);
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/Go up to it/);
    ann.pos = hexNeighbors(chest.pos, state.map.grid).find((n) => !solid(tileOf(state, n)) && !state.units.some((u) => posKey(u.pos) === posKey(n)))!;
    if (chest.guard) {
      expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/guards still stand/);
      state.units = state.units.filter((u) => u.group !== chest.guard);
    }
    // Out of a fight, with nobody near enough to start one.
    state.units = state.units.filter((u) => u.side === "hero" || hexDistance(u.pos, ann.pos) > 3);
    const step = stepZone(state, { type: "open", by: "ann", unit: "ann", poi: chest.id });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(state.map.pois.find((p) => p.id === chest.id)!.cleared).toBe(true);
    expect(step.events).toContainEqual({ t: "opened", id: "ann", poi: chest.id, loot: "chest" });
    expect(step.effects).toHaveLength(1);
    expect(step.effects[0]).toMatchObject({ type: "grant", heroId: "ann", xp: CHEST_PAY.chest.xp });
    const gold = step.effects[0].gold!;
    expect(gold).toBeGreaterThanOrEqual(CHEST_PAY.chest.gold[0]);
    expect(gold).toBeLessThanOrEqual(CHEST_PAY.chest.gold[1]);
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann" && e.gold === gold)).toBe(true);
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/emptied/);
  });

  it("pays every player's hero on the map from the hoard, but no stand-in, and lets no stand-in open it", () => {
    const state = createZone("DLVE", "d1", delveOptions());
    const hoard = state.map.pois.find((p) => p.loot === "hoard")!;
    expect(hoard).toBeDefined();
    state.units = state.units.filter((u) => u.side === "hero");
    const beside = hexNeighbors(hoard.pos, state.map.grid).filter((n) => !solid(tileOf(state, n)));
    hero(state, "ann", "qa_paladin", beside[0]);
    hero(state, "bo", "devops_mage", state.start);
    const helper = hero(state, "cy", "refactor_rogue", beside[1]);
    helper.controller = "ann";
    expect(fails(state, { type: "open", by: "ann", unit: "cy", poi: hoard.id })).toMatch(/your own hero/);
    const step = stepZone(state, { type: "open", by: "ann", unit: "ann", poi: hoard.id });
    if (!step.ok) throw new Error(step.error);
    expect(step.effects.map((e) => e.heroId).sort()).toEqual(["ann", "bo"]);
    for (const e of step.effects) expect(e).toMatchObject({ xp: CHEST_PAY.hoard.xp });
    expect(step.effects.every((e) => !!e.item)).toBe(true);
  });

  it("costs an Action to open a chest in a fight", () => {
    let { state } = duel("dummy");
    state.map.pois.push({ id: "chest9", kind: "cache", pos: at(5, 7), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" });
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "chest9" });
    expect(state.encounter!.budgets.ann.action).toBe(false);
    state.map.pois.push({ id: "chest10", kind: "cache", pos: at(5, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" });
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: "chest10" })).toMatch(/Action/);
  });
});

// ---------- crates ----------

describe("crates", () => {
  /** A crate standing on a hex, with this much left in it. */
  const crate = (state: ZoneState, id: string, pos: HexPos, hp = CRATE_HP) => {
    state.map.pois.push({ id, kind: "crate", pos, hidden: false, cleared: false, usedBy: [], enemies: [], hp, maxHp: CRATE_HP });
    return id;
  };
  const poi = (state: ZoneState, id: string) => state.map.pois.find((p) => p.id === id)!;
  const hits = (events: ZoneEvent[], id: string) => events.filter((e): e is Extract<ZoneEvent, { t: "crate_hit" }> => e.t === "crate_hit" && e.poi === id);
  /** A hero beside a crate, out of any fight. */
  function beside(classId = "qa_paladin", hp = CRATE_HP) {
    const state = board();
    hero(state, "ann", classId, at(5, 6));
    crate(state, "crate1", at(6, 6), hp);
    return state;
  }

  it("are stacked about a delve, and never shut off any of the floor, a chest or each other", () => {
    const delveOptions = zoneOptions({ biome: "caves", delve: true, party: 2, level: 3 });
    let total = 0;
    for (let seed = 0; seed < 16; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `d${seed}`, delveOptions);
      const crates = state.map.pois.filter((p) => p.kind === "crate");
      const chests = state.map.pois.filter((p) => p.kind === "cache");
      total += crates.length;
      expect(crates.length, where).toBeGreaterThanOrEqual(DELVE_CRATES[0]);
      expect(new Set(crates.map((c) => c.id)).size, where).toBe(crates.length);
      /** The floor walkable from the mouth, round whatever stands on these hexes. A locked door can be opened, so it counts as a way through. */
      const walkable = (blocked: Set<string>) => {
        const seen = new Set([posKey(state.start)]);
        const queue = [state.start];
        for (let i = 0; i < queue.length; i++) {
          for (const n of hexNeighbors(queue[i], state.map.grid)) {
            const t = state.map.tiles.find((x) => x.q === n.q && x.r === n.r);
            if (!t || (solid(t) && t.biome !== "gate") || seen.has(posKey(n)) || blocked.has(posKey(n))) continue;
            seen.add(posKey(n));
            queue.push(n);
          }
        }
        return seen;
      };
      const crateKeys = new Set(crates.map((c) => posKey(c.pos)));
      const withChests = walkable(new Set(chests.map((c) => posKey(c.pos))));
      const withAll = walkable(new Set([...chests, ...crates].map((c) => posKey(c.pos))));
      for (const c of crates) {
        expect(c.hp, where).toBe(CRATE_HP);
        expect(state.map.tiles.find((t) => t.q === c.pos.q && t.r === c.pos.r)?.biome, where).toBe("cave");
        expect(state.units.some((u) => posKey(u.pos) === posKey(c.pos)), where).toBe(false);
        expect(hexDistance(c.pos, state.start), where).toBeGreaterThan(2);
        // Never right beside a chest, so it never stands where a chest is opened from.
        for (const chest of chests) expect(hexDistance(c.pos, chest.pos), where).toBeGreaterThan(1);
        // Every crate can be walked up to, to be broken.
        expect(hexNeighbors(c.pos, state.map.grid).some((n) => withAll.has(posKey(n))), where).toBe(true);
      }
      // Nothing the party could walk to before is cut off by them, and every chest can still be got beside.
      for (const key of withChests) if (!crateKeys.has(key)) expect(withAll.has(key), `${where} ${key}`).toBe(true);
      for (const chest of chests) expect(hexNeighbors(chest.pos, state.map.grid).some((n) => withAll.has(posKey(n))), where).toBe(true);
      // They are something to break, not something to open: the cave is cleared without them.
      expect(unopened(state), where).toBe(chests.length);
    }
    expect(total / 16).toBeGreaterThan(DELVE_CRATES[0]);
  });

  it("stand in the way like a chest: nobody walks, jumps or is shoved onto one, and the splinters can be walked over", () => {
    let state = beside();
    expect(zoneReach(state, unit(state, "ann"), 10).has(posKey(at(6, 6)))).toBe(false);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) })).toMatch(/cannot get there/);
    expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(6, 6) })).toMatch(/nowhere to land/);
    // Shoved back into one, an enemy goes down where it stands.
    const shoved = board();
    shoved.aiOff = true;
    hero(shoved, "ann", "qa_paladin", at(4, 6));
    const foe = enemy(shoved, "dummy", at(5, 6));
    crate(shoved, "crate1", at(6, 6));
    let pushed: ZoneState | null = null;
    for (let seed = 1; seed < 40 && !pushed; seed++) {
      const step = stepZone({ ...shoved, rng: seed }, { type: "common", by: "ann", unit: "ann", what: "shove", target: foe.id });
      if (step.ok && step.events.some((e) => e.t === "shoved")) pushed = step.state;
    }
    expect(pushed).not.toBeNull();
    expect(unit(pushed!, foe.id).pos).toEqual(at(5, 6));
    // Broken, it is only splinters.
    poi(state, "crate1").cleared = true;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(unit(state, "ann").pos).toEqual(at(6, 6));
  });

  it("always takes a hero's blow: no roll, no fight, no Focus spent, and the damage comes off", () => {
    const state = beside("qa_paladin", 60);
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1", focus: true }, events);
    const [hit] = hits(events, "crate1");
    expect(hit).toMatchObject({ actor: "ann", what: "smite" });
    expect(hit.amount).toBeGreaterThan(0);
    expect(poi(next, "crate1").hp).toBe(60 - hit.amount);
    expect(events.some((e) => e.t === "roll")).toBe(false);
    expect(events).toContainEqual({ t: "used", id: "ann", what: "smite", name: ABILITIES.smite.name, target: "crate1", at: undefined });
    expect(next.encounter).toBeNull();
    expect(unit(next, "ann").focus).toBe(unit(state, "ann").focus);
  });

  it("breaks at 0 and pays whoever broke it: wood, maybe gold and a find, and no XP", () => {
    let state = beside("qa_paladin", 1);
    const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(step.events).toContainEqual({ t: "crate_hit", poi: "crate1", actor: "ann", amount: 1, what: "smite" });
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "ann" });
    expect(poi(state, "crate1")).toMatchObject({ cleared: true, hp: 0 });
    expect(step.effects).toHaveLength(1);
    const grant = step.effects[0];
    expect(grant).toMatchObject({ type: "grant", heroId: "ann", xp: 0 });
    expect(grant.resources.wood).toBeGreaterThanOrEqual(CRATE_PAY.wood[0]);
    expect(grant.item).toBeUndefined();
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann" && e.xp === 0)).toBe(true);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" })).toMatch(/broken already/);

    // Over many crates: always wood, often gold, now and then a potion or a torch, in the pack at once.
    const found = { gold: 0, potion: 0, torch: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const fresh = beside("qa_paladin", 1);
      fresh.rng = seed;
      const one = stepZone(fresh, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" });
      if (!one.ok) throw new Error(one.error);
      const g = one.effects[0];
      const wood = g.resources.wood ?? 0;
      expect(wood).toBeGreaterThanOrEqual(CRATE_PAY.wood[0]);
      expect(wood).toBeLessThanOrEqual(CRATE_PAY.wood[1]);
      if (g.gold) {
        found.gold += 1;
        expect(g.gold).toBeGreaterThanOrEqual(CRATE_PAY.gold[0]);
        expect(g.gold).toBeLessThanOrEqual(CRATE_PAY.gold[1]);
      }
      if (g.items?.healing) found.potion += 1;
      if (g.items?.torch) found.torch += 1;
      expect(unit(one.state, "ann").items.healing ?? 0).toBe((unit(fresh, "ann").items.healing ?? 0) + (g.items?.healing ?? 0));
    }
    expect(found.gold).toBeGreaterThan(80);
    expect(found.potion).toBeGreaterThan(5);
    expect(found.potion).toBeLessThan(60);
    expect(found.torch).toBeGreaterThan(5);
  });

  it("needs a melee blow from beside it, and a shot or a spell from in range with a clear line", () => {
    const state = board(tileEdit(at(7, 6), { biome: "rock" }));
    hero(state, "ann", "qa_paladin", at(4, 6));
    const rogue = hero(state, "bo", "refactor_rogue", at(10, 6));
    crate(state, "crate1", at(6, 6));
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" })).toMatch(/next to it/);
    expect(fails(state, { type: "use", by: "bo", unit: "bo", ability: "aimed_shot", target: "crate1" })).toMatch(/no clear line/);
    rogue.pos = at(6, 9);
    const events: ZoneEvent[] = [];
    must(state, { type: "use", by: "bo", unit: "bo", ability: "aimed_shot", target: "crate1" }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "nothing" })).toMatch(/Pick an enemy/);
  });

  it("is caught by a sweep all round, a blast and a thrown bomb", () => {
    // A sweep with nothing but a crate beside you still swings.
    let state = beside("qa_paladin", 60);
    unit(state, "ann").abilities = ["cleave"];
    let events: ZoneEvent[] = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "cleave" }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    poi(state, "crate1").pos = at(9, 9);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "cleave" })).toMatch(/No enemy is next to you/);

    state = board();
    const mage = hero(state, "ann", "devops_mage", at(3, 6));
    mage.abilities = ["thunderhead"];
    crate(state, "crate1", at(6, 6), 60);
    crate(state, "crate2", at(7, 6), 60);
    crate(state, "crate3", at(9, 6), 60);
    events = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "thunderhead", at: at(6, 6) }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    expect(hits(events, "crate2")).toHaveLength(1);
    expect(hits(events, "crate3")).toHaveLength(0);
    // The blast's one roll, all of it: a crate makes no save.
    expect(hits(events, "crate1")[0].amount).toBe(hits(events, "crate2")[0].amount);

    // Acid eats into it; a poison flask, which does no harm as it lands, leaves it be.
    unit(state, "ann").items.acid = 1;
    events = [];
    must(state, { type: "throw", by: "ann", unit: "ann", item: "acid", at: at(6, 6) }, events);
    expect(hits(events, "crate1").map((h) => h.what)).toEqual(["throw:acid"]);
    events = [];
    must(state, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(6, 6) }, events);
    expect(hits(events, "crate1")).toEqual([]);
  });

  it("burns in fire: as it takes hold, and again each round it lasts, in a fight or out of one", () => {
    // A fire bomb: the blast, then the flames under it.
    let state = board();
    hero(state, "ann", "devops_mage", at(3, 6));
    crate(state, "crate1", at(6, 6), 60);
    let events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(6, 6) }, events);
    expect(hits(events, "crate1").map((h) => h.what)).toEqual(["throw:fire", "fire"]);
    expect(hits(events, "crate1")[1].actor).toBe("ann");

    // In a fight it burns on at the turn of each round.
    let fight = duel("dummy").state;
    crate(fight, "crate9", at(6, 9), 60);
    fight = paint(fight, "fire", [at(6, 9)]);
    expect(poi(fight, "crate9").hp).toBeLessThan(60);
    const after = poi(fight, "crate9").hp!;
    events = [];
    fight = must(fight, { type: "end_turn", by: "ann", unit: "ann" }, events);
    expect(events.some((e) => e.t === "round")).toBe(true);
    expect(hits(events, "crate9")).toHaveLength(1);
    expect(poi(fight, "crate9").hp).toBe(after - hits(events, "crate9")[0].amount);

    // Out of a fight, each round of time that passes burns it again, and its breaker is whoever started the fire.
    state = must(state, { type: "time", now: 1_000_000 });
    const before = poi(state, "crate1").hp!;
    events = [];
    state = must(state, { type: "time", now: 1_000_000 + 2 * EXPLORE_ROUND_MS }, events);
    expect(hits(events, "crate1").map((h) => [h.what, h.actor])).toEqual([["fire", "ann"], ["fire", "ann"]]);
    expect(poi(state, "crate1").hp).toBe(before - hits(events, "crate1").reduce((n, h) => n + h.amount, 0));
  });

  it("pays the player whose stand-in broke it, and nobody for a fire no hero started", () => {
    const state = board();
    hero(state, "ann", "qa_paladin", at(2, 2));
    const helper = hero(state, "s1", "qa_paladin", at(5, 6));
    helper.controller = "ann";
    crate(state, "crate1", at(6, 6), 1);
    const step = stepZone(state, { type: "use", by: "ann", unit: "s1", ability: "smite", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "s1" });
    expect(step.effects.map((e) => e.heroId)).toEqual(["ann"]);

    const burnt = board();
    hero(burnt, "ann", "qa_paladin", at(2, 2));
    crate(burnt, "crate1", at(6, 6), 1);
    const fire = stepZone(burnt, { type: "dev", by: "ann", dev: { op: "paint", kind: "fire", hexes: [at(6, 6)] } });
    if (!fire.ok) throw new Error(fire.error);
    expect(fire.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: null });
    expect(fire.effects).toEqual([]);
  });

  it("is broken with a hero's own blow when simply clicked: by hand from beside it, else a shot or a spell that reaches", () => {
    const state = board();
    const ann = hero(state, "ann", "qa_paladin", at(5, 6));
    const bo = hero(state, "bo", "devops_mage", at(10, 6));
    crate(state, "crate1", at(6, 6));
    expect(crateBlow(state, ann, "crate1")).toBe("smite");
    expect(crateBlow(state, bo, "crate1")).toBe("firebolt");
    ann.pos = at(3, 6);
    expect(crateBlow(state, ann, "crate1")).toBeNull();
    // A blow that is not ready yet is passed over.
    bo.cooldowns.firebolt = 1;
    bo.abilities = ["firebolt", "hex_bolt"];
    expect(crateBlow(state, bo, "crate1")).toBe("hex_bolt");
  });

  it("can be struck, shot and bombed out of a fight: no fight starts, nothing is spent, and it pays at once", () => {
    // A band stands close by, not yet roused: only an attack that reaches one of them starts a fight.
    let state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "refactor_rogue", at(4, 9));
    const mage = hero(state, "cy", "devops_mage", at(3, 3));
    mage.abilities = ["thunderhead"];
    mage.items = { ...mage.items, fire: 2 };
    const foe = enemy(state, "dummy", at(10, 6));
    crate(state, "crate1", at(6, 6), 1);
    crate(state, "crate2", at(6, 9), 1);
    crate(state, "crate3", at(7, 3), 60);
    crate(state, "crate4", at(9, 6), 60);
    const quiet = (s: ZoneState) => {
      expect(s.encounter).toBeNull();
      expect(s.groups.g1.alerted).toBe(false);
    };

    // A blow by hand: it breaks, and what was in it is paid there and then.
    let step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    quiet(state);
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "ann" });
    expect(step.effects).toMatchObject([{ type: "grant", heroId: "ann", xp: 0 }]);
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann")).toBe(true);

    // A shot from across the chamber.
    step = stepZone(state, { type: "use", by: "bo", unit: "bo", ability: "aimed_shot", target: "crate2" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    quiet(state);
    expect(step.effects.map((e) => e.heroId)).toEqual(["bo"]);

    // A bomb thrown, and a blast with a wait on it used twice running: out of a fight neither Action nor wait counts.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "cy", unit: "cy", item: "fire", at: at(7, 3) }, events);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "thunderhead", at: at(7, 3) }, events);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "thunderhead", at: at(7, 3) }, events);
    quiet(state);
    expect(hits(events, "crate3").map((h) => h.what)).toEqual(["throw:fire", "fire", "thunderhead", "thunderhead"]);
    expect(unit(state, "cy").cooldowns).toEqual({});

    // A blast that catches the band as well as a crate: that one starts a fight, with the band that was hit.
    const both: ZoneEvent[] = [];
    unit(state, "cy").pos = at(5, 4);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "thunderhead", at: at(9, 6) }, both);
    expect(hits(both, "crate4")).toHaveLength(1);
    expect(state.groups.g1.alerted).toBe(true);
    expect(state.encounter?.order).toContain(foe.id);
  });

  it("costs the Action in a fight", () => {
    let { state } = duel("dummy");
    crate(state, "crate1", at(5, 7), 60);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" });
    expect(state.encounter!.budgets.ann.action).toBe(false);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "smite", target: "crate1" })).toMatch(/Action/);
  });

  it("keeps a hero arriving off one", () => {
    let state = board();
    // Every hex round the start but one has a crate on it.
    const around = hexNeighbors(state.start, state.map.grid);
    around.slice(1).forEach((p, i) => crate(state, `crate${i + 1}`, p));
    crate(state, "crate0", state.start);
    state = must(state, { type: "join", hero: standInHero("qa_paladin", "ann", 1)! });
    expect(unit(state, "ann").pos).toEqual(around[0]);
  });
});

// ---------- a hero's sheet ----------

describe("a hero's sheet", () => {
  it("is read again when they come back in different gear, but not in the middle of a fight", () => {
    const changed = { ...standInHero("qa_paladin", "ann", 1)!, armor: 9 };
    let state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    state = must(state, { type: "join", hero: changed });
    expect(unit(state, "ann").armor).toBe(9);

    const fight = duel().state;
    const before = unit(fight, "ann").armor;
    expect(unit(must(fight, { type: "join", hero: changed }), "ann").armor).toBe(before);
  });
});

// ---------- what a hero carries ----------

describe("what a hero carries", () => {
  it("is what their pack holds when they walk in, and the starting kit for one with no pack", () => {
    let state = board();
    state = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, items: { healing: 5 } } });
    expect(unit(state, "ann").items).toEqual({ healing: 5 });
    state = must(state, { type: "join", hero: standInHero("devops_mage", "bo", 1)! });
    expect(unit(state, "bo").items).toEqual({ healing: 2, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 });
  });

  it("follows the pack when the server says what it holds now, even in a fight", () => {
    const { state } = duel();
    const next = must(state, { type: "stock", unit: "ann", items: { healing: 1, fire: 0, nonsense: 4 } as never });
    expect(unit(next, "ann").items).toEqual({ healing: 1 });
    // And coming back mid-fight keeps the gear but takes the pack's count.
    const back = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, armor: 9, items: { poison: 3 } } });
    expect(unit(back, "ann").items).toEqual({ poison: 3 });
    expect(unit(back, "ann").armor).toBe(unit(state, "ann").armor);
  });

  it("is topped up to the starting kit by the dev restock, and never cut down", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(5, 6));
    ann.items = { healing: 7, poison: 0 };
    state = must(state, { type: "dev", by: "ann", dev: { op: "heal" } });
    expect(unit(state, "ann").items).toEqual({ healing: 7, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 });
  });
});

// ---------- a troll ----------

describe("a troll", () => {
  it("grows back at the start of each of its turns, unless it is burning", () => {
    const { state, foe } = duel("troll");
    unit(state, foe).hp = 5;
    const events: ZoneEvent[] = [];
    const healed = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    expect(unit(healed, foe).hp).toBe(5 + ENEMIES.troll.regen!.amount);
    expect(events).toContainEqual({ t: "heal", actor: foe, target: foe, amount: ENEMIES.troll.regen!.amount, what: "Regenerate" });

    unit(state, foe).conditions.push({ kind: "burning", rounds: 3 });
    const lit = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    expect(unit(lit, foe).hp).toBeLessThan(5);
  });
});

describe("the Paladin's class abilities", () => {
  /**
   * A Paladin (ann) and two crewmates in a fight with a dummy: bo two hexes from ann, cy three. Ann's turn.
   * `spare` is another hex beside ann, left empty.
   */
  function party() {
    let state = board();
    state.aiOff = true;
    const annAt = at(5, 6);
    const dummyAt = at(6, 6);
    const [spare] = hexNeighbors(annAt, state.map.grid).filter((p) => !sameHexes(p, dummyAt));
    const ann = hero(state, "ann", "qa_paladin", annAt);
    ann.abilities = ["beacon_aura", "healing_aura", "branding_strike", "stoke_the_fire", "bolster", "show_the_way"];
    hero(state, "bo", "refactor_rogue", at(3, 6));
    hero(state, "cy", "devops_mage", at(2, 6));
    const dummy = enemy(state, "dummy", dummyAt);
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    // bo at the edge of an aura's reach, cy just past it.
    expect(hexDistance(unit(state, "ann").pos, unit(state, "bo").pos)).toBe(AURAS.range);
    expect(hexDistance(unit(state, "ann").pos, unit(state, "cy").pos)).toBe(AURAS.range + 1);
    expect(hexDistance(unit(state, "ann").pos, dummy.pos)).toBe(1);
    return { state, dummy: dummy.id, spare };
  }
  /** Everyone sharing ann's turn ends it (conditions run down as a shared turn ends, not as each one in it does). */
  function endShared(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
    for (const id of [...state.encounter!.acting]) if (!state.encounter!.done.includes(id) && !unit(state, id).down) state = must(state, { type: "end_turn", by: id, unit: id }, sink);
    return state;
  }
  /** On to ann's next turn. */
  function nextTurn(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
    state = endShared(state, sink);
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" }, sink);
    return state;
  }
  const sameHexes = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
  const lasts = (state: ZoneState, kind: string) => unit(state, "ann").conditions.find((c) => c.kind === kind)?.rounds;

  it("are all in the Paladin's pool", () => {
    expect(poolFor("qa_paladin").map((e) => e.id)).toEqual(["beacon_aura", "healing_aura", "branding_strike", "stoke_the_fire", "bolster", "show_the_way"]);
  });

  it("Beacon Aura: a Bonus action that gives the Paladin and allies within 2 hexes advantage, not anyone further off", () => {
    let { state, dummy } = party();
    const foe = () => unit(state, dummy);
    expect(attackContext(state, unit(state, "bo"), foe(), { melee: true }).adv).toBe(0);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "beacon_aura" });
    expect(state.encounter!.budgets.ann).toMatchObject({ bonus: false, action: true });
    const bo = attackContext(state, unit(state, "bo"), foe(), { melee: true });
    expect(bo.adv).toBe(1);
    expect(bo.notes.join()).toMatch(/Beacon/);
    const ann = attackContext(state, unit(state, "ann"), foe(), { melee: true });
    expect(ann.adv).toBe(1);
    expect(ann.notes.join()).toMatch(/your Beacon/);
    expect(attackContext(state, unit(state, "cy"), foe(), { melee: false }).adv).toBe(0);
    expect(bo.notes.join()).toMatch(/an ally's Beacon/);
    // Enemies beside the Paladin get nothing from it.
    expect(attackContext(state, foe(), unit(state, "ann"), { melee: true }).adv).toBe(0);
  });

  it("Beacon Aura: lights the dark around the Paladin while it lasts, and lasts 4 of the Paladin's turns after this one", () => {
    let { state } = party();
    state.options = { ...state.options, biome: "caves" };
    const near = hexNeighbors(unit(state, "ann").pos, state.map.grid)[0];
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "beacon_aura" });
    expect(litHexes(state)!.has(posKey(near))).toBe(true);
    for (let turn = 1; turn <= 4; turn++) {
      state = nextTurn(state);
      expect(lasts(state, "beacon"), `turn ${turn}`).toBeGreaterThan(0);
    }
    state = endShared(state);
    expect(lasts(state, "beacon")).toBeUndefined();
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
  });

  it("Healing Aura: heals the Paladin and allies within 2 hexes at the start of each of their next 4 turns", () => {
    let { state } = party();
    for (const id of ["ann", "bo", "cy"]) unit(state, id).hp = 1;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "healing_aura" });
    expect(state.encounter!.budgets.ann.bonus).toBe(false);
    // Nothing on the turn it is put up.
    expect(unit(state, "ann").hp).toBe(1);
    const events: ZoneEvent[] = [];
    for (let turn = 0; turn < 6; turn++) state = nextTurn(state, events);
    const healed = (id: string) => events.filter((e) => e.t === "heal" && e.what === "healing_aura" && e.target === id);
    expect(healed("ann")).toHaveLength(4);
    expect(healed("bo")).toHaveLength(4);
    expect(healed("cy")).toHaveLength(0);
    for (const e of healed("ann")) if (e.t === "heal") expect(e.amount).toBeGreaterThanOrEqual(AURAS.heal.plus + 1);
    expect(unit(state, "cy").hp).toBe(1);
  });

  it("Healing Aura: does not get a fallen ally up", () => {
    let { state } = party();
    Object.assign(unit(state, "bo"), { hp: 0, down: true });
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "healing_aura" });
    state = nextTurn(state);
    expect(unit(state, "bo").down).toBe(true);
  });

  it("Branding Strike: an Action blow that sets what it hits Burning, and needs a rest after", () => {
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "branding_strike", target: dummy }, events);
      const hit = events.some((e) => e.t === "hit" && e.target === dummy);
      if (hit) hits++;
      expect(unit(state, dummy).conditions.some((c) => c.kind === "burning")).toBe(hit);
      expect(state.encounter!.budgets.ann.action).toBe(false);
      expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "branding_strike", target: dummy })).toMatch(/not ready/);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("Branding Strike: hits harder than a Smite", () => {
    expect(ABILITIES.branding_strike.damage!).toBeGreaterThan(ABILITIES.smite.damage!);
  });

  it("Stoke the Fire: strikes every enemy beside the Paladin and sets the ones it hits Burning, and nothing further off", () => {
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy, spare } = party();
      const second = enemy(state, "dummy", spare).id;
      const far = enemy(state, "dummy", at(8, 6)).id;
      expect(hexDistance(unit(state, "ann").pos, unit(state, second).pos)).toBe(1);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" }, events);
      for (const id of [dummy, second]) {
        const hit = events.some((e) => e.t === "hit" && e.target === id);
        if (hit) hits++;
        expect(unit(state, id).conditions.some((c) => c.kind === "burning"), `seed ${seed} ${id}`).toBe(hit);
      }
      expect(events.some((e) => (e.t === "roll" && e.roll.target === far) || (e.t === "hit" && e.target === far))).toBe(false);
      expect(unit(state, far).conditions).toEqual([]);
    }
    expect(hits).toBeGreaterThan(0);
  });

  const shieldOf = (state: ZoneState, id: string) => unit(state, id).conditions.find((c) => c.kind === "bolstered")?.amount;

  it("Bolster: an Action that shields the Paladin and allies within 2 hexes, not anyone further off", () => {
    let { state } = party();
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" }, events);
    expect(state.encounter!.budgets.ann).toMatchObject({ action: false, bonus: true });
    const size = BOLSTER.shield + unit(state, "ann").level;
    // The event says how big the shield is, for the bars to show it as the fight is played out.
    expect(events.filter((e) => e.t === "condition" && e.kind === "bolstered").map((e) => e.t === "condition" && [e.target, e.amount])).toEqual([["ann", size], ["bo", size]]);
    expect(shieldOf(state, "ann")).toBe(size);
    expect(shieldOf(state, "bo")).toBe(size);
    expect(shieldOf(state, "cy")).toBeUndefined();
    expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "bolster" })).toMatch(/not ready/);
  });

  it("Bolster: the shield takes a blow's damage before HP, and is gone once spent", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" });
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state: structuredClone(state), rng: makeRng(3), events, effects: [] };
    const bo = unit(ctx.state, "bo");
    const hp = bo.hp;
    const size = shieldOf(ctx.state, "bo")!;
    expect(damage(ctx, bo, size - 3, { actor: null, what: "test" })).toBe(0);
    expect(bo.hp).toBe(hp);
    expect(shieldOf(ctx.state, "bo")).toBe(3);
    expect(damage(ctx, bo, 5, { actor: null, what: "test" })).toBe(2);
    expect(bo.hp).toBe(hp - 2);
    expect(shieldOf(ctx.state, "bo")).toBeUndefined();
    expect(events.filter((e) => e.t === "hit").map((e) => e.t === "hit" && [e.amount, e.blocked])).toEqual([[0, size - 3], [2, 3]]);
  });

  it("Shield Wall: guards the Paladin and gives them alone a shield through their next turn, and heals nothing", () => {
    let { state } = party();
    unit(state, "ann").abilities.push("shield_wall");
    unit(state, "ann").hp = 5;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "shield_wall" }, events);
    expect(state.encounter!.budgets.ann).toMatchObject({ action: true, bonus: false });
    expect(unit(state, "ann").hp).toBe(5);
    expect(events.some((e) => e.t === "heal")).toBe(false);
    expect(lasts(state, "guarded")).toBeGreaterThan(0);
    expect(shieldOf(state, "ann")).toBe(SHIELD_WALL.shield + unit(state, "ann").level);
    expect(shieldOf(state, "bo")).toBeUndefined();
    state = nextTurn(state);
    expect(shieldOf(state, "ann")).toBeGreaterThan(0);
    state = endShared(state);
    expect(shieldOf(state, "ann")).toBeUndefined();
  });

  it("Bolster: wears off after 3 of the bearer's turns", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" });
    for (let turn = 1; turn <= BOLSTER.rounds; turn++) {
      state = nextTurn(state);
      expect(lasts(state, "bolstered"), `turn ${turn}`).toBeGreaterThan(0);
    }
    state = endShared(state);
    expect(lasts(state, "bolstered")).toBeUndefined();
  });

  it("Show the Way: lifts every harmful condition off an ally, and leaves the good ones", () => {
    let { state } = party();
    const bo = unit(state, "bo");
    bo.conditions = (["burning", "poisoned", "slowed", "exposed", "hasted"] as const).map((kind) => ({ kind, rounds: 3 }));
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    expect(unit(state, "bo").conditions.map((c) => c.kind)).toEqual(["hasted"]);
    expect(state.encounter!.budgets.ann.action).toBe(false);
  });

  it("Show the Way: heals the ally a little, less than a Mend", () => {
    let { state } = party();
    unit(state, "bo").hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" }, events);
    expect(unit(state, "bo").hp).toBeGreaterThan(1);
    expect(events.some((e) => e.t === "heal" && e.target === "bo" && e.what === "show_the_way")).toBe(true);
    expect(ABILITIES.show_the_way.heal!).toBeLessThan(ABILITIES.mend.heal!);
  });

  it("Show the Way: clears the fire, poison, oil, ice and slime off the way you would walk, but not water, nor ground off it", () => {
    let { state } = party();
    const annPos = unit(state, "ann").pos;
    const boPos = unit(state, "bo").pos;
    // The straight way is barred: the walk goes round.
    const between = at(4, 6);
    expect(hexDistance(annPos, between) + hexDistance(between, boPos)).toBe(hexDistance(annPos, boPos));
    enemy(state, "dummy", between);
    const way = wayBetween(state, unit(state, "ann"), boPos);
    expect(way).toHaveLength(4);
    expect(way.some((p) => sameHexes(p, between))).toBe(false);
    expect(way[0]).toEqual(annPos);
    expect(way[3]).toEqual(boPos);
    const lay = (pos: HexPos, kind: SurfaceKind) => (state.surfaces[posKey(pos)] = { kind, rounds: 5, by: null });
    lay(way[0], "oil");
    lay(way[1], "fire");
    lay(way[2], "slime");
    lay(way[3], "ice");
    lay(between, "poison");
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    for (const p of way) expect(state.surfaces[posKey(p)], posKey(p)).toBeUndefined();
    expect(state.surfaces[posKey(between)].kind).toBe("poison");
    // Water is no harm, and stays.
    ({ state } = party());
    lay(at(4, 6), "water");
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    expect(state.surfaces[posKey(at(4, 6))].kind).toBe("water");
  });

  it("Show the Way: with no way on foot to the ally, clears the straight line instead", () => {
    let { state } = party();
    const annPos = unit(state, "ann").pos;
    const boPos = unit(state, "bo").pos;
    // Enemies all round bo (cy, who could be walked past, out of the way): there is no walking to them.
    unit(state, "cy").pos = at(1, 1);
    for (const p of hexNeighbors(boPos, state.map.grid)) if (!unitAt(state, p)) enemy(state, "dummy", p);
    const way = wayBetween(state, unit(state, "ann"), boPos);
    expect(way).toEqual([annPos, at(4, 6), boPos]);
    for (const p of way) state.surfaces[posKey(p)] = { kind: "fire", rounds: 5, by: null };
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    for (const p of way) expect(state.surfaces[posKey(p)], posKey(p)).toBeUndefined();
  });

  it("Show the Way: takes the way over oil and slime, not round them", () => {
    const { state } = party();
    for (const p of [at(4, 6), ...hexNeighbors(at(4, 6), state.map.grid)]) state.surfaces[posKey(p)] = { kind: "slime", rounds: 5, by: null };
    expect(wayBetween(state, unit(state, "ann"), unit(state, "bo").pos)).toHaveLength(3);
  });
});

describe("the Mage's class abilities", () => {
  /**
   * A Mage (ann) and a crewmate (bo) two hexes off along the row, in a fight with a dummy far down it. Ann's turn.
   * Everyone stands on row 6, so hexes along it are in a straight line.
   */
  function party(abilities = ["soothing_rain", "chain_lightning", "roar_of_thunder", "trade_winds", "tidal_wave"]) {
    let state = board();
    state.aiOff = true;
    const ann = hero(state, "ann", "devops_mage", at(5, 6));
    ann.abilities = abilities;
    hero(state, "bo", "qa_paladin", at(3, 6));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  function endShared(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
    for (const id of [...state.encounter!.acting]) if (!state.encounter!.done.includes(id) && !unit(state, id).down) state = must(state, { type: "end_turn", by: id, unit: id }, sink);
    return state;
  }
  function nextTurn(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
    state = endShared(state, sink);
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" }, sink);
    return state;
  }
  /** Put a dummy down somewhere, in the fight. */
  function addDummy(state: ZoneState, pos: HexPos): string {
    const e = enemy(state, "dummy", pos);
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = 0;
    return e.id;
  }
  const healsOf = (events: ZoneEvent[], id: string) => events.filter((e) => e.t === "heal" && e.what === "soothing_rain" && e.target === id).length;
  const has = (state: ZoneState, id: string, kind: string) => unit(state, id).conditions.some((c) => c.kind === kind);

  it("are all in the Mage's pool", () => {
    expect(poolFor("devops_mage").map((e) => e.id)).toEqual(["soothing_rain", "chain_lightning", "roar_of_thunder", "trade_winds", "tidal_wave"]);
  });

  it("Soothing Rain: a 3-hex cloud that lays water, and heals the caster's side under it as it comes, not the enemy", () => {
    let { state } = party();
    const foe = addDummy(state, at(3, 7));
    for (const id of ["ann", "bo", foe]) unit(state, id).hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) }, events);
    const area = abilityArea(state, unit(state, "ann"), "soothing_rain", at(3, 6));
    expect(area).toHaveLength(3);
    for (const p of area) for (const q of area) expect(hexDistance(p, q)).toBeLessThanOrEqual(1);
    for (const p of area) expect(state.surfaces[posKey(p)]?.kind).toBe("water");
    expect(state.weather).toHaveLength(1);
    expect(healsOf(events, "bo")).toBe(1);
    expect(healsOf(events, "ann")).toBe(0);
    expect(healsOf(events, foe)).toBe(0);
    expect(state.encounter!.budgets.ann.action).toBe(false);
  });

  it("Soothing Rain: heals as a turn starts in it, and once a turn for walking in, however often", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) });
    const area = state.weather![0].hexes;
    const out = at(3, 4);
    expect(area.some((p) => hexDistance(p, out) === 0)).toBe(false);
    unit(state, "bo").hp = 1;
    // Ann walks in and out and in again on her turn: one heal.
    unit(state, "ann").hp = 1;
    const walked: ZoneEvent[] = [];
    const inside = area.find((p) => !state.units.some((u) => u.pos.q === p.q && u.pos.r === p.r))!;
    state.encounter!.budgets.ann.move = 99;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: inside }, walked);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, walked);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: inside }, walked);
    expect(healsOf(walked, "ann")).toBe(1);
    // On the next turn, bo (still standing in it) is healed as it starts.
    const turn: ZoneEvent[] = [];
    state = nextTurn(state, turn);
    expect(healsOf(turn, "bo")).toBe(1);
  });

  it("Soothing Rain: puts its water back at the start of every turn, and clears after 3 rounds", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) });
    const area = state.weather![0].hexes;
    for (const p of area) delete state.surfaces[posKey(p)];
    state = nextTurn(state);
    for (const p of area) expect(state.surfaces[posKey(p)]?.kind).toBe("water");
    for (let round = 1; round <= 3; round++) {
      expect(state.weather, `round ${round}`).toHaveLength(1);
      state = nextTurn(state);
    }
    expect(state.weather).toHaveLength(0);
  });

  it("Chain Lightning: leaps to the nearest enemy within 2 hexes it has not struck, on and on, each struck once", () => {
    for (let seed = 1; seed <= 6; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      const chain = [at(7, 6), at(9, 6), at(10, 6), at(8, 7)].map((p) => addDummy(state, p));
      // 3 hexes from the nearest of the chain: never reached. (The first dummy is further still.)
      const apart = addDummy(state, at(13, 8));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "chain_lightning", target: chain[0] }, events);
      const struck = events.filter((e) => e.t === "roll" && e.roll.kind === "attack").map((e) => e.t === "roll" && e.roll.target);
      expect(new Set(struck).size).toBe(struck.length);
      expect(new Set(struck)).toEqual(new Set(chain));
      expect(struck).not.toContain(apart);
      expect(struck).not.toContain(dummy);
    }
  });

  it("Roar of Thunder: never misses, Stuns, and throws the enemy a hex back", () => {
    for (let seed = 1; seed <= 6; seed++) {
      let { state } = party();
      state.rng = seed;
      const foe = addDummy(state, at(7, 6));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "roar_of_thunder", target: foe }, events);
      expect(events.some((e) => e.t === "roll" && e.roll.kind === "attack")).toBe(false);
      expect(has(state, foe, "stunned")).toBe(true);
      expect(unit(state, foe).pos).toEqual(at(8, 6));
      expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "roar_of_thunder", target: foe })).toMatch(/not ready/);
    }
  });

  it("Trade Winds: 7 hexes that Haste the caster's side and Slow the enemy in them", () => {
    let { state } = party();
    const foe = addDummy(state, at(4, 6));
    const outside = addDummy(state, at(9, 6));
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "trade_winds", at: at(3, 6) });
    expect(state.weather![0].hexes).toHaveLength(7);
    expect(has(state, "bo", "hasted")).toBe(true);
    expect(has(state, foe, "slowed")).toBe(true);
    expect(has(state, outside, "slowed")).toBe(false);
    expect(has(state, "ann", "hasted")).toBe(false);
  });

  it("Trade Winds: a turn started in them goes twice as far, or half, and walking in on your turn counts too", () => {
    let { state } = party();
    const before = state.encounter!.budgets.bo.move;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "trade_winds", at: at(3, 6) });
    // Bo shares ann's turn: Hasted now, the move doubles at once.
    expect(state.encounter!.budgets.bo.move).toBe(before * 2);
    state = nextTurn(state);
    expect(has(state, "bo", "hasted")).toBe(true);
    // Ann walks into the winds on her turn.
    state.encounter!.budgets.ann.move = 3;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(4, 6) });
    expect(has(state, "ann", "hasted")).toBe(true);
  });

  it("Tidal Wave: strikes only enemies in the line, and sweeps those that fail to brace to the far end", () => {
    let swept = 0;
    for (let seed = 1; seed <= 10; seed++) {
      let { state } = party();
      state.rng = seed;
      const near = addDummy(state, at(6, 6));
      const far = addDummy(state, at(8, 6));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "tidal_wave", at: at(6, 6) }, events);
      const saved = (id: string) => events.some((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === id && e.roll.ok);
      // The line runs from at(6,6) to at(10,6). The far one goes first, to the end; the near one as far as it can get.
      expect(unit(state, far).pos).toEqual(saved(far) ? at(8, 6) : at(10, 6));
      if (!saved(near)) expect(unit(state, near).pos).toEqual(saved(far) ? at(7, 6) : at(9, 6));
      else expect(unit(state, near).pos).toEqual(at(6, 6));
      swept += [near, far].filter((id) => !saved(id)).length;
      expect(events.some((e) => e.t === "hit" && e.target === "bo")).toBe(false);
      // The line is left under water, and whoever is on it soaked.
      for (let col = 6; col <= 10; col++) expect(state.surfaces[posKey(at(col, 6))]?.kind, `col ${col}`).toBe("water");
      for (const id of [near, far]) expect(unit(state, id).conditions.some((c) => c.kind === "wet")).toBe(true);
    }
    expect(swept).toBeGreaterThan(0);
  });
});

describe("the Rogue's class abilities", () => {
  const ALL = ["smugglers_route", "sneak", "pickpocket", "tactical_retreat", "contraband"];
  /**
   * A Rogue (ann) with a crewmate (bo) beside her and another (cy) further off, in a fight with a dummy far down
   * row 6. Ann's turn. `edit` changes the board first.
   */
  function party(edit?: (tile: Tile) => void) {
    let state = board(edit);
    state.aiOff = true;
    const ann = hero(state, "ann", "refactor_rogue", at(5, 6));
    ann.abilities = [...ann.abilities, ...ALL];
    hero(state, "bo", "qa_paladin", at(4, 6));
    hero(state, "cy", "devops_mage", at(2, 8));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  function addFoe(state: ZoneState, pos: HexPos, kind = "dummy"): string {
    const e = enemy(state, kind, pos);
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = 0;
    return e.id;
  }
  function nextTurn(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
    for (const id of [...state.encounter!.acting]) if (!state.encounter!.done.includes(id) && !unit(state, id).down) state = must(state, { type: "end_turn", by: id, unit: id }, sink);
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" }, sink);
    return state;
  }
  const step = (state: ZoneState, action: ZoneAction) => {
    const s = stepZone(state, action);
    if (!s.ok) throw new Error(s.error);
    return s;
  };
  const has = (state: ZoneState, id: string, kind: string) => unit(state, id).conditions.some((c) => c.kind === kind);
  const use = (ability: string, aim: { target?: string; at?: HexPos } = {}): ZoneAction => ({ type: "use", by: "ann", unit: "ann", ability, ...aim });
  const rock = (...hexes: HexPos[]) => (t: Tile) => { if (hexes.some((p) => p.q === t.q && p.r === t.r)) t.biome = "rock"; };

  it("are all in the Rogue's pool", () => {
    expect(poolFor("refactor_rogue").map((e) => e.id)).toEqual(ALL);
  });

  it("Smuggler's Route: a Bonus action to a hex up to 4 off, through a wall, spending no movement", () => {
    let { state } = party(rock(at(6, 5), at(6, 6), at(6, 7)));
    const move = state.encounter!.budgets.ann.move;
    const events: ZoneEvent[] = [];
    state = must(state, use("smugglers_route", { at: at(8, 6) }), events);
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    expect(events.some((e) => e.t === "blinked" && e.id === "ann")).toBe(true);
    expect(state.encounter!.budgets.ann).toMatchObject({ move, bonus: false, action: true });
    expect(unit(state, "ann").cooldowns.smugglers_route).toBe(4);
    // Bo stayed: nobody was picked to come along.
    expect(unit(state, "bo").pos).toEqual(at(4, 6));
  });

  it("Smuggler's Route: not further than 4, nor onto rock or someone", () => {
    const { state } = party(rock(at(7, 6)));
    expect(fails(state, use("smugglers_route", { at: at(10, 6) }))).toMatch(/Too far/);
    expect(fails(state, use("smugglers_route", { at: at(7, 6) }))).toMatch(/nowhere to stand/);
    expect(fails(state, use("smugglers_route", { at: at(4, 6) }))).toMatch(/nowhere to stand/);
  });

  it("Smuggler's Route: an ally beside you comes too, to the same side of where you land, or the nearest open hex", () => {
    let { state } = party();
    state = must(state, use("smugglers_route", { target: "bo", at: at(8, 6) }));
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    expect(unit(state, "bo").pos).toEqual(at(7, 6));
    // With that side taken, the nearest open hex beside it.
    let again = party().state;
    addFoe(again, at(7, 6));
    again = must(again, use("smugglers_route", { target: "bo", at: at(8, 6) }));
    expect(hexDistance(unit(again, "bo").pos, at(8, 6))).toBe(1);
    expect(hexDistance(unit(again, "bo").pos, at(7, 6))).toBe(1);
  });

  it("Smuggler's Route: the ally has to be beside you, and there has to be room for them", () => {
    const { state } = party();
    expect(fails(state, use("smugglers_route", { target: "cy", at: at(8, 6) }))).toMatch(/beside you/);
    const boxed = party(rock(...hexNeighbors(at(8, 6), GRID))).state;
    expect(fails(boxed, use("smugglers_route", { target: "bo", at: at(8, 6) }))).toMatch(/no room/);
    // Alone, the same hex is fine.
    expect(unit(must(boxed, use("smugglers_route", { at: at(8, 6) })), "ann").pos).toEqual(at(8, 6));
  });

  it("Smuggler's Route: leaving an enemy's side draws no blow", () => {
    let { state } = party();
    addFoe(state, at(6, 6), "bandit");
    const events: ZoneEvent[] = [];
    state = must(state, use("smugglers_route", { at: at(5, 9) }), events);
    expect(events.some((e) => e.t === "reaction")).toBe(false);
  });

  it("Sneak: you and every ally beside you go Unseen for 3 turns; one further off does not", () => {
    let { state } = party();
    state = must(state, use("sneak"));
    expect(has(state, "ann", "invisible")).toBe(true);
    expect(has(state, "bo", "invisible")).toBe(true);
    expect(has(state, "cy", "invisible")).toBe(false);
    expect(state.encounter!.budgets.ann.action).toBe(false);
    // Through the 3 turns after the one it is used on (and every enemy turn between), and no further.
    for (let turn = 1; turn <= 4; turn++) {
      expect(has(state, "ann", "invisible"), `turn ${turn}`).toBe(true);
      state = nextTurn(state);
    }
    expect(has(state, "ann", "invisible")).toBe(false);
  });

  it("Sneak: an enemy will not attack the Unseen, nor strike at them as they walk off", () => {
    let { state } = party();
    const bandit = addFoe(state, at(6, 6), "bandit");
    state = must(state, use("sneak"));
    state.encounter!.budgets.ann.move = 20;
    const walked: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 4) }, walked);
    expect(walked.some((e) => e.t === "reaction")).toBe(false);
    // The bandit's turn: it has only cy to go for.
    state.aiOff = false;
    const turn: ZoneEvent[] = [];
    state = nextTurn(state, turn);
    const aimedAt = turn.filter((e) => e.t === "used" && e.id === bandit).map((e) => e.t === "used" && e.target);
    expect(aimedAt).not.toContain("ann");
    expect(aimedAt).not.toContain("bo");
  });

  it("Sneak: using an ability gives you away, with advantage on its roll to hit", () => {
    let { state, dummy } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    unit(state, dummy).pos = at(6, 6);
    const events: ZoneEvent[] = [];
    state = must(state, use("quick_stab", { target: dummy }), events);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll?.t === "roll" && roll.roll.adv).toBe(1);
    expect(has(state, "ann", "invisible")).toBe(false);
    expect(events.some((e) => e.t === "seen" && e.id === "ann")).toBe(true);
    // Bo, who did nothing, is still Unseen.
    expect(has(state, "bo", "invisible")).toBe(true);
  });

  it("Sneak: nobody out of a fight notices the Unseen walking by", () => {
    let state = board();
    const ann = hero(state, "ann", "refactor_rogue", at(2, 6));
    ann.conditions.push({ kind: "invisible", rounds: 3 });
    enemy(state, "bandit", at(8, 6));
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter).toBeNull();
  });

  it("Pickpocket: a Bonus action blow that, landing, pays gold equal to your level, once an enemy", () => {
    let paid = 0;
    let missed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      unit(state, "ann").level = 3;
      unit(state, dummy).pos = at(6, 6);
      const first = step(state, use("pickpocket", { target: dummy }));
      expect(first.state.encounter!.budgets.ann).toMatchObject({ bonus: false, action: true });
      const hit = first.events.some((e) => e.t === "hit" && e.target === dummy);
      const gold = first.effects.filter((e) => e.type === "grant").map((e) => e.gold);
      expect(gold).toEqual(hit ? [3] : []);
      if (!hit) {
        missed += 1;
        continue;
      }
      paid += 1;
      expect(unit(first.state, dummy).picked).toBe(true);
      // Its pockets are empty now: the next one, even landing, pays nothing.
      state = first.state;
      state.encounter!.budgets.ann.bonus = true;
      expect(step(state, use("pickpocket", { target: dummy })).effects).toEqual([]);
    }
    expect(paid).toBeGreaterThan(0);
    expect(missed).toBeGreaterThan(0);
  });

  it("Pickpocket: Unseen, it is no blow, just the gold, and you stay Unseen", () => {
    let { state, dummy } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    unit(state, dummy).pos = at(6, 6);
    const hp = unit(state, dummy).hp;
    const s = step(state, use("pickpocket", { target: dummy }));
    expect(s.events.some((e) => e.t === "roll")).toBe(false);
    expect(unit(s.state, dummy).hp).toBe(hp);
    expect(s.effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: {}, gold: 1 }]);
    expect(has(s.state, "ann", "invisible")).toBe(true);
  });

  it("Tactical Retreat: a heavy blow, then away to a hex up to 4 off if one is picked, hit or miss", () => {
    for (let seed = 1; seed <= 4; seed++) {
      let { state, dummy } = party(rock(at(6, 5), at(5, 5)));
      state.rng = seed;
      unit(state, dummy).pos = at(6, 6);
      const events: ZoneEvent[] = [];
      state = must(state, use("tactical_retreat", { target: dummy, at: at(5, 3) }), events);
      expect(events.filter((e) => e.t === "roll" && e.roll.kind === "attack")).toHaveLength(1);
      expect(unit(state, "ann").pos).toEqual(at(5, 3));
      expect(state.encounter!.budgets.ann.action).toBe(false);
    }
    // No hex picked: the blow alone.
    let { state, dummy } = party();
    unit(state, dummy).pos = at(6, 6);
    state = must(state, use("tactical_retreat", { target: dummy }));
    expect(unit(state, "ann").pos).toEqual(at(5, 6));
    expect(fails(party().state, use("tactical_retreat", { target: dummy, at: at(10, 6) }))).toBeTruthy();
  });

  it("Tactical Retreat: hits harder than a Quick Stab", () => {
    expect(ABILITIES.tactical_retreat.damage!).toBeGreaterThan(ABILITIES.quick_stab.damage!);
  });

  it("Contraband: you and an ally each get a fire bomb, thrown before any of your own, gone after 3 turns", () => {
    let { state } = party();
    unit(state, "ann").items.fire = 0;
    state = must(state, use("contraband", { target: "bo" }));
    expect(state.encounter!.budgets.ann.bonus).toBe(false);
    expect(has(state, "ann", "contraband")).toBe(true);
    expect(has(state, "bo", "contraband")).toBe(true);
    // Ann has none of her own, and can throw one all the same.
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(false);
    expect(unit(state, "ann").items.fire ?? 0).toBe(0);
    // Bo's own bomb is still in his pack after throwing the smuggled one.
    state = must(state, { type: "throw", by: "bo", unit: "bo", item: "fire", at: at(10, 7) });
    expect(unit(state, "bo").items.fire).toBe(1);
    expect(has(state, "bo", "contraband")).toBe(false);
    // Not thrown, it is gone after the 3 turns that follow.
    let later = party().state;
    later = must(later, use("contraband", { target: "ann" }));
    for (let turn = 1; turn <= 3; turn++) later = nextTurn(later);
    expect(has(later, "ann", "contraband")).toBe(true);
    later = nextTurn(later);
    expect(has(later, "ann", "contraband")).toBe(false);
  });

  it("Contraband: used on yourself, both bombs are yours", () => {
    let { state } = party();
    unit(state, "ann").items.fire = 0;
    state = must(state, use("contraband"));
    expect(has(state, "bo", "contraband")).toBe(false);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(true);
    state = nextTurn(state);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(false);
    state.encounter!.budgets.ann.action = true;
    expect(fails(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) })).toMatch(/no fire bomb/i);
  });

  it("throwing gives the Unseen away too", () => {
    let { state } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "invisible")).toBe(false);
  });
});

describe("a dev kit", () => {
  function onMap() {
    const state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "devops_mage", at(3, 6));
    return state;
  }
  const kit = (unit: string, over: Partial<{ classId: string; weapon: string; level: number; abilities: string[] }> = {}): ZoneAction => ({
    type: "dev", by: "ann", dev: { op: "kit", unit, classId: "devops_mage", weapon: "tome", level: 7, abilities: ["chain_lightning", "tidal_wave", "soothing_rain", "trade_winds"], ...over },
  });

  it("makes your hero any class, level and weapon, with as many of the class's abilities as you like", () => {
    const state = must(onMap(), kit("ann"));
    const ann = unit(state, "ann");
    expect(ann).toMatchObject({ kind: "devops_mage", level: 7, devKit: true });
    expect(ann.abilities).toEqual([...WEAPONS.tome.abilities, "chain_lightning", "tidal_wave", "soothing_rain", "trade_winds"]);
    expect(ann.outfit?.main_hand?.ref).toBe("tome");
    expect(ann.hp).toBe(ann.maxHp);
  });

  it("drops abilities that are not the class's, and refuses a weapon of another class or a hero not yours", () => {
    expect(unit(must(onMap(), kit("ann", { abilities: ["bolster", "tidal_wave"] })), "ann").abilities).not.toContain("bolster");
    expect(fails(onMap(), kit("ann", { weapon: "mace" }))).toMatch(/weapon/);
    expect(fails(onMap(), kit("bo"))).toMatch(/not one of your heroes/);
  });

  it("holds through coming back to the map", () => {
    let state = must(onMap(), kit("ann"));
    state = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, name: "ann" } });
    expect(unit(state, "ann")).toMatchObject({ kind: "devops_mage", level: 7 });
  });
});
