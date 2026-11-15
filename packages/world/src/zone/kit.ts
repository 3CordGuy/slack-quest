// What each thing a hero or an enemy can do means on the tiles: what it
// costs (an Action or a Bonus action), how far it reaches, what shape it
// takes and what it leaves on the ground. The abilities themselves, their
// names and their numbers, are still content.ts: this is the layer that
// puts them on a map. A test fails if an ability or an enemy has no entry.

import type { StatKey } from "@gantt-quest/core";
import { ABILITIES, EFFECT_INFO, ENEMIES, type AbilityDef, type EffectKind, type EnemyAttack } from "../content";
import { diceFor, type Dice } from "./rules";
import type { CommonAction, Condition, SurfaceKind, Throwable } from "./types";

/**
 * - `single`: one enemy, an attack roll.
 * - `adjacent`: every enemy next to you, an attack roll each.
 * - `chain`: one enemy, then on to others nearby, an attack roll each.
 * - `blast`: a hex you pick and all around it. Everyone there saves for half, friend and foe.
 * - `burst`: all around yourself. Enemies save for half.
 * - `line`: a straight run of hexes from you. Everyone on it saves for half.
 * - `ally`: one friend (or yourself). No roll.
 * - `self`: yourself.
 */
export type Shape = "single" | "adjacent" | "chain" | "blast" | "burst" | "line" | "ally" | "self";

export interface Tactic {
  cost: "action" | "bonus";
  /** `melee` needs the target next to you. `ranged` and `spell` reach `range` hexes and need a clear line. */
  reach: "melee" | "ranged" | "spell";
  range: number;
  shape: Shape;
  /** Blast and burst: how far out from the middle. */
  radius?: number;
  /** Line: how many hexes. */
  length?: number;
  /** Chain: how many more targets after the first. */
  jumps?: number;
  /** Rounds before it can be used again. */
  cooldown?: number;
  /** Added to the attack roll. */
  toHit?: number;
  /** Left on the hexes it covers (or under a single target). */
  surface?: { kind: SurfaceKind; rounds: number };
  /** Fire: sets light to oil or poison under whatever it hits. */
  ignites?: boolean;
  /** Extra damage against something Wet. */
  vsWet?: number;
}

const melee = (extra: Partial<Tactic> = {}): Tactic => ({ cost: "action", reach: "melee", range: 1, shape: "single", ...extra });
const shot = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: "action", reach: "ranged", range, shape: "single", ...extra });
const spell = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: "action", reach: "spell", range, shape: "single", ...extra });
const guard = (): Tactic => ({ cost: "bonus", reach: "spell", range: 0, shape: "self" });
const mend = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: "action", reach: "spell", range, shape: "ally", ...extra });

export const TACTICS: Record<string, Tactic> = {
  punch: melee(),
  // Paladin
  smite: melee(),
  shield_wall: guard(),
  cleave: melee({ shape: "adjacent", cooldown: 2 }),
  heavy_blow: melee({ toHit: -2 }),
  full_reckoning: melee(),
  // Mage
  firebolt: spell(6, { ignites: true }),
  mend: mend(5),
  chain_spark: spell(5, { shape: "chain", jumps: 2, cooldown: 2, vsWet: 3 }),
  hex_bolt: spell(6),
  thunderhead: spell(6, { shape: "blast", radius: 1, cooldown: 3, vsWet: 3 }),
  // Rogue
  quick_stab: melee(),
  flurry: melee({ cooldown: 1 }),
  aimed_shot: shot(8),
  pin_down: shot(8),
  land_the_catch: melee(),
  // Druid
  thornlash: spell(5),
  rejuvenate: mend(5),
  overgrowth: spell(5, { shape: "blast", radius: 1, cooldown: 2 }),
  riptide: spell(4, { shape: "line", length: 4, cooldown: 2, surface: { kind: "water", rounds: 3 } }),
  // Bard
  dissonance: spell(5),
  encore: mend(5),
  cacophony: spell(0, { shape: "burst", radius: 2, cooldown: 2 }),
  all_hands: mend(5, { cost: "bonus", cooldown: 2 }),
  // Sage
  manifest: spell(6),
  arcane_ward: guard(),
  meteor: spell(6, { shape: "blast", radius: 1, cooldown: 3, ignites: true, surface: { kind: "fire", rounds: 2 } }),
  plot_the_course: spell(7),
  // Warden
  bulwark_strike: melee(),
  taunt: melee({ cost: "bonus" }),
  hold_the_line: guard(),
  shockwave: melee({ shape: "adjacent", cooldown: 2 }),
  lighthouse_beam: spell(5, { shape: "line", length: 5, cooldown: 2 }),
  // Warlock
  hex: spell(6),
  soul_drain: spell(5),
  blight: spell(5, { shape: "blast", radius: 1, cooldown: 2, surface: { kind: "poison", rounds: 3 } }),
  red_tide: spell(5),
};

export const tacticOf = (ability: string): Tactic => TACTICS[ability] ?? TACTICS.punch;

/** An ability's damage dice: a little under its old number, because the hero's stat, weapon and level are added on top. */
export const abilityDice = (def: AbilityDef): Dice => diceFor(Math.max(2, (def.damage ?? 0) - 2));
export const healDice = (def: AbilityDef): Dice => diceFor(Math.max(2, (def.heal ?? 0) - 1));

/** What a hero strikes with when an enemy walks out of reach: their first melee ability, or bare hands. */
export function reactionStrike(abilities: string[]): string {
  return abilities.find((a) => ABILITIES[a]?.damage && tacticOf(a).reach === "melee" && tacticOf(a).shape === "single" && tacticOf(a).cost === "action") ?? "punch";
}

// ---------- conditions ----------

/** The stat that shrugs off each condition. */
export const SAVE_STAT: Record<Condition, StatKey> = {
  bleeding: "vit",
  burning: "agi",
  stunned: "vit",
  guarded: "vit",
  taunting: "vit",
  slowed: "str",
  hasted: "agi",
  glitched: "int_stat",
  exposed: "agi",
  poisoned: "vit",
  prone: "agi",
  wet: "agi",
};

const info = (kind: EffectKind, blurb: string) => ({ name: EFFECT_INFO[kind].name, color: EFFECT_INFO[kind].color, blurb });

/** Every condition as it works on the tiles. Names and colours are the old ones where there was one. */
export const CONDITION_INFO: Record<Condition, { name: string; blurb: string; color: string }> = {
  bleeding: info("bleeding", "Loses 2 HP at the start of each of its turns."),
  burning: info("burning", "Loses 3 HP at the start of each of its turns. Water puts it out."),
  stunned: info("stunned", "Loses its next turn. Attacks against it have advantage."),
  guarded: info("guarded", "Takes half damage until its next turn."),
  taunting: info("taunting", "Enemies that can reach it go for it, until its next turn."),
  slowed: info("slowed", "Half movement."),
  hasted: info("hasted", "Double movement."),
  glitched: info("glitched", "Its next attack is rolled with disadvantage."),
  exposed: info("exposed", "Attacks against it have advantage."),
  poisoned: { name: "Poisoned", blurb: "Its attacks are rolled with disadvantage.", color: "#a3e635" },
  prone: { name: "Prone", blurb: "Flat on the ground: standing costs half its movement. Melee attacks against it have advantage.", color: "#cbd5e1" },
  wet: { name: "Wet", blurb: "Soaked through: lightning hits harder, and it cannot burn.", color: "#7dd3fc" },
};

// ---------- common actions ----------

export const COMMON_ACTIONS: Record<CommonAction, { name: string; cost: "action" | "bonus"; blurb: string }> = {
  dash: { name: "Dash", cost: "action", blurb: "Double your movement this turn." },
  disengage: { name: "Disengage", cost: "action", blurb: "Moving away from enemies draws no opportunity attacks this turn." },
  help: { name: "Help", cost: "action", blurb: "Get a fallen ally beside you back on their feet with 1 HP." },
  shove: { name: "Shove", cost: "bonus", blurb: "Push an enemy beside you one hex away: into fire, off a path, out of reach." },
  jump: { name: "Jump", cost: "bonus", blurb: "Leap a few hexes, over whatever lies between. Costs 2 movement." },
};

/** Light on their feet: a Rogue disengages as a Bonus action. */
export const commonCost = (what: CommonAction, classId: string): "action" | "bonus" => (what === "disengage" && classId === "refactor_rogue" ? "bonus" : COMMON_ACTIONS[what].cost);

export const JUMP_MOVE_COST = 2;
/** What a healing potion heals: all of it when drunk or at the heart of where it lands, half of it on the hexes around. */
export const POTION_DICE: Dice = { n: 2, d: 4, plus: 6 };
export const POTION_EDGE = 0.5;

// ---------- throwables ----------

export interface ThrowableDef {
  name: string;
  blurb: string;
  /** How far from where it lands it reaches. */
  radius: number;
  surface?: { kind: SurfaceKind; rounds: number };
  /** Damage to everyone caught in it; an Agility save halves it. */
  damage?: Dice;
  /** Healing to everyone caught in it: in full on the hex it lands on, and `POTION_EDGE` of that on the hexes around. */
  heal?: Dice;
  /** Can be drunk instead of thrown, as a Bonus action: its healing, in full, for the drinker alone. */
  drink?: boolean;
}

export const THROWABLES: Record<Throwable, ThrowableDef> = {
  healing: { name: "Healing potion", blurb: "Drink it, or throw it: it heals whoever it lands on, and half as much everyone on the six hexes around.", radius: 1, heal: POTION_DICE, drink: true },
  poison: { name: "Poison flask", blurb: "Leaves poison on the ground for 3 rounds.", radius: 1, surface: { kind: "poison", rounds: 3 } },
  fire: { name: "Fire bomb", blurb: "Bursts into flame: damage to everyone near, and fire left burning for 2 rounds.", radius: 1, damage: { n: 2, d: 6, plus: 0 }, surface: { kind: "fire", rounds: 2 } },
  oil: { name: "Oil flask", blurb: "Slick ground that slows whoever crosses it, and goes up at a spark.", radius: 1, surface: { kind: "oil", rounds: 4 } },
  water: { name: "Water skin", blurb: "Douses fire and leaves the ground wet for 3 rounds.", radius: 1, surface: { kind: "water", rounds: 3 } },
};

/** What a hero carries into a zone to throw. */
export const STARTING_ITEMS: Partial<Record<Throwable, number>> = { healing: 2, poison: 2, fire: 1, oil: 1, water: 1 };

/** How far a hero can throw: 5 hexes, further for the strong, never under 3. */
export const throwRange = (strMod: number): number => Math.max(3, 5 + strMod);
/** How far a hero can jump. */
export const jumpRange = (strMod: number): number => Math.max(2, 2 + strMod);

// ---------- enemies ----------

export interface EnemyAttackKit {
  /** Hexes it reaches: 1 for a blow. */
  range?: number;
  /** Left under the target when it lands. */
  surface?: { kind: SurfaceKind; rounds: number };
  /** Knocks the target back a hex when it lands. */
  push?: boolean;
  /** Freezes water under the target. */
  chills?: boolean;
}

export interface EnemyKit {
  /** Keeps its distance and likes high ground. */
  ranged?: boolean;
  /** Ignores the ground: surfaces, rough going, water and cliffs. */
  fly?: boolean;
  /** Advantage on an attack when one of its own is next to the target. */
  pack?: boolean;
  /** Attacks that are not plain blows, by name. */
  attacks?: Record<string, EnemyAttackKit>;
}

export const ENEMY_KIT: Record<string, EnemyKit> = {
  dummy: {},
  bandit: {},
  wolf: { pack: true },
  bear: {},
  cultist: { ranged: true, attacks: { "Dark Bolt": { range: 5 }, Immolate: { range: 5, surface: { kind: "fire", rounds: 2 } } } },
  brute: { attacks: { Shove: { push: true } } },
  archer: { ranged: true, attacks: { Volley: { range: 7 }, "Barbed Arrow": { range: 7 } } },
  alpha: { pack: true },
  great_bear: {},
  guardian: {},
  shade: { attacks: { "Chill Touch": { chills: true } } },
  bat: { fly: true },
  skeleton: {},
  slime: { attacks: { "Acid Splash": { range: 3, surface: { kind: "poison", rounds: 2 } } } },
  haunt: {},
  villain: {},
};

/** How far an attack on every hero reaches out from the enemy making it. */
export const ENEMY_BURST = 2;

export interface EnemyStrike {
  name: string;
  /** 1 for a blow; more needs a clear line. An attack on every hero is a burst around the enemy. */
  range: number;
  burst: boolean;
  dice: Dice;
  bonus: number;
  perfect?: EnemyAttack["perfect"];
  weight: number;
  kit: EnemyAttackKit;
}

/** The threat a zone was made at, for one made before there was such a thing. */
export const DEFAULT_THREAT = 2;
const clampThreat = (threat: number | undefined) => Math.max(1, Math.min(3, Math.round(threat ?? DEFAULT_THREAT)));
/** How much more an enemy can take, by threat: the old fights' numbers were for foes that fell in two blows. */
const THREAT_HP = [1, 1.9, 2.7];

/** An enemy kind's attacks as they work on the tiles, for a party of this level and at this threat. */
export function enemyStrikes(kind: string, level: number, threat?: number): EnemyStrike[] {
  const edge = clampThreat(threat) - 1;
  const def = ENEMIES[kind];
  if (!def) return [];
  const kit = ENEMY_KIT[kind] ?? {};
  return def.attacks.map((a) => {
    const own = kit.attacks?.[a.name] ?? {};
    return {
      name: a.name,
      range: a.target === "all_heroes" ? ENEMY_BURST : (own.range ?? 1),
      burst: a.target === "all_heroes",
      dice: diceFor(a.damage + Math.floor(level / 2) + edge),
      // The old chance of a roll, turned into a bonus: 45% is +3, 57% is +5. Threat sharpens it.
      bonus: Math.round((a.pct - 30) / 6) + Math.floor((Math.max(1, level) - 1) / 4) + edge,
      perfect: a.perfect,
      weight: a.weight,
      kit: own,
    };
  });
}

/** The quick are hard to hit: 10, one more for every 30 of the old speed, one more for a boss. */
export const enemyDefence = (kind: string): number => 10 + Math.floor((ENEMIES[kind]?.speed ?? 0) / 30) + (ENEMIES[kind]?.boss ? 1 : 0);

/** Steps a turn. A training dummy stays put. */
export const enemyMove = (kind: string): number => (kind === "dummy" ? 0 : Math.max(3, Math.min(8, 3 + Math.round((ENEMIES[kind]?.speed ?? 0) / 18))));

/** What an enemy adds to a saving throw: bosses and the big are harder to shake. */
export const enemySave = (kind: string): number => (ENEMIES[kind]?.boss ? 3 : (ENEMIES[kind]?.hp ?? 0) >= 18 ? 2 : 0);

/** Hit points for a party of this level (half again as much by level 4, as in the old fights), scaled by threat. */
export const enemyHp = (kind: string, level: number, threat?: number): number => Math.round((ENEMIES[kind]?.hp ?? 1) * (1 + 0.15 * Math.max(0, level - 1)) * THREAT_HP[clampThreat(threat) - 1]);

/** How many more stand with a group than its leader would bring, by threat. */
export const threatExtras = (threat?: number): number => clampThreat(threat) - 1;
