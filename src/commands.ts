// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env } from "./index";
import {
  flavorBossPhase,
  flavorDeath,
  flavorFleeSuccess,
  flavorForkOutcome,
  flavorGauntletNext,
  flavorHit,
  flavorJoin,
  flavorLootDrop,
  flavorSignature,
  flavorVictory,
  generateExpeditionForkScene,
  generateExpeditionTheme,
  generateOpeningScene,
} from "./ai";
import {
  addGold,
  addItem,
  addShield,
  appendLog,
  applySoftDeath,
  averageCharacterLevel,
  awardSpoils,
  bumpMaxMana,
  claimShopItem,
  consumeItem,
  cooldownRemaining,
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
  removeItem,
  reviveCharacter,
  saveScene,
  scaleMonsterForJoin,
  setCharacterHp,
  setCharacterHpAndShield,
  trySaveExpeditionAdvance,
  tryDeductGold,
  tryDeductMana,
  tryUpdateScene,
  type ActiveQuest,
  type Character,
  type ExpeditionNode,
  type ExpeditionState,
  type GauntletWave,
  type Item,
  type QuestVariant,
  type SceneJson,
  type ShopItem,
} from "./db";
import {
  applyDamageWithShield,
  isBossPhaseTransition,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  resolveShield,
  resolveSignature,
} from "./combat";
import {
  classByName,
  dropChance,
  generateNpcName,
  generateScar,
  pickRandomClass,
  priceFor,
  rollDice,
  rollItem,
  sellPriceFor,
  signatureFor,
  xpForLevel,
  MAX_MANA_CAP,
  RARITY_BADGE,
  SHIELD_CAP_MULTIPLIER,
} from "./flavor";
import { postMessage, respondToCommand, type SlashCommandPayload } from "./slack";

export interface CommandResponse {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: unknown[];
}

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const ACTION_COOLDOWN_MS = 45 * 1000;
const JOIN_HP_RATIO = 0.4; // monster max HP grows by this fraction per joiner
const SHOP_RESTOCK_MS = 6 * 60 * 60 * 1000; // 6h channel-wide restock cadence
const SHOP_STOCK_SIZE = 5;
const BOSS_LEVEL_REQUIRED = 3;
const GAUNTLET_LEVEL_REQUIRED = 5;
const GAUNTLET_WAVES = 3;
const EXPEDITION_LEVEL_REQUIRED = 4;
const EXPEDITION_FORKS = 3;
const EXPEDITION_TREASURE_OPTIONS = 2;

// Help text uses the actual slash command name the operator installed under (e.g. /sq,
// /quest, /raid). Slack's /dnd is reserved for Do Not Disturb so don't pick that.
function helpText(cmd: string): string {
  return [
    "*Slack Quest commands*",
    `• \`${cmd} roll\` — roll a new character`,
    `• \`${cmd} me\` — show your character sheet`,
    `• \`${cmd} quest\` — start a standard quest`,
    `• \`${cmd} quest boss\` — single tougher monster, 2 phases (L3+, 2× rewards)`,
    `• \`${cmd} quest gauntlet\` — 3 monsters back-to-back, no flee (L5+, 3× rewards, guaranteed drop)`,
    `• \`${cmd} quest expedition\` — 3 narrative forks → boss → treasure pick (L4+, 2.5× rewards)`,
    `• \`${cmd} quest elite\` — elite modifier; perma-death (composes: \`${cmd} quest boss elite\`)`,
    `• \`${cmd} choose <n>\` — pick a fork option in an expedition (first vote wins)`,
    `• \`${cmd} take <n>\` — claim an item from an expedition treasure room`,
    `• \`${cmd} join\` — join the active quest in this channel`,
    `• \`${cmd} attack\` — strike with weapon (1d6 + atk_mod + weapon power, crit on nat 6)`,
    `• \`${cmd} cast\` — channel magic (1d8 + mag_mod + weapon power, crit on nat 8)`,
    `• \`${cmd} flee\` — try to escape (1d2; on fail you take a free hit)`,
    `• \`${cmd} signature\` (alias \`sig\`) — your class's signature ability (costs 1 mana, refills between quests)`,
    `• \`${cmd} heal [@user]\` — restore 1d6 + magic_mod HP on a party member (costs 1 mana, default self)`,
    `• \`${cmd} shield [@user]\` — buff 1d6 + magic_mod absorbing HP on a party member (costs 1 mana, default self)`,
    `• \`${cmd} revive <id> @user\` — bring a downed party member back, consuming a revive item`,
    `• \`${cmd} inventory\` — list your items (equipped marked ✅)`,
    `• \`${cmd} equip <id>\` — equip a weapon or armor by inventory id`,
    `• \`${cmd} use <id>\` — use a consumable (free action, no cooldown)`,
    `• \`${cmd} shop\` — view the channel's shop (restocks every 6h)`,
    `• \`${cmd} buy <id>\` — purchase a shop item with gold`,
    `• \`${cmd} sell <id>\` — sell an inventory item for 30% of shop price`,
    `• \`${cmd} party\` — show the current quest's roster + HP`,
    `• \`${cmd} leaderboard\` — top 10 heroes`,
    `• \`${cmd} help\` — show this list`,
    "_Combat actions have a 45-second cooldown per player._",
  ].join("\n");
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
      return handleRoll(payload, env);
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
    case "equip":
      return handleEquip(payload, args, env);
    case "use":
      return handleUse(payload, args, env);
    case "shop":
      return handleShop(payload, env, ctx);
    case "buy":
      return handleBuy(payload, args, env);
    case "sell":
      return handleSell(payload, args, env);
    case "choose":
      return handleChoose(payload, args, env, ctx);
    case "take":
      return handleTake(payload, args, env, ctx);
    case "help":
    case "":
      return ephemeral(helpText(payload.command));
    default:
      return ephemeral(`Unknown command: \`${sub}\`. Try \`${payload.command} help\`.`);
  }
}

async function handleRoll(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const existing = await getCharacter(env.DB, payload.user_id);
  if (existing) {
    return ephemeral(
      `You already have a character: *${existing.name}* the ${existing.class} (L${existing.level}). Use \`${payload.command} me\` to see the sheet.`,
    );
  }

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

  return inChannel(
    [
      `🎲 <@${payload.user_id}> rolls a new hero!`,
      ``,
      `*${character.name}*, the ${character.class}`,
      `_${cls.blurb}_`,
      `Level ${character.level} • HP ${character.hp}/${character.max_hp} • ${character.gold} gold`,
    ].join("\n"),
  );
}

async function handleMe(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const c = await getCharacter(env.DB, payload.user_id);
  if (!c) return ephemeral(`You haven't rolled a character yet. Try \`${payload.command} roll\`.`);
  return ephemeral(formatSheet(c));
}

function formatSheet(c: Character): string {
  const downedNote = c.downed_until && c.downed_until > Date.now()
    ? `\n💀 _Downed until <!date^${Math.floor(c.downed_until / 1000)}^{date_short_pretty} {time}|soon>_`
    : "";
  const scarLine = c.scars.length ? `\nScars: ${c.scars.join(", ")}` : "";
  const sig = signatureFor(c.class);
  const sigLine = sig ? `\nSignature: *${sig.name}* — _${sig.blurb}_` : "";
  return [
    `*${c.name}*, the ${c.class}`,
    `Level ${c.level} • XP ${c.xp}`,
    `HP ${c.hp}/${c.max_hp} • Mana ${c.mana}/${c.max_mana} • ${c.gold} gold`,
    `${sigLine}${scarLine}${downedNote}`,
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
    : lower.includes("expedition")
    ? "expedition"
    : "standard";

  if (variant === "boss" && character.level < BOSS_LEVEL_REQUIRED) {
    return ephemeral(`Boss quests require Level ${BOSS_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }
  if (variant === "gauntlet" && character.level < GAUNTLET_LEVEL_REQUIRED) {
    return ephemeral(`Gauntlets require Level ${GAUNTLET_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }
  if (variant === "expedition" && character.level < EXPEDITION_LEVEL_REQUIRED) {
    return ephemeral(`Expeditions require Level ${EXPEDITION_LEVEL_REQUIRED}+. You're L${character.level}.`);
  }

  ctx.waitUntil((async () => {
    try {
      const scene = await buildQuestScene(env, character, elite, variant);
      const eliteBanner = elite ? "⚠️ *ELITE — perma-death enabled* ⚠️\n" : "";
      const variantBanner =
        variant === "boss"
          ? "👑 *BOSS QUEST*\n"
          : variant === "gauntlet"
          ? `⚔️ *GAUNTLET — ${GAUNTLET_WAVES} waves, no flee*\n`
          : variant === "expedition"
          ? `🗺️ *EXPEDITION — ${EXPEDITION_FORKS} forks, then boss + treasure*\n`
          : "";

      // Expedition opens at fork 1, not in a fight — show choices instead of foe HP.
      const isExpedition = variant === "expedition" && scene.expedition;
      const expFirstNode = isExpedition ? scene.expedition!.nodes[0] : null;

      const body = isExpedition && expFirstNode?.type === "fork"
        ? [
            `_${expFirstNode.scene}_`,
            ``,
            `*Theme:* ${scene.expedition!.theme}`,
            ``,
            ...((expFirstNode.choices ?? []).map((c, i) => `\`${i + 1}\` ${c}`)),
            ``,
            `_First \`${payload.command} choose <n>\` wins for the party._`,
          ].join("\n")
        : [
            `_${scene.scene}_`,
            ``,
            `Foe: *${scene.monster_name}* — HP ${scene.monster_hp}${variant === "gauntlet" ? ` (wave 1/${GAUNTLET_WAVES})` : ""}`,
          ].join("\n");

      const text = [
        `${eliteBanner}${variantBanner}*A new quest begins.* <@${payload.user_id}> as *${character.name}* the ${character.class} (L${character.level}).`,
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

      await createQuest(env.DB, {
        channel_id: payload.channel_id,
        thread_ts: post.ts,
        elite,
        scene,
        created_by: payload.user_id,
      });
      // Mana refills to max for the questing character at quest start. Anyone who
      // joins later via /sq join also gets a refill.
      await refillMana(env.DB, payload.user_id);
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

  if (variant === "expedition") {
    const theme = await generateExpeditionTheme(env.AI);
    const nodes: ExpeditionNode[] = [];
    const path: string[] = [];
    for (let i = 1; i <= EXPEDITION_FORKS; i++) {
      const fork = await generateExpeditionForkScene(env.AI, theme, path, i, EXPEDITION_FORKS);
      nodes.push({ type: "fork", scene: fork.scene, choices: fork.choices });
    }
    // Combat node — boss-flavored monster but no phase mechanics.
    const combat = await generateOpeningScene(env.AI, character, elite, "boss");
    nodes.push({ type: "combat", scene: combat.scene });
    // Treasure node — pre-roll N items at boss tier and AI-name each.
    const lootOptions: NonNullable<ExpeditionNode["loot_options"]> = [];
    for (let i = 0; i < EXPEDITION_TREASURE_OPTIONS; i++) {
      const roll = rollItem(combat.tier);
      const named = await flavorLootDrop(env.AI, "the expedition's reward chest", roll.type, roll.rarity, roll.power);
      lootOptions.push({
        name: named.name,
        item_type: roll.type,
        power: roll.power,
        rarity: roll.rarity,
        flavor: named.flavor,
      });
    }
    nodes.push({
      type: "treasure",
      scene: "The way ahead opens onto a chest, glittering with possibility.",
      loot_options: lootOptions,
    });

    const expedition: ExpeditionState = {
      theme,
      current: 0,
      nodes,
      path_taken: [],
    };

    // Top-level monster fields stay as the combat node's monster — populated when the
    // expedition reaches that node so combat code can read them unmodified.
    return {
      monster_name: combat.monster_name,
      monster_hp: combat.monster_max_hp, // not active yet; treated as latent
      monster_max_hp: combat.monster_max_hp,
      tier: combat.tier,
      scene: nodes[0].scene,
      variant,
      expedition,
    };
  }

  return { ...(await generateOpeningScene(env.AI, character, elite, "standard")), variant };
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
    if (quest.scene.variant === "gauntlet" || quest.scene.variant === "expedition") {
      return ephemeral("🚪 No exit on this quest type — kill or be killed.");
    }
    return resolveFlee(payload, env, ctx, character, quest, fighters, equippedArmor);
  }

  // Expedition: only allow attack/cast at the combat node.
  if (quest.scene.variant === "expedition") {
    const node = currentExpNode(quest);
    if (!node || node.type !== "combat") {
      const nextStep = node?.type === "fork"
        ? `Try \`${payload.command} choose <n>\`.`
        : node?.type === "treasure"
        ? `Try \`${payload.command} take <n>\`.`
        : "Quest not progressed.";
      return ephemeral(`Not in combat right now. ${nextStep}`);
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
      ? `💥 *${sig.name} CRIT!* <@${payload.user_id}> hits for *${damage}* (${sigResult.formula}, ×2).`
      : `✨ *${sig.name}* — <@${payload.user_id}> hits for *${damage}* (${sigResult.formula}).`;
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
      ? `💥 *CRIT!* <@${payload.user_id}> ${verb} for *${damage}* (${hit.roll}×2 + ${modBreakdown}).`
      : `<@${payload.user_id}> ${verb} for *${damage}* (${hit.roll} + ${modBreakdown}).`;
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
    // Expedition: advance to the treasure node instead of triggering victory.
    if (quest.scene.variant === "expedition") {
      return resolveExpeditionToTreasure(payload, env, ctx, quest, [
        playerLine,
        `🏆 *${quest.scene.monster_name}* falls.`,
      ]);
    }
    return resolveVictory(payload, env, ctx, character, quest, fighters, [
      playerLine,
      `🏆 *${quest.scene.monster_name}* falls.`,
    ]);
  }

  // Monster turn — retaliates against the actor only. Damage scales with party size,
  // mitigated by armor (floor(power / 2), minimum 1 damage so armor never makes you immune).
  // Boss phase 2 adds a flat tier bonus on top.
  const isMagic = action === "cast";
  const monster = resolveMonsterHit(
    quest.scene.tier,
    fighters.length,
    equippedArmor?.power ?? 0,
    updatedScene.variant === "boss" && updatedScene.boss_phase === 2,
    rollDice,
  );
  // Shield absorbs damage before HP. Both fields are written together below.
  const dmg = applyDamageWithShield(monster.final, character.shield, character.hp);
  const playerHpAfter = dmg.newHp;

  const armorPart = monster.armorReduction > 0
    ? ` (${monster.raw} − ${monster.armorReduction} armor)`
    : "";
  const shieldPart = dmg.shieldAbsorbed > 0
    ? ` — *${dmg.shieldAbsorbed}* absorbed by shield, *${dmg.hpDamage}* to HP`
    : "";
  const monsterLine = `*${quest.scene.monster_name}* hits back for *${monster.final}*${armorPart}${shieldPart}.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, monsterLine]);
  }

  await setCharacterHpAndShield(env.DB, payload.user_id, playerHpAfter, dmg.newShield);
  await appendLog(env.DB, quest.id, "monster", "attack", `${monster.final} dmg`);

  const shieldDisplay = dmg.newShield > 0 ? ` (🛡️${dmg.newShield})` : "";
  const ephemeralLines = [
    playerLine,
    `${quest.scene.monster_name}: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp} HP`,
    monsterLine,
    `${character.name}: ${playerHpAfter}/${character.max_hp} HP${shieldDisplay}`,
  ];
  const statBlock = `_${quest.scene.monster_name}: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp} HP • ${character.name}: ${playerHpAfter}/${character.max_hp} HP${shieldDisplay}_`;

  ctx.waitUntil((async () => {
    const flavor = signatureName
      ? await flavorSignature(env.AI, character, quest.scene.monster_name, signatureName, isCrit)
      : await flavorHit(env.AI, character, quest.scene.monster_name, isMagic ? "cast" : "attack", isCrit);
    const phaseLine = bossPhaseTransition
      ? `\n👑 *Phase 2!* ${await flavorBossPhase(env.AI, quest.scene.monster_name)}`
      : "";
    const marker = signatureName ? "✨ " : isCrit ? "💥 " : "";
    const text = `${marker}${flavor}${phaseLine}\n${statBlock}`;
    // Broadcast on phase transition or signature use (signatures are big beats).
    await postToThread(env, quest, text, { broadcast: bossPhaseTransition || !!signatureName });
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
      const tail = partyContinues
        ? `_<@${payload.user_id}> retreats. ${others.map((s) => `*${s.name}*`).join(", ")} fight on._`
        : `_The quest fails — no fighters remain._`;
      await postToThread(env, quest, `🏃 ${flavor}\n${tail}`);
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
    ? ` (${dmg.shieldAbsorbed} absorbed by shield)`
    : "";
  const intro = `🪤 <@${payload.user_id}> trips on the way out. *${quest.scene.monster_name}* lands a free hit for *${monster.final}*${shieldPart}.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [intro]);
  }

  await setCharacterHpAndShield(env.DB, payload.user_id, playerHpAfter, dmg.newShield);
  await appendLog(env.DB, quest.id, payload.user_id, "flee", "failed");
  const shieldDisplay = dmg.newShield > 0 ? ` (🛡️${dmg.newShield})` : "";
  const text = `${intro}\n${character.name}: ${playerHpAfter}/${character.max_hp} HP${shieldDisplay}`;
  ctx.waitUntil(postToThread(env, quest, text));
  return ephemeral(text);
}

function rewardMultiplier(variant?: QuestVariant): number {
  if (variant === "boss") return 2;
  if (variant === "gauntlet") return 3;
  if (variant === "expedition") return 2.5;
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
      const named = await flavorLootDrop(env.AI, quest.scene.monster_name, roll.type, roll.rarity, roll.power);
      const item = await addItem(env.DB, {
        character_id: fighter.slack_user_id,
        item_name: named.name,
        item_type: roll.type,
        power: roll.power,
        rarity: roll.rarity,
        flavor: named.flavor,
      });
      const powerStr = powerLabel(roll.type, roll.power);
      lootLines.push(
        `${RARITY_BADGE[roll.rarity]} *${fighter.name}* finds *${item.item_name}* (${roll.type}, ${powerStr}) — _${named.flavor}_`,
      );
    }
    const tail = [
      `_✨ +${xpEach} XP, +${goldEach} gold to each of ${fighters.length} fighter${fighters.length > 1 ? "s" : ""}._`,
      ...levelUpLines,
      ...lootLines,
    ].join("\n");
    await postToThread(env, quest, `🏆 ${flavor}\n${tail}`, { broadcast: true });
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
    const tail = `_⚔️ ${waveLabel} — *${next.name}* (HP ${next.max_hp})._\n_${next.scene}_`;
    await postToThread(env, quest, `⚔️ ${flavor}\n${tail}`, { broadcast: true });
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
  await appendLog(env.DB, quest.id, payload.user_id, "expedition", `→ treasure`);

  const lootLines = (treasureNode.loot_options ?? []).map((l, i) => {
    const power = powerLabel(l.item_type, l.power);
    return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}\n   _${l.flavor}_`;
  }).join("\n");

  ctx.waitUntil((async () => {
    const tail = `_🎁 ${treasureNode.scene}_\n${lootLines}\n\n_First \`${payload.command} take <n>\` claims for the party._`;
    await postToThread(env, quest, `${preamble.join("\n")}\n\n${tail}`, { broadcast: true });
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
    const tail = [
      `_🎁 *${taker.name}* claims *${takenItem.item_name}* (${takenItem.item_type}, ${powerLabel(takenItem.item_type, takenItem.power)})._`,
      `_✨ +${xpEach} XP, +${goldEach} gold to each of ${partySize} fighter${partySize > 1 ? "s" : ""}._`,
      ...levelUpLines,
    ].join("\n");
    await postToThread(env, quest, `🏆 ${flavor}\n${tail}`, { broadcast: true });
  })());
}

async function handleChoose(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest.");
  if (quest.scene.variant !== "expedition" || !quest.scene.expedition) {
    return ephemeral(`This quest doesn't have forks — try \`${payload.command} attack\` or similar.`);
  }

  const exp = quest.scene.expedition;
  const node = exp.nodes[exp.current];
  if (!node || node.type !== "fork") {
    return ephemeral("No fork to choose right now.");
  }

  const idx = parseInt(args[0] ?? "", 10);
  const choices = node.choices ?? [];
  if (Number.isNaN(idx) || idx < 1 || idx > choices.length) {
    return ephemeral(`Usage: \`${payload.command} choose <1-${choices.length}>\`.`);
  }

  const chosen = choices[idx - 1];
  const newCurrent = exp.current + 1;
  const nextNode = exp.nodes[newCurrent];
  if (!nextNode) return ephemeral("Expedition is in a bad state — no next node.");

  const updatedExp: ExpeditionState = {
    ...exp,
    current: newCurrent,
    path_taken: [...exp.path_taken, chosen],
  };

  const updatedScene: SceneJson = {
    ...quest.scene,
    expedition: updatedExp,
    scene: nextNode.scene,
    // If next is combat, refresh monster HP from the latent value (full bar).
    monster_hp: nextNode.type === "combat" ? quest.scene.monster_max_hp : 0,
  };

  // Atomic guard: write only lands if expedition.current still equals the value we
  // read. A racing /dnd choose for the same fork will fail the WHERE clause.
  const advanced = await trySaveExpeditionAdvance(env.DB, quest.id, updatedScene, exp.current);
  if (!advanced) {
    return ephemeral("Someone else already chose for the party.");
  }
  await appendLog(env.DB, quest.id, payload.user_id, "choose", `${idx}: ${chosen}`);

  ctx.waitUntil((async () => {
    const consequence = await flavorForkOutcome(env.AI, exp.theme, chosen);
    let nextBeat = "";
    if (nextNode.type === "fork") {
      nextBeat = [
        `_${nextNode.scene}_`,
        ``,
        ...((nextNode.choices ?? []).map((c, i) => `\`${i + 1}\` ${c}`)),
        ``,
        `_First \`${payload.command} choose <n>\` wins for the party._`,
      ].join("\n");
    } else if (nextNode.type === "combat") {
      nextBeat = [
        `_${nextNode.scene}_`,
        ``,
        `Foe: *${updatedScene.monster_name}* — HP ${updatedScene.monster_hp}/${updatedScene.monster_max_hp}`,
        ``,
        `Combat: \`${payload.command} attack\` or \`${payload.command} cast\`.`,
      ].join("\n");
    } else if (nextNode.type === "treasure") {
      const lootLines = (nextNode.loot_options ?? []).map((l, i) => {
        const power = powerLabel(l.item_type, l.power);
        return `\`${i + 1}\` ${RARITY_BADGE[l.rarity]} *${l.name}* — ${l.item_type}, ${power}\n   _${l.flavor}_`;
      }).join("\n");
      nextBeat = `_${nextNode.scene}_\n${lootLines}\n\n_First \`${payload.command} take <n>\` claims for the party._`;
    }
    const header = `🗺️ <@${payload.user_id}> chose: *${chosen}*. ${consequence}`;
    await postToThread(env, quest, `${header}\n\n${nextBeat}`);
  })());

  return ephemeral(`✅ You chose: *${chosen}*. Watch the thread for what happens.`);
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
  if (quest.scene.variant !== "expedition" || !quest.scene.expedition) {
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

  if (isPerma) {
    await deleteCharacter(env.DB, payload.user_id);
    await appendLog(env.DB, quest.id, payload.user_id, "death", "perma");
    ephemeralLines.push(
      `💀💀 *${character.name}* the ${character.class} is no more.`,
      `_Cause: ${quest.scene.monster_name}. Elite quest — perma-death enforced._`,
      `Roll a new hero with \`${payload.command} roll\`.`,
    );
    resultTail = `_💀💀 *${character.name}* the ${character.class} is no more — slain by ${quest.scene.monster_name}. Roll a new hero with \`${payload.command} roll\`._`;
  } else {
    // Note: applySoftDeath sets hp = max_hp (post-recovery). No need to write 0 first.
    const scar = generateScar(quest.scene.monster_name);
    const { goldLost, itemLost } = await applySoftDeath(env.DB, character, scar, DOWNED_COOLDOWN_MS);
    await appendLog(env.DB, quest.id, payload.user_id, "death", `soft, -${goldLost} gold`);
    const recoveryTs = Math.floor((Date.now() + DOWNED_COOLDOWN_MS) / 1000);
    ephemeralLines.push(
      `💀 *${character.name}* is *downed*.`,
      `Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_.`,
      `Recover by <!date^${recoveryTs}^{date_short_pretty} {time}|in ~12h>.`,
    );
    resultTail = `_💀 ${character.name} is downed. Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: ${scar}. Recover <!date^${recoveryTs}^{date_short_pretty}|in ~12h>._`;
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
    ? `_☠️ The party is broken. Quest fails._`
    : `_Survivors fight on: ${survivors.map((s) => `*${s.name}*`).join(", ")}._`;

  ctx.waitUntil((async () => {
    const flavor = await flavorDeath(env.AI, character, quest.scene.monster_name, isPerma);
    const marker = isPerma ? "💀💀 " : "💀 ";
    // Perma-death is rare and weighty — broadcast it. Soft deaths happen often
    // and would clutter the channel.
    await postToThread(env, quest, `${marker}${flavor}\n${resultTail}\n${survivorsTail}`, { broadcast: isPerma });
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
  // Expedition locks once any fork has been chosen — joiners don't get to retroactively
  // affect choices that have already been made.
  if (quest.scene.variant === "expedition" && (quest.scene.expedition?.path_taken.length ?? 0) > 0) {
    return ephemeral(`🗺️ The party has already started making decisions — too late to join. Wait for the next \`${payload.command} quest\`.`);
  }

  const inserted = await joinQuest(env.DB, quest.id, payload.user_id);
  if (!inserted) return ephemeral("You're already on this quest.");

  // Joiners also get a mana refill — same effect as starting the quest yourself.
  await refillMana(env.DB, payload.user_id);

  const scaled = await scaleMonsterForJoin(env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
  await appendLog(env.DB, quest.id, payload.user_id, "join", `monster +${scaled.monster_max_hp - quest.scene.monster_max_hp} HP`);

  ctx.waitUntil((async () => {
    const flavor = await flavorJoin(env.AI, character, scaled.monster_name);
    const tail = `_*${scaled.monster_name}* swells with menace (now ${scaled.monster_hp}/${scaled.monster_max_hp} HP)._`;
    // Broadcast joins so other channel members see "X joined the fight" and might
    // also drop in.
    await postToThread(env, quest, `🛡️ ${flavor}\n${tail}`, { broadcast: true });
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
      return `• *${c.name}* the ${c.class} — L${c.level}, HP ${c.hp}/${c.max_hp}${status}`;
    }),
  ];
  return ephemeral(lines.join("\n"));
}

async function handleInventory(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const items = await getInventory(env.DB, payload.user_id);
  if (items.length === 0) {
    return ephemeral("Your pack is empty. Win quests to find loot.");
  }

  const lines = [
    `*Inventory* — ${items.length} item${items.length > 1 ? "s" : ""}`,
  ];
  for (const item of items) {
    const equipMark = item.equipped ? " ✅" : "";
    const powerStr = powerLabel(item.item_type, item.power);
    lines.push(
      `\`${item.id}\` ${RARITY_BADGE[item.rarity]} *${item.item_name}* — ${item.item_type}, ${powerStr}${equipMark}`,
    );
    if (item.flavor) lines.push(`   _${item.flavor}_`);
  }
  lines.push("", `Equip with \`${payload.command} equip <id>\`, use a consumable with \`${payload.command} use <id>\`.`);
  return ephemeral(lines.join("\n"));
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
    `✅ Equipped *${item.item_name}* (${item.item_type}, +${item.power}). Previous ${item.item_type} unequipped.`,
  );
}

async function handleUse(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} use <inventory id>\` (find ids with \`${payload.command} inventory\`).`);

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");

  if (item.item_type === "magic") {
    if (character.max_mana >= MAX_MANA_CAP) {
      return ephemeral(`Already at the max-mana cap (${MAX_MANA_CAP}). Sell it instead with \`${payload.command} sell ${item.id}\`.`);
    }
    const result = await bumpMaxMana(env.DB, character, item.power, MAX_MANA_CAP);
    await removeItem(env.DB, item.id);
    const wasted = item.power - result.added;
    const wastedNote = wasted > 0 ? ` (${wasted} over the cap, lost)` : "";
    return ephemeral(
      `🔮 You channel *${item.item_name}* — *+${result.added}* max mana${wastedNote}. (${result.newMana}/${result.newMaxMana})`,
    );
  }

  if (item.item_type !== "consumable") {
    return ephemeral(`*${item.item_name}* isn't usable. Try \`${payload.command} equip ${item.id}\`.`);
  }

  if (character.hp >= character.max_hp) {
    return ephemeral("You're already at full HP — save it for when you need it.");
  }

  const healed = await consumeItem(env.DB, character, item);
  return ephemeral(
    `🧪 You drink *${item.item_name}* — recovered *${healed}* HP. (${character.hp + healed}/${character.max_hp})`,
  );
}

async function handleShop(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const existing = await getActiveShopStock(env.DB, payload.channel_id, SHOP_RESTOCK_MS);
  if (existing && existing.length > 0) {
    return ephemeral(formatShop(existing, character.gold, payload.command));
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
  const generatedAt = Date.now();
  const items: Parameters<typeof insertShopStock>[1] = [];
  for (let i = 0; i < SHOP_STOCK_SIZE; i++) {
    const roll = rollItem(tier);
    const named = await flavorLootDrop(env.AI, "the shopkeep's chest", roll.type, roll.rarity, roll.power);
    items.push({
      channel_id: channelId,
      generated_at: generatedAt,
      item_name: named.name,
      item_type: roll.type,
      power: roll.power,
      rarity: roll.rarity,
      flavor: named.flavor,
      price: priceFor(roll.type, roll.rarity),
    });
  }
  await insertShopStock(env.DB, items);
}

function formatShop(items: ShopItem[], gold: number, cmd: string): string {
  const lines = [`🛒 *Shop* — you have ${gold} gold`];
  for (const it of items) {
    const status = it.bought_by ? " ❌_sold_" : "";
    const powerStr = powerLabel(it.item_type, it.power);
    lines.push(
      `\`${it.id}\` ${RARITY_BADGE[it.rarity]} *${it.item_name}* — ${it.item_type}, ${powerStr} • *${it.price}g*${status}`,
    );
    if (it.flavor) lines.push(`   _${it.flavor}_`);
  }
  lines.push("", `Buy with \`${cmd} buy <id>\`. Sell your own items with \`${cmd} sell <id>\`.`);
  return lines.join("\n");
}

async function handleBuy(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral(`You need to \`${payload.command} roll\` a character first.`);

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral(`Usage: \`${payload.command} buy <shop id>\` (find ids with \`${payload.command} shop\`).`);

  const stock = await getShopItem(env.DB, id, payload.channel_id);
  if (!stock) return ephemeral("No such shop item in this channel.");
  if (stock.bought_by) return ephemeral(`*${stock.item_name}* was already bought.`);
  if (character.gold < stock.price) {
    return ephemeral(`Not enough gold — *${stock.item_name}* costs ${stock.price}g, you have ${character.gold}g.`);
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

// Slack @ mentions in slash text come through as <@U123ABC> or <@U123ABC|name>.
// Extract the user id (or null if no mention is present).
const MENTION_RX = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/;
function parseMention(text: string): string | null {
  const m = MENTION_RX.exec(text);
  return m?.[1] ?? null;
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
  const text = `💚 <@${payload.user_id}> heals ${targetTag} for *${healed}* HP (${heal.roll} + ${cls.magic_mod}m). _${target.name}: ${target.hp + healed}/${target.max_hp}_`;
  ctx.waitUntil(postToThread(env, quest, text));
  return ephemeral(text);
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
  const text = `🛡️ <@${payload.user_id}> shields ${targetTag} for *${added}*${wastedNote} (${shield.roll} + ${cls.magic_mod}m). _${target.name}: 🛡️${target.shield + added}/${cap}_`;
  ctx.waitUntil(postToThread(env, quest, text));
  return ephemeral(text);
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

  const text = `🌱 <@${payload.user_id}> uses *${item.item_name}* — <@${target.slack_user_id}> stirs and rejoins the fight at *${restoredHp}/${target.max_hp}* HP.`;
  // Revive is a big beat — broadcast.
  ctx.waitUntil(postToThread(env, quest, text, { broadcast: true }));
  return ephemeral(text);
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
async function postToThread(
  env: Env,
  quest: ActiveQuest,
  text: string,
  options?: { broadcast?: boolean },
): Promise<void> {
  const res = await postMessage(env.SLACK_BOT_TOKEN, {
    channel: quest.channel_id,
    thread_ts: quest.thread_ts,
    text,
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

function ephemeral(text: string): CommandResponse {
  return { text, response_type: "ephemeral" };
}

function inChannel(text: string): CommandResponse {
  return { text, response_type: "in_channel" };
}
