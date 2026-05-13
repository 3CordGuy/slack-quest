// Workers AI helpers for the web worker. Duplicates the loot-flavor
// helpers from apps/slack/src/ai.ts; if a third surface needs them we'll
// factor into a shared package.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface AiRunResponse {
  response?: string;
}

const COMBAT_SYSTEM = [
  'You are the narrator of "Slack Quest", a comedic engineering-themed dungeon crawl bot.',
  "Tone: dry, witty, software-industry + project-management winks (PRs, standups, deprecated APIs, YAML, on-call pagers, 502s, kubernetes, regex, sprints, gantt charts, scope creep, kanban, retros, blockers, story points, the critical path, burndown).",
  "Never break character. Never mention you are an AI.",
  "Output ONE line, 1-2 sentences, ~25 words MAX. No markdown formatting. No emoji. Do not include numbers, HP values, or damage amounts.",
].join("\n");

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
