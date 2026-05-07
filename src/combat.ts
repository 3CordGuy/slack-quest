// Pure combat math. Lives outside commands.ts so tests can exercise it without a DB.

export type CombatAction = "attack" | "cast" | "flee";

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
}

// Resolves the monster's counter-attack against a single fighter.
//   damage = 1d4 + tier + floor((alive_party - 1) / 2) [+ tier if boss phase 2]
//   then reduced by floor(armorPower / 2), with a minimum of 1 dmg dealt so armor
//   is never total immunity.
export function resolveMonsterHit(
  tier: number,
  fightersAlive: number,
  armorPower: number,
  bossPhase2: boolean,
  rollFn: (sides: number) => number,
): MonsterHit {
  const partyBonus = Math.floor((Math.max(1, fightersAlive) - 1) / 2);
  const bossBonus = bossPhase2 ? tier : 0;
  const raw = rollFn(4) + tier + partyBonus + bossBonus;
  const armorReduction = Math.floor(Math.max(0, armorPower) / 2);
  const final = Math.max(1, raw - armorReduction);
  return { raw, final, armorReduction };
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
