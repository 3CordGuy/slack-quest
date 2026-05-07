// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env } from "./index";
import {
  flavorDeath,
  flavorFleeSuccess,
  flavorHit,
  flavorJoin,
  flavorLootDrop,
  flavorVictory,
  generateOpeningScene,
} from "./ai";
import {
  addItem,
  appendLog,
  applySoftDeath,
  awardSpoils,
  consumeItem,
  cooldownRemaining,
  createCharacter,
  createQuest,
  deleteCharacter,
  equipItem,
  getActiveQuestForCharacter,
  getActiveQuestInChannel,
  getCharacter,
  getEquipped,
  getInventory,
  getItem,
  getLeaderboard,
  getQuestParty,
  isFighter,
  joinQuest,
  markQuestStatus,
  scaleMonsterForJoin,
  setCharacterHp,
  updateMonsterHp,
  type ActiveQuest,
  type Character,
  type Item,
} from "./db";
import {
  classByName,
  dropChance,
  generateNpcName,
  generateScar,
  pickRandomClass,
  rollDice,
  rollItem,
  xpForLevel,
  RARITY_BADGE,
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

const HELP_TEXT = [
  "*Slack Quest commands*",
  "• `/dnd roll` — roll a new character",
  "• `/dnd me` — show your character sheet",
  "• `/dnd quest` — start a standard quest",
  "• `/dnd quest elite` — start an elite quest (perma-death enabled)",
  "• `/dnd join` — join the active quest in this channel",
  "• `/dnd attack` — strike with weapon (1d6 + atk_mod + weapon power, crit on nat 6)",
  "• `/dnd cast` — channel magic (1d8 + mag_mod + weapon power, crit on nat 8)",
  "• `/dnd flee` — try to escape (1d2; on fail you take a free hit)",
  "• `/dnd inventory` — list your items (equipped marked ✅)",
  "• `/dnd equip <id>` — equip a weapon or armor by inventory id",
  "• `/dnd use <id>` — use a consumable (free action, no cooldown)",
  "• `/dnd party` — show the current quest's roster + HP",
  "• `/dnd leaderboard` — top 10 heroes",
  "• `/dnd help` — show this list",
  "_Combat actions have a 45-second cooldown per player._",
].join("\n");

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
    case "join":
      return handleJoin(payload, env, ctx);
    case "party":
      return handleParty(payload, env);
    case "leaderboard":
    case "lb":
      return handleLeaderboard(env);
    case "inventory":
    case "inv":
      return handleInventory(payload, env);
    case "equip":
      return handleEquip(payload, args, env);
    case "use":
      return handleUse(payload, args, env);
    case "help":
    case "":
      return ephemeral(HELP_TEXT);
    default:
      return ephemeral(`Unknown command: \`${sub}\`. Try \`/dnd help\`.`);
  }
}

async function handleRoll(payload: SlashCommandPayload, env: Env): Promise<CommandResponse> {
  const existing = await getCharacter(env.DB, payload.user_id);
  if (existing) {
    return ephemeral(
      `You already have a character: *${existing.name}* the ${existing.class} (L${existing.level}). Use \`/dnd me\` to see the sheet.`,
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
  if (!c) return ephemeral("You haven't rolled a character yet. Try `/dnd roll`.");
  return ephemeral(formatSheet(c));
}

function formatSheet(c: Character): string {
  const downedNote = c.downed_until && c.downed_until > Date.now()
    ? `\n💀 _Downed until <!date^${Math.floor(c.downed_until / 1000)}^{date_short_pretty} {time}|soon>_`
    : "";
  const scarLine = c.scars.length ? `\nScars: ${c.scars.join(", ")}` : "";
  return [
    `*${c.name}*, the ${c.class}`,
    `Level ${c.level} • XP ${c.xp}`,
    `HP ${c.hp}/${c.max_hp} • ${c.gold} gold`,
    `${scarLine}${downedNote}`,
  ].filter(Boolean).join("\n");
}

async function handleQuest(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");

  if (character.downed_until && character.downed_until > Date.now()) {
    return ephemeral(
      `You are *downed* and recovering. Try again later.`,
    );
  }

  const active = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (active) {
    return ephemeral(
      `You're already on a quest in <#${active.channel_id}>. Finish it (or die trying) before starting another.`,
    );
  }

  const elite = args[0]?.toLowerCase() === "elite";

  // Slack requires we ack within 3s. AI generation can take longer, so
  // ack immediately and post the scene asynchronously to the channel.
  ctx.waitUntil(
    (async () => {
      try {
        const scene = await generateOpeningScene(env.AI, character, elite);
        const eliteBanner = elite ? "⚠️ *ELITE QUEST — perma-death enabled* ⚠️\n\n" : "";
        const text = [
          `${eliteBanner}*A new quest begins.* <@${payload.user_id}> as *${character.name}* the ${character.class} (L${character.level}).`,
          ``,
          `_${scene.scene}_`,
          ``,
          `Foe: *${scene.monster_name}* — HP ${scene.monster_hp}`,
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
      } catch (err) {
        await respondToCommand(payload.response_url, {
          response_type: "ephemeral",
          text: `The narrator stumbled: ${(err as Error).message}`,
        });
      }
    })(),
  );

  return ephemeral("🎲 Rolling for initiative...");
}

type CombatAction = "attack" | "cast" | "flee";

async function handleCombat(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
  action: CombatAction,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't act. Recover, then try again.");
  }

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest. Try `/dnd quest` or `/dnd join`.");

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
    return resolveFlee(payload, env, ctx, character, quest, fighters, equippedArmor);
  }

  // attack | cast — equipped weapon adds to whichever action you use; armor reduces incoming.
  const cls = classByName(character.class);
  const isMagic = action === "cast";
  const sides = isMagic ? 8 : 6;
  const classMod = isMagic ? cls.magic_mod : cls.attack_mod;
  const weaponMod = equippedWeapon?.power ?? 0;
  const totalMod = classMod + weaponMod;
  const verb = isMagic ? "casts" : "attacks";

  const roll = rollDice(sides);
  const isCrit = roll === sides;
  const damage = (roll + totalMod) * (isCrit ? 2 : 1);
  const newMonsterHp = quest.scene.monster_hp - damage;

  const modBreakdown = weaponMod > 0 ? `${classMod}+${weaponMod}` : `${totalMod}`;
  const playerLine = isCrit
    ? `💥 *CRIT!* <@${payload.user_id}> ${verb} for *${damage}* (${roll}×2 + ${modBreakdown}).`
    : `<@${payload.user_id}> ${verb} for *${damage}* (${roll} + ${modBreakdown}).`;

  if (newMonsterHp <= 0) {
    await updateMonsterHp(env.DB, quest.id, quest.scene, 0);
    await appendLog(env.DB, quest.id, payload.user_id, action, `${damage} dmg (kill)`);
    return resolveVictory(payload, env, ctx, character, quest, fighters, [
      playerLine,
      `🏆 *${quest.scene.monster_name}* falls.`,
    ]);
  }

  await updateMonsterHp(env.DB, quest.id, quest.scene, newMonsterHp);
  await appendLog(env.DB, quest.id, payload.user_id, action, `${damage} dmg`);

  // Monster turn — retaliates against the actor only. Damage scales with party size,
  // mitigated by armor (floor(power / 2), minimum 1 damage so armor never makes you immune).
  const rawMonsterDmg = rollDice(4) + quest.scene.tier + Math.floor((fighters.length - 1) / 2);
  const armorReduction = equippedArmor ? Math.floor(equippedArmor.power / 2) : 0;
  const monsterRoll = Math.max(1, rawMonsterDmg - armorReduction);
  const playerHpAfter = character.hp - monsterRoll;

  const monsterLine = armorReduction > 0
    ? `*${quest.scene.monster_name}* hits back for *${monsterRoll}* (${rawMonsterDmg} − ${armorReduction} armor).`
    : `*${quest.scene.monster_name}* hits back for *${monsterRoll}*.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [playerLine, monsterLine]);
  }

  await setCharacterHp(env.DB, payload.user_id, playerHpAfter);
  await appendLog(env.DB, quest.id, "monster", "attack", `${monsterRoll} dmg`);

  const ephemeralLines = [
    playerLine,
    `${quest.scene.monster_name}: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp} HP`,
    monsterLine,
    `${character.name}: ${playerHpAfter}/${character.max_hp} HP`,
  ];
  const statBlock = `_${quest.scene.monster_name}: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp} HP • ${character.name}: ${playerHpAfter}/${character.max_hp} HP_`;

  ctx.waitUntil((async () => {
    const flavor = await flavorHit(env.AI, character, quest.scene.monster_name, isMagic ? "cast" : "attack", isCrit);
    const text = `${isCrit ? "💥 " : ""}${flavor}\n${statBlock}`;
    await postToThread(env, quest, text);
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
  const rawDmg = rollDice(4) + quest.scene.tier + Math.floor((fighters.length - 1) / 2);
  const armorReduction = equippedArmor ? Math.floor(equippedArmor.power / 2) : 0;
  const monsterRoll = Math.max(1, rawDmg - armorReduction);
  const playerHpAfter = character.hp - monsterRoll;
  const intro = `🪤 <@${payload.user_id}> trips on the way out. *${quest.scene.monster_name}* lands a free hit for *${monsterRoll}*.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, ctx, character, quest, fighters, [intro]);
  }

  await setCharacterHp(env.DB, payload.user_id, playerHpAfter);
  await appendLog(env.DB, quest.id, payload.user_id, "flee", "failed");
  const text = `${intro}\n${character.name}: ${playerHpAfter}/${character.max_hp} HP`;
  ctx.waitUntil(postToThread(env, quest, text));
  return ephemeral(text);
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
  const totalXp = 10 + quest.scene.tier * 5;
  const totalGold = 5 + quest.scene.tier * 3;
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
    );
    if (result.levelsGained > 0) {
      levelUpLines.push(
        `🎚️ *${fighter.name}* hits Level ${result.newLevel} (max HP ${result.newMaxHp}).`,
      );
    }
  }

  // Roll loot independently per fighter so everyone has skin in the kill.
  const lootRolls = fighters
    .map((f) => ({ fighter: f, roll: rollItem(quest.scene.tier) }))
    .filter(() => Math.random() < dropChance(quest.scene.tier));

  await markQuestStatus(env.DB, quest.id, "completed");
  await appendLog(env.DB, quest.id, payload.user_id, "victory", `+${xpEach}xp/+${goldEach}g × ${fighters.length}, ${lootRolls.length} drops`);

  const ephemeralLines = [
    ...preamble,
    `✨ Spoils split across ${fighters.length}: +${xpEach} XP, +${goldEach} gold each.`,
    ...levelUpLines,
  ];
  if (lootRolls.length > 0) {
    ephemeralLines.push(
      `🎁 ${lootRolls.length} drop${lootRolls.length > 1 ? "s" : ""}! Check \`/dnd inventory\` once narration posts.`,
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
      const powerStr = roll.type === "consumable" ? `heals ${roll.power}` : `+${roll.power}`;
      lootLines.push(
        `${RARITY_BADGE[roll.rarity]} *${fighter.name}* finds *${item.item_name}* (${roll.type}, ${powerStr}) — _${named.flavor}_`,
      );
    }
    const tail = [
      `_✨ +${xpEach} XP, +${goldEach} gold to each of ${fighters.length} fighter${fighters.length > 1 ? "s" : ""}._`,
      ...levelUpLines,
      ...lootLines,
    ].join("\n");
    await postToThread(env, quest, `🏆 ${flavor}\n${tail}`);
  })());

  return ephemeral(ephemeralLines.join("\n"));
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
      `Roll a new hero with \`/dnd roll\`.`,
    );
    resultTail = `_💀💀 *${character.name}* the ${character.class} is no more — slain by ${quest.scene.monster_name}. Roll a new hero with \`/dnd roll\`._`;
  } else {
    await setCharacterHp(env.DB, payload.user_id, 0);
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
    await postToThread(env, quest, `${marker}${flavor}\n${resultTail}\n${survivorsTail}`);
  })());

  return ephemeral(ephemeralLines.join("\n"));
}

async function handleJoin(
  payload: SlashCommandPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");
  if (!isFighter(character)) {
    return ephemeral("You're downed and can't quest right now.");
  }

  const existing = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (existing) {
    return ephemeral(`You're already on an active quest in <#${existing.channel_id}>.`);
  }

  const quest = await getActiveQuestInChannel(env.DB, payload.channel_id);
  if (!quest) return ephemeral("No active quest in this channel. Start one with `/dnd quest`.");

  const inserted = await joinQuest(env.DB, quest.id, payload.user_id);
  if (!inserted) return ephemeral("You're already on this quest.");

  const scaled = await scaleMonsterForJoin(env.DB, quest.id, quest.scene, JOIN_HP_RATIO);
  await appendLog(env.DB, quest.id, payload.user_id, "join", `monster +${scaled.monster_max_hp - quest.scene.monster_max_hp} HP`);

  ctx.waitUntil((async () => {
    const flavor = await flavorJoin(env.AI, character, scaled.monster_name);
    const tail = `_*${scaled.monster_name}* swells with menace (now ${scaled.monster_hp}/${scaled.monster_max_hp} HP)._`;
    await postToThread(env, quest, `🛡️ ${flavor}\n${tail}`);
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
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");

  const items = await getInventory(env.DB, payload.user_id);
  if (items.length === 0) {
    return ephemeral("Your pack is empty. Win quests to find loot.");
  }

  const lines = [
    `*Inventory* — ${items.length} item${items.length > 1 ? "s" : ""}`,
  ];
  for (const item of items) {
    const equipMark = item.equipped ? " ✅" : "";
    const powerStr = item.item_type === "consumable" ? `heals ${item.power}` : `+${item.power}`;
    lines.push(
      `\`${item.id}\` ${RARITY_BADGE[item.rarity]} *${item.item_name}* — ${item.item_type}, ${powerStr}${equipMark}`,
    );
    if (item.flavor) lines.push(`   _${item.flavor}_`);
  }
  lines.push("", "Equip with `/dnd equip <id>`, use a consumable with `/dnd use <id>`.");
  return ephemeral(lines.join("\n"));
}

async function handleEquip(
  payload: SlashCommandPayload,
  args: string[],
  env: Env,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral("Usage: `/dnd equip <inventory id>` (find ids with `/dnd inventory`).");

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.item_type === "consumable") {
    return ephemeral("Consumables can't be equipped — use them with `/dnd use <id>`.");
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
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");

  const id = parseInt(args[0] ?? "", 10);
  if (Number.isNaN(id)) return ephemeral("Usage: `/dnd use <inventory id>` (find ids with `/dnd inventory`).");

  const item = await getItem(env.DB, id, payload.user_id);
  if (!item) return ephemeral("No such item in your inventory.");
  if (item.item_type !== "consumable") {
    return ephemeral(`*${item.item_name}* isn't a consumable. Try \`/dnd equip ${item.id}\`.`);
  }

  if (character.hp >= character.max_hp) {
    return ephemeral("You're already at full HP — save it for when you need it.");
  }

  const healed = await consumeItem(env.DB, character, item);
  return ephemeral(
    `🧪 You drink *${item.item_name}* — recovered *${healed}* HP. (${character.hp + healed}/${character.max_hp})`,
  );
}

async function handleLeaderboard(env: Env): Promise<CommandResponse> {
  const top = await getLeaderboard(env.DB, 10);
  if (top.length === 0) return ephemeral("No heroes yet. Be the first — `/dnd roll`.");
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

async function postToThread(env: Env, quest: ActiveQuest, text: string): Promise<void> {
  const res = await postMessage(env.SLACK_BOT_TOKEN, {
    channel: quest.channel_id,
    thread_ts: quest.thread_ts,
    text,
  });
  if (!res.ok) {
    // Don't fail the command — the player still got an ephemeral copy.
    console.warn("postToThread failed", res.error);
  }
}

function ephemeral(text: string): CommandResponse {
  return { text, response_type: "ephemeral" };
}

function inChannel(text: string): CommandResponse {
  return { text, response_type: "in_channel" };
}
