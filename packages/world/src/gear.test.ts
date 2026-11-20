import { describe, expect, it } from "vitest";
import { GARB_HAT, LANTERN_HELM_ICON, parseGarbIcon, starterGarb, wearsLanternHelm } from "./gear";
import { gearSheet } from "./hero";
import {
  ABILITIES,
  RARITIES,
  SLOTS,
  WEAPONS,
  abilitiesFor,
  equipProblem,
  itemPrice,
  kindOfSlot,
  loadoutOf,
  makeRng,
  rollItem,
  sellPrice,
  shopStock,
  weaponItem,
  type ItemDef,
} from "./index";

const item = (over: Partial<ItemDef>): ItemDef => ({ kind: "armor", ref: "x", name: "x", rarity: "common", slot: "body", power: 0, statBonus: {}, levelReq: 1, icon: "chest-armor", ...over });

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
      if (item.kind === "weapon") expect([classId, undefined]).toContain(WEAPONS[item.ref].classId);
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
});

describe("gearSheet", () => {
  /** A paladin's real gear: a greatsword, a breastplate, a cap and a ring. */
  const WORN: ItemDef[] = [
    item({ kind: "weapon", ref: "greatsword", name: "Breakwater Greatsword", slot: "main_hand", power: 3, statBonus: { str: 2 }, icon: "greatsword" }),
    item({ kind: "armor", ref: "plate", name: "Breastplate", slot: "body", power: 6, statBonus: { vit: 2 }, icon: "plate" }),
    item({ kind: "armor", ref: "cap", name: "Cap", slot: "helmet", power: 2, icon: "cap" }),
    item({ kind: "trinket", ref: "band", name: "Band", slot: "ring", statBonus: { agi: 1, vit: 1 }, icon: "band" }),
  ];

  it("sums what is worn", () => {
    const sheet = gearSheet("qa_paladin", WORN);
    expect(sheet.weapon).toBe("greatsword");
    expect(sheet.weaponPower).toBe(3);
    expect(sheet.armor).toBe(8);
    expect(sheet.bonus).toEqual({ str: 2, vit: 3, agi: 1 });
    expect(sheet.outfit?.main_hand?.ref).toBe("greatsword");
  });

  it("counts hidden gear but does not draw it", () => {
    const sheet = gearSheet("qa_paladin", WORN.map((i) => (i.slot === "helmet" ? { ...i, hidden: true } : i)));
    expect(sheet.armor).toBe(8);
    expect(sheet.bonus).toEqual({ str: 2, vit: 3, agi: 1 });
    expect(sheet.outfit?.helmet).toBeUndefined();
    expect(sheet.outfit?.body?.ref).toBe("plate");
  });

  it("always draws what is held in the hands, even if marked hidden", () => {
    const sheet = gearSheet("qa_paladin", WORN.map((i) => (i.slot === "main_hand" ? { ...i, hidden: true } : i)));
    expect(sheet.outfit?.main_hand?.ref).toBe("greatsword");
  });

  it("is unarmed with nothing in hand, and can only punch", () => {
    const sheet = gearSheet("devops_mage", []);
    expect(sheet.weapon).toBe("");
    expect(sheet.weaponPower).toBe(0);
    expect(abilitiesFor(sheet.weapon)).toEqual(["punch"]);
    expect(abilitiesFor("staff")).toContain("shock");
    expect(ABILITIES.punch.target).toBe("enemy");
    // No weapon gives a punch: it is what is left when the weapon is put down.
    for (const w of Object.values(WEAPONS)) expect(w.abilities).not.toContain("punch");
  });
});

describe("the Lighthouse Paladin's Lantern Helm", () => {
  const hat = (classId: string) => starterGarb(classId).find((i) => i.ref === GARB_HAT)!;

  it("is the Paladin's starter hat; every other class starts in its own hat, pictured in its look", () => {
    expect(hat("qa_paladin")).toMatchObject({ name: "Lantern Helm", icon: LANTERN_HELM_ICON, slot: "helmet" });
    expect(hat("refactor_rogue")).toMatchObject({ name: "Smuggler Rogue Hat", icon: "garb-hat:refactor_rogue" });
  });

  it("names each piece of a class's starting clothes for the class, and gives it the class's own picture", () => {
    const sage = starterGarb("staff_sage");
    expect(sage.map((i) => i.icon)).toEqual(["garb-hat:staff_sage", "garb-tunic:staff_sage", "garb-trousers:staff_sage", "garb-shoes:staff_sage"]);
    expect(sage.map((i) => parseGarbIcon(i.icon))).toEqual(["hat", "tunic", "trousers", "shoes"].map((piece) => ({ piece, classId: "staff_sage" })));
    expect(parseGarbIcon("knit-cap")).toBeNull();
    // With no class, the plain pictures.
    expect(starterGarb("nobody").map((i) => i.icon)).toEqual(["knit-cap", "naval-tunic", "armored-pants", "deck-boots"]);
  });

  it("is worn by whoever has it on; any starter hat on a Paladin is one; and a Paladin with no look chosen is drawn in it bare-headed", () => {
    const on = (icon: string, ref = GARB_HAT) => ({ helmet: { icon, ref, rarity: "common" as const } });
    expect(wearsLanternHelm("qa_paladin", on(LANTERN_HELM_ICON))).toBe(true);
    expect(wearsLanternHelm("refactor_rogue", on(LANTERN_HELM_ICON))).toBe(true);
    // Another class's starter hat, or an old one of their own saved before it was the helm, is the Paladin's own hat on them.
    expect(wearsLanternHelm("qa_paladin", on("knit-cap"))).toBe(true);
    expect(wearsLanternHelm("refactor_rogue", on("knit-cap"))).toBe(false);
    // Armor on the head is not.
    expect(wearsLanternHelm("qa_paladin", on("heavy-helm", "hardhat"))).toBe(false);
    expect(wearsLanternHelm("qa_paladin", undefined)).toBe(true);
    expect(wearsLanternHelm("qa_paladin", { appearance: {} as never })).toBe(false);
    expect(wearsLanternHelm("refactor_rogue", undefined)).toBe(false);
  });

  it("still lights the way worn hidden, though it is not drawn", () => {
    const hat = { ...starterGarb("qa_paladin").find((i) => i.ref === GARB_HAT)!, hidden: true };
    const sheet = gearSheet("qa_paladin", [hat]);
    expect(sheet.outfit?.helmet).toBeUndefined();
    expect(sheet.lantern).toBe(true);
    expect(gearSheet("qa_paladin", []).lantern).toBeUndefined();
    expect(gearSheet("refactor_rogue", [{ ...starterGarb("refactor_rogue").find((i) => i.ref === GARB_HAT)!, hidden: true }]).lantern).toBeUndefined();
  });
});
