// A map's modifiers (mods.ts), the ground they leave that does not wear off,
// and the bounty a map the atlas made pays when it is cleared (loot.ts).

import { describe, expect, it } from "vitest";
import { STARTING_STATS, allHexesInGrid, hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Biome, Tile } from "../map";
import { MAX_CATCHUP_ROUNDS } from "./clock";
import { DEFAULT_ZONE_OPTIONS, zoneOptions } from "./gen";
import { solid } from "./geometry";
import { LAY_GRIDS } from "./lay";
import { propOf } from "./props";
import { SITE_IDS, siteFor, siteInside, siteOpen, type SiteId } from "./sites";
import { EXPLORE_ROUND_MS, enemyHp, enemyMove, enemyStrikes } from "./kit";
import { CHEST_PAY, SPOILS_ID, bountyPay } from "./loot";
import { STONE_MODS, cleanStone } from "../lodestone";
import { BOON_IDS, MAX_BOONS, MAX_MODS, PERIL_IDS, ZONE_MODS, ZONE_MOD_IDS, cleanMods, modEffect, modName, modOf, modRanks, modToken, modsOf, rollMod, type ZoneModId } from "./mods";
import { makeRng } from "../rng";
import { diceAverage } from "./rules";
import { createZone, standInHero, stepZone } from "./zone";
import type { Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

const base = { size: "medium", biome: "meadow", groups: 2, elevation: 1, obstacles: 1, clear: 4, party: 2, level: 3 } as const;
/** A map with these modifiers. `site`: the kind of place it is; left out, whatever suits the ground (which may be under a roof). */
const make = (mods: ZoneModId[], seed = "mods", site?: SiteId) => createZone("MODS", seed, zoneOptions({ ...base, mods, ...(site ? { site } : {}) }));
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
    // In the modifiers' own order, whatever order they came in.
    expect(cleanMods(["hardy", "hardy", "nonsense", "smouldering", "fouled", "swift", 7])).toEqual(["smouldering", "hardy", "swift"]);
    // So many perils and so many boons, and no more.
    expect(cleanMods(ZONE_MOD_IDS).length).toBe(MAX_MODS + MAX_BOONS);
    expect(cleanMods(PERIL_IDS).length).toBe(MAX_MODS);
    expect(cleanMods(BOON_IDS).length).toBe(MAX_BOONS);
    // A rank is part of what is carried: the highest given is kept, and one a modifier has not got is nothing.
    expect(cleanMods(["hardy2", "hardy", "savage3", "swift3", "gilded2"])).toEqual(["hardy2", "savage3", "gilded2"]);
    expect(cleanMods("hardy")).toEqual([]);
    expect(zoneOptions({ mods: ["hardy", "nope"] }).mods).toEqual(["hardy"]);
    expect(zoneOptions({ mods: [] })).toEqual(DEFAULT_ZONE_OPTIONS);
    expect(zoneOptions({ tier: 3.4 }).tier).toBe(3);
    expect(zoneOptions({ tier: 0 }).tier).toBeUndefined();
    expect(zoneOptions({ tier: "far" }).tier).toBeUndefined();
  });

  it("add up to nothing when there are none, and each names what it changes", () => {
    expect(modsOf({})).toEqual({ obstacles: 0, elevation: 0, groups: 0, patches: 1, hp: 1, edge: 0, move: 0, extras: 0, pay: 0, gold: 0, xp: 0, gear: 0, stones: 0 });
    expect(modsOf({ mods: ["hardy", "savage", "swift", "numerous"] })).toMatchObject({ hp: 1.3, edge: 1, move: 1, extras: 1 });
    expect(modsOf({ mods: ["sprawling", "frozen"] })).toMatchObject({ size: "large", groups: 1, hazard: "ice" });
    for (const id of ZONE_MOD_IDS) {
      expect(ZONE_MODS[id].blurb.length, id).toBeGreaterThan(10);
      expect(ZONE_MODS[id].weight, id).toBeGreaterThan(0);
      expect(modsOf({ mods: [id] }).pay).toBe(ZONE_MODS[id].pay);
    }
    // A peril makes the map harder and pays for it; a boon makes nothing harder, and is more of something in the bounty.
    for (const id of PERIL_IDS) expect(ZONE_MODS[id].pay, id).toBeGreaterThan(0);
    for (const id of BOON_IDS) {
      const sum = modsOf({ mods: [id] });
      expect(sum.pay, id).toBe(0);
      expect({ ...sum, gold: 0, xp: 0, gear: 0, stones: 0 }, id).toEqual(modsOf({}));
      expect(sum.gold + sum.xp + sum.gear + sum.stones, id).toBeGreaterThan(0);
    }
  });

  it("have ranks: the same thing, more so, and better paid", () => {
    for (const id of ZONE_MOD_IDS) {
      expect(modRanks(id), id).toBeGreaterThanOrEqual(2);
      let last = modsOf({ mods: [id] });
      for (let rank = 2; rank <= modRanks(id); rank++) {
        const mod = modToken(id, rank);
        expect(modOf(mod)).toEqual({ id, rank });
        expect(modName(mod)).toBe(`${ZONE_MODS[id].name} ${["", "", "II", "III"][rank]}`);
        const sum = modsOf({ mods: [mod] });
        // More of whatever it is: nothing it does is less than the rank below did.
        for (const key of ["obstacles", "elevation", "groups", "patches", "hp", "edge", "move", "extras", "pay", "gold", "xp", "gear", "stones"] as const) expect(sum[key], `${mod} ${key}`).toBeGreaterThanOrEqual(last[key]);
        expect(JSON.stringify(sum), mod).not.toBe(JSON.stringify(last));
        if (ZONE_MODS[id].kind !== "boon") expect(sum.pay, mod).toBeGreaterThan(last.pay);
        expect(modEffect(mod).blurb, mod).not.toBe(ZONE_MODS[id].blurb);
        last = sum;
      }
      // No rank past its last.
      expect(modOf(`${id}${modRanks(id) + 1}`), id).toBeNull();
      expect(modToken(id, 9)).toBe(modToken(id, modRanks(id)));
    }
    expect(modName("hardy")).toBe("Hardy");
    expect(modOf("hardy1")).toBeNull();
    expect(modOf("nonsense2")).toBeNull();
  });

  it("are rolled by weight, so the ones worth most are the rarest, and at higher ranks only far out", () => {
    const count: Record<string, number> = {};
    const ranks = { near: new Set<number>(), far: new Set<number>() };
    for (let i = 0; i < 6000; i++) {
      const rng = makeRng(i * 7919 + 3);
      const mod = rollMod(rng, ZONE_MOD_IDS, 12)!;
      count[modOf(mod)!.id] = (count[modOf(mod)!.id] ?? 0) + 1;
      ranks.far.add(modOf(mod)!.rank);
      ranks.near.add(modOf(rollMod(rng, ZONE_MOD_IDS, 2)!)!.rank);
    }
    expect(Object.keys(count).sort()).toEqual([...ZONE_MOD_IDS].sort());
    // The commonest turn up several times as often as the rarest.
    expect(count.tangled).toBeGreaterThan(count.numerous * 2);
    expect(count.slick).toBeGreaterThan(count.lodebearing * 3);
    expect(count.hardy).toBeGreaterThan(count.numerous);
    expect([...ranks.near]).toEqual([1]);
    expect([...ranks.far].sort()).toEqual([1, 2, 3]);
    // Only what fits is picked; and nothing, where nothing fits.
    for (let i = 0; i < 50; i++) expect(modOf(rollMod(makeRng(i), ZONE_MOD_IDS, 1, (id) => id === "swift")!)!.id).toBe("swift");
    expect(rollMod(makeRng(1), ZONE_MOD_IDS, 1, () => false)).toBeNull();
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

  it("Swift: a hex more for each AP of movement, for anything that moves at all, on top of what its kind covers", () => {
    const more = modsOf({ mods: ["swift"] }).move;
    expect(more).toBe(1);
    // A wolf covers 3 and an ogre 2 as they come: Swift, 4 and 3.
    expect([enemyMove("wolf"), enemyMove("ogre")]).toEqual([3, 2]);
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
      expect(big.map.grid).toEqual(LAY_GRIDS.large);
      expect(Object.keys(big.groups).length).toBe(base.groups + 1);
    }
  });

  it("Tangled and Craggy, out in the open: more in the way, and more high ground", () => {
    // What is in the way: trees to push through, and whatever stands on a hex and bars it (boulders, stones, dead trees).
    const blocked = (s: ZoneState) => s.map.tiles.filter((t) => t.biome === "rock" || t.biome === "forest" || propOf(t)?.blocks).length;
    const high = (s: ZoneState) => s.map.tiles.filter((t) => (t.elev ?? 0) > 0).length;
    let [plainBlocked, tangled, plainHigh, craggy] = [0, 0, 0, 0];
    // On each of the open-air places this ground may be (left to itself, one map in six here is under a roof: below).
    const sites = [0, 0.5, 0.7].map((roll) => siteFor(base.biome, undefined, "landfall", roll));
    expect(sites).toEqual(["keep", "ruins", "camp"]);
    for (const site of sites) {
      expect(siteOpen(site)).toBe(true);
      for (const seed of SEEDS) {
        const at = (mods: ZoneModId[]) => make(mods, seed, site);
        expect(at([]).scene!.site).toBe(site);
        expect(blocked(at(["tangled"])), `${site} ${seed}`).toBeGreaterThan(blocked(at([])));
        expect(high(at(["craggy"])), `${site} ${seed}`).toBeGreaterThan(high(at([])));
        plainBlocked += blocked(at([]));
        tangled += blocked(at(["tangled"]));
        plainHigh += high(at([]));
        craggy += high(at(["craggy"]));
      }
    }
    expect(tangled).toBeGreaterThan(plainBlocked * 1.2);
    expect(craggy).toBeGreaterThan(plainHigh * 1.3);
  });

  it("Tangled, under a roof or under ground: more stands about in the rooms, and the walls are where they were", () => {
    const walls = (s: ZoneState) => s.map.tiles.filter((t) => t.prop === "wall" || t.prop === "wall_torch" || t.prop === "arch").map((t) => `${t.q},${t.r}`);
    // Whatever stands on the floor: furniture, rock grown up from it, what lies about.
    const stood = (s: ZoneState) => s.map.tiles.filter((t) => t.prop && !["wall", "wall_torch", "arch"].includes(t.prop)).length;
    for (const site of SITE_IDS.filter(siteInside)) {
      for (const seed of SEEDS) {
        const [plain, tangled] = [make([], seed, site), make(["tangled"], seed, site)];
        expect(plain.scene!.site).toBe(site);
        expect(stood(tangled), `${site} ${seed}`).toBeGreaterThan(stood(plain));
        // The rooms are the same rooms: what bars a way is never stood in a doorway, so the plan of the place does not change.
        expect(walls(tangled), `${site} ${seed}`).toEqual(walls(plain));
        expect(tangled.start, `${site} ${seed}`).toEqual(plain.start);
      }
    }
  });

  // Not yet so: indoors.ts never reads `options.elevation`, so a Craggy map under a roof or under ground is, hex for hex
  // and band for band, the map it would have been without it (createZone with site "citadel", "crypt", "cavern" or
  // "hollow", mods ["craggy"] against mods []: the same `map` and the same `units`), though the modifier still pays.
  // The same goes for a lookout's `elevation: 3` (atlas.ts) when the lookout is a citadel.
  it.todo("Craggy, under a roof or under ground: more galleries and shelves (or it is not rolled for such a place)");
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
const unit = (state: ZoneState, id: string) => state.units.find((u) => u.id === id)!;

describe("the bounty for clearing a map the atlas made", () => {
  /** The lodestones Ann takes out of the spoils of a place cleared, in the order they lay there. */
  const stonesTaken = (options: Partial<ZoneState["options"]>, rng: number) => {
    const start = fight(options);
    start.rng = rng;
    const effects: ZoneEffect[] = [];
    must(win(start, [], []), { type: "take", by: "ann", unit: "ann", spot: SPOILS_ID }, [], effects);
    return effects.flatMap((e) => (e.stone ? [e.stone] : []));
  };

  it("always holds a lodestone, each one fit to keep, and more of them the more the stone that opened the place carried; a chart-less map has no spoils at all", () => {
    const tries = 80;
    const mean: Record<number, number> = {};
    for (const carried of [0, 1, 3]) {
      let total = 0;
      for (let i = 0; i < tries; i++) {
        const stones = stonesTaken({ tier: 6, stone: carried }, i * 9973 + 11);
        // Never none. The first is as good as the stone that opened the place, or a thing better.
        expect(stones.length, `${carried} ${i}`).toBeGreaterThanOrEqual(1);
        expect([carried, Math.min(STONE_MODS, carried + 1)], `${carried} ${i}`).toContain(stones[0].length);
        for (const stone of stones) {
          expect(cleanStone(stone)).toEqual(stone);
          expect(stone.length).toBeLessThanOrEqual(STONE_MODS);
        }
        total += stones.length;
      }
      mean[carried] = total / tries;
    }
    expect(mean[1]).toBeGreaterThan(mean[0]);
    expect(mean[3]).toBeGreaterThan(mean[1]);
    // A place beside the Harbor is opened by no stone at all: it is reckoned as a plain one.
    for (let i = 0; i < 20; i++) expect(stonesTaken({ tier: 1 }, i + 1).length).toBeGreaterThanOrEqual(1);
    // A map the atlas did not make has no spoils to take, and what fell on it carried no stone.
    const plain = win(fight({}), [], []);
    expect(plain.loot!.map((s) => s.kind)).toEqual(["body"]);
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    unit(plain, "ann").pos = at(7, 6);
    must(plain, { type: "take", by: "ann", unit: "ann", spot: plain.loot![0].id }, events, effects);
    expect(effects.some((e) => e.stone)).toBe(false);
  });

  it("pays its XP to every player's hero on it and no stand-in, once, and heaps the place's spoils beside whoever finished it", () => {
    const events: ZoneEvent[] = [];
    const effects: ZoneEffect[] = [];
    let state = win(fight({ tier: 3 }), events, effects);
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    // The fight's own XP, then the bounty's: both Ann's, neither the stand-in's, and XP is all either is.
    const p = bountyPay(3, 0);
    expect(effects).toEqual([
      { type: "grant", heroId: "ann", xp: ENEMIES.bandit.xp, resources: {} },
      { type: "grant", heroId: "ann", xp: p.xp, resources: {} },
    ]);
    expect(events.findIndex((e) => e.t === "bounty")).toBeGreaterThan(events.findIndex((e) => e.t === "cleared"));
    expect(events).toContainEqual({ t: "bounty", spot: SPOILS_ID });
    expect(state.bounty).toBe(true);
    // The spoils lie on open ground beside her, nobody's share looked into yet.
    const spot = state.loot!.find((s) => s.id === SPOILS_ID)!;
    expect(spot).toMatchObject({ kind: "spoils", loot: {} });
    expect(hexDistance(spot.pos, unit(state, "ann").pos)).toBe(1);
    expect(state.units.some((u) => posKey(u.pos) === posKey(spot.pos))).toBe(false);
    // Hers to take, and no stand-in's: its gold is what a place this far out pays.
    expect(stepZone(state, { type: "take", by: "ann", unit: "s1", spot: SPOILS_ID })).toMatchObject({ ok: false, error: expect.stringMatching(/your own hero/) });
    const taken: ZoneEffect[] = [];
    state = must(state, { type: "take", by: "ann", unit: "ann", spot: SPOILS_ID }, [], taken);
    expect(taken.every((e) => e.heroId === "ann" && e.xp === 0)).toBe(true);
    expect(taken[0].gold).toBeGreaterThanOrEqual(p.gold[0]);
    expect(taken[0].gold).toBeLessThanOrEqual(p.gold[1]);

    // Something else turns up and is beaten: the map was cleared already, and pays no second bounty.
    enemy(state, "bandit", at(9, 6));
    state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } });
    const [again, more]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, again, more);
    expect(more).toHaveLength(1);
    expect(again.some((e) => e.t === "bounty")).toBe(false);
    expect(state.loot!.filter((s) => s.kind === "spoils")).toHaveLength(1);
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

  it("waits, in a delve, until the last chest is open; anywhere else a chest left shut holds nothing up", () => {
    const chest = { id: "chest1", kind: "cache" as const, pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" as const };
    let state = fight({ tier: 2, delve: true });
    state.map.pois.push({ ...chest });
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, events, effects);
    expect(events.some((e) => e.t === "cleared")).toBe(true);
    expect(events.some((e) => e.t === "bounty")).toBe(false);
    expect(effects).toHaveLength(1);
    expect(state.bounty).toBeUndefined();

    const [opened, paid]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "chest1" }, opened, paid);
    // The chest's own XP, then the bounty's.
    expect(paid.map((e) => [e.heroId, e.xp])).toEqual([["ann", CHEST_PAY.chest.xp], ["ann", bountyPay(2, 0).xp]]);
    expect(opened).toContainEqual({ t: "bounty", spot: SPOILS_ID });
    expect(state.bounty).toBe(true);
    // The chest and the spoils are two heaps, each on a hex of its own.
    const spots = state.loot!.filter((s) => s.kind !== "body");
    expect(spots.map((s) => s.kind).sort()).toEqual(["chest", "spoils"]);
    expect(posKey(spots[0].pos)).not.toBe(posKey(spots[1].pos));

    // Under the sky the place is cleared when nobody is left to fight: its chest is the party's to open or to leave.
    let open = fight({ tier: 2 });
    open.map.pois.push({ ...chest });
    const told: ZoneEvent[] = [];
    open = win(open, told, []);
    expect(told).toContainEqual({ t: "bounty", spot: SPOILS_ID });
    expect(open.bounty).toBe(true);
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
