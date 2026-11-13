// Bears: a slow, heavy beast that roams the islands and turns up in camps,
// and the Great Bear, a den boss for beast hunts whose beast is a bear.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  ENEMIES,
  ENEMY_DROPS,
  ROAMER_LEADS,
  STORY_FRAMES,
  bandKinds,
  battleDrops,
  buildBible,
  createWorld,
  isBearHunt,
  makeRng,
  poiById,
  stepWorld,
  storyHints,
  validateBible,
  generateMap,
  type HeroInit,
  type WorldAction,
  type WorldState,
} from "./index";
import { SIM_ENCOUNTERS } from "./balance";

const hunt = STORY_FRAMES.find((f) => f.id === "beast_hunt")!;
const bearFill = CANNED_FILLS.beast_hunt.find((f) => isBearHunt(f))!;
const wolfFills = CANNED_FILLS.beast_hunt.filter((f) => !isBearHunt(f));

function must(state: WorldState, action: WorldAction): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  return res.state;
}

const heroInit = (id: string, classId: string, weapon: string): HeroInit => ({
  id, name: id.toUpperCase(), classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, bonus: {}, weapon, weaponPower: 0, armor: 0,
});

describe("the bear", () => {
  it("is a slow, tough bruiser that hits harder than a wolf and tears rather than clubs", () => {
    const { bear, wolf, brute } = ENEMIES;
    expect(bear.boss).toBeFalsy();
    expect(bear.hp).toBeGreaterThan(brute.hp);
    expect(bear.hp).toBeGreaterThan(wolf.hp * 2);
    expect(bear.speed).toBeLessThan(wolf.speed);
    expect(bear.speed).toBeLessThanOrEqual(brute.speed);
    const hardest = Math.max(...bear.attacks.map((a) => a.damage));
    expect(hardest).toBeGreaterThan(Math.max(...wolf.attacks.map((a) => a.damage)));
    // Its heavy blow makes them bleed; only its roar stuns.
    const swipe = bear.attacks.find((a) => a.damage === hardest)!;
    expect(swipe.perfect?.effect).toBe("bleeding");
    expect(bear.attacks.some((a) => a.name === "Roar" && a.perfect?.effect === "stunned")).toBe(true);
  });

  it("has a boss of its own: bigger, and its roar shakes the whole crew", () => {
    const big = ENEMIES.great_bear;
    expect(big.boss).toBe(true);
    expect(big.hp).toBeGreaterThan(ENEMIES.bear.hp);
    expect(big.speed).toBeLessThan(ENEMIES.alpha.speed);
    expect(big.attacks.some((a) => a.target === "all_heroes" && a.perfect?.effect === "stunned")).toBe(true);
  });

  it("drops fur and bone, and the Great Bear more of it", () => {
    expect(ENEMY_DROPS.bear).toEqual(["fur", "bone"]);
    expect(ENEMY_DROPS.great_bear).toEqual(["fur", "bone"]);
    for (let seed = 1; seed <= 200; seed++) {
      const one = battleDrops(makeRng(seed), ["bear"]);
      for (const k of Object.keys(one)) expect(["fur", "bone"]).toContain(k);
      const units = (r: Record<string, number | undefined>) => Object.values(r).reduce((a: number, n) => a + (n ?? 0), 0);
      expect(units(one)).toBeGreaterThanOrEqual(1);
      expect(units(battleDrops(makeRng(seed), ["great_bear"]))).toBeGreaterThan(3);
    }
  });
});

describe("where bears turn up", () => {
  it("roams ashore alone, or as a pair when the ship is full", () => {
    expect(ROAMER_LEADS).toContain("bear");
    expect(bandKinds("bear", 1)).toEqual(["bear"]);
    expect(bandKinds("bear", 3)).toEqual(["bear"]);
    expect(bandKinds("bear", 4)).toEqual(["bear", "bear"]);
    // The old bands are sized as they always were.
    expect(bandKinds("wolf", 2)).toEqual(["wolf", "wolf"]);
    expect(bandKinds("bandit", 4)).toEqual(["bandit", "archer", "bandit"]);
  });

  it("comes ashore with the other bands on some islands", () => {
    let bears = 0;
    for (let i = 0; i < 40; i++) {
      let s = createWorld("ABCD", `bears-${i}`);
      s = must(s, { type: "join", hero: heroInit("p1", "qa_paladin", "mace") });
      s = must(s, { type: "start", heroId: "p1" });
      s = must(s, { type: "begin", bible: buildBible(STORY_FRAMES[0], CANNED_FILLS.stolen_relic[0]) });
      bears += (s.roamers ?? []).filter((r) => r.kinds.includes("bear")).length;
    }
    expect(bears).toBeGreaterThan(0);
  });

  it("can hold a camp", () => {
    const camps = new Set<string>();
    for (const frame of STORY_FRAMES.filter((f) => ["stolen_relic", "rescue"].includes(f.id))) {
      for (let seed = 1; seed <= 60; seed++) camps.add(JSON.stringify(buildBible(frame, CANNED_FILLS[frame.id][0], frame.demands[0], makeRng(seed)).encounters.camp));
    }
    expect(camps).toContain(JSON.stringify(["bear"]));
  });

  it("dens alone as the Great Bear when the hunt's beast is a bear, and wolves keep their pack leader", () => {
    expect(isBearHunt(bearFill)).toBe(true);
    const bible = buildBible(hunt, bearFill);
    expect(bible.encounters.lair).toEqual(["great_bear"]);
    expect(validateBible(bible, generateMap("bear-den"))).toEqual([]);
    for (const fill of wolfFills) expect(buildBible(hunt, fill).encounters.lair).toEqual(["alpha", "wolf"]);
    expect(isBearHunt({ villain_description: "A she-bear grown bold on stolen stores." })).toBe(true);
    expect(isBearHunt({ villain_description: "A wolf that bears a grudge." })).toBe(false);
  });

  it("is offered to the storyteller as a beast to hunt", () => {
    expect(hunt.hints!.villain!.some((h) => /\bbear\b/.test(h))).toBe(true);
    expect(hunt.fields.villain).toMatch(/bear/);
    const offered = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) offered.add(storyHints(makeRng(seed), hunt).villain);
    expect([...offered].some((h) => /\bbear\b/.test(h))).toBe(true);
  });

  it("names the Great Bear after the story's villain", () => {
    let s = createWorld("TEST", "great-bear");
    s = must(s, { type: "join", hero: heroInit("p1", "qa_paladin", "mace") });
    s = must(s, { type: "start", heroId: "p1" });
    s = must(s, { type: "begin", bible: buildBible(hunt, bearFill) });
    s = { ...s, roamers: undefined, seen: undefined, heroes: s.heroes.map((h) => ({ ...h, pos: poiById(s.map, "lair")!.pos, hp: 900, maxHp: 900 })) };
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    const boss = s.battle!.combatants.find((c) => c.kind === "great_bear")!;
    expect(boss.name).toBe(bearFill.villain_name);
    expect(s.battle!.boss).toBe(true);
  });

  it("is in the balance simulation's fights", () => {
    const ids = SIM_ENCOUNTERS.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["band:bear", "camp:bear", "lair:great_bear"]));
  });
});
