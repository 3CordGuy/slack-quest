// The classes brought over from the old game: each is complete, and the two
// passives (the Druid's regrowth, the Bard's aura) do what they say.

import { describe, expect, it } from "vitest";
import { LEVELUP_AUTO_ALLOC, STARTING_STATS } from "@gantt-quest/core";
import {
  ABILITIES,
  BARD_AURA,
  DRUID_REGEN,
  DUMMY_KIND,
  HERO_CLASSES,
  WEAPONS,
  createBattle,
  currentActor,
  gearSheet,
  heroCombatant,
  makeRng,
  rollItem,
  stepBattle,
  type BattleEvent,
  type BattleState,
  type HeroInit,
} from "./index";

function hero(id: string, classId: string): HeroInit {
  return { id, name: id, classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, ...gearSheet(classId, []) };
}

describe("hero classes", () => {
  it("offers all six, each with stats, levelling, weapons of its own and abilities that exist", () => {
    expect(HERO_CLASSES.map((c) => c.id)).toEqual(["qa_paladin", "devops_mage", "refactor_rogue", "backend_druid", "frontend_bard", "staff_sage"]);
    for (const cls of HERO_CLASSES) {
      expect(STARTING_STATS[cls.id], cls.id).toBeDefined();
      expect(LEVELUP_AUTO_ALLOC[cls.id]?.length, cls.id).toBeGreaterThan(0);
      expect(cls.weapons.length).toBeGreaterThanOrEqual(2);
      for (const w of cls.weapons) {
        expect(WEAPONS[w]?.classId, w).toBe(cls.id);
        for (const a of WEAPONS[w].abilities) expect(ABILITIES[a], a).toBeDefined();
      }
      // Loot rolled for the class only ever gives it weapons it can use.
      const rng = makeRng(cls.id.length);
      for (let i = 0; i < 40; i++) {
        const item = rollItem(rng, cls.id, 0.5, 3, "main_hand");
        expect(WEAPONS[item.ref]?.classId).toBe(cls.id);
      }
    }
  });

  it("gives every new class a starting weapon that can both hurt and, for the healers, heal", () => {
    const start = (id: string) => WEAPONS[HERO_CLASSES.find((c) => c.id === id)!.weapons[0]].abilities.map((a) => ABILITIES[a]);
    for (const id of ["backend_druid", "frontend_bard", "staff_sage"]) expect(start(id).some((a) => a.damage)).toBe(true);
    for (const id of ["backend_druid", "frontend_bard"]) expect(start(id).some((a) => a.heal && a.target === "ally")).toBe(true);
  });
});

/** Play `who` against the dummy, always with `ability`, and collect every event. */
function spar(heroes: HeroInit[], ability: Record<string, string>, seed: number, turns = 12) {
  const rng = makeRng(seed);
  let { state } = createBattle({ heroes: heroes.map((h) => heroCombatant(h)), enemyKinds: [DUMMY_KIND], avgLevel: 1, poiId: "ring" }, rng);
  const events: BattleEvent[] = [];
  const hurt = (s: BattleState) => ({ ...s, combatants: s.combatants.map((c) => (c.side === "hero" ? { ...c, hp: Math.max(1, c.hp - 10) } : c)) });
  state = hurt(state);
  for (let i = 0; i < turns && state.status === "active"; i++) {
    const actor = currentActor(state)!;
    const res = stepBattle(state, actor.id, { type: "ability", ability: ability[actor.id], target: ABILITIES[ability[actor.id]].target === "ally" ? actor.id : "e0" }, rng);
    if (!res.ok) throw new Error(res.error);
    events.push(...res.events);
    state = res.state;
  }
  return { state, events };
}

describe("class passives", () => {
  it("lets the Backend Druid grow back at the start of each of its turns", () => {
    const { events } = spar([hero("d", "backend_druid")], { d: "thornlash" }, 3);
    const regrowth = events.filter((e) => e.t === "heal" && e.ability === "Deep Roots");
    expect(regrowth.length).toBeGreaterThan(0);
    for (const e of regrowth) if (e.t === "heal") expect(e.amount).toBeLessThanOrEqual(DRUID_REGEN);
  });

  it("does not regrow anyone else", () => {
    const { events } = spar([hero("m", "devops_mage")], { m: "firebolt" }, 3);
    expect(events.some((e) => e.t === "heal" && e.ability === "Deep Roots")).toBe(false);
  });

  it("makes the other heroes hit harder while a Frontend Bard stands, but not the Bard itself", () => {
    // The same rolls with and without a Bard aboard: the paladin's hits differ by exactly the aura when every roll lands.
    const perfectHits = (withBard: boolean) => {
      const party = withBard ? [hero("p", "qa_paladin"), hero("b", "frontend_bard")] : [hero("p", "qa_paladin")];
      const hits: number[] = [];
      for (let seed = 0; seed < 60; seed++) {
        const { events } = spar(party, { p: "smite", b: "dissonance" }, seed, 2);
        for (const e of events) if (e.t === "hit" && e.actor === "p" && e.perfect) hits.push(e.amount);
      }
      return hits;
    };
    const plain = new Set(perfectHits(false));
    const played = new Set(perfectHits(true));
    expect(plain.size).toBe(1);
    expect(played.size).toBe(1);
    expect([...played][0] - [...plain][0]).toBe(BARD_AURA);
  });
});
