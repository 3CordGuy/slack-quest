import { describe, expect, it } from "vitest";
import {
  RARITIES,
  SLOTS,
  WEAPONS,
  afterArmor,
  createBattle,
  equipProblem,
  itemPrice,
  kindOfSlot,
  loadoutOf,
  makeRng,
  rollItem,
  sellPrice,
  shopStock,
  stepBattle,
  weaponItem,
  type Combatant,
  type ItemDef,
} from "./index";

describe("item generation", () => {
  it("always produces a well-formed item the class can use", () => {
    const rng = makeRng(11);
    const seen = { slots: new Set<string>(), rarities: new Set<string>() };
    for (let i = 0; i < 600; i++) {
      const classId = ["qa_paladin", "devops_mage", "refactor_rogue"][i % 3];
      const level = 1 + (i % 9);
      const item = rollItem(rng, classId, (i % 5) / 4, level);
      seen.slots.add(item.slot);
      seen.rarities.add(item.rarity);
      expect(item.kind).toBe(kindOfSlot(item.slot));
      expect(item.name.trim()).toBe(item.name);
      expect(item.icon).toMatch(/^[a-z-]+$/);
      expect(item.levelReq).toBeGreaterThanOrEqual(1);
      expect(item.levelReq).toBeLessThanOrEqual(level);
      if (item.kind === "weapon") expect(WEAPONS[item.ref].classId).toBe(classId);
      if (item.kind === "trinket") expect(item.power).toBe(0);
      if (item.kind === "armor") expect(item.power).toBeGreaterThanOrEqual(2);
      expect(equipProblem(item, classId, level)).toBeNull();
    }
    expect([...seen.slots].sort()).toEqual([...SLOTS].sort());
    expect([...seen.rarities].sort()).toEqual([...RARITIES].sort());
  });

  it("makes rarer items carry more and cost more", () => {
    const at = (rarity: ItemDef["rarity"]) => {
      const rng = makeRng(5);
      for (let i = 0; i < 4000; i++) {
        const item = rollItem(rng, "qa_paladin", 0.5, 5, "body");
        if (item.rarity === rarity) return item;
      }
      throw new Error(`no ${rarity} rolled`);
    };
    const common = at("common");
    const epic = at("epic");
    expect(epic.power).toBeGreaterThan(common.power);
    expect(itemPrice(epic)).toBeGreaterThan(itemPrice(common));
    expect(sellPrice(epic)).toBeLessThan(itemPrice(epic));
    expect(sellPrice(common)).toBeGreaterThan(0);
  });

  it("refuses gear that is too high level or for another class", () => {
    const staff = weaponItem("staff", "rare", 6);
    expect(equipProblem(staff, "devops_mage", 6)).toBeNull();
    expect(equipProblem(staff, "devops_mage", 2)).toMatch(/level 5/);
    expect(equipProblem(staff, "qa_paladin", 9)).toMatch(/Stormcall Mage/);
  });
});

describe("shop stock", () => {
  it("is the same for a seed and stocks one item per slot", () => {
    const a = shopStock("player-1|100", "refactor_rogue", 3);
    expect(shopStock("player-1|100", "refactor_rogue", 3)).toEqual(a);
    expect(shopStock("player-1|101", "refactor_rogue", 3)).not.toEqual(a);
    expect(a.map((e) => e.item.slot)).toEqual([...SLOTS]);
    expect(a.every((e) => e.price === itemPrice(e.item) && e.price > 0)).toBe(true);
    expect(WEAPONS[a[0].item.ref].classId).toBe("refactor_rogue");
  });
});

describe("what gear does", () => {
  const item = (over: Partial<ItemDef>): ItemDef => ({ kind: "armor", ref: "x", name: "x", rarity: "common", slot: "body", power: 0, statBonus: {}, levelReq: 1, icon: "chest-armor", ...over });

  it("adds up a loadout", () => {
    const loadout = loadoutOf([
      weaponItem("mace", "epic", 4, { str: 1 }),
      item({ slot: "body", power: 5, statBonus: { vit: 2 } }),
      item({ slot: "helmet", power: 3, statBonus: { vit: 1, str: 1 } }),
      item({ kind: "trinket", slot: "ring", statBonus: { dex: 2 } }),
    ]);
    expect(loadout).toEqual({ weapon: "mace", weaponPower: 4, armor: 8, bonus: { str: 2, vit: 3, dex: 2 } });
    expect(loadoutOf([]).weapon).toBeNull();
  });

  it("blunts hits by armor, but never by more than half and never to zero", () => {
    expect(afterArmor(8, 0)).toBe(8);
    expect(afterArmor(8, 6)).toBe(6);
    expect(afterArmor(8, 30)).toBe(4);
    expect(afterArmor(1, 30)).toBe(1);
    expect(afterArmor(0, 30)).toBe(0);
  });

  it("changes a real fight: weapon power adds damage and armor reduces it", () => {
    const hero = (over: Partial<Combatant>): Combatant => ({
      id: "h", side: "hero", name: "h", kind: "qa_paladin", level: 1, hp: 60, maxHp: 60,
      pct: { str: 100, vit: 100, agi: 100, dex: 100, int_stat: 100 }, power: 0, armor: 0, speed: 0,
      focus: 0, potions: 0, abilities: ["smite"], effects: [], down: false, ...over,
    });
    const run = (over: Partial<Combatant>) => {
      // Same seed both times, so enemy rolls are identical and only the gear differs.
      const start = createBattle({ heroes: [hero(over)], enemyKinds: ["bandit"], avgLevel: 1, poiId: null }, makeRng(4));
      const taken = start.events.filter((e) => e.t === "hit").reduce((a, e) => a + (e.t === "hit" ? e.amount : 0), 0);
      const hit = stepBattle(start.state, "h", { type: "ability", ability: "smite", target: "e0" }, makeRng(4));
      if (!hit.ok) throw new Error(hit.error);
      const dealt = hit.events.find((e) => e.t === "hit" && e.actor === "h");
      return { taken, dealt: dealt && dealt.t === "hit" ? dealt.amount : 0 };
    };
    const bare = run({});
    const geared = run({ power: 3, armor: 9 });
    expect(bare.taken).toBeGreaterThan(0);
    expect(geared.taken).toBeLessThan(bare.taken);
    expect(geared.dealt).toBe(bare.dealt + 3);
  });
});
