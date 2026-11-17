// A map's modifiers (mods.ts), the ground they leave that does not wear off,
// and the bounty a map the atlas made pays when it is cleared (loot.ts).

import { describe, expect, it } from "vitest";
import { STARTING_STATS, allHexesInGrid, hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Biome, Tile } from "../map";
import { MAX_CATCHUP_ROUNDS } from "./clock";
import { DEFAULT_ZONE_OPTIONS, ZONE_GRIDS, zoneOptions } from "./gen";
import { solid } from "./geometry";
import { EXPLORE_ROUND_MS, enemyHp, enemyMove, enemyStrikes } from "./kit";
import { bountyPay } from "./loot";
import { cleanStone, stoneChance } from "../lodestone";
import { MAX_MODS, ZONE_MODS, ZONE_MOD_IDS, cleanMods, modsOf, type ZoneModId } from "./mods";
import { diceAverage } from "./rules";
import { createZone, standInHero, stepZone } from "./zone";
import type { Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

const base = { size: "medium", biome: "meadow", groups: 2, elevation: 1, obstacles: 1, clear: 4, party: 2, level: 3 } as const;
const make = (mods: ZoneModId[], seed = "mods") => createZone("MODS", seed, zoneOptions({ ...base, mods }));
const foes = (state: ZoneState) => state.units.filter((u) => u.side === "enemy");
const SEEDS = ["mods", "a", "b", "c"];

function must(state: ZoneState, action: ZoneAction, events: ZoneEvent[] = [], effects: ZoneEffect[] = []): ZoneState {
  const step = stepZone(state, action);
  if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
  events.push(...step.events);
  effects.push(...step.effects);
  return step.state;
}

describe("a map's modifiers", () => {
  it("are made safe: the ones there are, each once, one kind of ground at most; and none leaves the options as they were", () => {
    expect(cleanMods(["hardy", "hardy", "nonsense", "smouldering", "fouled", "swift", 7])).toEqual(["hardy", "smouldering", "swift"]);
    expect(cleanMods(ZONE_MOD_IDS).length).toBe(MAX_MODS);
    expect(cleanMods("hardy")).toEqual([]);
    expect(zoneOptions({ mods: ["hardy", "nope"] }).mods).toEqual(["hardy"]);
    expect(zoneOptions({ mods: [] })).toEqual(DEFAULT_ZONE_OPTIONS);
    expect(zoneOptions({ tier: 3.4 }).tier).toBe(3);
    expect(zoneOptions({ tier: 0 }).tier).toBeUndefined();
    expect(zoneOptions({ tier: "far" }).tier).toBeUndefined();
  });

  it("add up to nothing when there are none, and each names what it changes", () => {
    expect(modsOf({})).toEqual({ obstacles: 0, elevation: 0, groups: 0, hp: 1, edge: 0, move: 0, extras: 0, pay: 0 });
    expect(modsOf({ mods: ["hardy", "savage", "swift", "numerous"] })).toMatchObject({ hp: 1.3, edge: 1, move: 1, extras: 1 });
    expect(modsOf({ mods: ["sprawling", "frozen"] })).toMatchObject({ size: "large", groups: 1, hazard: "ice" });
    for (const id of ZONE_MOD_IDS) {
      expect(ZONE_MODS[id].pay, id).toBeGreaterThan(0);
      expect(ZONE_MODS[id].blurb.length, id).toBeGreaterThan(10);
      expect(modsOf({ mods: [id] }).pay).toBe(ZONE_MODS[id].pay);
    }
  });

  it("Hardy: everything takes a third more killing, on the very same map", () => {
    for (const seed of SEEDS) {
      const plain = make([], seed);
      const hardy = make(["hardy"], seed);
      expect(hardy.map).toEqual(plain.map);
      expect(foes(hardy).map((u) => [u.kind, u.pos])).toEqual(foes(plain).map((u) => [u.kind, u.pos]));
      for (const u of foes(hardy)) {
        expect(u.maxHp).toBe(Math.round(enemyHp(u.kind, 3, 2) * 1.3));
        expect(u.hp).toBe(u.maxHp);
      }
    }
  });

  it("Savage: every attack does more and lands more often", () => {
    const more = modsOf({ mods: ["savage"] }).edge;
    for (const kind of ["wolf", "bandit", "ogre"]) {
      const plain = enemyStrikes(kind, 3, 2);
      const savage = enemyStrikes(kind, 3, 2, more);
      savage.forEach((s, i) => {
        expect(s.bonus).toBe(plain[i].bonus + 1);
        expect(diceAverage(s.dice)).toBeGreaterThan(diceAverage(plain[i].dice));
      });
    }
  });

  it("Swift: a hex more a turn, for anything that moves at all", () => {
    const more = modsOf({ mods: ["swift"] }).move;
    expect(enemyMove("wolf", more)).toBe(enemyMove("wolf") + 1);
    expect(enemyMove("ogre", more)).toBe(enemyMove("ogre") + 1);
    expect(enemyMove("dummy", more)).toBe(0);
  });

  it("Numerous: one more in every band", () => {
    for (const seed of SEEDS) {
      const plain = make([], seed);
      const many = make(["numerous"], seed);
      // Bands in the order they were set out (their ids are minted along with their members', so they differ).
      const sizes = (s: ZoneState) => Object.keys(s.groups).map((g) => foes(s).filter((u) => u.group === g).length);
      expect(sizes(many), seed).toEqual(sizes(plain).map((n) => n + 1));
    }
  });

  it("Sprawling: a large map with one more band on it", () => {
    for (const seed of SEEDS) {
      const big = make(["sprawling"], seed);
      expect(big.map.grid).toEqual(ZONE_GRIDS.large);
      expect(Object.keys(big.groups).length).toBe(base.groups + 1);
    }
  });

  it("Tangled and Craggy: more in the way, and more high ground", () => {
    const blocked = (s: ZoneState) => s.map.tiles.filter((t) => t.biome === "rock" || t.biome === "forest").length;
    const high = (s: ZoneState) => s.map.tiles.filter((t) => (t.elev ?? 0) > 0).length;
    let [plainBlocked, tangled, plainHigh, craggy] = [0, 0, 0, 0];
    for (const seed of SEEDS) {
      plainBlocked += blocked(make([], seed));
      tangled += blocked(make(["tangled"], seed));
      plainHigh += high(make([], seed));
      craggy += high(make(["craggy"], seed));
    }
    expect(tangled).toBeGreaterThan(plainBlocked * 1.3);
    expect(craggy).toBeGreaterThan(plainHigh * 1.3);
  });
});

describe("ground a modifier leaves", () => {
  const KINDS: [ZoneModId, string][] = [["smouldering", "fire"], ["fouled", "poison"], ["slick", "oil"], ["frozen", "ice"]];

  it("lies in patches of its own kind on open ground, clear of the start and of where anyone stands, on the very same map", () => {
    for (const [mod, kind] of KINDS) {
      for (const seed of SEEDS) {
        const plain = make([], seed);
        const state = make([mod], seed);
        const where = `${mod} ${seed}`;
        expect(Object.keys(plain.surfaces)).toEqual([]);
        expect(state.map, where).toEqual(plain.map);
        const patches = Object.entries(state.surfaces);
        expect(patches.length, where).toBeGreaterThan(8);
        for (const [key, s] of patches) {
          expect(s, where).toEqual({ kind, rounds: 99, by: null, lasting: true });
          const [q, r] = key.split(",").map(Number);
          const tile = state.map.tiles.find((t) => t.q === q && t.r === r)!;
          expect(solid(tile) || tile.biome === "water", where).toBe(false);
          expect(hexDistance({ q, r }, state.start), where).toBeGreaterThan(base.clear + 1);
          for (const u of foes(state)) expect(hexDistance({ q, r }, u.pos), where).toBeGreaterThan(1);
        }
      }
    }
  });

  it("does not wear off as time passes, while ground laid any other way does", () => {
    let state = make(["smouldering"]);
    const lasting = Object.keys(state.surfaces).sort();
    // A pool of poison painted on beside the start: ordinary ground, with a few rounds in it.
    const spot = { q: state.start.q + 1, r: state.start.r };
    state = must(state, { type: "dev", by: "dev", dev: { op: "paint", kind: "poison", hexes: [spot] } });
    expect(state.surfaces[posKey(spot)]).toMatchObject({ kind: "poison" });
    expect(state.surfaces[posKey(spot)].lasting).toBeUndefined();
    const T0 = 5_000_000;
    state = must(state, { type: "time", now: T0 });
    for (let i = 1; i <= 3; i++) state = must(state, { type: "time", now: T0 + i * MAX_CATCHUP_ROUNDS * EXPLORE_ROUND_MS });
    expect(state.surfaces[posKey(spot)]).toBeUndefined();
    expect(Object.keys(state.surfaces).sort()).toEqual(lasting);
    for (const s of Object.values(state.surfaces)) expect(s).toEqual({ kind: "fire", rounds: 99, by: null, lasting: true });
  });
});

// ---------- the bounty ----------

const GRID: HexGrid = { cols: 16, rows: 12 };
const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });

function board(options: Partial<ZoneState["options"]> = {}): ZoneState {
  const tiles: Tile[] = allHexesInGrid(GRID).map((p) => ({ q: p.q, r: p.r, biome: "plains" as Biome, h: 0.3, elev: 0 }));
  return { v: 1, code: "TEST", seed: "test", rng: 4242, options: { ...DEFAULT_ZONE_OPTIONS, party: 1, ...options }, map: { grid: GRID, tiles, pois: [] }, start: at(2, 6), units: [], groups: {}, surfaces: {}, encounter: null, seq: 100, aiOff: true };
}
function hero(state: ZoneState, id: string, pos: HexPos, controller?: string): Unit {
  const sheet = standInHero("qa_paladin", id, 1)!;
  const unit: Unit = { id, side: "hero", name: id, kind: "qa_paladin", level: 1, pos, hp: sheet.maxHp, maxHp: sheet.maxHp, focus: 2, maxFocus: 2, stats: STARTING_STATS.qa_paladin, armor: 0, power: 0, abilities: ["smite"], conditions: [], down: false, cooldowns: {}, items: {}, ...(controller ? { controller } : {}) };
  state.units.push(unit);
  return unit;
}
function enemy(state: ZoneState, kind: string, pos: HexPos, level = 1): Unit {
  state.groups.g1 ??= { alerted: false };
  const unit: Unit = { id: `e${++state.seq}`, side: "enemy", name: ENEMIES[kind].name, kind, level, pos, hp: ENEMIES[kind].hp, maxHp: ENEMIES[kind].hp, focus: 0, maxFocus: 0, armor: 0, power: 0, abilities: [], conditions: [], down: false, cooldowns: {}, items: {}, group: "g1", home: pos };
  state.units.push(unit);
  return unit;
}
/** Ann, a stand-in of hers, and a bandit they are fighting. Winning it is one dev action. */
function fight(options: Partial<ZoneState["options"]> = {}, level = 1): ZoneState {
  const state = board(options);
  hero(state, "ann", at(5, 6));
  hero(state, "s1", at(4, 6), "ann");
  enemy(state, "bandit", at(8, 6), level);
  return must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } });
}
const win = (state: ZoneState, events: ZoneEvent[], effects: ZoneEffect[]) => must(state, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events, effects);

describe("the bounty for clearing a map the atlas made", () => {
  it("turns up a lodestone for some and not for others, each one fit to keep; and a chart-less map never does", () => {
    let found = 0;
    const tries = 120;
    for (let i = 0; i < tries; i++) {
      const events: ZoneEvent[] = [];
      const effects: ZoneEffect[] = [];
      const start = fight({ tier: 6 });
      start.rng = i * 9973 + 11;
      win(start, events, effects);
      const paid = effects[effects.length - 1];
      const told = events.filter((e): e is Extract<ZoneEvent, { t: "spoils" }> => e.t === "spoils").pop()!;
      expect(told.stone).toEqual(paid.stone);
      if (!paid.stone) continue;
      found++;
      expect(cleanStone(paid.stone)).toEqual(paid.stone);
      expect(paid.stone.length).toBeLessThanOrEqual(2);
    }
    expect(found / tries).toBeGreaterThan(stoneChance(6) - 0.15);
    expect(found / tries).toBeLessThan(stoneChance(6) + 0.15);
    // The fight's own pay has none, and nor has a map the atlas did not make.
    const effects: ZoneEffect[] = [];
    win(fight({}), [], effects);
    expect(effects.some((e) => e.stone)).toBe(false);
  });

  it("is paid to every player's hero on it and no stand-in, once", () => {
    const events: ZoneEvent[] = [];
    const effects: ZoneEffect[] = [];
    let state = win(fight({ tier: 3 }), events, effects);
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    // The fight's own pay, then the bounty: both Ann's, neither the stand-in's.
    expect(effects.map((e) => e.heroId)).toEqual(["ann", "ann"]);
    const p = bountyPay(3, 0);
    expect(effects[1].xp).toBe(p.xp);
    expect(effects[1].gold).toBeGreaterThanOrEqual(p.gold[0]);
    expect(effects[1].gold).toBeLessThanOrEqual(p.gold[1]);
    expect(events.findIndex((e) => e.t === "bounty")).toBeGreaterThan(events.findIndex((e) => e.t === "cleared"));
    expect(state.bounty).toBe(true);

    // Something else turns up and is beaten: the map was cleared already, and pays no second bounty.
    enemy(state, "bandit", at(9, 6));
    state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } });
    const [again, more]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    win(state, again, more);
    expect(more).toHaveLength(1);
    expect(again.some((e) => e.t === "bounty")).toBe(false);
  });

  it("is nothing on a map the atlas did not make", () => {
    const events: ZoneEvent[] = [];
    const effects: ZoneEffect[] = [];
    const state = win(fight(), events, effects);
    expect(effects).toHaveLength(1);
    expect(events.some((e) => e.t === "bounty")).toBe(false);
    expect(state.bounty).toBeUndefined();
  });

  it("is more the further out, and more again for each modifier", () => {
    expect(bountyPay(6, 0).xp).toBeGreaterThan(bountyPay(3, 0).xp);
    expect(bountyPay(6, 0).gold[0]).toBeGreaterThan(bountyPay(3, 0).gold[1] - 12);
    expect(bountyPay(3, 0.4).xp).toBeGreaterThan(bountyPay(3, 0).xp);
    expect(bountyPay(3, 0.4).gear).toBeGreaterThan(bountyPay(3, 0).gear);
    expect(bountyPay(40, 2).gear).toBe(1);
    expect(bountyPay(40, 2).quality).toBe(0.9);

    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    win(fight({ tier: 3, mods: ["hardy", "numerous"] }), events, effects);
    expect(effects[1].xp).toBe(bountyPay(3, ZONE_MODS.hardy.pay + ZONE_MODS.numerous.pay).xp);
  });

  it("waits, where there is something to open, until the last of it is open", () => {
    let state = fight({ tier: 2 });
    state.map.pois.push({ id: "chest1", kind: "cache", pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" });
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, events, effects);
    expect(events.some((e) => e.t === "cleared")).toBe(true);
    expect(events.some((e) => e.t === "bounty")).toBe(false);
    expect(effects).toHaveLength(1);

    const [opened, paid]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "chest1" }, opened, paid);
    // The chest's own finds, then the bounty.
    expect(paid.map((e) => e.heroId)).toEqual(["ann", "ann"]);
    expect(paid[1].xp).toBe(bountyPay(2, 0).xp);
    expect(opened[opened.length - 1]).toEqual({ t: "bounty" });
    expect(state.bounty).toBe(true);
  });

  it("makes a fight on such a map pay by the level of what fell", () => {
    const worth = (options: Partial<ZoneState["options"]>, level: number) => {
      const effects: ZoneEffect[] = [];
      win(fight(options, level), [], effects);
      return effects[0].xp;
    };
    expect(worth({}, 5)).toBe(ENEMIES.bandit.xp);
    expect(worth({ tier: 5 }, 1)).toBe(ENEMIES.bandit.xp);
    expect(worth({ tier: 5 }, 5)).toBe(Math.round(ENEMIES.bandit.xp * 1.6));
  });
});
