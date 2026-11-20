// A map's modifiers (mods.ts), and the ground they leave that does not wear
// off. The bounty a modified map pays is in looting.test.ts.

import { describe, expect, it } from "vitest";
import { hexDistance, posKey } from "@gantt-quest/core";
import { MAX_CATCHUP_ROUNDS } from "./clock";
import { DEFAULT_ZONE_OPTIONS, zoneOptions } from "./gen";
import { solid } from "./geometry";
import { LAY_GRIDS } from "./lay";
import { propOf } from "./props";
import { SITE_IDS, siteFor, siteInside, siteOpen, type SiteId } from "./sites";
import { EXPLORE_ROUND_MS, enemyHp, enemyMove, enemyStrikes } from "./kit";
import { BOON_IDS, MAX_BOONS, MAX_MODS, PERIL_IDS, ZONE_MODS, ZONE_MOD_IDS, cleanMods, modEffect, modName, modOf, modRanks, modToken, modsOf, rollMod, type ZoneModId } from "./mods";
import { makeRng } from "../rng";
import { diceAverage } from "./rules";
import { createZone, stepZone } from "./zone";
import type { ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

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
