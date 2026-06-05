import { describe, expect, it } from "vitest";

import {
  emptyLoadoutForLevel,
  growLoadoutToLevel,
  passiveSlotsForLevel,
  type AbilityLoadout,
} from "./types";

describe("growLoadoutToLevel", () => {
  it("pads passive 1 -> 2 with null when crossing L10", () => {
    const before: AbilityLoadout = {
      active: [null, null, null, null],
      passive: ["passive_a"],
    };
    const after = growLoadoutToLevel(before, 10);
    expect(after.passive).toEqual(["passive_a", null]);
    expect(after.active).toEqual(before.active);
    expect(after.passive.length).toBe(passiveSlotsForLevel(10));
  });

  it("pads passive 2 -> 3 when crossing L30", () => {
    const before: AbilityLoadout = {
      active: [null, null, null, null],
      passive: ["passive_a", "passive_b"],
    };
    const after = growLoadoutToLevel(before, 30);
    expect(after.passive).toEqual(["passive_a", "passive_b", null]);
    expect(after.passive.length).toBe(passiveSlotsForLevel(30));
  });

  it("trims trailing null first when shrinking L10 -> L9 (preserves first non-null)", () => {
    const before: AbilityLoadout = {
      active: [null, null, null, null],
      passive: ["passive_a", null],
    };
    const after = growLoadoutToLevel(before, 9);
    expect(after.passive).toEqual(["passive_a"]);
  });

  it("drops a null in the middle when shrinking and the tail is non-null", () => {
    const before: AbilityLoadout = {
      active: [null, null, null, null],
      passive: [null, "passive_b"],
    };
    const after = growLoadoutToLevel(before, 9);
    expect(after.passive).toEqual(["passive_b"]);
  });

  it("is a no-op when length already matches the target", () => {
    const before: AbilityLoadout = {
      active: ["a", null, null, null],
      passive: ["passive_a", "passive_b"],
    };
    const after = growLoadoutToLevel(before, 10);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });

  it("matches emptyLoadoutForLevel shape when applied to a fresh L1 loadout up to L30", () => {
    const fresh = emptyLoadoutForLevel(1);
    const grown = growLoadoutToLevel(fresh, 30);
    expect(grown.passive.length).toBe(3);
    expect(grown.passive.every((p) => p === null)).toBe(true);
  });
});
