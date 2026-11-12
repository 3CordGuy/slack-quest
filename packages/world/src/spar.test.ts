// The sparring ring: the shared hero-to-combatant helper, and the dummy.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  DUMMY_KIND,
  ENEMIES,
  STORY_FRAMES,
  pickSpine,
  WEAPONS,
  buildBible,
  createBattle,
  createWorld,
  currentActor,
  freshVitals,
  gearSheet,
  generateMap,
  heroCombatant,
  makeRng,
  maxFocusFor,
  maxHpFor,
  poiById,
  statPct,
  stepBattle,
  stepWorld,
  type HeroInit,
  type ItemDef,
  type WorldAction,
  type WorldState,
} from "./index";

const item = (over: Partial<ItemDef>): ItemDef => ({ kind: "armor", ref: "x", name: "X", rarity: "common", slot: "body", power: 0, statBonus: {}, levelReq: 1, icon: "x", ...over });

/** A level 3 paladin in real gear: a greatsword, a breastplate and a ring. */
const WORN: ItemDef[] = [
  item({ kind: "weapon", ref: "greatsword", name: "Breakwater Greatsword", slot: "main_hand", power: 3, statBonus: { str: 2 }, icon: "greatsword" }),
  item({ kind: "armor", ref: "plate", name: "Breastplate", slot: "body", power: 6, statBonus: { vit: 2 }, icon: "plate" }),
  item({ kind: "armor", ref: "cap", name: "Cap", slot: "helmet", power: 2, icon: "cap" }),
  item({ kind: "trinket", ref: "band", name: "Band", slot: "ring", statBonus: { agi: 1, vit: 1 }, icon: "band" }),
];

function paladin(worn: ItemDef[] = WORN): HeroInit {
  return { id: "p1", name: "Pal", classId: "qa_paladin", level: 3, xp: 5, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, ...gearSheet("qa_paladin", worn) };
}

function must(state: WorldState, action: WorldAction): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  return res.state;
}

describe("gearSheet", () => {
  it("sums what is worn", () => {
    const sheet = gearSheet("qa_paladin", WORN);
    expect(sheet.weapon).toBe("greatsword");
    expect(sheet.weaponPower).toBe(3);
    expect(sheet.armor).toBe(8);
    expect(sheet.bonus).toEqual({ str: 2, vit: 3, agi: 1 });
    expect(sheet.outfit?.main_hand?.ref).toBe("greatsword");
  });

  it("falls back to the class's starting weapon with nothing in hand", () => {
    const sheet = gearSheet("devops_mage", []);
    expect(sheet.weapon).toBe("staff");
    expect(sheet.weaponPower).toBe(0);
  });
});

describe("heroCombatant", () => {
  it("derives abilities, power, armor, percentages and HP from the hero and their gear", () => {
    const hero = paladin();
    const c = heroCombatant(hero);
    const base = STARTING_STATS.qa_paladin;
    const stats = { ...base, str: base.str + 2, vit: base.vit + 3, agi: base.agi + 1 };
    expect(c.abilities).toEqual(WEAPONS.greatsword.abilities);
    expect(c.power).toBe(3);
    expect(c.armor).toBe(8);
    expect(c.pct).toEqual({ str: statPct(stats.str), int_stat: statPct(stats.int_stat), vit: statPct(stats.vit), agi: statPct(stats.agi), dex: statPct(stats.dex) });
    expect(c.speed).toBe(statPct(stats.agi));
    expect(c.maxHp).toBe(maxHpFor(stats, 3));
    expect(c.hp).toBe(c.maxHp);
    expect(c.focus).toBe(maxFocusFor(3));
    expect(c.potions).toBe(1);
    expect(c).toMatchObject({ id: "p1", side: "hero", name: "Pal", kind: "qa_paladin", level: 3, effects: [], down: false });
    expect(c.outfit).toEqual(hero.outfit);
  });

  it("matches the combatant a voyage fields for the same hero", () => {
    const hero = paladin();
    let s = createWorld("SPAR", "spar-seed");
    s = must(s, { type: "join", hero });
    // A rested hero boards with exactly the vitals a bout starts with.
    const aboard = s.heroes[0];
    expect({ hp: aboard.hp, maxHp: aboard.maxHp, focus: aboard.focus, maxFocus: aboard.maxFocus, potions: aboard.potions }).toEqual(freshVitals(hero));

    s = must(s, { type: "start", heroId: "p1" });
    s = must(s, { type: "begin", bible: buildBible(STORY_FRAMES[0], CANNED_FILLS[STORY_FRAMES[0].id][0]) });
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos: poiById(s.map, "camp")!.pos })) };
    s = must(s, { type: "interact", heroId: "p1" });
    expect(s.phase).toBe("battle");
    const fielded = s.battle!.combatants.find((c) => c.id === "p1")!;
    // Enemies may already have swung, so compare everything a blow cannot change.
    const { hp: _hp, effects: _effects, down: _down, ...steady } = heroCombatant(hero);
    expect(fielded).toMatchObject(steady);
  });

  it("carries a voyage's wounds when given them", () => {
    const c = heroCombatant(paladin(), { hp: 4, maxHp: 30, focus: 0, potions: 2 });
    expect(c).toMatchObject({ hp: 4, maxHp: 30, focus: 0, potions: 2 });
  });
});

describe("the training dummy", () => {
  it("is feeble: slow, worth nothing, and never a boss", () => {
    const dummy = ENEMIES[DUMMY_KIND];
    expect(dummy.xp).toBe(0);
    expect(dummy.boss).toBeFalsy();
    const softest = Math.min(...Object.values(ENEMIES).filter((e) => e.kind !== DUMMY_KIND).flatMap((e) => e.attacks.map((a) => a.damage)));
    for (const a of dummy.attacks) expect(a.damage).toBeLessThan(softest);
    expect(dummy.hp).toBeGreaterThan(Math.max(...Object.values(ENEMIES).filter((e) => !e.boss && e.kind !== DUMMY_KIND).map((e) => e.hp)));
  });

  it("can be sparred to a win with a hero's real abilities", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = makeRng(seed);
      const hero = paladin();
      let { state } = createBattle({ heroes: [heroCombatant(hero)], enemyKinds: [DUMMY_KIND], avgLevel: hero.level, poiId: "ring" }, rng);
      expect(state.xp).toBe(0);
      expect(state.boss).toBe(false);
      for (let i = 0; i < 200 && state.status === "active"; i++) {
        expect(currentActor(state)!.id).toBe("p1");
        const res = stepBattle(state, "p1", { type: "ability", ability: "heavy_blow", target: "e0" }, rng);
        if (!res.ok) throw new Error(res.error);
        state = res.state;
      }
      expect(state.status).toBe("victory");
      expect(state.combatants.find((c) => c.id === "p1")!.down).toBe(false);
    }
  });

  it("never turns up on an island", () => {
    for (const frame of STORY_FRAMES) {
      for (const fill of CANNED_FILLS[frame.id]) {
        for (let seed = 0; seed < 40; seed++) {
          const plan = frame.plan(fill, makeRng(seed), pickSpine(frame, makeRng(seed)));
          expect(Object.values(plan.encounters).flat()).not.toContain(DUMMY_KIND);
          for (const cap of plan.capabilities) if (cap.verb === "start_combat") expect(cap.enemies).not.toContain(DUMMY_KIND);
        }
      }
    }
    for (let seed = 0; seed < 40; seed++) {
      for (const poi of generateMap(`island-${seed}`).pois) expect(poi.enemies).not.toContain(DUMMY_KIND);
    }
  });
});
