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

export type ItemType = "weapon" | "armor" | "consumable" | "magic" | "revive" | "tool" | "scroll" | "resource";

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

// Display-side metadata for every EffectType the engine emits.
//
// **Naming convention — important:**
// The `name` field is the player-facing display label and follows Gantt
// Quest's engineering-themed vocabulary, matching the ability that
// applies the effect (or the elemental concept that procs it). The
// `EffectType` *key* on the other hand is the stable internal identifier
// used in code (e.g. `effects.some(e => e.type === "barkskin")`) — it
// purposefully sticks with the classic short identifier so grepping
// and engine logic stay readable.
//
// So you'll see pairs like:
//   key: "barkskin"     name: "Firewalled"     (druid Firewall ability)
//   key: "animal_form"  name: "Scaled Up"      (druid Scale Up ability)
//   key: "stunned"      name: "Containerized"  (mage Containerize ability)
//   key: "entangled"    name: "Deadlocked"     (druid Deadlock ability)
//
// Player-visible surfaces (pill chips, character sheet, Slack pills,
// combat log) MUST render `meta.name`, not the type key. If you add a
// new effect type or ability, update the `name` here to match the
// engineering vocabulary of the action that applied it.
export const EFFECT_META: Record<EffectType, EffectMeta> = {
  // Generic DoT/HoT effects — applied by many sources (weapon procs, abilities, items).
  regen:     { emoji: "🟢", name: "Auto-Heal", kind: "buff",    ignoresArmor: true,  blurb: "Restores HP each action.",                  icon: "regeneration",   color: "#4ade80" },
  bleeding:  { emoji: "🔴", name: "Bleeding",  kind: "debuff",  ignoresArmor: false, blurb: "Loses HP each action.",                     icon: "bleeding-wound", color: "#f87171" },
  burning:   { emoji: "🔥", name: "Burning",   kind: "debuff",  ignoresArmor: true,  blurb: "Loses HP each action; ignores armor.",      icon: "fire",           color: "#fb923c" },
  poisoned:  { emoji: "☠️", name: "Poisoned",  kind: "debuff",  ignoresArmor: true,  blurb: "Loses HP each turn.",                       icon: "poison-cloud",   color: "#c084fc" },
  // Elemental procs (lightning weapons + ice procs) — keep the elemental name.
  frozen:    { emoji: "❄️", name: "Frozen",    kind: "passive", ignoresArmor: false, blurb: "Skips next action.",                        icon: "ice-bolt",       color: "#93c5fd" },
  shocked:   { emoji: "🌩️", name: "Shocked",   kind: "passive", ignoresArmor: false, blurb: "Takes +30% damage from all sources.",      icon: "electric",       color: "#fbbf24" },
  // Ability-driven effects — name matches the engineering ability that applies them.
  empowered: { emoji: "⚡", name: "Empowered", kind: "passive", ignoresArmor: false, blurb: "+25% damage dealt for N turns.",            icon: "aura",           color: "#f59e0b" },
  stunned:   { emoji: "📦", name: "Containerized", kind: "passive", ignoresArmor: false, blurb: "Containerized — skips swings with escalating 30%/turn break chance.", icon: "fluffy-swirl", color: "#a78bfa" },
  hexed:     { emoji: "🔮", name: "Hexed",     kind: "passive", ignoresArmor: false, blurb: "Deals -25% damage. Takes 3 bleed stacks whenever it takes damage.", icon: "death-skull", color: "#a855f7" },
  entangled: { emoji: "🌿", name: "Deadlocked", kind: "debuff",  ignoresArmor: false, blurb: "Held by an upstream dependency. -4 to attack rolls.",         icon: "vine-whip", color: "#86efac" },
  barkskin:    { emoji: "🍃", name: "Firewalled", kind: "passive", ignoresArmor: false, blurb: "Inbound deny-all rule active — bonus AC for N turns.",     icon: "leaf",      color: "#a3e635" },
  animal_form: { emoji: "🐺", name: "Scaled Up",  kind: "buff",    ignoresArmor: false, blurb: "Compute provisioned — stats surged while active.",         icon: "wolf-head", color: "#f97316" },
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

// Proc rate per hit by weapon rarity. Uncommon weapons can have elements at a lower rate.
export const ELEMENT_PROC_RATE: Record<"uncommon" | "rare" | "epic" | "legendary", number> = {
  uncommon: 0.10, rare: 0.20, epic: 0.30, legendary: 0.40,
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
  variant: "standard" | "boss" | "gauntlet";
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
  if (rarity !== "uncommon" && rarity !== "rare" && rarity !== "epic" && rarity !== "legendary") return undefined;
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
// Resource sell floor — per-rarity gold rates that bypass the normal
// item-pricing ladder. Resources don't have a "shop price" the way gear
// does, but players need a way to convert excess stockpile into gold or
// the gathering loop has nothing to push *to* once recipes are sated.
// Floors picked so a Standard mine + an uncommon roll = ~25g (matches
// Standard's base 25g gold reward), and a Deep rare = 100g (about half
// a tier-6 hunt). Active play still pays way better; this just keeps
// the resource pile from feeling like wasted time.
const RESOURCE_SELL_FLOOR: Record<Rarity, number> = {
  common:    5,
  uncommon:  25,
  rare:      100,
  epic:      250,
  legendary: 600,
};
export function sellPriceFor(type: ItemType, rarity: Rarity, opts?: { power?: number; sharpens_count?: number }): number {
  if (type === "resource") return RESOURCE_SELL_FLOOR[rarity];
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
const PREFIX = [
  "Bru", "Ka", "Mor", "Eth", "Vyn", "Tar", "Sel", "Drog", "Lyr", "Quin",
  "Zar", "Fen", "Aldra", "Wyn", "Tor", "Bel", "Cyr", "Dax", "Eld", "Fae",
  "Gal", "Hav", "Ira", "Jor", "Kes", "Mal", "Nav", "Orl", "Per", "Ryn",
  "Siv", "Thae", "Ulv", "Vael", "Wex", "Xar", "Yrd", "Zol",
];
const MID = [
  "dor", "an", "vek", "is", "ric", "el", "or", "tha", "ix", "een", "us",
  "ara", "eth", "ond", "ael", "yn", "ir", "ash", "en", "os",
];
const EPITHET = [
  // Original set
  "the Patient", "the Untested", "Stack-Cleaver", "the Verbose", "of the Long Build",
  "Halflinter", "the Deprecated", "Rebase-Born", "Two-PRs", "the Hotfixed",
  "Thread-Walker", "of the Stale Branch", "the Overcommitted",
  // Expanded — dev/work flavored
  "the Unmerged", "the Well-Documented", "the Off-by-One", "Null-Borne",
  "the Refactored", "Edge-Caser", "of the Final Commit", "the Async",
  "the Deadlocked", "Cache-Breaker", "the Legacy", "Branch-Keeper",
  "the Idempotent", "Scope-Creeper", "the Rollback", "Debug-Walker",
  "the Throughput", "of the Late Retro", "the Compiled", "Root-Cause",
  "the Undocumented", "Fail-Fast", "the Hardcoded", "Patch-Born",
  "the Concurrent", "Log-Watcher", "the Nullable", "Heap-Walker",
  "the Latent", "of the Pending Review", "the Recursive",
  "the Shipper", "Flag-Bearer", "the Postmortemed", "of the Frozen Sprint",
  // Purely fantasy-flavored (no dev puns) for variety
  "Ironveil", "Duskmantle", "Stonecalled", "the Wandering",
  "Ashbound", "the Relentless", "Coldforge", "the Unbroken",
  "Nightwatch", "the Unseen", "Emberborn", "of the Hollow Road",
  "the Cursed", "Gildstrike", "of the Shattered Keep", "the Forgotten",
  "the Unyielding", "Thornpact", "the Twice-Fallen", "Voidwalker",
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

// =============================================================================
// CAMP: gathering nodes, resources, recipes, upgrades
// =============================================================================
//
// Gathering is a real-time idle loop. Players start a task at the Mine /
// Herb Garden / Fishing Hole inside "My Camp", wait the tier duration in
// real wall-clock minutes, and collect resources + XP + (sometimes) gold
// when they return.
//
// Yield rolls are deterministic on (taskId, node, tier) so a status fetch
// and a claim never disagree — the same task id always lands the same yield
// regardless of who triggers the roll first. The seed is task id so each
// gather is its own outcome.

export type CampNode = "mine" | "forage" | "fish";
export type CampTier = "quick" | "standard" | "deep";

export interface CampTierSpec {
  tier: CampTier;
  label: string;
  duration_ms: number;
  base_xp: number;
  base_gold: number;
}

// Tier durations and base XP/gold rewards. Yield counts per node live in
// CAMP_NODE_CONFIG below — tiers control time + reward floor, nodes control
// what comes out the other side.
//
// Per-hour rates after the rebalance:
//   Quick    →  24 XP/hr,  20 gold/hr  (low commitment, fast cycles)
//   Standard →  30 XP/hr,  25 gold/hr  (default loop)
//   Deep     →  40 XP/hr,  35 gold/hr  (long commit pays better, not worse)
// The old numbers had Deep losing to Standard on a per-hour basis, which
// punished the long-form commit instead of rewarding it.
export const CAMP_TIERS: Record<CampTier, CampTierSpec> = {
  quick:    { tier: "quick",    label: "Quick",    duration_ms:  15 * 60 * 1000, base_xp:   6, base_gold:   5 },
  standard: { tier: "standard", label: "Standard", duration_ms:  60 * 60 * 1000, base_xp:  30, base_gold:  25 },
  deep:     { tier: "deep",     label: "Deep",     duration_ms: 240 * 60 * 1000, base_xp: 160, base_gold: 140 },
};

// Resource catalog. Each resource is its own inventory item_name (with emoji
// prefix, mirroring the convention in ITEM_CATALOG / STAPLES so the
// inventory render shows the icon inline). Rarity drives crafting cost.
export interface ResourceSpec {
  id: string;          // short slug used in recipe inputs
  name: string;        // bare name; full inventory name is `${emoji} ${name}`
  emoji: string;
  icon: string;        // SVG icon name from the local icons registry
  rarity: Rarity;
  node: CampNode;
  blurb: string;
}

export const RESOURCE_CATALOG: ResourceSpec[] = [
  // Mine
  { id: "iron_ore",    name: "Iron Ore",    emoji: "⛏️", icon: "coal-pile",        rarity: "common",   node: "mine",   blurb: "Workhorse ore. Smithy fodder." },
  { id: "silver_ore",  name: "Silver Ore",  emoji: "🪙", icon: "crystal-bars",     rarity: "uncommon", node: "mine",   blurb: "Glints in torchlight. Better gear inputs." },
  { id: "mithril_ore", name: "Mithril Ore", emoji: "💠", icon: "crystal-cluster",  rarity: "rare",     node: "mine",   blurb: "Light as feather, hard as fang. Rare deep-mine pull." },
  // Forage
  { id: "mossroot",    name: "Mossroot",    emoji: "🌿", icon: "herbs-bundle",     rarity: "common",   node: "forage", blurb: "Bitter herb. Healing base." },
  { id: "sunleaf",     name: "Sunleaf",     emoji: "🍀", icon: "chestnut-leaf",    rarity: "uncommon", node: "forage", blurb: "Stores warmth. Mana brews." },
  { id: "nightbloom",  name: "Nightbloom",  emoji: "🌸", icon: "dandelion-flower", rarity: "rare",     node: "forage", blurb: "Blooms only after dusk. Powerful base." },
  // Fish
  { id: "river_carp",  name: "River Carp",  emoji: "🐟", icon: "salmon",           rarity: "common",   node: "fish",   blurb: "Sells well at the Pub." },
  { id: "silverfin",   name: "Silverfin",   emoji: "🐠", icon: "flying-trout",     rarity: "uncommon", node: "fish",   blurb: "Prized at the Pub kitchen." },
  { id: "abyss_eel",   name: "Abyss Eel",   emoji: "🐉", icon: "eel",              rarity: "rare",     node: "fish",   blurb: "Coiled muscle. The pub pays double for these." },
];

// Full inventory name (with emoji prefix) for a resource id. Used everywhere
// resources cross the DB boundary so addResource/tryConsumeResource see the
// same string the player sees.
export function resourceItemName(id: string): string {
  const spec = RESOURCE_CATALOG.find((r) => r.id === id);
  if (!spec) throw new Error(`Unknown resource id: ${id}`);
  return `${spec.emoji} ${spec.name}`;
}

export function findResource(id: string): ResourceSpec | undefined {
  return RESOURCE_CATALOG.find((r) => r.id === id);
}

// Camp node config — what each node produces by tier. Yield counts are
// before the deterministic roll mixes in the extras (Standard rolls 1
// uncommon vs 2 commons; Deep rolls 3 commons + a chance at rare).
export interface CampNodeSpec {
  node: CampNode;
  label: string;
  icon: string;          // RPG-awesome icon name (or local svg)
  primary: string;       // common resource id
  uncommon: string;
  rare: string;
  blurb: string;
}

export const CAMP_NODE_CONFIG: Record<CampNode, CampNodeSpec> = {
  mine: {
    node: "mine",   label: "The Mine",      icon: "mining-diamonds",
    primary: "iron_ore", uncommon: "silver_ore", rare: "mithril_ore",
    blurb: "Veins of ore run deep under the bluffs. Bring it back for the smithy.",
  },
  forage: {
    node: "forage", label: "Herb Garden",   icon: "herbs-bundle",
    primary: "mossroot", uncommon: "sunleaf", rare: "nightbloom",
    blurb: "Wild herbs ring the camp clearing. The apothecary pays for stock.",
  },
  fish: {
    node: "fish",   label: "Fishing Hole",  icon: "fishing-pole",
    primary: "river_carp", uncommon: "silverfin", rare: "abyss_eel",
    blurb: "Quiet pool by the willows. The pub kitchen has standing orders.",
  },
};

// Probability a Deep-tier mine rolls a gold-vein strike instead of the rare
// ore. Surfaces as a chunky gold payout on top of the normal common yield.
export const MINE_GOLD_VEIN_CHANCE = 0.05;
export const MINE_GOLD_VEIN_PAYOUT = 250;

// Yield ranges for the toast preview. Roll math lives in rollGatherYield —
// these are the "you might get N..M" UI labels.
export interface YieldPreview {
  resources: string;     // human-readable preview, e.g. "1 ore"
  xp_label: string;
  gold_label: string;
  rare_chance?: string;
}

export function yieldPreview(node: CampNode, tier: CampTier): YieldPreview {
  const cfg = CAMP_NODE_CONFIG[node];
  const tierSpec = CAMP_TIERS[tier];
  const xp = `+${tierSpec.base_xp} XP`;
  const gold = `+${tierSpec.base_gold} gold`;
  if (tier === "quick") {
    return { resources: `1 ${cfg.primary.replace(/_/g, " ")}`, xp_label: xp, gold_label: gold };
  }
  if (tier === "standard") {
    return {
      resources: `2 commons or 1 ${cfg.uncommon.replace(/_/g, " ")}`,
      xp_label: xp, gold_label: gold,
    };
  }
  return {
    resources: `3 commons + chance ${cfg.rare.replace(/_/g, " ")}`,
    xp_label: xp, gold_label: gold,
    rare_chance: node === "mine" ? `${Math.round(MINE_GOLD_VEIN_CHANCE * 100)}% gold vein` : undefined,
  };
}

// Deterministic seeded RNG so a status fetch and a later claim agree on the
// same yield. mulberry32 — cheap, good distribution, no deps.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RolledYield {
  resources: Array<{ id: string; name: string; qty: number; rarity: Rarity }>;
  xp: number;
  gold: number;
  gold_strike?: boolean;
}

// XP scaling for time-based tasks. Without this, gather/errand XP rapidly
// becomes irrelevant past L4 (a single L5→L6 step is 777 XP, while
// Standard tier pays 30 XP/hr). Scales linearly with character level so
// idle play keeps pace with the curve without leapfrogging active play.
// Applied to XP only — gold stays tier-flat so the gold economy doesn't
// drift up with level. Pass character.level (or 1 for level-agnostic
// callers; the multiplier becomes 1.0).
export function levelScaledXpMultiplier(level: number): number {
  return 1 + 0.15 * Math.max(0, (level | 0) - 3);
}

// Optional "rested" bonus — when ≥24h has passed since the last claim,
// the next yield gets a one-time XP/gold bump. Encourages returning
// players without taxing the active loop. Caller decides whether to
// pass true; this constant lives near the roll fns so the modifier
// stack is in one place.
export const REST_BONUS_MULT = 1.5;

// Roll the gather yield. Deterministic on taskId — two parallel fetches of
// the same task always produce the same result, so racing a status fetch
// against a claim is harmless. Level scaling + rested bonus are read off
// the snapshotted modifiers, so the planned yield can't drift if the
// player levels up or claims another task before this one expires.
export function rollGatherYield(
  taskId: number,
  node: CampNode,
  tier: CampTier,
  modifiers: TentModifiers = NO_TENT_MODIFIERS,
): RolledYield {
  const cfg = CAMP_NODE_CONFIG[node];
  const tierSpec = CAMP_TIERS[tier];
  const rng = mulberry32(taskId);
  const resources: RolledYield["resources"] = [];
  const levelMult = levelScaledXpMultiplier(modifiers.character_level ?? 1);
  const restedMult = modifiers.rested ? REST_BONUS_MULT : 1;
  const xpScale = levelMult * restedMult;
  const goldScale = levelMult * restedMult;
  let xp = Math.round(tierSpec.base_xp * xpScale);
  let gold = Math.round(tierSpec.base_gold * goldScale);
  let gold_strike = false;

  const pushResource = (id: string, qty: number) => {
    const spec = findResource(id);
    if (!spec) return;
    resources.push({ id, name: resourceItemName(id), qty, rarity: spec.rarity });
  };

  // Big Haul perk: extra primary-resource units on every gather.
  const yieldBonus = Math.max(0, modifiers.yield_bonus | 0);
  // Keen Eye perk: widens rare-roll windows by N percent points. Applies to
  // Standard's uncommon roll and Deep's rare/uncommon thresholds, but does
  // NOT affect the gold-vein chance (that's a dedicated rare-rare).
  const rareWiden = Math.max(0, modifiers.rare_bonus_pct | 0) / 100;

  if (tier === "quick") {
    pushResource(cfg.primary, 1 + yieldBonus);
  } else if (tier === "standard") {
    // Base 70% commons / 30% uncommon. Keen Eye shifts toward uncommon.
    if (rng() < (0.7 - rareWiden)) pushResource(cfg.primary, 2 + yieldBonus);
    else pushResource(cfg.uncommon, 1);
  } else {
    // Deep: 3 commons always (+haul bonus), plus a rare-tier roll.
    pushResource(cfg.primary, 3 + yieldBonus);
    const rareRoll = rng();
    if (node === "mine" && rareRoll < MINE_GOLD_VEIN_CHANCE) {
      gold_strike = true;
      gold += MINE_GOLD_VEIN_PAYOUT;
    } else if (rareRoll < (0.20 + rareWiden)) {
      pushResource(cfg.rare, 1);
    } else if (rareRoll < (0.55 + rareWiden)) {
      pushResource(cfg.uncommon, 1);
    }
  }

  return { resources, xp, gold, ...(gold_strike ? { gold_strike: true } : {}) };
}

// Recipe catalog — Smithy Forge + Apothecary Brew. Inputs reference resource
// ids; outputs are crafted into inventory as fresh items (gear) or stacked
// (potions reuse Health/Mana Potion naming so they merge with shop stock).
export type CraftStation = "smithy" | "apothecary";

export interface RecipeSpec {
  id: string;             // slash-form short slug
  station: CraftStation;
  output_name: string;    // inventory item_name; pre-prefixed where applicable
  output_type: ItemType;
  output_power: number;
  output_slot?: EquipSlot | null;
  output_subtype?: string | null;
  output_rarity: Rarity;
  output_blurb: string;
  inputs: Array<{ resource_id: string; qty: number }>;
  gold_cost: number;
  level_req: number;
}

export const RECIPE_CATALOG: RecipeSpec[] = [
  // Smithy Forge — 5 recipes.
  {
    id: "iron_sword", station: "smithy",
    output_name: "Iron Sword", output_type: "weapon", output_power: 5,
    output_slot: "main_hand", output_rarity: "common",
    output_blurb: "Forged from honest ore. Reliable cutting edge.",
    inputs: [{ resource_id: "iron_ore", qty: 3 }],
    gold_cost: 40, level_req: 1,
  },
  {
    id: "iron_buckler", station: "smithy",
    output_name: "Iron Buckler", output_type: "armor", output_power: 4,
    output_slot: "off_hand", output_subtype: "shield", output_rarity: "common",
    output_blurb: "Small but sturdy. Soaks the first hit.",
    inputs: [{ resource_id: "iron_ore", qty: 2 }],
    gold_cost: 30, level_req: 1,
  },
  {
    id: "iron_helm", station: "smithy",
    output_name: "Iron Helm", output_type: "armor", output_power: 5,
    output_slot: "helmet", output_rarity: "common",
    output_blurb: "Dented but functional. Keeps the skull intact.",
    inputs: [{ resource_id: "iron_ore", qty: 2 }],
    gold_cost: 30, level_req: 2,
  },
  {
    id: "steel_greaves", station: "smithy",
    output_name: "Steel Greaves", output_type: "armor", output_power: 9,
    output_slot: "pants", output_rarity: "uncommon",
    output_blurb: "Layered silver bands. Cold steel runs the seams.",
    inputs: [{ resource_id: "iron_ore", qty: 3 }, { resource_id: "silver_ore", qty: 1 }],
    gold_cost: 90, level_req: 3,
  },
  {
    id: "mithril_ring", station: "smithy",
    output_name: "Mithril Ring", output_type: "armor", output_power: 10,
    output_slot: "ring", output_rarity: "rare",
    output_blurb: "Light braid. Hums faintly when worn.",
    inputs: [{ resource_id: "mithril_ore", qty: 1 }, { resource_id: "silver_ore", qty: 2 }],
    gold_cost: 200, level_req: 5,
  },
  // Mid/late-game mithril recipes. These give Deep mining a payoff beyond
  // gold floors — the rare mithril roll is the gating ingredient, so a
  // good Deep streak compounds straight into a power-spike item set.
  {
    id: "mithril_blade", station: "smithy",
    output_name: "Mithril Blade", output_type: "weapon", output_power: 18,
    output_slot: "main_hand", output_rarity: "rare",
    output_blurb: "Holds an edge through the longest fight. Half its weight.",
    inputs: [{ resource_id: "mithril_ore", qty: 2 }, { resource_id: "iron_ore", qty: 3 }],
    gold_cost: 260, level_req: 7,
  },
  {
    id: "mithril_aegis", station: "smithy",
    output_name: "Mithril Aegis", output_type: "armor", output_power: 16,
    output_slot: "off_hand", output_subtype: "shield", output_rarity: "rare",
    output_blurb: "A pale shield that turns blows like water.",
    inputs: [{ resource_id: "mithril_ore", qty: 1 }, { resource_id: "silver_ore", qty: 2 }, { resource_id: "iron_ore", qty: 2 }],
    gold_cost: 220, level_req: 7,
  },
  {
    id: "mithril_cuirass", station: "smithy",
    output_name: "Mithril Cuirass", output_type: "armor", output_power: 19,
    output_slot: "body", output_rarity: "rare",
    output_blurb: "Layered mithril over silver. Carries like a tunic, turns like plate.",
    inputs: [{ resource_id: "mithril_ore", qty: 2 }, { resource_id: "silver_ore", qty: 2 }, { resource_id: "iron_ore", qty: 3 }],
    gold_cost: 380, level_req: 8,
  },
  // Apothecary Brew — 5 recipes. Names piggyback on existing potion handling
  // where possible (Greater Health Potion etc. flow through existing use-item
  // dispatch) and add a few new ones for variety.
  {
    id: "greater_healing", station: "apothecary",
    output_name: "🧪 Greater Health Potion", output_type: "consumable", output_power: 25,
    output_rarity: "uncommon",
    output_blurb: "Restores 25 HP. Concentrate to boost potency.",
    inputs: [{ resource_id: "mossroot", qty: 3 }],
    gold_cost: 30, level_req: 1,
  },
  {
    id: "greater_mana", station: "apothecary",
    output_name: "✨ Mana Flask", output_type: "consumable", output_power: 3,
    output_rarity: "uncommon",
    output_blurb: "Restores 3 mana. Concentrate to boost potency.",
    inputs: [{ resource_id: "sunleaf", qty: 2 }],
    gold_cost: 25, level_req: 1,
  },
  {
    id: "antidote", station: "apothecary",
    output_name: "🟢 Antidote", output_type: "consumable", output_power: 0,
    output_rarity: "uncommon",
    output_blurb: "Clears poison status and grants brief Regen.",
    inputs: [{ resource_id: "mossroot", qty: 2 }, { resource_id: "sunleaf", qty: 1 }],
    gold_cost: 35, level_req: 2,
  },
  {
    id: "endurance_tonic", station: "apothecary",
    output_name: "⚗️ Endurance Tonic", output_type: "tool", output_power: 4,
    output_rarity: "uncommon",
    output_blurb: "Self-Regen for 5 actions. Stout, earthy taste.",
    inputs: [{ resource_id: "mossroot", qty: 2 }, { resource_id: "nightbloom", qty: 1 }],
    gold_cost: 60, level_req: 3,
  },
  {
    id: "focus_draught", station: "apothecary",
    output_name: "🔮 Focus Draught", output_type: "magic", output_power: 1,
    output_rarity: "rare",
    output_blurb: "Permanently raises max mana by 1. One-shot.",
    inputs: [{ resource_id: "sunleaf", qty: 2 }, { resource_id: "nightbloom", qty: 1 }],
    gold_cost: 120, level_req: 4,
  },
  // Apothecary combo brews. Each adds a second herb to the base healing
  // recipe; the cross-ingredient synergy yields significantly more HP/mana
  // per resource than crafting the single-herb base over and over.
  {
    id: "vital_brew", station: "apothecary",
    output_name: "🧪 Vital Brew", output_type: "consumable", output_power: 60,
    output_rarity: "rare",
    output_blurb: "Restores 60 HP. Mossroot steeped with sunleaf — bitter and bright.",
    inputs: [{ resource_id: "mossroot", qty: 2 }, { resource_id: "sunleaf", qty: 1 }],
    gold_cost: 55, level_req: 3,
  },
  {
    id: "master_healing_elixir", station: "apothecary",
    output_name: "🧪 Master Health Elixir", output_type: "consumable", output_power: 120,
    output_rarity: "rare",
    output_blurb: "Restores 120 HP. Triple-distilled, finished with a nightbloom petal.",
    inputs: [{ resource_id: "mossroot", qty: 4 }, { resource_id: "nightbloom", qty: 1 }],
    gold_cost: 110, level_req: 5,
  },
  {
    id: "twilight_concoction", station: "apothecary",
    // Reuses Mana Flask name so the use-item path (findStaple → restore_mana)
    // routes through cleanly. Item.power carries the bigger restore amount.
    output_name: "✨ Mana Flask", output_type: "consumable", output_power: 8,
    output_rarity: "rare",
    output_blurb: "Restores 8 mana. Sunleaf base brightened with nightbloom — burns cold on the tongue.",
    inputs: [{ resource_id: "sunleaf", qty: 3 }, { resource_id: "nightbloom", qty: 1 }],
    gold_cost: 80, level_req: 4,
  },
];

export function findRecipe(id: string): RecipeSpec | undefined {
  return RECIPE_CATALOG.find((r) => r.id === id);
}

// Smithy gear scales with the crafter's level so items stay relevant past the
// unlock tier. +2 power per level above level_req tracks the dungeon drop
// formula (rare power ≈ 2×tier + 4.5, level ≈ tier).
// Apothecary consumables are excluded — their output_power is a flat HP/MP value.
export const SMITHY_SCALE_PER_LEVEL = 2;

export function smithyEffectivePower(recipe: RecipeSpec, characterLevel: number): number {
  if (recipe.station !== "smithy" || recipe.output_type === "consumable") {
    return recipe.output_power;
  }
  return recipe.output_power + Math.floor(Math.max(0, characterLevel - recipe.level_req) * SMITHY_SCALE_PER_LEVEL);
}

// Camp upgrade catalog. v1 ships with one buildable upgrade (worker_tent_1).
// `coming_soon: true` entries render greyed in the Build tab as a hint for
// where the upgrade tree is going.
export interface CampUpgradeSpec {
  key: string;
  label: string;
  blurb: string;
  icon: string;
  gold_cost: number;
  level_req: number;
  // What the upgrade unlocks. extra_slot adds a parallel gathering slot;
  // perk-typed upgrades stamp modifiers onto in-flight tasks at start time
  // (see computeTentModifiers / rollGatherYield).
  effect:
    | { kind: "extra_slot" }
    | { kind: "duration_pct"; value: number }     // percent reduction off base tier duration
    | { kind: "yield_bonus"; value: number }      // added to primary resource qty
    | { kind: "rare_bonus_pct"; value: number };  // percent points added to rare-roll thresholds
  coming_soon?: boolean;
}

export const CAMP_UPGRADE_CATALOG: CampUpgradeSpec[] = [
  {
    key: "worker_tent_1",
    label: "Pitch a Worker Tent",
    blurb: "Hire a worker. Adds a second gathering slot — run two tasks in parallel.",
    icon: "camping-tent",
    gold_cost: 250,
    level_req: 3,
    effect: { kind: "extra_slot" },
  },
  {
    key: "worker_tent_2",
    label: "Second Worker Tent",
    blurb: "A third hand at the camp — three gathering tasks at once.",
    icon: "camping-tent",
    gold_cost: 2500,
    level_req: 25,
    effect: { kind: "extra_slot" },
  },
  {
    key: "worker_tent_3",
    label: "Third Worker Tent",
    blurb: "Four parallel slots. Full camp.",
    icon: "camping-tent",
    // Late-game capstone: players are already hitting Lv50 with three tents.
    // Gate the fourth slot far out of reach so it stays aspirational and
    // adjust gold cost to match — anyone Lv50+ should have ample gold flow.
    gold_cost: 25000,
    level_req: 50,
    effect: { kind: "extra_slot" },
  },
  {
    key: "tent_upgrade_quickdry",
    label: "Quickdry Frames",
    blurb: "Cuts every gather's wall-clock time by 25%. Applies to tasks started after build.",
    icon: "wood-frame",
    gold_cost: 600,
    level_req: 5,
    effect: { kind: "duration_pct", value: 25 },
  },
  {
    key: "tent_upgrade_haul",
    label: "Big Haul",
    blurb: "Each task brings back one extra of its primary resource.",
    icon: "knapsack",
    gold_cost: 1200,
    level_req: 7,
    effect: { kind: "yield_bonus", value: 1 },
  },
  {
    key: "tent_upgrade_keen_eye",
    label: "Keen Eye",
    blurb: "+10% chance to roll the rare resource on Standard and Deep tiers.",
    icon: "eye-target",
    gold_cost: 1500,
    level_req: 8,
    effect: { kind: "rare_bonus_pct", value: 10 },
  },
];

export function findCampUpgrade(key: string): CampUpgradeSpec | undefined {
  return CAMP_UPGRADE_CATALOG.find((u) => u.key === key);
}

// Total gather slots available given the character's built upgrades.
// 1 (main char) + 1 per built worker_tent_* upgrade. Cap at 4 (1 + 3 tents).
export function gatherSlotCount(builtKeys: string[]): number {
  let slots = 1;
  for (const key of builtKeys) {
    if (key.startsWith("worker_tent_")) slots += 1;
  }
  return Math.min(4, slots);
}

// Modifier snapshot stored on each gathering_tasks row at start time so
// in-flight tasks keep their planned math even if the player builds more
// perks (or levels up) before the task expires. The character_level and
// rested flags are snapshotted here too so a level-up or claim of another
// task doesn't retroactively change the planned yield.
export interface TentModifiers {
  duration_pct: number;     // 0..75 (clamp to leave a floor on every duration)
  yield_bonus: number;      // 0..N — added to primary resource qty
  rare_bonus_pct: number;   // 0..50 — percent points added to rare thresholds
  /** Character level at task start. Drives levelScaledXpMultiplier.
      Optional for back-compat with rows written before the rebalance. */
  character_level?: number;
  /** True when last_gather_claimed_at was >24h before this task started.
      Drives the +50% rested bonus on XP+gold. */
  rested?: boolean;
}

export const NO_TENT_MODIFIERS: TentModifiers = {
  duration_pct: 0,
  yield_bonus: 0,
  rare_bonus_pct: 0,
};

// Roll up built perks into a single modifier struct. Perks stack additively
// — two yield_bonus upgrades would each add their value (none today, but
// the math is ready). duration_pct caps at 75 so a gather can't drop to 0.
export function computeTentModifiers(builtKeys: string[]): TentModifiers {
  let duration_pct = 0;
  let yield_bonus = 0;
  let rare_bonus_pct = 0;
  for (const key of builtKeys) {
    const spec = findCampUpgrade(key);
    if (!spec) continue;
    if (spec.effect.kind === "duration_pct") duration_pct += spec.effect.value;
    else if (spec.effect.kind === "yield_bonus") yield_bonus += spec.effect.value;
    else if (spec.effect.kind === "rare_bonus_pct") rare_bonus_pct += spec.effect.value;
  }
  return {
    duration_pct: Math.min(75, Math.max(0, duration_pct)),
    yield_bonus: Math.max(0, yield_bonus),
    rare_bonus_pct: Math.min(50, Math.max(0, rare_bonus_pct)),
  };
}

// Apply duration_pct to a base tier duration. Used by /api/camp/start when
// stamping expires_at; the modifier struct is then persisted on the task
// for yield-time accounting.
export function applyDurationModifier(baseMs: number, modifiers: TentModifiers): number {
  const cut = Math.max(0, Math.min(75, modifiers.duration_pct));
  return Math.round(baseMs * (1 - cut / 100));
}

// =============================================================================
// PUB ERRANDS: timed, NPC-driven mini-quests
// =============================================================================
//
// Patrons at the pub offer timed errands. The player accepts one, waits the
// duration in real wall-clock time, then collects gold + xp + flavor loot.
// Yields are rolled lazily on read (deterministic by errand id) — same pattern
// as gathering. Trust score per (character, patron) gates which kinds are
// offered; at trust 10 the patron offers a one-shot rare errand with a
// signature reward.
//
// All catalogs here are static. The DB tracks live offers (pub_errand_offers),
// active errands (pub_errands), and trust scores (pub_trust).

export type PubErrandKind = "courier" | "procure" | "investigate" | "mercy" | "rare";
export type PubErrandTier = "short" | "medium" | "long";

export interface PubErrandTierSpec {
  tier: PubErrandTier;
  duration_ms: number;
  base_xp: number;
  base_gold: number;
}

// Tier durations chosen so errands are slower than gathering (camp Quick is
// 15 min) — these are flavor-heavy commitments, not idle clicks.
//
// Per-hour rates after the rebalance:
//   Short  → 40 XP/hr,  60 gold/hr  (fast turnaround, default loop)
//   Medium → 40 XP/hr,  70 gold/hr  (mid commit; modest gold bump)
//   Long   → 53 XP/hr,  70 gold/hr  (overnight commit; meaningful XP gain)
// Old numbers had Long losing per-hour to Short on both axes — the long
// commit should be the *best* rate, not the worst.
export const PUB_ERRAND_TIERS: Record<PubErrandTier, PubErrandTierSpec> = {
  short:  { tier: "short",  duration_ms:  30 * 60 * 1000, base_xp:  20, base_gold:  30 },
  medium: { tier: "medium", duration_ms: 120 * 60 * 1000, base_xp:  80, base_gold: 140 },
  long:   { tier: "long",   duration_ms: 360 * 60 * 1000, base_xp: 320, base_gold: 420 },
};

// Trust gates: minimum (character, patron) trust required to receive offers
// of this kind on the daily rotation. Courier is always available so first-
// time players have something to do; rare is a per-patron once-only at 10.
export const PUB_ERRAND_TRUST_GATE: Record<PubErrandKind, number> = {
  courier:     0,
  procure:     3,
  investigate: 3,
  mercy:       6,
  rare:        10,
};

// Max trust per patron. Once a player hits 10 and claims the rare, the
// patron's offer pool collapses to non-rare kinds at +25% payout.
export const PUB_TRUST_CAP = 10;

// Payout multiplier applied once trust >= 6 (the "Mercy unlocks" threshold).
export const PUB_TRUST_HIGH_MULT = 1.25;

// Procure: how many resource units the patron demands. Tier-scaled.
export const PUB_PROCURE_INPUT_QTY: Record<PubErrandTier, number> = {
  short: 1, medium: 2, long: 3,
};

export interface PubPatronSpec {
  id: string;
  name: string;
  archetype: string;
  blurb: string;
  // Display avatar — falls back to a generated NPC art slot if absent.
  icon: string;
  // Resource family they pay best for on Procure errands.
  procure_resource_node: CampNode;
  // Single signature reward (item_name) granted on the rare trust-10 errand.
  rare_item: { item_name: string; item_type: ItemType; power: number; rarity: Rarity; slot?: EquipSlot; blurb: string };
  // Items the patron tips out from on lower-trust errands. Picked weighted at roll time.
  tip_pool: Array<{ item_name: string; item_type: ItemType; power: number; rarity: Rarity; weight: number; blurb: string }>;
}

export const PUB_PATRONS: PubPatronSpec[] = [
  {
    id: "cobb",
    name: "Old Cobb the Cooper",
    archetype: "Retired barrel-maker, three drinks deep, two stories left",
    blurb: "Spent his life hooping casks for the smithy district. Keeps an unbroken streak of buying the next round.",
    icon: "beer-stein",
    procure_resource_node: "mine",
    rare_item: {
      item_name: "Cobb's Hooping Hammer",
      item_type: "weapon",
      power: 9,
      rarity: "rare",
      slot: "main_hand",
      blurb: "The smithy never took it back when Cobb retired. He says it's still got swings in it.",
    },
    tip_pool: [
      { item_name: "🧪 Health Potion",       item_type: "consumable", power: 10, rarity: "common",   weight: 4, blurb: "Pressed into your hand by a regular." },
      { item_name: "⛏️ Iron Ore",            item_type: "resource",   power: 0,  rarity: "common",   weight: 3, blurb: "From the dust at the bottom of his pocket." },
      { item_name: "🪙 Silver Ore",          item_type: "resource",   power: 0,  rarity: "uncommon", weight: 1, blurb: "He winks. 'Don't tell the smith.'" },
    ],
  },
  {
    id: "marra",
    name: "Marra Fivecups",
    archetype: "Off-shift apothecary, sharp tongue, sharper guesses",
    blurb: "Has the apothecary's keys when nobody's looking. Says half the cures are placebo. Won't say which half.",
    icon: "poison-bottle",
    procure_resource_node: "forage",
    rare_item: {
      item_name: "🔮 Marra's Concentrate",
      item_type: "magic",
      power: 2,
      rarity: "rare",
      blurb: "Permanently raises max mana by 2. She wouldn't say where it's brewed.",
    },
    tip_pool: [
      { item_name: "🌿 Mossroot",            item_type: "resource",   power: 0,  rarity: "common",   weight: 4, blurb: "Plucked from a sprig behind her ear." },
      { item_name: "🍀 Sunleaf",             item_type: "resource",   power: 0,  rarity: "uncommon", weight: 2, blurb: "She pretends it was for someone else." },
      { item_name: "✨ Mana Flask",          item_type: "consumable", power: 3,  rarity: "uncommon", weight: 2, blurb: "Tastes like dish soap. Works anyway." },
    ],
  },
  {
    id: "rell",
    name: "Captain Rell",
    archetype: "Riverboat captain on permanent shore leave",
    blurb: "Lost a boat, gained a story. Will pay handsomely for anything pulled from the water.",
    icon: "fishing-pole",
    procure_resource_node: "fish",
    rare_item: {
      item_name: "Captain's Tide-Stained Ring",
      item_type: "armor",
      power: 4,
      rarity: "rare",
      slot: "ring",
      blurb: "Worn smooth by a thousand knots. Calms the wearer's hand.",
    },
    tip_pool: [
      { item_name: "🐟 River Carp",          item_type: "resource",   power: 0,  rarity: "common",   weight: 4, blurb: "Slid across the bar wrapped in paper." },
      { item_name: "🐠 Silverfin",           item_type: "resource",   power: 0,  rarity: "uncommon", weight: 2, blurb: "'The pub kitchen'll take 'em.'" },
      { item_name: "🧪 Greater Health Potion", item_type: "consumable", power: 25, rarity: "uncommon", weight: 1, blurb: "From a kit he keeps under his coat." },
    ],
  },
];

export function findPubPatron(id: string): PubPatronSpec | undefined {
  return PUB_PATRONS.find((p) => p.id === id);
}

// Roll how many offers per patron land in the daily rotation. v1: every
// patron always offers exactly 3 distinct kinds the player is eligible for,
// drawn deterministically so the roster is stable across re-reads on the
// same day.
export const PUB_OFFERS_PER_PATRON = 3;

// Daily rotation window. Offers regenerate when the cutoff has elapsed.
export const PUB_ERRAND_RESTOCK_MS = 24 * 60 * 60 * 1000;

// Deterministic seeded RNG so a status fetch and a later read agree on the
// same yield. Mirrors the camp version (kept here to avoid an import cycle).
function pubMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick which errand kinds a patron offers today given a deterministic seed
// and current trust. Always returns kinds the player is gated for; rare
// only appears once trust hits cap and the patron's rare hasn't been claimed.
export function rollPatronOfferKinds(
  patronId: string,
  dayBucket: number,
  trustScore: number,
  rareClaimed: boolean,
): PubErrandKind[] {
  const seed = hashStringPub(patronId) ^ dayBucket;
  const rng = pubMulberry32(seed);
  const eligible: PubErrandKind[] = [];
  for (const kind of ["courier", "procure", "investigate", "mercy"] as PubErrandKind[]) {
    if (trustScore >= PUB_ERRAND_TRUST_GATE[kind]) eligible.push(kind);
  }
  // Always fill PUB_OFFERS_PER_PATRON slots; allow duplicates of eligible
  // kinds (different tiers) so low-trust players still see 3 offers even
  // when only Courier is unlocked.
  const tiers: PubErrandTier[] = ["short", "medium", "long"];
  const offers: PubErrandKind[] = [];
  for (let i = 0; i < PUB_OFFERS_PER_PATRON; i++) {
    offers.push(eligible[Math.floor(rng() * eligible.length)] ?? "courier");
    tiers[i % 3]; // reserve a tier (consumed in the offer rotation, not here)
  }
  // Rare gates the rest: at cap + un-claimed, replace the last slot with a rare.
  if (trustScore >= PUB_TRUST_CAP && !rareClaimed) {
    offers[offers.length - 1] = "rare";
  }
  return offers;
}

// Stable per-offer tier picker — index 0/1/2 maps to short/medium/long so the
// 3 daily slots span tiers.
export function tierForOfferIndex(index: number): PubErrandTier {
  return (["short", "medium", "long"] as const)[index % 3];
}

function hashStringPub(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface PubErrandYield {
  gold: number;
  xp: number;
  items: Array<{ item_name: string; item_type: ItemType; power: number; rarity: Rarity; slot?: EquipSlot | null; blurb: string }>;
  // Mercy errands grant a stacking apothecary discount (caps at 3 stacks).
  apothecary_discount_stacks?: number;
  // Investigate errands return a short lore fragment.
  lore_fragment?: string;
}

// ── Forage mini-game grid ──────────────────────────────────────────────────
//
// Minesweeper-style. Each "place in the forest" is one of:
//   - empty       : nothing under the dirt
//   - mossroot    : common herb. Clusters together.
//   - sunleaf     : uncommon herb. Repels mushrooms — never adjacent to one,
//                   so revealing a sunleaf confirms its neighbors are safe.
//   - mushroom    : poison hazard (1d4 HP). The only danger in the forest.
//
// Revealed cells render a hazard-count badge (count of adjacent mushrooms in
// the 8-neighborhood). Players deduce mushroom positions from the numbers,
// classic Minesweeper-style. The server generates the grid and tracks
// reveals in the forage_games table.
export type ForageCellKind =
  | "empty"
  | "mossroot"
  | "sunleaf"
  | "mushroom";

// Mini-game XP level scaling. Without this, the 3–12 XP awards stay flat
// while the character XP curve grows steeply — by L10 a 10 XP reward is
// only 0.2% of the way to the next level, which feels insulting. Adds 15%
// per character level above L3 (so L1–3 see no change but L10 doubles up
// and L20 is ~3.5x). Mirrors the same scaling shape as rollGatherYield so
// active and deferred gather paths feel commensurate.
export function scaleMinigameXp(baseXp: number, level: number): number {
  const factor = 1 + 0.15 * Math.max(0, level - 3);
  return Math.floor(baseXp * factor);
}

// Camp node stock — capacity and replenishment for the per-node harvestable
// pools that replaced the old hourly-vigor cooldowns. Each play depletes
// stock by the resources granted (not a fixed cost), and stock refills at 1
// unit per hour up to STOCK_CAP. Mini-games are always playable; depleted
// stock just means scant XP and zero resources for that play.
export const STOCK_CAP = 10;
export const STOCK_REGEN_MS = 60 * 60 * 1000;
// XP granted when the player completes a mini-game on an empty stock node.
// Keeps the score-attack / leaderboard mode meaningful without flooding the
// inventory with resources.
export const STOCK_EMPTY_XP = 2;

// Returns 0..STOCK_CAP. Same semantics as currentVigor: null/past timestamp
// means full pool, otherwise we deduct based on how many regen-ticks remain.
export function currentStock(fullAt: number | null | undefined, now: number): number {
  if (!fullAt || fullAt <= now) return STOCK_CAP;
  const ticksRemaining = Math.ceil((fullAt - now) / STOCK_REGEN_MS);
  return Math.max(0, STOCK_CAP - ticksRemaining);
}

// Returns the ms until the next +1 stock would arrive, or null if the pool
// is already full.
export function nextStockTickMs(fullAt: number | null | undefined, now: number): number | null {
  if (!fullAt || fullAt <= now) return null;
  const msIntoCurrentTick = (fullAt - now) % STOCK_REGEN_MS;
  return msIntoCurrentTick === 0 ? STOCK_REGEN_MS : msIntoCurrentTick;
}

// Spend N stock (where N = number of resource units the player actually
// pulled this play). Returns the new full-at timestamp. Caller is responsible
// for clamping N to currentStock(...) before granting resources.
export function spendStock(
  fullAt: number | null | undefined,
  now: number,
  units: number,
): number {
  if (units <= 0) return fullAt && fullAt > now ? fullAt : (fullAt ?? now);
  // If pool is currently full, the regen clock starts now.
  const base = (fullAt && fullAt > now) ? fullAt : now;
  return base + units * STOCK_REGEN_MS;
}

// 5×5 grid feels right at this density — 4×4 was too small (cascade swept the
// board, deduction trivial). 25 cells with 4-5 mushrooms keeps the cascade
// bounded and leaves enough cells for genuine puzzle-solving after the
// opening reveal.
export const FORAGE_GRID_ROWS = 5;
export const FORAGE_GRID_COLS = 5;
// Cascade reveals are free, but the bigger grid + scattered herbs mean the
// player needs more manual flips to harvest everything they spot.
export const FORAGE_BASE_FLIPS = 5;
export const FORAGE_MAX_FLIPS = 7;
export const FORAGE_HAZARD_DICE = 4; // 1dN HP per mushroom

export function forageFlipsForInt(intStat: number | null | undefined): number {
  const base = FORAGE_BASE_FLIPS;
  const bonus = Math.min(FORAGE_MAX_FLIPS - base, Math.max(0, ((intStat ?? 5) - 5)));
  return base + bonus;
}

// True if the cell is a hazard. Mushrooms are the only danger in the
// simplified ecology; the count badge on revealed cells reflects this.
export function isForageHazard(kind: ForageCellKind): boolean {
  return kind === "mushroom";
}

// Count hazards in the 8-neighborhood of (r, c).
export function forageHazardCount(grid: ForageCellKind[][], r: number, c: number): number {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= FORAGE_GRID_ROWS || nc < 0 || nc >= FORAGE_GRID_COLS) continue;
      if (isForageHazard(grid[nr][nc])) n++;
    }
  }
  return n;
}

// BFS cascade from a starting reveal. The starting cell is always included.
// Any revealed cell with hazard_count === 0 (and that isn't itself a hazard)
// expands to its 8 neighbors. Hazards are NEVER returned by the cascade —
// they only appear when manually flipped, since 0-count cells by definition
// have no hazard neighbors.
//
// Pass `alreadyRevealed` as the set of "r,c" keys already in the player's
// revealed list so the cascade doesn't redundantly re-include them.
export interface ForageRevealedCell {
  r: number;
  c: number;
  cell: ForageCellKind;
  hazard_count: number;
}

export function forageCascadeFrom(
  grid: ForageCellKind[][],
  startR: number,
  startC: number,
  alreadyRevealed: Set<string>,
): ForageRevealedCell[] {
  const out: ForageRevealedCell[] = [];
  const seen = new Set<string>();
  const queue: Array<[number, number]> = [[startR, startC]];
  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    const key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (alreadyRevealed.has(key)) continue;
    const cell = grid[r][c];
    const hazardCount = forageHazardCount(grid, r, c);
    out.push({ r, c, cell, hazard_count: hazardCount });
    // Cascade only through 0-count, non-hazard cells. (Hazards never appear
    // via cascade because a 0-count cell has no hazard neighbors by
    // definition; this is a belt-and-suspenders guard.)
    if (hazardCount === 0 && !isForageHazard(cell)) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= FORAGE_GRID_ROWS || nc < 0 || nc >= FORAGE_GRID_COLS) continue;
          const nKey = `${nr},${nc}`;
          if (!seen.has(nKey) && !alreadyRevealed.has(nKey)) {
            queue.push([nr, nc]);
          }
        }
      }
    }
  }
  return out;
}

// 8-direction adjacency.
function neighbors(r: number, c: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= FORAGE_GRID_ROWS || nc < 0 || nc >= FORAGE_GRID_COLS) continue;
      out.push([nr, nc]);
    }
  }
  return out;
}

function pickRandomEmpty(
  grid: ForageCellKind[][],
  rnd: () => number,
  filter?: (r: number, c: number) => boolean,
): [number, number] | null {
  const slots: Array<[number, number]> = [];
  for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
    for (let c = 0; c < FORAGE_GRID_COLS; c++) {
      if (grid[r][c] !== "empty") continue;
      if (filter && !filter(r, c)) continue;
      slots.push([r, c]);
    }
  }
  if (slots.length === 0) return null;
  return slots[Math.floor(rnd() * slots.length)];
}

export function generateForageGrid(seed: number): ForageCellKind[][] {
  const rnd = mulberry32(seed);
  const grid: ForageCellKind[][] = Array.from({ length: FORAGE_GRID_ROWS }, () =>
    Array.from({ length: FORAGE_GRID_COLS }, () => "empty" as ForageCellKind),
  );

  // 1. Mossroot — 3-4 cells scattered individually (NOT clustered). Earlier
  //    versions clustered mossroot so the opening cascade could grab all of
  //    them in one tap; scattering them means at least one will be far from
  //    the safe-start cell, requiring a real deduction.
  const mossrootCount = 3 + Math.floor(rnd() * 2);
  for (let i = 0; i < mossrootCount; i++) {
    const slot = pickRandomEmpty(grid, rnd);
    if (!slot) break;
    grid[slot[0]][slot[1]] = "mossroot";
  }

  // 2. Sunleaf — exactly 2, placed randomly. Sunleaf gates mushroom
  //    placement in the next step, so revealing a sunleaf certifies its
  //    neighbors as mushroom-free (the deduction rule that survives the
  //    simplified ecology).
  for (let i = 0; i < 2; i++) {
    const slot = pickRandomEmpty(grid, rnd);
    if (!slot) break;
    grid[slot[0]][slot[1]] = "sunleaf";
  }

  // 3. Mushrooms — 4-5 hazards (up from 2-3 on the old 4×4). Higher density
  //    keeps cascades bounded by hazard-count > 0 cells and forces more
  //    careful flipping. Never adjacent to sunleaf so sunleaf reveals stay
  //    reliable safety signals.
  const mushroomCount = 4 + Math.floor(rnd() * 2);
  for (let i = 0; i < mushroomCount; i++) {
    const slot = pickRandomEmpty(grid, rnd, (r, c) =>
      !neighbors(r, c).some(([nr, nc]) => grid[nr][nc] === "sunleaf"),
    );
    if (!slot) break;
    grid[slot[0]][slot[1]] = "mushroom";
  }

  return grid;
}

// ── Fishing mini-game tuning ───────────────────────────────────────────────
//
// Two phases per cast:
//   1. WAIT — bobber bobs for a random delay (FISH_BITE_MIN..FISH_BITE_MAX ms).
//      A bite cue fires; the player has BITE_WINDOW ms to strike. DEX widens
//      the window. Reaction time is recorded for the Fastest Hook board.
//   2. REEL — the player holds to reel against a fish that pulls back. The
//      indicator must stay in the SAFE zone (middle) to fill the catch meter.
//      SLACK (top) and SNAP (bottom) zones leak the catch meter back down.
//      STR softens the fish's pull rate.
//
// Loot tier follows the same anti-grind pattern as mining + forage:
//   - Common  : river_carp
//   - Uncommon: silverfin (mini-game ceiling; quality-gated)
//   - Rare    : abyss_eel — DEEP TIER ONLY, never from Quick Cast.
export const FISH_BITE_MIN_MS = 1800;
export const FISH_BITE_MAX_MS = 6500;
export const FISH_BITE_WINDOW_BASE_MS = 700;   // +30ms per DEX above 5, cap +400
export const FISH_REACTION_FLOOR_MS = 80;      // human-floor anti-cheese
export const FISH_REEL_TARGET_MS = 3500;       // total reel-phase duration
export const FISH_PULL_RATE_BASE = 0.45;       // SAFE-zone falloff per second; STR softens

export function fishBiteWindowForDex(dexStat: number | null | undefined): number {
  const dex = dexStat ?? 5;
  const bonusSteps = Math.max(0, Math.min(13, dex - 5));
  return FISH_BITE_WINDOW_BASE_MS + bonusSteps * 30; // 700..1090ms
}

export function fishPullRateForStr(strStat: number | null | undefined): number {
  const str = strStat ?? 5;
  // Each STR above 5 trims the pull rate by 1.5%, cap -15% (so STR 15 → 0.85 × base).
  const reduction = Math.max(0, Math.min(0.15, (str - 5) * 0.015));
  return FISH_PULL_RATE_BASE * (1 - reduction);
}

// Catch quality blends reaction speed and reel performance. Returns 0..1.
// Reaction component (40%): fastest = 1.0 at 120ms, decays to 0 at 700ms.
// Reel component (60%): clamped raw value the client measured.
export function fishCatchQuality(reactionMs: number, reelSafeFraction: number): number {
  const reactScale = Math.max(0, Math.min(1, (700 - Math.max(reactionMs, 120)) / 580));
  const reelScale = Math.max(0, Math.min(1, reelSafeFraction));
  return 0.4 * reactScale + 0.6 * reelScale;
}

// Roll the reward bag for an errand. Deterministic by errand id so the same
// errand always pays the same — fetch and claim agree without locking.
export function rollPubErrandYield(
  errandId: number,
  patronId: string,
  kind: PubErrandKind,
  tier: PubErrandTier,
  trustScore: number,
  characterLevel = 1,
): PubErrandYield {
  const patron = findPubPatron(patronId);
  if (!patron) return { gold: 0, xp: 0, items: [] };
  const tierSpec = PUB_ERRAND_TIERS[tier];
  const rng = pubMulberry32(errandId);
  const trustMult = trustScore >= 6 ? PUB_TRUST_HIGH_MULT : 1;
  // Both XP and gold scale with character level so the world stays relevant
  // as the player progresses. Trust is an additional multiplier on top.
  const levelMult = levelScaledXpMultiplier(characterLevel);
  const xpScale = trustMult * levelMult;
  let gold = Math.round(tierSpec.base_gold * trustMult * levelMult);
  let xp = Math.round(tierSpec.base_xp * xpScale);
  const items: PubErrandYield["items"] = [];

  if (kind === "rare") {
    items.push({
      item_name: patron.rare_item.item_name,
      item_type: patron.rare_item.item_type,
      power: patron.rare_item.power,
      rarity: patron.rare_item.rarity,
      slot: patron.rare_item.slot ?? null,
      blurb: patron.rare_item.blurb,
    });
    gold = Math.round(gold * 1.5);
    xp = Math.round(xp * 1.5);
    return { gold, xp, items };
  }

  // Tip chance: courier 25%, procure 90% (you brought them resources),
  // investigate 50%, mercy 70%.
  const tipChance = kind === "courier" ? 0.25 : kind === "procure" ? 0.9 : kind === "investigate" ? 0.5 : 0.7;
  if (rng() < tipChance) {
    const totalWeight = patron.tip_pool.reduce((s, e) => s + e.weight, 0);
    let pick = rng() * totalWeight;
    for (const entry of patron.tip_pool) {
      pick -= entry.weight;
      if (pick <= 0) {
        items.push({
          item_name: entry.item_name,
          item_type: entry.item_type,
          power: entry.power,
          rarity: entry.rarity,
          slot: null,
          blurb: entry.blurb,
        });
        break;
      }
    }
  }

  const result: PubErrandYield = { gold, xp, items };
  if (kind === "investigate") {
    result.lore_fragment = pickLoreFragment(patronId, rng);
  }
  if (kind === "mercy") {
    result.apothecary_discount_stacks = 1;
  }
  return result;
}

// Short, flavor-heavy lore strings keyed by patron. Picked deterministically
// off the errand's RNG so the same errand always returns the same fragment.
const LORE_FRAGMENTS: Record<string, string[]> = {
  cobb: [
    "The old smithy's third anvil — the one they never use — was Cobb's. He sharpened it himself.",
    "There's a hidden ore vein north of the bluffs. Cobb saw it once, never went back.",
    "The smith owes Cobb a favor. He won't say what for.",
  ],
  marra: [
    "Half the apothecary's stock is repackaged garden cuttings. Marra would know.",
    "Nightbloom grows in the apothecary's back lot. The owner doesn't know.",
    "There's a brewing recipe Marra hasn't written down. She says it works on the third try.",
  ],
  rell: [
    "The river bends east of the pub. There's a quiet pool no one fishes.",
    "Rell's old crew shipped silverfin past the customs house. He says they paid the right people.",
    "The captain's ring matches a pattern on the pub's eastern wall. He won't say why.",
  ],
};

function pickLoreFragment(patronId: string, rng: () => number): string {
  const pool = LORE_FRAGMENTS[patronId] ?? LORE_FRAGMENTS.cobb;
  return pool[Math.floor(rng() * pool.length)];
}

// =============================================================================
// PUB COOKING: turn raw fish into cooked food consumables
// =============================================================================
//
// The bartender takes 1 fish + small gold and returns a food consumable (HP
// heal on use). Closes the fish loop — without this, Captain Rell's procure
// errand and the Fishing Hole only pay in gold + sell value. Mirrors the
// smithy forge / apothecary brew flow: recipe catalog in code, consumed via
// a single POST endpoint.

export interface CookRecipeSpec {
  id: string;             // slash-form slug
  output_name: string;    // inventory item_name; pre-prefixed with food emoji
  output_power: number;   // HP healed on use
  output_rarity: Rarity;
  output_blurb: string;
  /** One or more resources combined into the dish. Multi-input recipes are
      the "combo" tier — better HP yield per fish spent than the base singles. */
  inputs: Array<{ resource_id: string; qty: number }>;
  gold_cost: number;
  level_req: number;
}

export const COOK_RECIPES: CookRecipeSpec[] = [
  // Single-fish dishes — the baseline.
  {
    id: "pan_fried_carp",
    output_name: "🍣 Pan-Fried Carp",
    output_power: 20,
    output_rarity: "common",
    output_blurb: "Restores 20 HP. Crispy skin, flaky middle. The bartender takes pride in this one.",
    inputs: [{ resource_id: "river_carp", qty: 1 }],
    gold_cost: 10,
    level_req: 1,
  },
  {
    id: "silverfin_steak",
    output_name: "🐟 Silverfin Steak",
    output_power: 40,
    output_rarity: "uncommon",
    output_blurb: "Restores 40 HP. Seared rare, served with a pinch of river salt.",
    inputs: [{ resource_id: "silverfin", qty: 1 }],
    gold_cost: 25,
    level_req: 2,
  },
  {
    id: "abyss_stew",
    output_name: "🍲 Abyss Stew",
    output_power: 75,
    output_rarity: "rare",
    output_blurb: "Restores 75 HP. The bartender stirs once and turns away. Best not to ask.",
    inputs: [{ resource_id: "abyss_eel", qty: 1 }],
    gold_cost: 50,
    level_req: 4,
  },
  // Combo dishes — multi-fish, the bartender's specials. Each gives ~25-30%
  // more HP per fish than cooking them as singles. The level gate keeps them
  // off the menu until the player has access to all the inputs reliably.
  {
    id: "surf_and_stream",
    output_name: "🍱 Surf & Stream Platter",
    output_power: 110,
    output_rarity: "uncommon",
    output_blurb: "Restores 110 HP. Two carp seared crisp around a silverfin medallion. House special.",
    inputs: [
      { resource_id: "silverfin", qty: 1 },
      { resource_id: "river_carp", qty: 2 },
    ],
    gold_cost: 50,
    level_req: 3,
  },
  {
    id: "three_fish_banquet",
    output_name: "🍛 Three-Fish Banquet",
    output_power: 180,
    output_rarity: "rare",
    output_blurb: "Restores 180 HP. River, lake, and deep — every layer cooked through. The bartender salutes.",
    inputs: [
      { resource_id: "river_carp", qty: 1 },
      { resource_id: "silverfin", qty: 1 },
      { resource_id: "abyss_eel", qty: 1 },
    ],
    gold_cost: 90,
    level_req: 5,
  },
  {
    id: "grand_mariners_feast",
    output_name: "🍤 Grand Mariner's Feast",
    output_power: 220,
    output_rarity: "rare",
    output_blurb: "Restores 220 HP. Silverfin filets, eel terrine, smoked pepper jus. Eats like a quest, recovers like one too.",
    inputs: [
      { resource_id: "silverfin", qty: 2 },
      { resource_id: "abyss_eel", qty: 1 },
    ],
    gold_cost: 110,
    level_req: 6,
  },
];

export function findCookRecipe(id: string): CookRecipeSpec | undefined {
  return COOK_RECIPES.find((r) => r.id === id);
}
