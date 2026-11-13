// The sound of the game, as data. This is the file you edit.
//
// Files are paths under apps/game/audio without the extension; see
// apps/game/audio/README.md for how to add them. Saving this file while the
// dev server runs applies it at once, without reloading the page.
//
// Event names are the ones the game asks for (names.ts lists them all, most
// specific first). You only need the general ones to start: "impact" covers
// every blow until you add "impact.melee" or "impact.firebolt".

import type { AudioManifest, SoundEvent } from "./types";

/** Footsteps share one shape: a pool of takes, a little pitch and level variation. */
const step = (surface: string, gainDb = -6): SoundEvent => ({
  files: `sfx/footsteps/${surface}_*`,
  gainDb,
  reverb: -6,
  pitch: [-1.5, 1.5],
  volume: [-3, 0],
  maxVoices: 6,
});

export const AUDIO: AudioManifest = {
  // Where each slider starts for a new player, and your trim for each group.
  mix: {
    master: { volume: 0.8, trimDb: 0 },
    music: { volume: 0.7, trimDb: -6 },
    atmosphere: { volume: 0.8, trimDb: -6 },
    sfx: { volume: 0.8, trimDb: 0 },
  },

  events: {
    // ----- footsteps, by the ground underfoot -----
    footstep: step("grass"),
    "footstep.plains": step("grass"),
    "footstep.forest": step("grass"),
    "footstep.hills": step("stone"),
    "footstep.cobble": step("stone"),
    "footstep.rampart": step("stone"),
    "footstep.dock": step("wood"),
    "footstep.floor": step("wood"),
    "footstep.mud": step("mud"),

    // ----- combat -----
    "attack.melee": { files: "sfx/combat/swing_*", pitch: [-2, 2], volume: [-2, 0], reverb: -12 },
    "attack.ranged": { files: "sfx/combat/bow_*", pitch: [-1, 1], reverb: -12 },
    "attack.magic": { files: "sfx/combat/cast_*", pitch: [-1, 1], reverb: -8 },
    impact: { files: "sfx/combat/hit_*", pitch: [-2, 2], volume: [-2, 0], reverb: -8 },
    "impact.magic": { files: "sfx/combat/magic_hit_*", pitch: [-2, 2], reverb: -6 },
    "impact.crit": { files: "sfx/combat/crit_*", gainDb: -3 },
    miss: { files: "sfx/combat/miss_*", pitch: [-2, 2], gainDb: -4 },
    heal: { files: "sfx/combat/heal_*" },
    "heal.fail": { files: "sfx/combat/miss_*", gainDb: -8, pitch: [-5, -3] },
    tick: { files: "sfx/combat/tick_*", gainDb: -6, pitch: [-2, 2] },
    down: { files: "sfx/combat/down_*", reverb: -8 },

    // ----- moments -----
    "turn.yours": { files: "sfx/ui/your_turn", gainDb: -6, cooldown: 1 },
    level_up: { files: "sfx/ui/level_up", cooldown: 2 },
    loot: { files: "sfx/ui/loot", gainDb: -4 },
    gold: { files: "sfx/ui/gold", gainDb: -6, cooldown: 0.2 },
    pickup: { files: "sfx/ui/pickup", gainDb: -6, pitch: [-1, 1] },

    // Stingers follow the Music slider.
    "stinger.battle_start": { files: "music/stingers/battle_start", group: "music" },
    "stinger.victory": { files: "music/stingers/victory", group: "music" },
    "stinger.defeat": { files: "music/stingers/defeat", group: "music" },
  },

  // Loops that play from where things are on the map: quieter, duller and off to one side as you
  // move away, by how the camera is turned. Distances are in map units (a hex is about 1.7 across).
  // "candle" and "lamp" can have one too.
  emitters: {
    fire: { file: "ambience/fire", gainDb: -6, ref: 1.5, max: 12, voices: 3 },
    // The water as a whole: louder toward the shore, from the side it lies on, all around you at sea.
    sea: { file: "ambience/shore", gainDb: -3, ref: 3, max: 18 },
  },

  // The sound of each place: an impulse response per reverb. Only one-shots that set `reverb` (their
  // send, in dB) are heard in it; everything else stays dry.
  reverbs: {
    room: { file: "ir/room", gainDb: -3 },
    hall: { file: "ir/hall", gainDb: -4 },
    open: { file: "ir/open", gainDb: -8 },
    woods: { file: "ir/woods", gainDb: -5 },
    stone: { file: "ir/stone", gainDb: -4 },
  },
  // Which reverb is heard where: the ground underfoot decides first, then the scene, then the default.
  // Moving between two crossfades them over a second.
  zones: {
    ground: { forest: "woods", cobble: "stone", rampart: "stone", hills: "stone" },
    scene: { hut: "room", pub: "hall" },
    default: "open",
  },

  // A level can follow the sky: "night" (0 day to 1 deep night), "rain" (0 dry to 1 pouring)
  // or "time" (0 midnight, 0.5 noon). A curve is [value, level] points; see audio/README.md.
  music: {
    harbor: {
      file: "music/harbor",
      fadeIn: 3,
      fadeOut: 3,
      bpm: 84,
      // A stem in sync with the main file, fading in through dusk.
      layers: [{ file: "music/harbor_night", follow: { param: "night", curve: [[0.3, 0], [0.8, 1]] } }],
    },
    island: { file: "music/island", fadeIn: 3, fadeOut: 3, bpm: 96 },
    // Comes in on the next bar of whatever was playing.
    battle: { file: "music/battle", fadeIn: 0.05, fadeOut: 2, bpm: 138, enter: "bar" },
  },

  ambience: {
    room: { file: "ambience/room", gainDb: -6, fadeIn: 2, fadeOut: 2 },
    night: { file: "ambience/night", gainDb: -8, follow: { param: "night", curve: [[0.5, 0], [0.9, 1]] } },
    rain: { file: "ambience/rain", gainDb: -4, follow: { param: "rain", curve: [[0, 0], [1, 1]] } },
    // The same rain heard from indoors: lower. Swap in a roof recording when you have one.
    rain_indoors: { file: "ambience/rain", gainDb: -14, follow: { param: "rain", curve: [[0, 0], [1, 1]] } },
  },

  scenes: {
    title: { music: "harbor" },
    harbor: { music: "harbor", ambience: ["night", "rain"] },
    hut: { music: "harbor", ambience: ["room", "rain_indoors"] },
    pub: { music: "harbor", ambience: ["room", "rain_indoors"] },
    sailing: { music: "island", ambience: ["rain"] },
    island: { music: "island", ambience: ["night", "rain"] },
    battle: { music: "battle", ambience: ["night", "rain"] },
    spar: { music: "battle", ambience: ["night", "rain"] },
  },
};
