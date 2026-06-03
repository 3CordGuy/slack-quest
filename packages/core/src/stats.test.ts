import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATS,
  STARTING_STATS,
  deriveAll,
  deriveArmorBonus,
  deriveAttackMod,
  deriveCritBonus,
  deriveDodgeChance,
  deriveInitiativeBonus,
  deriveMagicMod,
  deriveMaxHp,
  deriveStartingMana,
  derivedSkills,
  startingStatsForClass,
  statSnapshot,
  statsAtLevel,
  type Stats,
} from "./stats";

// Baseline mid-range stats (all 5s) for zero-bonus derivations.
const MID: Stats = { str: 5, int_stat: 5, vit: 5, agi: 5, dex: 5 };

describe("deriveAttackMod", () => {
  it("returns 0 at STR 5", () => expect(deriveAttackMod(MID)).toBe(0));
  it("returns 1 at STR 7", () => expect(deriveAttackMod({ ...MID, str: 7 })).toBe(1));
  it("returns 2 at STR 9", () => expect(deriveAttackMod({ ...MID, str: 9 })).toBe(2));
  it("returns negative at STR 3", () => expect(deriveAttackMod({ ...MID, str: 3 })).toBe(-1));
});

describe("deriveMagicMod", () => {
  it("returns 0 at INT 5", () => expect(deriveMagicMod(MID)).toBe(0));
  it("returns 2 at INT 9", () => expect(deriveMagicMod({ ...MID, int_stat: 9 })).toBe(2));
  it("returns 2 at INT 10", () => expect(deriveMagicMod({ ...MID, int_stat: 10 })).toBe(2));
  it("returns 3 at INT 11", () => expect(deriveMagicMod({ ...MID, int_stat: 11 })).toBe(3));
});

describe("deriveMaxHp", () => {
  // formula: 16 + 2*vit + 2*level
  it("level-1 baseline: 16 + 2*5 + 2*1 = 28", () => expect(deriveMaxHp(MID, 1)).toBe(28));
  it("scales with level: L5 = 16+10+10 = 36", () => expect(deriveMaxHp(MID, 5)).toBe(36));
  it("scales with VIT: vit 10 L1 = 16+20+2 = 38", () => expect(deriveMaxHp({ ...MID, vit: 10 }, 1)).toBe(38));
  it("QA Paladin L1: vit 9 → 16+18+2 = 36", () => {
    expect(deriveMaxHp({ ...MID, vit: 9 }, 1)).toBe(36);
  });
});

describe("deriveArmorBonus", () => {
  it("0 at VIT 5 (no bonus until above 5)", () => expect(deriveArmorBonus(MID)).toBe(0));
  it("0 at VIT 8 (floor((8-5)/4) = 0)", () => expect(deriveArmorBonus({ ...MID, vit: 8 })).toBe(0));
  it("1 at VIT 9 (floor(4/4))", () => expect(deriveArmorBonus({ ...MID, vit: 9 })).toBe(1));
  it("2 at VIT 13", () => expect(deriveArmorBonus({ ...MID, vit: 13 })).toBe(2));
  it("no negative at VIT < 5", () => expect(deriveArmorBonus({ ...MID, vit: 3 })).toBe(0));
});

describe("deriveDodgeChance", () => {
  it("0 at AGI 5", () => expect(deriveDodgeChance(MID)).toBe(0));
  it("0.01 at AGI 6", () => expect(deriveDodgeChance({ ...MID, agi: 6 })).toBe(0.01));
  it("0.05 at AGI 10", () => expect(deriveDodgeChance({ ...MID, agi: 10 })).toBe(0.05));
  it("caps at 0.15 regardless of AGI", () => {
    expect(deriveDodgeChance({ ...MID, agi: 30 })).toBe(0.15);
  });
  it("0 at AGI below 5 (no negative dodge)", () => {
    expect(deriveDodgeChance({ ...MID, agi: 3 })).toBe(0);
  });
});

describe("deriveCritBonus", () => {
  it("0 at DEX 5", () => expect(deriveCritBonus(MID)).toBe(0));
  it("0.03 at DEX 8 (Refactor Rogue start)", () => {
    expect(deriveCritBonus({ ...MID, dex: 8 })).toBe(0.03);
  });
  it("0.05 at DEX 10", () => expect(deriveCritBonus({ ...MID, dex: 10 })).toBe(0.05));
  it("caps at 0.10", () => expect(deriveCritBonus({ ...MID, dex: 20 })).toBe(0.10));
  it("0 below DEX 5", () => expect(deriveCritBonus({ ...MID, dex: 3 })).toBe(0));
});

describe("deriveInitiativeBonus", () => {
  it("0 at AGI 5", () => expect(deriveInitiativeBonus(MID)).toBe(0));
  it("1 at AGI 7", () => expect(deriveInitiativeBonus({ ...MID, agi: 7 })).toBe(1));
  it("negative at AGI 3", () => expect(deriveInitiativeBonus({ ...MID, agi: 3 })).toBe(-1));
});

describe("deriveStartingMana", () => {
  it("1 at INT 5 (1 + floor(5/4) = 2... wait: 1 + 1 = 2)", () => {
    expect(deriveStartingMana(MID)).toBe(2);
  });
  it("3 at INT 9 (1 + floor(9/4) = 1+2 = 3)", () => {
    expect(deriveStartingMana({ ...MID, int_stat: 9 })).toBe(3);
  });
  it("1 at INT 1 (1 + 0)", () => {
    expect(deriveStartingMana({ ...MID, int_stat: 1 })).toBe(1);
  });
});

describe("derivedSkills", () => {
  it("no skills at all-5 stats", () => expect(derivedSkills(MID)).toEqual([]));
  it("str skill at STR ≥ 8", () => expect(derivedSkills({ ...MID, str: 8 })).toContain("str"));
  it("dex skill at DEX ≥ 8", () => expect(derivedSkills({ ...MID, dex: 8 })).toContain("dex"));
  it("int skill at INT ≥ 8", () => expect(derivedSkills({ ...MID, int_stat: 8 })).toContain("int"));
  it("all three when stats are all ≥ 8", () => {
    const skills = derivedSkills({ str: 8, int_stat: 8, vit: 5, agi: 5, dex: 8 });
    expect(skills).toContain("str");
    expect(skills).toContain("dex");
    expect(skills).toContain("int");
  });
  it("no skills at STR 7 (boundary off by one)", () => {
    expect(derivedSkills({ ...MID, str: 7 })).not.toContain("str");
  });
});

describe("deriveAll", () => {
  it("returns an object with all eight derived fields", () => {
    const d = deriveAll(MID, 1);
    expect(d).toMatchObject({
      attack_mod: 0,
      magic_mod: 0,
      max_hp: 28, // 16 + 2*5 + 2*1
      armor_bonus: 0,
      dodge_chance: 0,
      crit_bonus: 0,
      initiative_bonus: 0,
      starting_mana: 2,
    });
  });
});

describe("statsAtLevel", () => {
  it("L1 = starting stats", () => {
    const s = statsAtLevel("QA Paladin", 1);
    expect(s).toEqual(STARTING_STATS["qa_paladin"]);
  });

  it("L2 adds one auto-alloc per stat in the class's array", () => {
    // qa_paladin auto-allocs STR+1, VIT+1 each level
    const l1 = statsAtLevel("QA Paladin", 1);
    const l2 = statsAtLevel("QA Paladin", 2);
    expect(l2.str).toBe(l1.str + 1);
    expect(l2.vit).toBe(l1.vit + 1);
    expect(l2.int_stat).toBe(l1.int_stat); // untouched
  });

  it("scales by (level - 1) levels", () => {
    const l1 = statsAtLevel("Refactor Rogue", 1);
    const l5 = statsAtLevel("Refactor Rogue", 5);
    // refactor_rogue auto-allocs dex+1, agi+1
    expect(l5.dex).toBe(l1.dex + 4);
    expect(l5.agi).toBe(l1.agi + 4);
    expect(l5.str).toBe(l1.str); // untouched
  });

  it("accepts class display names via alias resolution", () => {
    expect(() => statsAtLevel("DevOps Mage", 1)).not.toThrow();
  });

  it("falls back to DEFAULT_STATS for an unknown class", () => {
    const s = statsAtLevel("Unknown Class XYZ", 1);
    expect(s).toEqual(DEFAULT_STATS);
  });
});

describe("startingStatsForClass", () => {
  it("all class starting stat sums are 30", () => {
    const sum = (s: Stats) => s.str + s.int_stat + s.vit + s.agi + s.dex;
    for (const [, stats] of Object.entries(STARTING_STATS)) {
      expect(sum(stats)).toBe(30);
    }
  });
});

describe("statSnapshot", () => {
  it("uses provided stats + derives correctly", () => {
    const snap = statSnapshot({
      className: "QA Paladin",
      level: 1,
      stats: STARTING_STATS["qa_paladin"],
    });
    expect(snap.stats).toEqual(STARTING_STATS["qa_paladin"]);
    // QA Paladin: STR 9 → attack_mod = floor((9-5)/2) = 2
    expect(snap.derived.attack_mod).toBe(2);
    // VIT 9 → max_hp = 16 + 18 + 2 = 36
    expect(snap.derived.max_hp).toBe(36);
  });

  it("sums equip bonuses into base stats before derivation", () => {
    const base = statSnapshot({
      className: "DevOps Mage",
      level: 1,
      stats: STARTING_STATS["devops_mage"],
    });
    const withRing = statSnapshot({
      className: "DevOps Mage",
      level: 1,
      stats: STARTING_STATS["devops_mage"],
      equipBonuses: { int_stat: 2 },
    });
    // +2 INT should add 1 to magic_mod (floor((11-5)/2)=3 vs floor((9-5)/2)=2)
    expect(withRing.derived.magic_mod).toBe(base.derived.magic_mod + 1);
    expect(withRing.stats.int_stat).toBe(STARTING_STATS["devops_mage"].int_stat + 2);
  });

  it("falls back to statsAtLevel when stats not provided", () => {
    const snap = statSnapshot({ className: "QA Paladin", level: 1 });
    expect(snap.stats).toEqual(statsAtLevel("QA Paladin", 1));
  });

  it("defaults effects bag to zeros when no affixBonuses provided", () => {
    const snap = statSnapshot({ className: "QA Paladin", level: 1 });
    expect(snap.effects.crit_pct).toBe(0);
    expect(snap.effects.lifesteal).toBe(0);
    expect(snap.effects.resist_fire).toBe(0);
  });

  it("threads affix effects through to the snapshot", () => {
    const snap = statSnapshot({
      className: "QA Paladin",
      level: 1,
      affixBonuses: { crit_pct: 9, lifesteal: 3, resist_fire: 15 },
    });
    expect(snap.effects.crit_pct).toBe(9);
    expect(snap.effects.lifesteal).toBe(3);
    expect(snap.effects.resist_fire).toBe(15);
    expect(snap.effects.thorns).toBe(0); // unset keys stay zero
  });
});

describe("splitStatBonus", () => {
  it("partitions primary stats from affix-effect keys", async () => {
    const { splitStatBonus } = await import("./stats");
    const { primary, affixes } = splitStatBonus({
      str: 2,
      int_stat: 1,
      crit_pct: 9,
      resist_fire: 15,
      thorns: 2,
    });
    expect(primary).toEqual({ str: 2, int_stat: 1 });
    expect(affixes).toEqual({ crit_pct: 9, resist_fire: 15, thorns: 2 });
  });

  it("silently drops unknown keys (forward-compat with newer affixes)", async () => {
    const { splitStatBonus } = await import("./stats");
    const { primary, affixes } = splitStatBonus({ str: 1, future_affix_xyz: 99 });
    expect(primary).toEqual({ str: 1 });
    expect(affixes).toEqual({});
  });

  it("handles undefined input", async () => {
    const { splitStatBonus } = await import("./stats");
    const { primary, affixes } = splitStatBonus(undefined);
    expect(primary).toEqual({});
    expect(affixes).toEqual({});
  });
});

