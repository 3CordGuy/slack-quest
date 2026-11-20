import { describe, expect, it } from "vitest";
import { LEVELUP_AUTO_ALLOC, STARTING_STATS, xpForLevel } from "./stats";

describe("class stat tables", () => {
  it("every class starts with 30 points and grows two different stats a level", () => {
    for (const [id, stats] of Object.entries(STARTING_STATS)) {
      expect(Object.values(stats).reduce((a, b) => a + b, 0), id).toBe(30);
      const grows = LEVELUP_AUTO_ALLOC[id];
      expect(grows, id).toHaveLength(2);
      expect(new Set(grows).size, id).toBe(2);
    }
    expect(Object.keys(LEVELUP_AUTO_ALLOC).sort()).toEqual(Object.keys(STARTING_STATS).sort());
  });
});

describe("xpForLevel", () => {
  it("is nothing at level 1 and climbs with every level after", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    for (let level = 2; level < 30; level++) expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
  });
});
