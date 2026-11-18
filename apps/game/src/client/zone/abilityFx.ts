// How each ability, enemy attack and thrown thing looks as it goes off:
// what flies (an arrow, a bolt, a flask, a rock out of the sky), what
// strikes all at once (a beam, lightning), what comes up out of the ground,
// and in what colour. The pieces themselves are render/SpellFx.ts; ZoneView
// plays them as the fight's events arrive.

import { ABILITIES, tacticOf, type Throwable } from "@gantt-quest/world";

export type FxKind =
  /** A blow up close: the attacker lunges and a slash lands. */
  | "melee"
  /** Something flies to each target and lands. */
  | "arrow"
  | "bolt"
  /** Lightning from the caster through each target in turn. */
  | "spark"
  /** A rock falls on the hex aimed at. */
  | "meteor"
  /** Lightning out of the sky onto the hex aimed at. */
  | "storm"
  /** A bolt to the hex aimed at, then a ring rolling out from it. */
  | "lob"
  /** A beam along the line. */
  | "beam"
  /** Spikes out of the ground under everything it covers. */
  | "erupt"
  /** A ring rolling out from the user. */
  | "ring"
  /** Motes of light rising off whoever is helped. */
  | "bless";

export interface Fx {
  kind: FxKind;
  color: string;
}

const fx = (kind: FxKind, color: string): Fx => ({ kind, color });

const ABILITY_FX: Record<string, Fx> = {
  firebolt: fx("bolt", "#ff7a2a"),
  torch_swing: fx("melee", "#ff8a2a"),
  hex_bolt: fx("bolt", "#a78bfa"),
  manifest: fx("bolt", "#67e8f9"),
  plot_the_course: fx("bolt", "#facc15"),
  dissonance: fx("bolt", "#c4a7ff"),
  hex: fx("bolt", "#e879f9"),
  soul_drain: fx("bolt", "#e879f9"),
  red_tide: fx("bolt", "#e23b3b"),
  aimed_shot: fx("arrow", "#e8dcc0"),
  pin_down: fx("arrow", "#a78bfa"),
  thornlash: fx("erupt", "#4f8a3a"),
  overgrowth: fx("erupt", "#4f8a3a"),
  chain_spark: fx("spark", "#8fd3ff"),
  thunderhead: fx("storm", "#ffe98a"),
  meteor: fx("meteor", "#ff7a2a"),
  blight: fx("lob", "#84cc16"),
  riptide: fx("beam", "#38bdf8"),
  lighthouse_beam: fx("beam", "#ffe9a8"),
  cacophony: fx("ring", "#ff6b6b"),
  cleave: fx("ring", "#dfe9ff"),
  beacon_aura: fx("bless", "#ffe9a8"),
  healing_aura: fx("bless", "#7dff9a"),
  branding_strike: fx("melee", "#ff7a2a"),
  stoke_the_fire: fx("ring", "#ff7a2a"),
  bolster: fx("ring", "#9ec9ff"),
  soothing_rain: fx("lob", "#8fd3ff"),
  chain_lightning: fx("spark", "#c4b5fd"),
  roar_of_thunder: fx("bolt", "#facc15"),
  trade_winds: fx("lob", "#d9f2e6"),
  tidal_wave: fx("beam", "#38bdf8"),
  show_the_way: fx("bless", "#fff4c2"),
  smugglers_route: fx("bless", "#a78bfa"),
  sneak: fx("bless", "#b8c4d6"),
  pickpocket: fx("melee", "#ffd23f"),
  tactical_retreat: fx("melee", "#ff6b6b"),
  contraband: fx("bless", "#ff8a3a"),
  shockwave: fx("ring", "#a78bfa"),
  mend: fx("bless", "#7dff9a"),
  rejuvenate: fx("bless", "#a3e635"),
  encore: fx("bless", "#7dff9a"),
  all_hands: fx("bless", "#ffd23f"),
  shield_wall: fx("bless", "#93c5fd"),
  hold_the_line: fx("bless", "#fbbf24"),
  arcane_ward: fx("bless", "#a78bfa"),
};

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
