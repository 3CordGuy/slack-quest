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
  // Optional R2 target for flux portrait generation. When supplied, kicks off
  // a monster-art call in parallel with scene text and writes the URL into
  // monster_art_url on the returned SceneJson. Fail-soft: any error returns
  // a scene without the field; combat still loads.
  art?: ArtTarget,
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
  // Run scene text + portrait in parallel — both depend only on identity.
  const [scene, artUrl] = await Promise.all([
    generateSceneForMonster(ai, identity.name, character, elite, variant, waveContext),
    art ? generateMonsterArt(ai, art, identity.name, variant) : Promise.resolve(null),
  ]);
  const result: SceneJson = {
    monster_name: identity.name,
    monster_hp: identity.hp,
    monster_max_hp: identity.hp,
    tier,
    scene,
  };
  if (artUrl) result.monster_art_url = artUrl;
  return result;
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
    "You name comedic engineering + project-management themed monsters for Gantt Quest.",
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
    "You narrate comedic engineering + project-management themed dungeon scenes for Gantt Quest.",
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
  art?: ArtTarget,
): Promise<{ scene: SceneJson; upcoming_waves: { name: string; max_hp: number }[] }> {
  // Wave-1 scene mirrors a standard gauntlet-wave opening.
  const wave1Promise = generateOpeningScene(
    ai, character, elite, "gauntlet-wave", { wave: 1, total: totalWaves }, avoidNames, art,
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
  'You are the narrator of "Gantt Quest", a comedic engineering-themed dungeon crawl bot.',
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
function slotTypeHint(slot: string): string | null {
  switch (slot) {
    case "ring":     return "a finger ring or accessory (e.g. signet ring, debug ring, null-pointer ring, uptime band)";
    case "amulet":   return "a neck amulet or pendant (e.g. data-crystal pendant, uptime medallion, recursion talisman)";
    case "boots":    return "footwear (e.g. runtime sandals, debug boots, null-pointer treads, stack-overflow cleats)";
    case "helmet":   return "head armor (e.g. crash helmet, null-guard visor, incident commander's helm, merge-conflict cap)";
    case "pants":    return "leg armor or trousers (e.g. cargo pants, quantum leggings, debug denims, load-balanced greaves)";
    case "off_hand": return "a shield (e.g. firewall buckler, rate-limiting shield, null-check barrier, abstraction layer)";
    default:         return null;
  }
}

export async function flavorLootDrop(
  ai: Ai,
  monsterName: string,
  type: "weapon" | "armor" | "consumable" | "magic" | "revive",
  rarity: "common" | "uncommon" | "rare",
  power: number,
  weaponRange?: "melee" | "ranged" | "focus" | null,
  slot?: string,
): Promise<{ name: string; flavor: string }> {
  const weaponHint =
    type === "weapon"
      ? weaponRange === "ranged"
        ? "a RANGED weapon (e.g. crossbow, bow, sling, throwing dart, scroll-launcher, blunderbuss)"
        : "a MELEE weapon (e.g. sword, hammer, dagger, staff, gauntlet, mace, axe)"
      : null;
  const typeHint =
    weaponHint ??
    (slot ? (slotTypeHint(slot) ?? "armor (e.g. vest, robe, cloak, helm, plating, gloves)") :
     type === "armor"
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
    'You are the narrator of "Gantt Quest", a comedic engineering + project-management themed dungeon crawl bot.',
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

// =============================================================================
// DUNGEON GENERATION — AI room generators ported from apps/slack/src/ai.ts.
// These are used by the web worker when starting a dungeon expedition.
// =============================================================================

export async function generateExpeditionTheme(ai: Ai): Promise<string> {
  const user = "Generate a single short evocative theme for an expedition into a hostile codebase. 4-7 words. No quotes. Examples: 'the cursed monorepo merge', 'haunted staging environment', 'forgotten sprint of 2019'.";
  const fallback = "the abandoned staging environment";
  return generateFlavor(ai, user, fallback, 30);
}

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

export interface GeneratedMerchant {
  scene: string;
  greeting: string;
}

export async function generateMerchantRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
  merchantName: string,
): Promise<GeneratedMerchant> {
  const user = [
    `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    `A traveling merchant named "${merchantName}" has set up a tiny shop here, mid-dungeon.`,
    "Output exactly:",
    "SCENE: <2 sentences setting the encounter — what their stall looks like, where they came from>",
    "GREETING: <1-2 sentences of what they say to the party, hawking their wares>",
  ].join("\n");

  const fallback: GeneratedMerchant = {
    scene: `${merchantName} has improvised a shopfront from overturned standing-desks and a fluttering Gantt chart.`,
    greeting: `"You look like trouble waiting to happen. Lucky for you, I sell trouble preparation."`,
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

// =============================================================================
// IMAGE GENERATION — flux-1-schnell + R2 cache. Mirrors slack's apps/slack/ai.ts.
// =============================================================================
//
// All art keys live under art/<version>/ in R2 so prompt iteration can be rolled
// out without invalidating older quests' references. Failures are silent — any
// art helper returns null, and callers fall back to no-image rendering.

// Static-view banners (inventory, shop, class portraits, etc.). Bump this when
// the global style anchor changes; the URLs flip to the new keys and old
// images are orphaned in R2 until manually cleared.
const ART_VERSION = "v6";
// Monster portraits use their own version since the monster style differs from
// the global anchor (corporate-fantasy office-dungeon, Ghibli watercolor).
const MONSTER_ART_VERSION = "v8";

// Wrap a bucket + public base-url so art helpers can build full asset URLs
// without leaking the env type into ai.ts. baseUrl points at whichever worker
// serves /img/<key> from this bucket.
export interface ArtTarget {
  bucket: R2Bucket;
  baseUrl: string;
}

const STYLE_ANCHOR =
  "Studio Ghibli style hand-drawn anime illustration — watercolor textures, soft cel-shading, warm cinematic lighting, vibrant saturated colors, painterly brushwork, atmospheric and dreamlike. The kind of art you'd find in a Hayao Miyazaki film like Spirited Away, My Neighbor Totoro, or Howl's Moving Castle. Gentle, whimsical, expressive composition.";

const NEGATIVES =
  "edge-to-edge painted illustration, no card frame, no name plate, no border, no text, no logos, no UI elements";

// Monster portraits get their own anchor — corporate-fantasy office-dungeon
// setting + bright daylight, replacing (not layered on) the global style so
// flux doesn't fight a competing "dim moody" hint.
const MONSTER_STYLE_ANCHOR =
  "Studio Ghibli style hand-drawn anime illustration — watercolor textures, soft cel-shading, vibrant saturated colors, expressive painterly brushwork. The kind of frame you'd see in a Hayao Miyazaki film (Spirited Away / Princess Mononoke / Howl's Moving Castle). SETTING: a corporate-fantasy hybrid world where adventurers fight in a half-stone half-office workplace dungeon. The environment is a high-tech office crossed with a stone keep — warm natural daylight, soft desk lamps, glowing computer monitors lighting the scene. Gantt charts and burndown graphs are pinned to stone walls. Sticky notes and kanban-board cards cover desks. Server racks hum in alcoves. Coffee cups, ergonomic keyboards, mechanical office gear, ethernet cables, and scattered scrolls of printout code are visible in the background. LIGHTING IS BRIGHT, WARM, AND DREAMLIKE — not dim, not shadowy, not dungeon-gloomy. The monster is clearly lit and expressive against the busy office-dungeon backdrop. Whimsical creature design, gentle melancholy or wonder typical of Ghibli antagonists.";

// View-art prompts. Each renders the same image every time — generated once
// on first cache miss, then served from R2 forever. Keys stable across deploys
// so an ART_VERSION bump is what invalidates them. Ported from main's src/ai.ts.
export const VIEW_ART_PROMPTS = {
  inventory:
    "An adventurer's open leather pack laid out on a wooden table, contents spilling: a few potion vials with cork stoppers, a rolled scroll, a worn dagger, a small coin pouch, leather-bound journal. Warm candlelight, top-down 3/4 view. Single still-life composition.",
  channel_shop:
    "Interior of a bustling fantasy curio shop. A friendly shopkeeper smiling behind a polished wooden COUNTER with a brass ring-up bell, ready to serve customers. Shelves behind the counter stocked with neatly labeled corked potion bottles bearing handwritten price tags, weapons hung on display racks, scrolls in cubby holes, jewelry under a glass case. Hanging sign with a coin-and-key logo over the door. Warm lantern light, dust motes in the air. This is a SHOP for buying goods — not a workshop, not a forge, not a workbench. The mood is welcoming commerce.",
  treasure:
    "A heavy ornate chest sits open in the middle of a dim stone chamber, golden light spilling out from inside. Old coins and folded fabric visible. Flagstone floor, faint cobwebs in corners. Single dramatic chest as the focal point.",
  merchant:
    "A hooded fantasy merchant standing behind a portable wooden stall in a dim dungeon corridor. Goods displayed: vials, a coiled rope, two weapons, a small wooden box. Single lantern hanging above. Mysterious mood, face partially shadowed.",
  lockbox_bronze:
    "A small iron-banded wooden chest with a heavy bronze padlock, sitting in a dim stone alcove. Plain rivets and worn iron straps. Dust and cobwebs around the edges. Single chest, focal-point composition.",
  lockbox_silver:
    "An ornate dark-wood chest reinforced with engraved silver bands and a heavy filigreed silver padlock, sitting in a dim stone alcove. Detailed metalwork, slight tarnish. Single chest, focal-point composition.",
  lockbox_gold:
    "A lavishly ornate chest covered in gold-leaf engraving with a massive jeweled gold padlock, sitting on a stone pedestal in a dim chamber. Faint glow from cracks in the lid, polished gilt highlights. Single chest, focal-point composition.",
  class_devops_mage:
    "Three-quarter view portrait of a fantasy wizard in deep robes, hands wreathed in glowing arcane sigils that resemble stylized YAML brackets and container icons, summoning a translucent ethereal box of code. Single figure, dim arcane chamber, dramatic lighting.",
  class_qa_paladin:
    "Three-quarter view portrait of a heavily armored paladin holding a glowing greatsword inscribed with intricate runes, light pouring from the blade onto small bug-like creatures cowering at her feet. Single figure, holy chamber, dramatic lighting.",
  class_backend_druid:
    "Three-quarter view portrait of a bearded druid in green robes with vines running through his hair, kneeling beside a luminous tree whose roots form a network of tabular database glyphs. Single figure, mossy underground grove, dappled magical light.",
  class_frontend_bard:
    "Three-quarter view portrait of an elaborately dressed bard playing a stringed instrument that emits cascading streams of colored pixels and ribbons. Adoring townsfolk in the background. Single figure, warm tavern light, vibrant.",
  class_staff_sage:
    "Three-quarter view portrait of an elderly sage in deep blue robes hunched over a massive ancient tome on a heavy oak desk, surrounded by piles of scrolls and a guttering candle. Single figure, candlelit study, somber mood.",
  class_refactor_rogue:
    "Three-quarter view portrait of a hooded rogue in dark leathers with twin daggers drawn, mid-shadow-step, tangled fragments of broken ghostly code dissolving at her feet. Single figure, dim alley, dramatic shadow.",
  class_sre_warden:
    "Three-quarter view portrait of a grim heavily-armored warrior in dented plate, standing on a great wall, looking out over a howling formless void of swirling chaos. Single figure, dawn light, stoic mood.",
  class_data_warlock:
    "Three-quarter view portrait of a pact-bound warlock in tattered dark robes with glowing eyes, reading from an unholy grimoire whose pages writhe with arcane SQL-like characters and dark tendrils of energy. Single figure, candlelit ritual chamber, sinister atmosphere.",
  town_overview:
    "A small fantasy village at golden hour, panoramic establishing view from a low hillside. A timbered tavern with a hanging sign, a stone temple with a bell-tower, a job-board kiosk at the village square, a smith's forge with smoke rising, an inn with warm lit windows. Cobblestone path winding between them. A few villagers in middle distance. Cozy, lived-in, welcoming.",
  pub_interior:
    "Interior of a cozy fantasy tavern at evening. Sturdy wooden bar with polished brass rail and rows of corked bottles on shelves behind. A few barrels stacked at one end, a hearth crackling at the back, two or three rough wooden tables with high-backed chairs. Lantern light, warm wood tones, hint of pipe smoke. No specific people in close-up — the room is the subject, intimate but not crowded.",
  smithy_interior:
    "Interior of a fantasy blacksmith's workshop. A large iron anvil at center stage with a half-finished sword resting on it. A glowing red-orange forge behind, embers visible. Walls hung with hammers, tongs, files, and a few finished weapons and pieces of armor on display. Sparks frozen in the air, leather apron draped over a wooden stool. Warm fire-light, smoke in the rafters. The room is the subject; no specific smith figure in close-up.",
  inn_interior:
    "Interior of a cozy fantasy inn's main room. Two simple straw cots against one wall, a curtained private bed-alcove against the other. A small stone hearth in the corner with a kettle hanging over the fire. Wooden ceiling beams, a few hung lanterns casting warm orange light, a small rug on the plank floor. Quiet, restful, safe. No specific people in close-up — the room is the subject.",
  apothecary:
    "Interior of a dim fantasy apothecary shop. Shelves lined with labeled glass vials, stoppered bottles in amber and green and blue, bundles of dried herbs hanging from the ceiling, small clay pots of unguents and powders. A heavy wooden counter with a set of brass scales, mortar and pestle, and a few open recipe books. Candlelight, earthy tones, a faint haze of incense. The room is the subject — no specific figure in close-up.",
} as const;

export type ViewArtKey = keyof typeof VIEW_ART_PROMPTS;

function viewArtKeyAndPrompt(shortKey: string, rawPrompt: string): { key: string; fullPrompt: string } {
  return {
    key: `art/views/${ART_VERSION}/${shortKey}.png`,
    fullPrompt: `${rawPrompt} ${STYLE_ANCHOR} ${NEGATIVES}`,
  };
}

// Lazy fetch + background generate for a static view-art banner. Returns the
// public URL when the image is already in R2; on miss, fires generation via
// ctx.waitUntil and returns null this one time. The next call serves cache.
// When ttlMs is set, a cached image older than ttlMs is returned immediately
// (never breaks the UI) while a background regen is queued.
export async function getOrScheduleViewArt(
  ai: Ai,
  art: ArtTarget,
  ctx: ExecutionContext,
  shortKey: ViewArtKey,
  prompt?: string,
  ttlMs?: number,
): Promise<string | null> {
  const raw = prompt ?? VIEW_ART_PROMPTS[shortKey];
  const { key, fullPrompt } = viewArtKeyAndPrompt(shortKey, raw);
  const publicUrl = `${art.baseUrl}/img/${key}`;
  try {
    const existing = await art.bucket.head(key);
    if (existing) {
      if (ttlMs) {
        const uploadedAt = existing.uploaded?.getTime() ?? 0;
        if (Date.now() - uploadedAt > ttlMs) {
          // Stale but serve it — regen in background, don't block the request.
          ctx.waitUntil(generateAndCacheArt(ai, art, key, fullPrompt, `view:${shortKey}`));
        }
      }
      return publicUrl;
    }
  } catch (err) {
    console.warn("view-art:head-error", { shortKey, err: err instanceof Error ? err.message : String(err) });
  }
  ctx.waitUntil(generateAndCacheArt(ai, art, key, fullPrompt, `view:${shortKey}`));
  return null;
}

// One-shot batch pre-gen for every VIEW_ART_PROMPTS entry. Sequential to avoid
// hammering the Workers AI rate limit. Returns per-key status so callers can
// log what happened. Cached keys no-op (one R2 head each).
export async function pregenAllViewArt(
  ai: Ai,
  art: ArtTarget,
): Promise<Array<{ shortKey: string; status: "cached" | "generated" | "failed"; url: string | null }>> {
  const results: Array<{ shortKey: string; status: "cached" | "generated" | "failed"; url: string | null }> = [];
  for (const shortKey of Object.keys(VIEW_ART_PROMPTS)) {
    const prompt = VIEW_ART_PROMPTS[shortKey as ViewArtKey];
    const { key, fullPrompt } = viewArtKeyAndPrompt(shortKey, prompt);
    const publicUrl = `${art.baseUrl}/img/${key}`;
    try {
      const existing = await art.bucket.head(key);
      if (existing) {
        results.push({ shortKey, status: "cached", url: publicUrl });
        continue;
      }
    } catch {
      // Head failure → treat as miss.
    }
    const url = await generateAndCacheArt(ai, art, key, fullPrompt, `view:${shortKey}`);
    results.push({ shortKey, status: url ? "generated" : "failed", url });
  }
  return results;
}

function slugifyMonsterName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";
}

// Per-monster portrait via flux-1-schnell. R2-keyed by name slug so the same
// monster always serves the same image (and quickly from cache on repeats).
// Fail-soft: any error returns null and the scene renders without an image.
export async function generateMonsterArt(
  ai: Ai,
  art: ArtTarget,
  monsterName: string,
  variant: SceneVariant,
): Promise<string | null> {
  const slug = slugifyMonsterName(monsterName);
  const key = `art/${MONSTER_ART_VERSION}/${slug}.png`;
  const variantHint =
    variant === "boss"
      ? " dramatic boss creature, looming, more imposing composition,"
      : variant === "gauntlet-wave"
        ? " a single creature, mid-tier henchman energy,"
        : " a single creature, fantasy interpretation,";
  // SUBJECT first — defines what's painted. We treat the monster name as a
  // literal noun phrase to render, not a fantasy warrior's title. Examples
  // anchor flux on the "break compound name → show the thing" pattern.
  const subject =
    `ILLUSTRATION SUBJECT: depict "${monsterName}" — break the name into its words and paint a scene that shows that exact thing happening or being.` +
    ` Treat the name as a literal noun phrase to illustrate, NOT as a fantasy warrior's title.` +
    ` Examples of the approach: "Bias Bug" = a literal beetle with a skewed/lopsided body; "Race Condition" = two figures colliding mid-stride at a finish line; "Scope Overlord" = a giant figure looming over a tiny worker buried in scrolls.` +
    `${variantHint}`;
  const prompt = `${subject} ${MONSTER_STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `monster:${monsterName}`);
}

// Core image-generation primitive. Checks R2 for the cached object first,
// generates via flux-1-schnell on miss, persists, returns the public URL.
// Fail-soft: returns null on any error.
async function generateAndCacheArt(
  ai: Ai,
  art: ArtTarget,
  key: string,
  prompt: string,
  label: string,
): Promise<string | null> {
  const publicUrl = `${art.baseUrl}/img/${key}`;
  try {
    const existing = await art.bucket.head(key);
    if (existing) {
      console.log("art:cache-hit", { label, key });
      return publicUrl;
    }
  } catch (err) {
    console.warn("art:head-error", { label, err: err instanceof Error ? err.message : String(err) });
  }
  console.log("art:start", { label, key });
  try {
    const result = (await ai.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt,
      steps: 4,
    })) as unknown;
    const bytes = await coerceImageBytes(result);
    if (!bytes) {
      console.warn("art:unrecognized-response", { label, key });
      return null;
    }
    await art.bucket.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    console.log("art:done", { label, key, size: bytes.byteLength });
    return publicUrl;
  } catch (err) {
    console.error("art:error", { label, key, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Defensive coercion for the image-model response. Workers AI has historically
// returned multiple shapes across versions; tolerate them all and surface a
// single Uint8Array.
async function coerceImageBytes(result: unknown): Promise<Uint8Array | null> {
  if (!result) return null;
  if (typeof result === "object" && result !== null && "image" in result) {
    const img = (result as { image?: unknown }).image;
    if (typeof img === "string") {
      try {
        const binary = atob(img);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      } catch {
        return null;
      }
    }
  }
  if (result instanceof ReadableStream) {
    const reader = result.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.byteLength; }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return out;
  }
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return null;
}

// ---------- Town generation helpers (ported from Slack src/ai.ts) ----------
// These have no Slack dependencies — they only require the Ai binding.

export async function generateTownName(
  ai: Ai,
  recentNames: string[] = [],
): Promise<string> {
  const avoidLine = recentNames.length > 0
    ? `\nAvoid these recently-used names: ${recentNames.join(", ")}.`
    : "";
  const user = [
    "Generate a single evocative fantasy-RPG town name with a software-engineering wink.",
    'Examples: "Stale Logfile Township", "The Sprintward Hamlet", "Old Mainbranch on the Hill".',
    "Output ONLY the name itself, nothing else. 3-6 words. No quotes, no preamble.",
    avoidLine,
  ].filter(Boolean).join("\n");
  const fallback = "Stale Logfile Township";
  try {
    const result = (await ai.run(FAST_MODEL, {
      messages: [
        { role: "system", content: "You are a creative fantasy worldbuilder for a software-engineering-themed RPG." },
        { role: "user", content: user },
      ],
      max_tokens: 30,
    })) as AiRunResponse;
    const cleaned = (result.response ?? "")
      .replace(/^name:\s*/i, "")
      .split("\n")[0]
      .trim();
    return cleaned.length >= 3 && cleaned.length <= 60 ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

export interface JobListingFlavor {
  title: string;
  blurb: string;
}

export async function generateJobListing(
  ai: Ai,
  variant: "standard" | "boss" | "dungeon" | "gauntlet",
  townName: string,
): Promise<JobListingFlavor> {
  const variantHint = (() => {
    switch (variant) {
      case "standard": return "A single foe somewhere outside town. Modest difficulty.";
      case "boss": return "A named, beefy foe with two phases. Group recommended.";
      case "dungeon": return "A 5-7 room expedition with traps, lockboxes, NPC encounters, sub-boss + treasure.";
      case "gauntlet": return "Three monsters back-to-back with no rest between waves. No fleeing.";
    }
  })();
  const user = [
    `Generate a posting for a ${variant} job on the ${townName} job board.`,
    `Variant context: ${variantHint}`,
    "",
    "Return STRICTLY VALID JSON in this shape:",
    `{ "title": "<3-7 word evocative job title with software-engineering wink>", "blurb": "<1-2 sentence hook from the poster's perspective>" }`,
    "",
    "Examples:",
    `{ "title": "The Stale PR at the Merge Gate", "blurb": "A goblin is hoarding rebased commits up in the hills. Bring its scalp; we'll pay." }`,
    `{ "title": "Schemaless Shrieker — Sub-cellar", "blurb": "Something old has woken under the data temple. Two phases, by the rumors. Group up." }`,
    `{ "title": "Lost Sprint Crypts", "blurb": "Five rooms, locks, traps, and whatever's haunting the burndown chart. Bring keys." }`,
    "",
    "Output JSON ONLY. No prose. No code fences.",
  ].join("\n");

  const fallback: JobListingFlavor = (() => {
    switch (variant) {
      case "standard": return { title: "Goblin Trouble in the Outskirts", blurb: "Something's been ransacking the kanban field. Bring it down." };
      case "boss": return { title: "The Underlying Bug", blurb: "Old and stubborn, holed up in the temple ruins. Two phases by the rumors." };
      case "dungeon": return { title: "Sprint Crypts", blurb: "Five rooms, locks, traps. Bring keys and friends." };
      case "gauntlet": return { title: "The On-Call Rotation", blurb: "Three pages, three monsters, no rest between. Light a candle." };
    }
  })();

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: "You output strictly valid JSON. No prose, no code fences." },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const raw = (result.response ?? "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw) as Partial<JobListingFlavor>;
    if (typeof parsed.title === "string" && parsed.title.trim().length > 0
        && typeof parsed.blurb === "string" && parsed.blurb.trim().length > 0) {
      return { title: parsed.title.trim(), blurb: parsed.blurb.trim() };
    }
    return fallback;
  } catch {
    return fallback;
  }
}
