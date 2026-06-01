import { describe, it, expect } from "vitest";

import {
  STOCK_CAP,
  STOCK_REGEN_MS,
  STOCK_EMPTY_XP,
  currentStock,
  nextStockTickMs,
  spendStock,
  scaleMinigameXp,
} from "./flavor";

describe("camp node stock", () => {
  const now = 1_700_000_000_000;

  it("null full-at means full stock", () => {
    expect(currentStock(null, now)).toBe(STOCK_CAP);
    expect(currentStock(undefined, now)).toBe(STOCK_CAP);
  });

  it("past full-at means full stock", () => {
    expect(currentStock(now - 1, now)).toBe(STOCK_CAP);
  });

  it("future full-at deducts one stock per pending regen tick", () => {
    // Full-at = now + 3 hours → 3 ticks remaining → stock = 10 - 3 = 7
    const fullAt = now + 3 * STOCK_REGEN_MS;
    expect(currentStock(fullAt, now)).toBe(STOCK_CAP - 3);
  });

  it("clamps stock at zero when way in the future", () => {
    const fullAt = now + 50 * STOCK_REGEN_MS;
    expect(currentStock(fullAt, now)).toBe(0);
  });

  it("nextStockTickMs returns time until next +1", () => {
    expect(nextStockTickMs(null, now)).toBeNull();
    expect(nextStockTickMs(now - 1, now)).toBeNull();
    // Pool is missing 3 stock, next tick is in 0.4 hours.
    const fullAt = now + 2 * STOCK_REGEN_MS + 0.4 * STOCK_REGEN_MS;
    const tick = nextStockTickMs(fullAt, now);
    expect(tick).not.toBeNull();
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThanOrEqual(STOCK_REGEN_MS);
  });

  it("spendStock from a full pool starts the regen clock", () => {
    // Spending 2 units from a full pool: new full-at = now + 2hrs
    const newFullAt = spendStock(null, now, 2);
    expect(newFullAt).toBe(now + 2 * STOCK_REGEN_MS);
    expect(currentStock(newFullAt, now)).toBe(STOCK_CAP - 2);
  });

  it("spendStock from a partial pool extends the regen clock", () => {
    const fullAt = now + 3 * STOCK_REGEN_MS; // 7 stock available
    const newFullAt = spendStock(fullAt, now, 2);
    expect(newFullAt).toBe(fullAt + 2 * STOCK_REGEN_MS);
    expect(currentStock(newFullAt, now)).toBe(STOCK_CAP - 5);
  });

  it("spendStock(0) is a no-op on the timestamp", () => {
    const fullAt = now + 2 * STOCK_REGEN_MS;
    expect(spendStock(fullAt, now, 0)).toBe(fullAt);
    expect(spendStock(null, now, 0)).toBe(now);
  });

  it("STOCK_EMPTY_XP is the scant-XP floor for exhausted nodes", () => {
    expect(STOCK_EMPTY_XP).toBeGreaterThan(0);
    expect(STOCK_EMPTY_XP).toBeLessThan(5); // generous enough to feel worthwhile, tight enough not to flood XP
  });
});

describe("mini-game XP level scaling", () => {
  it("levels 1-3 see no change (no penalty for new players)", () => {
    expect(scaleMinigameXp(10, 1)).toBe(10);
    expect(scaleMinigameXp(10, 2)).toBe(10);
    expect(scaleMinigameXp(10, 3)).toBe(10);
  });

  it("each level above 3 adds 15% to the base", () => {
    // floor(10 * (1 + 0.15 * (level - 3)))
    expect(scaleMinigameXp(10, 4)).toBe(11);   // floor(11.5) = 11
    expect(scaleMinigameXp(10, 5)).toBe(13);   // floor(13.0) = 13
    expect(scaleMinigameXp(10, 10)).toBe(20);  // floor(20.5) = 20
    expect(scaleMinigameXp(10, 20)).toBe(35);  // floor(35.5) = 35
  });

  it("scant XP at high level becomes a respectable bonus", () => {
    expect(scaleMinigameXp(2, 10)).toBe(4); // floor(2 * 2.05)
    expect(scaleMinigameXp(2, 20)).toBe(7); // floor(2 * 3.55)
  });

  it("returns the base when level is missing or low", () => {
    expect(scaleMinigameXp(5, 0)).toBe(5);
    expect(scaleMinigameXp(5, 1)).toBe(5);
  });
});
