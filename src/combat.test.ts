import { describe, expect, it } from "vitest";
import {
  applyDamageWithShield,
  isBossPhaseTransition,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  resolveShield,
  resolveSignature,
} from "./combat";

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

describe("resolveSignature", () => {
  // Each signature gets one or two assertions verifying its formula. Using a
  // constant rollFn lets us pin damage exactly.
  const r = (val: number) => () => val;

  it("DevOps Mage Detonate: 2d6 + magic_mod + weapon", () => {
    // 2d6=4+4=8, mag=1, wpn=2 → 11
    expect(resolveSignature("devops_mage", 1, 1, 2, 1, 1, 30, r(4)).damage).toBe(11);
  });

  it("QA Paladin Smite: doubles attack_mod", () => {
    // 2d6=6+6=12, atk*2=2*2=4, wpn=0 → 16
    expect(resolveSignature("qa_paladin", 2, 0, 0, 1, 1, 30, r(6)).damage).toBe(16);
  });

  it("Backend Druid Wildgrowth: uses max(atk, mag) and adds tier", () => {
    // 1d8=5, max(1,1)=1, tier=3, wpn=0 → 9
    expect(resolveSignature("backend_druid", 1, 1, 0, 3, 1, 30, r(5)).damage).toBe(9);
  });

  it("Frontend Bard Crescendo: scales with party size", () => {
    const solo = resolveSignature("frontend_bard", 0, 2, 0, 1, 1, 30, r(3)).damage;
    const trio = resolveSignature("frontend_bard", 0, 2, 0, 1, 3, 30, r(3)).damage;
    // diff = (3-1) * 2 = 4
    expect(trio - solo).toBe(4);
  });

  it("Staff Sage Manifest: pure 2d8 + weapon, no class mod", () => {
    // 2d8=8+8=16, wpn=3 → 19. attack_mod and magic_mod are ignored.
    expect(resolveSignature("staff_sage", 99, 99, 3, 1, 1, 30, r(8)).damage).toBe(19);
  });

  it("Refactor Rogue Backstab: 3d4 + atk + weapon (caller applies the auto-crit)", () => {
    // Note: the auto-crit when monster ≤ 50% HP is applied by the caller, not here.
    // 3d4=2+2+2=6, atk=2, wpn=0 → 8
    expect(resolveSignature("refactor_rogue", 2, 0, 0, 1, 1, 30, r(2)).damage).toBe(8);
  });

  it("SRE Warden Bulwark Strike: caller folds armor into weapon slot", () => {
    // Caller passes wpn+armor as weaponPower. 1d10=7, atk=2, "wpn"=5 (3w+2a) → 14
    expect(resolveSignature("sre_warden", 2, 0, 5, 1, 1, 30, r(7)).damage).toBe(14);
  });

  it("Data Warlock Hex: damage scales with monster max HP", () => {
    // 1d6=3, mag=2, floor(40*0.05)=2, wpn=0 → 7
    expect(resolveSignature("data_warlock", 0, 2, 0, 1, 1, 40, r(3)).damage).toBe(7);
    // Bigger monster → more % damage
    // 1d6=3, mag=2, floor(200*0.05)=10, wpn=0 → 15
    expect(resolveSignature("data_warlock", 0, 2, 0, 1, 1, 200, r(3)).damage).toBe(15);
  });

  it("unknown class falls back to a vanilla attack-shaped formula", () => {
    // 1d6=4, atk=1, wpn=0 → 5
    expect(resolveSignature("unknown_class", 1, 0, 0, 1, 1, 30, r(4)).damage).toBe(5);
  });

  it("clamps negative weapon and zero/negative party-size to safe values", () => {
    // weaponPower<0 treated as 0; partySize<1 treated as 1
    const ok = resolveSignature("frontend_bard", 0, 0, -10, 1, 0, 30, r(3));
    expect(ok.damage).toBeGreaterThan(0);
  });
});

describe("resolveHeal", () => {
  const r = (val: number) => () => val;

  it("base heal is 1d6 + magic_mod", () => {
    expect(resolveHeal(2, r(4)).amount).toBe(6);
    expect(resolveHeal(0, r(3)).amount).toBe(3);
  });

  it("never heals less than 1, even with negative mod", () => {
    expect(resolveHeal(-10, r(1)).amount).toBe(1);
  });
});

describe("resolveShield", () => {
  const r = (val: number) => () => val;

  it("base shield is 1d6 + magic_mod", () => {
    expect(resolveShield(2, r(5)).amount).toBe(7);
  });

  it("never grants less than 1", () => {
    expect(resolveShield(-99, r(1)).amount).toBe(1);
  });
});

describe("applyDamageWithShield", () => {
  it("no shield → all damage hits HP", () => {
    const r = applyDamageWithShield(7, 0, 20);
    expect(r).toEqual({ newShield: 0, newHp: 13, shieldAbsorbed: 0, hpDamage: 7 });
  });

  it("shield fully absorbs small damage", () => {
    const r = applyDamageWithShield(3, 10, 20);
    expect(r).toEqual({ newShield: 7, newHp: 20, shieldAbsorbed: 3, hpDamage: 0 });
  });

  it("shield depletes and the remainder hits HP", () => {
    const r = applyDamageWithShield(8, 5, 20);
    expect(r).toEqual({ newShield: 0, newHp: 17, shieldAbsorbed: 5, hpDamage: 3 });
  });

  it("zero damage is a no-op", () => {
    const r = applyDamageWithShield(0, 5, 20);
    expect(r.shieldAbsorbed).toBe(0);
    expect(r.hpDamage).toBe(0);
  });

  it("negative damage is clamped to zero (defensive)", () => {
    const r = applyDamageWithShield(-3, 5, 20);
    expect(r).toEqual({ newShield: 5, newHp: 20, shieldAbsorbed: 0, hpDamage: 0 });
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
