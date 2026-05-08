// Workers AI helpers. Uses Llama 3.1 8B Instruct — cheap, plenty good for flavor text.

import type { Character } from "./db";
import type { SceneJson } from "./db";
import { fallbackMonsterName, fallbackSceneText } from "./flavor";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface AiRunResponse {
  response?: string;
}

export type SceneVariant = "standard" | "boss" | "gauntlet-wave";

// Two-step opening-scene generation:
//   1. generateMonsterIdentity → picks MONSTER_NAME + MONSTER_HP (small prompt,
//      tight output)
//   2. generateSceneForMonster → writes the SCENE with the chosen name forced
//      as explicit input
//
// Eliminates the name/scene mismatch class of bugs by construction — the scene
// prompt sees the name as input, never invents one. Pays an extra AI call per
// scene-gen, but each call is smaller than the old single-call combined output,
// so total token cost is roughly equivalent. Sequential by necessity (step 2
// needs step 1's output).
export async function generateOpeningScene(
  ai: Ai,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant = "standard",
  waveContext?: { wave: number; total: number },
  avoidNames: string[] = [],
): Promise<SceneJson> {
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));
  const tier = variant === "boss" ? baseTier + 1 : baseTier;

  // Boss has roughly 1.8x the HP ceiling; gauntlet wave is standard.
  const baseFloor = 8 + tier * 4;
  const baseCeil = baseFloor + 12;
  const monsterHpFloor = variant === "boss" ? Math.floor(baseFloor * 1.8) : baseFloor;
  const monsterHpCeil = variant === "boss" ? Math.floor(baseCeil * 1.8) : baseCeil;

  // Step 1: pick a name + HP, with the avoid-list applied here.
  const identity = await generateMonsterIdentity(
    ai, variant, monsterHpFloor, monsterHpCeil, avoidNames, waveContext,
  );
  // Step 2: write the scene around the chosen name.
  const scene = await generateSceneForMonster(
    ai, identity.name, character, elite, variant, waveContext,
  );

  return {
    monster_name: identity.name,
    monster_hp: identity.hp,
    monster_max_hp: identity.hp,
    tier,
    scene,
  };
}

// Step 1 of opening-scene generation: pick a name + HP. Tiny output — Llama
// nails the format with the focused prompt + smaller max_tokens budget.
async function generateMonsterIdentity(
  ai: Ai,
  variant: SceneVariant,
  hpFloor: number,
  hpCeil: number,
  avoidNames: string[],
  waveContext?: { wave: number; total: number },
): Promise<{ name: string; hp: number }> {
  const variantHint =
    variant === "boss"
      ? "BOSS encounter — name should be imposing, multi-word, slightly mythic."
      : variant === "gauntlet-wave"
      ? `Wave ${waveContext?.wave}/${waveContext?.total} of a gauntlet — name should be punchy, single archetype.`
      : "Standard foe — slightly absurd, single concept.";

  // Avoid-list with core-noun guidance.
  const avoidLines: string[] = [];
  if (avoidNames.length > 0) {
    const cleaned = avoidNames.slice(0, 10).map((n) => n.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      avoidLines.push(
        `DO NOT REUSE these recent foes OR their core nouns: ${cleaned.join(", ")}.`,
        "Pick a different core noun entirely (e.g. avoid 'the X Shrieker' if 'the Y Shrieker' is on the list).",
      );
    }
  }

  const system = [
    "You name comedic engineering + project-management themed monsters for Slack Quest.",
    "Tone: dry, witty, software-industry + PM (PRs, standups, sprints, gantt charts, scope creep, retros, kanban, blockers, deprecated APIs, on-call pagers).",
    "Output MUST follow this EXACT format. Plain text only — no markdown, no asterisks, no quotes around values, no commentary.",
    `MONSTER_NAME: <a ${variant === "boss" ? "2-5" : "1-4"} word name>`,
    `MONSTER_HP: <integer between ${hpFloor} and ${hpCeil}>`,
    variantHint,
    ...avoidLines,
  ].join("\n");

  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Pick the next foe now." },
      ],
      max_tokens: 60,
    })) as AiRunResponse;
    const text = res.response ?? "";
    const nameMatch = /\*{0,2}MONSTER_NAME\*{0,2}\s*:\s*(.+)/i.exec(text);
    const hpMatch = /\*{0,2}MONSTER_HP\*{0,2}\s*:\s*\*{0,2}(\d+)/i.exec(text);
    const name = nameMatch?.[1] ? stripWrappers(nameMatch[1].split("\n")[0]) : "";
    let hp = hpMatch ? parseInt(hpMatch[1], 10) : NaN;
    if (Number.isNaN(hp)) hp = Math.floor((hpFloor + hpCeil) / 2);
    hp = Math.min(hpCeil, Math.max(hpFloor, hp));
    if (!name) {
      console.warn("identity parse fallback", { preview: text.slice(0, 160) });
      return { name: fallbackMonsterName(), hp };
    }
    return { name, hp };
  } catch {
    return { name: fallbackMonsterName(), hp: Math.floor((hpFloor + hpCeil) / 2) };
  }
}

// Step 2 of opening-scene generation: write the scene prose with the chosen
// name pinned as input. The prompt is very explicit about using the exact name.
async function generateSceneForMonster(
  ai: Ai,
  monsterName: string,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant,
  waveContext?: { wave: number; total: number },
): Promise<string> {
  const variantLine =
    variant === "boss" ? "Climactic, imposing — single big foe." :
    variant === "gauntlet-wave" ? `Wave ${waveContext?.wave}/${waveContext?.total} — quick, momentum-driven, between breaths.` :
    "Standard quest opening.";
  const system = [
    "You narrate comedic engineering + project-management themed dungeon scenes for Slack Quest.",
    "Tone: dry, witty, software-industry + PM winks (PRs, standups, sprints, gantt charts, scope creep, retros, blockers, MVPs, kanban).",
    "Output ONE paragraph: 2-3 sentences, ~60 words total. Plain text — no markdown, no labels, no quotes around the prose.",
    `The monster's name is "${monsterName}". You MUST refer to it by that EXACT name at least once in the prose. Do not invent any other proper noun for the monster.`,
  ].join("\n");
  const user = [
    `Write the opening scene for ${character.name}, a Level ${character.level} ${character.class}, facing ${monsterName}.`,
    elite ? "ELITE quest — perma-death looms." : "",
    `Beat: ${variantLine}`,
  ].filter(Boolean).join("\n");
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 160,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    if (!text) return fallbackSceneText();
    // Final consistency check — log a warning if the LLM still slipped a different
    // name in (rare with the explicit-name prompt). We return the text anyway since
    // it's still on-tone narration; the alternative is a generic fallback.
    if (!sceneMentionsName(text, monsterName)) {
      console.warn("scene/name mismatch in step-2 regen", { monsterName, preview: text.slice(0, 120) });
    }
    return text;
  } catch {
    return fallbackSceneText();
  }
}

// Strips markdown emphasis (`*`, `_`), surrounding quotes, and code ticks from a
// captured field value. Llama 3.1 8B sometimes wraps fields like `**Foo**` or `"Foo"`
// despite the strict format spec.
function stripWrappers(s: string): string {
  let v = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = v.replace(/^[*_"'`]+/, "").replace(/[*_"'`]+$/, "").trim();
    if (next === v) break;
    v = next;
  }
  return v;
}

// Does the scene prose actually mention the monster's name? Lenient match: case-insensitive,
// strips a leading "the " from the name (so "the Bloat King" matches "Bloat King"), and
// passes if any 2+ consecutive words from the name appear in the scene.
function sceneMentionsName(scene: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").trim();
  const sceneL = scene.toLowerCase();
  const nameL = norm(name);
  if (!nameL) return true;
  if (sceneL.includes(nameL)) return true;
  const words = nameL.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return true;
  // For multi-word names, require any 2 consecutive name words to appear together.
  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      if (sceneL.includes(`${words[i]} ${words[i + 1]}`)) return true;
    }
    return false;
  }
  // Single-word name: match if it shows up anywhere.
  return sceneL.includes(words[0]);
}

// Shared system prompt for one-line combat flavor. Tight constraints — the model gets
// excited and starts writing essays otherwise.
const COMBAT_SYSTEM = [
  'You are the narrator of "Slack Quest", a comedic engineering-themed dungeon crawl Slack bot.',
  "Tone: dry, witty, software-industry + project-management winks (PRs, standups, deprecated APIs, YAML, on-call pagers, 502s, kubernetes, regex, sprints, gantt charts, scope creep, kanban, retros, blockers, story points, the critical path, burndown).",
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
  equippedWeapon?: string,
  equippedArmor?: string,
): Promise<string> {
  const verb = action === "cast"
    ? equippedWeapon
      ? `channels their *${equippedWeapon}* at`
      : "casts a spell at"
    : equippedWeapon
      ? `swings their *${equippedWeapon}* at`
      : "swings a weapon at";
  const intensity = isCrit ? "The blow lands as a CRITICAL hit — devastating." : "The blow connects solidly.";
  const gearHint = equippedWeapon || equippedArmor
    ? ` Mention the gear by name: ${[equippedWeapon && `weapon "${equippedWeapon}"`, equippedArmor && `armor "${equippedArmor}"`].filter(Boolean).join(", ")}.`
    : "";
  const user = `${character.name}, a Level ${character.level} ${character.class}, ${verb} ${monsterName}. ${intensity} Narrate this single moment in-world.${gearHint}`;
  const fallback = isCrit
    ? `${character.name} lands a brutal blow on ${monsterName}${equippedWeapon ? ` with their ${equippedWeapon}` : ""}.`
    : `${character.name} strikes ${monsterName}${equippedWeapon ? ` with their ${equippedWeapon}` : ""}.`;
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
//
// Note: this function is for items whose names are AI-generated (weapon, armor,
// consumable, magic, revive). Tool & scroll catalog items use flavorCatalogItem
// instead — their names are fixed and the AI only writes the flavor blurb.
export async function flavorLootDrop(
  ai: Ai,
  monsterName: string,
  type: "weapon" | "armor" | "consumable" | "magic" | "revive",
  rarity: "common" | "uncommon" | "rare",
  power: number,
  weaponRange?: "melee" | "ranged",
): Promise<{ name: string; flavor: string }> {
  const weaponHint = type === "weapon"
    ? weaponRange === "ranged"
      ? "a RANGED weapon (e.g. crossbow, bow, sling, throwing dart, scroll-launcher, blunderbuss)"
      : "a MELEE weapon (e.g. sword, hammer, dagger, staff, gauntlet, mace, axe)"
    : null;
  const typeHint =
    weaponHint ??
    (type === "armor"  ? "armor (e.g. vest, robe, cloak, helm, plating, gloves)" :
     type === "magic"  ? "a magical focus (e.g. tome, crystal, sigil, talisman, rune-stone)" :
     type === "revive" ? "a revival item (e.g. phoenix down, defib paddles, hot-fix kit, sacred patch)" :
                         "a consumable (e.g. potion, brew, scroll, capsule, energy drink, snack)");
  const rarityHint =
    rarity === "rare" ? "Rare and weighty — name it like a legendary artifact." :
    rarity === "uncommon" ? "Uncommon — slightly notable, has some history." :
    "Common — workmanlike, mildly absurd is fine.";
  const powerHint =
    type === "consumable" ? `It restores about ${power} HP when used.` :
    type === "magic" ? `It permanently grants +${power} maximum mana when consumed.` :
    type === "revive" ? `It revives a downed party member to ${power}% of their max HP.` :
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

// Flavor text for a catalog item (tool/scroll). The name is fixed by the catalog;
// this only generates the one-line description. Falls back to the catalog blurb if
// the model misbehaves.
export async function flavorCatalogItem(
  ai: Ai,
  catalogName: string,
  blurb: string,
  location: string,
): Promise<string> {
  const system = [
    'You are the narrator of "Slack Quest", a comedic engineering + project-management themed dungeon crawl Slack bot.',
    "Tone: dry, witty, software-industry winks (PRs, standups, sprints, gantt charts, scope creep, kanban, deprecated APIs, on-call pagers).",
    "Output ONE line: a 1-2 sentence flavor description (~25 words). No markdown, no quotes, no name field, no labels. Just the prose.",
    `Item: ${catalogName} — ${blurb}`,
  ].join("\n");
  const user = `Found in ${location}. Describe how this specific ${catalogName} looks/feels in 1-2 dry, witty sentences.`;
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 80,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    return text || blurb;
  } catch {
    return blurb;
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
  equippedWeapon?: string,
  equippedArmor?: string,
): Promise<string> {
  const intensity = isCrit ? "It lands as a CRITICAL strike — devastating." : "It lands true.";
  const gearHint = equippedWeapon || equippedArmor
    ? ` Work the gear into the moment: ${[equippedWeapon && `weapon "${equippedWeapon}"`, equippedArmor && `armor "${equippedArmor}"`].filter(Boolean).join(", ")}.`
    : "";
  const user = `${character.name}, a Level ${character.level} ${character.class}, just unleashes their signature ability *${signatureName}* on ${monsterName}. ${intensity} Narrate the moment with extra weight — this is a class-defining move.${gearHint}`;
  const fallback = isCrit
    ? `${character.name}'s ${signatureName}${equippedWeapon ? `, channeled through their ${equippedWeapon},` : ""} crashes into ${monsterName} like a falling stack trace.`
    : `${character.name} channels ${signatureName}${equippedWeapon ? ` through their ${equippedWeapon}` : ""} at ${monsterName}.`;
  return generateFlavor(ai, user, fallback, 110);
}

// Generates a trap room: scene description + 3 disarm-option texts. The skill type
// for each option is fixed by caller (one str, one dex, one int) — the AI just
// fills in what those skills look like in this scenario.
export interface GeneratedTrap {
  scene: string;
  options: { str: string; dex: string; int: string };
}

export async function generateTrapRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
): Promise<GeneratedTrap> {
  const user = [
    `You are running room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    "This room contains a TRAP. Generate scene + 3 disarm options matching three approaches:",
    "  STR — brute force (smash, charge, bend, lift)",
    "  DEX — finesse (disarm, slip past, defuse, sneak)",
    "  INT — wits (decode, riddle, calculate, identify)",
    "Output exactly:",
    "SCENE: <2 sentences, ~35 words, set the trap with menace>",
    "STR: <imperative phrase, 4-6 words>",
    "DEX: <imperative phrase, 4-6 words>",
    "INT: <imperative phrase, 4-6 words>",
  ].join("\n");

  const fallback: GeneratedTrap = {
    scene: "A pressure plate clicks under your boot. The room hisses — definitely a trap.",
    options: {
      str: "Smash through the wall",
      dex: "Disarm the trigger gently",
      int: "Decode the warding glyphs",
    },
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
    const str = /STR:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const dex = /DEX:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const int = /INT:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !str || !dex || !int) return fallback;
    return { scene, options: { str, dex, int } };
  } catch {
    return fallback;
  }
}

export async function generateLockboxScene(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
): Promise<string> {
  const user = `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}". This room has a *locked* chest. Narrate the discovery in 2 sentences (~35 words). Hint that without a key, players can only walk past empty-handed.`;
  const fallback = "A chest sits at the room's center, bound in three iron locks and humming with promise. You'd need a key — or your conscience to leave it.";
  return generateFlavor(ai, user, fallback, 110);
}

export interface GeneratedNpc {
  scene: string;
  greeting: string;
}

export async function generateNpcRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
  npcName: string,
): Promise<GeneratedNpc> {
  const user = [
    `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    `An NPC named "${npcName}" is here, offering an item to the party.`,
    "Output exactly:",
    "SCENE: <2 sentences setting the encounter — what they look like, what they're doing>",
    "GREETING: <1-2 sentences of what they say to the party, offering their wares>",
  ].join("\n");

  const fallback: GeneratedNpc = {
    scene: "A figure in patched robes warms hands by a battered terminal. They look up and grin.",
    greeting: `"You look like trustworthy adventurers. I've got something you might want — for the right offer."`,
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 180,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const greeting = /GREETING:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !greeting) return fallback;
    return { scene, greeting };
  } catch {
    return fallback;
  }
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
