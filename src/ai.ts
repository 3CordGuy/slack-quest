// Workers AI helpers. Uses Llama 3.1 8B Instruct — cheap, plenty good for flavor text.

import type { Character } from "./db";
import type { SceneJson } from "./db";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface AiRunResponse {
  response?: string;
}

export type SceneVariant = "standard" | "boss" | "gauntlet-wave";

export async function generateOpeningScene(
  ai: Ai,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant = "standard",
  waveContext?: { wave: number; total: number },
): Promise<SceneJson> {
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));
  const tier = variant === "boss" ? baseTier + 1 : baseTier;

  // Boss has roughly 1.8x the HP ceiling; gauntlet wave is standard.
  const baseFloor = 8 + tier * 4;
  const baseCeil = baseFloor + 12;
  const monsterHpFloor = variant === "boss" ? Math.floor(baseFloor * 1.8) : baseFloor;
  const monsterHpCeil = variant === "boss" ? Math.floor(baseCeil * 1.8) : baseCeil;

  const variantLine =
    variant === "boss"
      ? "This is a BOSS encounter — pick a more imposing, multi-word monster name and a scene that sets up a single climactic fight."
      : variant === "gauntlet-wave"
      ? `This is wave ${waveContext?.wave}/${waveContext?.total} of a gauntlet — quick scene, momentum-driven, the heroes are between catching their breath.`
      : "This is a standard quest.";

  const system = [
    "You are the narrator of a comedic engineering-themed dungeon crawl Slack bot called Slack Quest.",
    "Tone: dry, witty, with software-industry winks (PRs, standups, deprecated APIs, on-call pagers).",
    "Never break character. Never mention you are an AI.",
    "Output MUST follow this exact format with one field per line:",
    `MONSTER_NAME: <a ${variant === "boss" ? "2-5" : "1-4"} word name, slightly absurd>`,
    `MONSTER_HP: <integer between ${monsterHpFloor} and ${monsterHpCeil}>`,
    "SCENE: <2-3 sentences, ~60 words total, introducing the monster and the setting>",
  ].join("\n");

  const user = [
    `The hero is ${character.name}, a Level ${character.level} ${character.class}.`,
    elite ? "ELITE quest — perma-death is in effect. Make it feel weighty." : "",
    variantLine,
    "Generate the opening scene now.",
  ].filter(Boolean).join("\n");

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

// AI names + flavors a loot drop. Mechanics (slot, power, rarity) are deterministic;
// the model only writes the name and a one-line description.
// Returns { name, flavor } — falls back to generic stubs if the model misbehaves.
export async function flavorLootDrop(
  ai: Ai,
  monsterName: string,
  type: "weapon" | "armor" | "consumable" | "magic",
  rarity: "common" | "uncommon" | "rare",
  power: number,
): Promise<{ name: string; flavor: string }> {
  const typeHint =
    type === "weapon" ? "a weapon (e.g. sword, hammer, dagger, staff, bow, gauntlet)" :
    type === "armor"  ? "armor (e.g. vest, robe, cloak, helm, plating, gloves)" :
    type === "magic"  ? "a magical focus (e.g. tome, crystal, sigil, talisman, rune-stone)" :
                        "a consumable (e.g. potion, brew, scroll, capsule, energy drink, snack)";
  const rarityHint =
    rarity === "rare" ? "Rare and weighty — name it like a legendary artifact." :
    rarity === "uncommon" ? "Uncommon — slightly notable, has some history." :
    "Common — workmanlike, mildly absurd is fine.";
  const powerHint =
    type === "consumable" ? `It restores about ${power} HP when used.` :
    type === "magic" ? `It permanently grants +${power} maximum mana when consumed.` :
    `It grants a +${power} bonus when equipped.`;

  const user = [
    `Generate loot dropped by ${monsterName} for a comedic engineering-themed dungeon crawl.`,
    `It is ${typeHint}. ${rarityHint} ${powerHint}`,
    "Output exactly two lines, no markdown, no quotes:",
    "NAME: <a 2-5 word punchy themed name>",
    "FLAVOR: <one short sentence, ~15 words, dryly funny, software-industry winks ok>",
  ].join("\n");

  const fallback = {
    name: type === "consumable" ? `Mystery ${rarity} elixir` : `Battered ${rarity} ${type}`,
    flavor: `Dropped by ${monsterName}. Smells faintly of merge conflicts.`,
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 90,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const nameMatch = /NAME:\s*(.+)/i.exec(text);
    const flavorMatch = /FLAVOR:\s*(.+)/i.exec(text);
    const name = nameMatch?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const flavor = flavorMatch?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!name || !flavor) return fallback;
    return { name, flavor };
  } catch {
    return fallback;
  }
}

// Generates the per-node content of an expedition. The model picks a coherent
// theme + 5 scenes; we rely on field markers to parse rather than JSON output
// (llama-3.1-8b is unreliable with strict JSON, very reliable with line markers).
export interface GeneratedExpeditionScene {
  scene: string;
  choices: string[];
}

export async function generateExpeditionForkScene(
  ai: Ai,
  theme: string,
  pathTaken: string[],
  sceneIndex: number,
  totalForks: number,
): Promise<GeneratedExpeditionScene> {
  const history = pathTaken.length > 0
    ? `Choices made so far: ${pathTaken.map((p, i) => `(${i + 1}) ${p}`).join("; ")}.`
    : "This is the opening scene.";

  const user = [
    `You are running an expedition quest with the theme: "${theme}".`,
    `This is fork ${sceneIndex} of ${totalForks}.`,
    history,
    "Generate the next scene + 2 choices. Output exactly:",
    "SCENE: <2 sentences, ~40 words, set the situation>",
    "CHOICE_1: <a short imperative phrase, ~6 words>",
    "CHOICE_2: <a short imperative phrase, ~6 words, meaningfully different from choice 1>",
  ].join("\n");

  const fallback: GeneratedExpeditionScene = {
    scene: "A junction looms. Two paths diverge through the gloom of long-deprecated documentation.",
    choices: ["Take the lit path", "Take the dark path"],
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const c1 = /CHOICE_1:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const c2 = /CHOICE_2:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !c1 || !c2) return fallback;
    return { scene, choices: [c1, c2] };
  } catch {
    return fallback;
  }
}

export async function generateExpeditionTheme(ai: Ai): Promise<string> {
  const user = "Generate a single short evocative theme for an expedition into a hostile codebase. 4-7 words. No quotes. Examples: 'the cursed monorepo merge', 'haunted staging environment', 'forgotten sprint of 2019'.";
  const fallback = "the abandoned staging environment";
  return generateFlavor(ai, user, fallback, 30);
}

export async function flavorForkOutcome(
  ai: Ai,
  theme: string,
  choice: string,
): Promise<string> {
  const user = `Expedition theme: "${theme}". The party just chose: "${choice}". Narrate the immediate consequence in one short line.`;
  const fallback = `The party commits to the path.`;
  return generateFlavor(ai, user, fallback, 80);
}

export async function flavorSignature(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  signatureName: string,
  isCrit: boolean,
): Promise<string> {
  const intensity = isCrit ? "It lands as a CRITICAL strike — devastating." : "It lands true.";
  const user = `${character.name}, a Level ${character.level} ${character.class}, just unleashes their signature ability *${signatureName}* on ${monsterName}. ${intensity} Narrate the moment with extra weight — this is a class-defining move.`;
  const fallback = isCrit
    ? `${character.name}'s ${signatureName} crashes into ${monsterName} like a falling stack trace.`
    : `${character.name} channels ${signatureName} at ${monsterName}.`;
  return generateFlavor(ai, user, fallback, 110);
}

export async function flavorBossPhase(
  ai: Ai,
  monsterName: string,
): Promise<string> {
  const user = `${monsterName} has just been wounded past 50% HP and powers up — second phase of the boss fight begins. Narrate the menacing transformation in one line.`;
  const fallback = `${monsterName} pulses with renewed fury — the fight isn't over yet.`;
  return generateFlavor(ai, user, fallback, 110);
}

export async function flavorGauntletNext(
  ai: Ai,
  prevMonster: string,
  nextMonster: string,
  waveLabel: string,
): Promise<string> {
  const user = `${prevMonster} just fell. Now ${nextMonster} emerges — ${waveLabel} of a gauntlet. Narrate the transition with no rest in between.`;
  const fallback = `Before the dust settles, ${nextMonster} appears — ${waveLabel}.`;
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
