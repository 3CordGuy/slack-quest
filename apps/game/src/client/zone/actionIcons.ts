// Which picture each thing on a fight's bar gets: an ability, a common
// action, an item from the pack. The drawings are in actionArt.ts; several
// abilities share one, told apart by their accent colour.

import type { CommonAction, Throwable } from "@gantt-quest/world";

export interface ActionIcon {
  name: string;
  color: string;
}

const icon = (name: string, color: string): ActionIcon => ({ name: `act-${name}`, color });

export const ABILITY_ICON: Record<string, ActionIcon> = {
  punch: icon("fist", "#8a5a2b"),
  torch_swing: { name: "item-torch", color: "#ffb070" },
  // Paladin
  smite: icon("slash", "#ffd23f"),
  shield_wall: icon("shield", "#3f6fa8"),
  cleave: icon("cleave", "#ff6b6b"),
  heavy_blow: icon("heavy", "#ff8a3a"),
  full_reckoning: icon("slash", "#e879f9"),
  beacon_aura: icon("beam", "#ffe9a8"),
  healing_aura: icon("heal", "#ffd23f"),
  branding_strike: icon("heavy", "#ff7a2a"),
  stoke_the_fire: icon("fire", "#ff5a2a"),
  bolster: icon("shield", "#9ec9ff"),
  soothing_rain: icon("heal", "#8fd3ff"),
  chain_lightning: icon("spark", "#c4b5fd"),
  roar_of_thunder: icon("shout", "#facc15"),
  trade_winds: icon("dash", "#d9f2e6"),
  tidal_wave: icon("wave", "#38bdf8"),
  show_the_way: icon("beam", "#fff4c2"),
  // Mage
  firebolt: icon("fire", "#fff1c9"),
  mend: icon("heal", "#7dff9a"),
  chain_spark: icon("spark", "#8fd3ff"),
  hex_bolt: icon("bolt", "#a78bfa"),
  thunderhead: icon("spark", "#ffffff"),
  // Rogue
  quick_stab: icon("dagger", "#ff6b6b"),
  flurry: icon("flurry", "#facc15"),
  aimed_shot: icon("bow", "#7dff9a"),
  pin_down: icon("bow", "#a78bfa"),
  land_the_catch: icon("hook", "#38bdf8"),
  smugglers_route: icon("jump", "#a78bfa"),
  sneak: icon("disengage", "#b8c4d6"),
  pickpocket: icon("hook", "#ffd23f"),
  tactical_retreat: icon("flee", "#ff6b6b"),
  contraband: { name: "item-bomb", color: "#ff8a3a" },
  // Druid
  thornlash: icon("thorn", "#ff8fb1"),
  rejuvenate: icon("heal", "#a3e635"),
  overgrowth: icon("thorn", "#facc15"),
  riptide: icon("wave", "#38bdf8"),
  coral_field: icon("thorn", "#ff7f6e"),
  aqueous_regeneration: icon("heal", "#5eead4"),
  coral_armor: icon("shield", "#ff8f7a"),
  revitalizing_splash: icon("wave", "#7dffd4"),
  summon_sea_turtle: icon("help", "#4fb286"),
  turtle_bite: icon("fist", "#4fb286"),
  // Bard
  dissonance: icon("note", "#a78bfa"),
  encore: icon("note", "#7dff9a"),
  cacophony: icon("note", "#ff6b6b"),
  all_hands: icon("bell", "#ff6b6b"),
  // Sage
  manifest: icon("bolt", "#67e8f9"),
  arcane_ward: icon("shield", "#a78bfa"),
  meteor: icon("meteor", "#ff5a2a"),
  plot_the_course: icon("bolt", "#facc15"),
  // Warden
  bulwark_strike: icon("heavy", "#93c5fd"),
  taunt: icon("shout", "#ff6b6b"),
  hold_the_line: icon("shield", "#fbbf24"),
  shockwave: icon("quake", "#a78bfa"),
  lighthouse_beam: icon("beam", "#ffd23f"),
  // Warlock
  hex: icon("skull", "#e879f9"),
  soul_drain: icon("drain", "#e879f9"),
  blight: icon("skull", "#84cc16"),
  red_tide: icon("wave", "#e23b3b"),
};

export const abilityIcon = (id: string): ActionIcon => ABILITY_ICON[id] ?? ABILITY_ICON.punch;

export const COMMON_ICON: Record<CommonAction, ActionIcon> = {
  dash: icon("dash", "#facc15"),
  disengage: icon("disengage", "#8fd3ff"),
  jump: icon("jump", "#7dff9a"),
  shove: icon("shove", "#ff8a3a"),
  help: icon("help", "#7dff9a"),
  flee: icon("flee", "#ffd98a"),
};

export const ITEM_ICON: Record<Throwable, ActionIcon> = {
  healing: { name: "item-flask", color: "#e0453a" },
  poison: { name: "item-flask", color: "#84cc16" },
  fire: { name: "item-bomb", color: "#ff5a2a" },
  oil: { name: "item-flask", color: "#57534e" },
  water: { name: "item-waterskin", color: "#38bdf8" },
  acid: { name: "item-flask", color: "#bef264" },
  slime: { name: "item-flask", color: "#4d7c0f" },
  torch: { name: "item-torch", color: "#ffb070" },
};
