// Workers AI helpers for the web worker. Ports the loot-flavor +
// opening-scene helpers from apps/slack/src/ai.ts; if a third surface
// needs them we'll factor into a shared package.

import { fallbackMonsterName, fallbackSceneText } from "@gantt-quest/core";
import type { Character, SceneJson } from "@gantt-quest/db";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const FAST_MODEL = "@cf/meta/llama-3.2-3b-instruct";

interface AiRunResponse {
  response?: string;
}

export type SceneVariant = "standard" | "boss" | "gauntlet-wave";

// Two-step opening-scene generation:
//   1. generateMonsterIdentity → name + HP (FAST_MODEL, small prompt)
//   2. generateSceneForMonster → scene prose with the name pinned as input
// Eliminates the name/scene mismatch class of bugs by construction.
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
  const baseFloor = 8 + tier * 4;
  const baseCeil = baseFloor + 12;
  const monsterHpFloor = variant === "boss" ? Math.floor(baseFloor * 1.8) : baseFloor;
  const monsterHpCeil = variant === "boss" ? Math.floor(baseCeil * 1.8) : baseCeil;

  const identity = await generateMonsterIdentity(
    ai, variant, monsterHpFloor, monsterHpCeil, avoidNames, waveContext,
  );
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

  const avoidLines: string[] = [];
  if (avoidNames.length > 0) {
    const cleaned = avoidNames.slice(0, 10).map((n) => n.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      avoidLines.push(
        `DO NOT REUSE these recent foes OR their core nouns: ${cleaned.join(", ")}.`,
        "Pick a different core noun entirely.",
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
    const res = (await ai.run(FAST_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Pick the next foe now." },
      ],
      max_tokens: 150,
    })) as AiRunResponse;
    const text = res.response ?? "";
    const parsed = parseIdentityResponse(text, hpFloor, hpCeil);
    if (!parsed) {
      return { name: fallbackMonsterName(), hp: Math.floor((hpFloor + hpCeil) / 2) };
    }
    return parsed;
  } catch {
    return { name: fallbackMonsterName(), hp: Math.floor((hpFloor + hpCeil) / 2) };
  }
}

function parseIdentityResponse(
  text: string,
  hpFloor: number,
  hpCeil: number,
): { name: string; hp: number } | null {
  const strictName = /\*{0,2}MONSTER_NAME\*{0,2}\s*:\s*(.+)/i.exec(text);
  const strictHp = /\*{0,2}MONSTER_HP\*{0,2}\s*:\s*\*{0,2}(\d+)/i.exec(text);
  if (strictName?.[1]) {
    const name = stripWrappers(strictName[1].split("\n")[0]);
    let hp = strictHp ? parseInt(strictHp[1], 10) : Math.floor((hpFloor + hpCeil) / 2);
    hp = Math.min(hpCeil, Math.max(hpFloor, hp));
    if (name) return { name, hp };
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = "";
  let hp = NaN;
  for (const raw of lines) {
    const cleaned = raw
      .replace(/^\*{0,2}(monster[_\s]?name|monster[_\s]?hp|name|hp|foe)\*{0,2}\s*:?\s*/i, "")
      .replace(/[:;]+$/, "")
      .trim();
    if (!cleaned) continue;
    const intOnly = /^(\d+)\s*$/.exec(cleaned);
    if (intOnly && Number.isNaN(hp)) {
      const val = parseInt(intOnly[1], 10);
      if (val >= 1 && val <= hpCeil * 3) {
        hp = val;
        continue;
      }
    }
    if (!name && /[A-Za-z]/.test(cleaned)) name = stripWrappers(cleaned);
  }
  if (!name) return null;
  if (Number.isNaN(hp)) hp = Math.floor((hpFloor + hpCeil) / 2);
  hp = Math.min(hpCeil, Math.max(hpFloor, hp));
  return { name, hp };
}

async function generateSceneForMonster(
  ai: Ai,
  monsterName: string,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant,
  waveContext?: { wave: number; total: number },
): Promise<string> {
  const variantLine =
    variant === "boss"
      ? "Climactic, imposing — single big foe."
      : variant === "gauntlet-wave"
        ? `Wave ${waveContext?.wave}/${waveContext?.total} — quick, momentum-driven.`
        : "Standard quest opening.";
  const system = [
    "You narrate comedic engineering + project-management themed dungeon scenes for Slack Quest.",
    "Tone: dry, witty, software-industry + PM winks.",
    "Output ONE paragraph: 2-3 sentences, ~60 words. Plain text — no markdown, no labels, no quotes.",
    `The monster's name is "${monsterName}". You MUST refer to it by that EXACT name at least once.`,
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
      max_tokens: 220,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    return text || fallbackSceneText();
  } catch {
    return fallbackSceneText();
  }
}

// Generates a 3-wave gauntlet: full opening scene for wave 1 + identity
// (name + HP) for waves 2 and 3. All AI calls fire in parallel so the
// total latency is roughly one AI roundtrip (~1.5s) rather than 3-6×.
export async function generateGauntletWaves(
  ai: Ai,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  totalWaves: number,
  avoidNames: string[],
): Promise<{ scene: SceneJson; upcoming_waves: { name: string; max_hp: number }[] }> {
  // Wave-1 scene mirrors a standard gauntlet-wave opening.
  const wave1Promise = generateOpeningScene(
    ai, character, elite, "gauntlet-wave", { wave: 1, total: totalWaves }, avoidNames,
  );
  // Waves 2..N: identity only (name + HP). Same HP range as standard.
  const tier = Math.max(1, character.level + (elite ? 1 : 0));
  const hpFloor = 8 + tier * 4;
  const hpCeil = hpFloor + 12;
  const restPromises: Promise<{ name: string; hp: number }>[] = [];
  for (let w = 2; w <= totalWaves; w++) {
    restPromises.push(
      generateMonsterIdentity(ai, "gauntlet-wave", hpFloor, hpCeil, avoidNames, { wave: w, total: totalWaves }),
    );
  }
  const [wave1, ...rest] = await Promise.all([wave1Promise, ...restPromises]);
  return {
    scene: wave1,
    upcoming_waves: rest.map((r) => ({ name: r.name, max_hp: r.hp })),
  };
}

function stripWrappers(s: string): string {
  let v = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = v.replace(/^[*_"'`]+/, "").replace(/[*_"'`]+$/, "").trim();
    if (next === v) break;
    v = next;
  }
  return v;
}

const COMBAT_SYSTEM = [
  'You are the narrator of "Slack Quest", a comedic engineering-themed dungeon crawl bot.',
  "Tone: dry, witty, software-industry + project-management winks (PRs, standups, deprecated APIs, YAML, on-call pagers, 502s, kubernetes, regex, sprints, gantt charts, scope creep, kanban, retros, blockers, story points, the critical path, burndown).",
  "Never break character. Never mention you are an AI.",
  "Output ONE line, 1-2 sentences, ~25 words MAX. No markdown formatting. No emoji. Do not include numbers, HP values, or damage amounts.",
].join("\n");

// Single-shot AI flavor generation. Returns trimmed text on success or
// `fallback` on any error / empty response. Used by the combat flavor helpers.
async function generateFlavor(
  ai: Ai,
  user: string,
  fallback: string,
  maxTokens = 90,
): Promise<string> {
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    return text || fallback;
  } catch {
    return fallback;
  }
}

interface FlavorFighterRef {
  name: string;
  class: string;
  level: number;
}

// One-line narration of a player's landed attack/cast. Pulled to AI so the
// log doesn't read like raw mechanical events. Crit fork emphasizes
// devastation; non-crit is a beat of contact.
export async function flavorHit(
  ai: Ai,
  fighter: FlavorFighterRef,
  monsterName: string,
  action: "attack" | "cast",
  isCrit: boolean,
): Promise<string> {
  const verb = action === "cast" ? "casts a spell at" : "swings a weapon at";
  const intensity = isCrit
    ? "The blow lands as a CRITICAL hit — devastating."
    : "The blow connects solidly.";
  const user = `${fighter.name}, a Level ${fighter.level} ${fighter.class}, ${verb} ${monsterName}. ${intensity} Narrate this single moment in-world.`;
  const fallback = isCrit
    ? `${fighter.name} lands a brutal blow on ${monsterName}.`
    : `${fighter.name} strikes ${monsterName}.`;
  return generateFlavor(ai, user, fallback);
}

// Victory narration on the killing blow.
export async function flavorVictory(
  ai: Ai,
  fighter: FlavorFighterRef,
  monsterName: string,
  partySize: number,
): Promise<string> {
  const partyText = partySize === 1 ? "fighting solo" : `fighting alongside ${partySize - 1} other heroes`;
  const user = `${fighter.name}, a Level ${fighter.level} ${fighter.class} ${partyText}, just landed the killing blow on ${monsterName}. Narrate the triumph.`;
  const fallback = `${fighter.name} delivers the killing blow. ${monsterName} is no more.`;
  return generateFlavor(ai, user, fallback, 110);
}

// Fighter went to 0 HP. Soft-death; they'll come back after a cooldown.
export async function flavorDeath(
  ai: Ai,
  fighter: FlavorFighterRef,
  monsterName: string,
): Promise<string> {
  const user = `${fighter.name}, a Level ${fighter.level} ${fighter.class}, was just dropped to 0 HP by ${monsterName} and is now downed. They'll recover after a 12-hour cooldown. Narrate the indignity in one line.`;
  const fallback = `${fighter.name} crumples under ${monsterName}'s onslaught.`;
  return generateFlavor(ai, user, fallback, 110);
}

// Flee succeeded. partyContinues=true if the rest of the party is fighting on.
export async function flavorFleeSuccess(
  ai: Ai,
  fighter: FlavorFighterRef,
  monsterName: string,
  partyContinues: boolean,
): Promise<string> {
  const tail = partyContinues
    ? "The rest of the party fights on without them."
    : "Nobody is left to fight; the quest ends in retreat.";
  const user = `${fighter.name}, a Level ${fighter.level} ${fighter.class}, just successfully fled from ${monsterName}. ${tail} Narrate the escape with wry humor.`;
  const fallback = `${fighter.name} slips away from ${monsterName} and lives to debug another day.`;
  return generateFlavor(ai, user, fallback);
}

// AI-flavored name + flavor text for a non-catalog loot drop (weapon /
// armor / consumable / magic / revive). Catalog items (tool / scroll) use
// flavorCatalogItem — their names come from the fixed catalog and only the
// flavor blurb is AI-written.
export async function flavorLootDrop(
  ai: Ai,
  monsterName: string,
  type: "weapon" | "armor" | "consumable" | "magic" | "revive",
  rarity: "common" | "uncommon" | "rare",
  power: number,
  weaponRange?: "melee" | "ranged" | null,
): Promise<{ name: string; flavor: string }> {
  const weaponHint =
    type === "weapon"
      ? weaponRange === "ranged"
        ? "a RANGED weapon (e.g. crossbow, bow, sling, throwing dart, scroll-launcher, blunderbuss)"
        : "a MELEE weapon (e.g. sword, hammer, dagger, staff, gauntlet, mace, axe)"
      : null;
  const typeHint =
    weaponHint ??
    (type === "armor"
      ? "armor (e.g. vest, robe, cloak, helm, plating, gloves)"
      : type === "magic"
        ? "a magical focus (e.g. tome, crystal, sigil, talisman, rune-stone)"
        : type === "revive"
          ? "a revival item (e.g. phoenix down, defib paddles, hot-fix kit, sacred patch)"
          : "a consumable (e.g. potion, brew, scroll, capsule, energy drink, snack)");
  const rarityHint =
    rarity === "rare"
      ? "Rare and weighty — name it like a legendary artifact."
      : rarity === "uncommon"
        ? "Uncommon — slightly notable, has some history."
        : "Common — workmanlike, mildly absurd is fine.";
  const powerHint =
    type === "consumable"
      ? `It restores about ${power} HP when used.`
      : type === "magic"
        ? `It permanently grants +${power} maximum mana when consumed.`
        : type === "revive"
          ? `It revives a downed party member to ${power}% of their max HP.`
          : `It grants a +${power} bonus when equipped.`;

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

// One-line AI flavor for a catalog item (tool / scroll). Name stays
// canonical from the catalog; the model only writes the description.
export async function flavorCatalogItem(
  ai: Ai,
  catalogName: string,
  blurb: string,
  location: string,
): Promise<string> {
  const system = [
    'You are the narrator of "Slack Quest", a comedic engineering + project-management themed dungeon crawl bot.',
    "Tone: dry, witty, software-industry winks.",
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
