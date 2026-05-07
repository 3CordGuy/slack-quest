import { describe, expect, it } from "vitest";
import {
  CLASSES,
  RARITY_BADGE,
  SHOP_PRICE,
  classByName,
  dropChance,
  generateScar,
  rollDice,
  rollItem,
  sellPrice,
  xpForLevel,
} from "./flavor";

describe("rollDice", () => {
  it("single die rolls within [1, sides]", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollDice(6);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
  });

  it("multiple dice scale within [count, sides * count]", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollDice(4, 3);
      expect(r).toBeGreaterThanOrEqual(3);
      expect(r).toBeLessThanOrEqual(12);
    }
  });
});

describe("xpForLevel", () => {
  it("level 1 requires 0 XP", () => {
    expect(xpForLevel(1)).toBe(0);
  });

  it("is monotonically increasing", () => {
    let prev = -1;
    for (let level = 1; level <= 10; level++) {
      const xp = xpForLevel(level);
      expect(xp).toBeGreaterThanOrEqual(prev);
      prev = xp;
    }
  });

  it("level 5 requires meaningfully more XP than level 2", () => {
    expect(xpForLevel(5)).toBeGreaterThan(xpForLevel(2) * 4);
  });
});

describe("dropChance", () => {
  it("base rate at tier 1 is 0.35", () => {
    expect(dropChance(1)).toBeCloseTo(0.35, 5);
  });

  it("scales by 0.05 per tier", () => {
    expect(dropChance(2) - dropChance(1)).toBeCloseTo(0.05, 5);
    expect(dropChance(5) - dropChance(4)).toBeCloseTo(0.05, 5);
  });

  it("caps at 0.7", () => {
    expect(dropChance(20)).toBe(0.7);
  });
});

describe("rollItem", () => {
  it("type is one of weapon | armor | consumable", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollItem(2);
      expect(["weapon", "armor", "consumable"]).toContain(r.type);
    }
  });

  it("rarity is one of common | uncommon | rare", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollItem(2);
      expect(["common", "uncommon", "rare"]).toContain(r.rarity);
    }
  });

  it("power is always positive", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollItem(2);
      expect(r.power).toBeGreaterThan(0);
    }
  });

  it("higher tiers produce more rare drops than tier 1", () => {
    // Statistical sanity — not deterministic, but with 1000 rolls the difference is huge.
    const lowTier = Array.from({ length: 1000 }, () => rollItem(1)).filter((r) => r.rarity === "rare").length;
    const highTier = Array.from({ length: 1000 }, () => rollItem(5)).filter((r) => r.rarity === "rare").length;
    expect(highTier).toBeGreaterThan(lowTier);
  });

  it("consumable power exceeds weapon/armor power for the same rarity", () => {
    // Weapons/armor cap at +7 (rare); rare consumables go up to 35.
    let maxWeaponArmor = 0;
    let minRareConsumable = Infinity;
    for (let i = 0; i < 200; i++) {
      const r = rollItem(2);
      if (r.type !== "consumable") maxWeaponArmor = Math.max(maxWeaponArmor, r.power);
      if (r.type === "consumable" && r.rarity === "rare") {
        minRareConsumable = Math.min(minRareConsumable, r.power);
      }
    }
    if (minRareConsumable !== Infinity) {
      expect(minRareConsumable).toBeGreaterThan(maxWeaponArmor);
    }
  });
});

describe("shop pricing", () => {
  it("sell price is less than buy price for every rarity", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(sellPrice(rarity)).toBeLessThan(SHOP_PRICE[rarity]);
    }
  });

  it("rarer items cost more to buy", () => {
    expect(SHOP_PRICE.uncommon).toBeGreaterThan(SHOP_PRICE.common);
    expect(SHOP_PRICE.rare).toBeGreaterThan(SHOP_PRICE.uncommon);
  });

  it("sell yields ~30% of shop price", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(sellPrice(rarity)).toBe(Math.floor(SHOP_PRICE[rarity] * 0.3));
    }
  });
});

describe("classByName", () => {
  it("returns the matching class for a real name", () => {
    expect(classByName("DevOps Mage").id).toBe("devops_mage");
  });

  it("falls back to a balanced default for an unknown name", () => {
    const fallback = classByName("Made-Up Class");
    expect(fallback.attack_mod).toBe(1);
    expect(fallback.magic_mod).toBe(1);
  });

  it("every defined class has a non-empty blurb", () => {
    for (const cls of CLASSES) {
      expect(cls.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe("generateScar", () => {
  it("substitutes the monster name into the template", () => {
    const scar = generateScar("the Untested Branch");
    expect(scar).toContain("the Untested Branch");
  });
});

describe("RARITY_BADGE", () => {
  it("has a badge for every rarity", () => {
    expect(RARITY_BADGE.common).toBeTruthy();
    expect(RARITY_BADGE.uncommon).toBeTruthy();
    expect(RARITY_BADGE.rare).toBeTruthy();
  });
});
