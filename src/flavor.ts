// Engineering-themed classes, NPC name generation, dice.

// Skill leans determine which trap-room option auto-passes for a class. Non-experts
// can still attempt — they roll 1d6 and need 4+ — so every class is *capable* but
// classes built for the moment shine.
export type SkillType = "str" | "dex" | "int";

export interface CharClass {
  id: string;
  name: string;
  base_hp: number;
  attack_mod: number;
  magic_mod: number;
  skills: SkillType[];   // expert types — 1-2 per class
  blurb: string;
}

export const CLASSES: CharClass[] = [
  { id: "devops_mage",       name: "DevOps Mage",        base_hp: 22, attack_mod: 1, magic_mod: 1, skills: ["int", "dex"], blurb: "Channels arcane YAML to summon and banish containers." },
  { id: "qa_paladin",        name: "QA Paladin",         base_hp: 28, attack_mod: 2, magic_mod: 0, skills: ["str"],         blurb: "Smites bugs with the sacred light of regression suites." },
  { id: "backend_druid",     name: "Backend Druid",      base_hp: 24, attack_mod: 1, magic_mod: 1, skills: ["int", "str"],  blurb: "Speaks to databases and tames feral microservices." },
  { id: "frontend_bard",     name: "Frontend Bard",      base_hp: 20, attack_mod: 0, magic_mod: 2, skills: ["int"],         blurb: "Charms users with pixel-perfect ballads of CSS." },
  { id: "staff_sage",        name: "Staff Sage",         base_hp: 26, attack_mod: 0, magic_mod: 2, skills: ["int"],         blurb: "Dispenses ancient wisdom and the occasional postmortem." },
  { id: "refactor_rogue",    name: "Refactor Rogue",     base_hp: 18, attack_mod: 2, magic_mod: 0, skills: ["dex"],         blurb: "Strikes from the shadows; leaves no dead code behind." },
  { id: "sre_warden",        name: "SRE Warden",         base_hp: 30, attack_mod: 2, magic_mod: 0, skills: ["str"],         blurb: "Stands the wall between prod and the howling void." },
  { id: "data_warlock",      name: "Data Warlock",       base_hp: 22, attack_mod: 0, magic_mod: 2, skills: ["int"],         blurb: "Bound to a query plan most mortals dare not read." },
];

// Skill emojis used in trap choice display so players see at a glance which option
// matches their class without needing to memorize names.
export const SKILL_META: Record<SkillType, { emoji: string; label: string }> = {
  str: { emoji: "💪", label: "STR" },
  dex: { emoji: "🔧", label: "DEX" },
  int: { emoji: "📜", label: "INT" },
};

export function pickRandomClass(): CharClass {
  return CLASSES[Math.floor(Math.random() * CLASSES.length)];
}

export function classByName(name: string): CharClass {
  // Falls back to a balanced default so a renamed/stale class string still works.
  return CLASSES.find((c) => c.name === name) ??
    { id: "unknown", name, base_hp: 20, attack_mod: 1, magic_mod: 1, skills: ["int"], blurb: "" };
}

// Per-class haggle modifier — added to the 1d6 haggle roll. Charisma classes (Bard)
// get the biggest bump; persuasive support classes (Sage) and slick rogues get a
// small one. Default 0 for everyone else. Negative mods are reserved for future
// "intimidating" classes that scare merchants off.
export function haggleMod(className: string): number {
  const cls = classByName(className);
  if (cls.id === "frontend_bard") return 2;
  if (cls.id === "refactor_rogue") return 1;
  if (cls.id === "staff_sage") return 1;
  return 0;
}

// Static flavor lines for haggle outcomes. Picked at random per attempt — keeps
// the cost zero (no AI call per click) while still feeling fresh across multiple
// shop visits.
export const HAGGLE_LINES = {
  failed: [
    "The shopkeep snorts. \"You think this is a bazaar? Pay or walk.\"",
    "\"That's the price. I'm not running a charity for engineers.\"",
    "Your pitch lands flat. The shopkeep cracks their knuckles.",
    "\"My grandfather sold this stock at the same price. Show some respect.\"",
    "The shopkeep narrows their eyes. The price holds — and you've made an enemy.",
    "\"Go negotiate with my Q4 budget,\" they growl. Doesn't even blink.",
  ],
  modest: [
    "You point out a scratch on the box. The shopkeep sighs.",
    "\"Fine, fine. But don't tell anyone.\"",
    "After a long pause, the shopkeep mutters something about scope creep and relents.",
    "\"You drive a hard standup,\" they say, slightly impressed.",
  ],
  solid: [
    "The shopkeep barks a laugh. \"Alright, you've earned it.\"",
    "You bring up a competitor's gantt chart. The shopkeep capitulates.",
    "\"That was actually a pretty good critical-path argument. Take the deal.\"",
  ],
  steal: [
    "🎉 The shopkeep is nearly in tears. \"You're a menace. Take it. Take it.\"",
    "🎉 You've turned this into a 1:1. The shopkeep emerges shaken and generous.",
    "🎉 \"That sprint retrospective broke me,\" the shopkeep whispers, defeated.",
  ],
} as const;

// Picks a random line for a given outcome bucket.
export function pickHaggleLine(bucket: "failed" | "modest" | "solid" | "steal"): string {
  const lines = HAGGLE_LINES[bucket];
  return lines[Math.floor(Math.random() * lines.length)];
}

// Fallback monster names — used when the AI response can't be parsed. Themed for the
// engineering dungeon-crawl vibe so even a parse failure feels in-world.
const FALLBACK_MONSTER_NAMES = [
  "the Untested Branch",
  "the Cursed Migration",
  "the Recursion Wraith",
  "the 502 Goblin",
  "the Stale PR",
  "the YAML Revenant",
  "the Thrashing Cache",
  "the Stack Overflow",
  "the Deprecated Mainframe",
  "the Off-by-One Banshee",
  "the Heisenbug Wyrm",
  "the Race Condition",
  "the Null Pointer Lich",
  "the Memory Leak Hydra",
  "the Forgotten Cron",
  "the Schemaless Shrieker",
];

const FALLBACK_SCENES = [
  "A presence stirs in the dim glow of a forgotten staging environment. Something is very, very wrong.",
  "The on-call pager buzzes in the distance — an unwelcome omen. The air smells faintly of burnt JSON.",
  "The terminal blinks. A single line of red logs spools up the screen, hinting at the foe ahead.",
  "Something rummages through the build cache. The sound is wet and recursive.",
  "A monitor flickers ominously. The dashboard shows a metric only mathematicians can love.",
  "The CI pipeline coughs up a warning so old its bug tracker no longer exists. The thing it warned of stands before you.",
];

export function fallbackMonsterName(): string {
  return FALLBACK_MONSTER_NAMES[Math.floor(Math.random() * FALLBACK_MONSTER_NAMES.length)];
}

export function fallbackSceneText(): string {
  return FALLBACK_SCENES[Math.floor(Math.random() * FALLBACK_SCENES.length)];
}

const SCAR_TEMPLATES = [
  "Cleaved by {monster}",
  "Survivor of {monster}",
  "Marked by {monster}",
  "Once-bested by {monster}",
];

export function generateScar(monster: string): string {
  const t = SCAR_TEMPLATES[Math.floor(Math.random() * SCAR_TEMPLATES.length)];
  return t.replace("{monster}", monster);
}

// Loot system: deterministic rolls for slot/rarity/power. AI generates name + flavor on top.

export type ItemType = "weapon" | "armor" | "consumable" | "magic" | "revive" | "tool" | "scroll";

export type WeaponRange = "melee" | "ranged";

export const SHIELD_CAP_MULTIPLIER = 2; // shield caps at SHIELD_CAP_MULTIPLIER × max_hp
export type Rarity = "common" | "uncommon" | "rare";

export const MAX_MANA_CAP = 5;

// Class signature abilities. Each costs 1 mana, shares the 45s combat cooldown,
// and resolves to a damage value via a class-specific formula in combat.ts.
export interface SignatureSpec {
  id: string;
  name: string;
  blurb: string;
}

export const SIGNATURES: Record<string, SignatureSpec> = {
  devops_mage: { id: "detonate", name: "Detonate", blurb: "Drops a payload that bursts on impact." },
  qa_paladin: { id: "smite", name: "Smite", blurb: "Strikes with the weight of a thousand failed builds." },
  backend_druid: { id: "wildgrowth", name: "Wildgrowth", blurb: "Vines of legacy code constrict the foe." },
  frontend_bard: { id: "crescendo", name: "Crescendo", blurb: "A rising chorus the whole party joins." },
  staff_sage: { id: "manifest", name: "Manifest", blurb: "Pure intent shaped into pure damage." },
  refactor_rogue: { id: "backstab", name: "Backstab", blurb: "Slips through the diff and finds the soft spot." },
  sre_warden: { id: "bulwark_strike", name: "Bulwark Strike", blurb: "Turns armor into a weapon." },
  data_warlock: { id: "hex", name: "Hex", blurb: "Curses the foe with a slow query that bleeds them out." },
};

export function signatureFor(className: string): SignatureSpec | null {
  const cls = CLASSES.find((c) => c.name === className);
  if (!cls) return null;
  return SIGNATURES[cls.id] ?? null;
}

export interface ItemRoll {
  type: ItemType;
  rarity: Rarity;
  power: number;
  weapon_range?: WeaponRange; // only set when type === "weapon"
  catalog_name?: string;       // set for type === "tool"|"scroll" — fixed name from CATALOG
}

// Tool & scroll catalog. Names are fixed (no AI naming) so handleUse can dispatch
// effects by name lookup. Each entry encodes its rarity, computed power formula,
// emoji, and a short blurb. AI still flavors each drop's `flavor` text.
//
// Rarity drives price (via TOOL_PRICE / SCROLL_PRICE). Effects are dispatched in
// handleUse via item_name → switch.
export interface CatalogEntry {
  name: string;
  emoji: string;
  type: "tool" | "scroll";
  rarity: Rarity;
  // Power scales with the tier the drop rolled at. Drops do NOT auto-scale at use
  // time — a Caffeine Bomb bought at L1 stays L1-tier forever. Sell or use.
  computePower: (tier: number) => number;
  blurb: string;
}

export const ITEM_CATALOG: CatalogEntry[] = [
  {
    name: "Caffeine Bomb",
    emoji: "🧨",
    type: "tool",
    rarity: "common",
    computePower: (tier) => 2 + Math.max(1, tier),
    blurb: "Single-target nuke. Ignores armor.",
  },
  {
    name: "Hotfix Grenade",
    emoji: "🔥",
    type: "tool",
    rarity: "uncommon",
    computePower: (tier) => 6 + Math.max(1, tier) * 2,
    blurb: "Bigger nuke. Ignores armor. Single-target.",
  },
  {
    name: "Rebase Scroll",
    emoji: "🔄",
    type: "scroll",
    rarity: "uncommon",
    computePower: () => 0,
    blurb: "Free action — wipes party cooldowns + refills party mana to full. Monster doesn't retaliate.",
  },
  {
    name: "Production Outage",
    emoji: "💥",
    type: "scroll",
    rarity: "rare",
    computePower: () => 30, // boss damage % — non-boss instakill
    blurb: "Non-boss: instant kill. Boss: drops 30% HP.",
  },
];

export function findCatalogEntry(name: string): CatalogEntry | undefined {
  return ITEM_CATALOG.find((e) => e.name === name);
}

// Picks a catalog entry of the given type at random. Used by rollItem when the
// item-type roll lands on tool or scroll.
export function rollCatalogEntry(type: "tool" | "scroll"): CatalogEntry {
  const pool = ITEM_CATALOG.filter((e) => e.type === type);
  return pool[Math.floor(Math.random() * pool.length)];
}

// 60% melee / 40% ranged. Melee skews more common because most class signatures
// + the standard /sq attack assume hand-to-hand by default.
function rollWeaponRange(): WeaponRange {
  return Math.random() < 0.6 ? "melee" : "ranged";
}

// Slot weights. Magic items (permanent max_mana boost) and revive items (rare combat
// life-saver) sit at the bottom of the table on purpose — their effects are stronger
// than per-fight gear so the drop rates are throttled.
function rollItemType(): ItemType {
  const r = Math.random();
  if (r < 0.30) return "weapon";       // 30%
  if (r < 0.50) return "armor";        // 20%
  if (r < 0.74) return "consumable";   // 24%
  if (r < 0.86) return "magic";        // 12%
  if (r < 0.92) return "revive";       //  6%
  if (r < 0.97) return "tool";         //  5%
  return "scroll";                     //  3%
}

// Rarity weights skew rarer as the monster tier rises.
function rollRarity(tier: number): Rarity {
  const t = Math.max(1, tier);
  const rareChance = Math.min(0.25, 0.05 + 0.05 * (t - 1));
  const uncommonChance = Math.min(0.45, 0.25 + 0.05 * (t - 1));
  const r = Math.random();
  if (r < rareChance) return "rare";
  if (r < rareChance + uncommonChance) return "uncommon";
  return "common";
}

// Power maps to mechanic by type:
//   weapon/armor → flat modifier added to attack/cast (weapon) or subtracted /2 from incoming dmg (armor)
//   consumable   → HP healed on `<cmd> use`
//   magic        → max_mana increase on `<cmd> use` (capped at MAX_MANA_CAP)
function rollPower(type: ItemType, rarity: Rarity): number {
  if (type === "consumable") {
    if (rarity === "rare") return 25 + rollDice(11);      // 26-35
    if (rarity === "uncommon") return 12 + rollDice(7);   // 13-18
    return 5 + rollDice(4);                               // 6-8 (small)
  }
  if (type === "magic") {
    // Granular max_mana boost. Rarity tiers are flat — caller clamps to MAX_MANA_CAP.
    if (rarity === "rare") return 3;
    if (rarity === "uncommon") return 2;
    return 1;
  }
  if (type === "revive") {
    // Single-tier revive — power is the % HP restored on use.
    if (rarity === "rare") return 100;
    if (rarity === "uncommon") return 75;
    return 50;
  }
  // weapon | armor
  if (rarity === "rare") return 5 + rollDice(2);          // 6-7
  if (rarity === "uncommon") return 3 + rollDice(2);      // 4-5
  return 1 + rollDice(2);                                 // 2-3
}

export function rollItem(tier: number): ItemRoll {
  const type = rollItemType();
  if (type === "tool" || type === "scroll") {
    const entry = rollCatalogEntry(type);
    return {
      type,
      rarity: entry.rarity,
      power: entry.computePower(tier),
      catalog_name: entry.name,
    };
  }
  const rarity = rollRarity(tier);
  const power = rollPower(type, rarity);
  const weapon_range = type === "weapon" ? rollWeaponRange() : undefined;
  return { type, rarity, power, weapon_range };
}

// Per-fighter drop chance after a kill. 35% baseline, +5% per tier.
export function dropChance(tier: number): number {
  return Math.min(0.7, 0.35 + 0.05 * Math.max(0, tier - 1));
}

export const RARITY_BADGE: Record<Rarity, string> = {
  common: "⚪",
  uncommon: "🟢",
  rare: "🟣",
};

// Flat per-rarity pricing. Power varies within rarity but the price doesn't —
// keeps the stock readable and "do I want this?" easy to answer.
export const SHOP_PRICE: Record<Rarity, number> = {
  common: 15,
  uncommon: 50,
  rare: 150,
};

// Magic items grant permanent max_mana — priced higher than consumables/gear of the
// same rarity since the buff lasts forever.
export const MAGIC_PRICE: Record<Rarity, number> = {
  common: 100,
  uncommon: 250,
  rare: 500,
};

// Revive items pull a downed party member back into the fight. Pricier than gear,
// cheaper than rare magic — they're combat-defining but consumed on use.
export const REVIVE_PRICE: Record<Rarity, number> = {
  common: 150,
  uncommon: 280,
  rare: 450,
};

// Tool: tactical one-shot offensive consumables (Caffeine Bomb, Hotfix Grenade).
// Mid-tier pricing — they consume a combat turn and don't auto-scale, so a stockpile
// from L1 becomes irrelevant late.
export const TOOL_PRICE: Record<Rarity, number> = {
  common: 50,
  uncommon: 150,
  rare: 350,
};

// Scroll: party-affecting / boss-altering rituals (Rebase Scroll, Production Outage).
// Steeper than tools — bigger effects (whole-party cooldown reset, boss HP cut).
export const SCROLL_PRICE: Record<Rarity, number> = {
  common: 100,
  uncommon: 250,
  rare: 500,
};

export function priceFor(type: ItemType, rarity: Rarity): number {
  if (type === "magic") return MAGIC_PRICE[rarity];
  if (type === "revive") return REVIVE_PRICE[rarity];
  if (type === "tool") return TOOL_PRICE[rarity];
  if (type === "scroll") return SCROLL_PRICE[rarity];
  return SHOP_PRICE[rarity];
}

export function sellPriceFor(type: ItemType, rarity: Rarity): number {
  return Math.floor(priceFor(type, rarity) * 0.3);
}

export function rollDice(sides: number, count = 1): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
}

// XP threshold to reach a given level. Curve is gentle early, steeper later.
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(50 * Math.pow(level - 1, 1.6));
}

// Cheap syllable-based name generator. Two-part: given + epithet.
const PREFIX = ["Bru", "Ka", "Mor", "Eth", "Vyn", "Tar", "Sel", "Drog", "Lyr", "Quin", "Zar", "Fen", "Aldra", "Wyn"];
const MID    = ["dor", "an", "vek", "is", "ric", "el", "or", "tha", "ix", "een", "us"];
const EPITHET = [
  "the Patient", "the Untested", "Stack-Cleaver", "the Verbose", "of the Long Build",
  "Halflinter", "the Deprecated", "Rebase-Born", "Two-PRs", "the Hotfixed",
  "Thread-Walker", "of the Stale Branch", "the Overcommitted",
];

export function generateNpcName(): string {
  const given = PREFIX[Math.floor(Math.random() * PREFIX.length)] +
                MID[Math.floor(Math.random() * MID.length)];
  const epithet = EPITHET[Math.floor(Math.random() * EPITHET.length)];
  return `${given} ${epithet}`;
}
