// Engineering-themed classes, NPC name generation, dice.

import type { AbilityDef } from "./abilities";
import {
  mageAbilities,
  paladinAbilities,
  druidAbilities,
  bardAbilities,
  sageAbilities,
  rogueAbilities,
  wardenAbilities,
  warlockAbilities,
} from "./abilities/index";

// Skill leans determine which trap-room option auto-passes for a class. Non-experts
// can still attempt — they roll 1d6 and need 4+ — so every class is *capable* but
// classes built for the moment shine.
export type SkillType = "str" | "dex" | "int";

export interface CharClass {
  id: string;
  name: string;
  base_hp: number;
  skills: SkillType[];   // expert types — 1-2 per class
  blurb: string;
  abilities: AbilityDef[];
}

export const CLASSES: CharClass[] = [
  { id: "devops_mage",    name: "DevOps Mage",     base_hp: 22, skills: ["int", "dex"], blurb: "Channels arcane YAML to summon and banish containers.",    abilities: mageAbilities },
  { id: "qa_paladin",     name: "QA Paladin",      base_hp: 28, skills: ["str"],         blurb: "Smites bugs with the sacred light of regression suites.",  abilities: paladinAbilities },
  { id: "backend_druid",  name: "Backend Druid",   base_hp: 24, skills: ["int", "str"],  blurb: "Speaks to databases and tames feral microservices.",        abilities: druidAbilities },
  { id: "frontend_bard",  name: "Frontend Bard",   base_hp: 20, skills: ["int"],         blurb: "Charms users with pixel-perfect ballads of CSS.",           abilities: bardAbilities },
  { id: "staff_sage",     name: "Staff Sage",      base_hp: 26, skills: ["int"],         blurb: "Dispenses ancient wisdom and the occasional postmortem.",   abilities: sageAbilities },
  { id: "refactor_rogue", name: "Refactor Rogue",  base_hp: 18, skills: ["dex"],         blurb: "Strikes from the shadows; leaves no dead code behind.",    abilities: rogueAbilities },
  { id: "sre_warden",     name: "SRE Warden",      base_hp: 30, skills: ["str"],         blurb: "Stands the wall between prod and the howling void.",       abilities: wardenAbilities },
  { id: "data_warlock",   name: "Data Warlock",    base_hp: 22, skills: ["int"],         blurb: "Bound to a query plan most mortals dare not read.",        abilities: warlockAbilities },
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
  return CLASSES.find((c) => c.name === name) ??
    { id: "unknown", name, base_hp: 20, skills: ["int"], blurb: "", abilities: [] };
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

// Per-class NPC-trust modifier — added to the 1d6 trust roll. Reading-people
// classes (Bard, Sage) and paranoid types (Warlock) catch betrayals more often.
// Slick rogues lean street-smart. Other classes take it on the chin.
export function npcTrustMod(className: string): number {
  const cls = classByName(className);
  if (cls.id === "frontend_bard") return 2;
  if (cls.id === "staff_sage") return 2;
  if (cls.id === "refactor_rogue") return 1;
  if (cls.id === "data_warlock") return 1;
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

// Static flavor lines for NPC-trust outcomes. Sketchier classes get more
// frequent betrayals; perceptive ones get clean exchanges.
export const NPC_TRUST_LINES = {
  betrayed: [
    "You hand over your trust. They hand you a knife.",
    "The NPC's smile sours into a sneer as they bolt with your confidence.",
    "Should have read the body language. They cut and run with everything they could grab.",
    "\"Thanks for the trust!\" they shout, already three corridors away.",
    "You feel the prick of a hidden blade as they vanish into the gloom.",
    "Turns out the offered satchel was a decoy. They lift a pouch from your belt instead.",
  ],
  tainted: [
    "They press a satchel into your hand — only later do you notice the cuts on your palm.",
    "The bargain holds, but something about that handshake felt wrong.",
    "You take the offered item. The NPC's grin lingers a beat too long.",
    "A fair trade — though the satchel's drawstring is suspiciously sticky.",
    "You leave with the goods. You also leave with a slow leak.",
  ],
  clean: [
    "The stranger presses the satchel into your hand and vanishes with a nod.",
    "An honest deal in unhonest times.",
    "They wish you well — and they actually mean it.",
    "The NPC tips their hood and slips into the shadows. The item's yours, no strings.",
    "\"Don't tell anyone where you got it,\" they whisper, then they're gone.",
  ],
} as const;

export function pickNpcTrustLine(bucket: "betrayed" | "tainted" | "clean"): string {
  const lines = NPC_TRUST_LINES[bucket];
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

// 8-slot equipment system (Phase 2). Items carry a `slot` field indicating
// which body location they occupy when equipped. The equip-swap logic unequips
// any other item in the same slot before equipping the new one.
//   main_hand — primary weapon
//   off_hand  — shield only in Phase 2 (dual-wield deferred to Phase 5)
//   body      — chest armor
//   helmet    — head armor (armor_power contribution: floor(power/2))
//   pants     — leg armor (armor_power contribution: floor(power/4))
//   boots     — footwear (stat_bonus only, no armor contribution)
//   ring      — finger ring (stat_bonus only)
//   amulet    — neck amulet (stat_bonus only)
export type EquipSlot =
  | "main_hand"
  | "off_hand"
  | "body"
  | "helmet"
  | "pants"
  | "boots"
  | "ring"
  | "amulet";

// Status effects — applied to player characters or monsters and tick on the
// affected actor's own combat action / monster turn. v1 set is HP-based; future
// effects could touch cooldown, damage modifiers, etc.
export type EffectType = "regen" | "bleeding" | "burning" | "poisoned" | "empowered" | "frozen" | "shocked" | "stunned" | "hexed" | "entangled" | "barkskin" | "animal_form";

// Elemental damage type carried by rare+ weapons and assigned to monsters.
export type ElementType = "fire" | "ice" | "lightning";

export interface EffectMeta {
  emoji: string;
  name: string;
  // "buff" = HoT or beneficial; "debuff" = DoT or harmful; "passive" = no HP delta.
  kind: "buff" | "debuff" | "passive";
  // True if the per-tick HP change ignores armor (currently informational —
  // ticks apply directly to HP without the armor reduction in performMonsterTurn).
  ignoresArmor: boolean;
  blurb: string;
  // UI pill display (rpg-awesome icon name without ra- prefix, CSS color hex).
  icon: string;
  color: string;
}

export const EFFECT_META: Record<EffectType, EffectMeta> = {
  regen:     { emoji: "🟢", name: "Regen",     kind: "buff",    ignoresArmor: true,  blurb: "Restores HP each action.",                                                icon: "regeneration",   color: "#4ade80" },
  bleeding:  { emoji: "🔴", name: "Bleeding",  kind: "debuff",  ignoresArmor: false, blurb: "Loses HP each action.",                                                   icon: "bleeding-wound", color: "#f87171" },
  burning:   { emoji: "🔥", name: "Burning",   kind: "debuff",  ignoresArmor: true,  blurb: "Loses HP each action; ignores armor.",                                    icon: "fire",           color: "#fb923c" },
  poisoned:  { emoji: "☠️", name: "Poisoned",  kind: "debuff",  ignoresArmor: true,  blurb: "Loses HP each turn.",                                                     icon: "poison-cloud",   color: "#c084fc" },
  empowered: { emoji: "⚡", name: "Empowered", kind: "passive", ignoresArmor: false, blurb: "+25% damage dealt for N turns.",                                          icon: "aura",           color: "#f59e0b" },
  frozen:    { emoji: "❄️", name: "Frozen",    kind: "passive", ignoresArmor: false, blurb: "Skips next action.",                                                      icon: "ice-bolt",       color: "#93c5fd" },
  shocked:   { emoji: "🌩️", name: "Shocked",   kind: "passive", ignoresArmor: false, blurb: "Takes +30% damage from all sources.",                                    icon: "electric",       color: "#fbbf24" },
  stunned:   { emoji: "📦", name: "Stunned",   kind: "passive", ignoresArmor: false, blurb: "Containerized — skips swings with escalating 30%/turn break chance.",    icon: "fluffy-swirl",   color: "#a78bfa" },
  hexed:     { emoji: "🔮", name: "Hexed",     kind: "passive", ignoresArmor: false, blurb: "Deals -25% damage. Takes 3 bleed stacks whenever it takes damage.",      icon: "death-skull",    color: "#a855f7" },
  entangled: { emoji: "🌿", name: "Entangled", kind: "debuff",  ignoresArmor: false, blurb: "-4 to attack rolls.",                                                     icon: "vine-whip",      color: "#86efac" },
  barkskin:    { emoji: "🍃", name: "Barkskin",    kind: "passive", ignoresArmor: false, blurb: "Hardened skin — bonus AC for N turns.",              icon: "leaf",      color: "#a3e635" },
  animal_form: { emoji: "🐺", name: "Animal Form", kind: "buff",    ignoresArmor: false, blurb: "Transformed — mag + 25% stat boost active.",          icon: "wolf-head", color: "#f97316" },
};

export const ELEMENT_META: Record<ElementType, { emoji: string; name: string; effect: EffectType }> = {
  fire:      { emoji: "🔥", name: "Fire",      effect: "burning" },
  ice:       { emoji: "❄️", name: "Ice",       effect: "frozen"  },
  lightning: { emoji: "🌩️", name: "Lightning", effect: "shocked" },
};

// Governs how a monster's attack is routed through player defenses.
// physical → flat armor reduction; all others → % gear resistance, armor ignored.
export type DamageType = "physical" | "magic" | "fire" | "ice" | "lightning";

export const DAMAGE_TYPE_EMOJI: Record<DamageType, string> = {
  physical:  "⚔️",
  magic:     "✨",
  fire:      "🔥",
  ice:       "❄️",
  lightning: "🌩️",
};

// Proc rate per hit by weapon rarity (only rare+ weapons can have elements).
export const ELEMENT_PROC_RATE: Record<"rare" | "epic" | "legendary", number> = {
  rare: 0.20, epic: 0.30, legendary: 0.40,
};

// Probability a rare+ non-focus weapon receives an element at drop time.
export const ELEMENT_WEAPON_ROLL_CHANCE = 0.35;

// Probability a monster has any elemental affinity (weakness/resistance).
export const MONSTER_ELEMENT_AFFINITY_CHANCE = 0.30;

// Gear resistance rolling. Rings and amulets eligible at rare+;
// armor slots (body/helmet/pants/off_hand shield) eligible at epic+ only.
// Physical is excluded — flat armor reduction handles that.
const RESISTANCE_ELIGIBLE_TYPES: DamageType[] = ["magic", "fire", "ice", "lightning"];

const RESISTANCE_PCT_BY_RARITY: Record<"rare" | "epic" | "legendary", { min: number; max: number }> = {
  rare:      { min: 5,  max: 15 },
  epic:      { min: 10, max: 25 },
  legendary: { min: 20, max: 35 },
};

function rollResistance(slot: EquipSlot, rarity: Rarity, subtype?: string): { type: DamageType; pct: number } | undefined {
  const isAccessory = slot === "ring" || slot === "amulet";
  const isArmorPiece = (slot === "body" || slot === "helmet" || slot === "pants")
    || (slot === "off_hand" && subtype === "shield");

  if (!isAccessory && !isArmorPiece) return undefined;
  if (isAccessory && rarity !== "rare" && rarity !== "epic" && rarity !== "legendary") return undefined;
  if (isArmorPiece && rarity !== "epic" && rarity !== "legendary") return undefined;

  const range = RESISTANCE_PCT_BY_RARITY[rarity as "rare" | "epic" | "legendary"];
  if (!range) return undefined;

  const pct = range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  const type = RESISTANCE_ELIGIBLE_TYPES[Math.floor(Math.random() * RESISTANCE_ELIGIBLE_TYPES.length)];
  return { type, pct };
}

// "focus" weapons are the caster/support tier: wands, staves, codices.
// They don't add to attack/cast/sig damage (the bot zeroes weaponMod
// when range = "focus") and instead boost /sq heal + /sq shield by
// their power, plus grant +1 max mana while equipped.
//
// Keeping focus in the same TEXT column as melee/ranged means no DB
// migration is needed — the existing weapon_range field carries it.
// Old code that switches on melee/ranged needs a focus branch (or
// `(weapon_range ?? "melee") === "ranged"` style fallbacks gracefully
// treat focus as ranged-positioning by accident — we explicitly handle
// the case where it matters).
export type WeaponRange = "melee" | "ranged" | "focus";

// Legacy flat mana bonus kept for the Slack app (legacy code, not scaled).
export const FOCUS_MAX_MANA_BONUS = 1;

// Scaling mana ceiling lift for an equipped focus weapon: 1 + floor(power / 10).
// Base of 1 ensures even a power-0 focus still grants one extra mana; higher-tier
// focuses reward casters proportionally.
export function focusManaBonus(power: number): number {
  return 1 + Math.floor(power / 10);
}

// Per-rarity heal/shield bonus when a focus weapon is equipped. Scales
// the same way weapon power scales for melee/ranged, just applied to
// support actions instead of damage.
export const FOCUS_POWER_BY_RARITY: Record<Rarity, number> = {
  common: 2,
  uncommon: 4,
  rare: 6,
  epic: 9,
  legendary: 12,
};

// Probability that a random "weapon" roll becomes a focus instead of
// melee/ranged. Players who want a damage weapon still get one ~75% of
// the time; focus shows up often enough that healer/support builds
// have a real shot at gear without farming forever.
export const FOCUS_WEAPON_ROLL_CHANCE = 0.25;

export const SHIELD_CAP_MULTIPLIER = 2; // shield caps at SHIELD_CAP_MULTIPLIER × max_hp
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export const MAX_MANA_CAP = 5;

// AbilityId is the string id of any active ability. No longer a closed union —
// adding a new ability only requires updating the ability file itself.
export type AbilityId = string;

export interface ItemRoll {
  type: ItemType;
  rarity: Rarity;
  power: number;
  tier?: number;               // monster tier the item was rolled at — drives price scaling
  weapon_range?: WeaponRange; // only set when type === "weapon"
  catalog_name?: string;       // set for type === "tool"|"scroll" — fixed name from CATALOG
  // Phase 2 additions — present on new armor-subtype rolls (helmet/pants/boots/ring/amulet/shield).
  // Absent on legacy weapon/armor rolls so callers don't need updating for the common path.
  slot?: EquipSlot;
  stat_bonus?: Partial<Record<string, number>>; // e.g. { int_stat: 2 }
  item_subtype?: string;                        // "shield" for off_hand items
  // Elemental affinity — only on rare+ melee/ranged weapons (~35% of eligible drops).
  element?: ElementType;
  // Gear resistance — only on ring/amulet (rare+) or armor slots (epic+).
  // Stored as resist_<type> key inside stat_bonus JSON column; no schema change needed.
  resistance?: { type: DamageType; pct: number };
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
  // Optional effect tag for entries that restore a specific resource rather than dealing damage.
  effect?: "restore_mana" | "heal_hp";
  // True for items sold at the Apothecary — excluded from shop/merchant rolling
  // so they're apothecary-exclusive purchases (but can still drop as monster loot).
  shopExcluded?: boolean;
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
  {
    name: "Espresso Shot",
    emoji: "☕",
    type: "tool",
    rarity: "uncommon",
    // Power = HP regen per action. Effect duration is fixed at 5 actions, applied
    // at use time (handleUse → useEspressoShot).
    computePower: (tier) => 2 + Math.floor(Math.max(1, tier) / 2),
    blurb: "Self-applies 🟢 Regen — restores power HP per action for 5 actions.",
  },
  {
    name: "Poison Vial",
    emoji: "🧪",
    type: "tool",
    rarity: "uncommon",
    // Power = HP per monster turn. Tick count fixed at 4.
    computePower: (tier) => 2 + Math.floor(Math.max(1, tier) / 2),
    blurb: "Applies ☠️ Poisoned to the monster — drains power HP per monster turn for 4 turns.",
    shopExcluded: true,
  },
  // Apothecary items — purchasable from the Apothecary with level-scaled power/price.
  // Also available as random drops at higher tiers, but excluded from shop/merchant rolling.
  {
    name: "Venom Vial",
    emoji: "💉",
    type: "tool",
    rarity: "common",
    computePower: (tier) => 3 + tier,
    blurb: "Applies ☠️ Poisoned to the monster for 4 turns. Damage scales with level.",
    shopExcluded: true,
  },
  {
    name: "Regen Draft",
    emoji: "🫙",
    type: "tool",
    rarity: "common",
    computePower: (tier) => 3 + tier,
    blurb: "Self-applies 🟢 Regen — restores power HP per action for 3 actions. Free action.",
    shopExcluded: true,
  },
  {
    name: "Battle Elixir",
    emoji: "⚗️",
    type: "tool",
    rarity: "uncommon",
    computePower: () => 0,
    blurb: "Grants ⚡ Empowered — boosts damage dealt by 25% for 3 turns. Free action.",
    shopExcluded: true,
  },
];

// Looks up a catalog entry by name. Catalog items are stored in inventory
// with their emoji PREFIXED into the name ("🧪 Poison Vial"), so a plain
// equality check against the catalog's bare name ("Poison Vial") misses.
// We strip a leading emoji + whitespace before matching to make lookups
// robust regardless of whether the caller passes the bare or prefixed form.
//
// This is the bug that caused "/gq use" to report "Unknown effect" for
// every catalog item — items were saved as "🧪 Poison Vial" but the
// dispatcher couldn't match them to the catalog because of the prefix.
// "Staples" — commodity potions that are always in stock at the channel shop
// AND every dungeon merchant. Fixed price, no per-cycle buy cap, infinite
// supply. Separate from ITEM_CATALOG because:
//   (a) we don't want them in the random-loot pool (rolled drops should feel
//       like loot, not commodities)
//   (b) staples bypass the shop's restock + buy-cap machinery entirely
//
// Stored in inventory with the normal item_type so handleUse routes correctly:
// Health potions are item_type="consumable" (existing HP-heal path); mana
// potions are item_type="consumable" too with a name marker so handleUse
// dispatches to the mana-restore branch.
export interface StapleSpec {
  id: string;          // short slug used in slash form (`/sq buy hp`, etc.)
  name: string;        // display name, stored as inventory item_name
  emoji: string;
  effect: "heal_hp" | "restore_mana";
  power: number;       // HP healed OR mana restored on use
  price: number;       // gold
  blurb: string;
}

export const STAPLES: StapleSpec[] = [
  {
    id: "hp",
    name: "Health Potion",
    emoji: "🧪",
    effect: "heal_hp",
    power: 10,
    price: 15,
    blurb: "Restores 10 HP. Always in stock.",
  },
  {
    id: "hp+",
    name: "Greater Health Potion",
    emoji: "🧪",
    effect: "heal_hp",
    power: 25,
    price: 40,
    blurb: "Restores 25 HP. Always in stock.",
  },
  {
    id: "mp",
    name: "Mana Vial",
    emoji: "✨",
    effect: "restore_mana",
    power: 1,
    price: 7,
    blurb: "Restores 1 mana. Always in stock.",
  },
  {
    id: "mp+",
    name: "Mana Flask",
    emoji: "✨",
    effect: "restore_mana",
    power: 3,
    price: 20,
    blurb: "Restores 3 mana. Always in stock.",
  },
];

// Lookup by short id (slash form), display name, or "<emoji> <name>" form
// (handleUse calls this with the prefixed inventory name). Case-insensitive.
export function findStaple(query: string): StapleSpec | undefined {
  const q = query.trim().toLowerCase();
  return STAPLES.find((s) =>
    s.id.toLowerCase() === q
    || s.name.toLowerCase() === q
    || `${s.emoji} ${s.name}`.toLowerCase() === q,
  );
}

// Apothecary staples — Venom Vial, Regen Draft, Battle Elixir. Always in stock
// at the Apothecary. Power and price both scale with the buyer's level so the
// items stay relevant as players progress.
//
// item_type is "tool" so combat dispatch routes them through applyToolOrScroll /
// useToolOrScroll in both web and Slack paths.
export interface ApothecaryStaple {
  id: string;
  name: string;
  emoji: string;
  effect: "poison_enemy" | "regen_self" | "empower_self";
  // Base power before level scaling. power = base_power + level (or 0 for passive buffs).
  base_power: number;
  level_scale: number;   // power += floor(level * level_scale)
  turns: number;         // combat turn duration
  base_price: number;
  level_price: number;   // price += level * level_price
  blurb: string;
}

export const APOTHECARY_STAPLES: ApothecaryStaple[] = [
  {
    id: "venom",
    name: "Venom Vial",
    emoji: "💉",
    effect: "poison_enemy",
    base_power: 3,
    level_scale: 1,
    turns: 4,
    base_price: 30,
    level_price: 5,
    blurb: "Poisons the active monster for 4 turns. Damage and price scale with your level.",
  },
  {
    id: "draft",
    name: "Regen Draft",
    emoji: "🫙",
    effect: "regen_self",
    base_power: 3,
    level_scale: 1,
    turns: 3,
    base_price: 25,
    level_price: 4,
    blurb: "Applies regeneration for 3 combat turns. Healing and price scale with your level.",
  },
  {
    id: "elixir",
    name: "Battle Elixir",
    emoji: "⚗️",
    effect: "empower_self",
    base_power: 0,
    level_scale: 0,
    turns: 3,
    base_price: 55,
    level_price: 7,
    blurb: "Boosts your damage by 25% for 3 combat turns. Price scales with your level.",
  },
];

export function findApothecaryStaple(id: string): ApothecaryStaple | undefined {
  return APOTHECARY_STAPLES.find((s) => s.id === id);
}

// Compute level-scaled power and price for an apothecary staple.
export function apothecaryItemStats(
  staple: ApothecaryStaple,
  level: number,
): { power: number; price: number } {
  return {
    power: staple.base_power + Math.floor(level * staple.level_scale),
    price: staple.base_price + level * staple.level_price,
  };
}

// =============================================================================
// TOWN / PUB
// =============================================================================
//
// The pub serves drinks (catalog below) and hosts AI-generated NPCs with
// pre-baked multi-choice dialog trees. Town infrastructure lives here in
// flavor.ts alongside other catalog-style data (DRINKS sits next to STAPLES;
// types live next to the existing item types).
//
// Drinks split into two effect classes:
//   * *Instant* — fire-and-forget effects (heal HP, restore mana, grant
//     shield). Apply at purchase time; no buff state stored.
//   * *Buff* — stat modifiers that tick down on quest combat actions. Only
//     ONE active drink buff per character at a time; a second drink
//     replaces the first.
//
// Buffs are stored on `characters.drink_buff_json` as a single JSON blob
// rather than the multi-effect `character.effects` array, because:
//   1. The "one at a time" rule maps cleanly to one row field.
//   2. Buffs aren't HP-tick effects (the existing StatusEffect framework
//      assumes per-action HP deltas).
//   3. Combat math reads `character.drink_buff` directly instead of
//      iterating an effect array.
export type DrinkEffectKind =
  | "buff_attack"        // +N to attack dice for `remaining` actions
  | "buff_magic"         // +N to cast/sig magic_mod for `remaining` actions
  | "buff_next_crit"     // next attack/cast/sig is a guaranteed crit
  | "instant_shield"     // +N shield, instant
  | "instant_hp"         // +N HP, instant
  | "instant_mana"       // +N mana, instant
  | "instant_combo";     // multi-effect instant (HP + mana, etc.)

export interface DrinkSpec {
  id: string;
  name: string;
  emoji: string;
  price: number;
  effect: DrinkEffect;
  blurb: string;
}

export type DrinkEffect =
  | { kind: "buff_attack"; magnitude: number; duration: number }
  | { kind: "buff_magic"; magnitude: number; duration: number }
  | { kind: "buff_next_crit" }
  | { kind: "instant_shield"; amount: number }
  | { kind: "instant_hp"; amount: number }
  | { kind: "instant_mana"; amount: number }
  | { kind: "instant_combo"; hp: number; mana: number };

// Active drink buff stored on the character. Only present when there's a
// time-bounded buff in flight; instant effects don't write here.
export interface DrinkBuff {
  // Lowercase mirror of the relevant DrinkEffect kinds. Combat code keys
  // off this to apply the right modifier.
  kind: "buff_attack" | "buff_magic" | "buff_next_crit";
  magnitude: number;        // stat bonus; 1 for next_crit (charges)
  remaining: number;        // actions remaining (1 for next_crit); ignored when fight_duration=true
  drink_id: string;         // for display: emoji + name from the catalog
  fight_duration?: true;    // if set, buff lasts entire fight and is cleared (not written back) at fight end
}

// 8 drinks, two tiers. Starter tier (8-15g) is everyday support; premium tier
// (25-30g) is for the late-game pockets-full crowd. Numbers tuned against the
// existing combat math:
//   * +1 atk = roughly one extra damage on every swing for 3 swings. Worth
//     ~5g compared to a Health Potion's 10 HP. 8g is a fair-but-tempting price.
//   * +5 shield from Iron Brew matches roughly half the value of a 1-mana
//     `/sq shield` (which rolls 1d6 + mag_mod ≈ 5-9), but without spending mana
//     and at the cost of gold instead.
//   * +1 mana from Bitter Tea costs 12g — comparable to a Mana Vial (30g
//     for the same +1) but cheaper because it's gated to between-quest
//     consumption, where staples are useful mid-quest too.
//   * Lucky Sip's guaranteed crit is roughly 1.5-2× a normal attack's damage.
//     Worth 15g compared to two Tavern Ales (16g for +3 over 3 swings).
//   * Premium tier (Whiskey/Reset): 2-3× the starter prices for stronger
//     effects. Aimed at level-5+ players who can afford it.
export const DRINKS: DrinkSpec[] = [
  {
    id: "ale", emoji: "🍺", name: "Tavern Ale", price: 8,
    effect: { kind: "buff_attack", magnitude: 1, duration: 3 },
    blurb: "Cheap, foamy, gives you the courage to swing harder. *+1 attack* for 3 actions.",
  },
  {
    id: "mead", emoji: "🍷", name: "Spiced Mead", price: 8,
    effect: { kind: "buff_magic", magnitude: 1, duration: 3 },
    blurb: "Cinnamon, clove, and a tingle in the fingertips. *+1 magic* for 3 actions.",
  },
  {
    id: "brew", emoji: "🥃", name: "Iron Brew", price: 8,
    effect: { kind: "instant_shield", amount: 5 },
    blurb: "Tastes like ore. Lines your gut with grit. *+5 🛡 shield*, instant.",
  },
  {
    id: "tea", emoji: "🍵", name: "Bitter Tea", price: 12,
    effect: { kind: "instant_mana", amount: 2 },
    blurb: "Clarifies the mind, reignites the channel. *+2 mana*, instant.",
  },
  {
    id: "milk", emoji: "🥛", name: "Frothy Milk", price: 10,
    effect: { kind: "instant_hp", amount: 8 },
    blurb: "Comfort in a glass. The bartender knows. *+8 HP*, instant.",
  },
  {
    id: "lucky", emoji: "💧", name: "Lucky Sip", price: 15,
    effect: { kind: "buff_next_crit" },
    blurb: "A shimmer of fate. Your *next attack/cast/ability is a guaranteed crit*.",
  },
  {
    id: "whiskey", emoji: "🍶", name: "Aged Whiskey", price: 25,
    effect: { kind: "buff_attack", magnitude: 2, duration: 3 },
    blurb: "Smoke, leather, twenty harvests of patience. *+2 attack* for 3 actions.",
  },
  {
    id: "reset", emoji: "🍹", name: "Engineer's Reset", price: 30,
    effect: { kind: "instant_combo", hp: 4, mana: 4 },
    blurb: "Mystery cocktail. Tastes like everything went green. *+4 HP and +4 mana*, instant.",
  },
];

export function findDrink(query: string): DrinkSpec | undefined {
  const q = query.trim().toLowerCase();
  return DRINKS.find((d) =>
    d.id.toLowerCase() === q
    || d.name.toLowerCase() === q
    || `${d.emoji} ${d.name}`.toLowerCase() === q,
  );
}

// Mercenaries for hire at the pub. Always available — they never "run out".
// Per-quest: cleared from the character when the quest ends.
export interface MercSpec {
  id: string;
  name: string;
  blurb: string;           // one-liner shown on the pub hire card
  cost: number;            // gold to hire
  class_label: string;     // display-only class name (not a real CharClass)
  level: number;
  hp: number;
  max_hp: number;
  attack_mod: number;
  weapon_power: number;
  position: "front" | "back";
  weapon_range: "melee" | "ranged";
}

export const MERCS: MercSpec[] = [
  {
    id: "sellsword",
    name: "Dan A.",
    blurb: "Reduces complexity to zero damage. Very approachable.",
    cost: 20,
    class_label: "State Manager",
    level: 3,
    hp: 18,
    max_hp: 18,
    attack_mod: 2,
    weapon_power: 3,
    position: "front",
    weapon_range: "melee",
  },
  {
    id: "bowyer",
    name: "Rich H.",
    blurb: "No virtual DOM, no mercy. Compiles down to raw hits.",
    cost: 40,
    class_label: "Compiler",
    level: 5,
    hp: 15,
    max_hp: 15,
    attack_mod: 3,
    weapon_power: 4,
    position: "back",
    weapon_range: "ranged",
  },
  {
    id: "heavy",
    name: "DHH",
    blurb: "Convention over consultation. You'll take it.",
    cost: 40,
    class_label: "Framework Opinionator",
    level: 5,
    hp: 30,
    max_hp: 30,
    attack_mod: 2,
    weapon_power: 4,
    position: "front",
    weapon_range: "melee",
  },
  {
    id: "blade",
    name: "Brendan E.",
    blurb: "Shipped a language in 10 days. Probably fine.",
    cost: 80,
    class_label: "Language Architect",
    level: 8,
    hp: 22,
    max_hp: 22,
    attack_mod: 5,
    weapon_power: 6,
    position: "front",
    weapon_range: "melee",
  },
  {
    id: "uncle_bob",
    name: "Uncle Bob",
    blurb: "SOLID principles. Five of them. He will use all five.",
    cost: 60,
    class_label: "Clean Coder",
    level: 7,
    hp: 20,
    max_hp: 20,
    attack_mod: 4,
    weapon_power: 5,
    position: "back",
    weapon_range: "ranged",
  },
];

export function findMerc(id: string): MercSpec | undefined {
  return MERCS.find((m) => m.id === id);
}

// Pre-baked NPC dialog tree. AI generates the whole tree at town refresh
// time (one call per NPC), then players navigate it via button clicks.
// Three levels deep is the default: opening + 3 options × (reply + 2-3
// sub-options × (reply + maybe terminal)). Terminal leaves have no
// `options`; the UI shows "🚪 Walk away" on those.
export interface DialogNode {
  npc_says: string;
  options?: DialogOption[];     // omit / empty = terminal node
}

export interface DialogOption {
  player_says: string;          // short button label
  next: DialogNode;
  payload?: DialogPayload;      // optional reward when this branch is picked
}

export type DialogPayload =
  | { type: "rumor"; text: string }
  | { type: "gold"; amount: number }
  | { type: "drink_token"; drink_id: string }   // one free pour of a specific drink
  | { type: "xp"; amount: number };

// An NPC at the pub. Bartender is permanent (one per town); regulars rotate.
export interface NpcSpec {
  id: string;                   // "bartender", "regular_1", "regular_2"
  role: "bartender" | "regular";
  name: string;
  archetype: string;            // "weary engineer", "retired adventurer", ...
  vibe: string;                 // tone hint used in AI prompt
  concern?: string;             // optional topic seed
  dialog: DialogNode;           // pre-baked tree
}

// Archetype pools — hand-written seeds the AI dialog generator gets fed.
// Each entry is a template the AI fleshes out into a name + dialog tree.
// We keep ~6-8 templates per role so the same channel sees variety across
// weekly refreshes (seeded pick from these arrays).
//
// Names are intentionally generic placeholders here — the AI generator
// invents the actual name on each refresh. The archetype/vibe/concern do
// the heavy character lifting.
export interface ArchetypeTemplate {
  archetype: string;            // "weary engineer", "retired adventurer", ...
  vibe: string;                 // tone hints — feeds AI prompt
  concern: string;              // a "what's bothering them" hook
  name_seeds: string[];         // 3-5 plausible first names AI can riff on
}

export const BARTENDER_ARCHETYPES: ArchetypeTemplate[] = [
  {
    archetype: "ex-staff-engineer turned tavern keeper",
    vibe: "dry, knowing, has seen every failure mode at least twice",
    concern: "the new apprentice keeps merging to main without review",
    name_seeds: ["Bramfel", "Cordwin", "Maelthar", "Yshtra"],
  },
  {
    archetype: "boisterous brewer with a chef's pride",
    vibe: "loud, generous, takes the craft very seriously",
    concern: "a rival tavern is undercutting prices using a cursed recipe",
    name_seeds: ["Gorm", "Hella", "Druzh", "Pelinka"],
  },
  {
    archetype: "soft-spoken ex-cleric pouring drinks for atonement",
    vibe: "gentle, patient, listens more than speaks",
    concern: "a former student keeps coming in to drown a grief",
    name_seeds: ["Sephras", "Mirelle", "Aldwen", "Thessa"],
  },
  {
    archetype: "retired adventurer with a famously bad map collection",
    vibe: "rambling, exaggerates everything, names every chair",
    concern: "someone keeps stealing the maps off the back wall",
    name_seeds: ["Old Pelm", "Captain Hask", "Rurik", "Vethra"],
  },
  {
    archetype: "tightly-wound deploy-manager turned bartender",
    vibe: "hyperalert, narrates every pour like a postmortem",
    concern: "the cellar inventory keeps drifting from the manifest",
    name_seeds: ["Korvath", "Lessia", "Tarn", "Bevern"],
  },
  {
    archetype: "war-veteran who refuses to talk about the war",
    vibe: "few words, sharp eyes, every silence is meaningful",
    concern: "a new patron is asking questions they shouldn't",
    name_seeds: ["Vossel", "Drenna", "Hadrik", "Suvia"],
  },
];

export const REGULAR_ARCHETYPES: ArchetypeTemplate[] = [
  {
    archetype: "weary engineer who took a wrong turn out of the team",
    vibe: "tired, cynical, but kind underneath the sarcasm",
    concern: "their last PR is six weeks unmerged and no one will tell them why",
    name_seeds: ["Edrin", "Lornic", "Pessa", "Yveth"],
  },
  {
    archetype: "former boss-killer who lost their nerve at the worst time",
    vibe: "carries a sword they no longer draw; jumpy at sudden movements",
    concern: "rumors of an old foe returning have them rattled",
    name_seeds: ["Kessrin", "Mardun", "Wessa", "Goric"],
  },
  {
    archetype: "self-taught bard between gigs",
    vibe: "smooth-talking, always angling for a free drink and a story",
    concern: "their new ballad keeps getting stuck on the third verse",
    name_seeds: ["Lilial", "Brennan", "Aerith", "Pellow"],
  },
  {
    archetype: "exhausted on-call rotation veteran",
    vibe: "twitches at distant bells, jaw permanently set",
    concern: "their pager went off twice in the last hour and they're ignoring it",
    name_seeds: ["Threva", "Olin", "Mardel", "Sephie"],
  },
  {
    archetype: "junior dev who got lost en route to a different tavern",
    vibe: "wide-eyed, asks too many questions, generally lovable",
    concern: "they don't know how to get home and don't want to admit it",
    name_seeds: ["Pip", "Wren", "Doll", "Castor"],
  },
  {
    archetype: "retired DBA contemplating a return",
    vibe: "speaks in dry koans about indexing, watches everyone carefully",
    concern: "someone has been asking after old query plans",
    name_seeds: ["Halan", "Vessa", "Dornik", "Mreth"],
  },
  {
    archetype: "wandering apothecary with questionable credentials",
    vibe: "warm but evasive, pockets full of unmarked vials",
    concern: "a deal at the next town fell through and they need coin",
    name_seeds: ["Yssel", "Brem", "Trella", "Knox"],
  },
  {
    archetype: "wood-elf scout pretending not to know magic",
    vibe: "guarded, observant, lights a candle without touching it",
    concern: "their cover keeps slipping when the tavern hearth misbehaves",
    name_seeds: ["Sylven", "Aerwen", "Tarion", "Lirella"],
  },
];

// =============================================================================
// STONE-PARCHMENT-DAGGER
// =============================================================================
//
// Multiplayer pub mini-game. Two players each pick one throw; spectators
// can side-bet on either player; resolution pays out per a fixed payout
// formula (see commands.ts handleSpdResolve).
//
// Throw relationships — same shape as rock-paper-scissors with renamed
// pieces fitting the engineering-fantasy bot voice:
//
//   🪨 Stone     crushes 🗡 Dagger
//   🗡 Dagger    cuts    📜 Parchment
//   📜 Parchment wraps   🪨 Stone
//
// Game-logic constants (stake/bet tiers + house bump %) live here too
// so they're scannable next to the rules. Handlers read these directly.

export type SpdThrow = "stone" | "parchment" | "dagger";

export interface SpdThrowMeta {
  emoji: string;
  name: string;
  beats: SpdThrow;
  verb: string;            // past-tense action vs. the throw it beats
}
export const SPD_THROW_META: Record<SpdThrow, SpdThrowMeta> = {
  stone:     { emoji: "🪨", name: "Stone",     beats: "dagger",    verb: "crushed" },
  parchment: { emoji: "📜", name: "Parchment", beats: "stone",     verb: "wrapped" },
  dagger:    { emoji: "🗡", name: "Dagger",    beats: "parchment", verb: "cut" },
};

// Returns 1 if A beats B, -1 if B beats A, 0 on tie.
export function spdCompareThrows(a: SpdThrow, b: SpdThrow): 1 | -1 | 0 {
  if (a === b) return 0;
  return SPD_THROW_META[a].beats === b ? 1 : -1;
}

// Player-stake tiers offered when starting a match. Mirrors Liars' Roll
// for consistency — 10/25/50 reads as "small/standard/spicy."
export const SPD_STAKE_TIERS = [10, 25, 50] as const;
// Spectator bet tiers. Independent from the stake tiers so a spectator
// can bet 5g on a 50g match (small risk, small gain) or 25g on a 10g
// match (big risk on a low-stakes flicker). One bet per spectator per
// match — chosen amount is locked in.
export const SPD_BET_TIERS = [5, 10, 25] as const;
// House bump expressed as a percentage of the TOTAL wagered (player
// stakes + all side bets). The winner takes this as a "tavern wager-
// share" — the bot's contribution that makes betting feel celebratory
// rather than zero-sum.
export const SPD_HOUSE_BUMP_PCT = 0.20;
// Match auto-expiry. Any open match older than this gets swept to
// cancelled+refunded on the next pub/town render. 24h is generous;
// initiators have a full day to find an opponent.
export const SPD_MATCH_EXPIRY_MS = 24 * 60 * 60 * 1000;
// Bump cooldown. Initiator can re-surface a stale open match by
// posting a fresh channel announcement, but only every N minutes —
// otherwise the bump is a spam vector in slow channels.
export const SPD_BUMP_COOLDOWN_MS = 30 * 60 * 1000;

// Deterministic per-day archetype pick. Same channel + same day = same NPCs.
// Mix two stable inputs into a single u32 seed, then xor-shift to spread
// nearby seeds (e.g. consecutive days) into very different selections.
function hashStringToUint(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}
export function pickArchetype<T>(
  pool: T[],
  channelId: string,
  daySalt: number,
  saltModifier: number,    // varies bartender vs. regular_1 vs. regular_2
): T {
  const seed = (hashStringToUint(channelId) ^ Math.imul(daySalt, 2654435761) ^ saltModifier) >>> 0;
  return pool[seed % pool.length];
}

// A single posted job on the channel's Job Board. Wraps a quest variant in
// AI-flavored storytelling chrome. Clicking "Take Job" routes through the
// existing handleQuest flow with this variant — no separate quest engine.
// Jobs are display-only state; multiple players can take the same posted
// job (each gets their own quest), and the job persists on the board until
// the daily refresh.
export interface JobListing {
  id: string;                   // stable within the day, e.g. "job_1"
  variant: "standard" | "boss" | "dungeon" | "gauntlet";
  required_level: number;       // 1 / 3 / 1 / 5 by variant — gates the click
  title: string;                // AI-generated, e.g. "The Stale PR at the Merge Gate"
  blurb: string;                // AI-generated, 1-2 sentence hook
  reward_summary: string;       // hand-formatted display string (XP/gold preview)
}

// Per-channel town state. Refreshes on a daily cadence; town NAME refreshes
// less often (weekly) for persistence feel — tracked via a separate inner
// timestamp.
export interface TownState {
  channel_id: string;
  refreshed_at: number;         // ms — daily refresh stamp
  town_name: string;
  town_name_set_at: number;     // ms — weekly cadence for the name itself
  pub: {
    bartender: NpcSpec;
    regulars: NpcSpec[];        // 2-3
    daily_special_drink_id: string;
  };
  // 📋 Job Board postings. Optional for backwards-compat — older cached
  // states pre-jobboard-rollout won't have it; renderer treats missing as
  // empty and triggers a refresh in the background.
  jobs?: JobListing[];
}

export function findCatalogEntry(name: string): CatalogEntry | undefined {
  // Strip a leading emoji + space. Emojis are non-ASCII Unicode, so we use
  // a permissive prefix match: any leading non-alphanumeric chars + spaces.
  const stripped = name.replace(/^[^A-Za-z0-9]+\s*/, "").trim();
  return ITEM_CATALOG.find((e) => e.name === stripped || e.name === name);
}

// Picks a catalog entry of the given type at random. Used by rollItem when the
// item-type roll lands on tool or scroll. forShop=true excludes apothecary-only
// items so they can't appear in shop or merchant rolled stock.
export function rollCatalogEntry(type: "tool" | "scroll", forShop = false): CatalogEntry {
  const pool = ITEM_CATALOG.filter((e) => e.type === type && (!forShop || !e.shopExcluded));
  return pool[Math.floor(Math.random() * pool.length)];
}

// Weapon-range distribution. Focus weapons roll FOCUS_WEAPON_ROLL_CHANCE
// of the time (~25%); the remaining ~75% splits 60/40 melee/ranged as
// before. Melee skews more common in the damage-weapon bucket because
// most class signatures + the standard /sq attack assume hand-to-hand
// by default.
function rollWeaponRange(): WeaponRange {
  if (Math.random() < FOCUS_WEAPON_ROLL_CHANCE) return "focus";
  return Math.random() < 0.6 ? "melee" : "ranged";
}

// Slot weights. Magic items (permanent max_mana boost) and revive items (rare combat
// life-saver) sit at the bottom of the table on purpose — their effects are stronger
// than per-fight gear so the drop rates are throttled.
//
// Consumables were rebalanced from 24% → 10% when the Staples system shipped.
// Basic potions (Health Potion, Greater Health Potion) are now always-in-stock
// at the shop for fixed prices, so rolled consumables are reserved as a
// PREMIUM drop — always rare-tier, larger heal magnitudes, and meaningfully
// better than the Greater Health Potion (25 HP). The 14% freed up by the
// consumable cut got redistributed to tools (+5), scrolls (+3), magic (+3),
// and revives (+3) — items players actually want more of.
function rollItemType(): ItemType {
  const r = Math.random();
  if (r < 0.30) return "weapon";       // 30%
  if (r < 0.50) return "armor";        // 20%
  if (r < 0.60) return "consumable";   // 10% (was 24% — staples cover commodity heals)
  if (r < 0.75) return "magic";        // 15% (+3)
  if (r < 0.84) return "revive";       //  9% (+3)
  if (r < 0.94) return "tool";         // 10% (+5)
  return "scroll";                     //  6% (+3)
}

// Rarity weights skew rarer as the monster tier rises.
// Epic unlocks at tier 3 (5% → 12% at tier 7+).
// Legendary unlocks at tier 5 (2% → 6% at tier 7+).
function rollRarity(tier: number): Rarity {
  const t = Math.max(1, tier);
  const legendaryChance = t >= 5 ? Math.min(0.06, 0.02 + 0.01 * (t - 5)) : 0;
  const epicChance = t >= 3 ? Math.min(0.12, 0.05 + 0.02 * (t - 3)) : 0;
  const rareChance = Math.min(0.25, 0.05 + 0.05 * (t - 1));
  const uncommonChance = Math.min(0.45, 0.25 + 0.05 * (t - 1));
  const r = Math.random();
  if (r < legendaryChance) return "legendary";
  if (r < legendaryChance + epicChance) return "epic";
  if (r < legendaryChance + epicChance + rareChance) return "rare";
  if (r < legendaryChance + epicChance + rareChance + uncommonChance) return "uncommon";
  return "common";
}

// Power maps to mechanic by type:
//   weapon/armor → flat modifier added to attack/cast (weapon) or subtracted /2 from incoming dmg (armor)
//   consumable   → HP healed on `<cmd> use`
//   magic        → max_mana increase on `<cmd> use` (capped at MAX_MANA_CAP)
//
// Weapon and armor power scales with monster tier (+2 base per tier above 1)
// so gear from higher-tier fights is meaningfully better regardless of rarity.
// T1 base ranges are preserved as-is for backwards compat.
function rollPower(type: ItemType, rarity: Rarity, tier = 1): number {
  if (type === "consumable") {
    // Rolled consumables are rare-only post-staples-rebalance; the
    // uncommon/common branches stay for backwards-compat with older saved
    // items (legacy rolls might still be in inventories) but new drops only
    // hit the rare branch via the forced-rarity in rollItem/rollMerchantItem.
    // Heal value scales +5 HP per tier so drops stay useful as max_hp grows.
    const hpScale = (Math.max(1, tier) - 1) * 5;
    if (rarity === "legendary") return 55 + hpScale + rollDice(20);  // 56-75 at T1
    if (rarity === "epic") return 42 + hpScale + rollDice(13);       // 43-55 at T1
    if (rarity === "rare") return 30 + hpScale + rollDice(20);       // 31-50 at T1
    if (rarity === "uncommon") return 12 + hpScale + rollDice(7);    // 13-18 (legacy)
    return 5 + hpScale + rollDice(4);                                // 6-8 (legacy)
  }
  if (type === "magic") {
    // max_mana boost — flat by rarity, capped by caller at MAX_MANA_CAP.
    // Tier-invariant: mana pools don't scale with level.
    if (rarity === "legendary") return 5;
    if (rarity === "epic") return 4;
    if (rarity === "rare") return 3;
    if (rarity === "uncommon") return 2;
    return 1;
  }
  if (type === "revive") {
    // % HP restored on use — tier-invariant (always heals a % of current max_hp).
    if (rarity === "legendary" || rarity === "epic") return 100;
    if (rarity === "rare") return 100;
    if (rarity === "uncommon") return 75;
    return 50;
  }
  // weapon | armor — scale base by +2 per tier above 1.
  // T1: common 2-3, uncommon 4-5, rare 6-7, epic 9-10, legendary 12-15
  // T3: common 6-7, uncommon 8-9, rare 10-11, epic 13-14, legendary 16-19
  const tb = (Math.max(1, tier) - 1) * 2;
  if (rarity === "legendary") return tb + 11 + rollDice(4);
  if (rarity === "epic") return tb + 8 + rollDice(2);
  if (rarity === "rare") return tb + 5 + rollDice(2);
  if (rarity === "uncommon") return tb + 3 + rollDice(2);
  return tb + 1 + rollDice(2);
}

// Focus weapon heal/shield bonus — flat per rarity + tier scaling.
// Predictable output matters more than weapon power randomness for healer builds.
function rollFocusPower(rarity: Rarity, tier = 1): number {
  const tb = (Math.max(1, tier) - 1) * 2;
  return FOCUS_POWER_BY_RARITY[rarity] + tb;
}

// Phase 2: when the base roll lands on "armor", subdivide into one of 7
// sub-slots. Body armor keeps ~50% share; the other 50% spreads across new
// slots. Returns a full ItemRoll with slot + stat_bonus pre-populated so
// callers can pass the roll straight to addItem without further inspection.
function _rollArmorSlotInner(tier: number): ItemRoll {
  const rarity = rollRarity(tier);
  const r = Math.random();
  const statBonus = (key: string, v: number) => ({ [key]: v });
  // Stat bonuses on accessory slots scale +1 every 2 tiers above 1 so rings/amulets
  // from higher-tier fights remain upgrade candidates against the same rarity drop.
  const tierStatBoost = Math.floor((Math.max(1, tier) - 1) / 2);
  const bonusAmt = (rarity === "legendary" ? 6 : rarity === "epic" ? 5 : rarity === "rare" ? 3 : rarity === "uncommon" ? 2 : 1) + tierStatBoost;

  // Inline helper: merges resistance into stat_bonus (no DB schema change needed).
  const withResist = (base: ItemRoll, slot: EquipSlot, subtype?: string): ItemRoll => {
    const res = rollResistance(slot, rarity, subtype);
    if (!res) return base;
    const resistKey = `resist_${res.type}`;
    return { ...base, stat_bonus: { ...(base.stat_bonus ?? {}), [resistKey]: res.pct } };
  };

  if (r < 0.50) {
    // Body armor — power-based armor reduction + stat bonus at epic/legendary.
    const bodyStatBonus =
      rarity === "legendary" ? { vit: bonusAmt, ...(Math.random() < 0.5 ? { str: Math.ceil(bonusAmt / 2) } : { int_stat: Math.ceil(bonusAmt / 2) }) }
      : rarity === "epic" ? { vit: Math.ceil(bonusAmt * 0.6) }
      : null;
    return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "body",
      ...(bodyStatBonus ? { stat_bonus: bodyStatBonus } : {}) }, "body");
  }
  if (r < 0.65) {
    // Helmet — half-armor contribution (floor(power/2) in buildInitialCombatState).
    return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "helmet",
      stat_bonus: statBonus(Math.random() < 0.5 ? "int_stat" : "vit", bonusAmt) }, "helmet");
  }
  if (r < 0.77) {
    // Pants — quarter-armor contribution.
    return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "pants",
      stat_bonus: statBonus("agi", bonusAmt) }, "pants");
  }
  if (r < 0.87) {
    // Boots — no armor; pure AGI buff. No resistance eligible.
    return { type: "armor", rarity, power: 0, slot: "boots",
      stat_bonus: statBonus("agi", bonusAmt) };
  }
  if (r < 0.91) {
    // Ring — no armor; STR/INT/DEX buff depending on roll.
    const statKeys = ["str", "int_stat", "dex"] as const;
    const key = statKeys[Math.floor(Math.random() * statKeys.length)];
    return withResist({ type: "armor", rarity, power: 0, slot: "ring",
      stat_bonus: statBonus(key, bonusAmt) }, "ring");
  }
  if (r < 0.95) {
    // Amulet — no armor; INT/VIT buff.
    const key = Math.random() < 0.5 ? "int_stat" : "vit";
    return withResist({ type: "armor", rarity, power: 0, slot: "amulet",
      stat_bonus: statBonus(key, bonusAmt) }, "amulet");
  }
  if (r < 0.93) {
    // Gloves (off_hand, non-shield) — small armor; STR or DEX buff. No resistance.
    const key = Math.random() < 0.5 ? "str" : "dex";
    return { type: "armor", rarity, power: Math.max(1, Math.floor(rollPower("armor", rarity, tier) / 3)), slot: "off_hand",
      item_subtype: "gloves",
      stat_bonus: statBonus(key, bonusAmt) };
  }
  // Shield (off_hand) — adds power to armor_power; small +VIT stat bonus.
  return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "off_hand",
    item_subtype: "shield",
    stat_bonus: statBonus("vit", bonusAmt) }, "off_hand", "shield");
}

export function rollArmorSlot(tier: number): ItemRoll {
  return { ..._rollArmorSlotInner(tier), tier };
}

// Rolls an armor-pool-contributing piece: body / helmet / pants / shield off-hand.
// Used by the smithy's rotating stock. Re-rolls until rollArmorSlot returns one
// of the four eligible slots (typical retry count ≈ 1–2).
export function rollSmithyArmor(tier: number): ItemRoll {
  for (let i = 0; i < 8; i++) {
    const roll = rollArmorSlot(tier);
    if (roll.slot === "body" || roll.slot === "helmet" || roll.slot === "pants") return roll;
    if (roll.slot === "off_hand" && roll.item_subtype === "shield") return roll;
  }
  // Final fallback: force a body roll so callers always get a usable piece.
  return { type: "armor", rarity: rollRarity(tier), power: rollPower("armor", rollRarity(tier), tier), slot: "body", tier };
}

// Rolls an armor item that is guaranteed NOT to be body armor. Used by shop
// restock to ensure at least 2 accessory items appear per cycle regardless
// of the overall armor-type probability.
export function rollAccessorySlot(tier: number): ItemRoll {
  const inner = ((): ItemRoll => {
    const rarity = rollRarity(tier);
    const r = Math.random();
    const statBonus = (key: string, v: number) => ({ [key]: v });
    const tierStatBoost = Math.floor((Math.max(1, tier) - 1) / 2);
    const bonusAmt = (rarity === "legendary" ? 6 : rarity === "epic" ? 5 : rarity === "rare" ? 3 : rarity === "uncommon" ? 2 : 1) + tierStatBoost;

    const withResist = (base: ItemRoll, slot: EquipSlot, subtype?: string): ItemRoll => {
      const res = rollResistance(slot, rarity, subtype);
      if (!res) return base;
      const resistKey = `resist_${res.type}`;
      return { ...base, stat_bonus: { ...(base.stat_bonus ?? {}), [resistKey]: res.pct } };
    };

    if (r < 0.22) {
      return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "helmet",
        stat_bonus: statBonus(Math.random() < 0.5 ? "int_stat" : "vit", bonusAmt) }, "helmet");
    }
    if (r < 0.44) {
      return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "pants",
        stat_bonus: statBonus("agi", bonusAmt) }, "pants");
    }
    if (r < 0.61) {
      return { type: "armor", rarity, power: 0, slot: "boots",
        stat_bonus: statBonus("agi", bonusAmt) };
    }
    if (r < 0.75) {
      const statKeys = ["str", "int_stat", "dex"] as const;
      return withResist({ type: "armor", rarity, power: 0, slot: "ring",
        stat_bonus: statBonus(statKeys[Math.floor(Math.random() * statKeys.length)], bonusAmt) }, "ring");
    }
    if (r < 0.85) {
      return withResist({ type: "armor", rarity, power: 0, slot: "amulet",
        stat_bonus: statBonus(Math.random() < 0.5 ? "int_stat" : "vit", bonusAmt) }, "amulet");
    }
    if (r < 0.93) {
      const key = Math.random() < 0.5 ? "str" : "dex";
      return { type: "armor", rarity, power: Math.max(1, Math.floor(rollPower("armor", rarity, tier) / 3)), slot: "off_hand",
        item_subtype: "gloves", stat_bonus: statBonus(key, bonusAmt) };
    }
    return withResist({ type: "armor", rarity, power: rollPower("armor", rarity, tier), slot: "off_hand",
      item_subtype: "shield", stat_bonus: statBonus("vit", bonusAmt) }, "off_hand", "shield");
  })();
  return { ...inner, tier };
}

const ELEMENTS: ElementType[] = ["fire", "ice", "lightning"];

function rollWeaponElement(
  type: ItemType,
  weaponRange: WeaponRange | undefined,
  rarity: Rarity,
): ElementType | undefined {
  if (type !== "weapon" || weaponRange === "focus") return undefined;
  if (rarity !== "rare" && rarity !== "epic" && rarity !== "legendary") return undefined;
  if (Math.random() >= ELEMENT_WEAPON_ROLL_CHANCE) return undefined;
  return ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)];
}

export function rollItem(tier: number, forShop = false): ItemRoll {
  const type = rollItemType();
  if (type === "tool" || type === "scroll") {
    const entry = rollCatalogEntry(type, forShop);
    return {
      type,
      rarity: entry.rarity,
      power: entry.computePower(tier),
      catalog_name: entry.name,
    };
  }
  // Consumable rolls are always RARE-tier post-staples-rebalance — they're
  // premium drops that outclass the always-in-stock Greater Health Potion.
  // Other types still roll their normal rarity distribution.
  const rarity = type === "consumable" ? "rare" : rollRarity(tier);
  const weapon_range = type === "weapon" ? rollWeaponRange() : undefined;
  // Armor rolls sub-divide into 8 slots in Phase 2.
  if (type === "armor") return rollArmorSlot(tier);
  // Focus weapons override the regular weapon-power formula with a flat
  // ladder by rarity — predictable support output beats the +1-spread
  // randomness for healer builds.
  const power = type === "weapon" && weapon_range === "focus"
    ? rollFocusPower(rarity, tier)
    : rollPower(type, rarity, tier);
  const element = rollWeaponElement(type, weapon_range, rarity);
  return { type, rarity, power, weapon_range, slot: type === "weapon" ? "main_hand" : undefined, element, tier };
}

// Merchant slot weights — practical-for-this-fight stock only. Excludes magic
// items (permanent max-mana boost is long-term, not "buy now to win the
// sub-boss"). Re-weighted to fill the gap with consumables / tools / revives.
function rollMerchantType(): ItemType {
  const r = Math.random();
  if (r < 0.25) return "weapon";       // 25%
  if (r < 0.45) return "armor";        // 20%
  if (r < 0.70) return "consumable";   // 25%
  if (r < 0.80) return "revive";       // 10%
  if (r < 0.92) return "tool";         // 12%
  return "scroll";                     //  8%
}

export function rollMerchantItem(tier: number): ItemRoll {
  const type = rollMerchantType();
  if (type === "tool" || type === "scroll") {
    const entry = rollCatalogEntry(type, true);
    return {
      type,
      rarity: entry.rarity,
      power: entry.computePower(tier),
      catalog_name: entry.name,
    };
  }
  // Same rare-only consumable rule as rollItem — merchants' rolled stock
  // doesn't compete with their always-in-stock staples on basic potions.
  const rarity = type === "consumable" ? "rare" : rollRarity(tier);
  if (type === "armor") return rollArmorSlot(tier);
  const weapon_range = type === "weapon" ? rollWeaponRange() : undefined;
  const power = type === "weapon" && weapon_range === "focus"
    ? rollFocusPower(rarity, tier)
    : rollPower(type, rarity, tier);
  const element = rollWeaponElement(type, weapon_range, rarity);
  return { type, rarity, power, weapon_range, element, tier };
}

// Per-fighter drop chance after a kill. 35% baseline, +5% per tier.
export function dropChance(tier: number): number {
  return Math.min(0.7, 0.35 + 0.05 * Math.max(0, tier - 1));
}

export const RARITY_BADGE: Record<Rarity, string> = {
  common: "⚪",
  uncommon: "🟢",
  rare: "🟣",
  epic: "🟡",
  legendary: "🔶",
};

// Flat per-rarity pricing. Power varies within rarity but the price doesn't —
// keeps the stock readable and "do I want this?" easy to answer.
export const SHOP_PRICE: Record<Rarity, number> = {
  common: 15,
  uncommon: 50,
  rare: 150,
  epic: 400,
  legendary: 900,
};

// Magic items grant permanent max_mana — priced higher than consumables/gear of the
// same rarity since the buff lasts forever.
export const MAGIC_PRICE: Record<Rarity, number> = {
  common: 100,
  uncommon: 250,
  rare: 500,
  epic: 1000,
  legendary: 2000,
};

// Revive items pull a downed party member back into the fight. Pricier than gear,
// cheaper than rare magic — they're combat-defining but consumed on use.
export const REVIVE_PRICE: Record<Rarity, number> = {
  common: 150,
  uncommon: 280,
  rare: 450,
  epic: 700,
  legendary: 1000,
};

// Tool: tactical consumables — damage (Caffeine Bomb / Hotfix Grenade), heal-
// over-time (Espresso Shot), or status (Poison Vial). Pricing was originally
// 50/150/350 on the theory that tools are combat-defining; in practice the
// uncommon tier was unaffordable for low-level players (4-10 quests of
// dedicated saving for one item) and tools were ignored entirely. Rebalanced
// down to slot tools between consumables and scrolls — meaningful but
// reachable.
export const TOOL_PRICE: Record<Rarity, number> = {
  common: 25,
  uncommon: 75,
  rare: 200,
  epic: 450,
  legendary: 900,
};

// Scroll: party-affecting / boss-altering rituals (Rebase Scroll, Production Outage).
// Steeper than tools — bigger effects (whole-party cooldown reset, boss HP cut).
export const SCROLL_PRICE: Record<Rarity, number> = {
  common: 100,
  uncommon: 250,
  rare: 500,
  epic: 1000,
  legendary: 2000,
};

export function priceFor(type: ItemType, rarity: Rarity, tier = 1): number {
  if (type === "magic") return MAGIC_PRICE[rarity];
  if (type === "revive") return REVIVE_PRICE[rarity];
  if (type === "tool") return TOOL_PRICE[rarity];
  if (type === "scroll") return SCROLL_PRICE[rarity];
  // Weapons and armor scale +20% per tier above 1.
  const tierMult = 1 + (Math.max(1, tier) - 1) * 0.2;
  return Math.round(SHOP_PRICE[rarity] * tierMult);
}

// Sell price for an inventory item. Returns 30% of the equivalent shop
// price for the item's type + rarity — same baseline rebate as before.
//
// Sharpened items recoup PART of the invested gold: each sharpen the
// smithy applied gets folded into the rebate at the same 30% rate. So a
// player who spent 80 + 100 + 120 = 300g sharpening a base-3 weapon to +6
// gets back roughly base_rebate + 90g (30% of 300g). Without this,
// sharpening is a pure one-way sink and players are punished for
// upgrading instead of saving for new gear.
//
// The smithy cost formula MUST stay in sync with this — if cost-per-level
// changes in commands.ts (SMITHY_SHARPEN_PRICE_PER_LEVEL), update
// SHARPEN_PRICE_PER_LEVEL below too.
const SHARPEN_PRICE_PER_LEVEL = 20;
const SELL_REBATE_RATIO = 0.3;
export function sellPriceFor(type: ItemType, rarity: Rarity, opts?: { power?: number; sharpens_count?: number }): number {
  const base = priceFor(type, rarity);
  const power = opts?.power ?? 0;
  const sharpens = opts?.sharpens_count ?? 0;
  // Reconstruct the smithy cost ladder. The sharpens were applied at
  // powers (P-sharpens), (P-sharpens+1), ..., (P-1), each costing
  // (P_i + 1) * SHARPEN_PRICE_PER_LEVEL. Closed form for the sum:
  //   total = SHARPEN_PRICE_PER_LEVEL × Σ (i+1) for i in [P-sharpens, P-1]
  //         = SHARPEN_PRICE_PER_LEVEL × sharpens × (P + (P - sharpens + 1)) / 2
  //         = (SHARPEN_PRICE_PER_LEVEL / 2) × sharpens × (2P - sharpens + 1)
  const sharpenInvested = sharpens > 0
    ? Math.floor((SHARPEN_PRICE_PER_LEVEL / 2) * sharpens * (2 * power - sharpens + 1))
    : 0;
  return Math.floor((base + sharpenInvested) * SELL_REBATE_RATIO);
}

export function rollDice(sides: number, count = 1): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
}

// XP threshold to reach a given level. Curve is gentle early, steeper later.
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(100 * Math.pow(level - 1, 1.8));
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

// Merchants get a tradesperson-flavored epithet pool. Same prefix/mid as NPCs
// but with shopkeep-y suffixes.
const MERCHANT_EPITHET = [
  "the Marked-Up", "the Travelling Codemonger", "the Sprint Vendor",
  "the Underdocumented", "the Off-by-One", "the Markdown Trader",
  "the Quartermaster of Q4", "the Lukewarm Reseller", "the Cache-Hawker",
  "the Roadmap Reseller",
];

export function generateMerchantName(): string {
  const given = PREFIX[Math.floor(Math.random() * PREFIX.length)] +
                MID[Math.floor(Math.random() * MID.length)];
  const epithet = MERCHANT_EPITHET[Math.floor(Math.random() * MERCHANT_EPITHET.length)];
  return `${given} ${epithet}`;
}
