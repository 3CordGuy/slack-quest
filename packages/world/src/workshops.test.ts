// The apothecary and the smithy: their place among the projects, brew
// recipes and the one-of-each bag, what a bag does to a hero who boards,
// and the smithy's rising costs and +3 cap.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  APOTHECARY_PROJECT,
  BREWS,
  SMITHY_MAX_STEPS,
  SMITHY_PROJECT,
  brewBag,
  brewBuff,
  brewProblem,
  createWorld,
  projectById,
  smithyCost,
  smithyProblem,
  smithyWork,
  stepWorld,
  upgradedName,
  type HeroInit,
} from "./index";

describe("the apothecary and smithy projects", () => {
  it("are open, with the agreed costs", () => {
    expect(projectById(APOTHECARY_PROJECT)).toMatchObject({ open: true, cost: { gold: 250, wood: 25, stone: 15, herbs: 20, mushrooms: 20 } });
    expect(projectById(SMITHY_PROJECT)).toMatchObject({ open: true, cost: { gold: 400, stone: 30, iron: 30, copper: 15 } });
  });
});

describe("brewing", () => {
  const plenty = { herbs: 10, mushrooms: 10, bone: 5 };

  it("has three brews with the agreed recipes and effects", () => {
    expect(BREWS.map((b) => [b.id, b.recipe, b.buff])).toEqual([
      ["healing", { herbs: 3 }, { potions: 1 }],
      ["focus", { herbs: 2, mushrooms: 2 }, { focus: 1 }],
      ["stoneskin", { mushrooms: 3, bone: 1 }, { maxHp: 4 }],
    ]);
  });

  it("needs the apothecary built, the materials, and no brew of that kind already in the bag", () => {
    expect(brewProblem("healing", { built: true, bag: [], resources: plenty })).toBeNull();
    expect(brewProblem("healing", { built: false, bag: [], resources: plenty })).toMatch(/not built/);
    expect(brewProblem("healing", { built: true, bag: ["healing"], resources: plenty })).toMatch(/already carry/);
    expect(brewProblem("focus", { built: true, bag: ["healing", "stoneskin"], resources: plenty })).toBeNull();
    expect(brewProblem("stoneskin", { built: true, bag: [], resources: { mushrooms: 3 } })).toMatch(/1 bone/);
    expect(brewProblem("focus", { built: true, bag: [], resources: { herbs: 2, mushrooms: 1 } })).toMatch(/takes/);
    expect(brewProblem("elixir", { built: true, bag: [], resources: plenty })).toBe("No such brew.");
  });

  it("counts each kind once and ignores unknown ids", () => {
    expect(brewBag(["stoneskin", "healing", "healing", "elixir"])).toEqual(["healing", "stoneskin"]);
    expect(brewBuff(["healing", "healing", "elixir"])).toEqual({ focus: 0, potions: 1, maxHp: 0, xpPct: 0 });
    expect(brewBuff(["healing", "focus", "stoneskin"])).toEqual({ focus: 1, potions: 1, maxHp: 4, xpPct: 0 });
    expect(brewBuff(undefined)).toEqual({ focus: 0, potions: 0, maxHp: 0, xpPct: 0 });
  });

  it("applies a full bag to a hero as they board, and no more than one of each", () => {
    const hero: HeroInit = { id: "p1", name: "P1", classId: "qa_paladin", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0 };
    const plain = stepWorld(createWorld("ABCD", "brews"), { type: "join", hero });
    const brewed = stepWorld(createWorld("ABCD", "brews"), { type: "join", hero: { ...hero, brews: ["healing", "focus", "stoneskin", "stoneskin", "elixir"] } });
    if (!plain.ok || !brewed.ok) throw new Error("join failed");
    const a = plain.state.heroes[0];
    const b = brewed.state.heroes[0];
    expect(b.potions).toBe(a.potions + 1);
    expect(b.focus).toBe(a.focus + 1);
    expect(b.maxFocus).toBe(a.maxFocus + 1);
    expect(b.maxHp).toBe(a.maxHp + 4);
    expect(b.hp).toBe(a.hp + 4);
    expect(b.brews).toEqual(["healing", "focus", "stoneskin"]);
  });
});

describe("the smithy", () => {
  const weapon = { kind: "weapon" as const, name: "Anchor Mace" };
  const armour = { kind: "armor" as const, name: "Ledger Mail" };
  const rich = { built: true, gold: 1000, resources: { iron: 100, copper: 100 } };

  it("sharpens weapons, reinforces armour, and leaves trinkets alone", () => {
    expect(smithyWork(weapon)).toBe("sharpen");
    expect(smithyWork(armour)).toBe("reinforce");
    expect(smithyWork({ kind: "trinket" })).toBeNull();
    expect(smithyProblem({ kind: "trinket", name: "Ring" }, rich)).toMatch(/only works/);
  });

  it("costs more each step: iron and gold for weapons, iron and copper for armour", () => {
    const w = [0, 1, 2].map((n) => smithyCost(weapon, n)!);
    const a = [0, 1, 2].map((n) => smithyCost(armour, n)!);
    expect(w.map((c) => [c.gold, c.resources])).toEqual([[40, { iron: 3 }], [80, { iron: 6 }], [120, { iron: 9 }]]);
    expect(a.map((c) => [c.gold, c.resources])).toEqual([[0, { iron: 2, copper: 2 }], [0, { iron: 4, copper: 4 }], [0, { iron: 6, copper: 6 }]]);
  });

  it("stops at +3", () => {
    expect(SMITHY_MAX_STEPS).toBe(3);
    expect(smithyCost(weapon, 3)).toBeNull();
    expect(smithyProblem({ ...weapon, upgrades: 2 }, rich)).toBeNull();
    expect(smithyProblem({ ...weapon, upgrades: 3 }, rich)).toMatch(/as good as/);
  });

  it("needs the smithy built and the price in hand", () => {
    expect(smithyProblem(weapon, { ...rich, built: false })).toMatch(/not built/);
    expect(smithyProblem(weapon, { ...rich, gold: 39 })).toMatch(/40 gold/);
    expect(smithyProblem({ ...armour, upgrades: 1 }, { ...rich, resources: { iron: 4, copper: 3 } })).toMatch(/4 copper/);
  });

  it("shows the upgrade in the name", () => {
    expect(upgradedName("Anchor Mace", 2)).toBe("Anchor Mace +2");
    expect(upgradedName("Anchor Mace", 0)).toBe("Anchor Mace");
    expect(upgradedName("Anchor Mace", undefined)).toBe("Anchor Mace");
  });
});
