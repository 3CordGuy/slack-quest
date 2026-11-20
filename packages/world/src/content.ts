// Static game content: hero classes, weapons and their abilities, and
// enemies. Data only; the fights on the tiles (zone/) give it meaning.

import type { StatKey } from "@gantt-quest/core";

/** What an ability or an enemy's attack can leave on whoever it lands on. A fight on the tiles has more conditions of its own (zone/types.ts). */
export type EffectKind = "bleeding" | "burning" | "stunned" | "guarded" | "taunting" | "slowed" | "hasted" | "glitched" | "exposed" | "prone" | "sundered";

export const EFFECT_INFO: Record<EffectKind, { name: string; blurb: string; color: string }> = {
  bleeding: { name: "Bleeding", blurb: "Loses 2 HP at the start of each turn.", color: "#f87171" },
  burning: { name: "Burning", blurb: "Loses 3 HP at the start of each turn.", color: "#fb923c" },
  stunned: { name: "Stunned", blurb: "Skips the next turn.", color: "#a78bfa" },
  guarded: { name: "Guarded", blurb: "Takes half damage until its next turn.", color: "#93c5fd" },
  taunting: { name: "Taunting", blurb: "Every enemy attack aimed at one hero goes to it instead, until its next turn.", color: "#fbbf24" },
  slowed: { name: "Slowed", blurb: "Its next turns come half again later on the timeline.", color: "#4ade80" },
  hasted: { name: "Hasted", blurb: "Its next turn comes a third sooner on the timeline.", color: "#67e8f9" },
  glitched: { name: "Fumbling", blurb: "One roll of its next attack fails, whatever happens.", color: "#e879f9" },
  exposed: { name: "Exposed", blurb: "Takes 3 more damage from every direct hit, for 2 of its turns.", color: "#facc15" },
  prone: { name: "Prone", blurb: "Knocked flat: standing up costs 1 AP.", color: "#cbd5e1" },
  sundered: { name: "Sundered", blurb: "Its armor is dented: 2 less Defence.", color: "#b0a48a" },
};

/** Sundered targets have this much less Defence. */
export const SUNDERED_DEFENCE = 2;

export const EFFECT_TICK: Partial<Record<EffectKind, number>> = { bleeding: 2, burning: 3 };

// ---------- classes ----------

export interface HeroClass {
  id: string;
  name: string;
  blurb: string;
  /** First entry is the starting weapon; the rest drop as loot. */
  weapons: string[];
  /** A rarer weapon with the class's signature ability. Drops only where loot is good (lairs and bosses). */
  signature: string;
  /** Something the class always does in a fight, if it has one. Shown when choosing a class. */
  passive?: string;
}

/** HP the Reef Druid grows back at the start of each of its turns in a fight. */
export const DRUID_REGEN = 1;
/** Extra damage on every other hero's attacks while a Shanty Bard is standing. One Bard's worth, however many there are. */
export const BARD_AURA = 2;

export const HERO_CLASSES: HeroClass[] = [
  {
    id: "qa_paladin",
    name: "Lighthouse Paladin",
    blurb: "Tough front-liner. Hits hard with Strength and shrugs off blows.",
    weapons: ["mace", "greatsword"],
    signature: "ballast_flail",
  },
  {
    id: "devops_mage",
    name: "Stormcall Mage",
    blurb: "Fragile caster. Burns enemies and patches up allies with Intelligence.",
    weapons: ["staff", "tome"],
    signature: "barometer_rod",
  },
  {
    id: "refactor_rogue",
    name: "Smuggler Rogue",
    blurb: "Fast and precise. Opens wounds with Dexterity and usually acts first.",
    weapons: ["daggers", "shortbow"],
    signature: "gaff_hook",
  },
  {
    id: "backend_druid",
    name: "Reef Druid",
    blurb: "Hardy healer. Mends allies and tangles enemies with Intelligence, and regrows like coral.",
    weapons: ["root_staff", "sickle"],
    signature: "coral_staff",
    passive: `Deep roots: heals ${DRUID_REGEN} HP at the start of each of its turns in a fight.`,
  },
  {
    id: "frontend_bard",
    name: "Shanty Bard",
    blurb: "Makes everyone better. Plays the party up and the enemy down with Intelligence.",
    weapons: ["lute", "flute", "accordion"],
    signature: "ships_bell",
    passive: `Encore: while the Bard is standing, every other hero's attacks do +${BARD_AURA} damage.`,
  },
  {
    id: "staff_sage",
    name: "Starchart Sage",
    blurb: "Raw power. The hardest-hitting spells of any class, and little else to fall back on.",
    weapons: ["orb", "scepter"],
    signature: "astrolabe",
  },
  {
    id: "sre_warden",
    name: "Tidewall Warden",
    blurb: "The wall. Draws every blow onto itself and hits back with Strength and the weight of its armor.",
    weapons: ["maul", "pager_axe"],
    signature: "boarding_pike",
    passive: "Night watch: starts every fight guarded (half damage) until its second turn.",
  },
  {
    id: "data_warlock",
    name: "Wreck Warlock",
    blurb: "Curses, drowns and drains with Intelligence.",
    weapons: ["grimoire", "void_staff"],
    signature: "bilge_chalice",
    passive: "Riptide: every critical hit also drags the target under: a stack of Drowning.",
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
  /** How hard it hits. A fight rolls dice sized from this (zone/kit.ts abilityDice) and adds the hero's stat, weapon and level. */
  damage?: number;
  /** How much it heals, turned into dice the same way (healDice). */
  heal?: number;
  /** Applied to the user when the ability lands. */
  selfEffect?: { effect: EffectKind; turns: number };
  /** Applied to a target it gets through to, unless the target makes its save (where the ability allows one). */
  perfect?: { effect: EffectKind; turns: number };
  /** Applied to each target it gets through to, with no save. */
  targetEffect?: { effect: EffectKind; turns: number };
  /** Heals the user this share of the damage it deals. */
  drain?: number;
  blurb: string;
}

export const ABILITIES: Record<string, AbilityDef> = {
  // Bare hands: what a hero has with no weapon. Weak on purpose, and never on a weapon.
  // A lit torch swung in the main hand (zones only): the weapon is put away while it is held.
  torch_swing: { id: "torch_swing", name: "Torch Swing", stat: "str", rolls: 2, target: "enemy", damage: 6, perfect: { effect: "burning", turns: 2 }, blurb: "A swing of a lit torch. Whoever it hits may catch fire." },
  // Paladin weapons. Mace: Bash and Recover. Greatsword: Cleave and Block. Flail: Strike and Armor Crush.
  bash: { id: "bash", name: "Bash", stat: "str", rolls: 3, target: "enemy", damage: 8, perfect: { effect: "prone", turns: 1 }, blurb: "A heavy blow with the mace. On a hit, the target must save or be knocked Prone." },
  recover: { id: "recover", name: "Recover", stat: "vit", rolls: 1, target: "self", heal: 7, blurb: "Catch your breath and heal yourself a fair amount." },
  block: { id: "block", name: "Block", stat: "vit", rolls: 1, target: "self", blurb: "Set the flat of the blade before you, for a shield of 8 plus your level that takes the damage of blows before HP does, through your next turn." },
  flail_strike: { id: "flail_strike", name: "Strike", stat: "str", rolls: 3, target: "enemy", damage: 8, perfect: { effect: "slowed", turns: 2 }, blurb: "A swing of the flail. On a hit, the target must save or be Slowed." },
  armor_crush: { id: "armor_crush", name: "Armor Crush", stat: "str", rolls: 2, target: "enemy", damage: 4, perfect: { effect: "sundered", turns: 2 }, blurb: "A quick blow at the joints of its armor. On a hit, the target must save or be Sundered, with 2 less Defence for 2 turns." },
  // Mage weapons. Staff: Shock and Mend. Logbook: Slicing Wind and Wind's Blessing. Rod: Waterbolt and Lightning Strike.
  shock: { id: "shock", name: "Shock", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, blurb: "A bolt of lightning. Hits 3 harder on anything Wet." },
  mend: { id: "mend", name: "Mend", stat: "int_stat", rolls: 2, target: "ally", heal: 10, blurb: "Heal an ally (or yourself) a good amount." },
  slicing_wind: { id: "slicing_wind", name: "Slicing Wind", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, blurb: "A blade of wind at an enemy, and the gust carries you: 1 more movement for each AP for the rest of this turn." },
  winds_blessing: { id: "winds_blessing", name: "Wind's Blessing", stat: "int_stat", rolls: 1, target: "ally", heal: 4, blurb: "Heal an ally (or yourself) a little, and put the wind at their back: 1 more movement for each AP, this turn if they are taking it, else their next." },
  waterbolt: { id: "waterbolt", name: "Waterbolt", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, blurb: "A bolt of seawater. On a hit, it leaves water under the target, soaking it Wet." },
  lightning_strike: { id: "lightning_strike", name: "Lightning Strike", stat: "int_stat", rolls: 3, target: "enemy", damage: 12, perfect: { effect: "stunned", turns: 1 }, blurb: "Lightning out of the sky: a heavy blow, 3 harder on anything Wet. On a hit, the target must save or be Stunned." },
  // Rogue weapons. Knives: Stab and Eviscerate. Shortbow: Shot and Take Aim. Gaff Hook: Tear and Snag.
  stab: { id: "stab", name: "Stab", stat: "dex", rolls: 2, target: "enemy", damage: 8, blurb: "A quick stab with the knives. Made with advantage, it finds a gap: 3 more damage." },
  eviscerate: { id: "eviscerate", name: "Eviscerate", stat: "dex", rolls: 3, target: "enemy", damage: 14, perfect: { effect: "bleeding", turns: 3 }, blurb: "Open them up with both knives: a heavy blow, and on a hit the target must save or start Bleeding." },
  bow_shot: { id: "bow_shot", name: "Shot", stat: "dex", rolls: 3, target: "enemy", damage: 7, blurb: "An arrow from the shortbow." },
  take_aim: { id: "take_aim", name: "Take Aim", stat: "dex", rolls: 1, target: "self", blurb: "Steady your hand. Your next roll to hit has advantage." },
  // Ship's guns, for anyone. Pistol: Pistol Shot and Pistol Whip. Blunderbuss: Scattershot and Butt Stroke. Harpoon gun: Harpoon and Barbed Line.
  pistol_shot: { id: "pistol_shot", name: "Pistol Shot", stat: "dex", rolls: 2, target: "enemy", damage: 11, blurb: "A shot from the pistol, reaching 5 hexes." },
  pistol_whip: { id: "pistol_whip", name: "Pistol Whip", stat: "str", rolls: 1, target: "enemy", damage: 5, blurb: "Crack the butt across an enemy beside you." },
  scattershot: { id: "scattershot", name: "Scattershot", stat: "dex", rolls: 2, target: "enemy", damage: 12, blurb: "A blast of shot in a cone, 3 hexes long, that catches every enemy in it." },
  butt_stroke: { id: "butt_stroke", name: "Butt Stroke", stat: "str", rolls: 2, target: "enemy", damage: 7, perfect: { effect: "prone", turns: 1 }, blurb: "Swing the stock at an enemy beside you. On a hit, the target must save or be knocked Prone." },
  harpoon_shot: { id: "harpoon_shot", name: "Harpoon", stat: "dex", rolls: 2, target: "enemy", damage: 11, blurb: "Fire the harpoon up to 6 hexes. On a hit, the line hauls the target 2 hexes toward you." },
  barbed_line: { id: "barbed_line", name: "Barbed Line", stat: "dex", rolls: 2, target: "enemy", damage: 7, perfect: { effect: "slowed", turns: 2 }, blurb: "A barb on a short line, 3 hexes. On a hit, the target must save or be Slowed." },
  tear: { id: "tear", name: "Tear", stat: "dex", rolls: 2, target: "enemy", damage: 8, perfect: { effect: "bleeding", turns: 3 }, blurb: "A tearing swing of the hook. On a hit, the target must save or start Bleeding." },
  snag: { id: "snag", name: "Snag", stat: "dex", rolls: 3, target: "enemy", damage: 8, perfect: { effect: "slowed", turns: 2 }, blurb: "Throw the hook at an enemy up to 3 hexes off. On a hit, the target must save or be Slowed." },
  // Druid weapons. Driftwood Staff: Thornlash and Rejuvenate. Sickle: Sea Slash and Binding Kelp. Coral Staff: Coral Burst and Restore.
  sea_slash: { id: "sea_slash", name: "Sea Slash", stat: "int_stat", rolls: 2, target: "enemy", damage: 8, blurb: "A slash of the sickle with the sea behind it. On a hit, water pools under the target and under you." },
  binding_kelp: { id: "binding_kelp", name: "Binding Kelp", stat: "int_stat", rolls: 1, target: "enemy", blurb: "Kelp lashes round an enemy up to 4 hexes off, no roll to hit. It must save or be Slowed for 1 turn. Standing in water, it must instead save against being Stunned for 1 turn." },
  coral_burst: { id: "coral_burst", name: "Coral Burst", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 6, perfect: { effect: "bleeding", turns: 3 }, blurb: "Coral bursts out in a cone 3 hexes long: 1 hex, then 2, then 3. Every enemy in it takes a little damage (half if they brace), and those that fail to brace are cut and start Bleeding." },
  restore: { id: "restore", name: "Restore", stat: "int_stat", rolls: 1, target: "ally", heal: 4, blurb: "Heal an ally (or yourself) a little and lift every harmful condition off them." },
  // Bard weapons. Lute: Dissonance and Second Wind. Bosun's Pipe: Blasting Tone and Soothing Tone. Squeeze Box: Bellows Blast and Hornpipe. Ship's Bell: Peal and Clarion Call.
  dissonance: { id: "dissonance", name: "Dissonance", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, targetEffect: { effect: "glitched", turns: 1 }, blurb: "A note nobody can think through. On a hit, the target's next roll to hit is made with disadvantage. No save." },
  encore: { id: "encore", name: "Second Wind", stat: "int_stat", rolls: 1, target: "ally", heal: 4, blurb: "A tune that gets an ally (or yourself) back on their feet. Heal a little, and their next roll to hit has advantage." },
  blasting_tone: { id: "blasting_tone", name: "Blasting Tone", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 6, blurb: "A blast of sound in a line 4 hexes long. Every enemy on it takes a little damage (half if they brace). Your allies on the line are spared." },
  soothing_tone: { id: "soothing_tone", name: "Soothing Tone", stat: "int_stat", rolls: 1, target: "self", heal: 6, blurb: "A calming tone: you and every ally within 2 hexes heal a fair amount." },
  bellows_blast: { id: "bellows_blast", name: "Bellows Blast", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 6, blurb: "Squeeze the bellows shut on a great blare of a chord. Every enemy beside you takes a little damage (half if they brace), and those that fail to brace are pushed 1 hex back. 1 turn to wait." },
  hornpipe: { id: "hornpipe", name: "Hornpipe", stat: "int_stat", rolls: 1, target: "self", blurb: "A rousing jig: you and every ally within 2 hexes are Rallied, +2 damage on your next attack." },
  peal: { id: "peal", name: "Peal", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, blurb: "A ringing blow of sound at an enemy up to 4 hexes off. On a hit, the target must save or be pushed 1 hex back." },
  clarion_call: { id: "clarion_call", name: "Clarion Call", stat: "int_stat", rolls: 1, target: "ally", heal: 10, blurb: "A call that carries: heal an ally (or yourself) a good amount, and every ally beside them heals a fair amount too." },
  // Sage weapons. Orb: Starbeam and St. Elmo's Fire. Scepter: Water Burst and Rust Armor. Astrolabe: Moonlight and Focus Light.
  starbeam: { id: "starbeam", name: "Starbeam", stat: "int_stat", rolls: 3, target: "enemy", damage: 12, blurb: "A beam of raw starlight. On a hit, the target must save or be lit with Guiding Light for 3 turns: every attack on it has advantage." },
  st_elmos_fire: { id: "st_elmos_fire", name: "St. Elmo's Fire", stat: "int_stat", rolls: 1, target: "ally", blurb: "Fire dances over an ally (or yourself) up to 4 hexes off for 3 turns. Every blow they land sets its target Burning, one stack more if it would have anyway." },
  water_burst: { id: "water_burst", name: "Water Burst", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, blurb: "A burst of seawater at an enemy up to 5 hexes off. On a hit, every other enemy beside the target is drenched for a little damage too." },
  rust_armor: { id: "rust_armor", name: "Rust Armor", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 7, perfect: { effect: "sundered", turns: 3 }, blurb: "Rust spreads over 3 hexes up to 5 off. Every enemy in it takes damage (half if they brace), and those that fail to brace are Sundered: 2 less Defence for 3 turns." },
  // Astrolabe: Moonlight and Focus Light.
  moonlight: { id: "moonlight", name: "Moonlight", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 7, blurb: "Moonlight pours over 3 hexes up to 7 off. Every enemy in it takes damage (half if they brace), and those that fail to brace are lit with Guiding Light for 3 turns: every attack on them has advantage." },
  focus_light: { id: "focus_light", name: "Focus Light", stat: "int_stat", rolls: 2, target: "enemy", damage: 4, blurb: "A thin focused beam at an enemy up to 5 hexes off. If it is lit by Guiding Light, a hit also sets it Burning." },
  // Warden weapons. Bell-Buoy Maul: Sturdy Blow and Stand Strong. Foghorn Axe: Disarming Chop and Guard. Boarding Pike: Goading Strike and Throw Pike.
  sturdy_blow: { id: "sturdy_blow", name: "Sturdy Blow", stat: "str", rolls: 3, target: "enemy", damage: 9, blurb: "A heavy, careful blow with the maul. Hit or miss, you gain a shield of 3 plus your level on top of any you have, through your next turn." },
  stand_strong: { id: "stand_strong", name: "Stand Strong", stat: "vit", rolls: 1, target: "self", blurb: "Plant your feet. A shield of 3 plus your level, and 3 more for each enemy beside you, on top of any you have, through your next turn." },
  disarming_chop: { id: "disarming_chop", name: "Disarming Chop", stat: "str", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "glitched", turns: 1 }, blurb: "A chop at the weapon arm. On a hit, the target must save or its next attack is rolled with disadvantage." },
  raise_guard: { id: "raise_guard", name: "Guard", stat: "vit", rolls: 1, target: "self", selfEffect: { effect: "guarded", turns: 1 }, blurb: "Set yourself behind the axe. You are Guarded (half damage) until your next turn, and have a shield of 4 plus your level. 1 turn to wait." },
  goading_strike: { id: "goading_strike", name: "Goading Strike", stat: "str", rolls: 3, target: "enemy", damage: 9, blurb: "A jab with the pike to get its attention. On a hit, the target must save or be Taunted for 2 turns: it must come at you if it can." },
  throw_pike: { id: "throw_pike", name: "Throw Pike", stat: "str", rolls: 3, target: "enemy", damage: 8, blurb: "Hurl the pike at an enemy up to 3 hexes off. On a hit, it is dragged straight toward you, as far as beside you. 2 turns to wait." },
  // Warlock weapons. Grimoire: Hex and Soul Drain. Undertow Staff: Sink and Pull of the Deep. Bilge Chalice: Vile Splash and Drink Deeply.
  sink: { id: "sink", name: "Sink", stat: "int_stat", rolls: 3, target: "enemy", damage: 8, blurb: "A weight of black water on an enemy. On a hit, it must save or take a stack of Drowning." },
  pull_of_the_deep: { id: "pull_of_the_deep", name: "Pull of the Deep", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 5, blurb: "The sea drags at everything beside you. Every enemy beside you takes a little damage (half if they brace), and those that fail to brace take a stack of Drowning. 2 turns to wait." },
  vile_splash: { id: "vile_splash", name: "Vile Splash", stat: "int_stat", rolls: 3, target: "enemy", damage: 8, blurb: "A splash of foul bilge at an enemy up to 5 hexes off. On a hit, it leaves poison on the ground under the target: whoever stands in it is hurt and Poisoned." },
  drink_deeply: { id: "drink_deeply", name: "Drink Deeply", stat: "int_stat", rolls: 1, target: "self", heal: 14, blurb: "Drink deep from the chalice. Heal yourself a great deal, but you are Poisoned for 2 turns: your attacks are rolled with disadvantage. 2 turns to wait." },
  punch: { id: "punch", name: "Punch", stat: "str", rolls: 2, target: "enemy", damage: 4, blurb: "Bare knuckles. All you have without a weapon in hand." },
  cleave: { id: "cleave", name: "Cleave", stat: "str", rolls: 3, target: "all_enemies", damage: 7, blurb: "A wide swing through three hexes beside you, an attack on each enemy in them." },
  thornlash: { id: "thornlash", name: "Thornlash", stat: "int_stat", rolls: 3, target: "enemy", damage: 7, perfect: { effect: "slowed", turns: 2 }, blurb: "Thorns that dig in. On a hit, the target must save or be Slowed." },
  rejuvenate: { id: "rejuvenate", name: "Rejuvenate", stat: "int_stat", rolls: 2, target: "ally", heal: 7, blurb: "Heal an ally (or yourself) now, and the same again at the start of their next turn." },
  hex: { id: "hex", name: "Hex", stat: "int_stat", rolls: 3, target: "enemy", damage: 8, perfect: { effect: "glitched", turns: 1 }, blurb: "A slow curse on the target. On a hit, it must save or be Fumbling: its next attack is rolled with disadvantage." },
  soul_drain: { id: "soul_drain", name: "Soul Drain", stat: "int_stat", rolls: 3, target: "enemy", damage: 11, drain: 0.34, blurb: "Takes some of their life for yours: heals you a third of the damage dealt. 2 turns to wait." },
  // Class abilities: chosen for a hero's slots from their class's pool (classabilities.ts), not given by a weapon.
  // Paladin. The two auras are conditions on the Paladin in a fight (zone/kit.ts AURAS).
  beacon_aura: { id: "beacon_aura", name: "Beacon Aura", stat: "vit", rolls: 1, target: "self", blurb: "For 4 turns you shine: you light the dark around you, and you and allies within 2 hexes get +2 to hit." },
  healing_aura: { id: "healing_aura", name: "Healing Aura", stat: "vit", rolls: 1, target: "self", blurb: "For 4 turns, at the start of each of your turns, you and every ally within 2 hexes heal a little." },
  branding_strike: { id: "branding_strike", name: "Branding Strike", stat: "str", rolls: 3, target: "enemy", damage: 11, targetEffect: { effect: "burning", turns: 2 }, blurb: "A searing blow that hits harder than most, and sets the target Burning." },
  soothing_rain: { id: "soothing_rain", name: "Soothing Rain", stat: "int_stat", rolls: 1, target: "ally", blurb: "A rain cloud over 3 hexes for 3 turns. It lays water under itself, and heals your side a little as it comes, as each of you starts a turn in it, and the first time on a turn each of you walks into it." },
  chain_lightning: { id: "chain_lightning", name: "Chain Lightning", stat: "int_stat", rolls: 3, target: "enemy", damage: 9, blurb: "Lightning strikes an enemy, then leaps to the nearest enemy within 2 hexes it has not struck yet, and on, as long as there is one. +3 against anything Wet." },
  roar_of_thunder: { id: "roar_of_thunder", name: "Roar of Thunder", stat: "int_stat", rolls: 1, target: "enemy", perfect: { effect: "stunned", turns: 1 }, blurb: "A thunderclap that never misses: the enemy is thrown a hex back from you, and must save or be Stunned." },
  trade_winds: { id: "trade_winds", name: "Trade Winds", stat: "int_stat", rolls: 1, target: "ally", blurb: "Winds over 19 hexes for 3 turns: your side moves twice as far in them, and the enemy is Slowed." },
  tidal_wave: { id: "tidal_wave", name: "Tidal Wave", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 9, blurb: "A wave rolls out 5 hexes in a line, striking every enemy in it. Those that fail to brace are swept to the end of it, and the line is left under water." },
  bolster: { id: "bolster", name: "Bolster", stat: "vit", rolls: 1, target: "self", blurb: "You raise a great ward: you and every ally within 2 hexes get a shield of 10 plus your level, which takes the damage of blows before HP does, for 3 turns." },
  show_the_way: { id: "show_the_way", name: "Show the Way", stat: "vit", rolls: 1, target: "ally", heal: 4, blurb: "Heal an ally a little and lift every harmful condition off them, and sweep the fire, poison, oil, ice and slime off the way you would walk to them." },
  smugglers_route: { id: "smugglers_route", name: "Smuggler's Route", stat: "dex", rolls: 1, target: "self", blurb: "Slip through a way only you know: you are on a hex up to 3 off, over walls and water and all, and draw no blows going. Pick an ally beside you first and they come too, to a hex beside where you arrive." },
  sneak: { id: "sneak", name: "Sneak", stat: "dex", rolls: 1, target: "self", blurb: "You and every ally beside you go Unseen for 3 turns: enemies cannot attack you. Using an ability gives you away, but the roll to hit with it has advantage." },
  pickpocket: { id: "pickpocket", name: "Pickpocket", stat: "dex", rolls: 2, target: "enemy", damage: 8, blurb: "A cut and a quick hand: gold equal to your level, once an enemy. Used Unseen it is no cut, just the gold, and you stay Unseen." },
  tactical_retreat: { id: "tactical_retreat", name: "Tactical Retreat", stat: "dex", rolls: 3, target: "enemy", damage: 14, blurb: "A heavy blow, and then you are gone if you like: to a hex up to 4 off, over anything between, drawing no blows." },
  contraband: { id: "contraband", name: "Contraband", stat: "dex", rolls: 1, target: "ally", blurb: "Slip yourself and an ally a fire bomb each, off the books, or keep both for yourself. Throw them within 3 turns, or they are gone." },
  coral_field: { id: "coral_field", name: "Coral Field", stat: "int_stat", rolls: 1, target: "all_enemies", blurb: "Coral bursts up over 7 hexes for 4 turns. It does your side no harm, but cuts and Slows the enemy, once a turn, as they start a turn in it or walk into it." },
  aqueous_regeneration: { id: "aqueous_regeneration", name: "Aqueous Regeneration", stat: "int_stat", rolls: 1, target: "ally", heal: 6, blurb: "Heal an ally (or yourself) now, and again at the start of each of their turns for 3 turns. Every heal is bigger while they stand in water." },
  coral_armor: { id: "coral_armor", name: "Coral Armor", stat: "int_stat", rolls: 1, target: "ally", blurb: "Grow a shell of coral on an ally (or yourself) for 3 turns: +2 Defence, and any enemy that lands a blow on them up close is cut by it." },
  revitalizing_splash: { id: "revitalizing_splash", name: "Revitalizing Splash", stat: "int_stat", rolls: 1, target: "ally", heal: 7, blurb: "A wave of healing over 4 hexes: a fair heal for everyone of your side in it, even the fallen, and the ground left under water." },
  summon_sea_turtle: { id: "summon_sea_turtle", name: "Summon Sea Turtle", stat: "int_stat", rolls: 1, target: "self", blurb: "Call a sea turtle onto a hex up to 3 off. It is yours to play, on your turn: slow, but hard to hurt, with a fair bite that hits harder from the water. It stays till the fight is over; calling another sends the first away." },
  turtle_bite: { id: "turtle_bite", name: "Bite", stat: "str", rolls: 2, target: "enemy", damage: 9, blurb: "A sea turtle's beak, hard to shake. +4 while the turtle stands in water." },
  lively_shanty: { id: "lively_shanty", name: "Lively Shanty", stat: "int_stat", rolls: 1, target: "self", blurb: "Strike up a lively shanty for 4 turns: you and every ally within 2 hexes get +2 to hit and a little more damage (more as you level). An ally in it can join the song (1 AP, once): it reaches a hex further, they get advantage on their next attack, and everyone in it gets +1 more to hit until your next turn. One shanty at a time." },
  dour_shanty: { id: "dour_shanty", name: "Dour Shanty", stat: "int_stat", rolls: 1, target: "self", blurb: "Strike up a dour shanty for 4 turns: you and every ally within 2 hexes get +2 Defence. An ally in it can join the song (1 AP, once): it reaches a hex further, they are Guarded, and everyone in it gets +1 more Defence until your next turn. One shanty at a time." },
  windgod_shanty: { id: "windgod_shanty", name: "Wind-god's Shanty", stat: "int_stat", rolls: 1, target: "self", blurb: "Strike up a shanty to the wind-god for 4 turns: you and every ally within 2 hexes move 1 further for each AP of movement and cannot be Slowed. An ally in it can join the song (1 AP, once): it reaches a hex further, they Disengage (no blows drawn moving away this turn), and everyone in it moves 1 further for each AP until your next turn. One shanty at a time." },
  chorus: { id: "chorus", name: "Chorus", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 8, targetEffect: { effect: "slowed", turns: 2 }, blurb: "A roar of voices over 7 hexes: every enemy in it is struck (half if they brace) and those who fail are Slowed. Your allies in it are not hurt: each one sings along, for +3 damage." },
  lead_by_example: { id: "lead_by_example", name: "Lead by Example", stat: "int_stat", rolls: 3, target: "enemy", damage: 13, blurb: "A heavy blow of sound at an enemy. If it lands, the ally nearest the target is Inspired: advantage on their next attack." },
  falling_star: { id: "falling_star", name: "Falling Star", stat: "int_stat", rolls: 3, target: "enemy", damage: 13, targetEffect: { effect: "burning", turns: 3 }, blurb: "Bring a star down on an enemy up to 7 hexes off: a heavy blow that, if it lands, sets them Burning and lights them with Guiding Light for 3 turns (every attack on them has advantage)." },
  constellation: { id: "constellation", name: "Constellation", stat: "int_stat", rolls: 1, target: "self", damage: 5, blurb: "Draw lines of starlight from you to the nearest ally within 4 hexes, from them to the next, and on through every ally it can reach. Your side is untouched; every enemy a line crosses takes a little damage and is lit with Guiding Light for 3 turns." },
  new_moon: { id: "new_moon", name: "New Moon", stat: "int_stat", rolls: 3, target: "all_enemies", damage: 15, blurb: "Put out every Guiding Light at once, wherever it is: each enemy that was lit takes heavy damage, no roll to dodge it." },
  chart_a_course: { id: "chart_a_course", name: "Chart a Course", stat: "int_stat", rolls: 1, target: "self", blurb: "Mark a hex up to 8 off with a red X for 4 turns: you and your allies move 1 further for each AP of movement, on steps that bring you nearer the mark. A new mark takes the place of the old." },
  north_star: { id: "north_star", name: "North Star", stat: "int_stat", rolls: 2, target: "ally", damage: 9, blurb: "Make an ally (or yourself) the north star for 3 turns: every enemy beside them is struck, no roll, and lit with Guiding Light, and every blow they land sets its target Burning (one stack more if it would have anyway)." },
  against_the_waves: { id: "against_the_waves", name: "Against the Waves", stat: "vit", rolls: 1, target: "self", blurb: "Brace as the sea breaks on you: a high shield of 10 plus your level, which takes the damage of blows before HP does, for 2 turns. 8 more if you stand in water." },
  overwhelm: { id: "overwhelm", name: "Overwhelm", stat: "str", rolls: 1, target: "enemy", blurb: "Throw your weight at an enemy beside you, Strength against its footing: win, and it is driven 2 hexes back. Driven into a wall, rock or anything else nobody can pass, it is Stunned and loses its next turn." },
  fortify: { id: "fortify", name: "Fortify", stat: "vit", rolls: 1, target: "self", blurb: "Raise a wall 3 hexes long, up to 5 off, bowed toward you, for 3 rounds. Nobody gets through it. Your side sees and shoots over it, and has +1 Defence standing beside it; the enemy cannot see through it at all." },
  bulwark_strike: { id: "bulwark_strike", name: "Bulwark Strike", stat: "str", rolls: 3, target: "enemy", damage: 8, blurb: "Set your shield and swing: you gain a small shield of 4 plus your level on top of any you have, then the blow lands harder by half of all the shield you carry." },
  taunt: { id: "taunt", name: "Taunt", stat: "str", rolls: 1, target: "all_enemies", blurb: "Bellow a challenge: every enemy beside you is Taunted for 2 of its turns, and must come at you if it can reach you." },
  curse_of_drowning: { id: "curse_of_drowning", name: "Curse of Drowning", stat: "int_stat", rolls: 1, target: "enemy", damage: 8, targetEffect: { effect: "slowed", turns: 2 }, blurb: "Curse an enemy up to 5 hexes off. It is struck, no roll, and Slowed for 2 turns, and for 3 turns it takes a stack of Drowning whenever it starts or ends a turn standing in water." },
  summon_sunken_sailors: { id: "summon_sunken_sailors", name: "Summon Sunken Sailors", stat: "int_stat", rolls: 1, target: "self", blurb: "Call two drowned sailors up onto a hex up to 3 off and the hex beside it: a cutlass, who can take a beating, and a gunner, whose pistol reaches 4 hexes and hits harder. They are yours to play, on your turn, till the fight is over; calling them again sends the first two away." },
  red_sky_at_morning: { id: "red_sky_at_morning", name: "Red Sky at Morning", stat: "int_stat", rolls: 1, target: "all_enemies", blurb: "Turn the sky red over 19 hexes up to 5 off: every enemy under it reads the omen, and attacks with disadvantage for 3 turns." },
  unholy_waters: { id: "unholy_waters", name: "Unholy Waters", stat: "int_stat", rolls: 1, target: "all_enemies", blurb: "Flood 7 hexes up to 5 off with water for 3 turns, bar the hexes enemies stand on: those burst into flame under them instead, for 2." },
  the_black_spot: { id: "the_black_spot", name: "The Black Spot", stat: "int_stat", rolls: 1, target: "enemy", blurb: "Press the Black Spot on an enemy up to 5 hexes off, no roll, for 4 turns: it attacks with disadvantage, and takes a stack of Drowning at the end of each of its turns. If it falls before the Spot runs out, the Spot passes to the nearest of its side." },
  sailor_pistol: { id: "sailor_pistol", name: "Pistol", stat: "dex", rolls: 2, target: "enemy", damage: 11, blurb: "A drowned gunner's pistol, somehow still dry enough to fire. Reaches 4 hexes." },
  sailor_scimitar: { id: "sailor_scimitar", name: "Scimitar", stat: "str", rolls: 2, target: "enemy", damage: 8, blurb: "A drowned sailor's scimitar, rusted but sharp enough." },
  stoke_the_fire: { id: "stoke_the_fire", name: "Stoke the Fire", stat: "str", rolls: 3, target: "all_enemies", damage: 6, targetEffect: { effect: "burning", turns: 2 }, blurb: "Flame bursts off you: every enemy beside you is struck and set Burning." },
  // Signature abilities: one per class, on its signature weapon.
};

export interface WeaponDef {
  id: string;
  name: string;
  /** The class that can use it. Left out, anyone can. */
  classId?: string;
  abilities: string[];
  /** The class weapon it is nearest to: drawn as that one where it has no shape of its own. */
  looksLike?: string;
}

export const WEAPONS: Record<string, WeaponDef> = {
  mace: { id: "mace", name: "Anchor Mace", classId: "qa_paladin", abilities: ["bash", "recover"] },
  greatsword: { id: "greatsword", name: "Breakwater Cutlass", classId: "qa_paladin", abilities: ["cleave", "block"] },
  staff: { id: "staff", name: "Squall Staff", classId: "devops_mage", abilities: ["shock", "mend"] },
  tome: { id: "tome", name: "Logbook of Gales", classId: "devops_mage", abilities: ["slicing_wind", "winds_blessing"] },
  daggers: { id: "daggers", name: "Twin Gutting Knives", classId: "refactor_rogue", abilities: ["stab", "eviscerate"] },
  shortbow: { id: "shortbow", name: "Crow's Nest Shortbow", classId: "refactor_rogue", abilities: ["bow_shot", "take_aim"] },
  root_staff: { id: "root_staff", name: "Driftwood Staff", classId: "backend_druid", abilities: ["thornlash", "rejuvenate"] },
  sickle: { id: "sickle", name: "Kelp Sickle", classId: "backend_druid", abilities: ["sea_slash", "binding_kelp"] },
  lute: { id: "lute", name: "Dockside Lute", classId: "frontend_bard", abilities: ["dissonance", "encore"] },
  flute: { id: "flute", name: "Bosun's Pipe", classId: "frontend_bard", abilities: ["blasting_tone", "soothing_tone"] },
  accordion: { id: "accordion", name: "Squeeze Box", classId: "frontend_bard", abilities: ["bellows_blast", "hornpipe"] },
  orb: { id: "orb", name: "Sextant Orb", classId: "staff_sage", abilities: ["starbeam", "st_elmos_fire"] },
  scepter: { id: "scepter", name: "Tidestone Scepter", classId: "staff_sage", abilities: ["water_burst", "rust_armor"] },
  pager_axe: { id: "pager_axe", name: "Foghorn Axe", classId: "sre_warden", abilities: ["disarming_chop", "raise_guard"] },
  maul: { id: "maul", name: "Ship's Anchor", classId: "sre_warden", abilities: ["sturdy_blow", "stand_strong"] },
  grimoire: { id: "grimoire", name: "Drowned Grimoire", classId: "data_warlock", abilities: ["hex", "soul_drain"] },
  // Signature weapons: each class's own ability plus a staple, drawn like a weapon the class already has.
  ballast_flail: { id: "ballast_flail", name: "Chainshot Flail", classId: "qa_paladin", abilities: ["flail_strike", "armor_crush"], looksLike: "mace" },
  barometer_rod: { id: "barometer_rod", name: "Barometer Rod", classId: "devops_mage", abilities: ["waterbolt", "lightning_strike"], looksLike: "staff" },
  gaff_hook: { id: "gaff_hook", name: "Gaff Hook", classId: "refactor_rogue", abilities: ["tear", "snag"], looksLike: "daggers" },
  coral_staff: { id: "coral_staff", name: "Coral Staff", classId: "backend_druid", abilities: ["coral_burst", "restore"], looksLike: "root_staff" },
  ships_bell: { id: "ships_bell", name: "Ship's Bell", classId: "frontend_bard", abilities: ["peal", "clarion_call"], looksLike: "lute" },
  astrolabe: { id: "astrolabe", name: "Astrolabe", classId: "staff_sage", abilities: ["moonlight", "focus_light"], looksLike: "orb" },
  boarding_pike: { id: "boarding_pike", name: "Boarding Pike", classId: "sre_warden", abilities: ["goading_strike", "throw_pike"], looksLike: "pager_axe" },
  bilge_chalice: { id: "bilge_chalice", name: "Bilge Chalice", classId: "data_warlock", abilities: ["vile_splash", "drink_deeply"], looksLike: "grimoire" },
  // Ship's guns: no class of their own. Anyone can find one in loot and fire it.
  pistol: { id: "pistol", name: "Flintlock Pistol", abilities: ["pistol_shot", "pistol_whip"] },
  blunderbuss: { id: "blunderbuss", name: "Blunderbuss", abilities: ["scattershot", "butt_stroke"] },
  harpoon_gun: { id: "harpoon_gun", name: "Harpoon Gun", abilities: ["harpoon_shot", "barbed_line"] },
  void_staff: { id: "void_staff", name: "Undertow Staff", classId: "data_warlock", abilities: ["sink", "pull_of_the_deep"] },
};

/** What a hero can do with nothing in hand. */
export const UNARMED_ABILITIES: string[] = ["punch"];

/** The abilities a weapon gives, by its id; with no weapon (or one that is not known), bare hands. */
export const abilitiesFor = (weapon: string | null | undefined): string[] => (weapon ? WEAPONS[weapon]?.abilities : undefined) ?? UNARMED_ABILITIES;

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
  /** Grows back `amount` HP at the start of each of its turns, unless it has the effect `unless` on it (a troll and fire). */
  regen?: { amount: number; unless: EffectKind; name: string };
}

/** HP a troll grows back at the start of each of its turns, when it is not Burning. */
export const TROLL_REGEN = 3;

export const ENEMIES: Record<string, EnemyDef> = {
  // A training dummy, for a practice map: it soaks up a whole rotation of abilities, barely hits back and never moves.
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
  // A beast bruiser: slow and thick-hided, and every blow lands like a falling tree.
  // Where the Brute stuns with a club, the bear tears (bleeding) and only its roar stuns.
  bear: {
    kind: "bear", name: "Cave Bear", hp: 26, speed: 30, xp: 20,
    attacks: [
      { name: "Mauling Swipe", rolls: 2, pct: 53, damage: 12, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 3 },
      { name: "Roar", rolls: 2, pct: 45, damage: 4, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 1 },
    ],
  },
  // The heaviest thing that walks ashore: very slow, and its club lands like a dropped mast. Its stomp
  // shakes the whole crew and leaves them slow on their feet. A pair's worth on its own, like a bear.
  ogre: {
    kind: "ogre", name: "Ogre", hp: 32, speed: 22, xp: 24,
    attacks: [
      { name: "Club Smash", rolls: 2, pct: 49, damage: 13, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Stomp", rolls: 3, pct: 45, damage: 4, target: "all_heroes", perfect: { effect: "slowed", turns: 2 }, weight: 1 },
    ],
  },
  // A troll: no tougher than a brute to look at, but its wounds close as you watch. It grows back every
  // turn unless it is Burning, so fire (or a lot of damage at once) is how it is put down.
  troll: {
    kind: "troll", name: "Troll", hp: 20, speed: 40, xp: 22,
    regen: { amount: TROLL_REGEN, unless: "burning", name: "Regenerate" },
    attacks: [
      { name: "Rake", rolls: 3, pct: 53, damage: 7, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 3 },
      { name: "Hurl Rock", rolls: 2, pct: 49, damage: 6, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 1 },
    ],
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
  // A beast boss that comes alone: slow, huge, and it tears; its roar can stun the whole crew.
  great_bear: {
    kind: "great_bear", name: "Great Bear", hp: 42, speed: 35, xp: 44, boss: true,
    attacks: [
      { name: "Crushing Maul", rolls: 3, pct: 57, damage: 13, target: "hero", perfect: { effect: "bleeding", turns: 3 }, weight: 3 },
      { name: "Thunderous Roar", rolls: 4, pct: 45, damage: 5, target: "all_heroes", perfect: { effect: "stunned", turns: 1 }, weight: 2 },
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
  // The Haunted Caverns' dead. A shade is quick and weak, and its touch chills (slows) whoever it lays a hand on.
  shade: {
    kind: "shade", name: "Shade", hp: 10, speed: 70, xp: 12,
    attacks: [
      { name: "Chill Touch", rolls: 3, pct: 49, damage: 5, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 3 },
      { name: "Wail", rolls: 3, pct: 45, damage: 3, target: "all_heroes", weight: 1 },
    ],
  },
  // Cave bats: weak alone, but quick, and they come in swarms.
  bat: {
    kind: "bat", name: "Cave Bat", hp: 6, speed: 90, xp: 7,
    attacks: [
      { name: "Bite", rolls: 3, pct: 53, damage: 4, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 3 },
      { name: "Screech", rolls: 3, pct: 45, damage: 2, target: "all_heroes", weight: 1 },
    ],
  },
  // The smugglers' dead, still guarding their camp: slow and steady, and hard to put down.
  skeleton: {
    kind: "skeleton", name: "Skeleton", hp: 15, speed: 45, xp: 14,
    attacks: [
      { name: "Rusted Cutlass", rolls: 3, pct: 53, damage: 7, target: "hero", weight: 3 },
      { name: "Bone Rattle", rolls: 2, pct: 45, damage: 4, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 1 },
    ],
  },
  // A cave slime: very slow and very tough, and its acid leaves its prey exposed (taking more from every hit).
  slime: {
    kind: "slime", name: "Cave Slime", hp: 20, speed: 25, xp: 13,
    attacks: [
      { name: "Engulf", rolls: 3, pct: 49, damage: 6, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 3 },
      { name: "Acid Splash", rolls: 2, pct: 49, damage: 4, target: "hero", perfect: { effect: "exposed", turns: 2 }, weight: 2 },
    ],
  },
  // What is bound in the caverns' deepest chamber, guarding the hoard.
  haunt: {
    kind: "haunt", name: "Haunt", hp: 30, speed: 55, xp: 44, boss: true,
    attacks: [
      { name: "Grave Grasp", rolls: 3, pct: 57, damage: 9, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Keening", rolls: 4, pct: 49, damage: 5, target: "all_heroes", perfect: { effect: "slowed", turns: 2 }, weight: 2 },
    ],
  },
  // ---- what lives out on the atlas's maps ----
  // A hunting spider the size of a hound: quick and frail, its bite leaves venom on the ground, and its web slows
  // whoever it catches from across the way.
  spider: {
    kind: "spider", name: "Giant Spider", hp: 10, speed: 72, xp: 11,
    attacks: [
      { name: "Venomous Bite", rolls: 3, pct: 53, damage: 5, target: "hero", weight: 3 },
      { name: "Web Spit", rolls: 2, pct: 49, damage: 3, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 2 },
    ],
  },
  // What the nest belongs to: a spider the size of a cart, that webs the whole crew at once.
  broodmother: {
    kind: "broodmother", name: "Broodmother", hp: 38, speed: 50, xp: 44, boss: true,
    attacks: [
      { name: "Impaling Fang", rolls: 3, pct: 57, damage: 11, target: "hero", perfect: { effect: "bleeding", turns: 3 }, weight: 3 },
      { name: "Web Spit", rolls: 2, pct: 53, damage: 5, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 2 },
      { name: "Brood Swarm", rolls: 4, pct: 45, damage: 5, target: "all_heroes", perfect: { effect: "slowed", turns: 1 }, weight: 1 },
    ],
  },
  // The frost's wolves: a dire wolf in all but coat, and the cold in its bite slows what it bleeds.
  frost_wolf: {
    kind: "frost_wolf", name: "Frost Wolf", hp: 10, speed: 75, xp: 11,
    attacks: [{ name: "Rime Bite", rolls: 2, pct: 57, damage: 5, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 1 }],
  },
  // The ashlands' hounds, and what they bite catches fire.
  ember_hound: {
    kind: "ember_hound", name: "Ember Hound", hp: 11, speed: 70, xp: 12,
    attacks: [{ name: "Searing Bite", rolls: 2, pct: 57, damage: 5, target: "hero", perfect: { effect: "burning", turns: 2 }, weight: 1 }],
  },
  // A cave bear's white cousin: as slow, as thick-hided, and every bit as cross.
  snow_bear: {
    kind: "snow_bear", name: "Snow Bear", hp: 28, speed: 30, xp: 21,
    attacks: [
      { name: "Mauling Swipe", rolls: 2, pct: 53, damage: 12, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 3 },
      { name: "Roar", rolls: 2, pct: 45, damage: 4, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 1 },
    ],
  },
  // The frost's dead: it keeps its distance, and what its cold reaches is slow to move after.
  wraith: {
    kind: "wraith", name: "Rime Wraith", hp: 11, speed: 60, xp: 14,
    attacks: [
      { name: "Frost Lance", rolls: 3, pct: 53, damage: 6, target: "hero", perfect: { effect: "slowed", turns: 2 }, weight: 3 },
      { name: "Wail", rolls: 3, pct: 45, damage: 3, target: "all_heroes", weight: 1 },
    ],
  },
  // Whoever it is that lives alone in the wood or the fen, and does not care for callers. Thorns from across the
  // clearing, and a hex that leaves whoever it lands on easy to hit.
  witch: {
    kind: "witch", name: "Hedge Witch", hp: 12, speed: 50, xp: 15,
    attacks: [
      { name: "Thorn Hex", rolls: 3, pct: 53, damage: 6, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 3 },
      { name: "Evil Eye", rolls: 2, pct: 45, damage: 4, target: "hero", perfect: { effect: "exposed", turns: 2 }, weight: 2 },
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

/** What wanders the caverns' tunnels, as an even pick. */
export const CAVERN_LEADS = ["shade", "bat", "skeleton", "slime"] as const;
export type CavernLead = (typeof CAVERN_LEADS)[number];

/**
 * A band in the caverns for a party of `party` heroes: one enemy for a lone
 * hero, a pair for a party, a third for a full one. Bats are half an enemy
 * each and come as a swarm.
 */
export function cavernBand(lead: CavernLead, party: number): string[] {
  if (lead === "bat") return ["bat", "bat", ...(party >= 2 ? ["bat"] : []), ...(party >= 4 ? ["bat", "bat"] : [])];
  const second = lead === "skeleton" ? "bat" : lead;
  return [lead, ...(party >= 2 ? [second] : []), ...(party >= 4 ? [lead] : [])];
}

/** What can lead a roaming band. */
export type RoamerLead = "wolf" | "bandit" | "bear" | "ogre";

/**
 * A roaming band for a party of `party` heroes: a lone hero meets one enemy, a
 * party a pair, a full party a third. A bear is a pair's worth on its own, so
 * it comes alone until the party is full, and then with a second. So does an ogre, and what comes with it
 * to a full party is the bandit who keeps it fed.
 */
export function bandKinds(lead: RoamerLead, party: number): string[] {
  if (lead === "bear") return party >= 4 ? ["bear", "bear"] : ["bear"];
  if (lead === "ogre") return party >= 4 ? ["ogre", "bandit"] : ["ogre"];
  return [lead, ...(party >= 2 ? [lead === "bandit" ? "archer" : "wolf"] : []), ...(party >= 4 ? [lead] : [])];
}
