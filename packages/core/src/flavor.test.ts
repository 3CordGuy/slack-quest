import { describe, expect, it } from "vitest";
import {
  CLASSES,
  MAGIC_PRICE,
  MAX_MANA_CAP,
  RARITY_BADGE,
  SHOP_PRICE,
  classByName,
  dropChance,
  generateScar,
  priceFor,
  rollDice,
  rollItem,
  sellPriceFor,
  xpForLevel,
} from "./flavor";
import { activeAbilities } from "./abilities";

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
  it("type is one of weapon | armor | consumable | magic | revive | tool | scroll", () => {
    for (let i = 0; i < 200; i++) {
      const r = rollItem(2);
      expect(["weapon", "armor", "consumable", "magic", "revive", "tool", "scroll"]).toContain(r.type);
    }
  });

  it("tool/scroll rolls have a catalog_name and known emoji", () => {
    let sawCatalog = false;
    for (let i = 0; i < 500; i++) {
      const r = rollItem(2);
      if (r.type === "tool" || r.type === "scroll") {
        sawCatalog = true;
        expect(r.catalog_name).toBeDefined();
        expect([
          "Caffeine Bomb",
          "Hotfix Grenade",
          "Rebase Scroll",
          "Production Outage",
          "Espresso Shot",
          "Poison Vial",
          "Venom Vial",
          "Regen Draft",
          "Battle Elixir",
        ]).toContain(r.catalog_name);
        // Power is computed from tier — 0 for utility effects (Rebase Scroll, Battle Elixir).
        const zeroPower = r.catalog_name === "Rebase Scroll" || r.catalog_name === "Battle Elixir";
        if (r.type === "tool" && !zeroPower) expect(r.power).toBeGreaterThan(0);
      }
    }
    // ~8% combined drop weight × 500 rolls = expect at least one. Flaky-tolerant.
    expect(sawCatalog).toBe(true);
  });

  it("magic items have power between 1 and 3 (rarity-flat tiers)", () => {
    for (let i = 0; i < 200; i++) {
      const r = rollItem(2);
      if (r.type === "magic") {
        expect(r.power).toBeGreaterThanOrEqual(1);
        expect(r.power).toBeLessThanOrEqual(3);
      }
    }
  });

  it("rarity is one of common | uncommon | rare", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollItem(2);
      expect(["common", "uncommon", "rare"]).toContain(r.rarity);
    }
  });

  it("power is always positive (or zero for utility effects)", () => {
    for (let i = 0; i < 100; i++) {
      const r = rollItem(2);
      // Utility items with no numeric payload: Rebase Scroll clears cooldowns/mana;
      // Battle Elixir grants the Empowered status — neither uses power as a number.
      // Stat-bonus-only armor slots (boots, ring, amulet) likewise have power=0.
      if (
        (r.type === "scroll" && r.catalog_name === "Rebase Scroll") ||
        (r.type === "tool" && r.catalog_name === "Battle Elixir") ||
        (r.type === "armor" && ["boots", "ring", "amulet"].includes(r.slot ?? ""))
      ) {
        expect(r.power).toBe(0);
        continue;
      }
      expect(r.power).toBeGreaterThan(0);
    }
  });

  it("higher tiers produce more rare drops than tier 1", () => {
    // Statistical sanity — not deterministic, but with 1000 rolls the difference is huge.
    const lowTier = Array.from({ length: 1000 }, () => rollItem(1)).filter((r) => r.rarity === "rare").length;
    const highTier = Array.from({ length: 1000 }, () => rollItem(5)).filter((r) => r.rarity === "rare").length;
    expect(highTier).toBeGreaterThan(lowTier);
  });

  it("rare consumable power exceeds any weapon/armor power", () => {
    // Weapons/armor cap at +7 (rare); rare consumables go up to 35. Magic + revive
    // use power for different mechanics (max_mana / HP%) so they're excluded.
    let maxWeaponArmor = 0;
    let minRareConsumable = Infinity;
    for (let i = 0; i < 400; i++) {
      const r = rollItem(2);
      if (r.type === "weapon" || r.type === "armor") {
        maxWeaponArmor = Math.max(maxWeaponArmor, r.power);
      }
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
  it("sell price is less than buy price for every rarity (consumable + gear)", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      for (const type of ["weapon", "armor", "consumable"] as const) {
        expect(sellPriceFor(type, rarity)).toBeLessThan(priceFor(type, rarity));
      }
    }
  });

  it("magic items use the elevated MAGIC_PRICE table", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(priceFor("magic", rarity)).toBe(MAGIC_PRICE[rarity]);
      expect(priceFor("weapon", rarity)).toBe(SHOP_PRICE[rarity]);
    }
  });

  it("magic items always cost more than gear/consumables of the same rarity", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(priceFor("magic", rarity)).toBeGreaterThan(priceFor("consumable", rarity));
    }
  });

  it("rarer items cost more to buy", () => {
    expect(SHOP_PRICE.uncommon).toBeGreaterThan(SHOP_PRICE.common);
    expect(SHOP_PRICE.rare).toBeGreaterThan(SHOP_PRICE.uncommon);
    expect(MAGIC_PRICE.uncommon).toBeGreaterThan(MAGIC_PRICE.common);
    expect(MAGIC_PRICE.rare).toBeGreaterThan(MAGIC_PRICE.uncommon);
  });

  it("sell yields ~30% of shop price", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(sellPriceFor("weapon", rarity)).toBe(Math.floor(SHOP_PRICE[rarity] * 0.3));
      expect(sellPriceFor("magic", rarity)).toBe(Math.floor(MAGIC_PRICE[rarity] * 0.3));
    }
  });
});

describe("class abilities", () => {
  it("every class has at least one active ability", () => {
    for (const cls of CLASSES) {
      expect(activeAbilities(cls.abilities).length).toBeGreaterThan(0);
    }
  });

  it("classByName resolves active abilities for known classes", () => {
    expect(activeAbilities(classByName("DevOps Mage").abilities).map((a) => a.id)).toContain("fireball");
    expect(activeAbilities(classByName("QA Paladin").abilities).map((a) => a.id)).toContain("smite");
  });

  it("classByName returns empty abilities for unknown class", () => {
    expect(classByName("Made-Up Class").abilities).toHaveLength(0);
  });
});

describe("MAX_MANA_CAP", () => {
  it("is a sensible positive cap", () => {
    expect(MAX_MANA_CAP).toBeGreaterThan(1);
    expect(MAX_MANA_CAP).toBeLessThanOrEqual(10);
  });
});

describe("classByName", () => {
  it("returns the matching class for a real name", () => {
    expect(classByName("DevOps Mage").id).toBe("devops_mage");
  });

  it("falls back to a default for an unknown name", () => {
    const fallback = classByName("Made-Up Class");
    expect(fallback.id).toBe("unknown");
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
