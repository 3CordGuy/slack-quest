// Class traits (picked at levels 2 and 4) and the signature weapons' abilities.

import { describe, expect, it } from "vitest";
import {
  ABILITIES,
  HERO_CLASSES,
  POTION_HEAL,
  TRAITS,
  TRAIT_LEVELS,
  WEAPONS,
  createBattle,
  makeRng,
  parseTraits,
  pendingTraitTiers,
  rollItem,
  stepBattle,
  traitPickError,
  traitsFor,
  type BattleState,
  type Combatant,
} from "./index";

const hero = (id: string, over: Partial<Combatant> = {}): Combatant => ({
  id, side: "hero", name: id, kind: "qa_paladin", level: 1, hp: 60, maxHp: 60,
  pct: { str: 100, int_stat: 100, vit: 100, agi: 100, dex: 100 },
  power: 0, armor: 0, speed: 100, focus: 3, potions: 2,
  abilities: ["smite", "shield_wall", "full_reckoning", "thunderhead", "land_the_catch", "riptide", "all_hands", "plot_the_course", "lighthouse_beam", "red_tide", "firebolt"],
  effects: [], down: false, traits: [], ...over,
});
const fight = (heroes: Combatant[], enemies = ["dummy"], seed = 3) => createBattle({ heroes, enemyKinds: enemies, avgLevel: 1, poiId: null }, makeRng(seed)).state;
/** Give the dummy (or e0) plenty of HP and some effects. */
const tune = (s: BattleState, over: Partial<Combatant>, id = "e0"): BattleState => ({ ...s, combatants: s.combatants.map((c) => (c.id === id ? { ...c, ...over } : c)) });
const ok = (r: ReturnType<typeof stepBattle>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};
const hitOf = (r: ReturnType<typeof ok>, actor = "h") => {
  const e = r.events.find((x) => x.t === "hit" && x.actor === actor);
  return e?.t === "hit" ? e.amount : -1;
};
/** The hero's hit with `traits`, against a target set up by `over`. */
const strike = (ability: string, traits: string[], over: Partial<Combatant> = {}, heroOver: Partial<Combatant> = {}) => {
  const s = tune(fight([hero("h", { traits, ...heroOver })]), { hp: 500, maxHp: 500, ...over });
  if (s.actor !== "h") throw new Error("hero should act first");
  return hitOf(ok(stepBattle(s, "h", { type: "ability", ability, target: "e0" }, makeRng(1))));
};

describe("trait data", () => {
  it("gives every class two choices at each trait level", () => {
    for (const c of HERO_CLASSES) {
      const mine = traitsFor(c.id);
      expect(mine.filter((t) => t.tier === 1)).toHaveLength(2);
      expect(mine.filter((t) => t.tier === 2)).toHaveLength(2);
    }
    expect(new Set(TRAITS.map((t) => t.id)).size).toBe(TRAITS.length);
  });

  it("opens picks at levels 2 and 4, one per tier, for keeps", () => {
    expect(TRAIT_LEVELS).toEqual([2, 4]);
    expect(pendingTraitTiers("qa_paladin", 1, [])).toEqual([]);
    expect(pendingTraitTiers("qa_paladin", 2, [])).toEqual([1]);
    expect(pendingTraitTiers("qa_paladin", 5, [])).toEqual([1, 2]);
    expect(pendingTraitTiers("qa_paladin", 5, ["keelhaul"])).toEqual([2]);
    expect(traitPickError("qa_paladin", 2, [], "keelhaul")).toBeNull();
    expect(traitPickError("qa_paladin", 2, ["keelhaul"], "breakwater_stance")).toMatch(/already/);
    expect(traitPickError("qa_paladin", 3, [], "last_bulkhead")).toMatch(/level 4/);
    expect(traitPickError("qa_paladin", 9, [], "cutthroat")).toMatch(/class/);
    expect(traitPickError("qa_paladin", 9, [], "nope")).toMatch(/class/);
  });

  it("parses a stored list, dropping junk", () => {
    expect(parseTraits('["keelhaul","nope",3]')).toEqual(["keelhaul"]);
    expect(parseTraits("not json")).toEqual([]);
    expect(parseTraits(null)).toEqual([]);
  });
});

describe("trait rules in a fight", () => {
  it("vs_effect: Keelhaul hits Stunned enemies 3 harder", () => {
    const stunned = { effects: [{ kind: "stunned" as const, turns: 1 }] };
    expect(strike("smite", ["keelhaul"], stunned) - strike("smite", [], stunned)).toBe(5);
    expect(strike("smite", ["keelhaul"]) - strike("smite", [])).toBe(0);
  });

  it("per_debuff: Read the Wreckage adds 2 per different debuff", () => {
    const two = { effects: [{ kind: "bleeding" as const, turns: 2 }, { kind: "slowed" as const, turns: 2 }] };
    expect(strike("smite", ["read_the_wreckage"], two) - strike("smite", [], two)).toBe(4);
  });

  it("finisher: Cutthroat does half again to an enemy under a quarter HP", () => {
    const low = { hp: 100, maxHp: 500 };
    expect(strike("smite", ["cutthroat"], low)).toBe(Math.round(strike("smite", [], low) * 1.5));
    expect(strike("smite", ["cutthroat"], { hp: 400, maxHp: 500 })).toBe(strike("smite", [], { hp: 400, maxHp: 500 }));
  });

  it("last_stand: once a fight, a killing blow leaves the hero on 1 HP", () => {
    let saves = 0;
    let downs = 0;
    for (let seed = 1; seed < 30; seed++) {
      let s = fight([hero("h", { hp: 3, speed: 0, traits: ["last_bulkhead"], pct: { str: 0 } })], ["brute", "brute"], seed);
      const rng = makeRng(seed);
      const events = [];
      for (let i = 0; i < 20 && s.status === "active"; i++) {
        const r = ok(stepBattle(s, "h", { type: "ability", ability: "shield_wall" }, rng));
        events.push(...r.events);
        s = r.state;
      }
      const saved = events.filter((e) => e.t === "trait" && e.trait === "last_bulkhead").length;
      expect(saved).toBeLessThanOrEqual(1);
      saves += saved;
      if (s.status === "defeat") downs += 1;
    }
    expect(saves).toBeGreaterThan(0);
    expect(downs).toBeGreaterThan(0);
  });

  it("low_hp_guard: under a third of max HP, the hero starts each turn Guarded", () => {
    const s = fight([hero("h", { hp: 15, traits: ["breakwater_stance"] })]);
    expect(s.combatants.find((c) => c.id === "h")!.effects).toContainEqual({ kind: "guarded", turns: 1 });
    const full = fight([hero("h", { hp: 60, traits: ["breakwater_stance"] })]);
    expect(full.combatants.find((c) => c.id === "h")!.effects.some((e) => e.kind === "guarded")).toBe(false);
  });

  it("regen: Steady Light grows back 1 HP a turn", () => {
    const s = fight([hero("h", { hp: 20, traits: ["steady_light"] })]);
    expect(s.combatants.find((c) => c.id === "h")!.hp).toBe(21);
  });

  it("on_kill_heal: Drowned Debts heals 3 when an enemy goes down", () => {
    const s = tune(fight([hero("h", { hp: 20, traits: ["drowned_debts"] })], ["dummy", "dummy"]), { hp: 1 });
    const r = ok(stepBattle(s, "h", { type: "ability", ability: "smite", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "heal", actor: "h", target: "h", amount: 3, ability: "Drowned Debts" });
  });

  it("ally_perfect_focus: Call and Response gives focus on a crewmate's perfect", () => {
    const s = fight([hero("a", { speed: 100 }), hero("b", { speed: 0, focus: 0, traits: ["call_and_response"] })]);
    const r = ok(stepBattle(s, "a", { type: "ability", ability: "smite", target: "e0" }, makeRng(1)));
    expect(r.state.combatants.find((c) => c.id === "b")!.focus).toBe(1);
  });

  it("first_focus_free: Eye of the Storm refunds the first focus, once", () => {
    let s = tune(fight([hero("h", { focus: 3, traits: ["eye_of_the_storm"] })]), { hp: 500, maxHp: 500 });
    const r1 = ok(stepBattle(s, "h", { type: "ability", ability: "smite", target: "e0", focus: 2 }, makeRng(1)));
    expect(r1.state.combatants.find((c) => c.id === "h")!.focus).toBe(2);
    s = r1.state;
    if (s.actor !== "h") return;
    const r2 = ok(stepBattle(s, "h", { type: "ability", ability: "smite", target: "e0", focus: 1 }, makeRng(1)));
    expect(r2.state.combatants.find((c) => c.id === "h")!.focus).toBe(1);
  });

  it("longer: Squall Line makes the hero's burning last a turn longer", () => {
    const s = tune(fight([hero("h", { traits: ["squall_line"] })]), { hp: 500, maxHp: 500 });
    const r = ok(stepBattle(s, "h", { type: "ability", ability: "firebolt", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "e0", effect: "burning", turns: 4 });
  });

  it("perfect_effect: Spyglass holes the target on a perfect", () => {
    const s = tune(fight([hero("h", { traits: ["spyglass"] })]), { hp: 500, maxHp: 500 });
    const r = ok(stepBattle(s, "h", { type: "ability", ability: "full_reckoning", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "e0", effect: "exposed", turns: 2 });
  });

  it("start_effect: Ride the Storm starts the fight with a Fair Wind", () => {
    const created = createBattle({ heroes: [hero("h", { speed: 0, traits: ["ride_the_storm"] })], enemyKinds: ["dummy"], avgLevel: 1, poiId: null }, makeRng(2));
    expect(created.events).toContainEqual({ t: "trait", id: "h", trait: "ride_the_storm" });
  });

  it("potion_bonus: Sea Legs potions heal 6 more", () => {
    const s = fight([hero("h", { hp: 10, traits: ["sea_legs"] })]);
    const r = ok(stepBattle(s, "h", { type: "potion" }, makeRng(1)));
    expect(r.state.combatants.find((c) => c.id === "h")!.hp).toBe(10 + POTION_HEAL + 6);
  });
});

describe("signature abilities", () => {
  it("every class has a signature weapon of its own, with its own ability first", () => {
    for (const c of HERO_CLASSES) {
      const w = WEAPONS[c.signature];
      expect(w?.classId).toBe(c.id);
      expect(ABILITIES[w.abilities[0]]).toBeTruthy();
      expect(WEAPONS[w.looksLike!]).toBeTruthy();
    }
  });

  it("drops only from good loot", () => {
    const sig = new Set(HERO_CLASSES.map((c) => c.signature));
    let low = 0;
    let high = 0;
    for (let seed = 0; seed < 400; seed++) {
      if (sig.has(rollItem(makeRng(seed), "qa_paladin", 0.2, 3, "main_hand").ref)) low += 1;
      if (sig.has(rollItem(makeRng(seed), "qa_paladin", 0.6, 3, "main_hand").ref)) high += 1;
    }
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(50);
  });

  it("Full Reckoning: +2 per different debuff", () => {
    const two = { effects: [{ kind: "bleeding" as const, turns: 2 }, { kind: "burning" as const, turns: 2 }] };
    expect(strike("full_reckoning", [], two) - strike("full_reckoning", [])).toBe(4);
  });

  it("Thunderhead: +3 on Burning enemies", () => {
    expect(strike("thunderhead", [], { effects: [{ kind: "burning", turns: 2 }] }) - strike("thunderhead", [])).toBe(3);
  });

  it("Land the Catch: double damage under a quarter HP", () => {
    expect(strike("land_the_catch", [], { hp: 100, maxHp: 500 })).toBe(2 * strike("land_the_catch", [], { hp: 400, maxHp: 500 }));
  });

  it("Plot the Course goes through Guarded", () => {
    const guarded = { effects: [{ kind: "guarded" as const, turns: 1 }] };
    expect(strike("plot_the_course", [], guarded)).toBe(strike("plot_the_course", []));
    expect(strike("smite", [], guarded)).toBeLessThan(strike("smite", []));
  });

  it("Red Tide: +2 per turn of Bleeding left, and the bleeding stops", () => {
    const s = tune(fight([hero("h")]), { hp: 500, maxHp: 500, effects: [{ kind: "bleeding", turns: 3 }] });
    const r = ok(stepBattle(s, "h", { type: "ability", ability: "red_tide", target: "e0" }, makeRng(1)));
    expect(hitOf(r)).toBe(strike("red_tide", []) + 6);
    expect(r.state.combatants.find((c) => c.id === "e0")!.effects.some((e) => e.kind === "bleeding")).toBe(false);
  });

  it("All Hands: the crewmate takes the very next turn", () => {
    const s = fight([hero("a", { speed: 100 }), hero("b", { speed: 0 })]);
    expect(s.actor).toBe("a");
    const r = ok(stepBattle(s, "a", { type: "ability", ability: "all_hands", target: "b" }, makeRng(1)));
    expect(r.state.actor).toBe("b");
  });

  it("Riptide becalms every enemy it hits; Lighthouse Beam taunts", () => {
    const s = tune(fight([hero("h")], ["dummy", "dummy"]), { hp: 500, maxHp: 500 });
    const r = ok(stepBattle(s, "h", { type: "ability", ability: "riptide" }, makeRng(1)));
    expect(r.events.filter((e) => e.t === "effect" && e.effect === "slowed")).toHaveLength(2);
    const b = ok(stepBattle(s, "h", { type: "ability", ability: "lighthouse_beam" }, makeRng(1)));
    expect(b.events).toContainEqual({ t: "effect", target: "h", effect: "taunting", turns: 1 });
  });
});
