import { describe, expect, it } from "vitest";
import { isBossPhaseTransition, resolveMonsterHit, resolvePlayerHit } from "./combat";

// Deterministic dice: returns the same fixed value for any size.
const constantRoll = (value: number) => () => value;

describe("resolvePlayerHit", () => {
  it("attack uses 1d6 + class_mod + weapon_mod", () => {
    const r = resolvePlayerHit("attack", 2, 3, constantRoll(4));
    // roll 4 (not crit since not 6) + (2 + 3) = 9
    expect(r).toEqual({ roll: 4, damage: 9, isCrit: false, sides: 6, totalMod: 5 });
  });

  it("cast uses 1d8 + class_mod + weapon_mod", () => {
    const r = resolvePlayerHit("cast", 1, 0, constantRoll(5));
    // roll 5 (not crit, max for 8 is 8) + 1 = 6
    expect(r).toEqual({ roll: 5, damage: 6, isCrit: false, sides: 8, totalMod: 1 });
  });

  it("crit on natural max doubles the post-modifier total", () => {
    const r = resolvePlayerHit("attack", 2, 1, constantRoll(6));
    // crit: (6 + 3) * 2 = 18
    expect(r.isCrit).toBe(true);
    expect(r.damage).toBe(18);
  });

  it("cast crits on a natural 8", () => {
    const r = resolvePlayerHit("cast", 0, 0, constantRoll(8));
    expect(r.isCrit).toBe(true);
    expect(r.damage).toBe(16);
  });

  it("no weapon mod still rolls correctly", () => {
    const r = resolvePlayerHit("attack", 1, 0, constantRoll(3));
    expect(r.damage).toBe(4);
  });
});

describe("resolveMonsterHit", () => {
  it("solo party = no party bonus", () => {
    const r = resolveMonsterHit(2, 1, 0, false, constantRoll(3));
    // 1d4=3 + tier 2 + party 0 = 5
    expect(r).toEqual({ raw: 5, final: 5, armorReduction: 0 });
  });

  it("party scaling adds floor((alive - 1) / 2)", () => {
    expect(resolveMonsterHit(1, 3, 0, false, constantRoll(2)).raw).toBe(4); // 2 + 1 + 1
    expect(resolveMonsterHit(1, 4, 0, false, constantRoll(2)).raw).toBe(4); // 2 + 1 + floor(3/2)=1
    expect(resolveMonsterHit(1, 5, 0, false, constantRoll(2)).raw).toBe(5); // 2 + 1 + 2
  });

  it("armor reduces final damage by floor(power / 2)", () => {
    const r = resolveMonsterHit(2, 1, 5, false, constantRoll(4));
    // raw = 4 + 2 = 6, armor = floor(5/2) = 2, final = 6 - 2 = 4
    expect(r).toEqual({ raw: 6, final: 4, armorReduction: 2 });
  });

  it("never deals less than 1 damage even with overwhelming armor", () => {
    const r = resolveMonsterHit(1, 1, 100, false, constantRoll(1));
    // raw = 1 + 1 = 2, armor = 50, would be -48, clamped to 1
    expect(r.final).toBe(1);
  });

  it("boss phase 2 adds tier on top", () => {
    const noPhase = resolveMonsterHit(3, 1, 0, false, constantRoll(2));
    const phase2 = resolveMonsterHit(3, 1, 0, true, constantRoll(2));
    expect(phase2.raw - noPhase.raw).toBe(3);
  });

  it("treats fightersAlive < 1 as 1 (no negative party bonus)", () => {
    const r = resolveMonsterHit(1, 0, 0, false, constantRoll(2));
    // floor((1-1)/2) = 0, not floor((-1)/2) = -1
    expect(r.raw).toBe(3);
  });

  it("treats negative armor as 0", () => {
    const r = resolveMonsterHit(1, 1, -5, false, constantRoll(2));
    expect(r.armorReduction).toBe(0);
    expect(r.final).toBe(3);
  });
});

describe("isBossPhaseTransition", () => {
  it("triggers when crossing the 50% threshold", () => {
    expect(isBossPhaseTransition(40, 25, 19)).toBe(true);  // 25 ≥ 20, 19 < 20
  });

  it("does not trigger when starting below 50%", () => {
    expect(isBossPhaseTransition(40, 18, 10)).toBe(false);
  });

  it("does not trigger when staying above 50%", () => {
    expect(isBossPhaseTransition(40, 35, 25)).toBe(false);  // 35 ≥ 20, 25 ≥ 20
  });

  it("triggers exactly at the boundary read", () => {
    expect(isBossPhaseTransition(40, 20, 19)).toBe(true);  // 20 ≥ 20, 19 < 20
  });
});
