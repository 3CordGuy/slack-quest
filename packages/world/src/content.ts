// Static game content for the overworld game: hero classes, weapons and
// their abilities, enemies, and loot. Data only; the reducers in battle.ts
// and world.ts give it meaning.

import type { StatKey, Stats } from "@gantt-quest/core";

/** Effect names match EFFECT_META in packages/core/src/flavor.ts, plus `guarded`, `taunting` and the timeline effects (`slowed`, `hasted`, `glitched`, `exposed`). */
export type EffectKind = "bleeding" | "burning" | "stunned" | "guarded" | "taunting" | "slowed" | "hasted" | "glitched" | "exposed";

export const EFFECT_INFO: Record<EffectKind, { name: string; blurb: string; color: string }> = {
  bleeding: { name: "Bleeding", blurb: "Loses 2 HP at the start of each turn.", color: "#f87171" },
  burning: { name: "Burning", blurb: "Loses 3 HP at the start of each turn.", color: "#fb923c" },
  stunned: { name: "Stunned", blurb: "Skips the next turn.", color: "#a78bfa" },
  guarded: { name: "Guarded", blurb: "Takes half damage until its next turn.", color: "#93c5fd" },
  taunting: { name: "Taunting", blurb: "Every enemy attack aimed at one hero goes to it instead, until its next turn.", color: "#fbbf24" },
  slowed: { name: "Slowed", blurb: "Its next turns come half again later on the timeline.", color: "#4ade80" },
  hasted: { name: "Hasted", blurb: "Its next turn comes a third sooner on the timeline.", color: "#67e8f9" },
  glitched: { name: "Glitched", blurb: "One roll of its next attack fails, whatever happens.", color: "#e879f9" },
  exposed: { name: "Exposed", blurb: "Takes 3 more damage from every direct hit, for 2 of its turns.", color: "#facc15" },
};

/** Exposed targets take this much more from each direct hit. */
export const EXPOSED_BONUS = 3;
/** A hasted combatant's wait between turns is multiplied by this; a slowed one's by SLOW_FACTOR. */
export const HASTE_FACTOR = 2 / 3;
export const SLOW_FACTOR = 1.5;

export const EFFECT_TICK: Partial<Record<EffectKind, number>> = { bleeding: 2, burning: 3 };

// ---------- classes ----------

export interface HeroClass {
  id: string;
  name: string;
  blurb: string;
  /** First entry is the starting weapon; the rest drop as loot. */
  weapons: string[];
  /** Something the class always does in a fight, if it has one. Shown when choosing a class. */
  passive?: string;
}

/** HP the Reef Druid grows back at the start of each of its turns in a fight. */
export const DRUID_REGEN = 1;
/** Extra damage on every other hero's attacks while a Shanty Bard is standing. One Bard's worth, however many there are. */
export const BARD_AURA = 2;
/** Bulwark Strike adds the Warden's armor divided by this to its damage. */
export const ARMOR_DAMAGE_DIVISOR = 3;
/** Turns of bleeding the Wreck Warlock's perfect hits leave behind. */
export const WARLOCK_BLEED_TURNS = 2;

export const HERO_CLASSES: HeroClass[] = [
  {
    id: "qa_paladin",
    name: "Tidewall Paladin",
    blurb: "Tough front-liner. Hits hard with Strength and shrugs off blows.",
    weapons: ["mace", "greatsword"],
  },
  {
    id: "devops_mage",
    name: "Stormcall Mage",
    blurb: "Fragile caster. Burns enemies and patches up allies with Intelligence.",
    weapons: ["staff", "tome"],
  },
  {
    id: "refactor_rogue",
    name: "Smuggler Rogue",
    blurb: "Fast and precise. Opens wounds with Dexterity and usually acts first.",
    weapons: ["daggers", "shortbow"],
  },
  {
    id: "backend_druid",
    name: "Reef Druid",
    blurb: "Hardy healer. Mends allies and tangles enemies with Intelligence, and regrows like coral.",
    weapons: ["root_staff", "sickle"],
    passive: `Deep roots: heals ${DRUID_REGEN} HP at the start of each of its turns in a fight.`,
  },
  {
    id: "frontend_bard",
    name: "Shanty Bard",
    blurb: "Makes everyone better. Plays the party up and the enemy down with Intelligence.",
    weapons: ["lute", "flute"],
    passive: `Encore: while the Bard is standing, every other hero's attacks do +${BARD_AURA} damage.`,
  },
  {
    id: "staff_sage",
    name: "Starchart Sage",
    blurb: "Raw power. The hardest-hitting spells of any class, and little else to fall back on.",
    weapons: ["orb", "scepter"],
  },
  {
    id: "sre_warden",
    name: "Lighthouse Warden",
    blurb: "The wall. Draws every blow onto itself and hits back with Strength and the weight of its armor.",
    weapons: ["pager_axe", "maul"],
    passive: "Night watch: starts every fight guarded (half damage) until its second turn.",
  },
  {
    id: "data_warlock",
    name: "Wreck Warlock",
    blurb: "Curses and drains with Intelligence. The bigger the enemy, the harder its Hex lands.",
    weapons: ["grimoire", "void_staff"],
    passive: `Riptide: every perfect hit also leaves the target bleeding for ${WARLOCK_BLEED_TURNS} turns.`,
  },
];

export function heroClass(id: string): HeroClass | undefined {
  return HERO_CLASSES.find((c) => c.id === id);
}

// ---------- abilities ----------

export type AbilityTarget = "enemy" | "all_enemies" | "ally" | "self";

export interface AbilityDef {
  id: string;
  name: string;
  stat: StatKey;
  rolls: number;
  target: AbilityTarget;
  /** Damage at a perfect result, before the level bonus. Scales with successes. */
  damage?: number;
  /** Healing at a perfect result. Scales with successes. */
  heal?: number;
  /** Applied to the user when at least one roll succeeds. */
  selfEffect?: { effect: EffectKind; turns: number };
  /** Applied to the target only on a perfect result. */
  perfect?: { effect: EffectKind; turns: number };
  /** Applied to each target when at least one roll succeeds. */
  targetEffect?: { effect: EffectKind; turns: number };
  /** Adds a share of the user's armor (ARMOR_DAMAGE_DIVISOR) to the damage. */
  armorDamage?: boolean;
  /** Adds this share of the target's max HP to the damage, so it lands hardest on big enemies. */
  maxHpDamage?: number;
  /** Heals the user this share of the damage it deals. */
  drain?: number;
  blurb: string;
}

export const ABILITIES: Record<string, AbilityDef> = {
  smite: { id: "smite", name: "Smite", stat: "str", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "stunned", turns: 1 }, blurb: "Solid blow. Perfect: stuns." },
  shield_wall: { id: "shield_wall", name: "Shield Wall", stat: "vit", rolls: 2, target: "self", heal: 4, selfEffect: { effect: "guarded", turns: 1 }, blurb: "Guard yourself and catch your breath." },
  cleave: { id: "cleave", name: "Cleave", stat: "str", rolls: 4, target: "all_enemies", damage: 7, perfect: { effect: "exposed", turns: 2 }, blurb: "Hits every enemy. Perfect: exposed." },
  heavy_blow: { id: "heavy_blow", name: "Heavy Blow", stat: "str", rolls: 2, target: "enemy", damage: 12, perfect: { effect: "bleeding", turns: 3 }, blurb: "All or nothing. Perfect: bleeding." },
  firebolt: { id: "firebolt", name: "Firebolt", stat: "int_stat", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "burning", turns: 3 }, blurb: "Perfect: sets the target burning." },
  mend: { id: "mend", name: "Mend", stat: "int_stat", rolls: 2, target: "ally", heal: 10, blurb: "Heal an ally (or yourself)." },
  chain_spark: { id: "chain_spark", name: "Chain Spark", stat: "int_stat", rolls: 4, target: "all_enemies", damage: 6, perfect: { effect: "glitched", turns: 1 }, blurb: "Arcs through every enemy. Perfect: glitched." },
  hex_bolt: { id: "hex_bolt", name: "Hex Bolt", stat: "int_stat", rolls: 2, target: "enemy", damage: 6, perfect: { effect: "stunned", turns: 1 }, blurb: "Perfect: stuns." },
  quick_stab: { id: "quick_stab", name: "Quick Stab", stat: "dex", rolls: 2, target: "enemy", damage: 8, perfect: { effect: "bleeding", turns: 3 }, blurb: "Reliable. Perfect: bleeding." },
  flurry: { id: "flurry", name: "Flurry", stat: "dex", rolls: 4, target: "enemy", damage: 12, perfect: { effect: "exposed", turns: 2 }, blurb: "Four cuts; every one has to land. Perfect: exposed." },
  aimed_shot: { id: "aimed_shot", name: "Aimed Shot", stat: "dex", rolls: 3, target: "enemy", damage: 10, blurb: "A careful, heavy shot." },
  thornlash: { id: "thornlash", name: "Thornlash", stat: "int_stat", rolls: 3, target: "enemy", damage: 10, perfect: { effect: "slowed", turns: 2 }, blurb: "Thorns that dig in. Perfect: slowed." },
  rejuvenate: { id: "rejuvenate", name: "Rejuvenate", stat: "int_stat", rolls: 2, target: "ally", heal: 9, blurb: "Heal an ally (or yourself)." },
  overgrowth: { id: "overgrowth", name: "Overgrowth", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 5, perfect: { effect: "slowed", turns: 2 }, blurb: "Roots burst up under every enemy. Perfect: slowed." },
  dissonance: { id: "dissonance", name: "Dissonance", stat: "int_stat", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "stunned", turns: 1 }, blurb: "A note nobody can think through. Perfect: stuns." },
  encore: { id: "encore", name: "Second Wind", stat: "int_stat", rolls: 2, target: "ally", heal: 9, targetEffect: { effect: "hasted", turns: 1 }, blurb: "A tune that gets an ally (or yourself) back on their feet, and hastes them." },
  cacophony: { id: "cacophony", name: "Cacophony", stat: "int_stat", rolls: 4, target: "all_enemies", damage: 5, blurb: "Every enemy hears it." },
  manifest: { id: "manifest", name: "Manifest", stat: "int_stat", rolls: 3, target: "enemy", damage: 12, perfect: { effect: "exposed", turns: 2 }, blurb: "Raw force. The heaviest single spell there is. Perfect: exposed." },
  arcane_ward: { id: "arcane_ward", name: "Arcane Ward", stat: "int_stat", rolls: 2, target: "self", heal: 3, selfEffect: { effect: "guarded", turns: 1 }, blurb: "Wrap yourself in a ward and steady your breath." },
  meteor: { id: "meteor", name: "Meteor", stat: "int_stat", rolls: 4, target: "all_enemies", damage: 9, perfect: { effect: "burning", turns: 3 }, blurb: "Everything has to land. Perfect: sets them all burning." },
  bulwark_strike: { id: "bulwark_strike", name: "Bulwark Strike", stat: "str", rolls: 3, target: "enemy", damage: 7, armorDamage: true, perfect: { effect: "exposed", turns: 2 }, blurb: "Your whole weight behind the blow: adds a third of your armor to the damage. Perfect: exposed." },
  taunt: { id: "taunt", name: "Taunt", stat: "str", rolls: 2, target: "enemy", damage: 4, selfEffect: { effect: "taunting", turns: 1 }, blurb: "A jab and a shout. Until your next turn, enemies aiming at one hero aim at you." },
  hold_the_line: { id: "hold_the_line", name: "Hold the Line", stat: "vit", rolls: 2, target: "self", heal: 4, selfEffect: { effect: "guarded", turns: 1 }, blurb: "Plant your feet: guard yourself and catch your breath." },
  shockwave: { id: "shockwave", name: "Shockwave", stat: "str", rolls: 4, target: "all_enemies", damage: 5, perfect: { effect: "stunned", turns: 1 }, blurb: "Slam the ground under every enemy. Perfect: stuns them all." },
  hex: { id: "hex", name: "Hex", stat: "int_stat", rolls: 3, target: "enemy", damage: 6, maxHpDamage: 0.05, perfect: { effect: "glitched", turns: 1 }, blurb: "A slow query on the target: adds 5% of its max HP to the damage. Perfect: glitched." },
  blight: { id: "blight", name: "Blight", stat: "int_stat", rolls: 4, target: "all_enemies", damage: 5, blurb: "A curse on every enemy at once." },
  soul_drain: { id: "soul_drain", name: "Soul Drain", stat: "int_stat", rolls: 2, target: "enemy", damage: 7, drain: 0.34, blurb: "Takes some of their life for yours: heals you a third of the damage dealt." },
  pin_down: { id: "pin_down", name: "Pin Down", stat: "agi", rolls: 2, target: "enemy", damage: 4, perfect: { effect: "stunned", turns: 1 }, blurb: "Perfect: stuns." },
};

export interface WeaponDef {
  id: string;
  name: string;
  classId: string;
  abilities: string[];
}

export const WEAPONS: Record<string, WeaponDef> = {
  mace: { id: "mace", name: "Anchor Mace", classId: "qa_paladin", abilities: ["smite", "shield_wall"] },
  greatsword: { id: "greatsword", name: "Breakwater Greatsword", classId: "qa_paladin", abilities: ["cleave", "heavy_blow", "shield_wall"] },
  staff: { id: "staff", name: "Squall Staff", classId: "devops_mage", abilities: ["firebolt", "mend"] },
  tome: { id: "tome", name: "Logbook of Gales", classId: "devops_mage", abilities: ["chain_spark", "hex_bolt", "mend"] },
  daggers: { id: "daggers", name: "Twin Gutting Knives", classId: "refactor_rogue", abilities: ["quick_stab", "flurry"] },
  shortbow: { id: "shortbow", name: "Crow's Nest Shortbow", classId: "refactor_rogue", abilities: ["aimed_shot", "pin_down", "quick_stab"] },
  root_staff: { id: "root_staff", name: "Driftwood Staff", classId: "backend_druid", abilities: ["thornlash", "rejuvenate"] },
  sickle: { id: "sickle", name: "Kelp Sickle", classId: "backend_druid", abilities: ["overgrowth", "thornlash", "rejuvenate"] },
  lute: { id: "lute", name: "Dockside Lute", classId: "frontend_bard", abilities: ["dissonance", "encore"] },
  flute: { id: "flute", name: "Bosun's Pipe", classId: "frontend_bard", abilities: ["cacophony", "dissonance", "encore"] },
  orb: { id: "orb", name: "Sextant Orb", classId: "staff_sage", abilities: ["manifest", "arcane_ward"] },
  scepter: { id: "scepter", name: "Tidestone Scepter", classId: "staff_sage", abilities: ["meteor", "manifest", "arcane_ward"] },
  pager_axe: { id: "pager_axe", name: "Foghorn Axe", classId: "sre_warden", abilities: ["bulwark_strike", "taunt", "hold_the_line"] },
  maul: { id: "maul", name: "Bell-Buoy Maul", classId: "sre_warden", abilities: ["shockwave", "bulwark_strike", "taunt"] },
  grimoire: { id: "grimoire", name: "Drowned Grimoire", classId: "data_warlock", abilities: ["hex", "soul_drain"] },
  void_staff: { id: "void_staff", name: "Undertow Staff", classId: "data_warlock", abilities: ["blight", "hex", "soul_drain"] },
};

// ---------- enemies ----------

export interface EnemyAttack {
  name: string;
  rolls: number;
  pct: number;
  damage: number;
  target: "hero" | "all_heroes";
  perfect?: { effect: EffectKind; turns: number };
  weight: number;
}

export interface EnemyDef {
  kind: string;
  name: string;
  hp: number;
  /** Initiative base, on the same 0–100 scale as statPct(agi). */
  speed: number;
  xp: number;
  boss?: boolean;
  attacks: EnemyAttack[];
}

/** The sparring ring's stand-in opponent. Practice only: no story or map may field it. */
export const DUMMY_KIND = "dummy";

export const ENEMIES: Record<string, EnemyDef> = {
  // Soaks up a whole rotation of abilities and barely hits back.
  dummy: {
    kind: "dummy", name: "Training Dummy", hp: 60, speed: 0, xp: 0,
    attacks: [{ name: "Wobble", rolls: 2, pct: 29, damage: 1, target: "hero", weight: 1 }],
  },
  bandit: {
    kind: "bandit", name: "Bandit", hp: 12, speed: 60, xp: 12,
    attacks: [
      { name: "Slash", rolls: 3, pct: 49, damage: 6, target: "hero", weight: 3 },
      { name: "Cheap Shot", rolls: 2, pct: 45, damage: 5, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 1 },
    ],
  },
  wolf: {
    kind: "wolf", name: "Dire Wolf", hp: 9, speed: 75, xp: 10,
    attacks: [{ name: "Bite", rolls: 2, pct: 57, damage: 5, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 1 }],
  },
  cultist: {
    kind: "cultist", name: "Cultist", hp: 11, speed: 50, xp: 14,
    attacks: [
      { name: "Dark Bolt", rolls: 3, pct: 53, damage: 7, target: "hero", weight: 3 },
      { name: "Immolate", rolls: 2, pct: 41, damage: 4, target: "hero", perfect: { effect: "burning", turns: 2 }, weight: 1 },
    ],
  },
  brute: {
    kind: "brute", name: "Brute", hp: 18, speed: 35, xp: 18,
    attacks: [
      { name: "Maul", rolls: 2, pct: 49, damage: 11, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Shove", rolls: 3, pct: 53, damage: 6, target: "hero", weight: 1 },
    ],
  },
  archer: {
    kind: "archer", name: "Archer", hp: 9, speed: 70, xp: 13,
    attacks: [
      { name: "Volley", rolls: 3, pct: 53, damage: 6, target: "hero", weight: 3 },
      { name: "Barbed Arrow", rolls: 2, pct: 45, damage: 5, target: "hero", perfect: { effect: "bleeding", turns: 3 }, weight: 2 },
    ],
  },
  // A beast boss: fast, and it makes its victims bleed.
  alpha: {
    kind: "alpha", name: "Pack Leader", hp: 27, speed: 75, xp: 40, boss: true,
    attacks: [
      { name: "Savage Bite", rolls: 3, pct: 57, damage: 9, target: "hero", perfect: { effect: "bleeding", turns: 3 }, weight: 3 },
      { name: "Pounce", rolls: 2, pct: 53, damage: 8, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 2 },
      { name: "Rending Howl", rolls: 4, pct: 45, damage: 5, target: "all_heroes", weight: 1 },
    ],
  },
  // A guardian boss: slow and alone, but each blow lands like a wall.
  guardian: {
    kind: "guardian", name: "Guardian", hp: 35, speed: 30, xp: 44, boss: true,
    attacks: [
      { name: "Stone Fist", rolls: 2, pct: 57, damage: 12, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Quake", rolls: 4, pct: 49, damage: 6, target: "all_heroes", weight: 2 },
    ],
  },
  villain: {
    kind: "villain", name: "Villain", hp: 26, speed: 55, xp: 40, boss: true,
    attacks: [
      { name: "Crushing Strike", rolls: 3, pct: 57, damage: 9, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Sweeping Ruin", rolls: 4, pct: 49, damage: 6, target: "all_heroes", weight: 2 },
    ],
  },
};

// ---------- run-scoped key items ----------

export interface KeyItemDef {
  id: string;
  /** What holding it does, applied once when received. */
  grant: { maxFocus?: number; potions?: number };
}

export const KEY_ITEMS: Record<string, KeyItemDef> = {
  charm: { id: "charm", grant: { maxFocus: 2 } },
};
