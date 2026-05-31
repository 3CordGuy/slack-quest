import { describe, it, expect } from "vitest";

import {
  STOCK_CAP,
  STOCK_REGEN_MS,
  STOCK_EMPTY_XP,
  currentStock,
  nextStockTickMs,
  spendStock,
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
