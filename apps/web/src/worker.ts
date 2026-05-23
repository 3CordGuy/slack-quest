// Web app Worker. Handles /api/* routes; static assets and SPA fallback come
// from the ASSETS binding (configured in wrangler.jsonc). Shares the same D1
// instance as the Slack worker so codes issued by /sq web-login are visible
// here. The QuestRoom Durable Object (defined below) coordinates live web-mode
// combat over WebSocket.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  VIEW_ART_PROMPTS,
  pregenAllViewArt,
  flavorCatalogItem,
  flavorDeath,
  flavorFleeSuccess,
  flavorHit,
  flavorLootDrop,
  flavorVictory,
  generateExpeditionTheme,
  generateGauntletWaves,
  generateJobListing,
  generateLockboxScene,
  generateMerchantRoom,
  generateNpcRoom,
  generateOpeningScene,
  generateTrapRoom,
  generateTownName,
  getOrScheduleViewArt,
  generateCharacterArtNow,
  getOrScheduleCharacterArt,
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
  RARITY_BADGE,
  statSnapshot,
  upgradeCombatState,
  mergeEffect,
  MONSTER_ID,
  isMonsterActor,
  isAllyNpcActor,
  MERCS,
  findMerc,
  MONSTER_ELEMENT_AFFINITY_CHANCE,
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
  addCharacterKey,
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
  setQuestThreadTs,
  trySaveExpeditionAdvance,
  getAllEquippedSlots,
  insertShopStock,
  characterLevelRange,
  countCharacters,
  type ActiveQuest,
  type Character,
  type CharGender,
  generateGridDungeon,
  openDoor,
  tryMove,
  type DungeonDirection,
  type DungeonGraph,
  type DungeonNode,
  type ExpeditionNode,
  type ExpeditionNodeType,
  type ExpeditionState,
  type GridDoor,
  type GridRoomContent,
  type KeyTier,
  type LootOption,
  type MonsterSpec,
  type SceneJson,
  type TrapChoice,
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
// (dungeon-only lockbox) intentionally return an error here; both need
// support that doesn't make sense until either monster-kill integration
// or dungeon support lands.
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
  // Bot token for posting cross-surface notifications back into the Slack
  // channel (e.g. "Player joined from the web", combat milestone broadcasts,
  // boss-reveal/phase-2/down/victory beats). Same token the Slack worker
  // uses — single-tenant deployment, single workspace. Optional in dev so
  // local web-only iteration doesn't require the secret; when unset the
  // post calls are skipped silently.
  SLACK_BOT_TOKEN?: string;
  // Set to "local" via .dev.vars to enable dev-only endpoints (e.g. /api/dev/login).
  ENVIRONMENT?: string;
}

// Minimal chat.postMessage wrapper duplicated from apps/slack/src/slack.ts.
// The function is 12 lines and stable; lifting it into a shared package
// would couple the web worker to slack-specific types it doesn't otherwise
// need. If a third caller appears we'll lift then.
async function deleteSlackMessage(botToken: string, channel: string, ts: string): Promise<void> {
  await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ts }),
  });
}

async function postSlackMessage(
  botToken: string,
  args: {
    channel: string;
    text: string;
    thread_ts?: string;
    reply_broadcast?: boolean;
    blocks?: unknown[];
  },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(args),
  });
  return (await res.json()) as { ok: boolean; ts?: string; error?: string };
}

// Announces a web-originated quest into the player's recent Slack channel.
// Mirrors what Slack's handleQuest does on /gq quest: an opening narrative
// post (creator + monster + variant banner + scene), then a separate
// recruitment card with [Join on web] / [Join here] buttons.
//
// Returns the opening post's ts so the caller can update the quest's
// thread_ts via setQuestThreadTs. Quests start with a synthetic placeholder
// (`web-<timestamp>-<userId>`) because the DB row must exist before we can
// announce it; the announcement then replaces the placeholder with the
// real Slack ts so subsequent flavor/milestone broadcasts land in the
// right thread.
//
// Skipped when SLACK_BOT_TOKEN isn't bound or the channel can't be
// resolved. Failure logs a warning but doesn't break the player's quest.
interface WebQuestAnnounceArgs {
  channelId: string;
  questId: number;
  userId: string;
  characterName: string;
  characterClass: string;
  characterLevel: number;
  elite: boolean;
  variant: "standard" | "boss" | "gauntlet" | "dungeon";
  monsterName: string;
  monsterMaxHp: number;
  sceneText: string;
  totalWaves?: number;
  webBaseUrl?: string;
}
async function announceWebQuestToSlack(
  env: Env,
  args: WebQuestAnnounceArgs,
): Promise<string | null> {
  if (!env.SLACK_BOT_TOKEN) return null;
  const token = env.SLACK_BOT_TOKEN;

  const eliteBanner = args.elite ? "⚠️ *ELITE — perma-death enabled* ⚠️\n" : "";
  const variantBanner =
    args.variant === "boss" ? "👑 *BOSS QUEST*\n"
    : args.variant === "gauntlet" ? `⚔️ *GAUNTLET — ${args.totalWaves ?? "?"} waves, no flee*\n`
    : args.variant === "dungeon" ? "🗺️ *DUNGEON*\n"
    : "";

  const variantBadge =
    args.variant === "boss" ? "👑 Boss"
    : args.variant === "gauntlet" ? "⚔️ Gauntlet"
    : args.variant === "dungeon" ? "🗺️ Dungeon"
    : "⚔️ Quest";

  const openingText = [
    `${eliteBanner}${variantBanner}*A new quest begins* (from web). <@${args.userId}> as *${args.characterName}* the ${args.characterClass} (L${args.characterLevel}).`,
    ``,
    `_${args.sceneText}_`,
    ``,
    `Foe: *${args.monsterName}* — HP ${args.monsterMaxHp}`,
  ].join("\n");

  try {
    const opening = await postSlackMessage(token, {
      channel: args.channelId,
      text: openingText,
    });
    if (!opening.ok || !opening.ts) {
      console.warn("web-quest opening post failed", opening.error);
      return null;
    }

    // Recruitment card — same shape as Slack's postJoinableQuest. Elite
    // quests skip the card (perma-death opt-in by direct invite only,
    // matching the Slack behavior). Mid-flow quests can't happen here
    // because this is a fresh creation path.
    if (!args.elite) {
      const partyLine = `<@${args.userId}> vs. *${args.monsterName}* (${args.monsterMaxHp} HP)`;
      const elements: unknown[] = [];
      if (args.webBaseUrl) {
        elements.push({
          type: "button",
          text: { type: "plain_text", text: "Join on web", emoji: true },
          // Different prefix from join_quest_ to avoid colliding with
          // handleInteraction's handleJoin dispatch (matches the slack
          // worker's link_quest_web_ convention).
          action_id: `link_quest_web_${args.questId}`,
          url: args.webBaseUrl,
        });
      }
      elements.push({
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Join here", emoji: true },
        action_id: `join_quest_${args.questId}`,
        value: String(args.questId),
      });
      await postSlackMessage(token, {
        channel: args.channelId,
        text: `${variantBadge} — joinable quest. ${partyLine}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `${variantBadge} — *Joinable quest*\n${partyLine}` },
          },
          { type: "actions", elements },
        ],
      });
    }

    return opening.ts;
  } catch (err) {
    console.warn("web-quest announce failed", err);
    return null;
  }
}

// Web worker's own public domain. Used as the baseUrl for art assets so the
// browser fetches them from the same origin (no extra CORS, same cookie scope).
const WEB_PUBLIC_BASE = "https://quest.heylets.party";

function artTarget(env: Env): import("./ai").ArtTarget {
  return { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE, disabled: env.ENVIRONMENT === "local" };
  return { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE, disabled: env.ENVIRONMENT === "local" };
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

  await deleteCharacter(c.env.DB, session.slack_user_id);

  const body = await c.req.json<{ class?: string }>().catch((): { class?: string } => ({}));
  const cls = body.class ? classByName(body.class) : pickRandomClass();
  const hp = cls.base_hp + rollDice(4);
  const gender: CharGender = rollDice(2) === 1 ? "m" : "f";
  const newChar = await createCharacter(c.env.DB, {
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    name: generateNpcName(),
    class: cls.name,
    hp,
    max_hp: hp,
    gender,
  });

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
  if (scene.variant === "boss" || scene.variant === "dungeon") return scene;
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
const DUNGEON_LEVEL_REQUIRED = 1;
const DUNGEON_MIN_ROOMS = 5;
const DUNGEON_MAX_ROOMS = 7;
const EXPEDITION_TREASURE_OPTIONS = 2;

// Builds a fresh dungeon SceneJson. All AI calls run in parallel.
// Layout mirrors Slack: entry combat → middle pool (door-choice navigation) →
// guaranteed merchant → sub-boss → treasure.
async function buildDungeonScene(
  env: Pick<Env, "AI" | "ART">,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  avoidNames: string[] = [],
): Promise<SceneJson> {
  const art = { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE };
  const theme = await generateExpeditionTheme(env.AI);
  const totalRoomsVisited =
    DUNGEON_MIN_ROOMS + Math.floor(Math.random() * (DUNGEON_MAX_ROOMS - DUNGEON_MIN_ROOMS + 1));
  const middleCount = totalRoomsVisited - 2;
  const poolMiddleCount = middleCount * 2;

  const poolTypes: ExpeditionNodeType[] = [];
  for (let i = 0; i < poolMiddleCount; i++) {
    const r = Math.random();
    if (r < 0.40) poolTypes.push("combat");
    else if (r < 0.65) poolTypes.push("trap");
    else if (r < 0.85) poolTypes.push("lockbox");
    else poolTypes.push("npc");
  }
  poolTypes[0] = "combat";

  const failDamage = 4 + Math.max(1, character.level);
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));

  // Merges a roll + named result into a LootOption, preserving Phase 2 fields.
  function mkLootOption(roll: ItemRoll, named: { name: string; flavor: string }) {
    return {
      name: named.name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor: named.flavor,
      weapon_range: roll.weapon_range ?? null,
      ...(roll.slot ? { slot: roll.slot } : {}),
      ...(roll.stat_bonus ? { stat_bonus: roll.stat_bonus as Record<string, number> } : {}),
      ...(roll.item_subtype ? { item_subtype: roll.item_subtype } : {}),
      ...(roll.element ? { element: roll.element } : {}),
      ...(roll.tier != null ? { tier: roll.tier } : {}),
    };
  }

  // Resolves an ItemRoll to a { name, flavor } pair.
  async function resolveLoot(location: string, roll: ItemRoll): Promise<{ name: string; flavor: string }> {
    if (roll.catalog_name) {
      const entry = findCatalogEntry(roll.catalog_name);
      if (entry) {
        const flavor = await flavorCatalogItem(env.AI, entry.name, entry.blurb, location);
        return { name: `${entry.emoji} ${entry.name}`, flavor };
      }
    }
    return flavorLootDrop(
      env.AI,
      location,
      roll.type as "weapon" | "armor" | "consumable" | "magic" | "revive",
      roll.rarity,
      roll.power,
      roll.weapon_range,
      roll.slot ?? undefined,
      (roll.element ?? undefined) as ElementType | undefined,
    );
  }

  const middleNodePromises: Promise<ExpeditionNode>[] = poolTypes.map(async (type, i) => {
    const roomNum = i + 1;
    if (type === "combat") {
      const monster = await generateOpeningScene(env.AI, character, elite, "gauntlet-wave", { wave: roomNum, total: totalRoomsVisited }, avoidNames, art);
      return {
        type: "combat" as const,
        scene: monster.scene,
        monster_name: monster.monster_name,
        monster_max_hp: monster.monster_max_hp,
        monster_art_url: monster.monster_art_url,
        tier: monster.tier,
        drops_key: true,
        drops_key_tier: "bronze" as KeyTier,
      };
    }
    if (type === "trap") {
      const trap = await generateTrapRoom(env.AI, theme, roomNum, totalRoomsVisited);
      return {
        type: "trap" as const,
        scene: trap.scene,
        trap_choices: [
          { text: trap.options.str, emoji: "💪", skill: "str" as const, fail_damage: failDamage },
          { text: trap.options.dex, emoji: "🔧", skill: "dex" as const, fail_damage: failDamage },
          { text: trap.options.int, emoji: "📜", skill: "int" as const, fail_damage: failDamage },
        ],
      };
    }
    if (type === "lockbox") {
      const r = Math.random();
      const lockTier: KeyTier = r < 0.70 ? "bronze" : r < 0.95 ? "silver" : "gold";
      const tierBump = lockTier === "bronze" ? 1 : lockTier === "silver" ? 2 : 3;
      const rolls = Array.from({ length: 2 }, () => rollItem(baseTier + tierBump));
      const [lockboxScene, ...named] = await Promise.all([
        generateLockboxScene(env.AI, theme, roomNum, totalRoomsVisited),
        ...rolls.map((roll) => resolveLoot("the locked chest", roll)),
      ]);
      const opts = rolls.map((roll, j) => mkLootOption(roll, named[j]));
      return { type: "lockbox" as const, scene: lockboxScene, loot_options: opts, lock_tier: lockTier };
    }
    // npc
    const npcName = generateNpcName();
    const offerRoll = rollItem(baseTier);
    const [npc, offerNamed] = await Promise.all([
      generateNpcRoom(env.AI, theme, roomNum, totalRoomsVisited, npcName),
      resolveLoot(`${npcName}'s pack`, offerRoll),
    ]);
    return {
      type: "npc" as const,
      scene: npc.scene,
      npc: {
        greeting: npc.greeting,
        item: mkLootOption(offerRoll, offerNamed),
      },
    };
  });

  const bossPromise = generateOpeningScene(env.AI, character, elite, "boss", undefined, avoidNames, art);
  const treasureRolls = Array.from({ length: EXPEDITION_TREASURE_OPTIONS }, () => rollItem(baseTier + 1));
  const treasureNamedPromises = treasureRolls.map((roll) => resolveLoot("the dungeon's heart-chamber", roll));

  const merchantName = generateMerchantName();
  const merchantStockRolls = Array.from({ length: 3 }, () => rollMerchantItem(baseTier + 1));
  const merchantPromise = (async () => {
    const [info, ...named] = await Promise.all([
      generateMerchantRoom(env.AI, theme, totalRoomsVisited - 2, totalRoomsVisited, merchantName),
      ...merchantStockRolls.map((roll) => resolveLoot(`${merchantName}'s stall`, roll)),
    ]);
    const stock = merchantStockRolls.map((roll, j) => mkLootOption(roll, named[j]));
    return { info, stock };
  })();

  const [middleNodes, merchantData, boss, treasureNamed] = await Promise.all([
    Promise.all(middleNodePromises),
    merchantPromise,
    bossPromise,
    Promise.all(treasureNamedPromises),
  ]);

  const nodes: ExpeditionNode[] = [...middleNodes];
  nodes.push({
    type: "merchant",
    scene: merchantData.info.scene,
    loot_options: merchantData.stock,
    npc: { greeting: merchantData.info.greeting, item: merchantData.stock[0] },
  });
  nodes.push({
    type: "combat",
    scene: boss.scene,
    monster_name: boss.monster_name,
    monster_max_hp: boss.monster_max_hp,
    tier: boss.tier,
    drops_key: true,
    drops_key_tier: "silver" as KeyTier,
  });
  const treasureLoot = treasureRolls.map((roll, i) => mkLootOption(roll, treasureNamed[i]));
  nodes.push({
    type: "treasure",
    scene: "The dungeon opens onto its heart-chamber. A chest awaits.",
    loot_options: treasureLoot,
  });

  const pool: number[] = [];
  for (let i = 1; i < poolMiddleCount; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const expedition: ExpeditionState = {
    theme,
    current: 0,
    nodes,
    path_taken: [],
    keys: 0,
    pool,
    middle_count: middleCount,
    visited_count: 1,
    visited_indices: [0],
    sealed_doors: [],
  };

  const first = nodes[0];
  if (first.type === "combat") {
    return {
      monster_name: first.monster_name!,
      monster_hp: first.monster_max_hp!,
      monster_max_hp: first.monster_max_hp!,
      tier: first.tier!,
      scene: first.scene,
      variant: "dungeon",
      expedition,
    };
  }
  return {
    monster_name: "—",
    monster_hp: 0,
    monster_max_hp: 0,
    tier: baseTier,
    scene: first.scene,
    variant: "dungeon",
    expedition,
  };
}

// ── Grid dungeon scene builder (new system) ─────────────────────────────────
// Generates a SceneJson with `graph` populated (grid-based dungeon). The grid
// generator (packages/db/src/dungeon_grid.ts) handles layout + door placement;
// this function fills in AI-generated theme + monster names + loot flavor.
//
// Grid sizing: 4×4 (low tier), 4×5 (mid), 5×5 (high). Target ~10 rooms.
async function buildGridDungeonScene(
  env: Pick<Env, "AI" | "ART">,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  avoidNames: string[] = [],
): Promise<SceneJson> {
  const art = { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE };
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));
  const seed = Math.floor(Math.random() * 0x7fffffff);

  // Grid dims scale with level
  const width = character.level >= 5 ? 5 : 4;
  const height = character.level >= 4 ? 5 : 4;
  const targetRoomCount = Math.min(width * height, character.level >= 5 ? 14 : character.level >= 3 ? 12 : 10);

  // Pre-roll loot pools. We over-provision and pop from these in the callbacks.
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

  // Heuristic to spot the placeholder names mkLoot emits, so we only flavor
  // grid loot rather than re-naming catalog tools/scrolls that snuck in
  // (which currently aren't grid-routed but might be later).
  function isPlaceholderLootName(name: string): boolean {
    return /^(Weapon|Armor|Item) \(power \d+\)$/.test(name);
  }

  // Flavor a single LootOption in place. No-op if AI returns a falsy name.
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
      // Fall through — the placeholder name remains and the UI's
      // displayLootName fallback kicks in.
    }
  }

  // Roll AI theme + boss + a few monster packs in parallel.
  // Encounter rooms get one "leader" monster from `encounterScenes`. From
  // tier 3 onward, some encounters also pull a "minion" from a separate
  // bonus pool — minions are pre-generated so their names stay flavorful
  // even when we double up. Minion HP is reduced (~70%) so packs don't
  // overwhelm pacing relative to the single-monster baseline.
  const encounterCount = Math.max(3, Math.floor(targetRoomCount * 0.4));
  const bonusPoolSize = baseTier >= 3 ? Math.max(2, Math.ceil(encounterCount / 2)) : 0;
  const [theme, ...allScenes] = await Promise.all([
    generateExpeditionTheme(env.AI),
    ...Array.from({ length: encounterCount + bonusPoolSize }, () =>
      generateOpeningScene(env.AI, character, elite, "standard", undefined, avoidNames, art),
    ),
  ]);
  const encounterScenes = allScenes.slice(0, encounterCount);
  const bonusScenes = allScenes.slice(encounterCount);

  const bossScene = await generateOpeningScene(env.AI, character, elite, "boss", undefined, avoidNames, art);

  const encounterLeaders: MonsterSpec[] = encounterScenes.map((s) => ({
    name: s.monster_name,
    hp: s.monster_max_hp,
    max_hp: s.monster_max_hp,
    tier: s.tier,
    art_url: s.monster_art_url ?? null,
    flavor: s.scene,
  }));
  const bonusMinions: MonsterSpec[] = bonusScenes.map((s) => ({
    name: s.monster_name,
    // Minions are ~70% HP — keeps the fight from doubling in length.
    hp: Math.max(8, Math.round(s.monster_max_hp * 0.7)),
    max_hp: Math.max(8, Math.round(s.monster_max_hp * 0.7)),
    tier: Math.max(1, s.tier - 1),
    art_url: s.monster_art_url ?? null,
    flavor: s.scene,
  }));
  const bossPack: MonsterSpec[] = [{
    name: bossScene.monster_name,
    hp: bossScene.monster_max_hp,
    max_hp: bossScene.monster_max_hp,
    tier: bossScene.tier,
    is_boss: true,
    art_url: bossScene.monster_art_url ?? null,
    flavor: bossScene.scene,
  }];

  let encounterIdx = 0;
  let bonusIdx = 0;
  function rollMonsterPack(isBoss: boolean): MonsterSpec[] {
    if (isBoss) return bossPack;
    // Cycle through pre-rolled leaders; if we run out, wrap.
    const leader = encounterLeaders[encounterIdx % encounterLeaders.length];
    encounterIdx++;
    const pack: MonsterSpec[] = [{ ...leader, hp: leader.max_hp }]; // fresh copy

    // Pack-size odds driven by character level (progression gate) + elite
    // difficulty (hard-mode bump). Low levels stay solo so new players aren't
    // overwhelmed; mid-game pairs become common; high-level elite quests can
    // see rare triples.
    //   Level 1-2 : solo only
    //   Level 3-4 : 20% pair  /  2% triple
    //   Level 5-6 : 30% pair  / 10% triple
    //   Level 7+  : 40% pair  / 18% triple
    // Elite adds  :+15% pair  /+10% triple on top of the base
    const lvl = character.level;
    const basePair   = lvl >= 7 ? 0.40 : lvl >= 5 ? 0.30 : lvl >= 3 ? 0.20 : 0;
    const baseTriple = lvl >= 7 ? 0.18 : lvl >= 5 ? 0.10 : lvl >= 3 ? 0.02 : 0;
    const pairChance   = Math.min(0.65, basePair   + (elite ? 0.15 : 0));
    const tripleChance = Math.min(0.35, baseTriple + (elite ? 0.10 : 0));

    const r = Math.random();
    const extras = r < tripleChance ? 2 : r < tripleChance + pairChance ? 1 : 0;

    for (let i = 0; i < extras && bonusMinions.length > 0; i++) {
      const minion = bonusMinions[bonusIdx % bonusMinions.length];
      bonusIdx++;
      pack.push({ ...minion, hp: minion.max_hp }); // fresh copy
    }
    return pack;
  }

  function rollLoot(rollTier: number, kind: "loot" | "treasure" | "merchant" | "npc"): LootOption[] {
    const count = kind === "treasure" ? 3 : kind === "merchant" ? 3 : kind === "loot" ? 2 : 1;
    return Array.from({ length: count }, () => mkLoot(rollTier));
  }

  const failDamage = 4 + Math.max(1, character.level);
  function rollTrap(_tier: number): TrapChoice[] {
    return [
      { text: "Force your way through", emoji: "💪", skill: "str", fail_damage: failDamage },
      { text: "Disarm the mechanism", emoji: "🔧", skill: "dex", fail_damage: failDamage },
      { text: "Decipher the ward", emoji: "📜", skill: "int", fail_damage: failDamage },
    ];
  }

  function npcGreeting(): string {
    return "A weary traveler nods at you. \"Care to trade?\"";
  }
  function merchantGreeting(): string {
    return "A hooded merchant gestures at their wares.";
  }
  // Random portraits from the pre-generated NPC/merchant pools. Each room
  // picks a different one (deterministic by seed once we read it).
  const NPC_KEYS = ["npc_portrait_1", "npc_portrait_2", "npc_portrait_3", "npc_portrait_4", "npc_portrait_5", "npc_portrait_6"];
  const MERCHANT_KEYS = ["merchant_portrait_1", "merchant_portrait_2", "merchant_portrait_3", "merchant_portrait_4", "merchant_portrait_5"];
  function npcArtUrl(): string {
    const k = NPC_KEYS[Math.floor(Math.random() * NPC_KEYS.length)];
    return `${WEB_PUBLIC_BASE}/img/art/views/v6/${k}.png`;
  }
  function merchantArtUrl(): string {
    const k = MERCHANT_KEYS[Math.floor(Math.random() * MERCHANT_KEYS.length)];
    return `${WEB_PUBLIC_BASE}/img/art/views/v6/${k}.png`;
  }
  function describeRoom(kind: GridRoomContent["kind"], _shape: string): string {
    switch (kind) {
      case "entry": return "You step into the dungeon. The way forward beckons.";
      case "empty": return "A quiet stretch of corridor. Dust drifts in shafts of light.";
      case "encounter": return "A foe lurks ahead.";
      case "boss": return "The boss-chamber. Something terrible waits within.";
      case "loot": return "An item glints on the floor.";
      case "key_pickup": return "A key dangles from a rusted hook.";
      case "trap": return "Suspicious mechanisms line the walls.";
      case "lockbox": return "A locked chest sits in the room.";
      case "npc": return "Someone is here.";
      case "merchant": return "A merchant's stall has been set up here.";
    }
  }

  const graph = generateGridDungeon({
    seed,
    tier: baseTier,
    width,
    height,
    targetRoomCount,
    rollMonsterPack,
    rollLoot,
    rollTrap,
    npcGreeting,
    merchantGreeting,
    npcArtUrl,
    merchantArtUrl,
    describeRoom,
  });

  // Post-pass: replace the placeholder "Weapon (power N)" / "Item (power N)"
  // / "Armor (power N)" names generated by mkLoot with AI-flavored names +
  // flavor blurbs. The grid generator is pure & synchronous and can't await
  // AI calls; doing it here in parallel keeps dungeon-start latency
  // bounded while still giving boss treasure / lockbox / merchant / npc
  // loot proper names. Failures fall through to placeholder display.
  {
    const tasks: Promise<void>[] = [];
    for (const node of Object.values(graph.nodes)) {
      const c = node.content;
      if (!c) continue;
      if (c.kind === "boss" && c.treasure) {
        for (const it of c.treasure) tasks.push(flavorOne("the boss's hoard", it));
      } else if (c.kind === "loot" && c.items) {
        for (const it of c.items) tasks.push(flavorOne("the room floor", it));
      } else if (c.kind === "lockbox" && c.options) {
        for (const it of c.options) tasks.push(flavorOne("the locked chest", it));
      } else if (c.kind === "npc" && c.offer) {
        tasks.push(flavorOne("the traveler's pack", c.offer));
      } else if (c.kind === "merchant" && c.stock) {
        for (const it of c.stock) tasks.push(flavorOne("the merchant's stall", it));
      }
    }
    await Promise.all(tasks);
  }

  // Entry node carries the scene's display info.
  const entry = graph.nodes[graph.current];
  return {
    monster_name: "—",
    monster_hp: 0,
    monster_max_hp: 0,
    tier: baseTier,
    scene: entry.description,
    variant: "dungeon",
    graph,
  };
}

// Start a fresh quest. Supports standard / boss / gauntlet / dungeon variants.
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
  const body = (await c.req.json().catch(() => null)) as
    | { variant?: unknown; elite?: unknown; monster_count?: unknown }
    | null;
  const variant = body?.variant;
  const elite = body?.elite === true;
  const jobMonsterCount = typeof body?.monster_count === "number" ? Math.max(1, Math.min(3, body.monster_count as number)) : 1;
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "dungeon" && variant !== "bounty_pack") {
    return c.json({ error: "unsupported_variant", variant }, 400);
  }
  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return c.json({ error: "boss_level_gate", required: BOSS_LEVEL_REQUIRED }, 400);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return c.json({ error: "gauntlet_level_gate", required: GAUNTLET_LEVEL_REQUIRED }, 400);
  }
  if (variant === "dungeon" && character.level < DUNGEON_LEVEL_REQUIRED) {
    return c.json({ error: "dungeon_level_gate", required: DUNGEON_LEVEL_REQUIRED }, 400);
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
  } else if (variant === "dungeon") {
    scene = await buildGridDungeonScene(c.env, character, elite, avoidNames);
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

  // Slack announcement + recruitment card. Fire-and-forget via waitUntil
  // so the response doesn't wait on Slack API latency. Skipped when no
  // real Slack channel is known (web-only users have effectiveChannel
  // set to a synthetic "web:<userId>" sentinel which we filter on).
  if (channelId && c.env.SLACK_BOT_TOKEN) {
    c.executionCtx.waitUntil((async () => {
      const ts = await announceWebQuestToSlack(c.env, {
        channelId,
        questId,
        userId: session.slack_user_id,
        characterName: character.name,
        characterClass: character.class,
        characterLevel: character.level,
        elite,
        variant: variant as "standard" | "boss" | "gauntlet" | "dungeon",
        monsterName: scene.monster_name,
        monsterMaxHp: scene.monster_max_hp,
        sceneText: scene.scene,
        totalWaves: scene.total_waves,
        webBaseUrl: WEB_PUBLIC_BASE,
      });
      if (ts) await setQuestThreadTs(c.env.DB, questId, ts);
    })());
  }

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
  const body = (await c.req.json().catch(() => null)) as
    | { variant?: unknown; elite?: unknown; invitees?: unknown }
    | null;
  const variant = body?.variant;
  const elite = body?.elite === true;
  const invitees = Array.isArray(body?.invitees)
    ? (body!.invitees as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "dungeon") {
    return c.json({ error: "unsupported_variant" }, 400);
  }
  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return c.json({ error: "boss_level_gate", required: BOSS_LEVEL_REQUIRED }, 400);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return c.json({ error: "gauntlet_level_gate", required: GAUNTLET_LEVEL_REQUIRED }, 400);
  }
  if (variant === "dungeon" && character.level < DUNGEON_LEVEL_REQUIRED) {
    return c.json({ error: "dungeon_level_gate", required: DUNGEON_LEVEL_REQUIRED }, 400);
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
  } else if (variant === "dungeon") {
    scene = await buildGridDungeonScene(c.env, character, elite, avoidNames);
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

    // DM each invitee
    const token = c.env.SLACK_BOT_TOKEN;
    if (token) {
      const questLabel =
        variant === "dungeon" ? "a dungeon expedition"
        : variant === "boss" ? "a boss fight"
        : variant === "gauntlet" ? "a gauntlet"
        : "a quest";
      c.executionCtx.waitUntil((async () => {
        // Fetch slack_username for each invitee — only DM users with a real Slack presence
        const rows = await c.env.DB
          .prepare(`SELECT slack_user_id, slack_username FROM characters WHERE slack_user_id IN (${invitees.map(() => "?").join(",")})`)
          .bind(...invitees)
          .all<{ slack_user_id: string; slack_username: string | null }>();
        const slackUsers = new Map((rows.results ?? []).filter((r) => r.slack_username).map((r) => [r.slack_user_id, r]));
        await Promise.all(invitees.filter((uid) => slackUsers.has(uid)).map(async (uid) => {
          const openRes = await fetch("https://slack.com/api/conversations.open", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ users: uid }),
          });
          const openData = (await openRes.json()) as { ok: boolean; channel?: { id: string } };
          if (!openData.ok || !openData.channel?.id) return;
          await postSlackMessage(token, {
            channel: openData.channel.id,
            text: `⚔️ *${character.name}* invited you to join ${questLabel}! Open the web app to accept or decline: ${WEB_PUBLIC_BASE}`,
          });
        }));
      })());
    }

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
  // worker. Quest-shape locks (gauntlet wave 1+, dungeon past entry room)
  // still apply because those are about state, not surface ownership.
  if (quest.scene.variant === "gauntlet" && (quest.scene.wave ?? 1) > 1) {
    return c.json({ joinable: null, reason: "gauntlet_advanced" });
  }
  if (quest.scene.variant === "dungeon") {
    const exp = quest.scene.expedition;
    const advanced = (exp?.visited_count ?? 1) > 1 || (exp?.pending_doors?.length ?? 0) > 0;
    if (advanced) return c.json({ joinable: null, reason: "dungeon_advanced" });
  }
  return c.json({
    joinable: {
      quest_id: quest.id,
      channel_id: quest.channel_id,
      variant: quest.scene.variant ?? "standard",
      elite: quest.elite,
      monster_name: quest.scene.monster_name,
      monster_max_hp: quest.scene.monster_max_hp,
      scene: quest.scene.scene,
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
  if (quest.scene.variant === "dungeon") {
    const exp = quest.scene.expedition;
    const advanced = (exp?.visited_count ?? 1) > 1 || (exp?.pending_doors?.length ?? 0) > 0;
    if (advanced) return c.json({ error: "dungeon_advanced" }, 400);
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

  // Cross-surface notification: Slack players watching the thread see who
  // walked in from the browser. Fire-and-forget via ctx.waitUntil so a slow
  // or failing Slack call doesn't slow down the user's join response. Plain
  // thread reply (not broadcast) — joins from /sq join also use thread-only
  // visibility; broadcast budget is reserved for the bigger beats (boss,
  // phase 2, victory/defeat).
  if (c.env.SLACK_BOT_TOKEN && quest.thread_ts) {
    c.executionCtx.waitUntil(
      postSlackMessage(c.env.SLACK_BOT_TOKEN, {
        channel: quest.channel_id,
        thread_ts: quest.thread_ts,
        text: `🌐 <@${session.slack_user_id}> joined from the web.`,
      }).catch(() => {
        // Notification is best-effort — never let it surface as a join error.
      }),
    );
  }

  return c.json({
    ok: true,
    quest_id: quest.id,
    monster_hp_added: scaled.monster_max_hp - quest.scene.monster_max_hp,
  });
});

// Key economy — sell or transmute dungeon keys between quests.
// Mirrors /sq sell-key and /sq transmute in Slack.
const KEY_SELL_PRICE: Record<"bronze" | "silver" | "gold", number> = {
  bronze: 5,
  silver: 25,
  gold: 100,
};
const KEY_TRANSMUTE_COST = 3;

app.post("/api/keys/sell", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = (await c.req.json().catch(() => null)) as { tier?: unknown } | null;
  const tier = body?.tier;
  if (tier !== "bronze" && tier !== "silver" && tier !== "gold") {
    return c.json({ error: "bad_tier" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const have = tier === "bronze" ? character.keys_bronze : tier === "silver" ? character.keys_silver : character.keys_gold;
  if (have < 1) return c.json({ error: "no_keys", have }, 400);
  const price = KEY_SELL_PRICE[tier];
  await addCharacterKey(c.env.DB, session.slack_user_id, tier, -1);
  await addGold(c.env.DB, session.slack_user_id, price);
  return c.json({ ok: true, tier, price, new_gold: character.gold + price });
});

app.post("/api/keys/transmute", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const body = (await c.req.json().catch(() => null)) as { from_tier?: unknown } | null;
  const fromTier = body?.from_tier;
  if (fromTier !== "bronze" && fromTier !== "silver") {
    return c.json({ error: "bad_tier" }, 400);
  }
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const toTier = fromTier === "bronze" ? "silver" : "gold";
  const have = fromTier === "bronze" ? character.keys_bronze : character.keys_silver;
  if (have < KEY_TRANSMUTE_COST) {
    return c.json({ error: "not_enough_keys", have, need: KEY_TRANSMUTE_COST }, 400);
  }
  await addCharacterKey(c.env.DB, session.slack_user_id, fromTier, -KEY_TRANSMUTE_COST);
  await addCharacterKey(c.env.DB, session.slack_user_id, toTier, 1);
  return c.json({ ok: true, from_tier: fromTier, to_tier: toTier, cost: KEY_TRANSMUTE_COST });
});

// Town overview — returns AI art URLs for the map + each district. Lightweight:
// no quest/character check required, just session.
app.get("/api/town", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const art = artTarget(c.env);
  const [overview, pub, shop, inn, smithy, apothecary, outskirts] = await Promise.all([
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "town_overview", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "pub_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "channel_shop", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "inn_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "smithy_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "apothecary", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "outskirts", undefined, TOWN_WEEKLY_MS),
  ]);
  return c.json({ overview_art_url: overview, pub_art_url: pub, shop_art_url: shop, inn_art_url: inn, smithy_art_url: smithy, apothecary_art_url: apothecary, outskirts_art_url: outskirts });
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
      variant: "standard" | "boss" | "dungeon" | "gauntlet";
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
  const EXPEDITION_LEVEL_REQUIRED_LOCAL = 1;

  const [jobStd, jobBoss, jobDung, jobPack] = await Promise.all([
    generateJobListing(ai, "standard", townName),
    generateJobListing(ai, "boss", townName),
    generateJobListing(ai, "dungeon", townName),
    generateJobListing(ai, "bounty_pack", townName),
  ]);

  // Pack size 2 vs 3: alternate daily based on refresh timestamp parity.
  const packSize = Math.floor(now / (24 * 60 * 60 * 1000)) % 2 === 0 ? 2 : 3;

  const jobs = [
    { id: "job_1", variant: "standard" as const, required_level: 1, title: jobStd.title, blurb: jobStd.blurb, reward_summary: "1× rewards · +12% town bonus · single foe." },
    { id: "job_2", variant: "boss" as const, required_level: BOSS_LEVEL_REQUIRED_LOCAL, title: jobBoss.title, blurb: jobBoss.blurb, reward_summary: "2× rewards · +12% town bonus · two phases." },
    { id: "job_3", variant: "dungeon" as const, required_level: EXPEDITION_LEVEL_REQUIRED_LOCAL, title: jobDung.title, blurb: jobDung.blurb, reward_summary: "2.5× rewards · +12% town bonus · 5-7 rooms, sub-boss, treasure." },
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
      variant: "standard" | "boss" | "dungeon" | "gauntlet" | "bounty_pack";
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
      variant: "standard" | "boss" | "dungeon" | "gauntlet" | "bounty_pack";
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
  } else if (variant === "dungeon") {
    scene = await buildGridDungeonScene(c.env, character, false, avoidNames);
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

  // Announce the board-claim quest the same way the main /api/quest/start
  // path does. Job-board quests are always non-elite + non-dungeon-mid-flow
  // by definition (fresh claim, fresh quest).
  if (c.env.SLACK_BOT_TOKEN) {
    c.executionCtx.waitUntil((async () => {
      const ts = await announceWebQuestToSlack(c.env, {
        channelId,
        questId,
        userId: session.slack_user_id,
        characterName: character.name,
        characterClass: character.class,
        characterLevel: character.level,
        elite: false,
        variant: variant as "standard" | "boss" | "gauntlet" | "dungeon",
        monsterName: scene.monster_name,
        monsterMaxHp: scene.monster_max_hp,
        sceneText: scene.scene,
        totalWaves: scene.total_waves,
        webBaseUrl: WEB_PUBLIC_BASE,
      });
      if (ts) await setQuestThreadTs(c.env.DB, questId, ts);
    })());
  }

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
  const body = await c.req.json().catch(() => null) as { tier?: number; monster_count?: number; invitees?: unknown } | null;
  const requestedTier = body?.tier;
  if (typeof requestedTier !== "number" || !Number.isInteger(requestedTier) || requestedTier < 1) {
    return c.json({ error: "invalid_tier" }, 400);
  }
  const tier = Math.min(requestedTier, character.level);
  const monsterCount = Math.max(1, Math.min(3, Number.isInteger(body?.monster_count) ? (body!.monster_count as number) : 1));
  const invitees = Array.isArray(body?.invitees)
    ? (body!.invitees as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5)
    : [];

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
  // picks them up the same way dungeon encounters do.
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
  });

  if (invitees.length > 0) {
    await Promise.all(invitees.map((uid) => addPendingInvitee(c.env.DB, questId, uid)));
    const token = c.env.SLACK_BOT_TOKEN;
    if (token) {
      c.executionCtx.waitUntil((async () => {
        const rows = await c.env.DB
          .prepare(`SELECT slack_user_id, slack_username FROM characters WHERE slack_user_id IN (${invitees.map(() => "?").join(",")})`)
          .bind(...invitees)
          .all<{ slack_user_id: string; slack_username: string | null }>();
        const slackUsers = new Map((rows.results ?? []).filter((r) => r.slack_username).map((r) => [r.slack_user_id, r]));
        await Promise.all(invitees.filter((uid) => slackUsers.has(uid)).map(async (uid) => {
          const openRes = await fetch("https://slack.com/api/conversations.open", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ users: uid }),
          });
          const openData = (await openRes.json()) as { ok: boolean; channel?: { id: string } };
          if (!openData.ok || !openData.channel?.id) return;
          await postSlackMessage(token, {
            channel: openData.channel.id,
            text: `⚔️ *${character.name}* invited you to join an outskirts hunt! Open the web app to accept or decline: ${WEB_PUBLIC_BASE}`,
          });
        }));
      })());
    }
    return c.json({ ok: true, quest_id: questId, lobby: true });
  }

  await refillMana(c.env.DB, session.slack_user_id);

  // Hunt quests are rapid solo grind — skip the Slack announcement so the
  // channel isn't spammed every time someone grinds outskirts mobs.

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
// Allowed mid-quest (unlike rolled stock) because staples are also sold by
// the in-dungeon merchant in slack; keeping parity here lets the player
// stock up before/between/inside fights uniformly.
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

  return c.json({ downed, staples, gold: character.gold, revive_count: reviveCount, art_url });
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
      const restored = await addMana(c.env.DB, character, item.power);
      await removeItem(c.env.DB, item.id);
      return c.json({ ok: true, kind: "mana", restored, requested: item.power });
    }
    const healed = await consumeItem(c.env.DB, character, item);
    return c.json({ ok: true, kind: "heal", healed });
  }
  if (item.item_type === "magic") {
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

  // Announce to Slack so channel members can see and join or side-bet.
  if (c.env.SLACK_BOT_TOKEN) {
    c.executionCtx.waitUntil((async () => {
      try {
        const slackResult = await postSlackMessage(c.env.SLACK_BOT_TOKEN!, {
          channel: channelId,
          text: `🪨📜🗡 *Stone-Parchment-Dagger* — <@${session.slack_user_id}> opened a match for *${stake}g* from the web. Their throw is committed.\n_Join with \`/gq pub\` to accept or place a side bet (pays 2×)._`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🪨📜🗡 *Stone-Parchment-Dagger*\n<@${session.slack_user_id}> opened a match for *${stake}g* from the web. Their throw is committed.`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `_No side bets yet._`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "⚔️ Accept match", emoji: true },
                  action_id: `spd_accept_${matchId}`,
                  style: "primary",
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: `💰 Bet on ${character.name}`, emoji: true },
                  action_id: `spd_bet_${matchId}`,
                },
              ],
            },
          ],
        });
        if (slackResult.ok && slackResult.ts) {
          await c.env.DB
            .prepare("UPDATE spd_matches SET message_ts = ? WHERE id = ?")
            .bind(slackResult.ts, matchId)
            .run();
        }
      } catch (err) {
        console.warn("spd:web-open-announce-error", { matchId, err: err instanceof Error ? err.message : String(err) });
      }
    })());
  }

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
  // that missed the WS frame, but mounting GridDungeonView with that
  // row still present caused the previous fight's victory overlay to
  // flash on every new room entry until the next start_web_combat
  // cleaned it up.
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

  if (env.SLACK_BOT_TOKEN && quest.lobby_ts) {
    await postSlackMessage(env.SLACK_BOT_TOKEN, {
      channel: quest.channel_id,
      text: "✅ *Quest started!* Everyone is in.",
    });
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

  // Send a Slack DM only if the target has a Slack username (i.e. a real Slack presence)
  const dmToken = c.env.SLACK_BOT_TOKEN;
  if (dmToken && target.slack_username) {
    const inviter = await getCharacter(c.env.DB, session.slack_user_id);
    const questLabel =
      (quest.scene as { expedition?: { theme: string } | null; variant?: string; monster_name?: string }).expedition?.theme
        ? `a dungeon expedition`
        : (quest.scene as { variant?: string; monster_name?: string }).variant === "boss"
          ? `a boss fight`
          : `a quest`;
    c.executionCtx.waitUntil((async () => {
      const openRes = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${dmToken}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ users: body.target_user_id }),
      });
      const openData = (await openRes.json()) as { ok: boolean; channel?: { id: string } };
      if (!openData.ok || !openData.channel?.id) return;
      await postSlackMessage(dmToken, {
        channel: openData.channel.id,
        text: `⚔️ *${inviter?.name ?? "Someone"}* invited you to join ${questLabel}! Open the web app to accept or decline: ${WEB_PUBLIC_BASE}`,
      });
    })());
  }

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
app.get("/api/leaderboard", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const entries = await getQuestLeaderboard(c.env.DB, 10);
  return c.json({ entries });
});

// Starts (or resumes) web-mode combat for the user's active quest. Snapshots
// the party + monster from D1 into a CombatState, rolls initiative, and saves
// to web_combat_state. Idempotent: if a state already exists for this quest,
// the existing one is returned untouched so a refresh in the middle of a
// fight doesn't reset progress.
//
// v1 limits: standard + boss variants only. Gauntlet/dungeon stay on Slack.
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
  // WS clients that connected before combat started (the dungeon view
  // keeps its WS open across the whole expedition). Without this nudge
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

// Mirrors slack's pickNextRoom — picks where the party heads after the
// current room resolves. Duplicated here for v1; if a third surface needs
// expedition logic we'll factor this into a shared core helper.
type ExpNode = {
  type: "combat" | "trap" | "lockbox" | "npc" | "treasure" | "merchant";
  scene: string;
  monster_name?: string;
  monster_max_hp?: number;
  tier?: number;
  loot_options?: unknown[];
  lock_tier?: "bronze" | "silver" | "gold";
};
type ExpState = {
  theme: string;
  current: number;
  nodes: ExpNode[];
  pool?: number[];
  pending_doors?: number[];
  visited_count?: number;
  visited_indices?: number[];
  sealed_doors?: number[];
};

function pickNextRoom(
  exp: ExpState,
): { type: "doors"; pair: number[]; remainingPool: number[] } | { type: "node"; index: number; remainingPool: number[] } {
  const treasureIdx = exp.nodes.length - 1;
  const subBossIdx = exp.nodes.length - 2;
  const merchantIdx = exp.nodes.length - 3;
  const pool = [...(exp.pool ?? [])];
  if (exp.current === subBossIdx) return { type: "node", index: treasureIdx, remainingPool: pool };
  if (exp.current === merchantIdx) return { type: "doors", pair: [subBossIdx], remainingPool: pool };
  if (pool.length >= 2) {
    const a = pool.shift()!;
    const b = pool.shift()!;
    return { type: "doors", pair: [a, b], remainingPool: pool };
  }
  if (pool.length === 1) return { type: "doors", pair: [pool.shift()!], remainingPool: pool };
  return { type: "doors", pair: [merchantIdx], remainingPool: pool };
}

// Applies a resolved non-combat room outcome: hp damage if any, then
// advance the expedition (doors or auto-advance) into the next scene.
async function advanceDungeon(
  db: D1Database,
  questId: number,
  exp: ExpState,
  scene: { tier: number; [k: string]: unknown },
  actorHpAfter: { user_id: string; hp: number } | null,
): Promise<{ next_room?: string; pending_doors?: number[] }> {
  if (actorHpAfter) {
    await db
      .prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(Math.max(0, actorHpAfter.hp), Date.now(), actorHpAfter.user_id)
      .run();
  }
  const next = pickNextRoom(exp);
  if (next.type === "doors") {
    const updatedExp = { ...exp, pool: next.remainingPool, pending_doors: next.pair };
    const updatedScene = { ...scene, expedition: updatedExp };
    await saveScene(db, questId, updatedScene as never);
    return { pending_doors: next.pair };
  }
  const nextNode = exp.nodes[next.index];
  if (!nextNode) return {};
  const isCombat = nextNode.type === "combat";
  const updatedExp = {
    ...exp,
    current: next.index,
    pool: next.remainingPool,
    pending_doors: undefined,
    visited_count: (exp.visited_count ?? 1) + 1,
    visited_indices: [...(exp.visited_indices ?? [exp.current]), next.index],
  };
  const updatedScene = {
    ...scene,
    expedition: updatedExp,
    scene: nextNode.scene,
    monster_name: isCombat ? nextNode.monster_name ?? "—" : "—",
    monster_max_hp: isCombat ? nextNode.monster_max_hp ?? 0 : 0,
    monster_hp: isCombat ? nextNode.monster_max_hp ?? 0 : 0,
    tier: isCombat ? nextNode.tier ?? scene.tier : scene.tier,
    monster_effects: [],
  };
  await saveScene(db, questId, updatedScene as never);
  return { next_room: nextNode.type };
}

// Mirrors slack's /sq choose for trap rooms — picks among 3 skill-check
// options. Expert classes auto-pass; others roll d6 ≥ 4. Fail = take the
// option's fail_damage to HP. Either way advances the expedition.
app.post("/api/quest/:id/dungeon/trap_choose", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const exp = quest.scene.expedition;
  const node = exp?.nodes[exp.current];
  if (!exp || !node || node.type !== "trap") return c.json({ error: "not_a_trap_room" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  const choices = node.trap_choices ?? [];
  if (!Number.isFinite(pick) || pick < 1 || pick > choices.length) {
    return c.json({ error: "bad_pick", valid_picks: choices.length }, 400);
  }
  const choice = choices[pick - 1];
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const cls = classByName(character.class);
  const isExpert = cls.skills.includes(choice.skill);
  const roll = isExpert ? null : rollDice(6);
  const passed = isExpert || (roll !== null && roll >= 4);
  const hpAfter = passed ? character.hp : Math.max(0, character.hp - choice.fail_damage);

  const advance = await advanceDungeon(
    c.env.DB,
    questId,
    exp as ExpState,
    quest.scene as never,
    passed ? null : { user_id: session.slack_user_id, hp: hpAfter },
  );
  return c.json({
    passed,
    expert: isExpert,
    roll,
    skill: choice.skill,
    fail_damage: passed ? 0 : choice.fail_damage,
    ...advance,
  });
});

// Treasure pick — final dungeon room. Player picks 1 of N loot options;
// item lands in their inventory; quest is marked completed with full
// dungeon spoils (mult 2.5). Mirrors slack's resolveExpeditionVictory.
app.post("/api/quest/:id/dungeon/treasure_take", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const exp = quest.scene.expedition;
  const node = exp?.nodes[exp.current];
  if (!exp || !node || node.type !== "treasure") return c.json({ error: "not_a_treasure_room" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  const opts = node.loot_options ?? [];
  if (!Number.isFinite(pick) || pick < 1 || pick > opts.length) {
    return c.json({ error: "bad_pick", valid_picks: opts.length }, 400);
  }
  const choice = opts[pick - 1];
  const taken = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: choice.slot ?? null,
    stat_bonus: choice.stat_bonus ?? null,
    item_subtype: choice.item_subtype ?? null,
    level_req: choice.level_req,
    element: choice.element ?? null,
  });

  // Full dungeon spoils — dungeon variant rewardMultiplier = 2.5.
  const tier = quest.scene.tier;
  const totalXp = Math.round((10 + tier * 5) * 2.5);
  const totalGold = Math.round((5 + tier * 3) * 2.5);
  const party = await getQuestParty(c.env.DB, questId);
  const partySize = Math.max(1, party.length);
  const xpEach = Math.max(1, Math.floor(totalXp / partySize * partyXpBonus(partySize)));
  const goldEach = Math.max(0, Math.floor(totalGold / partySize));
  const levelUps: { user_id: string; new_level: number }[] = [];
  for (const f of party) {
    const result = await awardSpoils(
      c.env.DB,
      f,
      xpEach,
      goldEach,
      () => rollDice(6),
      xpForLevel,
    );
    if (result.levelsGained > 0) {
      levelUps.push({ user_id: f.slack_user_id, new_level: result.newLevel });
    }
  }
  await markQuestStatus(c.env.DB, questId, "completed");
  await clearPartyEffects(c.env.DB, questId);

  return c.json({
    completed: true,
    taken_item: {
      id: taken.id,
      name: taken.item_name,
      rarity: taken.rarity,
      type: taken.item_type,
      power: taken.power,
    },
    xp_each: xpEach,
    gold_each: goldEach,
    party_size: partySize,
    level_ups: levelUps,
  });
});

// Mirrors slack's pickKeyForLock — picks the cheapest key on the character
// that meets or exceeds the lock tier. Returns null if none qualifies.
const TIER_RANK: Record<"bronze" | "silver" | "gold", number> = { bronze: 0, silver: 1, gold: 2 };
function pickKeyForLock(
  character: { keys_bronze: number; keys_silver: number; keys_gold: number },
  lock: "bronze" | "silver" | "gold",
): "bronze" | "silver" | "gold" | null {
  for (const t of ["bronze", "silver", "gold"] as const) {
    if (TIER_RANK[t] < TIER_RANK[lock]) continue;
    const count = t === "bronze" ? character.keys_bronze : t === "silver" ? character.keys_silver : character.keys_gold;
    if (count > 0) return t;
  }
  return null;
}

// Lockbox resolution — mirrors /sq choose for lockbox rooms. Pick 1..N to
// claim a loot option (spends a key of node.lock_tier or higher); pick
// length+1 to skip without spending.
app.post("/api/quest/:id/dungeon/lockbox_choose", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const exp = quest.scene.expedition;
  const node = exp?.nodes[exp.current];
  if (!exp || !node || node.type !== "lockbox") return c.json({ error: "not_a_lockbox_room" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  const opts = node.loot_options ?? [];
  const skipIdx = opts.length + 1;
  if (!Number.isFinite(pick) || pick < 1 || pick > skipIdx) {
    return c.json({ error: "bad_pick", valid_picks: skipIdx }, 400);
  }
  if (pick === skipIdx) {
    const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
    return c.json({ skipped: true, ...advance });
  }
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const lockTier = node.lock_tier ?? "bronze";
  const keyTier = pickKeyForLock(character, lockTier);
  if (!keyTier) return c.json({ error: "no_key", lock_tier: lockTier }, 400);

  const choice = opts[pick - 1];
  await addCharacterKey(c.env.DB, session.slack_user_id, keyTier, -1);
  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: (choice as { slot?: string }).slot as import("@gantt-quest/core").EquipSlot | undefined,
    stat_bonus: (choice as { stat_bonus?: Record<string, number> }).stat_bonus,
    item_subtype: (choice as { item_subtype?: string }).item_subtype,
    element: (choice as { element?: ElementType }).element ?? null,
  });
  const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
  return c.json({
    skipped: false,
    key_spent: keyTier,
    item: { id: item.id, name: item.item_name, rarity: item.rarity, type: item.item_type, power: item.power },
    ...advance,
  });
});

// NPC resolution — pick 1 = trust (1d6 + npcTrustMod against three buckets
// betrayed/tainted/clean), pick 2 = refuse (no effect, free advance).
app.post("/api/quest/:id/dungeon/npc_choose", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const exp = quest.scene.expedition;
  const node = exp?.nodes[exp.current];
  if (!exp || !node || node.type !== "npc") return c.json({ error: "not_an_npc_room" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  if (pick !== 1 && pick !== 2) return c.json({ error: "bad_pick" }, 400);

  if (pick === 2) {
    const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
    return c.json({ refused: true, ...advance });
  }

  // Trust path
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const offer = node.npc?.item;
  if (!offer) {
    const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
    return c.json({ outcome: "empty", ...advance });
  }
  const mod = npcTrustMod(character.class);
  const roll = rollDice(6);
  const total = roll + mod;
  const bucket: "betrayed" | "tainted" | "clean" =
    total <= 2 ? "betrayed" : total === 3 ? "tainted" : "clean";

  if (bucket === "betrayed") {
    const damage = rollDice(4) + quest.scene.tier;
    const newHp = Math.max(0, character.hp - damage);
    const advance = await advanceDungeon(
      c.env.DB, questId, exp as ExpState, quest.scene as never,
      { user_id: session.slack_user_id, hp: newHp },
    );
    return c.json({ outcome: "betrayed", roll, modifier: mod, total, damage, ...advance });
  }

  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: offer.name,
    item_type: offer.item_type,
    power: offer.power,
    rarity: offer.rarity,
    flavor: offer.flavor,
    weapon_range: offer.weapon_range ?? null,
    slot: (offer as { slot?: string }).slot as import("@gantt-quest/core").EquipSlot | undefined,
    stat_bonus: (offer as { stat_bonus?: Record<string, number> }).stat_bonus,
    item_subtype: (offer as { item_subtype?: string }).item_subtype,
    element: (offer as { element?: ElementType }).element ?? null,
  });
  if (bucket === "tainted") {
    const bleed = { type: "bleeding" as const, magnitude: 2, remaining: 3, source: "tainted gift from a stranger" };
    const updatedEffects = [...(character.effects ?? []), bleed];
    await c.env.DB
      .prepare("UPDATE characters SET effects = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(JSON.stringify(updatedEffects), Date.now(), session.slack_user_id)
      .run();
  }
  const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
  return c.json({
    outcome: bucket,
    roll,
    modifier: mod,
    total,
    item: { id: item.id, name: item.item_name, rarity: item.rarity, type: item.item_type, power: item.power },
    ...advance,
  });
});

// Merchant room — buy stocked items with gold, or walk past. Mirrors
// /sq choose for merchant rooms in Slack.
//   pick 1..N → buy that item (deducts gold, adds to inventory, removes from stock)
//   pick N+1  → walk past (advance without spending)
// Stock is dungeon-instance-scoped: items not bought before advancing are gone.
app.post("/api/quest/:id/dungeon/merchant_choose", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const exp = quest.scene.expedition;
  const node = exp?.nodes[exp.current];
  if (!exp || !node || node.type !== "merchant") return c.json({ error: "not_a_merchant_room" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  const stock = node.loot_options ?? [];
  const skipIdx = stock.length + 1;
  if (!Number.isFinite(pick) || pick < 1 || pick > skipIdx) {
    return c.json({ error: "bad_pick", valid_picks: skipIdx }, 400);
  }

  // Walk past — advance without buying.
  if (pick === skipIdx) {
    const advance = await advanceDungeon(c.env.DB, questId, exp as ExpState, quest.scene as never, null);
    return c.json({ purchased: false, walked_past: true, ...advance });
  }

  // Buy path
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const choice = stock[pick - 1];
  if (!choice) return c.json({ error: "bad_pick" }, 400);

  const price = priceFor(choice.item_type, choice.rarity, choice.tier);
  if (character.gold < price) {
    return c.json({ error: "insufficient_gold", price, gold: character.gold }, 400);
  }

  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, price);
  if (!paid) return c.json({ error: "insufficient_gold", price }, 400);

  // Remove this item from stock (so it can't be bought twice) and persist.
  const remainingStock = stock.filter((_, i) => i !== pick - 1);
  const updatedNode = { ...node, loot_options: remainingStock };
  const updatedExp = {
    ...exp,
    nodes: exp.nodes.map((n, i) => (i === exp.current ? updatedNode : n)),
  };
  const updatedScene = { ...quest.scene, expedition: updatedExp };
  await saveScene(c.env.DB, questId, updatedScene);

  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: (choice as { slot?: string }).slot as import("@gantt-quest/core").EquipSlot | undefined,
    stat_bonus: (choice as { stat_bonus?: Record<string, number> }).stat_bonus,
    item_subtype: (choice as { item_subtype?: string }).item_subtype,
    element: (choice as { element?: ElementType }).element ?? null,
  });

  return c.json({
    purchased: true,
    walked_past: false,
    price,
    gold_remaining: character.gold - price,
    item: { id: item.id, name: item.item_name, rarity: item.rarity, type: item.item_type, power: item.power },
    remaining_stock: remainingStock.length,
  });
});

// Dungeon door pick from the dashboard — mirrors /sq choose 1|2 in Slack.
// Advances expedition.current to the chosen room, seals the other door,
// and updates scene_json's denormalized monster fields to the new room.
// No combat is started here — if the new room is combat, the player can
// click "Open Web Combat" on the dashboard next.
app.post("/api/quest/:id/dungeon/choose_door", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);

  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  if (quest.scene.variant !== "dungeon") return c.json({ error: "not_a_dungeon" }, 400);
  const exp = quest.scene.expedition;
  const doors = exp?.pending_doors ?? [];
  if (!exp || doors.length === 0) return c.json({ error: "no_pending_doors" }, 400);

  const body = (await c.req.json().catch(() => null)) as { pick?: unknown } | null;
  const pick = typeof body?.pick === "number" ? body.pick : NaN;
  if (!Number.isFinite(pick) || pick < 1 || pick > doors.length) {
    return c.json({ error: "bad_pick", valid_picks: doors.length }, 400);
  }

  const chosenIdx = doors[pick - 1];
  const otherIdx = doors[pick === 1 ? Math.min(1, doors.length - 1) : 0];
  const chosenNode = exp.nodes[chosenIdx];
  if (!chosenNode) return c.json({ error: "bad_dungeon_state" }, 500);

  const isCombat = chosenNode.type === "combat";
  const updatedExp = {
    ...exp,
    current: chosenIdx,
    pending_doors: undefined,
    visited_count: (exp.visited_count ?? 1) + 1,
    visited_indices: [...(exp.visited_indices ?? [exp.current]), chosenIdx],
    sealed_doors:
      doors.length > 1
        ? [...(exp.sealed_doors ?? []), otherIdx]
        : (exp.sealed_doors ?? []),
  };
  const updatedScene = {
    ...quest.scene,
    expedition: updatedExp,
    scene: chosenNode.scene,
    monster_name: isCombat ? chosenNode.monster_name ?? "—" : "—",
    monster_max_hp: isCombat ? chosenNode.monster_max_hp ?? 0 : 0,
    monster_hp: isCombat ? chosenNode.monster_max_hp ?? 0 : 0,
    tier: isCombat ? chosenNode.tier ?? quest.scene.tier : quest.scene.tier,
    monster_effects: [],
  };
  await saveScene(c.env.DB, quest.id, updatedScene);
  // Clear any stale combat state from the previous room so the dashboard
  // doesn't show "Resume Combat" when the player hasn't started the new one.
  await deleteWebCombatState(c.env.DB, quest.id);
  return c.json({ ok: true, room_type: chosenNode.type, is_combat: isCombat });
});

// ── Graph Dungeon routes (Phase 4) ───────────────────────────────────────────
// All graph dungeon mutations share the same auth + quest lookup boilerplate.
// The graph lives in scene_json.graph; these routes are feature-flagged by the
// presence of that field, not an env var (since the web doesn't carry DUNGEON_GRAPH).

app.get("/api/quest/:id/dungeon/graph", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const currentNode = graph.nodes[graph.current];
  return c.json({ ok: true, graph, current_node: currentNode ?? null });
});

app.post("/api/quest/:id/dungeon/graph/move", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);

  const body = (await c.req.json().catch(() => null)) as { direction?: unknown } | null;
  const dir = typeof body?.direction === "string" ? body.direction.toLowerCase() : "";
  const validDirs: DungeonDirection[] = ["n", "e", "s", "w"];
  if (!validDirs.includes(dir as DungeonDirection)) {
    return c.json({ error: "bad_direction", valid: validDirs }, 400);
  }

  const currentNode = graph.nodes[graph.current];
  if (!currentNode) return c.json({ error: "corrupt_graph" }, 500);
  // Grid content uses `content.kind === 'encounter'`, legacy uses `currentNode.encounter`.
  const hasGridEncounter = currentNode.content?.kind === "encounter" && !currentNode.content.cleared;
  const hasGridBoss = currentNode.content?.kind === "boss" && !currentNode.content.cleared;
  if (currentNode.encounter && !currentNode.encounter.cleared) {
    return c.json({ error: "encounter_active", monster: currentNode.encounter.monsters[0]?.name }, 409);
  }
  if (hasGridEncounter || hasGridBoss) {
    const monsters = currentNode.content?.kind === "encounter" ? currentNode.content.monsters
      : currentNode.content?.kind === "boss" ? currentNode.content.monsters : [];
    return c.json({ error: "encounter_active", monster: monsters[0]?.name }, 409);
  }

  // Grid-aware door check: locked/barred doors block movement.
  const move = tryMove(graph, graph.current, dir as DungeonDirection);
  if (move.kind === "needs_key") {
    const door = currentNode.doors?.[dir as DungeonDirection];
    return c.json({ error: "door_locked", door, tier: move.tier }, 423);
  }
  if (move.kind === "must_skill_check") {
    const door = currentNode.doors?.[dir as DungeonDirection];
    return c.json({ error: "door_barred", door }, 423);
  }
  if (move.kind === "blocked") {
    return c.json({ error: "no_exit", reason: move.reason }, 400);
  }
  const targetId = move.toRoomId;
  const targetNode = graph.nodes[targetId];
  if (!targetNode) return c.json({ error: "corrupt_graph" }, 500);

  const updatedTarget: DungeonNode = { ...targetNode, visited: true };
  const updatedGraph: DungeonGraph = {
    ...graph,
    current: targetId,
    visited: graph.visited.includes(targetId) ? graph.visited : [...graph.visited, targetId],
    nodes: { ...graph.nodes, [targetId]: updatedTarget },
  };
  let updatedScene: SceneJson = { ...quest.scene, graph: updatedGraph };
  // Grid content takes priority; fall through to legacy encounter for AI graphs.
  const gridMonsters =
    updatedTarget.content?.kind === "encounter" && !updatedTarget.content.cleared ? updatedTarget.content.monsters
    : updatedTarget.content?.kind === "boss" && !updatedTarget.content.cleared ? updatedTarget.content.monsters
    : null;
  if (gridMonsters && gridMonsters.length > 0) {
    const m = gridMonsters[0];
    updatedScene = {
      ...updatedScene,
      monster_name: m.name,
      monster_hp: m.hp,
      monster_max_hp: m.max_hp,
      tier: m.tier,
      monster_art_url: m.art_url ?? undefined,
      monster_effects: [],
      // Surface the AI-generated monster intro as the room scene text so
      // the combat UI shows it (mirrors legacy non-grid combat behaviour).
      scene: m.flavor || updatedTarget.description,
    };
  } else if (updatedTarget.encounter && !updatedTarget.encounter.cleared && updatedTarget.encounter.monsters.length > 0) {
    const monster = updatedTarget.encounter.monsters[0];
    updatedScene = {
      ...updatedScene,
      monster_name: monster.name,
      monster_hp: monster.hp,
      monster_max_hp: monster.max_hp,
      tier: monster.tier,
      monster_art_url: monster.art_url ?? undefined,
      monster_effects: [],
    };
  } else {
    // Non-combat room — reset monster fields so the UI doesn't show a stale bar.
    updatedScene = { ...updatedScene, monster_name: "—", monster_hp: 0, monster_max_hp: 0, monster_effects: [] };
  }
  await saveScene(c.env.DB, quest.id, updatedScene);
  // Notify all connected party members via the DO's WS broadcast so they
  // see the new room immediately instead of waiting for the 15s poll.
  const doId = c.env.QUEST_ROOM.idFromName(`quest:${quest.id}`);
  const doStub = c.env.QUEST_ROOM.get(doId);
  (doStub as unknown as { notifyDungeonMove(q: number): Promise<void> })
    .notifyDungeonMove(quest.id)
    .catch((err) => console.warn("notifyDungeonMove failed", err));
  return c.json({
    ok: true,
    current_node: updatedTarget,
    has_encounter: !!(gridMonsters || (updatedTarget.encounter && !updatedTarget.encounter.cleared)),
  });
});

// ── Door interactions: use_key, pick, bash ──────────────────────────────────
// Shared loader: returns (session, quest, graph, currentNode, dir, door) or an error.
async function loadDoorContext(c: { env: Env; req: Request }, p: { id: string }) {
  // No-op placeholder; inline in each handler for clarity.
  return null;
}

app.post("/api/quest/:id/dungeon/grid/use_key", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const body = (await c.req.json().catch(() => null)) as { direction?: unknown } | null;
  const dir = typeof body?.direction === "string" ? body.direction.toLowerCase() as DungeonDirection : null;
  if (!dir || !["n","e","s","w"].includes(dir)) return c.json({ error: "bad_direction" }, 400);
  const currentNode = graph.nodes[graph.current];
  const door = currentNode?.doors?.[dir];
  if (!door || door.state !== "locked") return c.json({ error: "door_not_locked" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const tier = door.lock_tier ?? "bronze";
  const keyField = tier === "bronze" ? "keys_bronze" : tier === "silver" ? "keys_silver" : "keys_gold";
  const have = character[keyField as keyof Character] as number;
  if (have <= 0) return c.json({ error: "no_key", tier }, 400);
  // Deduct one key.
  await c.env.DB.prepare(`UPDATE characters SET ${keyField} = ${keyField} - 1 WHERE slack_user_id = ?`)
    .bind(session.slack_user_id).run();
  // Open both sides of the door.
  openDoor(graph, graph.current, dir, "open");
  await saveScene(c.env.DB, quest.id, { ...quest.scene, graph });
  return c.json({ ok: true, action: "used_key", tier });
});

app.post("/api/quest/:id/dungeon/grid/pick", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const body = (await c.req.json().catch(() => null)) as { direction?: unknown } | null;
  const dir = typeof body?.direction === "string" ? body.direction.toLowerCase() as DungeonDirection : null;
  if (!dir || !["n","e","s","w"].includes(dir)) return c.json({ error: "bad_direction" }, 400);
  const currentNode = graph.nodes[graph.current];
  const door = currentNode?.doors?.[dir];
  if (!door || door.state !== "locked") return c.json({ error: "door_not_locked" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  // d20 + DEX mod vs pick_dc
  const dexMod = Math.floor(((character.dex ?? 5) - 5) / 2);
  const roll = 1 + Math.floor(Math.random() * 20);
  const total = roll + dexMod;
  const dc = door.pick_dc ?? 12;
  const success = total >= dc;
  if (success) {
    openDoor(graph, graph.current, dir, "open");
    await saveScene(c.env.DB, quest.id, { ...quest.scene, graph });
  }
  return c.json({ ok: true, action: "pick", roll, modifier: dexMod, total, dc, success });
});

app.post("/api/quest/:id/dungeon/grid/bash", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const body = (await c.req.json().catch(() => null)) as { direction?: unknown } | null;
  const dir = typeof body?.direction === "string" ? body.direction.toLowerCase() as DungeonDirection : null;
  if (!dir || !["n","e","s","w"].includes(dir)) return c.json({ error: "bad_direction" }, 400);
  const currentNode = graph.nodes[graph.current];
  const door = currentNode?.doors?.[dir];
  if (!door || (door.state !== "locked" && door.state !== "barred")) {
    return c.json({ error: "door_not_breakable" }, 400);
  }
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const strMod = Math.floor(((character.str ?? 5) - 5) / 2);
  const roll = 1 + Math.floor(Math.random() * 20);
  const total = roll + strMod;
  const dc = door.bash_dc ?? 14;
  const success = total >= dc;
  let damageDealt = 0;
  if (success) {
    openDoor(graph, graph.current, dir, "broken");
    await saveScene(c.env.DB, quest.id, { ...quest.scene, graph });
  } else {
    // Failure costs HP — 1d6.
    damageDealt = 1 + Math.floor(Math.random() * 6);
    const newHp = Math.max(0, character.hp - damageDealt);
    await c.env.DB.prepare("UPDATE characters SET hp = ? WHERE slack_user_id = ?")
      .bind(newHp, session.slack_user_id).run();
  }
  return c.json({ ok: true, action: "bash", roll, modifier: strMod, total, dc, success, damage_dealt: damageDealt });
});

// ── Grid content interactions ────────────────────────────────────────────────
// Shared shape: load active quest + graph + current node, then dispatch on
// content.kind. Each route writes back the updated content state and saves.

// Internal helper: add a LootOption to the character's inventory.
async function addLootToInventory(
  db: D1Database,
  userId: string,
  opt: LootOption,
) {
  return await addItem(db, {
    character_id: userId,
    item_name: opt.name,
    item_type: opt.item_type,
    power: opt.power,
    rarity: opt.rarity,
    flavor: opt.flavor,
    weapon_range: opt.weapon_range ?? null,
    slot: (opt as { slot?: string }).slot as import("@gantt-quest/core").EquipSlot | undefined,
    stat_bonus: (opt as { stat_bonus?: Record<string, number> }).stat_bonus,
    item_subtype: (opt as { item_subtype?: string }).item_subtype,
    element: opt.element ?? null,
  });
}

// Handle loot pickup or key pickup. Body: `{ pick?: number }` (1-based index
// for loot; ignored for key_pickup).
app.post("/api/quest/:id/dungeon/grid/take", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content) return c.json({ error: "nothing_to_take" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };

  if (content.kind === "loot") {
    if (content.taken) return c.json({ error: "already_taken" }, 400);
    const pick = typeof body.pick === "number" ? body.pick : 1;
    const choice = content.items[pick - 1];
    if (!choice) return c.json({ error: "bad_pick" }, 400);
    const item = await addLootToInventory(c.env.DB, session.slack_user_id, choice);
    const updatedContent: GridRoomContent = { ...content, taken: true };
    const updatedNode = { ...node, content: updatedContent };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
    await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, action: "loot", item: { id: item.id, name: item.item_name } });
  }

  if (content.kind === "key_pickup") {
    if (content.taken) return c.json({ error: "already_taken" }, 400);
    const keyField = content.tier === "bronze" ? "keys_bronze" : content.tier === "silver" ? "keys_silver" : "keys_gold";
    await c.env.DB.prepare(`UPDATE characters SET ${keyField} = ${keyField} + 1 WHERE slack_user_id = ?`)
      .bind(session.slack_user_id).run();
    const updatedContent: GridRoomContent = { ...content, taken: true };
    const updatedNode = { ...node, content: updatedContent };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
    await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, action: "key_pickup", tier: content.tier });
  }

  return c.json({ error: "not_takeable", content_kind: content.kind }, 400);
});

// Trap resolution. Body: `{ pick: 1|2|3 }` — index into content.choices.
app.post("/api/quest/:id/dungeon/grid/trap", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "trap") return c.json({ error: "not_a_trap" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };
  const idx = typeof body.pick === "number" ? body.pick - 1 : -1;
  const choice = content.choices[idx];
  if (!choice) return c.json({ error: "bad_pick" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  // d20 + stat mod vs DC 10 + character level
  const statRaw = choice.skill === "str" ? (character.str ?? 5)
    : choice.skill === "dex" ? (character.dex ?? 5) : (character.int_stat ?? 5);
  const mod = Math.floor((statRaw - 5) / 2);
  const roll = 1 + Math.floor(Math.random() * 20);
  const total = roll + mod;
  const dc = 10 + Math.max(1, character.level);
  const success = total >= dc;
  let damage = 0;
  if (!success) {
    damage = choice.fail_damage;
    const newHp = Math.max(0, character.hp - damage);
    await c.env.DB.prepare("UPDATE characters SET hp = ? WHERE slack_user_id = ?")
      .bind(newHp, session.slack_user_id).run();
  }
  const updatedContent: GridRoomContent = { ...content, resolved: true };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, action: "trap", success, roll, modifier: mod, total, dc, damage });
});

// Lockbox: consume a key + grab one loot option. Body: `{ pick: number }`.
// Two-step lockbox flow (new):
//   1. POST /lockbox/open → consume a key, mark opened=true
//   2. POST /lockbox/claim {pick} → claim one option from the open chest
//   3. POST /lockbox/close → manually close the chest (resolved=true)
// Auto-closes when every option is claimed. Legacy lockboxes (no `opened`
// field) keep using the original single-pick /lockbox endpoint below.

app.post("/api/quest/:id/dungeon/grid/lockbox/open", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "lockbox") return c.json({ error: "not_a_lockbox" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  if (content.opened) return c.json({ ok: true, already_open: true });
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const keyToSpend = pickKeyForLock(character, content.lock_tier);
  if (!keyToSpend) return c.json({ error: "no_key", tier: content.lock_tier }, 400);
  const keyField = keyToSpend === "bronze" ? "keys_bronze" : keyToSpend === "silver" ? "keys_silver" : "keys_gold";
  const dec = await c.env.DB.prepare(`UPDATE characters SET ${keyField} = ${keyField} - 1 WHERE slack_user_id = ? AND ${keyField} > 0`)
    .bind(session.slack_user_id).run();
  if (!dec.meta?.changes || dec.meta.changes === 0) {
    return c.json({ error: "no_key", tier: content.lock_tier }, 400);
  }
  const updatedContent: GridRoomContent = { ...content, opened: true, claims: content.claims ?? {} };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, key_spent: keyToSpend });
});

app.post("/api/quest/:id/dungeon/grid/lockbox/claim", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "lockbox") return c.json({ error: "not_a_lockbox" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  if (!content.opened) return c.json({ error: "not_open" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };
  const idx = typeof body.pick === "number" ? body.pick - 1 : -1;
  const choice = content.options[idx];
  if (!choice) return c.json({ error: "bad_pick" }, 400);
  const claims = { ...(content.claims ?? {}) };
  if (claims[String(idx)]) return c.json({ error: "already_claimed" }, 400);
  claims[String(idx)] = session.slack_user_id;
  const item = await addLootToInventory(c.env.DB, session.slack_user_id, choice);
  // Auto-resolve if every option has been claimed.
  const fullyClaimed = content.options.every((_, i) => claims[String(i)]);
  const updatedContent: GridRoomContent = {
    ...content, claims, resolved: fullyClaimed,
  };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, item: { id: item.id, name: item.item_name }, fully_claimed: fullyClaimed });
});

app.post("/api/quest/:id/dungeon/grid/lockbox/close", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "lockbox") return c.json({ error: "not_a_lockbox" }, 400);
  if (content.resolved) return c.json({ ok: true, already_resolved: true });
  if (!content.opened) return c.json({ error: "not_open" }, 400);
  const updatedContent: GridRoomContent = { ...content, resolved: true };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true });
});

app.post("/api/quest/:id/dungeon/grid/lockbox", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "lockbox") return c.json({ error: "not_a_lockbox" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };
  const idx = typeof body.pick === "number" ? body.pick - 1 : -1;
  const choice = content.options[idx];
  if (!choice) return c.json({ error: "bad_pick" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  // Allow a higher-tier key to open a lower-tier lock (gold opens silver
  // opens bronze) — matches Slack's `pickKeyForLock` behaviour so the two
  // surfaces stay in sync. Fails if the character has no qualifying key.
  const keyToSpend = pickKeyForLock(character, content.lock_tier);
  if (!keyToSpend) return c.json({ error: "no_key", tier: content.lock_tier }, 400);
  const keyField = keyToSpend === "bronze" ? "keys_bronze" : keyToSpend === "silver" ? "keys_silver" : "keys_gold";
  // Atomic decrement guarded by `> 0` — if a concurrent request raced us
  // to the same key, the UPDATE affects 0 rows and we bail without
  // resolving the lockbox. Prevents the "opened with no key" symptom.
  const dec = await c.env.DB.prepare(`UPDATE characters SET ${keyField} = ${keyField} - 1 WHERE slack_user_id = ? AND ${keyField} > 0`)
    .bind(session.slack_user_id).run();
  if (!dec.meta?.changes || dec.meta.changes === 0) {
    return c.json({ error: "no_key", tier: content.lock_tier }, 400);
  }
  const item = await addLootToInventory(c.env.DB, session.slack_user_id, choice);
  const updatedContent: GridRoomContent = { ...content, resolved: true };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, action: "lockbox", item: { id: item.id, name: item.item_name }, key_spent: keyToSpend });
});

// NPC offer. Body: `{ pick: 0 | 1 }` (0 = decline, 1 = accept).
app.post("/api/quest/:id/dungeon/grid/npc", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "npc") return c.json({ error: "not_an_npc" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };
  let item: { id: number; item_name: string } | null = null;
  if (body.pick === 1) {
    const added = await addLootToInventory(c.env.DB, session.slack_user_id, content.offer);
    item = { id: added.id, item_name: added.item_name };
  }
  const updatedContent: GridRoomContent = { ...content, resolved: true };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, action: "npc", accepted: body.pick === 1, item });
});

// Merchant: spend gold to buy one item. Body: `{ pick: number }` (1-based;
// 0 = skip).
app.post("/api/quest/:id/dungeon/grid/merchant", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);
  const node = graph.nodes[graph.current];
  const content = node?.content;
  if (!content || content.kind !== "merchant") return c.json({ error: "not_a_merchant" }, 400);
  if (content.resolved) return c.json({ error: "already_resolved" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { pick?: number };
  const pick = typeof body.pick === "number" ? body.pick : 0;

  // Skip: mark resolved without buying.
  if (pick === 0) {
    const updatedContent: GridRoomContent = { ...content, resolved: true };
    const updatedNode = { ...node, content: updatedContent };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
    await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, action: "merchant_skip" });
  }

  const choice = content.stock[pick - 1];
  if (!choice) return c.json({ error: "bad_pick" }, 400);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  const price = priceFor(choice.item_type, choice.rarity, choice.tier);
  if (character.gold < price) return c.json({ error: "insufficient_gold", price, gold: character.gold }, 400);
  const paid = await tryDeductGold(c.env.DB, session.slack_user_id, price);
  if (!paid) return c.json({ error: "insufficient_gold", price }, 400);
  const item = await addLootToInventory(c.env.DB, session.slack_user_id, choice);
  // Mark the entire room resolved (single purchase per merchant in grid mode).
  const updatedContent: GridRoomContent = { ...content, resolved: true };
  const updatedNode = { ...node, content: updatedContent };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [node.id]: updatedNode } };
  await saveScene(c.env.DB, questId, { ...quest.scene, graph: updatedGraph });
  return c.json({ ok: true, action: "merchant_buy", item: { id: item.id, name: item.item_name }, price });
});

app.post("/api/quest/:id/dungeon/graph/take", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);

  const body = (await c.req.json().catch(() => null)) as { object_id?: unknown } | null;
  const objectId = typeof body?.object_id === "string" ? body.object_id : null;
  if (!objectId) return c.json({ error: "missing_object_id" }, 400);

  const currentNode = graph.nodes[graph.current];
  if (!currentNode) return c.json({ error: "corrupt_graph" }, 500);

  const obj = currentNode.objects.find(o => o.id === objectId && o.takeable && !o.used);
  if (!obj) return c.json({ error: "object_not_found_or_taken" }, 404);

  const item = await addItem(c.env.DB, {
    character_id: session.slack_user_id,
    item_name: obj.name,
    item_type: "tool",
    power: 0,
    rarity: "common",
    flavor: "Retrieved from the dungeon.",
    weapon_range: null,
    slot: null,
    stat_bonus: null,
    item_subtype: null,
  });

  const updatedObjects = currentNode.objects.map(o => o.id === objectId ? { ...o, used: true } : o);
  const updatedNode: DungeonNode = { ...currentNode, objects: updatedObjects };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
  await saveScene(c.env.DB, quest.id, { ...quest.scene, graph: updatedGraph });

  return c.json({ ok: true, item: { id: item.id, name: item.item_name } });
});

app.post("/api/quest/:id/dungeon/graph/use", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) return c.json({ error: "quest_not_active" }, 404);
  const graph = quest.scene.graph;
  if (!graph) return c.json({ error: "not_a_graph_dungeon" }, 400);

  const body = (await c.req.json().catch(() => null)) as { object_id?: unknown } | null;
  const objectId = typeof body?.object_id === "string" ? body.object_id : null;
  if (!objectId) return c.json({ error: "missing_object_id" }, 400);

  const currentNode = graph.nodes[graph.current];
  if (!currentNode) return c.json({ error: "corrupt_graph" }, 500);

  const obj = currentNode.objects.find(o => o.id === objectId && !o.used);
  if (!obj) return c.json({ error: "object_not_found_or_used" }, 404);
  if (!obj.on_use) return c.json({ error: "object_not_usable" }, 400);

  const markUsed = (objects: typeof currentNode.objects) =>
    objects.map(o => o.id === objectId ? { ...o, used: true } : o);

  const effect = obj.on_use;

  if (effect.effect === "flavor") {
    const updatedNode: DungeonNode = { ...currentNode, objects: markUsed(currentNode.objects) };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(c.env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, effect: "flavor", text: effect.text });
  }

  if (effect.effect === "open_exit") {
    if (currentNode.exits[effect.direction]) {
      return c.json({ error: "exit_already_open" }, 409);
    }
    const updatedNode: DungeonNode = {
      ...currentNode,
      objects: markUsed(currentNode.objects),
      exits: { ...currentNode.exits, [effect.direction]: effect.reveals_node },
    };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(c.env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, effect: "open_exit", direction: effect.direction, reveals_node: effect.reveals_node });
  }

  if (effect.effect === "spawn_item") {
    const loot = effect.item;
    const item = await addItem(c.env.DB, {
      character_id: session.slack_user_id,
      item_name: loot.name,
      item_type: loot.item_type,
      power: loot.power,
      rarity: loot.rarity,
      flavor: loot.flavor,
      weapon_range: loot.weapon_range ?? null,
      slot: loot.slot ?? null,
      stat_bonus: loot.stat_bonus ?? null,
      item_subtype: loot.item_subtype ?? null,
    });
    const updatedNode: DungeonNode = { ...currentNode, objects: markUsed(currentNode.objects) };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(c.env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    return c.json({ ok: true, effect: "spawn_item", item: { id: item.id, name: item.item_name, rarity: loot.rarity } });
  }

  if (effect.effect === "trigger_encounter") {
    if (currentNode.encounter && !currentNode.encounter.cleared) {
      return c.json({ error: "encounter_already_active" }, 409);
    }
    const [spec] = effect.monsters;
    if (!spec) return c.json({ error: "no_monster_defined" }, 500);
    const updatedNode: DungeonNode = {
      ...currentNode,
      objects: markUsed(currentNode.objects),
      encounter: { monsters: effect.monsters, cleared: false },
    };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    const updatedScene: SceneJson = {
      ...quest.scene,
      graph: updatedGraph,
      monster_name: spec.name,
      monster_hp: spec.hp,
      monster_max_hp: spec.max_hp,
      tier: spec.tier,
      monster_art_url: spec.art_url ?? undefined,
      monster_effects: [],
      marked_by: undefined,
      marked_until: undefined,
    };
    await saveScene(c.env.DB, quest.id, updatedScene);
    return c.json({ ok: true, effect: "trigger_encounter", monster: spec });
  }

  return c.json({ error: "unknown_effect" }, 500);
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

// One-shot admin endpoint to pre-generate all VIEW_ART_PROMPTS images (including
// the new dungeon room backgrounds) so they're warm in R2 before the first
// player visits. No auth required — only callable by admins who know the URL.
// Sequential to avoid Workers AI rate limits; expect ~2-3 min for 28+ images.
app.post("/api/admin/pregen_dungeon_rooms", async (c) => {
  const art = artTarget(c.env);
  // ?force=1 wipes every cached view-art before regenerating.
  // ?force=rooms wipes only the room_* keys (grid dungeon backgrounds) and
  // leaves town / inventory / class portraits untouched.
  const force = c.req.query("force");
  const forceMode: boolean | "room_only" | undefined =
    force === "1" || force === "true" ? true
    : force === "rooms" || force === "room" ? "room_only"
    : undefined;
  const results = await pregenAllViewArt(c.env.AI, art, forceMode ? { force: forceMode } : undefined);
  const generated = results.filter((r) => r.status === "generated").length;
  const cached = results.filter((r) => r.status === "cached").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return c.json({ ok: true, total: results.length, generated, cached, failed, force: forceMode ?? null, results });
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
  // True when this was a dungeon combat room — quest stays active, player
  // picks the next door to advance.
  dungeon_room_cleared?: boolean;
  // When dungeon_room_cleared and the expedition produced two door choices,
  // these are the node stubs the client shows in the VictoryModal door picker.
  dungeon_doors?: Array<{ type: string; monster_name: string | null; scene: string | null }>;
}

interface ServerToClient {
  type: "state" | "events" | "error" | "outcome" | "flavor" | "log_replay" | "dungeon_move";
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
      if (Math.random() < dropChance(tier)) {
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
        isDungeon: questVariant === "dungeon",
        isElite: elite,
        isNoDeathRun: state.fighters.every((f) => f.hp > 0),
        initialMonsterCount: state.monsters.length,
      });
      const progIds = checkProgressionAchievements({
        existingAchievements: charAfter.achievements,
        level: charAfter.level,
        gold: charAfter.gold,
        keysBronze: charAfter.keys_bronze,
        keysSilver: charAfter.keys_silver,
        keysGold: charAfter.keys_gold,
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

  // Dungeon victory only clears the current combat room — the rest of the
  // expedition continues from the dashboard (or Slack). Advance the
  // expedition the same way the Slack-side advanceDungeonRoom does, so
  // pending_doors / pool / auto-advance to sub-boss are persisted. Without
  // this, scene_json.expedition stays pinned to the just-cleared combat
  // room and the dashboard's DoorPicker has nothing to render, while
  // Slack /gq choose returns "No room choice to make right now." Mode
  // flips to 'slack' so the quest isn't held in web-combat state — the
  // next combat room will flip it back when entered.
  const isDungeon = primaryMonster.upcoming_waves === undefined && won && await isDungeonQuest(env.DB, questId);
  if (won && isDungeon) {
    // For graph dungeons, also mark the current room's encounter as cleared.
    const sceneRow = await env.DB
      .prepare(`SELECT scene_json FROM quests WHERE id = ?`)
      .bind(questId)
      .first<{ scene_json: string }>();
    const parsedScene = sceneRow ? (JSON.parse(sceneRow.scene_json) as SceneJson) : null;
    if (parsedScene?.graph) {
      const graph = parsedScene.graph;
      const currentNode = graph.nodes[graph.current];
      if (currentNode) {
        // Mark the room cleared in BOTH the legacy `encounter` field (used by
        // pre-grid AI-graph dungeons) and the new `content.cleared` field
        // (used by grid dungeons). Without the content branch a grid encounter
        // would reset and let the player engage the same defeated foe again.
        const updatedNode: typeof currentNode = { ...currentNode };
        if (currentNode.encounter) {
          updatedNode.encounter = { ...currentNode.encounter, cleared: true };
        }
        if (currentNode.content?.kind === "encounter" || currentNode.content?.kind === "boss") {
          updatedNode.content = { ...currentNode.content, cleared: true };
        }
        const updatedScene: SceneJson = {
          ...parsedScene,
          graph: { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } },
          monster_hp: 0,
        };
        await saveScene(env.DB, questId, updatedScene);
      } else {
        await env.DB
          .prepare(`UPDATE quests SET scene_json = json_set(scene_json, '$.monster_hp', 0) WHERE id = ?`)
          .bind(questId).run();
      }
    } else {
      await env.DB
        .prepare(`UPDATE quests SET scene_json = json_set(scene_json, '$.monster_hp', 0) WHERE id = ?`)
        .bind(questId).run();
    }
    await setQuestMode(env.DB, questId, "slack");

    // Grid dungeon boss kill: distribute boss treasure to surviving fighters
    // (round-robin), append to each fighter's loot in the outcome, and mark
    // the quest completed. Without this the player kills the boss, clears
    // the room, and is then stuck — no exit, no treasure, no end-state.
    if (parsedScene?.graph && primaryMonster.is_boss) {
      const bossNode = parsedScene.graph.nodes[parsedScene.graph.current];
      const bossContent = bossNode?.content;
      if (bossContent?.kind === "boss" && bossContent.treasure?.length) {
        const survivors = humanFighters.filter((f) => f.hp > 0);
        if (survivors.length === 0 && humanFighters.length > 0) survivors.push(humanFighters[0]); // edge: pyrrhic
        for (let i = 0; i < bossContent.treasure.length; i++) {
          const item = bossContent.treasure[i];
          const recipient = survivors[i % survivors.length];
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
          const reward = rewards.find((r) => r.user_id === recipient.id);
          if (reward) {
            reward.loot.push({
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
      }
      await markQuestStatus(env.DB, questId, "completed");
      await clearHiredMercForParty(env.DB, questId);
      // Skip advanceExpeditionAfterWebCombat — grid dungeons don't use it.
      return {
        status: state.status as "victory" | "defeat" | "fled",
        rewards,
        monster_name: primaryMonster.name,
        monster_tier: tier,
        total_pool_xp: totalPoolXp,
        total_pool_gold: totalPoolGold,
        elite,
        is_boss: true,
        dungeon_room_cleared: true,
      };
    }

    const dungeonDoors = await advanceExpeditionAfterWebCombat(env, questId);
    if (dungeonDoors) {
      return {
        status: state.status as "victory" | "defeat" | "fled",
        rewards,
        monster_name: primaryMonster.name,
        monster_tier: tier,
        total_pool_xp: totalPoolXp,
        total_pool_gold: totalPoolGold,
        elite,
        is_boss: isBoss,
        dungeon_room_cleared: true,
        dungeon_doors: dungeonDoors,
      };
    }
  } else {
    await markQuestStatus(env.DB, questId, won ? "completed" : "failed");
    await clearHiredMercForParty(env.DB, questId);
  }

  return {
    status: state.status as "victory" | "defeat",
    rewards,
    monster_name: primaryMonster.name,
    monster_tier: tier,
    total_pool_xp: totalPoolXp,
    total_pool_gold: totalPoolGold,
    elite,
    is_boss: isBoss,
    dungeon_room_cleared: !!isDungeon,
  };
}

async function isDungeonQuest(db: D1Database, questId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT json_extract(scene_json, '$.variant') AS variant FROM quests WHERE id = ?`)
    .bind(questId)
    .first<{ variant: string | null }>();
  return row?.variant === "dungeon";
}

// Post-web-combat dungeon advance. Mirrors apps/slack/src/commands.ts
// advanceDungeonRoom: picks the next room via pickNextRoom and either
// (a) writes pending_doors + remaining pool — the player picks a door
// next via /sq choose (or the web dashboard), or
// (b) auto-advances to the next node (only case: sub-boss → treasure).
// Also leaves a Slack-thread breadcrumb so a player who switches back to
// Slack sees that the expedition has moved on instead of "no room choice
// to make right now".
async function advanceExpeditionAfterWebCombat(
  env: Env,
  questId: number,
): Promise<Array<{ type: string; monster_name: string | null; scene: string | null }> | null> {
  const quest = await getQuestById(env.DB, questId);
  const exp = quest?.scene.expedition;
  if (!quest || !exp) return null;

  const next = pickNextRoom(exp as ExpState);

  if (next.type === "doors") {
    const updatedExp: ExpeditionState = {
      ...exp,
      pool: next.remainingPool,
      pending_doors: next.pair,
    };
    const updatedScene: SceneJson = {
      ...quest.scene,
      expedition: updatedExp,
      monster_hp: 0,
    };
    const ok = await trySaveExpeditionAdvance(env.DB, questId, updatedScene, exp.current);
    if (!ok) return null;
    const doorNodes = next.pair.map((idx) => {
      const n = exp.nodes[idx];
      return { type: n?.type ?? "combat", monster_name: n?.monster_name ?? null, scene: n?.scene ?? null };
    });
    if (env.SLACK_BOT_TOKEN && quest.thread_ts) {
      const single = next.pair.length === 1;
      const subBossAhead = single && next.pair[0] === exp.nodes.length - 2;
      const headline = subBossAhead
        ? "👑 *The way opens to the sub-boss chamber.*"
        : single
        ? "🚪 *One path forward — catch your breath.*"
        : "🚪 *Two paths diverge ahead.*";
      const advanceHint = single
        ? "`/gq choose 1` to advance"
        : "`/gq choose 1` (N) or `/gq choose 2` (E)";
      const text = `${headline}\nRun \`/gq look\` to see the prompt, or ${advanceHint}.`;
      await postSlackMessage(env.SLACK_BOT_TOKEN, {
        channel: quest.channel_id,
        thread_ts: quest.thread_ts,
        text,
      }).catch((err) => console.warn("dungeon door post failed", err));
    }
    return doorNodes;
  }

  // Auto-advance — only fires when current was the sub-boss and the next
  // node is treasure. Mirrors advanceDungeon's node branch.
  const nextNode = exp.nodes[next.index];
  if (!nextNode) return null;
  const isCombat = nextNode.type === "combat";
  const updatedExp: ExpeditionState = {
    ...exp,
    current: next.index,
    pool: next.remainingPool,
    pending_doors: undefined,
    visited_count: (exp.visited_count ?? 1) + 1,
    visited_indices: [...(exp.visited_indices ?? [exp.current]), next.index],
  };
  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: updatedExp,
    scene: nextNode.scene,
    monster_name: isCombat ? nextNode.monster_name ?? "—" : "—",
    monster_max_hp: isCombat ? nextNode.monster_max_hp ?? 0 : 0,
    monster_hp: isCombat ? nextNode.monster_max_hp ?? 0 : 0,
    tier: isCombat ? nextNode.tier ?? quest.scene.tier : quest.scene.tier,
    monster_effects: [],
  };
  const ok = await trySaveExpeditionAdvance(env.DB, questId, updatedScene, exp.current);
  if (!ok) return null;
  if (env.SLACK_BOT_TOKEN && quest.thread_ts) {
    const text = nextNode.type === "treasure"
      ? "🎁 *Treasure ahead.* Run `/gq look` to see the loot, then `/gq take <n>` to claim."
      : `🗺️ *Next room: ${nextNode.type}.* Run \`/gq look\` to see what's ahead.`;
    await postSlackMessage(env.SLACK_BOT_TOKEN, {
      channel: quest.channel_id,
      thread_ts: quest.thread_ts,
      text,
    }).catch((err) => console.warn("dungeon advance post failed", err));
  }
  return null;
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
//
// Variant guard: dungeon rooms are only supported for `type === 'combat'`
// nodes; trap/lockbox/npc/treasure stay in Slack via /sq choose, /sq take.
// Returns a discriminated union so callers can render specific errors.
async function buildInitialCombatState(
  db: D1Database,
  quest: ActiveQuest,
): Promise<
  | { ok: true; seeded: CombatState }
  | { ok: false; reason: "unsupported_variant" | "non_combat_room"; detail?: string }
> {
  const variant = quest.scene.variant ?? "standard";
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "dungeon") {
    return { ok: false, reason: "unsupported_variant", detail: variant };
  }
  if (variant === "dungeon") {
    // Grid dungeons: check the current graph node's content.kind.
    // Legacy AI-graph dungeons: check the current graph node's encounter field.
    // Legacy expedition dungeons: check the current expedition node's type.
    const graph = quest.scene.graph;
    const exp = quest.scene.expedition;
    if (graph) {
      const node = graph.nodes[graph.current];
      const kind = node?.content?.kind;
      // The content union narrows differently per kind; cleared only exists
      // on encounter/boss. Cast through unknown to read it generically.
      const contentCleared = (node?.content as { cleared?: boolean } | undefined)?.cleared === true;
      const isUnclearedGridCombat = (kind === "encounter" || kind === "boss") && !contentCleared;
      const hasLegacyEncounter = !!(node?.encounter && !node.encounter.cleared);
      if (!isUnclearedGridCombat && !hasLegacyEncounter) {
        return { ok: false, reason: "non_combat_room", detail: kind ?? "missing" };
      }
    } else if (exp) {
      const node = exp.nodes[exp.current];
      if (!node || node.type !== "combat") {
        return { ok: false, reason: "non_combat_room", detail: node?.type ?? "missing" };
      }
    } else {
      return { ok: false, reason: "non_combat_room", detail: "no_dungeon_state" };
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
        : (weapon?.rarity === "rare" || weapon?.rarity === "epic" || weapon?.rarity === "legendary"
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

  // Grid dungeon: read the full monster array from the current node's
  // content. The generator now produces multi-monster encounter packs
  // (tier 3+); reading content.monsters here is how those reach the
  // engine. Boss rooms stay solo for now (generator returns one boss).
  // Falls back to the scene-root single-monster mirror for legacy
  // variants (standard / boss / gauntlet) and AI-graph dungeons.
  const gridNode = quest.scene.graph
    ? quest.scene.graph.nodes[quest.scene.graph.current]
    : null;
  const gridContentMonsters = (() => {
    if (!gridNode) return null;
    const c = gridNode.content;
    if (!c) return null;
    if ((c.kind === "encounter" || c.kind === "boss") && !c.cleared) {
      return c.monsters;
    }
    return null;
  })();
  const isGridBoss = gridNode?.content?.kind === "boss";

  // scene.monsters[] covers pack hunts and job-board pack quests.
  const scenePackMonsters = quest.scene.monsters && quest.scene.monsters.length > 1
    ? quest.scene.monsters
    : null;

  const init: CombatInit = (gridContentMonsters && gridContentMonsters.length > 0)
    ? {
        fighters,
        monsters: gridContentMonsters.map((m, i) => {
          const affinity = rollMonsterElementAffinity();
          return {
            name: m.name,
            hp: m.hp,
            max_hp: m.max_hp,
            shield: rollMonsterShield(m.tier),
            tier: m.tier,
            is_boss: isGridBoss && i === 0,
            art_url: m.art_url ?? undefined,
            ...affinity,
            ...rollMonsterAttackAndDamageTypes(m.tier, affinity.element_weakness),
          };
        }),
      }
    : scenePackMonsters
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
          is_boss: variant === "boss" || isGridBoss,
          boss_phase: quest.scene.boss_phase,
          wave: quest.scene.wave,
          total_waves: quest.scene.total_waves,
          upcoming_waves: quest.scene.upcoming_waves?.map((w) => ({
            name: w.name,
            max_hp: w.max_hp,
          })),
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
  // Channel + thread coordinates for the active quest, cached on first
  // load so the AI flavor fanout can chat.postMessage to the Slack thread
  // without re-reading D1 on every flavor result. Quest's channel_id and
  // thread_ts are immutable for the life of the quest so cached values
  // remain valid through DO hibernation/wakeup. Cleared when cacheQuestId
  // changes (different quest takes over the same DO).
  private cacheQuestMeta: { channel_id: string; thread_ts: string; joinable_ts: string | null } | null = null;
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
      this.cacheQuestMeta = null;

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

    // Combat-milestone broadcasts to the channel. Single source of truth
    // for boss-reveal / phase-2 / fighter-down / victory / defeat —
    // because handleStepResult runs for both WS-driven and RPC-driven
    // turns, the broadcast fires identically regardless of which surface
    // the actor came from.
    if (stateChanged) {
      this.fireMilestoneBroadcasts(questId, prevState, result);
      this.ctx.waitUntil(
        this.sendTurnNotification(questId, result.events, result.state.status).catch((err) =>
          console.warn("turn notification failed", err),
        ),
      );
    }

    const becameTerminal =
      stateChanged &&
      prevState.status === "active" &&
      (result.state.status === "victory" || result.state.status === "defeat" || result.state.status === "fled");
    if (becameTerminal) {
      // Write residual drink buffs back to D1 BEFORE applyWebCombatOutcome
      // — the latter may call clearPartyEffects which already nulls
      // drink_buff_json on quest-end paths. By writing back first we make
      // sure mid-quest combats (dungeon room cleared, gauntlet wave
      // advanced) carry an accurate post-tick buff into the next fight.
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
      this.postVictoryWrapup(questId, outcome);
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

    // Pre-seed the channel+thread cache so the very first flavor fanout
    // after begin() doesn't have to hit D1 again. ensureQuestMeta would
    // fetch it lazily on first need, but we already have the row here.
    if (quest.thread_ts) {
      this.cacheQuestMeta = { channel_id: quest.channel_id, thread_ts: quest.thread_ts, joinable_ts: quest.joinable_ts };
      this.cacheQuestId = questId;
    }

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
        : (weapon?.rarity === "rare" || weapon?.rarity === "epic" || weapon?.rarity === "legendary"
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

  // Notifies all connected WS clients that a dungeon room has changed so
  // they re-fetch the quest scene without waiting for the 15s poll cycle.
  // Called by the Worker's dungeon-move handlers after saving to D1.
  async notifyDungeonMove(questId: number): Promise<void> {
    this.broadcast({ type: "dungeon_move", quest_id: questId });
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
  // user), revive (raise a downed party member). Tools are dungeon-only;
  // scrolls have named effects (rebase, etc.) we'll plumb in a follow-up.
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
        const before = actor.hp;
        const after = Math.min(actor.max_hp, before + item.power);
        const amount = after - before;
        updatedFighters = state.fighters.map((f) =>
          f.id === actor.id ? { ...f, hp: after } : f,
        );
        effect = { kind: "heal", target: actor.id, amount, rolled: item.power };
        break;
      }
      case "magic": {
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
        this.postVictoryWrapup(questId, outcome);
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
      // Reset quest meta on quest-id change — populated lazily by
      // ensureQuestMeta when the flavor fanout needs it.
      this.cacheQuestMeta = null;
      return state;
    }
    return null;
  }

  // Lazily fetch the quest's channel_id + thread_ts so the AI flavor
  // fanout can post into the Slack thread. Returns null when the quest
  // has already ended or no row exists; that's a soft failure — flavor
  // still reaches web clients via WebSocket.
  private async ensureQuestMeta(
    questId: number,
  ): Promise<{ channel_id: string; thread_ts: string; joinable_ts: string | null } | null> {
    if (this.cacheQuestMeta && this.cacheQuestId === questId) {
      return this.cacheQuestMeta;
    }
    const quest = await getQuestById(this.env.DB, questId);
    if (!quest || !quest.thread_ts) return null;
    this.cacheQuestMeta = { channel_id: quest.channel_id, thread_ts: quest.thread_ts, joinable_ts: quest.joinable_ts };
    return this.cacheQuestMeta;
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
  //
  // Cross-surface fanout: when SLACK_BOT_TOKEN is bound on the web worker
  // (it's optional — see the Env comment), each flavor result is also
  // chat.postMessage'd into the quest's Slack thread. This way a Slack
  // spectator sees the AI-narrated beats (hit color, victory cry, etc.)
  // that today only reach the web client. Fire-and-forget — Slack failure
  // never blocks WS broadcast or log persistence.
  private async broadcastAndLogFlavor(
    questId: number,
    flavor: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string },
  ): Promise<void> {
    this.broadcast({ type: "flavor", flavor });
    const newLog = this.appendLog([{ _kind: "flavor", flavor }]);

    // Slack-thread fanout. Wrapped in a try so any failure (no token, no
    // thread_ts cached, network blip) doesn't disturb the local log
    // persistence below. The waitUntil keeps the post off the critical
    // path — the WS broadcast already fired so live viewers are served.
    if (this.env.SLACK_BOT_TOKEN) {
      const token = this.env.SLACK_BOT_TOKEN;
      this.ctx.waitUntil(
        (async () => {
          try {
            const meta = await this.ensureQuestMeta(questId);
            // Skip if no real Slack thread_ts (hunt/outskirts quests have a
            // synthetic "web-<ts>-<userId>" placeholder that Slack would
            // silently drop the thread param on and post as a new channel message).
            if (!meta || meta.thread_ts.startsWith("web-")) return;
            // Italicize for "narration" tone — distinguishes AI flavor
            // from the mechanical turn-summary posts.
            await postSlackMessage(token, {
              channel: meta.channel_id,
              thread_ts: meta.thread_ts,
              text: `_${flavor.text}_`,
            });
          } catch (err) {
            console.warn("flavor fanout to slack failed", err);
          }
        })(),
      );
    }

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

  // Post a wrap-up summary to the Slack thread after web combat ends, and
  // delete the joinable-card regardless of outcome. Skipped for pure-web quests
  // (channel_id starts with "web:") and when SLACK_BOT_TOKEN is absent.
  // Fire-and-forget via ctx.waitUntil.
  private postVictoryWrapup(questId: number, outcome: OutcomeSummary): void {
    if (!this.env.SLACK_BOT_TOKEN) return;
    const token = this.env.SLACK_BOT_TOKEN;
    this.ctx.waitUntil(
      (async () => {
        try {
          const meta = await this.ensureQuestMeta(questId);
          // Skip pure-web quests and hunt/outskirts quests (synthetic thread_ts
          // "web-<ts>-<userId>" has no real Slack thread to reply into).
          if (!meta || meta.channel_id.startsWith("web:") || meta.thread_ts.startsWith("web-")) return;

          // Always delete the join-post so it doesn't linger after combat ends.
          if (meta.joinable_ts) {
            void deleteSlackMessage(token, meta.channel_id, meta.joinable_ts);
          }

          if (outcome.status !== "victory") return;

          const header = [
            outcome.is_boss ? "👑" : "⚔️",
            `*${outcome.monster_name}* defeated`,
            outcome.elite ? " _(elite)_" : "",
            outcome.dungeon_room_cleared ? " _(dungeon room cleared)_" : "",
          ].join("") + "!";

          const partySize = outcome.rewards.length;
          const partyBonusPct = partyXpBonus(partySize);
          const partyTag = partyBonusPct > 1 ? ` _(🎉 +${Math.round((partyBonusPct - 1) * 100)}% party XP)_` : "";
          const lines: string[] = [header + partyTag];
          for (const r of outcome.rewards) {
            const parts: string[] = [
              `<@${r.user_id}>: +${r.xp_awarded} XP · +${r.gold_awarded}g`,
            ];
            if (r.level_up) parts.push(`→ Lv ${r.new_level} ↑`);
            for (const l of r.loot) {
              const badge = (RARITY_BADGE as Record<string, string>)[l.rarity] ?? "🎁";
              const power =
                l.item_type === "consumable" ? `heals ${l.power}` :
                l.item_type === "magic"      ? `+${l.power} max mana` :
                l.item_type === "revive"     ? `revive ${l.power}%` :
                                               `+${l.power}`;
              parts.push(`🎁 ${badge} *${l.item_name}* (${l.item_type}, ${power})`);
            }
            lines.push(parts.join(" · "));
          }

          await postSlackMessage(token, {
            channel: meta.channel_id,
            thread_ts: meta.thread_ts,
            text: lines.join("\n"),
          });
        } catch (err) {
          console.warn("combat wrapup to slack failed", err);
        }
      })(),
    );
  }

  // Channel-broadcast combat milestones to the Slack thread (with
  // reply_broadcast: true so they surface in the channel too — these are
  // the "OH SHIT" beats spectators should see without having to follow
  // the thread). Idempotent via CombatState.milestones_posted: the
  // dedupe set is recorded INTO state BEFORE the post fires, so a DO
  // crash between post and save can't double-broadcast on retry.
  //
  // Detected events (in order of detection priority):
  //   - boss reveal on first turn_start when monster.is_boss
  //   - boss_phase_transition (phase 2)
  //   - fighter_down (each unique fighter at most once)
  //   - victory + monster.is_boss (boss-only — non-boss victories are
  //     surfaced by the existing thread broadcast in resolveVictory)
  //   - defeat (always — party wipes are channel-noteworthy)
  //
  // SLACK_BOT_TOKEN optional: when unset, broadcasts are skipped silently
  // (same pattern as the flavor fanout).
  private fireMilestoneBroadcasts(
    questId: number,
    prevState: CombatState,
    result: { state: CombatState; events: CombatEvent[] },
  ): void {
    if (!this.env.SLACK_BOT_TOKEN) return;
    const token = this.env.SLACK_BOT_TOKEN;

    const alreadyPosted = new Set(result.state.milestones_posted ?? []);
    const newlyPosted: { key: string; text: string }[] = [];

    // Boss reveal — first turn_start emitted in the same step that produces
    // begin. Surface only when the monster is actually a boss; non-boss
    // quests don't need a "👑 appears" beat.
    const bossMonster = result.state.monsters[0];
    if (bossMonster?.is_boss && !alreadyPosted.has("boss_reveal")) {
      const sawBegin = result.events.some((e) => e.type === "begin");
      if (sawBegin) {
        newlyPosted.push({
          key: "boss_reveal",
          text: `👑 A boss appears: *${bossMonster.name}*.`,
        });
      }
    }

    // Phase 2 transition
    if (
      !alreadyPosted.has("phase_2") &&
      result.events.some((e) => e.type === "boss_phase_transition")
    ) {
      newlyPosted.push({
        key: "phase_2",
        text: `👑 *${bossMonster?.name ?? "Boss"}* shifts — *phase 2*.`,
      });
    }

    // Fighter downs (one beat per unique fighter per fight)
    for (const e of result.events) {
      if (e.type !== "fighter_down") continue;
      const key = `down:${e.target}`;
      if (alreadyPosted.has(key)) continue;
      const fighter = result.state.fighters.find((f) => f.id === e.target);
      const display = fighter ? `*${fighter.name}*` : `<@${e.target}>`;
      newlyPosted.push({
        key,
        text: `💀 ${display} falls.`,
      });
    }

    // Victory — only emit for boss quests (non-boss has its own thread
    // narration via the existing post-victory path). Detected via the
    // engine's "victory" event combined with monster.is_boss.
    if (
      !alreadyPosted.has("victory") &&
      result.state.status === "victory" &&
      bossMonster?.is_boss &&
      result.events.some((e) => e.type === "victory")
    ) {
      newlyPosted.push({
        key: "victory",
        text: `🏆 Boss slain: *${bossMonster.name}*.`,
      });
    }

    // Defeat — always a notable channel beat; wipes are the rare loud
    // moment that earns the broadcast.
    if (
      !alreadyPosted.has("defeat") &&
      result.state.status === "defeat" &&
      result.events.some((e) => e.type === "defeat")
    ) {
      newlyPosted.push({
        key: "defeat",
        text: `☠️ The party falls to *${bossMonster?.name ?? "the enemy"}*.`,
      });
    }

    if (newlyPosted.length === 0) return;

    // Update milestones_posted ON the saved state BEFORE issuing the posts.
    // saveWebCombatState has already run with the un-flagged state — but
    // saving again with the flags set means a DO crash between save and
    // post leaves the state marked posted, which is the safe failure mode
    // (false negative beats double-broadcast).
    const updatedState: CombatState = {
      ...result.state,
      milestones_posted: [
        ...(result.state.milestones_posted ?? []),
        ...newlyPosted.map((m) => m.key),
      ],
    };
    this.cacheState = updatedState;
    this.cacheQuestId = questId;
    this.ctx.waitUntil(
      (async () => {
        try {
          await saveWebCombatState(this.env.DB, questId, updatedState, this.cacheLog);
          const meta = await this.ensureQuestMeta(questId);
          if (!meta) return;
          for (const m of newlyPosted) {
            await postSlackMessage(token, {
              channel: meta.channel_id,
              thread_ts: meta.thread_ts,
              reply_broadcast: true,
              text: m.text,
            });
          }
        } catch (err) {
          console.warn("milestone broadcast failed", err);
        }
      })(),
    );
  }

  // Sends a turn-ping to the next human actor after a turn advances.
  // Reads notification_pref from D1: "dm" opens a direct message channel,
  // "thread" (default) posts a broadcast reply in the quest thread.
  // Skips silently when SLACK_BOT_TOKEN is absent (web-only sessions) or
  // when the quest has no Slack thread (thread_ts is a web-local sentinel).
  private async sendTurnNotification(
    questId: number,
    events: CombatEvent[],
    status: string,
  ): Promise<void> {
    if (status !== "active") return;
    if (!this.env.SLACK_BOT_TOKEN) return;
    const turnStart = events.find(
      (e): e is Extract<CombatEvent, { type: "turn_start" }> =>
        e.type === "turn_start" && !isMonsterActor(e.actor) && !isAllyNpcActor(e.actor),
    );
    if (!turnStart) return;
    const token = this.env.SLACK_BOT_TOKEN;
    const actorChar = await getCharacter(this.env.DB, turnStart.actor);
    if (actorChar?.notification_pref === "dm") {
      const openRes = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ users: turnStart.actor }),
      });
      const openData = (await openRes.json()) as { ok: boolean; channel?: { id: string } };
      if (!openData.ok || !openData.channel?.id) return;
      await postSlackMessage(token, {
        channel: openData.channel.id,
        text: `⚔️ It's your turn in the quest!`,
      });
    } else {
      const meta = await this.ensureQuestMeta(questId);
      if (!meta || meta.thread_ts.startsWith("web-")) return;
      await postSlackMessage(token, {
        channel: meta.channel_id,
        thread_ts: meta.thread_ts,
        reply_broadcast: true,
        text: `<@${turnStart.actor}> it's your turn!`,
      });
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
