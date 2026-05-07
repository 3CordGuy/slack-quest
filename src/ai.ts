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
    "You are the narrator of a comedic engineering-themed dungeon crawl Slack bot called Slack Quest.",
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

// Shared system prompt for one-line combat flavor. Tight constraints — the model gets
// excited and starts writing essays otherwise.
const COMBAT_SYSTEM = [
  'You are the narrator of "Slack Quest", a comedic engineering-themed dungeon crawl Slack bot.',
  "Tone: dry, witty, software-industry winks (PRs, standups, deprecated APIs, YAML, on-call pagers, 502s, kubernetes, regex).",
  "Never break character. Never mention you are an AI.",
  "Output ONE line, 1-2 sentences, ~25 words MAX. No markdown formatting. No emoji. Do not include numbers, HP values, or damage amounts.",
].join("\n");

// Strips a leading first-person/template fragment if the model echoes the prompt back.
function cleanFlavor(s: string): string {
  return s
    .trim()
    .replace(/^(here['']s|here is|narration:|line:)\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

async function generateFlavor(
  ai: Ai,
  userPrompt: string,
  fallback: string,
  maxTokens = 90,
): Promise<string> {
  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    })) as AiRunResponse;
    const cleaned = cleanFlavor(result.response ?? "");
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

interface FighterRef {
  name: string;
  class: string;
  level: number;
}

export async function flavorHit(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  action: "attack" | "cast",
  isCrit: boolean,
): Promise<string> {
  const verb = action === "cast" ? "casts a spell at" : "swings a weapon at";
  const intensity = isCrit ? "The blow lands as a CRITICAL hit — devastating." : "The blow connects solidly.";
  const user = `${character.name}, a Level ${character.level} ${character.class}, ${verb} ${monsterName}. ${intensity} Narrate this single moment in-world.`;
  const fallback = isCrit
    ? `${character.name} lands a brutal blow on ${monsterName}.`
    : `${character.name} strikes ${monsterName}.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorJoin(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
): Promise<string> {
  const user = `${character.name}, a Level ${character.level} ${character.class}, has just arrived mid-fight to join the party against ${monsterName}. Narrate their dramatic entrance.`;
  const fallback = `${character.name} the ${character.class} arrives to join the fight against ${monsterName}.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorFleeSuccess(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  partyContinues: boolean,
): Promise<string> {
  const tail = partyContinues
    ? "The rest of the party fights on without them."
    : "Nobody is left to fight; the quest ends in retreat.";
  const user = `${character.name}, a Level ${character.level} ${character.class}, just successfully fled from ${monsterName}. ${tail} Narrate the escape with wry humor.`;
  const fallback = `${character.name} slips away from ${monsterName} and lives to debug another day.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorDeath(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  isPerma: boolean,
): Promise<string> {
  const user = isPerma
    ? `${character.name}, a Level ${character.level} ${character.class}, has just been permanently slain by ${monsterName} in an elite quest. Write a brief, dignified-but-comedic obituary line in-world.`
    : `${character.name}, a Level ${character.level} ${character.class}, was just dropped to 0 HP by ${monsterName} and is now downed. They'll recover after a 12-hour cooldown. Narrate the indignity in one line.`;
  const fallback = isPerma
    ? `${character.name} falls before ${monsterName}, never to compile again.`
    : `${character.name} crumples under ${monsterName}'s onslaught.`;
  return generateFlavor(ai, user, fallback, 110);
}

export async function flavorVictory(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  partySize: number,
): Promise<string> {
  const partyText = partySize === 1 ? "fighting solo" : `fighting alongside ${partySize - 1} other heroes`;
  const user = `${character.name}, a Level ${character.level} ${character.class} ${partyText}, just landed the killing blow on ${monsterName}. Narrate the triumph.`;
  const fallback = `${character.name} delivers the killing blow. ${monsterName} is no more.`;
  return generateFlavor(ai, user, fallback, 110);
}
