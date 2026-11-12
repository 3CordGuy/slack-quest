import { describe, expect, it } from "vitest";
import { FURNISHINGS, HUT_TIERS, PERK_CAPS, RESOURCE_KINDS, STARTER_BLUEPRINTS, STORY_FRAMES, TROPHY_FOR_FRAME, addResources, canAfford, hutPerks } from "./index";

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
