// Zones: maps a party walks freely and fights on, turn by turn, on the
// tiles themselves. What the server and the client need is named here;
// the rest (the small moves in engine.ts, the enemy's reasoning in ai.ts)
// stays inside.

export * from "./types";
export { createZone, ensureMouth, stepZone, zoneView, zoneAwaiting, zoneHero, standInHero } from "./zone";
export { ZONE_GRIDS, ALERT_RANGE, JOIN_RANGE, DEFAULT_ZONE_OPTIONS, BIOME_LEADS, zoneOptions, generateZone, groupKinds, type ZonePlan } from "./gen";
export {
  FREE_WALK, MAX_ELEV, HEX_ROOM, HIGH_REACH,
  zoneReach, pathIn, sees, sameHex, elevOf, inFight, flies, unitAt, unitsAt, roomAt, heldAgainst, unitById, isDead, lineFrom, stepCost, blockerAt, seesFor, wallAt, ladderBetween, strikes, reachFrom, pitAt, solid as zoneSolid,
  blast as zoneBlast, type Reached, type Course, type Pit,
} from "./geometry";
export { PROPS, PROP_KINDS, propOf, type PropKind, type PropDef } from "./props";
export { SITES, SITE_IDS, FACTIONS, siteInside, siteOpen, siteFor, placeName, SITE_GROUNDS, LOOKOUT_INSIDE, LAIR_INSIDE, backdropOf, factionsOf, bandOf, type SiteId, type SiteGround, type SiteDef, type Backdrop, type PieceKind, type FactionId } from "./sites";
export { LAY_GRIDS, layZone } from "./lay";
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
  JUMP_UP,
  JUMP_DOWN,
  enemyShove,
  AP_TURN,
  SUMMON_AP_TURN,
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
  ENEMY_MOVE_AP,
  enemyHp,
  DEFAULT_THREAT,
  type Tactic,
  type SummonDef,
  type SummonCall,
  type Shape,
  type ThrowableDef,
  type EnemyStrike,
} from "./kit";
export { mod as statMod, proficiency, heroMove, heroDefence, diceFor, diceText, diceAverage, hitChance, rollShown, type Dice } from "./rules";
export { attackContext, defenceOf, has as hasCondition, shieldOf, unseen, type AttackContext } from "./engine";
export { abilityArea, carrySpot, checkAbility, checkCommon, checkDrink, checkLight, checkThrow, courseFor, crateBlow, moveLeft, walkAp, apForMove, payMove, previewAttack, leavesReach, shiftInto, shoveDest, edgeDc, EDGE_DC, BARD_AURA_RANGE, type Aim, type Shift } from "./combat";
export { chartOf, constellationHexes, constellationLinks, courseMarks, litFoes } from "./stars";
export { SURFACE_INFO, HARMFUL as HARMFUL_SURFACES } from "./surfaces";
export { WEATHER_INFO, wallHexes } from "./weather";
export { summonsOf, summonSpots } from "./summon";
export { breathDc, drowningStacks } from "./drowning";
export { SHANTIES, isShanty, joinable, shantyOf, shantyRadius, songsOn, type Song } from "./song";
export { carriesLantern, isDark, litHexes, inDark, seenByHeroes, lightSources, hiddenEnemies } from "./light";
export { MAX_CATCHUP_ROUNDS } from "./clock";
export { CHEST_PAY, SPOILS_ID, bountyPay, checkOpen, checkLoot, lootIn, sharedLoot, unopened, unlooted, zoneCleared } from "./loot";
export { ENEMY_FAMILY, FAMILY_LOOT, BOSS_LOOT, rollBody, rollChest, rollSpoils, type Family } from "./spoils";
export { HEAR_RANGE } from "./zone";
export { FORCE_DC, NOISE_RANGE, checkUnlock, doorAt } from "./doors";
export { GLOWCAP_LIGHT, GLOWCAP_MUSHROOMS, checkForage } from "./forage";
export { CRATE_HP, CRATE_PAY, crateAt, crateById, crateHp, isCrateId } from "./crates";
export { DELVE_GRID, DELVE_CRATES, generateDelve } from "./delve";
export { ZONE_MODS, ZONE_MOD_IDS, PERIL_IDS, BOON_IDS, MAX_MODS, MAX_BOONS, cleanMods, modsOf, modOf, modToken, modEffect, modName, modSide, modRanks, rollMod, type ZoneMod, type ZoneModId, type ZoneModDef, type ModSum } from "./mods";
