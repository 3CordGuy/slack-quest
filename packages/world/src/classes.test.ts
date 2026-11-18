// The classes brought over from the old game: each is complete, and their
// passives and special abilities do what they say: the Druid's regrowth, the
// Bard's aura, the Warden's opening guard, Taunt and Bulwark Strike, and the
// Warlock's bleeding perfect hits, Hex and Soul Drain.

import { describe, expect, it } from "vitest";
import { LEVELUP_AUTO_ALLOC, STARTING_STATS } from "@gantt-quest/core";
import {
  ABILITIES,
  BARD_AURA,
  DRUID_REGEN,
  DUMMY_KIND,
  HERO_CLASSES,
  WARLOCK_BLEED_TURNS,
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
  return { id, name: id, classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, ...gearSheet(classId, []), weapon: HERO_CLASSES.find((c) => c.id === classId)!.weapons[0] };
}

describe("hero classes", () => {
  it("offers all eight, each with stats, levelling, weapons of its own and abilities that exist", () => {
    expect(HERO_CLASSES.map((c) => c.id)).toEqual(["qa_paladin", "devops_mage", "refactor_rogue", "backend_druid", "frontend_bard", "staff_sage", "sre_warden", "data_warlock"]);
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
    for (const id of ["backend_druid", "frontend_bard", "staff_sage", "sre_warden", "data_warlock"]) expect(start(id).some((a) => a.damage)).toBe(true);
    for (const id of ["backend_druid", "frontend_bard"]) expect(start(id).some((a) => a.heal && a.target === "ally")).toBe(true);
  });
});

/** Play `who` against the dummy, always with `ability`, and collect every event. */
function spar(heroes: HeroInit[], ability: Record<string, string>, seed: number, turns = 12, enemies = [DUMMY_KIND], dummyHp?: number) {
  const rng = makeRng(seed);
  let { state } = createBattle({ heroes: heroes.map((h) => heroCombatant(h)), enemyKinds: enemies, avgLevel: 1, poiId: "ring" }, rng);
  if (dummyHp) state = { ...state, combatants: state.combatants.map((c) => (c.side === "enemy" ? { ...c, hp: dummyHp, maxHp: dummyHp } : c)) };
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
  it("lets the Reef Druid grow back at the start of each of its turns", () => {
    const { events } = spar([hero("d", "backend_druid")], { d: "thornlash" }, 3);
    const regrowth = events.filter((e) => e.t === "heal" && e.ability === "Deep Roots");
    expect(regrowth.length).toBeGreaterThan(0);
    for (const e of regrowth) if (e.t === "heal") expect(e.amount).toBeLessThanOrEqual(DRUID_REGEN);
  });

  it("does not regrow anyone else", () => {
    const { events } = spar([hero("m", "devops_mage")], { m: "shock" }, 3);
    expect(events.some((e) => e.t === "heal" && e.ability === "Deep Roots")).toBe(false);
  });

  it("makes the other heroes hit harder while a Shanty Bard stands, but not the Bard itself", () => {
    // The same rolls with and without a Bard aboard: the paladin's hits differ by exactly the aura when every roll lands.
    const perfectHits = (withBard: boolean) => {
      const party = withBard ? [hero("p", "qa_paladin"), hero("b", "frontend_bard")] : [hero("p", "qa_paladin")];
      const hits: number[] = [];
      for (let seed = 0; seed < 60; seed++) {
        const { events } = spar(party, { p: "bash", b: "dissonance" }, seed, 2);
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

describe("Tidewall Warden", () => {
  it("does not guard any other class at the start of a fight", () => {
    const heroes = HERO_CLASSES.filter((c) => c.id !== "sre_warden").map((c) => heroCombatant(hero(c.id, c.id)));
    const { state } = createBattle({ heroes, enemyKinds: [DUMMY_KIND], avgLevel: 1, poiId: "ring" }, makeRng(1));
    for (const c of state.combatants) expect(c.effects.some((e) => e.kind === "guarded"), c.id).toBe(false);
  });

});

describe("Wreck Warlock", () => {
  it("leaves the target bleeding on every perfect hit, and only on a perfect hit", () => {
    let perfects = 0;
    let plain = 0;
    for (let seed = 0; seed < 60; seed++) {
      const { events } = spar([hero("k", "data_warlock")], { k: "hex" }, seed, 6, [DUMMY_KIND], 500);
      events.forEach((e, i) => {
        if (e.t !== "hit" || e.actor !== "k") return;
        // The effects this hit applied: Hex's own (glitched) and the Warlock's bleed.
        const after: BattleEvent[] = [];
        for (let j = i + 1; j < events.length && events[j].t === "effect"; j++) after.push(events[j]);
        const bled = after.some((x) => x.t === "effect" && x.effect === "bleeding");
        if (e.perfect) {
          perfects += 1;
          expect(after).toContainEqual({ t: "effect", target: e.target, effect: "bleeding", turns: WARLOCK_BLEED_TURNS });
        } else {
          plain += 1;
          expect(bled).toBe(false);
        }
      });
    }
    expect(perfects).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
  });

  it("heals itself a third of the damage Soul Drain deals", () => {
    let drains = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { events } = spar([hero("k", "data_warlock")], { k: "soul_drain" }, seed, 6, [DUMMY_KIND], 500);
      events.forEach((e, i) => {
        if (e.t !== "heal" || e.ability !== "Soul Drain") return;
        drains += 1;
        // The hit it drained from: just before, or before the bleeding a perfect hit leaves.
        const hit = events.slice(0, i).reverse().find((x) => x.t === "hit" && x.actor === "k")!;
        expect(hit).toBeDefined();
        if (hit.t === "hit") expect(e.amount).toBeLessThanOrEqual(Math.max(1, Math.round(hit.amount * ABILITIES.soul_drain.drain!)));
      });
    }
    expect(drains).toBeGreaterThan(0);
  });
});
