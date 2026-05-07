// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env } from "./index";
import { generateOpeningScene } from "./ai";
import {
  appendLog,
  applySoftDeath,
  awardSpoils,
  createCharacter,
  createQuest,
  deleteCharacter,
  getActiveQuestForCharacter,
  getCharacter,
  markQuestStatus,
  setCharacterHp,
  updateMonsterHp,
  type ActiveQuest,
  type Character,
} from "./db";
import {
  classByName,
  generateNpcName,
  generateScar,
  pickRandomClass,
  rollDice,
  xpForLevel,
} from "./flavor";
import { postMessage, respondToCommand, type SlashCommandPayload } from "./slack";

export interface CommandResponse {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: unknown[];
}

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const HELP_TEXT = [
  "*Slack Quest commands*",
  "• `/dnd roll` — roll a new character",
  "• `/dnd me` — show your character sheet",
  "• `/dnd quest` — start a standard quest",
  "• `/dnd quest elite` — start an elite quest (perma-death enabled)",
  "• `/dnd attack` — strike with weapon (1d6 + atk_mod, crit on nat 6)",
  "• `/dnd cast` — channel magic (1d8 + mag_mod, crit on nat 8)",
  "• `/dnd flee` — try to escape (1d2; on fail you take a free hit)",
  "• `/dnd help` — show this list",
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
      return handleCombat(payload, env, "attack");
    case "cast":
      return handleCombat(payload, env, "cast");
    case "flee":
      return handleCombat(payload, env, "flee");
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
  action: CombatAction,
): Promise<CommandResponse> {
  const character = await getCharacter(env.DB, payload.user_id);
  if (!character) return ephemeral("You need to `/dnd roll` a character first.");

  const quest = await getActiveQuestForCharacter(env.DB, payload.user_id);
  if (!quest) return ephemeral("You're not on an active quest. Try `/dnd quest`.");

  if (action === "flee") return resolveFlee(payload, env, character, quest);

  // attack | cast
  const cls = classByName(character.class);
  const isMagic = action === "cast";
  const sides = isMagic ? 8 : 6;
  const mod = isMagic ? cls.magic_mod : cls.attack_mod;
  const verb = isMagic ? "casts" : "attacks";

  const roll = rollDice(sides);
  const isCrit = roll === sides;
  const damage = (roll + mod) * (isCrit ? 2 : 1);
  const newMonsterHp = quest.scene.monster_hp - damage;

  const playerLine = isCrit
    ? `💥 *CRIT!* <@${payload.user_id}> ${verb} for *${damage}* (${roll}×2 + ${mod}).`
    : `<@${payload.user_id}> ${verb} for *${damage}* (${roll} + ${mod}).`;

  if (newMonsterHp <= 0) {
    return resolveVictory(payload, env, character, quest, [
      playerLine,
      `🏆 *${quest.scene.monster_name}* falls.`,
    ]);
  }

  await updateMonsterHp(env.DB, quest.id, quest.scene, newMonsterHp);
  await appendLog(env.DB, quest.id, payload.user_id, action, `${damage} dmg`);

  // Monster turn.
  const monsterRoll = rollDice(4) + quest.scene.tier;
  const playerHpAfter = character.hp - monsterRoll;

  const monsterLine = `*${quest.scene.monster_name}* hits back for *${monsterRoll}*.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, character, quest, [playerLine, monsterLine]);
  }

  await setCharacterHp(env.DB, payload.user_id, playerHpAfter);
  await appendLog(env.DB, quest.id, "monster", "attack", `${monsterRoll} dmg`);

  const lines = [
    playerLine,
    `${quest.scene.monster_name}: ${Math.max(0, newMonsterHp)}/${quest.scene.monster_max_hp} HP`,
    monsterLine,
    `${character.name}: ${playerHpAfter}/${character.max_hp} HP`,
  ];
  await postToThread(env, quest, lines.join("\n"));
  return ephemeral(lines.join("\n"));
}

async function resolveFlee(
  payload: SlashCommandPayload,
  env: Env,
  character: Character,
  quest: ActiveQuest,
): Promise<CommandResponse> {
  const roll = rollDice(2);
  if (roll === 1) {
    await markQuestStatus(env.DB, quest.id, "failed");
    await appendLog(env.DB, quest.id, payload.user_id, "flee", "escaped");
    const text = `🏃 <@${payload.user_id}> escapes *${quest.scene.monster_name}* and lives to debug another day.`;
    await postToThread(env, quest, text);
    return ephemeral(text);
  }

  // Failed flee → free monster hit.
  const monsterRoll = rollDice(4) + quest.scene.tier;
  const playerHpAfter = character.hp - monsterRoll;
  const intro = `🪤 <@${payload.user_id}> trips on the way out. *${quest.scene.monster_name}* lands a free hit for *${monsterRoll}*.`;

  if (playerHpAfter <= 0) {
    return resolveDeath(payload, env, character, quest, [intro]);
  }

  await setCharacterHp(env.DB, payload.user_id, playerHpAfter);
  await appendLog(env.DB, quest.id, payload.user_id, "flee", "failed");
  const text = `${intro}\n${character.name}: ${playerHpAfter}/${character.max_hp} HP`;
  await postToThread(env, quest, text);
  return ephemeral(text);
}

async function resolveVictory(
  payload: SlashCommandPayload,
  env: Env,
  character: Character,
  quest: ActiveQuest,
  preamble: string[],
): Promise<CommandResponse> {
  const xpGained = 10 + quest.scene.tier * 5;
  const goldGained = 5 + quest.scene.tier * 3;
  const result = await awardSpoils(
    env.DB,
    character,
    xpGained,
    goldGained,
    () => rollDice(6),
    xpForLevel,
  );
  await markQuestStatus(env.DB, quest.id, "completed");
  await appendLog(env.DB, quest.id, payload.user_id, "victory", `+${xpGained} xp, +${goldGained} gold`);

  const lines = [
    ...preamble,
    `✨ +${xpGained} XP, +${goldGained} gold.`,
  ];
  if (result.levelsGained > 0) {
    lines.push(
      `🎚️ *LEVEL UP!* ${character.name} is now Level ${result.newLevel} (max HP ${result.newMaxHp}).`,
    );
  }
  await postToThread(env, quest, lines.join("\n"));
  return ephemeral(lines.join("\n"));
}

async function resolveDeath(
  payload: SlashCommandPayload,
  env: Env,
  character: Character,
  quest: ActiveQuest,
  preamble: string[],
): Promise<CommandResponse> {
  await markQuestStatus(env.DB, quest.id, "failed");
  await setCharacterHp(env.DB, payload.user_id, 0);

  if (quest.elite) {
    await deleteCharacter(env.DB, payload.user_id);
    await appendLog(env.DB, quest.id, payload.user_id, "death", "perma");
    const lines = [
      ...preamble,
      `💀💀 *${character.name}* the ${character.class} is no more.`,
      `_Cause: ${quest.scene.monster_name}. Elite quest — perma-death enforced._`,
      `Roll a new hero with \`/dnd roll\`.`,
    ];
    await postToThread(env, quest, lines.join("\n"));
    return ephemeral(lines.join("\n"));
  }

  // Soft death.
  const scar = generateScar(quest.scene.monster_name);
  const { goldLost, itemLost } = await applySoftDeath(env.DB, character, scar, DOWNED_COOLDOWN_MS);
  await appendLog(env.DB, quest.id, payload.user_id, "death", `soft, -${goldLost} gold`);

  const recoveryTs = Math.floor((Date.now() + DOWNED_COOLDOWN_MS) / 1000);
  const lines = [
    ...preamble,
    `💀 *${character.name}* is *downed*.`,
    `Lost ${goldLost} gold${itemLost ? ` and *${itemLost}*` : ""}. New scar: _${scar}_.`,
    `Recover by <!date^${recoveryTs}^{date_short_pretty} {time}|in ~12h>.`,
  ];
  await postToThread(env, quest, lines.join("\n"));
  return ephemeral(lines.join("\n"));
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
