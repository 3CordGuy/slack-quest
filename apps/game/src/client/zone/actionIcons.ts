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
  shock: icon("spark", "#c4b5fd"),
  mend: icon("heal", "#7dff9a"),
  stab: icon("dagger", "#ff6b6b"),
  eviscerate: icon("flurry", "#e23b3b"),
  bow_shot: icon("bow", "#7dff9a"),
  take_aim: icon("bow", "#ffe08a"),
  tear: icon("hook", "#38bdf8"),
  snag: icon("hook", "#a78bfa"),
  slicing_wind: icon("slash", "#dff4ff"),
  winds_blessing: icon("heal", "#bfe8ff"),
  waterbolt: icon("bolt", "#38bdf8"),
  lightning_strike: icon("spark", "#ffe98a"),
  // Rogue
  smugglers_route: icon("route", "#a78bfa"),
  sneak: icon("sneak", "#b8c4d6"),
  pickpocket: icon("pickpocket", "#ffd23f"),
  tactical_retreat: icon("retreat", "#ff6b6b"),
  contraband: icon("contraband", "#ff8a3a"),
  // Druid
  thornlash: icon("thorn", "#ff8fb1"),
  rejuvenate: icon("heal", "#a3e635"),
  sea_slash: icon("slash", "#38bdf8"),
  binding_kelp: icon("thorn", "#4ade80"),
  coral_burst: icon("wave", "#ff8f7a"),
  restore: icon("heal", "#5eead4"),
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
  blasting_tone: icon("note", "#ff6b6b"),
  soothing_tone: icon("note", "#5eead4"),
  bellows_blast: icon("shout", "#f97316"),
  hornpipe: icon("dash", "#facc15"),
  peal: icon("bell", "#a78bfa"),
  clarion_call: icon("bell", "#ffd23f"),
  // Sage
  starbeam: icon("bolt", "#fff3a8"),
  moonlight: icon("bolt", "#bcd7ff"),
  focus_light: icon("spark", "#fff3a8"),
  st_elmos_fire: icon("spark", "#ffd166"),
  water_burst: icon("wave", "#38bdf8"),
  rust_armor: icon("heavy", "#b0a48a"),
  falling_star: icon("falling-star", "#ffcf5a"),
  constellation: icon("constellation", "#bcd7ff"),
  new_moon: icon("new-moon", "#9aa7ff"),
  chart_a_course: icon("chart", "#ff4d4d"),
  north_star: icon("north-star", "#ffd166"),
  // Warden
  sturdy_blow: icon("heavy", "#c9b48a"),
  stand_strong: icon("shield", "#9ec9ff"),
  disarming_chop: icon("heavy", "#93c5fd"),
  raise_guard: icon("shield", "#fbbf24"),
  goading_strike: icon("shout", "#ff6b6b"),
  throw_pike: icon("hook", "#c9d6e8"),
  against_the_waves: icon("breakwater", "#5fb8ff"),
  overwhelm: icon("overwhelm", "#ff9a4a"),
  fortify: icon("fortify", "#c9b48a"),
  bulwark_strike: icon("bulwark", "#93c5fd"),
  taunt: icon("taunt", "#ff5a3c"),
  // Warlock
  hex: icon("skull", "#e879f9"),
  soul_drain: icon("drain", "#e879f9"),
  sink: icon("drain", "#2fa4c9"),
  vile_splash: icon("wave", "#6dff9e"),
  drink_deeply: icon("heal", "#6dff9e"),
  pull_of_the_deep: icon("skull", "#1f7fa0"),
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

/** A lodestone's picture, by how much it carries: a plain one is dull, and the vein brightens with each thing more. */
export const STONE_ICON = (carries: number): ActionIcon => ({ name: "item-lodestone", color: ["#8ea0b5", "#4fa8ff", "#7fd4ff", "#d6f4ff"][Math.min(3, Math.max(0, carries))] });

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
