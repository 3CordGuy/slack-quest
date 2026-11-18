// How each ability, enemy attack and thrown thing looks as it goes off:
// what flies (an arrow, a bolt, a flask, a rock out of the sky), what
// strikes all at once (a beam, lightning), what comes up out of the ground,
// and in what colour. The pieces themselves are render/SpellFx.ts; ZoneView
// plays them as the fight's events arrive.

import { ABILITIES, tacticOf, type Throwable } from "@gantt-quest/world";
import type { EruptStyle } from "../render/SpellFx";

export type FxKind =
  /** A blow up close: the attacker lunges and a slash lands. */
  | "melee"
  /** Something flies to each target and lands. */
  | "arrow"
  | "bolt"
  /** A thunderclap: crescents of sound and light racing out to each target. */
  | "thunder"
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
}

const fx = (kind: FxKind, color: string, style?: EruptStyle): Fx => ({ kind, color, ...(style ? { style } : {}) });

const ABILITY_FX: Record<string, Fx> = {
  torch_swing: fx("melee", "#ff8a2a"),
  falling_star: fx("meteor", "#ffcf5a"),
  constellation: fx("beam", "#bcd7ff"),
  new_moon: fx("ring", "#9aa7ff"),
  chart_a_course: fx("bless", "#ff4d4d"),
  north_star: fx("bless", "#ffd166"),
  shock: fx("spark", "#c4b5fd"),
  sturdy_blow: fx("melee", "#c9b48a"),
  stand_strong: fx("bless", "#9ec9ff"),
  disarming_chop: fx("melee", "#93c5fd"),
  raise_guard: fx("bless", "#fbbf24"),
  goading_strike: fx("melee", "#ff6b6b"),
  throw_pike: fx("arrow", "#c9d6e8"),
  starbeam: fx("beam", "#fff3a8"),
  moonlight: fx("erupt", "#bcd7ff", "shine"),
  focus_light: fx("beam", "#fff3a8"),
  st_elmos_fire: fx("bless", "#ffd166"),
  water_burst: fx("bolt", "#38bdf8"),
  rust_armor: fx("erupt", "#c0642c", "rust"),
  bow_shot: fx("arrow", "#e8dcc0"),
  snag: fx("arrow", "#a78bfa"),
  take_aim: fx("bless", "#ffe08a"),
  slicing_wind: fx("blade", "#dff4ff"),
  waterbolt: fx("bolt", "#38bdf8"),
  lightning_strike: fx("storm", "#ffe98a"),
  winds_blessing: fx("bless", "#bfe8ff"),
  dissonance: fx("bolt", "#c4a7ff"),
  hex: fx("bolt", "#e879f9"),
  soul_drain: fx("bolt", "#e879f9"),
  sink: fx("bolt", "#2fa4c9"),
  vile_splash: fx("lob", "#84cc16"),
  drink_deeply: fx("bless", "#6dff9e"),
  pull_of_the_deep: fx("ring", "#1f7fa0"),
  thornlash: fx("erupt", "#4f8a3a", "thorn"),
  sea_slash: fx("melee", "#38bdf8"),
  binding_kelp: fx("erupt", "#4ade80", "kelp"),
  coral_burst: fx("erupt", "#ff8f7a", "coral"),
  restore: fx("bless", "#5eead4"),
  cleave: fx("ring", "#dfe9ff"),
  beacon_aura: fx("bless", "#fff7d6"),
  healing_aura: fx("bless", "#5dffa0"),
  branding_strike: fx("melee", "#ff7a2a"),
  stoke_the_fire: fx("ring", "#ff7a2a"),
  bolster: fx("ring", "#9ec9ff"),
  soothing_rain: fx("rain", "#8fd3ff"),
  chain_lightning: fx("spark", "#c4b5fd"),
  roar_of_thunder: fx("thunder", "#facc15"),
  trade_winds: fx("lob", "#d9f2e6"),
  tidal_wave: fx("wave", "#38bdf8"),
  show_the_way: fx("bless", "#fff4c2"),
  smugglers_route: fx("bless", "#a78bfa"),
  sneak: fx("bless", "#b8c4d6"),
  pickpocket: fx("melee", "#ffd23f"),
  tactical_retreat: fx("melee", "#ff6b6b"),
  contraband: fx("bless", "#ff8a3a"),
  lively_shanty: fx("ring", "#ffb020"),
  dour_shanty: fx("ring", "#6f8fff"),
  windgod_shanty: fx("ring", "#3fe0c5"),
  chorus: fx("lob", "#ff6fa8"),
  lead_by_example: fx("bolt", "#ffe08a"),
  against_the_waves: fx("bless", "#5fb8ff"),
  overwhelm: fx("melee", "#ff9a4a"),
  fortify: fx("erupt", "#c9b48a", "stone"),
  bulwark_strike: fx("melee", "#93c5fd"),
  taunt: fx("ring", "#ff5a3c"),
  mend: fx("bless", "#7dff9a"),
  coral_field: fx("erupt", "#ff7f6e", "coral"),
  aqueous_regeneration: fx("bless", "#5eead4"),
  coral_armor: fx("bless", "#ff8f7a"),
  revitalizing_splash: fx("lob", "#7dffd4"),
  summon_sea_turtle: fx("bless", "#4fb286"),
  curse_of_drowning: fx("bolt", "#2fa4c9"),
  summon_sunken_sailors: fx("bless", "#5fe0c0"),
  red_sky_at_morning: fx("lob", "#e2483d"),
  unholy_waters: fx("erupt", "#2fa4c9", "water"),
  the_black_spot: fx("bolt", "#7a6a8f"),
  sailor_pistol: fx("bolt", "#ffd23f"),
  sailor_scimitar: fx("melee", "#9fb59a"),
  turtle_bite: fx("melee", "#4fb286"),
  rejuvenate: fx("bless", "#a3e635"),
  encore: fx("bless", "#7dff9a"),
  blasting_tone: fx("beam", "#ff6b6b"),
  soothing_tone: fx("bless", "#5eead4"),
  peal: fx("bolt", "#ffd23f"),
  clarion_call: fx("bless", "#ffd23f"),
  recover: fx("bless", "#ffd23f"),
  block: fx("bless", "#c9d6e8"),
};

/** Guards: shown as a wall of light round whoever puts one up. */
export const GUARDS = new Set(["block", "raise_guard", "stand_strong", "against_the_waves", "coral_armor"]);
/** Auras: a ring rolls out over the allies they reach. */
export const AURA_ABILITIES = new Set(["beacon_aura", "healing_aura"]);
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
export const aimKind = (what: string): "arrow" | "spell" => (fxFor(what).kind === "arrow" ? "arrow" : "spell");
