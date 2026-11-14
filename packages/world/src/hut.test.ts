import { describe, expect, it } from "vitest";
import { FURNISHINGS, HUT_TIERS, PERK_CAPS, RESOURCE_KINDS, STARTER_BLUEPRINTS, STORY_FRAMES, TROPHY_FOR_FRAME, addResources, buyFurnitureProblem, canAfford, capPerks, craftProblem, hutPerks, nextHutTier, upgradeProblem, xpWithBonus, STALL_FURNITURE } from "./index";

describe("hut catalogue", () => {
  it("is internally consistent", () => {
    for (const def of Object.values(FURNISHINGS)) {
      expect(FURNISHINGS[def.id]).toBe(def);
      for (const kind of Object.keys(def.recipe ?? {})) expect(RESOURCE_KINDS).toContain(kind);
      // Anything locked behind a blueprint must be craftable once it is known.
      if (def.needsBlueprint) expect(def.recipe).toBeDefined();
      // A trophy is earned, never bought or built.
      if (def.kind === "trophy") expect(def.price ?? def.recipe).toBeUndefined();
    }
    expect(STARTER_BLUEPRINTS).toEqual(expect.arrayContaining(["table", "chair", "rug"]));
    expect(STARTER_BLUEPRINTS).not.toContain("bed");
  });

  it("has a trophy for every story shape", () => {
    for (const frame of STORY_FRAMES) expect(FURNISHINGS[TROPHY_FOR_FRAME[frame.id]]?.kind).toBe("trophy");
  });

  it("makes each hut tier bigger and dearer than the last", () => {
    expect(HUT_TIERS[0].gold).toBe(0);
    for (let i = 1; i < HUT_TIERS.length; i++) {
      expect(HUT_TIERS[i].tier).toBe(i + 1);
      expect(HUT_TIERS[i].cols * HUT_TIERS[i].rows).toBeGreaterThan(HUT_TIERS[i - 1].cols * HUT_TIERS[i - 1].rows);
      expect(HUT_TIERS[i].gold).toBeGreaterThan(HUT_TIERS[i - 1].gold);
    }
  });
});

describe("hut perks", () => {
  const placed = (defId: string) => ({ defId, q: 0 });
  const stored = (defId: string) => ({ defId, q: null });

  it("counts only what is placed", () => {
    expect(hutPerks([stored("bed"), stored("chest")])).toEqual({ focus: 0, potions: 0, maxHp: 0, xpPct: 0 });
    expect(hutPerks([placed("bed"), stored("chest"), placed("hearth")])).toEqual({ focus: 1, potions: 0, maxHp: 4, xpPct: 0 });
  });

  it("never exceeds the caps, however much is placed", () => {
    const everything = [...Array(4).fill(placed("bed")), ...Array(4).fill(placed("chest")), ...Array(3).fill(placed("hearth")), ...Array(5).fill(placed("bookshelf")), ...Array(9).fill(placed("trophy_pelt"))];
    expect(hutPerks(everything)).toEqual(PERK_CAPS);
  });

  it("ignores furnishings it does not know", () => {
    expect(hutPerks([placed("no_such_thing"), placed("table")])).toEqual({ focus: 0, potions: 0, maxHp: 0, xpPct: 0 });
  });
});

describe("resources", () => {
  it("adds, drops empties, and checks affordability", () => {
    const have = addResources({ wood: 3 }, { wood: 2, iron: 1 });
    expect(have).toEqual({ wood: 5, iron: 1 });
    expect(addResources(have, { iron: -1 })).toEqual({ wood: 5 });
    expect(canAfford({ wood: 5 }, { wood: 5 })).toBe(true);
    expect(canAfford({ wood: 5 }, { wood: 5, stone: 1 })).toBe(false);
    expect(canAfford({}, {})).toBe(true);
  });
});

describe("perk caps", () => {
  it("holds any perk to the caps and to whole, non-negative numbers", () => {
    expect(capPerks(undefined)).toEqual({ focus: 0, potions: 0, maxHp: 0, xpPct: 0 });
    expect(capPerks({ focus: 9, potions: 9, maxHp: 99, xpPct: 99 })).toEqual(PERK_CAPS);
    expect(capPerks({ focus: -3, maxHp: 2.9, xpPct: Number.NaN })).toEqual({ focus: 0, potions: 0, maxHp: 2, xpPct: 0 });
  });

  it("adds the XP bonus as a rounded percentage, never above the cap", () => {
    expect(xpWithBonus(100, 0)).toBe(100);
    expect(xpWithBonus(100, 2)).toBe(102);
    expect(xpWithBonus(100, 50)).toBe(100 + PERK_CAPS.xpPct);
    expect(xpWithBonus(10, 5)).toBe(11);
    expect(xpWithBonus(10, 2)).toBe(10);
    expect(xpWithBonus(0, 5)).toBe(0);
  });
});

describe("crafting", () => {
  it("lets anyone craft a starter recipe they hold the materials for", () => {
    expect(craftProblem("table", STARTER_BLUEPRINTS, { wood: 6 })).toBeNull();
    expect(craftProblem("table", [], { wood: 99 })).toBeNull();
  });

  it("names what is missing", () => {
    expect(craftProblem("table", STARTER_BLUEPRINTS, { wood: 5 })).toBe("You need 1 more wood.");
    expect(craftProblem("lantern", STARTER_BLUEPRINTS, { wood: 1 })).toBe("You need 3 more copper.");
    expect(craftProblem("bed", ["bed"], {})).toBe("You need 8 more wood, 4 more fur.");
  });

  it("needs the blueprint for the pieces that have one", () => {
    const plenty = { wood: 99, fur: 99, iron: 99, stone: 99, bone: 99, copper: 99, herbs: 99, mushrooms: 99 };
    expect(craftProblem("bed", STARTER_BLUEPRINTS, plenty)).toMatch(/blueprint/);
    expect(craftProblem("bed", [...STARTER_BLUEPRINTS, "bed"], plenty)).toBeNull();
    for (const def of Object.values(FURNISHINGS)) {
      if (def.recipe) expect(craftProblem(def.id, [def.id], plenty)).toBeNull();
    }
  });

  it("refuses trophies and things that do not exist", () => {
    expect(craftProblem("trophy_pelt", ["trophy_pelt"], { fur: 99 })).toBe("That cannot be crafted.");
    expect(craftProblem("throne", ["throne"], {})).toBe("There is no such furnishing.");
    expect(craftProblem("toString", [], {})).toBe("There is no such furnishing.");
  });
});

describe("furniture at the stall", () => {
  it("sells only what the catalogue prices, at the catalogue's price", () => {
    expect(STALL_FURNITURE.map((f) => f.id)).toEqual(expect.arrayContaining(["table", "chair", "rug", "lantern", "banner"]));
    for (const def of STALL_FURNITURE) {
      expect(buyFurnitureProblem(def.id, def.price!)).toBeNull();
      expect(buyFurnitureProblem(def.id, def.price! - 1)).toBe("Not enough gold.");
    }
    expect(buyFurnitureProblem("bed", 9999)).toBe("The stall does not sell that.");
    expect(buyFurnitureProblem("trophy_core", 9999)).toBe("The stall does not sell that.");
    expect(buyFurnitureProblem("nothing", 9999)).toBe("The stall does not sell that.");
  });
});

describe("selling furniture back to the stall", () => {
  const stored = (defId: string) => ({ defId, q: null, inId: null, fish: null });

  it("pays half the stall price, rounded down, for what the stall sells", async () => {
    const { furnitureSellPrice } = await import("./index");
    expect(furnitureSellPrice("table")).toBe(15);
    expect(furnitureSellPrice("chair")).toBe(7);
    expect(furnitureSellPrice("mug")).toBe(2);
    for (const def of STALL_FURNITURE) expect(furnitureSellPrice(def.id)).toBe(Math.floor(def.price! / 2));
    expect(furnitureSellPrice("bed")).toBeNull();
    expect(furnitureSellPrice("storage_chest")).toBeNull();
    expect(furnitureSellPrice("toString")).toBeNull();
  });

  it("buys only stored, empty pieces it prices", async () => {
    const { sellFurnitureProblem } = await import("./index");
    expect(sellFurnitureProblem(stored("table"))).toBeNull();
    expect(sellFurnitureProblem(undefined)).toBe("You do not own that.");
    expect(sellFurnitureProblem(stored("bed"))).toBe("The stall does not buy that.");
    expect(sellFurnitureProblem(stored("storage_chest"))).toBe("The stall does not buy that.");
    expect(sellFurnitureProblem(stored("trophy_core"))).toBe("The stall does not buy that.");
    expect(sellFurnitureProblem({ ...stored("table"), q: 1 })).toBe("Put it back in storage first.");
    expect(sellFurnitureProblem({ ...stored("mug"), inId: 7 })).toBe("Take it out of the container first.");
    expect(sellFurnitureProblem({ ...stored("mounted_fish"), fish: { id: "f", species: "cod", grams: 1, mm: 1 } })).toBe("Take the fish down first.");
    expect(sellFurnitureProblem(stored("crate"), 2)).toBe("Empty it first.");
    expect(sellFurnitureProblem(stored("crate"), 0)).toBeNull();
  });
});

describe("making a hut bigger", () => {
  it("costs the next tier's gold and materials", () => {
    const cottage = HUT_TIERS[1];
    expect(nextHutTier(1)).toBe(cottage);
    expect(upgradeProblem(1, cottage.gold, cottage.resources)).toBeNull();
    expect(upgradeProblem(1, cottage.gold - 1, cottage.resources)).toBe("You need 1 more gold.");
    expect(upgradeProblem(1, cottage.gold, { wood: 20, stone: 4 })).toBe("You need 6 more stone.");
    expect(upgradeProblem(1, 0, {})).toBe("You need 150 more gold, 20 more wood, 10 more stone.");
    // The Cottage's price does not buy a Lodge.
    expect(upgradeProblem(2, cottage.gold, cottage.resources)).toMatch(/^You need /);
    expect(upgradeProblem(2, HUT_TIERS[2].gold, HUT_TIERS[2].resources)).toBeNull();
  });

  it("stops at the top tier", () => {
    const top = HUT_TIERS[HUT_TIERS.length - 1].tier;
    expect(nextHutTier(top)).toBeNull();
    expect(upgradeProblem(top, 99999, { wood: 999, stone: 999, iron: 999 })).toBe("Your hut is as big as huts get.");
  });
});

describe("the resource bin on a new plot", () => {
  it("takes what is held, never more than the shack still needs", async () => {
    const { SHACK_COST, binDeposit, binFill, binFull, binNeeds } = await import("./index");
    expect(binFull({})).toBe(false);
    expect(binFill({})).toBe(0);
    expect(binNeeds({})).toEqual(SHACK_COST);
    // Only the kinds the shack needs go in, and only up to what it needs.
    const first = binDeposit({}, { wood: 4, stone: 50, fur: 9 });
    expect(first).toEqual({ wood: 4, stone: SHACK_COST.stone });
    expect(binFull(first)).toBe(false);
    expect(binFill(first)).toBeGreaterThan(0);
    expect(binFill(first)).toBeLessThan(1);
    // Nothing held, nothing in.
    expect(binDeposit(first, {})).toEqual({});
    const rest = binDeposit(first, { wood: 99 });
    expect(rest).toEqual({ wood: SHACK_COST.wood! - 4 });
    const full = addResources({ ...first }, rest);
    expect(binFull(full)).toBe(true);
    expect(binFill(full)).toBe(1);
    expect(binDeposit(full, { wood: 5, stone: 5 })).toEqual({});
    // Odd amounts from a request are cleaned before they count.
    expect(binDeposit({}, { wood: -3, stone: 2.7 })).toEqual({ stone: 2 });
  });
});

describe("selling foraged goods to the stall", () => {
  it("buys herbs, mushrooms and gems only, whole amounts the seller holds", async () => {
    const { STALL_BUYS, STALL_GEM_PRICE, sellMaterialProblem } = await import("./index");
    expect(Object.keys(STALL_BUYS).sort()).toEqual(["gem", "herbs", "mushrooms"]);
    expect(STALL_BUYS.gem).toBe(STALL_GEM_PRICE);
    const have = { herbs: 4, mushrooms: 1, wood: 9, gem: 2, iron: 3 };
    expect(sellMaterialProblem("gem", 2, have)).toBeNull();
    expect(sellMaterialProblem("iron", 1, have)).toMatch(/does not buy/);
    expect(sellMaterialProblem("herbs", 4, have)).toBeNull();
    expect(sellMaterialProblem("mushrooms", 1, have)).toBeNull();
    expect(sellMaterialProblem("herbs", 5, have)).toMatch(/only have 4/);
    expect(sellMaterialProblem("wood", 1, have)).toMatch(/does not buy/);
    expect(sellMaterialProblem("gold", 1, have)).toMatch(/does not buy/);
    for (const bad of [0, -1, 1.5, "2", null]) expect(sellMaterialProblem("herbs", bad, have)).toMatch(/at least one/);
  });
});
