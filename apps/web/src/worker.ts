// Web app Worker. Handles /api/* routes; static assets and SPA fallback come
// from the ASSETS binding (configured in wrangler.jsonc). Shares the same D1
// instance as the Slack worker so codes issued by /sq web-login are visible
// here. The QuestRoom Durable Object (defined below) coordinates live web-mode
// combat over WebSocket.

import { DurableObject } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  VIEW_ART_PROMPTS,
  flavorCatalogItem,
  flavorDeath,
  flavorFleeSuccess,
  flavorHit,
  flavorLootDrop,
  flavorVictory,
  generateGauntletWaves,
  generateJobListing,
  generateOpeningScene,
  generateTownName,
  generateCharacterName,
  getOrScheduleViewArt,
  generateCharacterArtNow,
  getOrScheduleCharacterArt,
  type ViewArtKey,
} from "./ai";

import {
  ACHIEVEMENTS,
  APOTHECARY_STAPLES,
  FOCUS_MAX_MANA_BONUS,
  focusManaBonus,
  MAX_MANA_CAP,
  checkApothecaryAchievements,
  checkCombatAchievements,
  checkDeathAchievements,
  checkProgressionAchievements,
  classByName,
  createCombatState,
  statsAtLevel,
  deriveMaxMana,
  FREE_POINTS_PER_LEVEL,
  dropChance,
  findApothecaryStaple,
  findCatalogEntry,
  apothecaryItemStats,
  generateScar,
  generateMerchantName,
  generateNpcName,
  pickRandomClass,
  STAPLES,
  findStaple,
  haggleMod,
  pickHaggleLine,
  npcTrustMod,
  priceFor,
  resolveMonsterKill,
  rollDice,
  rollItem,
  rollAccessorySlot,
  rollSmithyArmor,
  rollMerchantItem,
  sellPriceFor,
  step,
  xpForLevel,
  statSnapshot,
  upgradeCombatState,
  mergeEffect,
  MONSTER_ID,
  isAllyNpcActor,
  MERCS,
  findMerc,
  MONSTER_ELEMENT_AFFINITY_CHANCE,
  // Camp / gathering / crafting
  CAMP_NODE_CONFIG,
  CAMP_TIERS,
  CAMP_UPGRADE_CATALOG,
  FORAGE_GRID_ROWS,
  FORAGE_GRID_COLS,
  FORAGE_HAZARD_DICE,
  forageFlipsForInt,
  forageHazardCount,
  forageCascadeFrom,
  isForageHazard,
  generateForageGrid,
  type ForageCellKind,
  FISH_BITE_MIN_MS,
  FISH_BITE_MAX_MS,
  FISH_REACTION_FLOOR_MS,
  FISH_REEL_TARGET_MS,
  fishBiteWindowForDex,
  fishPullRateForStr,
  fishCatchQuality,
  RECIPE_CATALOG,
  RESOURCE_CATALOG,
  findCampUpgrade,
  findCookRecipe,
  findRecipe,
  smithyEffectivePower,
  COOK_RECIPES,
  findResource,
  gatherSlotCount,
  resourceItemName,
  applyDurationModifier,
  computeTentModifiers,
  rollGatherYield,
  NO_TENT_MODIFIERS,
  type TentModifiers,
  type CampNode,
  type CampTier,
  type RecipeSpec,
  // Pub Errands
  PUB_ERRAND_RESTOCK_MS,
  PUB_ERRAND_TIERS,
  PUB_ERRAND_TRUST_GATE,
  PUB_OFFERS_PER_PATRON,
  PUB_PATRONS,
  PUB_PROCURE_INPUT_QTY,
  PUB_TRUST_CAP,
  findPubPatron,
  rollPatronOfferKinds,
  rollPubErrandYield,
  tierForOfferIndex,
  type PubErrandKind,
  type PubErrandTier,
  type PubErrandYield,
  type CombatEvent,
  type CombatFighter,
  type CombatMonster,
  type StatKey,
  type CombatInit,
  type CombatState,
  type DamageType,
  type ElementType,
  type DialogNode,
  type DialogOption,
  type DialogPayload,
  type ItemRoll,
  type ItemType,
  type Rarity,
  type NpcSpec,
  type RollFn,
  type Stats,
  type TurnAction,
} from "@gantt-quest/core";
import {
  addGold,
  addItem,
  addMana,
  addShield,
  applyFocusManaShift,
  applyInnRest,
  applyLongRest,
  applyShortRest,
  sharpenItem,
  applySoftDeath,
  bumpMaxMana,
  claimShopItem,
  clearPartyEffects,
  consumeItem,
  countPurchasesInCycle,
  equipItem,
  getActiveQuestInChannel,
  getActiveShopStock,
  getShopItem,
  healCharacter,
  joinQuest,
  refillMana,
  initArmorPool,
  getActiveSmithyStock,
  insertSmithyStock,
  getSmithyStockItem,
  claimSmithyItem,
  releaseSmithyClaim,
  releaseShopClaim,
  scaleMonsterForJoin,
  getQuestPartySize,
  transferItem,
  insertNotification,
  fetchAndClearNotifications,
  setPosition,
  tryDeductGold,
  trySetHaggleOutcome,
  awardSpoils,
  issueWebLoginCode,
  consumeWebLoginCode,
  createWebSession,
  deleteWebCombatState,
  deleteWebSession,
  deleteCharacter,
  createCharacter,
  createQuest,
  getActiveQuestForCharacter,
  getRecentMonsterNames,
  getCharacter,
  getEquipped,
  getInventory,
  getItem,
  getQuestById,
  getQuestParty,
  clearDrinkBuff as dbClearDrinkBuff,
  setDrinkBuff as dbSetDrinkBuff,
  getClaimedNpcPaths,
  getRecentQuestsForCharacter,
  getQuestStatsForCharacter,
  getQuestLeaderboard,
  getStaleTownState,
  getWebCombatState,
  getWebCombatSnapshot,
  getWebSession,
  markQuestStatus,
  recordClaimedNpcPath,
  grantAchievement,
  consumePendingAchievements,
  getDownedCharacters,
  incrementApothecaryPurchases,
  incrementRevivesGiven,
  reviveCharacter,
  getLifetimeStats,
  getPubLeaderboard,
  removeItem,
  saveScene,
  saveWebCombatOutcome,
  saveWebCombatState,
  spendStatPoint,
  setCharacterHpAndShield,
  setNotificationPref,
  setHiredMerc,
  clearHiredMerc,
  clearHiredMercForParty,
  setQuestMode,
  getAllEquippedSlots,
  insertShopStock,
  characterLevelRange,
  countCharacters,
  type ActiveQuest,
  type Character,
  type CharGender,
  type LootOption,
  type MonsterSpec,
  type SceneJson,
  getLobbyQuestForCharacter,
  getLobbyQuestById,
  getLobbyParty,
  updateInviteStatus,
  updateReadyStatus,
  removePendingInvitees,
  activateQuest,
  addPendingInvitee,
  appendLog,
  setQuestLocked,
  deleteQuestCascade,
  hasPendingInvitees,
  type LobbyQuest,
  type LobbyPartyMember,
  type TowerFloorPlan,
  incrementTowerStats,
  getTowerLeaderboard,
  listCharacterSlots,
  activateCharacterSlot,
  reserveSlotForNewCharacter,
  setActiveSlot,
  deleteCharacterSlot,
  getRecentCharacterNames,
  // Camp / gathering / crafting
  APOTHECARY_POTENCY_CAP,
  applyPotency,
  SMITHY_SHARPEN_GOLD_CAP,
  SMITHY_SHARPEN_TOTAL_CAP,
  addResource,
  bumpSharpens,
  cancelGatheringTask,
  getGatheringTask,
  listActiveGatheringTasks,
  listCampUpgrades,
  markGatheringTaskClaimed,
  startGatheringTask,
  tryAddPotencyStack,
  tryBuildCampUpgrade,
  tryConsumeResource,
  tryWriteGatheringYield,
  type GatheringTask,
  bumpCampClaimStats,
  bumpMineRichHits,
  bumpForageFlawless,
  bumpFishPlays,
  updateFishBestMs,
  bumpSmithyCrafts,
  bumpErrandStats,
  getHarvestLeaderboard,
  getForageGame,
  startForageGame,
  updateForageGame,
  deleteForageGame,
  getFishGame,
  startFishGame,
  recordFishStrike,
  deleteFishGame,
  // Pub Errands
  bumpPubTrust,
  getActivePubErrand,
  getActivePubErrandOffers,
  getPubErrand,
  getPubErrandOffer,
  getPubTrust,
  insertPubErrandOffers,
  listPubTrust,
  markPubErrandCancelled,
  markPubErrandClaimed,
  releasePubErrandOffer,
  startPubErrand,
  tryClaimPubErrandOffer,
  tryWritePubErrandYield,
  type PubErrand,
  type PubErrandOfferInput,
  type PubErrandOfferRow,
} from "@gantt-quest/db";

// =============================================================================
// PUB — Drink catalog (mirrors apps/slack/src/flavor.ts DRINKS)
// =============================================================================
const DRINK_CAP = 2; // max drinks between quests; reset when joining/starting

type DrinkEffectKind =
  | "buff_attack"
  | "buff_magic"
  | "buff_next_crit"
  | "instant_shield"
  | "instant_hp"
  | "instant_mana"
  | "instant_combo";

type DrinkEffect =
  | { kind: "buff_attack"; magnitude: number; duration: number }
  | { kind: "buff_magic"; magnitude: number; duration: number }
  | { kind: "buff_next_crit" }
  | { kind: "instant_shield"; amount: number }
  | { kind: "instant_hp"; amount: number }
  | { kind: "instant_mana"; amount: number }
  | { kind: "instant_combo"; hp: number; mana: number };

interface DrinkSpec {
  id: string;
  name: string;
  emoji: string;
  price: number;
  effect: DrinkEffect;
  blurb: string;
}

interface DrinkBuff {
  kind: "buff_attack" | "buff_magic" | "buff_next_crit";
  magnitude: number;
  remaining: number;
  drink_id: string;
  fight_duration?: true;
}

const DRINKS: DrinkSpec[] = [
  { id: "ale",     emoji: "🍺", name: "Tavern Ale",        price: 8,  effect: { kind: "buff_attack",   magnitude: 1, duration: 3 }, blurb: "Cheap, foamy, gives you the courage to swing harder. +1 attack for the whole fight." },
  { id: "mead",    emoji: "🍷", name: "Spiced Mead",       price: 8,  effect: { kind: "buff_magic",    magnitude: 1, duration: 3 }, blurb: "Cinnamon, clove, and a tingle in the fingertips. +1 magic for the whole fight." },
  { id: "brew",    emoji: "🥃", name: "Iron Brew",         price: 8,  effect: { kind: "instant_shield", amount: 5 },                blurb: "Tastes like ore. Lines your gut with grit. +5 shield, instant." },
  { id: "tea",     emoji: "🍵", name: "Bitter Tea",        price: 12, effect: { kind: "instant_mana",  amount: 3 },                blurb: "Clarifies the mind, reignites the channel. +3 mana, instant." },
  { id: "milk",    emoji: "🥛", name: "Frothy Milk",       price: 10, effect: { kind: "instant_hp",    amount: 8 },                blurb: "Comfort in a glass. The bartender knows. +8 HP, instant." },
  { id: "lucky",   emoji: "💧", name: "Lucky Sip",         price: 15, effect: { kind: "buff_next_crit" },                          blurb: "A shimmer of fate. Your next attack/cast/ability is a guaranteed crit." },
  { id: "whiskey", emoji: "🍶", name: "Aged Whiskey",      price: 25, effect: { kind: "buff_attack",   magnitude: 2, duration: 3 }, blurb: "Smoke, leather, twenty harvests of patience. +2 attack for the whole fight." },
  { id: "reset",   emoji: "🍹", name: "Engineer's Reset",  price: 30, effect: { kind: "instant_combo", hp: 4, mana: 4 },           blurb: "Mystery cocktail. Tastes like everything went green. +4 HP and +4 mana, instant." },
];

function findDrinkById(id: string): DrinkSpec | undefined {
  return DRINKS.find((d) => d.id === id);
}

async function getDailySpecialId(db: D1Database, channelId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT state_json FROM town_state WHERE channel_id = ?")
    .bind(channelId)
    .first<{ state_json: string }>();
  if (!row) return null;
  const state = JSON.parse(row.state_json) as { pub?: { daily_special_drink_id?: string } };
  return state.pub?.daily_special_drink_id ?? null;
}

async function setDrinkBuff(db: D1Database, userId: string, buff: DrinkBuff): Promise<void> {
  await db
    .prepare("UPDATE characters SET drink_buff_json = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(JSON.stringify(buff), Date.now(), userId)
    .run();
}

// =============================================================================
// LIARS' ROLL — solo pub mini-game (mirrors apps/slack/src/commands.ts)
// =============================================================================

type LiarsClaim = "low" | "medium" | "high";
type LiarsOutcome = "trust_win" | "trust_lose" | "challenge_win" | "challenge_lose";

interface LiarsRound {
  id: number;
  user_id: string;
  channel_id: string;
  stake: number;
  player_dice: number[];
  bartender_dice: number[];
  claim: LiarsClaim;
  lied: boolean;
  status: "open" | "resolved";
  outcome: LiarsOutcome | null;
  payout: number | null;
  created_at: number;
}

const LIARS_STAKES = [10, 25, 50];
const LIARS_HOUSE_CUT = 0.05;
const LIARS_TRUTH_RATE = 0.55;
const LIARS_TRUST_MULT = 1.7;
const LIARS_CHALLENGE_MULT = 2.5;
const SHIELD_CAP_MULTIPLIER = 1.5; // mirrors Slack's cap logic

function liarsZoneFor(total: number): LiarsClaim {
  if (total <= 18) return "low";
  if (total <= 23) return "medium";
  return "high";
}

function liarsZoneLabel(z: LiarsClaim): string {
  if (z === "low") return "Low (≤18)";
  if (z === "medium") return "Medium (19-23)";
  return "High (≥24)";
}

function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function rollThreeD6(): number[] {
  return [rollD6(), rollD6(), rollD6()];
}

async function createLiarsRound(
  db: D1Database,
  input: {
    user_id: string;
    channel_id: string;
    stake: number;
    player_dice: number[];
    bartender_dice: number[];
    claim: LiarsClaim;
    lied: boolean;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO liars_rounds (user_id, channel_id, stake, player_dice, bartender_dice, claim, lied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.user_id,
      input.channel_id,
      input.stake,
      JSON.stringify(input.player_dice),
      JSON.stringify(input.bartender_dice),
      input.claim,
      input.lied ? 1 : 0,
      Date.now(),
    )
    .run();
  return result.meta.last_row_id as number;
}

async function getLiarsRound(db: D1Database, roundId: number): Promise<LiarsRound | null> {
  const row = await db
    .prepare("SELECT * FROM liars_rounds WHERE id = ?")
    .bind(roundId)
    .first<{
      id: number; user_id: string; channel_id: string; stake: number;
      player_dice: string; bartender_dice: string; claim: string;
      lied: number; status: string; outcome: string | null;
      payout: number | null; created_at: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    channel_id: row.channel_id,
    stake: row.stake,
    player_dice: JSON.parse(row.player_dice) as number[],
    bartender_dice: JSON.parse(row.bartender_dice) as number[],
    claim: row.claim as LiarsClaim,
    lied: row.lied === 1,
    status: row.status as "open" | "resolved",
    outcome: row.outcome as LiarsOutcome | null,
    payout: row.payout,
    created_at: row.created_at,
  };
}

async function finalizeLiarsRound(
  db: D1Database,
  roundId: number,
  outcome: LiarsOutcome,
  payout: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE liars_rounds SET status = 'resolved', outcome = ?, payout = ?, resolved_at = ? WHERE id = ? AND status = 'open'`,
    )
    .bind(outcome, payout, Date.now(), roundId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// =============================================================================

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Reward formula: 15 × tier^1.2 for XP, 8 × tier^1.2 for gold.
// Grows faster than the old linear formula so higher-tier fights feel
// proportionally more rewarding, while early tiers stay grindy.
function baseRewardXp(tier: number): number { return Math.round(15 * Math.pow(tier, 1.2)); }
function baseRewardGold(tier: number): number { return Math.round(8 * Math.pow(tier, 1.2)); }
const BOSS_REWARD_MULTIPLIER = 2;
const ELITE_REWARD_MULTIPLIER = 1.5;
// Party bonus: each member earns more XP (not gold) when fighting as a group.
// n=1 → 1.0×, n=2 → 1.1×, n=3 → 1.2×, n≥4 → 1.25×
function partyXpBonus(partySize: number): number {
  if (partySize <= 1) return 1.0;
  if (partySize === 2) return 1.1;
  if (partySize === 3) return 1.2;
  return 1.25;
}
const SHOP_RESTOCK_MS = 6 * 60 * 60 * 1000;
const SHOP_BUY_CAP_PER_CYCLE = 2;
const SHOP_STOCK_BASE = 6;
const SHOP_STOCK_PER_EXTRA_PLAYER = 1;
const SHOP_STOCK_CAP = 12;
const SHOP_STOCK_PLAYER_BASELINE = 4;
// Town refresh cadences — kept in sync with Slack's rebuildTownState:
//   weekly: town name + location art
//   daily: job board + pub regulars (handled by Slack; web checks staleness)
const TOWN_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const TOWN_DAILY_MS = 24 * 60 * 60 * 1000;

// Looks up the channel_id of the player's most recent quest. Falls back to
// the most recently active channel in the whole DB — covers new players who
// haven't started a Slack quest yet but the team is already playing in a known
// channel.
async function recentChannelForUser(db: D1Database, userId: string, env?: { ENVIRONMENT?: string }): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT q.channel_id FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ?
         AND q.channel_id NOT LIKE 'web:%'
       ORDER BY q.id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ channel_id: string }>();
  if (row) return row.channel_id;
  // Fallback 1: most recently used real channel in the quest table
  const questFallback = await db
    .prepare(`SELECT channel_id FROM quests WHERE channel_id NOT LIKE 'web:%' ORDER BY id DESC LIMIT 1`)
    .first<{ channel_id: string }>();
  if (questFallback) return questFallback.channel_id;
  // Fallback 2: any channel that has town state — survives a full quest wipe
  const townFallback = await db
    .prepare(`SELECT channel_id FROM town_state ORDER BY refreshed_at DESC LIMIT 1`)
    .first<{ channel_id: string }>();
  if (townFallback) return townFallback.channel_id;
  // Fallback 3: local dev — no Slack channel needed
  if (env?.ENVIRONMENT === "local") return "local-dev";
  return null;
}

// Slack uses Workers AI to flavor non-catalog drops; web v1 names them
// deterministically off (rarity, type) so we don't depend on the AI binding.
// Tool / scroll drops still use the fixed catalog names + blurbs from core.
const RARITY_ADJ: Record<string, string> = {
  common: "Worn",
  uncommon: "Sturdy",
  rare: "Resplendent",
  epic: "Illustrious",
  legendary: "Mythic",
};
const TYPE_NOUN: Record<string, string> = {
  weapon: "Blade",
  armor: "Vest",
  consumable: "Elixir",
  magic: "Trinket",
  revive: "Vial",
  tool: "Tool",
  scroll: "Scroll",
};

interface ToolDispatchResult {
  effect: ItemEffect;
  fighters?: CombatState["fighters"];
  monster?: Partial<CombatState["monster"]>;
  targetMonId?: string;
  error?: string;
}

// Catalog dispatch for tool/scroll items. Mirrors the named effects in
// apps/slack/src/commands.ts useToolOrScroll. v1 web supports the five
// items that have purely-combat effects:
//   Caffeine Bomb / Hotfix Grenade — direct monster damage (capped at
//     monster.hp − 1 to never kill; v1 web matches Slack's safety rail)
//   Espresso Shot — self-applies regen for 5 actions
//   Poison Vial — applies poisoned to the monster for 4 ticks
//   Rebase Scroll — refills mana to max for every alive party member
//
// Production Outage (instakill / boss 30%) and Crowbar of Last Resort
// intentionally return an error here; both need support that doesn't make
// sense until monster-kill integration lands.
function applyToolOrScroll(
  state: CombatState,
  actor: CombatState["fighters"][number],
  item: { id: number; item_name: string; item_type: string; power: number },
  targetMonsterId?: string | null,
): ToolDispatchResult {
  const entry = findCatalogEntry(item.item_name);
  if (!entry) {
    return {
      effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
      error: `${item.item_name} has no wired-up effect`,
    };
  }

  // Resolve the targeted monster: prefer explicit target (if alive), fall back
  // to first live monster, finally fall back to monsters[0] as last resort.
  const resolveTarget = () =>
    (targetMonsterId && state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0)) ||
    state.monsters.find((m) => m.hp > 0) ||
    state.monsters[0];

  switch (entry.name) {
    case "Caffeine Bomb":
    case "Hotfix Grenade": {
      // Damage tools ignore armor and never kill (Slack convention v1).
      const requested = item.power;
      const m = resolveTarget();
      const damage = Math.max(1, Math.min(requested, m.hp - 1));
      return {
        effect: {
          kind: "monster_damage",
          amount: damage,
          ...(damage < requested ? { capped_from: requested } : {}),
        },
        monster: { hp: m.hp - damage },
        targetMonId: m.id,
      };
    }
    case "Espresso Shot": {
      // Self-applied regen. Goes through mergeEffect so a second sip
      // refreshes duration + takes the better magnitude (per the regen
      // "refresh" policy) instead of stacking two parallel timers.
      const eff = {
        type: "regen" as const,
        magnitude: item.power,
        remaining: 5,
        source: entry.name,
      };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: mergeEffect(f.effects, eff) } : f,
      );
      return {
        effect: {
          kind: "self_effect",
          target: actor.id,
          effect: "regen",
          magnitude: item.power,
          remaining: 5,
        },
        fighters,
      };
    }
    case "Poison Vial": {
      const m = resolveTarget();
      if (m.hp <= 0) {
        return {
          effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
          error: "no live foe to poison",
        };
      }
      const eff = {
        type: "poisoned" as const,
        magnitude: item.power,
        remaining: 4,
        source: actor.id,
      };
      return {
        effect: {
          kind: "monster_effect",
          effect: "poisoned",
          magnitude: item.power,
          remaining: 4,
        },
        monster: { effects: mergeEffect(m.effects, eff) },
        targetMonId: m.id,
      };
    }
    case "Rebase Scroll": {
      // Party mana refill — every alive fighter goes back to max_mana.
      // Slack's wider behavior (wipe cooldowns) is moot here since web
      // combat is strictly turn-based.
      const recipients: { user_id: string; restored: number }[] = [];
      const fighters = state.fighters.map((f) => {
        if (f.hp <= 0) return f;
        const restored = f.max_mana - f.mana;
        if (restored > 0) recipients.push({ user_id: f.id, restored });
        return { ...f, mana: f.max_mana };
      });
      return {
        effect: { kind: "party_mana_refill", recipients },
        fighters,
      };
    }
    case "Production Outage": {
      // Non-boss: instant kill. Boss: drops 30% of max_hp (capped at hp-1 so
      // it never delivers the killing blow on a boss). Mirrors slack semantics.
      const m = resolveTarget();
      if (m.hp <= 0) {
        return {
          effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
          error: "no live foe to outage",
        };
      }
      if (m.is_boss) {
        const requested = Math.floor(m.max_hp * 0.3);
        const damage = Math.max(1, Math.min(requested, m.hp - 1));
        return {
          effect: {
            kind: "monster_damage",
            amount: damage,
            ...(damage < requested ? { capped_from: requested } : {}),
          },
          monster: { hp: m.hp - damage },
          targetMonId: m.id,
        };
      }
      // Non-boss instakill — drops monster_hp to 0. handleUseItem detects this
      // and routes through resolveMonsterKill for victory / wave-transition.
      return {
        effect: { kind: "monster_damage", amount: m.hp },
        monster: { hp: 0 },
        targetMonId: m.id,
      };
    }
    case "Venom Vial": {
      const m = resolveTarget();
      if (m.hp <= 0) {
        return { effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 }, error: "no live foe to poison" };
      }
      const eff = { type: "poisoned" as const, magnitude: item.power, remaining: 4, source: actor.id };
      return {
        effect: { kind: "monster_effect", effect: "poisoned", magnitude: item.power, remaining: 4 },
        monster: { effects: mergeEffect(m.effects, eff) },
        targetMonId: m.id,
      };
    }
    case "Regen Draft": {
      const eff = { type: "regen" as const, magnitude: item.power, remaining: 3, source: entry.name };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: mergeEffect(f.effects, eff) } : f,
      );
      return {
        effect: { kind: "self_effect", target: actor.id, effect: "regen", magnitude: item.power, remaining: 3 },
        fighters,
      };
    }
    case "Battle Elixir": {
      const eff = { type: "empowered" as const, magnitude: 25, remaining: 3, source: entry.name };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: mergeEffect(f.effects, eff) } : f,
      );
      return {
        effect: { kind: "self_effect", target: actor.id, effect: "empowered", magnitude: 25, remaining: 3 },
        fighters,
      };
    }
    default:
      return {
        effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
        error: `${entry.name} isn't supported in web combat yet`,
      };
  }
}

// Picks the right flavor path for a rolled drop: catalog items keep their
// fixed name + emoji and get AI flavor only; everything else gets a full
// AI name + flavor (with deterministic fallbacks on either failure).
async function nameLootViaAi(
  env: Env,
  roll: ItemRoll,
  monsterName: string,
): Promise<{ name: string; flavor: string }> {
  if (roll.catalog_name) {
    const entry = findCatalogEntry(roll.catalog_name);
    if (entry) {
      const flavor = await flavorCatalogItem(env.AI, entry.name, entry.blurb, `the corpse of ${monsterName}`);
      return { name: `${entry.emoji} ${entry.name}`, flavor };
    }
  }
  // Non-catalog drops — full AI naming. flavorLootDrop returns a fallback
  // if the model misbehaves, so this never throws.
  if (
    roll.type === "weapon" ||
    roll.type === "armor" ||
    roll.type === "consumable" ||
    roll.type === "magic" ||
    roll.type === "revive"
  ) {
    return flavorLootDrop(
      env.AI, monsterName, roll.type, roll.rarity, roll.power, roll.weapon_range, roll.slot ?? undefined, (roll.element ?? undefined) as ElementType | undefined,
    );
  }
  // Unknown / future type — fall back to the deterministic name.
  const adj = RARITY_ADJ[roll.rarity] ?? roll.rarity;
  const noun = TYPE_NOUN[roll.type] ?? roll.type;
  return { name: `${adj} ${noun}`, flavor: `Spoils from ${monsterName}.` };
}

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  QUEST_ROOM: DurableObjectNamespace<QuestRoom>;
  // LobbyRoom: WS-attached DO holding live lobby state + ephemeral chat.
  // One instance per quest (`idFromName('lobby:' + questId)`). Optional so
  // local dev without the binding still boots (web falls back to polling).
  LOBBY_ROOM?: DurableObjectNamespace<LobbyRoom>;
  AI: Ai;
  // R2 bucket for AI-generated art (monster portraits + static view banners).
  // Shared with the slack worker; both apps point at the same gantt-quest-assets
  // bucket so a portrait generated by one app is cached for the other.
  ART: R2Bucket;
  // Retained binding (no longer used for cross-surface posts from the web
  // worker — those were removed). Kept optional so wrangler config doesn't
  // need to change and the slack worker, which actually uses this token,
  // continues to read it from its own binding.
  SLACK_BOT_TOKEN?: string;
  // Set to "local" via .dev.vars to enable dev-only endpoints (e.g. /api/dev/login).
  ENVIRONMENT?: string;
}

// Web worker's own public domain. Used as the baseUrl for art assets so the
// browser fetches them from the same origin (no extra CORS, same cookie scope).
const WEB_PUBLIC_BASE = "https://quest.heylets.party";

function artTarget(env: Env): import("./ai").ArtTarget {
  return { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE, disabled: env.ENVIRONMENT === "local" };
  return { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE, disabled: env.ENVIRONMENT === "local" };
}

// True when the player's *own* worker (slot 1) is mid-gather. Hired worker
// slots (slot ≥ 2) don't block the player from questing — the whole point
// of buying them is to keep gathering going while the main character is
// out in combat. Used as a guard on every quest/hunt entry point.
async function isMainCharacterGathering(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const tasks = await listActiveGatheringTasks(db, userId);
  return tasks.some((t) => t.worker_slot === 1);
}

const SESSION_COOKIE = "sq_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

// POST /api/auth/verify { code: "123456" } → sets session cookie on success.
app.post("/api/auth/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return c.json({ error: "invalid_code" }, 400);
  }

  const redeemed = await consumeWebLoginCode(c.env.DB, code);
  if (!redeemed) {
    return c.json({ error: "invalid_or_expired" }, 401);
  }

  const session = await createWebSession(
    c.env.DB,
    redeemed.slack_user_id,
    redeemed.slack_team_id,
  );

  setCookie(c, SESSION_COOKIE, session.session_id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteWebSession(c.env.DB, sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// POST /api/character/reroll — delete and recreate the player's character.
// Always free — forfeit of all gear/gold/level is the cost. Blocked mid-quest.
app.post("/api/character/reroll", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const existing = await getCharacter(c.env.DB, session.slack_user_id);
  if (!existing) return c.json({ error: "no_character" }, 404);

  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  // Preserve which slot this character occupies so the new character lands in
  // the same slot. createCharacter always inserts with DEFAULT 1, and without
  // this the rerolled character would silently claim slot 1, clobbering the
  // real slot-1 snapshot on the next activate.
  const priorSlot = existing.active_slot ?? 1;

  await deleteCharacter(c.env.DB, session.slack_user_id);

  const body = await c.req.json<{ class?: string }>().catch((): { class?: string } => ({}));
  const cls = body.class ? classByName(body.class) : pickRandomClass();
  const hp = cls.base_hp + rollDice(4);
  const gender: CharGender = rollDice(2) === 1 ? "m" : "f";

  // AI-generated name with an avoid-list of recent names; falls back to pool.
  const recentNames = await getRecentCharacterNames(c.env.DB, 20);
  const heroName = await generateCharacterName(c.env.AI, gender, cls.name, recentNames);

  const newChar = await createCharacter(c.env.DB, {
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    name: heroName,
    class: cls.name,
    hp,
    max_hp: hp,
    gender,
  });
  // Restore slot identity — createCharacter defaults to 1.
  if (priorSlot !== 1) await setActiveSlot(c.env.DB, session.slack_user_id, priorSlot);

  // Block on art generation so the response includes the URL and the UI can
  // display the portrait immediately without a second round-trip.
  const art_url = await generateCharacterArtNow(
    c.env.AI,
    artTarget(c.env),
    { name: newChar.name, class: newChar.class, gender: newChar.gender },
    cls.id,
  ).catch((err) => {
    console.warn("reroll:char-art-gen-error", { err: err instanceof Error ? err.message : String(err) });
    return null;
  });

  return c.json({ ok: true, character: newChar, art_url });
});

// === Character slots (web-only multi-character) ===========================
// Web players can keep up to 3 character builds. The active one lives in the
// `characters` table; the other two are JSON snapshots in `character_slots`.
// Switching slots = snapshot current, restore target. Switching/creating is
// blocked while the active character is in a quest so combat state doesn't
// reference a character that's about to vanish.

app.get("/api/character-slots", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const view = await listCharacterSlots(c.env.DB, session.slack_user_id);
  return c.json(view);
});

app.post("/api/character-slots/:slot/activate", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const slot = parseInt(c.req.param("slot"), 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > 3) {
    return c.json({ error: "bad_slot" }, 400);
  }
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  try {
    await activateCharacterSlot(c.env.DB, session.slack_user_id, slot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg === "no_active_character" || msg === "slot_empty") {
      return c.json({ error: msg }, 400);
    }
    throw err;
  }
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  return c.json({ ok: true, character });
});

// Create a fresh character into an empty slot. The current active is
// snapshotted into its own slot, then the new character takes the requested
// slot. Body: { slot: 1-3, class?: string }.
app.post("/api/character-slots/new", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ slot?: number; class?: string }>().catch(
    (): { slot?: number; class?: string } => ({}),
  );
  const slot = body.slot;
  if (!Number.isFinite(slot) || (slot as number) < 1 || (slot as number) > 3) {
    return c.json({ error: "bad_slot" }, 400);
  }
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  try {
    await reserveSlotForNewCharacter(c.env.DB, session.slack_user_id, slot as number);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg === "no_active_character" || msg === "slot_occupied" || msg === "bad_slot") {
      return c.json({ error: msg }, 400);
    }
    throw err;
  }

  const cls = body.class ? classByName(body.class) : pickRandomClass();
  const hp = cls.base_hp + rollDice(4);
  const gender: CharGender = rollDice(2) === 1 ? "m" : "f";

  // AI-generated name with an avoid-list of recent names; falls back to pool.
  const recentNamesForSlot = await getRecentCharacterNames(c.env.DB, 20);
  const slotHeroName = await generateCharacterName(c.env.AI, gender, cls.name, recentNamesForSlot);

  const newChar = await createCharacter(c.env.DB, {
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    name: slotHeroName,
    class: cls.name,
    hp,
    max_hp: hp,
    gender,
  });
  await setActiveSlot(c.env.DB, session.slack_user_id, slot as number);

  const art_url = await generateCharacterArtNow(
    c.env.AI,
    artTarget(c.env),
    { name: newChar.name, class: newChar.class, gender: newChar.gender },
    cls.id,
  ).catch((err) => {
    console.warn("slot-new:char-art-gen-error", { err: err instanceof Error ? err.message : String(err) });
    return null;
  });

  return c.json({ ok: true, character: { ...newChar, active_slot: slot }, art_url });
});

app.delete("/api/character-slots/:slot", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const slot = parseInt(c.req.param("slot"), 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > 3) {
    return c.json({ error: "bad_slot" }, 400);
  }
  // Active slot is owned by `characters`; reroll is the way to discard it.
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (character && character.active_slot === slot) {
    return c.json({ error: "cannot_delete_active" }, 400);
  }
  await deleteCharacterSlot(c.env.DB, session.slack_user_id, slot);
  return c.json({ ok: true });
});

// POST /api/character/spend — spends 1 unspent_point on the chosen primary stat.
// Body: { stat: "str" | "int_stat" | "vit" | "agi" | "dex" }
app.post("/api/character/spend", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);

  const VALID_STATS = new Set<StatKey>(["str", "int_stat", "vit", "agi", "dex"]);
  const body = await c.req.json<{ stat?: string }>().catch((): { stat?: string } => ({}));
  const stat = body.stat as StatKey | undefined;
  if (!stat || !VALID_STATS.has(stat)) {
    return c.json({ error: "invalid_stat", valid: Array.from(VALID_STATS) }, 400);
  }

  const updated = await spendStatPoint(c.env.DB, session.slack_user_id, stat);
  if (!updated) {
    return c.json({ error: "no_unspent_points" }, 400);
  }
  return c.json({ ok: true, character: updated });
});

app.post("/api/settings/notify", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ pref?: string }>().catch((): { pref?: string } => ({}));
  if (body.pref !== "thread" && body.pref !== "dm") {
    return c.json({ error: "invalid_pref", valid: ["thread", "dm"] }, 400);
  }
  await setNotificationPref(c.env.DB, session.slack_user_id, body.pref);
  return c.json({ ok: true });
});

// Lets a player set their own display username (the @handle shown next to
// their character name in party lists, leaderboards, and combat chips).
// Use case: the player's Slack handle never resolved (slack_username is
// null), so other players don't know who they're playing with. We reuse
// the slack_username column rather than introducing a parallel field —
// downstream display code already falls back to it, and the column has
// no meaning beyond "the @handle to show".
app.post("/api/settings/username", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ username?: string }>().catch((): { username?: string } => ({}));
  const raw = typeof body.username === "string" ? body.username.trim() : "";
  // Strip a leading @ so the player can paste either form. Allow letters,
  // digits, dot, dash, underscore — typical Slack handle alphabet.
  const cleaned = raw.replace(/^@+/, "").slice(0, 32);
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(cleaned)) {
    return c.json({ error: "invalid_username", note: "2–32 chars: letters, digits, . _ -" }, 400);
  }
  await c.env.DB
    .prepare("UPDATE characters SET slack_username = ? WHERE slack_user_id = ?")
    .bind(cleaned, session.slack_user_id)
    .run();
  return c.json({ ok: true, username: cleaned });
});

// Returns the authenticated user's character (or null if they haven't created
// one yet via /sq quest in Slack).
// Serve flux-generated art from the shared R2 bucket. Public, no auth — same
// pattern as the slack worker's /img endpoint. Browser caches for a day so
// the icon font + banner traffic never hits the worker after first load.
app.get("/img/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.ART.get(key);
  if (!obj) return c.text("not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=86400, immutable");
  return new Response(obj.body, { headers });
});

// Lazy view-art lookup. Returns the art URL when cached, fires background
// generation on miss and returns null this one call. The frontend swaps the
// banner src once a refresh shows the URL.
app.get("/api/art/view/:shortKey", async (c) => {
  const shortKey = c.req.param("shortKey");
  if (!(shortKey in VIEW_ART_PROMPTS)) {
    return c.json({ error: "unknown_view" }, 404);
  }
  const url = await getOrScheduleViewArt(
    c.env.AI,
    artTarget(c.env),
    c.executionCtx,
    shortKey as keyof typeof VIEW_ART_PROMPTS,
  );
  return c.json({ url });
});

app.get("/api/me", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  let class_art_url: string | null = null;
  let char_art_url: string | null = null;
  if (character) {
    const id = classByName(character.class).id;
    const shortKey = `class_${id}` as keyof typeof VIEW_ART_PROMPTS;
    if (shortKey in VIEW_ART_PROMPTS) {
      class_art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, shortKey);
    }
    // Per-character portrait keyed by name slug. Cache hit → return URL; miss →
    // schedule background gen and fall through to class_art_url fallback.
    const art = artTarget(c.env);
    if (art) {
      char_art_url = await getOrScheduleCharacterArt(
        c.env.AI, art, c.executionCtx,
        { name: character.name, class: character.class, gender: character.gender },
        id,
      );
    }
  }
  return c.json({
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    character,
    class_art_url,
    char_art_url,
  });
});

// GET /api/achievements — current user's earned achievements + all definitions.
// Clears pending_achievements so toasts only fire once.
app.get("/api/achievements", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const char = await getCharacter(c.env.DB, session.slack_user_id);
  if (!char) return c.json({ error: "character not found" }, 404);
  const pending = await consumePendingAchievements(c.env.DB, session.slack_user_id);
  return c.json({ definitions: ACHIEVEMENTS, earned: char.achievements, new_achievements: pending });
});

// GET /api/achievements/:userId — public view of another player's achievements.
// Only returns earned; does not expose locked silhouettes or pending.
app.get("/api/achievements/:userId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const char = await getCharacter(c.env.DB, c.req.param("userId"));
  if (!char) return c.json({ error: "character not found" }, 404);
  return c.json({ definitions: ACHIEVEMENTS, earned: char.achievements });
});

app.get("/api/inventory", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const items = await getInventory(c.env.DB, session.slack_user_id);
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "inventory");
  return c.json({ items, art_url });
});

// Read-only equipped items for any party member — used by the inspect dialog.
app.get("/api/character/:userId/equipped", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const userId = c.req.param("userId");
  const all = await getInventory(c.env.DB, userId);
  return c.json({ items: all.filter((i) => i.equipped) });
});

// Equip an inventory item. Mirrors /sq equip: consumables can't equip,
// already-equipped is a no-op, otherwise equip + unequip any other item
// of the same type.
app.post("/api/inventory/:itemId/equip", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.item_type === "consumable") return c.json({ error: "consumable_not_equippable" }, 400);
  if (item.equipped) return c.json({ error: "already_equipped" }, 400);
  const charForEquip = await getCharacter(c.env.DB, session.slack_user_id);
  if (charForEquip && charForEquip.level < item.level_req) {
    return c.json({ error: "level_requirement", required: item.level_req }, 400);
  }
  // Focus weapon swap bookkeeping. Swapping to/from a focus weapon shifts
  // max_mana by focusManaBonus(power) in either direction. Armor swaps don't
  // touch mana — only the weapon slot carries this dynamic.
  let manaDelta = 0;
  if (item.item_type === "weapon") {
    const prev = await getEquipped(c.env.DB, session.slack_user_id, "weapon");
    const prevBonus = prev?.weapon_range === "focus" ? focusManaBonus(prev.power) : 0;
    const newBonus = item.weapon_range === "focus" ? focusManaBonus(item.power) : 0;
    manaDelta = newBonus - prevBonus;
    if (manaDelta !== 0) {
      await applyFocusManaShift(c.env.DB, session.slack_user_id, manaDelta);
    }
  }
  await equipItem(c.env.DB, item);

  // If there's a pending or active web combat state for this character's quest,
  // patch the fighter's armor_power so the equip is reflected without a restart.
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) {
    const combatState = await getWebCombatState(c.env.DB, activeQuest.id);
    const terminalStates = new Set(["victory", "defeat", "fled"]);
    if (combatState && !terminalStates.has(combatState.status as string)) {
      const allSlots = await getAllEquippedSlots(c.env.DB, session.slack_user_id);
      const newArmorPower = computeArmorPowerFromSlots(allSlots);
      const patched = {
        ...combatState,
        fighters: (combatState.fighters as unknown as Array<Record<string, unknown>>).map((f) =>
          f.id === session.slack_user_id ? { ...f, armor_power: newArmorPower } : f,
        ),
      };
      await saveWebCombatState(c.env.DB, activeQuest.id, patched as unknown as CombatState);
    }
  }

  return c.json({ ok: true, mana_delta: manaDelta });
});

app.post("/api/inventory/:itemId/unequip", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (!item.equipped) return c.json({ error: "not_equipped" }, 400);
  if (item.item_type === "weapon" && item.weapon_range === "focus") {
    await applyFocusManaShift(c.env.DB, session.slack_user_id, -focusManaBonus(item.power));
  }
  await c.env.DB.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").bind(itemId).run();
  return c.json({ ok: true });
});

const JOIN_HP_RATIO = 0.4;

function addPackMonstersForParty(scene: SceneJson, partySize: number): SceneJson {
  if (scene.monsters && scene.monsters.length > 1) return scene;
  if (scene.variant === "boss") return scene;
  const count = Math.min(3, Math.max(1, partySize));
  if (count <= 1) return scene;
  const minionHp = Math.max(8, Math.round(scene.monster_max_hp * 0.65));
  const minions = Array.from({ length: count - 1 }, () => ({
    name: scene.monster_name,
    hp: minionHp,
    max_hp: minionHp,
    tier: Math.max(1, scene.tier - 1),
    art_url: scene.monster_art_url ?? null,
    is_boss: false,
  }));
  return {
    ...scene,
    monsters: [
      { name: scene.monster_name, hp: scene.monster_max_hp, max_hp: scene.monster_max_hp, tier: scene.tier, art_url: scene.monster_art_url ?? null, is_boss: false },
      ...minions,
    ] as MonsterSpec[],
  };
}
function preScaleForJoiners(scene: SceneJson, joinerCount: number, ratio: number): SceneJson {
  let s = scene;
  for (let i = 0; i < joinerCount; i++) {
    const bump = Math.max(1, Math.floor(s.monster_max_hp * ratio));
    s = { ...s, monster_hp: s.monster_hp + bump, monster_max_hp: s.monster_max_hp + bump };
  }
  return s;
}

const BOSS_LEVEL_REQUIRED = 3;
const GAUNTLET_LEVEL_REQUIRED = 5;
const GAUNTLET_WAVES = 3;

// Tower constants.
const TOWER_LEVEL_REQUIRED = 3;
const TOWER_FLOORS_PER_CYCLE = 10;
// Rest stop on the middle floor of every cycle (5, 15, 25, …).
const TOWER_REST_FLOOR_OFFSET = 5;

// Tower scaling is floor-driven, not level-driven — every climber faces the
// same difficulty curve regardless of where they started. Pure linear: floor
// 1 = tier 1, floor 10 boss = tier 10, floor 20 boss = tier 20, …
function towerFloorTier(_characterLevel: number, absoluteFloor: number): number {
  return Math.max(1, absoluteFloor);
}

function towerFloorKind(absoluteFloor: number): "combat" | "rest" | "boss" {
  const mod = ((absoluteFloor - 1) % TOWER_FLOORS_PER_CYCLE) + 1;
  if (mod === TOWER_REST_FLOOR_OFFSET) return "rest";
  if (mod === TOWER_FLOORS_PER_CYCLE) return "boss";
  return "combat";
}

// Pre-roll one full cycle (10 floors) starting at `startFloor`. Monster
// generation runs in parallel; rest-floor stock + boss treasure are rolled
// synchronously and flavored in a parallel post-pass. Returns the floor 1
// plan plus the remaining 9 floors as a TowerFloorPlan[] queue.
async function buildTowerSegment(
  env: Env,
  character: Pick<Character, "name" | "class" | "level">,
  startFloor: number,
  avoidNames: string[] = [],
): Promise<{ floors: TowerFloorPlan[] }> {
  const art = artTarget(env);

  // Build per-floor character stubs so generateOpeningScene's
  // baseTier = level + (elite ? 1 : 0) yields the desired floor tier.
  // For boss floors, generateOpeningScene adds +1 to tier internally, so we
  // pre-decrement the synthetic level by one to land on floorTier.
  const slots: { floor: number; kind: "combat" | "rest" | "boss"; tier: number }[] = [];
  for (let i = 0; i < TOWER_FLOORS_PER_CYCLE; i++) {
    const floor = startFloor + i;
    slots.push({ floor, kind: towerFloorKind(floor), tier: towerFloorTier(character.level, floor) });
  }

  // Combat + boss floors: full opening scene with monster art.
  const monsterPromises = slots.map((s) => {
    if (s.kind === "rest") return Promise.resolve<SceneJson | null>(null);
    const syntheticLevel = s.kind === "boss" ? Math.max(1, s.tier - 1) : s.tier;
    const synthChar = { name: character.name, class: character.class, level: syntheticLevel };
    return generateOpeningScene(
      env.AI,
      synthChar,
      false,
      s.kind === "boss" ? "boss" : "gauntlet-wave",
      { wave: s.floor, total: s.floor },
      avoidNames,
      art,
    );
  });

  function mkLoot(rollTier: number): LootOption {
    const r = rollItem(rollTier);
    return {
      name: `${r.type === "weapon" ? "Weapon" : r.type === "armor" ? "Armor" : "Item"} (power ${r.power})`,
      item_type: r.type,
      power: r.power,
      rarity: r.rarity,
      flavor: "",
      weapon_range: r.weapon_range ?? null,
      ...(r.slot ? { slot: r.slot } : {}),
      ...(r.stat_bonus ? { stat_bonus: r.stat_bonus as Record<string, number> } : {}),
      ...(r.item_subtype ? { item_subtype: r.item_subtype } : {}),
      ...(r.element ? { element: r.element } : {}),
    };
  }
  function isPlaceholderLootName(name: string): boolean {
    return /^(Weapon|Armor|Item) \(power \d+\)$/.test(name);
  }
  async function flavorOne(loc: string, opt: LootOption): Promise<void> {
    if (!isPlaceholderLootName(opt.name)) return;
    try {
      const { name, flavor } = await flavorLootDrop(
        env.AI,
        loc,
        opt.item_type as "weapon" | "armor" | "consumable" | "magic" | "revive",
        opt.rarity,
        opt.power,
        opt.weapon_range ?? undefined,
        opt.slot ?? undefined,
        opt.element ?? undefined,
      );
      if (name) opt.name = name;
      if (flavor) opt.flavor = flavor;
    } catch {
      // placeholder name remains; displayLootName fallback covers it.
    }
  }

  const monsterScenes = await Promise.all(monsterPromises);

  const floors: TowerFloorPlan[] = slots.map((s, i) => {
    if (s.kind === "rest") {
      const stock = [mkLoot(s.tier), mkLoot(s.tier), mkLoot(s.tier)];
      return { floor: s.floor, kind: "rest", rest_stock: stock };
    }
    const scene = monsterScenes[i]!;
    const monster: MonsterSpec = {
      name: scene.monster_name,
      hp: scene.monster_max_hp,
      max_hp: scene.monster_max_hp,
      tier: s.tier,
      is_boss: s.kind === "boss",
      art_url: scene.monster_art_url ?? null,
      flavor: scene.scene,
    };
    if (s.kind === "boss") {
      const treasure = [mkLoot(s.tier), mkLoot(s.tier), mkLoot(s.tier)];
      return { floor: s.floor, kind: "boss", monster, boss_treasure: treasure };
    }
    return { floor: s.floor, kind: "combat", monster };
  });

  // Parallel loot-flavor pass.
  const flavorTasks: Promise<void>[] = [];
  for (const f of floors) {
    if (f.kind === "rest" && f.rest_stock) {
      for (const it of f.rest_stock) flavorTasks.push(flavorOne("the rest-stop trader's pack", it));
    } else if (f.kind === "boss" && f.boss_treasure) {
      for (const it of f.boss_treasure) flavorTasks.push(flavorOne("the boss's hoard", it));
    }
  }
  await Promise.all(flavorTasks);

  return { floors };
}

// Convert the first floor of a tower segment into a fresh SceneJson. Combat
// and boss floors put a monster in the scene; rest floors leave monster_hp at
// 0 and surface rest_stock for the merchant card.
function towerSceneFromPlan(plan: TowerFloorPlan, queue: TowerFloorPlan[], cycle: number, killsRun: number): SceneJson {
  const baseTier = plan.kind === "rest"
    ? Math.max(1, (queue[0]?.monster?.tier ?? 1))
    : plan.monster!.tier;
  if (plan.kind === "rest") {
    return {
      monster_name: "—",
      monster_hp: 0,
      monster_max_hp: 0,
      tier: baseTier,
      scene: "A quiet landing — a hooded trader has set up shop. Take a breath, restock if you like, then press on.",
      variant: "tower",
      tower_floor: plan.floor,
      tower_cycle: cycle,
      tower_floor_kind: "rest",
      tower_queue: queue,
      tower_rest_stock: plan.rest_stock,
      tower_rest_claims: {},
      tower_kills_run: killsRun,
    };
  }
  const m = plan.monster!;
  return {
    monster_name: m.name,
    monster_hp: m.max_hp,
    monster_max_hp: m.max_hp,
    tier: m.tier,
    scene: m.flavor ?? "",
    variant: "tower",
    monster_art_url: m.art_url ?? undefined,
    tower_floor: plan.floor,
    tower_cycle: cycle,
    tower_floor_kind: plan.kind,
    tower_queue: queue,
    tower_kills_run: killsRun,
  };
}

// Start a fresh quest. Supports standard / boss / gauntlet / tower variants.
app.post("/api/quest/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "already_on_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering", note: "Your main character is mid-task at camp. Cancel it, or send a hired worker instead." }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { variant?: unknown; elite?: unknown; monster_count?: unknown }
    | null;
  const variant = body?.variant;
  const elite = body?.elite === true;
  const jobMonsterCount = typeof body?.monster_count === "number" ? Math.max(1, Math.min(3, body.monster_count as number)) : 1;
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "bounty_pack" && variant !== "tower") {
    return c.json({ error: "unsupported_variant", variant }, 400);
  }
  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return c.json({ error: "boss_level_gate", required: BOSS_LEVEL_REQUIRED }, 400);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return c.json({ error: "gauntlet_level_gate", required: GAUNTLET_LEVEL_REQUIRED }, 400);
  }
  if (variant === "tower" && character.level < TOWER_LEVEL_REQUIRED) {
    return c.json({ error: "tower_level_gate", required: TOWER_LEVEL_REQUIRED }, 400);
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  const effectiveChannel = channelId ?? `web:${session.slack_user_id}`;
  const avoidNames = channelId ? await getRecentMonsterNames(c.env.DB, channelId, 6) : [];

  let scene: SceneJson;
  if (variant === "gauntlet") {
    const gen = await generateGauntletWaves(c.env.AI, character, elite, GAUNTLET_WAVES, avoidNames, artTarget(c.env));
    scene = {
      ...gen.scene,
      variant: "gauntlet",
      wave: 1,
      total_waves: GAUNTLET_WAVES,
      upcoming_waves: gen.upcoming_waves.map((w) => ({ name: w.name, max_hp: w.max_hp, scene: "" })),
    };
  } else if (variant === "tower") {
    const { floors } = await buildTowerSegment(c.env, character, 1, avoidNames);
    const [first, ...rest] = floors;
    scene = towerSceneFromPlan(first, rest, 1, 0);
  } else if (variant === "bounty_pack") {
    const art = artTarget(c.env);
    const packScenes = await Promise.all(
      Array.from({ length: jobMonsterCount }, () =>
        generateOpeningScene(c.env.AI, character, elite, "standard", undefined, avoidNames, art)
      )
    );
    const [leader, ...minions] = packScenes;
    leader.variant = "standard";
    leader.from_job_board = true;
    if (jobMonsterCount > 1) {
      leader.monsters = [
        { name: leader.monster_name, hp: leader.monster_max_hp, max_hp: leader.monster_max_hp, tier: leader.tier, art_url: leader.monster_art_url ?? null },
        ...minions.map((s) => ({
          name: s.monster_name,
          hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
          max_hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
          tier: Math.max(1, s.tier - 1),
          art_url: s.monster_art_url ?? null,
        })),
      ] as typeof leader.monsters;
    }
    scene = leader;
  } else {
    scene = await generateOpeningScene(
      c.env.AI,
      character,
      elite,
      variant === "boss" ? "boss" : "standard",
      undefined,
      avoidNames,
      artTarget(c.env),
    );
    if (variant === "boss") scene.boss_phase = 1;
    scene.variant = variant;
  }

  const questId = await createQuest(c.env.DB, {
    channel_id: effectiveChannel,
    thread_ts: `web-${Date.now()}-${session.slack_user_id}`,
    elite,
    scene,
    mode: "web",
    created_by: session.slack_user_id,
  });
  await refillMana(c.env.DB, session.slack_user_id);
  await c.env.DB
    .prepare("UPDATE characters SET drinks_since_last_quest = 0 WHERE slack_user_id = ?")
    .bind(session.slack_user_id)
    .run();

  return c.json({
    ok: true,
    quest_id: questId,
    scene: {
      monster_name: scene.monster_name,
      monster_max_hp: scene.monster_max_hp,
      tier: scene.tier,
      scene: scene.scene,
      variant: scene.variant,
    },
  });
});

// Create a quest with a lobby and optional invitees. Returns lobby:true so
// the web client can skip straight to the LobbyView rather than a combat card.
app.post("/api/quest/start_with_party", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "already_on_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering", note: "Your main character is mid-task at camp. Cancel it, or send a hired worker instead." }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { variant?: unknown; elite?: unknown; invitees?: unknown }
    | null;
  const variant = body?.variant;
  const elite = body?.elite === true;
  const invitees = Array.isArray(body?.invitees)
    ? (body!.invitees as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "tower") {
    return c.json({ error: "unsupported_variant" }, 400);
  }
  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return c.json({ error: "boss_level_gate", required: BOSS_LEVEL_REQUIRED }, 400);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return c.json({ error: "gauntlet_level_gate", required: GAUNTLET_LEVEL_REQUIRED }, 400);
  }
  if (variant === "tower" && character.level < TOWER_LEVEL_REQUIRED) {
    return c.json({ error: "tower_level_gate", required: TOWER_LEVEL_REQUIRED }, 400);
  }

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  const effectiveChannel = channelId ?? `web:${session.slack_user_id}`;
  const avoidNames = channelId ? await getRecentMonsterNames(c.env.DB, channelId, 6) : [];

  let scene: SceneJson;
  if (variant === "gauntlet") {
    const gen = await generateGauntletWaves(c.env.AI, character, elite, GAUNTLET_WAVES, avoidNames, artTarget(c.env));
    scene = {
      ...gen.scene,
      variant: "gauntlet",
      wave: 1,
      total_waves: GAUNTLET_WAVES,
      upcoming_waves: gen.upcoming_waves.map((w) => ({ name: w.name, max_hp: w.max_hp, scene: "" })),
    };
  } else if (variant === "tower") {
    const { floors } = await buildTowerSegment(c.env, character, 1, avoidNames);
    const [first, ...rest] = floors;
    scene = towerSceneFromPlan(first, rest, 1, 0);
  } else {
    scene = await generateOpeningScene(
      c.env.AI, character, elite,
      variant === "boss" ? "boss" : "standard",
      undefined, avoidNames, artTarget(c.env),
    );
    if (variant === "boss") scene.boss_phase = 1;
    scene.variant = variant;
  }

  const now = Date.now();
  const LOBBY_TTL = 5 * 60 * 1000;
  const questId = await createQuest(c.env.DB, {
    channel_id: effectiveChannel,
    thread_ts: `web-${now}-${session.slack_user_id}`,
    elite,
    scene,
    mode: "web",
    created_by: session.slack_user_id,
    lobby: invitees.length > 0,
    lobby_expires_at: invitees.length > 0 ? now + LOBBY_TTL : undefined,
  });

  if (invitees.length > 0) {
    await Promise.all(invitees.map((uid) => addPendingInvitee(c.env.DB, questId, uid)));

    return c.json({ ok: true, quest_id: questId, lobby: true });
  }

  // No invitees — behave like solo start: refill mana, activate immediately
  await refillMana(c.env.DB, session.slack_user_id);
  await c.env.DB
    .prepare("UPDATE characters SET drinks_since_last_quest = 0 WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  return c.json({ ok: true, quest_id: questId, lobby: false });
});

// Returns the joinable quest in the player's recent channel (if any).
// Used by the dashboard to render a "Join Quest" affordance when the
// player isn't already on a quest.
app.get("/api/quest/joinable", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ joinable: null });
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ joinable: null });
  const quest = await getActiveQuestInChannel(c.env.DB, channelId);
  if (!quest) return c.json({ joinable: null });
  // Mode is informational only — both surfaces drive the same step() engine
  // via QuestRoom RPC when LEGACY_SLACK_COMBAT="0" is set on the slack
  // worker. Quest-shape locks (gauntlet wave 1+) still apply because those
  // are about state, not surface ownership.
  if (quest.scene.variant === "gauntlet" && (quest.scene.wave ?? 1) > 1) {
    return c.json({ joinable: null, reason: "gauntlet_advanced" });
  }
  if (quest.scene.variant === "tower" && (quest.scene.tower_floor ?? 1) > 1) {
    return c.json({ joinable: null, reason: "tower_advanced" });
  }
  // Pull the starter's display name so toast copy can attribute the quest.
  // Fall back to slack_username, then null if neither is set.
  const starterRow = await c.env.DB
    .prepare("SELECT name, slack_username FROM characters WHERE slack_user_id = ?")
    .bind(quest.created_by)
    .first<{ name: string | null; slack_username: string | null }>();
  const starterName = starterRow?.name ?? starterRow?.slack_username ?? null;
  return c.json({
    joinable: {
      quest_id: quest.id,
      channel_id: quest.channel_id,
      variant: quest.scene.variant ?? "standard",
      elite: quest.elite,
      monster_name: quest.scene.monster_name,
      monster_max_hp: quest.scene.monster_max_hp,
      scene: quest.scene.scene,
      starter_name: starterName,
    },
  });
});

// Mirrors /sq join: joinQuest insert + refillMana + scaleMonsterForJoin.
// Uses recentChannelForUser for the channel context.
app.post("/api/quest/join", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "already_on_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering", note: "Your main character is mid-task at camp. Cancel it, or send a hired worker instead." }, 400);
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const quest = await getActiveQuestInChannel(c.env.DB, channelId);
  if (!quest) return c.json({ error: "no_quest" }, 404);
  // Mode is informational only — engine path lets either surface drive
  // combat on the same web_combat_state row. Quest-shape locks below
  // still apply.
  if (quest.scene.variant === "gauntlet" && (quest.scene.wave ?? 1) > 1) {
    return c.json({ error: "gauntlet_advanced" }, 400);
  }
  if (quest.scene.variant === "tower" && (quest.scene.tower_floor ?? 1) > 1) {
    return c.json({ error: "tower_advanced" }, 400);
  }
  const inserted = await joinQuest(c.env.DB, quest.id, session.slack_user_id);
  if (!inserted) return c.json({ error: "already_in_party" }, 400);
  await refillMana(c.env.DB, session.slack_user_id);
  await c.env.DB
    .prepare("UPDATE characters SET drinks_since_last_quest = 0 WHERE slack_user_id = ?")
    .bind(session.slack_user_id)
    .run();
  const scaled = await scaleMonsterForJoin(c.env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
  const partySize = await getQuestPartySize(c.env.DB, quest.id);
  const withPack = addPackMonstersForParty(scaled, partySize);
  if (withPack !== scaled) {
    await c.env.DB
      .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
      .bind(JSON.stringify(withPack), quest.id)
      .run();
  }

  // Patch the in-memory DO state so the new fighter appears in live combat.
  // Fire-and-forget: if the DO isn't running yet (combat not started),
  // notifyFighterJoined is a no-op and the fighter will be included when
  // bootstrapFromSlack / start_web_combat runs.
  const doId = c.env.QUEST_ROOM.idFromName(`quest:${quest.id}`);
  const doStub = c.env.QUEST_ROOM.get(doId);
  c.executionCtx.waitUntil(
    (doStub as unknown as { notifyFighterJoined(q: number, u: string, hp: number): Promise<void> })
      .notifyFighterJoined(quest.id, session.slack_user_id, scaled.monster_max_hp)
      .catch((err) => console.warn("notifyFighterJoined failed", err)),
  );

  return c.json({
    ok: true,
    quest_id: quest.id,
    monster_hp_added: scaled.monster_max_hp - quest.scene.monster_max_hp,
  });
});

// Town overview — returns AI art URLs for the map + each district. Lightweight:
// no quest/character check required, just session.
app.get("/api/town", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const art = artTarget(c.env);
  const [overview, pub, shop, inn, smithy, apothecary, outskirts, mine, forage, fish, campOverview, campBuild] = await Promise.all([
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "town_overview", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "pub_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "channel_shop", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "inn_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "smithy_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "apothecary", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "outskirts", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "camp_mine", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "camp_forage", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "camp_fish", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "camp_overview", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "camp_build", undefined, TOWN_WEEKLY_MS),
  ]);
  return c.json({ overview_art_url: overview, pub_art_url: pub, shop_art_url: shop, inn_art_url: inn, smithy_art_url: smithy, apothecary_art_url: apothecary, outskirts_art_url: outskirts, mine_art_url: mine, forage_art_url: forage, fish_art_url: fish, camp_overview_art_url: campOverview, camp_build_art_url: campBuild });
});

// Regenerates stale town jobs (daily) and/or town name (weekly) for the web
// app, mirroring Slack's rebuildTownState cadences. Designed to be called via
// ctx.waitUntil so it never blocks the API response.
async function refreshWebTownIfStale(db: D1Database, ai: Ai, channelId: string): Promise<void> {
  const row = await db
    .prepare("SELECT state_json FROM town_state WHERE channel_id = ?")
    .bind(channelId)
    .first<{ state_json: string }>();
  if (!row) return;

  const state = JSON.parse(row.state_json) as {
    channel_id: string;
    town_name: string;
    town_name_set_at?: number;
    refreshed_at: number;
    pub?: unknown;
    jobs?: Array<{
      id: string;
      variant: "standard" | "boss" | "gauntlet";
      required_level: number;
      title: string;
      blurb: string;
      reward_summary: string;
    }>;
  };

  const now = Date.now();
  const jobsStale = !state.jobs || state.jobs.length === 0 || now - state.refreshed_at > TOWN_DAILY_MS;
  const nameStale = !state.town_name || now - (state.town_name_set_at ?? 0) > TOWN_WEEKLY_MS;

  if (!jobsStale && !nameStale) return; // nothing to do

  let townName = state.town_name;
  let townNameSetAt = state.town_name_set_at ?? 0;
  if (nameStale) {
    townName = await generateTownName(ai, state.town_name ? [state.town_name] : []);
    townNameSetAt = now;
  }

  const BOSS_LEVEL_REQUIRED_LOCAL = 3;

  const [jobStd, jobBoss, jobPack] = await Promise.all([
    generateJobListing(ai, "standard", townName),
    generateJobListing(ai, "boss", townName),
    generateJobListing(ai, "bounty_pack", townName),
  ]);

  // Pack size 2 vs 3: alternate daily based on refresh timestamp parity.
  const packSize = Math.floor(now / (24 * 60 * 60 * 1000)) % 2 === 0 ? 2 : 3;

  const jobs = [
    { id: "job_1", variant: "standard" as const, required_level: 1, title: jobStd.title, blurb: jobStd.blurb, reward_summary: "1× rewards · +12% town bonus · single foe." },
    { id: "job_2", variant: "boss" as const, required_level: BOSS_LEVEL_REQUIRED_LOCAL, title: jobBoss.title, blurb: jobBoss.blurb, reward_summary: "2× rewards · +12% town bonus · two phases." },
    { id: "job_4", variant: "bounty_pack" as const, required_level: 2, monster_count: packSize, title: jobPack.title, blurb: jobPack.blurb, reward_summary: `1.6× rewards · +12% town bonus · fight ${packSize} enemies at once · first come first served.` },
  ];

  const updated = { ...state, town_name: townName, town_name_set_at: townNameSetAt, refreshed_at: now, jobs };
  await db
    .prepare("INSERT OR REPLACE INTO town_state (channel_id, state_json) VALUES (?, ?)")
    .bind(channelId, JSON.stringify(updated))
    .run();
}

// GET /api/board — daily job postings + claim status for the current player.
app.get("/api/board", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ town_name: "Heylets", jobs: [], claims: {}, character_level: character.level });

  // Refresh stale jobs/name in the background — serve current state immediately.
  c.executionCtx.waitUntil(
    refreshWebTownIfStale(c.env.DB, c.env.AI, channelId).catch((err) =>
      console.warn("board:refresh-failed", { channelId, err: err instanceof Error ? err.message : String(err) })
    )
  );

  const townRow = await c.env.DB
    .prepare("SELECT state_json FROM town_state WHERE channel_id = ?")
    .bind(channelId)
    .first<{ state_json: string }>();
  if (!townRow) return c.json({ town_name: "Heylets", jobs: [], claims: {}, character_level: character.level });

  const townState = JSON.parse(townRow.state_json) as {
    town_name: string;
    refreshed_at: number;
    jobs?: Array<{
      id: string;
      variant: "standard" | "boss" | "gauntlet" | "bounty_pack";
      required_level: number;
      monster_count?: number;
      title: string;
      blurb: string;
      reward_summary: string;
    }>;
  };

  const jobs = townState.jobs ?? [];
  const claims: Record<string, { taken_by: string }> = {};
  if (jobs.length > 0) {
    const claimRows = await c.env.DB
      .prepare("SELECT job_id, taken_by FROM job_claims WHERE channel_id = ? AND refresh_stamp = ?")
      .bind(channelId, townState.refreshed_at)
      .all<{ job_id: string; taken_by: string }>();
    for (const row of claimRows.results) {
      claims[row.job_id] = { taken_by: row.taken_by };
    }
  }

  return c.json({ town_name: townState.town_name, jobs, claims, character_level: character.level, refresh_stamp: townState.refreshed_at });
});

// POST /api/board/take — claim a job posting and start the quest.
app.post("/api/board/take", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "already_on_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering", note: "Your main character is mid-task at camp. Cancel it, or send a hired worker instead." }, 400);
  }
  const body = await c.req.json().catch(() => null) as { job_id?: string } | null;
  const jobId = body?.job_id;
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 400);

  const townRow = await c.env.DB
    .prepare("SELECT state_json FROM town_state WHERE channel_id = ?")
    .bind(channelId)
    .first<{ state_json: string }>();
  if (!townRow) return c.json({ error: "no_board" }, 404);

  const townState = JSON.parse(townRow.state_json) as {
    town_name: string;
    refreshed_at: number;
    jobs?: Array<{
      id: string;
      variant: "standard" | "boss" | "gauntlet" | "bounty_pack";
      required_level: number;
      monster_count?: number;
      title: string;
      blurb: string;
      reward_summary: string;
    }>;
  };

  const job = townState.jobs?.find((j) => j.id === jobId);
  if (!job) return c.json({ error: "job_not_found" }, 404);
  if (character.level < job.required_level) {
    return c.json({ error: "level_gate", required: job.required_level }, 400);
  }

  // Atomic claim — INSERT OR IGNORE, then check if we got it.
  const claimResult = await c.env.DB
    .prepare("INSERT OR IGNORE INTO job_claims (channel_id, refresh_stamp, job_id, taken_by, taken_at) VALUES (?, ?, ?, ?, ?)")
    .bind(channelId, townState.refreshed_at, jobId, session.slack_user_id, Date.now())
    .run();
  if (claimResult.meta.changes === 0) {
    return c.json({ error: "already_claimed" }, 409);
  }

  const avoidNames = await getRecentMonsterNames(c.env.DB, channelId, 6);
  const { variant } = job;
  let scene: SceneJson;
  if (variant === "gauntlet") {
    const gen = await generateGauntletWaves(c.env.AI, character, false, GAUNTLET_WAVES, avoidNames, artTarget(c.env));
    scene = {
      ...gen.scene,
      variant: "gauntlet",
      wave: 1,
      total_waves: GAUNTLET_WAVES,
      upcoming_waves: gen.upcoming_waves.map((w) => ({ name: w.name, max_hp: w.max_hp, scene: "" })),
    };
  } else if (variant === "bounty_pack") {
    const packSize = Math.max(1, Math.min(3, job.monster_count ?? 2));
    const art = artTarget(c.env);
    const packScenes = await Promise.all(
      Array.from({ length: packSize }, () =>
        generateOpeningScene(c.env.AI, character, false, "standard", undefined, avoidNames, art)
      )
    );
    const [leader, ...minions] = packScenes;
    leader.variant = "standard";
    leader.from_job_board = true;
    if (packSize > 1) {
      leader.monsters = [
        { name: leader.monster_name, hp: leader.monster_max_hp, max_hp: leader.monster_max_hp, tier: leader.tier, art_url: leader.monster_art_url ?? null },
        ...minions.map((s) => ({
          name: s.monster_name,
          hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
          max_hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
          tier: Math.max(1, s.tier - 1),
          art_url: s.monster_art_url ?? null,
        })),
      ] as typeof leader.monsters;
    }
    scene = leader;
  } else {
    scene = await generateOpeningScene(
      c.env.AI, character, false,
      variant === "boss" ? "boss" : "standard",
      undefined, avoidNames, artTarget(c.env),
    );
    if (variant === "boss") scene.boss_phase = 1;
    scene.variant = variant;
  }

  const questId = await createQuest(c.env.DB, {
    channel_id: channelId,
    thread_ts: `web-${Date.now()}-${session.slack_user_id}`,
    elite: false,
    scene,
    mode: "web",
    created_by: session.slack_user_id,
  });
  await refillMana(c.env.DB, session.slack_user_id);

  return c.json({ ok: true, quest_id: questId });
});

// Shop view — lists current stock for the player's last-known channel.
// Web can't generate a fresh restock (Slack uses AI for item flavor), so
// if the channel's stock is empty/expired, return a hint to run /sq shop
// in Slack to seed it.
app.get("/api/shop", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const stock = await getActiveShopStock(c.env.DB, channelId, SHOP_RESTOCK_MS);
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "channel_shop", undefined, TOWN_WEEKLY_MS);
  if (!stock || stock.length === 0) {
    return c.json({
      stock: [],
      staples: STAPLES,
      gold: character.gold,
      level: character.level,
      channel_id: channelId,
      needs_restock: true,
      art_url,
    });
  }
  const cycleGeneratedAt = stock[0].generated_at;
  const purchasesThisCycle = await countPurchasesInCycle(
    c.env.DB, channelId, session.slack_user_id, cycleGeneratedAt,
  );
  // Derive level_req from power — same rule addItem uses when a shop
  // purchase lands in the player's inventory. Surfacing it on the shop
  // listing prevents the "buy → can't equip" surprise.
  const stockWithLevelReq = stock.map((s) => ({
    ...s,
    level_req: Math.max(1, Math.ceil(s.power / 3)),
  }));
  return c.json({
    stock: stockWithLevelReq,
    staples: STAPLES,
    art_url,
    gold: character.gold,
    level: character.level,
    channel_id: channelId,
    needs_restock: false,
    purchases_this_cycle: purchasesThisCycle,
    purchase_cap: SHOP_BUY_CAP_PER_CYCLE,
  });
});

// POST /api/shop/restock — triggers a fresh stock generation. Mirrors the
// restockShop logic from the Slack worker. Idempotent: bails if stock was
// generated in the last 60s so rapid clicks don't double-generate.
app.post("/api/shop/restock", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);

  const recent = await c.env.DB
    .prepare("SELECT 1 FROM shop_stock WHERE channel_id = ? AND generated_at > ? LIMIT 1")
    .bind(channelId, Date.now() - 60_000)
    .first();
  if (recent) return c.json({ ok: true, skipped: true });

  const { min: minLevel, max: maxLevel } = await characterLevelRange(c.env.DB);
  const tierLo = Math.max(2, minLevel);
  const tierHi = Math.max(tierLo, maxLevel);
  const randomTier = () => tierLo + Math.floor(Math.random() * (tierHi - tierLo + 1));
  const playerCount = await countCharacters(c.env.DB);
  const stockSize = Math.min(
    SHOP_STOCK_CAP,
    SHOP_STOCK_BASE + Math.max(0, playerCount - SHOP_STOCK_PLAYER_BASELINE) * SHOP_STOCK_PER_EXTRA_PLAYER,
  );
  const generatedAt = Date.now();
  const ACCESSORY_GUARANTEE = 2;
  const rolls: ItemRoll[] = [
    ...Array.from({ length: ACCESSORY_GUARANTEE }, () => rollAccessorySlot(randomTier())),
    ...Array.from({ length: Math.max(0, stockSize - ACCESSORY_GUARANTEE) }, () => rollItem(randomTier(), true)),
  ];
  const items: Parameters<typeof insertShopStock>[1] = [];
  for (const roll of rolls) {
    let name: string;
    let flavor: string;
    if (roll.catalog_name) {
      const entry = findCatalogEntry(roll.catalog_name);
      if (entry) {
        flavor = await flavorCatalogItem(c.env.AI, entry.name, entry.blurb, "the shopkeep's chest");
        name = `${entry.emoji} ${entry.name}`;
      } else {
        ({ name, flavor } = await flavorLootDrop(c.env.AI, "the shopkeep's chest", roll.type as "weapon" | "armor" | "consumable" | "magic" | "revive", roll.rarity, roll.power, roll.weapon_range, roll.slot ?? undefined, (roll.element ?? undefined) as ElementType | undefined));
      }
    } else {
      ({ name, flavor } = await flavorLootDrop(c.env.AI, "the shopkeep's chest", roll.type as "weapon" | "armor" | "consumable" | "magic" | "revive", roll.rarity, roll.power, roll.weapon_range, roll.slot ?? undefined, (roll.element ?? undefined) as ElementType | undefined));
    }
    items.push({
      channel_id: channelId,
      generated_at: generatedAt,
      item_name: name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor,
      price: priceFor(roll.type, roll.rarity, roll.tier),
      weapon_range: roll.weapon_range ?? null,
      slot: roll.slot ?? null,
      stat_bonus: (roll.stat_bonus ?? null) as Record<string, number> | null,
      item_subtype: roll.item_subtype ?? null,
      element: roll.element ?? null,
    });
  }
  await insertShopStock(c.env.DB, items);
  return c.json({ ok: true });
});

// POST /api/hunt — start a free-roam standard quest at a player-chosen tier
// (1 ≤ tier ≤ character.level). No job-board claim; no town bonus; XP/gold
// scale with scene.tier via baseRewardXp/baseRewardGold so grinding lower
// tiers naturally yields proportionally less per fight.
app.post("/api/hunt", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "already_on_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering", note: "Your main character is mid-task at camp. Cancel it, or send a hired worker instead." }, 400);
  }
  const body = await c.req.json().catch(() => null) as { tier?: number; monster_count?: number; invitees?: unknown; is_private?: boolean } | null;
  const requestedTier = body?.tier;
  if (typeof requestedTier !== "number" || !Number.isInteger(requestedTier) || requestedTier < 1) {
    return c.json({ error: "invalid_tier" }, 400);
  }
  const tier = Math.min(requestedTier, character.level);
  const monsterCount = Math.max(1, Math.min(3, Number.isInteger(body?.monster_count) ? (body!.monster_count as number) : 1));
  const invitees = Array.isArray(body?.invitees)
    ? (body!.invitees as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];
  const isPrivate = body?.is_private === true;

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 400);

  const avoidNames = await getRecentMonsterNames(c.env.DB, channelId, 6);
  const scaledCharacter = { ...character, level: tier };
  const art = artTarget(c.env);

  // Generate all scenes in parallel — leader + optional minions.
  const scenes = await Promise.all(
    Array.from({ length: monsterCount }, (_, i) =>
      generateOpeningScene(c.env.AI, scaledCharacter, false, "standard", undefined, avoidNames, art)
        .then((s) => ({ ...s, _idx: i }))
    )
  );
  const [leaderScene, ...minionScenes] = scenes;
  leaderScene.variant = "standard";

  // Pack hunts embed extra monsters in scene_json so buildInitialCombatState
  // picks them up the same way multi-monster encounters do.
  if (monsterCount > 1) {
    leaderScene.monsters = [
      { name: leaderScene.monster_name, hp: leaderScene.monster_max_hp, max_hp: leaderScene.monster_max_hp, tier: leaderScene.tier, art_url: leaderScene.monster_art_url ?? null },
      ...minionScenes.map((s) => ({
        name: s.monster_name,
        hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
        max_hp: Math.max(8, Math.round(s.monster_max_hp * 0.75)),
        tier: Math.max(1, s.tier - 1),
        art_url: s.monster_art_url ?? null,
      })),
    ] as typeof leaderScene.monsters;
  }

  const now = Date.now();
  const LOBBY_TTL = 5 * 60 * 1000;
  const questId = await createQuest(c.env.DB, {
    channel_id: channelId,
    thread_ts: `web-${now}-${session.slack_user_id}`,
    elite: false,
    scene: leaderScene,
    mode: "web",
    created_by: session.slack_user_id,
    lobby: invitees.length > 0,
    lobby_expires_at: invitees.length > 0 ? now + LOBBY_TTL : undefined,
    is_private: isPrivate,
  });

  if (invitees.length > 0) {
    await Promise.all(invitees.map((uid) => addPendingInvitee(c.env.DB, questId, uid)));
    return c.json({ ok: true, quest_id: questId, lobby: true });
  }

  await refillMana(c.env.DB, session.slack_user_id);

  return c.json({ ok: true, quest_id: questId, lobby: false });
});

// Mirrors /sq buy: claim row + deduct gold atomically; release on either
// failure so the item goes back to the shop.
app.post("/api/shop/:itemId/buy", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const stock = await getShopItem(c.env.DB, itemId, channelId);
  if (!stock) return c.json({ error: "not_in_shop" }, 404);
  if (stock.bought_by) return c.json({ error: "already_bought" }, 400);
  if (character.gold < stock.price) {
    return c.json({ error: "insufficient_gold", price: stock.price, gold: character.gold }, 400);
  }
  const alreadyBought = await countPurchasesInCycle(
    c.env.DB, channelId, session.slack_user_id, stock.generated_at,
  );
  if (alreadyBought >= SHOP_BUY_CAP_PER_CYCLE) {
    return c.json({ error: "cycle_cap", cap: SHOP_BUY_CAP_PER_CYCLE }, 400);
  }
  const claimed = await claimShopItem(c.env.DB, stock.id, session.slack_user_id);
  if (!claimed) return c.json({ error: "raced" }, 409);
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, stock.price);
  if (!paid) {
    await releaseShopClaim(c.env.DB, stock.id);
    return c.json({ error: "insufficient_gold_race" }, 400);
  }
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: stock.item_name,
    item_type: stock.item_type,
    power: stock.power,
    rarity: stock.rarity,
    flavor: stock.flavor ?? "",
    weapon_range: stock.weapon_range,
    slot: stock.slot ?? undefined,
    stat_bonus: stock.stat_bonus ?? undefined,
    item_subtype: stock.item_subtype ?? undefined,
    element: stock.element ?? undefined,
  });
  await grantAchievement(c.env.DB, session.slack_user_id, "first_purchase");
  return c.json({
    ok: true,
    paid: stock.price,
    gold_remaining: character.gold - stock.price,
    item: { id: item.id, name: item.item_name, rarity: item.rarity, type: item.item_type, power: item.power },
  });
});

// Buy a staple potion — always in stock, fixed price, no buy cap, no haggle.
// Allowed mid-quest (unlike rolled stock) so the player can stock up
// before/between/inside fights uniformly.
app.post("/api/shop/staple/:stapleId/buy", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const stapleId = c.req.param("stapleId");
  const staple = findStaple(stapleId);
  if (!staple) return c.json({ error: "unknown_staple" }, 404);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.gold < staple.price) {
    return c.json({ error: "insufficient_gold", price: staple.price, gold: character.gold }, 400);
  }
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, staple.price);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: `${staple.emoji} ${staple.name}`,
    item_type: "consumable",
    power: staple.power,
    rarity: "common",
    flavor: staple.blurb,
    weapon_range: null,
  });
  return c.json({
    ok: true,
    paid: staple.price,
    gold_remaining: character.gold - staple.price,
    item: { id: item.id, name: item.item_name, type: item.item_type, power: item.power },
  });
});

// Haggle on a single shop item. d6 + class haggleMod:
//   ≤3 → failed (price unchanged, locked from further haggling)
//   4-5 → 15% off
//   6   → 25% off
//   7+  → 30% off
app.post("/api/shop/:itemId/haggle", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const stock = await getShopItem(c.env.DB, itemId, channelId);
  if (!stock) return c.json({ error: "not_in_shop" }, 404);
  if (stock.bought_by) return c.json({ error: "already_bought" }, 400);
  if (stock.haggled) return c.json({ error: "already_haggled", outcome: stock.haggled }, 400);

  const roll = rollDice(6);
  const mod = haggleMod(character.class);
  const total = roll + mod;
  let outcome: "failed" | "15" | "25" | "30";
  let bucket: "failed" | "modest" | "solid" | "steal";
  let newPrice = stock.price;
  if (total <= 3) { outcome = "failed"; bucket = "failed"; }
  else if (total <= 5) {
    outcome = "15"; bucket = "modest";
    newPrice = Math.max(1, Math.floor(stock.price * 0.85));
  } else if (total === 6) {
    outcome = "25"; bucket = "solid";
    newPrice = Math.max(1, Math.floor(stock.price * 0.75));
  } else {
    outcome = "30"; bucket = "steal";
    newPrice = Math.max(1, Math.floor(stock.price * 0.7));
  }
  const ok = await trySetHaggleOutcome(c.env.DB, stock.id, outcome, newPrice);
  if (!ok) return c.json({ error: "raced" }, 409);
  const flavor = pickHaggleLine(bucket);
  return c.json({
    outcome,
    bucket,
    flavor,
    roll,
    modifier: mod,
    total,
    old_price: stock.price,
    new_price: newPrice,
    item_name: stock.item_name,
  });
});

// Rest — short (50% missing HP + 1 mana, 10-min cooldown) or long
// (full HP + last_long_rest_at bumped, 24h cooldown). Mirrors /sq rest;
// long rest is blocked mid-quest and downed players can't rest at all.
const SHORT_REST_COOLDOWN_MS = 10 * 60 * 1000;
const LONG_REST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SHORT_REST_HEAL_RATIO = 0.5;

// Set the character's persisted battle position. Free action — no
// cost, no cooldown. Used by the lobby's position toggle so players
// can pick a row before combat starts; mid-combat positioning goes
// through the engine's `position` action instead (consumes a turn).
// Server enforces only the value enum; the character may not have an
// active quest (lobby flow runs before status=active).
app.post("/api/character/position", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ position?: unknown }>().catch(() => ({} as { position?: unknown }));
  const pos = body?.position === "back" ? "back" : body?.position === "front" ? "front" : null;
  if (!pos) return c.json({ error: "bad_position" }, 400);
  await setPosition(c.env.DB, session.slack_user_id, pos);
  // If this user is in a lobby, push a state refresh so the LobbyView
  // for every connected member sees their new position pill instantly
  // instead of waiting for the next 4s/8s poll.
  const lobby = await getLobbyQuestForCharacter(c.env.DB, session.slack_user_id);
  if (lobby) {
    c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, lobby.id));
  }
  return c.json({ ok: true, position: pos });
});

app.post("/api/character/rest", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown } | null;
  const isLong = body?.kind === "long";
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed", ready_at: character.downed_until }, 400);
  }
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest && isLong) return c.json({ error: "no_long_rest_mid_quest" }, 400);
  // v1 mid-quest short rest only allowed between fights; for simplicity web
  // refuses any mid-quest short rest with a clear hint. Slack's
  // canRestBetweenRooms gate is more permissive — bring that in if needed.
  if (activeQuest) return c.json({ error: "no_rest_mid_quest" }, 400);
  if (character.hp >= character.max_hp && character.mana >= character.max_mana) {
    return c.json({ error: "already_full" }, 400);
  }

  if (isLong) {
    const since = character.last_long_rest_at == null
      ? Infinity
      : Date.now() - character.last_long_rest_at;
    if (since < LONG_REST_COOLDOWN_MS) {
      return c.json({ error: "cooldown", ready_in_ms: LONG_REST_COOLDOWN_MS - since }, 400);
    }
    await applyLongRest(c.env.DB, session.slack_user_id);
    await initArmorPool(c.env.DB, session.slack_user_id);
    return c.json({ ok: true, kind: "long", new_hp: character.max_hp });
  }

  const since = character.last_rest_at == null
    ? Infinity
    : Date.now() - character.last_rest_at;
  if (since < SHORT_REST_COOLDOWN_MS) {
    return c.json({ error: "cooldown", ready_in_ms: SHORT_REST_COOLDOWN_MS - since }, 400);
  }
  const missing = character.max_hp - character.hp;
  const healed = Math.max(1, Math.floor(missing * SHORT_REST_HEAL_RATIO));
  const newHp = Math.min(character.max_hp, character.hp + healed);
  await applyShortRest(c.env.DB, session.slack_user_id, newHp);
  await initArmorPool(c.env.DB, session.slack_user_id);
  return c.json({ ok: true, kind: "short", healed, new_hp: newHp });
});

// =============================================================================
// INN — paid alternative to /api/character/rest. Skips the 24h long-rest
// cooldown by spending gold; never touches last_rest_at / last_long_rest_at.
// =============================================================================
interface InnRoom {
  id: string;
  name: string;
  price: number;
  refills: { hp: boolean; mana: boolean };
  blurb: string;
  iconName: string;
}
const INN_ROOMS: InnRoom[] = [
  { id: "cot",  name: "Common Cot",      price: 20, refills: { hp: true, mana: false }, blurb: "A straw cot, a wool blanket, a guarantee nobody'll loot you in your sleep. Wakes you at full HP.", iconName: "bed" },
  { id: "bath", name: "Hot Bath & Bed",  price: 50, refills: { hp: true, mana: true },  blurb: "A copper tub, lavender soap, a real mattress. Wakes you at full HP and full mana.",            iconName: "bathtub" },
];

// =============================================================================
// Apothecary
// =============================================================================

app.get("/api/apothecary", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const [downed, allItems] = await Promise.all([
    getDownedCharacters(c.env.DB),
    getInventory(c.env.DB, session.slack_user_id),
  ]);
  const reviveCount = allItems.filter((i) => i.item_type === "revive").length;

  // Level-scale staple prices and powers for this character.
  const staples = APOTHECARY_STAPLES.map((s) => ({
    ...s,
    ...apothecaryItemStats(s, character.level),
  }));

  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "apothecary", undefined, TOWN_WEEKLY_MS);

  // Self-revive offer: only present when the caller is currently downed.
  // Cost is 50% of current gold + 50% of XP-into-current-level (matches the
  // in-combat self-revive on DefeatModal). Paying clears `downed_until` so
  // the player can start new quests immediately — soft-death's scar and the
  // already-paid 25% gold/item drop stay on the character.
  const isDowned = !!character.downed_until && character.downed_until > Date.now();
  const self_revive = isDowned
    ? (() => {
        const xpInLevel = Math.max(0, character.xp - xpForLevel(character.level));
        return {
          gold_cost: Math.floor(character.gold * 0.5),
          xp_cost: Math.floor(xpInLevel * 0.5),
          available_gold: character.gold,
          available_xp_in_level: xpInLevel,
          level: character.level,
          downed_until: character.downed_until,
        };
      })()
    : null;

  return c.json({ downed, staples, gold: character.gold, revive_count: reviveCount, art_url, self_revive });
});

app.post("/api/apothecary/staple/:stapleId/buy", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const staple = findApothecaryStaple(c.req.param("stapleId"));
  if (!staple) return c.json({ error: "unknown_staple" }, 404);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const { power, price } = apothecaryItemStats(staple, character.level);
  if (character.gold < price) return c.json({ error: "insufficient_gold", price, gold: character.gold }, 400);
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, price);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: `${staple.emoji} ${staple.name}`,
    item_type: "tool",
    power,
    rarity: "common",
    flavor: staple.blurb,
    weapon_range: null,
  });
  const totalPurchases = await incrementApothecaryPurchases(c.env.DB, session.slack_user_id);
  const freshChar = await getCharacter(c.env.DB, session.slack_user_id);
  const apoAchIds = checkApothecaryAchievements({
    existingAchievements: freshChar?.achievements ?? [],
    totalPurchases,
    totalRevives: freshChar?.revives_given ?? 0,
    action: "purchase",
  });
  for (const id of apoAchIds) await grantAchievement(c.env.DB, session.slack_user_id, id);
  return c.json({ ok: true, paid: price, gold_remaining: character.gold - price, item });
});

// Self-revive at the apothecary: clears `downed_until` so the player can
// start a new quest without the 12hr soft-death cooldown. Cost is 50% of
// current gold + 50% of XP-into-current-level. Soft-death's scar and the
// 25% gold + item drop already happened on the wipe — this is a paid
// shortcut past the cooldown only.
app.post("/api/apothecary/self_revive", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  if (!character.downed_until || character.downed_until <= Date.now()) {
    return c.json({ error: "not_downed" }, 400);
  }
  const goldCost = Math.floor(character.gold * 0.5);
  const xpInLevel = Math.max(0, character.xp - xpForLevel(character.level));
  const xpCost = Math.floor(xpInLevel * 0.5);
  await c.env.DB.prepare(
    `UPDATE characters
     SET gold = gold - ?, xp = xp - ?, hp = max_hp, downed_until = NULL, last_active = ?
     WHERE slack_user_id = ?`,
  ).bind(goldCost, xpCost, Date.now(), session.slack_user_id).run();
  return c.json({ ok: true, cost: { gold: goldCost, xp: xpCost } });
});

app.post("/api/apothecary/revive/:targetUserId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const targetId = c.req.param("targetUserId");
  const [reviver, target, allItems] = await Promise.all([
    getCharacter(c.env.DB, session.slack_user_id),
    getCharacter(c.env.DB, targetId),
    getInventory(c.env.DB, session.slack_user_id),
  ]);
  if (!reviver) return c.json({ error: "no_character" }, 404);
  if (!target) return c.json({ error: "target_not_found" }, 404);
  if (!target.downed_until || target.downed_until <= Date.now()) {
    return c.json({ error: "not_downed" }, 400);
  }
  const reviveItem = allItems.find((i) => i.item_type === "revive");
  if (!reviveItem) return c.json({ error: "no_revive_item" }, 400);
  await removeItem(c.env.DB, reviveItem.id);
  const hp_restored = await reviveCharacter(c.env.DB, target, 50);
  const totalRevives = await incrementRevivesGiven(c.env.DB, session.slack_user_id);
  const freshReviver = await getCharacter(c.env.DB, session.slack_user_id);
  const reviveAchIds = checkApothecaryAchievements({
    existingAchievements: freshReviver?.achievements ?? [],
    totalPurchases: freshReviver?.apothecary_purchases ?? 0,
    totalRevives,
    action: "revive",
  });
  for (const id of reviveAchIds) await grantAchievement(c.env.DB, session.slack_user_id, id);
  return c.json({ ok: true, hp_restored, target_name: target.name });
});

app.get("/api/inn", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "inn_interior", undefined, TOWN_WEEKLY_MS);
  return c.json({
    rooms: INN_ROOMS,
    gold: character.gold,
    hp: character.hp,
    max_hp: character.max_hp,
    mana: character.mana,
    max_mana: character.max_mana,
    art_url,
  });
});

// =============================================================================
// SMITHY — sharpen / tune / reinforce equipped gear. +1 power per upgrade,
// capped at SMITHY_SHARPEN_CAP (3). Cost = (power + 1) × 20g.
const SMITHY_REPAIR_PRICE_PER_POINT = 12; // gold per missing armor point

function smithyRepairCost(missing: number): number {
  return missing * SMITHY_REPAIR_PRICE_PER_POINT;
}

function computeArmorPowerFromSlots(slots: Record<string, { power: number; item_subtype?: string | null } | null>): number {
  return (slots.body?.power ?? 0) +
    Math.floor((slots.helmet?.power ?? 0) / 2) +
    Math.floor((slots.pants?.power ?? 0) / 4) +
    (slots.off_hand?.item_subtype === "shield" ? (slots.off_hand?.power ?? 0) : 0);
}

// =============================================================================
const SMITHY_SHARPEN_CAP = 3;
const SMITHY_SHARPEN_PRICE_PER_LEVEL = 20;

function smithySharpenCost(currentPower: number): number {
  return (currentPower + 1) * SMITHY_SHARPEN_PRICE_PER_LEVEL;
}

interface SmithVerbUi {
  verb: string;
  past: string;
  noun: string;
  iconName: string;
  stat: string;
}

function smithVerbFor(item: { item_type: string; weapon_range?: string | null }): SmithVerbUi {
  if (item.item_type === "armor") {
    return { verb: "Reinforce", past: "reinforced", noun: "reinforcements", iconName: "shield", stat: "defense" };
  }
  if (item.item_type === "weapon") {
    const range = item.weapon_range ?? "melee";
    if (range === "ranged") return { verb: "Tune", past: "tuned", noun: "tunings", iconName: "crossbow", stat: "damage" };
    if (range === "focus") return { verb: "Attune", past: "attuned", noun: "attunements", iconName: "crystal-ball", stat: "heal/shield" };
    return { verb: "Sharpen", past: "sharpened", noun: "sharpens", iconName: "anvil", stat: "damage" };
  }
  return { verb: "Upgrade", past: "upgraded", noun: "upgrades", iconName: "anvil", stat: "power" };
}

const SMITHY_RESTOCK_MS = 4 * 60 * 60 * 1000; // 4 hours
const SMITHY_STOCK_SIZE = 4;

// Smithy items cost ~1.5× the equivalent shop item — the player gets to choose
// the exact piece, so we charge a convenience premium.
function smithyStockPrice(itemType: ItemType, rarity: Rarity, tier?: number): number {
  return Math.ceil(priceFor(itemType, rarity, tier) * 1.5);
}

// Channel-scoped stock: one generation per channel per RESTOCK window,
// shared across everyone in that channel. `characterId` is recorded for
// audit (who triggered the restock) and `level` seeds the tier range.
async function ensureSmithyStock(
  env: Env,
  channelId: string,
  characterId: string,
  level: number,
): Promise<void> {
  const existing = await getActiveSmithyStock(env.DB, channelId, SMITHY_RESTOCK_MS);
  if (existing && existing.length > 0) return;
  const tierLo = Math.max(1, Math.min(level, 6));
  const tierHi = Math.max(tierLo, Math.min(level + 1, 9));
  const randomTier = () => tierLo + Math.floor(Math.random() * (tierHi - tierLo + 1));
  const generatedAt = Date.now();
  const rolls = Array.from({ length: SMITHY_STOCK_SIZE }, () => rollSmithyArmor(randomTier()));
  const items = await Promise.all(rolls.map(async (roll) => {
    const { name, flavor } = await flavorLootDrop(env.AI, "the smith's rack", "armor", roll.rarity, roll.power, undefined, roll.slot ?? undefined);
    return {
      character_id: characterId,
      channel_id: channelId,
      generated_at: generatedAt,
      item_name: name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor,
      price: smithyStockPrice(roll.type, roll.rarity, roll.tier),
      slot: roll.slot ?? null,
      stat_bonus: (roll.stat_bonus ?? null) as Record<string, number> | null,
      item_subtype: roll.item_subtype ?? null,
    };
  }));
  await insertSmithyStock(env.DB, items);
}

app.get("/api/smithy", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  // Channel resolution mirrors /api/shop: last channel the user did a /sq
  // command in. Required for channel-scoped stock to make sense.
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  await ensureSmithyStock(c.env, channelId, session.slack_user_id, character.level);
  const [weapon, armor, allSlots, stock] = await Promise.all([
    getEquipped(c.env.DB, session.slack_user_id, "weapon"),
    getEquipped(c.env.DB, session.slack_user_id, "armor"),
    getAllEquippedSlots(c.env.DB, session.slack_user_id),
    getActiveSmithyStock(c.env.DB, channelId, SMITHY_RESTOCK_MS),
  ]);
  const items = [weapon, armor]
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((it) => ({
      id: it.id,
      item_name: it.item_name,
      item_type: it.item_type,
      weapon_range: it.weapon_range,
      power: it.power,
      sharpens_count: it.sharpens_count,
      cap: SMITHY_SHARPEN_CAP,
      cost: it.sharpens_count >= SMITHY_SHARPEN_CAP ? 0 : smithySharpenCost(it.power),
      verb: smithVerbFor(it),
    }));
  const armorPower = computeArmorPowerFromSlots(allSlots);
  const armorMax = Math.floor(armorPower / 2);
  const armorMissing = Math.max(0, armorMax - character.shield);
  const armorRepair = armorMax > 0
    ? { current: character.shield, max: armorMax, cost: smithyRepairCost(armorMissing) }
    : null;
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "smithy_interior", undefined, TOWN_WEEKLY_MS);
  const stockListing = (stock ?? [])
    .filter((s) => s.bought_by === null)
    .map((s) => ({
      id: s.id,
      item_name: s.item_name,
      item_type: s.item_type,
      power: s.power,
      rarity: s.rarity,
      flavor: s.flavor,
      price: s.price,
      slot: s.slot,
      stat_bonus: s.stat_bonus,
      item_subtype: s.item_subtype,
      level_req: Math.max(1, Math.ceil(s.power / 3)),
    }));
  const stockGeneratedAt = stock && stock.length > 0 ? stock[0].generated_at : null;
  const stockExpiresAt = stockGeneratedAt ? stockGeneratedAt + SMITHY_RESTOCK_MS : null;
  return c.json({ items, gold: character.gold, armorRepair, stock: stockListing, stockExpiresAt, art_url });
});

app.post("/api/smithy/buy/:stockId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const stockId = parseInt(c.req.param("stockId"), 10);
  if (!Number.isFinite(stockId)) return c.json({ error: "bad_stock_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  // Buyer must be in the same channel that the stock was generated for —
  // prevents cross-channel sniping after the migration.
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const stockItem = await getSmithyStockItem(c.env.DB, stockId, channelId);
  if (!stockItem) return c.json({ error: "not_found" }, 404);
  if (stockItem.bought_by) return c.json({ error: "already_sold" }, 400);
  if (Date.now() - stockItem.generated_at > SMITHY_RESTOCK_MS) return c.json({ error: "expired" }, 400);
  if (character.gold < stockItem.price) {
    return c.json({ error: "insufficient_gold", price: stockItem.price, gold: character.gold }, 400);
  }
  const claimed = await claimSmithyItem(c.env.DB, stockId, session.slack_user_id);
  if (!claimed) return c.json({ error: "already_sold" }, 400);
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, stockItem.price);
  if (!paid) {
    await releaseSmithyClaim(c.env.DB, stockId);
    return c.json({ error: "insufficient_gold_race" }, 400);
  }
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: stockItem.item_name,
    item_type: stockItem.item_type,
    power: stockItem.power,
    rarity: stockItem.rarity,
    flavor: stockItem.flavor ?? "",
    weapon_range: null,
    slot: stockItem.slot,
    stat_bonus: stockItem.stat_bonus,
    item_subtype: stockItem.item_subtype,
  });
  return c.json({ ok: true, paid: stockItem.price, gold_remaining: character.gold - stockItem.price, item });
});

app.post("/api/smithy/:itemId/sharpen", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.item_type !== "weapon" && item.item_type !== "armor") {
    return c.json({ error: "not_smithy_gear" }, 400);
  }
  if (!item.equipped) return c.json({ error: "equip_first" }, 400);
  if (item.sharpens_count >= SMITHY_SHARPEN_CAP) {
    return c.json({ error: "at_cap", cap: SMITHY_SHARPEN_CAP }, 400);
  }
  const cost = smithySharpenCost(item.power);
  if (character.gold < cost) {
    return c.json({ error: "insufficient_gold", price: cost, gold: character.gold }, 400);
  }
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, cost);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  const updated = await sharpenItem(c.env.DB, item.id, session.slack_user_id, SMITHY_SHARPEN_CAP);
  if (!updated) {
    await addGold(c.env.DB, session.slack_user_id, cost);
    return c.json({ error: "raced" }, 409);
  }
  return c.json({
    ok: true,
    paid: cost,
    gold_remaining: character.gold - cost,
    item: {
      id: updated.id,
      item_name: updated.item_name,
      old_power: item.power,
      new_power: updated.power,
      sharpens_count: updated.sharpens_count,
      cap: SMITHY_SHARPEN_CAP,
    },
    verb: smithVerbFor(updated),
  });
});

app.post("/api/smithy/repair", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const slots = await getAllEquippedSlots(c.env.DB, session.slack_user_id);
  const armorPower = computeArmorPowerFromSlots(slots);
  const armorMax = Math.floor(armorPower / 2);
  if (armorMax <= 0) return c.json({ error: "no_armor" }, 400);
  const armorMissing = Math.max(0, armorMax - character.shield);
  if (armorMissing === 0) return c.json({ error: "not_needed" }, 400);
  const cost = smithyRepairCost(armorMissing);
  if (character.gold < cost) return c.json({ error: "insufficient_gold", price: cost, gold: character.gold }, 400);
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, cost);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  await initArmorPool(c.env.DB, session.slack_user_id);
  return c.json({ ok: true, paid: cost, gold_remaining: character.gold - cost, armor_restored: armorMissing, armor_max: armorMax });
});

// =============================================================================
// CAMP — gathering tasks (mine / forage / fish), worker-tent upgrades.
// Yields are rolled lazily: a task's yield_json is filled on the first read
// after expires_at via rollGatherYield(taskId, …) so a status fetch and a
// claim always agree on the same outcome.
// =============================================================================

// Ensures any expired-but-unrolled tasks have their yield persisted, then
// returns the freshest list. Idempotent — safe to call from /status and
// /claim alike.
async function rollAndPersistExpiredYields(
  db: D1Database,
  tasks: GatheringTask[],
): Promise<GatheringTask[]> {
  const now = Date.now();
  const refreshed: GatheringTask[] = [];
  for (const task of tasks) {
    if (task.yield || task.expires_at > now) {
      refreshed.push(task);
      continue;
    }
    const rolled = rollGatherYield(
      task.id,
      task.node,
      task.tier,
      (task.modifiers as TentModifiers | null) ?? NO_TENT_MODIFIERS,
    );
    const yieldData = {
      resources: rolled.resources.map((r) => ({ name: r.name, qty: r.qty })),
      xp: rolled.xp,
      gold: rolled.gold,
      ...(rolled.gold_strike ? { gold_strike: true } : {}),
    };
    await tryWriteGatheringYield(db, task.id, yieldData);
    refreshed.push({ ...task, yield: yieldData });
  }
  return refreshed;
}

app.get("/api/camp/status", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const [activeRaw, upgrades, inFlightErrand] = await Promise.all([
    listActiveGatheringTasks(c.env.DB, session.slack_user_id),
    listCampUpgrades(c.env.DB, session.slack_user_id),
    getActivePubErrand(c.env.DB, session.slack_user_id),
  ]);
  const active = await rollAndPersistExpiredYields(c.env.DB, activeRaw);
  const builtKeys = upgrades.map((u) => u.upgrade_key);
  const slotCount = gatherSlotCount(builtKeys);
  // Slot 1 is the main character. When they're out on a pub errand the
  // tent slot they'd otherwise occupy is unavailable to start a gather —
  // surface that in the count so the camp UI doesn't promise a slot it
  // can't deliver. Tasks themselves still only count their own slot;
  // errand_slot_used is the extra +1 occupant.
  const mainOnErrand = !!inFlightErrand && !active.some((t) => t.worker_slot === 1);
  const errandOccupied = mainOnErrand ? 1 : 0;
  const inUse = active.length + errandOccupied;
  return c.json({
    now: Date.now(),
    active: active.map((t) => ({
      id: t.id,
      node: t.node,
      tier: t.tier,
      worker_slot: t.worker_slot,
      started_at: t.started_at,
      expires_at: t.expires_at,
      ready: t.expires_at <= Date.now(),
      yield: t.yield,
    })),
    slots: {
      total: slotCount,
      in_use: inUse,
      available: Math.max(0, slotCount - inUse),
      errand_slot_used: errandOccupied === 1,
    },
    upgrades_built: builtKeys,
    upgrades_catalog: CAMP_UPGRADE_CATALOG,
    gold: character.gold,
    level: character.level,
  });
});

app.post("/api/camp/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  const body = await c.req.json().catch(() => null) as { node?: string; tier?: string; worker_slot?: number } | null;
  const node = body?.node as CampNode | undefined;
  const tier = body?.tier as CampTier | undefined;
  if (!node || !(node in CAMP_NODE_CONFIG)) return c.json({ error: "bad_node" }, 400);
  if (!tier || !(tier in CAMP_TIERS)) return c.json({ error: "bad_tier" }, 400);
  const [active, upgrades, inFlightErrand] = await Promise.all([
    listActiveGatheringTasks(c.env.DB, session.slack_user_id),
    listCampUpgrades(c.env.DB, session.slack_user_id),
    getActivePubErrand(c.env.DB, session.slack_user_id),
  ]);
  const slotCount = gatherSlotCount(upgrades.map((u) => u.upgrade_key));
  if (active.length >= slotCount) {
    return c.json({ error: "no_slot", slots: slotCount, in_use: active.length }, 400);
  }
  // Worker slot is just an index — slot 1 is the player (main character),
  // slots 2..N are tents. If the main is out on a pub errand, slot 1 is
  // occupied. The client can request a specific slot (the worker picker);
  // otherwise default to the highest free slot so tents go first and the
  // player stays free for quests/errands.
  const used = new Set(active.map((t) => t.worker_slot));
  if (inFlightErrand) used.add(1);

  let workerSlot: number;
  const requested = body?.worker_slot;
  if (typeof requested === "number" && Number.isInteger(requested)) {
    if (requested < 1 || requested > slotCount) {
      return c.json({ error: "bad_slot", slots: slotCount }, 400);
    }
    if (used.has(requested)) {
      if (requested === 1 && inFlightErrand) {
        return c.json({ error: "errand_in_flight", errand_id: inFlightErrand.id }, 400);
      }
      return c.json({ error: "slot_busy", slot: requested }, 400);
    }
    workerSlot = requested;
  } else {
    workerSlot = slotCount;
    while (workerSlot >= 1 && used.has(workerSlot)) workerSlot -= 1;
    if (workerSlot < 1) {
      if (inFlightErrand && active.length < slotCount) {
        return c.json({ error: "errand_in_flight", errand_id: inFlightErrand.id }, 400);
      }
      return c.json({ error: "no_slot", slots: slotCount, in_use: active.length }, 400);
    }
  }

  // Only the player going gathering blocks (and is blocked by) an active
  // quest. A tent gathering in the background is fine while the player is
  // out on a quest.
  if (workerSlot === 1 && await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const tierSpec = CAMP_TIERS[tier];
  // Snapshot the current perks + character context onto the task. Future
  // perk builds, level-ups, or claims of other tasks won't retroactively
  // alter an in-flight gather's planned math.
  const perks = computeTentModifiers(upgrades.map((u) => u.upgrade_key));
  // Rested only fires when the player's *main* (slot 1) starts a gather,
  // and only when they've been away ≥24h since their last claim. Workers
  // (slot ≥ 2) are an always-on stream — the bonus is meant for players
  // returning to the game, not for an extra tent.
  const lastClaimAt = character.last_gather_claimed_at ?? null;
  const restedThresholdMs = 24 * 60 * 60 * 1000;
  const rested =
    workerSlot === 1 &&
    lastClaimAt != null &&
    Date.now() - lastClaimAt >= restedThresholdMs;
  const modifiers: TentModifiers = {
    ...perks,
    character_level: character.level,
    rested,
  };
  const durationMs = applyDurationModifier(tierSpec.duration_ms, perks);
  const task = await startGatheringTask(c.env.DB, {
    character_id: session.slack_user_id,
    node, tier,
    worker_slot: workerSlot,
    duration_ms: durationMs,
    modifiers,
  });
  return c.json({ ok: true, task, rested });
});

// DELETE the player's own active gathering task — frees the worker slot so
// they can start a hunt/quest. Hired workers (slot ≥ 2) are left alone:
// the user said the point of buying workers is exactly to keep gathering
// running while the main character is out questing.
app.post("/api/camp/cancel/:taskId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const taskId = parseInt(c.req.param("taskId"), 10);
  if (!Number.isFinite(taskId)) return c.json({ error: "bad_task_id" }, 400);
  const task = await getGatheringTask(c.env.DB, taskId, session.slack_user_id);
  if (!task) return c.json({ error: "not_yours" }, 404);
  if (task.claimed_at) return c.json({ error: "already_claimed" }, 400);
  const cancelled = await cancelGatheringTask(c.env.DB, taskId, session.slack_user_id);
  if (!cancelled) return c.json({ error: "raced" }, 409);
  return c.json({ ok: true, task_id: taskId });
});

app.post("/api/camp/claim/:taskId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const taskId = parseInt(c.req.param("taskId"), 10);
  if (!Number.isFinite(taskId)) return c.json({ error: "bad_task_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const task = await getGatheringTask(c.env.DB, taskId, session.slack_user_id);
  if (!task) return c.json({ error: "not_yours" }, 404);
  if (task.claimed_at) return c.json({ error: "already_claimed" }, 400);
  if (task.expires_at > Date.now()) return c.json({ error: "not_ready" }, 400);
  // Make sure the yield is rolled and persisted before marking claimed.
  const [persisted] = await rollAndPersistExpiredYields(c.env.DB, [task]);
  const yieldData = persisted.yield;
  if (!yieldData) return c.json({ error: "no_yield" }, 500);
  const marked = await markGatheringTaskClaimed(c.env.DB, taskId, session.slack_user_id);
  if (!marked) return c.json({ error: "raced" }, 409);
  // Grant resources + XP/gold. Resources stack via addResource; XP/gold via
  // awardSpoils so level-up flows fire as normal.
  for (const r of yieldData.resources) {
    const id = RESOURCE_CATALOG.find((s) => `${s.emoji} ${s.name}` === r.name)?.id;
    const spec = id ? findResource(id) : undefined;
    await addResource(
      c.env.DB,
      session.slack_user_id,
      r.name,
      r.qty,
      spec?.rarity ?? "common",
      spec?.blurb ?? "",
    );
  }
  const spoils = await awardSpoils(
    c.env.DB,
    character,
    yieldData.xp,
    yieldData.gold,
    () => 1 + Math.floor(Math.random() * 6),
    xpForLevel,
  );

  // Camp counters + rested-bonus timer. Sum the qty by node so a single
  // claim bumps the right per-node lifetime counter (drives the *_100
  // achievements). Mithril detection rides off the same loop so we can
  // emit `first_mithril` without re-walking yield resources.
  let nodeOreDelta = 0;
  let nodeHerbsDelta = 0;
  let nodeFishDelta = 0;
  let mithrilPulled = false;
  for (const r of yieldData.resources) {
    const id = RESOURCE_CATALOG.find((s) => `${s.emoji} ${s.name}` === r.name)?.id;
    const spec = id ? findResource(id) : undefined;
    if (!spec) continue;
    if (spec.node === "mine") nodeOreDelta += r.qty;
    else if (spec.node === "forage") nodeHerbsDelta += r.qty;
    else if (spec.node === "fish") nodeFishDelta += r.qty;
    if (id === "mithril_ore") mithrilPulled = true;
  }
  await bumpCampClaimStats(
    c.env.DB,
    session.slack_user_id,
    {
      ore: nodeOreDelta,
      herbs: nodeHerbsDelta,
      fish: nodeFishDelta,
      deep: task.tier === "deep" ? 1 : 0,
    },
    task.worker_slot === 1,
  );

  // Achievement grants — order matters only for the toast feed. Always-
  // grant flags are idempotent at the DB layer, so the first-claim ones
  // no-op on subsequent calls.
  const camp = character;
  const newOre   = camp.camp_ore_mined     + nodeOreDelta;
  const newHerbs = camp.camp_herbs_foraged + nodeHerbsDelta;
  const newFish  = camp.camp_fish_caught   + nodeFishDelta;
  const newDeep  = camp.camp_deep_claimed  + (task.tier === "deep" ? 1 : 0);
  const achToGrant: string[] = ["first_gather"];
  if (yieldData.gold_strike) achToGrant.push("gold_vein");
  if (mithrilPulled) achToGrant.push("first_mithril");
  if (newOre >= 100)   achToGrant.push("miner_100");
  if (newHerbs >= 100) achToGrant.push("forager_100");
  if (newFish >= 100)  achToGrant.push("fisher_100");
  if (newDeep >= 10)   achToGrant.push("deep_gatherer_10");
  for (const id of achToGrant) {
    await grantAchievement(c.env.DB, session.slack_user_id, id);
  }

  return c.json({ ok: true, task_id: taskId, yield: yieldData, spoils });
});

// Immediate-action camp mini-game. Phase 1 ships mining only.
//
// The client (MiningMinigame.tsx) sends the zone each strike landed on:
//   { node: "mine", strikes: ["dull"|"thin"|"rich", ...] }
//
// Loot table balance (locked in after first playtest revealed grinding):
//   • DULL never drops ore — wasted swing, you only get the XP floor.
//   • THIN gives iron at best — common everyday material.
//   • RICH gives silver at best — uncommon. NO mithril from the mini-game,
//     so deep-tier deferred gathers stay the exclusive mithril source.
//   • Vigor cap (3, +1/hr) prevents back-to-back grinding even at full skill.
//
// The server still rolls each drop probabilistically so a "rich" claim can
// roll nothing (~10% miss).
const MAX_VIGOR = 3;
const VIGOR_REGEN_MS = 60 * 60 * 1000;

function currentVigor(fullAt: number | null | undefined, now: number): number {
  if (!fullAt || fullAt <= now) return MAX_VIGOR;
  const ticksRemaining = Math.ceil((fullAt - now) / VIGOR_REGEN_MS);
  return Math.max(0, MAX_VIGOR - ticksRemaining);
}

app.post("/api/camp/minigame", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  const body = await c.req.json().catch(() => null) as
    | { node?: string; strikes?: unknown }
    | null;
  if (!body || body.node !== "mine") return c.json({ error: "bad_node" }, 400);
  if (!Array.isArray(body.strikes) || body.strikes.length !== 3) {
    return c.json({ error: "bad_strikes" }, 400);
  }
  type Zone = "dull" | "thin" | "rich";
  const VALID: ReadonlyArray<Zone> = ["dull", "thin", "rich"];
  const strikes: Zone[] = [];
  for (const z of body.strikes) {
    if (typeof z !== "string" || !(VALID as readonly string[]).includes(z)) {
      return c.json({ error: "bad_strikes" }, 400);
    }
    strikes.push(z as Zone);
  }
  // Vigor gate. If the player is out of vigor, no swing at all.
  const now = Date.now();
  const vigor = currentVigor(character.vigor_full_at, now);
  if (vigor <= 0) {
    return c.json({
      error: "no_vigor",
      vigor: 0,
      vigor_full_at: character.vigor_full_at ?? null,
    }, 400);
  }
  // Spend 1 vigor: push vigor_full_at forward by one tick. If it's already
  // in the future, extend it; if it's null/past, start the regen clock now.
  const baseFullAt = (character.vigor_full_at && character.vigor_full_at > now)
    ? character.vigor_full_at
    : now;
  const newVigorFullAt = baseFullAt + VIGOR_REGEN_MS;
  // Roll loot per strike, server-side.
  type Drop = { id: "iron_ore" | "silver_ore"; qty: number };
  const drops: Drop[] = [];
  let richHits = 0;
  for (const z of strikes) {
    if (z === "rich") {
      richHits++;
      const r = Math.random();
      if (r < 0.60) drops.push({ id: "silver_ore", qty: 1 });
      else if (r < 0.90) drops.push({ id: "iron_ore", qty: 1 });
      // ~10% nothing
    } else if (z === "thin") {
      const r = Math.random();
      if (r < 0.50) drops.push({ id: "iron_ore", qty: 1 });
      // ~50% nothing
    }
    // dull: never drops anything
  }
  // Best-zone XP. Attempted: 3, any thin: 5, any rich: 10.
  const bestZone: Zone = strikes.includes("rich") ? "rich" : strikes.includes("thin") ? "thin" : "dull";
  const xpAward = bestZone === "rich" ? 10 : bestZone === "thin" ? 5 : 3;

  // Stack drops into { id, qty } for response + addResource calls.
  const tally = new Map<Drop["id"], number>();
  for (const d of drops) tally.set(d.id, (tally.get(d.id) ?? 0) + d.qty);

  const grantedResources: Array<{ name: string; qty: number; rarity: string }> = [];
  for (const [id, qty] of tally) {
    const spec = findResource(id);
    if (!spec) continue;
    const name = resourceItemName(id);
    await addResource(c.env.DB, session.slack_user_id, name, qty, spec.rarity, spec.blurb);
    grantedResources.push({ name: `${spec.emoji} ${spec.name}`, qty, rarity: spec.rarity });
  }

  const spoils = await awardSpoils(
    c.env.DB,
    character,
    xpAward,
    0,
    () => rollDice(6),
    xpForLevel,
  );

  if (richHits > 0) {
    await bumpMineRichHits(c.env.DB, session.slack_user_id, richHits);
  }
  // Commit the spent vigor.
  await c.env.DB
    .prepare("UPDATE characters SET vigor_full_at = ? WHERE slack_user_id = ?")
    .bind(newVigorFullAt, session.slack_user_id)
    .run();

  return c.json({
    ok: true,
    xp: xpAward,
    gold: 0,
    levelsGained: spoils.levelsGained,
    newLevel: spoils.newLevel,
    resources: grantedResources,
    richHits,
    vigor: currentVigor(newVigorFullAt, now),
    vigor_full_at: newVigorFullAt,
  });
});

// ── Foraging mini-game ─────────────────────────────────────────────────────
//
// /start  → spends 1 forage vigor; generates the 4x4 grid; returns row/col
//           dimensions, flip budget, and the player's current HP (no grid
//           contents — those reveal one cell at a time).
// /flip   → reveals one cell. Applies hazard damage on the spot. Returns the
//           cell kind + remaining flips + updated HP.
// /finish → ends the play. Awards XP, resources, and the Flawless Forages
//           stat bump if the player took zero hazards. Deletes the row.

app.post("/api/camp/forage/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  const now = Date.now();
  const vigor = currentVigor(character.forage_vigor_full_at, now);
  if (vigor <= 0) {
    return c.json({
      error: "no_vigor",
      vigor: 0,
      vigor_full_at: character.forage_vigor_full_at ?? null,
    }, 400);
  }
  const baseFullAt = (character.forage_vigor_full_at && character.forage_vigor_full_at > now)
    ? character.forage_vigor_full_at
    : now;
  const newVigorFullAt = baseFullAt + VIGOR_REGEN_MS;
  // Spend the vigor first so a crashed game still charges (anti-grind).
  await c.env.DB
    .prepare("UPDATE characters SET forage_vigor_full_at = ? WHERE slack_user_id = ?")
    .bind(newVigorFullAt, session.slack_user_id)
    .run();
  // Generate a fresh grid + persist it. The client never sees cell contents
  // until it /flip's them — no client-side cheat surface.
  const seed = Math.floor(Math.random() * 0xffffffff);
  const grid = generateForageGrid(seed);
  const flipsTotal = forageFlipsForInt(character.int_stat);
  await startForageGame(c.env.DB, session.slack_user_id, JSON.stringify(grid), flipsTotal);
  return c.json({
    ok: true,
    rows: FORAGE_GRID_ROWS,
    cols: FORAGE_GRID_COLS,
    flips_total: flipsTotal,
    flips_used: 0,
    hp: character.hp,
    max_hp: character.max_hp,
    vigor: currentVigor(newVigorFullAt, now),
    vigor_full_at: newVigorFullAt,
  });
});

app.post("/api/camp/forage/flip", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const game = await getForageGame(c.env.DB, session.slack_user_id);
  if (!game) return c.json({ error: "no_active_game" }, 400);
  const body = (await c.req.json().catch(() => null)) as { r?: number; c?: number } | null;
  if (!body || typeof body.r !== "number" || typeof body.c !== "number") {
    return c.json({ error: "bad_flip" }, 400);
  }
  if (body.r < 0 || body.r >= FORAGE_GRID_ROWS || body.c < 0 || body.c >= FORAGE_GRID_COLS) {
    return c.json({ error: "bad_flip" }, 400);
  }
  let grid = JSON.parse(game.grid_json) as ForageCellKind[][];
  const revealed = JSON.parse(game.revealed_json) as Array<[number, number]>;
  // Already revealed? No-op (client may double-tap).
  if (revealed.some(([rr, cc]) => rr === body.r && cc === body.c)) {
    return c.json({ error: "already_revealed" }, 400);
  }
  if (revealed.length >= game.flips_total) {
    return c.json({ error: "no_flips_left" }, 400);
  }
  // First-flip safety: like real Minesweeper, the first click is guaranteed
  // safe (a 0-hazard cell). Regenerate the grid up to 40 times if the
  // requested cell is a hazard or has any hazards in its 8 neighbors. After
  // 40 tries we give up and let the cell stand — the player still gets a
  // playable game even if it's tougher.
  if (revealed.length === 0) {
    let tries = 0;
    while (
      tries < 40 &&
      (isForageHazard(grid[body.r][body.c]) || forageHazardCount(grid, body.r, body.c) > 0)
    ) {
      const newSeed = Math.floor(Math.random() * 0xffffffff);
      grid = generateForageGrid(newSeed);
      tries++;
    }
    // Persist the (possibly regenerated) grid so subsequent /flip calls see
    // the same world.
    await c.env.DB
      .prepare("UPDATE forage_games SET grid_json = ? WHERE character_id = ?")
      .bind(JSON.stringify(grid), session.slack_user_id)
      .run();
  }
  // Cascade from the requested cell. Hazards are never auto-revealed.
  const alreadyKeys = new Set(revealed.map(([rr, cc]) => `${rr},${cc}`));
  const revealedCells = forageCascadeFrom(grid, body.r, body.c, alreadyKeys);
  // HP damage if the player MANUALLY flipped a hazard (only possible when
  // the player's first cell was a hazard AND we couldn't find a safe
  // regeneration within 40 tries, or if they probe a guess later).
  let hpDamage = 0;
  let newHp = character.hp;
  const firstCell = grid[body.r][body.c];
  if (isForageHazard(firstCell)) {
    hpDamage = 1 + Math.floor(Math.random() * FORAGE_HAZARD_DICE);
    newHp = Math.max(1, character.hp - hpDamage);
    await c.env.DB
      .prepare("UPDATE characters SET hp = ? WHERE slack_user_id = ?")
      .bind(newHp, session.slack_user_id)
      .run();
  }
  // Persist new revealed set + HP tally.
  const nextRevealed = [
    ...revealed,
    ...revealedCells.map((r) => [r.r, r.c] as [number, number]),
  ];
  const nextHpTaken = game.hp_taken + hpDamage;
  await updateForageGame(
    c.env.DB,
    session.slack_user_id,
    JSON.stringify(nextRevealed),
    nextHpTaken,
  );
  return c.json({
    ok: true,
    // Manual flip — the cell the player tapped and its hazard count.
    cell: firstCell,
    hazard_count: forageHazardCount(grid, body.r, body.c),
    // Cascade — every cell auto-revealed FROM this manual flip, including
    // the manual flip itself as the first entry. Useful for the client to
    // batch-render with a fade-in.
    cascade: revealedCells,
    hp_damage: hpDamage,
    hp: newHp,
    max_hp: character.max_hp,
    flips_used: revealed.length + 1, // only ONE manual flip consumed
    flips_total: game.flips_total,
  });
});

app.post("/api/camp/forage/finish", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const game = await getForageGame(c.env.DB, session.slack_user_id);
  if (!game) return c.json({ error: "no_active_game" }, 400);
  const grid = JSON.parse(game.grid_json) as ForageCellKind[][];
  const revealed = JSON.parse(game.revealed_json) as Array<[number, number]>;
  // Tally herbs and grant resources. Mushroom reveals already debited HP at
  // /flip time; here we only convert herb reveals to inventory drops.
  let mossroot = 0;
  let sunleaf = 0;
  let hazards = 0;
  for (const [r, cc] of revealed) {
    const k = grid[r][cc];
    if (k === "mossroot") mossroot++;
    else if (k === "sunleaf") sunleaf++;
    else if (k === "mushroom") hazards++;
  }
  if (mossroot > 0) {
    const spec = findResource("mossroot");
    if (spec) await addResource(c.env.DB, session.slack_user_id, resourceItemName("mossroot"), mossroot, spec.rarity, spec.blurb);
  }
  if (sunleaf > 0) {
    const spec = findResource("sunleaf");
    if (spec) await addResource(c.env.DB, session.slack_user_id, resourceItemName("sunleaf"), sunleaf, spec.rarity, spec.blurb);
  }
  const herbsTotal = mossroot + sunleaf;
  // XP: 3 floor + 1 per herb, capped at 9.
  const xpAward = Math.min(9, 3 + herbsTotal);
  const spoils = await awardSpoils(
    c.env.DB,
    character,
    xpAward,
    0,
    () => rollDice(6),
    xpForLevel,
  );
  // Flawless = the player revealed at least 1 herb and ZERO hazards.
  const flawless = revealed.length > 0 && hazards === 0 && herbsTotal > 0;
  if (flawless) {
    await bumpForageFlawless(c.env.DB, session.slack_user_id, 1);
  }
  await deleteForageGame(c.env.DB, session.slack_user_id);
  const grantedResources: Array<{ name: string; qty: number; rarity: string }> = [];
  if (mossroot > 0) {
    const spec = findResource("mossroot");
    if (spec) grantedResources.push({ name: `${spec.emoji} ${spec.name}`, qty: mossroot, rarity: spec.rarity });
  }
  if (sunleaf > 0) {
    const spec = findResource("sunleaf");
    if (spec) grantedResources.push({ name: `${spec.emoji} ${spec.name}`, qty: sunleaf, rarity: spec.rarity });
  }
  // Refresh vigor for the response (no spend on finish).
  const now = Date.now();
  return c.json({
    ok: true,
    xp: xpAward,
    gold: 0,
    levelsGained: spoils.levelsGained,
    newLevel: spoils.newLevel,
    resources: grantedResources,
    herbs: herbsTotal,
    hazards,
    hp_taken: game.hp_taken,
    flawless,
    vigor: currentVigor(character.forage_vigor_full_at, now),
    vigor_full_at: character.forage_vigor_full_at ?? null,
  });
});

// Abandon any in-flight forage game (e.g. when the modal is closed mid-play).
// Vigor stays spent — no give-backs.
app.post("/api/camp/forage/abandon", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await deleteForageGame(c.env.DB, session.slack_user_id);
  return c.json({ ok: true });
});

// ── Fishing mini-game ──────────────────────────────────────────────────────
//
// /cast    → spends 1 fish vigor; server picks bite_at and bite_window;
//            returns target_at_ms (when client should fire the bite cue
//            relative to now) and the window the player has to strike.
// /strike  → { strike_at } — client time when the player pressed. Server
//            validates the strike landed within [bite_at, bite_at+window]
//            and records reaction_ms. Failure ends the game (no reel).
// /reel    → { safe_fraction } — fraction of reel time the player kept the
//            line in the SAFE zone (0..1, server clamps). Computes catch
//            quality, awards loot/XP. Updates fish_best_ms when applicable.
// /abandon → drops the row, vigor stays spent.

app.post("/api/camp/fish/cast", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  const now = Date.now();
  const vigor = currentVigor(character.fish_vigor_full_at, now);
  if (vigor <= 0) {
    return c.json({
      error: "no_vigor",
      vigor: 0,
      vigor_full_at: character.fish_vigor_full_at ?? null,
    }, 400);
  }
  const baseFullAt = (character.fish_vigor_full_at && character.fish_vigor_full_at > now)
    ? character.fish_vigor_full_at
    : now;
  const newVigorFullAt = baseFullAt + VIGOR_REGEN_MS;
  await c.env.DB
    .prepare("UPDATE characters SET fish_vigor_full_at = ? WHERE slack_user_id = ?")
    .bind(newVigorFullAt, session.slack_user_id)
    .run();
  const biteAtMs = Math.floor(
    FISH_BITE_MIN_MS + Math.random() * (FISH_BITE_MAX_MS - FISH_BITE_MIN_MS),
  );
  const biteWindowMs = fishBiteWindowForDex(character.dex);
  await startFishGame(c.env.DB, session.slack_user_id, now, biteAtMs, biteWindowMs);
  return c.json({
    ok: true,
    bite_at_ms: biteAtMs,
    bite_window_ms: biteWindowMs,
    reel_target_ms: FISH_REEL_TARGET_MS,
    pull_rate: fishPullRateForStr(character.str),
    vigor: currentVigor(newVigorFullAt, now),
    vigor_full_at: newVigorFullAt,
  });
});

app.post("/api/camp/fish/strike", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const game = await getFishGame(c.env.DB, session.slack_user_id);
  if (!game) return c.json({ error: "no_active_game" }, 400);
  if (game.phase !== "waiting") return c.json({ error: "bad_phase" }, 400);
  const body = (await c.req.json().catch(() => null)) as { strike_at?: number } | null;
  if (!body || typeof body.strike_at !== "number") return c.json({ error: "bad_strike" }, 400);
  // Server computes elapsed from its own clock, not the client's, then
  // checks the elapsed against the planned bite + window.
  const now = Date.now();
  const elapsed = now - game.cast_at;
  // Too early or too late → escaped.
  if (elapsed < game.bite_at_ms) {
    await deleteFishGame(c.env.DB, session.slack_user_id);
    return c.json({ ok: true, result: "too_early", elapsed_ms: elapsed, bite_at_ms: game.bite_at_ms });
  }
  if (elapsed > game.bite_at_ms + game.bite_window_ms) {
    await deleteFishGame(c.env.DB, session.slack_user_id);
    return c.json({ ok: true, result: "too_late", elapsed_ms: elapsed, bite_at_ms: game.bite_at_ms });
  }
  const reactionMs = Math.max(FISH_REACTION_FLOOR_MS, elapsed - game.bite_at_ms);
  await recordFishStrike(c.env.DB, session.slack_user_id, reactionMs);
  return c.json({
    ok: true,
    result: "hooked",
    reaction_ms: reactionMs,
    reel_target_ms: FISH_REEL_TARGET_MS,
  });
});

app.post("/api/camp/fish/reel", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const game = await getFishGame(c.env.DB, session.slack_user_id);
  if (!game) return c.json({ error: "no_active_game" }, 400);
  if (game.phase !== "reeling") return c.json({ error: "bad_phase" }, 400);
  const body = (await c.req.json().catch(() => null)) as { safe_fraction?: number } | null;
  if (!body || typeof body.safe_fraction !== "number") return c.json({ error: "bad_reel" }, 400);
  const safeFraction = Math.max(0, Math.min(1, body.safe_fraction));
  const reactionMs = game.reaction_ms ?? 1000;
  const quality = fishCatchQuality(reactionMs, safeFraction);
  // Loot table — anti-grind keeps the rare exclusive to deep tier.
  // Quality >= 0.55 → guaranteed silverfin; otherwise carp (or nothing on
  // very poor reel). Quick Cast never drops abyss_eel.
  let fishId: "river_carp" | "silverfin" | null = null;
  if (safeFraction >= 0.45) {
    fishId = quality >= 0.55 ? "silverfin" : "river_carp";
  } else if (safeFraction >= 0.25) {
    fishId = "river_carp";
  }
  const grantedResources: Array<{ name: string; qty: number; rarity: string }> = [];
  if (fishId) {
    const spec = findResource(fishId);
    if (spec) {
      await addResource(c.env.DB, session.slack_user_id, resourceItemName(fishId), 1, spec.rarity, spec.blurb);
      grantedResources.push({ name: `${spec.emoji} ${spec.name}`, qty: 1, rarity: spec.rarity });
    }
  }
  // XP: 3 floor (already hooked = beat phase 1) + 2 if any fish caught +
  // 5 if quality >= 0.55. Max 10.
  let xpAward = 3;
  if (fishId) xpAward += 2;
  if (quality >= 0.55) xpAward += 5;
  xpAward = Math.min(10, xpAward);
  const spoils = await awardSpoils(
    c.env.DB,
    character,
    xpAward,
    0,
    () => rollDice(6),
    xpForLevel,
  );
  // Only update fish_best_ms when an actual fish was hauled in.
  if (fishId) await updateFishBestMs(c.env.DB, session.slack_user_id, reactionMs);
  await bumpFishPlays(c.env.DB, session.slack_user_id);
  await deleteFishGame(c.env.DB, session.slack_user_id);
  const now = Date.now();
  return c.json({
    ok: true,
    fish: fishId,
    quality,
    reaction_ms: reactionMs,
    xp: xpAward,
    gold: 0,
    levelsGained: spoils.levelsGained,
    newLevel: spoils.newLevel,
    resources: grantedResources,
    vigor: currentVigor(character.fish_vigor_full_at, now),
    vigor_full_at: character.fish_vigor_full_at ?? null,
  });
});

app.post("/api/camp/fish/abandon", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await deleteFishGame(c.env.DB, session.slack_user_id);
  return c.json({ ok: true });
});

app.post("/api/camp/upgrade/:upgradeKey", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const upgradeKey = c.req.param("upgradeKey");
  const spec = findCampUpgrade(upgradeKey);
  if (!spec) return c.json({ error: "unknown_upgrade" }, 404);
  if (spec.coming_soon) return c.json({ error: "coming_soon" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.level < spec.level_req) {
    return c.json({ error: "level_too_low", needed: spec.level_req, level: character.level }, 400);
  }
  if (character.gold < spec.gold_cost) {
    return c.json({ error: "insufficient_gold", price: spec.gold_cost, gold: character.gold }, 400);
  }
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, spec.gold_cost);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  const built = await tryBuildCampUpgrade(c.env.DB, session.slack_user_id, upgradeKey);
  if (!built) {
    await addGold(c.env.DB, session.slack_user_id, spec.gold_cost);
    return c.json({ error: "already_built" }, 400);
  }

  // Camp-perk achievements. Re-read built upgrades so the set check
  // includes the one we just inserted (tryBuildCampUpgrade returns
  // bool, not the full list).
  const builtNow = await listCampUpgrades(c.env.DB, session.slack_user_id);
  const builtKeys = new Set(builtNow.map((u) => u.upgrade_key));
  const grants: string[] = [];
  if (upgradeKey.startsWith("worker_tent_")) {
    grants.push("first_tent");
    const tents = ["worker_tent_1", "worker_tent_2", "worker_tent_3"];
    if (tents.every((k) => builtKeys.has(k))) grants.push("full_camp");
  }
  const perks = ["tent_upgrade_quickdry", "tent_upgrade_haul", "tent_upgrade_keen_eye"];
  if (perks.every((k) => builtKeys.has(k))) grants.push("camp_perks_all");
  for (const id of grants) {
    await grantAchievement(c.env.DB, session.slack_user_id, id);
  }

  return c.json({ ok: true, upgrade: spec, paid: spec.gold_cost, gold_remaining: character.gold - spec.gold_cost });
});

// Smithy Forge — craft a gear item from ore. Inputs validated against the
// recipe catalog; outputs go through addItem the same way shop purchases do.
app.post("/api/smithy/forge/:recipeId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const recipe = findRecipe(c.req.param("recipeId"));
  if (!recipe || recipe.station !== "smithy") return c.json({ error: "unknown_recipe" }, 404);
  return await runRecipe(c, session.slack_user_id, recipe);
});

app.post("/api/apothecary/brew/:recipeId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const recipe = findRecipe(c.req.param("recipeId"));
  if (!recipe || recipe.station !== "apothecary") return c.json({ error: "unknown_recipe" }, 404);
  return await runRecipe(c, session.slack_user_id, recipe);
});

async function runRecipe(c: Context<{ Bindings: Env }>, userId: string, recipe: RecipeSpec): Promise<Response> {
  const character = await getCharacter(c.env.DB, userId);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, userId)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  if (character.level < recipe.level_req) {
    return c.json({ error: "level_too_low", needed: recipe.level_req, level: character.level }, 400);
  }
  if (character.gold < recipe.gold_cost) {
    return c.json({ error: "insufficient_gold", price: recipe.gold_cost, gold: character.gold }, 400);
  }
  // Consume inputs first (atomic per-resource). If any consume fails, refund
  // the resources we already deducted so the player doesn't end up partway.
  const consumed: Array<{ resource_id: string; qty: number }> = [];
  for (const input of recipe.inputs) {
    const itemName = resourceItemName(input.resource_id);
    const ok = await tryConsumeResource(c.env.DB, userId, itemName, input.qty);
    if (!ok) {
      // Refund anything we already took.
      for (const back of consumed) {
        await addResource(c.env.DB, userId, resourceItemName(back.resource_id), back.qty);
      }
      return c.json({ error: "insufficient_resources", needed: input.resource_id, qty: input.qty }, 400);
    }
    consumed.push(input);
  }
  const paid = await tryDeductGold(c.env.DB, userId, recipe.gold_cost);
  if (!paid) {
    for (const back of consumed) {
      await addResource(c.env.DB, userId, resourceItemName(back.resource_id), back.qty);
    }
    return c.json({ error: "insufficient_gold_race" }, 400);
  }
  const item = await addItem(c.env.DB, {
    character_id: userId,
    item_name: recipe.output_name,
    item_type: recipe.output_type,
    power: smithyEffectivePower(recipe, character.level),
    rarity: recipe.output_rarity,
    flavor: recipe.output_blurb,
    slot: recipe.output_slot ?? undefined,
    item_subtype: recipe.output_subtype ?? undefined,
    weapon_range: recipe.output_type === "weapon" ? "melee" : null,
  });

  // Smithy-only achievement wiring. Apothecary brews don't increment the
  // smithy_crafts counter or trigger forge achievements — they have
  // their own catalog (apothecary_purchases / checkApothecaryAchievements).
  if (recipe.station === "smithy") {
    await bumpSmithyCrafts(c.env.DB, userId);
    const usesMithril = recipe.inputs.some((i) => i.resource_id === "mithril_ore");
    const newCrafts = character.smithy_crafts + 1;
    const grants: string[] = ["first_smith_craft"];
    if (usesMithril) grants.push("mithril_craft");
    if (newCrafts >= 25) grants.push("smith_25");
    if (newCrafts >= 50) grants.push("smith_master_50");
    for (const id of grants) {
      await grantAchievement(c.env.DB, userId, id);
    }
  }

  return c.json({
    ok: true,
    recipe_id: recipe.id,
    item,
    paid: recipe.gold_cost,
    consumed,
    gold_remaining: character.gold - recipe.gold_cost,
  });
}

// Smithy Reinforce — extend sharpens past the gold cap (3) up to total cap
// (6) using ore. Each reinforce costs 1 ore of the matching tier (any ore
// accepted; client picks). Power bumps +1 just like a normal sharpen.
app.post("/api/smithy/reinforce/:itemId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const body = await c.req.json().catch(() => null) as { resource_id?: string } | null;
  const resourceId = body?.resource_id;
  if (!resourceId) return c.json({ error: "bad_resource" }, 400);
  const spec = findResource(resourceId);
  if (!spec || spec.node !== "mine") return c.json({ error: "not_ore" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.item_type !== "weapon" && item.item_type !== "armor") {
    return c.json({ error: "not_smithy_gear" }, 400);
  }
  if (item.sharpens_count < SMITHY_SHARPEN_GOLD_CAP) {
    return c.json({ error: "use_sharpen_first", at: item.sharpens_count, gold_cap: SMITHY_SHARPEN_GOLD_CAP }, 400);
  }
  if (item.sharpens_count >= SMITHY_SHARPEN_TOTAL_CAP) {
    return c.json({ error: "at_total_cap", cap: SMITHY_SHARPEN_TOTAL_CAP }, 400);
  }
  const consumed = await tryConsumeResource(c.env.DB, session.slack_user_id, resourceItemName(resourceId), 1);
  if (!consumed) return c.json({ error: "insufficient_resources", needed: resourceId, qty: 1 }, 400);
  const bumped = await bumpSharpens(c.env.DB, item.id, session.slack_user_id);
  if (!bumped) {
    await addResource(c.env.DB, session.slack_user_id, resourceItemName(resourceId), 1);
    return c.json({ error: "raced" }, 409);
  }
  return c.json({
    ok: true,
    item: { id: item.id, item_name: item.item_name, old_power: item.power, new_power: item.power + 1, sharpens_count: item.sharpens_count + 1, total_cap: SMITHY_SHARPEN_TOTAL_CAP },
    consumed: resourceId,
  });
});

// Apothecary Concentrate — apply 1 herb to a potion to add a potency stack
// (max 2). At use time the potion's effect is boosted by +25% per stack;
// dispatch reads the potency_stacks field from inventory.
app.post("/api/apothecary/concentrate/:itemId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const body = await c.req.json().catch(() => null) as { resource_id?: string } | null;
  const resourceId = body?.resource_id;
  if (!resourceId) return c.json({ error: "bad_resource" }, 400);
  const spec = findResource(resourceId);
  if (!spec || spec.node !== "forage") return c.json({ error: "not_herb" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.item_type !== "consumable" && item.item_type !== "tool") {
    return c.json({ error: "not_potion" }, 400);
  }
  if (item.potency_stacks >= APOTHECARY_POTENCY_CAP) {
    return c.json({ error: "at_cap", cap: APOTHECARY_POTENCY_CAP }, 400);
  }
  const consumed = await tryConsumeResource(c.env.DB, session.slack_user_id, resourceItemName(resourceId), 1);
  if (!consumed) return c.json({ error: "insufficient_resources", needed: resourceId, qty: 1 }, 400);
  const bumped = await tryAddPotencyStack(c.env.DB, item.id, session.slack_user_id, APOTHECARY_POTENCY_CAP);
  if (!bumped) {
    await addResource(c.env.DB, session.slack_user_id, resourceItemName(resourceId), 1);
    return c.json({ error: "raced" }, 409);
  }
  return c.json({
    ok: true,
    item: { id: item.id, item_name: item.item_name, potency_stacks: item.potency_stacks + 1, cap: APOTHECARY_POTENCY_CAP },
    consumed: resourceId,
  });
});

app.post("/api/inn/:roomId/stay", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const roomId = c.req.param("roomId");
  const room = INN_ROOMS.find((r) => r.id === roomId);
  if (!room) return c.json({ error: "unknown_room" }, 404);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const wouldRefillHp = room.refills.hp && character.hp < character.max_hp;
  const wouldRefillMana = room.refills.mana && character.mana < character.max_mana;
  if (!wouldRefillHp && !wouldRefillMana) {
    return c.json({ error: "already_full" }, 400);
  }
  if (character.gold < room.price) {
    return c.json({ error: "insufficient_gold", price: room.price, gold: character.gold }, 400);
  }
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, room.price);
  if (!paid) return c.json({ error: "insufficient_gold_race" }, 400);
  await applyInnRest(c.env.DB, session.slack_user_id, room.refills);
  await initArmorPool(c.env.DB, session.slack_user_id);
  return c.json({
    ok: true,
    paid: room.price,
    gold_remaining: character.gold - room.price,
    refills: room.refills,
    hp_gained: wouldRefillHp ? character.max_hp - character.hp : 0,
    mana_gained: wouldRefillMana ? character.max_mana - character.mana : 0,
  });
});

// Use an inventory item out of combat. Mirrors /sq use for the contexts
// that don't need a foe: consumables heal the user (clamped to max_hp),
// magic items bump max_mana (capped at MAX_MANA_CAP). Tools / scrolls /
// revive items reject — those require combat context (use_item via WS)
// or a target picker (revive). Mid-combat use also rejects; route those
// through the WS protocol's use_item action instead.
app.post("/api/inventory/:itemId/use", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);

  if (item.item_type === "consumable") {
    // Staple potions stored as consumables route by name. Mana staples
    // (Mana Vial / Mana Flask) restore mana, not HP. Health staples and
    // any non-staple consumable fall through to consumeItem (HP heal).
    const staple = findStaple(item.item_name);
    if (staple?.effect === "restore_mana") {
      if (character.mana >= character.max_mana) {
        return c.json({ error: "at_full_mana" }, 400);
      }
      const effectivePower = applyPotency(item.power, item.potency_stacks ?? 0);
      const restored = await addMana(c.env.DB, character, effectivePower);
      await removeItem(c.env.DB, item.id);
      return c.json({ ok: true, kind: "mana", restored, requested: effectivePower });
    }
    if (character.hp >= character.max_hp) {
      return c.json({ error: "at_full_hp" }, 400);
    }
    const healed = await consumeItem(c.env.DB, character, item);
    return c.json({ ok: true, kind: "heal", healed });
  }
  if (item.item_type === "magic") {
    if (character.max_mana >= 5) {
      return c.json({ error: "at_max_mana_cap" }, 400);
    }
    const result = await bumpMaxMana(c.env.DB, character, item.power);
    await removeItem(c.env.DB, item.id);
    return c.json({
      ok: true,
      kind: "mana_bump",
      added: result.added,
      new_max_mana: result.newMaxMana,
    });
  }
  return c.json({
    error: "use_in_combat",
    item_type: item.item_type,
    hint: "Tools / scrolls / revives have combat-only effects on the web — open a fight first.",
  }, 400);
});

// Sell an inventory item. Mirrors /sq sell: no mid-quest, no equipped
// items. Price is sellPriceFor(type, rarity) — same table as slack.
app.post("/api/inventory/:itemId/sell", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.equipped) return c.json({ error: "unequip_first" }, 400);
  const price = sellPriceFor(item.item_type, item.rarity);
  await removeItem(c.env.DB, item.id);
  await addGold(c.env.DB, session.slack_user_id, price);
  return c.json({ ok: true, price });
});

// Give an unequipped inventory item to another player. Mirrors /sq give.
// Body: { to_user_id: string }. Item must be owned + unequipped. The
// recipient must have a character. No mid-quest restriction — matches
// the Slack version's "works anywhere" design.
app.post("/api/inventory/:itemId/give", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (!Number.isFinite(itemId)) return c.json({ error: "bad_item_id" }, 400);
  const body = await c.req.json<{ to_user_id?: string }>().catch(() => ({ to_user_id: undefined }));
  const toUserId = body.to_user_id?.trim();
  if (!toUserId) return c.json({ error: "missing_to_user_id" }, 400);
  if (toUserId === session.slack_user_id) return c.json({ error: "cant_give_to_self" }, 400);
  const item = await getItem(c.env.DB, itemId, session.slack_user_id);
  if (!item) return c.json({ error: "not_yours" }, 404);
  if (item.equipped) return c.json({ error: "unequip_first" }, 400);
  const recipient = await getCharacter(c.env.DB, toUserId);
  if (!recipient) return c.json({ error: "recipient_no_character" }, 404);
  await transferItem(c.env.DB, item.id, toUserId);
  // Drop a notification so the recipient sees a toast next time their
  // browser tab is focused (or on their next refresh). Best-effort —
  // a failure here doesn't undo the transfer; the user can always see
  // the item in their inventory regardless.
  const giver = await getCharacter(c.env.DB, session.slack_user_id);
  c.executionCtx.waitUntil(
    insertNotification(c.env.DB, toUserId, "item_received", {
      from_user_id: session.slack_user_id,
      from_name: giver?.name ?? session.slack_user_id,
      item_id: item.id,
      item_name: item.item_name,
      item_type: item.item_type,
      rarity: item.rarity,
    }).catch((err) => console.warn("notification insert failed", err)),
  );
  return c.json({ ok: true, item_name: item.item_name, to_name: recipient.name });
});

// Pending notifications for the current user — read-and-clear. Client
// polls on tab focus + initial load. Returns the rows in order; client
// renders one toast per entry.
app.get("/api/notifications/pending", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const items = await fetchAndClearNotifications(c.env.DB, session.slack_user_id);
  return c.json({ notifications: items });
});

// List team characters — used by the "Give" picker and the Adventurers panel.
app.get("/api/characters", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB
    .prepare(
      `SELECT slack_user_id, name, class, level, xp, hp, max_hp, last_active, slack_username, scars,
              str, int_stat, vit, agi, dex, unspent_points
       FROM characters
       WHERE slack_user_id != ? AND slack_team_id = ?
       ORDER BY last_active DESC LIMIT 20`,
    )
    .bind(session.slack_user_id, session.slack_team_id)
    .all<{ slack_user_id: string; name: string; class: string; level: number; xp: number; hp: number; max_hp: number; last_active: number; slack_username: string | null; scars: string; str: number; int_stat: number; vit: number; agi: number; dex: number; unspent_points: number }>();
  const characters = (rows.results ?? []).map((r) => ({ ...r, scars: JSON.parse(r.scars ?? "[]") as string[] }));
  return c.json({ characters });
});

// =============================================================================
// PUB ENDPOINTS
// =============================================================================

// =============================================================================
// STONE-PARCHMENT-DAGGER (SPD) — async 1v1 pub mini-game
// =============================================================================

type SpdThrow = "stone" | "parchment" | "dagger";

const SPD_STAKES = [10, 25, 50];
const SPD_BET_AMOUNTS = [5, 10, 25];
const SPD_HOUSE_BUMP_PCT = 0.2; // +20% house bump on total pot for winner
const SPD_BET_PAYOUT_MULT = 2;  // winning side bets pay 2×
const SPD_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Returns the winning side: 'initiator' | 'challenger' | 'tie'
function spdResolveThrow(initiator: SpdThrow, challenger: SpdThrow): "initiator" | "challenger" | "tie" {
  if (initiator === challenger) return "tie";
  // Stone crushes Dagger, Parchment wraps Stone, Dagger cuts Parchment
  if (
    (initiator === "stone" && challenger === "dagger") ||
    (initiator === "parchment" && challenger === "stone") ||
    (initiator === "dagger" && challenger === "parchment")
  ) {
    return "initiator";
  }
  return "challenger";
}

interface SpdMatchRow {
  id: number;
  channel_id: string;
  initiator_user_id: string;
  initiator_stake: number;
  initiator_throw: string;
  challenger_user_id: string | null;
  challenger_throw: string | null;
  status: string;
  winner_user_id: string | null;
  house_bump: number | null;
  message_ts: string | null;
  created_at: number;
  resolved_at: number | null;
  last_bumped_at: number | null;
}

interface SpdBetRow {
  match_id: number;
  bettor_user_id: string;
  side: string;
  amount: number;
  created_at: number;
}

// Sweep expired open matches in a channel — refund stakes and cancel.
async function spdSweepExpired(db: D1Database, channelId: string): Promise<void> {
  const cutoff = Date.now() - SPD_EXPIRY_MS;
  const expired = await db
    .prepare(
      `SELECT id, initiator_user_id, initiator_stake FROM spd_matches
       WHERE channel_id = ? AND status = 'open' AND created_at < ?`,
    )
    .bind(channelId, cutoff)
    .all<{ id: number; initiator_user_id: string; initiator_stake: number }>();

  for (const row of expired.results) {
    await db
      .prepare(`UPDATE spd_matches SET status = 'cancelled' WHERE id = ? AND status = 'open'`)
      .bind(row.id)
      .run();
    await addGold(db, row.initiator_user_id, row.initiator_stake);
    // Also refund any side bets that were placed
    const bets = await db
      .prepare(`SELECT bettor_user_id, amount FROM spd_bets WHERE match_id = ?`)
      .bind(row.id)
      .all<{ bettor_user_id: string; amount: number }>();
    for (const bet of bets.results) {
      await addGold(db, bet.bettor_user_id, bet.amount);
    }
  }
}

// Resolve a match after challenger_throw is set. Returns payout info.
async function spdResolveMatch(
  db: D1Database,
  match: SpdMatchRow,
): Promise<{ winner_user_id: string | null; house_bump: number; payout: number; tie: boolean }> {
  const outcome = spdResolveThrow(match.initiator_throw as SpdThrow, match.challenger_throw as SpdThrow);
  const totalStakes = match.initiator_stake * 2;
  const bets = await db
    .prepare(`SELECT * FROM spd_bets WHERE match_id = ?`)
    .bind(match.id)
    .all<SpdBetRow>();

  const initiatorBetTotal = bets.results.filter((b) => b.side === "initiator").reduce((s, b) => s + b.amount, 0);
  const challengerBetTotal = bets.results.filter((b) => b.side === "challenger").reduce((s, b) => s + b.amount, 0);
  const totalBetted = initiatorBetTotal + challengerBetTotal;
  const totalPot = totalStakes + totalBetted;

  if (outcome === "tie") {
    // Refund everything
    await addGold(db, match.initiator_user_id, match.initiator_stake);
    await addGold(db, match.challenger_user_id!, match.initiator_stake);
    for (const bet of bets.results) {
      await addGold(db, bet.bettor_user_id, bet.amount);
    }
    await db
      .prepare(
        `UPDATE spd_matches SET status = 'resolved', winner_user_id = NULL, house_bump = 0, resolved_at = ? WHERE id = ?`,
      )
      .bind(Date.now(), match.id)
      .run();
    return { winner_user_id: null, house_bump: 0, payout: 0, tie: true };
  }

  const winnerUserId = outcome === "initiator" ? match.initiator_user_id : match.challenger_user_id!;
  const houseBump = Math.floor(totalPot * SPD_HOUSE_BUMP_PCT);
  const winnerPayout = totalStakes + houseBump; // winner gets both stakes + bump
  await addGold(db, winnerUserId, winnerPayout);

  // Pay winning side bets 2×
  const winningSide = outcome;
  for (const bet of bets.results) {
    if (bet.side === winningSide) {
      await addGold(db, bet.bettor_user_id, bet.amount * SPD_BET_PAYOUT_MULT);
    }
    // Losing bets kept by house — no payout
  }

  await db
    .prepare(
      `UPDATE spd_matches SET status = 'resolved', winner_user_id = ?, house_bump = ?, resolved_at = ? WHERE id = ?`,
    )
    .bind(winnerUserId, houseBump, Date.now(), match.id)
    .run();

  return { winner_user_id: winnerUserId, house_bump: houseBump, payout: winnerPayout, tie: false };
}

// =============================================================================
// PUB ERRANDS — timed NPC-driven mini-quests
// =============================================================================
//
// Daily-rotating offers per channel, accepted one at a time per character.
// Reuses the camp's lazy-yield-on-read pattern: rollPubErrandYield(errandId,
// patron, kind, tier, trust) is deterministic so a status fetch and a claim
// always agree on the same payout.

// Day-bucket for the daily offer rotation. UTC midnight units; same channel
// rolls the same kinds within a day, fresh ones the next.
function pubDayBucket(now: number): number {
  return Math.floor(now / (24 * 60 * 60 * 1000));
}

// Ensure the channel has a live offer roster. Generates one per patron given
// the player's current trust scores; offers stay around until restock window.
async function ensurePubErrandOffers(
  db: D1Database,
  channelId: string,
  characterId: string,
): Promise<PubErrandOfferRow[]> {
  const existing = await getActivePubErrandOffers(db, channelId, PUB_ERRAND_RESTOCK_MS);
  const trust = await listPubTrust(db, characterId);
  const trustByPatron = new Map(trust.map((t) => [t.patron_id, t]));
  const now = Date.now();
  const day = pubDayBucket(now);

  // Per-patron top-up: any patron whose un-taken offers are exhausted gets a
  // fresh row of PUB_OFFERS_PER_PATRON slots. New rows roll against current
  // trust so unlocking Procure/Investigate flips the kinds available without
  // waiting on the daily reset.
  const openByPatron = new Map<string, number>();
  for (const o of existing) {
    if (o.taken_by === null) openByPatron.set(o.patron_id, (openByPatron.get(o.patron_id) ?? 0) + 1);
  }
  const toInsert: PubErrandOfferInput[] = [];
  for (const patron of PUB_PATRONS) {
    if ((openByPatron.get(patron.id) ?? 0) > 0) continue;
    const t = trustByPatron.get(patron.id);
    // Salt the day-bucket seed with the count of generations we've already
    // done for this patron so successive top-ups within the same day produce
    // a varied roster rather than the same kinds.
    const generations = existing.filter((o) => o.patron_id === patron.id).length / PUB_OFFERS_PER_PATRON;
    const kinds = rollPatronOfferKinds(patron.id, day + Math.floor(generations), t?.score ?? 0, (t?.rare_claimed ?? 0) === 1);
    for (let i = 0; i < PUB_OFFERS_PER_PATRON; i++) {
      toInsert.push({
        channel_id: channelId,
        patron_id: patron.id,
        kind: kinds[i],
        tier: kinds[i] === "rare" ? "long" : tierForOfferIndex(i),
        generated_at: now,
      });
    }
  }
  if (toInsert.length === 0) return existing;
  await insertPubErrandOffers(db, toInsert);
  return getActivePubErrandOffers(db, channelId, PUB_ERRAND_RESTOCK_MS);
}

// Roll + persist yield for any expired-but-unrolled active errand. Idempotent
// — safe to call from status and claim alike.
async function rollAndPersistPubYield(
  db: D1Database,
  errand: PubErrand,
  trustScore: number,
  characterLevel: number,
): Promise<PubErrand> {
  const now = Date.now();
  if (errand.yield || errand.expires_at > now) return errand;
  const rolled = rollPubErrandYield(
    errand.id,
    errand.patron_id,
    errand.kind,
    errand.tier,
    trustScore,
    characterLevel,
  );
  await tryWritePubErrandYield(db, errand.id, rolled);
  return { ...errand, yield: rolled };
}

app.get("/api/pub/errands", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const offers = await ensurePubErrandOffers(c.env.DB, channelId, session.slack_user_id);
  const activeRaw = await getActivePubErrand(c.env.DB, session.slack_user_id);
  let active: PubErrand | null = null;
  if (activeRaw) {
    const trust = await getPubTrust(c.env.DB, session.slack_user_id, activeRaw.patron_id);
    active = await rollAndPersistPubYield(c.env.DB, activeRaw, trust.score, character.level);
  }
  const trust = await listPubTrust(c.env.DB, session.slack_user_id);
  // Fetch patron portrait art in parallel — scheduled in background so
  // first-render latency isn't affected; R2 cache returns instantly once warm.
  const art = artTarget(c.env);
  const patronArtKeys: Record<string, ViewArtKey> = {
    cobb: "patron_cobb",
    marra: "patron_marra",
    rell: "patron_rell",
  };
  const patronArtUrls = await Promise.all(
    PUB_PATRONS.map((p) => {
      const key = patronArtKeys[p.id];
      return key
        ? getOrScheduleViewArt(c.env.AI, art, c.executionCtx, key, undefined, TOWN_WEEKLY_MS)
        : Promise.resolve(null);
    })
  );
  const patronsWithArt = PUB_PATRONS.map((p, i) => ({ ...p, art_url: patronArtUrls[i] }));
  return c.json({
    now: Date.now(),
    patrons: patronsWithArt,
    offers: offers.filter((o) => o.taken_by === null).map((o) => ({
      id: o.id,
      patron_id: o.patron_id,
      kind: o.kind,
      tier: o.tier,
      duration_ms: PUB_ERRAND_TIERS[o.tier as PubErrandTier].duration_ms,
      base_xp: PUB_ERRAND_TIERS[o.tier as PubErrandTier].base_xp,
      base_gold: PUB_ERRAND_TIERS[o.tier as PubErrandTier].base_gold,
      procure_qty: PUB_PROCURE_INPUT_QTY[o.tier as PubErrandTier],
    })),
    active: active ? {
      id: active.id,
      patron_id: active.patron_id,
      kind: active.kind,
      tier: active.tier,
      started_at: active.started_at,
      expires_at: active.expires_at,
      ready: active.expires_at <= Date.now(),
      yield: active.yield,
      input_resources: active.input_resources,
    } : null,
    trust: PUB_PATRONS.map((p) => {
      const t = trust.find((row) => row.patron_id === p.id);
      return {
        patron_id: p.id,
        score: t?.score ?? 0,
        rare_claimed: (t?.rare_claimed ?? 0) === 1,
        cap: PUB_TRUST_CAP,
      };
    }),
  });
});

app.post("/api/pub/errands/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.downed_until && character.downed_until > Date.now()) {
    return c.json({ error: "downed" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  if (await isMainCharacterGathering(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "main_gathering" }, 400);
  }
  const existingActive = await getActivePubErrand(c.env.DB, session.slack_user_id);
  if (existingActive) return c.json({ error: "errand_in_flight", errand_id: existingActive.id }, 400);
  const body = await c.req.json().catch(() => null) as { offer_id?: number; input_resource_id?: string } | null;
  const offerId = body?.offer_id;
  if (typeof offerId !== "number") return c.json({ error: "bad_offer_id" }, 400);
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const offer = await getPubErrandOffer(c.env.DB, offerId, channelId);
  if (!offer) return c.json({ error: "offer_not_found" }, 404);
  if (offer.taken_by !== null) return c.json({ error: "already_taken" }, 400);
  if (Date.now() - offer.generated_at > PUB_ERRAND_RESTOCK_MS) {
    return c.json({ error: "offer_expired" }, 400);
  }
  const patron = findPubPatron(offer.patron_id);
  if (!patron) return c.json({ error: "unknown_patron" }, 404);

  // Trust gate
  const trust = await getPubTrust(c.env.DB, session.slack_user_id, patron.id);
  if (trust.score < PUB_ERRAND_TRUST_GATE[offer.kind as PubErrandKind]) {
    return c.json({ error: "trust_too_low", needed: PUB_ERRAND_TRUST_GATE[offer.kind as PubErrandKind], have: trust.score }, 400);
  }
  if (offer.kind === "rare" && trust.rare_claimed === 1) {
    return c.json({ error: "rare_already_claimed" }, 400);
  }

  // Procure input handling — consumes the requested resource family up front.
  const tierSpec = PUB_ERRAND_TIERS[offer.tier as PubErrandTier];
  let inputResources: Array<{ name: string; qty: number }> = [];
  if (offer.kind === "procure") {
    const resourceId = body?.input_resource_id;
    if (!resourceId) return c.json({ error: "bad_resource" }, 400);
    const spec = findResource(resourceId);
    if (!spec) return c.json({ error: "unknown_resource" }, 400);
    if (spec.node !== patron.procure_resource_node) {
      return c.json({ error: "wrong_resource_family", expected: patron.procure_resource_node }, 400);
    }
    const qty = PUB_PROCURE_INPUT_QTY[offer.tier as PubErrandTier];
    const itemName = resourceItemName(resourceId);
    const consumed = await tryConsumeResource(c.env.DB, session.slack_user_id, itemName, qty);
    if (!consumed) return c.json({ error: "insufficient_resources", needed: resourceId, qty }, 400);
    inputResources = [{ name: itemName, qty }];
  }

  // Atomic offer claim — temp errand id of -1 because we don't have one yet;
  // we'll patch after insert.
  const tempClaim = await tryClaimPubErrandOffer(c.env.DB, offerId, -1);
  if (!tempClaim) {
    // Refund any consumed resources, then bail.
    for (const r of inputResources) {
      await addResource(c.env.DB, session.slack_user_id, r.name, r.qty);
    }
    return c.json({ error: "already_taken" }, 409);
  }
  const errand = await startPubErrand(c.env.DB, {
    character_id: session.slack_user_id,
    patron_id: patron.id,
    kind: offer.kind as PubErrandKind,
    tier: offer.tier as PubErrandTier,
    duration_ms: tierSpec.duration_ms,
    input_resources: inputResources,
  });
  // Patch the offer with the real errand id so the audit trail is right.
  await c.env.DB
    .prepare("UPDATE pub_errand_offers SET taken_by = ? WHERE id = ?")
    .bind(errand.id, offerId).run();

  return c.json({ ok: true, errand });
});

app.post("/api/pub/errands/claim/:id", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const errandId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(errandId)) return c.json({ error: "bad_errand_id" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const errand = await getPubErrand(c.env.DB, errandId, session.slack_user_id);
  if (!errand) return c.json({ error: "not_yours" }, 404);
  if (errand.claimed_at) return c.json({ error: "already_claimed" }, 400);
  if (errand.cancelled_at) return c.json({ error: "cancelled" }, 400);
  if (errand.expires_at > Date.now()) return c.json({ error: "not_ready" }, 400);
  const trust = await getPubTrust(c.env.DB, session.slack_user_id, errand.patron_id);
  const filled = await rollAndPersistPubYield(c.env.DB, errand, trust.score, character.level);
  const yieldData = filled.yield as PubErrandYield | null;
  if (!yieldData) return c.json({ error: "no_yield" }, 500);
  const marked = await markPubErrandClaimed(c.env.DB, errandId, session.slack_user_id);
  if (!marked) return c.json({ error: "raced" }, 409);

  // Grant items. Resources flow through addResource (stack); everything else
  // is a fresh inventory row via addItem.
  for (const item of yieldData.items) {
    if (item.item_type === "resource") {
      await addResource(c.env.DB, session.slack_user_id, item.item_name, 1, item.rarity, item.blurb);
    } else {
      await addItem(c.env.DB, {
        character_id: session.slack_user_id,
        item_name: item.item_name,
        item_type: item.item_type,
        power: item.power,
        rarity: item.rarity,
        flavor: item.blurb,
        slot: item.slot ?? undefined,
        weapon_range: item.item_type === "weapon" ? "melee" : null,
      });
    }
  }
  // Gold + XP via awardSpoils so level-up flows fire normally.
  const spoils = await awardSpoils(
    c.env.DB,
    character,
    yieldData.xp,
    yieldData.gold,
    () => 1 + Math.floor(Math.random() * 6),
    xpForLevel,
  );
  // Trust bump (+1) + mark rare claimed if applicable.
  const newTrust = await bumpPubTrust(
    c.env.DB,
    session.slack_user_id,
    errand.patron_id,
    1,
    errand.kind === "rare",
    PUB_TRUST_CAP,
  );

  // Counter bumps for the errand achievement set.
  await bumpErrandStats(
    c.env.DB,
    session.slack_user_id,
    errand.kind as "courier" | "procure" | "investigate" | "mercy" | "rare",
    errand.tier as "short" | "medium" | "long",
  );

  // Achievement grants. Counters re-derived from in-memory character +
  // delta since we just bumped them in DB — saves a re-read.
  const grants: string[] = ["first_errand"];
  const newCourier = character.errands_courier         + (errand.kind === "courier"     ? 1 : 0);
  const newProcure = character.errands_procure         + (errand.kind === "procure"     ? 1 : 0);
  const newInvest  = character.errands_investigate     + (errand.kind === "investigate" ? 1 : 0);
  const newMercy   = character.errands_mercy           + (errand.kind === "mercy"       ? 1 : 0);
  const newLong    = character.errands_long            + (errand.tier === "long"        ? 1 : 0);
  if (newCourier >= 10) grants.push("courier_10");
  if (newProcure >= 10) grants.push("procure_10");
  if (newInvest  >=  5) grants.push("investigate_5");
  if (errand.kind === "mercy") grants.push("mercy_first");
  if (newMercy   >=  5) grants.push("mercy_5");
  if (errand.kind === "rare") grants.push("rare_errand");
  if (errand.tier === "long") grants.push("long_errand");
  if (newLong    >=  5) grants.push("long_errand_5");
  // Patron-trust achievements — need the snapshot AFTER bumpPubTrust above.
  // newTrust covers the patron we just worked with; check all three for
  // the "all patrons at max" achievement.
  if (newTrust.score >= PUB_TRUST_CAP) grants.push("patron_pillar");
  const allTrust = await listPubTrust(c.env.DB, session.slack_user_id);
  const allPatronIds = ["cobb", "marra", "rell"];
  const allMaxed = allPatronIds.every((pid) =>
    (allTrust.find((t) => t.patron_id === pid)?.score ?? 0) >= PUB_TRUST_CAP,
  );
  if (allMaxed) grants.push("patron_friend_all");
  for (const id of grants) {
    await grantAchievement(c.env.DB, session.slack_user_id, id);
  }

  return c.json({ ok: true, errand_id: errandId, yield: yieldData, spoils, trust: newTrust });
});

app.post("/api/pub/errands/cancel/:id", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const errandId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(errandId)) return c.json({ error: "bad_errand_id" }, 400);
  const errand = await getPubErrand(c.env.DB, errandId, session.slack_user_id);
  if (!errand) return c.json({ error: "not_yours" }, 404);
  if (errand.claimed_at) return c.json({ error: "already_claimed" }, 400);
  if (errand.cancelled_at) return c.json({ error: "already_cancelled" }, 400);
  const marked = await markPubErrandCancelled(c.env.DB, errandId, session.slack_user_id);
  if (!marked) return c.json({ error: "raced" }, 409);
  // Refund any Procure inputs.
  if (errand.input_resources) {
    for (const r of errand.input_resources) {
      await addResource(c.env.DB, session.slack_user_id, r.name, r.qty);
    }
  }
  // Release the offer so the next channel-mate can grab it (within the day).
  await c.env.DB
    .prepare("UPDATE pub_errand_offers SET taken_by = NULL WHERE taken_by = ?")
    .bind(errandId).run();
  return c.json({ ok: true });
});

// =============================================================================
// PUB COOKING — turn raw fish into cooked food consumables
// =============================================================================
//
// One endpoint, mirrors smithy forge / apothecary brew: validate fish + gold,
// consume both, drop a fresh consumable into inventory. Food items route
// through the same consumeItem (HP heal) path as Health Potions.

app.post("/api/pub/cook/:recipeId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const recipe = findCookRecipe(c.req.param("recipeId"));
  if (!recipe) return c.json({ error: "unknown_recipe" }, 404);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  if (character.level < recipe.level_req) {
    return c.json({ error: "level_too_low", needed: recipe.level_req, level: character.level }, 400);
  }
  if (character.gold < recipe.gold_cost) {
    return c.json({ error: "insufficient_gold", price: recipe.gold_cost, gold: character.gold }, 400);
  }
  const fishSpec = findResource(recipe.input_fish_id);
  if (!fishSpec) return c.json({ error: "unknown_fish" }, 500);
  const fishName = resourceItemName(recipe.input_fish_id);
  const consumed = await tryConsumeResource(c.env.DB, session.slack_user_id, fishName, recipe.input_qty);
  if (!consumed) {
    return c.json({ error: "insufficient_resources", needed: recipe.input_fish_id, qty: recipe.input_qty }, 400);
  }
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, recipe.gold_cost);
  if (!paid) {
    await addResource(c.env.DB, session.slack_user_id, fishName, recipe.input_qty);
    return c.json({ error: "insufficient_gold_race" }, 400);
  }
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: recipe.output_name,
    item_type: "consumable",
    power: recipe.output_power,
    rarity: recipe.output_rarity,
    flavor: recipe.output_blurb,
    weapon_range: null,
  });
  return c.json({
    ok: true,
    recipe_id: recipe.id,
    item,
    paid: recipe.gold_cost,
    consumed_fish: recipe.input_fish_id,
    gold_remaining: character.gold - recipe.gold_cost,
  });
});

// GET /api/pub — drink menu + active buff state. Channel-scoped via the
// player's most-recent quest (same fallback pattern as /api/shop).
app.get("/api/pub", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);

  // Daily special from town_state (optional — null means no special today).
  let dailySpecialId: string | null = null;
  if (channelId) {
    dailySpecialId = await getDailySpecialId(c.env.DB, channelId);
  }

  // Active drink buff from character row (column added by migration 0016_town,
  // not yet reflected in the @gantt-quest/db Character type, so raw query).
  const drinkBuffRow = await c.env.DB
    .prepare("SELECT drink_buff_json FROM characters WHERE slack_user_id = ?")
    .bind(session.slack_user_id)
    .first<{ drink_buff_json: string | null }>();
  const drinkBuff = drinkBuffRow?.drink_buff_json
    ? (JSON.parse(drinkBuffRow.drink_buff_json) as DrinkBuff)
    : null;

  const drinksWithPrice = DRINKS.map((d) => {
    const isSpecial = d.id === dailySpecialId;
    return {
      ...d,
      actual_price: isSpecial ? Math.floor(d.price * 0.7) : d.price,
      is_daily_special: isSpecial,
      fight_duration: d.effect.kind === "buff_attack" || d.effect.kind === "buff_magic",
    };
  });

  // SPD — current open match in the user's channel (if any)
  let spdData: {
    open_match: Record<string, unknown> | null;
    my_bet: { side: string; amount: number } | null;
    bet_totals: { initiator: number; challenger: number };
  } = { open_match: null, my_bet: null, bet_totals: { initiator: 0, challenger: 0 } };

  if (channelId) {
    // Sweep expired matches first
    await spdSweepExpired(c.env.DB, channelId);

    const openMatch = await c.env.DB
      .prepare(
        `SELECT id, channel_id, initiator_user_id, initiator_stake, challenger_user_id,
                status, winner_user_id, house_bump, created_at, resolved_at
         FROM spd_matches WHERE channel_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(channelId)
      .first<{
        id: number;
        channel_id: string;
        initiator_user_id: string;
        initiator_stake: number;
        challenger_user_id: string | null;
        status: string;
        winner_user_id: string | null;
        house_bump: number | null;
        created_at: number;
        resolved_at: number | null;
      }>();

    if (openMatch) {
      // Look up initiator name
      const initiatorChar = await getCharacter(c.env.DB, openMatch.initiator_user_id);

      const bets = await c.env.DB
        .prepare(`SELECT side, amount, bettor_user_id FROM spd_bets WHERE match_id = ?`)
        .bind(openMatch.id)
        .all<{ side: string; amount: number; bettor_user_id: string }>();

      const initiatorBetTotal = bets.results.filter((b) => b.side === "initiator").reduce((s, b) => s + b.amount, 0);
      const challengerBetTotal = bets.results.filter((b) => b.side === "challenger").reduce((s, b) => s + b.amount, 0);

      const myBet = bets.results.find((b) => b.bettor_user_id === session.slack_user_id);

      spdData = {
        open_match: {
          id: openMatch.id,
          initiator_user_id: openMatch.initiator_user_id,
          initiator_name: initiatorChar?.name ?? openMatch.initiator_user_id,
          initiator_stake: openMatch.initiator_stake,
          challenger_user_id: openMatch.challenger_user_id,
          status: openMatch.status,
          created_at: openMatch.created_at,
          expires_at: openMatch.created_at + SPD_EXPIRY_MS,
          // initiator_throw intentionally omitted
        },
        my_bet: myBet ? { side: myBet.side, amount: myBet.amount } : null,
        bet_totals: { initiator: initiatorBetTotal, challenger: challengerBetTotal },
      };
    }
  }

  const drinksSince = await c.env.DB
    .prepare("SELECT drinks_since_last_quest FROM characters WHERE slack_user_id = ?")
    .bind(session.slack_user_id)
    .first<{ drinks_since_last_quest: number }>();
  const drinksRemaining = Math.max(0, DRINK_CAP - (drinksSince?.drinks_since_last_quest ?? 0));

  // Load NPC specs from stale town state (no expiry — best-effort).
  let npcs: { bartender: NpcSpec | null; regulars: NpcSpec[] } = { bartender: null, regulars: [] };
  if (channelId) {
    const townState = await getStaleTownState(c.env.DB, channelId);
    if (townState?.pub) {
      npcs = { bartender: townState.pub.bartender, regulars: townState.pub.regulars };
    }
  }

  // Leaderboard — top earners across all pub games for this channel.
  let leaderboard: Array<{ user_id: string; name: string; slack_username: string | null; games: number; wins: number; net: number }> = [];
  if (channelId) {
    const rawLb = await getPubLeaderboard(c.env.DB, channelId);
    leaderboard = await Promise.all(
      rawLb.slice(0, 10).map(async (e) => {
        const char = await getCharacter(c.env.DB, e.user_id);
        return { user_id: e.user_id, name: char?.name ?? e.user_id, slack_username: char?.slack_username ?? null, games: e.games, wins: e.wins, net: e.net };
      }),
    );
  }

  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "pub_interior", undefined, TOWN_WEEKLY_MS);
  const hired_merc = character.hired_merc_id ? (findMerc(character.hired_merc_id) ?? null) : null;
  return c.json({ drinks: drinksWithPrice, drink_buff: drinkBuff, gold: character.gold, spd: spdData, art_url, drinks_remaining: drinksRemaining, npcs, leaderboard, mercs: MERCS, hired_merc });
});

// GET /api/pub/leaderboard — pub leaderboard with optional period filtering.
// ?period=week  → last 7 days
// ?period=all   → all-time (default)
app.get("/api/pub/leaderboard", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const channelId = character.channel_id;
  if (!channelId) return c.json({ entries: [] });
  const period = c.req.query("period") ?? "all";
  const now = Date.now();
  const since = period === "week" ? now - 7 * 24 * 60 * 60 * 1000 : undefined;
  const rawLb = await getPubLeaderboard(c.env.DB, channelId, since);
  const entries = await Promise.all(
    rawLb.slice(0, 10).map(async (e) => {
      const char = await getCharacter(c.env.DB, e.user_id);
      return { user_id: e.user_id, name: char?.name ?? e.user_id, slack_username: char?.slack_username ?? null, games: e.games, wins: e.wins, net: e.net };
    }),
  );
  return c.json({ entries });
});

// POST /api/pub/hire/:mercId — hire a mercenary from the pub.
app.post("/api/pub/hire/:mercId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);
  if (character.hired_merc_id) return c.json({ error: "already_hired" }, 400);

  const mercId = c.req.param("mercId");
  const spec = findMerc(mercId);
  if (!spec) return c.json({ error: "unknown_merc" }, 404);

  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, spec.cost);
  if (!paid) return c.json({ error: "insufficient_gold" }, 400);

  await setHiredMerc(c.env.DB, session.slack_user_id, mercId);
  return c.json({ ok: true });
});

// POST /api/pub/dismiss-merc — dismiss your hired mercenary (no refund).
app.post("/api/pub/dismiss-merc", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await clearHiredMerc(c.env.DB, session.slack_user_id);
  return c.json({ ok: true });
});

// POST /api/pub/drink/:drinkId — order a drink. Deducts gold, applies the
// effect immediately (instant) or stores a buff on the character.
app.post("/api/pub/drink/:drinkId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const drinkId = c.req.param("drinkId");
  const drink = findDrinkById(drinkId);
  if (!drink) return c.json({ error: "unknown_drink" }, 404);

  // Enforce drink cap between quests.
  const drinkRow = await c.env.DB
    .prepare("SELECT drinks_since_last_quest FROM characters WHERE slack_user_id = ?")
    .bind(session.slack_user_id)
    .first<{ drinks_since_last_quest: number }>();
  if ((drinkRow?.drinks_since_last_quest ?? 0) >= DRINK_CAP) {
    return c.json({ error: "drink_cap_reached", cap: DRINK_CAP }, 400);
  }

  // Daily special pricing.
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  let price = drink.price;
  if (channelId) {
    const specialId = await getDailySpecialId(c.env.DB, channelId);
    if (specialId === drink.id) price = Math.floor(drink.price * 0.7);
  }

  if (character.gold < price) return c.json({ error: "insufficient_gold", price, gold: character.gold }, 400);

  const ok = await tryDeductGold(c.env.DB, session.slack_user_id, price);
  if (!ok) return c.json({ error: "insufficient_gold_race" }, 400);

  const eff = drink.effect;
  let summary = "";
  let newBuff: DrinkBuff | null = null;

  switch (eff.kind) {
    case "buff_attack": {
      newBuff = { kind: "buff_attack", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id, fight_duration: true };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = `+${eff.magnitude} attack for this fight`;
      break;
    }
    case "buff_magic": {
      newBuff = { kind: "buff_magic", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id, fight_duration: true };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = `+${eff.magnitude} magic for this fight`;
      break;
    }
    case "buff_next_crit": {
      newBuff = { kind: "buff_next_crit", magnitude: 1, remaining: 1, drink_id: drink.id };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = "next attack/cast/ability is a guaranteed crit";
      break;
    }
    case "instant_shield": {
      const cap = character.max_hp * SHIELD_CAP_MULTIPLIER;
      const added = await addShield(c.env.DB, character, eff.amount, cap);
      summary = `+${added} shield`;
      break;
    }
    case "instant_hp": {
      const healed = await healCharacter(c.env.DB, character, eff.amount);
      summary = `+${healed} HP`;
      break;
    }
    case "instant_mana": {
      const added = await addMana(c.env.DB, character, eff.amount);
      summary = `+${added} mana`;
      break;
    }
    case "instant_combo": {
      const healed = await healCharacter(c.env.DB, character, eff.hp);
      const added = await addMana(c.env.DB, character, eff.mana);
      summary = `+${healed} HP, +${added} mana`;
      break;
    }
  }

  await c.env.DB
    .prepare("UPDATE characters SET drinks_since_last_quest = drinks_since_last_quest + 1, last_active = ? WHERE slack_user_id = ?")
    .bind(Date.now(), session.slack_user_id)
    .run();

  return c.json({ ok: true, drink_name: drink.name, emoji: drink.emoji, price, summary, drink_buff: newBuff });
});

// POST /api/pub/talk/:npcId — walk an NPC's dialog tree.
// Body: { path: string } — comma-separated option indices, "" = root.
// Returns { npc_says, options, payload_applied } for the reached node.
app.post("/api/pub/talk/:npcId", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const npcId = c.req.param("npcId");
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 400);

  const townState = await getStaleTownState(c.env.DB, channelId);
  if (!townState?.pub) return c.json({ error: "no_town_state" }, 404);

  const npc: NpcSpec | undefined =
    npcId === "bartender"
      ? townState.pub.bartender
      : townState.pub.regulars.find((r) => r.id === npcId);
  if (!npc) return c.json({ error: "npc_not_found" }, 404);

  const body = await c.req.json<{ path?: string }>().catch(() => ({ path: "" }));
  const rawPath = body.path ?? "";
  const indices = rawPath.split(",").filter((s) => s.length > 0).map((s) => parseInt(s, 10));

  let node: DialogNode = npc.dialog;
  let optionChosen: DialogOption | undefined;
  for (const idx of indices) {
    if (!node.options || idx < 0 || idx >= node.options.length) {
      return c.json({ error: "invalid_path" }, 400);
    }
    optionChosen = node.options[idx];
    node = optionChosen.next;
  }

  // Claim reward once per day per NPC path.
  let payloadApplied: string | null = null;
  if (optionChosen?.payload) {
    const today = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const claimed = await getClaimedNpcPaths(c.env.DB, channelId, session.slack_user_id, npc.id, today);
    const pathKey = indices.join(",");
    if (!claimed.has(pathKey)) {
      await recordClaimedNpcPath(c.env.DB, channelId, session.slack_user_id, npc.id, today, pathKey);
      payloadApplied = await applyNpcPayload(c.env.DB, character, optionChosen.payload);
    } else {
      payloadApplied = "(already claimed today)";
    }
  }

  return c.json({
    npc_says: node.npc_says,
    options: (node.options ?? []).map((o, i) => ({
      index: i,
      player_says: o.player_says,
      has_payload: !!o.payload,
    })),
    payload_applied: payloadApplied,
    is_terminal: !node.options || node.options.length === 0,
  });
});

async function applyNpcPayload(
  db: D1Database,
  character: Character,
  payload: DialogPayload,
): Promise<string> {
  if (payload.type === "rumor") {
    return `_${payload.text}_`;
  }
  if (payload.type === "gold") {
    await addGold(db, character.slack_user_id, payload.amount);
    return `+${payload.amount}g slides across the bar.`;
  }
  if (payload.type === "xp") {
    await db
      .prepare("UPDATE characters SET xp = xp + ?, last_active = ? WHERE slack_user_id = ?")
      .bind(payload.amount, Date.now(), character.slack_user_id)
      .run();
    return `+${payload.amount} XP — that story was worth something.`;
  }
  if (payload.type === "drink_token") {
    const drink = findDrinkById(payload.drink_id);
    if (!drink) return "";
    const eff = drink.effect;
    switch (eff.kind) {
      case "instant_hp": {
        const healed = await healCharacter(db, character, eff.amount);
        return `Free ${drink.name}: +${healed} HP.`;
      }
      case "instant_mana": {
        const added = await addMana(db, character, eff.amount);
        return `Free ${drink.name}: +${added} mana.`;
      }
      case "instant_shield": {
        const cap = character.max_hp * SHIELD_CAP_MULTIPLIER;
        const added = await addShield(db, character, eff.amount, cap);
        return `Free ${drink.name}: +${added} shield.`;
      }
      case "instant_combo": {
        const healed = await healCharacter(db, character, eff.hp);
        const added = await addMana(db, character, eff.mana);
        return `Free ${drink.name}: +${healed} HP, +${added} mana.`;
      }
      default:
        return `Free ${drink.name}.`;
    }
  }
  return "";
}

// POST /api/pub/liars/start — begin a Liars' Roll round. Body: { stake: number }.
// Rolls dice, generates bartender's claim, persists round, returns the
// player's dice + bartender's claim so the UI can render the decide prompt.
app.post("/api/pub/liars/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const body = await c.req.json<{ stake?: number }>().catch(() => ({ stake: undefined }));
  const stake = body.stake;
  if (typeof stake !== "number" || !Number.isInteger(stake) || stake < 1 || stake > 1000) {
    return c.json({ error: "invalid_stake" }, 400);
  }
  if (character.gold < stake) {
    return c.json({ error: "insufficient_gold", gold: character.gold }, 400);
  }

  const goldOk = await tryDeductGold(c.env.DB, session.slack_user_id, stake);
  if (!goldOk) return c.json({ error: "insufficient_gold_race" }, 400);

  const playerDice = rollThreeD6();
  const bartenderDice = rollThreeD6();
  const total = [...playerDice, ...bartenderDice].reduce((a, b) => a + b, 0);
  const truth = liarsZoneFor(total);

  const isLying = Math.random() >= LIARS_TRUTH_RATE;
  let claim: LiarsClaim;
  if (!isLying) {
    claim = truth;
  } else {
    const others = (["low", "medium", "high"] as LiarsClaim[]).filter((z) => z !== truth);
    claim = others[Math.floor(Math.random() * others.length)];
  }

  const channelId = (await recentChannelForUser(c.env.DB, session.slack_user_id, c.env)) ?? "web";
  const roundId = await createLiarsRound(c.env.DB, {
    user_id: session.slack_user_id,
    channel_id: channelId,
    stake,
    player_dice: playerDice,
    bartender_dice: bartenderDice,
    claim,
    lied: isLying,
  });

  const playerSum = playerDice.reduce((a, b) => a + b, 0);
  return c.json({
    round_id: roundId,
    stake,
    player_dice: playerDice,
    player_sum: playerSum,
    claim,
    claim_label: liarsZoneLabel(claim),
    trust_mult: LIARS_TRUST_MULT,
    challenge_mult: LIARS_CHALLENGE_MULT,
    house_cut_pct: Math.round(LIARS_HOUSE_CUT * 100),
  });
});

// POST /api/pub/liars/:roundId/decide — resolve a Liars' Roll round.
// Body: { choice: "trust" | "challenge" }. Race-safe via conditional UPDATE.
app.post("/api/pub/liars/:roundId/decide", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const roundId = parseInt(c.req.param("roundId"), 10);
  if (!Number.isFinite(roundId)) return c.json({ error: "bad_round_id" }, 400);

  const body = await c.req.json<{ choice?: string }>().catch(() => ({ choice: undefined }));
  if (body.choice !== "trust" && body.choice !== "challenge") {
    return c.json({ error: "invalid_choice" }, 400);
  }
  const choice = body.choice;

  const round = await getLiarsRound(c.env.DB, roundId);
  if (!round) return c.json({ error: "round_not_found" }, 404);
  if (round.user_id !== session.slack_user_id) return c.json({ error: "not_your_round" }, 403);
  if (round.status !== "open") return c.json({ error: "already_resolved" }, 400);

  const totalPlayer = round.player_dice.reduce((a, b) => a + b, 0);
  const totalBartender = round.bartender_dice.reduce((a, b) => a + b, 0);
  const combined = totalPlayer + totalBartender;
  const truth = liarsZoneFor(combined);
  const correct = choice === "trust" ? !round.lied : round.lied;

  let outcome: LiarsOutcome;
  let payout = 0;
  if (correct) {
    const mult = choice === "trust" ? LIARS_TRUST_MULT : LIARS_CHALLENGE_MULT;
    const gross = round.stake * mult;
    payout = Math.floor(gross * (1 - LIARS_HOUSE_CUT));
    outcome = choice === "trust" ? "trust_win" : "challenge_win";
  } else {
    outcome = choice === "trust" ? "trust_lose" : "challenge_lose";
  }

  const won = await finalizeLiarsRound(c.env.DB, roundId, outcome, payout);
  if (!won) return c.json({ error: "already_resolved_race" }, 409);

  if (payout > 0) {
    await addGold(c.env.DB, session.slack_user_id, payout);
  }

  const updatedChar = await getCharacter(c.env.DB, session.slack_user_id);

  return c.json({
    ok: true,
    outcome,
    correct,
    choice,
    lied: round.lied,
    truth,
    truth_label: liarsZoneLabel(truth),
    claim_label: liarsZoneLabel(round.claim),
    player_dice: round.player_dice,
    bartender_dice: round.bartender_dice,
    combined,
    payout,
    gold: updatedChar?.gold ?? 0,
  });
});

// =============================================================================
// SPD ENDPOINTS
// =============================================================================

// POST /api/pub/spd/start — initiator opens a new match.
// Body: { stake: 10|25|50, throw: "stone"|"parchment"|"dagger" }
app.post("/api/pub/spd/start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const activeQuest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (activeQuest) return c.json({ error: "mid_quest" }, 400);

  const body = await c.req.json<{ stake?: number; throw?: string }>().catch(() => ({} as { stake?: number; throw?: string }));
  const stake = body.stake;
  const throwChoice = body.throw;
  if (typeof stake !== "number" || !Number.isInteger(stake) || stake < 1 || stake > 1000) {
    return c.json({ error: "invalid_stake" }, 400);
  }
  if (throwChoice !== "stone" && throwChoice !== "parchment" && throwChoice !== "dagger") {
    return c.json({ error: "invalid_throw" }, 400);
  }

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  if (!channelId) return c.json({ error: "no_channel" }, 400);

  // Sweep expired matches
  await spdSweepExpired(c.env.DB, channelId);

  // Check for existing open match in channel
  const existing = await c.env.DB
    .prepare(`SELECT id FROM spd_matches WHERE channel_id = ? AND status = 'open' LIMIT 1`)
    .bind(channelId)
    .first<{ id: number }>();
  if (existing) return c.json({ error: "match_already_open", match_id: existing.id }, 409);

  // Check gold
  if (character.gold < stake) return c.json({ error: "insufficient_gold", gold: character.gold }, 400);
  const goldOk = await tryDeductGold(c.env.DB, session.slack_user_id, stake);
  if (!goldOk) return c.json({ error: "insufficient_gold_race" }, 400);

  const result = await c.env.DB
    .prepare(
      `INSERT INTO spd_matches (channel_id, initiator_user_id, initiator_stake, initiator_throw, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    )
    .bind(channelId, session.slack_user_id, stake, throwChoice, Date.now())
    .run();

  const matchId = result.meta.last_row_id as number;

  return c.json({ ok: true, match_id: matchId, status: "open" });
});

// POST /api/pub/spd/:matchId/accept — challenger picks throw and resolves instantly.
// Body: { throw: "stone"|"parchment"|"dagger" }
app.post("/api/pub/spd/:matchId/accept", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const matchId = parseInt(c.req.param("matchId"), 10);
  if (!Number.isFinite(matchId)) return c.json({ error: "bad_match_id" }, 400);

  const body = await c.req.json<{ throw?: string }>().catch(() => ({} as { throw?: string }));
  const throwChoice = body.throw;
  if (throwChoice !== "stone" && throwChoice !== "parchment" && throwChoice !== "dagger") {
    return c.json({ error: "invalid_throw" }, 400);
  }

  const match = await c.env.DB
    .prepare(`SELECT * FROM spd_matches WHERE id = ?`)
    .bind(matchId)
    .first<SpdMatchRow>();
  if (!match) return c.json({ error: "match_not_found" }, 404);
  if (match.status !== "open") return c.json({ error: "match_not_open" }, 409);
  if (match.initiator_user_id === session.slack_user_id) {
    return c.json({ error: "cant_accept_own_match" }, 400);
  }

  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.gold < match.initiator_stake) {
    return c.json({ error: "insufficient_gold", gold: character.gold }, 400);
  }

  // Race-safe: atomically claim the match
  const updateResult = await c.env.DB
    .prepare(
      `UPDATE spd_matches SET status = 'resolving', challenger_user_id = ?, challenger_throw = ?
       WHERE id = ? AND status = 'open'`,
    )
    .bind(session.slack_user_id, throwChoice, matchId)
    .run();
  if ((updateResult.meta.changes ?? 0) !== 1) return c.json({ error: "match_taken" }, 409);

  const goldOk = await tryDeductGold(c.env.DB, session.slack_user_id, match.initiator_stake);
  if (!goldOk) {
    // Rollback the claim
    await c.env.DB
      .prepare(
        `UPDATE spd_matches SET status = 'open', challenger_user_id = NULL, challenger_throw = NULL WHERE id = ?`,
      )
      .bind(matchId)
      .run();
    return c.json({ error: "insufficient_gold_race" }, 400);
  }

  // Reload match with challenger data
  const fullMatch = await c.env.DB
    .prepare(`SELECT * FROM spd_matches WHERE id = ?`)
    .bind(matchId)
    .first<SpdMatchRow>();
  if (!fullMatch) return c.json({ error: "match_not_found" }, 404);

  const resolution = await spdResolveMatch(c.env.DB, fullMatch);
  const updatedChar = await getCharacter(c.env.DB, session.slack_user_id);
  const initiatorChar = await getCharacter(c.env.DB, match.initiator_user_id);

  return c.json({
    ok: true,
    match_id: matchId,
    initiator_throw: match.initiator_throw,
    challenger_throw: throwChoice,
    tie: resolution.tie,
    winner_user_id: resolution.winner_user_id,
    payout: resolution.payout,
    house_bump: resolution.house_bump,
    gold: updatedChar?.gold ?? 0,
    initiator_name: initiatorChar?.name ?? match.initiator_user_id,
  });
});

// POST /api/pub/spd/:matchId/bet — place a side bet on an open match.
// Body: { side: "initiator"|"challenger", amount: 5|10|25 }
app.post("/api/pub/spd/:matchId/bet", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const matchId = parseInt(c.req.param("matchId"), 10);
  if (!Number.isFinite(matchId)) return c.json({ error: "bad_match_id" }, 400);

  const body = await c.req.json<{ side?: string; amount?: number }>().catch(() => ({} as { side?: string; amount?: number }));
  const side = body.side;
  const amount = body.amount;
  if (side !== "initiator" && side !== "challenger") {
    return c.json({ error: "invalid_side" }, 400);
  }
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 1000) {
    return c.json({ error: "invalid_bet_amount" }, 400);
  }

  const match = await c.env.DB
    .prepare(`SELECT * FROM spd_matches WHERE id = ?`)
    .bind(matchId)
    .first<SpdMatchRow>();
  if (!match) return c.json({ error: "match_not_found" }, 404);
  if (match.status !== "open") return c.json({ error: "match_not_open" }, 409);
  if (
    match.initiator_user_id === session.slack_user_id ||
    match.challenger_user_id === session.slack_user_id
  ) {
    return c.json({ error: "cant_bet_on_own_match" }, 400);
  }

  // One bet per user per match
  const existingBet = await c.env.DB
    .prepare(`SELECT 1 FROM spd_bets WHERE match_id = ? AND bettor_user_id = ?`)
    .bind(matchId, session.slack_user_id)
    .first();
  if (existingBet) return c.json({ error: "already_bet" }, 409);

  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (character.gold < amount) return c.json({ error: "insufficient_gold", gold: character.gold }, 400);

  const goldOk = await tryDeductGold(c.env.DB, session.slack_user_id, amount);
  if (!goldOk) return c.json({ error: "insufficient_gold_race" }, 400);

  await c.env.DB
    .prepare(
      `INSERT INTO spd_bets (match_id, bettor_user_id, side, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(matchId, session.slack_user_id, side, amount, Date.now())
    .run();

  const updatedChar = await getCharacter(c.env.DB, session.slack_user_id);
  return c.json({ ok: true, match_id: matchId, side, amount, gold: updatedChar?.gold ?? 0 });
});

// POST /api/pub/spd/:matchId/cancel — initiator cancels their open match.
app.post("/api/pub/spd/:matchId/cancel", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const matchId = parseInt(c.req.param("matchId"), 10);
  if (!Number.isFinite(matchId)) return c.json({ error: "bad_match_id" }, 400);

  const match = await c.env.DB
    .prepare(`SELECT * FROM spd_matches WHERE id = ?`)
    .bind(matchId)
    .first<SpdMatchRow>();
  if (!match) return c.json({ error: "match_not_found" }, 404);
  if (match.initiator_user_id !== session.slack_user_id) {
    return c.json({ error: "not_initiator" }, 403);
  }
  if (match.status !== "open") return c.json({ error: "match_not_open" }, 409);

  const updateResult = await c.env.DB
    .prepare(`UPDATE spd_matches SET status = 'cancelled' WHERE id = ? AND status = 'open'`)
    .bind(matchId)
    .run();
  if ((updateResult.meta.changes ?? 0) !== 1) return c.json({ error: "already_resolved" }, 409);

  // Refund stake
  await addGold(c.env.DB, session.slack_user_id, match.initiator_stake);

  // Refund any side bets
  const bets = await c.env.DB
    .prepare(`SELECT bettor_user_id, amount FROM spd_bets WHERE match_id = ?`)
    .bind(matchId)
    .all<{ bettor_user_id: string; amount: number }>();
  for (const bet of bets.results) {
    await addGold(c.env.DB, bet.bettor_user_id, bet.amount);
  }

  const updatedChar = await getCharacter(c.env.DB, session.slack_user_id);
  return c.json({ ok: true, match_id: matchId, refunded: match.initiator_stake, gold: updatedChar?.gold ?? 0 });
});

// Returns the user's currently-active quest (with scene state + party) or
// { quest: null } if they're not in one. Polled by the active-quest panel.
app.get("/api/quest/active", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest) return c.json({ quest: null });
  const party = await getQuestParty(c.env.DB, quest.id);
  // Expose whether engine-driven combat is *in progress* so the dashboard
  // can auto-resume the CombatPage on reload / back navigation. We treat
  // a row whose status is victory/defeat/fled as "no active combat" —
  // it lingers post-fight so the outcome stays replayable for a client
  // that missed the WS frame.
  const existingCombat = await getWebCombatState(c.env.DB, quest.id);
  const terminalStates = new Set(["victory", "defeat", "fled"]);
  const hasWebCombat = !!existingCombat && !terminalStates.has(existingCombat.status as string);
  const partyWithArmor = await Promise.all(party.map(async (m) => {
    const slots = await getAllEquippedSlots(c.env.DB, m.slack_user_id);
    return { ...m, armor_power: computeArmorPowerFromSlots(slots) };
  }));
  return c.json({ quest, party: partyWithArmor, has_web_combat: hasWebCombat });
});

async function webStartQuestFromLobby(
  questId: number,
  env: Env,
): Promise<void> {
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return;
  const party = await getLobbyParty(env.DB, questId);
  const accepted = party.filter((m) => m.invite_status === "accepted");

  await removePendingInvitees(env.DB, questId);
  await activateQuest(env.DB, questId);

  const joinerCount = Math.max(0, accepted.length - 1);
  const scene = preScaleForJoiners(quest.scene, joinerCount, JOIN_HP_RATIO);
  const finalScene = joinerCount > 0 ? addPackMonstersForParty(scene, accepted.length) : scene;
  await saveScene(env.DB, questId, finalScene);

  for (const m of accepted) {
    await refillMana(env.DB, m.slack_user_id);
    await appendLog(env.DB, questId, m.slack_user_id, "join", "lobby started via web");
  }
}

// Returns the current user's lobby quest + party if they have a pending invite or are in a lobby.
app.get("/api/quest/lobby", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quest = await getLobbyQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest) return c.json({ quest: null });
  const party = await getLobbyParty(c.env.DB, quest.id);
  return c.json({ quest, party });
});

// WebSocket upgrade for live lobby state + ephemeral chat. Falls back to
// the existing 4s polling on the client if the upgrade fails or LOBBY_ROOM
// isn't bound.
app.get("/api/quest/:id/lobby/ws", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return new Response("unauthenticated", { status: 401 });
  const questId = Number(c.req.param("id"));
  if (!Number.isFinite(questId)) return new Response("bad questId", { status: 400 });
  if (!c.env.LOBBY_ROOM) return new Response("lobby ws not enabled", { status: 503 });

  // Authorize: caller must be a party member (pending OR accepted) on this
  // quest. Otherwise anyone could subscribe to anyone else's lobby chat.
  const party = await getLobbyParty(c.env.DB, questId);
  const me = party.find((m) => m.slack_user_id === session.slack_user_id);
  if (!me) return new Response("not_in_party", { status: 403 });

  if (c.req.header("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const id = c.env.LOBBY_ROOM.idFromName(`lobby:${questId}`);
  const stub = c.env.LOBBY_ROOM.get(id);
  // Forward the original Request so the WS handshake headers
  // (Sec-WebSocket-Key, Connection: Upgrade, etc.) reach the DO intact.
  // Just rewrite the URL params so the DO can pick out quest/user.
  const url = new URL(c.req.url);
  url.searchParams.set("quest", String(questId));
  url.searchParams.set("user", session.slack_user_id);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

app.post("/api/quest/:id/lobby/accept", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const party = await getLobbyParty(c.env.DB, questId);
  const me = party.find((m) => m.slack_user_id === session.slack_user_id);
  if (!me || me.invite_status !== "pending") return c.json({ error: "not_pending" }, 400);
  await updateInviteStatus(c.env.DB, questId, session.slack_user_id, "accepted");
  c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
  return c.json({ ok: true });
});

app.post("/api/quest/:id/lobby/decline", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const party = await getLobbyParty(c.env.DB, questId);
  const me = party.find((m) => m.slack_user_id === session.slack_user_id);
  if (!me || me.invite_status !== "pending") return c.json({ error: "not_pending" }, 400);
  await updateInviteStatus(c.env.DB, questId, session.slack_user_id, "declined");
  c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
  return c.json({ ok: true });
});

app.post("/api/quest/:id/lobby/ready", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  const party = await getLobbyParty(c.env.DB, questId);
  const me = party.find((m) => m.slack_user_id === session.slack_user_id);

  // Two flows depending on quest status:
  //   * status=lobby (pre-combat): standard ready toggle, fire allReady check
  //   * status=active (reinforcement): a pending invitee readying up means
  //     "yes, pull me into the fight". We auto-accept + join combat in one shot.
  if (quest.status === "active") {
    // Reinforcement: invitee must be pending. We flip them straight to
    // accepted+ready, then pull them in via QuestRoom.notifyFighterJoined.
    if (!me || me.invite_status !== "pending") {
      return c.json({ error: "not_pending" }, 400);
    }
    await updateInviteStatus(c.env.DB, questId, session.slack_user_id, "accepted");
    await updateReadyStatus(c.env.DB, questId, session.slack_user_id, true);
    // Refill mana + scale monster HP, mirroring the /api/quest/join path.
    await refillMana(c.env.DB, session.slack_user_id);
    const scaled = await scaleMonsterForJoin(c.env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
    const doId = c.env.QUEST_ROOM.idFromName(`quest:${quest.id}`);
    const doStub = c.env.QUEST_ROOM.get(doId);
    c.executionCtx.waitUntil(
      (doStub as unknown as { notifyFighterJoined(q: number, u: string, hp: number): Promise<void> })
        .notifyFighterJoined(quest.id, session.slack_user_id, scaled.monster_max_hp)
        .catch((err) => console.warn("notifyFighterJoined (reinforcement) failed", err)),
    );
    c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
    return c.json({ ok: true, joined: true });
  }

  // Pre-combat lobby — original behavior.
  if (!me || me.invite_status !== "accepted") return c.json({ error: "not_accepted" }, 400);
  await updateReadyStatus(c.env.DB, questId, session.slack_user_id, true);

  // Re-fetch to check if all accepted are ready and no invites are still pending
  const updated = await getLobbyParty(c.env.DB, questId);
  const accepted = updated.filter((m) => m.invite_status === "accepted");
  const hasPending = updated.some((m) => m.invite_status === "pending");
  const allReady = !hasPending && accepted.length > 0 && accepted.every((m) => m.ready);
  if (allReady) {
    await webStartQuestFromLobby(questId, c.env);
    c.executionCtx.waitUntil(notifyLobbyStarted(c.env, questId));
  } else {
    c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
  }
  return c.json({ ok: true, started: allReady });
});

app.post("/api/quest/:id/lobby/force_start", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  if (quest.created_by !== session.slack_user_id) return c.json({ error: "not_creator" }, 403);
  if (quest.status !== "lobby") return c.json({ error: "not_in_lobby" }, 400);
  await webStartQuestFromLobby(questId, c.env);
  c.executionCtx.waitUntil(notifyLobbyStarted(c.env, questId));
  return c.json({ ok: true, started: true });
});

// Toggle creator-only join lock. Locked lobbies reject new invites; existing
// pending invitees can still accept/decline. Body: { locked: boolean }.
app.post("/api/quest/:id/lobby/lock", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  if (quest.created_by !== session.slack_user_id) return c.json({ error: "not_creator" }, 403);
  const body = await c.req.json<{ locked: boolean }>().catch(() => ({ locked: !quest.locked }));
  const newLocked = !!body?.locked;
  await setQuestLocked(c.env.DB, questId, newLocked);
  c.executionCtx.waitUntil(notifyLobbyLockChanged(c.env, questId, newLocked));
  c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
  return c.json({ ok: true, locked: newLocked });
});

// Cancel a lobby. Pre-combat: delete the quest entirely (no XP/gold/loot
// ever materialized, so this is a clean undo). Mid-combat reinforcement:
// drop the pending invitees, leave the active fight running.
app.post("/api/quest/:id/lobby/cancel", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  if (quest.created_by !== session.slack_user_id) return c.json({ error: "not_creator" }, 403);

  if (quest.status === "lobby") {
    await deleteQuestCascade(c.env.DB, questId);
    c.executionCtx.waitUntil(notifyLobbyCancelled(c.env, questId));
    return c.json({ ok: true, deleted: true });
  }
  if (quest.status === "active") {
    await removePendingInvitees(c.env.DB, questId);
    c.executionCtx.waitUntil(notifyLobbyCancelled(c.env, questId));
    return c.json({ ok: true, deleted: false });
  }
  return c.json({ error: "not_cancellable" }, 400);
});

// Open a reinforcement recruitment lobby on a quest that's already active.
// Doesn't modify the quest status — it just enables the LobbyView surface
// for the creator to start inviting. Reinforcement invitees use the normal
// /lobby/invite endpoint after this. No-op safe (idempotent).
app.post("/api/quest/:id/recruit", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  if (quest.created_by !== session.slack_user_id) return c.json({ error: "not_creator" }, 403);
  if (quest.status !== "active") return c.json({ error: "not_active" }, 400);
  // Just notify — the recruitment lobby becomes visible to the creator
  // immediately because /api/quest/lobby returns active quests with the
  // creator as a member (status=active, creator's invite_status='accepted').
  // The frontend can show the invite UI right away.
  c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));
  return c.json({ ok: true });
});

app.post("/api/quest/:id/lobby/invite", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const quest = await getLobbyQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "not_found" }, 404);
  if (quest.created_by !== session.slack_user_id) return c.json({ error: "not_creator" }, 403);
  if (quest.locked) return c.json({ error: "locked" }, 423);
  const body = await c.req.json<{ target_user_id: string }>();
  if (!body?.target_user_id) return c.json({ error: "missing_target" }, 400);
  // Verify the target exists on the same team
  const target = await c.env.DB
    .prepare(`SELECT slack_user_id, name, slack_username FROM characters WHERE slack_user_id = ? AND slack_team_id = ?`)
    .bind(body.target_user_id, session.slack_team_id)
    .first<{ slack_user_id: string; name: string; slack_username: string | null }>();
  if (!target) return c.json({ error: "not_found" }, 404);
  await addPendingInvitee(c.env.DB, questId, body.target_user_id);
  c.executionCtx.waitUntil(notifyLobbyStateChanged(c.env, questId));

  return c.json({ ok: true });
});

// Quest party chat — ephemeral, scoped to quest lifetime.
// Only party members (lobby or active) can read/write.
app.get("/api/quest/:id/chat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const since = Number(c.req.query("since") ?? "0");
  // Verify membership
  const member = await c.env.DB
    .prepare(`SELECT character_id FROM quest_party WHERE quest_id = ? AND character_id = ?`)
    .bind(questId, session.slack_user_id).first();
  if (!member) return c.json({ error: "not_in_party" }, 403);
  const rows = await c.env.DB
    .prepare(`SELECT id, user_id, user_name, message, created_at FROM quest_chat WHERE quest_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 100`)
    .bind(questId, since).all<{ id: number; user_id: string; user_name: string; message: string; created_at: number }>();
  return c.json({ messages: rows.results ?? [] });
});

app.post("/api/quest/:id/chat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = Number(c.req.param("id"));
  const member = await c.env.DB
    .prepare(`SELECT character_id FROM quest_party WHERE quest_id = ? AND character_id = ?`)
    .bind(questId, session.slack_user_id).first();
  if (!member) return c.json({ error: "not_in_party" }, 403);
  const body = await c.req.json<{ message: string }>();
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 300) : "";
  if (!message) return c.json({ error: "empty" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  const now = Date.now();
  const result = await c.env.DB
    .prepare(`INSERT INTO quest_chat (quest_id, user_id, user_name, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(questId, session.slack_user_id, character?.name ?? "Unknown", message, now)
    .run();
  return c.json({ ok: true, id: result.meta.last_row_id, created_at: now });
});

// Most-recent completed/failed quests for the signed-in user. Used to render
// the history card.
app.get("/api/quests/recent", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quests = await getRecentQuestsForCharacter(
    c.env.DB,
    session.slack_user_id,
    15,
  );
  return c.json({ quests });
});

// Lifetime quest stats for the signed-in character: wins/losses, streaks,
// elite count, and per-variant breakdown.
app.get("/api/stats", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const stats = await getQuestStatsForCharacter(c.env.DB, session.slack_user_id);
  return c.json(stats);
});

// Global quest leaderboard — top players by total wins.
// ?period=week  → last 7 days
// ?period=all   → all-time (default)
app.get("/api/leaderboard", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const period = c.req.query("period") ?? "all";
  const now = Date.now();
  const since =
    period === "week" ? now - 7 * 24 * 60 * 60 * 1000 :
    undefined;
  const entries = await getQuestLeaderboard(c.env.DB, 10, since);
  return c.json({ entries });
});

// Top climbers, ordered by deepest floor reached. Public-ish: same session
// check as the quest leaderboard so the page only renders for signed-in users.
app.get("/api/leaderboard/tower", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const entries = await getTowerLeaderboard(c.env.DB, 10);
  return c.json({ entries });
});

// Camp mini-game leaderboard. Phase 1 surfaces mining "Veins Struck" only;
// rows include forage_rare_finds and fish_best_ms so the UI can add their
// rankings when those games ship without a new endpoint.
app.get("/api/leaderboard/harvest", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const entries = await getHarvestLeaderboard(c.env.DB, 10);
  return c.json({ entries });
});

// Tower: bank the cycle's spoils and exit gracefully. Only valid while the
// scene is parked at tower_awaiting_choice (set on boss kill). The boss
// hoard was already granted by advanceTowerAfterCombat; this just closes
// the quest so the player can return to town.
app.post("/api/quest/:id/tower/exit", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "no_quest" }, 404);
  if (quest.scene.variant !== "tower") return c.json({ error: "not_tower" }, 400);
  if (!quest.scene.tower_awaiting_choice) return c.json({ error: "not_awaiting_choice" }, 400);
  await markQuestStatus(c.env.DB, questId, "completed");
  await clearHiredMercForParty(c.env.DB, questId);
  return c.json({ ok: true, floors_climbed: quest.scene.tower_floor ?? 0 });
});

// Tower: press on into the next 10-floor cycle. Builds a fresh segment
// starting at floor (current + 1), clears awaiting_choice, and stages the
// first floor as the new active scene.
app.post("/api/quest/:id/tower/continue", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "no_quest" }, 404);
  if (quest.scene.variant !== "tower") return c.json({ error: "not_tower" }, 400);
  if (!quest.scene.tower_awaiting_choice) return c.json({ error: "not_awaiting_choice" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);

  const startFloor = (quest.scene.tower_floor ?? 0) + 1;
  const cycle = (quest.scene.tower_cycle ?? 1) + 1;
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id, c.env);
  const avoidNames = channelId ? await getRecentMonsterNames(c.env.DB, channelId, 6) : [];
  const { floors } = await buildTowerSegment(c.env, character, startFloor, avoidNames);
  const [first, ...rest] = floors;
  const newScene = towerSceneFromPlan(first, rest, cycle, quest.scene.tower_kills_run ?? 0);
  await saveScene(c.env.DB, questId, newScene);
  await setQuestMode(c.env.DB, questId, "web");
  return c.json({ ok: true, scene: { floor: newScene.tower_floor, cycle: newScene.tower_cycle, kind: newScene.tower_floor_kind } });
});

// Tower rest stop — claim one item from the merchant. Each party member can
// claim at most one item per rest stop; each item can only be claimed by
// one player. Healing happened at floor entry (in advanceTowerAfterCombat),
// so this endpoint is purely about loot distribution. The floor does NOT
// advance on a pick — players hit /tower/rest_advance when they're done.
app.post("/api/quest/:id/tower/rest_pick", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "no_quest" }, 404);
  if (quest.scene.variant !== "tower") return c.json({ error: "not_tower" }, 400);
  if (quest.scene.tower_floor_kind !== "rest") return c.json({ error: "not_rest_floor" }, 400);
  const body = await c.req.json().catch(() => null) as { index?: unknown } | null;
  const idxRaw = body?.index;
  const idx = typeof idxRaw === "number" ? idxRaw : null;
  const stock = quest.scene.tower_rest_stock ?? [];
  if (idx === null || idx < 0 || idx >= stock.length) {
    return c.json({ error: "bad_index" }, 400);
  }
  const claims = { ...(quest.scene.tower_rest_claims ?? {}) };
  if (claims[String(idx)]) {
    return c.json({ error: "already_claimed", claimed_by: claims[String(idx)] }, 409);
  }
  if (Object.values(claims).includes(session.slack_user_id)) {
    return c.json({ error: "already_claimed_other_item" }, 409);
  }
  const picked = stock[idx];

  await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: picked.name,
    item_type: picked.item_type,
    power: picked.power,
    rarity: picked.rarity,
    flavor: picked.flavor,
    weapon_range: picked.weapon_range ?? null,
    slot: picked.slot ?? undefined,
    stat_bonus: picked.stat_bonus ?? undefined,
    item_subtype: picked.item_subtype ?? undefined,
  });

  claims[String(idx)] = session.slack_user_id;
  const updatedScene: SceneJson = { ...quest.scene, tower_rest_claims: claims };
  await saveScene(c.env.DB, questId, updatedScene);

  return c.json({
    ok: true,
    picked: { name: picked.name, rarity: picked.rarity, power: picked.power },
    claims,
  });
});

// Tower rest stop — leave the merchant and engage the next combat floor.
// Pops the next plan off tower_queue, builds the new scene, flips mode back
// to web so the client can start_web_combat into the next fight.
app.post("/api/quest/:id/tower/rest_advance", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getQuestById(c.env.DB, questId);
  if (!quest) return c.json({ error: "no_quest" }, 404);
  if (quest.scene.variant !== "tower") return c.json({ error: "not_tower" }, 400);
  if (quest.scene.tower_floor_kind !== "rest") return c.json({ error: "not_rest_floor" }, 400);
  const queue = quest.scene.tower_queue ?? [];
  const [next, ...remaining] = queue;
  if (!next) {
    return c.json({ error: "empty_queue" }, 500);
  }
  const newScene = towerSceneFromPlan(next, remaining, quest.scene.tower_cycle ?? 1, quest.scene.tower_kills_run ?? 0);
  await saveScene(c.env.DB, questId, newScene);
  await setQuestMode(c.env.DB, questId, "web");
  return c.json({
    ok: true,
    next: { floor: newScene.tower_floor, kind: newScene.tower_floor_kind, monster: newScene.monster_name },
  });
});

// Starts (or resumes) web-mode combat for the user's active quest. Snapshots
// the party + monster from D1 into a CombatState, rolls initiative, and saves
// to web_combat_state. Idempotent: if a state already exists for this quest,
// the existing one is returned untouched so a refresh in the middle of a
// fight doesn't reset progress.
//
// v1 limits: standard + boss variants only. Gauntlet stays on Slack.
app.post("/api/quest/:id/start_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);

  // If a previous combat ended (victory / defeat / fled) the row lingers so
  // the broadcast outcome stays replayable. Don't return that stale state to
  // a fresh Engage click — clear it and rebuild instead.
  const existing = await getWebCombatState(c.env.DB, questId);
  if (existing) {
    const endStates = new Set(["victory", "defeat", "fled"]);
    if (endStates.has(existing.status as string)) {
      await deleteWebCombatState(c.env.DB, questId);
    } else {
      return c.json({ quest_id: questId, state: existing });
    }
  }

  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) {
    return c.json({ error: "quest_not_active_for_user" }, 404);
  }
  // Mode lock removed — engine path enables both surfaces on the same
  // web_combat_state row. start_web_combat is idempotent: if state already
  // exists (e.g. Slack /gq attack already ran bootstrapFromSlack), the
  // earlier check above returned the existing state.
  const built = await buildInitialCombatState(c.env.DB, quest);
  if (!built.ok) {
    if (built.reason === "non_combat_room") {
      return c.json({ error: "non_combat_room", room_type: built.detail ?? null }, 400);
    }
    return c.json({ error: built.reason, variant: built.detail }, 400);
  }
  // Pub drink buffs survive into the engine fight — same helper used by
  // the DO's bootstrapFromSlack path so both surfaces seed identically.
  const seededWithBuffs = await seedDrinkBuffs(c.env.DB, built.seeded);
  const begun = step(seededWithBuffs, { kind: "begin" }, productionRoll);
  const afterMercs = drainAllyNpcTurns(begun);
  await saveWebCombatState(c.env.DB, questId, afterMercs.state);
  // Lock the quest into web mode so Slack combat handlers refuse further
  // /sq attack actions on it. Once flipped to 'web' it stays there for the
  // life of this quest (no automatic unlock on web combat end — the quest
  // is over either way).
  await setQuestMode(c.env.DB, questId, "web");
  // Wake the QuestRoom DO and have it broadcast the fresh state to any
  // WS clients that connected before combat started. Without this nudge
  // the client hangs on "Connecting to combat…" until a manual refresh.
  const doId = c.env.QUEST_ROOM.idFromName(`quest:${questId}`);
  const doStub = c.env.QUEST_ROOM.get(doId);
  c.executionCtx.waitUntil(
    (doStub as unknown as { notifyCombatStarted(q: number): Promise<void> })
      .notifyCombatStarted(questId)
      .catch((err) => console.warn("notifyCombatStarted failed", err)),
  );
  return c.json({ quest_id: questId, state: afterMercs.state });
});

// Clears the web combat state for a quest. Used when the player exits the
// combat page. Doesn't touch the underlying quest row — quest outcome
// resolution (XP/gold/loot) lives in Phase 2d.
app.post("/api/quest/:id/end_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.json({ error: "not_in_party" }, 403);
  }
  await deleteWebCombatState(c.env.DB, questId);
  return c.json({ ok: true });
});

// WS upgrade for live combat. Session-gated and party-membership-checked
// (the user must be in this quest's party). The DO is keyed by quest_id so
// every party member talking about quest 42 lands in the same instance.
app.get("/api/ws/quest/:id", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.text("unauthenticated", 401);

  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.text("bad quest id", 400);

  // Party-membership gate. We won't ship action authorization from inside
  // the DO; that's the worker's job before we hand off the WS.
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.text("not in party", 403);
  }

  const doId = c.env.QUEST_ROOM.idFromName(`quest:${questId}`);
  const stub = c.env.QUEST_ROOM.get(doId);
  // Pass quest_id + user_id along so the DO knows who connected.
  const url = new URL(c.req.url);
  url.searchParams.set("quest", String(questId));
  url.searchParams.set("user", session.slack_user_id);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Health check. Anything else falls through to the ASSETS binding via the
// wrangler `not_found_handling: single-page-application` config.
app.get("/api/health", (c) => c.json({ ok: true }));

// DEV ONLY — dev tool actions (heal, mana, gold, revive, cooldown reset).
app.post("/api/dev/heal", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await c.env.DB.prepare("UPDATE characters SET hp = max_hp WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  return c.json({ ok: true });
});

app.post("/api/dev/mana", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await c.env.DB.prepare("UPDATE characters SET mana = max_mana WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  return c.json({ ok: true });
});

app.post("/api/dev/gold", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ amount?: unknown }>();
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("UPDATE characters SET gold = gold + ? WHERE slack_user_id = ?")
    .bind(amount, session.slack_user_id).run();
  return c.json({ ok: true });
});

app.post("/api/dev/revive", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await c.env.DB.prepare("UPDATE characters SET downed_until = NULL, hp = max_hp WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  return c.json({ ok: true });
});

app.post("/api/dev/cooldowns", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  await c.env.DB
    .prepare("UPDATE characters SET last_rest_at = NULL, last_long_rest_at = NULL, drinks_since_last_quest = 0 WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  await c.env.DB.prepare("DELETE FROM shop_stock WHERE channel_id = ?").bind("local-dev").run();
  await c.env.DB.prepare("DELETE FROM smithy_stock WHERE channel_id = ?").bind("local-dev").run();
  // Camp: fast-forward any in-flight gather tasks so the next status fetch
  // rolls + persists their yields. Lets local dev exercise the toast flow
  // without waiting 15 minutes.
  await c.env.DB
    .prepare("UPDATE gathering_tasks SET expires_at = ? WHERE character_id = ? AND claimed_at IS NULL")
    .bind(Date.now() - 1000, session.slack_user_id).run();
  // Same treatment for pub errands.
  await c.env.DB
    .prepare("UPDATE pub_errands SET expires_at = ? WHERE character_id = ? AND claimed_at IS NULL AND cancelled_at IS NULL")
    .bind(Date.now() - 1000, session.slack_user_id).run();
  return c.json({ ok: true });
});

app.post("/api/dev/level", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ level?: unknown }>();
  const targetLevel = Math.floor(Number(body.level));
  if (!Number.isFinite(targetLevel) || targetLevel < 1 || targetLevel > 99) return c.json({ error: "invalid" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const cls = classByName(character.class);
  // Auto-alloc stats are fully deterministic from class + level. Free-point
  // spends are not tracked per-level, so we reset to the clean baseline and
  // restore all free points for the target level.
  const stats = statsAtLevel(character.class, targetLevel);
  const maxMana = deriveMaxMana(stats.int_stat, targetLevel);
  // HP: use class base_hp + 3 per level above 1 (≈ avg d6 rounded down).
  const maxHp = cls.base_hp + Math.max(0, targetLevel - 1) * 3;
  const newXp = xpForLevel(targetLevel);
  const unspentPoints = (targetLevel - 1) * FREE_POINTS_PER_LEVEL;
  await c.env.DB
    .prepare(`UPDATE characters
       SET level = ?, xp = ?,
           str = ?, int_stat = ?, vit = ?, agi = ?, dex = ?,
           unspent_points = ?,
           max_hp = ?, hp = ?,
           max_mana = ?, mana = ?,
           last_active = ?
       WHERE slack_user_id = ?`)
    .bind(
      targetLevel, newXp,
      stats.str, stats.int_stat, stats.vit, stats.agi, stats.dex,
      unspentPoints,
      maxHp, maxHp,
      maxMana, maxMana,
      Date.now(), session.slack_user_id,
    ).run();
  return c.json({ ok: true });
});

const DEV_ITEM_TYPES = ["weapon", "armor", "consumable", "magic", "revive", "tool", "scroll"] as const;
const DEV_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
const DEV_WEAPON_RANGES = ["melee", "ranged", "focus"] as const;
const DEV_EQUIP_SLOTS = ["main_hand", "off_hand", "body", "helmet", "pants", "boots", "ring", "amulet"] as const;
const DEV_ELEMENTS = ["fire", "ice", "lightning"] as const;

app.post("/api/dev/item", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const type = body.type as string;
  const name = body.name;
  const power = Math.floor(Number(body.power));
  const rarity = body.rarity as string;
  const weaponRange = body.weapon_range as string | undefined;
  const slot = body.slot as string | undefined;
  const element = body.element as string | undefined;
  const statBonus = body.stat_bonus as Record<string, number> | undefined;
  if (!(DEV_ITEM_TYPES as readonly string[]).includes(type)) return c.json({ error: "invalid type" }, 400);
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "invalid name" }, 400);
  if (!Number.isFinite(power) || power < 0 || power > 999) return c.json({ error: "invalid power" }, 400);
  if (!(DEV_RARITIES as readonly string[]).includes(rarity)) return c.json({ error: "invalid rarity" }, 400);
  if (type === "weapon" && !(DEV_WEAPON_RANGES as readonly string[]).includes(weaponRange ?? "")) return c.json({ error: "invalid weapon_range" }, 400);
  if (slot && !(DEV_EQUIP_SLOTS as readonly string[]).includes(slot)) return c.json({ error: "invalid slot" }, 400);
  if (element && !(DEV_ELEMENTS as readonly string[]).includes(element)) return c.json({ error: "invalid element" }, 400);
  await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: name.trim(),
    item_type: type as ItemType,
    power,
    rarity: rarity as Rarity,
    flavor: "A dev-spawned item.",
    weapon_range: (weaponRange as import("@gantt-quest/core").WeaponRange) ?? null,
    slot: (slot as import("@gantt-quest/core").EquipSlot) ?? null,
    element: (element as ElementType) ?? null,
    stat_bonus: statBonus ?? null,
    level_req: 0,
  });
  return c.json({ ok: true });
});

// DEV ONLY — heal/mana restore that also patches the in-flight combat state
// so the DO re-broadcasts the corrected HP/mana on the next WebSocket connect.
async function devPatchCombatState(
  db: D1Database,
  userId: string,
  questId: number,
  field: "hp" | "mana",
): Promise<void> {
  const snap = await getWebCombatSnapshot(db, questId);
  if (!snap) return;
  const state = snap.state;
  const idx = state.fighters.findIndex((f) => f.id === userId);
  if (idx === -1) return;
  const fighter = state.fighters[idx];
  const patched = { ...fighter, [field]: field === "hp" ? fighter.max_hp : fighter.max_mana };
  const newFighters = [...state.fighters];
  newFighters[idx] = patched;
  await saveWebCombatState(db, questId, { ...state, fighters: newFighters });
}

app.post("/api/dev/combat-heal", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ questId?: unknown }>();
  const questId = Number(body.questId);
  if (!Number.isFinite(questId)) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("UPDATE characters SET hp = max_hp WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  await devPatchCombatState(c.env.DB, session.slack_user_id, questId, "hp");
  return c.json({ ok: true });
});

app.post("/api/dev/combat-mana", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ questId?: unknown }>();
  const questId = Number(body.questId);
  if (!Number.isFinite(questId)) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("UPDATE characters SET mana = max_mana WHERE slack_user_id = ?")
    .bind(session.slack_user_id).run();
  await devPatchCombatState(c.env.DB, session.slack_user_id, questId, "mana");
  return c.json({ ok: true });
});

app.post("/api/dev/combat-kill-enemies", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const session = await currentSession(c.env.DB, c.req.header("Cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ questId?: unknown }>();
  const questId = Number(body.questId);
  if (!Number.isFinite(questId)) return c.json({ error: "invalid" }, 400);
  const doId = c.env.QUEST_ROOM.idFromName(`quest:${questId}`);
  const doStub = c.env.QUEST_ROOM.get(doId);
  await (doStub as unknown as { devKillEnemies(q: number): Promise<{ ok: boolean }> }).devKillEnemies(questId);
  return c.json({ ok: true });
});

// DEV ONLY — bypasses Slack login by creating/reusing a local dev character.
app.post("/api/dev/login", async (c) => {
  if (c.env.ENVIRONMENT !== "local") return c.json({ error: "forbidden" }, 403);
  const DEV_USER = "dev-user";
  const DEV_TEAM = "dev-team";
  const existing = await getCharacter(c.env.DB, DEV_USER);
  if (!existing) {
    const cls = pickRandomClass();
    const hp = cls.base_hp + rollDice(4);
    const gender: CharGender = rollDice(2) === 1 ? "m" : "f";
    await createCharacter(c.env.DB, {
      slack_user_id: DEV_USER,
      slack_team_id: DEV_TEAM,
      name: "Dev Hero",
      class: cls.name,
      hp,
      max_hp: hp,
      gender,
    });
  }
  const { code } = await issueWebLoginCode(c.env.DB, DEV_USER, DEV_TEAM);
  return c.json({ code });
});

async function currentSession(db: D1Database, cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)sq_session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  return getWebSession(db, decodeURIComponent(match[1]));
}

export default app;

// ─── Durable Object ─────────────────────────────────────────────────────────
//
// QuestRoom owns one quest's live combat. Followed rules (per
// memory/feedback_durable_objects.md):
//   1. WebSocket Hibernation API — ctx.acceptWebSocket() lets the DO sleep
//      between turns without dropping the connection or billing active.
//   2. D1 is the system of record — every step() result is persisted via
//      saveWebCombatState before broadcasting. Instance-variable caches
//      (this.cache*) survive only within an active execution; on wake we
//      rehydrate from D1.
//   3. No setTimeout/setInterval — DO Alarms or lazy-on-action timing only.
//   4. No background tickers — status effects apply on the actor's next turn.
//   5. Idle WS disconnect — connection inactivity is fine; the DO closes
//      sockets the runtime tells it have gone away. (No explicit timer here
//      — adding it would need DO Alarms, deferred until we see real abuse.)

// Item-use action lives outside the engine (it does D1 I/O for inventory
// load + delete, which the pure machine can't do). The DO dispatches it
// before falling through to step() for engine-handled actions.
type UseItemAction = {
  kind: "use_item";
  actor: string;
  item_id: number;
  target_id?: string;
};

interface ClientToServer {
  type: "action" | "ping";
  action: TurnAction | UseItemAction;
}

export type ItemEffect =
  | { kind: "heal"; target: string; amount: number; rolled: number }
  | { kind: "mana_restore"; target: string; added: number; new_mana: number }
  | { kind: "mana_bump"; target: string; added: number; new_max_mana: number }
  | { kind: "revive"; target: string; hp_restored: number }
  | { kind: "monster_damage"; amount: number; capped_from?: number }
  | { kind: "self_effect"; target: string; effect: "regen" | "empowered"; magnitude: number; remaining: number }
  | {
      kind: "monster_effect";
      effect: "poisoned" | "bleeding" | "burning";
      magnitude: number;
      remaining: number;
    }
  | { kind: "party_mana_refill"; recipients: { user_id: string; restored: number }[] };

export interface ItemUsedEvent {
  type: "item_used";
  actor: string;
  item_id: number;
  item_name: string;
  item_type: string;
  effect: ItemEffect;
}

export interface LootDrop {
  item_name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string;
  weapon_range: "melee" | "ranged" | "focus" | null;
  level_req: number;
}

export interface FighterReward {
  user_id: string;
  damage_dealt: number;
  damage_taken: number;
  healing_done: number;
  shielding_done: number;
  kills: number;
  xp_awarded: number;
  gold_awarded: number;
  level_up: boolean;
  new_level: number;
  loot: LootDrop[];
  // Populated only on defeat for fighters at 0 HP.
  soft_death: { gold_lost: number; item_lost: string | null; scar: string } | null;
}

export interface OutcomeSummary {
  status: "victory" | "defeat" | "fled";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
  // Tower-only: true when the cleared combat was a tower floor that flipped
  // the scene into the next floor (combat / rest) or post-boss
  // awaiting-choice state. Quest stays active; web client re-fetches the
  // scene to render the next floor card.
  tower_floor_cleared?: boolean;
  tower_next_floor_kind?: "combat" | "rest" | "boss";
  tower_awaiting_choice?: boolean;
  tower_cycle_complete?: boolean;
}

interface ServerToClient {
  type: "state" | "events" | "error" | "outcome" | "flavor" | "log_replay";
  state?: CombatState;
  events?: unknown[];
  message?: string;
  outcome?: OutcomeSummary;
  quest_id?: number;
  // Flavor messages reference the originating event via the corresponding
  // actor (so the client can render alongside the right combat moment).
  flavor?: {
    kind: "hit" | "victory" | "death" | "flee";
    actor: string;
    text: string;
  };
}

// End-of-combat side-effects:
//   - Victory: contribution-proportional XP + gold split, scaled for boss
//     (×2) / elite (×1.5); awardSpoils handles level-ups; per-fighter loot
//     roll using existing dropChance / rollItem helpers.
//   - Defeat: applySoftDeath for any fighter at 0 HP (25% gold loss, 1
//     random item drop, downed timer, +1 scar). Survivors keep their final
//     HP and shield from the combat state.
//   - Either way: mark the quest completed/failed.
async function applyWebCombatOutcome(
  env: Env,
  questId: number,
  state: CombatState,
  killedBy?: string,
): Promise<OutcomeSummary> {
  const won = state.status === "victory";
  const primaryMonster = state.monsters[0];
  const tier = primaryMonster.tier;
  const isBoss = primaryMonster.is_boss;
  const eliteRow = await env.DB.prepare("SELECT elite FROM quests WHERE id = ?")
    .bind(questId)
    .first<{ elite: number }>();
  const elite = eliteRow?.elite === 1;

  const multiplier =
    (isBoss ? BOSS_REWARD_MULTIPLIER : 1) * (elite ? ELITE_REWARD_MULTIPLIER : 1);
  const totalPoolXp = won ? Math.round(baseRewardXp(tier) * multiplier * partyXpBonus(state.fighters.length)) : 0;
  const totalPoolGold = won ? Math.round(baseRewardGold(tier) * multiplier) : 0;

  // Two-pool reward split, favoring party balance:
  //   * Participation pool (PARTICIPATION_POOL_PCT of total): every fighter
  //     gets an equal share. Compensates supports and lower-damage fighters
  //     who carry their weight in other ways (healing, soaking damage,
  //     drawing aggro that doesn't register as "contribution").
  //   * Contribution pool (1 - PARTICIPATION_POOL_PCT): split proportional
  //     to damage_dealt + 0.75 × healing_done + 0.5 × shielding_done.
  //     Damage-dealers still clearly top the board, just not 5×.
  //
  // Empirical re-balance: previous formula left supports getting ~13% of
  // a fight's pool while damage dealers got ~70%. With 40/60 the spread
  // tightens to roughly 22–27% support vs 50–55% top dealer.
  const PARTICIPATION_POOL_PCT = 0.4;
  // Ally NPCs (mercs, summoned) are excluded from reward calculations — they
  // deal damage but earn nothing and don't count toward the party-size pool.
  const humanFighters = state.fighters.filter((f) => !isAllyNpcActor(f.id));
  const contributions = humanFighters.map((f) => {
    const fs = state.stats?.[f.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 };
    const supportCredit = Math.floor(fs.healing_done * 3 / 4) + Math.floor(fs.shielding_done / 2);
    return {
      id: f.id,
      // Floor at 1 so a zero-everything fighter still gets > 0 contribution
      // share (otherwise the contribution pool divides by zero when the whole
      // party is somehow zero-points — rare but possible).
      points: Math.max(1, (state.contribution[f.id] ?? 0) + supportCredit),
    };
  });
  const totalContribution = contributions.reduce((s, f) => s + f.points, 0);
  const xpShares: Record<string, number> = {};
  const goldShares: Record<string, number> = {};
  if (won) {
    const partySize = humanFighters.length || 1;
    const participationXp = Math.floor(totalPoolXp * PARTICIPATION_POOL_PCT);
    const participationGold = Math.floor(totalPoolGold * PARTICIPATION_POOL_PCT);
    const contributionXp = totalPoolXp - participationXp;
    const contributionGold = totalPoolGold - participationGold;
    const equalXp = Math.floor(participationXp / partySize);
    const equalGold = Math.floor(participationGold / partySize);

    let xpRemainder = totalPoolXp;
    let goldRemainder = totalPoolGold;
    for (const fighter of contributions) {
      const ratio = fighter.points / totalContribution;
      const xpShare = equalXp + Math.floor(ratio * contributionXp);
      const goldShare = equalGold + Math.floor(ratio * contributionGold);
      xpShares[fighter.id] = xpShare;
      goldShares[fighter.id] = goldShare;
      xpRemainder -= xpShare;
      goldRemainder -= goldShare;
    }
    // Hand any rounding remainder to the top contribution holder.
    const top = [...contributions].sort((a, b) => b.points - a.points)[0];
    if (top) {
      xpShares[top.id] += Math.max(0, xpRemainder);
      goldShares[top.id] += Math.max(0, goldRemainder);
    }
  }

  const rewards: FighterReward[] = [];

  for (const fighter of humanFighters) {
    const dmg = state.contribution[fighter.id] ?? 0;
    let xpAwarded = 0;
    let goldAwarded = 0;
    let levelUp = false;
    let newLevel = fighter.level;
    let loot: LootDrop[] = [];
    let softDeath: FighterReward["soft_death"] = null;

    // Sync HP, shield, AND mana to D1 first so subsequent helpers see fresh
    // state. Mana isn't covered by setCharacterHpAndShield so we add a small
    // follow-up query.
    await setCharacterHpAndShield(env.DB, fighter.id, fighter.hp, fighter.shield);
    await env.DB
      .prepare(
        "UPDATE characters SET mana = ?, last_active = ? WHERE slack_user_id = ?",
      )
      .bind(fighter.mana, Date.now(), fighter.id)
      .run();

    const character = await getCharacter(env.DB, fighter.id);
    const fighterStats = state.stats?.[fighter.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 };
    if (!character) {
      rewards.push({
        user_id: fighter.id,
        damage_dealt: dmg,
        damage_taken: fighterStats.damage_taken,
        healing_done: fighterStats.healing_done,
        shielding_done: fighterStats.shielding_done,
        kills: fighterStats.kills,
        xp_awarded: 0,
        gold_awarded: 0,
        level_up: false,
        new_level: fighter.level,
        loot: [],
        soft_death: null,
      });
      continue;
    }

    if (won) {
      // Guarantee at least 1 XP/gold so support fighters with 0 damage
      // dealt never see "+0 XP" due to integer rounding of a tiny share.
      xpAwarded = Math.max(1, xpShares[fighter.id] ?? 0);
      goldAwarded = Math.max(1, goldShares[fighter.id] ?? 0);
      const result = await awardSpoils(
        env.DB,
        character,
        xpAwarded,
        goldAwarded,
        () => rollDice(6),
        xpForLevel,
      );
      levelUp = result.levelsGained > 0;
      newLevel = result.newLevel;

      // Loot roll — per-fighter chance using the existing tier-scaled
      // dropChance + rollItem helpers (same probabilities as Slack drops).
      // Catalog items (tool / scroll) keep their fixed catalog names and
      // get AI flavor for the description only. Other types get full AI
      // name + flavor via flavorLootDrop. Both helpers fall back to
      // deterministic strings if the AI call fails.
      //
      // Tower runs explicitly opt out — the only loot inside the Tower
      // comes from rest-stop merchant picks and the boss-floor hoard.
      // Combat floors give XP/gold only.
      const isTowerFloor = primaryMonster.tower_floor !== undefined;
      if (!isTowerFloor && Math.random() < dropChance(tier)) {
        const roll = rollItem(tier);
        const named = await nameLootViaAi(env, roll, primaryMonster.name);
        const created = await addItem(env.DB, {
          character_id: fighter.id,
          item_name: named.name,
          item_type: roll.type,
          power: roll.power,
          rarity: roll.rarity,
          flavor: named.flavor,
          weapon_range: roll.weapon_range ?? null,
        });
        loot.push({
          item_name: created.item_name,
          item_type: created.item_type,
          power: created.power,
          rarity: created.rarity,
          flavor: created.flavor ?? named.flavor,
          weapon_range: created.weapon_range,
          level_req: created.level_req,
        });
      }
    } else if (fighter.hp <= 0) {
      // Soft death: only triggers on actual defeat AND for the fighters
      // that fell. Survivors of a wipe (none here, since defeat means full
      // wipe) would skip this branch.
      const scar = generateScar(primaryMonster.name);
      const death = await applySoftDeath(env.DB, character, scar, DOWNED_COOLDOWN_MS);
      softDeath = {
        gold_lost: death.goldLost,
        item_lost: death.itemLost,
        scar,
      };
    }

    // Achievement checks for this fighter
    const charAfter = await getCharacter(env.DB, fighter.id);
    if (charAfter) {
      const stats = await getLifetimeStats(env.DB, fighter.id);
      const variantRow = await env.DB
        .prepare(`SELECT json_extract(scene_json, '$.variant') AS variant FROM quests WHERE id = ?`)
        .bind(questId)
        .first<{ variant: string | null }>();
      const questVariant = variantRow?.variant ?? "standard";
      const combatIds = checkCombatAchievements({
        fighterClass: charAfter.class,
        finalHp: fighter.hp,
        maxHp: fighter.max_hp,
        roundsTotal: state.round,
        partySize: state.fighters.length,
        status: state.status as "victory" | "defeat" | "fled",
        monster: { is_boss: primaryMonster.is_boss, total_waves: primaryMonster.total_waves },
        existingAchievements: charAfter.achievements,
        lifetimeWins: stats.quests_completed,
        lifetimeKills: stats.kills,
        landedKillingBlow: killedBy === fighter.id,
        scarsCount: charAfter.scars.length,
        softDeathsTotal: stats.deaths_soft,
        isJobBoard: questVariant === "job_board",
        isElite: elite,
        isNoDeathRun: state.fighters.every((f) => f.hp > 0),
        initialMonsterCount: state.monsters.length,
      });
      const progIds = checkProgressionAchievements({
        existingAchievements: charAfter.achievements,
        level: charAfter.level,
        gold: charAfter.gold,
      });
      const deathIds = softDeath
        ? checkDeathAchievements({
            existingAchievements: charAfter.achievements,
            newScarsCount: charAfter.scars.length + 1,
            totalSoftDeaths: stats.deaths_soft + 1,
          })
        : [];
      for (const id of [...combatIds, ...progIds, ...deathIds]) {
        await grantAchievement(env.DB, fighter.id, id);
      }
    }

    rewards.push({
      user_id: fighter.id,
      damage_dealt: dmg,
      damage_taken: fighterStats.damage_taken,
      healing_done: fighterStats.healing_done,
      shielding_done: fighterStats.shielding_done,
      kills: fighterStats.kills,
      xp_awarded: xpAwarded,
      gold_awarded: goldAwarded,
      level_up: levelUp,
      new_level: newLevel,
      loot,
      soft_death: softDeath,
    });
  }

  // Tower advance: each engine combat is exactly one floor. On win, pop the
  // next floor from scene.tower_queue (rest or combat or boss). On a boss
  // kill, grant the hoard but DON'T mark the quest completed — flip
  // tower_awaiting_choice so the player picks continue / bank-and-exit. On a
  // wipe, just close out with the normal failure path; lifetime best_floor +
  // floors_climbed get bumped here too so a partial climb still scores.
  const towerOutcome = await advanceTowerAfterCombat(env, questId, state, humanFighters, rewards, won);
  if (towerOutcome) {
    return towerOutcome;
  }

  await markQuestStatus(env.DB, questId, won ? "completed" : "failed");
  await clearHiredMercForParty(env.DB, questId);

  return {
    status: state.status as "victory" | "defeat",
    rewards,
    monster_name: primaryMonster.name,
    monster_tier: tier,
    total_pool_xp: totalPoolXp,
    total_pool_gold: totalPoolGold,
    elite,
    is_boss: isBoss,
  };
}

// Tower outcome side-effect: increments lifetime + run kill stats, advances
// scene to the next floor, and writes back. Returns an OutcomeSummary when
// the quest is a tower run (so applyWebCombatOutcome can short-circuit
// before the standard path), or null when this isn't a tower or when the
// fight wasn't relevant (no kills, etc.). The standard close-out continues
// to handle the run-ending wipe/quit cases.
async function advanceTowerAfterCombat(
  env: Env,
  questId: number,
  state: CombatState,
  humanFighters: CombatFighter[],
  rewards: FighterReward[],
  won: boolean,
): Promise<OutcomeSummary | null> {
  const sceneRow = await env.DB
    .prepare(`SELECT scene_json, elite FROM quests WHERE id = ?`)
    .bind(questId)
    .first<{ scene_json: string; elite: number }>();
  if (!sceneRow) return null;
  const scene = JSON.parse(sceneRow.scene_json) as SceneJson;
  if (scene.variant !== "tower") return null;
  const elite = sceneRow.elite === 1;

  const primaryMonster = state.monsters[0];
  const tier = primaryMonster?.tier ?? scene.tier;
  const currentFloor = scene.tower_floor ?? 1;
  const currentCycle = scene.tower_cycle ?? 1;
  const currentKind = scene.tower_floor_kind ?? "combat";
  const queue = scene.tower_queue ?? [];

  // Kill credit for survivors — every fighter still standing at end of fight
  // gets +1 to lifetime tower_kills per monster slain this combat.
  if (won) {
    const survivors = humanFighters.filter((f) => f.hp > 0);
    const monstersKilled = state.monsters.filter((m) => m.hp <= 0).length;
    if (monstersKilled > 0 && survivors.length > 0) {
      await Promise.all(
        survivors.map((f) =>
          incrementTowerStats(env.DB, f.id, {
            kills: monstersKilled,
            floorsClimbed: 1,
          })
        ),
      );
    }
  }

  // Wipe: mark the run failed; bump best_floor (current floor reached) for
  // any humans on the party even if they died — climbing this far still
  // counts as your high-water mark.
  if (!won) {
    for (const f of humanFighters) {
      await incrementTowerStats(env.DB, f.id, { bestFloor: currentFloor });
    }
    await markQuestStatus(env.DB, questId, "failed");
    await clearHiredMercForParty(env.DB, questId);
    return {
      status: state.status as "victory" | "defeat" | "fled",
      rewards,
      monster_name: primaryMonster?.name ?? scene.monster_name,
      monster_tier: tier,
      total_pool_xp: 0,
      total_pool_gold: 0,
      elite,
      is_boss: currentKind === "boss",
      tower_floor_cleared: false,
    };
  }

  const killsRun = (scene.tower_kills_run ?? 0) + state.monsters.filter((m) => m.hp <= 0).length;

  // Boss kill: grant hoard, set awaiting_choice, update best_floor lifetime,
  // do NOT advance the queue (queue is empty at this point anyway). Player
  // hits /tower/continue or /tower/exit to resolve.
  if (currentKind === "boss") {
    // Boss treasure was queued at gen time on the boss floor's TowerFloorPlan.
    // We don't have direct access to it here (queue is post-boss only), so
    // reroll a fresh hoard at the boss tier — matches scale, same effect.
    // Name + flavor come from nameLootViaAi (catalog entries get their canonical
    // name + a fresh blurb; everything else gets full AI naming with a fallback).
    const treasure: LootOption[] = [];
    for (let i = 0; i < 3; i++) {
      const r = rollItem(tier);
      const named = await nameLootViaAi(env, r, primaryMonster.name);
      treasure.push({
        name: named.name,
        item_type: r.type,
        power: r.power,
        rarity: r.rarity,
        flavor: named.flavor,
        weapon_range: r.weapon_range ?? null,
        ...(r.slot ? { slot: r.slot } : {}),
        ...(r.stat_bonus ? { stat_bonus: r.stat_bonus as Record<string, number> } : {}),
        ...(r.item_subtype ? { item_subtype: r.item_subtype } : {}),
        ...(r.element ? { element: r.element } : {}),
      });
    }
    const survivors = humanFighters.filter((f) => f.hp > 0);
    for (let i = 0; i < treasure.length; i++) {
      const item = treasure[i];
      const recipient = survivors[i % Math.max(1, survivors.length)] ?? humanFighters[0];
      if (!recipient) break;
      const added = await addItem(env.DB, {
        character_id: recipient.id,
        item_name: item.name,
        item_type: item.item_type,
        power: item.power,
        rarity: item.rarity,
        flavor: item.flavor,
        weapon_range: item.weapon_range ?? null,
        slot: item.slot ?? undefined,
        stat_bonus: item.stat_bonus ?? undefined,
        item_subtype: item.item_subtype ?? undefined,
      });
      const r = rewards.find((rr) => rr.user_id === recipient.id);
      if (r) {
        r.loot.push({
          item_name: added.item_name,
          item_type: added.item_type,
          power: added.power,
          rarity: added.rarity,
          flavor: added.flavor ?? "",
          weapon_range: added.weapon_range,
          level_req: added.level_req,
        });
      }
    }

    // Lifetime best-floor bump for everyone in the party.
    for (const f of humanFighters) {
      await incrementTowerStats(env.DB, f.id, { bestFloor: currentFloor });
    }

    const updatedScene: SceneJson = {
      ...scene,
      monster_hp: 0,
      tower_awaiting_choice: true,
      tower_kills_run: killsRun,
    };
    await saveScene(env.DB, questId, updatedScene);
    await setQuestMode(env.DB, questId, "slack");
    return {
      status: "victory",
      rewards,
      monster_name: primaryMonster.name,
      monster_tier: tier,
      total_pool_xp: 0,
      total_pool_gold: 0,
      elite,
      is_boss: true,
      tower_floor_cleared: true,
      tower_awaiting_choice: true,
      tower_cycle_complete: true,
    };
  }

  // Combat floor: pop the next floor off the queue and stage it.
  const [next, ...remaining] = queue;
  if (!next) {
    // Shouldn't happen — a non-boss floor should always have a next entry —
    // but bail safely if the queue is empty: treat this as a wipe-style end.
    await markQuestStatus(env.DB, questId, "completed");
    await clearHiredMercForParty(env.DB, questId);
    return {
      status: "victory",
      rewards,
      monster_name: primaryMonster.name,
      monster_tier: tier,
      total_pool_xp: 0,
      total_pool_gold: 0,
      elite,
      is_boss: false,
      tower_floor_cleared: true,
    };
  }

  const nextScene = towerSceneFromPlan(next, remaining, currentCycle, killsRun);
  await saveScene(env.DB, questId, nextScene);
  // Rest floors heal the whole party on entry — not on each pick. This way
  // a player who skips the merchant still gets the recovery, and the
  // multi-claim picker isn't tangled up in heal logic.
  if (next.kind === "rest") {
    for (const f of humanFighters) {
      await applyLongRest(env.DB, f.id);
    }
  }
  await setQuestMode(env.DB, questId, "slack");
  return {
    status: "victory",
    rewards,
    monster_name: primaryMonster.name,
    monster_tier: tier,
    total_pool_xp: 0,
    total_pool_gold: 0,
    elite,
    is_boss: false,
    tower_floor_cleared: true,
    tower_next_floor_kind: next.kind,
  };
}

interface WsAttachment {
  quest_id: number;
  user_id: string;
}

const productionRoll: RollFn = (sides) => Math.floor(Math.random() * sides) + 1;

// Consumes any consecutive ally NPC turns at the head of the queue so the
// resulting state always presents a player or monster as the current actor.
// Called after `begin` (high-initiative NPC) and inside `serverAction`
// (NPC slot immediately follows the acted fighter).
function drainAllyNpcTurns(
  result: { state: CombatState; events: CombatEvent[] },
): { state: CombatState; events: CombatEvent[] } {
  let cur = result;
  let safety = 0;
  while (cur.state.status === "active" && safety++ < 20) {
    const actor = cur.state.turn_order[cur.state.turn_index % cur.state.turn_order.length];
    if (!actor || !isAllyNpcActor(actor)) break;
    const next = step(cur.state, { kind: "ally_npc_act" }, productionRoll);
    cur = { state: next.state, events: [...cur.events, ...next.events] };
  }
  return cur;
}

const ELEMENT_TYPES: ElementType[] = ["fire", "ice", "lightning"];

// Exponential decay: 70% chance at tier 1, ~1% at tier 15.
function rollMonsterShield(tier: number): number {
  return Math.random() < 0.7 * Math.pow(0.75, tier - 1) ? 0 : tier;
}

function rollMonsterElementAffinity(): { element_weakness?: ElementType; element_resistance?: ElementType } {
  if (Math.random() >= MONSTER_ELEMENT_AFFINITY_CHANCE) return {};
  const weakness = ELEMENT_TYPES[Math.floor(Math.random() * ELEMENT_TYPES.length)];
  // Resistance is a different element 50% of the time
  if (Math.random() < 0.5) {
    const others = ELEMENT_TYPES.filter((e) => e !== weakness);
    const resistance = others[Math.floor(Math.random() * others.length)];
    return { element_weakness: weakness, element_resistance: resistance };
  }
  return { element_weakness: weakness };
}

const ALL_DAMAGE_TYPES: DamageType[] = ["magic", "fire", "ice", "lightning"];

function rollMonsterAttackAndDamageTypes(
  tier: number,
  element_weakness?: ElementType,
): {
  attack_damage_type?: DamageType;
  damage_weakness?: DamageType;
  damage_resistance?: DamageType;
} {
  // Attack type: low-tier monsters are mostly physical; higher tiers diversify.
  const typedChance = tier >= 3 ? 0.30 : 0.15;
  let attack_damage_type: DamageType | undefined;
  if (Math.random() < typedChance) {
    if (element_weakness && Math.random() < 0.5) {
      attack_damage_type = element_weakness;
    } else {
      const r = Math.random();
      attack_damage_type = r < 0.35 ? "magic" : r < 0.55 ? "fire" : r < 0.75 ? "ice" : "lightning";
    }
  }

  // Damage type weakness/resistance on the monster (for player attacks).
  const damage_weakness: DamageType | undefined =
    Math.random() < 0.20
      ? ALL_DAMAGE_TYPES[Math.floor(Math.random() * ALL_DAMAGE_TYPES.length)]
      : undefined;

  const damage_resistance: DamageType | undefined =
    Math.random() < 0.15
      ? ALL_DAMAGE_TYPES[Math.floor(Math.random() * ALL_DAMAGE_TYPES.length)]
      : undefined;

  return {
    ...(attack_damage_type ? { attack_damage_type } : {}),
    ...(damage_weakness ? { damage_weakness } : {}),
    ...(damage_resistance ? { damage_resistance } : {}),
  };
}

// Shared loader used by both the HTTP `/api/quest/:id/start_web_combat`
// route and the DO's `bootstrapFromSlack` RPC. Reads the party from D1,
// builds CombatInit, runs createCombatState, then seeds the resulting
// state's effects from scene_json (monster status effects) and each
// character row (player status effects) so an active poison/burn carries
// across the boundary.
// Returns a discriminated union so callers can render specific errors.
async function buildInitialCombatState(
  db: D1Database,
  quest: ActiveQuest,
): Promise<
  | { ok: true; seeded: CombatState }
  | { ok: false; reason: "unsupported_variant" | "non_combat_room"; detail?: string }
> {
  const variant = quest.scene.variant ?? "standard";
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "tower") {
    return { ok: false, reason: "unsupported_variant", detail: variant };
  }
  if (variant === "tower") {
    // Rest floors and post-boss awaiting-choice state aren't fightable.
    if (quest.scene.tower_floor_kind === "rest") {
      return { ok: false, reason: "non_combat_room", detail: "tower_rest" };
    }
    if (quest.scene.tower_awaiting_choice) {
      return { ok: false, reason: "non_combat_room", detail: "tower_awaiting_choice" };
    }
  }

  const party = await getQuestParty(db, quest.id);
  const fighters: CombatInit["fighters"] = [];
  for (const member of party) {
    const slots = await getAllEquippedSlots(db, member.slack_user_id);
    const weapon = slots.main_hand;
    const weaponRange = (weapon?.weapon_range as "melee" | "ranged" | "focus" | null | undefined) ?? "melee";
    const isFocus = weaponRange === "focus";

    // Sum armor_power from all armor-contributing slots.
    // helmet contributes floor(power/2); pants floor(power/4); others full power.
    const armorPower =
      (slots.body?.power ?? 0) +
      Math.floor((slots.helmet?.power ?? 0) / 2) +
      Math.floor((slots.pants?.power ?? 0) / 4) +
      (slots.off_hand?.item_subtype === "shield" ? (slots.off_hand?.power ?? 0) : 0);

    // Sum stat_bonus and resist_* keys from all equipped items.
    const equipBonuses: Partial<Stats> = {};
    const rawResistances: Partial<Record<DamageType, number>> = {};
    for (const item of Object.values(slots)) {
      if (!item?.stat_bonus) continue;
      for (const [key, val] of Object.entries(item.stat_bonus)) {
        if (key.startsWith("resist_")) {
          const dtype = key.slice("resist_".length) as DamageType;
          rawResistances[dtype] = (rawResistances[dtype] ?? 0) + val;
        } else {
          (equipBonuses as Record<string, number>)[key] = ((equipBonuses as Record<string, number>)[key] ?? 0) + val;
        }
      }
    }
    // Cap each resistance at 75% and apply focus weapon passive (+10% magic).
    const resistances: Partial<Record<DamageType, number>> = {};
    for (const [dtype, pct] of Object.entries(rawResistances) as [DamageType, number][]) {
      resistances[dtype] = Math.min(75, pct);
    }
    if (isFocus) {
      resistances.magic = Math.min(75, (resistances.magic ?? 0) + 10);
    }

    const memberStats: Stats = {
      str: member.str,
      int_stat: member.int_stat,
      vit: member.vit,
      agi: member.agi,
      dex: member.dex,
    };
    const snap = statSnapshot({
      className: member.class,
      level: member.level,
      stats: memberStats,
      equipBonuses,
    });
    fighters.push({
      id: member.slack_user_id,
      name: member.name,
      class: member.class,
      level: member.level,
      hp: member.hp,
      max_hp: member.max_hp,
      mana: member.mana,
      max_mana: member.max_mana,
      // Armor pool starts at floor(armorPower / 2) at combat start.
      shield: Math.floor(armorPower / 2),
      position: member.position,
      attack_mod: snap.derived.attack_mod,
      magic_mod: snap.derived.magic_mod,
      weapon_power: isFocus ? Math.floor((weapon?.power ?? 0) / 4) : (weapon?.power ?? 0),
      focus_power: isFocus ? (weapon?.power ?? 0) : 0,
      weapon_range: weaponRange,
      slack_username: member.slack_username,
      armor_power: armorPower,
      scars: member.scars,
      stats: snap.stats,
      element: isFocus ? undefined : (weapon?.element ?? undefined),
      weapon_rarity: isFocus ? undefined
        : (weapon?.rarity === "uncommon" || weapon?.rarity === "rare" || weapon?.rarity === "epic" || weapon?.rarity === "legendary"
          ? weapon.rarity : undefined),
      resistances: Object.keys(resistances).length > 0 ? resistances : undefined,
    });

    // Inject hired merc as an additional CombatFighter for this member.
    // Merc ID is __merc_<user_id>__ so multiple party members can each bring
    // a different merc without ID collisions. Stats scale to member's level
    // so the merc stays useful instead of being one-shot at higher tiers.
    if (member.hired_merc_id) {
      const spec = findMerc(member.hired_merc_id);
      if (spec) {
        const lvl = member.level;
        const levelDelta = Math.max(0, lvl - spec.level);
        const scaledHp = Math.round(spec.hp * (lvl / spec.level));
        const scaledAtk = spec.attack_mod + Math.floor(levelDelta / 3);
        const scaledWep = spec.weapon_power + Math.floor(levelDelta / 4);
        fighters.push({
          id: `__merc_${member.slack_user_id}__`,
          name: spec.name,
          class: spec.class_label,
          level: lvl,
          hp: scaledHp,
          max_hp: scaledHp,
          mana: 0,
          max_mana: 0,
          shield: 0,
          position: spec.position,
          attack_mod: scaledAtk,
          magic_mod: 0,
          weapon_power: scaledWep,
          focus_power: 0,
          weapon_range: spec.weapon_range,
          slack_username: null,
          armor_power: 0,
          scars: [],
        });
      }
    }
  }

  // scene.monsters[] covers pack hunts and job-board pack quests.
  const scenePackMonsters = quest.scene.monsters && quest.scene.monsters.length > 1
    ? quest.scene.monsters
    : null;

  const init: CombatInit = scenePackMonsters
    ? {
        fighters,
        monsters: scenePackMonsters.map((m) => {
          const affinity = rollMonsterElementAffinity();
          return {
            name: m.name,
            hp: m.hp,
            max_hp: m.max_hp,
            shield: rollMonsterShield(m.tier),
            tier: m.tier,
            is_boss: false,
            art_url: m.art_url ?? undefined,
            ...affinity,
            ...rollMonsterAttackAndDamageTypes(m.tier, affinity.element_weakness),
          };
        }),
      }
    : {
        fighters,
        monster: {
          name: quest.scene.monster_name,
          hp: quest.scene.monster_hp,
          max_hp: quest.scene.monster_max_hp,
          shield: rollMonsterShield(quest.scene.tier),
          tier: quest.scene.tier,
          is_boss: variant === "boss" || quest.scene.tower_floor_kind === "boss",
          boss_phase: quest.scene.boss_phase,
          wave: quest.scene.wave,
          total_waves: quest.scene.total_waves,
          upcoming_waves: quest.scene.upcoming_waves?.map((w) => ({
            name: w.name,
            max_hp: w.max_hp,
          })),
          // Tower-only pass-through for the combat header "Floor N · Cycle M" chip.
          tower_floor: quest.scene.tower_floor,
          tower_cycle: quest.scene.tower_cycle,
          art_url: quest.scene.monster_art_url,
          ...(() => {
            const affinity = rollMonsterElementAffinity();
            return { ...affinity, ...rollMonsterAttackAndDamageTypes(quest.scene.tier, affinity.element_weakness) };
          })(),
        },
      };
  const initial = createCombatState(init);
  const seeded: CombatState = {
    ...initial,
    monsters: initial.monsters.map((m, i) =>
      // Seed effects only onto the lead monster — scene.monster_effects
      // is the legacy mirror for the primary slot. Additional monsters
      // start clean (no per-spawn effect mirror exists yet).
      i === 0 ? { ...m, effects: quest.scene.monster_effects ?? [] } : m
    ),
    fighters: initial.fighters.map((f) => {
      const character = party.find((p) => p.slack_user_id === f.id);
      return character ? { ...f, effects: character.effects ?? [] } : f;
    }),
  };
  return { ok: true, seeded };
}

// Reads each fighter's stored drink_buff_json from the characters table
// and folds it onto state.drink_buffs. Called once at combat bootstrap
// (both /api/quest/:id/start_web_combat and QuestRoom.bootstrapFromSlack)
// so a pub buff that was active before combat applies inside the engine.
//
// D1 is left UNCHANGED here — the in-combat state has a working copy via
// state.drink_buffs, and the residual is written back on combat exit by
// writebackDrinkBuffs. Leaving D1 intact through combat means a crashed
// or otherwise abandoned fight doesn't silently eat the player's buff.
async function seedDrinkBuffs(
  db: D1Database,
  state: CombatState,
): Promise<CombatState> {
  const buffs: Record<string, DrinkBuff> = {};
  for (const fighter of state.fighters) {
    const character = await getCharacter(db, fighter.id);
    if (character?.drink_buff) {
      buffs[fighter.id] = character.drink_buff;
    }
  }
  if (Object.keys(buffs).length === 0) return state;
  return { ...state, drink_buffs: buffs };
}

// Writes each fighter's residual drink buff back to D1 after combat ends.
// Called from handleStepResult's terminal branch (victory/defeat) so the
// next pub visit or next combat sees an accurate buff state.
//
// We diff against every party member, not just those whose buffs were
// consumed this fight: a buff that was seeded but never applied still
// belongs in D1 unchanged; a buff that consumed all charges this fight
// needs an explicit clear. Single SELECT per fighter keeps it cheap for
// typical 1–4-fighter parties.
async function writebackDrinkBuffs(
  db: D1Database,
  state: CombatState,
): Promise<void> {
  const finalBuffs = state.drink_buffs ?? {};
  for (const fighter of state.fighters) {
    const inState = finalBuffs[fighter.id];
    if (inState && !inState.fight_duration) {
      // Overwrite even when remaining is unchanged — cheap, and keeps D1
      // converging on the engine view of the buff.
      await dbSetDrinkBuff(db, fighter.id, inState);
    } else {
      // fight_duration buffs are consumed for the fight and not carried over;
      // turn-based buffs consumed to 0 (not in inState) are also cleared.
      await dbClearDrinkBuff(db, fighter.id);
    }
  }
}

export class QuestRoom extends DurableObject<Env> {
  // We hold a best-effort in-memory cache of the combat state, but always
  // reload from D1 when uncertain (post-hibernate) and always persist back
  // to D1 before broadcasting.
  private cacheState: CombatState | null = null;
  private cacheQuestId: number | null = null;
  // Recent combat events for replay on reconnect. Capped to LOG_MAX entries
  // and persisted to D1 alongside cacheState. Holds both engine CombatEvents
  // and worker-side events (e.g. item_used) — the UI handles both. Typed as
  // unknown[] for that reason; D1 stores it as plain JSON.
  private cacheLog: unknown[] = [];
  private static readonly LOG_MAX = 200;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const questId = parseInt(url.searchParams.get("quest") ?? "", 10);
    const userId = url.searchParams.get("user") ?? "";
    if (!Number.isFinite(questId) || !userId) {
      return new Response("bad params", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation: tells the runtime to deliver future messages to
    // this.webSocketMessage()/Close() even if the DO hibernates between them.
    this.ctx.acceptWebSocket(server);
    // `this.ctx` is the DurableObjectState provided by the DurableObject base.
    const attach: WsAttachment = { quest_id: questId, user_id: userId };
    server.serializeAttachment(attach);

    // Send initial state snapshot + buffered event log if combat already
    // exists. The log replay lets a Back-and-Resume user see their scrollback.
    // If combat is terminal and we have a saved outcome, replay it too — a
    // client that missed the live broadcast (lost WS, refresh, network blip)
    // would otherwise hang on "Resolving outcome…" forever. Pulled via
    // getWebCombatSnapshot directly so state + log + outcome come in one read,
    // priming the DO cache the same way loadState() does.
    const snap = await getWebCombatSnapshot(this.env.DB, questId);
    if (snap) {
      this.cacheState = snap.state;
      this.cacheQuestId = questId;
      this.cacheLog = snap.log;

      this.sendOne(server, { type: "state", state: snap.state });
      if (snap.log.length > 0) {
        this.sendOne(server, { type: "log_replay", events: snap.log });
      }
      const isTerminal =
        snap.state.status === "victory" ||
        snap.state.status === "defeat" ||
        snap.state.status === "fled";
      if (isTerminal && snap.outcome) {
        this.sendOne(server, { type: "outcome", outcome: snap.outcome as OutcomeSummary });
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the runtime when a client sends a frame. Survives hibernation.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attach = ws.deserializeAttachment() as WsAttachment | null;
    if (!attach) {
      ws.close(1008, "missing attachment");
      return;
    }

    let parsed: ClientToServer | null = null;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text) as ClientToServer;
    } catch {
      this.sendOne(ws, { type: "error", message: "invalid json" });
      return;
    }

    // Client heartbeat — silently ignore, keeps idle timer alive.
    if (parsed?.type === "ping") return;

    if (!parsed || parsed.type !== "action" || !parsed.action) {
      this.sendOne(ws, { type: "error", message: "expected { type: 'action', action: {...} }" });
      return;
    }

    const state = await this.loadState(attach.quest_id);
    if (!state) {
      this.sendOne(ws, { type: "error", message: "no combat in progress" });
      return;
    }

    // use_item lives outside the engine (it reads + deletes inventory in D1).
    if (parsed.action.kind === "use_item") {
      await this.handleUseItem(ws, attach.quest_id, state, parsed.action);
      return;
    }

    const result = step(state, parsed.action, productionRoll);
    try {
      await this.handleStepResult(attach.quest_id, state, result);
    } catch (err) {
      this.broadcast({
        type: "error",
        message: `outcome failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Shared post-step pipeline: persist state if it changed, broadcast events
  // and the new state to every connected WebSocket client, kick off async AI
  // flavor, and on a terminal transition apply combat outcome side-effects
  // (XP/gold/scars/etc.) exactly once.
  //
  // Returns the OutcomeSummary on terminal transition (so RPC callers can
  // forward it to the Slack thread), or null otherwise. Throws on outcome
  // failure so callers can decide how to surface it (the WS path broadcasts
  // an error frame; an RPC caller could include it in the response).
  private async handleStepResult(
    questId: number,
    prevState: CombatState,
    result: { state: CombatState; events: CombatEvent[] },
  ): Promise<OutcomeSummary | null> {
    const stateChanged = result.state !== prevState;
    if (stateChanged) {
      const newLog = this.appendLog(result.events);
      await saveWebCombatState(this.env.DB, questId, result.state, newLog);
      this.cacheState = result.state;
      this.cacheQuestId = questId;
    }
    this.broadcast({ type: "events", events: result.events });
    if (stateChanged) {
      this.broadcast({ type: "state", state: result.state });
    }
    this.kickOffFlavor(questId, result.state, result.events);

    const becameTerminal =
      stateChanged &&
      prevState.status === "active" &&
      (result.state.status === "victory" || result.state.status === "defeat" || result.state.status === "fled");
    if (becameTerminal) {
      // Write residual drink buffs back to D1 BEFORE applyWebCombatOutcome
      // — the latter may call clearPartyEffects which already nulls
      // drink_buff_json on quest-end paths. By writing back first we make
      // sure mid-quest combats (gauntlet wave advanced) carry an accurate
      // post-tick buff into the next fight.
      // Best-effort: a failure here doesn't block outcome processing —
      // the buff just stays at its pre-combat value.
      const killedBy = result.events.find((e): e is Extract<CombatEvent, { type: "monster_down" }> => e.type === "monster_down")?.killed_by;
      try {
        await writebackDrinkBuffs(this.env.DB, result.state);
      } catch (err) {
        console.warn("drink-buff writeback failed", err);
      }
      const outcome = await applyWebCombatOutcome(this.env, questId, result.state, killedBy);
      // Persist BEFORE broadcasting so a client that misses the live frame
      // (lost WS, refresh, network blip) can be replayed it on reconnect via
      // the WS handshake. Without this the outcome is broadcast-only and a
      // missed frame strands the player at "Resolving outcome…" forever.
      await saveWebCombatOutcome(this.env.DB, questId, outcome);
      this.broadcast({ type: "outcome", outcome });
      return outcome;
    }
    return null;
  }

  // ─── RPC entry points (callable from cross-bound Workers) ───────────────────
  //
  // Both methods are direct DurableObject RPC — call as
  //   env.QUEST_ROOM.get(env.QUEST_ROOM.idFromName(`quest:${questId}`))
  //     .serverAction(questId, action)
  //
  // The DO is the single owner of step() for a given quest regardless of
  // whether the actor came in via WebSocket (web client) or RPC (Slack
  // worker). Web clients still see the same broadcasts they always have —
  // a Slack-driven turn is broadcast to web WS clients identically to a
  // web-driven turn.

  async serverAction(
    questId: number,
    action: TurnAction,
  ): Promise<
    | { ok: true; state: CombatState; events: CombatEvent[]; outcome?: OutcomeSummary }
    | { ok: false; reason: string }
  > {
    let state = await this.loadState(questId);
    if (!state) return { ok: false, reason: "no_combat" };
    if (state.status !== "active") return { ok: false, reason: "combat_ended" };

    // If the persisted state already has an ally NPC as the current actor (e.g.
    // from a save before client-side auto-resolve was deployed), drain those first.
    const currentActor = state.turn_order[state.turn_index % state.turn_order.length];
    if (currentActor && isAllyNpcActor(currentActor)) {
      const drained = drainAllyNpcTurns({ state, events: [] });
      state = drained.state;
      if (state.status !== "active") return { ok: false, reason: "combat_ended" };
    }

    const raw = step(state, action, productionRoll);
    const combined = drainAllyNpcTurns(raw);
    const allEvents = combined.events;
    try {
      const outcome = await this.handleStepResult(questId, state, combined);
      return {
        ok: true,
        state: combined.state,
        events: allEvents,
        outcome: outcome ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `outcome_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async devKillEnemies(questId: number): Promise<{ ok: boolean; reason?: string }> {
    const prevState = await this.loadState(questId);
    if (!prevState) return { ok: false, reason: "no_combat" };
    if (prevState.status !== "active") return { ok: false, reason: "combat_ended" };
    const newMonsters = prevState.monsters.map((m) => ({ ...m, hp: 0 }));
    const newState: CombatState = { ...prevState, monsters: newMonsters, status: "victory" };
    await this.handleStepResult(questId, prevState, { state: newState, events: [{ type: "victory" }] });
    return { ok: true };
  }

  async bootstrapFromSlack(
    questId: number,
  ): Promise<
    | { ok: true; state: CombatState; events: CombatEvent[]; created: boolean }
    | { ok: false; reason: string; detail?: string }
  > {
    // Idempotent: if a state already exists, return it without re-running
    // begin. Slack-side combat handler treats `created: false` as "join
    // the in-progress fight"; `created: true` as "fresh — initiative was
    // just rolled."
    const existing = await this.loadState(questId);
    if (existing) {
      return { ok: true, state: existing, events: [], created: false };
    }

    const quest = await getQuestById(this.env.DB, questId);
    if (!quest) return { ok: false, reason: "quest_not_found" };

    const built = await buildInitialCombatState(this.env.DB, quest);
    if (!built.ok) return { ok: false, reason: built.reason, detail: built.detail };

    // Seed drink_buffs from the characters table so a pub buff bought before
    // /gq quest survives into the engine-driven fight. D1 stays the source
    // of truth between combats; the residual gets written back when combat
    // exits (writebackDrinkBuffs in handleStepResult terminal branch).
    const seededWithBuffs = await seedDrinkBuffs(this.env.DB, built.seeded);

    const begun = step(seededWithBuffs, { kind: "begin" }, productionRoll);
    // If the merc rolled highest initiative, auto-process their opening turn(s)
    // so the state always starts with a player or monster as the current actor.
    const afterMercs = drainAllyNpcTurns({ state: begun.state, events: begun.events });
    const newLog = this.appendLog(afterMercs.events);
    await saveWebCombatState(this.env.DB, questId, afterMercs.state, newLog);
    this.cacheState = afterMercs.state;
    this.cacheQuestId = questId;

    // Broadcast to any web clients that may already be connected (e.g. a
    // user who opened the web app expecting to start combat but a Slack
    // user got there first).
    this.broadcast({ type: "state", state: afterMercs.state });
    this.broadcast({ type: "events", events: afterMercs.events });

    return { ok: true, state: afterMercs.state, events: afterMercs.events, created: true };
  }

  // Patches the in-memory CombatState when a new fighter joins a quest that
  // has already started combat. Called from both the web /api/quest/join
  // route and the Slack handleJoin handler so the live fighters list stays
  // in sync regardless of which surface the joiner used.
  //
  // Idempotent: if the fighter is already present (e.g. the DO was freshly
  // bootstrapped from D1 which already includes them), this is a no-op.
  // Safe to call when no combat state exists yet — the fighter will be
  // included when bootstrapFromSlack / start_web_combat runs later.
  async notifyFighterJoined(questId: number, userId: string, newMonsterMaxHp: number): Promise<void> {
    const state = await this.loadState(questId);
    if (!state || state.status !== "active") return;
    if (state.fighters.some((f) => f.id === userId)) return;

    const character = await getCharacter(this.env.DB, userId);
    if (!character) return;

    const slots = await getAllEquippedSlots(this.env.DB, userId);
    const weapon = slots.main_hand;
    const weaponRange = (weapon?.weapon_range as "melee" | "ranged" | "focus" | null | undefined) ?? "melee";
    const isFocus = weaponRange === "focus";

    const armorPower =
      (slots.body?.power ?? 0) +
      Math.floor((slots.helmet?.power ?? 0) / 2) +
      Math.floor((slots.pants?.power ?? 0) / 4) +
      (slots.off_hand?.item_subtype === "shield" ? (slots.off_hand?.power ?? 0) : 0);

    const equipBonuses2: Partial<Stats> = {};
    const rawResistances2: Partial<Record<DamageType, number>> = {};
    for (const item of Object.values(slots)) {
      if (!item?.stat_bonus) continue;
      for (const [key, val] of Object.entries(item.stat_bonus)) {
        if (key.startsWith("resist_")) {
          const dtype = key.slice("resist_".length) as DamageType;
          rawResistances2[dtype] = (rawResistances2[dtype] ?? 0) + (val as number);
        } else {
          (equipBonuses2 as Record<string, number>)[key] =
            ((equipBonuses2 as Record<string, number>)[key] ?? 0) + (val as number);
        }
      }
    }
    const resistances2: Partial<Record<DamageType, number>> = {};
    for (const [dtype, pct] of Object.entries(rawResistances2) as [DamageType, number][]) {
      resistances2[dtype] = Math.min(75, pct);
    }
    if (isFocus) {
      resistances2.magic = Math.min(75, (resistances2.magic ?? 0) + 10);
    }

    const memberStats: Stats = {
      str: character.str,
      int_stat: character.int_stat,
      vit: character.vit,
      agi: character.agi,
      dex: character.dex,
    };
    const snap = statSnapshot({
      className: character.class,
      level: character.level,
      stats: memberStats,
      equipBonuses: equipBonuses2,
    });

    const newFighter: CombatFighter = {
      id: character.slack_user_id,
      name: character.name,
      class: character.class,
      level: character.level,
      hp: character.hp,
      max_hp: character.max_hp,
      mana: character.mana,
      max_mana: character.max_mana,
      shield: Math.floor(armorPower / 2),
      position: character.position,
      attack_mod: snap.derived.attack_mod,
      magic_mod: snap.derived.magic_mod,
      weapon_power: isFocus ? Math.floor((weapon?.power ?? 0) / 4) : (weapon?.power ?? 0),
      focus_power: isFocus ? (weapon?.power ?? 0) : 0,
      weapon_range: weaponRange,
      slack_username: character.slack_username,
      armor_power: armorPower,
      scars: character.scars,
      stats: snap.stats,
      element: isFocus ? undefined : (weapon?.element ?? undefined),
      weapon_rarity: isFocus ? undefined
        : (weapon?.rarity === "uncommon" || weapon?.rarity === "rare" || weapon?.rarity === "epic" || weapon?.rarity === "legendary"
          ? weapon.rarity : undefined),
      resistances: Object.keys(resistances2).length > 0 ? resistances2 : undefined,
      effects: character.effects ?? [],
      initiative: 0,
    };

    // Append to end of turn_order so the joiner acts last in the current
    // cycle without disrupting existing turn indices.
    const hpDelta = newMonsterMaxHp - state.monsters[0].max_hp;
    const updatedState: CombatState = {
      ...state,
      fighters: [...state.fighters, newFighter],
      monsters: state.monsters.map((m, i) =>
        i === 0
          ? { ...m, hp: Math.min(m.max_hp + hpDelta, m.hp + hpDelta), max_hp: newMonsterMaxHp }
          : m
      ),
      turn_order: [...state.turn_order, newFighter.id],
      contribution: { ...state.contribution, [newFighter.id]: 0 },
      stats: {
        ...state.stats,
        [newFighter.id]: { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 },
      },
    };

    const newLog = this.appendLog([{ _kind: "fighter_joined", fighter_id: userId, name: character.name }]);
    await saveWebCombatState(this.env.DB, questId, updatedState, newLog);
    this.cacheState = updatedState;
    this.broadcast({ type: "state", state: updatedState });
  }

  // Called by /api/quest/:id/start_web_combat after it builds + saves the
  // initial combat state directly. Without this, WS clients that were
  // connected before combat started never receive a state frame and the
  // CombatPanel hangs on "Connecting to combat…" until a manual refresh.
  // Re-reads from D1 (source of truth) and broadcasts to every connected
  // socket. Idempotent — safe to call again if state already exists.
  async notifyCombatStarted(questId: number): Promise<void> {
    const state = await this.loadState(questId);
    if (!state) return;
    this.broadcast({ type: "state", state });
  }

  // Inventory-driven combat action. Validates the item belongs to the
  // actor, applies the effect to CombatState, deletes the item from D1,
  // then reuses the engine's "wait" handler to advance the turn so the
  // turn-cycling logic stays in one place.
  //
  // Supported types for v1: consumable (heal user), magic (+max_mana on
  // user), revive (raise a downed party member). Scrolls have named effects
  // (rebase, etc.) we'll plumb in a follow-up.
  private async handleUseItem(
    ws: WebSocket,
    questId: number,
    state: CombatState,
    action: UseItemAction,
  ): Promise<void> {
    if (state.status !== "active") {
      this.sendOne(ws, { type: "error", message: "combat ended" });
      return;
    }
    const currentActor =
      state.turn_order[state.turn_index % state.turn_order.length] ?? "";
    if (currentActor !== action.actor) {
      this.sendOne(ws, { type: "error", message: "not your turn" });
      return;
    }
    const actor = state.fighters.find((f) => f.id === action.actor);
    if (!actor || actor.hp <= 0) {
      this.sendOne(ws, { type: "error", message: "actor downed" });
      return;
    }

    const item = await getItem(this.env.DB, action.item_id, action.actor);
    if (!item) {
      this.sendOne(ws, { type: "error", message: "item not found" });
      return;
    }

    let updatedFighters = state.fighters;
    let effect: ItemEffect | null = null;
    const monsterPatch: Partial<CombatMonster> = {};
    let targetMonId: string | undefined;

    switch (item.item_type) {
      case "consumable": {
        const staple = findStaple(item.item_name);
        const effectivePower = applyPotency(item.power, item.potency_stacks ?? 0);
        if (staple?.effect === "restore_mana") {
          if (actor.mana >= actor.max_mana) {
            this.sendOne(ws, { type: "error", message: "Already at full mana — save it for when you need it." });
            return;
          }
          const added = Math.min(actor.max_mana - actor.mana, effectivePower);
          const newMana = actor.mana + added;
          updatedFighters = state.fighters.map((f) =>
            f.id === actor.id ? { ...f, mana: newMana } : f,
          );
          effect = { kind: "mana_restore", target: actor.id, added, new_mana: newMana };
          break;
        }
        if (actor.hp >= actor.max_hp) {
          this.sendOne(ws, { type: "error", message: "Already at full HP — save it for when you need it." });
          return;
        }
        const before = actor.hp;
        const after = Math.min(actor.max_hp, before + effectivePower);
        const amount = after - before;
        updatedFighters = state.fighters.map((f) =>
          f.id === actor.id ? { ...f, hp: after } : f,
        );
        effect = { kind: "heal", target: actor.id, amount, rolled: effectivePower };
        break;
      }
      case "magic": {
        if (actor.max_mana >= 5) {
          this.sendOne(ws, { type: "error", message: "Already at max mana cap — save it for another character." });
          return;
        }
        const newMax = Math.min(5 /* MAX_MANA_CAP */, actor.max_mana + item.power);
        const added = newMax - actor.max_mana;
        updatedFighters = state.fighters.map((f) =>
          f.id === actor.id
            ? { ...f, max_mana: newMax, mana: Math.min(newMax, f.mana + added) }
            : f,
        );
        effect = {
          kind: "mana_bump",
          target: actor.id,
          added,
          new_max_mana: newMax,
        };
        break;
      }
      case "revive": {
        const target = state.fighters.find((f) => f.id === action.target_id);
        if (!target) {
          this.sendOne(ws, { type: "error", message: "no revive target" });
          return;
        }
        if (target.hp > 0) {
          this.sendOne(ws, { type: "error", message: "target not downed" });
          return;
        }
        // Item power is a % of max_hp restored (matches Slack convention).
        const restored = Math.max(1, Math.floor((target.max_hp * item.power) / 100));
        updatedFighters = state.fighters.map((f) =>
          f.id === target.id ? { ...f, hp: restored } : f,
        );
        effect = { kind: "revive", target: target.id, hp_restored: restored };
        break;
      }
      case "tool":
      case "scroll": {
        const dispatch = applyToolOrScroll(state, actor, item, action.target_id);
        if (dispatch.error) {
          this.sendOne(ws, { type: "error", message: dispatch.error });
          return;
        }
        if (dispatch.fighters) updatedFighters = dispatch.fighters;
        effect = dispatch.effect;
        Object.assign(monsterPatch, dispatch.monster ?? {});
        // Remember which monster we patched so we can check it for kill below.
        if (dispatch.targetMonId) targetMonId = dispatch.targetMonId;
        break;
      }
      default:
        this.sendOne(ws, {
          type: "error",
          message: `cannot use ${item.item_type} in combat yet`,
        });
        return;
    }

    if (!effect) return;

    // Apply the item's effect snapshot, then either resolve the monster kill
    // (if HP hit 0, e.g. Production Outage instakill) or advance the turn via
    // the engine's "wait" handler so turn_start / round-bump stay unified.
    const withEffect: CombatState = {
      ...state,
      fighters: updatedFighters,
      monsters: state.monsters.map((m) =>
        targetMonId && m.id === targetMonId ? { ...m, ...monsterPatch } : m,
      ),
    };

    let resultState: CombatState;
    let resultEvents: CombatEvent[];
    const patchedMonster = targetMonId ? withEffect.monsters.find((m) => m.id === targetMonId) : undefined;
    if (patchedMonster && patchedMonster.hp <= 0) {
      const killed = resolveMonsterKill(withEffect, patchedMonster.id, action.actor, []);
      resultState = killed.state;
      resultEvents = killed.events;
    } else {
      const waitResult = step(withEffect, { kind: "wait", actor: action.actor }, productionRoll);
      resultState = waitResult.state;
      resultEvents = waitResult.events;
    }

    const itemUsed: ItemUsedEvent = {
      type: "item_used",
      actor: action.actor,
      item_id: item.id,
      item_name: item.item_name,
      item_type: item.item_type,
      effect,
    };

    const newLog = this.appendLog([itemUsed, ...resultEvents]);
    await saveWebCombatState(this.env.DB, questId, resultState, newLog);
    await removeItem(this.env.DB, item.id);
    this.cacheState = resultState;

    this.broadcast({ type: "events", events: [itemUsed, ...resultEvents] });
    this.broadcast({ type: "state", state: resultState });
    this.kickOffFlavor(questId, resultState, resultEvents);

    // Item-driven kill — apply outcome side-effects (loot / xp / gold / level)
    // the same way a player-action kill would. Mirrors the WS handler logic.
    const becameTerminal =
      state.status === "active"
      && (resultState.status === "victory" || resultState.status === "defeat");
    if (becameTerminal) {
      const itemKilledBy = resultEvents.find((e): e is Extract<CombatEvent, { type: "monster_down" }> => e.type === "monster_down")?.killed_by;
      try {
        await writebackDrinkBuffs(this.env.DB, resultState);
      } catch (err) {
        console.warn("drink-buff writeback failed", err);
      }
      try {
        const outcome = await applyWebCombatOutcome(this.env, questId, resultState, itemKilledBy);
        // Persist before broadcasting — same reasoning as the WS-driven kill
        // path. Replayed on reconnect via the WS handshake.
        await saveWebCombatOutcome(this.env.DB, questId, outcome);
        this.broadcast({ type: "outcome", outcome });
      } catch (err) {
        this.broadcast({
          type: "error",
          message: `outcome failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Nothing to do — the runtime removes the closed socket from
    // getWebSockets() on its own. No alarms or timers to clean up.
  }

  private async loadState(questId: number): Promise<CombatState | null> {
    if (this.cacheState && this.cacheQuestId === questId) return this.cacheState;
    const snap = await getWebCombatSnapshot(this.env.DB, questId);
    if (snap) {
      let state = upgradeCombatState(snap.state);
      // Backfill armor_power on fighters that predate the typed-damage system.
      // Computes from equipped gear so the UI's armor bar has a max to render against.
      const needsBackfill = state.fighters.some((f) => typeof f.armor_power !== "number");
      if (needsBackfill) {
        const patched = await Promise.all(state.fighters.map(async (f) => {
          if (typeof f.armor_power === "number") return f;
          const slots = await getAllEquippedSlots(this.env.DB, f.id);
          return { ...f, armor_power: computeArmorPowerFromSlots(slots) };
        }));
        state = { ...state, fighters: patched };
        await saveWebCombatState(this.env.DB, questId, state, snap.log);
      }
      this.cacheState = state;
      this.cacheQuestId = questId;
      this.cacheLog = snap.log;
      return state;
    }
    return null;
  }

  // Append events to the in-memory log buffer, trim to LOG_MAX. Returns the
  // new buffer so callers can pass it straight to saveWebCombatState.
  private appendLog(events: unknown[]): unknown[] {
    if (events.length === 0) return this.cacheLog;
    const next = [...this.cacheLog, ...events];
    this.cacheLog = next.length > QuestRoom.LOG_MAX
      ? next.slice(next.length - QuestRoom.LOG_MAX)
      : next;
    return this.cacheLog;
  }

  // Broadcast a freshly-generated flavor message AND append it to the
  // persisted log so a reconnecting client can replay it. The log marker
  // shape (`_kind: "flavor"`) is distinguishable from CombatEvents (which
  // have `type`) so the client can dispatch differently on replay.
  private async broadcastAndLogFlavor(
    questId: number,
    flavor: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string },
  ): Promise<void> {
    this.broadcast({ type: "flavor", flavor });
    const newLog = this.appendLog([{ _kind: "flavor", flavor }]);

    // Persist log alongside the current state. Best-effort — a failure here
    // just means scrollback may miss this flavor entry; the broadcast already
    // landed for live viewers.
    if (this.cacheState) {
      try {
        await saveWebCombatState(this.env.DB, questId, this.cacheState, newLog);
      } catch {
        // ignore — scrollback regression only
      }
    }
  }

  // Scan engine events for moments worth narrating, fire off AI flavor
  // requests in parallel, and broadcast each result as a `flavor` message
  // when it returns. Errors fall back to canned text inside the helpers.
  // Skips: misses, status ticks, position swaps — those aren't dramatic
  // enough to warrant a model round-trip.
  private kickOffFlavor(questId: number, state: CombatState, events: CombatEvent[]): void {
    for (const e of events) {
      if (e.type === "player_hit") {
        const fighter = state.fighters.find((f) => f.id === e.actor);
        if (!fighter) continue;
        const action = e.formula.includes("aura") || e.crit ? "attack" : "attack";
        const kind: "attack" = action;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const monsterName = state.monsters[0].name;
        const isCrit = e.crit;
        this.ctx.waitUntil(
          flavorHit(this.env.AI, ref, monsterName, kind, isCrit)
            .then((text) => this.broadcastAndLogFlavor(questId, { kind: "hit", actor: e.actor, text }))
            .catch(() => undefined),
        );
      } else if (e.type === "monster_down") {
        const fighter = state.fighters.find((f) => f.id === e.killed_by);
        if (!fighter) continue;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const partySize = state.fighters.filter((f) => f.hp > 0).length;
        const monsterName = state.monsters[0].name;
        this.ctx.waitUntil(
          flavorVictory(this.env.AI, ref, monsterName, partySize)
            .then((text) => this.broadcastAndLogFlavor(questId, { kind: "victory", actor: e.killed_by, text }))
            .catch(() => undefined),
        );
      } else if (e.type === "fighter_down") {
        const fighter = state.fighters.find((f) => f.id === e.target);
        if (!fighter) continue;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const monsterName = state.monsters[0].name;
        this.ctx.waitUntil(
          flavorDeath(this.env.AI, ref, monsterName)
            .then((text) => this.broadcastAndLogFlavor(questId, { kind: "death", actor: e.target, text }))
            .catch(() => undefined),
        );
      } else if (e.type === "fled") {
        // Use the most recent flee_check to attribute the escape.
        const fleeCheck = [...events].reverse().find((x) => x.type === "flee_check");
        if (!fleeCheck || fleeCheck.type !== "flee_check") continue;
        const fighter = state.fighters.find((f) => f.id === fleeCheck.actor);
        if (!fighter) continue;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const monsterName = state.monsters[0].name;
        const partyContinues = state.fighters.some((f) => f.id !== fighter.id && f.hp > 0);
        this.ctx.waitUntil(
          flavorFleeSuccess(this.env.AI, ref, monsterName, partyContinues)
            .then((text) => this.broadcastAndLogFlavor(questId, { kind: "flee", actor: fleeCheck.actor, text }))
            .catch(() => undefined),
        );
      }
    }
  }

  private sendOne(ws: WebSocket, msg: ServerToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closed socket; let the runtime clean up.
    }
  }

  private broadcast(msg: ServerToClient): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Closed socket; runtime cleans up.
      }
    }
  }
}

// ─── LobbyRoom DO ─────────────────────────────────────────────────────────────
// One DO instance per quest (`idFromName('lobby:' + questId)`). Holds:
//   - mirrored party state (refreshed from D1 on notifyStateChanged)
//   - ephemeral chat ring buffer (in-memory only — explicitly drops on
//     hibernate; that's fine, chat doesn't persist past combat anyway)
//   - WS connections from web dashboard clients
//
// Lifecycle:
//   - Created lazily on first WS upgrade
//   - Hibernates between events when no message traffic
//   - Notified by both the web worker (HTTP endpoints) and the Slack worker
//     (cross-bound) when D1 state changes, so it pushes to all clients
//   - When the lobby starts combat or is cancelled, broadcasts the
//     terminal event and lets clients disconnect; the DO storage is
//     trivially empty (everything's in-memory or in D1)
// ────────────────────────────────────────────────────────────────────────────

interface LobbyWsAttachment {
  quest_id: number;
  user_id: string;
}

interface LobbyChatMessage {
  id: number;
  user_id: string;
  user_name: string;
  message: string;
  created_at: number;
}

type LobbyServerMsg =
  | { type: "state"; quest: LobbyQuest; party: LobbyPartyMember[] }
  | { type: "chat"; message: LobbyChatMessage }
  | { type: "chat_history"; messages: LobbyChatMessage[] }
  | { type: "lock_changed"; locked: boolean }
  | { type: "cancelled" }
  | { type: "started"; quest_id: number }
  | { type: "error"; message: string };

type LobbyClientMsg =
  | { type: "ping" }
  | { type: "chat"; message: string };

const LOBBY_CHAT_MAX = 50;

export class LobbyRoom extends DurableObject<Env> {
  // In-memory chat ring buffer. Cleared on hibernate (we re-issue empty
  // history to fresh connections — chat is explicitly ephemeral).
  private chat: LobbyChatMessage[] = [];
  private chatNextId = 1;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const questId = parseInt(url.searchParams.get("quest") ?? "", 10);
    const userId = url.searchParams.get("user") ?? "";
    if (!Number.isFinite(questId) || !userId) {
      return new Response("bad params", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const attach: LobbyWsAttachment = { quest_id: questId, user_id: userId };
    server.serializeAttachment(attach);

    // Send initial snapshot immediately so the client doesn't need to also
    // poll the REST endpoint after connecting.
    const snap = await this.loadState(questId);
    if (snap) {
      this.sendOne(server, { type: "state", quest: snap.quest, party: snap.party });
    }
    if (this.chat.length > 0) {
      this.sendOne(server, { type: "chat_history", messages: this.chat });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attach = ws.deserializeAttachment() as LobbyWsAttachment | null;
    if (!attach) {
      ws.close(1008, "missing attachment");
      return;
    }
    let parsed: LobbyClientMsg | null = null;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text) as LobbyClientMsg;
    } catch {
      this.sendOne(ws, { type: "error", message: "invalid json" });
      return;
    }
    if (!parsed) return;
    if (parsed.type === "ping") return; // heartbeat
    if (parsed.type === "chat") {
      const trimmed = parsed.message.trim();
      if (!trimmed) return;
      // Cap at 500 chars to keep ring buffer bounded.
      const clipped = trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;

      // Resolve display name from D1. Cheap one-shot read, cached implicitly
      // by D1's own read cache.
      const character = await getCharacter(this.env.DB, attach.user_id);
      const userName = character?.name ?? attach.user_id;

      const msg: LobbyChatMessage = {
        id: this.chatNextId++,
        user_id: attach.user_id,
        user_name: userName,
        message: clipped,
        created_at: Date.now(),
      };
      this.chat.push(msg);
      if (this.chat.length > LOBBY_CHAT_MAX) {
        this.chat = this.chat.slice(-LOBBY_CHAT_MAX);
      }
      this.broadcast({ type: "chat", message: msg });
      return;
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Nothing to do — the runtime removes the socket from getWebSockets()
    // automatically. We don't track per-connection state beyond the
    // attachment, so close is a no-op.
  }

  // RPC-callable from outside the DO. Re-reads lobby + party from D1 and
  // broadcasts a fresh `state` frame to all connected sockets. Idempotent.
  async notifyStateChanged(questId: number): Promise<void> {
    const snap = await this.loadState(questId);
    if (!snap) {
      // Lobby vanished (cancelled or completed). Tell clients and close.
      this.broadcast({ type: "cancelled" });
      this.closeAll(1000, "lobby gone");
      return;
    }
    this.broadcast({ type: "state", quest: snap.quest, party: snap.party });
  }

  // Called when the lobby transitions to combat (force start, ready-all,
  // or auto-start alarm). Broadcasts `started` so clients can switch to
  // CombatPage, then closes connections.
  async notifyStarted(questId: number): Promise<void> {
    this.broadcast({ type: "started", quest_id: questId });
    this.closeAll(1000, "lobby started");
    // Clear ephemeral chat — combat starts fresh.
    this.chat = [];
    this.chatNextId = 1;
  }

  // Called when the lobby's locked flag flipped.
  async notifyLockChanged(locked: boolean): Promise<void> {
    this.broadcast({ type: "lock_changed", locked });
  }

  // Called when the lobby is cancelled. Broadcasts and closes.
  async notifyCancelled(): Promise<void> {
    this.broadcast({ type: "cancelled" });
    this.closeAll(1000, "lobby cancelled");
    this.chat = [];
    this.chatNextId = 1;
  }

  private async loadState(
    questId: number,
  ): Promise<{ quest: LobbyQuest; party: LobbyPartyMember[] } | null> {
    const quest = await getLobbyQuestById(this.env.DB, questId);
    if (!quest) return null;
    // Show the lobby for both pre-combat (status=lobby) and reinforcement
    // (status=active with pending invitees). Anything else is gone.
    if (quest.status !== "lobby" && quest.status !== "active") return null;
    const party = await getLobbyParty(this.env.DB, questId);
    if (quest.status === "active") {
      // Reinforcement: only show if there's at least one pending invitee.
      // Otherwise the "lobby" is just the historical roster of the running
      // fight — no UI value.
      const anyPending = party.some((m) => m.invite_status === "pending");
      if (!anyPending) return null;
    }
    return { quest, party };
  }

  private sendOne(ws: WebSocket, msg: LobbyServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  private broadcast(msg: LobbyServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* closed */
      }
    }
  }

  private closeAll(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }
}

// Helper used by HTTP routes + Slack cross-binding to notify the LobbyRoom
// DO of a state change. Safe no-op if the binding isn't present (local dev
// without LOBBY_ROOM still works via polling fallback).
async function notifyLobbyStateChanged(
  env: Pick<Env, "LOBBY_ROOM">,
  questId: number,
): Promise<void> {
  if (!env.LOBBY_ROOM) return;
  try {
    const id = env.LOBBY_ROOM.idFromName(`lobby:${questId}`);
    const stub = env.LOBBY_ROOM.get(id);
    await (stub as unknown as { notifyStateChanged(q: number): Promise<void> }).notifyStateChanged(questId);
  } catch (err) {
    console.warn("notifyLobbyStateChanged failed", err);
  }
}

async function notifyLobbyStarted(
  env: Pick<Env, "LOBBY_ROOM">,
  questId: number,
): Promise<void> {
  if (!env.LOBBY_ROOM) return;
  try {
    const id = env.LOBBY_ROOM.idFromName(`lobby:${questId}`);
    const stub = env.LOBBY_ROOM.get(id);
    await (stub as unknown as { notifyStarted(q: number): Promise<void> }).notifyStarted(questId);
  } catch (err) {
    console.warn("notifyLobbyStarted failed", err);
  }
}

async function notifyLobbyLockChanged(
  env: Pick<Env, "LOBBY_ROOM">,
  questId: number,
  locked: boolean,
): Promise<void> {
  if (!env.LOBBY_ROOM) return;
  try {
    const id = env.LOBBY_ROOM.idFromName(`lobby:${questId}`);
    const stub = env.LOBBY_ROOM.get(id);
    await (stub as unknown as { notifyLockChanged(l: boolean): Promise<void> }).notifyLockChanged(locked);
  } catch (err) {
    console.warn("notifyLobbyLockChanged failed", err);
  }
}

async function notifyLobbyCancelled(
  env: Pick<Env, "LOBBY_ROOM">,
  questId: number,
): Promise<void> {
  if (!env.LOBBY_ROOM) return;
  try {
    const id = env.LOBBY_ROOM.idFromName(`lobby:${questId}`);
    const stub = env.LOBBY_ROOM.get(id);
    await (stub as unknown as { notifyCancelled(): Promise<void> }).notifyCancelled();
  } catch (err) {
    console.warn("notifyLobbyCancelled failed", err);
  }
}
