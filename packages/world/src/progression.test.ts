import { describe, expect, it } from "vitest";
import { DEFAULT_STATS, STARTING_STATS } from "@gantt-quest/core";
import { applyXp, barPixels, healthBand, makeRng, rollStartingStats, xpProgress, xpToNext } from "./index";

describe("progression", () => {
  it("rolls starting stats around the class baseline", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 50; i++) {
      const s = rollStartingStats(rng, "qa_paladin");
      expect(s.str).toBeGreaterThanOrEqual(8);
      expect(s.str).toBeLessThanOrEqual(11);
    }
  });

  it("levels up with class auto-allocation and a free point", () => {
    const p = { classId: "qa_paladin", level: 1, xp: 0, stats: { ...STARTING_STATS.qa_paladin }, unspent: 0 };
    const out = applyXp(p, xpToNext(1) + xpToNext(2) + 5);
    expect(out.level).toBe(3);
    expect(out.xp).toBe(5);
    expect(out.levelsGained).toBe(2);
    expect(out.unspent).toBe(2);
    expect(out.stats.str).toBe(p.stats.str + 2);
    expect(out.stats.vit).toBe(p.stats.vit + 2);
    expect(p.stats.str).toBe(STARTING_STATS.qa_paladin.str);
  });
});

describe("overhead plate", () => {
  it("measures XP through the current level", () => {
    expect(xpProgress(1, 0)).toBe(0);
    expect(xpProgress(1, xpToNext(1) / 2)).toBeCloseTo(0.5);
    expect(xpProgress(3, xpToNext(3) * 2)).toBe(1);
    expect(xpProgress(2, -5)).toBe(0);
    expect(xpProgress(2, Number.NaN)).toBe(0);
  });

  it("agrees with levelling: xp left over after a level-up is progress into the next", () => {
    const after = applyXp({ classId: "test", level: 1, xp: 0, stats: { ...DEFAULT_STATS }, unspent: 0 }, xpToNext(1) + 10);
    expect(after.level).toBe(2);
    expect(xpProgress(after.level, after.xp)).toBeCloseTo(10 / xpToNext(2));
  });

  it("bands health green, yellow and red", () => {
    expect(healthBand(1)).toBe("good");
    expect(healthBand(0.51)).toBe("good");
    expect(healthBand(0.5)).toBe("hurt");
    expect(healthBand(0.26)).toBe("hurt");
    expect(healthBand(0.25)).toBe("low");
    expect(healthBand(0)).toBe("low");
  });

  it("snaps bars to whole pixels, showing a sliver but never a false full", () => {
    expect(barPixels(0, 30)).toBe(0);
    expect(barPixels(0.001, 30)).toBe(1);
    expect(barPixels(0.5, 30)).toBe(15);
    expect(barPixels(0.999, 30)).toBe(29);
    expect(barPixels(1, 30)).toBe(30);
    expect(barPixels(2, 30)).toBe(30);
  });
});
