// Which picture each thing on a fight's bar gets: an ability, a common
// action, an item from the pack. The drawings are in actionArt.ts. Weapon
// abilities share a handful, told apart by their accent colour; every class
// ability has a picture of its own (a test holds them to it).

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
  bash: icon("heavy", "#ffd23f"),
  recover: icon("heal", "#ffd23f"),
  block: icon("shield", "#c9d6e8"),
  flail_strike: icon("slash", "#4ade80"),
  armor_crush: icon("heavy", "#b0a48a"),
  cleave: icon("cleave", "#ff6b6b"),
  beacon_aura: icon("beacon", "#fff7d6"),
  healing_aura: icon("healing-aura", "#5dffa0"),
  branding_strike: icon("brand", "#ff7a2a"),
  stoke_the_fire: icon("stoke", "#ff5a2a"),
  bolster: icon("bolster", "#9ec9ff"),
  soothing_rain: icon("rain", "#8fd3ff"),
  chain_lightning: icon("chain-lightning", "#c4b5fd"),
  roar_of_thunder: icon("thunder", "#facc15"),
  trade_winds: icon("winds", "#d9f2e6"),
  tidal_wave: icon("tidal", "#38bdf8"),
  show_the_way: icon("signpost", "#fff4c2"),
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
  smugglers_route: icon("route", "#a78bfa"),
  sneak: icon("sneak", "#b8c4d6"),
  pickpocket: icon("pickpocket", "#ffd23f"),
  tactical_retreat: icon("retreat", "#ff6b6b"),
  contraband: icon("contraband", "#ff8a3a"),
  // Druid
  thornlash: icon("thorn", "#ff8fb1"),
  rejuvenate: icon("heal", "#a3e635"),
  overgrowth: icon("thorn", "#facc15"),
  riptide: icon("wave", "#38bdf8"),
  coral_field: icon("coral", "#ff7f6e"),
  aqueous_regeneration: icon("droplet", "#5eead4"),
  coral_armor: icon("shell", "#ff8f7a"),
  revitalizing_splash: icon("splash", "#7dffd4"),
  summon_sea_turtle: icon("turtle", "#4fb286"),
  turtle_bite: icon("fist", "#4fb286"),
  // Bard
  lively_shanty: icon("shanty-lively", "#ffb020"),
  dour_shanty: icon("shanty-dour", "#6f8fff"),
  windgod_shanty: icon("shanty-wind", "#3fe0c5"),
  chorus: icon("chorus", "#ff6fa8"),
  lead_by_example: icon("banner", "#ffe08a"),
  dissonance: icon("note", "#a78bfa"),
  encore: icon("note", "#7dff9a"),
  cacophony: icon("note", "#ff6b6b"),
  all_hands: icon("bell", "#ff6b6b"),
  // Sage
  manifest: icon("bolt", "#67e8f9"),
  arcane_ward: icon("shield", "#a78bfa"),
  meteor: icon("meteor", "#ff5a2a"),
  plot_the_course: icon("bolt", "#facc15"),
  falling_star: icon("falling-star", "#ffcf5a"),
  constellation: icon("constellation", "#bcd7ff"),
  new_moon: icon("new-moon", "#9aa7ff"),
  chart_a_course: icon("chart", "#ff4d4d"),
  north_star: icon("north-star", "#ffd166"),
  // Warden
  seawall_blow: icon("heavy", "#93c5fd"),
  challenge: icon("shout", "#ff6b6b"),
  hold_the_line: icon("shield", "#fbbf24"),
  shockwave: icon("quake", "#a78bfa"),
  lighthouse_beam: icon("beam", "#ffd23f"),
  against_the_waves: icon("breakwater", "#5fb8ff"),
  overwhelm: icon("overwhelm", "#ff9a4a"),
  fortify: icon("fortify", "#c9b48a"),
  bulwark_strike: icon("bulwark", "#93c5fd"),
  taunt: icon("taunt", "#ff5a3c"),
  // Warlock
  hex: icon("skull", "#e879f9"),
  soul_drain: icon("drain", "#e879f9"),
  blight: icon("skull", "#84cc16"),
  red_tide: icon("wave", "#e23b3b"),
  curse_of_drowning: icon("drown-curse", "#2fa4c9"),
  summon_sunken_sailors: icon("sailors", "#5fe0c0"),
  red_sky_at_morning: icon("red-sky", "#e2483d"),
  unholy_waters: icon("unholy", "#2fa4c9"),
  the_black_spot: icon("black-spot", "#7a6a8f"),
  // The sunken sailors' own
  sailor_pistol: icon("pistol", "#ffd23f"),
  sailor_scimitar: icon("slash", "#9fb59a"),
};

export const abilityIcon = (id: string): ActionIcon => ABILITY_ICON[id] ?? ABILITY_ICON.punch;

export const COMMON_ICON: Record<CommonAction, ActionIcon> = {
  dash: icon("dash", "#facc15"),
  disengage: icon("disengage", "#8fd3ff"),
  jump: icon("jump", "#7dff9a"),
  shove: icon("shove", "#ff8a3a"),
  help: icon("help", "#7dff9a"),
  flee: icon("flee", "#ffd98a"),
  join: icon("note", "#ffe08a"),
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
