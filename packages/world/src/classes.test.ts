// The hero classes as data: each is complete, with stats, levelling, weapons
// of its own and abilities that exist. What their passives and abilities do
// in a fight is in zone/zone.test.ts.

import { describe, expect, it } from "vitest";
import { LEVELUP_AUTO_ALLOC, STARTING_STATS } from "@gantt-quest/core";
import { ABILITIES, HERO_CLASSES, SHIPS_GUNS, WEAPONS, WEAPON_ICON, equipProblem, makeRng, rollItem, weaponItem } from "./index";

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
      // Loot rolled for the class only ever gives it weapons it can use: its own, or a ship's gun anyone can.
      const rng = makeRng(cls.id.length);
      for (let i = 0; i < 40; i++) {
        const item = rollItem(rng, cls.id, 0.5, 3, "main_hand");
        expect(equipProblem(item, cls.id, 99), item.ref).toBeNull();
      }
    }
  });

  it("drops the ship's guns for any class, and lets any class equip and fire them", () => {
    expect(SHIPS_GUNS.sort()).toEqual(["blunderbuss", "harpoon_gun", "pistol"]);
    for (const id of SHIPS_GUNS) {
      expect(WEAPON_ICON[id], id).toBeTruthy();
      for (const a of WEAPONS[id].abilities) expect(ABILITIES[a], a).toBeDefined();
    }
    for (const cls of HERO_CLASSES) {
      const rng = makeRng(7);
      const seen = new Set<string>();
      for (let i = 0; i < 300; i++) seen.add(rollItem(rng, cls.id, 0.3, 3, "main_hand").ref);
      for (const id of SHIPS_GUNS) {
        expect(seen.has(id), `${cls.id} finds a ${id}`).toBe(true);
        expect(equipProblem(weaponItem(id), cls.id, 1)).toBeNull();
      }
    }
  });

  it("gives every new class a starting weapon that can both hurt and, for the healers, heal", () => {
    const start = (id: string) => WEAPONS[HERO_CLASSES.find((c) => c.id === id)!.weapons[0]].abilities.map((a) => ABILITIES[a]);
    for (const id of ["backend_druid", "frontend_bard", "staff_sage", "sre_warden", "data_warlock"]) expect(start(id).some((a) => a.damage)).toBe(true);
    for (const id of ["backend_druid", "frontend_bard"]) expect(start(id).some((a) => a.heal && a.target === "ally")).toBe(true);
  });
});

describe("signature weapons", () => {
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
});
