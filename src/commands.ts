// Slash sub-command handlers. Each returns an immediate Slack response payload.
// Long-running work (AI calls, chat.postMessage) goes through ctx.waitUntil.

import type { Env } from "./index";
import { generateOpeningScene } from "./ai";
import {
  createCharacter,
  createQuest,
  getActiveQuestForCharacter,
  getCharacter,
  type Character,
} from "./db";
import { generateNpcName, pickRandomClass, rollDice } from "./flavor";
import { postMessage, respondToCommand, type SlashCommandPayload } from "./slack";

export interface CommandResponse {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: unknown[];
}

const HELP_TEXT = [
  "*Gantt-Quest commands*",
  "• `/dnd roll` — roll a new character",
  "• `/dnd me` — show your character sheet",
  "• `/dnd quest` — start a standard quest",
  "• `/dnd quest elite` — start an elite quest (perma-death enabled)",
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

function ephemeral(text: string): CommandResponse {
  return { text, response_type: "ephemeral" };
}

function inChannel(text: string): CommandResponse {
  return { text, response_type: "in_channel" };
}
