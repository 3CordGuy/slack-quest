// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env, QuestRoomStub } from "./index";
import { cancelLobbyAlarm, questRoomId, scheduleLobbyAlarm } from "./index";
import { renderBattlefieldBlocks, renderTurnToThread } from "./render_combat";

// Public-facing display name. Defaults to "Slack Quest"; operators override per
// deployment by setting BOT_NAME in wrangler.jsonc `vars` or as a secret.
const DEFAULT_BOT_NAME = "Slack Quest";
function botName(env: Env): string {
  return env.BOT_NAME?.trim() || DEFAULT_BOT_NAME;
}
import {
  type ArtTarget,
  VIEW_ART_PROMPTS,
  flavorBossPhase,
  flavorDeath,
  flavorFleeSuccess,
  flavorGauntletNext,
  flavorHit,
  flavorJoin,
  flavorCatalogItem,
  flavorLootDrop,
  flavorSignature,
  flavorVictory,
  generateEncounterArt,
  generateExpeditionTheme,
  generateLockboxScene,
  generateMerchantRoom,
  generateMonsterArtPhase2,
  generateJobListing,
  generateNpcDialog,
  generateNpcRoom,
  generateDungeonGraph,
  generateOpeningScene,
  generateRoomArt,
  generateTownName,
  generateTrapArt,
  generateTrapRoom,
  getOrScheduleCharacterArt,
  getOrScheduleViewArt,
  type AiDialogNode,
  type AiDialogOption,
} from "./ai";

// Builds the monster-art target from env. Returns undefined when IMAGE_BASE_URL
// is unset (e.g. local dev without public URL) — generateOpeningScene then
// skips the art step entirely. Decoupled from the env shape so ai.ts doesn't
// have to import the index Env interface.
function artTargetFromEnv(env: Env): ArtTarget | undefined {
  if (!env.IMAGE_BASE_URL) return undefined;
  return { bucket: env.ASSETS, baseUrl: env.IMAGE_BASE_URL };
}

// Lazy fetcher for singleton view banners (inventory, shop, treasure, etc.).
// Returns the URL when the image is already in R2; on cache miss, schedules
// generation via ctx.waitUntil and returns null. The caller skips the image
// block on null and the next render shows the now-cached image.
//
// Returns null when IMAGE_BASE_URL isn't configured (local dev without public
// URL) — same fallback behavior as the static-jpeg path it replaces.
async function viewArt(
  env: Env,
  ctx: ExecutionContext,
  key: keyof typeof VIEW_ART_PROMPTS,
): Promise<string | null> {
  const target = artTargetFromEnv(env);
  if (!target) return null;
  return getOrScheduleViewArt(env.AI, target, ctx, key, VIEW_ART_PROMPTS[key]);
}
import {
  addCharacterKey,
  addMana,
  addGold,
  addItem,
  addShield,
  appendLog,
  applyFocusManaShift,
  applyLongRest,
  acceptSpdMatch,
  cancelSpdMatch,
  clearDrinkBuff,
  createLiarsRound,
  createSpdMatch,
  finalizeLiarsRound,
  getLiarsRound,
  finalizeSpdMatch,
  findExpiredSpdMatches,
  getClaimedNpcPaths,
  getJobClaim,
  getJobClaims,
  getOpenSpdMatch,
  getPubLeaderboard,
  getSpdBetByUser,
  getSpdBets,
  getSpdMatch,
  getStaleTownState,
  getTownState,
  placeSpdBet,
  recordClaimedNpcPath,
  saveTownState,
  setDrinkBuff,
  setSpdMessageTs,
  tickDrinkBuff,
  tryBumpSpdMatch,
  tryClaimJob,
  type LiarsClaim,
  type LiarsOutcome,
  type PubLeaderboardEntry,
  type SpdBet,
  type SpdMatch,
  applyShortRest,
  applySoftDeath,
  characterLevelRange,
  awardSpoils,
  bumpMaxMana,
  claimShopItem,
  consumeItem,
  cooldownRemaining,
  countCharacters,
  countPurchasesInCycle,
  createCharacter,
  activateQuest,
  addPendingInvitee,
  createQuest,
  deleteCharacter,
  equipItem,
  unequipItem,
  getActiveQuestForCharacter,
  getActiveQuestInChannel,
  getLobbyParty,
  getLobbyQuestById,
  getLobbyQuestForCharacter,
  getActiveShopStock,
  getCharacter,
  getEquipped,
  getInventory,
  getItem,
  getLeaderboard,
  getLifetimeStats,
  getQuestDamageStats,
  patchMonsterArtUrl,
  getQuestParty,
  getQuestPartySize,
  getRecentMonsterNames,
  getShopItem,
  healCharacter,
  insertShopStock,
  isFighter,
  joinQuest,
  markQuestStatus,
  clearPartyEffects,
  refillMana,
  initArmorPool,
  releaseShopClaim,
  removePendingInvitees,
  removeItem,
  resetCooldownsFor,
  reviveCharacter,
  saveScene,
  scaleMonsterForJoin,
  setCharacterEffects,
  setCharacterHp,
  setNotificationPref,
  setBattlefieldTs,
  setJoinableTs,
  setLobbyTs,
  setCharacterHpAndShield,
  setPosition,
  sharpenItem,
  spendStatPoint,
  transferItem,
  trySaveExpeditionAdvance,
  tryDeductGold,
  tryDeductMana,
  trySetHaggleOutcome,
  tryUpdateScene,
  updateInviteStatus,
  updateReadyStatus,
  grantAchievement,
  consumePendingAchievements,
  upsertSlackUsername,
  getAllEquippedSlots,
  type ActiveQuest,
  type LobbyPartyMember,
  type LobbyQuest,
  type BattlePosition,
  type CharGender,
  type Character,
  type DungeonDirection,
  type DungeonGraph,
  type DungeonNode,
  type ExpeditionNode,
  type ExpeditionNodeType,
  type ExpeditionState,
  type GauntletWave,
  type Item,
  type KeyTier,
  type LootOption,
  type MonsterSpec,
  type QuestDamageStats,
  type QuestVariant,
  type SceneJson,
  type ShopItem,
  type StatusEffect,
  issueWebLoginCode,
} from "@gantt-quest/db";
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
import {
  BARTENDER_ARCHETYPES,
  CLASSES,
  DRINKS,
  EFFECT_META,
  FOCUS_MAX_MANA_BONUS,
  REGULAR_ARCHETYPES,
  classByName,
  dropChance,
  findCatalogEntry,
  findDrink,
  findStaple,
  generateMerchantName,
  generateNpcName,
  haggleMod,
  npcTrustMod,
  abilityFor,
  passiveFor,
  pickArchetype,
  pickHaggleLine,
  pickNpcTrustLine,
  generateScar,
  pickRandomClass,
  priceFor,
  rollDice,
  rollItem,
  rollAccessorySlot,
  rollMerchantItem,
  sellPriceFor,
  signatureFor,
  xpForLevel,
  type DialogNode,
  type DialogOption,
  type DialogPayload,
  type DrinkBuff,
  type DrinkSpec,
  type ItemRoll,
  type JobListing,
  type NpcSpec,
  type SkillType,
  type SpdThrow,
  type StapleSpec,
  type TownState,
  SPD_BET_TIERS,
  SPD_BUMP_COOLDOWN_MS,
  SPD_HOUSE_BUMP_PCT,
  SPD_MATCH_EXPIRY_MS,
  SPD_STAKE_TIERS,
  SPD_THROW_META,
  spdCompareThrows,
  STAPLES,
  MAX_MANA_CAP,
  RARITY_BADGE,
  SHIELD_CAP_MULTIPLIER,
  SKILL_META,
  type TurnAction,
  type CombatEvent,
  isMonsterActor,
  checkCombatAchievements,
  checkDeathAchievements,
  checkLiarsAchievements,
  checkSpdAchievements,
  checkProgressionAchievements,
  deriveAll,
  DAMAGE_TYPE_EMOJI,
  type DamageType,
  type EquipSlot,
  type StatKey,
  type Stats,
  statSnapshot,
} from "@gantt-quest/core";
import { deleteMessage, openDMChannel, postJoinableQuest, postMessage, respondToCommand, sendDM, updateMessage, type InteractivePayload, type SlashCommandPayload } from "./slack";

export interface CommandResponse {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: unknown[];
  // Internal-only flag: when true, the /slack/interactive route POSTs
  // { delete_original: true } to the response_url, removing the original
  // message that had the now-stale buttons (merchant prompt, door pick,
  // etc.). Used in tandem with postToThread carrying the new content —
  // the thread becomes the canonical post, and the prompt with its
  // expired buttons is cleared so the chat stays clean. NEVER sent to
  // Slack as a normal response field.
  _deleteOriginal?: boolean;
  // Internal-only flag: when false, the /slack/interactive route passes
  // `replace_original: false` to response_url so the ephemeral does NOT
  // edit/replace the original message that the user clicked from. Used
  // for fire-and-forget acks like the [Join on web] URL-button click,
  // which should leave the recruitment card intact for other users.
  // Slack's default for block_actions response_urls is replace_original:
  // true, hence the explicit opt-out. NEVER sent as a normal response field.
  _replaceOriginal?: boolean;
}

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Party action cooldown — gives other players time to coordinate / react to
// the telegraphed swing. With 8 players online this is the tempo that keeps
// the fight feeling collaborative rather than spammy.
const ACTION_COOLDOWN_MS = 45 * 1000;
// Solo-quest action cooldown — when only one player is on the quest, there's
// nobody else to react / heal / shield / mark, so the 45s cap is just dead
// time. Drop it to 15s so the fight feels more like a real RPG combat loop.
// Switches dynamically: if a second player joins mid-quest, the cooldown
// reverts to the party value on the next action.
const SOLO_ACTION_COOLDOWN_MS = 15 * 1000;
// Resolves the right cooldown for an in-flight action based on the current
// quest roster. Used by every cooldownRemaining call site so the cadence
// stays consistent across attack / cast / signature / ability / heal /
// shield / tool / scroll. Party size > 1 → party cooldown; otherwise solo.
async function actionCooldownMs(db: D1Database, questId: number): Promise<number> {
  const size = await getQuestPartySize(db, questId);
  return size > 1 ? ACTION_COOLDOWN_MS : SOLO_ACTION_COOLDOWN_MS;
}

// Per-monster-turn mana regen. After the actor's action triggers a monster
// counter and the monster swing resolves, the actor gets +N mana back if they
// DIDN'T spend mana that turn (i.e. used attack/cast/non-mana-tool — not
// signature/heal/shield). This creates a "swing and recover" tempo:
// non-caster actions naturally refill mana; caster actions spend it. Net
// effect is mana stays roughly stable when alternating, drains when spamming
// mana actions, and refills steadily during pure-attack stretches. Without
// the no-spend-this-turn gate, signatures would be net-zero cost (spent 1,
// regen 1) and lose all their tactical weight.
const MANA_REGEN_PER_TURN = 1;

// Between-room mana regen for dungeons. When the party advances to a new
// room (post-combat-kill in mid-dungeon, or after a non-combat room
// resolves), every alive partymate gets a small mana refill. Gives caster
// classes a breath beat between fights without making mana free.
const MANA_REGEN_BETWEEN_ROOMS = 1;
const JOIN_HP_RATIO = 0.4; // monster max HP grows by this fraction per joiner

// Mark / focus-fire: how long a /sq mark stays active, and the +damage bonus
// other partymates get when attacking the marked monster. The window is
// generous — long enough to coordinate across timezones without being so
// long it lets one mark cover a whole multi-room dungeon.
const FOCUS_FIRE_DURATION_MS = 90 * 1000; // 90s — two cooldown cycles
const FOCUS_FIRE_BONUS = 2;

// Returns the active mark on a scene, or null if there isn't one (never set,
// or expired). Centralizes the timestamp check so callers don't have to
// inline it. Caller should also verify the mark applies to the CURRENT
// monster — scene transitions (room/wave/quest) clear the mark naturally.
function getActiveMark(scene: SceneJson): { marked_by: string; marked_until: number } | null {
  if (!scene.marked_by || !scene.marked_until) return null;
  if (Date.now() >= scene.marked_until) return null;
  return { marked_by: scene.marked_by, marked_until: scene.marked_until };
}

// Class-passive keys. One entry per passive that's tracked per-fight (i.e.
// "once per fight" passives). Always-on passives — Druid regen, Bard aura,
// Warlock crit-bleed, Sage richer telegraph — don't need a key because they
// don't burn out.
const PASSIVE_ROGUE_FIRST_CRIT = "rogue_first_crit";
// Mage's free-signature, not free-cast — /sq cast is already 0-mana for
// everyone, so a "free cast" passive would be a no-op. The signature is the
// 1-mana action this can meaningfully discount.
const PASSIVE_MAGE_FREE_SIG = "mage_free_sig";
const PASSIVE_WARDEN_SHIELD = "warden_shield";
const PASSIVE_PALADIN_AUTO_HEAL = "paladin_auto_heal";

// Has a specific user already triggered this passive in the current fight?
// Reads from the per-scene passives_used map. Tolerant of legacy scenes
// where the map doesn't exist yet (returns false).
function isPassiveUsed(scene: SceneJson, userId: string, passiveKey: string): boolean {
  return scene.passives_used?.[userId]?.includes(passiveKey) ?? false;
}

// Returns a new SceneJson with the passive flag set. Pure — does not write.
// Callers fold the returned scene into their atomic write (tryUpdateScene)
// alongside whatever else they're updating. The map is keyed by user_id so
// multiple party members of the same class each track their own triggers.
function withPassiveUsed(scene: SceneJson, userId: string, passiveKey: string): SceneJson {
  const current = scene.passives_used ?? {};
  const userPassives = current[userId] ?? [];
  if (userPassives.includes(passiveKey)) return scene;
  return {
    ...scene,
    passives_used: {
      ...current,
      [userId]: [...userPassives, passiveKey],
    },
  };
}

// Tuning knobs for class passives. Centralized so balance tweaks land in one
// place rather than scattered across the combat code.
const PALADIN_AUTO_HEAL_AMOUNT = 8;     // flat HP restore when an ally drops low
const PALADIN_AUTO_HEAL_THRESHOLD = 0.3; // trigger when target.hp/target.max_hp < this
const WARDEN_STARTING_SHIELD = 5;       // shield granted at first action of each fight
const BARD_AURA_DAMAGE = 1;              // +damage to non-Bard party attacks while a Bard is alive
const BARD_AURA_HYMN_DAMAGE = 3;         // Battle Hymn boosts the aura to this for HYMN_USES attacks
const DRUID_PASSIVE_REGEN = 2;           // HP/tick on Druid's own action
const WARLOCK_BLEED_MAGNITUDE = 3;       // HP/tick of the bleed applied on crit
const WARLOCK_BLEED_DURATION = 3;        // monster turns the bleed lasts
const SHOP_RESTOCK_MS = 6 * 60 * 60 * 1000; // 6h channel-wide restock cadence
// Stock scales with the active community: 6 base, +1 per character above 4, capped
// at 12 to keep AI-call cost bounded. 8 players → 10 items per restock.
const SHOP_STOCK_BASE = 6;
const SHOP_STOCK_PER_EXTRA_PLAYER = 1;
const SHOP_STOCK_CAP = 12;
const SHOP_STOCK_PLAYER_BASELINE = 4;
// Per-player purchase cap per restock cycle — keeps one greedy player from clearing
// the whole shop in 30 seconds. 8 players × 2 = 16 max demand vs ~10 supply: slight
// scarcity preserves urgency without freezing late shoppers out.
const SHOP_BUY_CAP_PER_CYCLE = 2;
const BOSS_LEVEL_REQUIRED = 3;
const GAUNTLET_LEVEL_REQUIRED = 5;
const GAUNTLET_WAVES = 3;
// Expeditions are the dungeon-crawl variant — accessible from L1 so new players see
// the bot's depth right away. The L4 gate was holding back the most fun content.
const EXPEDITION_LEVEL_REQUIRED = 1;
const EXPEDITION_TREASURE_OPTIONS = 2;
// Dungeon length: 5-7 rooms total. Last room is treasure (always); second-to-last is
// the sub-boss combat. Middle rooms (count − 2) are randomly chosen from the room pool.
const DUNGEON_MIN_ROOMS = 5;
const DUNGEON_MAX_ROOMS = 7;
const SHORT_REST_COOLDOWN_MS = 10 * 60 * 1000;        // 10 min between short rests
const LONG_REST_COOLDOWN_MS = 24 * 60 * 60 * 1000;    // once per real-world day
const SHORT_REST_HEAL_RATIO = 0.5;                    // heals 50% of missing HP, min 1

// Help text uses the actual slash command name the operator installed under (e.g. /sq,
// /quest, /raid). Slack's /dnd is reserved for Do Not Disturb so don't pick that.
// `name` is the display name (defaults to "Slack Quest"; operators can set BOT_NAME).
function helpText(cmd: string, name: string): string {
  return [
    `*${name} commands*`,
    `• \`${cmd} roll\` — roll a new character (or reroll: free until your first XP, then \`level × 50g\`; confirm with \`${cmd} roll confirm\`)`,
    `• \`${cmd} me\` — show your character sheet`,
    `• \`${cmd} inspect @user\` — view another player's public sheet (level, gear, signature)`,
    `• \`${cmd} quest [variant] [@user1 @user2…]\` — start a quest, optionally inviting party members`,
    `• \`${cmd} quest boss\` — single tougher monster, 2 phases (L3+, 2× rewards)`,
    `• \`${cmd} quest gauntlet\` — 3 monsters back-to-back, no flee (L5+, 3× rewards, guaranteed drop)`,
    `• \`${cmd} quest dungeon\` — 5-7 room dungeon crawl: combat, traps, lockboxes, NPC encounters → sub-boss → treasure (L1+, 2.5× rewards)`,
    `• \`${cmd} quest elite\` — elite modifier; perma-death (composes: \`${cmd} quest boss elite\`)`,
    `• \`${cmd} choose <n>\` — pick a room option in a dungeon (first vote wins)`,
    `• \`${cmd} take <n>\` — claim an item from a dungeon's final treasure room`,
    `• \`${cmd} join\` — join the active quest in this channel`,
    `• \`${cmd} attack\` — strike with weapon: \`1d6 + atk_mod + weapon\` (crit on nat 6, *front-row only*)`,
    `• \`${cmd} cast\` — channel magic: \`1d8 + mag_mod + weapon\` (crit on nat 8, any row)`,
    `• \`${cmd} flee\` — try to escape (\`1d2\`; on fail you take a free hit)`,
    `• \`${cmd} position front|back\` — set battle position. Free outside a quest; mid-quest costs the 45s combat cooldown.`,
    `• \`${cmd} signature\` (alias \`sig\`) — your class's signature ability (costs 1 mana, refills between quests)`,
    `• \`${cmd} ability\` (alias \`active\`) — your class's active ability (costs mana, 45s cooldown — see \`${cmd} me\`)`,
    `• \`${cmd} mark\` (alias \`focus\`) — call focus on the current foe; partymates get *+${FOCUS_FIRE_BONUS}* damage for ${Math.round(FOCUS_FIRE_DURATION_MS / 1000)}s (free action, no cooldown)`,
    `• \`${cmd} heal [@user]\` — restore \`1d6 + magic_mod\` HP on a party member (costs 1 mana, default self)`,
    `• \`${cmd} revive <id> @user\` — bring a downed party member back, consuming a revive item`,
    `• \`${cmd} rest\` — short rest: heals 50% of missing HP (10-min cooldown)`,
    `• \`${cmd} rest long\` — long rest: full HP restore, once per 24 hours`,
    `• \`${cmd} inventory\` (aliases: \`inv\`, \`i\`, \`bag\`, \`pack\`, \`backpack\`, \`items\`, \`loot\`) — list your items (equipped marked ✅)`,
    `• \`${cmd} look\` (\`where\`, \`scene\`) — re-show the current room / door choices if you've scrolled past`,
    `• \`${cmd} equip <id>\` — equip a weapon or armor by inventory id`,
    `• \`${cmd} unequip <id>\` — drop an equipped weapon or armor back into your pack (empties the slot)`,
    `• \`${cmd} use <id>\` — use a consumable (free action, no cooldown)`,
    `• \`${cmd} shop\` — view the channel's shop (restocks every 6h)`,
    `• \`${cmd} town\` (alias \`village\`) — visit the channel town: pub, shop, job board, more locations coming.`,
    `• \`${cmd} pub\` (alias \`tavern\`) — drinks (temp buffs + restores), chat with locals, play 🎲 Liars' Roll / 🪨📜🗡 SPD for gold. \`${cmd} pub lb\` for the pub games leaderboard.`,
    `• \`${cmd} board\` (aliases: \`jobs\`, \`jobboard\`) — view the day's posted quests; click to accept.`,
    `• \`${cmd} smithy\` (alias \`forge\`) — upgrade equipped gear: 🔨 Sharpen melee, 🛠️ Tune ranged, 🛡️ Reinforce armor. +1 per use, capped at 3 upgrades per item.`,
    `• \`${cmd} inn\` (alias \`lodge\`) — pay gold to rest now. 🛏️ Common Cot (20g, full HP) or 🛁 Hot Bath & Bed (50g, full HP + mana). Bypasses the 24h \`${cmd} rest long\` cooldown.`,
    `• \`${cmd} buy <id>\` — purchase a shop item with gold`,
    `• \`${cmd} haggle <id>\` — try to talk down the price (1d6 + class mod; communal, once per item)`,
    `• \`${cmd} sell <id>\` — sell an inventory item for 30% of shop price`,
    `• \`${cmd} sell-key <tier>\` — sell one key for gold (🥉 5g / 🥈 25g / 🥇 100g)`,
    `• \`${cmd} transmute <tier>\` — combine 3 keys of a tier into 1 of the next (🥉→🥈, 🥈→🥇)`,
    `• \`${cmd} give <id> @user\` — gift an inventory item to another player (unequip first)`,
    `• \`${cmd} party\` — show the current quest's roster + HP`,
    `• \`${cmd} stats\` (\`record\`) — your lifetime track record: quests won/lost, damage dealt, kills, healing/shielding, deaths, revives`,
    `• \`${cmd} leaderboard\` — top 10 heroes`,
    `• \`${cmd} help\` — show this list`,
    `• \`${cmd} rules [section]\` — mechanics reference. No arg → table of contents; pass a section name (e.g. \`combat\`, \`items\`, \`quests\`) for the details.`,
    "_Combat actions have a 45s cooldown per player in a party, 15s solo._",
  ].join("\n");
}

// Full mechanics reference, sectioned by category. `/sq rules` with no args
// returns a table-of-contents pointer so the channel isn't spammed with the
// whole wall of text every time someone asks "wait, what's a lockbox?";
// `/sq rules <section>` returns the specific block. Sections accept short
// aliases (singular/plural, common synonyms) so players don't have to guess
// the canonical name. Unknown sections fall back to the TOC with a hint.
//
// To add a section: append to RULES_SECTIONS with its id, title, aliases,
// emoji, and a body-builder. The dispatcher matches the user's arg (lowercased)
// against the id OR any alias.
interface RulesSection {
  id: string;            // canonical name (single word, lowercase)
  emoji: string;         // header decoration
  title: string;         // human-readable label for TOC + section header
  aliases: string[];     // alternative names accepted on the CLI
  body: (cmd: string) => string[];   // section body lines (joined w/ \n)
}

function rulesSections(): RulesSection[] {
  return [
    {
      id: "characters",
      emoji: "🧝",
      title: "Characters",
      aliases: ["character", "char", "chars", "roll", "level", "leveling", "xp"],
      body: (cmd) => [
        `• Roll with \`${cmd} roll\`. 8 engineering-themed classes, randomly assigned (HP / atk_mod / mag_mod vary by class).`,
        `• *Reroll:* free until your first XP, then \`level × 50g\`. Confirm with \`${cmd} roll confirm\` — deletes everything (gold, gear, scars).`,
        `• *Level up* (auto on XP threshold): max HP +1d6, HP refills, mana recalculates and refills.`,
        `• *Mana:* scales with INT and level — 2 + floor((INT−4)/2) + floor(level/6). Refills between quests, on join, and on level-up.`,
        `• See \`${cmd} rules classes\` for the per-class signature / passive / active breakdown.`,
      ],
    },
    {
      id: "classes",
      emoji: "🧙",
      title: "Classes & Abilities",
      aliases: ["class", "signatures", "passives", "actives", "kit", "kits"],
      // Renders the full 8-class kit. Each class block is 5 lines (header +
      // 4 facts) so the whole section is ~50 lines — long but scannable
      // because each class is a self-contained quote-block.
      //
      // Pulls from CLASSES / SIGNATURES / PASSIVES / ABILITIES (single
      // source of truth in flavor.ts) so this stays in sync automatically
      // when class kits get tuned. Only the per-class emoji map lives here,
      // matching the inline tags used in ability handlers / passive lines.
      body: (cmd) => {
        const emoji: Record<string, string> = {
          devops_mage: "🧙",
          qa_paladin: "✨",
          backend_druid: "🌿",
          frontend_bard: "🎭",
          staff_sage: "📜",
          refactor_rogue: "🗡",
          sre_warden: "🛡",
          data_warlock: "💀",
        };
        const lines: string[] = [
          `_8 classes, randomly assigned on \`${cmd} roll\`. Each has a signature (damage), a passive (always-on or auto-trigger), and an active (tactical, costs mana, 45s cooldown)._`,
          ``,
        ];
        for (const cls of CLASSES) {
          const sig = signatureFor(cls.name);
          const passive = passiveFor(cls.name);
          const ability = abilityFor(cls.name);
          const skillTags = cls.skills.map((s) => `${SKILL_META[s].emoji} ${SKILL_META[s].label}`).join(" · ");
          const e = emoji[cls.id] ?? "•";
          lines.push(`*${e} ${cls.name}* — _HP ${cls.base_hp} • atk +${cls.attack_mod} • mag +${cls.magic_mod} • ${skillTags}_`);
          if (sig) lines.push(`   ✨ *Signature — ${sig.name}* _(1m)_: ${sig.blurb}`);
          if (passive) lines.push(`   🌟 *Passive — ${passive.name}*: ${passive.blurb}`);
          if (ability) lines.push(`   ⚡ *Ability — ${ability.name}* _(${ability.mana_cost}m)_: ${ability.blurb}`);
          lines.push(``);
        }
        lines.push(`_Tip: \`${cmd} me\` shows your class's kit; \`${cmd} ability\` invokes your active._`);
        return lines;
      },
    },
    {
      id: "position",
      emoji: "🎯",
      title: "Battle Position",
      aliases: ["positioning", "row", "front", "back", "rank"],
      body: (cmd) => [
        `• 🔼 *Front:* 3× more likely to be targeted, takes full damage. Required for melee \`${cmd} attack\`.`,
        `• 🔽 *Back:* less hit risk, takes 60% damage, *can only \`${cmd} attack\` with a ranged or focus weapon equipped*.`,
        `• \`${cmd} position front|back\` — free outside a quest; mid-quest costs the 45s combat cooldown.`,
        `• _Position effects only apply in parties of 2+. Solo fights ignore positioning entirely._`,
      ],
    },
    {
      id: "combat",
      emoji: "⚔️",
      title: "Combat",
      aliases: ["fight", "attack", "cast", "signature", "sig", "abilities", "ability", "active"],
      body: (cmd) => [
        `_All actions share one cooldown — *45s* in a party (so teammates have time to react), *15s* solo (no teammates to wait on). Switches automatically as players join/leave._`,
        `• \`${cmd} attack\` — \`1d6 + atk_mod + weapon\`, crit on nat 6 (×2 damage)`,
        `• \`${cmd} cast\` — \`1d8 + mag_mod + weapon\`, crit on nat 8`,
        `• \`${cmd} signature\` (\`sig\`) — class-specific big move, costs 1 mana`,
        `• \`${cmd} ability\` (\`active\`) — class-specific active. Costs mana (1-2), 45s cooldown. \`${cmd} me\` shows yours.`,
        `• \`${cmd} flee\` — \`1d2\`. 1 = escape (party fights on); 2 = trip + free monster hit. Blocked in gauntlet/dungeon.`,
        `• *Mana regen:* basic \`attack\`/\`cast\` refunds +1 mana on the monster's retaliation (no regen on mana-spending actions). In dungeons, the party also gets +1 mana between rooms.`,
        `• \`${cmd} heal [@user]\` — \`1d6 + mag_mod\` HP to a partymate, costs 1 mana, burns the 45s combat cooldown (no monster counter — it's a support action)`,
        `• \`${cmd} shield\` — replenish your depletable armor pool back to max (\`floor(armor_power/2)\`), no mana cost. Physical hits chip armor before HP; magic/elemental bypass it entirely.`,
        `• \`${cmd} revive <id> @user\` — bring downed partymate back, consumes a revive item (no mana cost)`,
        `• Monster damage: \`1d4 + tier + party_bonus\`. *Physical* attacks deplete your armor pool first, overflow → HP. *Magic/elemental* attacks bypass armor — mitigated only by gear resistances (%). Back-row reduces all damage ×0.6, min 1. Boss phase 2 adds +tier.`,
        `• *Targeting:* monster picks a victim weighted 3:1 front:back from alive fighters — front-line tanks soak hits for back-line casters.`,
      ],
    },
    {
      id: "items",
      emoji: "🎒",
      title: "Items & Equipment",
      aliases: ["item", "equipment", "gear", "weapon", "weapons", "armor", "consumable", "consumables", "scroll", "scrolls", "tool", "tools"],
      body: (cmd) => [
        `• ⚔️ *Melee weapons* — front-row only for \`attack\`; \`+N\` to attack/cast/sig damage`,
        `• 🏹 *Ranged weapons* — usable from any row for \`attack\`; same damage bonus`,
        `• 🔮 *Focus weapons* (caster/support) — usable any row, NO damage bonus, *+N to \`heal\`* amounts, *+1 max mana while equipped*, *+10% magic resistance* passively. The healer/support build.`,
        `• 🛡️ *Armor* — reduces *physical* incoming damage by \`floor(power/2)\`. Has no effect on magic/elemental attacks.`,
        `• 💎 *Gear resistances* — rings, amulets, and high-rarity armor can roll fire/ice/lightning/magic resistance (%). Stack across slots, capped at 75% per type.`,
        `• 🧪 *Consumables* — \`${cmd} use <id>\` heals N HP. Free action, no cooldown.`,
        `• 🔮 *Magic items* — \`${cmd} use <id>\` grants permanent +N max mana (cap 5)`,
        `• 🌱 *Revive items* — bring downed teammate back at N% HP (rarity-tiered 50/75/100%)`,
        `• 🧨 *Tools* — single-shot offensive consumables; \`${cmd} use <id>\` deals damage, ignores armor (consumes a combat turn)`,
        `• 📜 *Scrolls* — single-shot rituals; \`${cmd} use <id>\` triggers the named effect. 🔄 Rebase (FREE action — party cooldowns + mana wipe to full, no retaliation), 💥 Production Outage (consumes a turn — boss -30% HP / non-boss → 1 HP)`,
        `• Slots: 1 weapon + 1 armor equipped at a time. \`${cmd} equip <id>\` swaps in.`,
        `• \`${cmd} give <id> @user\` — gift any unequipped item; channel-public message`,
      ],
    },
    {
      id: "town",
      emoji: "🏘️",
      title: "Town & Pub",
      aliases: ["village", "pub", "tavern", "drinks", "drink", "liars", "dice", "spd", "stone", "parchment", "dagger", "leaderboard", "lb", "board", "jobs", "jobboard", "smithy", "forge", "sharpen", "inn", "lodge"],
      body: (cmd) => [
        `• \`${cmd} town\` — channel hub map: 🍺 Pub, 🛒 Shop, 📋 Job Board, ⚒️ Smithy, 🛏️ Inn.`,
        `• \`${cmd} pub\` — the tavern. *Between-quest only* — no drinks mid-fight.`,
        `• \`${cmd} board\` (aliases \`jobs\` / \`jobboard\`) — three posted contracts daily: 1 standard, 1 boss (L${BOSS_LEVEL_REQUIRED}+), 1 dungeon (L${EXPEDITION_LEVEL_REQUIRED}+). Click *Take Job* to ride out.`,
        `   _Job differences vs. \`${cmd} quest\`:_ (1) the foe IS the posted title (standard/boss) — the board's promise is real; (2) town pays a *+12% bonus* on XP and gold; (3) *each job is exclusive — first to click claims it, the others must use \`${cmd} quest\` or wait for tomorrow*.`,
        `• \`${cmd} smithy\` (alias \`forge\`) — upgrade equipped gear for *+1* per use: 🔨 *Sharpen* melee weapons, 🛠️ *Tune* ranged weapons, 🛡️ *Reinforce* armor. Cost scales with current stat _(\`(current + 1) × 20g\` — e.g. +3→+4 = 80g, +5→+6 = 120g)_. Hard cap: *${SMITHY_SHARPEN_CAP} upgrades per item*. Sharpened gear sells back for more.`,
        `• \`${cmd} inn\` (alias \`lodge\`) — two room tiers. 🛏️ Common Cot (20g, full HP). 🛁 Hot Bath & Bed (50g, full HP + full mana). The Inn bypasses the 24h \`${cmd} rest long\` cooldown — pay gold any time. Refuses to take your money if you're already rested.`,
        ``,
        `*🍷 Drinks:* one active buff at a time (second drink replaces the first). Buffs tick on quest actions that match the drink (no waste on mismatched actions). Cleared at quest end.`,
        `   • 🍺 *Tavern Ale* (8g) — +1 attack for 3 actions`,
        `   • 🍷 *Spiced Mead* (8g) — +1 magic for 3 actions`,
        `   • 🥃 *Iron Brew* (8g) — +5 shield, instant`,
        `   • 🍵 *Bitter Tea* (12g) — +2 mana, instant`,
        `   • 🥛 *Frothy Milk* (10g) — +8 HP, instant`,
        `   • 💧 *Lucky Sip* (15g) — next attack/cast/sig is a guaranteed crit`,
        `   • 🍶 *Aged Whiskey* (25g) — +2 attack for 3 actions`,
        `   • 🍹 *Engineer's Reset* (30g) — +4 HP and +4 mana, instant`,
        `   ⭐ One drink rotates as the *daily special* (30% off).`,
        ``,
        `*👥 NPCs:* bartender + 2 regulars, rotate daily. Multiple-choice dialog trees — clicking branches occasionally yields a rumor, gold tip, free drink, or XP. Rewards claim once per day per NPC.`,
        ``,
        `*🎲 Liars' Roll:* bluff mini-game vs. the bartender. Stake 10/25/50g. You both roll 3d6 (yours visible, theirs hidden); the bartender announces a CLAIM about the combined zone (Low ≤18 / Medium 19-23 / High ≥24). The bartender lies *45% of the time*. *Trust* their claim (pays 1.7×) or *Challenge* "Liar!" (pays 2.5×). Wrong call = lose your stake. House takes a 5% cut on wins.`,
    ``,
    `*🪨📜🗡 Stone-Parchment-Dagger:* multiplayer pub game. Two players each stake 10/25/50g and privately commit a throw (🪨 Stone / 📜 Parchment / 🗡 Dagger). Spectators side-bet 5/10/25g on either player (one bet per match). Reveal happens the moment the challenger commits; winner takes both stakes + a *+${Math.round(SPD_HOUSE_BUMP_PCT * 100)}% house bump* on total wagered; winning side bets pay *2×*; losing bets keep by the house. Tie refunds everything. One open match per channel; initiator can \`📣 Bump\` (30-min cooldown) or \`🚪 Cancel\` for 24h (matches expire after that).`,
    ``,
    `*🏆 Leaderboard:* \`${cmd} pub lb\` (alias \`leaderboard\`) — channel-scoped ranking by net gold across Liars' Roll + SPD matches + SPD side bets. Top 10, with biggest-single-win and biggest-single-loss callouts at the bottom.`,
      ],
    },
    {
      id: "shop",
      emoji: "🛒",
      title: "Shop",
      aliases: ["shopping", "buy", "sell", "haggle", "staples", "merchant"],
      body: (cmd) => [
        `• \`${cmd} shop\` — channel-shared, restocks every 6h with AI-generated items.`,
        `• *Stock size scales:* 6 base + 1 per character above 4 (cap 12). 8 players → 10 items per cycle.`,
        `• *Per-player cap:* 2 purchases per restock cycle (no whale-clearing).`,
        `• Pricing (flat per rarity): gear 15g/50g/150g; magic 100g/250g/500g; revive 150g/280g/450g.`,
        `• *Staples* — always-in-stock potions: 🧪 Health (15g/+10HP), 🧪 Greater Health (40g/+25HP), ✨ Mana Vial (30g/+1m), ✨ Mana Flask (60g/+2m). No buy cap; also stocked in the dungeon merchant.`,
        `• Rolled consumables are *rare only* (heal 31-50 HP) — premium tier above the staples.`,
        `• \`${cmd} sell\` returns 30% of buy price. No shopping mid-quest.`,
        `• \`${cmd} haggle <id>\` — *free action*, once per item (any party member). Roll 1d6 + class mod: 🎭 Bard +2, 🗡️ Rogue +1, 🧙 Sage +1. ≤3 fail (price locks), 4-5 → 15% off, 6 → 25% off, 7+ → 30% steal. The discount is communal — anyone can buy at the haggled price.`,
      ],
    },
    {
      id: "quests",
      emoji: "🗺️",
      title: "Quest Variants",
      aliases: ["quest", "variants", "boss", "gauntlet", "dungeon", "expedition", "elite", "trap", "traps", "lockbox", "lockboxes", "npc", "keys", "key"],
      body: (cmd) => [
        `• \`${cmd} quest\` — standard, 1 monster, 1× rewards`,
        `• \`${cmd} quest boss\` — L3+, beefy monster, 2 phases at 50% HP, 2× rewards`,
        `• \`${cmd} quest gauntlet\` — L5+, 3 monsters back-to-back, no flee, 3× rewards, 100% drop on the final kill`,
        `• \`${cmd} quest dungeon\` (alias \`expedition\`) — *the dungeon crawl* (L1+). 5-7 rooms: combat, trap, lockbox, NPC encounter. Sub-boss + treasure at the end. 2.5× rewards.`,
        `   _Door-pick navigation_ — between rooms, pick from 2 doors (\`${cmd} choose 1|2\`). The unchosen door is sealed.`,
        `   _Trap rooms_ — 3 skill-keyed options (STR / DEX / INT). Roll \`1d6 ≥ 4\` to pass. Class-skill match: +2 to the roll (~83% pass). Pass yields a skill-tied reward: 💪 STR drops a 🥉 bronze key, 🔧 DEX grants 🛡️ shield, 📜 INT restores ✨ mana. Fail = HP damage.`,
        `   _Lockbox rooms_ — tiered locks (🥉 bronze / 🥈 silver / 🥇 gold). Need a matching-or-higher key from your inventory; bigger tier = bigger loot.`,
        `   _Keys_ — 🥉 bronze drops from each combat room; 🥈 silver from the sub-boss; 🥇 gold rarely from chests. *Keys persist on your character* across dungeons.`,
        `   _NPC rooms_ — trust is risky! Roll 1d6 + class trust mod (🎭 Bard +2, 🧙 Sage +2, 🗡️ Rogue +1, 👁️ Warlock +1, others 0). ≤2: betrayed (no item + damage). 3: tainted (item + 🔴 Bleeding). 4+: clean exchange. Refuse to walk away safely.`,
        `   _Merchant_ — guaranteed once per dungeon, right before the sub-boss. 3 practical-for-the-fight items at flat shop prices (no markup). Stock evaporates when you walk past.`,
        `   _Map_ — \`🗺️\` trail shown each room; full reveal (with sealed doors) on completion.`,
        `   Class skills: 💪 *STR*: Paladin, Warden, Druid · 🔧 *DEX*: Rogue, Mage · 📜 *INT*: Bard, Sage, Warlock, Mage, Druid`,
        `• \`${cmd} quest elite\` — modifier: *perma-death* on 0 HP. Composes: \`${cmd} quest boss elite\`.`,
        `• *Invite at start:* \`${cmd} quest [variant] @user1 @user2\` — auto-joins them, scales monster HP per joiner.`,
      ],
    },
    {
      id: "joining",
      emoji: "🤝",
      title: "Joining a Quest",
      aliases: ["join", "party", "invite"],
      body: (cmd) => [
        `• \`${cmd} join\` — join the active channel quest. Monster max HP grows ×1.4 per joiner.`,
        `• Joinable through wave 1 of a gauntlet (locks at wave 2).`,
        `• Joinable until the first room is resolved on a dungeon (locks once anyone advances).`,
      ],
    },
    {
      id: "death",
      emoji: "💀",
      title: "Death & Recovery",
      aliases: ["downed", "dying", "rest", "scars", "scar", "perma", "permadeath"],
      body: (cmd) => [
        `• *Soft death* (any non-elite at 0 HP): 25% gold loss, drop a random item, +1 scar, *12h cooldown*, HP restored to max for next time.`,
        `• *Perma death* (elite quest at 0 HP): character row deleted (gear, gold, scars — all gone). Roll a new one.`,
        `• \`${cmd} rest\` — short rest between quests, heals 50% of missing HP, 10-min cooldown.`,
        `• \`${cmd} rest long\` — full HP restore, *once per 24h*.`,
      ],
    },
    {
      id: "visibility",
      emoji: "👁️",
      title: "Visibility",
      aliases: ["channel", "thread", "ephemeral", "messages"],
      body: () => [
        `• Channel sees: quest start, quest end (victory / failure / abandoned). And the leaderboard if you run it.`,
        `• Quest thread sees: every combat action with full Block Kit cards (narration, dice math, monster + actor stats).`,
        `• You see (ephemeral): your own action's deterministic outcome instantly; the AI-flavored thread version follows ~1-2s later.`,
      ],
    },
  ];
}

// Match a user-supplied section name (lowercased) against canonical ids and
// aliases. Returns null on miss so the caller can render the TOC fallback.
function findRulesSection(query: string): RulesSection | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  for (const section of rulesSections()) {
    if (section.id === q || section.aliases.includes(q)) return section;
  }
  return null;
}

// Renders the table of contents — categories with the slash to drill in,
// plus pointers to help/me for the adjacent reference surfaces.
function rulesToc(cmd: string, name: string): string {
  const lines: string[] = [
    `*🎲 ${name} — Mechanics Reference*`,
    ``,
    `_Pick a section: \`${cmd} rules <section>\`_`,
    ``,
  ];
  for (const section of rulesSections()) {
    lines.push(`• ${section.emoji} \`${cmd} rules ${section.id}\` — *${section.title}*`);
  }
  lines.push(``);
  lines.push(`_Use \`${cmd} help\` for the command list. \`${cmd} me\` for your sheet._`);
  return lines.join("\n");
}

// Renders a single section. `unknownArg` (non-null when the user typed
// something that didn't match) becomes a header note pointing them back at
// the TOC — better than silently returning the wrong section.
function rulesSection(cmd: string, name: string, section: RulesSection): string {
  return [
    `*${section.emoji} ${name} — ${section.title}*`,
    ``,
    ...section.body(cmd),
    ``,
    `_\`${cmd} rules\` for the full table of contents._`,
  ].join("\n");
}

// `/sq rules` → TOC. `/sq rules <section>` → that section. Unknown section →
// TOC with a note. We keep this as a single entry point so the dispatch in
// handleCommand stays clean and aliases are honored uniformly.
function rulesText(cmd: string, name: string, arg?: string): string {
  if (!arg) return rulesToc(cmd, name);
  const match = findRulesSection(arg);
  if (match) return rulesSection(cmd, name, match);
  return [
    `_Unknown section \`${arg}\`. Pick one below:_`,
    ``,
    rulesToc(cmd, name),
  ].join("\n");
}

// Block Kit TOC — same content as rulesToc but interactive. Slack caps each
// `actions` block at 5 buttons, so 10 sections span 2 actions blocks. The
// action_id is `rules_<section_id>` so handleInteraction can dispatch by
// prefix; the button label uses the emoji + title for visual scannability
// without requiring players to remember the canonical section name.
//
// We also keep a text fallback (the same string rulesToc returns) so clients
// that strip blocks — notifications, screen readers — still get readable
// content.
function rulesBlocksToc(cmd: string, name: string): { text: string; blocks: unknown[] } {
  const sections = rulesSections();
  const text = rulesToc(cmd, name);
  const intro = `*🎲 ${name} — Mechanics Reference*\n_Pick a section below, or type \`${cmd} rules <section>\`._`;
  // Split into chunks of 5 — Slack rejects actions blocks with more than 5
  // elements. With 10 sections we get two 5-button rows; adding more sections
  // later will spill into a third.
  const chunks: RulesSection[][] = [];
  for (let i = 0; i < sections.length; i += 5) {
    chunks.push(sections.slice(i, i + 5));
  }
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: intro } },
  ];
  for (const chunk of chunks) {
    blocks.push({
      type: "actions",
      elements: chunk.map((s) => ({
        type: "button",
        action_id: `rules_${s.id}`,
        value: s.id,
        text: { type: "plain_text", text: `${s.emoji} ${s.title}`, emoji: true },
      })),
    });
  }
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `_\`${cmd} help\` for the command list • \`${cmd} me\` for your sheet._` },
    ],
  });
  return { text, blocks };
}

// Block Kit single section — body as a markdown section, plus a footer
// actions block with a "📋 Table of Contents" button so players can hop back
// without retyping. The action_id is the special `rules_toc` sentinel.
function rulesBlocksSection(cmd: string, name: string, section: RulesSection): { text: string; blocks: unknown[] } {
  const text = rulesSection(cmd, name, section);
  const header = `*${section.emoji} ${name} — ${section.title}*`;
  const body = section.body(cmd).join("\n");
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header } },
      { type: "section", text: { type: "mrkdwn", text: body } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "rules_toc",
            value: "toc",
            text: { type: "plain_text", text: "📋 Table of Contents", emoji: true },
          },
        ],
      },
    ],
  };
}

// Single entry point used by both the slash dispatcher and the button
// interaction handler. Resolves an optional `arg` (section name or alias) to
// either the TOC or a specific section view, returning a CommandResponse
// with text + blocks.
function rulesResponse(cmd: string, name: string, arg?: string): CommandResponse {
  if (!arg) {
    const r = rulesBlocksToc(cmd, name);
    return { text: r.text, response_type: "ephemeral", blocks: r.blocks };
  }
  const match = findRulesSection(arg);
  if (match) {
    const r = rulesBlocksSection(cmd, name, match);
    return { text: r.text, response_type: "ephemeral", blocks: r.blocks };
  }
  // Unknown section — show TOC with an inline note explaining the miss.
  const r = rulesBlocksToc(cmd, name);
  const noteBlock = { type: "section", text: { type: "mrkdwn", text: `_Unknown section \`${arg}\`. Pick one below:_` } };
  return {
    text: `Unknown section "${arg}". ${r.text}`,
    response_type: "ephemeral",
    blocks: [noteBlock, ...r.blocks],
  };
}

// Routes Block Kit button clicks to the same handlers slash commands use. We
// build a synthetic SlashCommandPayload from the interactive payload so we can
// reuse the existing per-action functions without duplicating their logic.
//
// action_id values used today (set in /sq inventory render):
//   "equip" | "use" | "sell"   — value = inventory id (string)
//
// Slack's interactive endpoint expects a fast 200. The actual handler may post
// to thread / response_url asynchronously; we just return the immediate response.
export async function handleInteraction(
  payload: InteractivePayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  if (payload.user.username) {
    ctx.waitUntil(upsertSlackUsername(env.DB, payload.user.id, payload.user.username).catch(() => {}));
  }
  if (payload.type !== "block_actions" || payload.actions.length === 0) {
    return ephemeral("Unknown interaction.");
  }
  const action = payload.actions[0];
  const slash: SlashCommandPayload = {
    token: "",
    team_id: payload.team.id,
    team_domain: payload.team.domain ?? "",
    channel_id: payload.channel.id,
    channel_name: payload.channel.name ?? "",
    user_id: payload.user.id,
    user_name: payload.user.username ?? "",
    // Use the same command label slash commands use so the help/error text reads
    // naturally. We don't have access to the original command name here, so
    // default to the bot's display alias.
    command: "/" + (env.BOT_NAME?.toLowerCase().replace(/\s+/g, "") || "sq"),
    text: action.value,
    response_url: payload.response_url,
    trigger_id: payload.trigger_id,
    api_app_id: payload.api_app_id,
    // Mark this as an interactive (button) origin. Downstream handlers
    // check this flag to avoid double-rendering — button clicks already
    // surface their result via response_url; the slash-command pattern of
    // ephemeral + postToThread would otherwise duplicate the content.
    _interactive: true,
  };
  const args = [action.value];

  // Recruitment-card "Join on web" link button. Slack DOES deliver an
  // interactivity payload for URL buttons even though it also opens the
  // URL in the user's browser; we ack with a brief ephemeral instead of
  // letting it fall through to the "Unknown action" error message.
  // _replaceOriginal: false keeps the recruitment card intact (Slack's
  // default for block_actions response_urls is to REPLACE the original;
  // here that would dismiss the card for the clicker so they can't come
  // back to use [Join here], and other channel members would still see
  // it — confusing inconsistency we explicitly opt out of).
  if (action.action_id.startsWith("link_quest_web_")) {
    return {
      text: "🌐 Opening on web…",
      response_type: "ephemeral",
      _replaceOriginal: false,
    };
  }
  // Recruitment-card "Join here" button. action_id encodes the quest id
  // (`join_quest_<id>`) for uniqueness, but handleJoin looks up the active
  // quest in the channel naturally — the encoded id is for action_id
  // uniqueness only, not as a lookup key. If the quest has since advanced
  // past join-window (gauntlet wave 2+, dungeon past room 1) handleJoin's
  // own checks ephemerally reject the click.
  if (action.action_id.startsWith("join_quest_")) return handleJoin(slash, env, ctx);
  // Pinned-battlefield action buttons. action_id format:
  //   turn_<action>_<questId>_<actorId>
  // The engine validates turn order — actor mismatch surfaces as an
  // ephemeral "not your turn" rather than a Slack-side gate. handleCombat
  // reads env.LEGACY_SLACK_COMBAT and routes to legacy when set; for
  // button-driven turns we always go via the engine path (the legacy
  // cooldown loop has no equivalent battlefield buttons).
  if (action.action_id.startsWith("turn_attack_")) return handleCombatViaEngine(slash, env, ctx, "attack");
  if (action.action_id.startsWith("turn_cast_")) return handleCombatViaEngine(slash, env, ctx, "cast");
  if (action.action_id.startsWith("turn_signature_")) return handleCombatViaEngine(slash, env, ctx, "signature");
  if (action.action_id.startsWith("turn_flee_")) return handleCombatViaEngine(slash, env, ctx, "flee");
  if (action.action_id === "equip") return handleEquip(slash, args, env);
  if (action.action_id === "unequip") return handleUnequip(slash, args, env);
  if (action.action_id === "use") return handleUse(slash, args, env, ctx);
  if (action.action_id === "sell") return handleSell(slash, args, env);
  if (action.action_id === "inventory") return handleInventory(slash, env, ctx);
  // dungeon_choose_<n> / dungeon_take_<n> encode the option index in the
  // action_id because Slack requires action_ids to be unique within an
  // actions block. The button's `value` still carries the index — we just
  // route by prefix here. (Same pattern as the key-sell buttons.)
  if (action.action_id.startsWith("dungeon_choose")) return handleChoose(slash, args, env, ctx);
  if (action.action_id.startsWith("dungeon_take")) return handleTake(slash, args, env, ctx);
  if (action.action_id === "shop_buy") return handleBuy(slash, args, env);
  // Staple buys carry the short id in the action_id (e.g. staple_buy_hp).
  // Route through handleBuy with the staple id as the arg.
  if (action.action_id.startsWith("staple_buy_")) {
    const stapleId = action.action_id.slice("staple_buy_".length);
    return handleBuy(slash, [stapleId], env);
  }
  if (action.action_id === "shop_haggle") return handleHaggle(slash, args, env, ctx);
  if (action.action_id === "shop_open") return handleShop(slash, env, ctx);
  // key_sell_* and key_transmute_* use the action_id suffix as a tier marker
  // because action_id must be unique within an actions block. The button's
  // value still carries the tier — we just route by prefix here.
  if (action.action_id.startsWith("key_sell_")) return handleSellKey(slash, args, env);
  if (action.action_id.startsWith("key_transmute_")) return handleTransmuteKey(slash, args, env);
  // Rules buttons. `rules_toc` returns the table-of-contents; any other
  // `rules_<id>` returns that section's content. `_deleteOriginal: false`
  // is the default — we want the new view to REPLACE the old one in place
  // (Slack's response_url default behavior), so the user can hop between
  // TOC ↔ section without the chat growing a new ephemeral each click.
  if (action.action_id === "rules_toc") {
    return rulesResponse(slash.command, botName(env));
  }
  if (action.action_id.startsWith("rules_")) {
    const sectionId = action.action_id.slice("rules_".length);
    return rulesResponse(slash.command, botName(env), sectionId);
  }

  // ===========================================================================
  // TOWN / PUB / LIARS' ROLL interactions
  // ===========================================================================
  // Map of action_id prefixes to handler routes. Pattern follows the rest of
  // the bot — the action_id encodes the route + args, the button's `value`
  // is redundant context (Slack requires it but we don't need to read it).
  if (action.action_id === "town_open") return handleTown(slash, env, ctx);
  if (action.action_id === "town_pub" || action.action_id === "pub_open") return handlePub(slash, env, ctx);
  // Shop-from-town: routes the existing handleShop. Players visit the shop
  // through the town map instead of typing /sq shop separately.
  if (action.action_id === "town_shop") return handleShop(slash, env, ctx);
  // Job Board from town. The board itself is rendered by handleJobBoard;
  // the per-job "Take Job" buttons route through handleJobBoardTake which
  // adapts to handleQuest with the right variant.
  if (action.action_id === "town_board") return handleJobBoard(slash, env, ctx);
  if (action.action_id.startsWith("jobboard_take_")) {
    const jobId = action.action_id.slice("jobboard_take_".length);
    return handleJobBoardTake(slash, [], env, ctx, jobId);
  }
  // Smithy — list + per-item sharpen buttons. action_id format for the
  // per-item button is smithy_sharpen_<inventory_id>.
  if (action.action_id === "town_smithy") return handleSmithy(slash, env, ctx);
  if (action.action_id.startsWith("smithy_sharpen_")) {
    const itemIdStr = action.action_id.slice("smithy_sharpen_".length);
    return handleSmithySharpen(slash, env, ctx, itemIdStr);
  }
  // Inn — room-tier picker; per-tier button uses inn_stay_<room_id>.
  if (action.action_id === "town_inn") return handleInn(slash, env, ctx);
  if (action.action_id.startsWith("inn_stay_")) {
    const roomId = action.action_id.slice("inn_stay_".length);
    return handleInnStay(slash, env, ctx, roomId);
  }
  // (No location stubs left in v1 — every town button routes to a real
  // handler. Kept the prefix-based dispatcher in case future locations
  // ship as stubs first; just no entries today.)
  // Drink buy buttons. action_id format: pub_drink_<drink_id>.
  if (action.action_id.startsWith("pub_drink_")) {
    const drinkId = action.action_id.slice("pub_drink_".length);
    return handlePubDrink(slash, env, ctx, drinkId);
  }
  // NPC dialog buttons. Two formats:
  //   pub_talk_<npc_id>                       → root of the tree
  //   pub_talk_<npc_id>__<path_idx_underscored> → walk to that branch
  // Double-underscore separates the npc_id from the path so npc_ids
  // containing underscores ("regular_1") still parse cleanly.
  if (action.action_id.startsWith("pub_talk_")) {
    const rest = action.action_id.slice("pub_talk_".length);
    const sep = rest.indexOf("__");
    if (sep === -1) {
      // No path → root node.
      return handlePubTalk(slash, env, ctx, rest, "");
    }
    const npcId = rest.slice(0, sep);
    const path = rest.slice(sep + 2).split("_").join(",");
    return handlePubTalk(slash, env, ctx, npcId, path);
  }
  // Stone-Parchment-Dagger routing. Multi-step flow: open → stake →
  // throw → public post → bets → accept → resolve. action_ids encode
  // the step + match_id + parameters so the dispatcher can route
  // without a server-side state machine.
  if (action.action_id === "pub_spd") return handleSpdStart(slash, env, ctx);
  if (action.action_id.startsWith("spd_stake_")) {
    const stake = parseInt(action.action_id.slice("spd_stake_".length), 10);
    if (!Number.isFinite(stake)) return ephemeral("Invalid stake.");
    return handleSpdStakePicked(slash, env, stake);
  }
  if (action.action_id.startsWith("spd_init_")) {
    // Format: spd_init_<stake>_<throw>
    const parts = action.action_id.slice("spd_init_".length).split("_");
    if (parts.length !== 2) return ephemeral("Invalid action.");
    const stake = parseInt(parts[0], 10);
    if (!Number.isFinite(stake)) return ephemeral("Invalid stake.");
    return handleSpdInitCommit(slash, env, ctx, stake, parts[1]);
  }
  if (action.action_id.startsWith("spd_accept_")) {
    const matchId = parseInt(action.action_id.slice("spd_accept_".length), 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdAccept(slash, env, matchId);
  }
  if (action.action_id.startsWith("spd_chall_")) {
    // Format: spd_chall_<matchId>_<throw>
    const parts = action.action_id.slice("spd_chall_".length).split("_");
    if (parts.length !== 2) return ephemeral("Invalid action.");
    const matchId = parseInt(parts[0], 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdChallCommit(slash, env, ctx, matchId, parts[1]);
  }
  if (action.action_id.startsWith("spd_bet_")) {
    const matchId = parseInt(action.action_id.slice("spd_bet_".length), 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdBetPicker(slash, env, matchId);
  }
  if (action.action_id.startsWith("spd_place_")) {
    // Format: spd_place_<matchId>_<side>_<amount>
    const parts = action.action_id.slice("spd_place_".length).split("_");
    if (parts.length !== 3) return ephemeral("Invalid action.");
    const matchId = parseInt(parts[0], 10);
    const side = parts[1];
    const amount = parseInt(parts[2], 10);
    if (!Number.isFinite(matchId) || !Number.isFinite(amount)) return ephemeral("Invalid action.");
    if (side !== "initiator" && side !== "challenger") return ephemeral("Invalid side.");
    return handleSpdBetPlace(slash, env, ctx, matchId, side, amount);
  }
  if (action.action_id.startsWith("spd_cancel_")) {
    const matchId = parseInt(action.action_id.slice("spd_cancel_".length), 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdCancel(slash, env, ctx, matchId);
  }
  if (action.action_id.startsWith("spd_bump_")) {
    const matchId = parseInt(action.action_id.slice("spd_bump_".length), 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdBump(slash, env, ctx, matchId);
  }
  if (action.action_id.startsWith("spd_view_")) {
    const matchId = parseInt(action.action_id.slice("spd_view_".length), 10);
    if (!Number.isFinite(matchId)) return ephemeral("Invalid match.");
    return handleSpdView(slash, env, matchId);
  }

  // Pub games leaderboard — channel-scoped net P/L across all bar games.
  if (action.action_id === "pub_leaderboard") return handlePubLeaderboard(slash, env, ctx);

  // Liars' Roll bluff mini-game routing.
  if (action.action_id === "pub_liars") return handleLiarsStart(slash, env);
  if (action.action_id.startsWith("liars_stake_")) {
    const stake = parseInt(action.action_id.slice("liars_stake_".length), 10);
    if (!Number.isFinite(stake)) return ephemeral("Invalid stake.");
    return handleLiarsStake(slash, env, stake);
  }
  if (action.action_id.startsWith("liars_decide_")) {
    // Format: liars_decide_<round_id>_<trust|challenge>
    const tail = action.action_id.slice("liars_decide_".length);
    const lastUnderscore = tail.lastIndexOf("_");
    if (lastUnderscore === -1) return ephemeral("Invalid decision.");
    const roundId = parseInt(tail.slice(0, lastUnderscore), 10);
    const choice = tail.slice(lastUnderscore + 1) as "trust" | "challenge";
    if (!Number.isFinite(roundId) || !["trust", "challenge"].includes(choice)) {
      return ephemeral("Invalid decision.");
    }
    return handleLiarsDecide(slash, env, roundId, choice);
  }

  // Lobby system buttons: accept/decline invite, ready up, force start.
  // action_id suffix encodes questId so each button is unique within the block.
  if (action.action_id.startsWith("accept_invite_")) {
    const questId = parseInt(action.action_id.slice("accept_invite_".length), 10);
    if (!Number.isFinite(questId)) return ephemeral("Invalid lobby.");
    return handleAcceptInvite(questId, payload, env);
  }
  if (action.action_id.startsWith("decline_invite_")) {
    const questId = parseInt(action.action_id.slice("decline_invite_".length), 10);
    if (!Number.isFinite(questId)) return ephemeral("Invalid lobby.");
    return handleDeclineInvite(questId, payload, env);
  }
  if (action.action_id.startsWith("ready_up_")) {
    const questId = parseInt(action.action_id.slice("ready_up_".length), 10);
    if (!Number.isFinite(questId)) return ephemeral("Invalid lobby.");
    return handleReadyUp(questId, payload, env);
  }
  if (action.action_id.startsWith("force_start_")) {
    const questId = parseInt(action.action_id.slice("force_start_".length), 10);
    if (!Number.isFinite(questId)) return ephemeral("Invalid lobby.");
    return handleForceStart(questId, payload, env);
  }

  return ephemeral(`Unknown action \`${action.action_id}\`.`);
}

export async function handleCommand(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  if (payload.user_name) {
    ctx.waitUntil(upsertSlackUsername(env.DB, payload.user_id, payload.user_name).catch(() => {}));
  }
  const args = payload.text.trim().split(/\s+/).filter(Boolean);
  const sub = (args.shift() ?? "help").toLowerCase();

  switch (sub) {
    case "roll":
      return handleRoll(payload, args, env, ctx);
    case "character":
    case "char":
      return handleCharacterStats(payload, env);
    case "spend":
      return handleSpend(payload, args, env);
    case "me":
    case "sheet":
      return handleMe(payload, env, ctx);
    case "inspect":
    case "view":
      return handleInspect(payload, args, env, ctx);
    case "stats":
    case "record":
      return handleStats(payload, env);
    case "quest":
      return handleQuest(payload, args, env, ctx);
    case "attack":
    case "cast":
    case "flee":
    case "signature":
    case "sig": {
      const combatAction = (sub === "sig" ? "signature" : sub) as CombatAction;
      const targetArg = args[0] && /^\d+$/.test(args[0]) ? args[0] : undefined;
      const combatResult = await handleCombat(payload, env, ctx, combatAction, targetArg);
      return appendForeseeIfActive(combatResult, env, payload.user_id);
    }
    case "ability":
    case "active":
      return handleAbility(payload, args, env, ctx);
    case "mark":
    case "focus":
      return handleMark(payload, env, ctx);
    case "heal":
      return handleHeal(payload, args, env, ctx);
    case "shield":
      return handleShield(payload, env, ctx);
    case "revive":
      return handleRevive(payload, args, env, ctx);
    case "rest":
      return handleRest(payload, args, env);
    case "notify":
      return handleNotifyPref(payload, args, env);
    case "position":
    case "pos":
      return handlePosition(payload, args, env, ctx);
    case "join":
      return handleJoin(payload, env, ctx);
    case "party":
      return handleParty(payload, env);
    case "leaderboard":
    case "lb":
      return handleLeaderboard(payload, env);
    case "inventory":
    case "inv":
    case "i":
    case "bag":
    case "pack":
    case "backpack":
    case "items":
    case "loot":
      return handleInventory(payload, env, ctx);
    case "look":
    case "where":
    case "scene":
      return handleLook(payload, env, ctx);
    case "move":
    case "go":
      return handleGraphMove(payload, args, env, ctx);
    case "equip":
      return handleEquip(payload, args, env);
    case "unequip":
      return handleUnequip(payload, args, env);
    case "use":
      return handleUse(payload, args, env, ctx);
    case "shop":
      return handleShop(payload, env, ctx);
    case "buy":
      return handleBuy(payload, args, env);
    case "haggle":
      return handleHaggle(payload, args, env, ctx);
    case "sell":
      return handleSell(payload, args, env);
    case "sell-key":
    case "sellkey":
      return handleSellKey(payload, args, env);
    case "transmute":
      return handleTransmuteKey(payload, args, env);
    case "give":
      return handleGive(payload, args, env, ctx);
    case "choose":
      return handleChoose(payload, args, env, ctx);
    case "take":
      return handleTake(payload, args, env, ctx);
    case "web-login":
    case "weblogin":
      return handleWebLogin(payload, env);
    case "town":
    case "village":
      return handleTown(payload, env, ctx);
    case "pub":
    case "tavern":
      // Sub-routing: `/sq pub` shows the pub; `/sq pub drink <id>` buys;
      // `/sq pub talk <npc>` opens an NPC chat; `/sq pub liars` starts a game;
      // `/sq pub spd` opens a Stone-Parchment-Dagger match.
      if (args[0] === "drink" && args[1]) return handlePubDrink(payload, env, ctx, args[1]);
      if (args[0] === "talk" && args[1]) return handlePubTalk(payload, env, ctx, args[1], args[2] ?? "");
      if (args[0] === "liars" || args[0] === "dice") return handleLiarsStart(payload, env);
      if (args[0] === "spd" || args[0] === "stone") return handleSpdStart(payload, env, ctx);
      if (args[0] === "lb" || args[0] === "leaderboard") return handlePubLeaderboard(payload, env, ctx);
      return handlePub(payload, env, ctx);
    case "board":
    case "jobs":
    case "jobboard":
      // Sub-routing: `/sq board` shows the board; `/sq board take <id>`
      // accepts a job. The slash form mirrors what the button does.
      if (args[0] === "take" && args[1]) return handleJobBoardTake(payload, args.slice(2), env, ctx, args[1]);
      return handleJobBoard(payload, env, ctx);
    case "smithy":
    case "forge":
      // Sub-routing: `/sq smithy` shows the smithy; `/sq smithy sharpen
      // <id>` does the upgrade in one shot.
      if (args[0] === "sharpen" && args[1]) return handleSmithySharpen(payload, env, ctx, args[1]);
      return handleSmithy(payload, env, ctx);
    case "inn":
    case "lodge":
      // Sub-routing: `/sq inn` shows the rooms; `/sq inn stay <cot|bath>`
      // books a specific room.
      if (args[0] === "stay" && args[1]) return handleInnStay(payload, env, ctx, args[1]);
      return handleInn(payload, env, ctx);
    case "help":
    case "":
      return ephemeral(helpText(payload.command, botName(env)));
    case "rules":
    case "howto":
    case "manual":
      // First positional arg is the optional section name (e.g. `/sq rules
      // combat`). Missing → TOC (rendered as Block Kit buttons for quick
      // navigation; plain-text fallback included for clients that strip
      // blocks).
      return rulesResponse(payload.command, botName(env), args[0]);
    default:
      return ephemeral(`Unknown command: \`${sub}\`. Try \`${payload.command} help\`.`);
  }
}

// Reroll cost: free until your first quest victory (XP > 0), then `level × 50g`
// to swap classes. The fee is a barrier, not a literal deduction — rerolling deletes
// the entire character (gold included) and creates a fresh one with default 10g.
function rerollCostFor(c: Character): number {
  if (c.xp === 0) return 0;
  return c.level * 50;
}

async function rollNewCharacter(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  preamble?: string,
): Promise<CommandResponse> {
  const cls = pickRandomClass();
  const npcName = generateNpcName();
  const hp = cls.base_hp + rollDice(4); // small variance
  // 50/50 m/f at roll time. Drives pronoun consistency in AI flavor and the
  // gender anchor of the per-character portrait. Players don't pick it —
  // reroll for a different outcome.
  const gender: CharGender = rollDice(2) === 1 ? "m" : "f";

  const character = await createCharacter(env.DB, {
    slack_user_id: payload.user_id,
    slack_team_id: payload.team_id,
    name: npcName,
    class: cls.name,
    hp,
    max_hp: hp,
    gender,
  });

  // Kick off per-character portrait generation in the background so that by
  // the time the player views /sq sheet (a few seconds after roll), their
  // unique art is already in R2. Without this, the first sheet view shows
  // the class-singleton fallback — which is identical for any two players
  // of the same class. Pre-warming here means same-class partymates always
  // see their own distinct portrait, not the shared fallback.
  const art = artTargetFromEnv(env);
  if (art) {
    ctx.waitUntil(
      getOrScheduleCharacterArt(env.AI, art, ctx, { name: character.name, class: character.class, gender: character.gender }, cls.id)
        .catch((err) => console.warn("roll:char-art-gen-error", { err: err instanceof Error ? err.message : String(err) })),
    );
  }

  const lines = [
    preamble ?? `🎲 <@${payload.user_id}> rolls a new hero!`,
    ``,
    `*${character.name}*, the ${character.class}`,
    `_${cls.blurb}_`,
    `Level ${character.level} • HP ${character.hp}/${character.max_hp} • ${character.gold} gold`,
  ];
  return inChannel(lines.join("\n"));
}

async function handleRoll(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const existing = await getCharacter(env.DB, payload.user_id);

  // First-ever roll: nothing to reconcile.
  if (!existing) return rollNewCharacter(payload, env, ctx);

  // Reroll requires a clear-headed character — no swapping mid-quest.
  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral(
      `You're on an active quest in <#${activeQuest.channel_id}>. Finish (or die trying) before rerolling.`,
    );
  }

  const cost = rerollCostFor(existing);
  const isFree = cost === 0;
  const confirmed = args[0]?.toLowerCase() === "confirm";

  if (!confirmed) {
    if (isFree) {
      return ephemeral(
        `You already have *${existing.name}* the ${existing.class} (L${existing.level}). Reroll is *free* — you haven't earned XP yet.\n` +
        `Confirm with \`${payload.command} roll confirm\` to delete them and roll a new hero.`,
      );
    }
    return ephemeral(
      `You already have *${existing.name}* the ${existing.class} (L${existing.level}, ${existing.gold}g).\n` +
      `Reroll cost: *${cost}g* (level × 50). Rerolling *deletes* them — gear, gold, scars, signature, all of it.\n` +
      (existing.gold < cost
        ? `You're short ${cost - existing.gold}g. Earn more, then \`${payload.command} roll confirm\`.`
        : `Confirm with \`${payload.command} roll confirm\` to proceed.`),
    );
  }

  // Confirmed reroll — re-validate gold (in case state changed since the warning).
  if (existing.gold < cost) {
    return ephemeral(`Not enough gold to reroll (need ${cost}g, have ${existing.gold}g).`);
  }

  await deleteCharacter(env.DB, payload.user_id);
  const preamble = isFree
    ? `🎲 <@${payload.user_id}> rerolls — *${existing.name}* steps aside for a fresh hero.`
    : `🎲 <@${payload.user_id}> spends ${cost}g to retire *${existing.name}* and roll a new hero.`;
  return rollNewCharacter(payload, env, ctx, preamble);
}

async function handleMe(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  try {
    const c = await getCharacter(env.DB, payload.user_id);
    if (!c) return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);
    const [weapon, armor] = await Promise.all([
      getEquipped(env.DB, payload.user_id, "weapon"),
      getEquipped(env.DB, payload.user_id, "armor"),
    ]);
    // Per-character portrait — unique to this character's name. First /sq sheet
    // for any roll renders the class-singleton fallback while the unique
    // portrait gens in the background; subsequent views show the unique one.
    const charArt = await characterArt(env, ctx, c);
    const text = formatSheet(c, weapon, armor);
    const blocks = buildSheetBlocks(c, weapon, armor, charArt);
    console.log("sheet:built", { user: payload.user_id, class: c.class, charArt: charArt ? "yes" : "no", blockCount: blocks.length });
    return { text, response_type: "ephemeral", blocks };
  } catch (err) {
    console.error("sheet:error", { err: err instanceof Error ? err.stack || err.message : String(err) });
    return ephemeral(`⚠️ Sheet failed to render: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// `/gq character` — ephemeral stat sheet showing primary stats (STR/INT/VIT/AGI/DEX),
// their derived combat values, and how many points are available to spend.
async function handleCharacterStats(
  payload: SlashCommandPayload,
  env: Env,
): Promise<CommandResponse> {
  const c = await getCharacter(env.DB, payload.user_id);
  if (!c) return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);

  const stats: Stats = { str: c.str, int_stat: c.int_stat, vit: c.vit, agi: c.agi, dex: c.dex };
  const derived = deriveAll(stats, c.level);

  const bar = (val: number) => "█".repeat(Math.min(20, val)) + (val > 20 ? "+" : "");
  const statLine = (label: string, val: number) => `*${label}* ${val}  ${bar(val)}`;

  const lines = [
    `*${c.name}* — ${c.class} (Level ${c.level})`,
    ``,
    statLine("STR", c.str),
    statLine("INT", c.int_stat),
    statLine("VIT", c.vit),
    statLine("AGI", c.agi),
    statLine("DEX", c.dex),
    ``,
    `_Derived:_ atk +${derived.attack_mod}  mag +${derived.magic_mod}  max HP ${derived.max_hp}  dodge ${Math.round(derived.dodge_chance * 100)}%  crit+${Math.round(derived.crit_bonus * 100)}%  init+${derived.initiative_bonus}`,
  ];

  if (c.unspent_points > 0) {
    lines.push(``, `✨ *${c.unspent_points} unspent point${c.unspent_points > 1 ? "s" : ""}* — spend with \`${payload.command} spend <str|int|vit|agi|dex>\``);
  }

  return ephemeral(lines.join("\n"));
}

// `/gq spend <stat>` — spends 1 unspent point on the chosen stat.
async function handleSpend(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const VALID_STATS: Record<string, StatKey> = {
    str: "str", strength: "str",
    int: "int_stat", int_stat: "int_stat", intelligence: "int_stat",
    vit: "vit", vitality: "vit",
    agi: "agi", agility: "agi",
    dex: "dex", dexterity: "dex",
  };
  const raw = (args[0] ?? "").toLowerCase();
  const stat = VALID_STATS[raw];
  if (!stat) {
    return ephemeral(
      `Usage: \`${payload.command} spend <str|int|vit|agi|dex>\`. Choose a stat to invest your free point.`,
    );
  }

  const updated = await spendStatPoint(env.DB, payload.user_id, stat);
  if (!updated) {
    const c = await getCharacter(env.DB, payload.user_id);
    if (!c) return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);
    return ephemeral(`No unspent points. You'll earn one per level — next at ${c.level + 1}.`);
  }

  const statLabels: Record<StatKey, string> = {
    str: "STR", int_stat: "INT", vit: "VIT", agi: "AGI", dex: "DEX",
  };
  const newVal = updated[stat];
  const label = statLabels[stat];
  const remainingMsg = updated.unspent_points > 0
    ? ` (${updated.unspent_points} left)`
    : "";
  return ephemeral(`✨ *${label}* raised to *${newVal}*${remainingMsg}. Use \`${payload.command} character\` to see your full stats.`);
}

// Resolves a per-character portrait URL — unique per character name, with the
// class-singleton banner as a fallback while the unique gen runs in the
// background. Returns null when art isn't configured (no IMAGE_BASE_URL).
async function characterArt(
  env: Env,
  ctx: ExecutionContext,
  c: Character,
): Promise<string | null> {
  const target = artTargetFromEnv(env);
  if (!target) return null;
  const classId = classByName(c.class).id;
  return getOrScheduleCharacterArt(env.AI, target, ctx, { name: c.name, class: c.class, gender: c.gender }, classId);
}

// Lifetime track record across every quest the user has been part of. Reads
// from quest_log + quest_party — no new schema. Block Kit layout splits into
// quest tally, combat aggregates, and a deaths/revives line.
async function handleStats(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  try {
    return await handleStatsInner(payload, env);
  } catch (err) {
    console.error("stats:error", { err: err instanceof Error ? err.stack || err.message : String(err) });
    return ephemeral(`⚠️ Stats failed to render: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatsInner(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) {
    return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);
  }
  const stats = await getLifetimeStats(env.DB, payload.user_id);
  const totalQuests = stats.quests_completed + stats.quests_failed + stats.quests_active;
  const winRate = totalQuests > 0
    ? Math.round((stats.quests_completed / Math.max(1, stats.quests_completed + stats.quests_failed)) * 100)
    : 0;

  const variantParts: string[] = [];
  if (stats.by_variant.standard > 0) variantParts.push(`⚔️ ${stats.by_variant.standard} standard`);
  if (stats.by_variant.boss > 0) variantParts.push(`👑 ${stats.by_variant.boss} boss`);
  if (stats.by_variant.dungeon > 0) variantParts.push(`🗺️ ${stats.by_variant.dungeon} dungeon`);
  if (stats.by_variant.gauntlet > 0) variantParts.push(`🌪️ ${stats.by_variant.gauntlet} gauntlet`);
  const variantLine = variantParts.length > 0 ? variantParts.join("  •  ") : "_no quests yet_";

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📊 ${character.name}'s Record` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*🏆 Quests Won*\n${stats.quests_completed}` },
        { type: "mrkdwn", text: `*☠️ Quests Lost*\n${stats.quests_failed}` },
        { type: "mrkdwn", text: `*⚖️ Win Rate*\n${winRate}%` },
        { type: "mrkdwn", text: `*🎯 Total Played*\n${totalQuests}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*By variant:* ${variantLine}` } },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*💥 Damage Dealt*\n${stats.damage_dealt.toLocaleString()}` },
        { type: "mrkdwn", text: `*🩸 Killing Blows*\n${stats.kills}` },
        { type: "mrkdwn", text: `*💚 Healing Done*\n${stats.healing_done.toLocaleString()}` },
        { type: "mrkdwn", text: `*🛡️ Shielding Done*\n${stats.shielding_done.toLocaleString()}` },
      ],
    },
  ];

  // Deaths + revives row only when there's something to show — keeps the
  // card terse for fresh players whose record is mostly zeros.
  const ledger: string[] = [];
  if (stats.deaths_soft > 0) ledger.push(`💀 *${stats.deaths_soft}* downed`);
  if (stats.deaths_perma > 0) ledger.push(`☠️ *${stats.deaths_perma}* perma-deaths`);
  if (stats.revives > 0) ledger.push(`🌟 *${stats.revives}* revives given`);
  if (ledger.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: ledger.join("  •  ") } });
  }

  // Plain-text fallback for clients that don't render Block Kit.
  const fallback = [
    `📊 ${character.name}'s record`,
    `Quests: ${stats.quests_completed}W / ${stats.quests_failed}L (${winRate}% win rate over ${totalQuests} played)`,
    `Damage: ${stats.damage_dealt.toLocaleString()}  •  Kills: ${stats.kills}  •  Healing: ${stats.healing_done.toLocaleString()}  •  Shielding: ${stats.shielding_done.toLocaleString()}`,
    ...(ledger.length > 0 ? [ledger.join(", ")] : []),
  ].join("\n");

  return { text: fallback, response_type: "ephemeral", blocks };
}

// /sq inspect @user — view another player's public sheet. Same shape as /sq me
// but without the [Inventory] action button (you can't see someone else's pack)
// and explicitly tagged with their @mention so it's clear whose stats you're
// looking at. Ephemeral — only the requester sees it.
async function handleInspect(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const targetId = parseMention(args.join(" "));
  if (!targetId) {
    return ephemeral(`Usage: \`${payload.command} inspect @user\`.`);
  }
  const target = await getCharacter(env.DB, targetId);
  if (!target) {
    return ephemeral(`<@${targetId}> hasn't rolled a character.`);
  }
  const [weapon, armor] = await Promise.all([
    getEquipped(env.DB, targetId, "weapon"),
    getEquipped(env.DB, targetId, "armor"),
  ]);
  // Same per-character art as /sq me. If you're the first to view this
  // character's sheet, the unique-portrait gen kicks off in the background
  // and the class-singleton fallback renders immediately.
  const charArt = await characterArt(env, ctx, target);
  const text = `Inspecting <@${targetId}>:\n${formatSheet(target, weapon, armor)}`;
  // Reuse buildSheetBlocks but strip the trailing actions block (no [Inventory]
  // button on someone else's sheet) and prepend a header noting who you're
  // looking at.
  const sheetBlocks = buildSheetBlocks(target, weapon, armor, charArt).filter(
    (b) => (b as { type?: string }).type !== "actions",
  );
  const blocks: unknown[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_Inspecting <@${targetId}>'s public sheet._` }],
    },
    ...sheetBlocks,
  ];
  return { text, response_type: "ephemeral", blocks };
}

// Sectioned Block Kit layout for /sq me. Sections (with dividers between):
//   0. Class portrait (when classArt URL provided — pre-resolved by caller)
//   1. Header: name + class
//   2. Vitals: level, xp, position, HP, mana, gold, shield (if any)
//   3. Equipped: weapon + armor
//   4. Signature: class signature ability
//   5. Keys: tiered dungeon keys (only shown if non-zero)
//   6. Scars / downed status (only shown if applicable)
//   7. Actions: [🎒 Inventory] button
//
// `classArt` is an optional pre-resolved URL (lazy-cached in R2 via viewArt).
// When null, the portrait block is omitted — matches the same first-render
// fallback we use for the singleton banners.
function buildSheetBlocks(
  c: Character,
  weapon: Item | null,
  armor: Item | null,
  classArt: string | null = null,
): unknown[] {
  const blocks: unknown[] = [];

  // 0. Class portrait (optional)
  if (classArt) {
    blocks.push({
      type: "image",
      image_url: classArt,
      alt_text: c.class,
    });
  }

  // 1. Header
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*${c.name}*, the *${c.class}*` },
  });

  // 2. Vitals — 2-row fields layout for compact density. Slack fields render
  // as a 2-col grid; first row is one combined line for cleaner mobile reading.
  const shieldNote = c.shield > 0 ? `  •  🛡️ ${c.shield}` : "";
  const vitalsLines = [
    `🎚️ *Level ${c.level}*  •  ✨ ${c.xp} XP  •  ${positionEmoji(c.position)} ${c.position}`,
    `❤️ *${c.hp}/${c.max_hp}* HP  •  🔮 *${c.mana}/${c.max_mana}* mana  •  💰 *${c.gold}* gold${shieldNote}`,
  ];
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: vitalsLines.join("\n") },
  });

  // 3. Equipped
  blocks.push({ type: "divider" });
  const equipLines: string[] = ["*⚔️ Equipped*"];
  if (weapon) {
    const wIcon = weapon.weapon_range === "ranged" ? "🏹" : weapon.weapon_range === "focus" ? "🔮" : "⚔️";
    equipLines.push(`${wIcon} *${weapon.item_name}* (+${weapon.power})`);
  } else {
    equipLines.push("⚔️ _no weapon_");
  }
  if (armor) {
    equipLines.push(`🛡️ *${armor.item_name}* (+${armor.power})`);
  } else {
    equipLines.push("🛡️ _no armor_");
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: equipLines.join("\n") } });

  // 4. Signature
  const sig = signatureFor(c.class);
  if (sig) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*✨ Signature — ${sig.name}*\n_${sig.blurb}_`,
      },
    });
  }

  // 4b. Class passive
  const passive = passiveFor(c.class);
  if (passive) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🌟 Passive — ${passive.name}*\n_${passive.blurb}_`,
      },
    });
  }

  // 4c. Class active ability — mana-costed lever players invoke with
  // `/sq ability`. Shows mana cost so the player can plan around their pool.
  const ability = abilityFor(c.class);
  if (ability) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⚡ Ability — ${ability.name}* _(${ability.mana_cost}m)_\n_${ability.blurb}_`,
      },
    });
  }

  // 5. Keys (only if any held)
  const keyDisplay = characterKeyDisplay(c);
  if (keyDisplay) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🗝️ Keys*\n${keyDisplay}` },
    });
  }

  // 5b. Active status effects (only if any are present)
  if (c.effects && c.effects.length > 0) {
    blocks.push({ type: "divider" });
    const effectLines = c.effects.map((e) => {
      const meta = EFFECT_META[e.type];
      if (!meta) return `❓ unknown ${e.remaining}`;
      const sign = meta.kind === "buff" ? "+" : "-";
      return `${meta.emoji} *${meta.name}* — ${sign}${e.magnitude} HP/action, *${e.remaining}* action${e.remaining !== 1 ? "s" : ""} left`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*✨ Active Effects*\n${effectLines.join("\n")}` },
    });
  }

  // 6. Scars + downed status
  const statusLines: string[] = [];
  if (c.scars.length > 0) {
    statusLines.push(`🩹 *Scars:* ${c.scars.join(", ")}`);
  }
  if (c.downed_until && c.downed_until > Date.now()) {
    statusLines.push(`💀 *Downed* until <!date^${Math.floor(c.downed_until / 1000)}^{date_short_pretty} {time}|soon>`);
  }
  if (statusLines.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: statusLines.join("\n") } });
  }

  // 7. Actions
  blocks.push({
    type: "actions",
    block_id: "me_actions",
    elements: [
      {
        type: "button",
        action_id: "inventory",
        value: "open",
        text: { type: "plain_text", text: "🎒 Inventory" },
      },
    ],
  });

  return blocks;
}

function formatSheet(c: Character, weapon: Item | null, armor: Item | null): string {
  const downedNote = c.downed_until && c.downed_until > Date.now()
    ? `\n💀 _Downed until <!date^${Math.floor(c.downed_until / 1000)}^{date_short_pretty} {time}|soon>_`
    : "";
  const scarLine = c.scars.length ? `\nScars: ${c.scars.join(", ")}` : "";
  const sig = signatureFor(c.class);
  const sigLine = sig ? `\nSignature: *${sig.name}* — _${sig.blurb}_` : "";
  const passive = passiveFor(c.class);
  const passiveLine = passive ? `\nPassive: *${passive.name}* — _${passive.blurb}_` : "";
  // Active ability — separate from the damage signature. Costs mana, 45s
  // cooldown shared with combat actions. Listed alongside the other class
  // levers so /sq sheet shows the full kit at a glance.
  const ability = abilityFor(c.class);
  const abilityLine = ability ? `\nAbility: *${ability.name}* (${ability.mana_cost}m) — _${ability.blurb}_` : "";

  // Equipment line. Shows whichever slots are filled; blank if neither.
  // Weapon emoji reflects melee (⚔️) vs ranged (🏹).
  const equipParts: string[] = [];
  if (weapon) {
    const wIcon = weapon.weapon_range === "ranged" ? "🏹" : weapon.weapon_range === "focus" ? "🔮" : "⚔️";
    equipParts.push(`${wIcon} *${weapon.item_name}* +${weapon.power}`);
  }
  if (armor) equipParts.push(`🛡️ *${armor.item_name}* +${armor.power}`);
  const equipLine = equipParts.length > 0
    ? `\nEquipped: ${equipParts.join(" • ")}`
    : `\nEquipped: _nothing_`;

  const keyDisplay = characterKeyDisplay(c);
  const keyLine = keyDisplay ? `\nKeys: ${keyDisplay}` : "";

  return [
    `*${c.name}*, the ${c.class}`,
    `Level ${c.level} • XP ${c.xp} • ${positionEmoji(c.position)} ${c.position}`,
    `HP ${c.hp}/${c.max_hp} • Mana ${c.mana}/${c.max_mana} • ${c.gold} gold`,
    `${equipLine}${sigLine}${passiveLine}${abilityLine}${keyLine}${scarLine}${downedNote}`,
  ].filter(Boolean).join("\n");
}

async function handleQuest(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
  // When non-null, this quest was accepted from the Job Board. Two effects:
  //   1. `seedName` is forced as the monster name (standard/boss only — the
  //      board posting becomes a real promise instead of marketing flavor).
  //      Dungeons run their normal sub-boss flow; the seed flavor lives on
  //      the board card but doesn't override the room generator.
  //   2. The quest scene is marked `from_job_board: true`, which
  //      resolveVictory honors with a small reward multiplier bump.
  fromJobBoard?: { seedName: string },
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  if (character.downed_until && character.downed_until > Date.now()) {
    return ephemeral(`You are *downed* and recovering. Try again later.`);
  }

  const active = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (active) {
    return ephemeral(
      `You're already on a quest in <#${active.channel_id}>. Finish it (or die trying) before starting another.`,
    );
  }
  const inLobby = await getLobbyQuestForCharacter(env.DB, payload.user_id);
  if (inLobby) {
    return ephemeral(
      `You're already in a quest lobby. Ready up or wait for it to start.`,
    );
  }

  const lower = args.map((a) => a.toLowerCase());
  const elite = lower.includes("elite");
  const variant: QuestVariant = lower.includes("boss")
    ? "boss"
    : lower.includes("gauntlet")
    ? "gauntlet"
    : lower.includes("dungeon") || lower.includes("expedition")
    ? "dungeon"
    : "standard";

  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return ephemeral(`Boss quests require Level ${BOSS_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return ephemeral(`Gauntlets require Level ${GAUNTLET_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }
  if (variant === "dungeon" && character.level < EXPEDITION_LEVEL_REQUIRED) {
    return ephemeral(`Dungeons require Level ${EXPEDITION_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }

  // Optional invitees: any @ mentions in the slash text auto-join at quest start.
  // Mentions of the inviter themselves are filtered out (they're already in).
  const invitedIds = parseMentions(args.join(" ")).filter((id) => id !== payload.user_id);

  ctx.waitUntil((async () => {
    try {
      const recentNames = await getRecentMonsterNames(env.DB, payload.channel_id, 5);
      const baseScene = await buildQuestScene(
        env, character, elite, variant, recentNames,
        fromJobBoard ? { name: fromJobBoard.seedName } : undefined,
      );

      // Validate each invitee: must have a character, not be downed, and not
      // already on another active quest or lobby. Rejections surface in the
      // lobby post so the creator sees why an invite bounced.
      type Reject = { id: string; name: string; reason: string };
      const validInvitees: Character[] = [];
      const rejects: Reject[] = [];
      for (const id of invitedIds) {
        const c = await getCharacter(env.DB, id);
        if (!c) {
          rejects.push({ id, name: `<@${id}>`, reason: "no character" });
          continue;
        }
        if (!isFighter(c)) {
          rejects.push({ id, name: c.name, reason: "downed" });
          continue;
        }
        const existingActive = await getActiveQuestForCharacter(env.DB, id);
        if (existingActive) {
          rejects.push({ id, name: c.name, reason: "already on a quest" });
          continue;
        }
        const existingLobby = await getLobbyQuestForCharacter(env.DB, id);
        if (existingLobby) {
          rejects.push({ id, name: c.name, reason: "already in a lobby" });
          continue;
        }
        validInvitees.push(c);
      }

      // Store the scene as-is; HP scaling happens at lobby start once the
      // final party is known. Tag job-board origin now so startQuestFromLobby
      // can honour the reward multiplier later.
      const scene: SceneJson = fromJobBoard ? { ...baseScene, from_job_board: true } : baseScene;

      // Post the lobby anchor message in the channel. The thread_ts from
      // this message becomes the quest's home thread.
      const lobbyExpiresAt = Date.now() + 5 * 60 * 1000;
      const variantLabel =
        variant === "boss" ? "👑 Boss Quest"
        : variant === "gauntlet" ? "⚔️ Gauntlet"
        : variant === "dungeon" ? "🗺️ Dungeon"
        : "⚔️ Quest";
      const elitePrefix = elite ? "⚠️ *ELITE* — " : "";
      const lobbyText = `${elitePrefix}${variantLabel} lobby started by <@${payload.user_id}>.`;

      const post = await postMessage(env.SLACK_BOT_TOKEN, {
        channel: payload.channel_id,
        text: lobbyText,
      });

      if (!post.ok || !post.ts) {
        await respondToCommand(payload.response_url, {
          response_type: "ephemeral",
          text: `Failed to start the lobby: ${post.error ?? "unknown Slack error"}`,
        });
        return;
      }

      // Create quest in lobby status. HP scaling deferred to startQuestFromLobby.
      const questId = await createQuest(env.DB, {
        channel_id: payload.channel_id,
        thread_ts: post.ts,
        elite,
        scene,
        mode: "slack",
        created_by: payload.user_id,
        lobby: true,
        lobby_expires_at: lobbyExpiresAt,
      });

      // Add valid invitees as pending party members.
      for (const inv of validInvitees) {
        await addPendingInvitee(env.DB, questId, inv.slack_user_id);
      }

      // Build and post the full lobby block kit message as a thread reply.
      // This is the interactive card players use to accept/ready up.
      const initialParty = await getLobbyParty(env.DB, questId);
      const rejectLine = rejects.length > 0
        ? `\n⚠️ Couldn't invite: ${rejects.map((r) => `*${r.name}* (${r.reason})`).join(", ")}`
        : "";
      const { text: lobbyBodyText, blocks: lobbyBodyBlocks } = buildLobbyContent(
        questId, scene, initialParty, payload.user_id, rejectLine, lobbyExpiresAt, payload.command,
      );
      const lobbyPost = await postMessage(env.SLACK_BOT_TOKEN, {
        channel: payload.channel_id,
        thread_ts: post.ts,
        text: lobbyBodyText,
        blocks: lobbyBodyBlocks,
      });
      if (lobbyPost.ok && lobbyPost.ts) {
        await setLobbyTs(env.DB, questId, lobbyPost.ts);
      }

      // Schedule the 5-minute auto-start alarm via the LobbyManager DO.
      await scheduleLobbyAlarm(
        env, questId, lobbyExpiresAt, payload.channel_id, post.ts, lobbyPost.ts ?? null,
      );
    } catch (err) {
      await respondToCommand(payload.response_url, {
        response_type: "ephemeral",
        text: `The narrator stumbled: ${(err as Error).message}`,
      });
    }
  })());

  return ephemeral("⏳ Quest lobby created — accept the invite and ready up!");
}

// ─── Lobby system ─────────────────────────────────────────────────────────────

const LOBBY_TIMEOUT_MS = 5 * 60 * 1000;

function lobbyStatusEmoji(member: LobbyPartyMember): string {
  if (member.invite_status === "pending") return "✉️";
  if (member.invite_status === "declined") return "❌";
  return member.ready ? "🟢" : "⏳";
}

function lobbyStatusLabel(member: LobbyPartyMember): string {
  if (member.invite_status === "pending") return "Invite pending";
  if (member.invite_status === "declined") return "Declined";
  return member.ready ? "Ready" : "Not ready";
}

// Builds the lobby card text + blocks for a quest. Called on creation and
// after every lobby state change (accept/decline/ready/force-start).
function buildLobbyContent(
  questId: number,
  scene: SceneJson,
  party: LobbyPartyMember[],
  creatorId: string,
  rejectLine: string,
  expiresAt: number,
  cmd: string,
): { text: string; blocks: unknown[] } {
  const variantLabel =
    scene.variant === "boss" ? "👑 Boss Quest"
    : scene.variant === "gauntlet" ? "⚔️ Gauntlet"
    : scene.variant === "dungeon" ? "🗺️ Dungeon"
    : "⚔️ Quest";

  const rosterLines = party.map(
    (m) => `• <@${m.slack_user_id}>  ${lobbyStatusEmoji(m)}  _${lobbyStatusLabel(m)}_`,
  );
  const minutesLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  const footerNote = `Quest content will be revealed once everyone readies up. Auto-starts in ~${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`;

  const text = [
    `*${variantLabel} Lobby*`,
    ``,
    ...rosterLines,
    ``,
    footerNote,
    rejectLine,
  ].filter(Boolean).join("\n");

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Accept Invite", emoji: true },
          action_id: `accept_invite_${questId}`,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Decline", emoji: true },
          action_id: `decline_invite_${questId}`,
          style: "danger",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Ready Up", emoji: true },
          action_id: `ready_up_${questId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "▶ Force Start", emoji: true },
          action_id: `force_start_${questId}`,
        },
      ],
    },
  ];

  return { text, blocks };
}

// Posts the full opening content once a lobby transitions to active.
// Mirrors the body of the old synchronous quest-start, but reads the
// already-generated scene from D1 and scales HP for the final party.
export async function startQuestFromLobby(
  questId: number,
  channelId: string,
  threadTs: string,
  lobbyTs: string | null,
  env: Env,
): Promise<void> {
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return; // already started or doesn't exist

  const party = await getLobbyParty(env.DB, questId);
  const accepted = party.filter((m) => m.invite_status === "accepted");

  // Drop pending invitees and activate. Declined members were never full
  // party members so their quest_party row was never used for HP scaling.
  await removePendingInvitees(env.DB, questId);
  await activateQuest(env.DB, questId);

  // HP scaling: pre-scale for accepted joiners beyond the creator.
  const joinerCount = Math.max(0, accepted.length - 1);
  const scene = preScaleForJoiners(quest.scene, joinerCount, JOIN_HP_RATIO);
  const packedScene = joinerCount > 0 ? addPackMonstersForParty(scene, accepted.length) : scene;
  // Roll whether the primary monster starts with armor (legacy Slack path).
  // Engine path rolls this in buildInitialCombatState; storing it here keeps
  // the two paths consistent across the same quest.
  const finalScene = { ...packedScene, monster_armor: rollMonsterShield(packedScene.tier) };
  await saveScene(env.DB, questId, finalScene);

  // Mana refill + armor pool init + log for every accepted member.
  for (const m of accepted) {
    await refillMana(env.DB, m.slack_user_id);
    await initArmorPool(env.DB, m.slack_user_id);
    await appendLog(env.DB, questId, m.slack_user_id, "join", "lobby started");
  }

  // Cancel the LobbyManager alarm (no-op if already fired).
  await cancelLobbyAlarm(env, questId);

  // Update the lobby card to show "Quest started!" and remove buttons.
  if (lobbyTs && env.SLACK_BOT_TOKEN) {
    await updateMessage(env.SLACK_BOT_TOKEN, {
      channel: channelId,
      ts: lobbyTs,
      text: "✅ *Quest started!* Everyone is in.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "✅ *Quest started!* Everyone is in." },
        },
      ],
    });
  }

  // Post the actual quest opening in the thread.
  const eliteBanner = quest.elite ? "⚠️ *ELITE — perma-death enabled* ⚠️\n" : "";
  const variantBanner =
    finalScene.variant === "boss"
      ? "👑 *BOSS QUEST*\n"
      : finalScene.variant === "gauntlet"
      ? `⚔️ *GAUNTLET — ${GAUNTLET_WAVES} waves, no flee*\n`
      : finalScene.variant === "dungeon"
      ? `🗺️ *DUNGEON — ${dungeonRoomTotal(finalScene.expedition?.middle_count ?? 4)} rooms, treasure at the end*\n`
      : "";

  const partyMentions = accepted.map((m) => `<@${m.slack_user_id}>`).join(", ");
  const partyLine = accepted.length > 1 ? `\n👥 *Party:* ${partyMentions}` : "";

  const isExpedition = finalScene.variant === "dungeon" && finalScene.expedition;
  const body = isExpedition
    ? [
        `*Theme:* ${finalScene.expedition!.theme}`,
        ``,
        renderDungeonRoom(finalScene.expedition!.nodes[0], finalScene.expedition!, "/sq"),
      ].join("\n")
    : [
        `_${finalScene.scene}_`,
        ``,
        `Foe: *${finalScene.monster_name}* — HP ${finalScene.monster_hp}${finalScene.variant === "gauntlet" ? ` (wave 1/${GAUNTLET_WAVES})` : ""}`,
      ].join("\n");

  const openingText = [
    `${eliteBanner}${variantBanner}*The quest begins.* ${partyMentions}.${partyLine}`,
    ``,
    body,
  ].join("\n");

  const openingBlocks: unknown[] = [];
  if (finalScene.monster_art_url) {
    openingBlocks.push({
      type: "image",
      image_url: finalScene.monster_art_url,
      alt_text: finalScene.monster_name,
    });
  }
  openingBlocks.push({
    type: "section",
    text: { type: "mrkdwn", text: openingText },
  });

  if (env.SLACK_BOT_TOKEN) {
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel: channelId,
      thread_ts: threadTs,
      text: openingText,
      blocks: openingBlocks.length > 1 ? openingBlocks : undefined,
    });
  }

  // Post a public recruitment card for non-elite quests so latecomers can join.
  if (!quest.elite) {
    const joinCard = await postJoinableQuest(env.SLACK_BOT_TOKEN, {
      channel: channelId,
      questId,
      variant: finalScene.variant ?? "standard",
      monsterName: finalScene.monster_name,
      monsterMaxHp: finalScene.monster_max_hp,
      createdByUserId: quest.created_by,
      partySize: accepted.length,
      webBaseUrl: env.WEB_BASE_URL,
    });
    if (joinCard.ok && joinCard.ts) {
      await setJoinableTs(env.DB, questId, joinCard.ts);
    }
  }
}

// Updates the lobby card in-place after any state change.
async function refreshLobbyCard(
  questId: number,
  channelId: string,
  quest: LobbyQuest,
  creatorId: string,
  env: Env,
): Promise<void> {
  if (!quest.lobby_ts || !env.SLACK_BOT_TOKEN) return;
  const party = await getLobbyParty(env.DB, questId);
  const { text, blocks } = buildLobbyContent(
    questId, quest.scene, party, creatorId, "", quest.lobby_expires_at ?? Date.now() + LOBBY_TIMEOUT_MS, "/sq",
  );
  await updateMessage(env.SLACK_BOT_TOKEN, { channel: channelId, ts: quest.lobby_ts, text, blocks });
}

// Checks whether all accepted members are ready; if so, starts the quest.
async function maybeAutoStart(
  questId: number,
  channelId: string,
  threadTs: string,
  lobbyTs: string | null,
  env: Env,
): Promise<boolean> {
  const party = await getLobbyParty(env.DB, questId);
  const accepted = party.filter((m) => m.invite_status === "accepted");
  if (accepted.length > 0 && accepted.every((m) => m.ready)) {
    await startQuestFromLobby(questId, channelId, threadTs, lobbyTs, env);
    return true;
  }
  return false;
}

async function handleAcceptInvite(
  questId: number,
  payload: InteractivePayload,
  env: Env,
): Promise<CommandResponse> {
  const userId = payload.user.id;
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return ephemeral("This lobby is no longer active.");

  const party = await getLobbyParty(env.DB, questId);
  const member = party.find((m) => m.slack_user_id === userId);
  if (!member) return ephemeral("You weren't invited to this lobby.");
  if (member.invite_status !== "pending") {
    return ephemeral(`You already ${member.invite_status === "accepted" ? "accepted" : "declined"} this invite.`);
  }

  await updateInviteStatus(env.DB, questId, userId, "accepted");
  await refreshLobbyCard(questId, quest.channel_id, quest, quest.created_by, env);

  const started = await maybeAutoStart(
    questId, quest.channel_id, quest.thread_ts, quest.lobby_ts, env,
  );
  if (started) return { response_type: "ephemeral", text: "✅ Quest started!", _deleteOriginal: false };
  return ephemeral("✅ You joined the lobby! Click *Ready Up* when you're set.");
}

async function handleDeclineInvite(
  questId: number,
  payload: InteractivePayload,
  env: Env,
): Promise<CommandResponse> {
  const userId = payload.user.id;
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return ephemeral("This lobby is no longer active.");

  const party = await getLobbyParty(env.DB, questId);
  const member = party.find((m) => m.slack_user_id === userId);
  if (!member || member.invite_status !== "pending") {
    return ephemeral("Nothing to decline.");
  }

  await updateInviteStatus(env.DB, questId, userId, "declined");
  await refreshLobbyCard(questId, quest.channel_id, quest, quest.created_by, env);
  return ephemeral("Invite declined.");
}

async function handleReadyUp(
  questId: number,
  payload: InteractivePayload,
  env: Env,
): Promise<CommandResponse> {
  const userId = payload.user.id;
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return ephemeral("This lobby is no longer active.");

  const party = await getLobbyParty(env.DB, questId);
  const member = party.find((m) => m.slack_user_id === userId);
  if (!member) {
    return ephemeral("You're not in this lobby. Accept the invite first.");
  }
  if (member.invite_status !== "accepted") {
    return ephemeral("Accept the invite before readying up.");
  }
  if (member.ready) return ephemeral("You're already marked as ready.");

  await updateReadyStatus(env.DB, questId, userId, true);
  await refreshLobbyCard(questId, quest.channel_id, quest, quest.created_by, env);

  const started = await maybeAutoStart(
    questId, quest.channel_id, quest.thread_ts, quest.lobby_ts, env,
  );
  if (started) return { response_type: "ephemeral", text: "🚀 Everyone's ready — quest started!", _deleteOriginal: false };
  return ephemeral("🟢 You're ready! Waiting for others…");
}

async function handleForceStart(
  questId: number,
  payload: InteractivePayload,
  env: Env,
): Promise<CommandResponse> {
  const userId = payload.user.id;
  const quest = await getLobbyQuestById(env.DB, questId);
  if (!quest) return ephemeral("This lobby is no longer active.");
  if (quest.created_by !== userId) {
    return ephemeral("Only the quest creator can force start.");
  }
  await startQuestFromLobby(questId, quest.channel_id, quest.thread_ts, quest.lobby_ts, env);
  return { response_type: "ephemeral", text: "▶ Quest force-started!", _deleteOriginal: false };
}

// Returns an ephemeral "quest hasn't started" message if the user is an
// accepted member of a lobby quest, or null if they are not.
async function lobbyGuard(db: D1Database, userId: string): Promise<CommandResponse | null> {
  const lobby = await getLobbyQuestForCharacter(db, userId);
  if (!lobby) return null;
  return ephemeral("⏳ Your quest hasn't started yet — waiting for the lobby to ready up.");
}

// ─── End lobby system ─────────────────────────────────────────────────────────

// Builds the SceneJson for a new quest, with variant-specific shape:
//   standard   → existing behavior
//   boss       → bigger HP envelope, boss_phase=1
//   gauntlet   → first wave inline, remaining waves pre-generated and queued
async function buildQuestScene(
  env: Env,
  character: Character,
  elite: boolean,
  variant: QuestVariant,
  recentNames: string[] = [],
  // Optional Job-Board-driven seed. `name` overrides the monster name on
  // standard/boss/gauntlet (the AI's identity step is bypassed). For
  // dungeons it'd flow into the theme — not wired in v1 to keep the
  // dungeon path stable, so a dungeon job's title becomes flavor only.
  seed?: { name?: string },
): Promise<SceneJson> {
  const art = artTargetFromEnv(env);
  if (variant === "boss") {
    const scene = await generateOpeningScene(env.AI, character, elite, "boss", undefined, recentNames, art, seed?.name);
    return { ...scene, variant, boss_phase: 1 };
  }

  if (variant === "gauntlet") {
    // Generate all waves IN PARALLEL. Sequential generation made the 2-step
    // identity+scene flow add up to 6+ AI calls in series, which timed out the
    // build. Each wave gets the same channel-recent avoid-list; intra-gauntlet
    // name collisions are possible but rare enough to accept for the speed win.
    const wavePromises = [];
    for (let i = 1; i <= GAUNTLET_WAVES; i++) {
      wavePromises.push(
        generateOpeningScene(env.AI, character, elite, "gauntlet-wave", {
          wave: i,
          total: GAUNTLET_WAVES,
        }, recentNames, art),
      );
    }
    const waves = await Promise.all(wavePromises);
    const first = waves[0];
    // Persist each upcoming wave's art URL alongside its name/hp/scene so it
    // can be promoted to the top-level scene when the wave activates.
    const queue: GauntletWave[] = waves.slice(1).map((w) => ({
      name: w.monster_name,
      max_hp: w.monster_max_hp,
      scene: w.scene,
      art_url: w.monster_art_url,
    }));
    return {
      ...first,
      variant,
      wave: 1,
      total_waves: GAUNTLET_WAVES,
      upcoming_waves: queue,
    };
  }

  if (variant === "dungeon") {
    if (env.DUNGEON_GRAPH === "1") {
      return buildGraphDungeonScene(env, character, elite, recentNames);
    }
    return buildDungeonScene(env, character, elite, variant, recentNames);
  }

  return { ...(await generateOpeningScene(env.AI, character, elite, "standard", undefined, recentNames, art, seed?.name)), variant };
}

// Generates a fresh dungeon. Layout:
//   - Player enters at index 0: a combat room that drops a key (guaranteed).
//   - Middle rooms after that come from a pool 2× the visited count. At each
//     transition the bot presents 2 unvisited rooms as doors; player picks one,
//     the other is discarded.
//   - Last 2 indices in nodes[] are always sub-boss + treasure (auto-advanced;
//     no door choice).
// All combat rooms drop a key (not just the first), which feeds the auto-unlock
// mechanic for lockboxes the party walked past.
async function buildDungeonScene(
  env: Env,
  character: Character,
  elite: boolean,
  variant: QuestVariant,
  recentNames: string[] = [],
): Promise<SceneJson> {
  const theme = await generateExpeditionTheme(env.AI);
  const totalRoomsVisited =
    DUNGEON_MIN_ROOMS + Math.floor(Math.random() * (DUNGEON_MAX_ROOMS - DUNGEON_MIN_ROOMS + 1));
  const middleCount = totalRoomsVisited - 2;            // visited middle rooms
  const poolMiddleCount = middleCount * 2;               // generated middle rooms (door pool)

  // Pick room types for the entire generated middle pool. Bias toward combat
  // for encounter density.
  const poolTypes: ExpeditionNodeType[] = [];
  for (let i = 0; i < poolMiddleCount; i++) {
    const r = Math.random();
    if (r < 0.40) poolTypes.push("combat");
    else if (r < 0.65) poolTypes.push("trap");
    else if (r < 0.85) poolTypes.push("lockbox");
    else poolTypes.push("npc");
  }
  // Force first slot to be combat — that's the entry room and drops the first key.
  poolTypes[0] = "combat";
  // Note: merchant is appended as a DEDICATED node after the pool (see below),
  // not by overriding a random slot — preserves the random-middle-room
  // probabilities (40 combat / 25 trap / 20 lockbox / 15 npc).

  const failDamage = 4 + Math.max(1, character.level);
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));

  const art = artTargetFromEnv(env);
  // Build every middle-pool room in parallel — they're independent. Sequential was
  // ~30s wall-clock for a 10-room pool; parallel is closer to the slowest single call.
  const middleNodePromises: Promise<ExpeditionNode>[] = poolTypes.map(async (type, i) => {
    const roomNum = i + 1;
    if (type === "combat") {
      const monster = await generateOpeningScene(env.AI, character, elite, "gauntlet-wave", { wave: roomNum, total: totalRoomsVisited }, recentNames, art);
      const node: ExpeditionNode = {
        type: "combat",
        scene: monster.scene,
        monster_name: monster.monster_name,
        monster_max_hp: monster.monster_max_hp,
        tier: monster.tier,
        drops_key: true,
        drops_key_tier: "bronze",
        monster_art_url: monster.monster_art_url,
      };
      return node;
    }
    if (type === "trap") {
      // Sequential: generate the scene first, then fire art gen with the
      // scene text as the visual subject. Art gen runs in the background
      // through generateTrapArt → generateAndCacheArt.
      const trap = await generateTrapRoom(env.AI, theme, roomNum, totalRoomsVisited);
      const trapArtUrl = art ? await generateTrapArt(env.AI, art, trap.scene) : null;
      const node: ExpeditionNode = {
        type: "trap",
        scene: trap.scene,
        trap_choices: [
          { text: trap.options.str, emoji: "💪", skill: "str", fail_damage: failDamage },
          { text: trap.options.dex, emoji: "🔧", skill: "dex", fail_damage: failDamage },
          { text: trap.options.int, emoji: "📜", skill: "int", fail_damage: failDamage },
        ],
        ...(trapArtUrl ? { trap_art_url: trapArtUrl } : {}),
      };
      return node;
    }
    if (type === "lockbox") {
      const r = Math.random();
      const lockTier: KeyTier = r < 0.70 ? "bronze" : r < 0.95 ? "silver" : "gold";
      const tierBump = lockTier === "bronze" ? 1 : lockTier === "silver" ? 2 : 3;
      const rolls = Array.from({ length: 2 }, () => rollItem(baseTier + tierBump));
      const [lockboxScene, ...named] = await Promise.all([
        generateLockboxScene(env.AI, theme, roomNum, totalRoomsVisited),
        ...rolls.map((roll) => resolveLootDrop(env, "the locked chest", roll)),
      ]);
      const opts: LootOption[] = rolls.map((roll, j) => rollToLootOption(roll, named[j]));
      const node: ExpeditionNode = { type: "lockbox", scene: lockboxScene, loot_options: opts, lock_tier: lockTier };
      return node;
    }
    // (merchant is no longer rolled in the random pool — it's appended as a
    // dedicated node after the pool. See merchantPromise below.)
    // npc
    const npcName = generateNpcName();
    const offerRoll = rollItem(baseTier);
    // Sequential: name the offered item first, THEN generate the NPC's
    // greeting with that item name as input. Without this the greeting
    // would invent generic "wares" disconnected from the actual item.
    // Art gen runs in parallel with the loot-name call (it doesn't depend
    // on item names — only the NPC's name slug).
    const [offerNamed, npcArtUrl] = await Promise.all([
      resolveLootDrop(env, `${npcName}'s pack`, offerRoll),
      art ? generateEncounterArt(env.AI, art, "npc", npcName) : Promise.resolve(null),
    ]);
    const npc = await generateNpcRoom(env.AI, theme, roomNum, totalRoomsVisited, npcName, offerNamed.name);
    const node: ExpeditionNode = {
      type: "npc",
      scene: npc.scene,
      npc: {
        greeting: npc.greeting,
        item: rollToLootOption(offerRoll, offerNamed),
        ...(npcArtUrl ? { art_url: npcArtUrl } : {}),
      },
    };
    return node;
  });

  // Sub-boss + treasure loot also fire in parallel with the pool.
  const bossPromise = generateOpeningScene(env.AI, character, elite, "boss", undefined, recentNames, art);
  // Treasure loot rolls don't depend on boss tier — fire them at baseTier+1 in parallel
  // (was: baseTier from boss, but boss tier is already character.level + elite bump).
  const treasureRolls = Array.from({ length: EXPEDITION_TREASURE_OPTIONS }, () => rollItem(baseTier + 1));
  const treasureNamedPromises = treasureRolls.map((roll) =>
    resolveLootDrop(env, "the dungeon's heart-chamber", roll),
  );

  // Dedicated merchant node — appended AFTER the random pool so the random
  // middle-room probabilities (combat/trap/lockbox/npc) stay untouched.
  // Practical-for-fight stock only: weapons, armor, consumables, revives,
  // tools, scrolls. Magic items (max-mana boost) excluded — they're long-term
  // upgrades, not "fight this dungeon" gear.
  const merchantName = generateMerchantName();
  const merchantStockRolls = Array.from(
    { length: 3 },
    () => rollMerchantItem(baseTier + 1),
  );
  const merchantPromise = (async () => {
    // Sequential: name the stock items first so the merchant's greeting can
    // hawk them by name. Art gen runs in parallel with the stock-naming
    // calls (it depends only on the merchant's name slug). Then a final
    // generateMerchantRoom call with the named stock as explicit input.
    const [artUrl, ...named] = await Promise.all([
      art ? generateEncounterArt(env.AI, art, "merchant", merchantName) : Promise.resolve(null),
      ...merchantStockRolls.map((roll) => resolveLootDrop(env, `${merchantName}'s stall`, roll)),
    ]);
    const stockNames = named.map((n) => n.name);
    const info = await generateMerchantRoom(
      env.AI,
      theme,
      totalRoomsVisited - 2,
      totalRoomsVisited,
      merchantName,
      stockNames,
    );
    const stock: LootOption[] = merchantStockRolls.map((roll, j) => rollToLootOption(roll, named[j]));
    return { info, stock, artUrl };
  })();

  const [middleNodes, merchantData, boss, treasureNamed] = await Promise.all([
    Promise.all(middleNodePromises),
    merchantPromise,
    bossPromise,
    Promise.all(treasureNamedPromises),
  ]);

  const nodes: ExpeditionNode[] = [...middleNodes];
  // Merchant — guaranteed visit, sits between the random pool and the sub-boss.
  nodes.push({
    type: "merchant",
    scene: merchantData.info.scene,
    loot_options: merchantData.stock,
    npc: {
      greeting: merchantData.info.greeting,
      item: merchantData.stock[0],
      ...(merchantData.artUrl ? { art_url: merchantData.artUrl } : {}),
    },
  });
  nodes.push({
    type: "combat",
    scene: boss.scene,
    monster_name: boss.monster_name,
    monster_max_hp: boss.monster_max_hp,
    tier: boss.tier,
    drops_key: true,
    drops_key_tier: "silver",
    monster_art_url: boss.monster_art_url,
  });

  const treasureLoot: LootOption[] = treasureRolls.map((roll, i) => rollToLootOption(roll, treasureNamed[i]));
  nodes.push({
    type: "treasure",
    scene: "The dungeon opens onto its heart-chamber. A chest awaits.",
    loot_options: treasureLoot,
  });

  // Build the door pool: indices 1..poolMiddleCount-1 (entry index 0 is fixed start).
  // Shuffle so door pairs are random.
  const pool: number[] = [];
  for (let i = 1; i < poolMiddleCount; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Note: merchant is a dedicated node appended after the pool (see node
  // assembly above), not a pool slot — so no special placement needed here.
  // pickNextRoom routes pool-empty → merchant → sub-boss as forced single doors.

  const expedition: ExpeditionState = {
    theme,
    current: 0,
    nodes,
    path_taken: [],
    keys: 0,                            // legacy field — kept for backwards compat with old saves
    pool,
    middle_count: middleCount,
    visited_count: 1,                   // entry room counts
    visited_indices: [0],               // entry room
    sealed_doors: [],
  };

  // Top-level monster fields = first room's monster (entry is always combat).
  const first = nodes[0];
  if (first.type === "combat") {
    return {
      monster_name: first.monster_name!,
      monster_hp: first.monster_max_hp!,
      monster_max_hp: first.monster_max_hp!,
      tier: first.tier!,
      scene: first.scene,
      variant,
      expedition,
      ...(first.monster_art_url ? { monster_art_url: first.monster_art_url } : {}),
    };
  }
  return {
    monster_name: "—",
    monster_hp: 0,
    monster_max_hp: 0,
    tier: baseTier,
    scene: first.scene,
    variant,
    expedition,
  };
}

// ── Phase 4: Graph dungeon ────────────────────────────────────────────────────

const DIR_LABELS: Record<DungeonDirection, string> = { n: "North", e: "East", s: "South", w: "West" };

function directionLabel(dir: DungeonDirection): string {
  return DIR_LABELS[dir] ?? dir.toUpperCase();
}

// Renders the current room for Slack (mrkdwn text). Used by handleLook and
// handleGraphMove. Shows description, exits, encounter, and available objects.
function renderGraphRoom(node: DungeonNode, graph: DungeonGraph, cmd: string): string {
  const lines: string[] = [blockQuote(node.description)];
  const exitParts = Object.entries(node.exits).map(([d, id]) => {
    const targetNode = graph.nodes[id];
    const visited = targetNode?.visited ? "" : " _(unexplored)_";
    return `*${directionLabel(d as DungeonDirection)}*${visited}`;
  });
  if (exitParts.length > 0) {
    lines.push(`Exits: ${exitParts.join("  |  ")}`);
  }
  if (node.encounter && !node.encounter.cleared) {
    const m = node.encounter.monsters[0];
    lines.push(``, `⚔️ *${m.name}* (${m.hp}/${m.max_hp} HP) — use \`${cmd} attack\` to fight.`);
  } else if (node.encounter?.cleared) {
    lines.push(``, `✅ Encounter cleared.`);
  }
  const activeObjects = node.objects.filter(o => !o.used || o.takeable);
  if (activeObjects.length > 0) {
    const names = activeObjects.map(o => `*${o.name}*`).join(", ");
    lines.push(``, `Objects: ${names} — \`${cmd} use <name>\` to interact.`);
  }
  return lines.join("\n");
}

async function buildGraphDungeonScene(
  env: Env,
  character: Character,
  elite: boolean,
  recentNames: string[] = [],
): Promise<SceneJson> {
  const theme = await generateExpeditionTheme(env.AI);
  const art = artTargetFromEnv(env);
  const graph = await generateDungeonGraph(env.AI, theme, character.level, recentNames, art);
  const entranceNode = graph.nodes["entrance"]!;
  const baseTier = Math.max(1, Math.ceil(character.level / 2));
  return {
    monster_name: "—",
    monster_hp: 0,
    monster_max_hp: 0,
    tier: baseTier,
    scene: entranceNode.description,
    variant: "dungeon",
    graph,
  };
}

// Handles /gq move <n|e|s|w> for graph dungeons.
async function handleGraphMove(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const rawDir = (args[0] ?? "").toLowerCase();
  const validDirs: DungeonDirection[] = ["n", "e", "s", "w"];
  if (!validDirs.includes(rawDir as DungeonDirection)) {
    return ephemeral(`Usage: \`${payload.command} move <n|e|s|w>\`. Valid directions: n (north), e (east), s (south), w (west).`);
  }
  const dir = rawDir as DungeonDirection;

  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed and can't move.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");

  const graph = quest.scene.graph;
  if (!graph) {
    return ephemeral(`This quest doesn't use graph navigation. Try \`${payload.command} choose\` for the classic dungeon.`);
  }

  const currentNode = graph.nodes[graph.current];
  if (!currentNode) return ephemeral("Dungeon state is corrupted — no current room.");

  if (currentNode.encounter && !currentNode.encounter.cleared) {
    const m = currentNode.encounter.monsters[0];
    return ephemeral(`⚔️ *${m.name}* blocks the way! Finish the fight first.`);
  }

  const targetId = currentNode.exits[dir];
  if (!targetId) {
    return ephemeral(`No exit to the *${directionLabel(dir)}* from here.`);
  }

  const targetNode = graph.nodes[targetId];
  if (!targetNode) return ephemeral("That exit leads nowhere — dungeon state is corrupted.");

  const firstVisit = !targetNode.visited;
  const updatedTarget: DungeonNode = { ...targetNode, visited: true };
  const updatedGraph: DungeonGraph = {
    ...graph,
    current: targetId,
    visited: graph.visited.includes(targetId) ? graph.visited : [...graph.visited, targetId],
    nodes: { ...graph.nodes, [targetId]: updatedTarget },
  };

  // If entering a combat room with an active encounter, promote monster fields.
  let updatedScene: SceneJson = { ...quest.scene, graph: updatedGraph };
  if (updatedTarget.encounter && !updatedTarget.encounter.cleared && updatedTarget.encounter.monsters.length > 0) {
    const monster = updatedTarget.encounter.monsters[0];
    updatedScene = {
      ...updatedScene,
      monster_name: monster.name,
      monster_hp: monster.hp,
      monster_max_hp: monster.max_hp,
      tier: monster.tier,
      monster_art_url: monster.art_url ?? undefined,
      monster_effects: [],
      marked_by: undefined,
      marked_until: undefined,
      monster_telegraph: undefined,
      passives_used: undefined,
      ability_state: undefined,
    };
  }

  await saveScene(env.DB, quest.id, updatedScene);
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `graph move ${dir} → ${targetId}`);
  if (firstVisit) await regenPartyMana(env.DB, quest.id, MANA_REGEN_BETWEEN_ROOMS);

  const roomName = updatedTarget.name ?? targetId;
  const moveNote = `🧭 <@${payload.user_id}> moves *${directionLabel(dir)}* — *${roomName}*.`;
  const roomText = renderGraphRoom(updatedTarget, updatedGraph, payload.command);

  // On first visit, fire room art generation in the background. When it
  // resolves, save the URL back to the node so subsequent visits show the image.
  const artTarget = artTargetFromEnv(env);
  if (firstVisit && artTarget && !updatedTarget.encounter) {
    ctx.waitUntil(
      (async () => {
        const url = await generateRoomArt(
          env.AI,
          artTarget,
          targetId,
          roomName,
          updatedTarget.description ?? "",
        );
        if (!url) return;
        // Re-read the scene to get the latest state, then patch in the art URL.
        const latestQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
        if (!latestQuest?.scene.graph) return;
        const latestGraph = latestQuest.scene.graph;
        const latestNode = latestGraph.nodes[targetId];
        if (!latestNode) return;
        const patchedGraph: DungeonGraph = {
          ...latestGraph,
          nodes: { ...latestGraph.nodes, [targetId]: { ...latestNode, art_url: url } },
        };
        await saveScene(env.DB, quest.id, { ...latestQuest.scene, graph: patchedGraph });
      })(),
    );
  }

  // Build image blocks: encounter art takes priority; room art shown on non-combat rooms.
  const roomArtUrl = updatedTarget.art_url ?? null;
  const encounterArtUrl = updatedTarget.encounter?.monsters[0]?.art_url ?? null;
  const displayArtUrl = encounterArtUrl ?? roomArtUrl;

  if (displayArtUrl) {
    const altText = updatedTarget.encounter?.monsters[0]?.name ?? roomName;
    const imgBlocks: unknown[] = [
      { type: "image", image_url: displayArtUrl, alt_text: altText },
      { type: "section", text: { type: "mrkdwn", text: [moveNote, "", roomText].join("\n") } },
    ];
    ctx.waitUntil(postToThread(env, quest, [blockQuote(moveNote), "", roomText].join("\n"), { blocks: imgBlocks }));
  } else {
    ctx.waitUntil(postToThread(env, quest, [blockQuote(moveNote), "", roomText].join("\n")));
  }

  return { text: [moveNote, "", roomText].join("\n"), response_type: "ephemeral" };
}

// Called when a monster dies in a graph dungeon room. Marks the encounter
// cleared. Boss kill → full resolveVictory; normal kill → show room prompt.
async function resolveGraphEncounterKill(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  fighters: Character[],
  preamble: string[],
): Promise<CommandResponse> {
  const graph = quest.scene.graph!;
  const currentNodeId = graph.current;
  const currentNode = graph.nodes[currentNodeId];
  if (!currentNode) return ephemeral(preamble.join("\n"));

  const isBoss = currentNode.encounter?.monsters[0]?.is_boss ?? false;

  // Mark encounter cleared in the graph.
  const updatedNode: DungeonNode = currentNode.encounter
    ? { ...currentNode, encounter: { ...currentNode.encounter, cleared: true } }
    : currentNode;
  const updatedGraph: DungeonGraph = {
    ...graph,
    nodes: { ...graph.nodes, [currentNodeId]: updatedNode },
  };
  const updatedScene: SceneJson = { ...quest.scene, graph: updatedGraph, monster_hp: 0 };
  await saveScene(env.DB, quest.id, updatedScene);
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `graph encounter cleared: ${currentNodeId}${isBoss ? " (boss)" : ""}`);

  if (isBoss) {
    // Boss killed — full victory flow.
    return resolveVictory(payload, env, ctx, character, { ...quest, scene: updatedScene }, fighters, preamble);
  }

  // Regular encounter cleared — show the room so the party sees available exits.
  const roomText = renderGraphRoom(updatedNode, updatedGraph, payload.command);
  const lines = [...preamble, ``, `✅ Room clear. Use \`${payload.command} move <n|e|s|w>\` to continue.`, ``, roomText];
  ctx.waitUntil(postToThread(env, { ...quest, scene: updatedScene }, lines.join("\n")));
  return ephemeral(lines.join("\n"));
}

// Picks up a takeable object in the current graph dungeon room.
async function handleGraphTake(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  quest: ActiveQuest,
): Promise<CommandResponse> {
  const graph = quest.scene.graph!;
  const node = graph.nodes[graph.current];
  if (!node) return ephemeral("Dungeon state is corrupted.");

  const query = args.join(" ").toLowerCase().trim();
  if (!query) return ephemeral(`Usage: \`${payload.command} take <object name>\`.`);

  const obj = node.objects.find(o => o.takeable && !o.used && o.name.toLowerCase().includes(query));
  if (!obj) {
    const available = node.objects.filter(o => o.takeable && !o.used).map(o => `*${o.name}*`).join(", ");
    return available
      ? ephemeral(`No match for "${query}". Takeable objects here: ${available}.`)
      : ephemeral("There's nothing to take here.");
  }

  // If the object carries a spawn_item loot spec, generate AI name/flavor at
  // pickup time so the item feels fresh. Falls back to the spec's placeholder
  // strings if the AI call fails.
  const lootSpec = obj.on_use?.effect === "spawn_item" ? obj.on_use.item : null;
  let itemName = obj.name;
  let itemFlavor = "Retrieved from the dungeon.";
  let itemType: "weapon" | "armor" | "consumable" | "magic" | "revive" | "tool" = "tool";
  let itemPower = 0;
  let itemRarity: "common" | "uncommon" | "rare" | "epic" | "legendary" = "common";
  let itemWeaponRange: "melee" | "ranged" | "focus" | null = null;
  let itemSlot: import("@gantt-quest/core").EquipSlot | null = null;
  let itemStatBonus: Record<string, number> | null = null;
  let itemSubtype: string | null = null;
  if (lootSpec) {
    try {
      const named = await flavorLootDrop(
        env.AI,
        quest.scene.monster_name ?? "the dungeon",
        lootSpec.item_type as "weapon" | "armor" | "consumable" | "magic" | "revive",
        lootSpec.rarity as "common" | "uncommon" | "rare" | "epic" | "legendary",
        lootSpec.power,
        (lootSpec.weapon_range ?? undefined) as "melee" | "ranged" | "focus" | undefined,
        lootSpec.slot ?? undefined,
        lootSpec.item_subtype ?? undefined,
      );
      itemName = named.name;
      itemFlavor = named.flavor;
    } catch {
      itemName = lootSpec.name;
      itemFlavor = lootSpec.flavor;
    }
    itemType = lootSpec.item_type as typeof itemType;
    itemPower = lootSpec.power;
    itemRarity = lootSpec.rarity as typeof itemRarity;
    itemWeaponRange = (lootSpec.weapon_range ?? null) as typeof itemWeaponRange;
    itemSlot = (lootSpec.slot ?? null) as typeof itemSlot;
    itemStatBonus = lootSpec.stat_bonus ?? null;
    itemSubtype = lootSpec.item_subtype ?? null;
  }
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: itemName,
    item_type: itemType,
    power: itemPower,
    rarity: itemRarity,
    flavor: itemFlavor,
    weapon_range: itemWeaponRange,
    slot: itemSlot,
    stat_bonus: itemStatBonus,
    item_subtype: itemSubtype,
  });

  const updatedObjects = node.objects.map(o => o.id === obj.id ? { ...o, used: true } : o);
  const updatedNode: DungeonNode = { ...node, objects: updatedObjects };
  const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
  await saveScene(env.DB, quest.id, { ...quest.scene, graph: updatedGraph });

  const lootLine = lootSpec
    ? `🎒 You open *${obj.name}* and find ${RARITY_BADGE[itemRarity]} *${itemName}* (id \`${item.id}\`). _${itemFlavor}_`
    : `🎒 You pick up *${obj.name}*. Added to inventory as item \`${item.id}\`.`;
  return ephemeral(lootLine);
}

// Runs the on_use effect of a named object in the current graph dungeon room.
async function handleGraphUseObject(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  quest: ActiveQuest,
): Promise<CommandResponse> {
  const graph = quest.scene.graph!;
  const node = graph.nodes[graph.current];
  if (!node) return ephemeral("Dungeon state is corrupted.");

  const query = args.join(" ").toLowerCase().trim();
  if (!query) return ephemeral(`Usage: \`${payload.command} use <object name>\`.`);

  const obj = node.objects.find(o => !o.used && o.name.toLowerCase().includes(query));
  if (!obj) {
    const available = node.objects.filter(o => !o.used && o.on_use).map(o => `*${o.name}*`).join(", ");
    return available
      ? ephemeral(`No match for "${query}". Usable objects here: ${available}.`)
      : ephemeral("There's nothing to interact with here.");
  }

  if (!obj.on_use) {
    return ephemeral(`*${obj.name}* can't be used — it's just there.`);
  }

  const markUsed = (o: typeof obj) => node.objects.map(x => x.id === o.id ? { ...x, used: true } : x);

  const effect = obj.on_use;

  if (effect.effect === "flavor") {
    const updatedObjects = markUsed(obj);
    const updatedNode: DungeonNode = { ...node, objects: updatedObjects };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    return ephemeral(`🔍 *${obj.name}*: ${effect.text}`);
  }

  if (effect.effect === "open_exit") {
    if (node.exits[effect.direction]) {
      return ephemeral(`The exit to the *${directionLabel(effect.direction)}* is already open.`);
    }
    const updatedObjects = markUsed(obj);
    const updatedNode: DungeonNode = {
      ...node,
      objects: updatedObjects,
      exits: { ...node.exits, [effect.direction]: effect.reveals_node },
    };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    return ephemeral(`🚪 *${obj.name}* reveals a passage to the *${directionLabel(effect.direction)}*. Use \`${payload.command} move ${effect.direction}\` to proceed.`);
  }

  if (effect.effect === "spawn_item") {
    const loot = effect.item;
    const item = await addItem(env.DB, {
      character_id: payload.user_id,
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
    const updatedObjects = markUsed(obj);
    const updatedNode: DungeonNode = { ...node, objects: updatedObjects };
    const updatedGraph: DungeonGraph = { ...graph, nodes: { ...graph.nodes, [graph.current]: updatedNode } };
    await saveScene(env.DB, quest.id, { ...quest.scene, graph: updatedGraph });
    const badge = RARITY_BADGE[loot.rarity] ?? "";
    return ephemeral(`✨ *${obj.name}* yields ${badge} *${loot.name}*! Added to inventory as item \`${item.id}\`.`);
  }

  if (effect.effect === "trigger_encounter") {
    if (node.encounter && !node.encounter.cleared) {
      return ephemeral("There's already an active encounter in this room.");
    }
    const [spec] = effect.monsters;
    if (!spec) return ephemeral("No monster defined for this encounter.");
    const updatedObjects = markUsed(obj);
    const updatedNode: DungeonNode = {
      ...node,
      objects: updatedObjects,
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
    await saveScene(env.DB, quest.id, updatedScene);
    return ephemeral(`⚔️ *${obj.name}* triggers an encounter! *${spec.name}* (${spec.hp}/${spec.max_hp} HP) attacks! Use \`${payload.command} attack\` to fight.`);
  }

  return ephemeral(`*${obj.name}* has no effect.`);
}

// Resolves an ItemRoll into a (name, flavor) pair. Catalog items (tool/scroll) keep
// their fixed name from the catalog; the AI just writes flavor text. Other types
// (weapon/armor/etc.) get fully AI-named via flavorLootDrop. Used at every drop
// site so the catalog/non-catalog branch lives in one place.
async function resolveLootDrop(
  env: Env,
  location: string,
  roll: ItemRoll,
): Promise<{ name: string; flavor: string }> {
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
    // Narrow back: catalog items are handled above, so by here type is always one of
    // the AI-named types.
    roll.type as "weapon" | "armor" | "consumable" | "magic" | "revive",
    roll.rarity,
    roll.power,
    roll.weapon_range,
    roll.slot ?? undefined,
    roll.item_subtype ?? undefined,
  );
}

// Merges a roll + AI-named result into a LootOption. Preserves all Phase 2
// slot/stat_bonus/item_subtype fields so they flow through to addItem.
function rollToLootOption(roll: ItemRoll, named: { name: string; flavor: string }): LootOption {
  return {
    name: named.name,
    item_type: roll.type,
    power: roll.power,
    rarity: roll.rarity,
    flavor: named.flavor,
    weapon_range: roll.weapon_range ?? null,
    level_req: Math.max(1, Math.ceil(roll.power / 3)),
    ...(roll.slot ? { slot: roll.slot } : {}),
    ...(roll.stat_bonus ? { stat_bonus: roll.stat_bonus as Record<string, number> } : {}),
    ...(roll.item_subtype ? { item_subtype: roll.item_subtype } : {}),
  };
}

function dungeonRoomLabel(t: ExpeditionNodeType): string {
  if (t === "combat") return "⚔️ Combat";
  if (t === "trap") return "⚠️ Trap";
  if (t === "lockbox") return "🔒 Lockbox";
  if (t === "npc") return "🤝 Encounter";
  if (t === "merchant") return "🛒 Merchant";
  return "🎁 Treasure";
}

// Mid-dungeon rest gate. Allowed when the party is "between" rooms in a dungeon —
// not during an active combat fight. Other variants (standard/boss/gauntlet) never
// allow mid-quest rest because there's no room concept to be "between."
function canRestBetweenRooms(quest: ActiveQuest): boolean {
  if (quest.scene.variant !== "dungeon") return false;
  const exp = quest.scene.expedition;
  if (!exp) return false;
  // Pending door pick = entry combat just resolved, no active fight.
  if (exp.pending_doors && exp.pending_doors.length > 0) return true;
  // Active combat blocks rest. Otherwise (current room is trap/lockbox/npc/treasure
  // OR combat is already won), resting is fine.
  const node = exp.nodes[exp.current];
  if (node && node.type === "combat" && quest.scene.monster_hp > 0) return false;
  return true;
}

// Status-effect tick. Returns the post-tick effects array (with expired entries
// dropped) and the cumulative HP delta to apply to the actor. Magnitude is
// stored as a positive integer; sign comes from EFFECT_META.kind (buff = +HP,
// debuff = -HP). Each entry's `remaining` decrements once per call.
function tickEffects(effects: StatusEffect[]): { next: StatusEffect[]; hpDelta: number; ticked: StatusEffect[] } {
  let hpDelta = 0;
  const ticked: StatusEffect[] = [];
  const next: StatusEffect[] = [];
  for (const e of effects) {
    const meta = EFFECT_META[e.type];
    if (!meta) {
      // Unknown effect — drop it gracefully.
      continue;
    }
    if (meta.kind === "passive") {
      // Passive effects (e.g. empowered) have no HP delta — just count down silently.
      const remaining = e.remaining - 1;
      if (remaining > 0) next.push({ ...e, remaining });
      continue;
    }
    const sign = meta.kind === "buff" ? 1 : -1;
    hpDelta += sign * e.magnitude;
    ticked.push(e);
    const remaining = e.remaining - 1;
    if (remaining > 0) {
      next.push({ ...e, remaining });
    }
  }
  return { next, hpDelta, ticked };
}

// Compact effect summary for display next to an actor's name (e.g. in /sq me or
// combat output). Returns "" when there are no effects.
function effectsBadge(effects: StatusEffect[] | undefined | null): string {
  if (!effects || effects.length === 0) return "";
  return effects.map((e) => `${EFFECT_META[e.type]?.emoji ?? "❓"}${e.remaining}`).join(" ");
}

// Tick the actor's status effects + apply any newly-applied effects, persist
// both HP and effects to the DB, and return narration lines + post-tick HP.
//
// Used by every combat-tier player action (attack/cast/sig, heal/shield, tool
// uses that consume a turn). Free-action tool uses (Espresso Shot, Rebase Scroll)
// don't call this — they apply their own effects without ticking.
//
// Returns:
//   character    — updated copy with new HP + effects (caller should reassign)
//   tickLines    — one line per ticked effect (for narration)
//   newLines     — one line per newly-applied effect ("now bleeding")
//   postTickHp   — final HP after tick, before any clamp by caller
async function applyPlayerTick(
  env: Env,
  userId: string,
  character: Character,
  newlyApplied: StatusEffect[] = [],
): Promise<{ character: Character; tickLines: string[]; newLines: string[]; postTickHp: number }> {
  const tick = tickEffects(character.effects ?? []);
  const tickLines = tick.ticked.map((e) => {
    const meta = EFFECT_META[e.type];
    const sign = meta.kind === "buff" ? "+" : "-";
    return `${meta.emoji} <@${userId}> ${meta.name.toLowerCase()} ticks ${sign}${e.magnitude} HP.`;
  });
  let postTickEffects = tick.next;
  const newLines: string[] = [];
  for (const eff of newlyApplied) {
    postTickEffects = withEffectApplied(postTickEffects, eff);
    const meta = EFFECT_META[eff.type];
    newLines.push(`${meta.emoji} <@${userId}> is now *${meta.name}* (${eff.remaining} actions).`);
  }

  // 🌿 Backend Druid passive: always-on regen — restore 1 HP per own action.
  // Models the druid drawing constantly on the database-tree's vitality.
  // Stacks AFTER status-effect ticks so a poisoned Druid still loses net HP
  // each turn (poison usually > 1/tick), but the regen partially offsets.
  // Only ticks on the Druid's OWN action — not on partymates'.
  let druidRegenDelta = 0;
  if (classByName(character.class).id === "backend_druid" && character.hp + tick.hpDelta < character.max_hp) {
    druidRegenDelta = DRUID_PASSIVE_REGEN;
    tickLines.push(`🌿 *Backend Druid* passive: regen +${DRUID_PASSIVE_REGEN} HP.`);
  }

  const postTickHp = Math.max(0, Math.min(character.max_hp, character.hp + tick.hpDelta + druidRegenDelta));
  const effectsChanged =
    tick.hpDelta !== 0 || tick.ticked.length > 0 || newlyApplied.length > 0;
  if (effectsChanged) {
    await setCharacterEffects(env.DB, userId, postTickEffects);
  }
  if (tick.hpDelta !== 0 || druidRegenDelta !== 0) {
    await setCharacterHp(env.DB, userId, postTickHp);
  }
  return {
    character: { ...character, hp: postTickHp, effects: postTickEffects },
    tickLines,
    newLines,
    postTickHp,
  };
}

// Applies an effect to a character or monster. If an effect of the same type
// already exists, STACKS it: magnitudes add together, remaining takes the max.
// Two Poison Vials on the same monster double the damage per tick; a Warlock
// who crits twice inflicts 2× bleed. No hard cap — party coordination is the
// balancing lever.
function withEffectApplied(effects: StatusEffect[], add: StatusEffect): StatusEffect[] {
  const idx = effects.findIndex((e) => e.type === add.type);
  if (idx === -1) return [...effects, add];
  const existing = effects[idx];
  const merged: StatusEffect = {
    ...add,
    magnitude: existing.magnitude + add.magnitude,
    remaining: Math.max(existing.remaining, add.remaining),
  };
  return effects.map((e, i) => (i === idx ? merged : e));
}

// Is there a live monster in the current scene that should retaliate when a player
// uses mana? Heal/shield call this to skip retaliation when the party is between
// rooms (dungeon: pending door, or non-combat room, or combat won) — a dead Stale PR
// shouldn't get to hit back.
function hasLiveMonster(quest: ActiveQuest): boolean {
  if (quest.scene.monster_hp <= 0) return false;
  if (quest.scene.variant === "dungeon") {
    const exp = quest.scene.expedition;
    if (!exp) return false;
    if (exp.pending_doors && exp.pending_doors.length > 0) return false;
    const node = exp.nodes[exp.current];
    if (!node || node.type !== "combat") return false;
  }
  return true;
}

const KEY_EMOJI: Record<KeyTier, string> = { bronze: "🥉", silver: "🥈", gold: "🥇" };
const TIER_RANK: Record<KeyTier, number> = { bronze: 1, silver: 2, gold: 3 };
const TIER_ORDER: KeyTier[] = ["bronze", "silver", "gold"];

// Returns the cheapest key tier the character holds that meets-or-exceeds `lock`.
// Falls back to null if they can't open it.
function pickKeyForLock(character: Character, lock: KeyTier): KeyTier | null {
  for (const t of TIER_ORDER) {
    if (TIER_RANK[t] < TIER_RANK[lock]) continue;
    const count = t === "bronze" ? character.keys_bronze : t === "silver" ? character.keys_silver : character.keys_gold;
    if (count > 0) return t;
  }
  return null;
}

function characterKeyDisplay(c: Character): string {
  const parts: string[] = [];
  if (c.keys_bronze > 0) parts.push(`${KEY_EMOJI.bronze}${c.keys_bronze}`);
  if (c.keys_silver > 0) parts.push(`${KEY_EMOJI.silver}${c.keys_silver}`);
  if (c.keys_gold > 0) parts.push(`${KEY_EMOJI.gold}${c.keys_gold}`);
  return parts.join(" ");
}

// Static gold values per key tier — sold to the shopkeep regardless of channel
// shop state. Lets piled-up keys convert to a soft gold trickle.
const KEY_SELL_PRICE: Record<KeyTier, number> = {
  bronze: 5,
  silver: 25,
  gold: 100,
};

// 3 of any tier transmutes up to 1 of the next tier. No transmute path beyond
// gold (it's the top). Encourages saving toward gold-tier locks without
// requiring sub-boss drop luck.
const KEY_TRANSMUTE_COST = 3;

function keyCount(c: Character, tier: KeyTier): number {
  return tier === "bronze" ? c.keys_bronze : tier === "silver" ? c.keys_silver : c.keys_gold;
}

function nextKeyTier(tier: KeyTier): KeyTier | null {
  if (tier === "bronze") return "silver";
  if (tier === "silver") return "gold";
  return null;
}

// Compact emoji-only icon for a room type — used in path-trail rendering.
function dungeonRoomIcon(t: ExpeditionNodeType): string {
  if (t === "combat") return "⚔️";
  if (t === "trap") return "⚠️";
  if (t === "lockbox") return "🔒";
  if (t === "npc") return "🤝";
  if (t === "merchant") return "🛒";
  return "🎁";
}

// One-line trail showing visited rooms (with the current one bracketed) and `?`
// Total rooms a player will visit in a dungeon, given the dungeon's
// middle_count. The math:
//   1 entry combat
// + (middleCount - 1) paired-door middle picks
// + 1 single-option middle pick (always — pool size is always odd)
// + 1 merchant
// + 1 sub-boss
// + 1 treasure
// = middleCount + 4
//
// Earlier code used `middleCount + 3` and the single-option pool leftover was
// uncounted, so the display capped 1 short of reality (player saw "Room 4/6"
// when actually completing 7 rooms before treasure-take ended the run).
function dungeonRoomTotal(middleCount: number): number {
  return middleCount + 4;
}

// placeholders for what's still ahead. Reads visited_indices for path order; falls
// back to a coarse approximation if that field is missing on legacy saves.
function renderPathTrail(exp: ExpeditionState): string {
  const visited = exp.visited_indices ?? [exp.current];
  const middleTotal = dungeonRoomTotal(exp.middle_count ?? 0);
  const ahead = Math.max(0, middleTotal - visited.length);
  const visitedIcons = visited.map((idx, i) => {
    const node = exp.nodes[idx];
    if (!node) return "?";
    const icon = dungeonRoomIcon(node.type);
    return i === visited.length - 1 ? `*${icon}*` : icon;
  });
  const aheadIcons = Array.from({ length: ahead }, () => "❓");
  return `🗺️ ${[...visitedIcons, ...aheadIcons].join(" → ")}`;
}

// Vertical map shown on dungeon completion — every visited room with its sealed-door
// alternative inline on the same line.
//
// Invariant: sealed_doors is appended-to in walk order, one entry per door pick.
// All non-entry middle rooms came from a door pick EXCEPT the auto-advanced last
// middle room (which the player walked into when only one room was left in the pool).
// We iterate visited[] and consume sealed_doors with a running cursor; when the
// cursor runs past the end (the auto-advance step), `sealed[cursor]` is undefined
// and we render no sealed sibling — which is exactly correct.
// Per-fighter damage / healing / shield / kill totals at quest end. Renders a
// compact one-line-per-actor breakdown ordered by damage dealt descending.
// Returns "" when there's nothing to show (no logged combat actions).
function renderDamageBreakdown(stats: QuestDamageStats[]): string {
  if (stats.length === 0) return "";
  // Identify the top tank (most damage soaked) so we can call them out
  // with a 🛡 badge — gives tank-flavored classes (Warden, Paladin) a
  // public moment of recognition that mirrors the "most damage dealt"
  // implicit top-of-list ordering. Ties: first row wins (stable sort).
  const tanks = stats.filter((s) => s.damage_taken > 0);
  const topTankId = tanks.length > 0
    ? tanks.reduce((best, s) => s.damage_taken > best.damage_taken ? s : best, tanks[0]).user_id
    : null;

  const lines = ["📊 *Contribution breakdown*"];
  for (const s of stats) {
    const parts: string[] = [];
    if (s.damage_dealt > 0) parts.push(`*${s.damage_dealt}* dmg`);
    if (s.damage_taken > 0) {
      const tankBadge = s.user_id === topTankId ? "🛡 " : "";
      parts.push(`${tankBadge}${s.damage_taken} taken`);
    }
    if (s.healing_done > 0) parts.push(`💚 ${s.healing_done} healed`);
    if (s.shielding_done > 0) parts.push(`🛡️ ${s.shielding_done} shielded`);
    if (s.kills > 0) parts.push(`🏆 ${s.kills}`);
    if (parts.length === 0) continue;
    lines.push(`<@${s.user_id}> — ${parts.join(", ")}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function renderDungeonMap(exp: ExpeditionState): string {
  const visited = exp.visited_indices ?? [exp.current];
  const sealed = exp.sealed_doors ?? [];
  // Labels keyed off node-index, not position-in-visited, so the markers stay
  // correct even mid-quest (treasure not visited yet) or in legacy dungeons
  // built before the merchant slot existed.
  const treasureIdx = exp.nodes.length - 1;
  const subBossIdx = exp.nodes.length - 2;
  const merchantIdx = exp.nodes.length - 3;
  const lines: string[] = ["🗺️ *Dungeon path*"];
  let sealedCursor = 0;
  for (let i = 0; i < visited.length; i++) {
    const idx = visited[i];
    const node = exp.nodes[idx];
    if (!node) continue;
    const label = dungeonRoomLabel(node.type);
    let line: string;
    if (i === 0) {
      line = `▸ ${label}  _entry_`;
    } else if (idx === treasureIdx) {
      line = `▸ ${label}  _heart-chamber_`;
    } else if (idx === subBossIdx) {
      line = `▸ ${label}  _sub-boss_`;
    } else if (idx === merchantIdx && node.type === "merchant") {
      line = `▸ ${label}  _merchant_`;
    } else {
      const sealedIdx = sealed[sealedCursor++];
      const sealedNode = sealedIdx !== undefined ? exp.nodes[sealedIdx] : null;
      const sealedLabel = sealedNode ? `  ╱ _sealed: ${dungeonRoomLabel(sealedNode.type)}_` : "";
      line = `▸ ${label}${sealedLabel}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Renders a single dungeon room as the body text for either the opening post or a
// post-action room transition. Includes the room number, key count, and type-specific
// affordances (combat verbs / trap options / lockbox key prompt / npc choices / take).
// `currentMonsterHp` is the live HP from the active scene (passed in from
// /sq look mid-fight). When omitted, callers are rendering the room at
// first reveal — the monster is at full HP and we show max/max. When
// supplied for an active combat room, we render current/max so players can
// pull up /sq look and see the fight's actual state.
function renderDungeonRoom(node: ExpeditionNode, exp: ExpeditionState, cmd: string, currentMonsterHp?: number): string {
  // Display X/Y in terms of VISITED rooms, not the door-pool size. visited_count
  // is the player's path length so far; dungeonRoomTotal is the total visits.
  const visited = exp.visited_count ?? 1;
  const middleTotal = dungeonRoomTotal(exp.middle_count ?? 0);
  const trail = renderPathTrail(exp);
  const header = `*Room ${visited}/${middleTotal}* — ${dungeonRoomLabel(node.type)}\n${trail}`;
  const sceneBlock = blockQuote(node.scene);

  if (node.type === "combat") {
    const liveHp = currentMonsterHp ?? node.monster_max_hp;
    return [
      header,
      sceneBlock,
      "",
      `Foe: *${node.monster_name}* — HP ${liveHp}/${node.monster_max_hp}`,
      "",
      `Combat: \`${cmd} attack\` • \`${cmd} cast\` • \`${cmd} signature\`.`,
    ].join("\n");
  }
  if (node.type === "trap") {
    const choices = (node.trap_choices ?? []).map((c, i) => {
      const reward = trapRewardLabel(c.skill);
      return `\`${i + 1}\` ${c.emoji} ${c.text}  _(${SKILL_META[c.skill].label}, pass: ${reward})_`;
    });
    const dmg = node.trap_choices?.[0]?.fail_damage ?? 0;
    return [
      header,
      sceneBlock,
      "",
      ...choices,
      "",
      `_Roll 1d6 + matching-skill bonus, need 4+. Class skill = +2 to roll. Fail = take *${dmg}* HP._ \`${cmd} choose <n>\``,
    ].join("\n");
  }
  if (node.type === "lockbox") {
    const opts = (node.loot_options ?? []).map((l, i) => {
      const power = l.item_type === "consumable" ? `heals ${l.power}` : `+${l.power}`;
      return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
    });
    const skipNum = (node.loot_options?.length ?? 0) + 1;
    const lockTier = node.lock_tier ?? "bronze";
    const lockBadge = `${KEY_EMOJI[lockTier]} *${lockTier}* lock`;
    const action = `${lockBadge} — needs ${KEY_EMOJI[lockTier]} ${lockTier}+ key. \`${cmd} choose 1|2\` to spend a key, \`${cmd} choose ${skipNum}\` to walk past.`;
    return [header, sceneBlock, "", ...opts, "", action].join("\n");
  }
  if (node.type === "npc") {
    const item = node.npc?.item;
    const itemLine = item
      ? `Offers: ${RARITY_BADGE[item.rarity]} *${item.name}* — ${item.item_type}, ${item.item_type === "consumable" ? `heals ${item.power}` : `+${item.power}`}`
      : "";
    return [
      header,
      sceneBlock,
      "",
      `> "${node.npc?.greeting ?? "..."}"`,
      itemLine,
      "",
      `\`${cmd} choose 1\` Trust them (take the item) • \`${cmd} choose 2\` Refuse and pass.`,
    ].filter(Boolean).join("\n");
  }
  if (node.type === "merchant") {
    const stock = node.loot_options ?? [];
    const stockLines = stock.map((l, i) => {
      const power = powerLabel(l.item_type, l.power, l.name);
      const price = merchantPrice(l.item_type, l.rarity);
      const effect = catalogEffectLine(l.name);
      const head = `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power} • *${price}g*`;
      return effect ? `${head}\n   ${effect}` : head;
    });
    const skipNum = stock.length + 1;
    return [
      header,
      sceneBlock,
      "",
      `> "${node.npc?.greeting ?? "..."}"`,
      "",
      ...stockLines,
      "",
      `\`${cmd} choose 1-${stock.length}\` to buy • \`${cmd} choose ${skipNum}\` to walk past. _Prices include a +15% dungeon markup._`,
    ].join("\n");
  }
  // treasure
  const opts = (node.loot_options ?? []).map((l, i) => {
    const power = l.item_type === "consumable" ? `heals ${l.power}` : `+${l.power}`;
    return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
  });
  return [
    header,
    sceneBlock,
    "",
    ...opts,
    "",
    `_First \`${cmd} take <n>\` claims for the party._`,
  ].join("\n");
}

// Short label describing what a trap-pass yields, by skill. Mirrors the
// resolveTrapChoice reward branches — keeping these in sync is what makes
// the trap UI honest about the choice on offer.
function trapRewardLabel(skill: SkillType): string {
  if (skill === "str") return `🥉 bronze key`;
  if (skill === "dex") return `🛡️ ${TRAP_SHIELD_REWARD} shield`;
  return `✨ ${TRAP_MANA_REWARD} mana`;
}

// Truncates a string to fit Slack's plain_text 75-char button cap with a small
// safety margin. Used for loot-button labels where the AI-generated item name
// can occasionally run long ("Phoenix-Down of the Late-Stage Hotfix"). Cuts
// on a word boundary when possible and appends "…" so the truncation reads
// intentionally rather than as a render bug.
function truncateForButton(text: string, max = 60): string {
  if (text.length <= max) return text;
  const trimmed = text.slice(0, max);
  // Prefer cutting at the last space so we don't break a word mid-syllable.
  const lastSpace = trimmed.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? trimmed.slice(0, lastSpace) : trimmed) + "…";
}

// Block Kit version of renderDungeonRoom — same content but with action buttons
// for trap/lockbox/npc/treasure choices. Combat rooms get no buttons (combat uses
// /sq attack/cast/sig). Action_id values route via /slack/interactive →
// handleInteraction → handleChoose / handleTake. value = the same idx the slash
// form takes.
// Async because non-combat rooms (lockbox, merchant, treasure) attach AI-
// generated banner art via viewArt — head-checks R2, schedules background
// gen on miss. Combat rooms take their per-monster portrait from the node
// itself (already pre-rendered at dungeon-creation time) and don't need the
// lazy path. ctx is required for non-combat rooms; pass undefined when env
// is also undefined (rare — only the empty-state preview render does this).
async function buildDungeonRoomBlocks(
  node: ExpeditionNode,
  exp: ExpeditionState,
  cmd: string,
  env?: Env,
  ctx?: ExecutionContext,
  // Live HP from the current scene — supplied by /sq look so the rendered
  // foe line reflects the in-progress fight, not just the starting state.
  // Other callers (initial room reveal, door advance) omit this and the
  // renderer defaults to monster_max_hp/monster_max_hp.
  currentMonsterHp?: number,
): Promise<unknown[]> {
  const visited = exp.visited_count ?? 1;
  const middleTotal = dungeonRoomTotal(exp.middle_count ?? 0);
  const trail = renderPathTrail(exp);
  const header = `*Room ${visited}/${middleTotal}* — ${dungeonRoomLabel(node.type)}\n${trail}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: header } },
    { type: "section", text: { type: "mrkdwn", text: blockQuote(node.scene) } },
  ];

  if (node.type === "combat") {
    // Insert the room's monster portrait between the room header and the
    // scene-prose section so players see who they're fighting before they
    // start scrolling stat lines. Same splice pattern as lockbox/merchant
    // headers — keeps the room-header section first.
    if (node.monster_art_url) {
      blocks.splice(1, 0, {
        type: "image",
        image_url: node.monster_art_url,
        alt_text: node.monster_name ?? "foe",
      });
    }
    const liveHp = currentMonsterHp ?? node.monster_max_hp;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `Foe: *${node.monster_name}* — HP ${liveHp}/${node.monster_max_hp}\n\nCombat: \`${cmd} attack\` • \`${cmd} cast\` • \`${cmd} signature\`.` },
    });
    return blocks;
  }

  if (node.type === "trap") {
    // Per-trap illustration — pre-rendered at dungeon-creation time, stored
    // on the node. Old expeditions (pre-trap-art) gracefully skip.
    if (node.trap_art_url) {
      blocks.splice(1, 0, {
        type: "image",
        image_url: node.trap_art_url,
        alt_text: "the trap",
      });
    }
    const choices = node.trap_choices ?? [];
    // Each option displays its skill, the action text, AND its pass-reward
    // (so players can make an informed choice between them — risk vs reward
    // when no class skill matches, reward selection when multiple do).
    const optionLines = choices.map((c, i) => {
      const reward = trapRewardLabel(c.skill);
      return `\`${i + 1}\` ${c.emoji} ${c.text}  _(${SKILL_META[c.skill].label}, pass: ${reward})_`;
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: optionLines } });
    blocks.push({
      type: "actions",
      block_id: "dungeon_trap",
      elements: choices.map((c, i) => ({
        type: "button",
        // action_id must be unique within the block — encode the index.
        action_id: `dungeon_choose_${i + 1}`,
        value: String(i + 1),
        text: { type: "plain_text", text: `${c.emoji} ${SKILL_META[c.skill].label}` },
      })),
    });
    const dmg = choices[0]?.fail_damage ?? 0;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_Roll 1d6 + matching-skill bonus, need 4+. Class skill = +2 to roll. Fail = take *${dmg}* HP._` }],
    });
    return blocks;
  }

  if (node.type === "lockbox") {
    // Tier-keyed banner — bronze/silver/gold each get their own cached image
    // so the chest visibly matches what the player needs to unlock it. Lazy:
    // first miss schedules gen, returns null, image appears next render.
    if (env && ctx) {
      const tier = node.lock_tier ?? "bronze";
      const lockKey = (`lockbox_${tier}`) as keyof typeof VIEW_ART_PROMPTS;
      const lockArt = await viewArt(env, ctx, lockKey);
      if (lockArt) {
        blocks.splice(1, 0, {
          type: "image",
          image_url: lockArt,
          alt_text: `the ${tier} chest`,
        });
      }
    }
    const opts = node.loot_options ?? [];
    const lockTier = node.lock_tier ?? "bronze";
    // Per-item: stat row + (optional) catalog-effect row. Same rationale as
    // the merchant view — without the blurb, tool/scroll items read as
    // misleading "X dmg" labels even when they heal or apply status effects.
    const optionLines = opts.flatMap((l, i) => {
      const power = powerLabel(l.item_type, l.power, l.name);
      const head = `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
      const effect = catalogEffectLine(l.name);
      return effect ? [head, `   ${effect}`] : [head];
    }).join("\n");
    const lockBadge = `${KEY_EMOJI[lockTier]} *${lockTier}* lock — needs ${KEY_EMOJI[lockTier]} ${lockTier}+ key.`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${lockBadge}\n${optionLines}` } });
    const skipNum = opts.length + 1;
    // Buttons name the item directly (so players don't have to cross-reference
    // numbers) AND show the key cost up front via the "🥉 →" prefix. action_id
    // remains uniquely indexed for Slack's per-block uniqueness rule.
    const buttons: unknown[] = opts.map((opt, i) => ({
      type: "button",
      action_id: `dungeon_choose_${i + 1}`,
      value: String(i + 1),
      text: { type: "plain_text", text: truncateForButton(`${KEY_EMOJI[lockTier]} → ${opt.name}`) },
      style: "primary",
    }));
    buttons.push({
      type: "button",
      action_id: `dungeon_choose_${skipNum}`,
      value: String(skipNum),
      text: { type: "plain_text", text: "👋 Walk past" },
    });
    blocks.push({ type: "actions", block_id: "dungeon_lockbox", elements: buttons });
    return blocks;
  }

  if (node.type === "npc") {
    // Per-encounter NPC portrait — pre-rendered at dungeon construction by
    // generateEncounterArt and stored on the NpcOffer. Old expeditions
    // (pre-Tier-3) don't have art_url; render falls through silently.
    if (node.npc?.art_url) {
      blocks.splice(1, 0, {
        type: "image",
        image_url: node.npc.art_url,
        alt_text: "the wandering figure",
      });
    }
    const item = node.npc?.item;
    const greeting = `> "${node.npc?.greeting ?? "..."}"`;
    let itemLine = "";
    if (item) {
      const power = powerLabel(item.item_type, item.power, item.name);
      const head = `\nOffers: ${RARITY_BADGE[item.rarity]} *${item.name}* — ${item.item_type}, ${power}`;
      const effect = catalogEffectLine(item.name);
      // Catalog effect (tool/scroll) on its own line so the mechanics are
      // clear before the player decides to trust the NPC.
      itemLine = effect ? `${head}\n   ${effect}` : head;
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${greeting}${itemLine}` } });
    blocks.push({
      type: "actions",
      block_id: "dungeon_npc",
      elements: [
        // action_id must be unique within the block — encode the index.
        { type: "button", action_id: "dungeon_choose_1", value: "1", text: { type: "plain_text", text: "🤝 Trust (take item)" }, style: "primary" },
        { type: "button", action_id: "dungeon_choose_2", value: "2", text: { type: "plain_text", text: "👋 Refuse" } },
      ],
    });
    return blocks;
  }

  if (node.type === "merchant") {
    // Per-encounter merchant portrait — pre-rendered at dungeon construction
    // by generateEncounterArt(kind="merchant"). Falls back to the singleton
    // merchant banner for old (pre-Tier-3) expeditions whose nodes don't
    // carry art_url.
    let merchantArt: string | null = node.npc?.art_url ?? null;
    if (!merchantArt && env && ctx) {
      merchantArt = await viewArt(env, ctx, "merchant");
    }
    if (merchantArt) {
      blocks.splice(1, 0, {
        type: "image",
        image_url: merchantArt,
        alt_text: "the merchant's stall",
      });
    }
    const stock = node.loot_options ?? [];
    const greeting = `> "${node.npc?.greeting ?? "..."}"`;
    // Per-item: stat row + (optional) catalog-effect row. Catalog items
    // (tool/scroll) have hand-curated blurbs that explain mechanics — without
    // them, "Espresso Shot — tool, 4 dmg" is actively misleading (it heals,
    // doesn't deal damage). The blurb is what makes "do I want this?"
    // answerable at a glance.
    const stockLines = stock.flatMap((l, i) => {
      const power = powerLabel(l.item_type, l.power, l.name);
      const price = merchantPrice(l.item_type, l.rarity);
      const head = `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power} • *${price}g*`;
      const effect = catalogEffectLine(l.name);
      return effect ? [head, `   ${effect}`] : [head];
    }).join("\n");
    const noteParts = stock.length === 0
      ? `_The merchant's stall is empty — you bought everything good._`
      : `${greeting}\n${stockLines}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: noteParts } });
    const skipNum = stock.length + 1;
    // Buttons name the item directly + lead with the gold cost so the player
    // sees what they're buying before they click. Shorter names fit fine;
    // long ones get truncated with an ellipsis.
    const elements: unknown[] = stock.map((l, i) => ({
      type: "button",
      action_id: `dungeon_choose_${i + 1}`,
      value: String(i + 1),
      text: { type: "plain_text", text: truncateForButton(`💰 ${merchantPrice(l.item_type, l.rarity)}g — ${l.name}`) },
      style: "primary",
    }));
    elements.push({
      type: "button",
      action_id: `dungeon_choose_${skipNum}`,
      value: String(skipNum),
      text: { type: "plain_text", text: "👋 Walk past" },
    });
    blocks.push({ type: "actions", block_id: "dungeon_merchant", elements });
    // Staples — same always-in-stock potions the channel shop carries.
    // Rendered as a sub-section so mid-dungeon players can recharge without
    // leaving the run.
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🧺 Always in stock* — fixed prices, no purchase cap.` },
    });
    for (const s of STAPLES) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${s.emoji} *${s.name}* — ${s.blurb} • *${s.price}g*` },
        accessory: {
          type: "button",
          action_id: `staple_buy_${s.id}`,
          value: s.id,
          text: { type: "plain_text", text: `🛍️ Buy ${s.price}g` },
        },
      });
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_Stock is gone once you walk past. Staples (potions) are always available — purchase via the buttons above or \`${cmd} buy <staple>\`._` }],
    });
    return blocks;
  }

  // treasure — final dungeon room. Add a banner image so the payoff has the
  // same visual weight as the lockbox/merchant/shop surfaces.
  if (env && ctx) {
    const treasureArt = await viewArt(env, ctx, "treasure");
    if (treasureArt) {
      blocks.splice(1, 0, {
        type: "image",
        image_url: treasureArt,
        alt_text: "the open treasure chest",
      });
    }
  }
  const opts = node.loot_options ?? [];
  // Per-item: stat row + (optional) catalog-effect row. Same rationale as
  // the merchant/lockbox views.
  const optionLines = opts.flatMap((l, i) => {
    const power = powerLabel(l.item_type, l.power, l.name);
    const head = `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
    const effect = catalogEffectLine(l.name);
    return effect ? [head, `   ${effect}`] : [head];
  }).join("\n");
  blocks.push({ type: "section", text: { type: "mrkdwn", text: optionLines } });
  blocks.push({
    type: "actions",
    block_id: "dungeon_treasure",
    // Buttons name the item directly so players don't have to cross-reference
    // the row numbers in the section above. Treasure is free (no cost prefix).
    elements: opts.map((opt, i) => ({
      type: "button",
      action_id: `dungeon_take_${i + 1}`,
      value: String(i + 1),
      text: { type: "plain_text", text: truncateForButton(`🎁 ${opt.name}`) },
      style: "primary",
    })),
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_First \`${cmd} take <n>\` claims for the party._` }],
  });
  return blocks;
}

// Block Kit version of renderDoorPrompt — door buttons labeled with the room
// type behind each (so the player can see what they're picking).
function buildDoorPromptBlocks(exp: ExpeditionState, cmd: string): unknown[] {
  const doors = exp.pending_doors ?? [];
  const visited = exp.visited_count ?? 1;
  const middleTotal = dungeonRoomTotal(exp.middle_count ?? 0);
  const isSingle = doors.length === 1;
  const isSubBossAhead = isSingle && doors[0] === exp.nodes.length - 2;

  const headline = isSubBossAhead
    ? `*👑 The way opens to the sub-boss chamber* — Room ${visited + 1}/${middleTotal}.`
    : isSingle
    ? `*🚪 One path forward* — Room ${visited + 1}/${middleTotal}. Catch your breath.`
    : `*🚪 Two paths diverge* — Room ${visited + 1}/${middleTotal} ahead.`;

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${headline}\n${renderPathTrail(exp)}` },
    },
    {
      type: "actions",
      block_id: "dungeon_door",
      elements: doors.map((idx, i) => {
        const node = exp.nodes[idx];
        // Single-option button label: "Continue" (instead of Door 1) since
        // there's no real choice. Sub-boss gets its own framing.
        const text = isSingle
          ? (isSubBossAhead
            ? `👑 Continue to sub-boss`
            : `🚪 Continue: ${dungeonRoomLabel(node.type)}`)
          : `🧭 ${["N", "E", "S", "W"][i] ?? i + 1}: ${dungeonRoomLabel(node.type)}`;
        return {
          type: "button",
          // action_id must be unique within the block — encode the index.
          action_id: `dungeon_choose_${i + 1}`,
          value: String(i + 1),
          text: { type: "plain_text", text },
        };
      }),
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: isSingle
        ? `_\`${cmd} rest\` to short-rest first (HP + mana). \`${cmd} choose 1\` to advance. \`${cmd} look\` to re-show this prompt._`
        : `_First \`${cmd} choose <n>\` picks for the party. \`${cmd} rest\` to short-rest first. \`${cmd} look\` to re-show this prompt._`,
      }],
    },
  ];
  return blocks;
}

type CombatAction = "attack" | "cast" | "flee" | "signature";

// Upserts the pinned-battlefield message in the quest thread. First call
// (no battlefield_ts yet) does chat.postMessage and persists the new ts
// onto the quests row; subsequent calls do chat.update against that ts.
// Best-effort — a failure here logs a warning but doesn't fail the turn.
//
// Why a pinned message: each engine turn would otherwise post a fresh
// "current state" block to the thread, drowning the narrative. With a
// pinned message, spectators see the LATEST state in one place; the
// turn-summary thread replies become a scrollback log of what just
// happened. Mirrors the web client's two-pane "live view + log" split.
async function upsertBattlefield(
  env: Env,
  quest: ActiveQuest,
  state: import("@gantt-quest/core").CombatState,
): Promise<void> {
  const blocks = renderBattlefieldBlocks(state, quest.id);
  const m0 = state.monsters[0];
  const fallbackText = m0 ? `Battlefield: ${m0.name} (${m0.hp}/${m0.max_hp} HP)` : `Battlefield`;
  try {
    if (quest.battlefield_ts) {
      const res = await updateMessage(env.SLACK_BOT_TOKEN, {
        channel: quest.channel_id,
        ts: quest.battlefield_ts,
        text: fallbackText,
        blocks,
      });
      if (!res.ok) {
        // Stale ts (message deleted by an admin, etc.) — fall back to a
        // new post and re-store. Single retry; if that fails too, give up.
        const post = await postMessage(env.SLACK_BOT_TOKEN, {
          channel: quest.channel_id,
          thread_ts: quest.thread_ts,
          text: fallbackText,
          blocks,
        });
        if (post.ok && post.ts) {
          await setBattlefieldTs(env.DB, quest.id, post.ts);
        }
      }
    } else {
      const post = await postMessage(env.SLACK_BOT_TOKEN, {
        channel: quest.channel_id,
        thread_ts: quest.thread_ts,
        text: fallbackText,
        blocks,
      });
      if (post.ok && post.ts) {
        await setBattlefieldTs(env.DB, quest.id, post.ts);
      }
    }
  } catch (err) {
    console.warn("upsertBattlefield failed", err);
  }
}

// Sends a turn notification to the next human actor after a turn advances.
// Reads the actor's notification_pref from DB: "thread" broadcasts an @mention
// to the quest thread (reply_broadcast: true = shows in channel), "dm" sends a
// direct message instead. Skips monster actors and terminal combat states.
async function dispatchTurnNotification(
  env: Env,
  quest: ActiveQuest,
  status: string,
  events: CombatEvent[],
): Promise<void> {
  if (status !== "active") return;
  const turnStart = events.find(
    (e): e is Extract<CombatEvent, { type: "turn_start" }> =>
      e.type === "turn_start" && !isMonsterActor(e.actor),
  );
  if (!turnStart) return;
  const actorChar = await getCharacter(env.DB, turnStart.actor);
  if (actorChar?.notification_pref === "dm") {
    await sendDM(env.SLACK_BOT_TOKEN, turnStart.actor, `⚔️ It's your turn in the quest!`);
  } else {
    await postToThread(env, quest, `<@${turnStart.actor}> it's your turn!`, { broadcast: true });
  }
}

// Engine-driven combat dispatcher. Translates a Slack `(payload, action)`
// pair into a TurnAction, calls QuestRoom.serverAction over RPC, posts
// the resulting CombatEvent[] as a thread reply via renderTurnToThread,
// and upserts the pinned battlefield message via chat.update. Drink-buff
// consumption + AI flavor fanout to the Slack thread run server-side
// inside the DO, so they reach this path automatically.
//
// Gated on env.LEGACY_SLACK_COMBAT — handleCombat reads the toggle at its
// top and routes here only when the operator has flipped to the engine
// path (default stays legacy). When the toggle is on but the cross-bound
// QUEST_ROOM binding is missing (e.g. local dev without the wrangler
// redeploy), we surface an operator-facing ephemeral instead of falling
// through silently so the misconfiguration is visible.
//
// Still missing (follow-up PR — tracked in the unification plan):
//   - /gq heal, /gq shield, /gq position, /gq mark, /gq wait, /gq ability
//     slash commands. Engine supports each TurnAction kind; the Slack
//     dispatch layer just doesn't expose them yet.
//   - Heal / migrate target-picker ephemerals (engine needs target id).
async function handleCombatViaEngine(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  action: CombatAction,
  targetArg?: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't act. Recover, then try again.");
  }

  let quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return (await lobbyGuard(env.DB, payload.user_id)) ?? ephemeral(`You're not on an active quest. Try \`${payload.command} quest\` or \`${payload.command} join\`.`);
  if (quest.channel_id !== payload.channel_id) {
    return ephemeral(`Your active quest is in <#${quest.channel_id}>.`);
  }

  const doId = questRoomId(env, quest.id);
  if (!doId || !env.QUEST_ROOM) {
    // Engine path requires the cross-bound DO binding. If it's missing we
    // refuse to fall through silently — the operator turned the toggle on
    // deliberately, so an ephemeral surfaces what's wrong.
    return ephemeral(
      "⚠️ Engine combat is enabled but QUEST_ROOM binding is missing — redeploy the slack worker with the web worker's script_name.",
    );
  }
  // Cast to QuestRoomStub — we're cross-binding a DO that lives in apps/web
  // and the runtime returns an opaque stub. Type-only assertion; no runtime
  // cost. The two methods we call (bootstrapFromSlack, serverAction) are
  // declared on QuestRoomStub in apps/slack/src/index.ts.
  const stub = env.QUEST_ROOM.get(doId) as unknown as QuestRoomStub;

  // Idempotent: bootstrapFromSlack returns the existing state if combat
  // already started (via web `/api/quest/:id/start_web_combat`); otherwise
  // it builds CombatInit from D1, runs step({kind: "begin"}), persists,
  // and returns the begun state. `created: true` means initiative was
  // just rolled — we surface that as a kickoff thread post so spectators
  // see the transition from legacy → engine combat. Non-combat dungeon
  // rooms bail with a clear error.
  const boot = await stub.bootstrapFromSlack(quest.id);
  if (!boot.ok) {
    if (boot.reason === "non_combat_room") {
      return ephemeral(
        `Not in combat right now (${boot.detail ?? "unknown"} room). Try \`${payload.command} choose\` or \`${payload.command} take\`.`,
      );
    }
    return ephemeral(`Can't start combat: ${boot.reason}${boot.detail ? ` (${boot.detail})` : ""}.`);
  }
  if (boot.created) {
    await postToThread(env, quest, "🎲 *Initiative rolled.* Turn-based combat begins.");
    // Also render the begin events (initiative reveal + first turn_start)
    // as their own thread post so the order is visible to spectators.
    const beginText = renderTurnToThread(boot.state, boot.events);
    if (beginText) {
      await postToThread(env, quest, beginText);
    }
    ctx.waitUntil(dispatchTurnNotification(env, quest, boot.state.status, boot.events).catch(console.warn));
    // Drop the pinned battlefield into the thread on first action. From
    // here on it's chat.update'd in place per turn.
    await upsertBattlefield(env, quest, boot.state);
    // upsertBattlefield wrote battlefield_ts to D1; re-read it so the
    // next branch (post-action update) hits chat.update on the just-posted
    // message instead of trying to post a second pinned block.
    const refreshed = await getActiveQuestForCharacter(env.DB, payload.user_id);
    if (refreshed) quest = refreshed;
  }

  // Resolve target_id for multi-monster combat. `/gq attack 2` picks the
  // monster at 1-based index; without an arg, auto-pick the lowest-HP live
  // monster (consistent with the engine's existing pickMonsterTarget).
  let targetId: string | undefined;
  if (action === "attack" || action === "cast" || action === "signature") {
    const monsters = boot.state.monsters ?? [];
    const live = monsters.filter((m) => m.hp > 0);
    if (live.length > 1) {
      const idx = targetArg ? parseInt(targetArg, 10) - 1 : -1;
      const picked = idx >= 0 && idx < monsters.length && monsters[idx].hp > 0
        ? monsters[idx]
        : live.reduce((a, b) => (a.hp <= b.hp ? a : b));
      targetId = picked.id ?? undefined;
    }
  }

  const turnAction: TurnAction =
    action === "attack" ? { kind: "attack", actor: payload.user_id, target_id: targetId }
    : action === "cast" ? { kind: "cast", actor: payload.user_id, target_id: targetId }
    : action === "signature" ? { kind: "signature", actor: payload.user_id, target_id: targetId }
    : { kind: "flee", actor: payload.user_id };

  const result = await stub.serverAction(quest.id, turnAction);
  if (!result.ok) {
    return ephemeral(`Can't act: ${result.reason}.`);
  }

  // Engine rejection events surface as ephemeral feedback (e.g. "not your
  // turn") without being posted to the thread. Detect via a `rejected`
  // event in the returned stream when the state didn't advance.
  const rejection = result.events.find((e) => e.type === "rejected");
  if (rejection && rejection.type === "rejected") {
    return ephemeral(`⏳ ${rejection.reason}`);
  }

  const turnText = renderTurnToThread(result.state, result.events);
  if (turnText) {
    await postToThread(env, quest, turnText);
  }
  ctx.waitUntil(dispatchTurnNotification(env, quest, result.state.status, result.events).catch(console.warn));

  // Update the pinned battlefield with the post-turn state. chat.update is
  // ~1/sec per channel — well under that since each Slack turn is gated on
  // a slash command or button click. Skip when combat ended (victory/defeat/
  // fled) so the final state stays visible without a stale button row.
  if (result.state.status === "active") {
    await upsertBattlefield(env, quest, result.state);
  }

  return ephemeral("✅ Action resolved.");
}

async function handleCombat(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  action: CombatAction,
  targetArg?: string,
): Promise<CommandResponse> {
  // Engine path opt-in. Default keeps legacy cooldown-paced combat live
  // until the engine path is verified end-to-end in dev. See the LEGACY_
  // SLACK_COMBAT comment in apps/slack/src/index.ts for the toggle.
  if (env.LEGACY_SLACK_COMBAT === "0") {
    return handleCombatViaEngine(payload, env, ctx, action, targetArg);
  }

  let character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't act. Recover, then try again.");
  }

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return (await lobbyGuard(env.DB, payload.user_id)) ?? ephemeral(`You're not on an active quest. Try \`${payload.command} quest\` or \`${payload.command} join\`.`);

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  const party = await getQuestParty(env.DB, quest.id);
  const fighters = party.filter(isFighter);

  // Equipment loaded once for both attack/cast and flee paths (failed flee takes a hit too).
  const slots = await getAllEquippedSlots(env.DB, payload.user_id);
  const equippedWeapon = slots.main_hand;
  const equippedArmor = slots.body;

  // STATS_V2: derive attack/magic mods from primary stats + equip bonuses.
  const statsV2Enabled = env.STATS_V2 === "1";
  const equipBonuses: Partial<Record<string, number>> = {};
  if (statsV2Enabled) {
    for (const item of Object.values(slots)) {
      if (!item?.stat_bonus) continue;
      for (const [key, val] of Object.entries(item.stat_bonus)) {
        equipBonuses[key] = (equipBonuses[key] ?? 0) + val;
      }
    }
  }
  const snap = statSnapshot({
    className: character.class,
    level: character.level,
    stats: { str: character.str, int_stat: character.int_stat, vit: character.vit, agi: character.agi, dex: character.dex },
    v2Enabled: statsV2Enabled,
    equipBonuses: statsV2Enabled ? (equipBonuses as Partial<Stats>) : undefined,
  });
  const levelBonus = statsV2Enabled ? 0 : Math.floor(character.level / 4);
  const attackMod = snap.derived.attack_mod + levelBonus;
  const magicMod = snap.derived.magic_mod + levelBonus;

  if (action === "flee") {
    if (quest.scene.variant === "gauntlet" || quest.scene.variant === "dungeon") {
      return ephemeral("🚪 No exit on this quest type — kill or be killed.");
    }
    return resolveFlee(payload, env, ctx, character, quest, fighters, equippedArmor);
  }

  // Expedition: only allow attack/cast in combat rooms. Other rooms use /sq choose
  // (trap, lockbox, npc) or /sq take (treasure).
  if (quest.scene.variant === "dungeon") {
    const node = currentExpNode(quest);
    if (!node || node.type !== "combat") {
      const nextStep =
        node?.type === "treasure" ? `Try \`${payload.command} take <n>\`.` :
        node ? `Try \`${payload.command} choose <n>\`.` :
        "Quest not progressed.";
      return ephemeral(`Not in combat right now. ${nextStep}`);
    }
  }

  // Back-row melee restriction only applies in a party — solo fights have no
  // positioning concept (one fighter, one target). Ranged AND focus weapons
  // both pass the back-row check (focus channels at any distance — the lack
  // of damage bonus is the trade-off, not a positioning restriction).
  if (action === "attack" && character.position === "back" && fighters.length > 1) {
    const range = equippedWeapon?.weapon_range ?? "melee";
    const canShootFromBack = range === "ranged" || range === "focus";
    if (!canShootFromBack) {
      return ephemeral(
        `🏹 Back row can't melee — equip a *ranged* or *focus* weapon to attack from here, or \`${payload.command} cast\` / \`${payload.command} signature\`, or \`${payload.command} position front\`.`,
      );
    }
  }

  // attack | cast | signature — compute damage + the player-line. Signature has its
  // own formula per class and costs 1 mana (deducted post-success below).
  const cls = classByName(character.class);
  let damage: number;
  let isCrit: boolean;
  let playerLine: string;
  let signatureName: string | null = null;
  let manaCost = 0;

  // Class-passive tracking. Each passive that fires this turn records itself
  // here so the post-turn scene write can mark all triggers in one atomic
  // update (rather than each passive racing its own write). `passiveLines`
  // collects user-facing strings describing what fired, surfaced alongside
  // the combat narration.
  const passiveTriggers: { userId: string; key: string }[] = [];
  const passiveLines: string[] = [];

  // 🛡 SRE Warden passive: on the first action of each fight, gain a small
  // starting shield. Models "the Warden hardens up the moment the fight
  // begins" without requiring a separate prep command. Granted before
  // damage is computed so it stacks with any incoming retaliation this
  // same turn. Only fires once per scene per Warden.
  if (cls.id === "sre_warden" && !isPassiveUsed(quest.scene, payload.user_id, PASSIVE_WARDEN_SHIELD)) {
    const cap = character.max_hp * SHIELD_CAP_MULTIPLIER;
    const added = await addShield(env.DB, character, WARDEN_STARTING_SHIELD, cap);
    if (added > 0) {
      character = { ...character, shield: character.shield + added };
      passiveTriggers.push({ userId: payload.user_id, key: PASSIVE_WARDEN_SHIELD });
      passiveLines.push(`🛡 *SRE Warden* passive: hardens up — gains 🛡${added} shield.`);
    } else {
      // Shield already at cap — mark the passive used anyway so the message
      // doesn't keep appearing every action.
      passiveTriggers.push({ userId: payload.user_id, key: PASSIVE_WARDEN_SHIELD });
    }
  }

  if (action === "signature") {
    const sig = signatureFor(character.class);
    if (!sig) return ephemeral("Your class has no signature ability.");
    if (character.mana < 1) {
      return ephemeral(
        `Out of mana — \`${payload.command} signature\` refills between quests. (${character.mana}/${character.max_mana})`,
      );
    }

    // SRE Warden's Bulwark Strike folds equipped armor into the "weapon" slot of
    // the signature formula — armor power becomes its own attack stat. Focus
    // weapons contribute ZERO to damage signatures — their power is for /sq
    // heal + /sq shield. The caster gets the support tradeoff in exchange for
    // a weaker sig.
    const isFocus = (equippedWeapon?.weapon_range ?? "melee") === "focus";
    const wpnPower = isFocus ? 0 : (equippedWeapon?.power ?? 0);
    const armorPower = equippedArmor?.power ?? 0;
    const sigWpn = cls.id === "sre_warden" ? wpnPower + armorPower : wpnPower;

    const sigResult = resolveSignature(
      cls.id,
      attackMod,
      magicMod,
      sigWpn,
      quest.scene.tier,
      fighters.length,
      quest.scene.monster_max_hp,
      rollDice,
    );

    damage = sigResult.damage;
    isCrit = false;
    signatureName = sig.name;
    manaCost = 1;

    // Backstab auto-crits when the monster is already weakened. Doubles damage.
    if (cls.id === "refactor_rogue" && quest.scene.monster_hp <= quest.scene.monster_max_hp / 2) {
      damage = damage * 2;
      isCrit = true;
    }

    // 🧙 DevOps Mage passive: first signature each fight is free (0 mana).
    // Lets a Mage open a fight with a sig without burning their tiny mana
    // pool, leaving the rest available for cast/heal/shield/follow-up sigs.
    if (cls.id === "devops_mage" && !isPassiveUsed(quest.scene, payload.user_id, PASSIVE_MAGE_FREE_SIG)) {
      manaCost = 0;
      passiveTriggers.push({ userId: payload.user_id, key: PASSIVE_MAGE_FREE_SIG });
      passiveLines.push(`🧙 *DevOps Mage* passive: first signature free.`);
    }

    playerLine = isCrit
      ? `💥 *${sig.name} CRIT!* <@${payload.user_id}> hits for *${damage}* \`${sigResult.formula} ×2\`.`
      : `✨ *${sig.name}* — <@${payload.user_id}> hits for *${damage}* \`${sigResult.formula}\`.`;
  } else {
    const isMagic = action === "cast";
    const classMod = isMagic ? magicMod : attackMod;
    // Focus weapons add zero to attack + cast damage (their power is a
    // /sq heal + /sq shield bonus instead — applied in those handlers).
    // Regular weapons add their power as usual.
    const isFocus = (equippedWeapon?.weapon_range ?? "melee") === "focus";
    const weaponMod = isFocus ? 0 : (equippedWeapon?.power ?? 0);
    const verb = isMagic ? "casts" : "attacks";

    const hit = resolvePlayerHit(action, classMod, weaponMod, rollDice);
    damage = hit.damage;
    isCrit = hit.isCrit;

    // ⚡ Battle Elixir — Empowered: +25% damage for N turns.
    if (character.effects.some((e) => e.type === "empowered")) {
      damage = Math.round(damage * 1.25);
    }

    // 🗡 Refactor Rogue passive: first attack each fight is a guaranteed crit
    // (doubles the (roll + mods) total). Only fires for `attack`, not `cast`
    // — the Rogue's identity is the dagger-strike opener. If the natural
    // roll was already a crit we don't burn the passive on a redundant
    // upgrade.
    if (cls.id === "refactor_rogue" && action === "attack" && !isCrit
        && !isPassiveUsed(quest.scene, payload.user_id, PASSIVE_ROGUE_FIRST_CRIT)) {
      isCrit = true;
      damage = damage * 2;
      passiveTriggers.push({ userId: payload.user_id, key: PASSIVE_ROGUE_FIRST_CRIT });
      passiveLines.push(`🗡 *Refactor Rogue* passive: first-strike crit.`);
    }

    const modBreakdown = weaponMod > 0 ? `${classMod}+${weaponMod}` : `${hit.totalMod}`;
    // Crit doubles the WHOLE total: (roll + mods) × 2. The display reflects the
    // formula's actual associativity — wrapping the sum in parens — so the math
    // is reproducible from the breakdown.
    playerLine = isCrit
      ? `💥 *CRIT!* <@${payload.user_id}> ${verb} for *${damage}* \`(${hit.roll} + ${modBreakdown})×2\`.`
      : `<@${payload.user_id}> ${verb} for *${damage}* \`${hit.roll} + ${modBreakdown}\`.`;
  }

  // Focus-fire bonus. When another partymate has marked the current monster,
  // attacks from anyone OTHER than the marker get a +2 damage bonus until the
  // mark expires. Marker doesn't get the bonus themselves — the mechanic is
  // about calling targets for the rest of the party, not self-buffing.
  // Bonus stacks on top of base damage (including crit doubling already
  // applied above). Mark fizzles on monster death (cleared on transition)
  // and on expiry.
  let focusFireBonus = 0;
  const mark = getActiveMark(quest.scene);
  if (mark && mark.marked_by !== payload.user_id) {
    focusFireBonus = FOCUS_FIRE_BONUS;
    damage += focusFireBonus;
    playerLine += ` 🎯 *+${focusFireBonus}* focus-fire (marked by <@${mark.marked_by}>).`;
  }

  // 🍺 Pub drink buffs. Three drinks plug in here:
  //   - 🍺 Tavern Ale / 🍶 Aged Whiskey → buff_attack, applies on `attack` only
  //   - 🍷 Spiced Mead → buff_magic, applies on `cast` only
  //   - 💧 Lucky Sip → buff_next_crit, force-crits any damage action incl. sigs
  // Atk/mag buffs intentionally DON'T apply to signatures — sigs are already
  // class powerhouses, no need to compound. But Lucky Sip CAN crit a sig (the
  // "save it for the killing blow" play). Consumed when the buff actually
  // fired this turn — drinking an ale and then casting doesn't waste a charge.
  let drinkBuffConsumed = false;
  if (character.drink_buff && damage > 0) {
    const buff = character.drink_buff;
    const drink = findDrink(buff.drink_id);
    const drinkLabel = drink ? `${drink.emoji} ${drink.name}` : "drink";
    if (buff.kind === "buff_attack" && action === "attack") {
      damage += buff.magnitude;
      playerLine += ` ${drink?.emoji ?? "🍺"} *+${buff.magnitude}* ${drinkLabel}.`;
      drinkBuffConsumed = true;
    } else if (buff.kind === "buff_magic" && action === "cast") {
      damage += buff.magnitude;
      playerLine += ` ${drink?.emoji ?? "🍷"} *+${buff.magnitude}* ${drinkLabel}.`;
      drinkBuffConsumed = true;
    } else if (buff.kind === "buff_next_crit" && !isCrit) {
      isCrit = true;
      damage = damage * 2;
      playerLine += ` 💧 *Lucky Sip!* — guaranteed crit. Damage doubled to *${damage}*.`;
      drinkBuffConsumed = true;
    }
  }

  // 🎵 Frontend Bard aura: while a Bard is alive in the party, the other
  // fighters get +1 damage on attacks (not the Bard themselves — the Bard
  // is the singer, others are the warriors getting hyped). Always-on, no
  // per-fight state. Triggers only on actual hits (damage > 0) so a missed
  // cast doesn't get the +1.
  //
  // Battle Hymn (Bard active ability) boosts the aura from +1 to +3 for the
  // next N partymate attacks. We consume one hymn charge per non-Bard hit
  // and write the decrement back to scene.ability_state.
  let hymnChargeConsumed = false;
  if (damage > 0 && cls.id !== "frontend_bard") {
    const auraBard = fighters.find((f) =>
      f.slack_user_id !== payload.user_id
      && classByName(f.class).id === "frontend_bard",
    );
    if (auraBard) {
      const hymnCharges = quest.scene.ability_state?.battle_hymn ?? 0;
      const auraAmount = hymnCharges > 0 ? BARD_AURA_HYMN_DAMAGE : BARD_AURA_DAMAGE;
      damage += auraAmount;
      const flavor = hymnCharges > 0 ? `🎶 *+${auraAmount}* hymn-charged aura` : `🎵 *+${auraAmount}* bardic aura`;
      playerLine += ` ${flavor} (<@${auraBard.slack_user_id}>).`;
      if (hymnCharges > 0) hymnChargeConsumed = true;
    }
  }

  // Tick monster's status effects (e.g. poison) — applied alongside the player's
  // damage in the same atomic write. Effects with `remaining > 0` after this tick
  // are kept on the new scene; expired effects are dropped.
  const monsterTick = tickEffects(quest.scene.monster_effects ?? []);
  const monsterEffectLines: string[] = monsterTick.ticked.map((e) => {
    const meta = EFFECT_META[e.type];
    const sign = meta.kind === "buff" ? "+" : "-";
    return `${meta.emoji} ${quest.scene.monster_name} ${meta.name.toLowerCase()} ticks ${sign}${e.magnitude} HP.`;
  });
  // Physical attacks (attack) deplete the monster's armor pool before HP.
  // Cast and signatures bypass armor entirely.
  const monsterArmorMax = quest.scene.tier;
  const monsterArmorCurrent = quest.scene.monster_armor ?? monsterArmorMax;
  const isPhysicalHit = action === "attack";
  const monsterArmorAbsorbed = isPhysicalHit ? Math.min(monsterArmorCurrent, damage) : 0;
  const monsterArmorAfter = monsterArmorCurrent - monsterArmorAbsorbed;
  const hpDamageFromPlayer = damage - monsterArmorAbsorbed;

  const newMonsterHp = quest.scene.monster_hp - hpDamageFromPlayer + monsterTick.hpDelta;
  const willKill = newMonsterHp <= 0;

  if (monsterArmorAbsorbed > 0) {
    const remaining = monsterArmorAfter > 0 ? ` (${monsterArmorAfter} armor left)` : " — *armor broken!*";
    playerLine += ` 🛡 *${monsterArmorAbsorbed}* blocked by armor${remaining}.`;
  }

  // 💀 Data Warlock passive: every crit attack/cast applies a 2-turn bleed
  // on the monster. Always-on (no per-fight state). Stacks with other status
  // effects via withEffectApplied (which dedupes by type and refreshes the
  // duration). Only fires on actual crits — natural rolls or boosted by
  // other passives like Rogue's first-strike.
  let monsterEffectsAfterTurn = monsterTick.next;
  if (isCrit && cls.id === "data_warlock") {
    const bleed: StatusEffect = {
      type: "bleeding",
      magnitude: WARLOCK_BLEED_MAGNITUDE,
      remaining: WARLOCK_BLEED_DURATION,
      source: "Data Wizard crit",
    };
    monsterEffectsAfterTurn = withEffectApplied(monsterEffectsAfterTurn, bleed);
    passiveLines.push(`💀 *Data Wizard* passive: critical strike inflicts 🩸 *Bleeding* (${WARLOCK_BLEED_MAGNITUDE}/turn × ${WARLOCK_BLEED_DURATION}).`);
  }

  // Boss phase 1 → 2 transition: crossing the 50% HP threshold powers it up.
  // Bake the flag into the scene so the same atomic write applies HP + phase together.
  let updatedScene: SceneJson = {
    ...quest.scene,
    monster_hp: Math.max(0, newMonsterHp),
    monster_armor: monsterArmorAfter,
    monster_effects: monsterEffectsAfterTurn,
  };
  // Fold any passive triggers from this turn into the scene write so the
  // once-per-fight flags persist atomically with the rest of the state.
  for (const t of passiveTriggers) {
    updatedScene = withPassiveUsed(updatedScene, t.userId, t.key);
  }
  // 🎶 Battle Hymn charge consumption — bake the decrement into the same
  // atomic write so we don't double-spend a charge if two attacks race.
  if (hymnChargeConsumed) {
    const prevState = updatedScene.ability_state ?? {};
    const remaining = (prevState.battle_hymn ?? 1) - 1;
    const nextAbilityState: NonNullable<SceneJson["ability_state"]> = { ...prevState };
    if (remaining > 0) nextAbilityState.battle_hymn = remaining;
    else delete nextAbilityState.battle_hymn;
    updatedScene.ability_state = Object.keys(nextAbilityState).length > 0 ? nextAbilityState : undefined;
  }
  let bossPhaseTransition = false;
  if (
    !willKill &&
    quest.scene.variant === "boss" &&
    quest.scene.boss_phase === 1 &&
    isBossPhaseTransition(quest.scene.monster_max_hp, quest.scene.monster_hp, newMonsterHp)
  ) {
    bossPhaseTransition = true;
    updatedScene.boss_phase = 2;
    updatedScene.monster_armor = quest.scene.tier; // boss hardens: armor refills in phase 2
  }

  // Atomic write: only proceed if monster_hp hasn't moved since we read it. Two
  // simultaneous attacks racing on the same HP value would otherwise lose one
  // player's damage. Loser of the race retries instead of having work erased.
  const won = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!won) {
    return ephemeral(
      "⏱️ The fight moved on while you were swinging. Try again — your cooldown wasn't consumed.",
    );
  }

  // Phase-2 portrait swap. Fired after the conditional write succeeds so we
  // know the transition is real. Gen runs in the background via waitUntil;
  // when it finishes, patchMonsterArtUrl writes ONLY the art_url field via
  // json_set — safe even if combat has moved on, since we're not stomping
  // the rest of the scene. Players see the wounded portrait on the next
  // combat round (the immediate "phase 2!" thread post still uses the
  // phase-1 art, which is fine — they're transitioning, not transitioned).
  if (bossPhaseTransition) {
    const artTarget = artTargetFromEnv(env);
    if (artTarget) {
      const monsterName = quest.scene.monster_name;
      const questId = quest.id;
      ctx.waitUntil((async () => {
        const newUrl = await generateMonsterArtPhase2(env.AI, artTarget, monsterName);
        if (newUrl) {
          await patchMonsterArtUrl(env.DB, questId, newUrl);
        }
      })());
    }
  }

  if (manaCost > 0) {
    // Mana deduct is conditional too — covers the (rare) case where a player races
    // two simultaneous signatures with mana=1. Loser gets the mana refund implicitly
    // by failing the WHERE clause; the scene update has already landed for them which
    // means the damage applied — small inconsistency, accepted for v1.
    await tryDeductMana(env.DB, payload.user_id, manaCost);
  }
  await appendLog(env.DB, quest.id, payload.user_id, action, `${damage} dmg${willKill ? " (kill)" : ""}`);

  // 🍺 Drink buff tick. Only fires when the buff actually applied this turn
  // (drinkBuffConsumed flag set during damage calc). Otherwise the buff sits
  // unspent — drinking an ale and then casting doesn't waste a charge.
  // tickDrinkBuff decrements remaining; clears the buff entirely when it
  // hits zero. Returns the post-tick buff so we can flavor the expiry.
  if (drinkBuffConsumed && character.drink_buff) {
    const post = await tickDrinkBuff(env.DB, payload.user_id);
    if (!post) {
      const drink = findDrink(character.drink_buff.drink_id);
      passiveLines.push(`${drink?.emoji ?? "🍺"} *${drink?.name ?? "Drink"}* wears off.`);
    }
  }

  // Tick the actor's own status effects + fold in any newly-applied effects from
  // this action (e.g. boss phase 2 transition applies burning).
  const newlyApplied: StatusEffect[] = [];
  if (bossPhaseTransition) {
    newlyApplied.push({
      type: "burning",
      magnitude: 3,
      remaining: 3,
      source: `${quest.scene.monster_name} phase 2`,
    });
  }
  const tickResult = await applyPlayerTick(env, payload.user_id, character, newlyApplied);
  const playerTickLines = tickResult.tickLines;
  const newEffectLines = tickResult.newLines;
  let postTickHp = tickResult.postTickHp;

  // Death-after-success clamp: if the player's tick would kill them ON THE SAME
  // action that delivered a kill blow, clamp to 1 HP so the win still registers.
  // "Collapses to one knee but the boss is down." Subsequent ticks (or the next
  // monster's swing) can still kill them — but the quest gets credit for the kill.
  if (postTickHp <= 0 && willKill) {
    await setCharacterHp(env.DB, payload.user_id, 1);
    postTickHp = 1;
    playerTickLines.push(`💪 <@${payload.user_id}> drops to one knee but the kill stands — clamped to 1 HP.`);
  } else if (postTickHp <= 0) {
    // DoT tick killed the actor without a kill blow — standard death path.
    return resolveDeath(payload, env, ctx, character, quest, fighters, [
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
    ]);
  }
  // Update the in-memory character so downstream code (monster turn target HP,
  // ephemeral stat lines) sees the post-tick HP.
  character = { ...tickResult.character, hp: postTickHp };

  if (willKill) {
    // Gauntlet: advance to next wave instead of triggering victory.
    if (quest.scene.variant === "gauntlet" && quest.scene.upcoming_waves && quest.scene.upcoming_waves.length > 0) {
      return resolveGauntletAdvance(payload, env, ctx, quest, [...passiveLines, playerLine, ...monsterEffectLines, ...playerTickLines, ...newEffectLines, `🏆 *${quest.scene.monster_name}* falls.`]);
    }
    // Graph dungeon: mark encounter cleared; boss kill → victory; other rooms → stay + look.
    if (quest.scene.variant === "dungeon" && quest.scene.graph) {
      return resolveGraphEncounterKill(payload, env, ctx, character, quest, fighters, [
        ...passiveLines, playerLine, ...monsterEffectLines, ...playerTickLines, ...newEffectLines,
        `🏆 *${quest.scene.monster_name}* falls.`,
      ]);
    }
    // Expedition (dungeon): branch on whether this was a mid-dungeon room or the
    // final sub-boss. The next room being treasure means we just killed the boss.
    if (quest.scene.variant === "dungeon") {
      const exp = quest.scene.expedition;
      const currentNode = exp?.nodes[exp.current];
      const preamble: string[] = [...passiveLines, playerLine, ...monsterEffectLines, ...playerTickLines, ...newEffectLines, `🏆 *${quest.scene.monster_name}* falls.`];
      // Drop a tiered key onto the killing player. Sub-boss drops silver, regular
      // combat rooms drop bronze. Legacy nodes (pre-tier rollout) default to bronze.
      if (currentNode?.drops_key) {
        const tier = currentNode.drops_key_tier ?? "bronze";
        await addCharacterKey(env.DB, payload.user_id, tier, 1);
        preamble.push(`${KEY_EMOJI[tier]} <@${payload.user_id}> picks up a *${tier}* key.`);
      }
      const nextNode = exp?.nodes[(exp?.current ?? 0) + 1];
      if (nextNode?.type === "treasure") {
        return resolveExpeditionToTreasure(payload, env, ctx, quest, preamble);
      }
      return advanceDungeonRoom(payload, env, ctx, quest, character, preamble);
    }
    return resolveVictory(payload, env, ctx, character, quest, fighters, [
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
      `🏆 *${quest.scene.monster_name}* falls.`,
    ]);
  }

  // Monster turn — see performMonsterTurn for targeting + damage logic.
  const isMagic = action === "cast";
  const turn = await performMonsterTurn(env, quest, fighters, character, equippedArmor);

  if (turn.isSplash && turn.splashTargets) {
    // Boss AoE splash — hits the whole non-vanished party.
    const preamble = [
      ...passiveLines,
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
    ];
    const firstKilled = turn.splashTargets.find((st) => st.willKill);
    if (firstKilled) {
      // Persist HP for non-killed targets first.
      for (const st of turn.splashTargets.filter((s) => !s.willKill)) {
        await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
      }
      await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
      return resolveDeath(payload, env, ctx, firstKilled.fighter, quest, fighters, [
        ...preamble,
        turn.monsterLine,
      ]);
    }
    for (const st of turn.splashTargets) {
      await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
    }
    await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
    await persistNextTelegraph(env, quest, fighters, turn);
    // Mana regen still happens after splash.
    let actorPostManaSplash = character.mana;
    if (manaCost === 0 && character.mana < character.max_mana) {
      const added = await addMana(env.DB, character, MANA_REGEN_PER_TURN);
      actorPostManaSplash = character.mana + added;
      if (added > 0) {
        passiveLines.push(`✨ <@${payload.user_id}> catches their breath — *+${added}* mana.`);
      }
    }
    const actorSplashSt = turn.splashTargets.find((st) => st.fighter.slack_user_id === character.slack_user_id);
    const updatedActorSplash: Character = actorSplashSt
      ? { ...character, hp: actorSplashSt.dmg.newHp, shield: actorSplashSt.dmg.newShield, mana: actorPostManaSplash }
      : { ...character, mana: actorPostManaSplash };
    const splashStatLines = turn.splashTargets
      .filter((st) => st.fighter.slack_user_id !== character.slack_user_id)
      .map((st) => {
        const sh = st.dmg.newShield > 0 ? ` 🛡${st.dmg.newShield}` : "";
        return `<@${st.fighter.slack_user_id}> (*${st.fighter.name}*): ${st.dmg.newHp}/${st.fighter.max_hp}${sh}`;
      });
    const actorShSplash = actorSplashSt && actorSplashSt.dmg.newShield > 0 ? ` 🛡${actorSplashSt.dmg.newShield}` : "";
    const ephemeralLinesSplash = [
      ...passiveLines,
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
      `*${quest.scene.monster_name}*: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp}`,
      turn.monsterLine,
      `*${updatedActorSplash.name}*: ${updatedActorSplash.hp}/${updatedActorSplash.max_hp}${actorShSplash}`,
      ...splashStatLines,
    ];
    ctx.waitUntil(postToThread(env, quest, ephemeralLinesSplash.join("\n")));
    return ephemeral(ephemeralLinesSplash.join("\n"));
  }

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [
      ...passiveLines,
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
      turn.monsterLine,
    ]);
  }

  // Containerize-skipped turns: don't persist HP/shield changes (there were
  // none) and don't log a "monster attack" event. The monsterLine still
  // describes the fizzle so the combat block reads coherently.
  if (!turn.skipped) {
    await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
    await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name} <@${turn.target.slack_user_id}>`);
  } else {
    await appendLog(env.DB, quest.id, "monster", "skip", `${quest.scene.monster_name} skipped`);
  }

  // ✨ QA Paladin passive: when an ally drops below 30% HP after a monster
  // swing, the first available Paladin in the party auto-heals them.
  // Once per fight per Paladin. Triggers on the actual hit target (not on
  // status-effect ticks) since this is "laying on hands the wounded ally"
  // not "ambient healing." Skipped swings never trigger this (no hit landed).
  let paladinPostHitHp = turn.dmg.newHp;
  if (!turn.skipped && turn.dmg.newHp > 0 && turn.dmg.newHp < turn.target.max_hp * PALADIN_AUTO_HEAL_THRESHOLD) {
    const paladin = fighters.find((f) =>
      classByName(f.class).id === "qa_paladin"
      && !isPassiveUsed(quest.scene, f.slack_user_id, PASSIVE_PALADIN_AUTO_HEAL)
    );
    if (paladin) {
      // healCharacter expects pre-state and returns the HP delta granted.
      // Snapshot the target post-hit so the cap math is correct, then add
      // the delta back to compute the new absolute HP.
      const postHitTarget = { ...turn.target, hp: turn.dmg.newHp } as Character;
      const healed = await healCharacter(env.DB, postHitTarget, PALADIN_AUTO_HEAL_AMOUNT);
      paladinPostHitHp = turn.dmg.newHp + healed;
      // Patch the passive flag onto the scene atomically (separate from the
      // main scene write, which already landed for the player's damage).
      const updatedPassives = withPassiveUsed(quest.scene, paladin.slack_user_id, PASSIVE_PALADIN_AUTO_HEAL).passives_used ?? {};
      try {
        await env.DB
          .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.passives_used', json(?)) WHERE id = ?")
          .bind(JSON.stringify(updatedPassives), quest.id)
          .run();
      } catch (err) {
        console.warn("paladin-passive:patch-error", { err: err instanceof Error ? err.message : String(err) });
      }
      await appendLog(env.DB, quest.id, paladin.slack_user_id, "heal", `+${healed} HP → ${turn.target.name}`);
      passiveLines.push(`✨ *QA Paladin* passive: <@${paladin.slack_user_id}> lays on hands — <@${turn.target.slack_user_id}> heals to *${paladinPostHitHp}* HP.`);
    }
  }
  // Returns the NEW telegraph target so we can render it in the combat
  // block — without this, the block would show the OLD telegraph (the one
  // baked into the in-memory quest.scene at handleCombat-start), one round
  // behind what actually got committed for the next swing.
  const nextTelegraph = await persistNextTelegraph(env, quest, fighters, turn);

  // Mana regen — the actor catches their breath after the monster's swing.
  // Skips if they spent mana this turn (signatures), so mana actions retain
  // their cost; basic attacks/casts refill steadily.
  let actorPostMana = character.mana;
  if (manaCost === 0 && character.mana < character.max_mana) {
    const added = await addMana(env.DB, character, MANA_REGEN_PER_TURN);
    actorPostMana = character.mana + added;
    if (added > 0) {
      passiveLines.push(`✨ <@${payload.user_id}> catches their breath — *+${added}* mana.`);
    }
  }

  const shieldDisplay = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  // Multi-party clarity: if the monster's retaliation hit a different party
  // member than the actor, tag that target with their @mention in the stat
  // line so it's unmistakable who took the damage.
  const targetStatLabel = turn.victimWasActor
    ? `*${turn.target.name}*`
    : `<@${turn.target.slack_user_id}> (*${turn.target.name}*)`;
  const ephemeralLines = [
    ...passiveLines,
    playerLine,
    ...monsterEffectLines,
    ...playerTickLines,
    ...newEffectLines,
    `*${quest.scene.monster_name}*: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp}`,
    turn.monsterLine,
    // No target stat on skipped swings — nobody got hit, so re-printing the
    // actor's HP line is just noise. The fizzle monsterLine already conveys
    // "the monster did nothing."
    ...(turn.skipped ? [] : [`${targetStatLabel}: ${paladinPostHitHp}/${turn.target.max_hp}${shieldDisplay}`]),
  ];

  // For the thread cards: show the actor (whose action this was). If they weren't the
  // target, their stats are unchanged from pre-turn — still informative.
  // paladinPostHitHp reflects any QA Paladin auto-heal that fired between
  // the hit landing and now. actorPostMana reflects the +1 regen if the
  // actor didn't spend mana this turn.
  const updatedActor: Character = turn.victimWasActor
    ? { ...character, hp: paladinPostHitHp, shield: turn.dmg.newShield, mana: actorPostMana }
    : { ...character, mana: actorPostMana };
  // For the thread post: when the monster hit a different partymate, build a
  // separate "target" character card so their post-hit HP shows publicly. The
  // ephemeral already includes the target stat line, but the thread (visible
  // to everyone) was only showing the actor's card. Skipped swings: no target
  // card — nobody was hit.
  const updatedTarget: Character | null = (turn.victimWasActor || turn.skipped)
    ? null
    : { ...turn.target, hp: paladinPostHitHp, shield: turn.dmg.newShield };

  const weaponName = equippedWeapon?.item_name;
  const armorName = equippedArmor?.item_name;
  ctx.waitUntil((async () => {
    const flavor = signatureName
      ? await flavorSignature(env.AI, character, quest.scene.monster_name, signatureName, isCrit, weaponName, armorName)
      : await flavorHit(env.AI, character, quest.scene.monster_name, isMagic ? "cast" : "attack", isCrit, weaponName, armorName);
    const marker = signatureName ? "✨ " : isCrit ? "💥 " : "";
    const phaseLine = bossPhaseTransition
      ? `\n\n👑 *Phase 2!* ${await flavorBossPhase(env.AI, quest.scene.monster_name)}`
      : "";
    const narration = `${marker}${flavor}${phaseLine}`;

    // Split the events into player-side and monster-side. Block Kit renders
    // them as separate sections with a divider between, so "what I did" and
    // "what hit me back" don't blur into one wall of text. Passives, the
    // player hit line, monster status-effect ticks (poison the player
    // inflicted), and the player's own tick lines all stack on the player
    // side; the monster's counter-swing is its own section.
    const playerEvents = [
      ...passiveLines,
      playerLine,
      ...monsterEffectLines,
      ...playerTickLines,
      ...newEffectLines,
    ];
    const monsterEvent = turn.monsterLine;

    // Notification fallback: plain text. Block Kit drives the actual visual layout.
    const targetFallback = updatedTarget
      ? `\n*${updatedTarget.name}* — ${updatedTarget.hp}/${updatedTarget.max_hp}${updatedTarget.shield > 0 ? ` 🛡${updatedTarget.shield}` : ""}`
      : "";
    const fallbackText = [
      blockQuote(narration),
      "",
      ...playerEvents,
      `↩️ ${monsterEvent}`,
      "",
      formatMonsterLine(quest.scene, newMonsterHp),
      `*${updatedActor.name}* — ${updatedActor.hp}/${updatedActor.max_hp}${updatedActor.shield > 0 ? ` 🛡${updatedActor.shield}` : ""}${targetFallback}`,
    ].join("\n");
    // Inject the freshly-committed next-turn telegraph so the combat block
    // shows who's ACTUALLY about to be hit, not the stale value from when
    // handleCombat first read the scene. Without this override, the rendered
    // "🎯 locked on @X" would lag one round behind the real commitment.
    const sceneForRender: SceneJson = nextTelegraph
      ? { ...quest.scene, monster_telegraph: { target_user_id: nextTelegraph } }
      : { ...quest.scene, monster_telegraph: undefined };
    const blocks = buildCombatBlocks({
      narration,
      playerEvents,
      monsterEvent,
      scene: sceneForRender,
      monsterHp: newMonsterHp,
      actor: updatedActor,
      target: updatedTarget,
    });

    // Mid-quest combat stays in-thread; only quest start + finish broadcast.
    await postToThread(env, quest, fallbackText, { blocks });
  })());

  return ephemeral(ephemeralLines.join("\n"));
}

async function resolveFlee(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  fighters: Character[],
  equippedArmor: Item | null,
): Promise<CommandResponse> {
  const roll = rollDice(2);
  if (roll === 1) {
    await appendLog(env.DB, quest.id, payload.user_id, "flee", "escaped");
    const others = fighters.filter((c) => c.slack_user_id !== payload.user_id);
    const partyContinues = others.length > 0;
    if (!partyContinues) {
      clearJoinableCard(env, quest);
      await markQuestStatus(env.DB, quest.id, "failed");
      await clearPartyEffects(env.DB, quest.id);
    }

    const ephem = partyContinues
      ? `🏃 You escape *${quest.scene.monster_name}*. The rest fight on.`
      : `🏃 You escape *${quest.scene.monster_name}*. The party is broken — quest ends.`;

    ctx.waitUntil((async () => {
      const flavor = await flavorFleeSuccess(env.AI, character, quest.scene.monster_name, partyContinues);
      if (!partyContinues) {
        // Last fighter walks away — quest ends. Use the same fanfare shape as victory
        // but framed as "abandoned" rather than "failed."
        const blocks = buildQuestEndBlocks({
          outcome: "failure",
          headline: "QUEST ABANDONED",
          narration: `🏃 ${flavor}`,
          body: [`The quest closes — no fighters remain.`],
        });
        const fallback = `🏃 QUEST ABANDONED\n${blockQuote(flavor)}`;
        await postToThread(env, quest, fallback, { broadcast: true, blocks });
        return;
      }
      const tail = `<@${payload.user_id}> retreats. ${others.map((s) => `*${s.name}*`).join(", ")} fight on.`;
      await postToThread(env, quest, `${blockQuote(`🏃 ${flavor}`)}\n\n${tail}`);
    })());

    return ephemeral(ephem);
  }

  // Failed flee → free monster hit. Static narration (low-stakes comic beat).
  const fleeAttackType: DamageType =
    quest.scene.monsters?.[0]?.attack_damage_type
    ?? quest.scene.monster_attack_type
    ?? "physical";
  const monster = resolveMonsterHit(
    quest.scene.tier,
    fighters.length,
    0,
    quest.scene.variant === "boss" && quest.scene.boss_phase === 2,
    rollDice,
    fleeAttackType,
  );
  const fleeDmgRaw = applyDamageWithShield(
    monster.final,
    fleeAttackType === "physical" ? character.shield : 0,
    character.hp,
  );
  const dmg = fleeAttackType === "physical"
    ? fleeDmgRaw
    : { newShield: character.shield, newHp: fleeDmgRaw.newHp, shieldAbsorbed: 0, hpDamage: fleeDmgRaw.hpDamage };
  const playerHpAfter = dmg.newHp;
  const typeEmoji = fleeAttackType !== "physical" ? ` ${DAMAGE_TYPE_EMOJI[fleeAttackType]}` : "";
  const armorNote = dmg.shieldAbsorbed > 0 ? ` \`${dmg.shieldAbsorbed} armor absorbed\`` : "";
  const intro = `🪤 <@${payload.user_id}> trips on the way out. *${quest.scene.monster_name}*${typeEmoji} lands a free hit for *${monster.final}*${armorNote}.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [intro]);
  }

  await setCharacterHpAndShield(env.DB, payload.user_id, playerHpAfter, dmg.newShield);
  await appendLog(env.DB, quest.id, payload.user_id, "flee", "failed");

  const updatedActor: Character = { ...character, hp: playerHpAfter, shield: dmg.newShield };
  const ephem = `${intro}\n*${character.name}*: ${playerHpAfter}/${character.max_hp}${dmg.newShield > 0 ? ` 🛡${dmg.newShield}` : ""}`;
  // Failed flee narration is short and already mentions the damage, so use a brief
  // narration + the same intro as the event line for consistency with combat posts.
  const blocks = buildCombatBlocks({
    narration: `🪤 *${character.name}* trips on the way out.`,
    events: [intro],
    scene: quest.scene,
    monsterHp: quest.scene.monster_hp,
    actor: updatedActor,
  });
  ctx.waitUntil(postToThread(env, quest, ephem, { blocks }));
  return ephemeral(ephem);
}

function rewardMultiplier(variant?: QuestVariant): number {
  if (variant === "boss") return 2;
  if (variant === "gauntlet") return 3;
  if (variant === "dungeon") return 2.5;
  return 1;
}

// 🎉 Party bonus: each member earns more XP (not gold) when fighting as a group.
// n=1 → 1.0×, n=2 → 1.1×, n=3 → 1.2×, n≥4 → 1.25×
function partyXpBonus(partySize: number): number {
  if (partySize <= 1) return 1.0;
  if (partySize === 2) return 1.1;
  if (partySize === 3) return 1.2;
  return 1.25;
}

// 📋 Job Board bonus. The town pays extra for posted contracts — gives the
// board a real mechanical edge over self-started quests. 12% pulls a job
// quest meaningfully above baseline without breaking the economy (a base
// standard quest pays 15 XP / 8 gold per tier-1 fighter; job version pays
// 16-17 / 8-9 — felt, not transformative).
const JOB_BOARD_REWARD_BONUS = 0.12;
function jobBoardBonus(scene: SceneJson): number {
  return scene.from_job_board ? JOB_BOARD_REWARD_BONUS : 0;
}

function currentExpNode(quest: ActiveQuest): ExpeditionNode | null {
  const exp = quest.scene.expedition;
  if (!exp) return null;
  return exp.nodes[exp.current] ?? null;
}

function variantDropChance(variant: QuestVariant | undefined, tier: number): number {
  if (variant === "gauntlet") return 1.0;
  const base = dropChance(tier);
  if (variant === "boss") return Math.min(1.0, base + 0.2);
  return base;
}

function clearJoinableCard(env: Env, quest: ActiveQuest): void {
  if (!quest.joinable_ts || !env.SLACK_BOT_TOKEN) return;
  void deleteMessage(env.SLACK_BOT_TOKEN, quest.channel_id, quest.joinable_ts);
}

async function resolveVictory(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  killer: Character,
  quest: ActiveQuest,
  fighters: Character[],
  preamble: string[],
): Promise<CommandResponse> {
  const mult = rewardMultiplier(quest.scene.variant);
  const bonus = jobBoardBonus(quest.scene);
  const totalXp = (10 + quest.scene.tier * 5) * mult * (1 + bonus);
  const totalGold = (5 + quest.scene.tier * 3) * mult * (1 + bonus);
  const xpEach = Math.max(1, Math.floor(totalXp / fighters.length * partyXpBonus(fighters.length)));
  const goldEach = Math.max(0, Math.floor(totalGold / fighters.length));

  const isJobBoard = quest.scene.from_job_board === true;
  const isDungeonVariant = quest.scene.variant === "dungeon";
  const isBossVariant = quest.scene.variant === "boss";
  const isElite = quest.elite;
  const isNoDeathRun = fighters.every((f) => f.hp > 0);
  const killerUserId = killer.slack_user_id;

  const levelUpLines: string[] = [];
  for (const fighter of fighters) {
    const result = await awardSpoils(
      env.DB,
      fighter,
      xpEach,
      goldEach,
      () => rollDice(6),
      xpForLevel,
    );
    if (result.levelsGained > 0) {
      const manaPart = result.newMaxMana > fighter.max_mana ? `, max mana ${result.newMaxMana}` : "";
      levelUpLines.push(
        `🎚️ *${fighter.name}* hits Level ${result.newLevel} (max HP ${result.newMaxHp}${manaPart}).`,
      );
    }

    // Achievement checks — fire and forget; Slack doesn't use pending toasts
    const charAfter = await getCharacter(env.DB, fighter.slack_user_id);
    if (charAfter) {
      const stats = await getLifetimeStats(env.DB, fighter.slack_user_id);
      const combatIds = checkCombatAchievements({
        fighterClass: fighter.class,
        finalHp: fighter.hp,
        maxHp: fighter.max_hp,
        roundsTotal: 0, // Slack path doesn't track rounds
        partySize: fighters.length,
        status: "victory",
        monster: { is_boss: isBossVariant, total_waves: quest.scene.total_waves },
        existingAchievements: charAfter.achievements,
        lifetimeWins: stats.quests_completed,
        lifetimeKills: stats.kills,
        landedKillingBlow: fighter.slack_user_id === killerUserId,
        scarsCount: fighter.scars.length,
        softDeathsTotal: stats.deaths_soft,
        isJobBoard,
        isDungeon: isDungeonVariant,
        isElite,
        isNoDeathRun,
        initialMonsterCount: quest.scene.monsters?.length ?? 1,
      });
      const progIds = checkProgressionAchievements({
        existingAchievements: charAfter.achievements,
        level: result.newLevel,
        gold: charAfter.gold,
        keysBronze: charAfter.keys_bronze,
        keysSilver: charAfter.keys_silver,
        keysGold: charAfter.keys_gold,
      });
      for (const id of [...combatIds, ...progIds]) {
        await grantAchievement(env.DB, fighter.slack_user_id, id);
      }
    }
  }

  // Roll loot independently per fighter so everyone has skin in the kill.
  const variantDrop = variantDropChance(quest.scene.variant, quest.scene.tier);
  const lootRolls = fighters
    .map((f) => ({ fighter: f, roll: rollItem(quest.scene.tier) }))
    .filter(() => Math.random() < variantDrop);

  clearJoinableCard(env, quest);
  await markQuestStatus(env.DB, quest.id, "completed");
  await clearPartyEffects(env.DB, quest.id);
  await appendLog(env.DB, quest.id, payload.user_id, "victory", `+${xpEach}xp/+${goldEach}g × ${fighters.length}, ${lootRolls.length} drops`);

  const bonusTag = bonus > 0 ? " _(📋 +12% job board bonus)_" : "";
  const partyBonusPct = partyXpBonus(fighters.length);
  const partyTag = partyBonusPct > 1 ? ` _(🎉 +${Math.round((partyBonusPct - 1) * 100)}% party XP bonus)_` : "";
  const ephemeralLines = [
    ...preamble,
    `✨ Spoils split across ${fighters.length}: +${xpEach} XP, +${goldEach} gold each.${bonusTag}${partyTag}`,
    ...levelUpLines,
  ];
  if (lootRolls.length > 0) {
    ephemeralLines.push(
      `🎁 ${lootRolls.length} drop${lootRolls.length > 1 ? "s" : ""}! Check \`${payload.command} inventory\` once narration posts.`,
    );
  }

  ctx.waitUntil((async () => {
    // Post the killing-blow combat line to thread first so party members see who
    // landed the kill, not just the fanfare. Without this, the killer's attack
    // is ephemeral-only and partymates wonder how the fight ended.
    await postToThread(env, quest, blockQuote(preamble.join("\n")));

    const flavor = await flavorVictory(env.AI, killer, quest.scene.monster_name, fighters.length);
    const lootLines: string[] = [];
    for (const { fighter, roll } of lootRolls) {
      const named = await resolveLootDrop(env, quest.scene.monster_name, roll);
      const opt = rollToLootOption(roll, named);
      const item = await addItem(env.DB, {
        character_id: fighter.slack_user_id,
        item_name: opt.name,
        item_type: opt.item_type,
        power: opt.power,
        rarity: opt.rarity,
        flavor: opt.flavor,
        weapon_range: opt.weapon_range,
        slot: opt.slot,
        stat_bonus: opt.stat_bonus,
        item_subtype: opt.item_subtype,
      });
      const powerStr = powerLabel(roll.type, roll.power, item.item_name);
      const rangeNote = roll.weapon_range
        ? ` ${roll.weapon_range === "ranged" ? "🏹" : roll.weapon_range === "focus" ? "🔮" : "⚔️"}`
        : "";
      lootLines.push(
        `${RARITY_BADGE[roll.rarity]} *${fighter.name}* finds *${item.item_name}* (${roll.type}${rangeNote}, ${powerStr}) — _${named.flavor}_`,
      );
    }
    const stats = await getQuestDamageStats(env.DB, quest.id);
    const breakdown = renderDamageBreakdown(stats);
    const body = [
      `✨ +${xpEach} XP, +${goldEach} gold to each of ${fighters.length} fighter${fighters.length > 1 ? "s" : ""}.`,
      ...levelUpLines,
      ...lootLines,
      ...(breakdown ? ["", breakdown] : []),
    ];
    const blocks = buildQuestEndBlocks({
      outcome: "victory",
      headline: "QUEST COMPLETE",
      narration: flavor,
      body,
    });
    const fallback = `🏆 QUEST COMPLETE\n${blockQuote(flavor)}\n${body.join("\n")}`;
    await postToThread(env, quest, fallback, { broadcast: true, blocks });
  })());

  return ephemeral(ephemeralLines.join("\n"));
}

// Gauntlet wave kill: drop the queued next monster into scene_json and post a transition
// narration. No spoils yet — only the final wave's kill triggers resolveVictory.
async function resolveGauntletAdvance(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  quest: ActiveQuest,
  preamble: string[],
): Promise<CommandResponse> {
  const queue = quest.scene.upcoming_waves ?? [];
  const next = queue[0];
  const remaining = queue.slice(1);
  const newWave = (quest.scene.wave ?? 1) + 1;
  const totalWaves = quest.scene.total_waves ?? GAUNTLET_WAVES;
  const previousMonster = quest.scene.monster_name;

  const updatedScene: SceneJson = {
    ...quest.scene,
    monster_name: next.name,
    monster_hp: next.max_hp,
    monster_max_hp: next.max_hp,
    scene: next.scene,
    wave: newWave,
    upcoming_waves: remaining,
    // Promote the wave's pre-rendered art URL (or clear when missing — we
    // don't want the previous wave's portrait sticking around when the next
    // wave came from a pre-art save).
    monster_art_url: next.art_url,
    // New wave's monster starts fresh — clear any effects (poison etc.) that were
    // on the previous wave's foe.
    monster_effects: [],
    monster_armor: undefined, // new wave: armor resets to default (tier) on first hit
    // Mark and telegraph are per-monster — clear on wave advance so calls
    // on the previous wave don't silently affect attacks on the next.
    marked_by: undefined,
    marked_until: undefined,
    monster_telegraph: undefined,
    // Per-fight passives reset on every scene transition so each new fight
    // gets fresh once-per-fight triggers (Rogue crit, Mage free cast, etc.)
    passives_used: undefined,
    // Active-ability buffs/debuffs are per-fight too — taunt expires,
    // vanish wears off, containerize doesn't carry to the next monster.
    ability_state: undefined,
  };

  // Reached only after a kill-blow conditional update succeeded, so no concurrent
  // writer is possible. saveScene (unconditional) is correct here.
  await saveScene(env.DB, quest.id, updatedScene);
  await appendLog(env.DB, quest.id, payload.user_id, "wave_advance", `wave ${newWave}/${totalWaves}`);

  const ephemeralLines = [
    ...preamble,
    `⚔️ Wave ${newWave}/${totalWaves}: *${next.name}* (HP ${next.max_hp}).`,
  ];

  const waveLabel = `wave ${newWave}/${totalWaves}`;
  ctx.waitUntil((async () => {
    // Post the killing-blow line first so partymates see who downed the wave's foe.
    await postToThread(env, quest, blockQuote(preamble.join("\n")));

    const flavor = await flavorGauntletNext(env.AI, previousMonster, next.name, waveLabel);
    const intro = `⚔️ ${flavor}`;
    const tail = `⚔️ *${waveLabel}* — *${next.name}* (HP ${next.max_hp})\n${blockQuote(next.scene)}`;
    const fallback = `${blockQuote(intro)}\n\n${tail}`;
    // When the wave came with a pre-rendered portrait, render an image block
    // above the intro so the new foe is visually announced. Plain-text path
    // remains the fallback for image-less old gauntlets.
    if (next.art_url) {
      const blocks: unknown[] = [
        { type: "image", image_url: next.art_url, alt_text: next.name },
        { type: "section", text: { type: "mrkdwn", text: blockQuote(intro) } },
        { type: "section", text: { type: "mrkdwn", text: tail } },
      ];
      await postToThread(env, quest, fallback, { blocks });
    } else {
      await postToThread(env, quest, fallback);
    }
  })());

  return ephemeral(ephemeralLines.join("\n"));
}

// Expedition combat-node kill: advance to the treasure node and post the loot prompt.
// Quest stays active until someone /dnd take's an item.
async function resolveExpeditionToTreasure(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  quest: ActiveQuest,
  preamble: string[],
): Promise<CommandResponse> {
  const exp = quest.scene.expedition;
  if (!exp) return ephemeral("Expedition state missing — quest is in a bad way.");
  const treasureIdx = exp.current + 1;
  const treasureNode = exp.nodes[treasureIdx];
  if (!treasureNode || treasureNode.type !== "treasure") {
    // Shouldn't be reachable — expeditions always build combat → treasure. If it ever
    // does (corrupted scene_json, manual DB edit, etc.), end the quest cleanly.
    clearJoinableCard(env, quest);
    await markQuestStatus(env.DB, quest.id, "completed");
    await clearPartyEffects(env.DB, quest.id);
    return ephemeral([...preamble, "_(no treasure node found — quest closed.)_"].join("\n"));
  }

  const updatedExp: ExpeditionState = {
    ...exp,
    current: treasureIdx,
    // Track the treasure visit so the completion-path map shows it as the
    // final 🎁 row. Without this, visited_indices stops at the sub-boss and
    // the map drops the heart-chamber line.
    visited_indices: [...(exp.visited_indices ?? [exp.current]), treasureIdx],
    visited_count: (exp.visited_count ?? 1) + 1,
  };
  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: updatedExp,
    scene: treasureNode.scene,
    monster_hp: 0,
  };
  // Reached only after a kill-blow conditional update succeeded, so no concurrent
  // writer is possible — but use trySaveExpeditionAdvance anyway for symmetry with
  // the other expedition advance sites.
  await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `→ treasure`);

  const lootLines = (treasureNode.loot_options ?? []).map((l, i) => {
    const power = powerLabel(l.item_type, l.power, l.name);
    const effect = catalogEffectLine(l.name);
    const head = `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
    return effect ? `${head}\n   ${effect}\n   _${l.flavor}_` : `${head}\n   _${l.flavor}_`;
  }).join("\n");

  ctx.waitUntil((async () => {
    const head = blockQuote(preamble.join("\n"));
    const sceneQuote = blockQuote(`🎁 ${treasureNode.scene}`);
    const tail = `${lootLines}\n\n_First \`${payload.command} take <n>\` claims for the party._`;
    // Mid-quest treasure reveal stays in-thread; the expedition victory itself broadcasts.
    await postToThread(env, quest, `${head}\n\n${sceneQuote}\n\n${tail}`);
  })());

  return ephemeral([...preamble, `🎁 Treasure ahead — \`${payload.command} take <1-2>\` to claim.`].join("\n"));
}

// Used at the end of an expedition once treasure has been picked. Splits XP/gold across
// alive fighters with the expedition multiplier, marks quest completed, posts the closer.
async function resolveExpeditionVictory(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  taker: Character,
  takenItem: Item,
  quest: ActiveQuest,
): Promise<void> {
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const partySize = Math.max(1, fighters.length);
  const mult = rewardMultiplier(quest.scene.variant);
  const bonus = jobBoardBonus(quest.scene);
  const totalXp = (10 + quest.scene.tier * 5) * mult * (1 + bonus);
  const totalGold = (5 + quest.scene.tier * 3) * mult * (1 + bonus);
  const xpEach = Math.max(1, Math.floor(totalXp / partySize * partyXpBonus(partySize)));
  const goldEach = Math.max(0, Math.floor(totalGold / partySize));

  const levelUpLines: string[] = [];
  for (const fighter of fighters) {
    const result = await awardSpoils(env.DB, fighter, xpEach, goldEach, () => rollDice(6), xpForLevel);
    if (result.levelsGained > 0) {
      const manaPart = result.newMaxMana > fighter.max_mana ? `, max mana ${result.newMaxMana}` : "";
      levelUpLines.push(
        `🎚️ *${fighter.name}* hits Level ${result.newLevel} (max HP ${result.newMaxHp}${manaPart}).`,
      );
    }
  }

  clearJoinableCard(env, quest);
  await markQuestStatus(env.DB, quest.id, "completed");
  await clearPartyEffects(env.DB, quest.id);
  await appendLog(env.DB, quest.id, payload.user_id, "expedition_complete", `taker:${taker.name}, item:${takenItem.item_name}`);

  ctx.waitUntil((async () => {
    const flavor = await flavorVictory(env.AI, taker, quest.scene.monster_name, partySize);
    const map = quest.scene.expedition ? renderDungeonMap(quest.scene.expedition) : "";
    const stats = await getQuestDamageStats(env.DB, quest.id);
    const breakdown = renderDamageBreakdown(stats);
    const body = [
      `🎁 *${taker.name}* claims *${takenItem.item_name}* (${takenItem.item_type}, ${powerLabel(takenItem.item_type, takenItem.power, takenItem.item_name)}).`,
      `✨ +${xpEach} XP, +${goldEach} gold to each of ${partySize} fighter${partySize > 1 ? "s" : ""}${partyXpBonus(partySize) > 1 ? ` _(🎉 +${Math.round((partyXpBonus(partySize) - 1) * 100)}% party XP)_` : ""}.`,
      ...levelUpLines,
      ...(breakdown ? ["", breakdown] : []),
      ...(map ? ["", map] : []),
    ];
    const blocks = buildQuestEndBlocks({
      outcome: "victory",
      headline: "EXPEDITION COMPLETE",
      narration: flavor,
      body,
    });
    const fallback = `🏆 EXPEDITION COMPLETE\n${blockQuote(flavor)}\n${body.join("\n")}`;
    await postToThread(env, quest, fallback, { broadcast: true, blocks });
  })());
}

// Advances a dungeon expedition to the next room. Atomically writes the new scene
// state (current+1, optional key delta, monster fields synced if next room is combat).
// Posts the new room into the thread; returns ephemeral combining preamble + room.
// Helper: render the door-choice prompt when the player is between middle rooms.
function renderDoorPrompt(exp: ExpeditionState, cmd: string): string {
  const doors = exp.pending_doors ?? [];
  const visited = exp.visited_count ?? 1;
  const middleTotal = dungeonRoomTotal(exp.middle_count ?? 0);
  const isSingle = doors.length === 1;
  const isSubBossAhead = isSingle && doors[0] === exp.nodes.length - 2;
  // Header reflects how many paths there are. Single-option transitions get a
  // "catch your breath" header so players know it's their cue to rest if needed.
  const headline = isSubBossAhead
    ? `*👑 The way opens to the sub-boss chamber* — Room ${visited + 1}/${middleTotal}.`
    : isSingle
    ? `*🚪 One path forward* — Room ${visited + 1}/${middleTotal}. Catch your breath.`
    : `*🚪 Two paths diverge* — Room ${visited + 1}/${middleTotal} ahead.`;
  const DOOR_DIRS = ["N", "E", "S", "W"];
  const lines = [headline, renderPathTrail(exp)];
  for (let i = 0; i < doors.length; i++) {
    const node = exp.nodes[doors[i]];
    const dir = isSingle ? "" : ` (${DOOR_DIRS[i] ?? i + 1})`;
    lines.push(`\`${i + 1}\`${dir} ${dungeonRoomLabel(node.type)}`);
  }
  const restHint = `\`${cmd} rest\` to short-rest first (HP+mana, 10-min cooldown).`;
  const lookHint = `\`${cmd} look\` to re-show this prompt if you scroll past it.`;
  const advanceHint = isSingle
    ? `\`${cmd} choose 1\` to advance.`
    : `_First \`${cmd} choose <n>\` picks for the party. The unchosen door is sealed behind you._`;
  lines.push("", advanceHint, restHint, lookHint);
  return lines.join("\n");
}

// Picks the next node index after the current room is resolved. Returns both the
// pick and the post-pop pool so callers don't recompute it. Three cases:
//   1. Pool has 2+ unvisited middle rooms: pop two, set pending_doors, signal "doors"
//   2. Pool has exactly 1: pop it, auto-advance (no door choice — last middle room)
//   3. Pool is empty: advance to sub-boss (nodes.length - 2)
//   4. Already at sub-boss when called: advance to treasure
type NextRoom =
  | { type: "doors"; pair: number[]; remainingPool: number[] }
  | { type: "node"; index: number; remainingPool: number[] };

function pickNextRoom(exp: ExpeditionState): NextRoom {
  const treasureIdx = exp.nodes.length - 1;
  const subBossIdx = exp.nodes.length - 2;
  const merchantIdx = exp.nodes.length - 3;
  const pool = [...(exp.pool ?? [])];

  // Sub-boss → treasure: auto-advance (treasure is the take-prompt UI,
  // not a fight, no rest needed).
  if (exp.current === subBossIdx) {
    return { type: "node", index: treasureIdx, remainingPool: pool };
  }
  // Merchant → sub-boss: forced single door so the party gets a pause to
  // rest/heal/equip purchases before the boss fight.
  if (exp.current === merchantIdx) {
    return { type: "doors", pair: [subBossIdx], remainingPool: pool };
  }
  // 2+ pool: regular door pick (left vs right).
  if (pool.length >= 2) {
    const a = pool.shift()!;
    const b = pool.shift()!;
    return { type: "doors", pair: [a, b], remainingPool: pool };
  }
  // 1 pool: present as single-option door (rest-pause beat).
  if (pool.length === 1) {
    const idx = pool.shift()!;
    return { type: "doors", pair: [idx], remainingPool: pool };
  }
  // Pool empty: forced single door to merchant (the guaranteed-visit slot).
  return { type: "doors", pair: [merchantIdx], remainingPool: pool };
}

async function advanceDungeonRoom(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  quest: ActiveQuest,
  actor: Character,
  preamble: string[],
  options?: { actorHpAfter?: number },
): Promise<CommandResponse> {
  const exp = quest.scene.expedition;
  if (!exp) return ephemeral("Expedition state missing.");

  const next = pickNextRoom(exp);

  // Apply HP damage (e.g. trap fail) before the advance writes — so a fatal trap
  // routes through resolveDeath cleanly.
  if (options?.actorHpAfter !== undefined && options.actorHpAfter <= 0) {
    const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
    return resolveDeath(payload, env, ctx, actor, quest, fighters, preamble);
  }
  if (options?.actorHpAfter !== undefined && options.actorHpAfter !== actor.hp) {
    await setCharacterHp(env.DB, payload.user_id, options.actorHpAfter);
  }

  if (next.type === "doors") {
    // Present a door choice — don't advance current yet.
    const updatedExp: ExpeditionState = {
      ...exp,
      pool: next.remainingPool,
      pending_doors: next.pair,
    };
    const updatedScene: SceneJson = { ...quest.scene, expedition: updatedExp };
    const ok = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
    if (!ok) return ephemeral("Someone else already advanced the party.");
    await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `doors → ${next.pair.join(",")}`);

    const prompt = renderDoorPrompt(updatedExp, payload.command);
    const threadText = [blockQuote(preamble.join("\n")), "", prompt].join("\n");
    const doorBlocks = buildDoorPromptBlocks(updatedExp, payload.command);
    const threadBlocks = [
      { type: "section", text: { type: "mrkdwn", text: blockQuote(preamble.join("\n")) } },
      ...doorBlocks,
    ];
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: preamble.join("\n") } },
      ...doorBlocks,
    ];
    // Always post the new content to the thread — response_url posts have
    // unreliable thread context (sometimes drop out of the thread view).
    // postToThread is the canonical channel for advancement content.
    ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
    // For interactive (button-click) callers: delete the original prompt
    // (the merchant/door/etc. message whose buttons just got pressed) so
    // the actor doesn't see both the now-stale prompt AND the duplicate
    // ephemeral copy. The new content lives in the thread post above.
    // Slash callers get the full ephemeral content as before.
    if (payload._interactive) {
      return { text: "", _deleteOriginal: true };
    }
    return { text: [...preamble, "", prompt].join("\n"), response_type: "ephemeral", blocks };
  }

  // Direct advance to next.index (auto-advance — last middle room, sub-boss, or treasure).
  const newCurrent = next.index;
  const nextNode = exp.nodes[newCurrent];
  if (!nextNode) return ephemeral("Dungeon is in a bad state — no next room.");

  const updatedExp: ExpeditionState = {
    ...exp,
    current: newCurrent,
    pool: next.remainingPool,
    pending_doors: undefined,
    visited_count: (exp.visited_count ?? 1) + 1,
    visited_indices: [...(exp.visited_indices ?? [exp.current]), newCurrent],
  };

  const isCombat = nextNode.type === "combat";
  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: updatedExp,
    scene: nextNode.scene,
    monster_name: isCombat ? nextNode.monster_name! : "—",
    monster_max_hp: isCombat ? nextNode.monster_max_hp! : 0,
    monster_hp: isCombat ? nextNode.monster_max_hp! : 0,
    tier: isCombat ? nextNode.tier! : quest.scene.tier,
    // Promote the room's pre-rendered monster portrait (combat only). For
    // non-combat rooms (lockbox/trap/npc/treasure/merchant) we explicitly
    // clear it so the previous room's portrait doesn't bleed into the new
    // scene block.
    monster_art_url: isCombat ? nextNode.monster_art_url : undefined,
    // New room's monster starts fresh — clear any effects from the prior room.
    monster_effects: [],
    // Mark and telegraph are per-monster; clear so the next room's foe isn't
    // pre-marked or already-targeted.
    marked_by: undefined,
    marked_until: undefined,
    monster_telegraph: undefined,
    // Per-fight passives reset on every scene transition so each new fight
    // gets fresh once-per-fight triggers (Rogue crit, Mage free cast, etc.)
    passives_used: undefined,
    // Active-ability buffs/debuffs are per-fight too — taunt expires,
    // vanish wears off, containerize doesn't carry to the next monster.
    ability_state: undefined,
  };

  const advanced = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!advanced) return ephemeral("Someone else already advanced the party.");
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `→ idx ${newCurrent}`);

  // Between-room mana regen — every alive partymate catches their breath
  // between rooms in a dungeon. Silent: mana shows up on the next stat
  // card; explicit announcement would be too noisy in big parties.
  await regenPartyMana(env.DB, quest.id, MANA_REGEN_BETWEEN_ROOMS);

  const roomBody = renderDungeonRoom(nextNode, updatedExp, payload.command);
  const threadText = [blockQuote(preamble.join("\n")), "", roomBody].join("\n");
  const roomBlocks = await buildDungeonRoomBlocks(nextNode, updatedExp, payload.command, env, ctx);
  const threadBlocks = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(preamble.join("\n")) } },
    ...roomBlocks,
  ];
  const ephemBlocks = [
    { type: "section", text: { type: "mrkdwn", text: preamble.join("\n") } },
    ...roomBlocks,
  ];
  // Always post to thread (reliable thread visibility). For interactive
  // callers, also delete the original button-bearing prompt so the actor
  // doesn't see it duplicated alongside the new thread post.
  ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
  if (payload._interactive) {
    return { text: "", _deleteOriginal: true };
  }
  return { text: [...preamble, "", roomBody].join("\n"), response_type: "ephemeral", blocks: ephemBlocks };
}

// Resolves a door pick — advances to the chosen room, discards the unchosen.
// Called by handleChoose when pending_doors is set.
async function resolveDoorChoice(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  quest: ActiveQuest,
  exp: ExpeditionState,
  pickIdx: number, // 1 or 2
): Promise<CommandResponse> {
  const doors = exp.pending_doors ?? [];
  if (pickIdx < 1 || pickIdx > doors.length) {
    return ephemeral(`Usage: \`${payload.command} choose 1\` or \`${payload.command} choose 2\`.`);
  }
  const chosenNodeIdx = doors[pickIdx - 1];
  const otherIdx = doors[pickIdx === 1 ? 1 : 0];
  const chosenNode = exp.nodes[chosenNodeIdx];
  if (!chosenNode) return ephemeral("Door leads nowhere — dungeon state is corrupted.");

  const isCombat = chosenNode.type === "combat";
  const updatedExp: ExpeditionState = {
    ...exp,
    current: chosenNodeIdx,
    pending_doors: undefined,
    visited_count: (exp.visited_count ?? 1) + 1,
    visited_indices: [...(exp.visited_indices ?? [exp.current]), chosenNodeIdx],
    sealed_doors: [...(exp.sealed_doors ?? []), otherIdx],
  };
  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: updatedExp,
    scene: chosenNode.scene,
    monster_name: isCombat ? chosenNode.monster_name! : "—",
    monster_max_hp: isCombat ? chosenNode.monster_max_hp! : 0,
    monster_hp: isCombat ? chosenNode.monster_max_hp! : 0,
    tier: isCombat ? chosenNode.tier! : quest.scene.tier,
    // Promote the new room's portrait (combat only); clear for non-combat
    // rooms so the previous monster's image doesn't carry over.
    monster_art_url: isCombat ? chosenNode.monster_art_url : undefined,
    // Door pick — new room's monster starts fresh.
    monster_effects: [],
    // Mark + telegraph don't carry across rooms.
    marked_by: undefined,
    marked_until: undefined,
    monster_telegraph: undefined,
    // Per-fight passives reset on every scene transition so each new fight
    // gets fresh once-per-fight triggers (Rogue crit, Mage free cast, etc.)
    passives_used: undefined,
    // Active-ability buffs/debuffs are per-fight too — taunt expires,
    // vanish wears off, containerize doesn't carry to the next monster.
    ability_state: undefined,
  };

  const ok = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!ok) return ephemeral("Someone else already opened a door.");
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `door pick → ${chosenNodeIdx} (sealed ${otherIdx})`);

  // Between-room mana regen — silently refills alive partymates.
  await regenPartyMana(env.DB, quest.id, MANA_REGEN_BETWEEN_ROOMS);

  const roomBody = renderDungeonRoom(chosenNode, updatedExp, payload.command);
  const headLine = `🚪 <@${payload.user_id}> opens Door ${pickIdx} — ${dungeonRoomLabel(chosenNode.type).toLowerCase()}.`;
  const threadText = [blockQuote(headLine), "", roomBody].join("\n");
  const roomBlocks = await buildDungeonRoomBlocks(chosenNode, updatedExp, payload.command, env, ctx);
  const threadBlocks = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(headLine) } },
    ...roomBlocks,
  ];
  const ephemBlocks = [
    { type: "section", text: { type: "mrkdwn", text: headLine } },
    ...roomBlocks,
  ];
  // Always thread-post the new room. For interactive callers, also delete
  // the door-pick prompt that just got clicked so its stale buttons don't
  // linger above the new room.
  ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
  if (payload._interactive) {
    return { text: "", _deleteOriginal: true };
  }
  return { text: [headLine, "", roomBody].join("\n"), response_type: "ephemeral", blocks: ephemBlocks };
}

async function handleChoose(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed and can't act.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return (await lobbyGuard(env.DB, payload.user_id)) ?? ephemeral("You're not on an active quest.");
  if (quest.scene.variant !== "dungeon" || !quest.scene.expedition) {
    return ephemeral(`No room choice to make — try \`${payload.command} attack\` or similar.`);
  }

  const exp = quest.scene.expedition;

  const idx = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(idx) || idx < 1) {
    return ephemeral(`Usage: \`${payload.command} choose <n>\`.`);
  }

  if (exp.pending_doors && exp.pending_doors.length > 0) {
    return resolveDoorChoice(payload, env, ctx, quest, exp, idx);
  }

  const node = exp.nodes[exp.current];
  if (!node || (node.type !== "trap" && node.type !== "lockbox" && node.type !== "npc" && node.type !== "merchant")) {
    return ephemeral("No room choice to make right now.");
  }

  if (node.type === "trap") {
    return resolveTrapChoice(payload, env, ctx, character, quest, exp, node, idx);
  }
  if (node.type === "lockbox") {
    return resolveLockboxChoice(payload, env, ctx, character, quest, exp, node, idx);
  }
  if (node.type === "merchant") {
    return resolveMerchantChoice(payload, env, ctx, character, quest, exp, node, idx);
  }
  return resolveNpcChoice(payload, env, ctx, character, quest, exp, node, idx);
}

// Reward magnitudes for trap-pass outcomes. Tuned for early-game usefulness
// without trivializing the dungeon — a successful pass should feel like a
// small win, not a fight-changing buff.
const TRAP_KEY_REWARD: KeyTier = "bronze"; // STR pass
const TRAP_SHIELD_REWARD = 4;              // DEX pass
const TRAP_SHIELD_CAP_MULT = 2;            // shield ceiling = 2 × max_hp (matches /sq shield cap)
const TRAP_MANA_REWARD = 2;                // INT pass

async function resolveTrapChoice(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  exp: ExpeditionState,
  node: ExpeditionNode,
  idx: number,
): Promise<CommandResponse> {
  const choices = node.trap_choices ?? [];
  if (idx > choices.length) {
    return ephemeral(`Usage: \`${payload.command} choose <1-${choices.length}>\`.`);
  }
  const choice = choices[idx - 1];
  const cls = classByName(character.class);
  const isExpert = cls.skills.includes(choice.skill);

  // Class-skill match = +2 to roll instead of auto-pass. With need 4+:
  //   • Class match (1d6+2): fails only on natural 1 → ~17% fail rate
  //   • Non-class (1d6):     fails on 1-3        → 50% fail rate
  // Keeps your class skill strongly favored (5x lower fail rate) without
  // making it deterministic — natural 1 still hurts, picking a non-class
  // option is a real gamble worth taking for the right reward.
  const roll = rollDice(6);
  const modifiedRoll = roll + (isExpert ? 2 : 0);
  const passed = modifiedRoll >= 4;
  const expertNote = isExpert ? `+2 ${SKILL_META[choice.skill].label}` : "";
  const rollNote = isExpert
    ? `1d6 = *${roll}*${expertNote ? ` ${expertNote} = *${modifiedRoll}*` : ""} — ${passed ? "pass (≥4)" : "fail (<4)"}.`
    : `1d6 = *${roll}* — ${passed ? "pass (≥4)" : "fail (<4)"}.`;

  // Apply the success reward, by skill type. Each option offers a different
  // payoff so the choice between them matters even when one auto-favors
  // your class. Reward applies on pass only — failing yields nothing
  // beyond the HP cost.
  let rewardLine = "";
  if (passed) {
    if (choice.skill === "str") {
      await addCharacterKey(env.DB, payload.user_id, TRAP_KEY_REWARD, 1);
      rewardLine = ` Drops ${KEY_EMOJI[TRAP_KEY_REWARD]} *${TRAP_KEY_REWARD}* key.`;
    } else if (choice.skill === "dex") {
      const cap = character.max_hp * TRAP_SHIELD_CAP_MULT;
      const added = await addShield(env.DB, character, TRAP_SHIELD_REWARD, cap);
      rewardLine = added > 0 ? ` Gains 🛡️ *${added}* shield.` : ` Shield already at cap.`;
    } else if (choice.skill === "int") {
      const added = await addMana(env.DB, character, TRAP_MANA_REWARD);
      rewardLine = added > 0 ? ` Restores ✨ *${added}* mana.` : ` Mana already at max.`;
    }
  }

  const actorHpAfter = passed ? character.hp : Math.max(0, character.hp - choice.fail_damage);
  const headLine = passed
    ? `⚠️ <@${payload.user_id}> chose ${choice.emoji} *${choice.text}*. ${rollNote}${rewardLine}`
    : `⚠️ <@${payload.user_id}> chose ${choice.emoji} *${choice.text}*. ${rollNote} Takes *${choice.fail_damage}* HP.`;

  await appendLog(
    env.DB, quest.id, payload.user_id,
    "trap",
    `${choice.skill} ${passed ? `pass${rewardLine ? rewardLine.trim() : ""}` : `fail -${choice.fail_damage}HP`}`,
  );

  return advanceDungeonRoom(payload, env, ctx, quest, character, [headLine], {
    actorHpAfter: passed ? undefined : actorHpAfter,
  });
}

async function resolveLockboxChoice(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  exp: ExpeditionState,
  node: ExpeditionNode,
  idx: number,
): Promise<CommandResponse> {
  const opts = node.loot_options ?? [];
  const skipIdx = opts.length + 1;
  if (idx > skipIdx) {
    return ephemeral(`Usage: \`${payload.command} choose <1-${skipIdx}>\` (last option = skip).`);
  }
  if (idx === skipIdx) {
    return advanceDungeonRoom(payload, env, ctx, quest, character, [
      `🔒 <@${payload.user_id}> walks past the lockbox empty-handed.`,
    ]);
  }
  const lockTier = node.lock_tier ?? "bronze";
  const keyToSpend = pickKeyForLock(character, lockTier);
  if (!keyToSpend) {
    const have = characterKeyDisplay(character) || "no keys";
    return ephemeral(
      `${KEY_EMOJI[lockTier]} You need a *${lockTier}* key (or higher). You have ${have}. \`${payload.command} choose ${skipIdx}\` to skip.`,
    );
  }
  const choice = opts[idx - 1];
  await addCharacterKey(env.DB, payload.user_id, keyToSpend, -1);
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: choice.slot,
    stat_bonus: choice.stat_bonus,
    item_subtype: choice.item_subtype,
  });
  await appendLog(env.DB, quest.id, payload.user_id, "lockbox", `unlocked ${lockTier} → ${item.item_name}`);

  const spentNote = keyToSpend === lockTier ? "" : ` (spent ${KEY_EMOJI[keyToSpend]} ${keyToSpend})`;
  const headline = `🔓 <@${payload.user_id}> opens the ${KEY_EMOJI[lockTier]} ${lockTier} lock${spentNote} — claims ${RARITY_BADGE[choice.rarity]} *${choice.name}* (id \`${item.id}\`).`;
  return advanceDungeonRoom(payload, env, ctx, quest, character, [headline]);
}

async function resolveNpcChoice(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  exp: ExpeditionState,
  node: ExpeditionNode,
  idx: number,
): Promise<CommandResponse> {
  if (idx < 1 || idx > 2) {
    return ephemeral(`Usage: \`${payload.command} choose 1\` (trust) or \`${payload.command} choose 2\` (refuse).`);
  }
  if (idx === 2) {
    return advanceDungeonRoom(payload, env, ctx, quest, character, [
      `🤝 <@${payload.user_id}> waves the stranger off and presses on.`,
    ]);
  }
  // Trust — roll 1d6 + class trust mod against the stranger.
  //   ≤3: betrayed (no item, take damage)
  //   4-5: tainted gift (item given, but applies 🔴 Bleeding for 3 actions)
  //   6+:  clean exchange (item, no strings)
  const offer = node.npc?.item;
  if (!offer) {
    return advanceDungeonRoom(payload, env, ctx, quest, character, [
      `🤝 The stranger fades into the gloom with nothing to give.`,
    ]);
  }

  const mod = npcTrustMod(character.class);
  const roll = rollDice(6);
  const total = roll + mod;
  const modBreakdown = mod > 0 ? `${roll} + ${mod}m` : `${roll}`;
  let bucket: "betrayed" | "tainted" | "clean";
  if (total <= 2) bucket = "betrayed";
  else if (total === 3) bucket = "tainted";
  else bucket = "clean";

  const flavor = pickNpcTrustLine(bucket);
  const tier = quest.scene.tier;

  if (bucket === "betrayed") {
    // No item. Take 1d4 + tier damage. Route to death if it kills.
    const damage = rollDice(4) + tier;
    const newHp = Math.max(0, character.hp - damage);
    const headline = `🤝 <@${payload.user_id}> trusts the stranger — *BETRAYED!* \`1d6 + ${modBreakdown} = ${total}\`. Takes *${damage}* HP.`;
    const flavorLine = `_${flavor}_`;
    await appendLog(env.DB, quest.id, payload.user_id, "npc", `betrayed, -${damage} HP`);

    if (newHp <= 0) {
      const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
      return resolveDeath(payload, env, ctx, character, quest, fighters, [headline, flavorLine]);
    }
    return advanceDungeonRoom(payload, env, ctx, quest, character, [headline, flavorLine], {
      actorHpAfter: newHp,
    });
  }

  // Both "tainted" and "clean" hand over the item.
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: offer.name,
    item_type: offer.item_type,
    power: offer.power,
    rarity: offer.rarity,
    flavor: offer.flavor,
    weapon_range: offer.weapon_range ?? null,
    slot: offer.slot,
    stat_bonus: offer.stat_bonus,
    item_subtype: offer.item_subtype,
  });

  if (bucket === "tainted") {
    // Apply 🔴 Bleeding via withEffectApplied. Save effects.
    const bleed: StatusEffect = {
      type: "bleeding",
      magnitude: 3,
      remaining: 3,
      source: `tainted gift from a stranger`,
    };
    const updatedEffects = withEffectApplied(character.effects ?? [], bleed);
    await setCharacterEffects(env.DB, payload.user_id, updatedEffects);
    await appendLog(env.DB, quest.id, payload.user_id, "npc", `tainted, took ${item.item_name} + bleeding`);
    const headline = `🤝 <@${payload.user_id}> trusts the stranger — *tainted gift* \`1d6 + ${modBreakdown} = ${total}\`. Claims ${RARITY_BADGE[offer.rarity]} *${offer.name}* (id \`${item.id}\`) — but is now 🔴 *Bleeding* (-2 HP × 3 actions).`;
    const flavorLine = `_${flavor}_`;
    return advanceDungeonRoom(payload, env, ctx, quest, character, [headline, flavorLine]);
  }

  // Clean
  await appendLog(env.DB, quest.id, payload.user_id, "npc", `trusted, took ${item.item_name}`);
  const headline = `🤝 <@${payload.user_id}> trusts the stranger — *honest exchange* \`1d6 + ${modBreakdown} = ${total}\`. Claims ${RARITY_BADGE[offer.rarity]} *${offer.name}* (id \`${item.id}\`).`;
  const flavorLine = `_${flavor}_`;
  return advanceDungeonRoom(payload, env, ctx, quest, character, [headline, flavorLine]);
}

// Merchant room — buy stocked items with gold, or walk past. Stock is dungeon-
// instance-scoped: items not bought before advancing are gone forever.
//   /sq choose 1..N → buy item N (deducts gold + adds to inventory)
//   /sq choose N+1 → walk past
async function resolveMerchantChoice(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  exp: ExpeditionState,
  node: ExpeditionNode,
  idx: number,
): Promise<CommandResponse> {
  const stock = node.loot_options ?? [];
  const skipIdx = stock.length + 1;
  if (idx < 1 || idx > skipIdx) {
    return ephemeral(`Usage: \`${payload.command} choose <1-${skipIdx}>\` (last option = walk past).`);
  }
  if (idx === skipIdx) {
    return advanceDungeonRoom(payload, env, ctx, quest, character, [
      `🛒 <@${payload.user_id}> waves the merchant off and walks on.`,
    ]);
  }

  const choice = stock[idx - 1];
  const price = merchantPrice(choice.item_type, choice.rarity);
  if (character.gold < price) {
    return ephemeral(
      `🛒 *${choice.name}* costs ${price}g — you have ${character.gold}g. \`${payload.command} choose ${skipIdx}\` to walk past.`,
    );
  }

  // Atomic gold deduct so two players can't double-spend the same gold pile.
  const paid = await tryDeductGold(env.DB, payload.user_id, price);
  if (!paid) {
    return ephemeral(`Couldn't afford that — looks like the gold went elsewhere.`);
  }

  // Remove this item from the merchant's stock so it can't be bought twice.
  // Also set node.scene = updated to reflect the sold state for future renders.
  const remainingStock = stock.filter((_, i) => i !== idx - 1);
  const updatedNode: ExpeditionNode = { ...node, loot_options: remainingStock };
  const updatedExp: ExpeditionState = {
    ...exp,
    nodes: exp.nodes.map((n, i) => (i === exp.current ? updatedNode : n)),
  };
  const updatedScene: SceneJson = { ...quest.scene, expedition: updatedExp };
  await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);

  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: choice.slot,
    stat_bonus: choice.stat_bonus,
    item_subtype: choice.item_subtype,
  });
  await appendLog(env.DB, quest.id, payload.user_id, "merchant", `bought ${item.item_name} for ${price}g`);

  const headline = `🛍️ <@${payload.user_id}> buys ${RARITY_BADGE[choice.rarity]} *${choice.name}* from the merchant for *${price}g* (id \`${item.id}\`, now ${character.gold - price}g).`;
  // Don't advance — let the player potentially buy a second item. Return the
  // updated room render so they see what's left.
  const roomBody = renderDungeonRoom(updatedNode, updatedExp, payload.command);
  const blocks = await buildDungeonRoomBlocks(updatedNode, updatedExp, payload.command, env, ctx);
  ctx.waitUntil(postToThread(env, quest, [blockQuote(headline), "", roomBody].join("\n")));
  return {
    text: [headline, "", roomBody].join("\n"),
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: headline } },
      ...blocks,
    ],
  };
}

async function handleTake(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return (await lobbyGuard(env.DB, payload.user_id)) ?? ephemeral("You're not on an active quest.");

  if (quest.scene.graph) return handleGraphTake(payload, args, env, quest);

  if (quest.scene.variant !== "dungeon" || !quest.scene.expedition) {
    return ephemeral("Not an expedition — there's no chest to open here.");
  }

  const exp = quest.scene.expedition;
  const node = exp.nodes[exp.current];
  if (!node || node.type !== "treasure") {
    return ephemeral("No treasure to take right now.");
  }

  const idx = parseInt(args[0] ?? "", 10);
  const options = node.loot_options ?? [];
  if (Number.isNaN(idx) || idx < 1 || idx > options.length) {
    return ephemeral(`Usage: \`${payload.command} take <1-${options.length}>\`.`);
  }

  const choice = options[idx - 1];

  // Race guard FIRST — only the winning /dnd take advances the expedition. Two
  // simultaneous takers would otherwise both insert items and both call victory.
  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: { ...exp, current: exp.current + 1 },
  };
  const advanced = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!advanced) {
    return ephemeral("Someone else already claimed the treasure.");
  }

  // Past the guard — safe to mutate inventory + resolve victory exactly once.
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: choice.name,
    item_type: choice.item_type,
    power: choice.power,
    rarity: choice.rarity,
    flavor: choice.flavor,
    weapon_range: choice.weapon_range ?? null,
    slot: choice.slot,
    stat_bonus: choice.stat_bonus,
    item_subtype: choice.item_subtype,
  });

  await resolveExpeditionVictory(payload, env, ctx, character, item, quest);

  return ephemeral(
    `🎁 You claim ${RARITY_BADGE[choice.rarity]} *${choice.name}* for the party. Inventory id \`${item.id}\`. Watch the thread for the closer.`,
  );
}

async function resolveDeath(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  fightersBefore: Character[],
  preamble: string[],
): Promise<CommandResponse> {
  const survivors = fightersBefore.filter((c) => c.slack_user_id !== payload.user_id);
  const questEnds = survivors.length === 0;
  const isPerma = quest.elite;

  const ephemeralLines = [...preamble];
  let resultTail = "";

  // `character` here is the DYING character — which may differ from the action's
  // invoker (payload.user_id) now that monster targeting can hit anyone in the party.
  // All death-state writes target character.slack_user_id, not payload.user_id.
  if (isPerma) {
    await deleteCharacter(env.DB, character.slack_user_id);
    await appendLog(env.DB, quest.id, character.slack_user_id, "death", "perma");
    ephemeralLines.push(
      `💀💀 *${character.name}* the ${character.class} is no more.`,
      `_Cause: ${quest.scene.monster_name}. Elite quest — perma-death enforced._`,
      `Roll a new hero with \`${payload.command} roll\`.`,
    );
    resultTail = `💀💀 *${character.name}* the ${character.class} is no more — slain by *${quest.scene.monster_name}*. Roll a new hero with \`${payload.command} roll\`.`;
  } else {
    // Note: applySoftDeath sets hp = max_hp (post-recovery). No need to write 0 first.
    const scar = generateScar(quest.scene.monster_name);
    const { goldLost, itemLost } = await applySoftDeath(env.DB, character, scar, DOWNED_COOLDOWN_MS);
    await appendLog(env.DB, quest.id, character.slack_user_id, "death", `soft, -${goldLost} gold`);
    // Death achievements
    {
      const stats = await getLifetimeStats(env.DB, character.slack_user_id);
      const charAfter = await getCharacter(env.DB, character.slack_user_id);
      if (charAfter) {
        const deathIds = checkDeathAchievements({
          existingAchievements: charAfter.achievements,
          newScarsCount: charAfter.scars.length,
          totalSoftDeaths: stats.deaths_soft,
        });
        for (const id of deathIds) {
          await grantAchievement(env.DB, character.slack_user_id, id);
        }
      }
    }
    const recoveryTs = Math.floor((Date.now() + DOWNED_COOLDOWN_MS) / 1000);
    ephemeralLines.push(
      `💀 <@${character.slack_user_id}> (*${character.name}*) is *downed*.`,
      `Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_.`,
      `Recover by <!date^${recoveryTs}^{date_short_pretty} {time}|in ~12h>.`,
    );
    resultTail = `💀 <@${character.slack_user_id}> (*${character.name}*) is downed. Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_. Recover <!date^${recoveryTs}^{date_short_pretty}|in ~12h>.`;
  }

  if (questEnds) {
    clearJoinableCard(env, quest);
    await markQuestStatus(env.DB, quest.id, "failed");
    await clearPartyEffects(env.DB, quest.id);
    ephemeralLines.push(`☠️ The party is broken. Quest fails.`);
  } else {
    ephemeralLines.push(
      `Survivors fight on: ${survivors.map((s) => `*${s.name}*`).join(", ")}.`,
    );
  }

  const survivorsTail = questEnds
    ? `☠️ The party is broken. Quest fails.`
    : `Survivors fight on: ${survivors.map((s) => `*${s.name}*`).join(", ")}.`;

  ctx.waitUntil((async () => {
    // Post the death-blow combat line to thread first so partymates see how the
    // character fell (the monster's hit, the trap fail, etc.). Without this, the
    // killing line is ephemeral-only and partymates jump straight to "downed."
    await postToThread(env, quest, blockQuote(preamble.join("\n")));

    const flavor = await flavorDeath(env.AI, character, quest.scene.monster_name, isPerma);
    const marker = isPerma ? "💀💀 " : "💀 ";

    // When the death ENDS the quest (last fighter falls), use the quest-end fanfare
    // header — same shape as victory but with the failure styling. Otherwise stay
    // with the lighter inline death post.
    if (questEnds) {
      const blocks = buildQuestEndBlocks({
        outcome: "failure",
        headline: "QUEST FAILED",
        narration: `${marker}${flavor}`,
        body: [resultTail, survivorsTail],
      });
      const fallback = `☠️ QUEST FAILED\n${blockQuote(`${marker}${flavor}`)}\n${resultTail}\n${survivorsTail}`;
      // Always broadcast a quest-failure ending — same logic as victories.
      await postToThread(env, quest, fallback, { broadcast: true, blocks });
      return;
    }

    // Mid-quest death (party survives) — stays in-thread regardless of perma vs soft.
    // Channel only sees the quest START + FINISH posts.
    await postToThread(env, quest, `${blockQuote(`${marker}${flavor}`)}\n\n${resultTail}\n${survivorsTail}`);
  })());

  return ephemeral(ephemeralLines.join("\n"));
}

async function handleJoin(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't quest right now.");
  }

  const existing = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (existing) {
    // Distinguish "you're already in THIS quest" from "you're on a quest
    // elsewhere" — the former is the common case for the quest creator
    // clicking their own recruitment card's [Join here] button and the
    // generic "you're on a quest in <channel>" message reads as confusing
    // noise (it points at the same channel they're in).
    if (existing.channel_id === payload.channel_id) {
      return ephemeral(
        `You're already in this quest. \`${payload.command} attack\` to fight, \`${payload.command} look\` to see where you are.`,
      );
    }
    return ephemeral(`You're already on an active quest in <#${existing.channel_id}>.`);
  }

  const quest = await getActiveQuestInChannel(env.DB, payload.channel_id);
  if (!quest) return ephemeral(`No active quest in this channel. Start one with \`${payload.command} quest\`.`);

  // Gauntlet locks once wave 2+ begins; up through wave 1 you can still join. Joiners
  // get caught up by the existing scaleMonsterForJoin HP bump.
  if (quest.scene.variant === "gauntlet" && (quest.scene.wave ?? 1) > 1) {
    return ephemeral("⚔️ Gauntlet has already advanced past wave 1 — too late to join.");
  }
  // Dungeon locks once the entry combat is resolved (pending door pick set, or any
  // subsequent room visited). Joiners don't get to retroactively affect decisions.
  if (quest.scene.variant === "dungeon") {
    const exp = quest.scene.expedition;
    const advanced = (exp?.visited_count ?? 1) > 1 || (exp?.pending_doors?.length ?? 0) > 0;
    if (advanced) {
      return ephemeral(`🗺️ The party has already started making decisions — too late to join. Wait for the next \`${payload.command} quest\`.`);
    }
  }

  const inserted = await joinQuest(env.DB, quest.id, payload.user_id);
  if (!inserted) return ephemeral("You're already on this quest.");

  // Joiners get mana refill + armor pool init — same effect as starting the quest.
  await refillMana(env.DB, payload.user_id);
  await initArmorPool(env.DB, payload.user_id);

  const scaled = await scaleMonsterForJoin(env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
  await appendLog(env.DB, quest.id, payload.user_id, "join", `monster +${scaled.monster_max_hp - quest.scene.monster_max_hp} HP`);

  // Patch the in-memory DO state so the new fighter appears in live combat.
  // Fire-and-forget: no-op when the DO isn't running yet.
  if (env.QUEST_ROOM) {
    const doId = questRoomId(env, quest.id);
    if (doId) {
      const stub = env.QUEST_ROOM.get(doId) as unknown as QuestRoomStub;
      ctx.waitUntil(
        stub.notifyFighterJoined(quest.id, payload.user_id, scaled.monster_max_hp)
          .catch((err) => console.warn("notifyFighterJoined failed", err)),
      );
    }
  }

  // Joiners post arrives with the actor's character card so the rest of the party can
  // see the new arrival's HP/mana at a glance — same 2-card grid as combat actions.
  ctx.waitUntil((async () => {
    const flavor = await flavorJoin(env.AI, character, scaled.monster_name);
    const narration = `🛡️ ${flavor}`;
    const fallback = [
      blockQuote(narration),
      "",
      formatMonsterLine({ ...quest.scene, monster_name: scaled.monster_name, monster_hp: scaled.monster_hp, monster_max_hp: scaled.monster_max_hp }, scaled.monster_hp),
      `*${character.name}* — ${character.hp}/${character.max_hp}${character.shield > 0 ? ` 🛡${character.shield}` : ""}${character.max_mana > 0 ? ` ✨${character.mana}/${character.max_mana}` : ""}`,
    ].join("\n");
    const blocks = buildCombatBlocks({
      narration,
      scene: { ...quest.scene, monster_name: scaled.monster_name, monster_hp: scaled.monster_hp, monster_max_hp: scaled.monster_max_hp },
      monsterHp: scaled.monster_hp,
      actor: character,
    });
    await postToThread(env, quest, fallback, { blocks });
  })());

  return ephemeral(
    `🛡️ You join the fight as *${character.name}* the ${character.class}. *${scaled.monster_name}*: ${scaled.monster_hp}/${scaled.monster_max_hp} HP.`,
  );
}

async function handleParty(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");
  const party = await getQuestParty(env.DB, quest.id);
  const lines = [
    `*Quest party* — facing *${quest.scene.monster_name}* (${quest.scene.monster_hp}/${quest.scene.monster_max_hp} HP)`,
    ...party.map((c) => {
      const status = isFighter(c) ? "" : " 💀_downed_";
      return `• ${positionEmoji(c.position)} *${c.name}* the ${c.class} — L${c.level}, HP ${c.hp}/${c.max_hp}${status}`;
    }),
  ];
  return ephemeral(lines.join("\n"));
}

// /sq look — re-renders the current quest state ephemerally so a scrolled-past
// player can see where they are. Aliased as `/sq where` and `/sq scene`.
async function handleLook(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) {
    return ephemeral(`You're not on an active quest. Try \`${payload.command} quest\` to start one.`);
  }

  if (quest.scene.variant === "dungeon" && quest.scene.graph) {
    const graph = quest.scene.graph;
    const node = graph.nodes[graph.current];
    if (!node) return ephemeral("Dungeon state is corrupted.");
    const liveHp = node.encounter && !node.encounter.cleared ? quest.scene.monster_hp : undefined;
    const nodeWithLiveHp: DungeonNode = liveHp !== undefined && node.encounter
      ? { ...node, encounter: { ...node.encounter, monsters: node.encounter.monsters.map((m, i) => i === 0 ? { ...m, hp: liveHp } : m) } }
      : node;
    return ephemeral(renderGraphRoom(nodeWithLiveHp, graph, payload.command));
  }

  if (quest.scene.variant === "dungeon" && quest.scene.expedition) {
    const exp = quest.scene.expedition;
    if (exp.pending_doors && exp.pending_doors.length > 0) {
      return {
        text: renderDoorPrompt(exp, payload.command),
        response_type: "ephemeral",
        blocks: buildDoorPromptBlocks(exp, payload.command),
      };
    }
    const node = exp.nodes[exp.current];
    if (node) {
      // For combat rooms, pass the live monster HP from the active scene so
      // /sq look reflects the in-progress fight (not the starting state).
      // Non-combat rooms ignore this param — they don't carry monster state.
      const liveHp = node.type === "combat" ? quest.scene.monster_hp : undefined;
      return {
        text: renderDungeonRoom(node, exp, payload.command, liveHp),
        response_type: "ephemeral",
        blocks: await buildDungeonRoomBlocks(node, exp, payload.command, env, ctx, liveHp),
      };
    }
  }

  // Non-dungeon: show monster + scene. Render with blocks when a portrait
  // is available so /look re-shows the image alongside the prose; otherwise
  // fall back to plain ephemeral text.
  const lines = [`*${quest.scene.monster_name}* — HP ${quest.scene.monster_hp}/${quest.scene.monster_max_hp}`];
  if (quest.scene.variant === "gauntlet" && quest.scene.wave && quest.scene.total_waves) {
    lines.push(`Wave ${quest.scene.wave}/${quest.scene.total_waves}`);
  }
  if (quest.scene.variant === "boss" && quest.scene.boss_phase === 2) {
    lines.push(`_Phase 2 — enraged_`);
  }
  lines.push("", blockQuote(quest.scene.scene));
  const text = lines.join("\n");
  if (quest.scene.monster_art_url) {
    return {
      text,
      response_type: "ephemeral",
      blocks: [
        { type: "image", image_url: quest.scene.monster_art_url, alt_text: quest.scene.monster_name },
        { type: "section", text: { type: "mrkdwn", text } },
      ],
    };
  }
  return ephemeral(text);
}

async function handleInventory(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const items = await getInventory(env.DB, payload.user_id);
  const keyDisplay = characterKeyDisplay(character);
  const keyLine = keyDisplay ? `Keys: ${keyDisplay}` : "";

  if (items.length === 0) {
    const emptyLines = ["Your pack is empty. Win quests to find loot."];
    if (keyLine) emptyLines.push("", keyLine);
    return ephemeral(emptyLines.join("\n"));
  }

  // Sort equipped items to the top, then by id desc (newest first) within each
  // group. Equipped items render under an "Equipped" subheader so they pop visually.
  const equippedItems = items.filter((i) => i.equipped).sort((a, b) => b.id - a.id);
  const packItems = items.filter((i) => !i.equipped).sort((a, b) => b.id - a.id);

  // Hoist the keys detection up here — we need it for the block-budget math
  // before we start pushing chrome blocks. Same logic re-used at the bottom.
  const heldTiers: KeyTier[] = [];
  if (character.keys_bronze > 0) heldTiers.push("bronze");
  if (character.keys_silver > 0) heldTiers.push("silver");
  if (character.keys_gold > 0) heldTiers.push("gold");

  // Slack hard-caps messages at 50 blocks. Inventory is the only screen that
  // grows unbounded with player progression — once a player carries enough
  // loot, the per-item (section + actions) pairs push us over the cap and
  // Slack rejects the whole response with `invalid_command_response`. So we
  // budget the fixed chrome (image, headers, keys, footer) and truncate the
  // pack list (never the equipped list — it's always small) to fit. Hidden
  // items get surfaced via a "+N more" hint in the footer.
  const SLACK_BLOCK_CAP = 50;
  let chromeBlocks = 1 /* header */ + 1 /* footer */;
  if (env.IMAGE_BASE_URL) chromeBlocks += 1; // banner
  // New equipped rendering: 1 slot-summary section + 1 actions block per equipped item.
  if (equippedItems.length > 0) chromeBlocks += 1 + equippedItems.length; // slot summary + unequip rows
  if (equippedItems.length > 0 && packItems.length > 0) chromeBlocks += 2; // pack divider + subheader
  if (heldTiers.length > 0) chromeBlocks += 2; // keys section + keys actions
  const packBudgetBlocks = SLACK_BLOCK_CAP - chromeBlocks;
  const maxPackItems = Math.max(0, Math.floor(packBudgetBlocks / 2));
  const visiblePackItems = packItems.slice(0, maxPackItems);
  const hiddenItemCount = packItems.length - visiblePackItems.length;

  // Per-item: section block (item description) + actions block ([Equip] [Use] [Sell]).
  // The actions block carries action_id values that the /slack/interactive endpoint
  // routes via handleInteraction. value = inventory id as string.
  const blocks: unknown[] = [];
  // Lazy-cached AI-generated banner. First miss schedules gen via waitUntil
  // and returns null (we skip the image this once); subsequent renders hit
  // the R2 cache. Same Elmore/Easley style anchor as the monster portraits
  // so the bot's visual language stays unified.
  const inventoryArt = await viewArt(env, ctx, "inventory");
  if (inventoryArt) {
    blocks.push({
      type: "image",
      image_url: inventoryArt,
      alt_text: "your pack",
    });
  }
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Inventory — ${items.length} item${items.length > 1 ? "s" : ""}` },
  });
  // ── Equipped section: one slot-summary section + one actions row per item ──
  if (equippedItems.length > 0) {
    const SLOT_EMOJI_MAP: Record<string, string> = {
      main_hand: "⚔️", off_hand: "🛡️", body: "🧥", helmet: "🪖",
      pants: "👖", boots: "👟", ring: "💍", amulet: "📿",
    };
    const SLOT_NAME_MAP: Record<string, string> = {
      main_hand: "Main Hand", off_hand: "Off Hand", body: "Body", helmet: "Helmet",
      pants: "Legs", boots: "Boots", ring: "Ring", amulet: "Amulet",
    };
    const ALL_EQUIP_SLOTS: EquipSlot[] = ["main_hand", "off_hand", "body", "helmet", "pants", "boots", "ring", "amulet"];
    const equippedBySlot = new Map(
      equippedItems.map((i) => [i.slot ?? (i.item_type === "weapon" ? "main_hand" : "body"), i])
    );
    const slotLines: string[] = [];
    const emptySlots: string[] = [];
    for (const s of ALL_EQUIP_SLOTS) {
      const ei = equippedBySlot.get(s);
      if (ei) {
        const powerStr = powerLabel(ei.item_type, ei.power, ei.item_name);
        const statLine = ei.stat_bonus
          ? ` · ${Object.entries(ei.stat_bonus).map(([k, v]) => formatStatBonusEntry(k, v)).join(", ")}`
          : "";
        slotLines.push(`${SLOT_EMOJI_MAP[s]} *${SLOT_NAME_MAP[s]}:* ${ei.item_name} — ${powerStr}${statLine}`);
      } else {
        emptySlots.push(SLOT_NAME_MAP[s]);
      }
    }
    if (emptySlots.length > 0) slotLines.push(`_${emptySlots.join(", ")} — empty_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*✅ Equipped*\n${slotLines.join("\n")}` },
    });
    for (const item of equippedItems) {
      const sellPrice = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
      blocks.push({
        type: "actions",
        block_id: `inv_eq_${item.id}`,
        elements: [
          { type: "button", action_id: "unequip", value: String(item.id), text: { type: "plain_text", text: `Unequip ${item.item_name}` } },
          {
            type: "button", action_id: "sell", value: String(item.id),
            text: { type: "plain_text", text: `Sell ${sellPrice}g` }, style: "danger",
            confirm: {
              title: { type: "plain_text", text: "Sell equipped item?" },
              text: { type: "mrkdwn", text: `Unequip and sell *${item.item_name}* for ${sellPrice}g?` },
              confirm: { type: "plain_text", text: "Sell" }, deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      });
    }
  }

  // ── Pack section ─────────────────────────────────────────────────────────
  if (visiblePackItems.length > 0) {
    if (equippedItems.length > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🎒 Pack — ${packItems.length}*` },
    });
  }
  for (const item of visiblePackItems) {
    const locked = item.level_req > 1 && character.level < item.level_req;
    const lockPrefix = locked ? "🔒 " : "";
    const levelGate = locked ? ` _(requires L${item.level_req})_` : "";
    const powerStr = powerLabel(item.item_type, item.power, item.item_name);
    const effect = catalogEffectLine(item.item_name);
    const effectLine = effect ? `\n${effect}` : "";
    const flavorLine = item.flavor ? `\n_${item.flavor}_` : "";
    const summary = `${lockPrefix}\`${item.id}\` ${RARITY_BADGE[item.rarity]} *${item.item_name}* — ${item.item_type}${rangeBadge(item)}, ${powerStr}${levelGate}${effectLine}${flavorLine}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: summary } });

    const elements: unknown[] = [];
    const isEquippable = item.slot !== null && !locked;
    const isUsable = item.item_type === "consumable" || item.item_type === "magic" || item.item_type === "revive" || item.item_type === "tool" || item.item_type === "scroll";
    if (isEquippable) {
      elements.push({ type: "button", action_id: "equip", value: String(item.id), text: { type: "plain_text", text: "Equip" } });
    }
    if (isUsable) {
      elements.push({ type: "button", action_id: "use", value: String(item.id), text: { type: "plain_text", text: "Use" }, style: "primary" });
    }
    const sellPrice = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
    elements.push({
      type: "button", action_id: "sell", value: String(item.id),
      text: { type: "plain_text", text: `Sell ${sellPrice}g` }, style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Sell this item?" },
        text: { type: "mrkdwn", text: `Sell *${item.item_name}* for ${sellPrice}g? This is permanent.` },
        confirm: { type: "plain_text", text: "Sell" }, deny: { type: "plain_text", text: "Cancel" },
      },
    });
    blocks.push({ type: "actions", block_id: `inv_${item.id}`, elements });
  }

  // Keys section — rendered separately from the footer so we can attach action
  // buttons (sell / transmute) per tier the player holds. heldTiers is hoisted
  // above so the block-budget math can account for these blocks. No divider
  // here — drops one block off the chrome budget and the section header
  // already provides visual separation.
  if (heldTiers.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🗝️ Keys*\n${keyDisplay}` },
    });
    const keyActions: unknown[] = [];
    for (const tier of heldTiers) {
      // action_id must be unique within an actions block — encode the tier in
      // the id so Slack doesn't reject the message.
      keyActions.push({
        type: "button",
        action_id: `key_sell_${tier}`,
        value: tier,
        text: { type: "plain_text", text: `💰 Sell ${KEY_EMOJI[tier]} (${KEY_SELL_PRICE[tier]}g)` },
      });
    }
    // Transmute buttons — only for tiers where the player has at least 3 AND
    // there's a tier above to upgrade into.
    for (const tier of (["bronze", "silver"] as const)) {
      if (keyCount(character, tier) >= KEY_TRANSMUTE_COST) {
        const upTier = nextKeyTier(tier)!;
        keyActions.push({
          type: "button",
          action_id: `key_transmute_${tier}`,
          value: tier,
          text: { type: "plain_text", text: `⚗️ ${KEY_TRANSMUTE_COST}${KEY_EMOJI[tier]} → 1${KEY_EMOJI[upTier]}` },
          style: "primary",
        });
      }
    }
    if (keyActions.length > 0) {
      blocks.push({ type: "actions", block_id: "inv_keys", elements: keyActions });
    }
  }

  // Footer: slash-command hints. (Keys moved to their own section above.)
  // When the pack overflowed the block budget we surface the hidden count here
  // along with the slash form so players can still reach the truncated items.
  const overflowNote = hiddenItemCount > 0
    ? `_+${hiddenItemCount} more in pack — sell oldest with \`${payload.command} sell <id>\` to see the rest._  •  `
    : "";
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${overflowNote}_Slash forms: \`${payload.command} equip <id>\` • \`${payload.command} unequip <id>\` • \`${payload.command} use <id>\` • \`${payload.command} sell <id>\` • \`${payload.command} sell-key <tier>\` • \`${payload.command} transmute <tier>\`._` }],
  });

  // Plain-text fallback for clients/contexts that don't render Block Kit.
  const fallback = items
    .map((it) => `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}, ${powerLabel(it.item_type, it.power, it.item_name)}${it.equipped ? " ✅" : ""}`)
    .join("\n");
  return { text: fallback, response_type: "ephemeral", blocks };
}

async function handleEquip(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} equip <inventory id>\` (find ids with \`${payload.command} inventory\`).`);

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.item_type === "consumable") {
    return ephemeral(`Consumables can't be equipped — use them with \`${payload.command} use <id>\`.`);
  }
  if (item.equipped) return ephemeral(`*${item.item_name}* is already equipped.`);

  // Off-hand slot only accepts shields in Phase 2.
  if (item.slot === "off_hand" && item.item_subtype !== "shield") {
    return ephemeral(`Only shields can go in the off-hand slot. Dual-wielding is not yet supported.`);
  }

  if (character.level < item.level_req) {
    return ephemeral(`⚠️ You need to be level ${item.level_req} to equip *${item.item_name}*.`);
  }

  // 🔮 Focus weapon swap bookkeeping. Equipping a focus bumps max_mana
  // by FOCUS_MAX_MANA_BONUS (and current mana too); unequipping the
  // focus to swap to another weapon refunds that bonus. Only the
  // weapon slot has this dynamic — armor doesn't carry mana.
  let manaShiftLine = "";
  if (item.item_type === "weapon") {
    const prevWeapon = await getEquipped(env.DB, payload.user_id, "weapon");
    const prevBonus = prevWeapon?.weapon_range === "focus" ? FOCUS_MAX_MANA_BONUS : 0;
    const newBonus = item.weapon_range === "focus" ? FOCUS_MAX_MANA_BONUS : 0;
    const delta = newBonus - prevBonus;
    if (delta !== 0) {
      await applyFocusManaShift(env.DB, payload.user_id, delta);
      if (delta > 0) manaShiftLine = ` 🔮 *+${delta}* max mana (now ${character.max_mana + delta}/${character.max_mana + delta}).`;
      else manaShiftLine = ` 🔮 *${delta}* max mana (now ${character.max_mana + delta}).`;
    }
  }

  const slotLabel = item.slot ?? item.item_type;
  const statLine = item.stat_bonus
    ? ` · ${Object.entries(item.stat_bonus).map(([k, v]) => formatStatBonusEntry(k, v)).join(", ")}`
    : "";
  await equipItem(env.DB, item);
  return ephemeral(
    `✅ Equipped *${item.item_name}* (${slotLabel}${rangeBadge(item)}, +${item.power}${statLine}). Previous ${slotLabel} unequipped.${manaShiftLine}`,
  );
}

// /sq unequip <id> — drops the named item back into the pack without
// requiring a replacement. Useful when a player wants to fight bare-handed
// or empty a slot to free up the position-based ranged/melee toggle.
async function handleUnequip(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} unequip <inventory id>\` (find ids with \`${payload.command} inventory\`).`);

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (!item.equipped) return ephemeral(`*${item.item_name}* isn't equipped.`);

  // 🔮 Unequipping a focus refunds the max_mana bonus and clamps
  // current mana down if needed.
  let manaShiftLine = "";
  if (item.item_type === "weapon" && item.weapon_range === "focus") {
    await applyFocusManaShift(env.DB, payload.user_id, -FOCUS_MAX_MANA_BONUS);
    manaShiftLine = ` 🔮 *-${FOCUS_MAX_MANA_BONUS}* max mana (now ${character.max_mana - FOCUS_MAX_MANA_BONUS}).`;
  }

  await unequipItem(env.DB, item);
  const unequipSlotLabel = item.slot ?? item.item_type;
  return ephemeral(
    `🎒 Unequipped *${item.item_name}* (${unequipSlotLabel}${rangeBadge(item)}, +${item.power}). Slot is now empty.${manaShiftLine}`,
  );
}

async function handleUse(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  // Non-integer arg → graph dungeon object interaction.
  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) {
    const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
    if (quest?.scene.graph) return handleGraphUseObject(payload, args, env, quest);
    return ephemeral(`Usage: \`${payload.command} use <inventory id>\` (find ids with \`${payload.command} inventory\`).`);
  }

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");

  if (item.item_type === "tool" || item.item_type === "scroll") {
    return useToolOrScroll(payload, env, ctx, character, item);
  }

  // Lookup active quest once — both magic and consumable uses post to thread when
  // mid-quest so the rest of the party sees the action. Out-of-quest use stays
  // ephemeral (no thread to post to).
  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);

  if (item.item_type === "magic") {
    if (character.max_mana >= MAX_MANA_CAP) {
      return ephemeral(`Already at the max-mana cap (${MAX_MANA_CAP}). Sell it instead with \`${payload.command} sell ${item.id}\`.`);
    }
    const result = await bumpMaxMana(env.DB, character, item.power);
    await removeItem(env.DB, item.id);
    const wasted = item.power - result.added;
    const wastedNote = wasted > 0 ? ` (${wasted} over the cap, lost)` : "";
    const headline = `🔮 <@${payload.user_id}> channels *${item.item_name}* — *+${result.added}* max mana${wastedNote}. (${result.newMana}/${result.newMaxMana})`;
    if (activeQuest) {
      ctx.waitUntil(postToThread(env, activeQuest, blockQuote(headline)));
    }
    return ephemeral(headline);
  }

  if (item.item_type !== "consumable") {
    return ephemeral(`*${item.item_name}* isn't usable. Try \`${payload.command} equip ${item.id}\`.`);
  }

  // Staple lookup — Mana Vial / Mana Flask are stored as consumables but
  // restore mana instead of HP. handleUse routes them to the mana branch via
  // the staple catalog. Health potions (also staples) fall through to the
  // default HP-heal path below since they ARE consumables with item.power=HP.
  const staple = findStaple(item.item_name);
  if (staple && staple.effect === "restore_mana") {
    if (character.mana >= character.max_mana) {
      return ephemeral(`Already at max mana (${character.mana}/${character.max_mana}). Save it for when you need it.`);
    }
    const added = await addMana(env.DB, character, staple.power);
    await removeItem(env.DB, item.id);
    const newMana = character.mana + added;
    const wasted = staple.power - added;
    const wastedNote = wasted > 0 ? ` (${wasted} over cap)` : "";
    const headline = `✨ <@${payload.user_id}> drinks *${item.item_name}* — restores *${added}* mana${wastedNote}. (${newMana}/${character.max_mana})`;
    if (activeQuest) {
      ctx.waitUntil(postToThread(env, activeQuest, blockQuote(headline)));
    }
    return ephemeral(headline);
  }

  if (character.hp >= character.max_hp) {
    return ephemeral("You're already at full HP — save it for when you need it.");
  }

  const healed = await consumeItem(env.DB, character, item);
  const newHp = character.hp + healed;
  const headline = `🧪 <@${payload.user_id}> drinks *${item.item_name}* — recovered *${healed}* HP. (${newHp}/${character.max_hp})`;
  if (activeQuest) {
    ctx.waitUntil(postToThread(env, activeQuest, blockQuote(headline)));
  }
  return ephemeral(headline);
}

// /sq use for catalog items (tool / scroll). Each catalog name dispatches to a
// fixed effect handler below. All tool/scroll uses:
//   1. Require an active quest with a live foe (damage tools) or just an active quest.
//   2. Spend a combat turn (action cooldown). Damage tools also trigger monster
//      retaliation since they're an offensive action; free-action variants
//      (Espresso Shot, Rebase Scroll) skip both cooldown and retaliation.
//   3. Consume the item on use.
//
// v1 limitation: damage tools cap at monster_hp - 1 so they never deliver the
// killing blow. Reason: avoids a refactor of handleCombat's kill-flow branches
// (gauntlet/dungeon/standard). Player follows up with /sq attack to finish.
async function useToolOrScroll(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
): Promise<CommandResponse> {
  if (!isFighter(character)) return ephemeral("You're downed and can't act.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) {
    return ephemeral(`*${item.item_name}* needs a foe in front of you. Pick up a quest first.`);
  }

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  const entry = findCatalogEntry(item.item_name);
  if (!entry) {
    return ephemeral(`Unknown effect for *${item.item_name}*. Try selling it.`);
  }

  if (entry.name === "Caffeine Bomb" || entry.name === "Hotfix Grenade") {
    return useDamageTool(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Rebase Scroll") {
    return useRebaseScroll(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Production Outage") {
    return useProductionOutage(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Espresso Shot") {
    return useEspressoShot(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Poison Vial") {
    return usePoisonVial(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Venom Vial") {
    return useVenomVial(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Regen Draft") {
    return useRegenDraft(payload, env, ctx, character, item, quest, entry);
  }
  if (entry.name === "Battle Elixir") {
    return useBattleElixir(payload, env, ctx, character, item, quest, entry);
  }
  return ephemeral(`*${item.item_name}* doesn't have a wired-up effect yet.`);
}

// Espresso Shot — self-applies 🟢 Regen for 5 actions at item.power HP/tick.
// Free action variant: the buff applies but the monster does NOT retaliate (it's
// a quick chug, not a swing). Item is consumed.
async function useEspressoShot(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  const newEffect: StatusEffect = {
    type: "regen",
    magnitude: item.power,
    remaining: 5,
    source: entry.name,
  };
  const updated = withEffectApplied(character.effects ?? [], newEffect);
  await setCharacterEffects(env.DB, payload.user_id, updated);
  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: regen +${item.power} × 5`);

  const playerLine = `${entry.emoji} <@${payload.user_id}> chugs *${item.item_name}* — gains 🟢 *Regen* (+${item.power} HP × 5 actions). _(free action)_`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(playerLine)));
  return ephemeral(playerLine);
}

// Poison Vial — applies ☠️ Poisoned to the monster for 4 ticks at item.power HP each.
// Tool consumes a turn (cooldown + monster retaliates).
async function usePoisonVial(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  if (!hasLiveMonster(quest)) {
    return ephemeral(`*${item.item_name}* needs a live foe to inject.`);
  }
  const newEffect: StatusEffect = {
    type: "poisoned",
    magnitude: item.power,
    remaining: 4,
    source: entry.name,
  };
  const updatedMonsterEffects = withEffectApplied(quest.scene.monster_effects ?? [], newEffect);
  const updatedScene: SceneJson = { ...quest.scene, monster_effects: updatedMonsterEffects };
  const ok = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!ok) return ephemeral("⏱️ The fight moved on. Your tool wasn't consumed — try again.");

  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: poison ${item.power}/tick × 4`);

  const playerLine = `${entry.emoji} <@${payload.user_id}> hurls *${item.item_name}* — *${quest.scene.monster_name}* is now ☠️ *Poisoned* (-${item.power} HP × 4 turns).`;

  // Tick caster's status effects — Poison Vial consumes a turn.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const tick = await applyPlayerTick(env, payload.user_id, character);
  if (tick.postTickHp <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, ...tick.tickLines]);
  }

  // Tool consumes a turn — monster gets a swing in retaliation.
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, tick.character, actorArmor);

  if (turn.isSplash && turn.splashTargets) {
    const firstKilled = turn.splashTargets.find((st) => st.willKill);
    if (firstKilled) {
      for (const st of turn.splashTargets.filter((s) => !s.willKill)) {
        await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
      }
      await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
      return resolveDeath(payload, env, ctx, firstKilled.fighter, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
    }
    for (const st of turn.splashTargets) {
      await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
    }
    await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
    await persistNextTelegraph(env, quest, fighters, turn);
    const splashStatLines = turn.splashTargets.map((st) => {
      const sh = st.dmg.newShield > 0 ? ` 🛡${st.dmg.newShield}` : "";
      return `${st.fighter.slack_user_id === tick.character.slack_user_id ? `*${st.fighter.name}*` : `<@${st.fighter.slack_user_id}> (*${st.fighter.name}*)`}: ${st.dmg.newHp}/${st.fighter.max_hp}${sh}`;
    });
    const ephem = [playerLine, ...tick.tickLines, turn.monsterLine, ...splashStatLines].join("\n");
    ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, turn.monsterLine, ...splashStatLines].join("\n")));
    return ephemeral(ephem);
  }

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name} <@${turn.target.slack_user_id}>`);
  await persistNextTelegraph(env, quest, fighters, turn);

  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `${turn.victimWasActor ? `*${turn.target.name}*` : `<@${turn.target.slack_user_id}> (*${turn.target.name}*)`}: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, ...tick.tickLines, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
}

// Caffeine Bomb / Hotfix Grenade — deal item.power damage, ignores armor, capped
// at monster_hp - 1. Triggers monster retaliation (consumes a combat turn).
async function useDamageTool(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  if (!hasLiveMonster(quest)) {
    return ephemeral(`*${item.item_name}* needs a live foe. Save it for the next combat room.`);
  }
  // Cap at monster_hp - 1 so v1 tools never deliver the kill blow (see useToolOrScroll header).
  const requested = item.power;
  const damage = Math.max(1, Math.min(requested, quest.scene.monster_hp - 1));
  const newMonsterHp = quest.scene.monster_hp - damage;
  const updatedScene: SceneJson = { ...quest.scene, monster_hp: newMonsterHp };

  const ok = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!ok) return ephemeral("⏱️ The fight moved on. Your tool wasn't consumed — try again.");

  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: ${damage} dmg`);

  const cappedNote = damage < requested ? ` _(capped from ${requested} — finish it with attack)_` : "";
  const playerLine = `${entry.emoji} <@${payload.user_id}> uses *${item.item_name}* — *${damage}* dmg, ignores armor.${cappedNote}`;

  // Tick the actor's status effects — tools that consume a turn behave like any
  // other combat action.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const tick = await applyPlayerTick(env, payload.user_id, character);
  if (tick.postTickHp <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, ...tick.tickLines]);
  }

  // Monster turn — same plumbing as heal/shield post-effect.
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, tick.character, actorArmor);

  if (turn.isSplash && turn.splashTargets) {
    const firstKilled = turn.splashTargets.find((st) => st.willKill);
    if (firstKilled) {
      for (const st of turn.splashTargets.filter((s) => !s.willKill)) {
        await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
      }
      await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
      return resolveDeath(payload, env, ctx, firstKilled.fighter, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
    }
    for (const st of turn.splashTargets) {
      await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
    }
    await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
    await persistNextTelegraph(env, quest, fighters, turn);
    const monsterStatSplash = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
    const splashStats = turn.splashTargets.map((st) => {
      const sh = st.dmg.newShield > 0 ? ` 🛡${st.dmg.newShield}` : "";
      return `${st.fighter.slack_user_id === tick.character.slack_user_id ? `*${st.fighter.name}*` : `<@${st.fighter.slack_user_id}> (*${st.fighter.name}*)`}: ${st.dmg.newHp}/${st.fighter.max_hp}${sh}`;
    });
    const ephem = [playerLine, ...tick.tickLines, monsterStatSplash, turn.monsterLine, ...splashStats].join("\n");
    ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, monsterStatSplash, turn.monsterLine, ...splashStats].join("\n")));
    return ephemeral(ephem);
  }

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name} <@${turn.target.slack_user_id}>`);
  await persistNextTelegraph(env, quest, fighters, turn);

  const monsterStat = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `${turn.victimWasActor ? `*${turn.target.name}*` : `<@${turn.target.slack_user_id}> (*${turn.target.name}*)`}: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, ...tick.tickLines, monsterStat, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, monsterStat, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
}

// Venom Vial — applies ☠️ Poisoned to monster for 4 turns. Apothecary variant of
// Poison Vial; same mechanic, different name/emoji. Consumes a turn.
async function useVenomVial(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  if (!hasLiveMonster(quest)) {
    return ephemeral(`*${item.item_name}* needs a live foe to inject.`);
  }
  const newEffect: StatusEffect = { type: "poisoned", magnitude: item.power, remaining: 4, source: entry.name };
  const updatedMonsterEffects = withEffectApplied(quest.scene.monster_effects ?? [], newEffect);
  const updatedScene: SceneJson = { ...quest.scene, monster_effects: updatedMonsterEffects };
  const ok = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!ok) return ephemeral("⏱️ The fight moved on. Your item wasn't consumed — try again.");
  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: poison ${item.power}/tick × 4`);

  const playerLine = `${entry.emoji} <@${payload.user_id}> injects *${item.item_name}* — *${quest.scene.monster_name}* is now ☠️ *Poisoned* (-${item.power} HP × 4 turns).`;
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const tick = await applyPlayerTick(env, payload.user_id, character);
  if (tick.postTickHp <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, ...tick.tickLines]);
  }
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, tick.character, actorArmor);
  if (turn.isSplash && turn.splashTargets) {
    const firstKilled = turn.splashTargets.find((st) => st.willKill);
    if (firstKilled) {
      for (const st of turn.splashTargets.filter((s) => !s.willKill)) {
        await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
      }
      await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
      return resolveDeath(payload, env, ctx, firstKilled.fighter, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
    }
    for (const st of turn.splashTargets) {
      await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
    }
    await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
    await persistNextTelegraph(env, quest, fighters, turn);
    const splashStatLines = turn.splashTargets.map((st) => {
      const sh = st.dmg.newShield > 0 ? ` 🛡${st.dmg.newShield}` : "";
      return `${st.fighter.slack_user_id === tick.character.slack_user_id ? `*${st.fighter.name}*` : `<@${st.fighter.slack_user_id}> (*${st.fighter.name}*)`}: ${st.dmg.newHp}/${st.fighter.max_hp}${sh}`;
    });
    const ephem = [playerLine, ...tick.tickLines, turn.monsterLine, ...splashStatLines].join("\n");
    ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, turn.monsterLine, ...splashStatLines].join("\n")));
    return ephemeral(ephem);
  }
  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name} <@${turn.target.slack_user_id}>`);
  await persistNextTelegraph(env, quest, fighters, turn);
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `${turn.victimWasActor ? `*${turn.target.name}*` : `<@${turn.target.slack_user_id}> (*${turn.target.name}*)`}: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, ...tick.tickLines, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
}

// Regen Draft — self-applies 🟢 Regen for 3 turns. Free action (no monster retaliation).
async function useRegenDraft(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  const newEffect: StatusEffect = { type: "regen", magnitude: item.power, remaining: 3, source: entry.name };
  const updated = withEffectApplied(character.effects ?? [], newEffect);
  await setCharacterEffects(env.DB, payload.user_id, updated);
  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: regen +${item.power} × 3`);

  const playerLine = `${entry.emoji} <@${payload.user_id}> quaffs *${item.item_name}* — gains 🟢 *Regen* (+${item.power} HP × 3 actions). _(free action)_`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(playerLine)));
  return ephemeral(playerLine);
}

// Battle Elixir — grants ⚡ Empowered (+25% damage) for 3 turns. Free action.
async function useBattleElixir(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  const newEffect: StatusEffect = { type: "empowered", magnitude: 25, remaining: 3, source: entry.name };
  const updated = withEffectApplied(character.effects ?? [], newEffect);
  await setCharacterEffects(env.DB, payload.user_id, updated);
  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "tool", `${entry.name}: empowered × 3`);

  const playerLine = `${entry.emoji} <@${payload.user_id}> drinks *${item.item_name}* — gains ⚡ *Empowered* (+25% damage × 3 turns). _(free action)_`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(playerLine)));
  return ephemeral(playerLine);
}

// Rebase Scroll — a "fast ritual" treated as a free action:
//   • Wipes action cooldowns for every party member (caster included)
//   • Refills mana to full for every party member
//   • Does NOT consume the caster's turn — no monster retaliation
//
// The free-action framing is what justifies 250g over "just wait 45s": real-time
// waiting only resets your own cooldown and does nothing for mana. Rebase resets
// the WHOLE party AND tops everyone up. Party-wide burst window with the boss
// not swinging back. Use it before a sub-boss for a coordinated sig wave.
//
// Spam-gating: 'scroll' isn't logged in the action list, so back-to-back scrolls
// would technically work — but rare drop weight + 250g price keeps stockpiles
// rare in practice. A v2 limit could add an explicit per-quest cap.
async function useRebaseScroll(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const fighterIds = fighters.map((f) => f.slack_user_id);
  await Promise.all([
    resetCooldownsFor(env.DB, quest.id, fighterIds),
    ...fighterIds.map((uid) => refillMana(env.DB, uid)),
  ]);
  await removeItem(env.DB, item.id);
  // Note: action='scroll_free' is intentionally NOT in cooldownRemaining's filter
  // list, so this use doesn't gate the caster's combat cooldown. Free action.
  await appendLog(env.DB, quest.id, payload.user_id, "scroll_free", `${entry.name}: party cd+mana reset`);

  const partyNote = fighters.length > 1
    ? ` Whole party (${fighters.length}) at full mana, no cooldowns.`
    : ` You're at full mana with no cooldown.`;
  const playerLine = `${entry.emoji} <@${payload.user_id}> reads *${item.item_name}* — fast ritual.${partyNote} _(free action — monster doesn't retaliate)_`;

  // Free action — never trigger monster turn, regardless of whether a foe is alive.
  ctx.waitUntil(postToThread(env, quest, blockQuote(playerLine)));
  return ephemeral(playerLine);
}

// Production Outage — boss: HP × 0.7 (effective -30%). Non-boss: HP → 1 (player's
// next attack ends it). v1 doesn't deliver the killing blow itself (see header).
async function useProductionOutage(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  item: Item,
  quest: ActiveQuest,
  entry: { name: string; emoji: string },
): Promise<CommandResponse> {
  if (!hasLiveMonster(quest)) {
    return ephemeral(`*${item.item_name}* needs a live foe to crash on.`);
  }
  const isBoss = quest.scene.variant === "boss" ||
    (quest.scene.variant === "dungeon" &&
      // sub-boss is the penultimate node in the dungeon; check current node
      quest.scene.expedition?.nodes[quest.scene.expedition.current]?.type === "combat" &&
      quest.scene.expedition.current === (quest.scene.expedition.nodes.length - 2));
  const newMonsterHp = isBoss
    ? Math.max(1, Math.floor(quest.scene.monster_hp * 0.7))
    : 1;
  const damage = quest.scene.monster_hp - newMonsterHp;
  const updatedScene: SceneJson = { ...quest.scene, monster_hp: newMonsterHp };

  const ok = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!ok) return ephemeral("⏱️ The fight moved on. Your scroll wasn't consumed — try again.");

  await removeItem(env.DB, item.id);
  await appendLog(env.DB, quest.id, payload.user_id, "scroll", `${entry.name}: ${damage} dmg (${isBoss ? "boss -30%" : "set to 1HP"})`);

  const effectNote = isBoss
    ? `*${quest.scene.monster_name}* takes *${damage}* damage — production is on fire.`
    : `*${quest.scene.monster_name}* is reduced to *1 HP* — finish it.`;
  const playerLine = `${entry.emoji} <@${payload.user_id}> invokes *${item.item_name}*. ${effectNote}`;

  // Tick caster's status effects — Production Outage consumes a turn.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const tick = await applyPlayerTick(env, payload.user_id, character);
  if (tick.postTickHp <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, ...tick.tickLines]);
  }

  // Monster gets a turn (still alive — we capped at 1).
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, tick.character, actorArmor);

  if (turn.isSplash && turn.splashTargets) {
    const firstKilled = turn.splashTargets.find((st) => st.willKill);
    if (firstKilled) {
      for (const st of turn.splashTargets.filter((s) => !s.willKill)) {
        await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
      }
      await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
      return resolveDeath(payload, env, ctx, firstKilled.fighter, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
    }
    for (const st of turn.splashTargets) {
      await setCharacterHpAndShield(env.DB, st.fighter.slack_user_id, st.dmg.newHp, st.dmg.newShield);
    }
    await appendLog(env.DB, quest.id, "monster", "splash", `splash → all fighters`);
    await persistNextTelegraph(env, quest, fighters, turn);
    const monsterStatSplash = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
    const splashStats = turn.splashTargets.map((st) => {
      const sh = st.dmg.newShield > 0 ? ` 🛡${st.dmg.newShield}` : "";
      return `${st.fighter.slack_user_id === tick.character.slack_user_id ? `*${st.fighter.name}*` : `<@${st.fighter.slack_user_id}> (*${st.fighter.name}*)`}: ${st.dmg.newHp}/${st.fighter.max_hp}${sh}`;
    });
    const ephem = [playerLine, ...tick.tickLines, monsterStatSplash, turn.monsterLine, ...splashStats].join("\n");
    ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, monsterStatSplash, turn.monsterLine, ...splashStats].join("\n")));
    return ephemeral(ephem);
  }

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, ...tick.tickLines, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name} <@${turn.target.slack_user_id}>`);
  await persistNextTelegraph(env, quest, fighters, turn);

  const monsterStat = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `${turn.victimWasActor ? `*${turn.target.name}*` : `<@${turn.target.slack_user_id}> (*${turn.target.name}*)`}: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, ...tick.tickLines, monsterStat, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", ...tick.tickLines, monsterStat, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
}

// =============================================================================
// TOWN / PUB
// =============================================================================
//
// `/sq town` shows a hub map with location buttons. `/sq pub` is the only
// location with content in v1; other locations stub to "Coming Soon" so the
// map looks complete and the path is signalled.
//
// Town state is per-channel (matches shop). Refreshes on a daily cadence
// (NPCs + daily special); the town NAME refreshes weekly so the place
// feels persistent while the people/specials rotate.
//
// Heavy AI work (NPC dialog tree gen, town name gen) runs at refresh time
// only — players walk pre-baked trees with zero per-interaction AI cost.

const TOWN_REFRESH_MS = 24 * 60 * 60 * 1000;    // daily — NPCs + special rotate
const TOWN_NAME_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly — name persists

// Stable date stamp used as a deterministic salt for archetype picking
// + the npc_payloads_claimed refresh_date marker. Floors to UTC midnight.
function todayStamp(): number {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

// Builds a fresh TownState. Two refresh cadences run side-by-side:
//   * Weekly (town_name + bartender) — the persistent face of the place.
//     Players returning across the week see the same bartender with new
//     dialog branches. If the stale state's weekly window is still open,
//     we reuse name + bartender verbatim; otherwise both regenerate.
//   * Daily (regulars + special) — rotates so the pub feels different
//     every day. Two new regulars + a new daily special drink each day.
//
// Cost: weekly bumps generate 1 town-name call + 1 bartender dialog call
// + 2 regular dialog calls = 4 AI calls. Daily-only refreshes generate
// 2 regular dialog calls. All fail-soft to fallback dialog trees.
export async function rebuildTownState(
  env: Env,
  channelId: string,
): Promise<TownState> {
  const now = Date.now();
  const today = todayStamp();

  // Stale-state read bypasses the daily cutoff so we can rescue persistent
  // weekly-scoped data (town name + bartender) across daily refreshes.
  const stale = await getStaleTownState(env.DB, channelId);
  let townName = stale?.town_name ?? "";
  let townNameSetAt = stale?.town_name_set_at ?? 0;
  // Weekly window check. If the existing town name is still fresh we
  // preserve it AND the bartender as a unit (they share the cadence —
  // "the place AND its keeper persist for a week").
  const weeklyStillFresh = !!townName && now - townNameSetAt <= TOWN_NAME_REFRESH_MS;
  if (!weeklyStillFresh) {
    townName = await generateTownName(env.AI, stale?.town_name ? [stale.town_name] : []);
    townNameSetAt = now;
  }

  // Daily salt seeds the regulars + special pick. Stable within a day so
  // reloads don't shuffle the lineup; different day → different pick.
  const nameSeed = (channelId + ":" + today).split("").reduce((a, c) => a + c.charCodeAt(0), 0);

  // ---- Bartender (weekly cadence) ----
  // Reuse the stale bartender if the weekly window is still open AND the
  // stale state actually has a bartender row (paranoid guard). Otherwise
  // regenerate with a fresh archetype + dialog.
  let bartender: NpcSpec;
  if (weeklyStillFresh && stale?.pub?.bartender) {
    bartender = stale.pub.bartender;
  } else {
    const tmpl = pickArchetype(BARTENDER_ARCHETYPES, channelId, today, 0);
    const name = tmpl.name_seeds[(nameSeed + 0) % tmpl.name_seeds.length];
    const dialog = await generateNpcDialog(env.AI, {
      name, archetype: tmpl.archetype, vibe: tmpl.vibe, concern: tmpl.concern,
      role: "bartender", townName,
    });
    bartender = {
      id: "bartender",
      role: "bartender",
      name,
      archetype: tmpl.archetype,
      vibe: tmpl.vibe,
      concern: tmpl.concern,
      dialog: aiToDialogNode(dialog),
    };
  }

  // ---- Regulars (daily cadence) ----
  // Always regenerate. Pick deterministically per (channel, day, slot).
  const regular1Template = pickArchetype(REGULAR_ARCHETYPES, channelId, today, 1);
  let regular2Template = pickArchetype(REGULAR_ARCHETYPES, channelId, today, 2);
  if (regular2Template === regular1Template) {
    // Salt collision — bump to the next archetype so regulars are distinct.
    const idx = REGULAR_ARCHETYPES.indexOf(regular2Template);
    regular2Template = REGULAR_ARCHETYPES[(idx + 1) % REGULAR_ARCHETYPES.length];
  }
  const reg1Name = regular1Template.name_seeds[(nameSeed + 1) % regular1Template.name_seeds.length];
  const reg2Name = regular2Template.name_seeds[(nameSeed + 2) % regular2Template.name_seeds.length];

  // 📋 Job Board listings. Fixed slate of 3 variants per day: 1 standard
  // (L1+), 1 boss (L3+), 1 dungeon (L1+). Gauntlet is L5+ and harder to
  // balance in a 3-slot rotation — skipped for v1, easy to add later by
  // expanding the slate or randomizing.
  //
  // We parallelize all 5 AI calls (2 regulars + 3 jobs) since they're
  // independent — total wall-clock matches the slowest single call.
  const [reg1Dialog, reg2Dialog, jobStdFlavor, jobBossFlavor, jobDungFlavor] = await Promise.all([
    generateNpcDialog(env.AI, {
      name: reg1Name, archetype: regular1Template.archetype, vibe: regular1Template.vibe,
      concern: regular1Template.concern, role: "regular", townName,
    }),
    generateNpcDialog(env.AI, {
      name: reg2Name, archetype: regular2Template.archetype, vibe: regular2Template.vibe,
      concern: regular2Template.concern, role: "regular", townName,
    }),
    generateJobListing(env.AI, "standard", townName),
    generateJobListing(env.AI, "boss", townName),
    generateJobListing(env.AI, "dungeon", townName),
  ]);

  // Build the JobListing array. Reward summaries are hand-formatted strings
  // matching the existing quest-variant rewards (1× / 2× / 2.5× multipliers
  // documented in the rules) so the board's numbers stay honest if combat
  // tuning drifts. Re-derive these from constants when we have a single
  // source of truth — for now they match the rules text manually.
  const jobs: JobListing[] = [
    {
      id: "job_1",
      variant: "standard",
      required_level: 1,
      title: jobStdFlavor.title,
      blurb: jobStdFlavor.blurb,
      reward_summary: "_1× rewards · 📋 +12% town bonus · single foe._",
    },
    {
      id: "job_2",
      variant: "boss",
      required_level: BOSS_LEVEL_REQUIRED,
      title: jobBossFlavor.title,
      blurb: jobBossFlavor.blurb,
      reward_summary: "_2× rewards · 📋 +12% town bonus · two phases._",
    },
    {
      id: "job_3",
      variant: "dungeon",
      required_level: EXPEDITION_LEVEL_REQUIRED,
      title: jobDungFlavor.title,
      blurb: jobDungFlavor.blurb,
      reward_summary: "_2.5× rewards · 📋 +12% town bonus · 5-7 rooms, sub-boss, treasure._",
    },
  ];

  // Daily special — pick any drink. Seeded by (channel, day) so reloads
  // show the same special; tomorrow rotates.
  const specialIdx = (nameSeed + today) % DRINKS.length;
  const daily_special_drink_id = DRINKS[specialIdx].id;

  const state: TownState = {
    channel_id: channelId,
    refreshed_at: now,
    town_name: townName,
    town_name_set_at: townNameSetAt,
    pub: {
      bartender,
      regulars: [
        {
          id: "regular_1",
          role: "regular",
          name: reg1Name,
          archetype: regular1Template.archetype,
          vibe: regular1Template.vibe,
          concern: regular1Template.concern,
          dialog: aiToDialogNode(reg1Dialog),
        },
        {
          id: "regular_2",
          role: "regular",
          name: reg2Name,
          archetype: regular2Template.archetype,
          vibe: regular2Template.vibe,
          concern: regular2Template.concern,
          dialog: aiToDialogNode(reg2Dialog),
        },
      ],
      daily_special_drink_id,
    },
    jobs,
  };

  await saveTownState(env.DB, state);
  return state;
}

// Convert AI's loose-shape dialog response to the strict DialogNode type.
// Defensive — AI may produce extra keys or missing payload fields; we
// normalize to known shapes here.
function aiToDialogNode(ai: AiDialogNode): DialogNode {
  const node: DialogNode = { npc_says: ai.npc_says };
  if (ai.options && ai.options.length > 0) {
    node.options = ai.options.map((o) => aiToDialogOption(o));
  }
  return node;
}
function aiToDialogOption(ai: AiDialogOption): DialogOption {
  const opt: DialogOption = {
    player_says: ai.player_says,
    next: aiToDialogNode(ai.next),
  };
  if (ai.payload) {
    const p = ai.payload;
    if (p.type === "rumor" && typeof p.text === "string") {
      opt.payload = { type: "rumor", text: p.text };
    } else if (p.type === "gold" && typeof p.amount === "number") {
      // Clamp gold rewards to a small range — AI sometimes hands out
      // 100g on a casual conversation; cap to keep economy intact.
      opt.payload = { type: "gold", amount: Math.max(1, Math.min(p.amount, 10)) };
    } else if (p.type === "xp" && typeof p.amount === "number") {
      opt.payload = { type: "xp", amount: Math.max(1, Math.min(p.amount, 20)) };
    } else if (p.type === "drink_token" && typeof p.drink_id === "string" && findDrink(p.drink_id)) {
      opt.payload = { type: "drink_token", drink_id: p.drink_id };
    }
  }
  return opt;
}

// Returns cached town state if fresh; otherwise null + schedules a rebuild
// via ctx.waitUntil. Slash commands MUST respond inside Slack's 3-second
// timeout — town gen does 3+ AI calls (name + 3 dialog trees) plus a
// banner image, which runs 8-12 seconds. So we return null on cache miss
// and the handler renders a "town is waking up" placeholder; the player
// re-runs /sq town a few seconds later and hits the warm cache.
//
// On weekly refresh, the bartender is preserved (cheaper), so subsequent
// daily refreshes only generate 2 dialog trees and finish faster — but
// still over the 3s budget. Always background-gen.
async function loadTownStateOrSchedule(
  env: Env,
  ctx: ExecutionContext,
  channelId: string,
): Promise<TownState | null> {
  const cached = await getTownState(env.DB, channelId, TOWN_REFRESH_MS);
  if (cached) return cached;
  // Cache miss → schedule background rebuild, return null.
  ctx.waitUntil(rebuildTownState(env, channelId).catch((err) => {
    console.warn("town:rebuild-error", { channelId, err: err instanceof Error ? err.message : String(err) });
  }));
  return null;
}

// Synchronous-ish accessor for handlers that strictly require fresh state
// (e.g. handlePubDrink validates the daily special). Falls back to stale
// state if it exists, so a player can still buy drinks while a refresh is
// in flight. Worst case: they see yesterday's special price; the next
// refresh fixes it.
async function loadTownStateOrStale(
  env: Env,
  channelId: string,
): Promise<TownState | null> {
  const cached = await getTownState(env.DB, channelId, TOWN_REFRESH_MS);
  if (cached) return cached;
  return getStaleTownState(env.DB, channelId);
}

// /sq town — hub map. Renders the AI-named town with location buttons.
// Pub is the only working location in v1; everything else stubs to a
// "Coming Soon" ephemeral on click.
async function handleTown(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  // Town visits are between-quest only. Players in an active quest get
  // a redirect instead — the town doesn't exist for them while questing.
  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🏘️ The town's gates are out of reach mid-quest. Finish the fight (or flee) first.");
  }

  const state = await loadTownStateOrSchedule(env, ctx, payload.channel_id);
  if (!state) {
    // First-time town visit (or weekly refresh window expired). Background
    // rebuild is already scheduled by loadTownStateOrSchedule — we just
    // return the warmup line so the player knows to circle back. Matches
    // the /sq shop "stocking" message for tonal consistency.
    return ephemeral(
      `🏘️ _Strolling into town... the watch is still rotating and the smith is just firing the forge._ Try \`${payload.command} town\` again in a few seconds.`,
    );
  }
  const townArt = await viewArt(env, ctx, "town_overview");
  const buffNote = character.drink_buff
    ? `\n_🍺 You're currently feeling ${findDrink(character.drink_buff.drink_id)?.name ?? "a drink"}._`
    : "";
  const text = [
    `🏘️ *${state.town_name}*`,
    `_Late afternoon. The watch hasn't rotated, the smith is still hammering, and the tavern's already half-full._${buffNote}`,
    "",
    `Locations: 🍺 Pub • 🛒 Shop • 📋 Job Board • ⚒️ Smithy • 🛏️ Inn`,
    "",
    `_Use the buttons or \`${payload.command} pub\` directly._`,
  ].join("\n");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `🏘️ ${state.town_name}`, emoji: true } },
  ];
  if (townArt) {
    blocks.push({ type: "image", image_url: townArt, alt_text: state.town_name });
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `_Late afternoon. The watch hasn't rotated, the smith is still hammering, and the tavern's already half-full._${buffNote}` },
  });
  // Town locations — single row (Slack caps actions blocks at 5 elements).
  // All five route to real handlers now — no remaining stubs in v1.
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "town_pub", value: "pub", text: { type: "plain_text", text: "🍺 Pub", emoji: true }, style: "primary" },
      { type: "button", action_id: "town_shop", value: "shop", text: { type: "plain_text", text: "🛒 Shop", emoji: true } },
      { type: "button", action_id: "town_board", value: "board", text: { type: "plain_text", text: "📋 Job Board", emoji: true } },
      { type: "button", action_id: "town_smithy", value: "smithy", text: { type: "plain_text", text: "⚒️ Smithy", emoji: true } },
      { type: "button", action_id: "town_inn", value: "inn", text: { type: "plain_text", text: "🛏️ Inn", emoji: true } },
    ],
  });
  return { text, response_type: "ephemeral", blocks };
}

// /sq pub — the tavern interior. Drink menu + NPC list + game/rumor
// buttons. Reads cached TownState; rebuilds if stale (rare — usually
// /sq town has already warmed the cache for this channel).
async function handlePub(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🍺 The tavern's closed to questing parties — the keeper doesn't pour for the bleeding. Wrap up the fight first.");
  }

  const state = await loadTownStateOrSchedule(env, ctx, payload.channel_id);
  if (!state) {
    return ephemeral(
      `🍺 _Pushing the tavern door open... the keeper is still pulling kegs and lighting lanterns._ Try \`${payload.command} pub\` again in a few seconds.`,
    );
  }
  // Lazy sweep of stale SPD matches — keeps gold from sitting locked up
  // in 25-hour-old "open" matches. Runs in the background so the pub
  // render itself doesn't block on it.
  ctx.waitUntil(expireSpdMatches(env, payload.channel_id).catch(() => {}));

  const special = findDrink(state.pub.daily_special_drink_id);
  const pubArt = await viewArt(env, ctx, "pub_interior");

  const buffLine = character.drink_buff
    ? `_🍺 Active drink buff: *${findDrink(character.drink_buff.drink_id)?.name ?? "drink"}* — ${character.drink_buff.kind === "buff_next_crit" ? "next attack guaranteed crit" : `+${character.drink_buff.magnitude} ${character.drink_buff.kind === "buff_attack" ? "atk" : "mag"} for ${character.drink_buff.remaining} more action${character.drink_buff.remaining === 1 ? "" : "s"}`}._`
    : "";

  // Drink menu rendered as compact lines. The button names use truncated
  // forms because Slack button labels cap at ~75 chars.
  const drinkLines = DRINKS.map((d) => {
    const isSpecial = d.id === special?.id;
    const price = isSpecial ? Math.floor(d.price * 0.7) : d.price;
    const priceTag = isSpecial ? `⭐ ~~${d.price}g~~ *${price}g*` : `${price}g`;
    return `${d.emoji} *${d.name}* — ${d.blurb} _${priceTag}_`;
  });
  const introLine = `> _Smoke, sawdust, a thousand failed deployments worth of regret in the air. ${state.pub.bartender.name} polishes a mug behind the bar._`;

  const text = [
    `🍺 *${state.town_name} — Stale Logfile Tavern*`,
    introLine,
    buffLine,
    "",
    "*🍷 Drink Menu*",
    ...drinkLines,
    special ? `\n⭐ *Daily Special:* ${special.emoji} *${special.name}* — 30% off!` : "",
    "",
    `*👥 At the Bar*`,
    `• 🍳 *${state.pub.bartender.name}* — _${state.pub.bartender.archetype}_`,
    ...state.pub.regulars.map((r) => `• 🧑 *${r.name}* — _${r.archetype}_`),
    "",
    `_Use buttons below or \`${payload.command} pub drink <id>\`, \`${payload.command} pub talk bartender\`, \`${payload.command} pub liars\` (mini-game)._`,
  ].filter(Boolean).join("\n");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `🍺 Stale Logfile Tavern`, emoji: true } },
  ];
  if (pubArt) {
    blocks.push({ type: "image", image_url: pubArt, alt_text: "the tavern" });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `${introLine}${buffLine ? `\n${buffLine}` : ""}` } });
  blocks.push({ type: "divider" });

  // Drink menu — Block Kit section with all drinks, followed by purchase buttons.
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*🍷 Drink Menu*\n💰 _You have *${character.gold}g*._${special ? `\n\n⭐ *Daily Special:* ${special.emoji} *${special.name}* — 30% off (now ${Math.floor(special.price * 0.7)}g)` : ""}` } });
  for (const d of DRINKS) {
    const isSpecial = d.id === special?.id;
    const price = isSpecial ? Math.floor(d.price * 0.7) : d.price;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${d.emoji} *${d.name}* — _${d.blurb}_ ${isSpecial ? `⭐ ~~${d.price}g~~ *${price}g*` : `*${price}g*`}` },
      accessory: {
        type: "button",
        action_id: `pub_drink_${d.id}`,
        value: d.id,
        text: { type: "plain_text", text: `Order — ${price}g`, emoji: true },
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*👥 At the Bar*` } });
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: `pub_talk_bartender`, value: "bartender", text: { type: "plain_text", text: `💬 ${state.pub.bartender.name} (bartender)`, emoji: true } },
      ...state.pub.regulars.map((r) => ({
        type: "button",
        action_id: `pub_talk_${r.id}`,
        value: r.id,
        text: { type: "plain_text", text: `💬 ${r.name}`, emoji: true },
      })),
    ],
  });

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "pub_liars", value: "start", text: { type: "plain_text", text: "🎲 Liars' Roll (solo)", emoji: true } },
      { type: "button", action_id: "pub_spd", value: "start", text: { type: "plain_text", text: "🪨📜🗡 Stone-Parchment-Dagger", emoji: true } },
      { type: "button", action_id: "pub_leaderboard", value: "open", text: { type: "plain_text", text: "🏆 Leaderboard", emoji: true } },
      { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ Back to Town", emoji: true } },
    ],
  });

  return { text, response_type: "ephemeral", blocks };
}

// /sq board — Job Board. Shows the channel's daily-posted quest opportunities.
// Each card displays an AI-flavored title + blurb + required level + reward
// summary, with a Take Job button that routes through handleQuest. Players
// below the variant's required level see the card but get a level-gated
// ephemeral on click.
//
// Mid-quest is blocked at the renderer level — same gate as `/sq quest`.
// Older cached TownState rows without `jobs` get a friendly nudge to
// re-warm the town via /sq town.
async function handleJobBoard(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("📋 The job board is no use mid-quest — finish what you started first.");
  }

  const state = await loadTownStateOrSchedule(env, ctx, payload.channel_id);
  if (!state) {
    return ephemeral(
      `📋 _The postings are still being pinned up — give it a beat and try \`${payload.command} board\` again._`,
    );
  }
  // Legacy state pre-jobs rollout — schedule a rebuild and ask the player
  // to re-run. Better than rendering an empty board.
  if (!state.jobs || state.jobs.length === 0) {
    ctx.waitUntil(rebuildTownState(env, payload.channel_id).catch(() => {}));
    return ephemeral(
      `📋 _The notice board is empty — a courier's on the way with fresh postings. Try \`${payload.command} board\` again in a few seconds._`,
    );
  }

  // Pull existing claims for this posting cycle. `refresh_stamp` is the
  // town state's `refreshed_at` — uniquely identifies the posting; daily
  // refresh resets the slate naturally.
  const claims = await getJobClaims(env.DB, payload.channel_id, state.refreshed_at);

  const text = [
    `📋 *${state.town_name} — Job Board*`,
    `_Three contracts are pinned up today. Each can only be claimed by ONE adventurer._`,
    "",
    ...state.jobs.map((j, i) => {
      const claim = claims[j.id];
      const claimNote = claim ? `\n   _Taken by <@${claim.taken_by}>._` : "";
      return `${i + 1}. *${j.title}* _(${j.variant.toUpperCase()} · L${j.required_level}+)_\n   ${j.blurb}\n   ${j.reward_summary}${claimNote}`;
    }),
  ].join("\n");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📋 Job Board`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `_Three contracts are pinned up today. Each can only be claimed by ONE adventurer — first come, first served. Refreshes daily._` } },
    { type: "divider" },
  ];

  for (const job of state.jobs) {
    // Variant tag + level requirement displayed prominently. Players who
    // don't meet the level still see the job (so they know what's coming);
    // the click is what enforces the gate. Claim state takes priority over
    // both — a taken job is taken regardless of level.
    const variantBadge = job.variant === "boss" ? "👑 BOSS"
      : job.variant === "dungeon" ? "🗺️ DUNGEON"
      : job.variant === "gauntlet" ? "⚔️ GAUNTLET"
      : "⚔️ STANDARD";
    const claim = claims[job.id];
    const meetsLevel = character.level >= job.required_level;
    const isTaken = !!claim;
    const isOwnClaim = claim?.taken_by === payload.user_id;

    // Three states: TAKEN (disabled, shows claimant) > UNDER_LEVEL (locked
    // by level) > AVAILABLE (primary action). Self-claims show a softer
    // "you've taken this" so the player knows what they did.
    const buttonText = isTaken
      ? (isOwnClaim ? `✅ You took this` : `✅ Taken`)
      : meetsLevel
      ? `🪙 Take Job`
      : `🔒 L${job.required_level}+ required`;
    const claimLine = isTaken ? `\n_📋 Taken by <@${claim.taken_by}>._` : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${job.title}*\n_${variantBadge} · L${job.required_level}+ required_\n\n${job.blurb}\n\n${job.reward_summary}${claimLine}`,
      },
      accessory: {
        type: "button",
        action_id: `jobboard_take_${job.id}`,
        value: job.id,
        text: { type: "plain_text", text: buttonText, emoji: true },
        ...(meetsLevel && !isTaken ? { style: "primary" } : {}),
        ...(meetsLevel && !isTaken ? {
          confirm: {
            title: { type: "plain_text", text: "Take this job?" },
            text: { type: "mrkdwn", text: `Start *${job.title}* (${job.variant} quest)? You'll head out as soon as you confirm. *This claim is exclusive — nobody else can take this posting.*` },
            confirm: { type: "plain_text", text: "Take Job" },
            deny: { type: "plain_text", text: "Not yet" },
          },
        } : {}),
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Postings refresh daily. You can also start a quest directly with \`${payload.command} quest [variant]\`._` }],
  });
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ Back to Town", emoji: true } },
    ],
  });

  return { text, response_type: "ephemeral", blocks };
}

// /sq board take <job_id> — accept a posted job and start the matching
// quest. Routes through handleQuest with the job's variant; handleQuest
// applies its own validation (level, no-active-quest, etc.). This is
// mostly a thin adapter — the existing quest engine does the work.
async function handleJobBoardTake(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
  jobId: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  // We need the cached jobs to look up the variant. Stale state is fine
  // here — the jobs are pinned to the day's tree, and if the cache is
  // refreshed mid-day the new tree will have different ids that the
  // button no longer matches (the click resolves harmlessly).
  const state = await loadTownStateOrStale(env, payload.channel_id);
  if (!state?.jobs) return ephemeral("📋 No active job postings — try the board again.");
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return ephemeral("📋 That posting's gone — a courier may have pulled it. Try the board again.");

  // Atomic claim. The INSERT OR IGNORE in tryClaimJob is the race guard —
  // if two players click "Take Job" at the same instant, exactly one wins
  // and the other gets `false`. We check the loser case with a follow-up
  // read so we can name the actual claimant.
  const won = await tryClaimJob(env.DB, payload.channel_id, state.refreshed_at, job.id, payload.user_id);
  if (!won) {
    const claim = await getJobClaim(env.DB, payload.channel_id, state.refreshed_at, job.id);
    if (claim && claim.taken_by !== payload.user_id) {
      return ephemeral(`📋 *${job.title}* was just taken by <@${claim.taken_by}>. Try another posting or wait for tomorrow's board.`);
    }
    // Edge case: the claim row exists for THIS user (they double-clicked
    // and the second click hit the DB after the first wrote). Fall through
    // to handleQuest — the engine's own no-active-quest check will block
    // duplicate quest creation cleanly.
  }

  // Hand off to the quest engine. We prepend the variant as args[0] so
  // handleQuest's existing arg parser picks it up the same way `/sq quest
  // <variant>` would. Anything the user passed after `take <id>` (such as
  // @mentions for invitees) flows through too — same UX as `/sq quest`.
  // The seed name forces standard/boss quests to BE the posted foe; the
  // from-job-board flag triggers the reward bonus at victory.
  return handleQuest(payload, [job.variant, ...args], env, ctx, { seedName: job.title });
}

// /sq pub drink <id> — buy and consume a drink. Mid-quest blocked (handled
// upstream). Applies instant effects directly; replaces any existing
// drink_buff with the new one for buff drinks (second drink replaces first
// per the design doc).
async function handlePubDrink(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  drinkId: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🍺 No drinks mid-quest — the tavern keeper draws the line.");
  }

  const drink = findDrink(drinkId);
  if (!drink) return ephemeral(`Unknown drink: \`${drinkId}\`.`);

  // Daily special pricing — needs to match what handlePub rendered.
  const state = await loadTownStateOrStale(env, payload.channel_id);
  if (!state) {
    return ephemeral(
      `🍺 _The tavern's still being set up — try \`${payload.command} town\` first, then come back in a few seconds._`,
    );
  }
  const isSpecial = state.pub.daily_special_drink_id === drink.id;
  const price = isSpecial ? Math.floor(drink.price * 0.7) : drink.price;

  if (character.gold < price) {
    return ephemeral(`💰 You're short on gold for *${drink.name}* — need ${price}g, have ${character.gold}g.`);
  }

  // Atomic gold deduct; race-safe via the conditional WHERE clause.
  const ok = await tryDeductGold(env.DB, payload.user_id, price);
  if (!ok) return ephemeral("💰 Couldn't deduct gold — try again.");

  // Apply the effect.
  const eff = drink.effect;
  let summary = "";
  switch (eff.kind) {
    case "buff_attack": {
      const buff: DrinkBuff = { kind: "buff_attack", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id, fight_duration: true };
      await setDrinkBuff(env.DB, payload.user_id, buff);
      summary = `+${eff.magnitude} attack for this fight`;
      break;
    }
    case "buff_magic": {
      const buff: DrinkBuff = { kind: "buff_magic", magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id, fight_duration: true };
      await setDrinkBuff(env.DB, payload.user_id, buff);
      summary = `+${eff.magnitude} magic for this fight`;
      break;
    }
    case "buff_next_crit": {
      const buff: DrinkBuff = { kind: "buff_next_crit", magnitude: 1, remaining: 1, drink_id: drink.id };
      await setDrinkBuff(env.DB, payload.user_id, buff);
      summary = "next attack/cast/sig is a guaranteed crit";
      break;
    }
    case "instant_shield": {
      const cap = character.max_hp * SHIELD_CAP_MULTIPLIER;
      const added = await addShield(env.DB, character, eff.amount, cap);
      summary = `+${added} 🛡 shield`;
      break;
    }
    case "instant_hp": {
      const healed = await healCharacter(env.DB, character, eff.amount);
      summary = `+${healed} HP`;
      break;
    }
    case "instant_mana": {
      const added = await addMana(env.DB, character, eff.amount);
      summary = `+${added} mana`;
      break;
    }
    case "instant_combo": {
      const healed = await healCharacter(env.DB, character, eff.hp);
      const added = await addMana(env.DB, character, eff.mana);
      summary = `+${healed} HP, +${added} mana`;
      break;
    }
  }

  return ephemeral(`${drink.emoji} You order *${drink.name}* (-${price}g). ${summary}.`);
}

// /sq pub talk <npc_id> [path] — walks the cached dialog tree. `path` is
// a comma-separated sequence of option indices (e.g. "0", "0,1") that
// indicates which branch we're displaying. Empty path = the root node.
async function handlePubTalk(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  npcId: string,
  rawPath: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("🍺 Not while you're on a quest, friend.");

  const state = await loadTownStateOrStale(env, payload.channel_id);
  if (!state) {
    return ephemeral(
      `🍺 _The tavern's still being set up — try \`${payload.command} town\` first, then come back in a few seconds._`,
    );
  }
  const npc = npcId === "bartender" ? state.pub.bartender : state.pub.regulars.find((r) => r.id === npcId);
  if (!npc) return ephemeral("That patron's stepped out.");

  // Walk the path through the tree. Path "" = root; "0" = first option's
  // next; "0,1" = first option then second sub-option.
  const indices = rawPath.split(",").filter((s) => s.length > 0).map((s) => parseInt(s, 10));
  let node: DialogNode = npc.dialog;
  let optionChosen: DialogOption | undefined;
  for (const idx of indices) {
    if (!node.options || idx < 0 || idx >= node.options.length) {
      return ephemeral("That branch isn't available.");
    }
    optionChosen = node.options[idx];
    node = optionChosen.next;
  }

  // If this leaf has a payload, claim once-per-day-per-NPC (check + record).
  let payloadLine = "";
  if (optionChosen?.payload) {
    const today = todayStamp();
    const claimed = await getClaimedNpcPaths(env.DB, payload.channel_id, payload.user_id, npc.id, today);
    const pathKey = indices.join(",");
    if (!claimed.has(pathKey)) {
      await recordClaimedNpcPath(env.DB, payload.channel_id, payload.user_id, npc.id, today, pathKey);
      payloadLine = await applyDialogPayload(env, character, optionChosen.payload);
    } else {
      payloadLine = "_(already claimed today)_";
    }
  }

  // Render the NPC's line + the options as buttons, OR a "🚪 Walk away"
  // terminal if no options. Each option encodes the full path so the next
  // click extends instead of restarting.
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*🧑 ${npc.name}* _(${npc.archetype})_\n${node.npc_says}` } },
  ];
  if (payloadLine) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `🎁 ${payloadLine}` } });
  }
  if (node.options && node.options.length > 0) {
    const elements = node.options.map((o, i) => ({
      type: "button",
      action_id: `pub_talk_${npc.id}__${[...indices, i].join("_")}`,
      value: [...indices, i].join("_"),
      text: { type: "plain_text", text: truncateForButton(o.player_says, 70), emoji: true },
    }));
    blocks.push({ type: "actions", elements });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", action_id: "pub_open", value: "pub", text: { type: "plain_text", text: "🚪 Walk away", emoji: true } },
      ],
    });
  }

  const text = `${npc.name}: ${node.npc_says}${payloadLine ? `\n🎁 ${payloadLine}` : ""}`;
  return { text, response_type: "ephemeral", blocks };
}

// Applies a dialog payload (rumor/gold/xp/drink_token) to the character.
// Returns a single-line description of what happened, used in the chat
// ephemeral.
async function applyDialogPayload(
  env: Env,
  character: Character,
  payload: DialogPayload,
): Promise<string> {
  if (payload.type === "rumor") {
    return `_${payload.text}_`;
  }
  if (payload.type === "gold") {
    await addGold(env.DB, character.slack_user_id, payload.amount);
    return `*+${payload.amount}g* slides across the bar.`;
  }
  if (payload.type === "xp") {
    // Award a small flat XP bonus directly (bypasses awardSpoils since
    // there's no quest-context level-up math to apply here).
    await env.DB
      .prepare(`UPDATE characters SET xp = xp + ?, last_active = ? WHERE slack_user_id = ?`)
      .bind(payload.amount, Date.now(), character.slack_user_id)
      .run();
    return `*+${payload.amount} XP* — that story was worth something.`;
  }
  if (payload.type === "drink_token") {
    const drink = findDrink(payload.drink_id);
    if (!drink) return "";
    // For simplicity in v1: drink tokens immediately apply the drink's
    // effect (free). A token-as-inventory-item is a v2 feature.
    const eff = drink.effect;
    let appliedText = "";
    switch (eff.kind) {
      case "instant_hp": {
        const healed = await healCharacter(env.DB, character, eff.amount);
        appliedText = `+${healed} HP`;
        break;
      }
      case "instant_mana": {
        const added = await addMana(env.DB, character, eff.amount);
        appliedText = `+${added} mana`;
        break;
      }
      case "instant_shield": {
        const cap = character.max_hp * SHIELD_CAP_MULTIPLIER;
        const added = await addShield(env.DB, character, eff.amount, cap);
        appliedText = `+${added} 🛡 shield`;
        break;
      }
      case "instant_combo": {
        const healed = await healCharacter(env.DB, character, eff.hp);
        const added = await addMana(env.DB, character, eff.mana);
        appliedText = `+${healed} HP, +${added} mana`;
        break;
      }
      case "buff_attack":
      case "buff_magic": {
        const buff: DrinkBuff = { kind: eff.kind, magnitude: eff.magnitude, remaining: eff.duration, drink_id: drink.id };
        await setDrinkBuff(env.DB, character.slack_user_id, buff);
        appliedText = `+${eff.magnitude} ${eff.kind === "buff_attack" ? "attack" : "magic"} buff for ${eff.duration} actions`;
        break;
      }
      case "buff_next_crit": {
        const buff: DrinkBuff = { kind: "buff_next_crit", magnitude: 1, remaining: 1, drink_id: drink.id };
        await setDrinkBuff(env.DB, character.slack_user_id, buff);
        appliedText = "next attack/cast/sig guaranteed crit";
        break;
      }
    }
    return `A complimentary ${drink.emoji} *${drink.name}*: ${appliedText}.`;
  }
  return "";
}

// =============================================================================
// LIARS' ROLL (pub mini-game)
// =============================================================================
//
// Quick 3-round dice bluff vs. the bartender. Stake gold up front; if you
// win, you get the bartender's "matching" gold (minus a 5% house cut). If
// you lose, the bartender keeps your stake.
//
// THIS IS A BLUFF GAME — the bartender makes a claim before the reveal,
// and the player decides whether to trust the claim or call the bluff.
// Mechanics:
//   1. Player picks stake (10/25/50g) — gold deducted up front
//   2. Both roll 3d6 — player's dice are visible, bartender's are hidden
//   3. Bartender announces a claim about the COMBINED total's zone
//      (Low ≤18 / Medium 19-23 / High ≥24). The claim is TRUTHFUL 55% of
//      the time, LYING 45% of the time (random other zone)
//   4. Player decides: TRUST (smaller payout if right) or CHALLENGE
//      (bigger payout if right)
//   5. Bartender's dice revealed. Payout determined.
//
// Why server-side round state? The truth (bartender's dice + lied flag)
// must NOT be visible in the button payload — a clever player could
// inspect the action_id value before clicking and always win. Round row
// in `liars_rounds` keeps the truth on the server; the action_id only
// carries the round id.

const LIARS_STAKES = [10, 25, 50];
const LIARS_HOUSE_CUT = 0.05;          // 5% rake on player wins
const LIARS_TRUTH_RATE = 0.55;         // P(bartender tells the truth)
const LIARS_TRUST_MULT = 1.7;          // payout on Trust + truth
const LIARS_CHALLENGE_MULT = 2.5;      // payout on Challenge + lie

// 3d6 zone classification matching the v1 game. Player's three dice
// give them partial info — combined zone is determined when both
// 3d6 are summed.
function liarsZoneFor(combinedTotal: number): LiarsClaim {
  if (combinedTotal <= 18) return "low";
  if (combinedTotal <= 23) return "medium";
  return "high";
}
function liarsZoneLabel(z: LiarsClaim): string {
  if (z === "low") return "🔽 Low (≤18)";
  if (z === "medium") return "↔️ Medium (19-23)";
  return "🔼 High (≥24)";
}
function rollThreeD6(): number[] {
  return [rollDice(6), rollDice(6), rollDice(6)];
}

// Pulls the current bartender's name from cached town state for flavor.
// Falls back to "the bartender" if town hasn't been warmed yet.
async function liarsBartenderName(env: Env, channelId: string): Promise<string> {
  const state = await getStaleTownState(env.DB, channelId);
  return state?.pub?.bartender?.name ?? "the bartender";
}

async function handleLiarsStart(
  payload: SlashCommandPayload,
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("🎲 Tavern games are between quests only.");

  const bartender = await liarsBartenderName(env, payload.channel_id);
  const text = [
    `🎲 *Liars' Roll* — vs. ${bartender}.`,
    `You both roll 3d6. ${bartender} announces a claim about the COMBINED total: 🔽 Low (≤18) / ↔️ Medium (19-23) / 🔼 High (≥24).`,
    `*${bartender} lies sometimes.* You can *Trust* (small payout if right) or *Challenge* (big payout if right).`,
    "",
    `Trust correct: pays *${LIARS_TRUST_MULT}×*. Challenge correct: pays *${LIARS_CHALLENGE_MULT}×*. Wrong call: lose your stake. ${Math.round(LIARS_HOUSE_CUT * 100)}% house rake on wins.`,
    "",
    `💰 You have *${character.gold}g*. Pick your stake:`,
  ].join("\n");
  return {
    text,
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: LIARS_STAKES.filter((s) => character.gold >= s).map((s) => ({
          type: "button",
          action_id: `liars_stake_${s}`,
          value: String(s),
          text: { type: "plain_text", text: `🪙 ${s}g`, emoji: true },
        })),
      },
    ],
  };
}

// Stake committed — roll both sets of dice, generate the bartender's
// claim (truthful 55% of the time), persist the round, show the decide
// prompt with the player's visible dice + bartender's claim.
async function handleLiarsStake(
  payload: SlashCommandPayload,
  env: Env,
  stake: number,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (character.gold < stake) return ephemeral(`💰 You only have ${character.gold}g.`);
  if (!LIARS_STAKES.includes(stake)) return ephemeral("Invalid stake.");

  // Atomic deduct.
  const ok = await tryDeductGold(env.DB, payload.user_id, stake);
  if (!ok) return ephemeral("💰 Couldn't deduct gold — try again.");

  // Roll both sets of dice + determine the truth zone.
  const playerDice = rollThreeD6();
  const bartenderDice = rollThreeD6();
  const total = [...playerDice, ...bartenderDice].reduce((a, b) => a + b, 0);
  const truth = liarsZoneFor(total);

  // Bartender's claim: truthful with probability LIARS_TRUTH_RATE,
  // otherwise picks one of the OTHER two zones at random. The lie isn't
  // adversarial — it doesn't try to fool you optimally based on your
  // dice — it's just a 45% chance of a random alternative.
  const isLying = Math.random() >= LIARS_TRUTH_RATE;
  let claim: LiarsClaim;
  if (!isLying) {
    claim = truth;
  } else {
    const others: LiarsClaim[] = (["low", "medium", "high"] as LiarsClaim[]).filter((z) => z !== truth);
    claim = others[Math.floor(Math.random() * others.length)];
  }

  // Persist the round — caller's gold has already been deducted; the
  // payout (if any) will land on resolve.
  const roundId = await createLiarsRound(env.DB, {
    user_id: payload.user_id,
    channel_id: payload.channel_id,
    stake,
    player_dice: playerDice,
    bartender_dice: bartenderDice,
    claim,
    lied: isLying,
  });

  const bartender = await liarsBartenderName(env, payload.channel_id);
  const playerSum = playerDice.reduce((a, b) => a + b, 0);
  return {
    text: `🎲 *${bartender} sets down their cup.* "I'd put my bones on *${claim.toUpperCase()}*, friend."`,
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `🎲 *${bartender}'s claim:* "${liarsZoneLabel(claim)}."`,
            `Your dice: *${playerDice.join(", ")}* (sum *${playerSum}*).`,
            `${bartender}'s dice are face-down — combined zone is your call.`,
            ``,
            `*Trust* (correct pays *${LIARS_TRUST_MULT}×*) or *Challenge* (correct pays *${LIARS_CHALLENGE_MULT}×*)?`,
          ].join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: `liars_decide_${roundId}_trust`, value: "trust", text: { type: "plain_text", text: `🤝 Trust ${bartender}`, emoji: true } },
          { type: "button", action_id: `liars_decide_${roundId}_challenge`, value: "challenge", text: { type: "plain_text", text: `🔥 Challenge "Liar!"`, emoji: true }, style: "danger" },
        ],
      },
    ],
  };
}

// Resolve — reveals the bartender's dice and applies payout. Race-safe
// finalize ensures double-clicks don't double-pay.
async function handleLiarsDecide(
  payload: SlashCommandPayload,
  env: Env,
  roundId: number,
  choice: "trust" | "challenge",
): Promise<CommandResponse> {
  const round = await getLiarsRound(env.DB, roundId);
  if (!round) return ephemeral("That round is gone.");
  if (round.user_id !== payload.user_id) return ephemeral("That's not your round.");
  if (round.status !== "open") return ephemeral("That round was already resolved.");

  const totalPlayer = round.player_dice.reduce((a, b) => a + b, 0);
  const totalBartender = round.bartender_dice.reduce((a, b) => a + b, 0);
  const combined = totalPlayer + totalBartender;
  const truth = liarsZoneFor(combined);
  const correct = choice === "trust" ? !round.lied : round.lied;

  // Compute payout BEFORE the race-safe finalize so we know what to
  // grant. House rake applied on the gross.
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

  const won = await finalizeLiarsRound(env.DB, roundId, outcome, payout);
  if (!won) return ephemeral("That round was just resolved on another click — payout already landed if it was a win.");

  if (payout > 0) {
    await addGold(env.DB, payload.user_id, payout);
  }

  const bartender = await liarsBartenderName(env, payload.channel_id);
  const character = await getCharacter(env.DB, payload.user_id);
  const goldNow = character?.gold ?? 0;

  // Liar's achievement checks
  if (character) {
    // Count how many challenges this player has issued (approximate via DB query)
    const challengeCountRow = await env.DB
      .prepare(`SELECT COUNT(*) AS cnt FROM liars_rounds WHERE user_id = ? AND status IN ('challenge_win','challenge_lose')`)
      .bind(payload.user_id)
      .first<{ cnt: number }>();
    const totalChallenges = (challengeCountRow?.cnt ?? 0) + (choice === "challenge" ? 1 : 0);
    const liarsIds = checkLiarsAchievements({
      existingAchievements: character.achievements,
      won: correct,
      stake: round.stake,
      isChallenge: choice === "challenge",
      challengeWon: choice === "challenge" && correct,
      totalChallenges,
    });
    for (const id of liarsIds) {
      await grantAchievement(env.DB, payload.user_id, id);
    }
  }

  const verdict = round.lied
    ? `*${bartender} was lying!* The truth was *${liarsZoneLabel(truth)}*.`
    : `*${bartender} told the truth.* The combined zone was indeed *${liarsZoneLabel(truth)}*.`;
  const resultLine = correct
    ? choice === "trust"
      ? `🤝 You trusted, and ${bartender}'s claim landed. *+${payout}g* (after ${Math.round(LIARS_HOUSE_CUT * 100)}% house rake).`
      : `🔥 You called the bluff. *+${payout}g* (after ${Math.round(LIARS_HOUSE_CUT * 100)}% house rake).`
    : choice === "trust"
      ? `💸 You trusted, but ${bartender} was lying. ${bartender} keeps your *${round.stake}g*.`
      : `💸 You called a bluff that wasn't there. ${bartender} keeps your *${round.stake}g*.`;
  const diceLine = `_Your dice: ${round.player_dice.join(", ")} (${totalPlayer}). ${bartender}'s dice: ${round.bartender_dice.join(", ")} (${totalBartender}). Combined: *${combined}*._`;

  return {
    text: `${resultLine}\n${verdict}\n${diceLine}\n💰 You now have *${goldNow}g*.`,
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${resultLine}\n${verdict}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: diceLine }] },
      { type: "context", elements: [{ type: "mrkdwn", text: `💰 You now have *${goldNow}g*.` }] },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "pub_liars", value: "again", text: { type: "plain_text", text: "🎲 Again", emoji: true } },
          { type: "button", action_id: "pub_open", value: "back", text: { type: "plain_text", text: "🚪 Back to Pub", emoji: true } },
        ],
      },
    ],
  };
}

// =============================================================================
// PUB GAMES LEADERBOARD
// =============================================================================
//
// `/sq pub lb` or pub-view button. Channel-scoped ranking by net gold
// across all Liars' Roll + SPD matches + SPD side bets. Top 10 by net
// P/L, with a highlighted biggest-single-win and biggest-single-loss
// callout below to give the rest of the channel some bragging-and-
// commiseration material.

async function handlePubLeaderboard(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  // Town state is optional here — we just want a title for the board.
  // No warmup gate; this is a pure-read view.
  const state = await loadTownStateOrStale(env, payload.channel_id);
  const townName = state?.town_name ?? "The Tavern";

  const entries = await getPubLeaderboard(env.DB, payload.channel_id);
  if (entries.length === 0) {
    return ephemeral(`🏆 *${townName} — Pub Games Leaderboard*\n\n_No games settled yet. Be the first — try \`${payload.command} pub liars\` or \`${payload.command} pub spd\`._`);
  }

  // Find biggest single win + loss across ALL players so we can call
  // them out below the table. Skip entries with no wins / no losses
  // when computing each.
  let biggestWin: { user_id: string; amount: number; game: string } | null = null;
  let biggestLoss: { user_id: string; amount: number; game: string } | null = null;
  for (const e of entries) {
    if (e.biggest_win && (!biggestWin || e.biggest_win.amount > biggestWin.amount)) {
      biggestWin = { user_id: e.user_id, amount: e.biggest_win.amount, game: gameLabel(e.biggest_win.game) };
    }
    if (e.biggest_loss && (!biggestLoss || e.biggest_loss.amount > biggestLoss.amount)) {
      biggestLoss = { user_id: e.user_id, amount: e.biggest_loss.amount, game: gameLabel(e.biggest_loss.game) };
    }
  }

  const lines = [`🏆 *${townName} — Pub Games Leaderboard*`, ``];
  const top = entries.slice(0, 10);
  lines.push(`*By net winnings (top ${top.length}):*`);
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    // Trend marker reads at a glance — green up for profit, neutral
    // dash at exactly zero, red down for loss.
    const trend = e.net > 0 ? "📈" : e.net === 0 ? "📊" : "📉";
    const netLabel = e.net > 0 ? `+${e.net}g` : e.net === 0 ? "even" : `${e.net}g`;
    const winRate = e.games > 0 ? Math.round((e.wins / e.games) * 100) : 0;
    lines.push(`\`${i + 1}.\` ${trend} <@${e.user_id}> — *${netLabel}* (${e.games} game${e.games === 1 ? "" : "s"}, ${e.wins} win${e.wins === 1 ? "" : "s"} — ${winRate}%)`);
  }
  lines.push("");
  if (biggestWin) {
    lines.push(`🏆 *Biggest single win:* <@${biggestWin.user_id}> — *+${biggestWin.amount}g* (${biggestWin.game})`);
  }
  if (biggestLoss) {
    lines.push(`💸 *Biggest single loss:* <@${biggestLoss.user_id}> — *-${biggestLoss.amount}g* (${biggestLoss.game})`);
  }

  const text = lines.join("\n");
  // Posts publicly in the channel — leaderboards are bragging content;
  // ephemeral defeats the point. Navigation buttons stay so anyone
  // browsing can jump into the games; clicking them opens that user's
  // OWN ephemeral pub/town view, not modifying the public post.
  return {
    text,
    response_type: "in_channel",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "pub_open", value: "back", text: { type: "plain_text", text: "🍺 To the Pub", emoji: true } },
          { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ To Town", emoji: true } },
        ],
      },
    ],
  };
}

// Maps the leaderboard's internal game-tag to a human label for the
// biggest-win/biggest-loss callout.
function gameLabel(g: string): string {
  if (g === "liars") return "Liars' Roll";
  if (g === "spd_match") return "SPD match";
  if (g === "spd_bet") return "SPD side bet";
  return g;
}

// =============================================================================
// STONE-PARCHMENT-DAGGER (multiplayer)
// =============================================================================
//
// Two players face off. Each privately picks 🪨 / 📜 / 🗡; spectators
// place side bets while the match is open; resolution distributes
// stakes + a house bump (% of total pot) to the winner and pays bet
// winners 2× their stake.
//
// Match lifecycle reminders (see migration 0019_spd.sql):
//   open      → initiator committed, awaiting challenger
//   resolving → both throws in, payouts about to land (transient)
//   done      → settled, history readable
//   cancelled → initiator pulled it OR 24h lazy expiry
//
// One open match per channel. Lazy expiry runs from handlePub /
// handleTown so a stale match doesn't sit forever soaking gold.

// ---------- helpers ----------

// Sweeps any expired (≥24h) open matches in the channel, cancels them,
// and refunds the initiator's stake plus every bet. Called from pub/
// town renders so the player who refreshes their view triggers cleanup.
// Returns the matches it swept for optional caller logging.
async function expireSpdMatches(env: Env, channelId: string): Promise<SpdMatch[]> {
  const expired = await findExpiredSpdMatches(env.DB, channelId, SPD_MATCH_EXPIRY_MS);
  for (const match of expired) {
    const cancelled = await cancelSpdMatch(env.DB, match.id);
    if (!cancelled) continue; // raced with manual cancel
    // Refund initiator's stake.
    await addGold(env.DB, match.initiator_user_id, match.initiator_stake);
    // Refund every bet.
    const bets = await getSpdBets(env.DB, match.id);
    for (const bet of bets) {
      await addGold(env.DB, bet.bettor_user_id, bet.amount);
    }
    // Retire the stale open message so its buttons can't be clicked.
    await retireSpdOpenMessage(env, match, `🚪 Match expired — no opponent stepped up.`);
  }
  return expired;
}

// Posts a public-channel announcement when a match opens. Stores the
// message ts on the match so future state updates can thread-reply.
// Fire-and-forget on errors — the match still works without the public
// post, the players just won't get spectator engagement.
async function postSpdOpenMessage(
  env: Env,
  ctx: ExecutionContext,
  match: SpdMatch,
): Promise<void> {
  const lines = [
    `🪨📜🗡 *Stone-Parchment-Dagger* — <@${match.initiator_user_id}> opens a match for *${match.initiator_stake}g*. Their throw is committed.`,
    `_Who'll face them? Spectators can place side bets too — first opponent to lock in starts the reveal._`,
  ];
  const blocks = buildSpdOpenBlocks(match, []);
  try {
    const result = await postMessage(env.SLACK_BOT_TOKEN, {
      channel: match.channel_id,
      text: lines.join("\n"),
      blocks,
    });
    if (result.ok && result.ts) {
      ctx.waitUntil(setSpdMessageTs(env.DB, match.id, result.ts));
    }
  } catch (err) {
    console.warn("spd:open-post-error", { matchId: match.id, err: err instanceof Error ? err.message : String(err) });
  }
}

// Renders the Block Kit version of the open-match public message. Uses
// the current bet list so spectator clicks accumulate visibly.
function buildSpdOpenBlocks(match: SpdMatch, bets: SpdBet[]): unknown[] {
  const initiatorBets = bets.filter((b) => b.side === "initiator");
  const challengerBets = bets.filter((b) => b.side === "challenger");
  const initiatorTotal = initiatorBets.reduce((s, b) => s + b.amount, 0);
  const challengerTotal = challengerBets.reduce((s, b) => s + b.amount, 0);
  const betSummary = bets.length === 0
    ? "_No side bets yet._"
    : `💰 *Side bets:* ${initiatorBets.length} on <@${match.initiator_user_id}> (${initiatorTotal}g) · ${challengerBets.length} on challenger (${challengerTotal}g).`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🪨📜🗡 *Stone-Parchment-Dagger*\n<@${match.initiator_user_id}> opens for *${match.initiator_stake}g*. Their throw is committed.\n${betSummary}`,
      },
    },
    // Row 1: open-to-everyone actions. Slack caps each actions block at
    // 5 elements; with Bump + Cancel we'd hit 5, but keeping them in a
    // separate row makes the initiator-only buttons visually distinct.
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `spd_accept_${match.id}`,
          value: String(match.id),
          text: { type: "plain_text", text: `🪨 Accept (${match.initiator_stake}g)`, emoji: true },
          style: "primary",
        },
        {
          type: "button",
          action_id: `spd_bet_${match.id}`,
          value: String(match.id),
          text: { type: "plain_text", text: "💰 Place a Side Bet", emoji: true },
        },
        {
          type: "button",
          action_id: `spd_view_${match.id}`,
          value: String(match.id),
          text: { type: "plain_text", text: "🔄 Refresh", emoji: true },
        },
      ],
    },
    // Row 2: initiator-only actions. Buttons are visible to everyone (we
    // can't filter by user at render time — Block Kit has no per-viewer
    // visibility), so the handlers gate on click and return an ephemeral
    // for non-initiator users.
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `spd_bump_${match.id}`,
          value: String(match.id),
          text: { type: "plain_text", text: "📣 Bump", emoji: true },
        },
        {
          type: "button",
          action_id: `spd_cancel_${match.id}`,
          value: String(match.id),
          text: { type: "plain_text", text: "🚪 Cancel", emoji: true },
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Cancel this match?" },
            text: { type: "mrkdwn", text: "Your stake will be refunded. All side bets will be refunded to their bettors. The match closes." },
            confirm: { type: "plain_text", text: "Cancel match" },
            deny: { type: "plain_text", text: "Keep it open" },
          },
        },
      ],
    },
  ];
}

// Renders an in-thread state update — bet placed, match accepted,
// resolution. Posted via the match's message_ts so the channel sees
// the conversation in one collapsed thread.
async function postSpdThreadUpdate(
  env: Env,
  match: SpdMatch,
  text: string,
  opts: { broadcast?: boolean; blocks?: unknown[] } = {},
): Promise<void> {
  if (!match.message_ts) return;
  try {
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel: match.channel_id,
      thread_ts: match.message_ts,
      reply_broadcast: opts.broadcast ?? false,
      text,
      blocks: opts.blocks,
    });
  } catch (err) {
    console.warn("spd:thread-post-error", { matchId: match.id, err: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- handlers ----------

// Entry point — `/sq pub spd` or button. Shows the stake picker. We
// don't let two open matches per channel coexist, so the first thing we
// do is check for an existing open match and route the user to its
// view if so.
async function handleSpdStart(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("🪨 SPD is a between-quest game — finish the fight first.");

  // Sweep expired matches before anything else so a stale 25h match
  // doesn't block a new one.
  await expireSpdMatches(env, payload.channel_id);

  const existing = await getOpenSpdMatch(env.DB, payload.channel_id);
  if (existing) {
    if (existing.initiator_user_id === payload.user_id) {
      // Initiator-owned open match — give them inline Bump/Cancel so
      // they don't have to scroll-hunt for the original channel post.
      // The same action_ids the public post uses are wired here.
      const text = `🪨 You already have a Stone-Parchment-Dagger match open for *${existing.initiator_stake}g*.`;
      return {
        text,
        response_type: "ephemeral",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `🪨 *Match #${existing.id}* — open for *${existing.initiator_stake}g*.\nWait for an opponent, or use the buttons below.` } },
          {
            type: "actions",
            elements: [
              { type: "button", action_id: `spd_bump_${existing.id}`, value: String(existing.id), text: { type: "plain_text", text: "📣 Bump", emoji: true } },
              {
                type: "button",
                action_id: `spd_cancel_${existing.id}`,
                value: String(existing.id),
                text: { type: "plain_text", text: "🚪 Cancel", emoji: true },
                style: "danger",
                confirm: {
                  title: { type: "plain_text", text: "Cancel this match?" },
                  text: { type: "mrkdwn", text: "Your stake will be refunded. All side bets will be refunded to their bettors. The match closes." },
                  confirm: { type: "plain_text", text: "Cancel match" },
                  deny: { type: "plain_text", text: "Keep it open" },
                },
              },
            ],
          },
        ],
      };
    }
    // Spectator path — they're not the initiator. Offer Accept + Bet
    // inline so they don't have to chase the channel post either.
    return {
      text: `🪨 <@${existing.initiator_user_id}> has an open Stone-Parchment-Dagger match for *${existing.initiator_stake}g*.`,
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `🪨 <@${existing.initiator_user_id}> has an open match for *${existing.initiator_stake}g*. Their throw is committed — face them, or place a side bet.` } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: `spd_accept_${existing.id}`,
              value: String(existing.id),
              text: { type: "plain_text", text: `🪨 Accept (${existing.initiator_stake}g)`, emoji: true },
              style: "primary",
            },
            {
              type: "button",
              action_id: `spd_bet_${existing.id}`,
              value: String(existing.id),
              text: { type: "plain_text", text: "💰 Place a Side Bet", emoji: true },
            },
          ],
        },
      ],
    };
  }

  return {
    text: `🪨📜🗡 *Start a Stone-Parchment-Dagger match.* Pick your stake — your opponent will match it.`,
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `🪨📜🗡 *Stone-Parchment-Dagger* — pick your stake.\n💰 You have *${character.gold}g*.` },
      },
      {
        type: "actions",
        elements: SPD_STAKE_TIERS.filter((s) => character.gold >= s).map((s) => ({
          type: "button",
          action_id: `spd_stake_${s}`,
          value: String(s),
          text: { type: "plain_text", text: `🪙 ${s}g`, emoji: true },
        })),
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_House bumps the winner's pot by *${Math.round(SPD_HOUSE_BUMP_PCT * 100)}%* of total wagered (player stakes + side bets). Winning side bets pay *2×*. Ties refund everything._` }],
      },
    ],
  };
}

// Stake picked — show the throw picker. We don't write to the DB yet;
// the commit happens when the throw button is clicked. This lets the
// player back out without spending gold.
async function handleSpdStakePicked(
  payload: SlashCommandPayload,
  env: Env,
  stake: number,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (character.gold < stake) return ephemeral(`💰 You only have ${character.gold}g.`);
  if (!SPD_STAKE_TIERS.includes(stake as 10 | 25 | 50)) return ephemeral("Invalid stake.");

  return {
    text: `🪨📜🗡 Pick your throw. The opponent won't see it until they commit theirs.`,
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `🪨📜🗡 *Stake locked at ${stake}g.* Pick your throw — it stays secret until your opponent commits.` },
      },
      {
        type: "actions",
        elements: (["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => ({
          type: "button",
          action_id: `spd_init_${stake}_${t}`,
          value: t,
          text: { type: "plain_text", text: `${SPD_THROW_META[t].emoji} ${SPD_THROW_META[t].name}`, emoji: true },
        })),
      },
    ],
  };
}

// Initiator commits their throw. DB write happens here — gold deducted,
// match row inserted, public message posted.
async function handleSpdInitCommit(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  stake: number,
  throwName: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (character.gold < stake) return ephemeral(`💰 You only have ${character.gold}g.`);
  if (!isSpdThrow(throwName)) return ephemeral("Invalid throw.");

  // Re-check no open match — sweep expired first.
  await expireSpdMatches(env, payload.channel_id);
  const existing = await getOpenSpdMatch(env.DB, payload.channel_id);
  if (existing) {
    return ephemeral(`🪨 Someone opened a match while you were picking. Try again — your gold wasn't spent.`);
  }

  // Atomic gold deduct.
  const ok = await tryDeductGold(env.DB, payload.user_id, stake);
  if (!ok) return ephemeral("💰 Couldn't deduct gold — try again.");

  const matchId = await createSpdMatch(env.DB, {
    channel_id: payload.channel_id,
    initiator_user_id: payload.user_id,
    initiator_stake: stake,
    initiator_throw: throwName,
  });
  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("Match created but couldn't be re-read. Try the channel.");

  // Public announcement.
  ctx.waitUntil(postSpdOpenMessage(env, ctx, match));

  return ephemeral(
    `🪨📜🗡 *Match opened* for *${stake}g* — your throw (${SPD_THROW_META[throwName].emoji} ${SPD_THROW_META[throwName].name}) is committed. Watch the channel for an accepter.`,
  );
}

// Accept handler — opens the challenger's throw picker. No DB write
// yet; the accept-and-throw both land on the next click.
async function handleSpdAccept(
  payload: SlashCommandPayload,
  env: Env,
  matchId: number,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("🪨 You're already on a quest — finish it before facing off.");

  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.status !== "open") return ephemeral("🪨 That match is no longer open.");
  if (match.initiator_user_id === payload.user_id) return ephemeral("🪨 You can't accept your own match.");
  if (character.gold < match.initiator_stake) {
    return ephemeral(`💰 You need ${match.initiator_stake}g to match the stake — you have ${character.gold}g.`);
  }

  return {
    text: `🪨📜🗡 Pick your throw. The instant you commit, both throws reveal and the match resolves.`,
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `🪨📜🗡 Accepting <@${match.initiator_user_id}>'s match for *${match.initiator_stake}g*. Pick your throw — committing instantly resolves the match.` },
      },
      {
        type: "actions",
        elements: (["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => ({
          type: "button",
          action_id: `spd_chall_${match.id}_${t}`,
          value: t,
          text: { type: "plain_text", text: `${SPD_THROW_META[t].emoji} ${SPD_THROW_META[t].name}`, emoji: true },
        })),
      },
    ],
  };
}

// Challenger commits — accepts the match atomically (race guard in
// acceptSpdMatch), deducts their stake, then resolves.
async function handleSpdChallCommit(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  matchId: number,
  throwName: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isSpdThrow(throwName)) return ephemeral("Invalid throw.");

  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.status !== "open") return ephemeral("🪨 That match is no longer open.");
  if (match.initiator_user_id === payload.user_id) return ephemeral("🪨 You can't accept your own match.");
  if (character.gold < match.initiator_stake) {
    return ephemeral(`💰 You need ${match.initiator_stake}g — you have ${character.gold}g.`);
  }

  // Deduct gold first, then atomic accept. If the atomic accept fails
  // (someone else just won the race), refund.
  const goldOk = await tryDeductGold(env.DB, payload.user_id, match.initiator_stake);
  if (!goldOk) return ephemeral("💰 Couldn't deduct gold — try again.");

  const accepted = await acceptSpdMatch(env.DB, matchId, payload.user_id, throwName);
  if (!accepted) {
    await addGold(env.DB, payload.user_id, match.initiator_stake);
    return ephemeral(`🪨 Another adventurer beat you to the punch on that match. Your gold is back.`);
  }

  // Resolve immediately. The DB now holds both throws; resolveSpdMatch
  // computes payouts, writes them, and posts the public reveal.
  ctx.waitUntil(resolveSpdMatch(env, matchId));

  return ephemeral(
    `🪨📜🗡 Match accepted with ${SPD_THROW_META[throwName].emoji} *${SPD_THROW_META[throwName].name}* — reveal incoming in the channel.`,
  );
}

// Bet picker — opens the side+amount grid as a private ephemeral.
async function handleSpdBetPicker(
  payload: SlashCommandPayload,
  env: Env,
  matchId: number,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.status !== "open") return ephemeral("🪨 Betting is closed — match is no longer open.");
  if (match.initiator_user_id === payload.user_id) {
    return ephemeral("🪨 The initiator can't bet on their own match — your stake is already on the line.");
  }
  const existingBet = await getSpdBetByUser(env.DB, matchId, payload.user_id);
  if (existingBet) {
    const sideLabel = existingBet.side === "initiator" ? `<@${match.initiator_user_id}>` : "the challenger";
    return ephemeral(`💰 You've already bet *${existingBet.amount}g* on ${sideLabel}. One bet per match.`);
  }

  // Show 6 buttons: 3 amounts × 2 sides. Filter affordability up front
  // so players don't see disabled-style tease for amounts they can't
  // afford.
  const affordable = SPD_BET_TIERS.filter((a) => character.gold >= a);
  if (affordable.length === 0) {
    return ephemeral(`💰 You need at least ${Math.min(...SPD_BET_TIERS)}g to place a side bet — you have ${character.gold}g.`);
  }

  return {
    text: `💰 Place a side bet on the Stone-Parchment-Dagger match.`,
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💰 *Side bet* on <@${match.initiator_user_id}>'s match.\nWinning bets pay *2× your stake*. One bet per match.\n💰 You have *${character.gold}g*.`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Bet on <@${match.initiator_user_id}>:*` },
      },
      {
        type: "actions",
        elements: affordable.map((amt) => ({
          type: "button",
          action_id: `spd_place_${match.id}_initiator_${amt}`,
          value: `initiator_${amt}`,
          text: { type: "plain_text", text: `🪙 ${amt}g`, emoji: true },
        })),
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Bet on the challenger:*` },
      },
      {
        type: "actions",
        elements: affordable.map((amt) => ({
          type: "button",
          action_id: `spd_place_${match.id}_challenger_${amt}`,
          value: `challenger_${amt}`,
          text: { type: "plain_text", text: `🪙 ${amt}g`, emoji: true },
        })),
      },
    ],
  };
}

// Bet commit — atomic gold deduct + INSERT OR IGNORE bet row.
async function handleSpdBetPlace(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  matchId: number,
  side: "initiator" | "challenger",
  amount: number,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!SPD_BET_TIERS.includes(amount as 5 | 10 | 25)) return ephemeral("Invalid bet amount.");

  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.status !== "open") return ephemeral("🪨 Betting is closed.");
  if (match.initiator_user_id === payload.user_id) return ephemeral("🪨 No betting on your own match.");
  if (character.gold < amount) return ephemeral(`💰 You only have ${character.gold}g.`);

  // Deduct gold first, then try to place bet. If the INSERT loses to a
  // double-click race, refund.
  const goldOk = await tryDeductGold(env.DB, payload.user_id, amount);
  if (!goldOk) return ephemeral("💰 Couldn't deduct gold — try again.");

  const placed = await placeSpdBet(env.DB, {
    match_id: matchId,
    bettor_user_id: payload.user_id,
    side,
    amount,
    created_at: Date.now(),
  });
  if (!placed) {
    await addGold(env.DB, payload.user_id, amount);
    return ephemeral("💰 You've already bet on this match. Refunded.");
  }

  // Spectator bet achievement
  await grantAchievement(env.DB, payload.user_id, "spd_spectator_bet");

  // Update the public message's bet summary. Cheap fire-and-forget —
  // missing the update isn't fatal; the next /sq pub or refresh would
  // show stale info but the bet itself is on the books.
  const bets = await getSpdBets(env.DB, matchId);
  ctx.waitUntil(postSpdThreadUpdate(env, match,
    `💰 <@${payload.user_id}> bets *${amount}g* on ${side === "initiator" ? `<@${match.initiator_user_id}>` : "the challenger"}.`,
  ));

  const sideLabel = side === "initiator" ? `<@${match.initiator_user_id}>` : "the challenger";
  return ephemeral(
    `💰 Bet placed: *${amount}g* on ${sideLabel}. Win and you pocket *${amount * 2}g* (your stake doubled).`,
  );
}

// Cancel — initiator only. Refunds initiator + all bettors.
async function handleSpdCancel(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  matchId: number,
): Promise<CommandResponse> {
  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.initiator_user_id !== payload.user_id) {
    return ephemeral("🪨 Only the initiator can cancel.");
  }
  if (match.status !== "open") return ephemeral("🪨 Match is no longer open — can't cancel.");

  const cancelled = await cancelSpdMatch(env.DB, matchId);
  if (!cancelled) return ephemeral("🪨 The match was just resolved — refunds aren't possible.");

  // Refund the initiator's stake + every bet.
  await addGold(env.DB, match.initiator_user_id, match.initiator_stake);
  const bets = await getSpdBets(env.DB, matchId);
  for (const bet of bets) {
    await addGold(env.DB, bet.bettor_user_id, bet.amount);
  }

  ctx.waitUntil(postSpdThreadUpdate(env, match,
    `🚪 *Match cancelled.* <@${match.initiator_user_id}> pulled the contract — all stakes and side bets refunded.`,
    { broadcast: true },
  ));
  ctx.waitUntil(retireSpdOpenMessage(env, match, `🚪 <@${match.initiator_user_id}> cancelled the match.`));

  return ephemeral("🪨 Match cancelled. Stake refunded. Any side bets were refunded to their bettors.");
}

// Bump — initiator-only re-announce of an open match. Posts a fresh
// top-level channel message (so the match surfaces past whatever
// scrolled it off-screen) and re-points the match's message_ts at the
// new post so future thread replies (bets, the eventual reveal) attach
// to the visible bump rather than the buried original.
//
// Cooldown: SPD_BUMP_COOLDOWN_MS between bumps for the same match.
// Enforced atomically via tryBumpSpdMatch's conditional UPDATE so
// double-clicks can't double-post.
async function handleSpdBump(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  matchId: number,
): Promise<CommandResponse> {
  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  if (match.initiator_user_id !== payload.user_id) {
    return ephemeral("📣 Only the initiator can bump the match.");
  }
  if (match.status !== "open") return ephemeral("📣 Match is no longer open — no need to bump.");

  // Atomic cooldown check + write. If we lose (cooldown not up), tell
  // the user how long they have to wait — read the row again to compute
  // the remaining time since the bump itself didn't land.
  const won = await tryBumpSpdMatch(env.DB, matchId, payload.user_id, SPD_BUMP_COOLDOWN_MS);
  if (!won) {
    const fresh = await getSpdMatch(env.DB, matchId);
    const lastBump = fresh?.last_bumped_at ?? fresh?.created_at ?? Date.now();
    const remainMs = SPD_BUMP_COOLDOWN_MS - (Date.now() - lastBump);
    const remainMin = Math.max(1, Math.ceil(remainMs / 60000));
    return ephemeral(`📣 Just bumped recently — give it another ${remainMin} min before the next nudge.`);
  }

  // Re-read the now-bumped match so the rendered blocks reflect the
  // updated last_bumped_at (purely cosmetic — the value isn't shown).
  const fresh = await getSpdMatch(env.DB, matchId);
  if (!fresh) return ephemeral("Couldn't re-read the match. Try again.");

  const bets = await getSpdBets(env.DB, matchId);
  const blocks = buildSpdOpenBlocks(fresh, bets);
  const text = `📣 *Still looking!* <@${fresh.initiator_user_id}>'s Stone-Parchment-Dagger match is open for *${fresh.initiator_stake}g*.`;

  // Post the fresh announcement as a new top-level message in the
  // channel. The point of bump is visibility — putting it at the
  // top of the channel where scroll-back went deep.
  ctx.waitUntil((async () => {
    try {
      const result = await postMessage(env.SLACK_BOT_TOKEN, {
        channel: fresh.channel_id,
        text,
        blocks,
      });
      // Re-point message_ts to the new post so future thread updates
      // (acceptance, bets, resolution) attach to the visible bump
      // rather than the buried original.
      if (result.ok && result.ts) {
        await setSpdMessageTs(env.DB, fresh.id, result.ts);
      }
    } catch (err) {
      console.warn("spd:bump-post-error", { matchId: fresh.id, err: err instanceof Error ? err.message : String(err) });
    }
  })());

  return ephemeral("📣 Bumped! A fresh notice is going up in the channel.");
}

// View — refresh the public message blocks. Lightweight, no state change.
async function handleSpdView(
  payload: SlashCommandPayload,
  env: Env,
  matchId: number,
): Promise<CommandResponse> {
  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return ephemeral("That match is gone.");
  const bets = await getSpdBets(env.DB, matchId);
  const initBets = bets.filter((b) => b.side === "initiator");
  const chalBets = bets.filter((b) => b.side === "challenger");
  const lines = [
    `🪨📜🗡 *Match #${match.id}* — status: ${match.status}`,
    `Stake: *${match.initiator_stake}g* · Initiator: <@${match.initiator_user_id}>`,
    match.challenger_user_id ? `Challenger: <@${match.challenger_user_id}>` : "_No challenger yet._",
    `Bets — ${initBets.length} on initiator (${initBets.reduce((s, b) => s + b.amount, 0)}g), ${chalBets.length} on challenger (${chalBets.reduce((s, b) => s + b.amount, 0)}g).`,
  ];
  return ephemeral(lines.join("\n"));
}

// Resolves a match — computes winner, applies payouts, updates DB,
// posts public reveal. Called from handleSpdChallCommit via waitUntil.
async function resolveSpdMatch(env: Env, matchId: number): Promise<void> {
  const match = await getSpdMatch(env.DB, matchId);
  if (!match) return;
  if (match.status !== "resolving") return;
  if (!match.challenger_user_id || !match.challenger_throw) return; // shouldn't happen

  const a = match.initiator_throw as SpdThrow;
  const b = match.challenger_throw as SpdThrow;
  const cmp = spdCompareThrows(a, b);
  const bets = await getSpdBets(env.DB, matchId);
  const totalBets = bets.reduce((s, bet) => s + bet.amount, 0);
  const playerPot = match.initiator_stake * 2;
  const houseBump = Math.floor((playerPot + totalBets) * SPD_HOUSE_BUMP_PCT);

  // Lead every resolution with the acceptance beat so spectators see WHO
  // stepped up before the result lands. Without this the reveal jumped
  // straight from "match open" to "winner takes the pot" with no clear
  // moment for the challenger to be named.
  const acceptanceLine = `⚔️ <@${match.challenger_user_id}> accepts <@${match.initiator_user_id}>'s challenge!`;
  const matchupLine = `${SPD_THROW_META[a].emoji} <@${match.initiator_user_id}> threw *${SPD_THROW_META[a].name}* · ${SPD_THROW_META[b].emoji} <@${match.challenger_user_id}> threw *${SPD_THROW_META[b].name}*.`;

  if (cmp === 0) {
    // Tie — refund initiator + challenger stakes, refund all bets.
    await addGold(env.DB, match.initiator_user_id, match.initiator_stake);
    await addGold(env.DB, match.challenger_user_id, match.initiator_stake);
    for (const bet of bets) {
      await addGold(env.DB, bet.bettor_user_id, bet.amount);
    }
    await finalizeSpdMatch(env.DB, matchId, null, 0);
    const text = [
      acceptanceLine,
      matchupLine,
      `🤝 *Tie!* Both threw ${SPD_THROW_META[a].emoji} *${SPD_THROW_META[a].name}*. Stakes refunded; ${bets.length > 0 ? `all ${bets.length} side bet${bets.length === 1 ? "" : "s"} refunded.` : "no bets to refund."}`,
    ].filter(Boolean).join("\n");
    await postSpdThreadUpdate(env, match, text, { broadcast: true });
    await retireSpdOpenMessage(env, match, "🤝 Tie — match closed.");
    return;
  }

  const winnerId = cmp === 1 ? match.initiator_user_id : match.challenger_user_id!;
  const loserId = cmp === 1 ? match.challenger_user_id! : match.initiator_user_id;
  const winningSide: "initiator" | "challenger" = cmp === 1 ? "initiator" : "challenger";
  const winnerThrow = cmp === 1 ? a : b;
  const loserThrow = cmp === 1 ? b : a;
  const winnerPot = playerPot + houseBump;

  // Winner takes the player pot + house bump in one go.
  await addGold(env.DB, winnerId, winnerPot);

  // Bettors on the winning side: 2× their stake.
  const winningBettorLines: string[] = [];
  for (const bet of bets) {
    if (bet.side === winningSide) {
      const payout = bet.amount * 2;
      await addGold(env.DB, bet.bettor_user_id, payout);
      winningBettorLines.push(`<@${bet.bettor_user_id}> (+${payout}g)`);
    }
  }
  const losingBetCount = bets.filter((b) => b.side !== winningSide).length;

  await finalizeSpdMatch(env.DB, matchId, winnerId, houseBump);

  // SPD achievements for both players
  for (const [playerId, playerThrow, playerWon] of [
    [match.initiator_user_id, a, cmp === 1] as const,
    [match.challenger_user_id!, b, cmp === -1] as const,
  ]) {
    const char = await getCharacter(env.DB, playerId);
    if (char) {
      const winsRow = await env.DB
        .prepare(`SELECT COUNT(*) AS cnt FROM spd_matches WHERE (initiator_user_id = ? OR challenger_user_id = ?) AND status = 'resolved' AND winner_user_id = ?`)
        .bind(playerId, playerId, playerId)
        .first<{ cnt: number }>();
      const totalWins = (winsRow?.cnt ?? 0) + (playerWon ? 1 : 0);
      const spdIds = checkSpdAchievements({
        existingAchievements: char.achievements,
        won: playerWon,
        throw_used: playerThrow,
        isSpectator: false,
        totalWins,
      });
      for (const id of spdIds) {
        await grantAchievement(env.DB, playerId, id);
      }
    }
  }
  // Spectator bet achievement
  for (const bet of bets) {
    const betChar = await getCharacter(env.DB, bet.bettor_user_id);
    if (betChar) {
      const spectIds = checkSpdAchievements({
        existingAchievements: betChar.achievements,
        won: false,
        throw_used: "stone",
        isSpectator: true,
        totalWins: 0,
      });
      for (const id of spectIds) {
        await grantAchievement(env.DB, bet.bettor_user_id, id);
      }
    }
  }

  const verb = SPD_THROW_META[winnerThrow].verb;
  const lines = [
    acceptanceLine,
    matchupLine,
    `🏆 *<@${winnerId}> wins!* ${SPD_THROW_META[winnerThrow].emoji} ${SPD_THROW_META[winnerThrow].name} ${verb} ${SPD_THROW_META[loserThrow].emoji} ${SPD_THROW_META[loserThrow].name}.`,
    `_<@${winnerId}> takes the *${playerPot}g* pot + a *${houseBump}g* tavern wager-share = *${winnerPot}g* total._`,
  ];
  if (winningBettorLines.length > 0) {
    lines.push(`💰 *Winning side bets:* ${winningBettorLines.join(", ")}.`);
  }
  if (losingBetCount > 0) {
    lines.push(`_${losingBetCount} losing bet${losingBetCount === 1 ? "" : "s"} kept by the house._`);
  }
  await postSpdThreadUpdate(env, match, lines.join("\n"), { broadcast: true });
  await retireSpdOpenMessage(env, match, `🏆 <@${winnerId}> won — match closed.`);
}

// Replaces the original "match open" post (which has stale Accept / Bet
// / Refresh buttons) with a closed summary line. Cheap chat.update call;
// non-fatal if the message_ts isn't stored or the edit fails.
async function retireSpdOpenMessage(env: Env, match: SpdMatch, footer: string): Promise<void> {
  if (!match.message_ts) return;
  try {
    await updateMessage(env.SLACK_BOT_TOKEN, {
      channel: match.channel_id,
      ts: match.message_ts,
      text: footer,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🪨📜🗡 *Stone-Parchment-Dagger* — <@${match.initiator_user_id}>'s ${match.initiator_stake}g match.\n_${footer}_ See thread reply for the reveal.`,
          },
        },
      ],
    });
  } catch (err) {
    console.warn("spd:retire-error", { matchId: match.id, err: err instanceof Error ? err.message : String(err) });
  }
}

// Defensive throw-string validator. Used at every commit entry point so
// a malformed action_id can't put nonsense in the DB.
function isSpdThrow(s: string): s is SpdThrow {
  return s === "stone" || s === "parchment" || s === "dagger";
}

// =============================================================================
// SMITHY
// =============================================================================
//
// Single mechanic v1: 🔨 Sharpen — pay gold to bump an equipped item's
// power by +1. Geometric pricing (cost scales with current power) and a
// hard +3 cap per item make this a meaningful gold sink without runaway
// scaling. Equipped-only filter encourages "buy → equip → upgrade" flow
// and keeps the UI focused on the gear the player is actually using.
//
// Future v2: 🔥 Reforge (gamble re-roll), repair (if we add durability),
// or hands-on customization. Skipped for now to keep scope tight.

// Hard cap — a single item can be sharpened at most 3 times from its
// original power. Stored as `sharpens_count` on the item row; smithy
// refuses when count = cap.
const SMITHY_SHARPEN_CAP = 3;
// Price formula: cost to upgrade from power P → P+1 is (P + 1) * SHARPEN_PRICE_PER_LEVEL.
// At 20g/level: +3→+4 = 80g, +5→+6 = 120g, +7→+8 = 160g. Calibrated so the
// upgrade pays back in a few standard fights and feels expensive late.
const SMITHY_SHARPEN_PRICE_PER_LEVEL = 20;
function smithySharpenCost(currentPower: number): number {
  return (currentPower + 1) * SMITHY_SHARPEN_PRICE_PER_LEVEL;
}

// Per-item upgrade vocabulary. "Sharpen" only fits edged melee weapons —
// a blunderbuss gets *tuned*, a chestplate gets *reinforced*, etc. The
// underlying mechanic + DB column (`sharpens_count`) keep their generic
// names; only the player-facing strings vary by item shape.
//
// Caller uses these on button labels, headlines, confirm dialogs, and
// success messages so the entire smithy interaction reads in-voice.
interface SmithVerb {
  verb: string;          // imperative, used on buttons ("Sharpen", "Tune")
  past: string;          // past-tense for success messages ("sharpened")
  noun: string;          // mass noun for the metered counter ("sharpens", "tunings")
  emoji: string;         // pre-button glyph
  stat: string;          // stat-line label ("damage", "defense")
}
function smithVerbFor(item: Item): SmithVerb {
  if (item.item_type === "armor") {
    return { verb: "Reinforce", past: "reinforced", noun: "reinforcements", emoji: "🛡️", stat: "defense" };
  }
  if (item.item_type === "weapon") {
    // Range-specific verb. Ranged (bows, blunderbusses) get tuned —
    // bore, tension, balance — not sharpened. Focus (wands, staves,
    // codices) get attuned — the smith aligns the resonance for
    // bigger heal/shield output. Melee is the sharpening default.
    const range = item.weapon_range ?? "melee";
    if (range === "ranged") {
      return { verb: "Tune", past: "tuned", noun: "tunings", emoji: "🛠️", stat: "damage" };
    }
    if (range === "focus") {
      return { verb: "Attune", past: "attuned", noun: "attunements", emoji: "🔮", stat: "heal/shield" };
    }
    return { verb: "Sharpen", past: "sharpened", noun: "sharpens", emoji: "🔨", stat: "damage" };
  }
  // Defensive default for any other type that shouldn't reach the smithy.
  return { verb: "Upgrade", past: "upgraded", noun: "upgrades", emoji: "🔨", stat: "power" };
}

// /sq smithy — lists the player's equipped weapon + armor with Sharpen
// buttons. Between-quest only (the smith's hammer rings into a quiet
// town, not over the clamor of an active fight).
async function handleSmithy(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("⚒️ The smith won't take your steel mid-quest — wrap up the fight first.");
  }

  // Pull equipped weapon + armor. Smithy is gear-focused; we don't surface
  // consumables/tools/scrolls (no "power" to sharpen) or unequipped backup
  // gear (keeps the UI focused — equip first, then upgrade).
  const [weapon, armor] = await Promise.all([
    getEquipped(env.DB, payload.user_id, "weapon"),
    getEquipped(env.DB, payload.user_id, "armor"),
  ]);
  const items = [weapon, armor].filter((i): i is Item => !!i);

  const smithyArt = await viewArt(env, ctx, "smithy_interior");
  const introLine = `> _The smith looks up from the anvil, sleeves rolled, hair singed at the edges. "Bring me steel and gold. I'll make it sing."_`;
  const goldLine = `💰 You have *${character.gold}g*.`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `⚒️ The Smithy`, emoji: true } },
  ];
  if (smithyArt) {
    blocks.push({ type: "image", image_url: smithyArt, alt_text: "the smithy" });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `${introLine}\n${goldLine}` } });
  blocks.push({ type: "divider" });

  if (items.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `_Nothing equipped to work on — head to \`${payload.command} inventory\` and equip a weapon or armor first, then come back._` },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Your gear* — the smith *sharpens* edged blades, *tunes* ranged weapons, and *reinforces* armor. Each upgrade adds *+1* to the stat; capped at *${SMITHY_SHARPEN_CAP}* upgrades per item.`,
      },
    });
    for (const it of items) {
      // Item-shape icon (weapon glyph by range, shield for armor) — keeps
      // the row scannable beyond the name.
      const icon = it.item_type === "weapon"
        ? (it.weapon_range === "ranged" ? "🏹" : it.weapon_range === "focus" ? "🔮" : "⚔️")
        : "🛡️";
      const sharpened = it.sharpens_count;
      const remaining = SMITHY_SHARPEN_CAP - sharpened;
      const atCap = remaining <= 0;
      const cost = atCap ? 0 : smithySharpenCost(it.power);
      const canAfford = !atCap && character.gold >= cost;
      // Per-item vocabulary: a blunderbuss gets tuned, a chestplate gets
      // reinforced. The mechanic + cap are identical; the strings adapt.
      const v = smithVerbFor(it);
      const meterFilled = v.emoji.repeat(sharpened);
      const meterEmpty = "·".repeat(remaining);
      // Capitalize the noun for the meter label so "Sharpens / Tunings /
      // Reinforcements" all read sentence-case consistently.
      const nounCap = v.noun.charAt(0).toUpperCase() + v.noun.slice(1);
      const meter = `_${nounCap}: ${meterFilled}${meterEmpty} (${sharpened}/${SMITHY_SHARPEN_CAP})_`;
      const headline = `${icon} *${it.item_name}* — ${v.stat} *+${it.power}*\n${meter}`;
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: headline },
        accessory: {
          type: "button",
          action_id: `smithy_sharpen_${it.id}`,
          value: String(it.id),
          text: { type: "plain_text", text: atCap ? `${v.emoji} Maxed` : canAfford ? `${v.emoji} ${v.verb} +1 — ${cost}g` : `${v.emoji} Need ${cost}g`, emoji: true },
          ...(canAfford ? { style: "primary" } : {}),
          ...(canAfford ? {
            confirm: {
              title: { type: "plain_text", text: `${v.verb} this item?` },
              text: { type: "mrkdwn", text: `Pay *${cost}g* to raise *${it.item_name}* ${v.stat} from +${it.power} to +${it.power + 1}? (${remaining - 1} ${remaining - 1 === 1 ? v.noun.replace(/s$/, "") : v.noun} left after this.)` },
              confirm: { type: "plain_text", text: v.verb },
              deny: { type: "plain_text", text: "Cancel" },
            },
          } : {}),
        },
      });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Slash form: \`${payload.command} smithy sharpen <id>\` from \`${payload.command} inventory\`._` }],
  });
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ Back to Town", emoji: true } },
    ],
  });

  const text = [
    `⚒️ *The Smithy*`,
    introLine,
    goldLine,
    "",
    items.length === 0
      ? "_Nothing equipped to work on._"
      : items.map((it) => {
          const icon = it.item_type === "weapon" ? "⚔️" : "🛡️";
          const remaining = SMITHY_SHARPEN_CAP - it.sharpens_count;
          const cost = remaining <= 0 ? "MAX" : `${smithySharpenCost(it.power)}g`;
          const v = smithVerbFor(it);
          return `${icon} ${it.item_name} ${v.stat} +${it.power} (${it.sharpens_count}/${SMITHY_SHARPEN_CAP} ${v.noun}) — ${cost}`;
        }).join("\n"),
  ].join("\n");

  return { text, response_type: "ephemeral", blocks };
}

// /sq smithy sharpen <id> — does the work. Race-safe via the conditional
// UPDATE in sharpenItem (the WHERE clause refuses to bump beyond the cap).
// Gold deduct happens FIRST (atomic too); if the sharpen UPDATE fails
// (race / already-at-cap), we refund.
async function handleSmithySharpen(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  itemIdStr: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("⚒️ Not while you're questing.");

  const itemId = parseInt(itemIdStr, 10);
  if (!Number.isFinite(itemId)) return ephemeral("Invalid item id.");

  const item = await getItem(env.DB, itemId, payload.user_id);
  if (!item) return ephemeral("That item isn't in your pack.");
  if (item.item_type !== "weapon" && item.item_type !== "armor") {
    return ephemeral(`⚒️ The smith only works on weapons and armor — *${item.item_name}* isn't either.`);
  }
  if (!item.equipped) {
    return ephemeral(`⚒️ Equip *${item.item_name}* first — the smith only sharpens what you're carrying ready to swing.`);
  }
  if (item.sharpens_count >= SMITHY_SHARPEN_CAP) {
    return ephemeral(`⚒️ *${item.item_name}* is already maxed out at ${SMITHY_SHARPEN_CAP} sharpens. The smith won't touch it further.`);
  }

  const cost = smithySharpenCost(item.power);
  if (character.gold < cost) {
    return ephemeral(`💰 You need *${cost}g* to sharpen *${item.item_name}* — you have ${character.gold}g.`);
  }

  // Atomic gold deduct first; race-safe via the conditional WHERE.
  const goldOk = await tryDeductGold(env.DB, payload.user_id, cost);
  if (!goldOk) return ephemeral("💰 Couldn't deduct gold — try again.");

  // Race-safe UPDATE on the item. If it fails (another sharpen landed
  // simultaneously OR the item hit cap between our read and write), refund
  // the gold so the player isn't out a payment for nothing.
  const updated = await sharpenItem(env.DB, item.id, payload.user_id, SMITHY_SHARPEN_CAP);
  if (!updated) {
    await addGold(env.DB, payload.user_id, cost);
    return ephemeral("⚒️ The smith waves you off — the moment passed. Your gold is back.");
  }

  const remaining = SMITHY_SHARPEN_CAP - updated.sharpens_count;
  const v = smithVerbFor(updated);
  const remainingNote = remaining > 0
    ? `${remaining} ${remaining === 1 ? v.noun.replace(/s$/, "") : v.noun} left on this piece.`
    : `That's the last one — the smith won't take more.`;

  // Surface the post-upgrade sell price too — smithing boosts resale,
  // not just the combat stat. Helps players see they're investing in
  // real value rather than burning gold one-way.
  const sellNow = sellPriceFor(updated.item_type, updated.rarity, {
    power: updated.power,
    sharpens_count: updated.sharpens_count,
  });
  return ephemeral(
    `${v.emoji} *${updated.item_name}* ${v.past} — ${v.stat} *+${item.power} → +${updated.power}* _(\`-${cost}g\`)_. ${remainingNote}\n_(Sell value now: ${sellNow}g.)_`,
  );
}

// =============================================================================
// INN
// =============================================================================
//
// Two room tiers v1: 🛏️ Common Cot (HP only) and 🛁 Hot Bath & Bed (HP + mana).
// The value proposition vs. `/sq rest long` is "pay gold to skip the 24h
// cooldown" — the long-rest does the same HP refill for free, but only
// once a day. Hot Bath is competitive with stacking mana potions for
// mana-heavy classes who run dry mid-day.
//
// We DON'T touch the rest-cooldown timestamps — the Inn is a parallel
// recovery channel, not a "reset your free long rest" mechanic. A player
// who's done a long rest 1 hour ago can still pay for the Inn for a full
// top-up; the next free long rest is still 23 hours away.

interface InnRoom {
  id: string;
  emoji: string;
  name: string;
  price: number;
  refills: { hp: boolean; mana: boolean };
  blurb: string;
}
const INN_ROOMS: InnRoom[] = [
  {
    id: "cot",
    emoji: "🛏️",
    name: "Common Cot",
    price: 20,
    refills: { hp: true, mana: false },
    blurb: "A straw cot, a wool blanket, a guarantee nobody'll loot you in your sleep. Wakes you at *full HP*.",
  },
  {
    id: "bath",
    emoji: "🛁",
    name: "Hot Bath & Bed",
    price: 50,
    refills: { hp: true, mana: true },
    blurb: "A copper tub, lavender soap, a real mattress. Wakes you at *full HP and full mana*.",
  },
];

function findInnRoom(id: string): InnRoom | undefined {
  return INN_ROOMS.find((r) => r.id === id);
}

// /sq inn — pick a room tier. Between-quest only. Buttons grey out when
// the player is already maxed on what the tier offers (no point paying
// for a cot when you're at full HP).
async function handleInn(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛏️ The inn's doors are bolted to questing parties — finish the fight first.");
  }

  const innArt = await viewArt(env, ctx, "inn_interior");
  const introLine = `> _A small hearth crackles in the corner. The innkeep looks up. "Room for the night?"_`;
  // Compact stat-line so players see what each tier would change.
  const hpLine = character.hp < character.max_hp
    ? `❤️ ${character.hp}/${character.max_hp} HP`
    : `❤️ Full HP`;
  const manaLine = character.mana < character.max_mana
    ? `🔮 ${character.mana}/${character.max_mana} mana`
    : `🔮 Full mana`;
  const statLine = `${hpLine}  •  ${manaLine}  •  💰 ${character.gold}g`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `🛏️ The Inn`, emoji: true } },
  ];
  if (innArt) {
    blocks.push({ type: "image", image_url: innArt, alt_text: "the inn's main room" });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `${introLine}\n${statLine}` } });
  blocks.push({ type: "divider" });

  for (const room of INN_ROOMS) {
    // A room is "useful" if it would actually change something — buying a
    // cot at full HP is wasteful, so we grey out and tell the player.
    const wouldRefillHp = room.refills.hp && character.hp < character.max_hp;
    const wouldRefillMana = room.refills.mana && character.mana < character.max_mana;
    const useful = wouldRefillHp || wouldRefillMana;
    const canAfford = character.gold >= room.price;
    // Effect summary: spell out what changes (e.g. "+22 HP" or "Already
    // rested") so the player understands what they're buying.
    const refillParts: string[] = [];
    if (room.refills.hp) {
      const delta = character.max_hp - character.hp;
      refillParts.push(delta > 0 ? `*+${delta} HP*` : "_HP full_");
    }
    if (room.refills.mana) {
      const delta = character.max_mana - character.mana;
      refillParts.push(delta > 0 ? `*+${delta} mana*` : "_mana full_");
    }
    const refillText = refillParts.join(" · ");

    let buttonLabel: string;
    if (!useful) buttonLabel = `${room.emoji} Already rested`;
    else if (!canAfford) buttonLabel = `${room.emoji} Need ${room.price}g`;
    else buttonLabel = `${room.emoji} Stay — ${room.price}g`;

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${room.emoji} *${room.name}* — _${room.blurb}_\n${refillText} • *${room.price}g*`,
      },
      accessory: {
        type: "button",
        action_id: `inn_stay_${room.id}`,
        value: room.id,
        text: { type: "plain_text", text: buttonLabel, emoji: true },
        ...(useful && canAfford ? { style: "primary" } : {}),
        ...(useful && canAfford ? {
          confirm: {
            title: { type: "plain_text", text: "Stay the night?" },
            text: { type: "mrkdwn", text: `Pay *${room.price}g* for the *${room.name}*? You'll wake at ${refillParts.join(" + ").replace(/\*/g, "")}.` },
            confirm: { type: "plain_text", text: "Stay" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        } : {}),
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Slash form: \`${payload.command} inn stay <cot|bath>\`. The Inn bypasses the 24h \`${payload.command} rest long\` cooldown — pay gold any time._` }],
  });
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ Back to Town", emoji: true } },
    ],
  });

  const text = [
    `🛏️ *The Inn*`,
    introLine,
    statLine,
    "",
    ...INN_ROOMS.map((r) => `${r.emoji} ${r.name} — ${r.price}g`),
  ].join("\n");

  return { text, response_type: "ephemeral", blocks };
}

// /sq inn stay <room_id> — actually book the room. Race-safe atomic gold
// deduct, then refills. We DON'T touch last_rest_at / last_long_rest_at
// — the Inn is a separate recovery channel; the free long-rest cooldown
// stays where it is.
async function handleInnStay(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  roomId: string,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) return ephemeral("🛏️ The inn's doors are bolted to questing parties — finish the fight first.");

  const room = findInnRoom(roomId);
  if (!room) return ephemeral(`Unknown room: \`${roomId}\`. Try \`cot\` or \`bath\`.`);

  // Refuse if the room would do nothing — saves the player from paying
  // for a cot at full HP. Also covers the edge case where someone clicks
  // the slash form while already rested.
  const wouldRefillHp = room.refills.hp && character.hp < character.max_hp;
  const wouldRefillMana = room.refills.mana && character.mana < character.max_mana;
  if (!wouldRefillHp && !wouldRefillMana) {
    return ephemeral(`🛏️ You're already rested — the *${room.name}* would be a wasted ${room.price}g.`);
  }

  if (character.gold < room.price) {
    return ephemeral(`💰 You need *${room.price}g* for the *${room.name}* — you have ${character.gold}g.`);
  }

  // Atomic gold deduct.
  const goldOk = await tryDeductGold(env.DB, payload.user_id, room.price);
  if (!goldOk) return ephemeral("💰 Couldn't deduct gold — try again.");

  // Apply refills. healCharacter / refillMana clamp at max so it's safe
  // to call when already partially full.
  let healed = 0;
  let manaAdded = 0;
  if (room.refills.hp) {
    healed = await healCharacter(env.DB, character, character.max_hp - character.hp);
  }
  if (room.refills.mana) {
    // refillMana sets to max in one shot; the delta we report is from
    // the original character snapshot (post-write the value is max_mana).
    await refillMana(env.DB, payload.user_id);
    manaAdded = character.max_mana - character.mana;
  }

  const deltas: string[] = [];
  if (healed > 0) deltas.push(`*+${healed} HP*`);
  if (manaAdded > 0) deltas.push(`*+${manaAdded} mana*`);
  const deltaLine = deltas.join(" · ") || "_already rested_";

  return ephemeral(
    `${room.emoji} You take the *${room.name}* (\`-${room.price}g\`). ${deltaLine}. _Sleep well._`,
  );
}

async function handleShop(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛒 No shopping mid-quest — the shopkeep is afraid of monsters. Finish the fight first.");
  }

  const existing = await getActiveShopStock(env.DB, payload.channel_id, SHOP_RESTOCK_MS);
  if (existing && existing.length > 0) {
    const shopArt = await viewArt(env, ctx, "channel_shop");
    return {
      text: formatShopText(existing, character.gold, payload.command),
      response_type: "ephemeral",
      blocks: formatShopBlocks(existing, character.gold, payload.command, shopArt),
    };
  }

  // Shop is dry — kick off a restock. Generation does up to SHOP_STOCK_SIZE AI calls,
  // so we ack immediately and let it run via waitUntil. The user re-runs /dnd shop to see it.
  ctx.waitUntil(restockShop(env, payload.channel_id));
  return ephemeral(
    `🛒 The shopkeep is unpacking new stock — try \`${payload.command} shop\` again in a few seconds.`,
  );
}

async function restockShop(env: Env, channelId: string): Promise<void> {
  // Idempotency guard: if another concurrent /dnd shop already kicked off a restock
  // (rows with generated_at in the last 60s), bail. Without this, N near-simultaneous
  // /dnd shop calls would each generate their own batch of stock and the channel would
  // see 5N items. The window between this check and the eventual insertShopStock is
  // small (~AI latency) but bounded — for an 8-person team this resolves the
  // thundering-herd cleanly without a separate lock table.
  const recent = await env.DB
    .prepare("SELECT 1 FROM shop_stock WHERE channel_id = ? AND generated_at > ? LIMIT 1")
    .bind(channelId, Date.now() - 60_000)
    .first();
  if (recent) return;

  const { min: minLevel, max: maxLevel } = await characterLevelRange(env.DB);
  const tierLo = Math.max(2, minLevel);
  const tierHi = Math.max(tierLo, maxLevel);
  const randomTier = () => tierLo + Math.floor(Math.random() * (tierHi - tierLo + 1));
  const playerCount = await countCharacters(env.DB);
  const stockSize = Math.min(
    SHOP_STOCK_CAP,
    SHOP_STOCK_BASE + Math.max(0, playerCount - SHOP_STOCK_PLAYER_BASELINE) * SHOP_STOCK_PER_EXTRA_PLAYER,
  );
  const generatedAt = Date.now();
  const items: Parameters<typeof insertShopStock>[1] = [];
  // Guarantee 2 accessory slots per cycle so rings/amulets/boots/helmets/pants
  // always appear regardless of the overall armor-type probability.
  const ACCESSORY_GUARANTEE = 2;
  const rolls: ItemRoll[] = [
    ...Array.from({ length: ACCESSORY_GUARANTEE }, () => rollAccessorySlot(randomTier())),
    ...Array.from({ length: Math.max(0, stockSize - ACCESSORY_GUARANTEE) }, () => rollItem(randomTier(), true)),
  ];
  for (const roll of rolls) {
    const named = await resolveLootDrop(env, "the shopkeep's chest", roll);
    items.push({
      channel_id: channelId,
      generated_at: generatedAt,
      item_name: named.name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor: named.flavor,
      price: priceFor(roll.type, roll.rarity),
      weapon_range: roll.weapon_range ?? null,
      slot: roll.slot ?? null,
      stat_bonus: (roll.stat_bonus ?? null) as Record<string, number> | null,
      item_subtype: roll.item_subtype ?? null,
    });
  }
  await insertShopStock(env.DB, items);
}

// Plain-text shop summary (for fallback / non-Block-Kit clients).
function formatShopText(items: ShopItem[], gold: number, cmd: string): string {
  const lines = [`🛒 *Shop* — you have ${gold} gold`];
  for (const it of items) {
    const status = it.bought_by ? " ❌_sold_" : "";
    const powerStr = powerLabel(it.item_type, it.power, it.item_name);
    lines.push(
      `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}${rangeBadge(it)}, ${powerStr} • *${it.price}g*${status}`,
    );
    const effect = catalogEffectLine(it.item_name);
    if (effect) lines.push(`   ${effect}`);
    if (it.flavor) lines.push(`   _${it.flavor}_`);
  }
  lines.push(
    "",
    `Buy with \`${cmd} buy <id>\`. Sell your own items with \`${cmd} sell <id>\`. _Cap: ${SHOP_BUY_CAP_PER_CYCLE} purchases per restock cycle._`,
  );
  return lines.join("\n");
}

// Block Kit shop view: header + per-item (section + Buy button), with sold items
// styled as struck-through and no Buy button. The Buy button carries the shop_stock
// id as `value` and routes through handleInteraction → handleBuy.
//
// `shopArtUrl` is pre-resolved by the caller — formatShopBlocks stays sync so
// per-item rendering is straightforward. Pass null when the cache miss
// triggered a background gen (image will appear on next render).
function formatShopBlocks(items: ShopItem[], gold: number, cmd: string, shopArtUrl: string | null): unknown[] {
  const available = items.filter((i) => !i.bought_by).length;
  const blocks: unknown[] = [];
  if (shopArtUrl) {
    blocks.push({
      type: "image",
      image_url: shopArtUrl,
      alt_text: "the shop",
    });
  }
  blocks.push(
    {
      type: "header",
      text: { type: "plain_text", text: `🛒 Shop — ${available}/${items.length} available` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `You have *${gold}g*. Cap: ${SHOP_BUY_CAP_PER_CYCLE} purchases per restock cycle.` }],
    },
    { type: "divider" },
  );
  for (const it of items) {
    const sold = !!it.bought_by;
    const powerStr = powerLabel(it.item_type, it.power, it.item_name);
    const effect = catalogEffectLine(it.item_name);
    const effectLine = effect ? `\n${effect}` : "";
    const flavorLine = it.flavor ? `\n_${it.flavor}_` : "";
    // Haggle status badge — appended to the price line so the discount is visible.
    const haggleBadge =
      it.haggled === "failed" ? "  🪙 _haggle failed_" :
      it.haggled === "15" ? "  🪙 _-15% haggled_" :
      it.haggled === "25" ? "  🪙 _-25% haggled_" :
      it.haggled === "30" ? "  🪙 _-30% STEAL_" : "";
    const summaryRaw = `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}${rangeBadge(it)}, ${powerStr} • *${it.price}g*${haggleBadge}${effectLine}${flavorLine}`;
    // Sold items: render dimmed + tagged. We can't truly grey out a section in
    // Block Kit, so we strikethrough the name and append "❌ sold by <user>".
    const summary = sold
      ? `~${summaryRaw.replace(/\*([^*]+)\*/, "$1")}~  ❌ _sold to <@${it.bought_by}>_`
      : summaryRaw;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: summary } });

    if (!sold) {
      const canAfford = gold >= it.price;
      const elements: unknown[] = [
        {
          type: "button",
          action_id: "shop_buy",
          value: String(it.id),
          text: { type: "plain_text", text: canAfford ? `🛍️ Buy ${it.price}g` : `Not enough gold (${it.price}g)` },
          style: "primary",
          confirm: {
            title: { type: "plain_text", text: "Buy this item?" },
            text: { type: "mrkdwn", text: `Buy *${it.item_name}* for ${it.price}g? You'll have ${gold - it.price}g left.` },
            confirm: { type: "plain_text", text: "Buy" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ];
      // Haggle button — only when not yet attempted on this item.
      if (!it.haggled) {
        elements.push({
          type: "button",
          action_id: "shop_haggle",
          value: String(it.id),
          text: { type: "plain_text", text: "🪙 Haggle" },
        });
      }
      blocks.push({
        type: "actions",
        block_id: `shop_${it.id}`,
        elements,
      });
    }
  }
  // Staples — always-in-stock potions. Distinct section + leading divider so
  // it visually separates from the rolled stock above. No buy cap, no haggle,
  // fixed price. One button per staple (4 total).
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*🧺 Always in stock* — fixed prices, no purchase cap.`,
    },
  });
  for (const s of STAPLES) {
    const canAfford = gold >= s.price;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${s.emoji} *${s.name}* — ${s.blurb} • *${s.price}g*`,
      },
      accessory: {
        type: "button",
        action_id: `staple_buy_${s.id}`,
        value: s.id,
        text: { type: "plain_text", text: canAfford ? `🛍️ Buy ${s.price}g` : `Need ${s.price}g` },
        style: canAfford ? "primary" : undefined,
      },
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Slash form: \`${cmd} buy <id>\` (rolled stock) or \`${cmd} buy <staple>\` (e.g. \`${cmd} buy hp\`, \`${cmd} buy mp+\`) • \`${cmd} sell <id>\`._` }],
  });
  // Quick-nav back to the town view. Works whether the player came via
  // `/sq town` → shop button or typed `/sq shop` directly — either way,
  // discoverable from here.
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "town_open", value: "town", text: { type: "plain_text", text: "🏘️ Back to Town", emoji: true } },
    ],
  });
  return blocks;
}

async function handleBuy(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  // Staples branch FIRST — allowed mid-quest (the dungeon merchant renders
  // them too). Rolled-stock purchases are still gated on no-active-quest
  // below since the channel shop is meant to be a between-quests stop.
  const stapleQuery = (args[0] ?? "").trim();
  const staple = stapleQuery ? findStaple(stapleQuery) : null;
  if (staple) return buyStaple(payload, env, character, staple);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛒 No shopping mid-quest. Finish the fight first.");
  }

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} buy <shop id>\` (find ids with \`${payload.command} shop\`).`);

  const stock = await getShopItem(env.DB, id, payload.channel_id);
  if (!stock) return ephemeral("No such shop item in this channel.");
  if (stock.bought_by) return ephemeral(`*${stock.item_name}* was already bought.`);
  if (character.gold < stock.price) {
    return ephemeral(`Not enough gold — *${stock.item_name}* costs ${stock.price}g, you have ${character.gold}g.`);
  }

  // Per-cycle purchase cap so a fast buyer can't clear the shop alone.
  const alreadyBought = await countPurchasesInCycle(
    env.DB,
    payload.channel_id,
    payload.user_id,
    stock.generated_at,
  );
  if (alreadyBought >= SHOP_BUY_CAP_PER_CYCLE) {
    return ephemeral(
      `🛒 You've already bought ${SHOP_BUY_CAP_PER_CYCLE} item${SHOP_BUY_CAP_PER_CYCLE > 1 ? "s" : ""} this restock cycle. Wait for the next 6h refresh.`,
    );
  }

  // Two-stage atomic purchase:
  //   1. Claim the stock row (prevents two players from buying the same item).
  //   2. Conditionally deduct gold (prevents a player from buying two items in
  //      parallel that together exceed their balance).
  // If gold deduct fails after the claim succeeds, release the claim so the item
  // goes back into the shop.
  const claimed = await claimShopItem(env.DB, stock.id, payload.user_id);
  if (!claimed) return ephemeral(`*${stock.item_name}* was just bought by someone else.`);

  const paid = await tryDeductGold(env.DB, payload.user_id, stock.price);
  if (!paid) {
    await releaseShopClaim(env.DB, stock.id);
    return ephemeral(
      `Not enough gold — looks like you spent it on something else. *${stock.item_name}* is back in the shop.`,
    );
  }

  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: stock.item_name,
    item_type: stock.item_type,
    power: stock.power,
    rarity: stock.rarity,
    flavor: stock.flavor ?? "",
    weapon_range: stock.weapon_range,
    slot: stock.slot ?? undefined,
    stat_bonus: stock.stat_bonus ?? undefined,
    item_subtype: stock.item_subtype ?? undefined,
  });
  const text = `🛍️ Bought ${RARITY_BADGE[stock.rarity]} *${stock.item_name}* for ${stock.price}g (now ${character.gold - stock.price}g). Inventory id \`${item.id}\`.`;
  return {
    text,
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      shopBackButtonRow(),
    ],
  };
}

// Buys a staple potion — always in stock, no buy cap, fixed price. Inserts
// directly into inventory with item_type="consumable" (both health and mana
// potions; handleUse routes mana potions to the mana-restore handler via
// findStaple). Out-of-quest only, like the rolled-shop buy flow.
async function buyStaple(
  payload: SlashCommandPayload,
  env: Env,
  character: Character,
  staple: StapleSpec,
): Promise<CommandResponse> {
  if (character.gold < staple.price) {
    return ephemeral(
      `🛒 *${staple.name}* costs ${staple.price}g — you have ${character.gold}g.`,
    );
  }
  // Atomic gold deduct so two parallel buys can't double-spend.
  const paid = await tryDeductGold(env.DB, payload.user_id, staple.price);
  if (!paid) {
    return ephemeral(`Couldn't afford that — looks like the gold went elsewhere.`);
  }
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: `${staple.emoji} ${staple.name}`,
    item_type: "consumable",
    power: staple.power,
    rarity: "common",
    flavor: staple.blurb,
    weapon_range: null,
  });
  return ephemeral(
    `🛍️ Bought *${staple.emoji} ${staple.name}* (id \`${item.id}\`) for *${staple.price}g* (now ${character.gold - staple.price}g). Use with \`${payload.command} use ${item.id}\`.`,
  );
}

// Haggle for a discount on a single shop item. Communal: any party member can
// haggle each item once per cycle; the outcome locks for everyone.
//   Roll: 1d6 + class haggle modifier (Bard +2, Rogue/Sage +1, others 0).
//   ≤3 → failed (price unchanged, locked from further haggling)
//   4-5 → 15% off
//   6   → 25% off
//   7+  → 30% off (the "steal" tier — Bards live for this)
//
// Free action — no gold cost, no shop-buy-cap consumption. The per-item lock is
// the only gate.
async function handleHaggle(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛒 No haggling mid-quest. Finish the fight first.");
  }

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} haggle <shop id>\`.`);

  const stock = await getShopItem(env.DB, id, payload.channel_id);
  if (!stock) return ephemeral("No such shop item in this channel.");
  if (stock.bought_by) return ephemeral(`*${stock.item_name}* was already bought — too late to haggle.`);
  if (stock.haggled) {
    return ephemeral(
      stock.haggled === "failed"
        ? `🪙 *${stock.item_name}* — haggle already failed. Price locked at ${stock.price}g.`
        : `🪙 *${stock.item_name}* — already haggled (-${stock.haggled}%). Price: ${stock.price}g.`,
    );
  }

  const mod = haggleMod(character.class);
  const roll = rollDice(6);
  const total = roll + mod;
  let bucket: "failed" | "modest" | "solid" | "steal";
  let pct = 0;
  if (total <= 3) bucket = "failed";
  else if (total <= 5) { bucket = "modest"; pct = 15; }
  else if (total === 6) { bucket = "solid"; pct = 25; }
  else { bucket = "steal"; pct = 30; }

  const newPrice = pct > 0 ? Math.max(1, Math.floor(stock.price * (1 - pct / 100))) : stock.price;
  const outcomeTag: "failed" | "15" | "25" | "30" = bucket === "failed" ? "failed" : (String(pct) as "15" | "25" | "30");

  const ok = await trySetHaggleOutcome(env.DB, stock.id, outcomeTag, newPrice);
  if (!ok) {
    return ephemeral(`*${stock.item_name}* was already haggled by someone else.`);
  }

  const flavor = pickHaggleLine(bucket);
  const modBreakdown = mod > 0 ? `${roll} + ${mod}m` : `${roll}`;
  const headline = bucket === "failed"
    ? `🪙 <@${payload.user_id}> tries to haggle *${stock.item_name}* — *failed* \`1d6 + ${modBreakdown} = ${total}\`. Price locked at ${stock.price}g.`
    : bucket === "steal"
    ? `🪙 <@${payload.user_id}> haggles *${stock.item_name}* — *STEAL!* -${pct}% \`1d6 + ${modBreakdown} = ${total}\`. New price: *${newPrice}g* (was ${stock.price}g).`
    : `🪙 <@${payload.user_id}> haggles *${stock.item_name}* — *-${pct}%* \`1d6 + ${modBreakdown} = ${total}\`. New price: *${newPrice}g* (was ${stock.price}g).`;

  const text = `${headline}\n_${flavor}_`;

  // Post the haggle result to the channel publicly — everyone sees the win/fail
  // (and can react). Top-level message (no thread_ts) since shopping happens
  // between quests. The haggler still gets an ephemeral copy with a [Shop]
  // button for quick navigation.
  ctx.waitUntil(
    postMessage(env.SLACK_BOT_TOKEN, {
      channel: payload.channel_id,
      text,
    }),
  );

  return {
    text,
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      shopBackButtonRow(),
    ],
  };
}

// Shared "back to shop" actions row used after haggle / buy / sell-from-shop
// confirmations so the player can hop back into the shop view in one click
// instead of re-running /sq shop. action_id "shop_open" routes through
// handleInteraction → handleShop.
function shopBackButtonRow(): unknown {
  return {
    type: "actions",
    block_id: "shop_back",
    elements: [
      {
        type: "button",
        action_id: "shop_open",
        value: "open",
        text: { type: "plain_text", text: "🛒 Back to Shop" },
      },
    ],
  };
}

async function handleSell(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛒 No selling mid-quest — keep your gear. Finish the fight first.");
  }

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} sell <inventory id>\`.`);

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.equipped) return ephemeral("Unequip it first.");

  // Sharpen rebate folds into the sale (item.power and item.sharpens_count
  // drive a partial recoup of smithy gold).
  const price = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
  await removeItem(env.DB, item.id);
  await addGold(env.DB, payload.user_id, price);
  return ephemeral(
    `💰 Sold *${item.item_name}* for ${price}g (now ${character.gold + price}g).`,
  );
}

// Sell ONE key of the given tier for its flat gold value. Lets piled-up keys
// convert to gold without requiring a lockbox to spend them on. No mid-quest
// selling (you might still need that key in the dungeon).
async function handleSellKey(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("🛒 No key-selling mid-quest — you might need that key.");
  }

  const tierArg = (args[0] ?? "").toLowerCase();
  if (tierArg !== "bronze" && tierArg !== "silver" && tierArg !== "gold") {
    return ephemeral(`Usage: \`${payload.command} sell-key bronze|silver|gold\`.`);
  }
  const tier = tierArg as KeyTier;
  if (keyCount(character, tier) < 1) {
    return ephemeral(`${KEY_EMOJI[tier]} You don't have any ${tier} keys.`);
  }

  const price = KEY_SELL_PRICE[tier];
  await addCharacterKey(env.DB, payload.user_id, tier, -1);
  await addGold(env.DB, payload.user_id, price);
  return ephemeral(
    `💰 Sold a ${KEY_EMOJI[tier]} *${tier}* key for ${price}g (now ${character.gold + price}g).`,
  );
}

// Transmute 3 keys of one tier into 1 key of the next tier up. Bronze → silver,
// silver → gold. No transmute past gold (it's the top tier).
async function handleTransmuteKey(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    return ephemeral("⚗️ No transmuting mid-quest — focus on the dungeon.");
  }

  const tierArg = (args[0] ?? "").toLowerCase();
  if (tierArg !== "bronze" && tierArg !== "silver") {
    return ephemeral(`Usage: \`${payload.command} transmute bronze|silver\` (3-of-tier → 1 of next tier).`);
  }
  const fromTier = tierArg as KeyTier;
  const toTier = nextKeyTier(fromTier);
  if (!toTier) {
    return ephemeral(`${KEY_EMOJI.gold} Gold keys are the top tier — nothing to transmute up to.`);
  }
  if (keyCount(character, fromTier) < KEY_TRANSMUTE_COST) {
    return ephemeral(
      `${KEY_EMOJI[fromTier]} Need ${KEY_TRANSMUTE_COST} ${fromTier} keys to transmute. You have ${keyCount(character, fromTier)}.`,
    );
  }

  await addCharacterKey(env.DB, payload.user_id, fromTier, -KEY_TRANSMUTE_COST);
  await addCharacterKey(env.DB, payload.user_id, toTier, 1);
  return ephemeral(
    `⚗️ Transmuted *${KEY_TRANSMUTE_COST}* ${KEY_EMOJI[fromTier]} ${fromTier} → *1* ${KEY_EMOJI[toTier]} ${toTier} key.`,
  );
}

// Hand an item over to another player. Works anywhere (no quest required) so it
// composes with the shop ("I bought you a healing potion") and post-quest cleanup.
// Equipped items are auto-unequipped on transfer to keep the new owner's slot state sane.
async function handleGive(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const itemId = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(itemId)) {
    return ephemeral(`Usage: \`${payload.command} give <inventory id> @user\`.`);
  }

  const targetUserId = parseMention(args.slice(1).join(" "));
  if (!targetUserId) {
    return ephemeral(`Need a target — \`${payload.command} give ${itemId} @user\`.`);
  }
  if (targetUserId === payload.user_id) {
    return ephemeral("You can't give items to yourself.");
  }

  const item = await getItem(env.DB, itemId, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.equipped) {
    return ephemeral(`*${item.item_name}* is currently equipped — equip a different ${item.item_type} first to free this slot.`);
  }

  const target = await getCharacter(env.DB, targetUserId);
  if (!target) return ephemeral(`<@${targetUserId}> hasn't rolled a character yet.`);

  await transferItem(env.DB, item.id, target.slack_user_id);

  // Public in-channel post so the whole channel sees the generosity. Errors above
  // (no item, equipped, no target, etc.) stay ephemeral — only successful transfers
  // get the broadcast.
  return inChannel(
    `🎁 <@${payload.user_id}> gives *${item.item_name}* (${item.item_type}, ${powerLabel(item.item_type, item.power, item.item_name)}) to <@${target.slack_user_id}>.`,
  );
}

// Slack @ mentions in slash text come through as <@U123ABC> or <@U123ABC|name>.
// Extract the user id (or null if no mention is present).
const MENTION_RX = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/;
function parseMention(text: string): string | null {
  const m = MENTION_RX.exec(text);
  return m?.[1] ?? null;
}

// All user mentions in a string, in order, deduped. Used by /sq quest @a @b @c
// for batch quest invites.
function parseMentions(text: string): string[] {
  const rx = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Pure scene-scaling helper — same math as scaleMonsterForJoin in db.ts but runs
// against an in-memory SceneJson before the quest is persisted. Used by /sq quest
// when invitees are batched in at quest start, so the saved scene already reflects
// the scaled monster HP.
function preScaleForJoiners(scene: SceneJson, joinerCount: number, ratio: number): SceneJson {
  let s = scene;
  for (let i = 0; i < joinerCount; i++) {
    const bump = Math.max(1, Math.floor(s.monster_max_hp * ratio));
    s = {
      ...s,
      monster_hp: s.monster_hp + bump,
      monster_max_hp: s.monster_max_hp + bump,
    };
  }
  return s;
}

// For parties of 2+ on standard/gauntlet quests: guarantee extra monsters so
// Exponential decay: 70% at tier 1, ~1% at tier 15. Returns 0 (no armor) or tier.
function rollMonsterShield(tier: number): number {
  return Math.random() < 0.7 * Math.pow(0.75, tier - 1) ? 0 : tier;
}

// multi-player fights are always multi-monster. Minions are the same creature
// type at tier-1, 65% of the (post-scaled) main HP — weaker but real threats.
// Boss and dungeon variants are excluded: boss has phases, dungeon handles its
// own room-level packs.
function addPackMonstersForParty(scene: SceneJson, partySize: number): SceneJson {
  if (scene.monsters && scene.monsters.length > 1) return scene; // already a pack
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
    ] as typeof scene.monsters,
  };
}

// Shared validation for heal/shield: target must be on the same active quest.
async function resolveSupportTarget(
  env: Env,
  invoker: Character,
  invokerQuest: ActiveQuest,
  args: string[],
): Promise<{ target: Character } | { error: string }> {
  const targetId = parseMention(args.join(" ")) ?? invoker.slack_user_id;
  const target = targetId === invoker.slack_user_id
    ? invoker
    : await getCharacter(env.DB, targetId);
  if (!target) return { error: "Target hasn't rolled a character yet." };
  const targetQuest = targetId === invoker.slack_user_id
    ? invokerQuest
    : await getActiveQuestForCharacter(env.DB, targetId);
  if (!targetQuest || targetQuest.id !== invokerQuest.id) {
    return { error: `*${target.name}* isn't on your quest.` };
  }
  return { target };
}

// /sq mark — focus-fire caller. Tags the current monster as "marked" for
// FOCUS_FIRE_DURATION_MS; other partymates attacking the marked monster get
// +FOCUS_FIRE_BONUS damage. The marker themselves doesn't get the bonus
// (the mechanic is for calling targets, not buffing yourself).
//
// Free action: no mana cost, no cooldown burn, no monster retaliation —
// it's a callout, not a swing.
async function handleMark(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral(`You're not on an active quest. Try \`${payload.command} quest\`.`);

  if (!hasLiveMonster(quest)) {
    return ephemeral(`Nothing to mark — no live foe in this room.`);
  }

  // Re-marking an already-marked monster refreshes the timer (and lets a new
  // marker take over) but is otherwise a no-op. We don't reject — it's a
  // free action, low-cost to spam.
  const expiry = Date.now() + FOCUS_FIRE_DURATION_MS;
  const updatedScene: SceneJson = {
    ...quest.scene,
    marked_by: payload.user_id,
    marked_until: expiry,
  };
  // Conditional on monster_hp not having moved — protects against a race
  // where the monster dies between read and write (we'd be marking a corpse).
  const ok = await tryUpdateScene(env.DB, quest.id, updatedScene, quest.scene.monster_hp);
  if (!ok) {
    return ephemeral(`The fight moved on — try again.`);
  }
  await appendLog(env.DB, quest.id, payload.user_id, "mark", `${quest.scene.monster_name} marked for ${Math.round(FOCUS_FIRE_DURATION_MS / 1000)}s`);

  const headline = `🎯 <@${payload.user_id}> calls focus on *${quest.scene.monster_name}* — partymates get *+${FOCUS_FIRE_BONUS}* damage for the next ${Math.round(FOCUS_FIRE_DURATION_MS / 1000)}s.`;
  // Post publicly in the thread so the whole party sees the call.
  ctx.waitUntil(postToThread(env, quest, headline));
  return ephemeral(headline);
}

// /sq ability — class-active dispatcher. Each class has ONE active tactical
// ability (separate from its damage signature and its always-on passive).
// Shared cooldown with attack/cast/signature (45s); shared mana pool.
//
// Per-class branches live in this file as `useXxxAbility(payload, env, ctx,
// character, quest, fighters)` functions. The dispatcher handles the common
// pre-checks (live quest, alive character, cooldown, mana cost).
async function handleAbility(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed and can't act.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral(`You're not on an active quest. Try \`${payload.command} quest\`.`);

  const cls = classByName(character.class);
  const ability = abilityFor(character.class);
  if (!ability) return ephemeral("Your class has no active ability.");

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }
  if (character.mana < ability.mana_cost) {
    return ephemeral(
      `Out of mana — *${ability.name}* costs ${ability.mana_cost} mana, you have ${character.mana}/${character.max_mana}.`,
    );
  }

  // Most abilities require a live foe (taunt without a monster is moot).
  // Migrate is the exception — it's a positioning move usable in any combat
  // room. Foresee also requires a live monster (it reads the monster's tells).
  const needsLiveFoe = cls.id !== "backend_druid";
  if (needsLiveFoe && !hasLiveMonster(quest)) {
    return ephemeral(`*${ability.name}* needs a live foe.`);
  }

  // Dispatch by class. Each handler is responsible for deducting mana,
  // writing the ability_state buff/debuff to scene, and posting narration.
  switch (cls.id) {
    case "sre_warden":     return useTaunt(payload, env, ctx, character, quest, ability);
    case "devops_mage":    return useContainerize(payload, env, ctx, character, quest, ability);
    case "qa_paladin":     return useRegressionShield(payload, env, ctx, character, quest, ability);
    case "refactor_rogue": return useVanish(payload, env, ctx, character, quest, ability);
    case "data_warlock":   return useSoulDrain(payload, env, ctx, character, quest, ability);
    case "frontend_bard":  return useBattleHymn(payload, env, ctx, character, quest, ability);
    case "staff_sage":     return useForesee(payload, env, ctx, character, quest, ability);
    case "backend_druid":  return useMigrate(payload, args, env, ctx, character, quest, ability);
    default: return ephemeral(`Your class has no active ability wired up yet.`);
  }
}

// Patch a single field on scene.ability_state via JSON merge. Avoids racing
// other writes to scene (telegraph, monster_hp, etc.) that might be in
// flight from a parallel player action. Caller provides the partial.
async function patchAbilityState(
  db: D1Database,
  questId: number,
  partial: NonNullable<SceneJson["ability_state"]>,
  expectedMonsterHp?: number,
): Promise<void> {
  // We read-then-write rather than doing a JSON patch in SQL because nested
  // map merges (e.g. vanished[user_id] = N) need JS to combine cleanly with
  // any existing keys.
  const row = await db
    .prepare("SELECT scene_json FROM quests WHERE id = ?")
    .bind(questId)
    .first<{ scene_json: string }>();
  if (!row) return;
  const scene = JSON.parse(row.scene_json) as SceneJson;
  // Guard against the monster dying between read and our caller's intent.
  if (expectedMonsterHp !== undefined && scene.monster_hp !== expectedMonsterHp) return;
  const merged: NonNullable<SceneJson["ability_state"]> = {
    ...(scene.ability_state ?? {}),
    ...partial,
  };
  // Merge vanished maps (we want union, not replace).
  if (partial.vanished && scene.ability_state?.vanished) {
    merged.vanished = { ...scene.ability_state.vanished, ...partial.vanished };
  }
  scene.ability_state = merged;
  await db
    .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
    .bind(JSON.stringify(scene), questId)
    .run();
}

// 🛡 SRE Warden — Taunt. Locks the monster's target to the Warden for the
// next 2 swings, overriding the telegraph. Pure tank-redirect.
async function useTaunt(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const TAUNT_SWINGS = 2;
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  await patchAbilityState(env.DB, quest.id, {
    taunt: { user_id: payload.user_id, swings_remaining: TAUNT_SWINGS },
    // Overrides the telegraph immediately — next swing hits the Warden.
  });
  // Also patch the monster_telegraph to point at the Warden so the next
  // render shows the redirected target.
  await env.DB
    .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.monster_telegraph', json(?)) WHERE id = ?")
    .bind(JSON.stringify({ target_user_id: payload.user_id }), quest.id)
    .run();
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Taunt → ${TAUNT_SWINGS} swings redirected`);
  const headline = `🛡 *${ability.name}!* <@${payload.user_id}> bellows a challenge — *${quest.scene.monster_name}* locks onto them for the next ${TAUNT_SWINGS} swings.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// 🧙 DevOps Mage — Containerize. Locks the monster in stasis; it skips its
// next swing entirely.
async function useContainerize(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  const current = quest.scene.ability_state?.skip_swings ?? 0;
  await patchAbilityState(env.DB, quest.id, { skip_swings: current + 1 });
  await appendLog(env.DB, quest.id, payload.user_id, "ability", "Containerize → +1 skip");
  const headline = `🧙 *${ability.name}!* <@${payload.user_id}> wraps *${quest.scene.monster_name}* in a stasis container — it'll skip its next swing.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// ✨ QA Paladin — Regression Shield. Grants +3 shield to every alive
// partymate (including the Paladin).
async function useRegressionShield(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const SHIELD_AMOUNT = 3;
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const grants: string[] = [];
  for (const f of fighters) {
    const cap = f.max_hp * SHIELD_CAP_MULTIPLIER;
    const added = await addShield(env.DB, f, SHIELD_AMOUNT, cap);
    if (added > 0) grants.push(`<@${f.slack_user_id}> +${added}`);
  }
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Regression Shield → ${grants.length} buffed`);
  const granted = grants.length > 0 ? grants.join(", ") : "_everyone at shield cap_";
  const headline = `✨ *${ability.name}!* <@${payload.user_id}> chants a regression suite — party shields up: ${granted}.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// 🗡 Refactor Rogue — Vanish. The monster can't target the Rogue for the
// next 2 swings. If the telegraph is currently on the Rogue, it re-picks.
async function useVanish(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const VANISH_SWINGS = 2;
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  await patchAbilityState(env.DB, quest.id, {
    vanished: { [payload.user_id]: VANISH_SWINGS },
  });
  // If the current telegraph is on the Rogue, re-roll it onto someone else
  // so the immediate next swing isn't wasted on a vanished target.
  if (quest.scene.monster_telegraph?.target_user_id === payload.user_id) {
    const fighters = (await getQuestParty(env.DB, quest.id))
      .filter(isFighter)
      .filter((f) => f.slack_user_id !== payload.user_id);
    if (fighters.length > 0) {
      const reroll = pickMonsterTarget(fighters, Math.random);
      await env.DB
        .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.monster_telegraph', json(?)) WHERE id = ?")
        .bind(JSON.stringify({ target_user_id: reroll.slack_user_id }), quest.id)
        .run();
    }
  }
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Vanish → ${VANISH_SWINGS} swings untargetable`);
  const headline = `🗡 *${ability.name}!* <@${payload.user_id}> melts into the shadows — *${quest.scene.monster_name}* can't target them for the next ${VANISH_SWINGS} swings.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// 💀 Data Warlock — Soul Drain. Deal 1d6+magic damage and heal yourself for
// 50% of the damage dealt. Vampiric self-sustain.
async function useSoulDrain(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const cls = classByName(character.class);
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  const abilitySnap = statSnapshot({
    className: character.class,
    level: character.level,
    stats: { str: character.str, int_stat: character.int_stat, vit: character.vit, agi: character.agi, dex: character.dex },
    v2Enabled: env.STATS_V2 === "1",
  });
  const abilityMagicMod = abilitySnap.derived.magic_mod + (env.STATS_V2 === "1" ? 0 : Math.floor(character.level / 4));
  // Damage = 1d6 + magic_mod. Capped at monster_hp - 1 so this never delivers
  // the kill blow (matches the damage-tool pattern); follow-up attack closes it.
  const roll = rollDice(6);
  const rawDamage = roll + abilityMagicMod;
  const damage = Math.min(rawDamage, Math.max(1, quest.scene.monster_hp - 1));
  const heal = Math.floor(damage / 2);
  // Atomic monster HP write conditional on prior monster_hp.
  const won = await tryUpdateScene(env.DB, quest.id, {
    ...quest.scene,
    monster_hp: Math.max(0, quest.scene.monster_hp - damage),
  }, quest.scene.monster_hp);
  if (!won) {
    // Race-loser: refund mana so the Warlock isn't penalized for losing the race.
    await addMana(env.DB, character, ability.mana_cost);
    return ephemeral("The fight moved on — your mana was refunded.");
  }
  const healed = await healCharacter(env.DB, character, heal);
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Soul Drain → ${damage} dmg, +${healed} HP`);
  const headline = `💀 *${ability.name}!* <@${payload.user_id}> rips life-essence from *${quest.scene.monster_name}* — *${damage}* damage, *+${healed}* HP \`${roll} + ${abilityMagicMod}m, half drained\`.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// 🎵 Frontend Bard — Battle Hymn. The bardic aura jumps from +1 to +3
// damage for the next 2 partymate attacks.
async function useBattleHymn(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const HYMN_USES = 2;
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  const current = quest.scene.ability_state?.battle_hymn ?? 0;
  await patchAbilityState(env.DB, quest.id, { battle_hymn: current + HYMN_USES });
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Battle Hymn → +${HYMN_USES} hymn-charged attacks`);
  const headline = `🎵 *${ability.name}!* <@${payload.user_id}> strikes a heroic chord — the next *${HYMN_USES}* partymate attacks deal *+3* damage instead of +1.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

// 📜 Staff Sage — Foresee. Reveal the current AND speculative next-next
// Shared intel body for Foresee — called on cast and on each subsequent
// turn while foresee_turns > 0. Returns the multi-line readout string so
// useForesee and appendForeseeIfActive can both call it without duplicating
// the damage / triage logic.
async function buildForeseeText(
  env: Env,
  quest: ActiveQuest,
  header: string,
): Promise<string> {
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const tier = quest.scene.tier;
  const partyBonus = Math.floor((Math.max(1, fighters.length) - 1) / 2);
  const isBossP2 = quest.scene.variant === "boss" && quest.scene.boss_phase === 2;
  const bossBonus = isBossP2 ? tier : 0;
  const rawLo = 1 + tier + partyBonus + bossBonus;
  const rawHi = 4 + tier + partyBonus + bossBonus;
  const abilityState = quest.scene.ability_state ?? {};

  const targetId = quest.scene.monster_telegraph?.target_user_id;
  const target = targetId ? fighters.find((f) => f.slack_user_id === targetId) : null;

  const lines: string[] = [header];

  if (target) {
    const targetItems = await getInventory(env.DB, target.slack_user_id);
    const targetArmor = targetItems.find((i) => i.item_type === "armor" && i.equipped);
    const armorPower = targetArmor?.power ?? 0;
    const armorReduction = Math.floor(armorPower / 2);
    const isBack = target.position === "back";
    const netLo = isBack
      ? Math.max(1, Math.round((rawLo - armorReduction) * 0.6))
      : Math.max(1, rawLo - armorReduction);
    const netHi = isBack
      ? Math.max(1, Math.round((rawHi - armorReduction) * 0.6))
      : Math.max(1, rawHi - armorReduction);
    const survives = target.hp > netHi;
    const verdict = survives
      ? `✅ survives worst-case`
      : target.hp <= netLo
        ? `💀 *cannot survive* even min hit`
        : `⚠️ *at risk* — worst case could down them`;
    const armorNote = armorReduction > 0 ? ` (−${armorReduction} armor)` : "";
    const posNote = isBack ? ` ×0.6 back-row` : "";
    lines.push(
      `\n🎯 *Next swing:* <@${targetId}> _(${target.position}-row, ${target.hp}/${target.max_hp} HP)_`,
      `   Raw: *${rawLo}–${rawHi}*${armorNote}${posNote} → net *${netLo}–${netHi}* HP`,
      `   ${verdict}`,
    );
  } else {
    lines.push(`\n🎯 *Next swing:* no committed target yet — random pick next swing.`);
  }

  if (fighters.length > 1) {
    const vanishedMap = abilityState.vanished ?? {};
    const targetable = fighters.filter((f) => (vanishedMap[f.slack_user_id] ?? 0) <= 0);
    const weights = targetable.map((f) => (f.position === "back" ? 1 : 3));
    const total = weights.reduce((a, b) => a + b, 0);
    const probLines = targetable.map((f, i) => {
      const pct = Math.round((weights[i] / total) * 100);
      return `<@${f.slack_user_id}> ${f.position} ${pct}%`;
    });
    lines.push(`\n🔮 *Next swing odds:* ${probLines.join("  ·  ")}`);
    const vanished = Object.entries(vanishedMap).filter(([, v]) => (v as number) > 0);
    if (vanished.length > 0) {
      lines.push(`   _(${vanished.map(([id]) => `<@${id}> vanished`).join(", ")} — excluded from pool)_`);
    }
  }

  lines.push(`\n💉 *Party triage:*`);
  for (const f of fighters) {
    const hpPct = f.max_hp > 0 ? f.hp / f.max_hp : 1;
    const bar = hpPct >= 0.66 ? "🟩" : hpPct >= 0.33 ? "🟨" : "🟥";
    const shieldNote = f.shield > 0 ? ` +${f.shield}🛡` : "";
    lines.push(`   ${bar} <@${f.slack_user_id}> *${f.hp}/${f.max_hp}*${shieldNote} _(${f.position})_`);
  }

  const stateNotes: string[] = [];
  const skipSwings = abilityState.skip_swings ?? 0;
  if (skipSwings > 0) stateNotes.push(`⏸ Containerize: ${skipSwings} swing(s) remaining`);
  const taunt = abilityState.taunt;
  if (taunt && (taunt.swings_remaining ?? 0) > 0) stateNotes.push(`🛡 Taunt: <@${taunt.user_id}> drawing fire (${taunt.swings_remaining} left)`);
  if (stateNotes.length > 0) lines.push(`\n⚙️ *Active effects:* ${stateNotes.join("  ·  ")}`);

  return lines.join("\n");
}

// Full battle-intelligence readout for the Staff Sage. Costs 1 mana and
// persists for 2 more of the Sage's own combat turns (foresee_turns in
// ability_state). Each subsequent turn re-runs the readout against fresh
// quest state so the intel stays current after each monster swing.
async function useForesee(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");

  await patchAbilityState(env.DB, quest.id, { foresee_turns: 2 });
  await appendLog(env.DB, quest.id, payload.user_id, "ability", "Foresee");

  const header = `📜 *${ability.name}!* <@${payload.user_id}> reads *${quest.scene.monster_name}*'s tells:`;
  const text = await buildForeseeText(env, quest, header);
  return ephemeral(text);
}

// Called after every combat action the Sage takes. If foresee_turns > 0,
// re-runs the intel readout against current quest state (telegraph will have
// updated since the cast) and appends it to the Sage's ephemeral response.
// Decrements the counter; clears the key when it hits zero.
async function appendForeseeIfActive(
  response: CommandResponse,
  env: Env,
  userId: string,
): Promise<CommandResponse> {
  const quest = await getActiveQuestForCharacter(env.DB, userId);
  if (!quest) return response;
  const turns = quest.scene.ability_state?.foresee_turns ?? 0;
  if (turns <= 0) return response;

  const remaining = turns - 1;
  // patchAbilityState serialises via JSON.stringify, so undefined drops the key.
  await patchAbilityState(env.DB, quest.id, { foresee_turns: remaining > 0 ? remaining : undefined });

  // Re-fetch so triage and telegraph reflect post-action state.
  const freshQuest = await getActiveQuestForCharacter(env.DB, userId);
  if (!freshQuest) return response;

  const turnsNote = remaining > 0 ? ` _(${remaining} turn${remaining === 1 ? "" : "s"} remaining)_` : ` _(Foresee fades)_`;
  const header = `📜 *Foresee* — *${freshQuest.scene.monster_name}* intel update:${turnsNote}`;
  const foreseeText = await buildForeseeText(env, freshQuest, header);

  const existing = "text" in response ? (response.text ?? "") : "";
  return ephemeral(`${existing}\n\n${foreseeText}`);
}

// 🌿 Backend Druid — Migrate. Move any partymate (including self) to
// front or back without consuming their turn. Usable in combat or between.
async function useMigrate(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
  character: Character,
  quest: ActiveQuest,
  ability: { name: string; mana_cost: number },
): Promise<CommandResponse> {
  // args layout: [target_mention_or_self, position]
  // Usage: /sq ability @user front  OR  /sq ability self back
  const rawTarget = (args[0] ?? "").trim();
  const rawPosition = (args[1] ?? "").toLowerCase().trim();
  const targetId = rawTarget && rawTarget.toLowerCase() !== "self"
    ? parseMention(rawTarget)
    : payload.user_id;
  if (!targetId) {
    return ephemeral(
      `Usage: \`${payload.command} ability @user front|back\` (or use \`self\` for yourself).`,
    );
  }
  if (rawPosition !== "front" && rawPosition !== "back") {
    return ephemeral(`Position must be \`front\` or \`back\`.`);
  }
  const target = await getCharacter(env.DB, targetId);
  if (!target) return ephemeral("That player hasn't rolled a character.");
  const targetQuest = await getActiveQuestForCharacter(env.DB, targetId);
  if (!targetQuest || targetQuest.id !== quest.id) {
    return ephemeral("They're not on your quest.");
  }
  if (target.position === rawPosition) {
    return ephemeral(`*${target.name}* is already in the ${rawPosition} row.`);
  }
  const ok = await tryDeductMana(env.DB, payload.user_id, ability.mana_cost);
  if (!ok) return ephemeral("Couldn't deduct mana — try again.");
  await setPosition(env.DB, targetId, rawPosition);
  await appendLog(env.DB, quest.id, payload.user_id, "ability", `Migrate → ${target.name} to ${rawPosition}`);
  const headline = `🌿 *${ability.name}!* <@${payload.user_id}> shifts <@${targetId}> to the *${rawPosition}* row — vines guide them past the fray.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(headline)));
  return ephemeral(headline);
}

async function handleShield(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed and can't act.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  // Compute armor pool max from equipped armor.
  const slots = await getAllEquippedSlots(env.DB, payload.user_id);
  const equippedArmor = slots.body ?? slots.off_hand;
  const armorMax = Math.floor((equippedArmor?.power ?? 0) / 2);

  if (armorMax === 0) {
    return ephemeral("You have no armor equipped — nothing to replenish. Equip armor to use this action.");
  }
  if (character.shield >= armorMax) {
    return ephemeral(`🛡️ Your armor is already at full (${character.shield}/${armorMax}).`);
  }

  await initArmorPool(env.DB, payload.user_id);
  await appendLog(env.DB, quest.id, payload.user_id, "shield", `armor → ${armorMax}`);

  const text = `🛡️ *${character.name}* braces and fortifies their armor — restored to *${armorMax}* (physical attacks only). Magic bypasses it.`;
  ctx.waitUntil(postToThread(env, quest, blockQuote(text)));
  return ephemeral(text);
}

async function handleHeal(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed and can't act.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }
  if (character.mana < 1) {
    return ephemeral(`Out of mana. Mana refills between quests. (${character.mana}/${character.max_mana})`);
  }

  const resolved = await resolveSupportTarget(env, character, quest, args);
  if ("error" in resolved) return ephemeral(resolved.error);
  const { target } = resolved;
  if (!isFighter(target)) {
    return ephemeral(`*${target.name}* is downed — needs \`${payload.command} revive <id> @${target.name}\` (with a revive item) instead.`);
  }
  if (target.hp >= target.max_hp) {
    return ephemeral(`*${target.name}* is already at full HP.`);
  }

  const cls = classByName(character.class);
  const healSlots = await getAllEquippedSlots(env.DB, payload.user_id);
  const healEquipBonuses: Partial<Record<string, number>> = {};
  if (env.STATS_V2 === "1") {
    for (const item of Object.values(healSlots)) {
      if (!item?.stat_bonus) continue;
      for (const [key, val] of Object.entries(item.stat_bonus)) {
        healEquipBonuses[key] = (healEquipBonuses[key] ?? 0) + val;
      }
    }
  }
  const healSnap = statSnapshot({
    className: character.class,
    level: character.level,
    stats: { str: character.str, int_stat: character.int_stat, vit: character.vit, agi: character.agi, dex: character.dex },
    v2Enabled: env.STATS_V2 === "1",
    equipBonuses: env.STATS_V2 === "1" ? (healEquipBonuses as Partial<Stats>) : undefined,
  });
  const healMagicMod = healSnap.derived.magic_mod + (env.STATS_V2 === "1" ? 0 : Math.floor(character.level / 4));
  const heal = resolveHeal(healMagicMod, rollDice);
  // 🔮 Focus weapons add their power as a flat bonus to heal amount.
  // Caster's existing 1d6 + magic_mod becomes 1d6 + magic_mod + focus.power.
  const focusWeapon = healSlots.main_hand;
  const focusBonus = (focusWeapon?.weapon_range === "focus") ? focusWeapon.power : 0;
  const finalHealAmount = heal.amount + focusBonus;
  const healed = await healCharacter(env.DB, target, finalHealAmount);
  await tryDeductMana(env.DB, payload.user_id, 1);
  await appendLog(env.DB, quest.id, payload.user_id, "heal", `+${healed} HP → ${target.name}`);

  const targetTag = target.slack_user_id === payload.user_id
    ? `themselves`
    : `<@${target.slack_user_id}>`;
  // Display includes the focus bonus in the math breakdown so players see
  // where the extra HP came from. Without focus, the line reads the same
  // as before.
  const focusBreakdown = focusBonus > 0 ? ` + ${focusBonus}🔮` : "";
  const healLine = `💚 <@${payload.user_id}> heals ${targetTag} for *${healed}* HP \`${heal.roll} + ${healMagicMod}m${focusBreakdown}\`.`;

  // Tick the caster's status effects — heal is a combat-tier action so it should
  // tick effects just like attack/cast. The actor's tick (regen/bleed/burn) fires
  // on their own action.
  const casterTick = await applyPlayerTick(env, payload.user_id, character);
  const tickLines = casterTick.tickLines;
  if (casterTick.postTickHp <= 0) {
    const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
    return resolveDeath(payload, env, ctx, character, quest, fighters, [healLine, ...tickLines]);
  }

  // Heal is a support action — consistent with /sq revive, it does NOT trigger
  // a monster counter-attack. The costs (1 mana, 45s combat cooldown, your
  // offensive turn skipped) are sufficient. Earlier behavior had the monster
  // retaliate, which made heal a net wash: heal 5 HP → take 5 HP back. Players
  // correctly identified this as a waste of mana. Now heal is a true safety
  // net: pay the mana, give up your offensive turn, restore HP cleanly.
  const healStat = `*${target.name}*: ${target.hp + healed}/${target.max_hp}`;
  const lines = [healLine, ...tickLines, healStat];
  ctx.waitUntil(postToThread(env, quest, [blockQuote(healLine), "", ...tickLines, healStat].join("\n")));
  return ephemeral(lines.join("\n"));
}

async function handleRevive(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) return ephemeral("You're downed yourself — can't revive anyone.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");

  // Cooldown applies — revive is a combat-tier action.
  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, await actionCooldownMs(env.DB, quest.id));
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  const itemId = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(itemId)) {
    return ephemeral(`Usage: \`${payload.command} revive <inventory id> @user\`.`);
  }

  const targetId = parseMention(args.slice(1).join(" "));
  if (!targetId) {
    return ephemeral(`Need a target — \`${payload.command} revive ${itemId} @user\`.`);
  }
  if (targetId === payload.user_id) {
    return ephemeral("You can't revive yourself — find a partymate.");
  }

  const item = await getItem(env.DB, itemId, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.item_type !== "revive") {
    return ephemeral(`*${item.item_name}* isn't a revive item.`);
  }

  const target = await getCharacter(env.DB, targetId);
  if (!target) return ephemeral("Target hasn't rolled a character.");
  if (!target.downed_until || target.downed_until <= Date.now()) {
    return ephemeral(`*${target.name}* isn't downed.`);
  }

  // Same active quest only (downed character is still on quest_party).
  const targetQuest = await getActiveQuestForCharacter(env.DB, targetId);
  if (!targetQuest || targetQuest.id !== quest.id) {
    return ephemeral(`*${target.name}* isn't on your quest.`);
  }

  const restoredHp = await reviveCharacter(env.DB, target, item.power);
  await removeItem(env.DB, item.id);
  // Don't deduct mana — the item itself is the gate.
  await appendLog(env.DB, quest.id, payload.user_id, "revive", `${item.item_name} → ${target.name}`);

  const headline = `🌱 <@${payload.user_id}> uses *${item.item_name}* — <@${target.slack_user_id}> stirs and rejoins the fight.`;
  const stat = `*${target.name}*: ${restoredHp}/${target.max_hp}`;
  const ephem = `${headline}\n${stat}`;
  // Mid-quest support action — stays in-thread.
  ctx.waitUntil(postToThread(env, quest, `${blockQuote(headline)}\n\n${stat}`));
  return ephemeral(ephem);
}

// Renders a millisecond duration as a human-friendly cooldown string.
// e.g. 6500 → "7s", 90_000 → "1m 30s", 8_640_000 → "2h 24m".
function formatCooldown(ms: number): string {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return s > 0 ? `${totalMin}m ${s}s` : `${totalMin}m`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Between-quest HP restore. Two flavors:
async function handleNotifyPref(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const pref = args[0]?.toLowerCase();
  if (pref !== "dm" && pref !== "thread") {
    return ephemeral(
      `Usage: \`${payload.command} notify dm\` or \`${payload.command} notify thread\`\nDefault is \`thread\` — your turn posts a broadcast in the quest channel. Switch to \`dm\` to receive a direct message instead.`,
    );
  }
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  await setNotificationPref(env.DB, payload.user_id, pref);
  const label = pref === "dm" ? "direct messages" : "channel broadcasts";
  return ephemeral(`✅ Turn notifications set to *${label}*.`);
}

//   short (default) — heals 50% of missing HP, 10-minute cooldown
//   long             — full HP restore, once per 24 hours
async function handleRest(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  if (character.downed_until && character.downed_until > Date.now()) {
    return ephemeral("You're downed and recovering — wait the 12h cooldown.");
  }

  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  const isLong = args[0]?.toLowerCase() === "long";

  if (activeQuest) {
    // Long rest is always blocked mid-quest — too generous, would nullify attrition.
    if (isLong) {
      return ephemeral(`Long rests only happen between quests. Try \`${payload.command} rest\` for a short one.`);
    }
    // Short rest mid-quest is allowed in dungeons, but only between rooms (not
    // mid-combat). "Between" = pending door pick, current room is non-combat,
    // or the combat in this room is already resolved (monster_hp <= 0).
    if (!canRestBetweenRooms(activeQuest)) {
      return ephemeral(
        `Can't rest mid-fight. Try \`${payload.command} use <id>\` for a consumable, or \`${payload.command} heal\` if you have mana.`,
      );
    }
  }

  if (character.hp >= character.max_hp && character.mana >= character.max_mana) {
    return ephemeral("Already at full HP and mana — save the rest for when you need it.");
  }

  if (isLong) {
    const since = character.last_long_rest_at == null
      ? Infinity
      : Date.now() - character.last_long_rest_at;
    if (since < LONG_REST_COOLDOWN_MS) {
      return ephemeral(
        `🛌 You've already taken your daily long rest — next one in ${formatCooldown(LONG_REST_COOLDOWN_MS - since)}.`,
      );
    }
    await applyLongRest(env.DB, payload.user_id);
    return ephemeral(
      `🛌 You take a long rest. HP fully restored to *${character.max_hp}/${character.max_hp}*. Next long rest available in 24h.`,
    );
  }

  // Short rest path.
  const since = character.last_rest_at == null
    ? Infinity
    : Date.now() - character.last_rest_at;
  if (since < SHORT_REST_COOLDOWN_MS) {
    return ephemeral(
      `🛏️ You're still catching your breath — next short rest in ${formatCooldown(SHORT_REST_COOLDOWN_MS - since)}.`,
    );
  }

  const missing = character.max_hp - character.hp;
  const healed = Math.max(1, Math.floor(missing * SHORT_REST_HEAL_RATIO));
  const newHp = Math.min(character.max_hp, character.hp + healed);
  await applyShortRest(env.DB, payload.user_id, newHp);
  return ephemeral(
    `🛏️ You take a short rest. Recovered *${healed}* HP (${newHp}/${character.max_hp}). For a full heal, try \`${payload.command} rest long\` (1× per 24h).`,
  );
}

async function handlePosition(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const target = args[0]?.toLowerCase();
  if (target !== "front" && target !== "back") {
    return ephemeral(
      `Usage: \`${payload.command} position front|back\`. Currently in *${character.position}* row.\n` +
      `_Front: 3× more likely to be targeted, takes full damage. Back: less hit risk, 60% damage taken when hit, can't melee._`,
    );
  }

  if (character.position === target) {
    return ephemeral(`You're already in *${target}* row.`);
  }

  // In-quest repositioning consumes the combat cooldown — moving up or back is
  // a real action, not a free swap. Outside a quest it's free preparation.
  const activeQuest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (activeQuest) {
    const cd = await cooldownRemaining(env.DB, activeQuest.id, payload.user_id, await actionCooldownMs(env.DB, activeQuest.id));
    if (cd > 0) {
      return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cd / 1000)}s.`);
    }
    await setPosition(env.DB, payload.user_id, target as BattlePosition);
    await appendLog(env.DB, activeQuest.id, payload.user_id, "position", `→ ${target}`);
    const headline = target === "front"
      ? `🔼 <@${payload.user_id}> shoulders forward to *front* row.`
      : `🔽 <@${payload.user_id}> retreats to *back* row.`;
    // Post to the quest thread so the rest of the party sees the formation change —
    // it affects monster targeting weights, so it's gameplay-relevant.
    ctx.waitUntil(postToThread(env, activeQuest, blockQuote(headline)));
    return ephemeral(`${headline} _(Cooldown set, 45s.)_`);
  }

  // Out-of-quest reposition — free, no cooldown, ephemeral only (no thread to post to).
  await setPosition(env.DB, payload.user_id, target as BattlePosition);
  return ephemeral(
    target === "front"
      ? `🔼 You move to *front* row — you'll soak more hits, but take full damage.`
      : `🔽 You move to *back* row — harder to hit, take 60% damage when hit, can't melee.`,
  );
}

async function handleLeaderboard(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const top = await getLeaderboard(env.DB, 10);
  if (top.length === 0) return ephemeral(`No heroes yet. Be the first — \`${payload.command} roll\`.`);
  const lines = [
    "*🏆 Top heroes*",
    ...top.map((e, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const scars = e.scars_count > 0 ? ` • ${e.scars_count} scar${e.scars_count > 1 ? "s" : ""}` : "";
      return `${medal} *${e.name}* the ${e.class} — L${e.level}, ${e.xp} XP, ${e.gold}g${scars}`;
    }),
  ];
  return inChannel(lines.join("\n"));
}

// Posts a message into the quest thread. With { broadcast: true }, Slack also surfaces
// the message at the channel top-level so spectators see it without clicking into the
// thread. Use broadcast for "big beats" only — joins, phase transitions, perma-death,
// gauntlet wave changes, victories — to keep the channel from drowning in combat lines.
//
// `blocks` (optional) lets callers send Block Kit JSON for richer layouts. The `text`
// arg becomes the notification fallback. Most callers should pass plain text; combat
// uses blocks for the party-card grid.
async function postToThread(
  env: Env,
  quest: ActiveQuest,
  text: string,
  options?: { broadcast?: boolean; blocks?: unknown[] },
): Promise<void> {
  const res = await postMessage(env.SLACK_BOT_TOKEN, {
    channel: quest.channel_id,
    thread_ts: quest.thread_ts,
    text,
    blocks: options?.blocks,
    reply_broadcast: options?.broadcast,
  });
  if (!res.ok) {
    // Don't fail the command — the player still got an ephemeral copy.
    console.warn("postToThread failed", res.error);
  }
}

// Renders the power value in user-facing terms based on item type.
// Used by inventory, shop, treasure room, and victory loot lines.
// Compact mechanics summary for the inventory/shop/merchant rows. Catalog items
// (tool/scroll) have varying effect kinds — Caffeine Bomb deals damage,
// Espresso Shot heals via regen, Poison Vial applies a status — so a flat
// "X dmg" label was actively misleading. We pass the item NAME through to
// Formats a stat_bonus entry for display. Handles resist_* keys specially.
function formatStatBonusEntry(key: string, val: number): string {
  if (key.startsWith("resist_")) {
    const dtype = key.slice("resist_".length);
    const emoji = DAMAGE_TYPE_EMOJI[dtype as DamageType] ?? "";
    const name = dtype.charAt(0).toUpperCase() + dtype.slice(1);
    return `${emoji} ${name} Res ${val}%`;
  }
  return `+${val} ${key === "int_stat" ? "INT" : key.toUpperCase()}`;
}

// pick the right unit per catalog entry. Non-catalog tools/scrolls fall back
// to a generic "power N" label.
function powerLabel(itemType: Item["item_type"], power: number, itemName?: string): string {
  if (itemType === "consumable") return `heals ${power}`;
  if (itemType === "magic") return `+${power} max mana`;
  if (itemType === "revive") return `revives @ ${power}% HP`;
  if (itemType === "tool" || itemType === "scroll") {
    // Catalog-aware label — pick the unit based on what the named effect does.
    // Each catalog item is uniquely named so name-keyed dispatch is fine.
    if (itemName) {
      const unit = catalogPowerUnit(itemName);
      if (unit) return `${power} ${unit}`;
    }
    if (itemType === "tool") return `power ${power}`;
    return power > 0 ? `+${power}` : "ritual";
  }
  return `+${power}`;
}

// Resolves the unit text for a catalog item's power value. Returns null when
// the item isn't in the catalog (drives the fallback path in powerLabel).
//
// Hand-curated rather than parsed from the blurb — the blurb is for humans,
// the unit is for the row label and needs to be tight.
function catalogPowerUnit(itemName: string): string | null {
  switch (itemName) {
    case "Caffeine Bomb":      return "dmg";
    case "Hotfix Grenade":     return "AOE dmg";
    case "Rebase Scroll":      return null;       // fixed effect, ignore power
    case "Production Outage":  return "% boss HP";
    case "Espresso Shot":      return "HP/tick × 5";
    case "Poison Vial":        return "poison/tick × 4";
    case "Venom Vial":         return "poison/tick × 4";
    case "Regen Draft":        return "HP/tick × 3";
    case "Battle Elixir":      return "+25% dmg × 3";
    default:                   return null;
  }
}

// Merchants charge the same flat shop price as the channel-shared shop. No
// markup — they're convenient, but not predatory.
function merchantPrice(type: Parameters<typeof priceFor>[0], rarity: Parameters<typeof priceFor>[1]): number {
  return priceFor(type, rarity);
}

// For catalog items (tool / scroll), returns a short *Effect:* line describing
// what the item does mechanically. Empty string for non-catalog items.
function catalogEffectLine(itemName: string): string {
  const entry = findCatalogEntry(itemName);
  if (!entry) return "";
  return `💡 *Effect:* ${entry.blurb}`;
}

// Compact range badge for weapons; empty for non-weapons.
//   ⚔️ melee · 🏹 ranged · 🔮 focus (caster/support — no damage bonus,
//   boosts heal/shield, +1 max mana while equipped)
function rangeBadge(item: { item_type: Item["item_type"]; weapon_range?: Item["weapon_range"] | null }): string {
  if (item.item_type !== "weapon") return "";
  const range = item.weapon_range ?? "melee";
  if (range === "ranged") return " 🏹";
  if (range === "focus") return " 🔮";
  return " ⚔️";
}

// Single source of truth for the position emoji. Directional (🔼 forward / 🔽 back)
// so it never collides with weapon-range badges (⚔️ melee / 🏹 ranged) — a front-row
// player with a ranged weapon now reads cleanly as 🔼 + 🏹 instead of ⚔️ + 🏹.
function positionEmoji(p: BattlePosition): string {
  return p === "back" ? "🔽" : "🔼";
}

// Wraps multi-line narration in Slack's block-quote prefix so the story text gets the
// vertical bar treatment and reads as visually distinct from the stat block below.
function blockQuote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}

// One party member's compact stat fragment. Downed members show as a skull instead
// of HP. Active shield buffer renders as 🛡N.
function formatPartyMember(c: Character): string {
  if (!isFighter(c)) return `*${c.name}* 💀`;
  const shieldPart = c.shield > 0 ? ` 🛡${c.shield}` : "";
  return `*${c.name}* ${c.hp}/${c.max_hp}${shieldPart}`;
}

function formatPartyLine(party: Character[]): string {
  return `*Party* — ${party.map(formatPartyMember).join(" • ")}`;
}

// Monster line with the boss phase 2 marker if active.
function formatMonsterLine(scene: SceneJson, currentHp: number): string {
  const phase = scene.variant === "boss" && scene.boss_phase === 2 ? " 👑 *P2*" : "";
  const effectsTag = effectsBadge(scene.monster_effects);
  const effectsPart = effectsTag ? ` ${effectsTag}` : "";
  return `*${scene.monster_name}*${phase}${effectsPart} — ${Math.max(0, currentHp)}/${scene.monster_max_hp}`;
}

// One character's compact stat card for Block Kit fields. Downed members render as
// a skull. Active shield/mana are appended only if present so the card stays terse.
// Position emoji is part of the name line so spectators see at a glance who's
// front-line vs back-line.
function characterField(c: Character): { type: "mrkdwn"; text: string } {
  const stat = isFighter(c)
    ? [
        `${c.hp}/${c.max_hp} ❤️`,
        c.shield > 0 ? `🛡${c.shield}` : "",
        c.max_mana > 0 ? `✨${c.mana}/${c.max_mana}` : "",
      ].filter(Boolean).join("  ")
    : "💀 _downed_";
  return {
    type: "mrkdwn",
    text: `${positionEmoji(c.position)} *${c.name}*\n${stat}`,
  };
}

function monsterField(scene: SceneJson, currentHp: number): { type: "mrkdwn"; text: string } {
  const phase = scene.variant === "boss" && scene.boss_phase === 2 ? " 👑" : "";
  // Mark indicator on the monster card so attackers see the focus-fire is
  // live. We don't show who called it (the headline post already does);
  // the 🎯 is just the at-a-glance hint that party hits get +bonus.
  const mark = getActiveMark(scene);
  const markBadge = mark ? " 🎯" : "";
  return {
    type: "mrkdwn",
    text: `*${scene.monster_name}*${phase}${markBadge}\n${Math.max(0, currentHp)}/${scene.monster_max_hp} 🩸`,
  };
}

// Builds the Block Kit blocks for a combat-result thread post. Renders as:
//   1. Narration section (block-quoted markdown — the AI's prose)
//   2. Player events section (player line + passive triggers + tick lines)
//   3. Monster events section (the counter-swing) — visually separated by a
//      divider so the player's action and the monster's response don't blur
//      into the same wall of text
//   4. Two-card grid (monster, actor) — current state of the participants
//   5. Telegraph context (who the monster is locked on for next round)
//
// Events are intentionally separate from narration: the AI doesn't include
// numbers (we tell it not to), so the events sections are where the dice
// math lives.
function buildCombatBlocks(opts: {
  narration: string;
  // Player-side events: passives that fired, the player's hit line, any
  // status-effect ticks the player's action triggered. Rendered as one
  // section visually grouped above the monster's response.
  playerEvents?: string[];
  // Monster-side event: the counter-swing line. Rendered as its own section
  // with a leading ↩️ so it's unambiguous which side hit whom. Pass null
  // when the monster didn't swing (e.g. free-action tools).
  monsterEvent?: string | null;
  // Legacy single-events list — only used by call sites that haven't been
  // migrated to playerEvents/monsterEvent yet. Renders as one section.
  events?: string[];
  scene: SceneJson;
  monsterHp: number;
  actor: Character;
  // Optional second character card for the monster's hit target when it differs
  // from the actor. Without this, multi-party combat thread posts only showed
  // the actor's HP — the partymate who actually got hit didn't appear.
  target?: Character | null;
}): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(opts.narration) } },
    { type: "divider" },
  ];
  // Preferred path: split player + monster events with a divider between so
  // the eye can scan "what I did" then "what hit me back" as distinct beats.
  if (opts.playerEvents !== undefined || opts.monsterEvent !== undefined) {
    if (opts.playerEvents && opts.playerEvents.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: opts.playerEvents.join("\n") },
      });
    }
    if (opts.monsterEvent) {
      // Divider only when BOTH halves are present — avoids a stray separator
      // above a lone monster-only or player-only block.
      if (opts.playerEvents && opts.playerEvents.length > 0) {
        blocks.push({ type: "divider" });
      }
      blocks.push({
        type: "section",
        // ↩️ prefix marks the monster's counter explicitly so it doesn't
        // get mistaken for another player line in a long thread scroll.
        text: { type: "mrkdwn", text: `↩️ ${opts.monsterEvent}` },
      });
    }
    blocks.push({ type: "divider" });
  } else if (opts.events && opts.events.length > 0) {
    // Legacy single-list rendering for callers still on the old API.
    blocks.push({ type: "section", text: { type: "mrkdwn", text: opts.events.join("\n") } });
    blocks.push({ type: "divider" });
  }
  const fields = [monsterField(opts.scene, opts.monsterHp), characterField(opts.actor)];
  if (opts.target && opts.target.slack_user_id !== opts.actor.slack_user_id) {
    fields.push(characterField(opts.target));
  }
  blocks.push({ type: "section", fields });
  // Telegraph the monster's next target so the party can react before the
  // next swing lands. Rendered as a context block under the stat grid —
  // small, unobtrusive, but clear about who's about to get hit.
  //
  // 📜 Staff Sage passive: when the viewer's class is Staff Sage, the
  // telegraph includes an estimated damage range so the Sage can advise
  // whether the party needs to heal/shield up or just absorb. Others see
  // just the target. Modeled as "reading the monster's tells."
  if (opts.monsterHp > 0 && opts.scene.monster_telegraph?.target_user_id) {
    const viewerIsSage = classByName(opts.actor.class).id === "staff_sage";
    const baseText = `🎯 *${opts.scene.monster_name}* is winding up — locked on <@${opts.scene.monster_telegraph.target_user_id}> next round. _Heal or shield them before they swing._`;
    let text = baseText;
    if (viewerIsSage) {
      // Estimate the incoming hit's range. Same formula performMonsterTurn
      // uses — pre-armor damage is roughly 1d6 + tier modifier; armor will
      // reduce. We show the unadjusted range as the Sage's "tell."
      const tier = opts.scene.tier;
      const low = 1 + tier;
      const high = 6 + tier;
      text = `${baseText}\n📜 *Sage's reading:* estimated *${low}-${high}* HP swing.`;
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text }],
    });
  }
  return blocks;
}

interface MonsterTurnOutcome {
  target: Character;
  victimWasActor: boolean;
  monsterLine: string;          // formatted line for events section
  dmg: { newShield: number; newHp: number; shieldAbsorbed: number; hpDamage: number };
  positionAdjusted: number;     // damage after position modifier (pre-shield)
  willKillTarget: boolean;
  // True when the monster's swing was suppressed by an active ability
  // (DevOps Mage Containerize). Callers should skip the DB write that
  // persists the target's new HP/shield and treat this as a no-op turn.
  // The monsterLine still describes the fizzle so the thread reads coherently.
  skipped?: boolean;
  // Set when this is a boss AoE splash (hits the whole party).
  isSplash?: boolean;
  splashTargets?: Array<{
    fighter: Character;
    dmg: { newShield: number; newHp: number; shieldAbsorbed: number; hpDamage: number };
    positionAdjusted: number;
    willKill: boolean;
  }>;
}

// Picks the next monster target and stores it on scene.monster_telegraph so
// the party can see who's about to be hit and react (heal/shield/reposition).
// Called from every "monster swing landed" path. Computes the post-hit
// fighter list (target's new HP/shield applied, downed members filtered out)
// so the next-target RNG works against the actual live set.
//
// Uses a direct json_set patch (like patchMonsterArtUrl) to avoid the race
// where another player attacks in between scene reads — we're only setting
// one field, the rest of the scene is fine as-is.
// Refills mana for every alive partymate on a quest by the given amount,
// capped at each player's max_mana. Silent — no message, no log; the new
// mana shows up on the next stat-card render. Used for between-room regen
// in dungeons so the party gets a small recharge before each new fight.
//
// Per-player addMana calls are serial rather than parallel — D1 batches
// poorly across short writes, and the party is rarely >5 people so the
// extra round-trips are cheap. Atomic correctness isn't critical here:
// regen is a non-conflicting INCREMENT on independent rows.
async function regenPartyMana(
  db: D1Database,
  questId: number,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  const fighters = (await getQuestParty(db, questId)).filter(isFighter);
  for (const f of fighters) {
    if (f.mana < f.max_mana) {
      await addMana(db, f, amount);
    }
  }
}

async function persistNextTelegraph(
  env: Env,
  quest: ActiveQuest,
  fightersAtTurnStart: Character[],
  turn: MonsterTurnOutcome,
): Promise<string | null> {
  const postTurnFighters = fightersAtTurnStart
    .map((f) => f.slack_user_id === turn.target.slack_user_id
      ? { ...f, hp: turn.dmg.newHp, shield: turn.dmg.newShield }
      : f)
    .filter((f) => f.hp > 0);
  if (postTurnFighters.length === 0) return null; // party wiped; telegraph moot
  // Read the latest ability_state since performMonsterTurn just decremented
  // counters — we want to honor the post-swing values (someone with vanished=1
  // before the swing is now vanished=0, freely targetable next round).
  const freshRow = await env.DB
    .prepare("SELECT scene_json FROM quests WHERE id = ?")
    .bind(quest.id)
    .first<{ scene_json: string }>();
  const freshScene = freshRow ? (JSON.parse(freshRow.scene_json) as SceneJson) : quest.scene;
  const vanishedMap = freshScene.ability_state?.vanished ?? {};
  const taunt = freshScene.ability_state?.taunt;
  // 🛡 Taunt locks the telegraph: if the taunter is still alive after this
  // swing AND has remaining swings, keep the spotlight on them so the render
  // matches reality.
  if (taunt && taunt.swings_remaining > 0) {
    const tauntFighter = postTurnFighters.find((f) => f.slack_user_id === taunt.user_id);
    if (tauntFighter && (vanishedMap[tauntFighter.slack_user_id] ?? 0) <= 0) {
      try {
        await env.DB
          .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.monster_telegraph', json(?)) WHERE id = ?")
          .bind(JSON.stringify({ target_user_id: tauntFighter.slack_user_id }), quest.id)
          .run();
        return tauntFighter.slack_user_id;
      } catch (err) {
        console.warn("telegraph:patch-error", { questId: quest.id, err: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
  }
  // 🗡 Vanish excludes hidden fighters from the next-target pool. When
  // NOBODY is targetable post-swing (every alive fighter is still
  // vanished — e.g. a solo Rogue mid-Vanish), clear the telegraph so the
  // combat block doesn't read "locked on @josh next round" right after
  // a fizzle that says nobody can be hit. The next monster turn will
  // pick fresh via the same all-vanished check in performMonsterTurn.
  const targetable = postTurnFighters.filter((f) => (vanishedMap[f.slack_user_id] ?? 0) <= 0);
  if (targetable.length === 0) {
    try {
      await env.DB
        .prepare("UPDATE quests SET scene_json = json_remove(scene_json, '$.monster_telegraph') WHERE id = ?")
        .bind(quest.id)
        .run();
    } catch (err) {
      console.warn("telegraph:clear-error", { questId: quest.id, err: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
  const nextTarget = pickMonsterTarget(targetable, Math.random);
  try {
    await env.DB
      .prepare(
        "UPDATE quests SET scene_json = json_set(scene_json, '$.monster_telegraph', json(?)) WHERE id = ?",
      )
      .bind(JSON.stringify({ target_user_id: nextTarget.slack_user_id }), quest.id)
      .run();
    return nextTarget.slack_user_id;
  } catch (err) {
    // Non-fatal — the next monster turn just falls back to fresh pickMonsterTarget.
    console.warn("telegraph:patch-error", { questId: quest.id, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Resolves a monster's counter-attack: picks a target via pickMonsterTarget, computes
// damage through armor + position modifier + shield, and returns the outcome WITHOUT
// writing to DB. Caller decides to either route to resolveDeath or persist + narrate.
//
// Used by: handleCombat (attack/cast/sig), handleHeal, handleShield. Any "trigger
// monster on mana use" actions go through this so the retaliation rules stay
// centralized and consistent.
//
// Target selection: if scene.monster_telegraph specifies a target who's still
// a viable fighter, the monster commits to that target — completing the
// telegraph promise from the previous round. Otherwise picks fresh via the
// position-weighted RNG. Honoring the telegraph is what makes the "react to
// the next hit" mechanic real instead of misleading.
async function performMonsterTurn(
  env: Env,
  quest: ActiveQuest,
  fighters: Character[],
  actor: Character,
  actorArmor: Item | null,
): Promise<MonsterTurnOutcome> {
  // Active-ability consumption — read once and apply to targeting + decrements
  // at the end. Reads are non-atomic with other parallel writes (a second
  // player using an ability mid-swing could be clobbered), but ability use
  // is rare enough that occasional under-counting is acceptable.
  const abilityState = quest.scene.ability_state ?? {};
  const skipSwings = abilityState.skip_swings ?? 0;
  const vanishedMap = abilityState.vanished ?? {};
  const taunt = abilityState.taunt;

  // 🧙 DevOps Mage Containerize — the monster's next swing fizzles. Decrement
  // the skip counter and return a no-op outcome. Picks a representative target
  // (the actor) just to satisfy the shape; no DB write follows because
  // skipped=true tells callers to bypass setCharacterHpAndShield.
  if (skipSwings > 0) {
    const dummy = fighters.find((f) => f.slack_user_id === actor.slack_user_id) ?? fighters[0];
    await writeAbilityState(env.DB, quest.id, {
      ...abilityState,
      skip_swings: skipSwings - 1 > 0 ? skipSwings - 1 : undefined,
    });
    return {
      target: dummy,
      victimWasActor: dummy.slack_user_id === actor.slack_user_id,
      monsterLine: `💨 *${quest.scene.monster_name}* is suspended in stasis — its swing fizzles.`,
      dmg: { newShield: dummy.shield, newHp: dummy.hp, shieldAbsorbed: 0, hpDamage: 0 },
      positionAdjusted: 0,
      willKillTarget: false,
      skipped: true,
    };
  }

  // 🗡 Refactor Rogue Vanish — vanished fighters can't be targeted. When
  // NOBODY is targetable (most commonly a solo Rogue who just vanished,
  // but also possible if every partymate vanishes simultaneously) the
  // monster's swing fizzles entirely — same shape as a Containerize
  // skip. Vanished counters still tick down so the buff expires at the
  // same rate; the player gets the protection they paid mana for instead
  // of the previous fallback that targeted them anyway.
  const targetable = fighters.filter((f) => (vanishedMap[f.slack_user_id] ?? 0) <= 0);
  if (targetable.length === 0 && fighters.length > 0) {
    // Decrement every vanished counter — the swing was "used up" even
    // though no damage landed. Mirrors the normal vanished-decrement
    // path below (factored inline since this branch returns early).
    const nextVanished: Record<string, number> = {};
    for (const f of fighters) {
      const remaining = (vanishedMap[f.slack_user_id] ?? 0) - 1;
      if (remaining > 0) nextVanished[f.slack_user_id] = remaining;
    }
    const nextState: NonNullable<SceneJson["ability_state"]> = { ...abilityState };
    nextState.vanished = Object.keys(nextVanished).length > 0 ? nextVanished : undefined;
    await writeAbilityState(env.DB, quest.id, nextState);

    const dummy = fighters.find((f) => f.slack_user_id === actor.slack_user_id) ?? fighters[0];
    return {
      target: dummy,
      victimWasActor: dummy.slack_user_id === actor.slack_user_id,
      monsterLine: `💨 *${quest.scene.monster_name}* swings at empty air — there's nobody to hit.`,
      dmg: { newShield: dummy.shield, newHp: dummy.hp, shieldAbsorbed: 0, hpDamage: 0 },
      positionAdjusted: 0,
      willKillTarget: false,
      skipped: true,
    };
  }
  const targetPool = targetable;

  // ── Boss splash (AoE) ──
  // Bosses have a ~25% (phase 1) or ~40% (phase 2) chance to slam the whole
  // non-vanished party instead of a single target. Taunt does NOT redirect a
  // splash. Only fires when multiple fighters are alive.
  const isBossVariant = quest.scene.variant === "boss";
  const isBossPhase2 = isBossVariant && quest.scene.boss_phase === 2;
  const splashRoll = Math.ceil(Math.random() * 5);
  const doSplash = isBossVariant && targetPool.length > 1 && splashRoll <= (isBossPhase2 ? 2 : 1);

  if (doSplash) {
    const splashAttackType: DamageType =
      quest.scene.monsters?.[0]?.attack_damage_type
      ?? quest.scene.monster_attack_type
      ?? "physical";
    const splashTypeEmoji = splashAttackType !== "physical" ? ` ${DAMAGE_TYPE_EMOJI[splashAttackType]}` : "";
    const splashResults: NonNullable<MonsterTurnOutcome["splashTargets"]> = [];
    for (const f of targetPool) {
      let fResistPct = 0;
      if (splashAttackType !== "physical") {
        const fSlots = await getAllEquippedSlots(env.DB, f.slack_user_id);
        const resistKey = `resist_${splashAttackType}`;
        for (const item of Object.values(fSlots)) {
          fResistPct += item?.stat_bonus?.[resistKey] ?? 0;
        }
        fResistPct = Math.min(75, fResistPct);
      }
      const hit = resolveMonsterHit(
        quest.scene.tier,
        fighters.length,
        0,
        isBossPhase2,
        rollDice,
        splashAttackType,
        fResistPct,
      );
      const posAdj = fighters.length > 1
        ? positionDamageMod(f.position, hit.final)
        : hit.final;
      // Physical depletes armor pool; non-physical bypasses it.
      const rawSplash = applyDamageWithShield(
        posAdj,
        splashAttackType === "physical" ? f.shield : 0,
        f.hp,
      );
      const dmg = splashAttackType === "physical"
        ? rawSplash
        : { newShield: f.shield, newHp: rawSplash.newHp, shieldAbsorbed: 0, hpDamage: rawSplash.hpDamage };
      splashResults.push({ fighter: f, dmg, positionAdjusted: posAdj, willKill: dmg.newHp <= 0 });
    }

    // Decrement vanished counters (splash still "uses up" the swing).
    // Taunt is NOT decremented — splash ignores taunt.
    const vanishedUserIds = Object.keys(vanishedMap).filter((uid) => (vanishedMap[uid] ?? 0) > 0);
    if (vanishedUserIds.length > 0) {
      const nextVanished: Record<string, number> = {};
      for (const uid of vanishedUserIds) {
        const remaining = (vanishedMap[uid] ?? 0) - 1;
        if (remaining > 0) nextVanished[uid] = remaining;
      }
      const nextState: NonNullable<SceneJson["ability_state"]> = { ...abilityState };
      nextState.vanished = Object.keys(nextVanished).length > 0 ? nextVanished : undefined;
      await writeAbilityState(env.DB, quest.id, nextState);
    }

    const firstKilled = splashResults.find((r) => r.willKill);
    const representative = firstKilled?.fighter ?? actor;
    const monsterLines: string[] = [
      `💥 *${quest.scene.monster_name}*${splashTypeEmoji} unleashes a devastating slam — the whole party takes the hit!`,
    ];
    for (const r of splashResults) {
      const armorPart = r.fighter.slack_user_id === actor.slack_user_id
        ? ""
        : "";
      const shieldPart = r.dmg.shieldAbsorbed > 0
        ? ` — *${r.dmg.shieldAbsorbed}* absorbed by shield, *${r.dmg.hpDamage}* to HP`
        : "";
      monsterLines.push(`• <@${r.fighter.slack_user_id}> (*${r.fighter.name}*): *${r.positionAdjusted}* dmg${shieldPart} → *${Math.max(0, r.dmg.newHp)}*/*${r.fighter.max_hp}* HP`);
      void armorPart;
    }

    return {
      target: representative,
      victimWasActor: representative.slack_user_id === actor.slack_user_id,
      monsterLine: monsterLines.join("\n"),
      dmg: splashResults.find((r) => r.fighter.slack_user_id === representative.slack_user_id)?.dmg
        ?? { newShield: representative.shield, newHp: representative.hp, shieldAbsorbed: 0, hpDamage: 0 },
      positionAdjusted: splashResults.find((r) => r.fighter.slack_user_id === representative.slack_user_id)?.positionAdjusted ?? 0,
      willKillTarget: !!firstKilled,
      isSplash: true,
      splashTargets: splashResults,
    };
  }

  // 🛡 SRE Warden Taunt — overrides the telegraph if the taunter is still in
  // the target pool (alive + not vanished). Otherwise fall through to the
  // committed telegraph and then position-weighted pick.
  let target: Character;
  let tauntConsumed = false;
  if (taunt && taunt.swings_remaining > 0) {
    const tauntFighter = targetPool.find((f) => f.slack_user_id === taunt.user_id);
    if (tauntFighter) {
      target = tauntFighter;
      tauntConsumed = true;
    } else {
      const telegraphed = quest.scene.monster_telegraph?.target_user_id;
      const telegraphedFighter = telegraphed
        ? targetPool.find((f) => f.slack_user_id === telegraphed)
        : null;
      target = telegraphedFighter ?? pickMonsterTarget(targetPool, Math.random);
    }
  } else {
    const telegraphed = quest.scene.monster_telegraph?.target_user_id;
    const telegraphedFighter = telegraphed
      ? targetPool.find((f) => f.slack_user_id === telegraphed)
      : null;
    target = telegraphedFighter ?? pickMonsterTarget(targetPool, Math.random);
  }
  const victimWasActor = target.slack_user_id === actor.slack_user_id;

  // Re-fetch armor for non-actor targets (the actor's armor was already loaded).
  const targetArmor = victimWasActor
    ? actorArmor
    : await getEquipped(env.DB, target.slack_user_id, "armor");

  // Determine monster attack type and target's resistance.
  const monsterAttackType: DamageType =
    quest.scene.monsters?.[0]?.attack_damage_type
    ?? quest.scene.monster_attack_type
    ?? "physical";

  let targetResistPct = 0;
  if (monsterAttackType !== "physical") {
    // Sum resist_<type> from all equipped items for the target.
    const targetSlots = await getAllEquippedSlots(env.DB, target.slack_user_id);
    for (const item of Object.values(targetSlots)) {
      if (!item?.stat_bonus) continue;
      const resistKey = `resist_${monsterAttackType}`;
      targetResistPct += (item.stat_bonus[resistKey] ?? 0);
    }
    targetResistPct = Math.min(75, targetResistPct);
  }

  const monster = resolveMonsterHit(
    quest.scene.tier,
    fighters.length,
    0,
    quest.scene.variant === "boss" && quest.scene.boss_phase === 2,
    rollDice,
    monsterAttackType,
    targetResistPct,
  );

  const positionAdjusted = fighters.length > 1
    ? positionDamageMod(target.position, monster.final)
    : monster.final;

  // Physical attacks route through the depletable armor pool (target.shield).
  // Non-physical bypasses armor entirely and hits HP directly.
  const dmgRaw = applyDamageWithShield(
    positionAdjusted,
    monsterAttackType === "physical" ? target.shield : 0,
    target.hp,
  );
  const dmg = monsterAttackType === "physical"
    ? dmgRaw
    : { newShield: target.shield, newHp: dmgRaw.newHp, shieldAbsorbed: 0, hpDamage: dmgRaw.hpDamage };

  const typeEmoji = monsterAttackType !== "physical" ? ` ${DAMAGE_TYPE_EMOJI[monsterAttackType]}` : "";
  const armorPart = dmg.shieldAbsorbed > 0
    ? ` \`${monster.raw} − ${dmg.shieldAbsorbed} armor\``
    : monster.resistanceReduction > 0
      ? ` \`${monster.raw} − ${monster.resistanceReduction} resist\``
      : "";
  const positionPart = fighters.length > 1 && target.position === "back" && positionAdjusted < monster.final
    ? ` (${target.position}-row: ${positionAdjusted})`
    : "";
  const shieldPart = "";
  // When the monster picks a different party member than the actor, tag them
  // with a Slack <@user_id> mention so the message reads clearly in a multi-
  // person quest ("the Stale PR hits @fenus for 6"). For the actor themselves
  // we say "hits back" since they're the one who just acted.
  const targetTag = victimWasActor
    ? "back"
    : `<@${target.slack_user_id}>`;
  const monsterLine = `*${quest.scene.monster_name}*${typeEmoji} hits ${targetTag} for *${positionAdjusted}*${armorPart}${positionPart}${shieldPart}.`;

  // Decrement consumed ability_state. Taunt counter ticks down only when a
  // taunt-redirected swing actually landed; vanished counters tick for every
  // user who was vanished this turn regardless of whether the monster targeted
  // them (the "hidden in shadows for N swings" promise).
  let stateChanged = false;
  const nextState: NonNullable<SceneJson["ability_state"]> = { ...abilityState };
  if (tauntConsumed && taunt) {
    const remaining = taunt.swings_remaining - 1;
    nextState.taunt = remaining > 0
      ? { user_id: taunt.user_id, swings_remaining: remaining }
      : undefined;
    stateChanged = true;
  }
  const vanishedUserIds = Object.keys(vanishedMap).filter((uid) => (vanishedMap[uid] ?? 0) > 0);
  if (vanishedUserIds.length > 0) {
    const nextVanished: Record<string, number> = {};
    for (const uid of vanishedUserIds) {
      const remaining = (vanishedMap[uid] ?? 0) - 1;
      if (remaining > 0) nextVanished[uid] = remaining;
    }
    nextState.vanished = Object.keys(nextVanished).length > 0 ? nextVanished : undefined;
    stateChanged = true;
  }
  if (stateChanged) {
    await writeAbilityState(env.DB, quest.id, nextState);
  }

  return {
    target,
    victimWasActor,
    monsterLine,
    dmg,
    positionAdjusted,
    willKillTarget: dmg.newHp <= 0,
  };
}

// Replaces scene.ability_state entirely. Fields set to `undefined` are pruned
// so we don't accumulate dead keys forever in the scene blob. Used by
// performMonsterTurn (consuming taunt/vanished/skip_swings) and handleCombat
// (consuming battle_hymn). Read-modify-write is racy under truly concurrent
// ability use, but action cadence + 45s cooldowns make this very rare.
async function writeAbilityState(
  db: D1Database,
  questId: number,
  state: NonNullable<SceneJson["ability_state"]>,
): Promise<void> {
  // Prune undefined keys — json_set with a JSON null would leave the field in
  // place; we want it gone so SceneJson["ability_state"] looks clean.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (v !== undefined) cleaned[k] = v;
  }
  try {
    await db
      .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.ability_state', json(?)) WHERE id = ?")
      .bind(JSON.stringify(cleaned), questId)
      .run();
  } catch (err) {
    console.warn("ability-state:patch-error", { questId, err: err instanceof Error ? err.message : String(err) });
  }
}

// Quest-end blocks. Used by victory/expedition-victory/party-broken-death posts so
// the channel sees a clear "this is the closer" beat instead of just one more
// thread message in a long stream.
function buildQuestEndBlocks(opts: {
  outcome: "victory" | "failure";
  headline: string;       // single short line, e.g. "QUEST COMPLETE" or "QUEST FAILED"
  narration: string;      // AI-generated flavor text
  body: string[];         // post-narration lines: spoils, level-ups, loot, scars, etc.
}): unknown[] {
  const emoji = opts.outcome === "victory" ? "🏆🎉" : "☠️💀";
  return [
    { type: "header", text: { type: "plain_text", text: `${emoji} ${opts.headline} ${emoji}`, emoji: true } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: blockQuote(opts.narration) } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: opts.body.join("\n") } },
  ];
}

async function handleWebLogin(
  payload: SlashCommandPayload,
  env: Env,
): Promise<CommandResponse> {
  const { code, expires_at } = await issueWebLoginCode(env.DB, payload.user_id, payload.team_id);
  const minutes = Math.max(1, Math.round((expires_at - Date.now()) / 60_000));
  const webUrl = env.WEB_BASE_URL?.trim();
  const where = webUrl ? `Enter it at ${webUrl}` : "Enter it in the web app";
  return ephemeral(`🔐 Your web login code: *${code}*\n${where}. Expires in ~${minutes} min.`);
}

function ephemeral(text: string): CommandResponse {
  return { text, response_type: "ephemeral" };
}

function inChannel(text: string): CommandResponse {
  return { text, response_type: "in_channel" };
}
