// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env } from "./index";

// Public-facing display name. Defaults to "Slack Quest"; operators override per
// deployment by setting BOT_NAME in wrangler.jsonc `vars` or as a secret.
const DEFAULT_BOT_NAME = "Slack Quest";
function botName(env: Env): string {
  return env.BOT_NAME?.trim() || DEFAULT_BOT_NAME;
}
import {
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
  generateExpeditionTheme,
  generateLockboxScene,
  generateNpcRoom,
  generateOpeningScene,
  generateTrapRoom,
} from "./ai";
import {
  addCharacterKey,
  addGold,
  addItem,
  addShield,
  appendLog,
  applyLongRest,
  applyShortRest,
  applySoftDeath,
  averageCharacterLevel,
  awardSpoils,
  bumpMaxMana,
  claimShopItem,
  consumeItem,
  cooldownRemaining,
  countCharacters,
  countPurchasesInCycle,
  createCharacter,
  createQuest,
  deleteCharacter,
  equipItem,
  getActiveQuestForCharacter,
  getActiveQuestInChannel,
  getActiveShopStock,
  getCharacter,
  getEquipped,
  getInventory,
  getItem,
  getLeaderboard,
  getQuestParty,
  getShopItem,
  healCharacter,
  insertShopStock,
  isFighter,
  joinQuest,
  markQuestStatus,
  refillMana,
  releaseShopClaim,
  resetCooldownsFor,
  removeItem,
  reviveCharacter,
  saveScene,
  scaleMonsterForJoin,
  setCharacterHp,
  setCharacterHpAndShield,
  setPosition,
  transferItem,
  trySaveExpeditionAdvance,
  tryDeductGold,
  tryDeductMana,
  tryUpdateScene,
  type ActiveQuest,
  type BattlePosition,
  type Character,
  type ExpeditionNode,
  type ExpeditionNodeType,
  type ExpeditionState,
  type GauntletWave,
  type Item,
  type KeyTier,
  type LootOption,
  type QuestVariant,
  type SceneJson,
  type ShopItem,
} from "./db";
import {
  applyDamageWithShield,
  isBossPhaseTransition,
  pickMonsterTarget,
  positionDamageMod,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  resolveShield,
  resolveSignature,
} from "./combat";
import {
  classByName,
  dropChance,
  findCatalogEntry,
  generateNpcName,
  generateScar,
  pickRandomClass,
  priceFor,
  rollDice,
  rollItem,
  sellPriceFor,
  signatureFor,
  xpForLevel,
  type ItemRoll,
  MAX_MANA_CAP,
  RARITY_BADGE,
  SHIELD_CAP_MULTIPLIER,
  SKILL_META,
} from "./flavor";
import { postMessage, respondToCommand, type InteractivePayload, type SlashCommandPayload } from "./slack";

export interface CommandResponse {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: unknown[];
}

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const ACTION_COOLDOWN_MS = 45 * 1000;
const JOIN_HP_RATIO = 0.4; // monster max HP grows by this fraction per joiner
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
    `• \`${cmd} heal [@user]\` — restore \`1d6 + magic_mod\` HP on a party member (costs 1 mana, default self)`,
    `• \`${cmd} shield [@user]\` — buff \`1d6 + magic_mod\` absorbing HP on a party member (costs 1 mana, default self)`,
    `• \`${cmd} revive <id> @user\` — bring a downed party member back, consuming a revive item`,
    `• \`${cmd} rest\` — short rest: heals 50% of missing HP (10-min cooldown)`,
    `• \`${cmd} rest long\` — long rest: full HP restore, once per 24 hours`,
    `• \`${cmd} inventory\` — list your items (equipped marked ✅)`,
    `• \`${cmd} look\` (\`where\`, \`scene\`) — re-show the current room / door choices if you've scrolled past`,
    `• \`${cmd} equip <id>\` — equip a weapon or armor by inventory id`,
    `• \`${cmd} use <id>\` — use a consumable (free action, no cooldown)`,
    `• \`${cmd} shop\` — view the channel's shop (restocks every 6h)`,
    `• \`${cmd} buy <id>\` — purchase a shop item with gold`,
    `• \`${cmd} sell <id>\` — sell an inventory item for 30% of shop price`,
    `• \`${cmd} give <id> @user\` — gift an inventory item to another player (unequip first)`,
    `• \`${cmd} party\` — show the current quest's roster + HP`,
    `• \`${cmd} leaderboard\` — top 10 heroes`,
    `• \`${cmd} help\` — show this list`,
    `• \`${cmd} rules\` — full mechanics reference (positioning, items, shop, etc.)`,
    "_Combat actions have a 45-second cooldown per player._",
  ].join("\n");
}

// Full mechanics reference. Verbose by design — players invoke this when they want
// to understand the system, not just remember a command name.
function rulesText(cmd: string, name: string): string {
  return [
    `*🎲 ${name} — Mechanics Reference*`,
    ``,
    `*━━ Characters ━━*`,
    `• Roll with \`${cmd} roll\`. 8 engineering-themed classes, randomly assigned (HP / atk_mod / mag_mod vary by class).`,
    `• *Reroll:* free until your first XP, then \`level × 50g\`. Confirm with \`${cmd} roll confirm\` — deletes everything (gold, gear, scars).`,
    `• *Level up* (auto on XP threshold): max HP +1d6, HP refills, mana refills, max mana +1 every 5 levels (cap 5).`,
    `• *Mana refills* between quests, on join, and on level-up.`,
    ``,
    `*━━ Battle Position ━━*`,
    `• 🔼 *Front:* 3× more likely to be targeted, takes full damage. Required for melee \`${cmd} attack\`.`,
    `• 🔽 *Back:* less hit risk, takes 60% damage, *can only \`${cmd} attack\` with a ranged weapon equipped*.`,
    `• \`${cmd} position front|back\` — free outside a quest; mid-quest costs the 45s combat cooldown.`,
    `• _Position effects only apply in parties of 2+. Solo fights ignore positioning entirely._`,
    ``,
    `*━━ Combat ━━*`,
    `_All actions share one 45s cooldown — one combat-tier action per player per 45s._`,
    `• \`${cmd} attack\` — \`1d6 + atk_mod + weapon\`, crit on nat 6 (×2 damage)`,
    `• \`${cmd} cast\` — \`1d8 + mag_mod + weapon\`, crit on nat 8`,
    `• \`${cmd} signature\` (\`sig\`) — class-specific big move, costs 1 mana`,
    `• \`${cmd} flee\` — \`1d2\`. 1 = escape (party fights on); 2 = trip + free monster hit. Blocked in gauntlet/dungeon.`,
    `• \`${cmd} heal [@user]\` — \`1d6 + mag_mod\` HP to a partymate, costs 1 mana, *triggers monster retaliation*`,
    `• \`${cmd} shield [@user]\` — \`1d6 + mag_mod\` absorbing HP, costs 1 mana, caps at 2× max HP, *triggers monster retaliation*`,
    `• \`${cmd} revive <id> @user\` — bring downed partymate back, consumes a revive item (no mana cost)`,
    `• Monster damage: \`1d4 + tier + party_bonus\`, mitigated by armor (\`floor(power/2)\`, min 1) and back-row position (×0.6, min 1). Boss phase 2 adds +tier.`,
    `• *Targeting:* monster picks a victim weighted 3:1 front:back from alive fighters — front-line tanks soak hits for back-line casters.`,
    ``,
    `*━━ Items & Equipment ━━*`,
    `• ⚔️ *Melee weapons* — front-row only for \`attack\`; \`+N\` to attack/cast/sig damage`,
    `• 🏹 *Ranged weapons* — usable from any row for \`attack\`; same damage bonus`,
    `• 🛡️ *Armor* — reduces incoming damage by \`floor(power/2)\``,
    `• 🧪 *Consumables* — \`${cmd} use <id>\` heals N HP. Free action, no cooldown.`,
    `• 🔮 *Magic items* — \`${cmd} use <id>\` grants permanent +N max mana (cap 5)`,
    `• 🌱 *Revive items* — bring downed teammate back at N% HP (rarity-tiered 50/75/100%)`,
    `• 🧨 *Tools* — single-shot offensive consumables; \`${cmd} use <id>\` deals damage, ignores armor (consumes a combat turn)`,
    `• 📜 *Scrolls* — single-shot rituals; \`${cmd} use <id>\` triggers the named effect. 🔄 Rebase (FREE action — party cooldowns + mana wipe to full, no retaliation), 💥 Production Outage (consumes a turn — boss -30% HP / non-boss → 1 HP)`,
    `• Slots: 1 weapon + 1 armor equipped at a time. \`${cmd} equip <id>\` swaps in.`,
    `• \`${cmd} give <id> @user\` — gift any unequipped item; channel-public message`,
    ``,
    `*━━ Shop ━━*`,
    `• \`${cmd} shop\` — channel-shared, restocks every 6h with AI-generated items.`,
    `• *Stock size scales:* 6 base + 1 per character above 4 (cap 12). 8 players → 10 items per cycle.`,
    `• *Per-player cap:* 2 purchases per restock cycle (no whale-clearing).`,
    `• Pricing (flat per rarity): gear 15g/50g/150g; magic 100g/250g/500g; revive 150g/280g/450g.`,
    `• \`${cmd} sell\` returns 30% of buy price. No shopping mid-quest.`,
    ``,
    `*━━ Quest Variants ━━*`,
    `• \`${cmd} quest\` — standard, 1 monster, 1× rewards`,
    `• \`${cmd} quest boss\` — L3+, beefy monster, 2 phases at 50% HP, 2× rewards`,
    `• \`${cmd} quest gauntlet\` — L5+, 3 monsters back-to-back, no flee, 3× rewards, 100% drop on the final kill`,
    `• \`${cmd} quest dungeon\` (alias \`expedition\`) — *the dungeon crawl* (L1+). 5-7 rooms: combat, trap, lockbox, NPC encounter. Sub-boss + treasure at the end. 2.5× rewards.`,
    `   _Door-pick navigation_ — between rooms, pick from 2 doors (\`${cmd} choose 1|2\`). The unchosen door is sealed.`,
    `   _Trap rooms_ — 3 class-skill options. Match → auto-pass; mismatch → \`1d6 ≥ 4\`. Fail = HP damage.`,
    `   _Lockbox rooms_ — tiered locks (🥉 bronze / 🥈 silver / 🥇 gold). Need a matching-or-higher key from your inventory; bigger tier = bigger loot.`,
    `   _Keys_ — 🥉 bronze drops from each combat room; 🥈 silver from the sub-boss; 🥇 gold rarely from chests. *Keys persist on your character* across dungeons.`,
    `   _NPC rooms_ — trust them for an item, or refuse and pass.`,
    `   _Map_ — \`🗺️\` trail shown each room; full reveal (with sealed doors) on completion.`,
    `   Class skills: 💪 *STR*: Paladin, Warden, Druid · 🔧 *DEX*: Rogue, Mage · 📜 *INT*: Bard, Sage, Warlock, Mage, Druid`,
    `• \`${cmd} quest elite\` — modifier: *perma-death* on 0 HP. Composes: \`${cmd} quest boss elite\`.`,
    `• *Invite at start:* \`${cmd} quest [variant] @user1 @user2\` — auto-joins them, scales monster HP per joiner.`,
    ``,
    `*━━ Joining ━━*`,
    `• \`${cmd} join\` — join the active channel quest. Monster max HP grows ×1.4 per joiner.`,
    `• Joinable through wave 1 of a gauntlet (locks at wave 2).`,
    `• Joinable until the first room is resolved on a dungeon (locks once anyone advances).`,
    ``,
    `*━━ Death & Recovery ━━*`,
    `• *Soft death* (any non-elite at 0 HP): 25% gold loss, drop a random item, +1 scar, *12h cooldown*, HP restored to max for next time.`,
    `• *Perma death* (elite quest at 0 HP): character row deleted (gear, gold, scars — all gone). Roll a new one.`,
    `• \`${cmd} rest\` — short rest between quests, heals 50% of missing HP, 10-min cooldown.`,
    `• \`${cmd} rest long\` — full HP restore, *once per 24h*.`,
    ``,
    `*━━ Visibility ━━*`,
    `• Channel sees: quest start, quest end (victory / failure / abandoned). And \`${cmd} leaderboard\` if you run it.`,
    `• Quest thread sees: every combat action with full Block Kit cards (narration, dice math, monster + actor stats).`,
    `• You see (ephemeral): your own action's deterministic outcome instantly; the AI-flavored thread version follows ~1-2s later.`,
    ``,
    `_Use \`${cmd} help\` for the command list. \`${cmd} me\` for your sheet._`,
  ].join("\n");
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
  };
  const args = [action.value];

  if (action.action_id === "equip") return handleEquip(slash, args, env);
  if (action.action_id === "use") return handleUse(slash, args, env, ctx);
  if (action.action_id === "sell") return handleSell(slash, args, env);
  if (action.action_id === "inventory") return handleInventory(slash, env);
  if (action.action_id === "dungeon_choose") return handleChoose(slash, args, env, ctx);
  if (action.action_id === "dungeon_take") return handleTake(slash, args, env, ctx);
  if (action.action_id === "shop_buy") return handleBuy(slash, args, env);
  return ephemeral(`Unknown action \`${action.action_id}\`.`);
}

export async function handleCommand(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const args = payload.text.trim().split(/\s+/).filter(Boolean);
  const sub = (args.shift() ?? "help").toLowerCase();

  switch (sub) {
    case "roll":
      return handleRoll(payload, args, env);
    case "me":
    case "sheet":
      return handleMe(payload, env);
    case "quest":
      return handleQuest(payload, args, env, ctx);
    case "attack":
      return handleCombat(payload, env, ctx, "attack");
    case "cast":
      return handleCombat(payload, env, ctx, "cast");
    case "flee":
      return handleCombat(payload, env, ctx, "flee");
    case "signature":
    case "sig":
      return handleCombat(payload, env, ctx, "signature");
    case "heal":
      return handleHeal(payload, args, env, ctx);
    case "shield":
      return handleShield(payload, args, env, ctx);
    case "revive":
      return handleRevive(payload, args, env, ctx);
    case "rest":
      return handleRest(payload, args, env);
    case "position":
    case "pos":
      return handlePosition(payload, args, env);
    case "join":
      return handleJoin(payload, env, ctx);
    case "party":
      return handleParty(payload, env);
    case "leaderboard":
    case "lb":
      return handleLeaderboard(payload, env);
    case "inventory":
    case "inv":
      return handleInventory(payload, env);
    case "look":
    case "where":
    case "scene":
      return handleLook(payload, env);
    case "equip":
      return handleEquip(payload, args, env);
    case "use":
      return handleUse(payload, args, env, ctx);
    case "shop":
      return handleShop(payload, env, ctx);
    case "buy":
      return handleBuy(payload, args, env);
    case "sell":
      return handleSell(payload, args, env);
    case "give":
      return handleGive(payload, args, env, ctx);
    case "choose":
      return handleChoose(payload, args, env, ctx);
    case "take":
      return handleTake(payload, args, env, ctx);
    case "help":
    case "":
      return ephemeral(helpText(payload.command, botName(env)));
    case "rules":
    case "howto":
    case "manual":
      return ephemeral(rulesText(payload.command, botName(env)));
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
  preamble?: string,
): Promise<CommandResponse> {
  const cls = pickRandomClass();
  const npcName = generateNpcName();
  const hp = cls.base_hp + rollDice(4); // small variance

  const character = await createCharacter(env.DB, {
    slack_user_id: payload.user_id,
    slack_team_id: payload.team_id,
    name: npcName,
    class: cls.name,
    hp,
    max_hp: hp,
  });

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
): Promise<CommandResponse> {
  const existing = await getCharacter(env.DB, payload.user_id);

  // First-ever roll: nothing to reconcile.
  if (!existing) return rollNewCharacter(payload, env);

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
  return rollNewCharacter(payload, env, preamble);
}

async function handleMe(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const c = await getCharacter(env.DB, payload.user_id);
  if (!c) return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);
  const [weapon, armor] = await Promise.all([
    getEquipped(env.DB, payload.user_id, "weapon"),
    getEquipped(env.DB, payload.user_id, "armor"),
  ]);
  const text = formatSheet(c, weapon, armor); // plain-text fallback for non-Block-Kit clients
  return { text, response_type: "ephemeral", blocks: buildSheetBlocks(c, weapon, armor) };
}

// Sectioned Block Kit layout for /sq me. Sections (with dividers between):
//   1. Header: name + class
//   2. Vitals: level, xp, position, HP, mana, gold, shield (if any)
//   3. Equipped: weapon + armor
//   4. Signature: class signature ability
//   5. Keys: tiered dungeon keys (only shown if non-zero)
//   6. Scars / downed status (only shown if applicable)
//   7. Actions: [🎒 Inventory] button
function buildSheetBlocks(c: Character, weapon: Item | null, armor: Item | null): unknown[] {
  const blocks: unknown[] = [];

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
    const wIcon = (weapon.weapon_range ?? "melee") === "ranged" ? "🏹" : "⚔️";
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

  // 5. Keys (only if any held)
  const keyDisplay = characterKeyDisplay(c);
  if (keyDisplay) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🗝️ Keys*\n${keyDisplay}` },
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

  // Equipment line. Shows whichever slots are filled; blank if neither.
  // Weapon emoji reflects melee (⚔️) vs ranged (🏹).
  const equipParts: string[] = [];
  if (weapon) {
    const wIcon = (weapon.weapon_range ?? "melee") === "ranged" ? "🏹" : "⚔️";
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
    `${equipLine}${sigLine}${keyLine}${scarLine}${downedNote}`,
  ].filter(Boolean).join("\n");
}

async function handleQuest(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
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
      const baseScene = await buildQuestScene(env, character, elite, variant);

      // Validate each invitee. Bucket into joiners (will succeed) and rejects (with
      // reasons surfaced in the opening post so the inviter knows why).
      type Reject = { id: string; name: string; reason: string };
      const joiners: Character[] = [];
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
        const existing = await getActiveQuestForCharacter(env.DB, id);
        if (existing) {
          rejects.push({ id, name: c.name, reason: "already on a quest" });
          continue;
        }
        joiners.push(c);
      }

      // Pre-scale the monster HP based on how many will join. Saved scene already
      // reflects the bumped HP; no follow-up scaleMonsterForJoin DB writes needed.
      const scene = preScaleForJoiners(baseScene, joiners.length, JOIN_HP_RATIO);
      const eliteBanner = elite ? "⚠️ *ELITE — perma-death enabled* ⚠️\n" : "";
      const variantBanner =
        variant === "boss"
          ? "👑 *BOSS QUEST*\n"
          : variant === "gauntlet"
          ? `⚔️ *GAUNTLET — ${GAUNTLET_WAVES} waves, no flee*\n`
          : variant === "dungeon"
          ? `🗺️ *DUNGEON — ${scene.expedition?.nodes.length ?? 5} rooms, treasure at the end*\n`
          : "";

      // Expedition: render the first room (could be combat/trap/lockbox/npc).
      // Other variants: standard opening scene + foe HP.
      const isExpedition = variant === "dungeon" && scene.expedition;
      const body = isExpedition
        ? [
            `*Theme:* ${scene.expedition!.theme}`,
            ``,
            renderDungeonRoom(scene.expedition!.nodes[0], scene.expedition!, payload.command),
          ].join("\n")
        : [
            `_${scene.scene}_`,
            ``,
            `Foe: *${scene.monster_name}* — HP ${scene.monster_hp}${variant === "gauntlet" ? ` (wave 1/${GAUNTLET_WAVES})` : ""}`,
          ].join("\n");

      // Party line + invite-rejection notes, both visible in the opening channel post.
      // Each name carries its position emoji so spectators see the front/back split
      // before combat starts.
      const partyMembers = [
        `${positionEmoji(character.position)} <@${payload.user_id}>`,
        ...joiners.map((j) => `${positionEmoji(j.position)} <@${j.slack_user_id}>`),
      ];
      const partyLine = joiners.length > 0
        ? `\n👥 *Party:* ${partyMembers.join(", ")}`
        : "";
      const rejectLine = rejects.length > 0
        ? `\n⚠️ Couldn't invite: ${rejects.map((r) => `*${r.name}* (${r.reason})`).join(", ")}`
        : "";

      const text = [
        `${eliteBanner}${variantBanner}*A new quest begins.* <@${payload.user_id}> as *${character.name}* the ${character.class} (L${character.level}).${partyLine}${rejectLine}`,
        ``,
        body,
      ].join("\n");

      const post = await postMessage(env.SLACK_BOT_TOKEN, {
        channel: payload.channel_id,
        text,
      });

      if (!post.ok || !post.ts) {
        await respondToCommand(payload.response_url, {
          response_type: "ephemeral",
          text: `Failed to start the quest: ${post.error ?? "unknown Slack error"}`,
        });
        return;
      }

      const questId = await createQuest(env.DB, {
        channel_id: payload.channel_id,
        thread_ts: post.ts,
        elite,
        scene,
        created_by: payload.user_id,
      });
      // Mana refills to max for the questing character at quest start. Anyone who
      // joins later via /sq join also gets a refill.
      await refillMana(env.DB, payload.user_id);

      // Auto-join validated invitees. Each one also gets a mana refill so they
      // start the quest fresh, same as the inviter.
      for (const j of joiners) {
        await joinQuest(env.DB, questId, j.slack_user_id);
        await refillMana(env.DB, j.slack_user_id);
        await appendLog(env.DB, questId, j.slack_user_id, "join", "invited at quest start");
      }
    } catch (err) {
      await respondToCommand(payload.response_url, {
        response_type: "ephemeral",
        text: `The narrator stumbled: ${(err as Error).message}`,
      });
    }
  })());

  return ephemeral("🎲 Rolling for initiative...");
}

// Builds the SceneJson for a new quest, with variant-specific shape:
//   standard   → existing behavior
//   boss       → bigger HP envelope, boss_phase=1
//   gauntlet   → first wave inline, remaining waves pre-generated and queued
async function buildQuestScene(
  env: Env,
  character: Character,
  elite: boolean,
  variant: QuestVariant,
): Promise<SceneJson> {
  if (variant === "boss") {
    const scene = await generateOpeningScene(env.AI, character, elite, "boss");
    return { ...scene, variant, boss_phase: 1 };
  }

  if (variant === "gauntlet") {
    const first = await generateOpeningScene(env.AI, character, elite, "gauntlet-wave", {
      wave: 1,
      total: GAUNTLET_WAVES,
    });
    const queue: GauntletWave[] = [];
    for (let i = 2; i <= GAUNTLET_WAVES; i++) {
      const next = await generateOpeningScene(env.AI, character, elite, "gauntlet-wave", {
        wave: i,
        total: GAUNTLET_WAVES,
      });
      queue.push({ name: next.monster_name, max_hp: next.monster_max_hp, scene: next.scene });
    }
    return {
      ...first,
      variant,
      wave: 1,
      total_waves: GAUNTLET_WAVES,
      upcoming_waves: queue,
    };
  }

  if (variant === "dungeon") {
    return buildDungeonScene(env, character, elite, variant);
  }

  return { ...(await generateOpeningScene(env.AI, character, elite, "standard")), variant };
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

  const failDamage = 4 + Math.max(1, character.level);
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));

  // Build every middle-pool room in parallel — they're independent. Sequential was
  // ~30s wall-clock for a 10-room pool; parallel is closer to the slowest single call.
  const middleNodePromises: Promise<ExpeditionNode>[] = poolTypes.map(async (type, i) => {
    const roomNum = i + 1;
    if (type === "combat") {
      const monster = await generateOpeningScene(env.AI, character, elite, "gauntlet-wave", { wave: roomNum, total: totalRoomsVisited });
      const node: ExpeditionNode = {
        type: "combat",
        scene: monster.scene,
        monster_name: monster.monster_name,
        monster_max_hp: monster.monster_max_hp,
        tier: monster.tier,
        drops_key: true,
        drops_key_tier: "bronze",
      };
      return node;
    }
    if (type === "trap") {
      const trap = await generateTrapRoom(env.AI, theme, roomNum, totalRoomsVisited);
      const node: ExpeditionNode = {
        type: "trap",
        scene: trap.scene,
        trap_choices: [
          { text: trap.options.str, emoji: "💪", skill: "str", fail_damage: failDamage },
          { text: trap.options.dex, emoji: "🔧", skill: "dex", fail_damage: failDamage },
          { text: trap.options.int, emoji: "📜", skill: "int", fail_damage: failDamage },
        ],
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
      const opts: LootOption[] = rolls.map((roll, j) => ({
        name: named[j].name,
        item_type: roll.type,
        power: roll.power,
        rarity: roll.rarity,
        flavor: named[j].flavor,
        weapon_range: roll.weapon_range ?? null,
      }));
      const node: ExpeditionNode = { type: "lockbox", scene: lockboxScene, loot_options: opts, lock_tier: lockTier };
      return node;
    }
    // npc
    const npcName = generateNpcName();
    const offerRoll = rollItem(baseTier);
    const [npc, offerNamed] = await Promise.all([
      generateNpcRoom(env.AI, theme, roomNum, totalRoomsVisited, npcName),
      resolveLootDrop(env, `${npcName}'s pack`, offerRoll),
    ]);
    const node: ExpeditionNode = {
      type: "npc",
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
    return node;
  });

  // Sub-boss + treasure loot also fire in parallel with the pool.
  const bossPromise = generateOpeningScene(env.AI, character, elite, "boss");
  // Treasure loot rolls don't depend on boss tier — fire them at baseTier+1 in parallel
  // (was: baseTier from boss, but boss tier is already character.level + elite bump).
  const treasureRolls = Array.from({ length: EXPEDITION_TREASURE_OPTIONS }, () => rollItem(baseTier + 1));
  const treasureNamedPromises = treasureRolls.map((roll) =>
    resolveLootDrop(env, "the dungeon's heart-chamber", roll),
  );

  const [middleNodes, boss, treasureNamed] = await Promise.all([
    Promise.all(middleNodePromises),
    bossPromise,
    Promise.all(treasureNamedPromises),
  ]);

  const nodes: ExpeditionNode[] = [...middleNodes];
  nodes.push({
    type: "combat",
    scene: boss.scene,
    monster_name: boss.monster_name,
    monster_max_hp: boss.monster_max_hp,
    tier: boss.tier,
    drops_key: true,
    drops_key_tier: "silver",
  });

  const treasureLoot: LootOption[] = treasureRolls.map((roll, i) => ({
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

  // Build the door pool: indices 1..poolMiddleCount-1 (entry index 0 is fixed start).
  // Shuffle so door pairs are random.
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
  );
}

function dungeonRoomLabel(t: ExpeditionNodeType): string {
  if (t === "combat") return "⚔️ Combat";
  if (t === "trap") return "⚠️ Trap";
  if (t === "lockbox") return "🔒 Lockbox";
  if (t === "npc") return "🤝 Encounter";
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

// Compact emoji-only icon for a room type — used in path-trail rendering.
function dungeonRoomIcon(t: ExpeditionNodeType): string {
  if (t === "combat") return "⚔️";
  if (t === "trap") return "⚠️";
  if (t === "lockbox") return "🔒";
  if (t === "npc") return "🤝";
  return "🎁";
}

// One-line trail showing visited rooms (with the current one bracketed) and `?`
// placeholders for what's still ahead. Reads visited_indices for path order; falls
// back to a coarse approximation if that field is missing on legacy saves.
function renderPathTrail(exp: ExpeditionState): string {
  const visited = exp.visited_indices ?? [exp.current];
  const middleTotal = (exp.middle_count ?? 0) + 2;
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
function renderDungeonMap(exp: ExpeditionState): string {
  const visited = exp.visited_indices ?? [exp.current];
  const sealed = exp.sealed_doors ?? [];
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
    } else if (node.type === "treasure") {
      line = `▸ ${label}  _heart-chamber_`;
    } else if (i === visited.length - 2 && node.type === "combat") {
      // The penultimate visited node is the sub-boss in completed dungeons.
      line = `▸ ${label}  _sub-boss_`;
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
function renderDungeonRoom(node: ExpeditionNode, exp: ExpeditionState, cmd: string): string {
  // Display X/Y in terms of VISITED rooms, not the door-pool size. visited_count
  // is the player's path length so far; middle_count + 2 is the total they'll visit.
  const visited = exp.visited_count ?? 1;
  const middleTotal = (exp.middle_count ?? 0) + 2; // + sub-boss + treasure
  const trail = renderPathTrail(exp);
  const header = `*Room ${visited}/${middleTotal}* — ${dungeonRoomLabel(node.type)}\n${trail}`;
  const sceneBlock = blockQuote(node.scene);

  if (node.type === "combat") {
    return [
      header,
      sceneBlock,
      "",
      `Foe: *${node.monster_name}* — HP ${node.monster_max_hp}`,
      "",
      `Combat: \`${cmd} attack\` • \`${cmd} cast\` • \`${cmd} signature\`.`,
    ].join("\n");
  }
  if (node.type === "trap") {
    const choices = (node.trap_choices ?? []).map((c, i) =>
      `\`${i + 1}\` ${c.emoji} ${c.text}  _(${SKILL_META[c.skill].label})_`,
    );
    const dmg = node.trap_choices?.[0]?.fail_damage ?? 0;
    return [
      header,
      sceneBlock,
      "",
      ...choices,
      "",
      `_Failing rolls 1d6, need 4+. Fail = take *${dmg}* HP. Class with the matching skill auto-passes._ \`${cmd} choose <n>\``,
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

// Block Kit version of renderDungeonRoom — same content but with action buttons
// for trap/lockbox/npc/treasure choices. Combat rooms get no buttons (combat uses
// /sq attack/cast/sig). Action_id values route via /slack/interactive →
// handleInteraction → handleChoose / handleTake. value = the same idx the slash
// form takes.
function buildDungeonRoomBlocks(node: ExpeditionNode, exp: ExpeditionState, cmd: string): unknown[] {
  const visited = exp.visited_count ?? 1;
  const middleTotal = (exp.middle_count ?? 0) + 2;
  const trail = renderPathTrail(exp);
  const header = `*Room ${visited}/${middleTotal}* — ${dungeonRoomLabel(node.type)}\n${trail}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: header } },
    { type: "section", text: { type: "mrkdwn", text: blockQuote(node.scene) } },
  ];

  if (node.type === "combat") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `Foe: *${node.monster_name}* — HP ${node.monster_max_hp}\n\nCombat: \`${cmd} attack\` • \`${cmd} cast\` • \`${cmd} signature\`.` },
    });
    return blocks;
  }

  if (node.type === "trap") {
    const choices = node.trap_choices ?? [];
    const optionLines = choices.map((c, i) =>
      `\`${i + 1}\` ${c.emoji} ${c.text}  _(${SKILL_META[c.skill].label})_`,
    ).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: optionLines } });
    blocks.push({
      type: "actions",
      block_id: "dungeon_trap",
      elements: choices.map((c, i) => ({
        type: "button",
        action_id: "dungeon_choose",
        value: String(i + 1),
        text: { type: "plain_text", text: `${c.emoji} ${SKILL_META[c.skill].label}` },
      })),
    });
    const dmg = choices[0]?.fail_damage ?? 0;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_Failing rolls 1d6, need 4+. Fail = take *${dmg}* HP. Class with the matching skill auto-passes._` }],
    });
    return blocks;
  }

  if (node.type === "lockbox") {
    const opts = node.loot_options ?? [];
    const lockTier = node.lock_tier ?? "bronze";
    const optionLines = opts.map((l, i) => {
      const power = l.item_type === "consumable" ? `heals ${l.power}` : `+${l.power}`;
      return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
    }).join("\n");
    const lockBadge = `${KEY_EMOJI[lockTier]} *${lockTier}* lock — needs ${KEY_EMOJI[lockTier]} ${lockTier}+ key.`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${lockBadge}\n${optionLines}` } });
    const skipNum = opts.length + 1;
    const buttons: unknown[] = opts.map((_, i) => ({
      type: "button",
      action_id: "dungeon_choose",
      value: String(i + 1),
      text: { type: "plain_text", text: `${KEY_EMOJI[lockTier]} Claim ${i + 1}` },
      style: "primary",
    }));
    buttons.push({
      type: "button",
      action_id: "dungeon_choose",
      value: String(skipNum),
      text: { type: "plain_text", text: "Skip" },
    });
    blocks.push({ type: "actions", block_id: "dungeon_lockbox", elements: buttons });
    return blocks;
  }

  if (node.type === "npc") {
    const item = node.npc?.item;
    const greeting = `> "${node.npc?.greeting ?? "..."}"`;
    const itemLine = item
      ? `\nOffers: ${RARITY_BADGE[item.rarity]} *${item.name}* — ${item.item_type}, ${item.item_type === "consumable" ? `heals ${item.power}` : `+${item.power}`}`
      : "";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${greeting}${itemLine}` } });
    blocks.push({
      type: "actions",
      block_id: "dungeon_npc",
      elements: [
        { type: "button", action_id: "dungeon_choose", value: "1", text: { type: "plain_text", text: "🤝 Trust (take item)" }, style: "primary" },
        { type: "button", action_id: "dungeon_choose", value: "2", text: { type: "plain_text", text: "👋 Refuse" } },
      ],
    });
    return blocks;
  }

  // treasure
  const opts = node.loot_options ?? [];
  const optionLines = opts.map((l, i) => {
    const power = l.item_type === "consumable" ? `heals ${l.power}` : `+${l.power}`;
    return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}`;
  }).join("\n");
  blocks.push({ type: "section", text: { type: "mrkdwn", text: optionLines } });
  blocks.push({
    type: "actions",
    block_id: "dungeon_treasure",
    elements: opts.map((_, i) => ({
      type: "button",
      action_id: "dungeon_take",
      value: String(i + 1),
      text: { type: "plain_text", text: `🎁 Take ${i + 1}` },
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
  const middleTotal = (exp.middle_count ?? 0) + 2;
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Two paths diverge* — Room ${visited + 1}/${middleTotal} ahead.\n${renderPathTrail(exp)}` },
    },
    {
      type: "actions",
      block_id: "dungeon_door",
      elements: doors.map((idx, i) => {
        const node = exp.nodes[idx];
        return {
          type: "button",
          action_id: "dungeon_choose",
          value: String(i + 1),
          text: { type: "plain_text", text: `🚪 Door ${i + 1}: ${dungeonRoomLabel(node.type)}` },
        };
      }),
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_First \`${cmd} choose <n>\` picks for the party. The unchosen door is sealed behind you._` }],
    },
  ];
  return blocks;
}

type CombatAction = "attack" | "cast" | "flee" | "signature";

async function handleCombat(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  action: CombatAction,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't act. Recover, then try again.");
  }

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral(`You're not on an active quest. Try \`${payload.command} quest\` or \`${payload.command} join\`.`);

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, ACTION_COOLDOWN_MS);
  if (cooldown > 0) {
    return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cooldown / 1000)}s.`);
  }

  const party = await getQuestParty(env.DB, quest.id);
  const fighters = party.filter(isFighter);

  // Equipment loaded once for both attack/cast and flee paths (failed flee takes a hit too).
  const [equippedWeapon, equippedArmor] = await Promise.all([
    getEquipped(env.DB, payload.user_id, "weapon"),
    getEquipped(env.DB, payload.user_id, "armor"),
  ]);

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
  // positioning concept (one fighter, one target).
  if (action === "attack" && character.position === "back" && fighters.length > 1) {
    const isRanged = (equippedWeapon?.weapon_range ?? "melee") === "ranged";
    if (!isRanged) {
      return ephemeral(
        `🏹 Back row can't melee — equip a *ranged* weapon to attack from here, or \`${payload.command} cast\` / \`${payload.command} signature\`, or \`${payload.command} position front\`.`,
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

  if (action === "signature") {
    const sig = signatureFor(character.class);
    if (!sig) return ephemeral("Your class has no signature ability.");
    if (character.mana < 1) {
      return ephemeral(
        `Out of mana — \`${payload.command} signature\` refills between quests. (${character.mana}/${character.max_mana})`,
      );
    }

    // SRE Warden's Bulwark Strike folds equipped armor into the "weapon" slot of
    // the signature formula — armor power becomes its own attack stat.
    const wpnPower = equippedWeapon?.power ?? 0;
    const armorPower = equippedArmor?.power ?? 0;
    const sigWpn = cls.id === "sre_warden" ? wpnPower + armorPower : wpnPower;

    const sigResult = resolveSignature(
      cls.id,
      cls.attack_mod,
      cls.magic_mod,
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

    playerLine = isCrit
      ? `💥 *${sig.name} CRIT!* <@${payload.user_id}> hits for *${damage}* \`${sigResult.formula} ×2\`.`
      : `✨ *${sig.name}* — <@${payload.user_id}> hits for *${damage}* \`${sigResult.formula}\`.`;
  } else {
    const isMagic = action === "cast";
    const classMod = isMagic ? cls.magic_mod : cls.attack_mod;
    const weaponMod = equippedWeapon?.power ?? 0;
    const verb = isMagic ? "casts" : "attacks";

    const hit = resolvePlayerHit(action, classMod, weaponMod, rollDice);
    damage = hit.damage;
    isCrit = hit.isCrit;

    const modBreakdown = weaponMod > 0 ? `${classMod}+${weaponMod}` : `${hit.totalMod}`;
    playerLine = isCrit
      ? `💥 *CRIT!* <@${payload.user_id}> ${verb} for *${damage}* \`${hit.roll}×2 + ${modBreakdown}\`.`
      : `<@${payload.user_id}> ${verb} for *${damage}* \`${hit.roll} + ${modBreakdown}\`.`;
  }

  const newMonsterHp = quest.scene.monster_hp - damage;
  const willKill = newMonsterHp <= 0;

  // Boss phase 1 → 2 transition: crossing the 50% HP threshold powers it up.
  // Bake the flag into the scene so the same atomic write applies HP + phase together.
  let updatedScene: SceneJson = { ...quest.scene, monster_hp: Math.max(0, newMonsterHp) };
  let bossPhaseTransition = false;
  if (
    !willKill &&
    quest.scene.variant === "boss" &&
    quest.scene.boss_phase === 1 &&
    isBossPhaseTransition(quest.scene.monster_max_hp, quest.scene.monster_hp, newMonsterHp)
  ) {
    bossPhaseTransition = true;
    updatedScene.boss_phase = 2;
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

  if (manaCost > 0) {
    // Mana deduct is conditional too — covers the (rare) case where a player races
    // two simultaneous signatures with mana=1. Loser gets the mana refund implicitly
    // by failing the WHERE clause; the scene update has already landed for them which
    // means the damage applied — small inconsistency, accepted for v1.
    await tryDeductMana(env.DB, payload.user_id, manaCost);
  }
  await appendLog(env.DB, quest.id, payload.user_id, action, `${damage} dmg${willKill ? " (kill)" : ""}`);

  if (willKill) {
    // Gauntlet: advance to next wave instead of triggering victory.
    if (quest.scene.variant === "gauntlet" && quest.scene.upcoming_waves && quest.scene.upcoming_waves.length > 0) {
      return resolveGauntletAdvance(payload, env, ctx, quest, [playerLine, `🏆 *${quest.scene.monster_name}* falls.`]);
    }
    // Expedition (dungeon): branch on whether this was a mid-dungeon room or the
    // final sub-boss. The next room being treasure means we just killed the boss.
    if (quest.scene.variant === "dungeon") {
      const exp = quest.scene.expedition;
      const currentNode = exp?.nodes[exp.current];
      const preamble: string[] = [playerLine, `🏆 *${quest.scene.monster_name}* falls.`];
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
      `🏆 *${quest.scene.monster_name}* falls.`,
    ]);
  }

  // Monster turn — see performMonsterTurn for targeting + damage logic.
  const isMagic = action === "cast";
  const turn = await performMonsterTurn(env, quest, fighters, character, equippedArmor);

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, turn.monsterLine]);
  }

  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name}`);

  const shieldDisplay = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const ephemeralLines = [
    playerLine,
    `*${quest.scene.monster_name}*: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp}`,
    turn.monsterLine,
    `*${turn.target.name}*: ${turn.dmg.newHp}/${turn.target.max_hp}${shieldDisplay}`,
  ];

  // For the thread cards: show the actor (whose action this was). If they weren't the
  // target, their stats are unchanged from pre-turn — still informative.
  const updatedActor: Character = turn.victimWasActor
    ? { ...character, hp: turn.dmg.newHp, shield: turn.dmg.newShield }
    : character;

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

    // Both player + monster lines already include the dice math (e.g. "5 dmg `3 + 2`"
     // and "hits back for 4 `4 − 0 armor` — 2 absorbed by shield, 2 to HP"), so they
     // double as the events section.
    const events = [playerLine, turn.monsterLine];

    // Notification fallback: plain text. Block Kit drives the actual visual layout.
    const fallbackText = [
      blockQuote(narration),
      "",
      ...events,
      "",
      formatMonsterLine(quest.scene, newMonsterHp),
      `*${updatedActor.name}* — ${updatedActor.hp}/${updatedActor.max_hp}${updatedActor.shield > 0 ? ` 🛡${updatedActor.shield}` : ""}`,
    ].join("\n");
    const blocks = buildCombatBlocks({
      narration,
      events,
      scene: quest.scene,
      monsterHp: newMonsterHp,
      actor: updatedActor,
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
    if (!partyContinues) await markQuestStatus(env.DB, quest.id, "failed");

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
  const monster = resolveMonsterHit(
    quest.scene.tier,
    fighters.length,
    equippedArmor?.power ?? 0,
    quest.scene.variant === "boss" && quest.scene.boss_phase === 2,
    rollDice,
  );
  const dmg = applyDamageWithShield(monster.final, character.shield, character.hp);
  const playerHpAfter = dmg.newHp;
  const shieldPart = dmg.shieldAbsorbed > 0
    ? ` \`${dmg.shieldAbsorbed} absorbed by shield\``
    : "";
  const intro = `🪤 <@${payload.user_id}> trips on the way out. *${quest.scene.monster_name}* lands a free hit for *${monster.final}*${shieldPart}.`;

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
  const totalXp = (10 + quest.scene.tier * 5) * mult;
  const totalGold = (5 + quest.scene.tier * 3) * mult;
  const xpEach = Math.max(1, Math.floor(totalXp / fighters.length));
  const goldEach = Math.max(0, Math.floor(totalGold / fighters.length));

  const levelUpLines: string[] = [];
  for (const fighter of fighters) {
    const result = await awardSpoils(
      env.DB,
      fighter,
      xpEach,
      goldEach,
      () => rollDice(6),
      xpForLevel,
      MAX_MANA_CAP,
    );
    if (result.levelsGained > 0) {
      const manaPart = result.newMaxMana > fighter.max_mana ? `, max mana ${result.newMaxMana}` : "";
      levelUpLines.push(
        `🎚️ *${fighter.name}* hits Level ${result.newLevel} (max HP ${result.newMaxHp}${manaPart}).`,
      );
    }
  }

  // Roll loot independently per fighter so everyone has skin in the kill.
  const variantDrop = variantDropChance(quest.scene.variant, quest.scene.tier);
  const lootRolls = fighters
    .map((f) => ({ fighter: f, roll: rollItem(quest.scene.tier) }))
    .filter(() => Math.random() < variantDrop);

  await markQuestStatus(env.DB, quest.id, "completed");
  await appendLog(env.DB, quest.id, payload.user_id, "victory", `+${xpEach}xp/+${goldEach}g × ${fighters.length}, ${lootRolls.length} drops`);

  const ephemeralLines = [
    ...preamble,
    `✨ Spoils split across ${fighters.length}: +${xpEach} XP, +${goldEach} gold each.`,
    ...levelUpLines,
  ];
  if (lootRolls.length > 0) {
    ephemeralLines.push(
      `🎁 ${lootRolls.length} drop${lootRolls.length > 1 ? "s" : ""}! Check \`${payload.command} inventory\` once narration posts.`,
    );
  }

  ctx.waitUntil((async () => {
    const flavor = await flavorVictory(env.AI, killer, quest.scene.monster_name, fighters.length);
    const lootLines: string[] = [];
    for (const { fighter, roll } of lootRolls) {
      const named = await resolveLootDrop(env, quest.scene.monster_name, roll);
      const item = await addItem(env.DB, {
        character_id: fighter.slack_user_id,
        item_name: named.name,
        item_type: roll.type,
        power: roll.power,
        rarity: roll.rarity,
        flavor: named.flavor,
        weapon_range: roll.weapon_range ?? null,
      });
      const powerStr = powerLabel(roll.type, roll.power);
      const rangeNote = roll.weapon_range ? ` ${roll.weapon_range === "ranged" ? "🏹" : "⚔️"}` : "";
      lootLines.push(
        `${RARITY_BADGE[roll.rarity]} *${fighter.name}* finds *${item.item_name}* (${roll.type}${rangeNote}, ${powerStr}) — _${named.flavor}_`,
      );
    }
    const body = [
      `✨ +${xpEach} XP, +${goldEach} gold to each of ${fighters.length} fighter${fighters.length > 1 ? "s" : ""}.`,
      ...levelUpLines,
      ...lootLines,
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
    const flavor = await flavorGauntletNext(env.AI, previousMonster, next.name, waveLabel);
    const intro = `⚔️ ${flavor}`;
    const tail = `⚔️ *${waveLabel}* — *${next.name}* (HP ${next.max_hp})\n${blockQuote(next.scene)}`;
    // Mid-quest wave transition stays in-thread.
    await postToThread(env, quest, `${blockQuote(intro)}\n\n${tail}`);
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
    await markQuestStatus(env.DB, quest.id, "completed");
    return ephemeral([...preamble, "_(no treasure node found — quest closed.)_"].join("\n"));
  }

  const updatedExp: ExpeditionState = { ...exp, current: treasureIdx };
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
    const power = powerLabel(l.item_type, l.power);
    return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}\n   _${l.flavor}_`;
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
  const totalXp = (10 + quest.scene.tier * 5) * mult;
  const totalGold = (5 + quest.scene.tier * 3) * mult;
  const xpEach = Math.max(1, Math.floor(totalXp / partySize));
  const goldEach = Math.max(0, Math.floor(totalGold / partySize));

  const levelUpLines: string[] = [];
  for (const fighter of fighters) {
    const result = await awardSpoils(env.DB, fighter, xpEach, goldEach, () => rollDice(6), xpForLevel, MAX_MANA_CAP);
    if (result.levelsGained > 0) {
      const manaPart = result.newMaxMana > fighter.max_mana ? `, max mana ${result.newMaxMana}` : "";
      levelUpLines.push(
        `🎚️ *${fighter.name}* hits Level ${result.newLevel} (max HP ${result.newMaxHp}${manaPart}).`,
      );
    }
  }

  await markQuestStatus(env.DB, quest.id, "completed");
  await appendLog(env.DB, quest.id, payload.user_id, "expedition_complete", `taker:${taker.name}, item:${takenItem.item_name}`);

  ctx.waitUntil((async () => {
    const flavor = await flavorVictory(env.AI, taker, quest.scene.monster_name, partySize);
    const map = quest.scene.expedition ? renderDungeonMap(quest.scene.expedition) : "";
    const body = [
      `🎁 *${taker.name}* claims *${takenItem.item_name}* (${takenItem.item_type}, ${powerLabel(takenItem.item_type, takenItem.power)}).`,
      `✨ +${xpEach} XP, +${goldEach} gold to each of ${partySize} fighter${partySize > 1 ? "s" : ""}.`,
      ...levelUpLines,
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
  const middleTotal = (exp.middle_count ?? 0) + 2;
  const lines = [
    `*Two paths diverge* — Room ${visited + 1}/${middleTotal} ahead.`,
    renderPathTrail(exp),
  ];
  for (let i = 0; i < doors.length; i++) {
    const node = exp.nodes[doors[i]];
    lines.push(`\`${i + 1}\` ${dungeonRoomLabel(node.type)}`);
  }
  lines.push("", `_First \`${cmd} choose <n>\` picks for the party. The unchosen door is sealed behind you._`);
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
  const subBossIdx = exp.nodes.length - 2;
  const treasureIdx = exp.nodes.length - 1;
  const pool = [...(exp.pool ?? [])];

  if (exp.current === subBossIdx) {
    return { type: "node", index: treasureIdx, remainingPool: pool };
  }
  if (pool.length >= 2) {
    const a = pool.shift()!;
    const b = pool.shift()!;
    return { type: "doors", pair: [a, b], remainingPool: pool };
  }
  if (pool.length === 1) {
    const idx = pool.shift()!;
    return { type: "node", index: idx, remainingPool: pool };
  }
  return { type: "node", index: subBossIdx, remainingPool: pool };
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
    ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
    const ephemBlocks = [
      { type: "section", text: { type: "mrkdwn", text: preamble.join("\n") } },
      ...doorBlocks,
    ];
    return { text: [...preamble, "", prompt].join("\n"), response_type: "ephemeral", blocks: ephemBlocks };
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
  };

  const advanced = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!advanced) return ephemeral("Someone else already advanced the party.");
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `→ idx ${newCurrent}`);

  const roomBody = renderDungeonRoom(nextNode, updatedExp, payload.command);
  const threadText = [blockQuote(preamble.join("\n")), "", roomBody].join("\n");
  const roomBlocks = buildDungeonRoomBlocks(nextNode, updatedExp, payload.command);
  const threadBlocks = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(preamble.join("\n")) } },
    ...roomBlocks,
  ];
  ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
  const ephemBlocks = [
    { type: "section", text: { type: "mrkdwn", text: preamble.join("\n") } },
    ...roomBlocks,
  ];
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
  };

  const ok = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!ok) return ephemeral("Someone else already opened a door.");
  await appendLog(env.DB, quest.id, payload.user_id, "dungeon", `door pick → ${chosenNodeIdx} (sealed ${otherIdx})`);

  const roomBody = renderDungeonRoom(chosenNode, updatedExp, payload.command);
  const headLine = `🚪 <@${payload.user_id}> opens Door ${pickIdx} — ${dungeonRoomLabel(chosenNode.type).toLowerCase()}.`;
  const threadText = [blockQuote(headLine), "", roomBody].join("\n");
  const roomBlocks = buildDungeonRoomBlocks(chosenNode, updatedExp, payload.command);
  const threadBlocks = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(headLine) } },
    ...roomBlocks,
  ];
  ctx.waitUntil(postToThread(env, quest, threadText, { blocks: threadBlocks }));
  const ephemBlocks = [
    { type: "section", text: { type: "mrkdwn", text: headLine } },
    ...roomBlocks,
  ];
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
  if (!quest) return ephemeral("You're not on an active quest.");
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
  if (!node || (node.type !== "trap" && node.type !== "lockbox" && node.type !== "npc")) {
    return ephemeral("No room choice to make right now.");
  }

  if (node.type === "trap") {
    return resolveTrapChoice(payload, env, ctx, character, quest, exp, node, idx);
  }
  if (node.type === "lockbox") {
    return resolveLockboxChoice(payload, env, ctx, character, quest, exp, node, idx);
  }
  return resolveNpcChoice(payload, env, ctx, character, quest, exp, node, idx);
}

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
  let passed: boolean;
  let rollNote: string;
  if (isExpert) {
    passed = true;
    rollNote = `*${cls.name}* expert at ${SKILL_META[choice.skill].label} — auto-pass.`;
  } else {
    const roll = rollDice(6);
    passed = roll >= 4;
    rollNote = `1d6 = *${roll}* — ${passed ? "pass (≥4)" : "fail (<4)"}.`;
  }

  const actorHpAfter = passed ? character.hp : Math.max(0, character.hp - choice.fail_damage);
  const headLine = passed
    ? `⚠️ <@${payload.user_id}> chose ${choice.emoji} *${choice.text}*. ${rollNote}`
    : `⚠️ <@${payload.user_id}> chose ${choice.emoji} *${choice.text}*. ${rollNote} Takes *${choice.fail_damage}* HP.`;

  await appendLog(
    env.DB, quest.id, payload.user_id,
    "trap",
    `${choice.skill} ${passed ? "pass" : `fail -${choice.fail_damage}HP`}`,
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
  // Trust — take the offered item.
  const offer = node.npc?.item;
  if (!offer) {
    return advanceDungeonRoom(payload, env, ctx, quest, character, [
      `🤝 The stranger fades into the gloom with nothing to give.`,
    ]);
  }
  const item = await addItem(env.DB, {
    character_id: payload.user_id,
    item_name: offer.name,
    item_type: offer.item_type,
    power: offer.power,
    rarity: offer.rarity,
    flavor: offer.flavor,
    weapon_range: offer.weapon_range ?? null,
  });
  await appendLog(env.DB, quest.id, payload.user_id, "npc", `trusted, took ${item.item_name}`);

  const headline = `🤝 <@${payload.user_id}> trusts the stranger — claims ${RARITY_BADGE[offer.rarity]} *${offer.name}* (id \`${item.id}\`).`;
  return advanceDungeonRoom(payload, env, ctx, quest, character, [headline]);
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
  if (!quest) return ephemeral("You're not on an active quest.");
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
    const recoveryTs = Math.floor((Date.now() + DOWNED_COOLDOWN_MS) / 1000);
    ephemeralLines.push(
      `💀 *${character.name}* is *downed*.`,
      `Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_.`,
      `Recover by <!date^${recoveryTs}^{date_short_pretty} {time}|in ~12h>.`,
    );
    resultTail = `💀 *${character.name}* is downed. Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_. Recover <!date^${recoveryTs}^{date_short_pretty}|in ~12h>.`;
  }

  if (questEnds) {
    await markQuestStatus(env.DB, quest.id, "failed");
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

  // Joiners also get a mana refill — same effect as starting the quest yourself.
  await refillMana(env.DB, payload.user_id);

  const scaled = await scaleMonsterForJoin(env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
  await appendLog(env.DB, quest.id, payload.user_id, "join", `monster +${scaled.monster_max_hp - quest.scene.monster_max_hp} HP`);

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
async function handleLook(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) {
    return ephemeral(`You're not on an active quest. Try \`${payload.command} quest\` to start one.`);
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
      return {
        text: renderDungeonRoom(node, exp, payload.command),
        response_type: "ephemeral",
        blocks: buildDungeonRoomBlocks(node, exp, payload.command),
      };
    }
  }

  // Non-dungeon: show monster + scene.
  const lines = [`*${quest.scene.monster_name}* — HP ${quest.scene.monster_hp}/${quest.scene.monster_max_hp}`];
  if (quest.scene.variant === "gauntlet" && quest.scene.wave && quest.scene.total_waves) {
    lines.push(`Wave ${quest.scene.wave}/${quest.scene.total_waves}`);
  }
  if (quest.scene.variant === "boss" && quest.scene.boss_phase === 2) {
    lines.push(`_Phase 2 — enraged_`);
  }
  lines.push("", blockQuote(quest.scene.scene));
  return ephemeral(lines.join("\n"));
}

async function handleInventory(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
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
  const orderedItems = [...equippedItems, ...packItems];

  // Per-item: section block (item description) + actions block ([Equip] [Use] [Sell]).
  // The actions block carries action_id values that the /slack/interactive endpoint
  // routes via handleInteraction. value = inventory id as string.
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Inventory — ${items.length} item${items.length > 1 ? "s" : ""}` },
    },
  ];
  if (equippedItems.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*✅ Equipped — ${equippedItems.length}*` },
    });
  }
  let firstPackItem = equippedItems.length > 0;
  for (const item of orderedItems) {
    // When we transition from equipped → pack, drop a visual divider + label.
    if (firstPackItem && !item.equipped) {
      blocks.push({ type: "divider" });
      if (packItems.length > 0) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*🎒 Pack — ${packItems.length}*` },
        });
      }
      firstPackItem = false;
    }
    const equipPrefix = item.equipped ? "✅ " : "";
    const powerStr = powerLabel(item.item_type, item.power);
    const flavorLine = item.flavor ? `\n_${item.flavor}_` : "";
    const summary = `${equipPrefix}\`${item.id}\` ${RARITY_BADGE[item.rarity]} *${item.item_name}* — ${item.item_type}${rangeBadge(item)}, ${powerStr}${flavorLine}`;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: summary },
    });

    // Build the action row. Equip is only meaningful for weapon/armor; Use is only
    // for consumable/magic/revive/tool/scroll. Sell always available.
    const elements: unknown[] = [];
    const isEquippable = item.item_type === "weapon" || item.item_type === "armor";
    const isUsable =
      item.item_type === "consumable" ||
      item.item_type === "magic" ||
      item.item_type === "revive" ||
      item.item_type === "tool" ||
      item.item_type === "scroll";
    if (isEquippable && !item.equipped) {
      elements.push({
        type: "button",
        action_id: "equip",
        value: String(item.id),
        text: { type: "plain_text", text: "Equip" },
      });
    }
    if (isUsable) {
      elements.push({
        type: "button",
        action_id: "use",
        value: String(item.id),
        text: { type: "plain_text", text: "Use" },
        style: "primary",
      });
    }
    elements.push({
      type: "button",
      action_id: "sell",
      value: String(item.id),
      text: { type: "plain_text", text: `Sell ${sellPriceFor(item.item_type, item.rarity)}g` },
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Sell this item?" },
        text: { type: "mrkdwn", text: `Sell *${item.item_name}* for ${sellPriceFor(item.item_type, item.rarity)}g? This is permanent.` },
        confirm: { type: "plain_text", text: "Sell" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    });
    blocks.push({
      type: "actions",
      block_id: `inv_${item.id}`,
      elements,
    });
  }

  // Footer: keys + slash-command hints.
  const footerParts: string[] = [];
  if (keyLine) footerParts.push(keyLine);
  footerParts.push(`_Buttons require Slack interactivity. Slash forms: \`${payload.command} equip <id>\` • \`${payload.command} use <id>\` • \`${payload.command} sell <id>\`._`);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footerParts.join("  •  ") }],
  });

  // Plain-text fallback for clients/contexts that don't render Block Kit.
  const fallback = items
    .map((it) => `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}, ${powerLabel(it.item_type, it.power)}${it.equipped ? " ✅" : ""}`)
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

  await equipItem(env.DB, item);
  return ephemeral(
    `✅ Equipped *${item.item_name}* (${item.item_type}${rangeBadge(item)}, +${item.power}). Previous ${item.item_type} unequipped.`,
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

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} use <inventory id>\` (find ids with \`${payload.command} inventory\`).`);

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
    const result = await bumpMaxMana(env.DB, character, item.power, MAX_MANA_CAP);
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
//   2. Spend a combat turn (action cooldown + monster retaliation, like heal/shield).
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

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, ACTION_COOLDOWN_MS);
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
  return ephemeral(`*${item.item_name}* doesn't have a wired-up effect yet.`);
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

  // Monster turn — same plumbing as heal/shield post-effect.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, character, actorArmor);

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name}`);

  const monsterStat = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `*${turn.target.name}*: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, monsterStat, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", monsterStat, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
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

  // Monster gets a turn (still alive — we capped at 1).
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, character, actorArmor);

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [playerLine, turn.monsterLine]);
  }
  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name}`);

  const monsterStat = `*${quest.scene.monster_name}*: ${newMonsterHp}/${quest.scene.monster_max_hp}`;
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const targetStat = `*${turn.target.name}*: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [playerLine, monsterStat, turn.monsterLine, targetStat].join("\n");
  ctx.waitUntil(postToThread(env, quest, [blockQuote(playerLine), "", monsterStat, turn.monsterLine, targetStat].join("\n")));
  return ephemeral(ephem);
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
    return {
      text: formatShopText(existing, character.gold, payload.command),
      response_type: "ephemeral",
      blocks: formatShopBlocks(existing, character.gold, payload.command),
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

  const tier = Math.max(2, await averageCharacterLevel(env.DB));
  const playerCount = await countCharacters(env.DB);
  const stockSize = Math.min(
    SHOP_STOCK_CAP,
    SHOP_STOCK_BASE + Math.max(0, playerCount - SHOP_STOCK_PLAYER_BASELINE) * SHOP_STOCK_PER_EXTRA_PLAYER,
  );
  const generatedAt = Date.now();
  const items: Parameters<typeof insertShopStock>[1] = [];
  for (let i = 0; i < stockSize; i++) {
    const roll = rollItem(tier);
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
    });
  }
  await insertShopStock(env.DB, items);
}

// Plain-text shop summary (for fallback / non-Block-Kit clients).
function formatShopText(items: ShopItem[], gold: number, cmd: string): string {
  const lines = [`🛒 *Shop* — you have ${gold} gold`];
  for (const it of items) {
    const status = it.bought_by ? " ❌_sold_" : "";
    const powerStr = powerLabel(it.item_type, it.power);
    lines.push(
      `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}${rangeBadge(it)}, ${powerStr} • *${it.price}g*${status}`,
    );
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
function formatShopBlocks(items: ShopItem[], gold: number, cmd: string): unknown[] {
  const available = items.filter((i) => !i.bought_by).length;
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🛒 Shop — ${available}/${items.length} available` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `You have *${gold}g*. Cap: ${SHOP_BUY_CAP_PER_CYCLE} purchases per restock cycle.` }],
    },
    { type: "divider" },
  ];
  for (const it of items) {
    const sold = !!it.bought_by;
    const powerStr = powerLabel(it.item_type, it.power);
    const flavorLine = it.flavor ? `\n_${it.flavor}_` : "";
    const summaryRaw = `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}${rangeBadge(it)}, ${powerStr} • *${it.price}g*${flavorLine}`;
    // Sold items: render dimmed + tagged. We can't truly grey out a section in
    // Block Kit, so we strikethrough the name and append "❌ sold by <user>".
    const summary = sold
      ? `~${summaryRaw.replace(/\*([^*]+)\*/, "$1")}~  ❌ _sold to <@${it.bought_by}>_`
      : summaryRaw;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: summary } });

    if (!sold) {
      const canAfford = gold >= it.price;
      const button: Record<string, unknown> = {
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
      };
      blocks.push({
        type: "actions",
        block_id: `shop_${it.id}`,
        elements: [button],
      });
    }
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Slash form: \`${cmd} buy <id>\` • \`${cmd} sell <id>\`._` }],
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
  });
  return ephemeral(
    `🛍️ Bought ${RARITY_BADGE[stock.rarity]} *${stock.item_name}* for ${stock.price}g (now ${character.gold - stock.price}g). Inventory id \`${item.id}\`.`,
  );
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

  const price = sellPriceFor(item.item_type, item.rarity);
  await removeItem(env.DB, item.id);
  await addGold(env.DB, payload.user_id, price);
  return ephemeral(
    `💰 Sold *${item.item_name}* for ${price}g (now ${character.gold + price}g).`,
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
    `🎁 <@${payload.user_id}> gives *${item.item_name}* (${item.item_type}, ${powerLabel(item.item_type, item.power)}) to <@${target.slack_user_id}>.`,
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

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, ACTION_COOLDOWN_MS);
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
  const heal = resolveHeal(cls.magic_mod, rollDice);
  const healed = await healCharacter(env.DB, target, heal.amount);
  await tryDeductMana(env.DB, payload.user_id, 1);
  await appendLog(env.DB, quest.id, payload.user_id, "heal", `+${healed} HP → ${target.name}`);

  const targetTag = target.slack_user_id === payload.user_id
    ? `themselves`
    : `<@${target.slack_user_id}>`;
  const healLine = `💚 <@${payload.user_id}> heals ${targetTag} for *${healed}* HP \`${heal.roll} + ${cls.magic_mod}m\`.`;

  // Between-rooms / no-live-monster: skip retaliation. Heal still consumes mana
  // and triggers the cooldown — but no dead monster can hit back.
  if (!hasLiveMonster(quest)) {
    const healStat = `*${target.name}*: ${target.hp + healed}/${target.max_hp}`;
    ctx.waitUntil(postToThread(env, quest, [blockQuote(healLine), "", healStat].join("\n")));
    return ephemeral([healLine, healStat].join("\n"));
  }

  // Monster retaliates while you're channeling the heal — mana actions cost a turn,
  // so the monster gets one too. Pick target via the same position-weighted RNG.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, character, actorArmor);

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [healLine, turn.monsterLine]);
  }

  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name}`);

  const healStat = `*${target.name}*: ${target.hp + healed}/${target.max_hp}`;
  const targetShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const monsterStat = `*${turn.target.name}*: ${turn.dmg.newHp}/${turn.target.max_hp}${targetShield}`;
  const ephem = [healLine, healStat, turn.monsterLine, monsterStat].join("\n");

  // Thread post: heal + monster retaliation as the events, with monster + actor cards.
  const updatedActor: Character = turn.victimWasActor
    ? { ...character, hp: turn.dmg.newHp, shield: turn.dmg.newShield }
    : character;
  ctx.waitUntil((async () => {
    const blocks = buildCombatBlocks({
      narration: healLine,
      events: [healStat, turn.monsterLine],
      scene: quest.scene,
      monsterHp: quest.scene.monster_hp,
      actor: updatedActor,
    });
    const fallback = [blockQuote(healLine), "", healStat, turn.monsterLine, monsterStat].join("\n");
    await postToThread(env, quest, fallback, { blocks });
  })());

  return ephemeral(ephem);
}

async function handleShield(
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

  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, ACTION_COOLDOWN_MS);
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
    return ephemeral(`*${target.name}* is downed — can't shield a downed character.`);
  }

  const cls = classByName(character.class);
  const shield = resolveShield(cls.magic_mod, rollDice);
  const cap = target.max_hp * SHIELD_CAP_MULTIPLIER;
  const added = await addShield(env.DB, target, shield.amount, cap);
  await tryDeductMana(env.DB, payload.user_id, 1);
  await appendLog(env.DB, quest.id, payload.user_id, "shield", `+${added} sh → ${target.name}`);

  const targetTag = target.slack_user_id === payload.user_id
    ? `themselves`
    : `<@${target.slack_user_id}>`;
  const wasted = shield.amount - added;
  const wastedNote = wasted > 0 ? ` (${wasted} over the cap)` : "";
  const shieldLine = `🛡️ <@${payload.user_id}> shields ${targetTag} for *${added}*${wastedNote} \`${shield.roll} + ${cls.magic_mod}m\`.`;

  // Between-rooms / no-live-monster: skip retaliation. Shield still costs mana +
  // cooldown but a dead monster can't hit back.
  if (!hasLiveMonster(quest)) {
    const shieldStat = `*${target.name}*: 🛡${(target.shield ?? 0) + added}`;
    ctx.waitUntil(postToThread(env, quest, [blockQuote(shieldLine), "", shieldStat].join("\n")));
    return ephemeral([shieldLine, shieldStat].join("\n"));
  }

  // Monster retaliates on mana use, same as heal/cast.
  const fighters = (await getQuestParty(env.DB, quest.id)).filter(isFighter);
  const actorArmor = await getEquipped(env.DB, payload.user_id, "armor");
  const turn = await performMonsterTurn(env, quest, fighters, character, actorArmor);

  if (turn.willKillTarget) {
    return resolveDeath(payload, env, ctx, turn.target, quest, fighters, [shieldLine, turn.monsterLine]);
  }

  await setCharacterHpAndShield(env.DB, turn.target.slack_user_id, turn.dmg.newHp, turn.dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${turn.positionAdjusted} dmg → ${turn.target.name}`);

  const shieldStat = `*${target.name}*: 🛡${target.shield + added}/${cap}`;
  const turnShield = turn.dmg.newShield > 0 ? ` 🛡${turn.dmg.newShield}` : "";
  const monsterStat = `*${turn.target.name}*: ${turn.dmg.newHp}/${turn.target.max_hp}${turnShield}`;
  const ephem = [shieldLine, shieldStat, turn.monsterLine, monsterStat].join("\n");

  const updatedActor: Character = turn.victimWasActor
    ? { ...character, hp: turn.dmg.newHp, shield: turn.dmg.newShield }
    : character;
  ctx.waitUntil((async () => {
    const blocks = buildCombatBlocks({
      narration: shieldLine,
      events: [shieldStat, turn.monsterLine],
      scene: quest.scene,
      monsterHp: quest.scene.monster_hp,
      actor: updatedActor,
    });
    const fallback = [blockQuote(shieldLine), "", shieldStat, turn.monsterLine, monsterStat].join("\n");
    await postToThread(env, quest, fallback, { blocks });
  })());

  return ephemeral(ephem);
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
  const cooldown = await cooldownRemaining(env.DB, quest.id, payload.user_id, ACTION_COOLDOWN_MS);
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
    const cd = await cooldownRemaining(env.DB, activeQuest.id, payload.user_id, ACTION_COOLDOWN_MS);
    if (cd > 0) {
      return ephemeral(`⏳ Catching your breath — try again in ${Math.ceil(cd / 1000)}s.`);
    }
    await setPosition(env.DB, payload.user_id, target as BattlePosition);
    await appendLog(env.DB, activeQuest.id, payload.user_id, "position", `→ ${target}`);
    return ephemeral(
      target === "front"
        ? `🔼 You shoulder forward to *front* row. (Cooldown set, 45s.)`
        : `🔽 You retreat to *back* row. (Cooldown set, 45s.)`,
    );
  }

  // Out-of-quest reposition — free, no cooldown.
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
function powerLabel(itemType: Item["item_type"], power: number): string {
  if (itemType === "consumable") return `heals ${power}`;
  if (itemType === "magic") return `+${power} max mana`;
  if (itemType === "revive") return `revives @ ${power}% HP`;
  return `+${power}`;
}

// Compact range badge for weapons; empty for non-weapons.
function rangeBadge(item: { item_type: Item["item_type"]; weapon_range?: Item["weapon_range"] | null }): string {
  if (item.item_type !== "weapon") return "";
  return (item.weapon_range ?? "melee") === "ranged" ? " 🏹" : " ⚔️";
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
  return `*${scene.monster_name}*${phase} — ${Math.max(0, currentHp)}/${scene.monster_max_hp}`;
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
  return {
    type: "mrkdwn",
    text: `*${scene.monster_name}*${phase}\n${Math.max(0, currentHp)}/${scene.monster_max_hp} 🩸`,
  };
}

// Builds the Block Kit blocks for a combat-result thread post. Renders as:
//   1. Narration section (block-quoted markdown)
//   2. (optional) Events section — damage dealt / received / shield breakdown so
//      the actual mechanical outcome is visible alongside the AI flavor.
//   3. Two-card grid (monster, actor) — current state of the participants.
// Events is intentionally separate from narration: the AI doesn't include numbers
// (we tell it not to), so this section is where the dice math lives.
function buildCombatBlocks(opts: {
  narration: string;
  events?: string[];
  scene: SceneJson;
  monsterHp: number;
  actor: Character;
}): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: blockQuote(opts.narration) } },
    { type: "divider" },
  ];
  if (opts.events && opts.events.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: opts.events.join("\n") } });
    blocks.push({ type: "divider" });
  }
  blocks.push({ type: "section", fields: [monsterField(opts.scene, opts.monsterHp), characterField(opts.actor)] });
  return blocks;
}

interface MonsterTurnOutcome {
  target: Character;
  victimWasActor: boolean;
  monsterLine: string;          // formatted line for events section
  dmg: { newShield: number; newHp: number; shieldAbsorbed: number; hpDamage: number };
  positionAdjusted: number;     // damage after position modifier (pre-shield)
  willKillTarget: boolean;
}

// Resolves a monster's counter-attack: picks a target via pickMonsterTarget, computes
// damage through armor + position modifier + shield, and returns the outcome WITHOUT
// writing to DB. Caller decides to either route to resolveDeath or persist + narrate.
//
// Used by: handleCombat (attack/cast/sig), handleHeal, handleShield. Any "trigger
// monster on mana use" actions go through this so the retaliation rules stay
// centralized and consistent.
async function performMonsterTurn(
  env: Env,
  quest: ActiveQuest,
  fighters: Character[],
  actor: Character,
  actorArmor: Item | null,
): Promise<MonsterTurnOutcome> {
  const target = pickMonsterTarget(fighters, Math.random);
  const victimWasActor = target.slack_user_id === actor.slack_user_id;

  // Re-fetch armor for non-actor targets (the actor's armor was already loaded).
  const targetArmor = victimWasActor
    ? actorArmor
    : await getEquipped(env.DB, target.slack_user_id, "armor");

  const monster = resolveMonsterHit(
    quest.scene.tier,
    fighters.length,
    targetArmor?.power ?? 0,
    quest.scene.variant === "boss" && quest.scene.boss_phase === 2,
    rollDice,
  );

  const positionAdjusted = fighters.length > 1
    ? positionDamageMod(target.position, monster.final)
    : monster.final;

  const dmg = applyDamageWithShield(positionAdjusted, target.shield, target.hp);

  const armorPart = monster.armorReduction > 0
    ? ` \`${monster.raw} − ${monster.armorReduction} armor\``
    : "";
  const positionPart = fighters.length > 1 && target.position === "back" && positionAdjusted < monster.final
    ? ` (${target.position}-row: ${positionAdjusted})`
    : "";
  const shieldPart = dmg.shieldAbsorbed > 0
    ? ` — *${dmg.shieldAbsorbed}* absorbed by shield, *${dmg.hpDamage}* to HP`
    : "";
  const targetTag = victimWasActor ? "back" : `*${target.name}*`;
  const monsterLine = `*${quest.scene.monster_name}* hits ${targetTag} for *${positionAdjusted}*${armorPart}${positionPart}${shieldPart}.`;

  return {
    target,
    victimWasActor,
    monsterLine,
    dmg,
    positionAdjusted,
    willKillTarget: dmg.newHp <= 0,
  };
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

function ephemeral(text: string): CommandResponse {
  return { text, response_type: "ephemeral" };
}

function inChannel(text: string): CommandResponse {
  return { text, response_type: "in_channel" };
}
