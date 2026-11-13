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
    "attack.melee": { files: "sfx/combat/swing_*", pitch: [-2, 2], volume: [-2, 0] },
    "attack.ranged": { files: "sfx/combat/bow_*", pitch: [-1, 1] },
    "attack.magic": { files: "sfx/combat/cast_*", pitch: [-1, 1] },
    impact: { files: "sfx/combat/hit_*", pitch: [-2, 2], volume: [-2, 0] },
    "impact.magic": { files: "sfx/combat/magic_hit_*", pitch: [-2, 2] },
    "impact.crit": { files: "sfx/combat/crit_*", gainDb: -3 },
    miss: { files: "sfx/combat/miss_*", pitch: [-2, 2], gainDb: -4 },
    heal: { files: "sfx/combat/heal_*" },
    "heal.fail": { files: "sfx/combat/miss_*", gainDb: -8, pitch: [-5, -3] },
    tick: { files: "sfx/combat/tick_*", gainDb: -6, pitch: [-2, 2] },
    down: { files: "sfx/combat/down_*" },

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

  music: {
    harbor: { file: "music/harbor", fadeIn: 3, fadeOut: 3 },
    island: { file: "music/island", fadeIn: 3, fadeOut: 3 },
    battle: { file: "music/battle", fadeIn: 0.5, fadeOut: 2 },
  },

  ambience: {
    shore: { file: "ambience/shore", fadeIn: 4, fadeOut: 4 },
    room: { file: "ambience/room", gainDb: -6, fadeIn: 2, fadeOut: 2 },
  },

  scenes: {
    title: { music: "harbor" },
    harbor: { music: "harbor", ambience: ["shore"] },
    hut: { music: "harbor", ambience: ["room"] },
    pub: { music: "harbor", ambience: ["room"] },
    sailing: { music: "island", ambience: ["shore"] },
    island: { music: "island", ambience: ["shore"] },
    battle: { music: "battle", ambience: ["shore"] },
    spar: { music: "battle", ambience: ["shore"] },
  },
};
