// Zones: maps a party walks freely and fights on, turn by turn, on the
// tiles themselves. What the server and the client need is named here;
// the rest (the small moves in engine.ts, the enemy's reasoning in ai.ts)
// stays inside.

export * from "./types";
export { createZone, ensureMouth, stepZone, zoneView, zoneAwaiting, zoneHero, standInHero } from "./zone";
export { ZONE_GRIDS, ALERT_RANGE, JOIN_RANGE, DEFAULT_ZONE_OPTIONS, BIOME_LEADS, zoneOptions, generateZone, groupKinds, type ZonePlan } from "./gen";
export { FREE_WALK, zoneReach, pathIn, sees, sameHex, elevOf, inFight, flies, unitAt, unitById, isDead, lineFrom, stepCost, blockerAt, seesFor, wallAt, blast as zoneBlast, type Reached, type Course } from "./geometry";
export {
  TACTICS,
  tacticOf,
  abilityDice,
  healDice,
  CONDITION_INFO,
  COMMON_ACTIONS,
  commonCost,
  FLEE_RANGE,
  THROWABLES,
  STARTING_ITEMS,
  THROWABLE_KINDS,
  LIGHT_RADIUS,
  TORCH_HELD_ROUNDS,
  TORCH_GROUND_ROUNDS,
  EXPLORE_ROUND_MS,
  TORCH_ROUND_MS,
  SHIELD_SET_ASIDE,
  SMUGGLED,
  SEA_TURTLE,
  DROWNED_GUNNER,
  DROWNED_CUTLASS,
  SUMMONS,
  SUMMON_CALLS,
  DROWNING,
  DROWNING_CURSE,
  BLACK_SPOT,
  RED_SKY,
  UNHOLY_WATERS,
  AQUEOUS,
  CORAL_ARMOR,
  SPLASH,
  SHANTY,
  AURAS,
  CHORUS_PER_ALLY,
  GUIDING_LIGHT,
  CONSTELLATION,
  CHART,
  NORTH_STAR,
  AGAINST_WAVES,
  OVERWHELM,
  FORTIFY,
  BULWARK,
  TAUNT,
  cleanItems,
  throwRange,
  jumpRange,
  AP_TURN,
  AP_MAX,
  ACTION_AP,
  BONUS_AP,
  ITEM_AP,
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
  type SummonDef,
  type SummonCall,
  type Shape,
  type ThrowableDef,
  type EnemyStrike,
} from "./kit";
export { mod as statMod, proficiency, heroMove, heroDefence, diceFor, diceText, diceAverage, hitChance, type Dice } from "./rules";
export { attackContext, defenceOf, has as hasCondition, shieldOf, unseen, type AttackContext } from "./engine";
export { abilityArea, carrySpot, checkAbility, checkCommon, checkDrink, checkLight, checkThrow, courseFor, crateBlow, moveLeft, apForMove, payMove, previewAttack, BARD_AURA_RANGE, type Aim } from "./combat";
export { chartOf, constellationHexes, constellationLinks, courseMarks, litFoes } from "./stars";
export { SURFACE_INFO, HARMFUL as HARMFUL_SURFACES } from "./surfaces";
export { WEATHER_INFO, wallHexes } from "./weather";
export { summonsOf, summonSpots } from "./summon";
export { breathDc, drowningStacks } from "./drowning";
export { SHANTIES, isShanty, joinable, shantyOf, shantyRadius, songsOn, type Song } from "./song";
export { carriesLantern, isDark, litHexes, inDark, seenByHeroes, lightSources } from "./light";
export { MAX_CATCHUP_ROUNDS } from "./clock";
export { CHEST_PAY, bountyPay, checkOpen, unopened } from "./loot";
export { FORCE_DC, NOISE_RANGE, checkUnlock, doorAt } from "./doors";
export { GLOWCAP_LIGHT, GLOWCAP_MUSHROOMS, checkForage } from "./forage";
export { CRATE_HP, CRATE_PAY, crateAt, crateById, crateHp, isCrateId } from "./crates";
export { DELVE_GRID, DELVE_CRATES, generateDelve } from "./delve";
export { ZONE_MODS, ZONE_MOD_IDS, PERIL_IDS, BOON_IDS, MAX_MODS, MAX_BOONS, cleanMods, modsOf, modOf, modToken, modEffect, modName, modSide, modRanks, rollMod, type ZoneMod, type ZoneModId, type ZoneModDef, type ModSum } from "./mods";
