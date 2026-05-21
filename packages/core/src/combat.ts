// Pure combat math. Lives outside commands.ts so tests can exercise it without a DB.

import type { DamageType } from "./flavor";

export type CombatAction = "attack" | "cast" | "flee";

export type BattlePosition = "front" | "back";

// Position-based monster damage multiplier. Front-row eats full damage; back-row
// takes 60% (rounded down, with a minimum of 1 so back-row isn't immune).
export function positionDamageMod(position: BattlePosition, rawDamage: number): number {
  if (position === "back") return Math.max(1, Math.floor(rawDamage * 0.6));
  return rawDamage;
}

// Picks a monster's target from the alive party, weighted by battle position.
// Front-row characters are 3× more likely to be hit than back-row. If only back-row
// fighters remain, the monster targets back. Random injection makes it testable.
export function pickMonsterTarget<T extends { id: string; position: BattlePosition }>(
  fighters: T[],
  random: () => number,
  alreadyTargeted?: Record<string, number>,
): T {
  if (fighters.length === 0) throw new Error("pickMonsterTarget: empty fighters list");
  // Base weight: front row 3×, back row 1×.
  // Anti-pile-on: divide by (1 + times already targeted this round) so a
  // fighter who was just picked by another monster is 2× less likely to get
  // picked again, 3× less likely if picked twice, etc.
  const weights = fighters.map((f) => {
    const base = f.position === "back" ? 1 : 3;
    const already = alreadyTargeted?.[f.id] ?? 0;
    return base / (1 + already);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < fighters.length; i++) {
    r -= weights[i];
    if (r <= 0) return fighters[i];
  }
  return fighters[fighters.length - 1];
}

export interface PlayerHit {
  roll: number;
  damage: number;
  isCrit: boolean;
  sides: number;
  totalMod: number;
}

// Resolves a player's attack/cast against the monster.
//   action="attack" → 1d6, crit on natural 6
//   action="cast"   → 1d8, crit on natural 8
// Crits double the post-modifier total. `rollFn(sides)` is injected so tests can be
// deterministic; production passes flavor.ts's `rollDice`.
export function resolvePlayerHit(
  action: "attack" | "cast",
  classMod: number,
  weaponMod: number,
  rollFn: (sides: number) => number,
): PlayerHit {
  const sides = action === "cast" ? 8 : 6;
  const roll = rollFn(sides);
  const isCrit = roll === sides;
  const totalMod = classMod + weaponMod;
  const damage = (roll + totalMod) * (isCrit ? 2 : 1);
  return { roll, damage, isCrit, sides, totalMod };
}

export interface MonsterHit {
  raw: number;
  final: number;
  armorReduction: number;
  resistanceReduction: number;
  damageType: DamageType;
}

// Resolves the monster's counter-attack against a single fighter.
//   damage = 1d4 + tier + floor((alive_party - 1) / 2) [+ tier if boss phase 2]
//
// Physical attacks: reduced by floor(armorPower / 2), minimum 1.
// Magic/elemental attacks: armor is ignored; a percentage reduction from gear
//   resistances applies instead (capped 0–75). Minimum 1 always enforced.
export function resolveMonsterHit(
  tier: number,
  fightersAlive: number,
  armorPower: number,
  bossPhase2: boolean,
  rollFn: (sides: number) => number,
  damageType: DamageType = "physical",
  resistancePct: number = 0,
): MonsterHit {
  const partyBonus = Math.floor((Math.max(1, fightersAlive) - 1) / 2);
  const bossBonus = bossPhase2 ? tier : 0;
  const raw = rollFn(4) + tier + partyBonus + bossBonus;

  let armorReduction = 0;
  let resistanceReduction = 0;
  let final: number;

  if (damageType === "physical") {
    // Armor is a depletable pool managed by the caller via applyDamageWithShield.
    // resolveMonsterHit just returns raw damage; actual armor absorption is
    // reflected in applyDamageWithShield's shieldAbsorbed output.
    final = raw;
  } else {
    const clampedPct = Math.min(75, Math.max(0, resistancePct));
    resistanceReduction = Math.floor(raw * clampedPct / 100);
    final = Math.max(1, raw - resistanceReduction);
  }

  return { raw, final, armorReduction, resistanceReduction, damageType };
}

// True iff this attack drops the monster from at-or-above 50% HP to below 50% — the
// boss phase 1→2 transition trigger. Caller is responsible for checking variant=boss
// and current phase before applying the transition.
export function isBossPhaseTransition(
  monsterMaxHp: number,
  oldHp: number,
  newHp: number,
): boolean {
  return oldHp >= monsterMaxHp / 2 && newHp < monsterMaxHp / 2;
}

// Heal: 2d6 + magic_mod HP restored. Two dice smooth out the punishing low end —
// physical classes (mag_mod 0) heal 2-12, casters (mag_mod 2) heal 4-14.
export function resolveHeal(
  magicMod: number,
  rollFn: (sides: number) => number,
): { amount: number; roll: number } {
  const roll = rollFn(6) + rollFn(6);
  const amount = Math.max(2, roll + magicMod);
  return { amount, roll };
}

// Applies incoming raw damage through the shield buffer first, then HP. Shield is
// consumed by the absorbed amount; HP eats whatever's left over. Used by both the
// monster turn and the failed-flee free hit.
export function applyDamageWithShield(
  rawDamage: number,
  currentShield: number,
  currentHp: number,
): { newShield: number; newHp: number; shieldAbsorbed: number; hpDamage: number } {
  const dmg = Math.max(0, rawDamage);
  const shieldAbsorbed = Math.min(currentShield, dmg);
  const newShield = currentShield - shieldAbsorbed;
  const hpDamage = dmg - shieldAbsorbed;
  const newHp = currentHp - hpDamage;
  return { newShield, newHp, shieldAbsorbed, hpDamage };
}

export interface SignatureResult {
  damage: number;
  formula: string; // human-readable for the ephemeral / log
}

// Resolves a class signature ability. Costs 1 mana (caller deducts). Each class has
// a distinct formula so the eight feel mechanically different even though they share
// the same /sq signature command.
export function resolveSignature(
  classId: string,
  attackMod: number,
  magicMod: number,
  weaponPower: number,
  tier: number,
  partySize: number,
  monsterMaxHp: number,
  rollFn: (sides: number) => number,
): SignatureResult {
  const wpn = Math.max(0, weaponPower);
  const t = Math.max(1, tier);
  const party = Math.max(1, partySize);

  switch (classId) {
    case "devops_mage": {
      // Fireball: 2d6 + magic_mod (pure magic — weapon adds no bonus)
      const r = rollFn(6) + rollFn(6);
      return { damage: r + magicMod, formula: `2d6 + ${magicMod}m` };
    }
    case "qa_paladin": {
      // Smite: 2d6 + attack_mod * 2 + weapon
      const r = rollFn(6) + rollFn(6);
      return { damage: r + attackMod * 2 + wpn, formula: `2d6 + ${attackMod}a×2 + ${wpn}w` };
    }
    case "backend_druid": {
      // Wildgrowth: 1d8 + max(atk, mag) + tier + weapon
      const best = Math.max(attackMod, magicMod);
      const r = rollFn(8);
      return { damage: r + best + t + wpn, formula: `1d8 + ${best} + ${t}t + ${wpn}w` };
    }
    case "frontend_bard": {
      // Crescendo: 1d6 + magic_mod + party_size * 2 + weapon
      const r = rollFn(6);
      return { damage: r + magicMod + party * 2 + wpn, formula: `1d6 + ${magicMod}m + ${party}p×2 + ${wpn}w` };
    }
    case "staff_sage": {
      // Manifest: 2d8 + weapon (raw caster output, no class mod)
      const r = rollFn(8) + rollFn(8);
      return { damage: r + wpn, formula: `2d8 + ${wpn}w` };
    }
    case "refactor_rogue": {
      // Backstab: 3d4 + attack_mod + weapon
      // (auto-crit if monster ≤ 50% HP applied by caller — needs monster_hp)
      const r = rollFn(4) + rollFn(4) + rollFn(4);
      return { damage: r + attackMod + wpn, formula: `3d4 + ${attackMod}a + ${wpn}w` };
    }
    case "sre_warden": {
      // Bulwark Strike: 1d10 + attack_mod + armor_power. Armor power is passed via
      // weaponPower's slot — caller must pre-add the armor value if both equipped.
      const r = rollFn(10);
      return { damage: r + attackMod + wpn, formula: `1d10 + ${attackMod}a + ${wpn}` };
    }
    case "data_warlock": {
      // Hex: 1d6 + magic_mod + floor(monster_max_hp * 0.05) + weapon
      const slowQuery = Math.floor(Math.max(0, monsterMaxHp) * 0.05);
      const r = rollFn(6);
      return { damage: r + magicMod + slowQuery + wpn, formula: `1d6 + ${magicMod}m + ${slowQuery}% + ${wpn}w` };
    }
    default: {
      // Unknown class — fall back to a vanilla attack so it's never a no-op.
      const r = rollFn(6);
      return { damage: r + attackMod + wpn, formula: `1d6 + ${attackMod}a + ${wpn}w` };
    }
  }
}
