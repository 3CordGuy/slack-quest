// The sound of the game, as data. This is the file you edit.
//
// Files are paths under apps/game/audio without the extension; see
// apps/game/audio/README.md for how to add them. Saving this file while the
// dev server runs applies it at once, without reloading the page.
//
// Event names are the ones the game asks for (names.ts lists them all, most
// specific first). You only need the general ones to start: "impact" covers
// every blow until you add "impact.melee" or "impact.firebolt".

import { ABILITIES, ENEMIES, type EffectKind } from "@gantt-quest/world";
import { slug } from "./select";
import type { AudioManifest, Follow, SoundEvent } from "./types";

/** "shore" is hexes to the nearest water. Level 0.7 is 3 dB down. */
const BY_THE_SEA: Follow = { param: "shore", curve: [[0.5, 0.7], [2, 1]] };
/**
 * Birds and crickets take cover from the rain: thinning out as it starts, about 12 dB down in light
 * rain (35% on "rain"), and gone by the time it is coming down properly. A storm is heavy rain, so it
 * silences them too. At silence the bed is not played or held in memory.
 */
const OUT_OF_THE_RAIN: Follow = { param: "rain", curve: [[0, 1], [0.15, 0.6], [0.35, 0.25], [0.6, 0]] };

// Every event also names a built-in sound in `fallback` (audio/synth.ts): what plays until a recording
// is added to `files`. Those are the game's sounds today, so nothing goes quiet while recordings arrive.
const built = (sound: string) => `synth/combat/${sound}_*`;

/** Footsteps share one shape: a pool of takes, a little pitch and level variation. */
const step = (surface: string, ground: string, gainDb = -6): SoundEvent => ({
  files: `sfx/footsteps/${surface}_*`,
  fallback: `synth/step/${ground}_*`,
  gainDb,
  reverb: -6,
  pitch: [-1.5, 1.5],
  volume: [-3, 0],
  maxVoices: 6,
});

export const AUDIO: AudioManifest = {
  // Where each slider starts for a new player, and your trim for each group.
  mix: {
    // The three groups start wide open and balanced against each other by their own levels and trims;
    // the master starts at half, which leaves a player room to turn the game up as well as down.
    master: { volume: 0.5, trimDb: 0 },
    music: { volume: 1, trimDb: 0 },
    atmosphere: { volume: 1, trimDb: 0 },
    sfx: { volume: 1, trimDb: 0 },
  },

  events: {
    // ----- footsteps, by the ground underfoot -----
    footstep: step("grass", "grass"),
    "footstep.plains": step("grass", "grass"),
    "footstep.forest": step("grass", "grass"),
    "footstep.hills": step("stone", "stone"),
    "footstep.cobble": step("stone", "stone"),
    "footstep.rampart": step("stone", "stone"),
    "footstep.cave": step("stone", "stone"),
    "footstep.dock": step("wood", "wood"),
    "footstep.floor": step("wood", "floor"),
    "footstep.mud": step("mud", "mud"),

    // ----- combat -----
    "attack.melee": { files: "sfx/combat/swing_*", fallback: built("swing"), pitch: [-2, 2], volume: [-2, 0], reverb: -12 },
    "attack.ranged": { files: "sfx/combat/bow_*", fallback: built("arrow_loose"), pitch: [-1, 1], reverb: -12 },
    "attack.magic": { files: "sfx/combat/cast_*", fallback: built("spell_cast"), pitch: [-1, 1], reverb: -8 },
    // A blow landing: a blunt thump by hand, unless it cuts or bites (blade abilities, below).
    impact: { files: "sfx/combat/hit_*", fallback: built("blunt"), pitch: [-2, 2], volume: [-2, 0], reverb: -8 },
    "impact.ranged": { files: "sfx/combat/arrow_hit_*", fallback: built("arrow_hit"), pitch: [-2, 2], reverb: -8 },
    "impact.magic": { files: "sfx/combat/magic_hit_*", fallback: built("spell_hit"), pitch: [-2, 2], reverb: -6 },
    ...bladeImpacts(),
    "impact.crit": { files: "sfx/combat/crit_*", fallback: built("crit"), gainDb: -3 },
    miss: { files: "sfx/combat/miss_*", fallback: built("whiff"), pitch: [-2, 2], gainDb: -4 },
    "miss.magic": { files: "sfx/combat/fizzle_*", fallback: built("fizzle"), pitch: [-2, 2], gainDb: -4 },
    heal: { files: "sfx/combat/heal_*", fallback: built("heal") },
    "heal.fail": { files: "sfx/combat/miss_*", fallback: built("heal_fail"), gainDb: -8, pitch: [-5, -3] },
    tick: { files: "sfx/combat/tick_*", fallback: built("bleed"), gainDb: -6, pitch: [-2, 2] },
    "tick.bleeding": { files: "sfx/combat/tick_*", fallback: built("bleed"), gainDb: -6, pitch: [-2, 2] },
    "tick.burning": { files: "sfx/combat/tick_*", fallback: built("burn"), gainDb: -6, pitch: [-2, 2] },
    ...effectTells(),
    down: { files: "sfx/combat/down_*", fallback: built("enemy_down"), reverb: -8 },
    "enemy.down": { files: "sfx/combat/down_*", fallback: built("enemy_down"), reverb: -8 },
    "hero.down": { files: "sfx/combat/hero_down_*", fallback: built("hero_down"), reverb: -8 },
    ...bossFalls(),

    // ----- moments -----
    "turn.yours": { files: "sfx/ui/your_turn", fallback: built("your_turn"), gainDb: -6, cooldown: 1 },
    level_up: { files: "sfx/ui/level_up", cooldown: 2 },
    loot: { files: "sfx/ui/loot", gainDb: -4 },
    gold: { files: "sfx/ui/gold", gainDb: -6, cooldown: 0.2 },
    pickup: { files: "sfx/ui/pickup", gainDb: -6, pitch: [-1, 1] },

    // ----- weather -----
    // Lightning strikes. Only a storm has them: a downpour, however heavy, has none. Bounce each strike (crack and rumble together) as its own take:
    // sfx/weather/thunder_01.wav, thunder_02.wav, and so on. "shuffle" plays every take once before any
    // comes round again. The flash on screen follows the loudness of whichever take plays, so a take
    // with two cracks flickers twice. Follows the Atmosphere slider.
    "weather.thunder": { files: "sfx/weather/thunder_*", group: "atmosphere", order: "shuffle", maxVoices: 2, reverb: -10 },

    // ----- felling in the grove -----
    "gather.chop": { files: "sfx/gather/chop_*", fallback: built("blunt"), pitch: [-3, -1], volume: [-2, 0], reverb: -10 },
    "gather.chop.perfect": { files: "sfx/gather/chop_clean_*", fallback: built("blade"), pitch: [-4, -2], reverb: -10 },
    "gather.chop.good": { files: "sfx/gather/chop_*", fallback: built("blunt"), pitch: [-3, -1], volume: [-2, 0], reverb: -10 },
    "gather.chop.miss": { files: "sfx/gather/glance_*", fallback: built("whiff"), pitch: [-2, 0], gainDb: -3 },
    "gather.knock": { files: "sfx/gather/knock_*", fallback: "synth/step/wood_*", gainDb: -2, reverb: -10 },
    "gather.knock.solid": { files: "sfx/gather/knock_solid_*", fallback: "synth/step/wood_*", gainDb: -2, pitch: [1, 2], reverb: -10 },
    "gather.knock.hollow": { files: "sfx/gather/knock_hollow_*", fallback: "synth/step/floor_*", gainDb: 0, pitch: [-7, -5], reverb: -4 },
    "gather.knock.scurry": { files: "sfx/gather/scurry_*", fallback: built("whiff"), gainDb: -6, pitch: [5, 7] },
    "gather.creak": { files: "sfx/gather/creak_*", fallback: built("debuff"), gainDb: -6, pitch: [-12, -9], reverb: -8 },
    "gather.timber": { files: "sfx/gather/timber_*", fallback: built("enemy_down"), pitch: [-9, -6], reverb: -4 },
    "gather.hung": { files: "sfx/gather/hung_*", fallback: built("blunt"), pitch: [-8, -6], gainDb: -2, reverb: -6 },
    "gather.creek": { files: "sfx/gather/splash_*", fallback: "synth/step/water_*", gainDb: 2, pitch: [-6, -4], reverb: -6 },
    "gather.pile": { files: "sfx/gather/smash_*", fallback: built("boss_down"), pitch: [-4, -2], reverb: -4 },

    // Stingers follow the Music slider.
    "stinger.battle_start": { files: "music/stingers/battle_start", group: "music" },
    // A boss's first appearance.
    "stinger.boss": { files: "music/stingers/boss", fallback: built("boss"), group: "music", cooldown: 2 },
    "stinger.victory": { files: "music/stingers/victory", fallback: built("victory"), group: "music" },
    "stinger.defeat": { files: "music/stingers/defeat", fallback: built("defeat"), group: "music" },
  },

  // Loops that play from where things are on the map: quieter, duller and off to one side as you
  // move away, by how the camera is turned. Distances are in map units (a hex is about 1.7 across).
  // "candle" and "lamp" can have one too.
  // How far to one side a placed sound can go: 0 is no direction, 1 is hard left or right.
  placing: { width: 0.45 },

  emitters: {
    // Stereo files here are folded to mono when loaded: they are heard from a point.
    fire: { file: "ambience/fire", ref: 1.5, max: 12, voices: 3 },
    // The water as a whole: louder toward the shore, from the side it lies on, all around you at sea.
    // `stereo` keeps the recording as wide as it is and leans it toward the water.
    sea: { file: "ambience/ocean", gainDb: 6, ref: 3, max: 18, stereo: true },
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
    // The town's night music, by day too for now. A day version can be a second cue, or a stem laid
    // over this one: layers: [{ file: "music/harbor_day", follow: { param: "night", curve: [[0.3, 1], [0.7, 0]] } }]
    // Give it its bpm and the battle music will come in on its bar.
    // `gap` is the rest between plays, in seconds: it plays through, leaves the town to its atmosphere for
    // two minutes, then plays again. A range, such as [120, 240], rests a different length each time.
    harbor: { file: "music/harbor", fadeIn: 3, fadeOut: 3, gap: 120 },
    island: { file: "music/island", fadeIn: 3, fadeOut: 3, bpm: 96 },
    // Comes in on the next bar of whatever was playing.
    battle: { file: "music/battle", fadeIn: 0.05, fadeOut: 2, bpm: 138, enter: "bar" },
  },

  ambience: {
    // The land by day and by night, crossing over through dusk and dawn. A bed whose curve has it at
    // silence is not played or held in memory at all.
    // Both also dip a little by the water, to leave room for the sea: 3 dB down at the edge, back to full two hexes inland.
    day: { file: "ambience/forest_day", gainDb: -3, fadeIn: 4, fadeOut: 4, follow: [{ param: "night", curve: [[0.3, 1], [0.7, 0]] }, BY_THE_SEA, OUT_OF_THE_RAIN] },
    night: { file: "ambience/forest_night", fadeIn: 4, fadeOut: 4, follow: [{ param: "night", curve: [[0.3, 0], [0.7, 1]] }, BY_THE_SEA, OUT_OF_THE_RAIN] },
    // Rain comes up fast: light rain (about 35% on the "rain" value) is already 2.5 dB under full, where a
    // straight line had it 9 dB under. `gainDb` lifts the whole bed.
    rain: { file: "ambience/rain", gainDb: 3, fadeIn: 3, fadeOut: 3, follow: { param: "rain", curve: [[0, 0], [0.15, 0.55], [0.5, 0.9], [1, 1]] } },
    // The storm's own rain, laid over the rain bed in a storm only: it follows "storm", which stays at 0
    // in a plain downpour however hard it rains. The thunder ("weather.thunder") comes with it.
    rainstorm: { file: "ambience/rainstorm", gainDb: 2, fadeIn: 3, fadeOut: 3, follow: { param: "storm", curve: [[0.1, 0], [0.7, 1]] } },
  },

  scenes: {
    title: { music: "harbor" },
    harbor: { music: "harbor", ambience: ["day", "night", "rain", "rainstorm"] },
    // Indoors: the Harbor's music, atmosphere and sea carry on, muffled, as through the walls. `cutoff`
    // is the high cut in Hz. A building's own sound goes here too and is heard clean: ambience: ["pub_crowd"],
    // or music: "pub" to replace the music from outside.
    hut: { inside: { of: "harbor", cutoff: 700, gainDb: -3 } },
    pub: { inside: { of: "harbor", cutoff: 700, gainDb: -3 } },
    sailing: { music: "island", ambience: ["rain", "rainstorm"] },
    island: { music: "island", ambience: ["day", "night", "rain", "rainstorm"] },
    // Under the rocks: no sky, no weather. The island's music until the caverns have their own.
    caverns: { music: "island" },
    battle: { music: "battle", ambience: ["day", "night", "rain", "rainstorm"] },
    spar: { music: "battle", ambience: ["day", "night", "rain", "rainstorm"] },
  },
};

// ---------- the built-in sounds' finer choices ----------

function bladeImpacts(): Record<string, SoundEvent> {
  /** Cutting and biting blows, heroes' and enemies': these land with a blade's bite rather than a thump. */
  const BLADE = new Set(["Cleave", "Quick Stab", "Flurry", "Land the Catch", "Slash", "Cheap Shot", "Bite", "Savage Bite", "Pounce", "Sweeping Ruin"]);
  const names = new Set([...Object.values(ABILITIES).map((a) => a.name), ...Object.values(ENEMIES).flatMap((e) => e.attacks.map((a) => a.name))]);
  const out: Record<string, SoundEvent> = {};
  for (const name of names) {
    if (BLADE.has(name)) out[`impact.${slug(name)}`] = { files: "sfx/combat/hit_*", fallback: built("blade"), pitch: [-2, 2], volume: [-2, 0], reverb: -8 };
  }
  return out;
}

/** The short tell of each effect taking hold: a drip, a crackle, stars, and a rise or fall for the rest. */
function effectTells(): Record<string, SoundEvent> {
  const tell = (e: EffectKind) => (e === "bleeding" ? "bleed" : e === "burning" ? "burn" : e === "stunned" ? "stun" : e === "guarded" || e === "taunting" || e === "hasted" ? "buff" : "debuff");
  const out: Record<string, SoundEvent> = { effect: { files: "sfx/combat/effect_*", fallback: built("debuff"), gainDb: -4 } };
  const all: EffectKind[] = ["bleeding", "burning", "stunned", "guarded", "taunting", "slowed", "hasted", "glitched", "exposed"];
  for (const e of all) out[`effect.${e}`] = { files: `sfx/combat/effect_${e}_*`, fallback: built(tell(e)), gainDb: -4 };
  return out;
}

/** A boss going down is heard as more than a puff. */
function bossFalls(): Record<string, SoundEvent> {
  const out: Record<string, SoundEvent> = {};
  for (const [kind, def] of Object.entries(ENEMIES)) if (def.boss) out[`enemy.${kind}.down`] = { files: "sfx/combat/boss_down_*", fallback: built("boss_down"), reverb: -6 };
  return out;
}
