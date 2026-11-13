// The Haunted Caverns: a short, branching delve under the Harbor's rocks.

import { describe, expect, it } from "vitest";
import { STARTING_STATS, hexDistance } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  CAVERN_FRAMES,
  ENEMIES,
  ENEMY_DROPS,
  STORY_FRAMES,
  buildBible,
  createWorld,
  findPath,
  framesFor,
  frameById,
  generateCaverns,
  generateMap,
  makeRng,
  pickFrame,
  poiById,
  requiredDoom,
  seedFromString,
  stepWorld,
  validateBible,
  type Demand,
  type HeroInit,
  type WorldAction,
  type WorldMap,
  type WorldState,
} from "./index";
import { CAVE_SIM_ENCOUNTERS, SIM_CLASSES, simRow } from "./balance";

const haunt = CAVERN_FRAMES[0];

function must(state: WorldState, action: WorldAction): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  return res.state;
}

const hero = (id: string): HeroInit => ({
  id, name: id.toUpperCase(), classId: "qa_paladin", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0,
});

/** A caverns run under way: two strong heroes, nothing roaming, no fog, so only the story is under test. */
function begin(seed: string, demand: Demand = haunt.demands[0]): WorldState {
  let s = createWorld("CAVE", seed, [], "caverns");
  s = must(s, { type: "join", hero: hero("p1") });
  s = must(s, { type: "join", hero: hero("p2") });
  s = must(s, { type: "ready", heroId: "p2", ready: true });
  s = must(s, { type: "start", heroId: "p1" });
  const rng = makeRng(seedFromString(`story|${seed}`));
  s = must(s, { type: "begin", bible: buildBible(haunt, CANNED_FILLS[haunt.id][0], demand, rng) });
  return { ...s, roamers: undefined, seen: undefined, heroes: s.heroes.map((h) => ({ ...h, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 900, maxHp: 900 })) };
}

/** Stand the party at a place and use it, fighting out any battle that starts. */
function act(s: WorldState, poiId: string): WorldState {
  const pos = poiById(s.map, poiId)!.pos;
  s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
  if (s.turn!.acted) s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
  s = must(s, { type: "interact", heroId: s.turn!.heroId });
  for (let i = 0; i < 200 && s.phase === "battle"; i++) s = must(s, { type: "timeout" });
  return s;
}

/** Walkable on foot between two places, with the hexes in `blocked` (and next to them) closed off. */
function walkable(map: WorldMap, from: string, to: string, blocked: string[]): boolean {
  const shut = blocked.map((id) => poiById(map, id)!.pos);
  const route = findPath(map, poiById(map, from)!.pos, poiById(map, to)!.pos, Infinity, (t) =>
    t.biome === "rock" || shut.some((p) => hexDistance(p, t) <= 1) ? Infinity : 1,
  );
  return !!route;
}

describe("the caverns map", () => {
  it("is cave floor inside living rock, with every place reachable from the mouth", () => {
    for (let i = 0; i < 40; i++) {
      const map = generateCaverns(`cave-${i}`);
      expect(new Set(map.tiles.map((t) => t.biome))).toEqual(new Set(["cave", "rock"]));
      for (const p of map.pois) {
        expect(map.tiles.find((t) => t.q === p.pos.q && t.r === p.pos.r)!.biome, `${p.id} on seed ${i}`).toBe("cave");
        expect(findPath(map, poiById(map, "landing")!.pos, p.pos, Infinity), `${p.id} on seed ${i}`).not.toBeNull();
      }
      expect(poiById(map, "lair")!.hidden).toBe(true);
    }
  });

  it("forks: the deep chamber can be reached up either passage on its own", () => {
    for (let i = 0; i < 40; i++) {
      const map = generateCaverns(`fork-${i}`);
      // Close the east passage's places, and the west still reaches the deep chamber; and the other way round.
      expect(walkable(map, "cache1", "lair", ["shrine", "cache2"]), `west, seed ${i}`).toBe(true);
      expect(walkable(map, "cache2", "lair", ["camp", "cache1"]), `east, seed ${i}`).toBe(true);
    }
  });

  it("is a smaller place than an island", () => {
    let cave = 0;
    let island = 0;
    for (let i = 0; i < 20; i++) {
      cave += generateCaverns(`size-${i}`).tiles.filter((t) => t.biome === "cave").length;
      island += generateMap(`size-${i}`).tiles.filter((t) => t.biome !== "water").length;
    }
    expect(cave / island).toBeLessThan(0.8);
  });

  it("is the same cave for the same seed", () => {
    expect(generateCaverns("same")).toEqual(generateCaverns("same"));
  });
});

describe("a delve", () => {
  it("starts in the caverns, not on an island", () => {
    const s = createWorld("CAVE", "start", [], "caverns");
    expect(s.kind).toBe("caverns");
    expect(s.map.tiles.some((t) => t.biome === "rock")).toBe(true);
    expect(createWorld("ISLE", "start").kind).toBe("voyage");
  });

  it("tells only cavern stories, and voyages never do", () => {
    expect(framesFor("caverns")).toBe(CAVERN_FRAMES);
    expect(framesFor("voyage")).toBe(STORY_FRAMES);
    for (let i = 0; i < 20; i++) {
      expect(CAVERN_FRAMES).toContain(pickFrame(makeRng(i), [], framesFor("caverns")));
      expect(STORY_FRAMES).toContain(pickFrame(makeRng(i)));
    }
    expect(frameById("restless_haunt")).toBe(haunt);
  });

  it("builds a story that can be finished, for every ask, on many caverns", () => {
    for (const demand of haunt.demands) {
      for (let i = 0; i < 20; i++) {
        const seed = `story-${demand.id}-${i}`;
        for (const fill of CANNED_FILLS[haunt.id]) {
          const bible = buildBible(haunt, fill, demand, makeRng(seedFromString(seed)));
          expect(validateBible(bible, generateCaverns(seed)), seed).toEqual([]);
        }
      }
    }
  });

  it("can be won down the west passage or the east one", () => {
    for (const [cache, side] of [["cache1", "west"], ["cache2", "east"]] as const) {
      let s = begin(`win-${side}`);
      s = must(s, { type: "talk", heroId: s.turn!.heroId, npcId: "npc1", text: "hello" });
      s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "…", intent: null, attitudeDelta: 0 } });
      s = act(s, cache);
      expect(s.facts["found:binding"], side).toBe(true);
      // What binds the haunt shows the way down.
      expect(poiById(s.map, "lair")!.hidden).toBe(false);
      s = act(s, "lair"); // the fight
      expect(s.facts["defeated:lair"]).toBe(true);
      s = act(s, "lair"); // laid to rest
      expect(s.result?.outcome, side).toBe("victory");
    }
  });

  it("cannot be won by beating the haunt alone: it rises again until it is laid to rest with what binds it", () => {
    let s = begin("no-binding");
    s = act(s, "lair");
    expect(s.facts["defeated:lair"]).toBe(true);
    expect(s.phase).not.toBe("ended");
    // Nothing to do at the lair without the binding: the place is cleared and there is no rite yet.
    const pos = poiById(s.map, "lair")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
    if (s.turn!.acted) s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
    expect(stepWorld(s, { type: "interact", heroId: s.turn!.heroId }).ok).toBe(false);
    s = act(s, "cache2");
    s = act(s, "lair");
    expect(s.result?.outcome).toBe("victory");
  });

  it("takes about half the days of an island voyage", () => {
    let cave = 0;
    let island = 0;
    const heroes = [{ base: { ...STARTING_STATS.qa_paladin }, bonus: {} }];
    for (let i = 0; i < 20; i++) {
      cave += begin(`days-${i}`).doom;
      // An island's clock, averaged over every kind of island story.
      const isle = createWorld("ISLE", `days-${i}`);
      for (const frame of STORY_FRAMES) {
        const bible = buildBible(frame, CANNED_FILLS[frame.id][0]);
        island += Math.max(frame.doomRounds, requiredDoom(isle.map, bible, heroes)) / STORY_FRAMES.length;
      }
    }
    // About half: 15 minutes or so to an island's 30.
    expect(cave / island).toBeLessThan(0.6);
  });

  it("fills its tunnels with cave things and the restless dead", () => {
    let s = createWorld("CAVE", "dead", [], "caverns");
    s = must(s, { type: "join", hero: hero("p1") });
    s = must(s, { type: "start", heroId: "p1" });
    const rng = makeRng(seedFromString("story|dead"));
    s = must(s, { type: "begin", bible: buildBible(haunt, CANNED_FILLS[haunt.id][1], haunt.demands[0], rng) });
    const cave = new Set(["shade", "bat", "skeleton", "slime"]);
    for (const band of s.roamers ?? []) expect(band.kinds.every((k) => cave.has(k))).toBe(true);
    expect(ENEMIES.haunt.boss).toBe(true);
    for (const kind of cave) {
      expect(ENEMIES[kind].boss).toBeFalsy();
      expect(ENEMY_DROPS[kind]?.length).toBeGreaterThan(0);
    }
    expect(poiById(s.map, "lair")!.enemies[0]).toBe("haunt");
  });
});

describe("caverns balance", () => {
  // Level-1 win rates, every class, against each cave fight: bands are a skirmish, camps a real fight, the haunt a boss.
  const rate = (encounter: string, party: number) => {
    const enc = CAVE_SIM_ENCOUNTERS.find((e) => e.id === encounter)!;
    const rates = SIM_CLASSES.map((c) => simRow(c, Array.from({ length: party }, () => ({ classId: c, level: 1 })), [enc], 12).winRate);
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  };

  it("pitches cave fights like an island's: easy bands, fair camps, a hard boss for a lone hero", () => {
    for (const lead of ["shade", "bat", "skeleton", "slime"]) expect(rate(`band:${lead}`, 1), lead).toBeGreaterThan(0.85);
    for (const camp of ["camp:2 skeletons", "camp:skeleton+bats", "camp:skeleton+slime"]) expect(rate(camp, 1), camp).toBeGreaterThan(0.6);
    for (const lair of ["lair:haunt+shade", "lair:haunt+skeleton"]) {
      expect(rate(lair, 1), lair).toBeGreaterThan(0.2);
      expect(rate(lair, 1), lair).toBeLessThan(0.8);
      // Two heroes together see it off, as they do an island's lair.
      expect(rate(lair, 2), lair).toBeGreaterThan(0.9);
    }
  });
});
