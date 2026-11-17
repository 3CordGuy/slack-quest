// Zones: maps a party walks freely and fights on, turn by turn, on the
// tiles themselves. What the server and the client need is named here;
// the rest (the small moves in engine.ts, the enemy's reasoning in ai.ts)
// stays inside.

export * from "./types";
export { createZone, stepZone, zoneView, zoneAwaiting, zoneHero, standInHero } from "./zone";
export { ZONE_GRIDS, ALERT_RANGE, JOIN_RANGE, DEFAULT_ZONE_OPTIONS, BIOME_LEADS, zoneOptions, generateZone, groupKinds, type ZonePlan } from "./gen";
export { FREE_WALK, zoneReach, pathIn, sees, sameHex, elevOf, inFight, flies, unitAt, unitById, lineFrom, stepCost, blast as zoneBlast, type Reached } from "./geometry";
export {
  TACTICS,
  tacticOf,
  abilityDice,
  healDice,
  CONDITION_INFO,
  COMMON_ACTIONS,
  commonCost,
  THROWABLES,
  STARTING_ITEMS,
  THROWABLE_KINDS,
  LIGHT_RADIUS,
  TORCH_HELD_ROUNDS,
  TORCH_GROUND_ROUNDS,
  SHIELD_SET_ASIDE,
  cleanItems,
  throwRange,
  jumpRange,
  JUMP_MOVE_COST,
  POTION_DICE,
  POTION_EDGE,
  ENEMY_KIT,
  ENEMY_BURST,
  enemyStrikes,
  enemyDefence,
  enemyMove,
  enemyHp,
  DEFAULT_THREAT,
  type Tactic,
  type Shape,
  type ThrowableDef,
  type EnemyStrike,
} from "./kit";
export { mod as statMod, proficiency, heroMove, heroDefence, diceFor, diceText, diceAverage, hitChance, type Dice } from "./rules";
export { attackContext, defenceOf, has as hasCondition, type AttackContext } from "./engine";
export { abilityArea, checkAbility, checkCommon, checkDrink, checkLight, checkThrow, previewAttack, BARD_AURA_RANGE, type Aim } from "./combat";
export { SURFACE_INFO, HARMFUL as HARMFUL_SURFACES } from "./surfaces";
export { isDark, litHexes, inDark, seenByHeroes, lightSources } from "./light";
