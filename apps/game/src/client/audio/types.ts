// The shapes behind the sound: the manifest you write (manifest.ts) and the
// index of audio files the tools build from apps/game/audio (see
// apps/game/audio/README.md). Shared with the Node scripts in apps/game/scripts.

/** The three volume groups a player controls, each with its own slider. */
export type Group = "music" | "atmosphere" | "sfx";
/** A slider in the Sound panel: one per group, and the master over all of them. */
export type Fader = Group | "master";

export interface FaderDefault {
  /** Where the player's slider starts, 0–1 (shown to them as 0–100). */
  volume: number;
  /** Your mix trim for the group, in dB. Players never see it, and changing it never resets a saved slider. */
  trimDb: number;
}

/** A random range, [low, high]. */
export type Range = [low: number, high: number];

/** A one-shot sound the game can ask for by name, such as "footstep.cobble" or "impact.melee". */
export interface SoundEvent {
  /**
   * The files to choose from: paths under apps/game/audio, without the extension.
   * A `*` in the last part matches anything, so "sfx/footsteps/cobble_*" picks up every take you add.
   */
  files: string | string[];
  /** Which slider it follows. Default "sfx". */
  group?: Group;
  /** Level, in dB. Default 0. */
  gainDb?: number;
  /** A random pitch shift on each play, in semitones, such as [-1, 1]. */
  pitch?: Range;
  /** A random change of level on each play, in dB, such as [-2, 0]. */
  volume?: Range;
  /**
   * How the next take is picked. "random" (the default): any take but the last one.
   * "shuffle": every take once, in a random order, then again. "sequence": in order.
   */
  order?: "random" | "shuffle" | "sequence";
  /** The most copies that may sound at once; another one fades out the oldest. Default 4. */
  maxVoices?: number;
  /** Seconds after a play during which a repeat is ignored. Default 0. */
  cooldown?: number;
  /** Seconds to wait before it sounds. Default 0. */
  delay?: number;
  /**
   * How much of it is sent to the reverb of the place you are in, in dB (0 sends it all; −12 a little).
   * Leave it out for a sound that should stay dry, such as a menu click or a musical sting.
   */
  reverb?: number;
}

/** A reverb: an impulse response the sound of a place is made with. */
export interface Reverb {
  /** The impulse response: a path under apps/game/audio without the extension, such as "ir/small_room". */
  file: string;
  /** Level of the reverb's return, in dB. Default 0. */
  gainDb?: number;
}

/**
 * Which reverb is heard where. The ground you stand on decides first, then
 * the scene, then `default`. Name a key of `reverbs`, or null for none.
 */
export interface ReverbZones {
  /** By the ground underfoot: "plains", "forest", "hills", "cobble", "dock", "mud", "rampart", "floor". */
  ground?: Record<string, string | null>;
  scene?: Partial<Record<SceneName, string | null>>;
  default?: string | null;
}

/**
 * A value the game keeps up to date, which a loop's level can follow:
 * "night" (0 full day to 1 deep night), "rain" (0 dry to 1 pouring) and
 * "time" (the time of day: 0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk).
 * They describe the sky outside, and hold indoors too.
 */
export type ParamName = "night" | "rain" | "time";

/**
 * An automation curve: the level (0 silent to 1 full) at each value of a
 * parameter, as [value, level] points in rising order, joined by straight lines.
 * `{ param: "night", curve: [[0.3, 0], [0.7, 1]] }` fades in through dusk.
 */
export interface Follow {
  param: ParamName;
  curve: [value: number, level: number][];
}

/** A stem played in sync with a loop's main file: the same length, started on the same sample. */
export interface Layer {
  file: string;
  /** Level, in dB. Default 0. */
  gainDb?: number;
  /** Its level follows a parameter. Without one it always plays. */
  follow?: Follow;
}

/** A looping music cue or atmosphere bed. */
export interface Loop {
  /** The file: a path under apps/game/audio without the extension, such as "music/harbor". */
  file: string;
  /** Level, in dB. Default 0. */
  gainDb?: number;
  /** The main file's level follows a parameter (a night bed, a rain bed, a day stem). */
  follow?: Follow;
  /** Stems laid over the main file, in sync with it. */
  layers?: Layer[];
  /** Tempo, for music that others switch to on its bar or beat. The loop should start on a bar line and be whole bars long. */
  bpm?: number;
  /** Beats in a bar. Default 4. */
  beatsPerBar?: number;
  /**
   * When this music comes in over music already playing: "now" (the default), or on the
   * next "bar" or "beat" of the music it replaces, if that music gives its `bpm`.
   */
  enter?: "now" | "bar" | "beat";
  /** Seconds to fade in when its scene starts. Default 2. */
  fadeIn?: number;
  /** Seconds to fade out when its scene ends. Default 2. */
  fadeOut?: number;
  /**
   * The loop region, for a file without loop markers (markers in the WAV are read automatically).
   * In seconds, or in samples with `unit: "samples"` (samples at the master's own rate).
   */
  loop?: { start: number; end: number; unit?: "seconds" | "samples" };
  /**
   * Where playback begins. "file" (the default) plays from the top, so anything before the
   * loop start is an intro heard once. "loop" starts at the loop start, for files rendered with margins.
   */
  startAt?: "file" | "loop";
}

/** The places the game can be, each with its own music and atmosphere. */
export type SceneName = "title" | "harbor" | "hut" | "pub" | "sailing" | "island" | "battle" | "spar";

export interface Scene {
  /** A key of `music`, or null for no music. */
  music?: string | null;
  /** Keys of `ambience`, all playing at once. */
  ambience?: string[];
}

/**
 * Things in the world that make a continuous sound from where they are:
 * "fire" (campfires, fireplaces, stoves), "candle", "lamp" (lanterns), and
 * "sea", which is the water as a whole rather than a point.
 */
export type EmitterKind = "fire" | "candle" | "lamp" | "sea";

export interface Emitter {
  /** The loop: a path under apps/game/audio without the extension. Mono; any stereo is folded down. */
  file: string;
  /** Level, in dB. Default 0. */
  gainDb?: number;
  /** Within this distance it is at full level (a hex is about 1.7 across). Default 1.5, or 3 for the sea. */
  ref?: number;
  /** Past this distance it is silent. Default 14, or 18 for the sea. */
  max?: number;
  /** How many of the nearest sources sound at once. Default 3. The sea is always one. */
  voices?: number;
}

export interface AudioManifest {
  mix: Record<Fader, FaderDefault>;
  /** Looping sounds placed in the world. Follows the Atmosphere slider. */
  emitters?: Partial<Record<EmitterKind, Emitter>>;
  /** The reverbs there are, by name. Heard on one-shots that set `reverb`. */
  reverbs?: Record<string, Reverb>;
  /** Which reverb is heard where. */
  zones?: ReverbZones;
  events: Record<string, SoundEvent>;
  music: Record<string, Loop>;
  ambience: Record<string, Loop>;
  scenes: Record<SceneName, Scene>;
}

// ---------- the index of files ----------

/** Ogg Opus and AAC are what ships; WAV is your masters, served as they are while developing. */
export type Format = "opus" | "aac" | "wav";

export interface AudioFile {
  /** Where each encoding of the file is served. */
  urls: Partial<Record<Format, string>>;
  /** Length of the master, in seconds. */
  duration: number;
  sampleRate: number;
  channels: number;
  /** The loop region in seconds, from loop markers in the master. */
  loop?: { start: number; end: number };
  /** Made by the placeholder script: heard while developing, never shipped. */
  placeholder?: boolean;
}

export interface AudioIndex {
  version: 1;
  /** Keyed by path under apps/game/audio without the extension, such as "sfx/footsteps/cobble_01". */
  files: Record<string, AudioFile>;
}
