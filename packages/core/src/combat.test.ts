import { describe, expect, it } from "vitest";
import {
  applyDamageWithShield,
  isBossPhaseTransition,
  pickMonsterTarget,
  positionDamageMod,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  resolveSignature,
} from "./combat";

// Deterministic dice: returns the same fixed value for any size.
const constantRoll = (value: number) => () => value;

describe("resolvePlayerHit", () => {
  it("attack uses 1d6 + class_mod + weapon_mod", () => {
    const r = resolvePlayerHit("attack", 2, 3, constantRoll(4));
    // roll 4 (not crit since not 6) + (2 + 3) = 9
    expect(r).toEqual({ roll: 4, damage: 9, isCrit: false, formula: "1d6", totalMod: 5 });
  });

  it("crit on natural max doubles the post-modifier total", () => {
    const r = resolvePlayerHit("attack", 2, 1, constantRoll(6));
    // crit: (6 + 3) * 2 = 18
    expect(r.isCrit).toBe(true);
    expect(r.damage).toBe(18);
  });

  it("no weapon mod still rolls correctly", () => {
    const r = resolvePlayerHit("attack", 1, 0, constantRoll(3));
    expect(r.damage).toBe(4);
  });
});

describe("resolveMonsterHit", () => {
  it("solo party = no party bonus (physical)", () => {
    const r = resolveMonsterHit(2, 1, 0, false, constantRoll(3));
    // 1d4=3 + tier 2 + party 0 = 5; physical: armor handled by caller, final = raw
    expect(r).toEqual({ raw: 5, final: 5, armorReduction: 0, resistanceReduction: 0, damageType: "physical" });
  });

  it("party scaling adds floor((alive - 1) / 2)", () => {
    expect(resolveMonsterHit(1, 3, 0, false, constantRoll(2)).raw).toBe(4); // 2 + 1 + 1
    expect(resolveMonsterHit(1, 4, 0, false, constantRoll(2)).raw).toBe(4); // 2 + 1 + floor(3/2)=1
    expect(resolveMonsterHit(1, 5, 0, false, constantRoll(2)).raw).toBe(5); // 2 + 1 + 2
  });

  it("physical: resolveMonsterHit returns raw damage (caller depletes armor pool)", () => {
    const r = resolveMonsterHit(2, 1, 5, false, constantRoll(4));
    // raw = 4 + 2 = 6; no flat reduction — armor pool handled via applyDamageWithShield
    expect(r.raw).toBe(6);
    expect(r.final).toBe(6);
    expect(r.armorReduction).toBe(0);
    expect(r.damageType).toBe("physical");
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

  it("magic damage: armor is ignored, resistance % applies", () => {
    // raw = 1d4(3) + tier(2) = 5, 20% resist → floor(5*0.2)=1 reduction, final=4
    const r = resolveMonsterHit(2, 1, 10, false, constantRoll(3), "magic", 20);
    expect(r.damageType).toBe("magic");
    expect(r.armorReduction).toBe(0);
    expect(r.resistanceReduction).toBe(1); // floor(5 * 0.20) = 1
    expect(r.final).toBe(4);
  });

  it("elemental damage: resistance pct capped at 75", () => {
    // raw = 1d4(4) + tier(1) = 5, 90% resist clamped to 75 → floor(5*0.75)=3, final=2
    const r = resolveMonsterHit(1, 1, 0, false, constantRoll(4), "fire", 90);
    expect(r.resistanceReduction).toBe(3);
    expect(r.final).toBe(2);
  });

  it("non-physical damage still enforces minimum 1", () => {
    const r = resolveMonsterHit(1, 1, 0, false, constantRoll(1), "ice", 75);
    // raw = 1d4(1) + tier(1) = 2, 75% resist → floor(2*0.75)=1, final=max(1, 2-1)=1
    expect(r.final).toBe(1);
  });
});

describe("resolveSignature", () => {
  // Each signature gets one or two assertions verifying its formula. Using a
  // constant rollFn lets us pin damage exactly.
  const r = (val: number) => () => val;

  it("DevOps Mage Fireball: 2d6 + magic_mod (weapon ignored)", () => {
    // 2d6=4+4=8, mag=1, wpn=99 (ignored) → 9
    expect(resolveSignature("devops_mage", 0, 1, 99, 1, 1, 30, r(4)).damage).toBe(9);
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
  // r(val) returns a constant rollFn — both d6 calls return val.
  const r = (val: number) => () => val;

  it("base heal is 2d6 + magic_mod", () => {
    expect(resolveHeal(2, r(4)).amount).toBe(10); // 4+4+2=10
    expect(resolveHeal(0, r(3)).amount).toBe(6);  // 3+3+0=6
  });

  it("never heals less than 2 (floor prevents perma-zero healing)", () => {
    expect(resolveHeal(-10, r(1)).amount).toBe(2); // max(2, 1+1-10)=2
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

describe("positionDamageMod", () => {
  it("front row takes full damage", () => {
    expect(positionDamageMod("front", 10)).toBe(10);
    expect(positionDamageMod("front", 1)).toBe(1);
  });

  it("back row takes 60% (rounded down) of damage", () => {
    expect(positionDamageMod("back", 10)).toBe(6);
    expect(positionDamageMod("back", 5)).toBe(3);  // floor(3.0)
    expect(positionDamageMod("back", 7)).toBe(4);  // floor(4.2)
  });

  it("back row never takes less than 1 damage", () => {
    expect(positionDamageMod("back", 1)).toBe(1);
    expect(positionDamageMod("back", 2)).toBe(1);  // floor(1.2) → 1
  });
});

describe("pickMonsterTarget", () => {
  const front = { id: "F", position: "front" as const };
  const back = { id: "B", position: "back" as const };

  it("returns the only fighter when alone", () => {
    expect(pickMonsterTarget([front], () => 0.5).id).toBe("F");
    expect(pickMonsterTarget([back], () => 0.5).id).toBe("B");
  });

  it("picks first front-row when random is at 0", () => {
    expect(pickMonsterTarget([back, front], () => 0).id).toBe("B");  // weights: 1, 3 → first is back
  });

  it("front-to-back hit ratio is 3:1 over many rolls", () => {
    let frontHits = 0;
    let backHits = 0;
    for (let i = 0; i < 4000; i++) {
      const t = pickMonsterTarget([front, back], () => Math.random());
      if (t.id === "F") frontHits++;
      else backHits++;
    }
    // Expected: front gets ~3000, back gets ~1000. Allow loose bounds.
    expect(frontHits).toBeGreaterThan(2700);
    expect(frontHits).toBeLessThan(3300);
    expect(backHits).toBeGreaterThan(700);
    expect(backHits).toBeLessThan(1300);
  });

  it("back-only party still gets hit", () => {
    const t = pickMonsterTarget([back, back], () => 0.5);
    expect(t.position).toBe("back");
  });

  it("throws on empty fighters", () => {
    expect(() => pickMonsterTarget([], () => 0.5)).toThrow();
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
