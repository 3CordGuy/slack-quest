import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  DUMMY_KIND,
  CACHE_DECOR,
  CACHE_RESOURCES,
  CANNED_FILLS,
  ENEMIES,
  ENEMY_DROPS,
  FOUND_BLUEPRINTS,
  FURNISHINGS,
  RESOURCE_KINDS,
  STORY_FRAMES,
  TROPHY_FOR_FRAME,
  addResources,
  battleDrops,
  buildBible,
  cacheDrops,
  createWorld,
  demandMet,
  makeRng,
  poiById,
  seedFromString,
  stepWorld,
  storyTrophy,
  type Demand,
  type HeroInit,
  type ResourceKind,
  type Resources,
  type StoryFrame,
  type WorldAction,
  type WorldEffect,
  type WorldEvent,
  type WorldState,
} from "./index";

const hero = (id: string, classId: string, weapon: string): HeroInit => ({
  id, name: id.toUpperCase(), classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, bonus: {}, weapon, weaponPower: 0, armor: 0,
});

/** A voyage plus everything it has emitted so far. */
interface Log {
  state: WorldState;
  events: WorldEvent[];
  effects: WorldEffect[];
}

function must(log: Log, action: WorldAction): void {
  const res = stepWorld(log.state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  log.state = res.state;
  log.events.push(...res.events);
  log.effects.push(...res.effects);
}

function begin(frame: StoryFrame, demand: Demand, seed: string): Log {
  const log: Log = { state: createWorld("TEST", seed), events: [], effects: [] };
  must(log, { type: "join", hero: hero("p1", "qa_paladin", "mace") });
  must(log, { type: "join", hero: hero("p2", "devops_mage", "staff") });
  must(log, { type: "ready", heroId: "p2", ready: true });
  must(log, { type: "start", heroId: "p1" });
  const rng = makeRng(seedFromString(`story|${seed}`));
  const fill = rng.pick(CANNED_FILLS[frame.id]);
  must(log, { type: "begin", bible: buildBible(frame, fill, demand, rng) });
  // Strong enough that fights are won whatever the dice do.
  // These tests are about what a voyage pays, so the island has no fog and nothing roaming on it.
  log.state = { ...log.state, roamers: undefined, seen: undefined, heroes: log.state.heroes.map((h) => ({ ...h, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 900, maxHp: 900 })) };
  return log;
}

const goTo = (log: Log, poiId: string) => {
  const pos = poiById(log.state.map, poiId)!.pos;
  log.state = { ...log.state, heroes: log.state.heroes.map((h) => ({ ...h, pos })) };
};

/** Everyone walks to a place and whoever's turn it is acts there; any fight is played out. */
function act(log: Log, poiId: string): void {
  goTo(log, poiId);
  if (log.state.turn!.acted) must(log, { type: "end_turn", heroId: log.state.turn!.heroId });
  must(log, { type: "interact", heroId: log.state.turn!.heroId });
  for (let i = 0; i < 200 && log.state.phase === "battle"; i++) must(log, { type: "timeout" });
}

/** Play a story to its end, one unmet objective at a time (the pattern from story.test.ts). */
function playThrough(frame: StoryFrame, demand: Demand, seed: string): Log {
  const log = begin(frame, demand, seed);
  const talk = (intent: { verb: string; args: Record<string, unknown> } | null) => {
    goTo(log, "hut");
    must(log, { type: "talk", heroId: "p1", npcId: "npc1", text: "hello" });
    must(log, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "…", intent, attitudeDelta: 0 } });
  };
  const earn = (fact: string): void => {
    const [kind, ref] = fact.split(":");
    if (kind === "met") return talk(null);
    if (kind === "defeated" || kind === "searched" || kind === "prayed") return act(log, ref);
    if (kind === "revealed") {
      const bible = log.state.bible!;
      if (!demandMet(bible, log.state.facts, log.state.npcs.npc1.persuaded)) {
        if (bible.demand.fact) earn(bible.demand.fact);
        else log.state = { ...log.state, npcs: { npc1: { ...log.state.npcs.npc1, persuaded: true } } };
      }
      return talk({ verb: "reveal_location", args: { poi: ref } });
    }
    const rite = log.state.bible!.rites.find((r) => r.sets === fact);
    if (!rite) throw new Error(`nothing sets ${fact}`);
    return act(log, rite.poi);
  };
  for (let i = 0; i < 30 && log.state.phase !== "ended"; i++) {
    const next = log.state.bible!.objectives.find((o) => !log.state.facts[o.fact]);
    if (!next) break;
    earn(next.fact);
  }
  return log;
}

const kindsOf = (r: Resources) => Object.keys(r) as ResourceKind[];
const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

describe("drop tables", () => {
  it("covers every enemy with valid resource kinds", () => {
    // The sparring dummy is practice only and pays nothing.
    for (const kind of Object.keys(ENEMIES).filter((k) => k !== DUMMY_KIND)) {
      expect(ENEMY_DROPS[kind]?.length, kind).toBeGreaterThan(0);
      for (const r of ENEMY_DROPS[kind]) expect(RESOURCE_KINDS).toContain(r);
    }
    for (const r of CACHE_RESOURCES) expect(RESOURCE_KINDS).toContain(r);
    expect(FOUND_BLUEPRINTS.length).toBeGreaterThan(0);
    for (const id of FOUND_BLUEPRINTS) expect(FURNISHINGS[id]?.needsBlueprint, id).toBe(true);
    for (const id of CACHE_DECOR) expect(FURNISHINGS[id]?.kind, id).toBe("furniture");
  });

  it("battle drops are deterministic per seed and match the enemies fought", () => {
    const party = ["wolf", "wolf", "bandit", "guardian"];
    for (let seed = 1; seed <= 300; seed++) {
      const a = battleDrops(makeRng(seed), party);
      expect(battleDrops(makeRng(seed), party)).toEqual(a);

      const wolves = battleDrops(makeRng(seed), ["wolf", "wolf"]);
      for (const k of kindsOf(wolves)) expect(["fur", "bone"]).toContain(k);
      expect(units(wolves)).toBeGreaterThanOrEqual(2);
      expect(units(wolves)).toBeLessThanOrEqual(6);

      for (const k of kindsOf(battleDrops(makeRng(seed), ["bandit", "archer", "brute", "cultist", "villain"]))) expect(["iron", "copper"]).toContain(k);
      expect(kindsOf(battleDrops(makeRng(seed), ["guardian"]))).toEqual(["stone"]);
      // A boss is worth more than the most a rank-and-file enemy can give.
      expect(units(battleDrops(makeRng(seed), ["alpha"]))).toBeGreaterThan(3);
      expect(battleDrops(makeRng(seed), ["nobody"])).toEqual({});
    }
    expect(battleDrops(makeRng(1), party)).not.toEqual(battleDrops(makeRng(2), party));
  });

  it("cache drops are deterministic per seed and only name real things", () => {
    let blueprints = 0;
    let decor = 0;
    const N = 4000;
    for (let seed = 1; seed <= N; seed++) {
      const d = cacheDrops(makeRng(seed));
      expect(cacheDrops(makeRng(seed))).toEqual(d);
      for (const k of kindsOf(d.resources)) expect(CACHE_RESOURCES).toContain(k);
      expect(units(d.resources)).toBeGreaterThanOrEqual(2);
      expect(units(d.resources)).toBeLessThanOrEqual(4);
      if (d.blueprint) {
        blueprints++;
        expect(FOUND_BLUEPRINTS).toContain(d.blueprint);
      }
      if (d.furnishing) {
        decor++;
        expect(CACHE_DECOR).toContain(d.furnishing.defId);
        expect(d.furnishing.label).toBe(FURNISHINGS[d.furnishing.defId].name);
      }
    }
    // Both are occasional, and decor is the rarer of the two.
    expect(blueprints).toBeGreaterThan(N * 0.08);
    expect(blueprints).toBeLessThan(N * 0.25);
    expect(decor).toBeGreaterThan(0);
    expect(decor).toBeLessThan(blueprints);
  });

  it("does not hand out a blueprint already found this voyage", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const first = cacheDrops(makeRng(seed)).blueprint;
      if (!first) continue;
      expect(cacheDrops(makeRng(seed), [first]).blueprint).not.toBe(first);
      expect(cacheDrops(makeRng(seed), FOUND_BLUEPRINTS).blueprint).toBeUndefined();
    }
  });

  it("names a trophy after the story, for every story shape", () => {
    for (const frame of STORY_FRAMES) {
      for (const fill of CANNED_FILLS[frame.id]) {
        const bible = buildBible(frame, fill);
        const trophy = storyTrophy(bible)!;
        expect(trophy.defId).toBe(TROPHY_FOR_FRAME[frame.id]);
        expect(FURNISHINGS[trophy.defId].kind).toBe("trophy");
        expect(trophy.label).toContain(fill.title);
        expect(trophy.label.includes(fill.villain_name) || trophy.label.toLowerCase().includes(fill.relic_name.toLowerCase())).toBe(true);
      }
    }
    expect(storyTrophy({ frameId: "no_such_frame", title: "x", relicName: "y", villain: { name: "z", description: "" } })).toBeUndefined();
  });
});

describe("drops on a voyage", () => {
  it("a won fight grants each fighter resources matching its enemies", () => {
    for (const seed of ["drops-a", "drops-b", "drops-c"]) {
      const log = begin(STORY_FRAMES[0], STORY_FRAMES[0].demands[0], seed);
      const camp = log.state.map.pois.find((p) => p.kind === "camp")!;
      const allowed = new Set(camp.enemies.flatMap((k) => ENEMY_DROPS[k]));
      const from = log.events.length;
      act(log, camp.id);
      const events = log.events.slice(from);
      expect(events).toContainEqual({ t: "battle_end", status: "victory" });
      const drops = events.filter((e) => e.t === "resources");
      expect(drops.map((e) => e.heroId).sort()).toEqual(["p1", "p2"]);
      for (const ev of drops) {
        expect(units(ev.resources)).toBeGreaterThanOrEqual(camp.enemies.length);
        for (const k of kindsOf(ev.resources)) expect(allowed.has(k), `${k} from ${camp.enemies}`).toBe(true);
        expect(log.state.earned[ev.heroId].resources).toEqual(ev.resources);
      }
    }
  });

  it("a cache search that finds something yields wood, stone or copper", () => {
    let found = 0;
    for (let i = 0; i < 12; i++) {
      const log = begin(STORY_FRAMES[0], STORY_FRAMES[0].demands[0], `cache-${i}`);
      const cache = log.state.map.pois.find((p) => p.kind === "cache")!;
      const from = log.events.length;
      act(log, cache.id);
      const events = log.events.slice(from);
      const search = events.find((e) => e.t === "search")!;
      const drops = events.filter((e) => e.t === "resources");
      if (!search.found) {
        expect(drops).toEqual([]);
        continue;
      }
      found++;
      expect(drops).toHaveLength(1);
      expect(drops[0].heroId).toBe(search.heroId);
      for (const k of kindsOf(drops[0].resources)) expect(CACHE_RESOURCES).toContain(k);
    }
    expect(found).toBeGreaterThan(0);
  });

  for (const frame of STORY_FRAMES) {
    it(`winning "${frame.id}" gives every hero its trophy, and the grants add up`, () => {
      frame.demands.forEach((demand, i) => {
        const log = playThrough(frame, demand, `${frame.id}-trophy-${i}`);
        const { state } = log;
        expect(state.result?.outcome).toBe("victory");
        const expected = storyTrophy(state.bible!)!;
        expect(expected.defId).toBe(TROPHY_FOR_FRAME[frame.id]);

        for (const h of state.heroes) {
          const earned = state.earned[h.id];
          expect(earned.furnishings?.filter((f) => FURNISHINGS[f.defId].kind === "trophy")).toEqual([expected]);
          for (const k of kindsOf(earned.resources ?? {})) expect(RESOURCE_KINDS).toContain(k);
          for (const id of earned.blueprints ?? []) expect(FOUND_BLUEPRINTS).toContain(id);
          for (const f of earned.furnishings ?? []) expect(FURNISHINGS[f.defId]).toBeDefined();
          expect(units(earned.resources ?? {})).toBeGreaterThan(0);

          // What the server was told to write is exactly what the voyage says was earned.
          const grants = log.effects.filter((e) => e.kind === "grant" && e.heroId === h.id) as Extract<WorldEffect, { kind: "grant" }>[];
          expect(grants.reduce((a, g) => a + g.xp, 0)).toBe(earned.xp);
          expect(grants.reduce((a, g) => a + g.gold, 0)).toBe(earned.gold);
          expect(grants.flatMap((g) => (g.item ? [g.item] : []))).toEqual(earned.items);
          expect(grants.reduce<Resources>((a, g) => addResources(a, g.resources ?? {}), {})).toEqual(earned.resources ?? {});
          expect(grants.flatMap((g) => (g.blueprint ? [g.blueprint] : []))).toEqual(earned.blueprints ?? []);
          expect(grants.flatMap((g) => (g.furnishing ? [g.furnishing] : []))).toEqual(earned.furnishings ?? []);
        }
        expect(log.events.filter((e) => e.t === "furnishing" && e.furnishing.defId === expected.defId)).toHaveLength(state.heroes.length);
      });
    });
  }

  it("a lost story gives no trophy", () => {
    const log = begin(STORY_FRAMES[0], STORY_FRAMES[0].demands[0], "lost");
    log.state = { ...log.state, doom: 1 };
    for (let i = 0; i < 10 && log.state.phase !== "ended"; i++) must(log, { type: "end_turn", heroId: log.state.turn!.heroId });
    expect(log.state.result?.outcome).toBe("defeat");
    for (const h of log.state.heroes) expect(log.state.earned[h.id]?.furnishings ?? []).toEqual([]);
  });
});
