// Engineering-themed classes, NPC name generation, dice.

export interface CharClass {
  id: string;
  name: string;
  base_hp: number;
  blurb: string;
}

export const CLASSES: CharClass[] = [
  { id: "devops_mage",       name: "DevOps Mage",        base_hp: 22, blurb: "Channels arcane YAML to summon and banish containers." },
  { id: "qa_paladin",        name: "QA Paladin",         base_hp: 28, blurb: "Smites bugs with the sacred light of regression suites." },
  { id: "backend_druid",     name: "Backend Druid",      base_hp: 24, blurb: "Speaks to databases and tames feral microservices." },
  { id: "frontend_bard",     name: "Frontend Bard",      base_hp: 20, blurb: "Charms users with pixel-perfect ballads of CSS." },
  { id: "staff_necromancer", name: "Staff Necromancer",  base_hp: 26, blurb: "Resurrects deprecated APIs from the codebase crypt." },
  { id: "refactor_rogue",    name: "Refactor Rogue",     base_hp: 18, blurb: "Strikes from the shadows; leaves no dead code behind." },
  { id: "sre_warden",        name: "SRE Warden",         base_hp: 30, blurb: "Stands the wall between prod and the howling void." },
  { id: "data_warlock",      name: "Data Warlock",       base_hp: 22, blurb: "Bound to a query plan most mortals dare not read." },
];

export function pickRandomClass(): CharClass {
  return CLASSES[Math.floor(Math.random() * CLASSES.length)];
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
