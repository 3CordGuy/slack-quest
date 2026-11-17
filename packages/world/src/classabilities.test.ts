import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import { ABILITY_POOLS, ABILITY_SLOTS, abilitySlotError, classAbilitiesOf, parseAbilityLoadout, withAbilityInSlot, withClassAbilities, type AbilityPools } from "./classabilities";
import { ABILITIES, HERO_CLASSES, abilitiesFor } from "./content";
import { TACTICS } from "./zone/kit";
import { heroCombatant, type HeroSheet } from "./hero";
import { zoneHero } from "./zone/zone";

// Real pools are still empty, so the rules are tried on a made-up one.
const pools: AbilityPools = {
  qa_paladin: [
    { id: "smite", level: 1 },
    { id: "cleave", level: 1 },
    { id: "heavy_blow", level: 1 },
    { id: "shield_wall", level: 5 },
  ],
};

describe("class ability pools", () => {
  it("only name abilities that exist, with a tactic for the zone, for a class that exists", () => {
    for (const [classId, pool] of Object.entries(ABILITY_POOLS)) {
      expect(HERO_CLASSES.some((c) => c.id === classId), classId).toBe(true);
      for (const e of pool) {
        expect(ABILITIES[e.id], e.id).toBeDefined();
        expect(TACTICS[e.id], e.id).toBeDefined();
      }
    }
  });
  it("has a pool (possibly empty) for every class", () => {
    for (const c of HERO_CLASSES) expect(ABILITY_POOLS[c.id], c.id).toBeDefined();
  });
});

describe("parseAbilityLoadout", () => {
  it("always gives one entry per slot", () => {
    expect(parseAbilityLoadout(undefined)).toEqual([null, null, null]);
    expect(parseAbilityLoadout("[]")).toEqual([null, null, null]);
    expect(parseAbilityLoadout('["smite"]')).toEqual(["smite", null, null]);
    expect(parseAbilityLoadout('["smite",null,"cleave","heavy_blow"]')).toHaveLength(ABILITY_SLOTS);
  });
  it("drops what is malformed or unknown", () => {
    expect(parseAbilityLoadout("not json")).toEqual([null, null, null]);
    expect(parseAbilityLoadout('{"a":1}')).toEqual([null, null, null]);
    expect(parseAbilityLoadout('[1,"no_such_ability","smite"]')).toEqual([null, null, "smite"]);
  });
});

describe("abilitySlotError", () => {
  it("allows a pool ability the hero's level reaches, and emptying a slot", () => {
    expect(abilitySlotError("qa_paladin", 1, 0, "smite", pools)).toBeNull();
    expect(abilitySlotError("qa_paladin", 1, 2, null, pools)).toBeNull();
  });
  it("refuses another class's ability, a bad slot, and one not yet opened", () => {
    expect(abilitySlotError("devops_mage", 9, 0, "smite", pools)).toMatch(/class's abilities/);
    expect(abilitySlotError("qa_paladin", 1, 3, "smite", pools)).toMatch(/no such slot/);
    expect(abilitySlotError("qa_paladin", 1, -1, "smite", pools)).toMatch(/no such slot/);
    expect(abilitySlotError("qa_paladin", 1, 0, "shield_wall", pools)).toMatch(/level 5/);
    expect(abilitySlotError("qa_paladin", 5, 0, "shield_wall", pools)).toBeNull();
  });
});

describe("withAbilityInSlot", () => {
  it("fills and empties a slot", () => {
    expect(withAbilityInSlot([null, null, null], 1, "smite")).toEqual([null, "smite", null]);
    expect(withAbilityInSlot([null, "smite", null], 1, null)).toEqual([null, null, null]);
  });
  it("trades places rather than putting one ability in two slots", () => {
    expect(withAbilityInSlot(["smite", "cleave", null], 1, "smite")).toEqual(["cleave", "smite", null]);
    expect(withAbilityInSlot(["smite", null, null], 2, "smite")).toEqual([null, null, "smite"]);
  });
  it("does not change what it was given", () => {
    const before: (string | null)[] = ["smite", null, null];
    withAbilityInSlot(before, 1, "cleave");
    expect(before).toEqual(["smite", null, null]);
  });
});

describe("classAbilitiesOf", () => {
  it("gives the slotted abilities the hero's level has opened, in slot order", () => {
    expect(classAbilitiesOf("qa_paladin", 1, ["cleave", null, "smite"], pools)).toEqual(["cleave", "smite"]);
    expect(classAbilitiesOf("qa_paladin", 1, ["smite", "shield_wall", null], pools)).toEqual(["smite"]);
    expect(classAbilitiesOf("qa_paladin", 5, ["smite", "shield_wall", null], pools)).toEqual(["smite", "shield_wall"]);
  });
  it("ignores another class's picks, repeats and nothing at all", () => {
    expect(classAbilitiesOf("devops_mage", 9, ["smite", null, null], pools)).toEqual([]);
    expect(classAbilitiesOf("qa_paladin", 1, ["smite", "smite", "smite"], pools)).toEqual(["smite"]);
    expect(classAbilitiesOf("qa_paladin", 1, undefined, pools)).toEqual([]);
  });
});

describe("withClassAbilities", () => {
  it("puts the class's after the weapon's, with none twice", () => {
    expect(withClassAbilities(["smite", "shield_wall"], ["cleave", "smite"])).toEqual(["smite", "shield_wall", "cleave"]);
    expect(withClassAbilities(["punch"], undefined)).toEqual(["punch"]);
  });
});

describe("a hero's loadout, as they go into a fight", () => {
  // The real Paladin pool, lent an entry for these tests and given back after.
  let saved: typeof ABILITY_POOLS.qa_paladin;
  beforeEach(() => {
    saved = ABILITY_POOLS.qa_paladin;
    ABILITY_POOLS.qa_paladin = [{ id: "cleave", level: 1 }, { id: "heavy_blow", level: 4 }];
  });
  afterEach(() => {
    ABILITY_POOLS.qa_paladin = saved;
  });

  const sheet = (level: number, abilityLoadout: (string | null)[]): HeroSheet => ({
    id: "ann", name: "Ann", classId: "qa_paladin", level, base: STARTING_STATS.qa_paladin, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0, abilityLoadout,
  });

  it("adds what the level has opened to the weapon's, in a voyage battle", () => {
    expect(heroCombatant(sheet(1, ["cleave", "heavy_blow", null])).abilities).toEqual([...abilitiesFor("mace"), "cleave"]);
    expect(heroCombatant(sheet(4, ["cleave", "heavy_blow", null])).abilities).toEqual([...abilitiesFor("mace"), "cleave", "heavy_blow"]);
  });

  it("adds the same in a zone", () => {
    expect(zoneHero(sheet(1, ["cleave", "heavy_blow", null])).classAbilities).toEqual(["cleave"]);
    expect(zoneHero(sheet(4, [null, "heavy_blow", "cleave"])).classAbilities).toEqual(["heavy_blow", "cleave"]);
  });

  it("adds nothing for an empty loadout, or none at all", () => {
    expect(heroCombatant(sheet(4, [null, null, null])).abilities).toEqual(abilitiesFor("mace"));
    expect(heroCombatant({ ...sheet(4, []), abilityLoadout: undefined }).abilities).toEqual(abilitiesFor("mace"));
  });
});
