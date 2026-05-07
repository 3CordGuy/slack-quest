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
  { id: "staff_necromancer", name: "Staff Necromancer",  base_hp: 26, attack_mod: 0, magic_mod: 2, blurb: "Resurrects deprecated APIs from the codebase crypt." },
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

export type ItemType = "weapon" | "armor" | "consumable";
export type Rarity = "common" | "uncommon" | "rare";

export interface ItemRoll {
  type: ItemType;
  rarity: Rarity;
  power: number;
}

// Slot weights are constant — every drop has the same chance to be a sword vs potion vs vest.
function rollItemType(): ItemType {
  const r = Math.random();
  if (r < 0.4) return "weapon";
  if (r < 0.7) return "armor";
  return "consumable";
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
//   consumable   → HP healed on /dnd use
function rollPower(type: ItemType, rarity: Rarity): number {
  if (type === "consumable") {
    if (rarity === "rare") return 25 + rollDice(11);      // 26-35
    if (rarity === "uncommon") return 12 + rollDice(7);   // 13-18
    return 5 + rollDice(4);                               // 6-8 (small)
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

export function sellPrice(rarity: Rarity): number {
  return Math.floor(SHOP_PRICE[rarity] * 0.3);
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
