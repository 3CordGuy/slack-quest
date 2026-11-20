// What each thing a hero or an enemy can do means on the tiles: what it
// costs (in Action Points), how far it reaches, what shape it
// takes and what it leaves on the ground. The abilities themselves, their
// names and their numbers, are still content.ts: this is the layer that
// puts them on a map. A test fails if an ability or an enemy has no entry.

import type { StatKey, Stats } from "@gantt-quest/core";
import { ABILITIES, EFFECT_INFO, ENEMIES, SUNDERED_DEFENCE, type AbilityDef, type EffectKind, type EnemyAttack } from "../content";
import { diceFor, type Dice } from "./rules";
import type { CommonAction, Condition, ShantyKind, SurfaceKind, Throwable, WeatherKind } from "./types";

/**
 * - `single`: one enemy, an attack roll.
 * - `adjacent`: every enemy next to you, an attack roll each.
 * - `cone`: a fan of hexes ahead of you, 1 hex, then 2, then 3, leaning toward the side aimed at. Only the other side is struck: it saves for half.
 * - `arc`: three hexes next to you, around the one swung at (any hex that way will do), an attack roll for each enemy in them.
 * - `chain`: one enemy, then on to others nearby, an attack roll each.
 * - `blast`: a hex you pick and all around it. Everyone there saves for half, friend and foe.
 * - `burst`: all around yourself. Enemies save for half.
 * - `line`: a straight run of hexes from you. Everyone on it saves for half.
 * - `ally`: one friend (or yourself). No roll.
 * - `self`: yourself.
 */
export type Shape = "single" | "adjacent" | "arc" | "cone" | "chain" | "blast" | "burst" | "line" | "ally" | "self";

/**
 * Action Points (AP): every unit gets AP_TURN at the start of its turn, on top of what it saved (AP_MAX at most), and spends
 * them on anything in any order. What was once an Action costs ACTION_AP, a Bonus action BONUS_AP; 1 AP buys a unit's
 * stride of movement (heroMove in rules.ts; enemyMove below, of which an enemy spends ENEMY_MOVE_AP a turn at most).
 */
export const AP_TURN = 4;
/** A summoned creature gets fewer fresh AP each turn than a hero or an enemy. */
export const SUMMON_AP_TURN = 3;
export const AP_MAX = 6;
export const ACTION_AP = 2;
export const BONUS_AP = 1;

export interface Tactic {
  /** Action Points it takes: ACTION_AP for what was an Action, BONUS_AP for what was a Bonus action. */
  cost: number;
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
  /**
   * The user's turns it is not ready for, counted from the one it is used in, each ticking off as that turn ends: 1 is
   * once a turn, 3 is not again until the third turn after. None (0): as often as the AP allow (a weapon's basic attack).
   */
  cooldown?: number;
  /** Added to the attack roll. */
  toHit?: number;
  /** Damage dice set outright, in place of those worked out from the ability's `damage` (abilityDice). The hero's stat, weapon and level still add on top (Pickpocket). */
  dice?: Dice;
  /** Left on the hexes it covers (or under a single target). `self`: also under the user, when it lands (Sea Slash). */
  surface?: { kind: SurfaceKind; rounds: number; self?: boolean };
  /** Fire: sets light to oil or poison under whatever it hits. */
  ignites?: boolean;
  /** Extra damage against something Wet. */
  vsWet?: number;
  /** Self: leaves the user Poisoned for this many of their turns (Drink Deeply). */
  sicken?: number;
  /** Leaves this many stacks of Drowning on an enemy it gets through to that fails its save (Sink, Pull of the Deep). */
  drowns?: number;
  /** Single: shields the user before the blow, hit or miss, on top of any shield they have (Sturdy Blow). */
  ward?: typeof STURDY;
  /** Self: a shield on top of any the user has, bigger for each enemy beside them (Stand Strong). */
  standStrong?: typeof STAND_STRONG;
  /** Single: a hit leaves the target Taunted by the user for this many of its turns, unless it saves (Goading Strike). */
  goad?: number;
  /** Single: a hit also sets the target Burning for this many turns if it is lit by Guiding Light (Focus Light). */
  kindleLit?: number;
  /** With `guide`: the enemy saves against being lit (Starbeam). */
  guideSave?: boolean;
  /** Ally: leaves the ally with North Star for this many of their turns, no strike (St. Elmo's Fire). */
  starlit?: number;
  /** Single: landed, every other enemy beside the target takes a little damage too, no roll, this much before bonuses (Water Burst). */
  spray?: number;
  /** Blast: covers this many hexes in a clump about the one aimed at, in place of a radius (Rust Armor). */
  cluster?: number;
  /** Blast or line: strikes only the other side (Blasting Tone, Rust Armor). */
  foesOnly?: boolean;
  /** Self: Rallies the user and every ally within `range` of them: `damage` more on each one's next attack, for `rounds` of their turns (Hornpipe). */
  rally?: typeof RALLY;
  /** Self: heals the user and every ally within `range` of them, as much as the ability heals (Soothing Tone). */
  soothe?: { range: number };
  /** Ally: every other ally beside the target heals this much too, scaled as a heal is (Clarion Call). */
  ripple?: number;
  /** With `knockback`: the target saves (Strength) against being knocked back (Peal). */
  knockSave?: boolean;
  /** Single: no blow, but the enemy saves or is held for these turns: Slowed, or Stunned if it stands in water (Binding Kelp). */
  bind?: { slowed: number; stunned: number };
  /** Ally: takes every harmful condition off them (Restore). */
  cleanse?: boolean;
  /** Extra damage when the roll to hit had advantage (Stab). */
  edge?: number;
  /** Leaves the target (the user, for a self ability) Inspired, their next roll to hit with advantage, for this many of their turns (Take Aim, Second Wind). */
  steady?: number;
  /** Single: landed, drags the target this many hexes straight toward the user, as far as the way is open (Throw Pike). */
  pull?: number;
  /** Adds this much to each AP of the user's movement for the rest of their turn (Slicing Wind). */
  stride?: number;
  /** Adds this much to each AP of the ally's movement: for the rest of their turn if it is theirs, else their next (Wind's Blessing). */
  tailwind?: number;
  /** Extra damage while the user stands in water (the sea turtle's Bite). */
  wading?: number;
  /** Puts this condition on the user for `rounds` of their own turns: an aura, worked by the condition itself (see AURAS). */
  aura?: { kind: Condition; rounds: number };
  /**
   * Shields the user, and every ally within `range` of them, with `shield` points plus the user's level, for `rounds` of each one's
   * turns (Bolstered), and `water` more for each one standing in water.
   */
  shield?: { range: number; shield: number; rounds: number; water?: number };
  /** Leaves this weather over the hexes it covers (weather.ts), instead of striking them. */
  weather?: WeatherKind;
  /** Single: lands without an attack roll. */
  sure?: boolean;
  /** Single: pushes the target this many hexes away from the user. Burst: pushes whoever fails to brace (Bellows Blast). */
  knockback?: number;
  /** Line: strikes only the other side; whoever fails to save is swept to the far end of the line. */
  sweep?: boolean;
  /** Takes every harmful condition off the ally, and the ground that hurts or hinders (surfaces.ts HINDERING) off the way you would walk to them. */
  clearWay?: boolean;
  /**
   * Moves the user to a hex they pick (`at`) up to `range` hexes off, over anything between and drawing no blows:
   * a self ability goes there, and with `carry` takes an ally beside the user (`target`) along to a hex beside it;
   * a blow lands first, and the move after it is the user's choice (no `at`, no move).
   */
  blink?: { range: number; carry?: boolean };
  /** Pickpocket: gold equal to the user's level from an enemy whose pockets are not picked yet. Used Unseen it is no blow, just the gold, and does not give the user away. */
  steal?: boolean;
  /** Makes the user and every ally within `range` of them Unseen for `rounds` of each one's turns. */
  hide?: { range: number; rounds: number };
  /** Slips the user and the ally a fire bomb each (the user two, used on themselves), good for `rounds` of each one's turns (Contraband). */
  smuggle?: { rounds: number };
  /** Ally: heals again at the start of the ally's next turns, this many of them: the same dice and the same bonus as the heal now (Rejuvenate). */
  echo?: number;
  /** Heals at once, then again at the start of each of the ally's turns for some rounds, more for one standing in water (Aqueous Regeneration). */
  regen?: typeof AQUEOUS;
  /** Raises the ally's Defence, and cuts whoever lands a blow on them up close, for some rounds of their turns (Coral Armor). */
  armor?: typeof CORAL_ARMOR;
  /** Heals the caster's side on a cluster of `hexes` hexes about the one aimed at, and leaves water there (Revitalizing Splash). No harm to anyone. */
  splash?: typeof SPLASH;
  /** Calls creatures onto an open hex in range (`at`) and beside it (summon.ts), and sends away those this hero called before, if they are still there. */
  summon?: SummonCall;
  /** Strikes up a shanty around the Bard (song.ts), in place of the one they were singing. */
  shanty?: ShantyKind;
  /** Blast: strikes only the other side, and hits this much harder for each of the user's allies standing in it (Chorus). */
  chorus?: number;
  /** Single: landed, it leaves the user's ally nearest the target Inspired, with advantage on their next roll to hit (Lead by Example). */
  inspire?: boolean;
  /** Leaves Guiding Light on each enemy it gets through to, for this many of its turns: whoever attacks it has advantage. */
  guide?: number;
  /** Links the user to their allies, one to the next (stars.ts), and strikes the enemies the links cross (Constellation). */
  constellation?: typeof CONSTELLATION;
  /** Takes Guiding Light off every enemy that has it, and strikes each of them, no roll (New Moon). */
  newMoon?: boolean;
  /** Marks a hex (`at`) the user's side moves faster toward, in place of the user's last mark (Chart a Course). */
  chart?: typeof CHART;
  /** Ally: strikes every enemy beside them, no roll, lighting them with Guiding Light, and leaves the ally's blows setting fires (North Star). */
  northStar?: typeof NORTH_STAR;
  /** Single: no blow, but a contest of Strength: won, the enemy is driven back some hexes, and Stunned if it is driven into a wall (Overwhelm). */
  overwhelm?: typeof OVERWHELM;
  /** Blast: raises a short wall on the hex aimed at (weather.ts), the user's side seeing over it and steadier beside it (Fortify). */
  fortify?: typeof FORTIFY;
  /** Single: shields the user first, a little, then the blow lands harder for every point of shield they have (Bulwark Strike). */
  bulwark?: typeof BULWARK;
  /** Taunts every enemy within `range` of the user for `rounds` of its turns: it must go for the user if it can (Taunt). */
  taunt?: typeof TAUNT;
  /** Single: lays the Curse of Drowning on the enemy (drowning.ts): a stack of Drowning each time it starts or ends a turn in water. */
  curse?: typeof DROWNING_CURSE;
  /** Single: lays the Black Spot on the enemy (drowning.ts): its attacks are worse, it drowns a little more each turn, and it is passed on when it falls. */
  blackSpot?: typeof BLACK_SPOT;
  /** Blast: no blow, but every enemy in it attacks with disadvantage for some of its turns (Red Sky at Morning). */
  redSky?: typeof RED_SKY;
  /** Blast: water over the hexes it covers, and fire under every enemy standing in it (Unholy Waters). */
  unholy?: typeof UNHOLY_WATERS;
}

const melee = (extra: Partial<Tactic> = {}): Tactic => ({ cost: 2, reach: "melee", range: 1, shape: "single", ...extra });
const shot = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: 2, reach: "ranged", range, shape: "single", ...extra });
const spell = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: 2, reach: "spell", range, shape: "single", ...extra });
const guard = (): Tactic => ({ cost: 1, reach: "spell", range: 0, shape: "self" });
const mend = (range: number, extra: Partial<Tactic> = {}): Tactic => ({ cost: 2, reach: "spell", range, shape: "ally", ...extra });

/** Bolster: a shield of `shield` points plus the Paladin's level on them and every ally within `range`, for `rounds` of each one's turns. */
export const BOLSTER = { range: 2, shield: 10, rounds: 3 };

/**
 * The Warden's. Endure: a shield of `shield` plus the Warden's level on themselves (and they are Guarded: content.ts).
 * Overwhelm drives an enemy `hexes` back, and Stuns it `stun` of its turns if it is driven into a wall. Fortify raises a wall of
 * `hexes` hexes for `rounds` rounds; the user's side gets `defence` more Defence beside it. Bulwark Strike shields the Warden
 * `shield` plus their level first, then adds `perShield` of their shield to the damage. Taunt reaches `range` hexes, for `rounds`.
 */
export const ENDURE = { range: 0, shield: 10, rounds: 2 };
export const OVERWHELM = { hexes: 2, stun: 1 };
export const FORTIFY = { hexes: 3, rounds: 3, defence: 1 };
export const BULWARK = { shield: 4, rounds: 2, perShield: 0.5 };
export const TAUNT = { range: 2, rounds: 2 };
/** Sturdy Blow (the maul): a shield of `shield` plus the user's level, on top of any they have, hit or miss. */
export const STURDY = { shield: 3, rounds: 1 };
/** Stand Strong (the maul): a shield of `shield` plus the user's level and `perFoe` for each enemy beside them, on top of any they have. */
export const STAND_STRONG = { shield: 3, perFoe: 3, rounds: 1 };
/** Against the Waves (the axe): a shield of `shield` plus the user's level, `water` more standing in water. */
export const AGAINST_WAVES = { range: 0, shield: 4, rounds: 1, water: 4 };

/**
 * Weather (weather.ts), by kind: how many rounds of a fight it hangs on after the one it is made in. Rain heals
 * `heal` (once a turn) and keeps `water` rounds of water under itself; the winds Haste the caster's side and Slow the other.
 */
export const WEATHER = {
  rain: { rounds: 3, heal: { n: 1, d: 4, plus: 2 } satisfies Dice, water: 2 },
  wind: { rounds: 3 },
  // Coral Field: cuts and Slows the other side, once a turn, as one starts a turn in it or walks into it on its turn.
  coral: { rounds: 4, damage: { n: 1, d: 6, plus: 1 } satisfies Dice },
  // Fortify: a wall, standing where it was raised.
  wall: { rounds: FORTIFY.rounds },
};

/** Aqueous Regeneration: the heal again at the start of each of the ally's turns for `rounds`, and `water` more on each heal for one standing in water. */
export const AQUEOUS = { rounds: 3, tick: { n: 1, d: 4, plus: 2 } satisfies Dice, water: 2 };
/** Coral Armor: `defence` more, for `rounds` of the wearer's turns; whoever lands a blow on them up close takes `thorns`. */
export const CORAL_ARMOR = { defence: 2, rounds: 3, thorns: { n: 1, d: 4, plus: 1 } satisfies Dice };
/**
 * The Bard's shanties (song.ts): sung for `rounds` of the Bard's turns, reaching `radius` hexes and a hex more for each
 * ally who joins. Lively: `hit` to hit and `damage(the Bard's level)` more damage. Dour: `defence`. Wind-god's: `move`
 * more movement and no Slowing. Each joining adds `surge` (Lively) or `perJoin` more of it, until the Bard's next turn.
 */
export const SHANTY = {
  rounds: 4,
  radius: 2,
  lively: { hit: 2, damage: (level: number) => 1 + Math.floor(level / 4), surge: 1 },
  dour: { defence: 2, perJoin: 1 },
  windgod: { move: 1, perJoin: 1 },
};

/** Chorus: extra damage for each of the Bard's allies standing in it. */
export const CHORUS_PER_ALLY = 3;
/** Hornpipe: who it reaches round the Bard, how long a Rally waits to be used, and what it adds to the blow that uses it. */
export const RALLY = { range: 2, rounds: 1, damage: 2 };

/** Revitalizing Splash: how many hexes it covers, and the rounds of water it leaves on them. */
export const SPLASH = { hexes: 4, water: 3 };

/** A creature a hero can call into a fight (summon.ts): played by the hero's player, on the hero's initiative. Defence is 10, its Agility, and half its armor, as a hero's. */
export interface SummonDef {
  name: string;
  hp: (level: number) => number;
  move: number;
  armor: number;
  stats: Stats;
  abilities: string[];
}

/**
 * The Druid's sea turtle: slow, hard to hurt and hard to get through, with a fair bite that is worse from the water.
 * It lasts until it falls, another is called, or the fight is over.
 */
export const SEA_TURTLE: SummonDef = {
  name: "Sea Turtle",
  hp: (level: number) => 34 + 4 * level,
  move: 1,
  armor: 12,
  stats: { str: 7, int_stat: 3, vit: 10, agi: 5, dex: 3 },
  abilities: ["turtle_bite"],
};

/**
 * The Warlock's sunken sailors, called up two at a time: a gunner with a pistol that reaches 4 hexes and hits the harder
 * of the two, and a cutlass who stands up to more. Between them about as much to get through as a sea turtle.
 */
export const DROWNED_GUNNER: SummonDef = {
  name: "Drowned Gunner",
  hp: (level: number) => 14 + 3 * level,
  move: 2,
  armor: 4,
  stats: { str: 4, int_stat: 3, vit: 5, agi: 6, dex: 9 },
  abilities: ["sailor_pistol"],
};
export const DROWNED_CUTLASS: SummonDef = {
  name: "Drowned Cutlass",
  hp: (level: number) => 22 + 4 * level,
  move: 2,
  armor: 8,
  stats: { str: 8, int_stat: 3, vit: 8, agi: 5, dex: 4 },
  abilities: ["sailor_scimitar"],
};

/** Every creature that can be called, by its kind (the unit's `kind`). */
export const SUMMONS: Record<string, SummonDef> = { sea_turtle: SEA_TURTLE, drowned_cutlass: DROWNED_CUTLASS, drowned_gunner: DROWNED_GUNNER };

/** What a summoning ability calls: the creatures' kinds, the first on the hex aimed at and the rest beside it. */
export type SummonCall = "sea_turtle" | "sunken_sailors";
export const SUMMON_CALLS: Record<SummonCall, string[]> = { sea_turtle: ["sea_turtle"], sunken_sailors: ["drowned_cutlass", "drowned_gunner"] };

/** How far Smuggler's Route takes the Rogue (and whoever comes along), and how far Tactical Retreat does. */
export const ROUTE_RANGE = 3;
export const RETREAT_RANGE = 4;
/** Sneak: everyone beside the Rogue goes Unseen with them, for this many of their turns. */
export const SNEAK = { range: 1, rounds: 3 };
/** Contraband: a fire bomb slipped into a pack is good for this many of its holder's turns. */
export const CONTRABAND = { rounds: 3 };
/** The item Contraband slips into a pack. */
export const SMUGGLED: Throwable = "fire";

/**
 * The Sage's stars (stars.ts). Guiding Light lasts `rounds` of the enemy's turns. Constellation links an ally at most
 * `link` hexes from the last one linked, in clear sight. Chart a Course gives `speed` movement for each AP of movement toward a mark up to
 * `range` hexes off, for `rounds` of the Sage's turns. North Star lasts `rounds` of the ally's turns, and each blow of theirs
 * leaves `burn` rounds of Burning.
 */
export const GUIDING_LIGHT = { rounds: 3 };
export const CONSTELLATION = { link: 4 };
export const CHART = { range: 8, speed: 1, rounds: 4 };
export const NORTH_STAR = { rounds: 3, burn: 2 };

/**
 * The Warlock's (drowning.ts). Drowning is stacks on an enemy, for `rounds` of its turns, each stack laid on starting the count
 * again for all of them. At the start of each of its turns it takes `tick` for every stack, then saves (Vitality) against `dc` and
 * `perStack` more for every stack, or loses ACTION_AP of its AP. Curse of Drowning lasts `rounds` of the enemy's turns. The Black Spot lasts
 * `rounds`. Red Sky at Morning lasts `rounds`. Unholy Waters leaves `water` rounds of water and `fire` rounds of fire.
 */
export const DROWNING = { rounds: 3, tick: 2, dc: 2, perStack: 2 };
export const DROWNING_CURSE = { rounds: 3 };
export const BLACK_SPOT = { rounds: 4 };
export const RED_SKY = { rounds: 3 };
export const UNHOLY_WATERS = { water: 3, fire: 2 };

/** Block (the greatsword): a shield of `shield` points plus the user's level on themselves, through their next turn. */
export const BLOCK = { range: 0, shield: 8, rounds: 1 };

export const TACTICS: Record<string, Tactic> = {
  punch: melee(),
  torch_swing: melee(),
  // Paladin
  bash: melee(),
  recover: { ...guard(), cooldown: 1 },
  block: { ...guard(), shield: BLOCK, cooldown: 1 },
  flail_strike: melee(),
  armor_crush: melee({ cost: 1, cooldown: 1 }),
  cleave: melee({ shape: "arc" }),
  // Paladin class abilities
  beacon_aura: { cost: 1, reach: "spell", range: 0, shape: "self", aura: { kind: "beacon", rounds: 4 }, cooldown: 1 },
  healing_aura: { cost: 1, reach: "spell", range: 0, shape: "self", aura: { kind: "mending", rounds: 4 }, cooldown: 1 },
  branding_strike: melee({ cooldown: 3 }),
  stoke_the_fire: melee({ shape: "adjacent", cooldown: 3 }),
  bolster: { cost: 2, reach: "spell", range: 0, shape: "self", cooldown: 4, shield: BOLSTER },
  show_the_way: mend(5, { cost: 1, cooldown: 3, clearWay: true }),
  // Mage
  shock: spell(6, { vsWet: 3 }),
  mend: mend(5, { cooldown: 1 }),
  stab: melee({ edge: 3 }),
  eviscerate: melee({ cooldown: 3 }),
  bow_shot: shot(7),
  take_aim: { ...guard(), steady: 1, cooldown: 1 },
  tear: melee(),
  snag: shot(3, { cooldown: 1 }),
  // Ship's guns
  pistol_shot: shot(5),
  pistol_whip: melee({ cost: 1, cooldown: 1 }),
  scattershot: shot(3, { shape: "cone", length: 3, cooldown: 2 }),
  butt_stroke: melee({ cooldown: 1 }),
  harpoon_shot: shot(6, { pull: 2, cooldown: 3 }),
  barbed_line: shot(3, { cooldown: 1 }),
  slicing_wind: spell(6, { stride: 1 }),
  winds_blessing: mend(5, { cost: 1, tailwind: 1, cooldown: 1 }),
  waterbolt: spell(6, { surface: { kind: "water", rounds: 3 } }),
  lightning_strike: spell(5, { vsWet: 3, cooldown: 2 }),
  // Mage class abilities
  soothing_rain: spell(5, { shape: "blast", radius: 1, cooldown: 4, weather: "rain" }),
  chain_lightning: spell(5, { shape: "chain", jumps: Infinity, cooldown: 3, vsWet: 3 }),
  roar_of_thunder: spell(5, { cooldown: 2, sure: true, knockback: 1 }),
  trade_winds: spell(5, { shape: "blast", radius: 2, cooldown: 4, weather: "wind" }),
  tidal_wave: spell(5, { shape: "line", length: 5, cooldown: 3, sweep: true, surface: { kind: "water", rounds: 2 } }),
  // Rogue
  // Rogue class abilities
  smugglers_route: { cost: 1, reach: "spell", range: ROUTE_RANGE, shape: "self", cooldown: 4, blink: { range: ROUTE_RANGE, carry: true } },
  sneak: { cost: 2, reach: "spell", range: 0, shape: "self", cooldown: 5, hide: SNEAK },
  pickpocket: melee({ cost: 1, steal: true, cooldown: 1, dice: { n: 1, d: 6, plus: 0 } }),
  tactical_retreat: melee({ cooldown: 3, blink: { range: RETREAT_RANGE }, dice: { n: 2, d: 6, plus: 0 } }),
  contraband: mend(5, { cost: 1, cooldown: 4, smuggle: CONTRABAND }),
  // Druid
  thornlash: spell(5),
  rejuvenate: mend(5, { cooldown: 1, echo: 1 }),
  sea_slash: melee({ surface: { kind: "water", rounds: 3, self: true } }),
  binding_kelp: spell(4, { cost: 1, bind: { slowed: 1, stunned: 1 }, cooldown: 1 }),
  coral_burst: spell(3, { shape: "cone", length: 3 }),
  restore: mend(5, { cost: 1, cooldown: 2, cleanse: true }),
  // Druid class abilities
  coral_field: spell(5, { shape: "blast", radius: 1, cooldown: 4, weather: "coral" }),
  aqueous_regeneration: mend(5, { cost: 1, cooldown: 4, regen: AQUEOUS }),
  coral_armor: mend(3, { cost: 1, cooldown: 4, armor: CORAL_ARMOR }),
  revitalizing_splash: spell(5, { shape: "blast", cooldown: 3, splash: SPLASH }),
  summon_sea_turtle: { cost: 3, reach: "spell", range: 3, shape: "self", cooldown: 5, summon: "sea_turtle" },
  // The sea turtle's own
  turtle_bite: melee({ wading: 4 }),
  // Bard
  dissonance: spell(5),
  encore: mend(5, { cost: 1, steady: 2, cooldown: 1 }),
  blasting_tone: spell(4, { shape: "line", length: 4, foesOnly: true }),
  soothing_tone: { cost: 2, reach: "spell", range: 0, shape: "self", cooldown: 2, soothe: { range: 2 } },
  peal: spell(4, { knockback: 1, knockSave: true }),
  clarion_call: mend(5, { cooldown: 2, ripple: 6 }),
  bellows_blast: spell(0, { shape: "burst", radius: 1, cooldown: 2, knockback: 1 }),
  hornpipe: { cost: 2, reach: "spell", range: 0, shape: "self", cooldown: 2, rally: RALLY },
  // Bard class abilities
  lively_shanty: { ...guard(), cooldown: 5, shanty: "lively_shanty" },
  dour_shanty: { ...guard(), cooldown: 5, shanty: "dour_shanty" },
  windgod_shanty: { ...guard(), cooldown: 5, shanty: "windgod_shanty" },
  chorus: spell(5, { shape: "blast", radius: 1, cooldown: 4, chorus: CHORUS_PER_ALLY }),
  lead_by_example: spell(5, { cooldown: 3, inspire: true }),
  // Sage
  moonlight: spell(7, { shape: "blast", cluster: 3, foesOnly: true, guide: GUIDING_LIGHT.rounds, dice: { n: 1, d: 4, plus: 2 } }),
  focus_light: spell(5, { cost: 1, kindleLit: 3, cooldown: 1, dice: { n: 1, d: 4, plus: 2 } }),
  starbeam: spell(6, { guide: GUIDING_LIGHT.rounds, guideSave: true, dice: { n: 1, d: 6, plus: 3 } }),
  st_elmos_fire: mend(4, { cost: 1, cooldown: 3, starlit: NORTH_STAR.rounds }),
  water_burst: spell(5, { spray: 4 }),
  rust_armor: spell(5, { shape: "blast", cluster: 3, cooldown: 2, foesOnly: true }),
  // Sage class abilities
  falling_star: spell(7, { cooldown: 4, ignites: true, guide: GUIDING_LIGHT.rounds }),
  constellation: { cost: 1, reach: "spell", range: 0, shape: "self", cooldown: 3, guide: GUIDING_LIGHT.rounds, constellation: CONSTELLATION },
  new_moon: { cost: 2, reach: "spell", range: 0, shape: "self", cooldown: 5, newMoon: true },
  chart_a_course: { cost: 1, reach: "spell", range: CHART.range, shape: "blast", radius: 0, cooldown: 3, chart: CHART },
  north_star: mend(6, { cooldown: 4, guide: GUIDING_LIGHT.rounds, northStar: NORTH_STAR }),
  // Warden
  // Warden class abilities
  sturdy_blow: melee({ ward: STURDY }),
  stand_strong: { ...guard(), standStrong: STAND_STRONG, cooldown: 1 },
  disarming_chop: melee(),
  raise_guard: { ...guard(), cooldown: 2, shield: AGAINST_WAVES },
  goading_strike: melee({ goad: TAUNT.rounds }),
  throw_pike: shot(3, { pull: 2, cooldown: 3 }),
  against_the_waves: { ...guard(), cooldown: 3, shield: ENDURE },
  overwhelm: melee({ cost: 1, cooldown: 3, overwhelm: OVERWHELM }),
  fortify: spell(5, { shape: "blast", radius: 0, cooldown: 4, weather: "wall", fortify: FORTIFY }),
  bulwark_strike: melee({ cooldown: 3, bulwark: BULWARK }),
  taunt: { ...guard(), cost: 2, cooldown: 4, taunt: TAUNT },
  // Warlock
  hex: spell(6),
  soul_drain: spell(5, { cooldown: 3 }),
  sink: spell(6, { drowns: 1 }),
  vile_splash: spell(5, { surface: { kind: "poison", rounds: 3 } }),
  drink_deeply: { ...guard(), cooldown: 3, sicken: 2 },
  pull_of_the_deep: spell(0, { shape: "burst", radius: 1, cooldown: 3, drowns: 1 }),
  // Warlock class abilities
  curse_of_drowning: spell(5, { cost: 1, cooldown: 4, sure: true, curse: DROWNING_CURSE }),
  summon_sunken_sailors: { cost: 3, reach: "spell", range: 3, shape: "self", cooldown: 5, summon: "sunken_sailors" },
  red_sky_at_morning: spell(5, { shape: "blast", radius: 2, cooldown: 6, redSky: RED_SKY }),
  unholy_waters: spell(5, { cost: 1, shape: "blast", radius: 1, cooldown: 3, unholy: UNHOLY_WATERS }),
  the_black_spot: spell(5, { cooldown: 5, sure: true, blackSpot: BLACK_SPOT }),
  // The sunken sailors' own
  sailor_pistol: shot(4),
  sailor_scimitar: melee(),
};

export const tacticOf = (ability: string): Tactic => TACTICS[ability] ?? TACTICS.punch;

/** An ability's damage dice: a little under its old number, because the hero's stat, weapon and level are added on top. Or what its tactic sets outright. */
export const abilityDice = (def: AbilityDef): Dice => TACTICS[def.id]?.dice ?? diceFor(Math.max(2, (def.damage ?? 0) - 2));
export const healDice = (def: AbilityDef): Dice => diceFor(Math.max(2, (def.heal ?? 0) - 1));

/** What a hero strikes with when an enemy walks out of reach: their first melee ability, or bare hands. */
export function reactionStrike(abilities: string[]): string {
  return abilities.find((a) => ABILITIES[a]?.damage && tacticOf(a).reach === "melee" && (tacticOf(a).shape === "single" || tacticOf(a).shape === "arc") && tacticOf(a).cost === ACTION_AP) ?? "punch";
}

// ---------- conditions ----------

/**
 * What the aura conditions reach and do. Beacon: the bearer gives light, and the bearer and every ally within
 * `range` get `beaconHit` on their rolls to hit. Mending: at the start of each of the bearer's turns, the bearer and every ally
 * standing within `range` heal `heal` (the fallen are not got up).
 */
export const AURAS = {
  range: 2,
  beaconLight: 2,
  beaconHit: 2,
  heal: { n: 1, d: 4, plus: 1 } satisfies Dice,
};


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
  sundered: "str",
  poisoned: "vit",
  prone: "agi",
  wet: "agi",
  beacon: "vit",
  mending: "vit",
  bolstered: "vit",
  invisible: "agi",
  contraband: "agi",
  regenerating: "vit",
  rejuvenating: "vit",
  rallied: "int_stat",
  coral_armor: "vit",
  lively_shanty: "int_stat",
  dour_shanty: "int_stat",
  windgod_shanty: "int_stat",
  inspired: "int_stat",
  guiding_light: "int_stat",
  north_star: "int_stat",
  charted: "int_stat",
  taunted: "int_stat",
  drowning: "vit",
  drowning_curse: "vit",
  black_spot: "int_stat",
  red_sky: "int_stat",
  tailwind: "agi",
};

const info = (kind: EffectKind, blurb: string) => ({ name: EFFECT_INFO[kind].name, color: EFFECT_INFO[kind].color, blurb });

/** Every condition as it works on the tiles. Names and colours are the old ones where there was one. */
export const CONDITION_INFO: Record<Condition, { name: string; blurb: string; color: string }> = {
  bleeding: info("bleeding", "Loses 2 HP at the start of each of its turns."),
  burning: info("burning", "Loses 3 HP at the start of each of its turns, 3 more for each stack past the first. Water puts it out."),
  stunned: info("stunned", "Loses its next turn. Attacks against it have advantage."),
  guarded: info("guarded", "Takes half damage until its next turn."),
  taunting: info("taunting", "Enemies that can reach it go for it, until its next turn."),
  slowed: info("slowed", "Half movement for each AP."),
  hasted: info("hasted", "Double movement for each AP."),
  glitched: info("glitched", "Its next attack is rolled with disadvantage."),
  exposed: info("exposed", "Attacks against it have advantage."),
  poisoned: { name: "Poisoned", blurb: "Its attacks are rolled with disadvantage.", color: "#a3e635" },
  prone: info("prone", "Flat on the ground: standing up costs 1 AP. Melee attacks against it have advantage, ranged attacks disadvantage."),
  sundered: info("sundered", `Its armor is dented: ${SUNDERED_DEFENCE} less Defence.`),
  wet: { name: "Wet", blurb: "Soaked through: lightning hits harder, and it cannot burn.", color: "#7dd3fc" },
  beacon: { name: "Beacon", blurb: `Gives light, and it and allies within 2 hexes get +${AURAS.beaconHit} to hit.`, color: "#fff7d6" },
  mending: { name: "Healing Aura", blurb: "At the start of each of its turns, it and every ally within 2 hexes heal a little.", color: "#5dffa0" },
  bolstered: { name: "Bolstered", blurb: "A shield takes the damage of blows before its HP does, until it is spent or wears off.", color: "#9ec9ff" },
  invisible: { name: "Unseen", blurb: "Enemies cannot see it to attack it. Its next roll to hit has advantage, and using any ability (or throwing, or shoving) gives it away.", color: "#b8c4d6" },
  contraband: { name: "Contraband", blurb: "Smuggled fire bombs in the pack, to throw before they are found out.", color: "#ff8a3a" },
  regenerating: { name: "Regenerating", blurb: "Heals at the start of each of its turns, more when it stands in water.", color: "#5eead4" },
  rejuvenating: { name: "Rejuvenating", blurb: "Heals again at the start of its next turn.", color: "#8be38f" },
  rallied: { name: "Rallied", blurb: `+${RALLY.damage} damage on its next attack.`, color: "#facc15" },
  coral_armor: { name: "Coral Armor", blurb: `+${CORAL_ARMOR.defence} Defence, and whoever lands a blow on it up close is cut.`, color: "#ff8f7a" },
  lively_shanty: { name: "Lively Shanty", blurb: `Singing: allies within reach get +${SHANTY.lively.hit} to hit and a little more damage. Each who joins widens it a hex and adds +${SHANTY.lively.surge} to hit until the Bard's next turn.`, color: "#ffb020" },
  dour_shanty: { name: "Dour Shanty", blurb: `Singing: allies within reach get +${SHANTY.dour.defence} Defence. Each who joins widens it a hex and adds +${SHANTY.dour.perJoin} Defence until the Bard's next turn.`, color: "#6f8fff" },
  windgod_shanty: { name: "Wind-god's Shanty", blurb: `Singing: allies within reach move ${SHANTY.windgod.move} further for each AP of movement and cannot be Slowed. Each who joins widens it a hex and adds ${SHANTY.windgod.perJoin} more for each AP until the Bard's next turn.`, color: "#3fe0c5" },
  inspired: { name: "Inspired", blurb: "Its next roll to hit has advantage.", color: "#ffe08a" },
  guiding_light: { name: "Guiding Light", blurb: "Lit up by a star: every attack against it has advantage.", color: "#fff3a8" },
  north_star: { name: "North Star", blurb: "Every blow it lands sets the target Burning, one stack more if the blow would have set it Burning anyway.", color: "#ffd166" },
  taunted: { name: "Taunted", blurb: "Goaded: it must go for the one who taunted it, if it can reach them.", color: "#ff5a3c" },
  charted: { name: "Course Charted", blurb: `A mark on the map: it and its allies move ${CHART.speed} further each turn, on steps that bring them nearer the mark.`, color: "#ff4d4d" },
  drowning: { name: "Drowning", blurb: `Loses ${DROWNING.tick} HP a stack at the start of each of its turns, then must hold its breath (harder for every stack) or lose ${ACTION_AP} AP. A new stack keeps them all going ${DROWNING.rounds} more turns.`, color: "#2fa4c9" },
  drowning_curse: { name: "Curse of Drowning", blurb: "Takes a stack of Drowning each time it starts or ends a turn standing in water.", color: "#1f7fa0" },
  black_spot: { name: "The Black Spot", blurb: "Its attacks are rolled with disadvantage, and it takes a stack of Drowning at the end of each of its turns. If it falls with the Spot still on it, the Spot passes to the nearest of its side.", color: "#7a6a8f" },
  tailwind: { name: "Tailwind", blurb: "The wind at its back: more movement for each AP on its next turn.", color: "#bfe8ff" },
  red_sky: { name: "Red Sky at Morning", blurb: "A bad omen: its attacks are rolled with disadvantage.", color: "#e2483d" },
};

// ---------- common actions ----------

export const COMMON_ACTIONS: Record<CommonAction, { name: string; cost: number; blurb: string }> = {
  disengage: { name: "Disengage", cost: 2, blurb: "Moving away from enemies draws no opportunity attacks this turn." },
  help: { name: "Help", cost: 2, blurb: "Get a fallen ally beside you back on their feet with 1 HP." },
  shove: { name: "Shove", cost: 1, blurb: "Push an enemy beside you one hex away: into fire, out of reach, off a height (they fall: a d4 for each level past the first, and land flat), or into deep water, lava or off the edge of the land, where they are lost. Toward a drop or a pit they roll to catch the edge." },
  jump: { name: "Jump", cost: 2, blurb: "Leap a few hexes, over whatever lies between: up a ledge two levels high, or down one. Further down than two levels is a fall." },
  join: { name: "Join the Song", cost: 1, blurb: "Join an ally's shanty you are standing in, once a shanty: it reaches a hex further, and you get its joining lift (Lively: advantage on your next attack; Dour: Guarded; Wind-god's: Disengaged), and everyone in it gets a little more of what it gives until the Bard's next turn." },
  flee: { name: "Flee", cost: 2, blurb: "Get out of the fight, once no enemy in it is within 2 hexes of you. You walk free and it goes on without you; an enemy coming that close again brings you back into it." },
};

/** How far clear of every enemy in a fight a hero must be to flee it, and how near one must come to draw them back in. */
export const FLEE_RANGE = 2;

/** Light on their feet: a Rogue disengages, and flees, for BONUS_AP. */
export const commonCost = (what: CommonAction, classId: string): number => ((what === "disengage" || what === "flee") && classId === "refactor_rogue" ? BONUS_AP : COMMON_ACTIONS[what].cost);

/** AP each of these takes in a fight (out of one they are free). */
export const ITEM_AP = { drink: BONUS_AP, throw: ACTION_AP, light: BONUS_AP, stow: BONUS_AP, pickup: BONUS_AP, open: ACTION_AP, forage: ACTION_AP, unlock: ACTION_AP, attack: ACTION_AP };
/** How many levels a jump can go up, and how many it can come down before it is a fall (a d4 a level past that, and landing flat). */
export const JUMP_UP = 2;
export const JUMP_DOWN = 2;
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
  /** Can be drunk instead of thrown, for 1 AP: its healing, in full, for the drinker alone. */
  drink?: boolean;
  /** Left on everyone caught in it who fails the Agility save. */
  condition?: { kind: Condition; rounds: number };
  /** A torch: lit and held in the off hand instead of drunk, and thrown it lies burning where it lands (light.ts). */
  light?: boolean;
}

export const THROWABLES: Record<Throwable, ThrowableDef> = {
  healing: { name: "Healing potion", blurb: "Drink it, or throw it: it heals whoever it lands on, and half as much everyone on the six hexes around.", radius: 1, heal: POTION_DICE, drink: true },
  poison: { name: "Poison flask", blurb: "Brewed with cave slime: leaves poison on the ground for 4 rounds.", radius: 1, surface: { kind: "poison", rounds: 4 } },
  fire: { name: "Fire bomb", blurb: "Bursts into flame: damage to everyone near, and fire left burning for 2 rounds.", radius: 1, damage: { n: 2, d: 6, plus: 0 }, surface: { kind: "fire", rounds: 2 } },
  oil: { name: "Oil flask", blurb: "Slick ground that slows whoever crosses it, and goes up at a spark.", radius: 1, surface: { kind: "oil", rounds: 4 } },
  water: { name: "Water skin", blurb: "Douses fire and leaves the ground wet for 3 rounds.", radius: 1, surface: { kind: "water", rounds: 3 } },
  acid: { name: "Acid flask", blurb: "Splashes slime acid: a little damage to everyone near, and leaves them Exposed for 2 rounds unless they dodge it.", radius: 1, damage: { n: 1, d: 6, plus: 0 }, condition: { kind: "exposed", rounds: 2 } },
  slime: { name: "Slime flask", blurb: "Leaves a sticky slick for 3 rounds: it costs a step more to cross and slows whoever walks into it.", radius: 1, surface: { kind: "slime", rounds: 3 } },
  torch: { name: "Torch", blurb: "Light it to hold in your off hand (1 AP) and see in the dark, with your shield set aside. Thrown, it lies burning where it lands, and sets oil alight.", radius: 0, light: true },
};

/** How far a torch lights, held or lying burning, and how far a burning hex does. */
export const LIGHT_RADIUS = 4;
export const FIRE_GLOW = 1;
/** Rounds of a fight a torch burns: lit to hold, and one lit from the pack and thrown straight down. */
export const TORCH_HELD_ROUNDS = 10;
export const TORCH_GROUND_ROUNDS = 8;
/**
 * Out of a fight time passes as in real life (zone/clock.ts): every EXPLORE_ROUND_MS counts as a round for the
 * ground and for conditions. Torches are given a far kinder clock out there, a round every TORCH_ROUND_MS: a
 * held torch lights some fifteen minutes of exploring.
 */
export const EXPLORE_ROUND_MS = 6_000;
export const TORCH_ROUND_MS = 90_000;
/** Defence lost while a torch is held in the hand a shield would be on. */
export const SHIELD_SET_ASIDE = 2;

/** The kit every hero starts out with in their pack (and a stand-in is given on each map). */
export const STARTING_ITEMS: Partial<Record<Throwable, number>> = { healing: 2, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 };

/** Every kind of thing carried to drink or throw, in the order they are listed. */
export const THROWABLE_KINDS = Object.keys(THROWABLES) as Throwable[];

/** What is really carried, out of whatever was read: the kinds there are, in whole numbers, and none of what there is none of. */
export function cleanItems(raw: Partial<Record<string, number>> | undefined): Partial<Record<Throwable, number>> {
  const out: Partial<Record<Throwable, number>> = {};
  for (const kind of THROWABLE_KINDS) {
    const n = raw?.[kind];
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) out[kind] = Math.floor(n);
  }
  return out;
}

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
  /** It has the hands and the wit for it: it will shove someone beside it over a drop or into a pit (its bonus action). */
  shoves?: boolean;
  /** Attacks that are not plain blows, by name. */
  attacks?: Record<string, EnemyAttackKit>;
}

export const ENEMY_KIT: Record<string, EnemyKit> = {
  dummy: {},
  bandit: { shoves: true },
  wolf: { pack: true },
  bear: { shoves: true },
  // Its Stomp, like anything that strikes the whole crew, is a burst around it.
  ogre: { shoves: true },
  // It rakes up close, and will throw a rock at whoever keeps away. (Its wounds closing is in zone.ts, at the start of its turn.)
  troll: { shoves: true, attacks: { "Hurl Rock": { range: 5 } } },
  cultist: { ranged: true, attacks: { "Dark Bolt": { range: 5 }, Immolate: { range: 5, surface: { kind: "fire", rounds: 2 } } } },
  brute: { shoves: true, attacks: { Shove: { push: true } } },
  archer: { ranged: true, attacks: { Volley: { range: 7 }, "Barbed Arrow": { range: 7 } } },
  alpha: { pack: true },
  great_bear: { shoves: true },
  guardian: { shoves: true },
  shade: { attacks: { "Chill Touch": { chills: true } } },
  bat: { fly: true },
  skeleton: { shoves: true },
  slime: { attacks: { "Acid Splash": { range: 3, surface: { kind: "poison", rounds: 2 } } } },
  haunt: {},
  villain: { shoves: true },
  spider: { pack: true, attacks: { "Venomous Bite": { surface: { kind: "poison", rounds: 2 } }, "Web Spit": { range: 4, surface: { kind: "slime", rounds: 2 } } } },
  broodmother: { attacks: { "Web Spit": { range: 5, surface: { kind: "slime", rounds: 2 } } } },
  frost_wolf: { pack: true, attacks: { "Rime Bite": { chills: true } } },
  ember_hound: { pack: true },
  snow_bear: { shoves: true },
  wraith: { ranged: true, attacks: { "Frost Lance": { range: 5, chills: true } } },
  witch: { ranged: true, attacks: { "Thorn Hex": { range: 5 }, "Evil Eye": { range: 5 } } },
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

/**
 * An enemy kind's attacks as they work on the tiles, for a party of this level and at this threat.
 * `more` is what the map's modifiers add to every attack's damage and its bonus to hit (zone/mods.ts).
 */
export function enemyStrikes(kind: string, level: number, threat?: number, more = 0): EnemyStrike[] {
  const edge = clampThreat(threat) - 1 + more;
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

/**
 * Steps 1 AP buys an enemy, and `more` for what the map's modifiers add: 2 for most of what goes on foot, as for an
 * ordinary hero (rules.ts heroMove), and 3 for the quick (a speed of 63 or more: wolves, hounds, spiders, archers,
 * shades, bats). Never more than 3 before `more`. A training dummy stays put.
 */
export const enemyMove = (kind: string, more = 0): number => (kind === "dummy" ? 0 : Math.max(1, Math.floor(Math.max(3, Math.min(7, 3 + Math.round((ENEMIES[kind]?.speed ?? 0) / 25))) / 2)) + more);

/**
 * The most AP an enemy puts into movement in one turn, whether or not it also strikes: two strides, so 4 hexes of open
 * ground for a bandit and 6 for a wolf, where an ordinary hero who does nothing but walk covers 8. What it does not
 * spend it keeps for its next turn, as anyone does. A hero has no such limit. Being shoved or dragged is not its own
 * movement, and what lengthens a stride (Hasted, a Swift map) still does. Held in each turn's budget (Budget.walk,
 * set in zone.ts beginTurn), so the walk itself keeps to it and the enemy's planning (ai.ts) reckons with the same number.
 */
export const ENEMY_MOVE_AP = 2;

/** What an enemy adds to its roll when it shoves someone: the big shove hard. */
export const enemyShove = (kind: string): number => 1 + enemySave(kind);

/** What an enemy adds to a saving throw: bosses and the big are harder to shake. */
export const enemySave = (kind: string): number => (ENEMIES[kind]?.boss ? 3 : (ENEMIES[kind]?.hp ?? 0) >= 18 ? 2 : 0);

/** Every enemy's hit points, at every level, against what its entry and the level and threat give. */
export const ENEMY_HP_SCALE = 1.1;

/** Hit points for a party of this level (half again as much by level 4, as in the old fights), scaled by threat. */
export const enemyHp = (kind: string, level: number, threat?: number): number => Math.round((ENEMIES[kind]?.hp ?? 1) * (1 + 0.15 * Math.max(0, level - 1)) * THREAT_HP[clampThreat(threat) - 1] * ENEMY_HP_SCALE);

/** How many more stand with a group than its leader would bring, by threat. */
export const threatExtras = (threat?: number): number => clampThreat(threat) - 1;
