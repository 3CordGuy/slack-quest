// Engineering-themed classes, NPC name generation, dice.

export interface CharClass {
  id: string;
  name: string;
  base_hp: number;
  attack_mod: number;
  magic_mod: number;
  blurb: string;
}

export const CLASSES: CharClass[] = [
  { id: "devops_mage",       name: "DevOps Mage",        base_hp: 22, attack_mod: 1, magic_mod: 1, blurb: "Channels arcane YAML to summon and banish containers." },
  { id: "qa_paladin",        name: "QA Paladin",         base_hp: 28, attack_mod: 2, magic_mod: 0, blurb: "Smites bugs with the sacred light of regression suites." },
  { id: "backend_druid",     name: "Backend Druid",      base_hp: 24, attack_mod: 1, magic_mod: 1, blurb: "Speaks to databases and tames feral microservices." },
  { id: "frontend_bard",     name: "Frontend Bard",      base_hp: 20, attack_mod: 0, magic_mod: 2, blurb: "Charms users with pixel-perfect ballads of CSS." },
  { id: "staff_sage",        name: "Staff Sage",         base_hp: 26, attack_mod: 0, magic_mod: 2, blurb: "Dispenses ancient wisdom and the occasional postmortem." },
  { id: "refactor_rogue",    name: "Refactor Rogue",     base_hp: 18, attack_mod: 2, magic_mod: 0, blurb: "Strikes from the shadows; leaves no dead code behind." },
  { id: "sre_warden",        name: "SRE Warden",         base_hp: 30, attack_mod: 2, magic_mod: 0, blurb: "Stands the wall between prod and the howling void." },
  { id: "data_warlock",      name: "Data Warlock",       base_hp: 22, attack_mod: 0, magic_mod: 2, blurb: "Bound to a query plan most mortals dare not read." },
];

export function pickRandomClass(): CharClass {
  return CLASSES[Math.floor(Math.random() * CLASSES.length)];
}

export function classByName(name: string): CharClass {
  // Falls back to a balanced default so a renamed/stale class string still works.
  return CLASSES.find((c) => c.name === name) ??
    { id: "unknown", name, base_hp: 20, attack_mod: 1, magic_mod: 1, blurb: "" };
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

export type ItemType = "weapon" | "armor" | "consumable" | "magic";
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
}

// Slot weights — magic items are rarer than gear/consumables since they grant permanent
// max_mana increases (capped at MAX_MANA_CAP).
function rollItemType(): ItemType {
  const r = Math.random();
  if (r < 0.35) return "weapon";
  if (r < 0.60) return "armor";
  if (r < 0.85) return "consumable";
  return "magic";
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
  // weapon | armor
  if (rarity === "rare") return 5 + rollDice(2);          // 6-7
  if (rarity === "uncommon") return 3 + rollDice(2);      // 4-5
  return 1 + rollDice(2);                                 // 2-3
}

export function rollItem(tier: number): ItemRoll {
  const type = rollItemType();
  const rarity = rollRarity(tier);
  const power = rollPower(type, rarity);
  return { type, rarity, power };
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

export function priceFor(type: ItemType, rarity: Rarity): number {
  return type === "magic" ? MAGIC_PRICE[rarity] : SHOP_PRICE[rarity];
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
