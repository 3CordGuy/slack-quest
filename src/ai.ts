// Workers AI helpers. Uses Llama 3.1 8B Instruct — cheap, plenty good for flavor text.

import type { Character } from "./db";
import type { SceneJson } from "./db";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface AiRunResponse {
  response?: string;
}

export async function generateOpeningScene(
  ai: Ai,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
): Promise<SceneJson> {
  const tier = Math.max(1, character.level + (elite ? 1 : 0));
  const monsterHpFloor = 8 + tier * 4;
  const monsterHpCeil = monsterHpFloor + 12;

  const system = [
    "You are the narrator of a comedic engineering-themed dungeon crawl Slack bot called Gantt-Quest.",
    "Tone: dry, witty, with software-industry winks (PRs, standups, deprecated APIs, on-call pagers).",
    "Never break character. Never mention you are an AI.",
    "Output MUST follow this exact format with one field per line:",
    "MONSTER_NAME: <a 1-4 word name, slightly absurd>",
    `MONSTER_HP: <integer between ${monsterHpFloor} and ${monsterHpCeil}>`,
    "SCENE: <2-3 sentences, ~60 words total, introducing the monster and the setting>",
  ].join("\n");

  const user = [
    `The hero is ${character.name}, a Level ${character.level} ${character.class}.`,
    elite ? "This is an ELITE quest — perma-death is in effect. Make it feel weighty." : "This is a standard quest.",
    "Generate the opening scene now.",
  ].join("\n");

  const result = (await ai.run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 220,
  })) as AiRunResponse;

  return parseScene(result.response ?? "", tier, monsterHpFloor, monsterHpCeil);
}

function parseScene(text: string, tier: number, hpFloor: number, hpCeil: number): SceneJson {
  const nameMatch = /MONSTER_NAME:\s*(.+)/i.exec(text);
  const hpMatch = /MONSTER_HP:\s*(\d+)/i.exec(text);
  const sceneMatch = /SCENE:\s*([\s\S]+)/i.exec(text);

  const monster_name = nameMatch?.[1]?.trim() || "the Unnamed Thing";
  let monster_hp = hpMatch ? parseInt(hpMatch[1], 10) : Math.floor((hpFloor + hpCeil) / 2);
  if (Number.isNaN(monster_hp)) monster_hp = Math.floor((hpFloor + hpCeil) / 2);
  monster_hp = Math.min(hpCeil, Math.max(hpFloor, monster_hp));

  const scene = sceneMatch?.[1]?.trim() ||
    "A presence stirs in the dim glow of a forgotten staging environment. Something is very, very wrong.";

  return { monster_name, monster_hp, monster_max_hp: monster_hp, tier, scene };
}
