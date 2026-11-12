// The classes brought over from the old game: each is complete, and their
// passives and special abilities do what they say: the Druid's regrowth, the
// Bard's aura, the Warden's opening guard, Taunt and Bulwark Strike, and the
// Warlock's bleeding perfect hits, Hex and Soul Drain.

import { describe, expect, it } from "vitest";
import { LEVELUP_AUTO_ALLOC, STARTING_STATS } from "@gantt-quest/core";
import {
  ABILITIES,
  ARMOR_DAMAGE_DIVISOR,
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
  return { id, name: id, classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, ...gearSheet(classId, []) };
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
    const { events } = spar([hero("m", "devops_mage")], { m: "firebolt" }, 3);
    expect(events.some((e) => e.t === "heal" && e.ability === "Deep Roots")).toBe(false);
  });

  it("makes the other heroes hit harder while a Shanty Bard stands, but not the Bard itself", () => {
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

describe("Lighthouse Warden", () => {
  it("starts every fight guarded, and keeps the guard through its first turn until its second", () => {
    for (let seed = 0; seed < 20; seed++) {
      const rng = makeRng(seed);
      const { state: start } = createBattle({ heroes: [heroCombatant(hero("w", "sre_warden")), heroCombatant(hero("p", "qa_paladin"))], enemyKinds: [DUMMY_KIND], avgLevel: 1, poiId: "ring" }, rng);
      const guarded = (s: BattleState, id: string) => s.combatants.find((c) => c.id === id)!.effects.some((e) => e.kind === "guarded");
      expect(guarded(start, "w")).toBe(true);
      expect(guarded(start, "p")).toBe(false);
      // Both heroes attack, never guarding themselves, so any guard the Warden has is the passive's.
      let state = start;
      let wardenTurns = 0;
      for (let i = 0; i < 8 && state.status === "active"; i++) {
        const actor = currentActor(state)!;
        if (actor.id === "w") {
          wardenTurns += 1;
          // At the start of its first turn the guard is still up; at its second it is gone.
          expect(guarded(state, "w")).toBe(wardenTurns === 1);
        }
        const res = stepBattle(state, actor.id, { type: "ability", ability: actor.id === "w" ? "bulwark_strike" : "smite", target: "e0" }, rng);
        if (!res.ok) throw new Error(res.error);
        state = res.state;
      }
      expect(wardenTurns).toBeGreaterThanOrEqual(2);
    }
  });

  it("does not guard any other class at the start of a fight", () => {
    const heroes = HERO_CLASSES.filter((c) => c.id !== "sre_warden").map((c) => heroCombatant(hero(c.id, c.id)));
    const { state } = createBattle({ heroes, enemyKinds: [DUMMY_KIND], avgLevel: 1, poiId: "ring" }, makeRng(1));
    for (const c of state.combatants) expect(c.effects.some((e) => e.kind === "guarded"), c.id).toBe(false);
  });

  it("draws every single-target enemy attack onto itself while taunting, until its next turn", () => {
    // Three dummies swing at a party of three. The Warden taunts every turn; the
    // others only look after themselves, so the fight runs long.
    let taunted = 0;
    let elsewhere = 0;
    for (let seed = 0; seed < 30; seed++) {
      const party = [hero("w", "sre_warden"), hero("p", "qa_paladin"), hero("m", "devops_mage")];
      const { events } = spar(party, { w: "taunt", p: "shield_wall", m: "mend" }, seed, 30, [DUMMY_KIND, DUMMY_KIND, DUMMY_KIND]);
      let active = false;
      for (const e of events) {
        if (e.t === "effect" && e.target === "w" && e.effect === "taunting") active = true;
        else if ((e.t === "turn" && e.id === "w") || (e.t === "down" && e.id === "w")) active = false;
        else if ((e.t === "hit" || e.t === "miss") && e.actor.startsWith("e")) {
          if (active) {
            expect(e.target).toBe("w");
            taunted += 1;
          } else if (e.target !== "w") elsewhere += 1;
        }
      }
    }
    expect(taunted).toBeGreaterThan(20);
    // Without a taunt up, the dummies spread their swings around as usual.
    expect(elsewhere).toBeGreaterThan(0);
  });

  it("adds a share of its armor to Bulwark Strike", () => {
    const perfect = (armor: number) => {
      const hits = new Set<number>();
      for (let seed = 0; seed < 60; seed++) {
        const { events } = spar([{ ...hero("w", "sre_warden"), armor }], { w: "bulwark_strike" }, seed, 2);
        for (const e of events) if (e.t === "hit" && e.actor === "w" && e.perfect) hits.add(e.amount);
      }
      expect(hits.size).toBe(1);
      return [...hits][0];
    };
    expect(perfect(9) - perfect(0)).toBe(Math.floor(9 / ARMOR_DAMAGE_DIVISOR));
  });
});

describe("Wreck Warlock", () => {
  it("lands Hex harder on bigger enemies: about 5% of their max HP", () => {
    const perfect = (hp: number) => {
      const hits = new Set<number>();
      for (let seed = 0; seed < 60; seed++) {
        const { events } = spar([hero("k", "data_warlock")], { k: "hex" }, seed, 2, [DUMMY_KIND], hp);
        for (const e of events) if (e.t === "hit" && e.actor === "k" && e.perfect) hits.add(e.amount);
      }
      expect(hits.size).toBe(1);
      return [...hits][0];
    };
    expect(perfect(400) - perfect(60)).toBe(20 - 3);
  });

  it("leaves the target bleeding on every perfect hit, and only on a perfect hit", () => {
    let perfects = 0;
    let plain = 0;
    for (let seed = 0; seed < 60; seed++) {
      const { events } = spar([hero("k", "data_warlock")], { k: "hex" }, seed, 6, [DUMMY_KIND], 500);
      events.forEach((e, i) => {
        if (e.t !== "hit" || e.actor !== "k") return;
        const next = events[i + 1];
        const bled = next?.t === "effect" && next.effect === "bleeding";
        if (e.perfect) {
          perfects += 1;
          expect(events[i + 1]).toEqual({ t: "effect", target: e.target, effect: "bleeding", turns: WARLOCK_BLEED_TURNS });
        } else {
          plain += 1;
          expect(bled).toBe(false);
        }
      });
    }
    expect(perfects).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
  });

  it("does not make anyone else's perfect hits bleed", () => {
    for (let seed = 0; seed < 40; seed++) {
      const { events } = spar([hero("s", "staff_sage")], { s: "manifest" }, seed, 6, [DUMMY_KIND], 500);
      expect(events.some((e) => e.t === "effect" && e.effect === "bleeding")).toBe(false);
    }
  });

  it("heals itself half the damage Soul Drain deals", () => {
    let drains = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { events } = spar([hero("k", "data_warlock")], { k: "soul_drain" }, seed, 6, [DUMMY_KIND], 500);
      events.forEach((e, i) => {
        if (e.t !== "heal" || e.ability !== "Soul Drain") return;
        drains += 1;
        // The hit it drained from: just before, or before the bleeding a perfect hit leaves.
        const hit = events.slice(0, i).reverse().find((x) => x.t === "hit" && x.actor === "k")!;
        expect(hit).toBeDefined();
        if (hit.t === "hit") expect(e.amount).toBeLessThanOrEqual(Math.max(1, Math.round(hit.amount / 2)));
      });
    }
    expect(drains).toBeGreaterThan(0);
  });
});
