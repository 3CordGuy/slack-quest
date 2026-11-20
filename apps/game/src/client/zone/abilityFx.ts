// How each ability, enemy attack and thrown thing looks as it goes off:
// what flies (an arrow, a bolt, a flask, a rock out of the sky), what
// strikes all at once (a beam, lightning), what comes up out of the ground,
// and in what colour. The pieces themselves are render/SpellFx.ts; ZoneView
// plays them as the fight's events arrive.

import { ABILITIES, tacticOf, type Throwable } from "@gantt-quest/world";
import type { EruptStyle, SongMood, SoundKind } from "../render/SpellFx";

export type FxKind =
  /** A blow up close: the attacker lunges and a slash lands. */
  | "melee"
  /** Something flies to each target and lands. */
  | "arrow"
  | "bolt"
  /** A thunderclap: crescents of sound and light racing out to each target. */
  | "thunder"
  /** A blow of sound: crescents racing to each target with notes in their wake (see SOUND_KIND for how each sounds). */
  | "sound"
  /** A blast of sound down a line. */
  | "blast"
  /** A roar of voices converging on the hex aimed at and bursting there. */
  | "chorus"
  /** A shanty struck up round the singer, and notes off them for as long as it lasts (see SONG_MOOD). */
  | "song"
  /** A bolt to each target, and their life pulled back along an arc into the caster (Soul Drain). */
  | "drain"
  /** A bolt to each target, and a curse's spiral flaring on the ground under them (Hex). */
  | "hex"
  /** A weight of black water dropped on each target (Sink). */
  | "sink"
  /** A bolt to each target, and bubbles and a spiral of water winding up round them (Curse of Drowning). */
  | "drown"
  /** A flask thrown at each target, breaking on them (Vile Splash). */
  | "flask"
  /** The Black Spot slammed onto the one aimed at, and held over them while they carry it. */
  | "spot"
  /** A whirlpool round the user, dragging everything beside them in (Pull of the Deep). */
  | "whirl"
  /** The sky over the hex aimed at turned red (Red Sky at Morning). */
  | "omen"
  /** A pike hurled at each target, and a rope left strung to them as they are hauled in (Throw Pike). */
  | "pike"
  /** A bellowed challenge all round the user, and a "!" over each enemy it reaches (Taunt). */
  | "taunt"
  /** The user thrown bodily at the one aimed at, slamming into them (Overwhelm). */
  | "charge"
  /** A lighthouse's beams sweeping round the user for as long as their Beacon lasts. */
  | "beacon"
  /** A healing ring on the ground round the user for as long as it lasts. */
  | "aura"
  /** A ward going up round the user and every ally in reach (Bolster). */
  | "bolster"
  /** Flames bursting off the user all round (Stoke the Fire). */
  | "nova"
  /** A wide crescent swept through the hexes beside the user (Cleave). */
  | "sweep"
  /** A path of light laid to the ally helped (Show the Way). */
  | "way"
  /** A gaff hook thrown on a line at each target, and yanked back (Snag). */
  | "hook"
  /** A fire bomb tossed to the ally aimed at, and one popped into the user's own hand (Contraband). */
  | "bomb"
  /** A ring closing in round the user like a sight narrowing (Take Aim). */
  | "aim"
  /** A harpoon fired from a gun on a line at each target: hauling them in (Harpoon Shot) or reeled back (Barbed Line). */
  | "harpoon"
  /** Every Guiding Light put out at once: a crescent moon over each enemy that was lit (New Moon). */
  | "snuff"
  /** A red flare shot onto the hex marked (Chart a Course). */
  | "chart"
  /** Starfire on the ally helped, lasting while it does (North Star, St Elmo's Fire). */
  | "starfire"
  /** A bolt of seawater bursting on each target and spraying the enemies beside it (Water Burst). */
  | "drench"
  /** A gust of wind sweeping over the hexes it covers (Trade Winds). */
  | "gust"
  /** A wave of healing rolling over the hexes it covers, healing each ally as it reaches them (Revitalizing Splash). */
  | "healwave"
  /** A blare of sound bursting all round the player (Bellows Blast). */
  | "blare"
  /** A crescent blade of wind flying to each target. */
  | "blade"
  /** Lightning out of the sky onto each target, arcing from one to the next. */
  | "spark"
  /** A rock falls on the hex aimed at. */
  | "meteor"
  /** A bolt of lightning out of the sky onto the hex aimed at. */
  | "storm"
  /** A rain cloud gathering over the hex aimed at (the cloud itself is drawn with the weather, TacticsLayer). */
  | "rain"
  /** A bolt to the hex aimed at, then a ring rolling out from it. */
  | "lob"
  /** A beam along the line. */
  | "beam"
  /** A wave of water rolling out along the line, striking each one as it reaches them. */
  | "wave"
  /** Something out of the ground under everything it covers (thorns, coral, stone, water, light, rust: see `style`). */
  | "erupt"
  /** A ring rolling out from the user. */
  | "ring"
  /** Motes of light rising off whoever is helped. */
  | "bless";

export interface Fx {
  kind: FxKind;
  color: string;
  /** For an eruption, what comes up out of the ground. */
  style?: EruptStyle;
  /** A heal or blessing that is sung (the Bard's): music notes rise through it rather than motes. */
  notes?: boolean;
}

const fx = (kind: FxKind, color: string, style?: EruptStyle): Fx => ({ kind, color, ...(style ? { style } : {}) });
/** A heal or blessing sung by a Bard. */
const sung = (color: string): Fx => ({ kind: "bless", color, notes: true });

/** How each shanty's notes move. */
export const SONG_MOOD: Record<string, SongMood> = { lively_shanty: "lively", dour_shanty: "dour", windgod_shanty: "wind" };
/**
 * What a blow by hand leaves as it lands, besides its slash: a shield gone up round the one who struck (they gain one,
 * hit or miss), steel sparks off the target, a "!" over it (it is goaded into coming at them), flames on it (it is set
 * alight), or a thud of dust at its feet.
 */
export const FLOURISH: Record<string, "shield" | "sparks" | "goad" | "brand" | "thud" | "coins" | "cross"> = {
  sturdy_blow: "shield",
  bulwark_strike: "shield",
  disarming_chop: "sparks",
  goading_strike: "goad",
  // The Paladin's: a searing blow sets them alight; a mace's heavy blow thuds into the ground; a blow at the joints of armor strikes sparks.
  branding_strike: "brand",
  bash: "thud",
  armor_crush: "sparks",
  // The Rogue's: a cut and a quick hand lifts gold; both knives at once cross their cuts.
  pickpocket: "coins",
  eviscerate: "cross",
};

/** How each blow of sound lands: heavy, ringing like a bell, or out of tune. Plain for any not here. */
export const SOUND_KIND: Record<string, SoundKind> = { lead_by_example: "heavy", peal: "bell", dissonance: "discord" };

const ABILITY_FX: Record<string, Fx> = {
  torch_swing: fx("melee", "#ff8a2a"),
  falling_star: fx("meteor", "#ffcf5a"),
  constellation: fx("beam", "#bcd7ff"),
  new_moon: fx("snuff", "#9aa7ff"),
  chart_a_course: fx("chart", "#ff4d4d"),
  north_star: fx("starfire", "#ffd166"),
  shock: fx("spark", "#c4b5fd"),
  sturdy_blow: fx("melee", "#c9b48a"),
  stand_strong: fx("bless", "#9ec9ff"),
  disarming_chop: fx("melee", "#93c5fd"),
  raise_guard: fx("bless", "#5fb8ff"),
  goading_strike: fx("melee", "#ff6b6b"),
  throw_pike: fx("pike", "#c9d6e8"),
  starbeam: fx("beam", "#fff3a8"),
  moonlight: fx("erupt", "#bcd7ff", "shine"),
  focus_light: fx("beam", "#fff3a8"),
  st_elmos_fire: fx("starfire", "#9fd8ff"),
  water_burst: fx("drench", "#38bdf8"),
  rust_armor: fx("erupt", "#c0642c", "rust"),
  bow_shot: fx("arrow", "#e8dcc0"),
  pistol_shot: fx("bolt", "#ffd23f"),
  pistol_whip: fx("melee", "#c9b48a"),
  scattershot: fx("erupt", "#ffb347"),
  butt_stroke: fx("melee", "#c9b48a"),
  harpoon_shot: fx("harpoon", "#c9d6e8"),
  barbed_line: fx("harpoon", "#a78bfa"),
  snag: fx("hook", "#a78bfa"),
  take_aim: fx("aim", "#ffe08a"),
  slicing_wind: fx("blade", "#dff4ff"),
  waterbolt: fx("bolt", "#38bdf8"),
  lightning_strike: fx("storm", "#ffe98a"),
  winds_blessing: fx("bless", "#bfe8ff"),
  dissonance: fx("sound", "#c4a7ff"),
  hex: fx("hex", "#c07cf0"),
  soul_drain: fx("drain", "#e879f9"),
  sink: fx("sink", "#2fa4c9"),
  vile_splash: fx("flask", "#84cc16"),
  drink_deeply: fx("bless", "#6dff9e"),
  pull_of_the_deep: fx("whirl", "#1f7fa0"),
  thornlash: fx("erupt", "#4f8a3a", "thorn"),
  sea_slash: fx("melee", "#38bdf8"),
  binding_kelp: fx("erupt", "#4ade80", "kelp"),
  coral_burst: fx("erupt", "#ff8f7a", "coral"),
  restore: fx("bless", "#5eead4"),
  cleave: fx("sweep", "#dfe9ff"),
  beacon_aura: fx("beacon", "#ffe9a8"),
  healing_aura: fx("aura", "#5dffa0"),
  branding_strike: fx("melee", "#ff7a2a"),
  stoke_the_fire: fx("nova", "#ff7a2a"),
  bolster: fx("bolster", "#9ec9ff"),
  soothing_rain: fx("rain", "#8fd3ff"),
  chain_lightning: fx("spark", "#c4b5fd"),
  roar_of_thunder: fx("thunder", "#facc15"),
  trade_winds: fx("gust", "#d9f2e6"),
  tidal_wave: fx("wave", "#38bdf8"),
  show_the_way: fx("way", "#fff4c2"),
  smugglers_route: fx("bless", "#a78bfa"),
  sneak: fx("bless", "#b8c4d6"),
  pickpocket: fx("melee", "#ffd23f"),
  tactical_retreat: fx("melee", "#ff6b6b"),
  contraband: fx("bomb", "#ff8a3a"),
  stab: fx("melee", "#dfe9ff"),
  eviscerate: fx("melee", "#ff8a8a"),
  tear: fx("melee", "#c9b48a"),
  lively_shanty: fx("song", "#ffb020"),
  dour_shanty: fx("song", "#6f8fff"),
  windgod_shanty: fx("song", "#3fe0c5"),
  chorus: fx("chorus", "#ff6fa8"),
  lead_by_example: fx("sound", "#ffe08a"),
  against_the_waves: fx("bless", "#fbbf24"),
  overwhelm: fx("charge", "#ff9a4a"),
  fortify: fx("erupt", "#c9b48a", "stone"),
  bulwark_strike: fx("melee", "#93c5fd"),
  taunt: fx("taunt", "#ff5a3c"),
  mend: fx("bless", "#7dff9a"),
  coral_field: fx("erupt", "#ff7f6e", "coral"),
  aqueous_regeneration: fx("bless", "#5eead4"),
  coral_armor: fx("bless", "#ff8f7a"),
  revitalizing_splash: fx("healwave", "#5eead4"),
  summon_sea_turtle: fx("bless", "#4fb286"),
  curse_of_drowning: fx("drown", "#2fa4c9"),
  summon_sunken_sailors: fx("bless", "#5fe0c0"),
  red_sky_at_morning: fx("omen", "#e2483d"),
  unholy_waters: fx("erupt", "#2fa4c9", "water"),
  the_black_spot: fx("spot", "#7a6a8f"),
  sailor_pistol: fx("bolt", "#ffd23f"),
  sailor_scimitar: fx("melee", "#9fb59a"),
  turtle_bite: fx("melee", "#4fb286"),
  rejuvenate: fx("bless", "#a3e635"),
  encore: sung("#7dff9a"),
  blasting_tone: fx("blast", "#ff6b6b"),
  soothing_tone: sung("#5eead4"),
  bellows_blast: fx("blare", "#f97316"),
  hornpipe: sung("#facc15"),
  peal: fx("sound", "#ffd23f"),
  clarion_call: sung("#ffd23f"),
  recover: fx("bless", "#ffd23f"),
  block: fx("bless", "#c9d6e8"),
};

/** Guards: shown as a wall of light round whoever puts one up. */
export const GUARDS = new Set(["block", "raise_guard", "stand_strong", "against_the_waves", "coral_armor"]);
/** Calls for help: water breaks where the help comes up. */
export const SUMMONS = new Set(["summon_sea_turtle", "summon_sunken_sailors"]);

/** What enemies shoot and cast, by the attack's own name. Anything not here is a blow up close, or (an attack on every hero) a ring. */
const ENEMY_FX: Record<string, Fx> = {
  Volley: fx("arrow", "#e8dcc0"),
  "Barbed Arrow": fx("arrow", "#e8dcc0"),
  "Dark Bolt": fx("bolt", "#a78bfa"),
  Immolate: fx("bolt", "#ff7a2a"),
  "Acid Splash": fx("bolt", "#84cc16"),
};

/** How a hero's ability (by id) or an enemy's attack (by name) looks. `burst` says an enemy attack was on every hero at once. */
export function fxFor(what: string, burst = false): Fx {
  if (ABILITIES[what]) return ABILITY_FX[what] ?? fx(tacticOf(what).reach === "melee" ? "melee" : "bolt", "#dfe9ff");
  return ENEMY_FX[what] ?? fx(burst ? "ring" : "melee", "#ff6b6b");
}

/** The colour of each thing thrown, in the air and where it breaks. */
export const THROW_COLOR: Record<Throwable, string> = { healing: "#ff6b6b", poison: "#84cc16", fire: "#ff7a2a", oil: "#8a7f6a", water: "#38bdf8", acid: "#d9f99d", slime: "#65a30d", torch: "#ffb070" };

/** How high a shot or a spell arcs when it is aimed, as SpellFx flies it. */
export const aimKind = (what: string): "arrow" | "spell" => (["arrow", "pike", "hook", "harpoon"].includes(fxFor(what).kind) ? "arrow" : "spell");
