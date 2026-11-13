// The Haunted Caverns: a short delve with no story. Carved fresh every time,
// with things lurking, chests to open, now and then a locked door, and
// torchlight to get back out by.

import { describe, expect, it } from "vitest";
import { STARTING_STATS, hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import {
  DELVE_EXIT_XP,
  ENEMIES,
  ENEMY_DROPS,
  createWorld,
  findPath,
  generateCaverns,
  poiAt,
  poiById,
  reachable,
  stepWorld,
  tileAt,
  type HeroInit,
  type WorldAction,
  type WorldEffect,
  type WorldEvent,
  type WorldMap,
  type WorldState,
} from "./index";
import { CAVE_SIM_ENCOUNTERS, SIM_CLASSES, simRow } from "./balance";

type Sink = { events: WorldEvent[]; effects: WorldEffect[] };

function must(state: WorldState, action: WorldAction, sink?: Sink): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  sink?.events.push(...res.events);
  sink?.effects.push(...res.effects);
  return res.state;
}

const hero = (id: string): HeroInit => ({
  id, name: id.toUpperCase(), classId: "qa_paladin", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0,
});

/** A delve under way with `n` heroes. */
function delve(seed: string, n = 2): WorldState {
  let s = createWorld("CAVE", seed, [], "caverns");
  for (let i = 1; i <= n; i++) s = must(s, { type: "join", hero: hero(`p${i}`) });
  for (let i = 2; i <= n; i++) s = must(s, { type: "ready", heroId: `p${i}`, ready: true });
  s = must(s, { type: "start", heroId: "p1" });
  return must(s, { type: "begin", bible: null });
}

/** Strong heroes, nothing roaming and no fog, so only the place under test matters. */
const calm = (s: WorldState): WorldState => ({
  ...s,
  roamers: [],
  seen: undefined,
  heroes: s.heroes.map((h) => ({ ...h, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 900, maxHp: 900 })),
});

function fightOut(s: WorldState): WorldState {
  for (let i = 0; i < 300 && s.phase === "battle"; i++) s = must(s, { type: "timeout" });
  return s;
}

/** Stand the whole party at `pos`, with a turn that still has its action. */
function standAt(s: WorldState, pos: HexPos): WorldState {
  s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos: { ...pos } })) };
  if (s.turn!.acted) s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
  return s;
}

/** The first seed (of many) whose caverns have what `want` looks for. */
function seedWith(want: (map: WorldMap) => boolean): string {
  for (let i = 0; i < 200; i++) if (want(generateCaverns(`find-${i}`))) return `find-${i}`;
  throw new Error("no such caverns");
}

const landing = (map: WorldMap) => poiById(map, "landing")!.pos;

describe("the caverns map", () => {
  it("is cave floor in living rock, with a hoard in the deepest chamber and things lurking on the way", () => {
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`cave-${i}`);
      for (const t of map.tiles) expect(["cave", "rock", "gate"]).toContain(t.biome);
      const lair = poiById(map, "lair")!;
      const hoard = poiById(map, "hoard")!;
      expect(lair.enemies[0]).toBe("haunt");
      expect(hoard).toMatchObject({ kind: "cache", loot: "hoard", guard: "lair" });
      expect(hexDistance(hoard.pos, lair.pos)).toBe(1);
      expect(map.pois.filter((p) => p.kind === "camp").length).toBeGreaterThanOrEqual(2);
      expect(map.pois.filter((p) => p.kind === "cache" && p.loot === "chest").length).toBeGreaterThanOrEqual(1);
      expect(map.pois.filter((p) => p.kind === "pickup").length).toBeGreaterThanOrEqual(5);
    }
  });

  it("can be walked end to end, but for what is shut behind a locked door", () => {
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`walk-${i}`);
      const shut = reachable(map, landing(map));
      const open = reachable(map, landing(map), Infinity, (t) => (t.biome === "rock" ? Infinity : 1));
      const gates = map.pois.filter((p) => p.kind === "gate");
      for (const p of map.pois) {
        expect(open.has(posKey(p.pos)), `${p.id} in walk-${i}`).toBe(true);
        if (p.kind === "gate") continue;
        // Only a strongbox, or the deepest chamber when it is the one shut away, lies behind a door.
        if (!shut.has(posKey(p.pos))) expect(p.loot === "vault" || ((p.id === "lair" || p.id === "hoard") && gates.length > 0), `${p.id} in walk-${i}`).toBe(true);
      }
      // A strongbox is only ever behind a door, and each door really does keep it shut.
      for (const vault of map.pois.filter((p) => p.loot === "vault")) expect(shut.has(posKey(vault.pos))).toBe(false);
    }
  });

  it("has a locked door now and then, and a key to each on the near side", () => {
    let doors = 0;
    let none = 0;
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`door-${i}`);
      const gates = map.pois.filter((p) => p.kind === "gate");
      expect(gates.length).toBeLessThanOrEqual(2);
      for (const g of gates) expect(tileAt(map, g.pos)!.biome).toBe("gate");
      const near = reachable(map, landing(map));
      const keys = map.pois.filter((p) => p.key);
      expect(keys.length).toBeLessThanOrEqual(gates.length);
      for (const k of keys) expect(near.has(posKey(k.pos)), `key at ${k.id} in door-${i}`).toBe(true);
      doors += gates.length;
      if (gates.length === 0) none += 1;
    }
    // Not every delve, but most.
    expect(doors).toBeGreaterThan(40);
    expect(none).toBeGreaterThan(5);
  });

  it("is carved differently every time, and the same from the same seed", () => {
    expect(generateCaverns("same")).toEqual(generateCaverns("same"));
    const shapes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const map = generateCaverns(`shape-${i}`);
      shapes.add(map.tiles.filter((t) => t.biome !== "rock").map((t) => posKey(t)).sort().join(" "));
    }
    expect(shapes.size).toBe(20);
  });
});

describe("a delve", () => {
  it("goes straight down: no story, and torchlight sized to the cave", () => {
    for (let i = 0; i < 10; i++) {
      const s = delve(`down-${i}`);
      expect(s.phase).toBe("overworld");
      expect(s.bible).toBeNull();
      expect(s.doom).toBeGreaterThanOrEqual(10);
      expect(s.doom).toBeLessThanOrEqual(24);
      expect(s.keys).toBe(0);
      expect((s.roamers ?? []).length).toBeLessThanOrEqual(1);
      for (const band of s.roamers ?? []) for (const k of band.kinds) expect(["shade", "bat", "skeleton", "slime"]).toContain(k);
    }
  });

  it("never begins a voyage without a story", () => {
    let s = createWorld("SHIP", "story", []);
    s = must(s, { type: "join", hero: hero("p1") });
    s = must(s, { type: "start", heroId: "p1" });
    expect(stepWorld(s, { type: "begin", bible: null }).ok).toBe(false);
  });

  it("is jumped by whatever lurks in a chamber when a hero comes within a hex of it", () => {
    let s = calm(delve("lurk"));
    const camp = s.map.pois.find((p) => p.kind === "camp")!;
    const from = s.map.tiles.find((t) => t.biome === "cave" && hexDistance(t, camp.pos) === 3 && findPath(s.map, t, camp.pos, 4))!;
    s = { ...s, heroes: s.heroes.map((h) => (h.id === s.turn!.heroId ? { ...h, pos: { q: from.q, r: from.r } } : { ...h, pos: landing(s.map) })) };
    s.turn!.mp = 8;
    const sink: Sink = { events: [], effects: [] };
    s = must(s, { type: "move", heroId: s.turn!.heroId, to: camp.pos }, sink);
    expect(s.phase).toBe("battle");
    expect(sink.events).toContainEqual(expect.objectContaining({ t: "ambush", by: "lurk" }));
    // The walk stops beside them, not on top of them.
    const me = s.heroes.find((h) => h.id === s.turn!.heroId)!;
    expect(hexDistance(me.pos, poiById(s.map, s.battle!.poiId!)!.pos)).toBe(1);
  });

  it("guards some chests: reaching for one starts the fight, and it opens once they are down", () => {
    const seed = seedWith((m) => m.pois.some((p) => p.kind === "cache" && p.loot === "chest" && p.guard));
    let s = calm(delve(seed));
    const chest = s.map.pois.find((p) => p.kind === "cache" && p.loot === "chest" && p.guard)!;
    s = standAt(s, chest.pos);
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    expect(s.battle?.poiId).toBe(chest.guard);
    s = fightOut(s);
    expect(poiById(s.map, chest.guard!)!.cleared).toBe(true);
    s = standAt(s, chest.pos);
    const opener = s.turn!.heroId;
    const gold = s.earned[opener]?.gold ?? 0;
    const sink: Sink = { events: [], effects: [] };
    s = must(s, { type: "interact", heroId: opener }, sink);
    expect(sink.events).toContainEqual(expect.objectContaining({ t: "chest", poiId: chest.id, loot: "chest" }));
    expect(s.earned[opener].gold).toBeGreaterThan(gold);
    expect(poiById(s.map, chest.id)!.cleared).toBe(true);
    expect(stepWorld(standAt(s, chest.pos), { type: "interact", heroId: s.turn!.heroId }).ok).toBe(false);
  });

  it("opens a locked door with a key, or by force, and only then can the room behind it be walked into", () => {
    const seed = seedWith((m) => m.pois.some((p) => p.kind === "gate"));
    const fresh = calm(delve(seed));
    const gate = fresh.map.pois.find((p) => p.kind === "gate")!;
    const beside = fresh.map.tiles.find((t) => t.biome === "cave" && hexDistance(t, gate.pos) === 1 && !poiAt(fresh.map, t) && reachable(fresh.map, landing(fresh.map)).has(posKey(t)))!;
    const at = { q: beside.q, r: beside.r };

    // With a key.
    let s = standAt({ ...fresh, keys: 1 }, at);
    const sink: Sink = { events: [], effects: [] };
    s = must(s, { type: "interact", heroId: s.turn!.heroId }, sink);
    expect(sink.events).toContainEqual(expect.objectContaining({ t: "gate", poiId: gate.id, how: "key" }));
    expect(s.keys).toBe(0);
    expect(poiById(s.map, gate.id)!.cleared).toBe(true);
    expect(tileAt(s.map, gate.pos)!.biome).toBe("cave");

    // Without one: shoulders until it gives. It stays shut (and unwalkable) every time it holds.
    s = standAt(fresh, at);
    let tries = 0;
    for (; tries < 40 && !poiById(s.map, gate.id)!.cleared; tries++) {
      s = standAt(s, at);
      s = must(s, { type: "interact", heroId: s.turn!.heroId });
      if (!poiById(s.map, gate.id)!.cleared) expect(tileAt(s.map, gate.pos)!.biome).toBe("gate");
    }
    expect(poiById(s.map, gate.id)!.cleared).toBe(true);
    expect(tries).toBeGreaterThan(0);
  });

  it("hands a key to whoever opens the chest or beats the band that holds it", () => {
    const seed = seedWith((m) => m.pois.some((p) => p.key && p.kind === "cache" && !p.guard));
    let s = calm(delve(seed));
    const chest = s.map.pois.find((p) => p.key && p.kind === "cache" && !p.guard)!;
    s = standAt(s, chest.pos);
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    expect(s.keys).toBe(1);
  });

  it("ends well once everyone has climbed out at the mouth, one at a time", () => {
    let s = calm(delve("out"));
    const mouth = landing(s.map);
    // Not from anywhere but the mouth.
    const away = s.map.pois.find((p) => p.kind === "camp")!.pos;
    expect(stepWorld(standAt(s, away), { type: "climb_out", heroId: s.turn!.heroId }).ok).toBe(false);

    s = standAt(s, mouth);
    const first = s.turn!.heroId;
    s = must(s, { type: "climb_out", heroId: first });
    expect(s.heroes.find((h) => h.id === first)!.out).toBe(true);
    expect(s.phase).toBe("overworld");
    // Out is out: no more turns below.
    for (let i = 0; i < 4; i++) {
      expect(s.turn!.heroId).not.toBe(first);
      s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
    }
    const sink: Sink = { events: [], effects: [] };
    s = must(s, { type: "climb_out", heroId: s.turn!.heroId }, sink);
    expect(s.result?.outcome).toBe("victory");
    expect(s.result?.epilogue).toMatch(/chests opened/);
    for (const h of s.heroes) expect(s.earned[h.id].xp).toBeGreaterThanOrEqual(DELVE_EXIT_XP);
    // No story to write up.
    expect(sink.effects.some((e) => e.kind === "epilogue")).toBe(false);
    expect(sink.effects).toContainEqual({ kind: "run_end", outcome: "victory" });
  });

  it("ends in the dark when the torches burn out, with the usual capped loss", () => {
    let s = calm(delve("dark"));
    const sink: Sink = { events: [], effects: [] };
    for (let i = 0; i < 2000 && s.phase !== "ended"; i++) {
      s = must(s, { type: "timeout" }, sink);
      s = { ...s, roamers: [] };
    }
    expect(s.result?.outcome).toBe("defeat");
    expect(s.result?.reason).toMatch(/torch/);
    expect(sink.effects.filter((e) => e.kind === "penalty")).toHaveLength(2);
  });

  it("fills its tunnels with cave things, each with something to drop", () => {
    for (const kind of ["shade", "bat", "skeleton", "slime"]) {
      expect(ENEMIES[kind].boss).toBeFalsy();
      expect(ENEMY_DROPS[kind]?.length).toBeGreaterThan(0);
    }
    expect(ENEMIES.haunt.boss).toBe(true);
  });
});

describe("caverns balance", () => {
  // Level-1 win rates, every class, against each cave fight: bands are a skirmish, lurkers a real fight, the hoard's guards a boss.
  const rate = (encounter: string, party: number) => {
    const enc = CAVE_SIM_ENCOUNTERS.find((e) => e.id === encounter)!;
    const rates = SIM_CLASSES.map((c) => simRow(c, Array.from({ length: party }, () => ({ classId: c, level: 1 })), [enc], 12).winRate);
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  };

  it("pitches cave fights like an island's: easy bands, fair lurkers, a hard boss for a lone hero", () => {
    for (const lead of ["shade", "bat", "skeleton", "slime"]) expect(rate(`band:${lead}`, 1), lead).toBeGreaterThan(0.85);
    for (const camp of ["camp:2 skeletons", "camp:skeleton+bats", "camp:skeleton+slime", "camp:3 bats", "camp:2 shades"]) expect(rate(camp, 1), camp).toBeGreaterThan(0.6);
    for (const lair of ["lair:haunt+shade", "lair:haunt+skeleton"]) {
      expect(rate(lair, 1), lair).toBeGreaterThan(0.2);
      expect(rate(lair, 1), lair).toBeLessThan(0.8);
      // Two heroes together see it off, as they do an island's lair.
      expect(rate(lair, 2), lair).toBeGreaterThan(0.9);
    }
  });
});

