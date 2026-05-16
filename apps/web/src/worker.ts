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
} from "./ai";

import {
  ACHIEVEMENTS,
  APOTHECARY_STAPLES,
  FOCUS_MAX_MANA_BONUS,
  MAX_MANA_CAP,
  checkApothecaryAchievements,
  checkCombatAchievements,
  checkDeathAchievements,
  checkProgressionAchievements,
  classByName,
  createCombatState,
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
  rollMerchantItem,
  sellPriceFor,
  step,
  xpForLevel,
  RARITY_BADGE,
  type CombatEvent,
  type CombatInit,
  type CombatState,
  type DialogNode,
  type DialogOption,
  type DialogPayload,
  type ItemRoll,
  type NpcSpec,
  type RollFn,
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
  releaseShopClaim,
  scaleMonsterForJoin,
  transferItem,
  tryDeductGold,
  trySetHaggleOutcome,
  awardSpoils,
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
  setCharacterHpAndShield,
  setQuestMode,
  setQuestThreadTs,
  trySaveExpeditionAdvance,
  type ActiveQuest,
  type Character,
  type CharGender,
  type ExpeditionNode,
  type ExpeditionNodeType,
  type ExpeditionState,
  type KeyTier,
  type SceneJson,
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
}

const DRINKS: DrinkSpec[] = [
  { id: "ale",     emoji: "🍺", name: "Tavern Ale",        price: 8,  effect: { kind: "buff_attack",   magnitude: 1, duration: 3 }, blurb: "Cheap, foamy, gives you the courage to swing harder. +1 attack for 3 actions." },
  { id: "mead",    emoji: "🍷", name: "Spiced Mead",       price: 8,  effect: { kind: "buff_magic",    magnitude: 1, duration: 3 }, blurb: "Cinnamon, clove, and a tingle in the fingertips. +1 magic for 3 actions." },
  { id: "brew",    emoji: "🥃", name: "Iron Brew",         price: 8,  effect: { kind: "instant_shield", amount: 5 },                blurb: "Tastes like ore. Lines your gut with grit. +5 shield, instant." },
  { id: "tea",     emoji: "🍵", name: "Bitter Tea",        price: 12, effect: { kind: "instant_mana",  amount: 2 },                blurb: "Clarifies the mind, reignites the channel. +2 mana, instant." },
  { id: "milk",    emoji: "🥛", name: "Frothy Milk",       price: 10, effect: { kind: "instant_hp",    amount: 8 },                blurb: "Comfort in a glass. The bartender knows. +8 HP, instant." },
  { id: "lucky",   emoji: "💧", name: "Lucky Sip",         price: 15, effect: { kind: "buff_next_crit" },                          blurb: "A shimmer of fate. Your next attack/cast/signature is a guaranteed crit." },
  { id: "whiskey", emoji: "🍶", name: "Aged Whiskey",      price: 25, effect: { kind: "buff_attack",   magnitude: 2, duration: 3 }, blurb: "Smoke, leather, twenty harvests of patience. +2 attack for 3 actions." },
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
const SUPPORT_BASE_CONTRIBUTION = 1;
const SHOP_RESTOCK_MS = 6 * 60 * 60 * 1000;
const SHOP_BUY_CAP_PER_CYCLE = 2;
// Town refresh cadences — kept in sync with Slack's rebuildTownState:
//   weekly: town name + location art
//   daily: job board + pub regulars (handled by Slack; web checks staleness)
const TOWN_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const TOWN_DAILY_MS = 24 * 60 * 60 * 1000;

// Looks up the channel_id of the player's most recent quest. Falls back to
// the most recently active channel in the whole DB — covers new players who
// haven't started a Slack quest yet but the team is already playing in a known
// channel.
async function recentChannelForUser(db: D1Database, userId: string): Promise<string | null> {
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
  // Fallback: most recently used real channel in the system
  const fallback = await db
    .prepare(`SELECT channel_id FROM quests WHERE channel_id NOT LIKE 'web:%' ORDER BY id DESC LIMIT 1`)
    .first<{ channel_id: string }>();
  return fallback?.channel_id ?? null;
}

// Slack uses Workers AI to flavor non-catalog drops; web v1 names them
// deterministically off (rarity, type) so we don't depend on the AI binding.
// Tool / scroll drops still use the fixed catalog names + blurbs from core.
const RARITY_ADJ: Record<string, string> = {
  common: "Worn",
  uncommon: "Sturdy",
  rare: "Resplendent",
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
): ToolDispatchResult {
  const entry = findCatalogEntry(item.item_name);
  if (!entry) {
    return {
      effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
      error: `${item.item_name} has no wired-up effect`,
    };
  }

  switch (entry.name) {
    case "Caffeine Bomb":
    case "Hotfix Grenade": {
      // Damage tools ignore armor and never kill (Slack convention v1).
      const requested = item.power;
      const damage = Math.max(1, Math.min(requested, state.monster.hp - 1));
      return {
        effect: {
          kind: "monster_damage",
          amount: damage,
          ...(damage < requested ? { capped_from: requested } : {}),
        },
        monster: { hp: state.monster.hp - damage },
      };
    }
    case "Espresso Shot": {
      // Self-applied regen. Stacks alongside whatever's already on the
      // actor — withEffectApplied semantics in Slack just push to the
      // array; v1 web does the same (Slack: append to effects).
      const eff = {
        type: "regen" as const,
        magnitude: item.power,
        remaining: 5,
        source: entry.name,
      };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: [...f.effects, eff] } : f,
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
      if (state.monster.hp <= 0) {
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
        monster: { effects: [...state.monster.effects, eff] },
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
      if (state.monster.hp <= 0) {
        return {
          effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 },
          error: "no live foe to outage",
        };
      }
      if (state.monster.is_boss) {
        const requested = Math.floor(state.monster.max_hp * 0.3);
        const damage = Math.max(1, Math.min(requested, state.monster.hp - 1));
        return {
          effect: {
            kind: "monster_damage",
            amount: damage,
            ...(damage < requested ? { capped_from: requested } : {}),
          },
          monster: { hp: state.monster.hp - damage },
        };
      }
      // Non-boss instakill — drops monster_hp to 0. handleUseItem detects this
      // and routes through resolveMonsterKill for victory / wave-transition.
      return {
        effect: { kind: "monster_damage", amount: state.monster.hp },
        monster: { hp: 0 },
      };
    }
    case "Venom Vial": {
      if (state.monster.hp <= 0) {
        return { effect: { kind: "heal", target: actor.id, amount: 0, rolled: 0 }, error: "no live foe to poison" };
      }
      const eff = { type: "poisoned" as const, magnitude: item.power, remaining: 4, source: actor.id };
      return {
        effect: { kind: "monster_effect", effect: "poisoned", magnitude: item.power, remaining: 4 },
        monster: { effects: [...state.monster.effects, eff] },
      };
    }
    case "Regen Draft": {
      const eff = { type: "regen" as const, magnitude: item.power, remaining: 3, source: entry.name };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: [...f.effects, eff] } : f,
      );
      return {
        effect: { kind: "self_effect", target: actor.id, effect: "regen", magnitude: item.power, remaining: 3 },
        fighters,
      };
    }
    case "Battle Elixir": {
      const eff = { type: "empowered" as const, magnitude: 25, remaining: 3, source: entry.name };
      const fighters = state.fighters.map((f) =>
        f.id === actor.id ? { ...f, effects: [...f.effects, eff] } : f,
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
      env.AI, monsterName, roll.type, roll.rarity, roll.power, roll.weapon_range,
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
}

// Minimal chat.postMessage wrapper duplicated from apps/slack/src/slack.ts.
// The function is 12 lines and stable; lifting it into a shared package
// would couple the web worker to slack-specific types it doesn't otherwise
// need. If a third caller appears we'll lift then.
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
  return { bucket: env.ART, baseUrl: WEB_PUBLIC_BASE };
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

  const cls = pickRandomClass();
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

  return c.json({ ok: true, character: newChar });
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
  // Lazy class-portrait lookup. classByName resolves the display name back
  // to a stable class id ("DevOps Mage" → "devops_mage") which is the suffix
  // of the matching `class_*` VIEW_ART_PROMPTS key. Cache miss → background
  // flux gen, next poll picks up the URL. Fail-soft.
  let class_art_url: string | null = null;
  if (character) {
    const id = classByName(character.class).id;
    const shortKey = `class_${id}` as keyof typeof VIEW_ART_PROMPTS;
    if (shortKey in VIEW_ART_PROMPTS) {
      class_art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, shortKey);
    }
  }
  return c.json({
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    character,
    class_art_url,
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
  // Focus weapon swap bookkeeping. Swapping to/from a focus weapon shifts
  // max_mana by FOCUS_MAX_MANA_BONUS in either direction. Armor swaps don't
  // touch mana — only the weapon slot carries this dynamic.
  let manaDelta = 0;
  if (item.item_type === "weapon") {
    const prev = await getEquipped(c.env.DB, session.slack_user_id, "weapon");
    const prevBonus = prev?.weapon_range === "focus" ? FOCUS_MAX_MANA_BONUS : 0;
    const newBonus = item.weapon_range === "focus" ? FOCUS_MAX_MANA_BONUS : 0;
    manaDelta = newBonus - prevBonus;
    if (manaDelta !== 0) {
      await applyFocusManaShift(c.env.DB, session.slack_user_id, manaDelta);
    }
  }
  await equipItem(c.env.DB, item);
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
    await applyFocusManaShift(c.env.DB, session.slack_user_id, -FOCUS_MAX_MANA_BONUS);
  }
  await c.env.DB.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").bind(itemId).run();
  return c.json({ ok: true });
});

const JOIN_HP_RATIO = 0.4;
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
      const opts = rolls.map((roll, j) => ({
        name: named[j].name,
        item_type: roll.type,
        power: roll.power,
        rarity: roll.rarity,
        flavor: named[j].flavor,
        weapon_range: roll.weapon_range ?? null,
      }));
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
        item: {
          name: offerNamed.name,
          item_type: offerRoll.type,
          power: offerRoll.power,
          rarity: offerRoll.rarity,
          flavor: offerNamed.flavor,
          weapon_range: offerRoll.weapon_range ?? null,
        },
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
    const stock = merchantStockRolls.map((roll, j) => ({
      name: named[j].name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor: named[j].flavor,
      weapon_range: roll.weapon_range ?? null,
    }));
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
  const treasureLoot = treasureRolls.map((roll, i) => ({
    name: treasureNamed[i].name,
    item_type: roll.type,
    power: roll.power,
    rarity: roll.rarity,
    flavor: treasureNamed[i].flavor,
    weapon_range: roll.weapon_range ?? null,
  }));
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
    | { variant?: unknown; elite?: unknown }
    | null;
  const variant = body?.variant;
  const elite = body?.elite === true;
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet" && variant !== "dungeon") {
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
    scene = await buildDungeonScene(c.env, character, elite, avoidNames);
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

// Returns the joinable quest in the player's recent channel (if any).
// Used by the dashboard to render a "Join Quest" affordance when the
// player isn't already on a quest.
app.get("/api/quest/joinable", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ joinable: null });
  }
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
  const [overview, pub, shop, inn, smithy, apothecary] = await Promise.all([
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "town_overview", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "pub_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "channel_shop", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "inn_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "smithy_interior", undefined, TOWN_WEEKLY_MS),
    getOrScheduleViewArt(c.env.AI, art, c.executionCtx, "apothecary", undefined, TOWN_WEEKLY_MS),
  ]);
  return c.json({ overview_art_url: overview, pub_art_url: pub, shop_art_url: shop, inn_art_url: inn, smithy_art_url: smithy, apothecary_art_url: apothecary });
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

  const [jobStd, jobBoss, jobDung] = await Promise.all([
    generateJobListing(ai, "standard", townName),
    generateJobListing(ai, "boss", townName),
    generateJobListing(ai, "dungeon", townName),
  ]);

  const jobs = [
    { id: "job_1", variant: "standard" as const, required_level: 1, title: jobStd.title, blurb: jobStd.blurb, reward_summary: "1× rewards · +12% town bonus · single foe." },
    { id: "job_2", variant: "boss" as const, required_level: BOSS_LEVEL_REQUIRED_LOCAL, title: jobBoss.title, blurb: jobBoss.blurb, reward_summary: "2× rewards · +12% town bonus · two phases." },
    { id: "job_3", variant: "dungeon" as const, required_level: EXPEDITION_LEVEL_REQUIRED_LOCAL, title: jobDung.title, blurb: jobDung.blurb, reward_summary: "2.5× rewards · +12% town bonus · 5-7 rooms, sub-boss, treasure." },
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
      variant: "standard" | "boss" | "dungeon" | "gauntlet";
      required_level: number;
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

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
      variant: "standard" | "boss" | "dungeon" | "gauntlet";
      required_level: number;
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
    scene = await buildDungeonScene(c.env, character, false, avoidNames);
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
  if (!channelId) return c.json({ error: "no_channel" }, 404);
  const stock = await getActiveShopStock(c.env.DB, channelId, SHOP_RESTOCK_MS);
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "channel_shop", undefined, TOWN_WEEKLY_MS);
  if (!stock || stock.length === 0) {
    return c.json({
      stock: [],
      staples: STAPLES,
      gold: character.gold,
      channel_id: channelId,
      needs_restock: true,
      art_url,
    });
  }
  const cycleGeneratedAt = stock[0].generated_at;
  const purchasesThisCycle = await countPurchasesInCycle(
    c.env.DB, channelId, session.slack_user_id, cycleGeneratedAt,
  );
  return c.json({
    stock,
    staples: STAPLES,
    art_url,
    gold: character.gold,
    channel_id: channelId,
    needs_restock: false,
    purchases_this_cycle: purchasesThisCycle,
    purchase_cap: SHOP_BUY_CAP_PER_CYCLE,
  });
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
  const body = await c.req.json().catch(() => null) as { tier?: number } | null;
  const requestedTier = body?.tier;
  if (typeof requestedTier !== "number" || !Number.isInteger(requestedTier) || requestedTier < 1) {
    return c.json({ error: "invalid_tier" }, 400);
  }
  const tier = Math.min(requestedTier, character.level);

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
  if (!channelId) return c.json({ error: "no_channel" }, 400);

  const avoidNames = await getRecentMonsterNames(c.env.DB, channelId, 6);
  // Build a fake character at the chosen tier so the scene generator scales
  // HP, damage, and flavor to the requested difficulty, not the player's level.
  const scaledCharacter = { ...character, level: tier };
  const scene = await generateOpeningScene(
    c.env.AI, scaledCharacter, false, "standard", undefined, avoidNames, artTarget(c.env),
  );
  scene.variant = "standard";

  const questId = await createQuest(c.env.DB, {
    channel_id: channelId,
    thread_ts: `web-${Date.now()}-${session.slack_user_id}`,
    elite: false,
    scene,
    mode: "web",
    created_by: session.slack_user_id,
  });
  await refillMana(c.env.DB, session.slack_user_id);

  // /api/hunt always produces a standard, non-elite quest. Announce it
  // the same as the other web creation paths.
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
        variant: "standard",
        monsterName: scene.monster_name,
        monsterMaxHp: scene.monster_max_hp,
        sceneText: scene.scene,
        webBaseUrl: WEB_PUBLIC_BASE,
      });
      if (ts) await setQuestThreadTs(c.env.DB, questId, ts);
    })());
  }

  return c.json({ ok: true, quest_id: questId });
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
  { id: "cot",  name: "Common Cot",      price: 20, refills: { hp: true, mana: false }, blurb: "A straw cot, a wool blanket, a guarantee nobody'll loot you in your sleep. Wakes you at full HP.", iconName: "campfire" },
  { id: "bath", name: "Hot Bath & Bed",  price: 50, refills: { hp: true, mana: true },  blurb: "A copper tub, lavender soap, a real mattress. Wakes you at full HP and full mana.",            iconName: "moon-sun" },
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

app.get("/api/smithy", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  if (!character) return c.json({ error: "no_character" }, 404);
  if (await getActiveQuestForCharacter(c.env.DB, session.slack_user_id)) {
    return c.json({ error: "mid_quest" }, 400);
  }
  const [weapon, armor] = await Promise.all([
    getEquipped(c.env.DB, session.slack_user_id, "weapon"),
    getEquipped(c.env.DB, session.slack_user_id, "armor"),
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
  const art_url = await getOrScheduleViewArt(c.env.AI, artTarget(c.env), c.executionCtx, "smithy_interior", undefined, TOWN_WEEKLY_MS);
  return c.json({ items, gold: character.gold, art_url });
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
    const result = await bumpMaxMana(c.env.DB, character, item.power, 5 /* MAX_MANA_CAP */);
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
  return c.json({ ok: true, item_name: item.item_name, to_name: recipient.name });
});

// List team characters — used by the "Give" picker and the Adventurers panel.
app.get("/api/characters", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB
    .prepare(
      `SELECT slack_user_id, name, class, level, xp, hp, max_hp, last_active, slack_username, scars
       FROM characters
       WHERE slack_user_id != ? AND slack_team_id = ?
       ORDER BY last_active DESC LIMIT 20`,
    )
    .bind(session.slack_user_id, session.slack_team_id)
    .all<{ slack_user_id: string; name: string; class: string; level: number; xp: number; hp: number; max_hp: number; last_active: number; slack_username: string | null; scars: string }>();
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

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);

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
  return c.json({ drinks: drinksWithPrice, drink_buff: drinkBuff, gold: character.gold, spd: spdData, art_url, drinks_remaining: drinksRemaining, npcs, leaderboard });
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
      newBuff = { kind: "buff_attack", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = `+${eff.magnitude} attack for ${eff.duration} actions`;
      break;
    }
    case "buff_magic": {
      newBuff = { kind: "buff_magic", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = `+${eff.magnitude} magic for ${eff.duration} actions`;
      break;
    }
    case "buff_next_crit": {
      newBuff = { kind: "buff_next_crit", magnitude: 1, remaining: 1, drink_id: drink.id };
      await setDrinkBuff(c.env.DB, session.slack_user_id, newBuff);
      summary = "next attack/cast/signature is a guaranteed crit";
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
  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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
  if (typeof stake !== "number" || !LIARS_STAKES.includes(stake)) {
    return c.json({ error: "invalid_stake", valid_stakes: LIARS_STAKES }, 400);
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

  const channelId = (await recentChannelForUser(c.env.DB, session.slack_user_id)) ?? "web";
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
  if (typeof stake !== "number" || !SPD_STAKES.includes(stake)) {
    return c.json({ error: "invalid_stake", valid_stakes: SPD_STAKES }, 400);
  }
  if (throwChoice !== "stone" && throwChoice !== "parchment" && throwChoice !== "dagger") {
    return c.json({ error: "invalid_throw" }, 400);
  }

  const channelId = await recentChannelForUser(c.env.DB, session.slack_user_id);
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

  return c.json({ ok: true, match_id: result.meta.last_row_id as number, status: "open" });
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
  if (typeof amount !== "number" || !SPD_BET_AMOUNTS.includes(amount)) {
    return c.json({ error: "invalid_bet_amount", valid_amounts: SPD_BET_AMOUNTS }, 400);
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
  // Expose whether engine-driven combat is in progress so the dashboard
  // can auto-resume the CombatPage on reload / back navigation. Mode is
  // informational only; presence of web_combat_state is what indicates
  // engine combat is live (whether bootstrapped via start_web_combat
  // from web, or via QuestRoom.bootstrapFromSlack from Slack).
  const hasWebCombat = !!(await getWebCombatState(c.env.DB, quest.id));
  return c.json({ quest, party, has_web_combat: hasWebCombat });
});

// Most-recent completed/failed quests for the signed-in user. Used to render
// the history card.
app.get("/api/quests/recent", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quests = await getRecentQuestsForCharacter(
    c.env.DB,
    session.slack_user_id,
    10,
  );
  return c.json({ quests });
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

  const existing = await getWebCombatState(c.env.DB, questId);
  if (existing) return c.json({ quest_id: questId, state: existing });

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
  await saveWebCombatState(c.env.DB, questId, begun.state);
  // Lock the quest into web mode so Slack combat handlers refuse further
  // /sq attack actions on it. Once flipped to 'web' it stays there for the
  // life of this quest (no automatic unlock on web combat end — the quest
  // is over either way).
  await setQuestMode(c.env.DB, questId, "web");
  return c.json({ quest_id: questId, state: begun.state });
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
  });

  // Full dungeon spoils — dungeon variant rewardMultiplier = 2.5.
  const tier = quest.scene.tier;
  const totalXp = Math.round((10 + tier * 5) * 2.5);
  const totalGold = Math.round((5 + tier * 3) * 2.5);
  const party = await getQuestParty(c.env.DB, questId);
  const partySize = Math.max(1, party.length);
  const xpEach = Math.max(1, Math.floor(totalXp / partySize));
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
      MAX_MANA_CAP,
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

  const price = priceFor(choice.item_type, choice.rarity);
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
  return c.json({ ok: true, room_type: chosenNode.type, is_combat: isCombat });
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
  type: "action";
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
  status: "victory" | "defeat";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
  // True when this was a dungeon combat room — quest stays active, player
  // returns to Slack to advance through doors / non-combat rooms.
  dungeon_room_cleared?: boolean;
}

interface ServerToClient {
  type: "state" | "events" | "error" | "outcome" | "flavor" | "log_replay";
  state?: CombatState;
  events?: unknown[];
  message?: string;
  outcome?: OutcomeSummary;
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
  const tier = state.monster.tier;
  const isBoss = state.monster.is_boss;
  const eliteRow = await env.DB.prepare("SELECT elite FROM quests WHERE id = ?")
    .bind(questId)
    .first<{ elite: number }>();
  const elite = eliteRow?.elite === 1;

  const multiplier =
    (isBoss ? BOSS_REWARD_MULTIPLIER : 1) * (elite ? ELITE_REWARD_MULTIPLIER : 1);
  const totalPoolXp = won ? Math.round(baseRewardXp(tier) * multiplier) : 0;
  const totalPoolGold = won ? Math.round(baseRewardGold(tier) * multiplier) : 0;

  // Contribution split: proportional to damage dealt, with a small support
  // baseline so fighters who contribute via heals/shields/other support
  // actions still earn spoils even if they dealt zero damage.
  const contributions = state.fighters.map((f) => ({
    id: f.id,
    points: (state.contribution[f.id] ?? 0) + SUPPORT_BASE_CONTRIBUTION,
  }));
  const totalContribution = contributions.reduce((s, f) => s + f.points, 0);
  const xpShares: Record<string, number> = {};
  const goldShares: Record<string, number> = {};
  if (won) {
    let xpRemainder = totalPoolXp;
    let goldRemainder = totalPoolGold;
    for (const fighter of contributions) {
      const xpShare = Math.floor((fighter.points / totalContribution) * totalPoolXp);
      const goldShare = Math.floor((fighter.points / totalContribution) * totalPoolGold);
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

  for (const fighter of state.fighters) {
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
      xpAwarded = xpShares[fighter.id] ?? 0;
      goldAwarded = goldShares[fighter.id] ?? 0;
      const result = await awardSpoils(
        env.DB,
        character,
        xpAwarded,
        goldAwarded,
        () => rollDice(6),
        xpForLevel,
        MAX_MANA_CAP,
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
        const named = await nameLootViaAi(env, roll, state.monster.name);
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
        });
      }
    } else if (fighter.hp <= 0) {
      // Soft death: only triggers on actual defeat AND for the fighters
      // that fell. Survivors of a wipe (none here, since defeat means full
      // wipe) would skip this branch.
      const scar = generateScar(state.monster.name);
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
        monster: { is_boss: state.monster.is_boss, total_waves: state.monster.total_waves },
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
  const isDungeon = state.monster.upcoming_waves === undefined && won && await isDungeonQuest(env.DB, questId);
  if (won && isDungeon) {
    const sceneRow = await env.DB
      .prepare("SELECT scene_json FROM quests WHERE id = ?")
      .bind(questId)
      .first<{ scene_json: string }>();
    if (sceneRow) {
      const scene = JSON.parse(sceneRow.scene_json) as {
        tier: number;
        expedition?: ExpState;
        [k: string]: unknown;
      };
      if (scene.expedition) {
        await advanceDungeon(env.DB, questId, scene.expedition, scene, null);
      }
    }
    await setQuestMode(env.DB, questId, "slack");
    await advanceExpeditionAfterWebCombat(env, questId);
  } else {
    await markQuestStatus(env.DB, questId, won ? "completed" : "failed");
  }

  return {
    status: state.status as "victory" | "defeat",
    rewards,
    monster_name: state.monster.name,
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
): Promise<void> {
  const quest = await getQuestById(env.DB, questId);
  const exp = quest?.scene.expedition;
  if (!quest || !exp) return;

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
    if (!ok) return;
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
        : "`/gq choose 1` or `/gq choose 2`";
      const text = `${headline}\nRun \`/gq look\` to see the prompt, or ${advanceHint}.`;
      await postSlackMessage(env.SLACK_BOT_TOKEN, {
        channel: quest.channel_id,
        thread_ts: quest.thread_ts,
        text,
      }).catch((err) => console.warn("dungeon door post failed", err));
    }
    return;
  }

  // Auto-advance — only fires when current was the sub-boss and the next
  // node is treasure. Mirrors advanceDungeon's node branch.
  const nextNode = exp.nodes[next.index];
  if (!nextNode) return;
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
  if (!ok) return;
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
}

interface WsAttachment {
  quest_id: number;
  user_id: string;
}

const productionRoll: RollFn = (sides) => Math.floor(Math.random() * sides) + 1;

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
    const exp = quest.scene.expedition;
    const node = exp ? exp.nodes[exp.current] : undefined;
    if (!node || node.type !== "combat") {
      return { ok: false, reason: "non_combat_room", detail: node?.type ?? "missing" };
    }
  }

  const party = await getQuestParty(db, quest.id);
  const fighters: CombatInit["fighters"] = [];
  for (const member of party) {
    const [weapon, armor] = await Promise.all([
      getEquipped(db, member.slack_user_id, "weapon"),
      getEquipped(db, member.slack_user_id, "armor"),
    ]);
    const cls = classByName(member.class);
    const weaponRange = (weapon?.weapon_range as "melee" | "ranged" | "focus" | null | undefined) ?? "melee";
    const isFocus = weaponRange === "focus";
    fighters.push({
      id: member.slack_user_id,
      name: member.name,
      class: member.class,
      level: member.level,
      hp: member.hp,
      max_hp: member.max_hp,
      mana: member.mana,
      max_mana: member.max_mana,
      shield: member.shield,
      position: member.position,
      attack_mod: cls.attack_mod + Math.floor(member.level / 4),
      magic_mod: cls.magic_mod + Math.floor(member.level / 4),
      weapon_power: isFocus ? 0 : (weapon?.power ?? 0),
      focus_power: isFocus ? (weapon?.power ?? 0) : 0,
      weapon_range: weaponRange,
      slack_username: member.slack_username,
      armor_power: armor?.power ?? 0,
      scars: member.scars,
    });
  }

  const init: CombatInit = {
    fighters,
    monster: {
      name: quest.scene.monster_name,
      hp: quest.scene.monster_hp,
      max_hp: quest.scene.monster_max_hp,
      tier: quest.scene.tier,
      is_boss: variant === "boss",
      boss_phase: quest.scene.boss_phase,
      wave: quest.scene.wave,
      total_waves: quest.scene.total_waves,
      upcoming_waves: quest.scene.upcoming_waves?.map((w) => ({
        name: w.name,
        max_hp: w.max_hp,
      })),
      art_url: quest.scene.monster_art_url,
    },
  };
  const initial = createCombatState(init);
  const seeded: CombatState = {
    ...initial,
    monster: {
      ...initial.monster,
      effects: quest.scene.monster_effects ?? [],
    },
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
    if (inState) {
      // Overwrite even when remaining is unchanged — cheap, and keeps D1
      // converging on the engine view of the buff.
      await dbSetDrinkBuff(db, fighter.id, inState);
    } else {
      // Engine cleared this fighter's buff (consumed to expiry) — clear in
      // D1 too. Safe to call even when D1 already had it null.
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
  private cacheQuestMeta: { channel_id: string; thread_ts: string } | null = null;
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
    }

    const becameTerminal =
      stateChanged &&
      prevState.status === "active" &&
      (result.state.status === "victory" || result.state.status === "defeat");
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
    const state = await this.loadState(questId);
    if (!state) return { ok: false, reason: "no_combat" };
    if (state.status !== "active") return { ok: false, reason: "combat_ended" };

    const result = step(state, action, productionRoll);
    try {
      const outcome = await this.handleStepResult(questId, state, result);
      return {
        ok: true,
        state: result.state,
        events: result.events,
        outcome: outcome ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `outcome_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
      this.cacheQuestMeta = { channel_id: quest.channel_id, thread_ts: quest.thread_ts };
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
    const newLog = this.appendLog(begun.events);
    await saveWebCombatState(this.env.DB, questId, begun.state, newLog);
    this.cacheState = begun.state;
    this.cacheQuestId = questId;

    // Broadcast to any web clients that may already be connected (e.g. a
    // user who opened the web app expecting to start combat but a Slack
    // user got there first).
    this.broadcast({ type: "state", state: begun.state });
    this.broadcast({ type: "events", events: begun.events });

    return { ok: true, state: begun.state, events: begun.events, created: true };
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
    const monsterPatch: Partial<CombatState["monster"]> = {};

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
        const dispatch = applyToolOrScroll(state, actor, item);
        if (dispatch.error) {
          this.sendOne(ws, { type: "error", message: dispatch.error });
          return;
        }
        if (dispatch.fighters) updatedFighters = dispatch.fighters;
        if (dispatch.monster) {
          // Apply via separate object copy below so we keep both in sync.
        }
        effect = dispatch.effect;
        // Stash monster patch for the state assembly below.
        Object.assign(monsterPatch, dispatch.monster ?? {});
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
      monster: { ...state.monster, ...monsterPatch },
    };

    let resultState: CombatState;
    let resultEvents: CombatEvent[];
    if (withEffect.monster.hp <= 0) {
      const killed = resolveMonsterKill(withEffect, action.actor, []);
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
      this.cacheState = snap.state;
      this.cacheQuestId = questId;
      this.cacheLog = snap.log;
      // Reset quest meta on quest-id change — populated lazily by
      // ensureQuestMeta when the flavor fanout needs it.
      this.cacheQuestMeta = null;
    }
    return snap?.state ?? null;
  }

  // Lazily fetch the quest's channel_id + thread_ts so the AI flavor
  // fanout can post into the Slack thread. Returns null when the quest
  // has already ended or no row exists; that's a soft failure — flavor
  // still reaches web clients via WebSocket.
  private async ensureQuestMeta(
    questId: number,
  ): Promise<{ channel_id: string; thread_ts: string } | null> {
    if (this.cacheQuestMeta && this.cacheQuestId === questId) {
      return this.cacheQuestMeta;
    }
    const quest = await getQuestById(this.env.DB, questId);
    if (!quest || !quest.thread_ts) return null;
    this.cacheQuestMeta = { channel_id: quest.channel_id, thread_ts: quest.thread_ts };
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
            if (!meta) return;
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

  // Post a wrap-up summary to the Slack thread after a web combat victory.
  // Skipped for pure-web quests (channel_id starts with "web:") and when
  // SLACK_BOT_TOKEN is absent. Fire-and-forget via ctx.waitUntil.
  private postVictoryWrapup(questId: number, outcome: OutcomeSummary): void {
    if (outcome.status !== "victory") return;
    if (!this.env.SLACK_BOT_TOKEN) return;
    const token = this.env.SLACK_BOT_TOKEN;
    this.ctx.waitUntil(
      (async () => {
        try {
          const meta = await this.ensureQuestMeta(questId);
          if (!meta || meta.channel_id.startsWith("web:")) return;

          const header = [
            outcome.is_boss ? "👑" : "⚔️",
            `*${outcome.monster_name}* defeated`,
            outcome.elite ? " _(elite)_" : "",
            outcome.dungeon_room_cleared ? " _(dungeon room cleared)_" : "",
          ].join("") + "!";

          const lines: string[] = [header];
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
          console.warn("victory wrapup to slack failed", err);
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
    if (result.state.monster.is_boss && !alreadyPosted.has("boss_reveal")) {
      const sawBegin = result.events.some((e) => e.type === "begin");
      if (sawBegin) {
        newlyPosted.push({
          key: "boss_reveal",
          text: `👑 A boss appears: *${result.state.monster.name}*.`,
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
        text: `👑 *${result.state.monster.name}* shifts — *phase 2*.`,
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
      result.state.monster.is_boss &&
      result.events.some((e) => e.type === "victory")
    ) {
      newlyPosted.push({
        key: "victory",
        text: `🏆 Boss slain: *${result.state.monster.name}*.`,
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
        text: `☠️ The party falls to *${result.state.monster.name}*.`,
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
        // We can't tell attack vs cast from the player_hit event alone — look
        // back at the previous `roll` event to disambiguate by die ("d6" vs "d8").
        const recentRoll = events.find(
          (x) => x.type === "roll" && x.actor === e.actor && (x.purpose === "damage_attack" || x.purpose === "damage_cast"),
        );
        const kind: "attack" | "cast" =
          recentRoll && recentRoll.type === "roll" && recentRoll.purpose === "damage_cast" ? "cast" : action;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const monsterName = state.monster.name;
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
        const monsterName = state.monster.name;
        this.ctx.waitUntil(
          flavorVictory(this.env.AI, ref, monsterName, partySize)
            .then((text) => this.broadcastAndLogFlavor(questId, { kind: "victory", actor: e.killed_by, text }))
            .catch(() => undefined),
        );
      } else if (e.type === "fighter_down") {
        const fighter = state.fighters.find((f) => f.id === e.target);
        if (!fighter) continue;
        const ref = { name: fighter.name, class: fighter.class, level: fighter.level };
        const monsterName = state.monster.name;
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
        const monsterName = state.monster.name;
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
