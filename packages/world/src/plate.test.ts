import { describe, expect, it } from "vitest";
import { DEFAULT_STATS } from "@gantt-quest/core";
import { applyXp, barPixels, healthBand, xpProgress, xpToNext } from "./index";

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

  it("bands health green, yellow, red like the battle bars", () => {
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
