// The engine's built-in sounds: footsteps, combat and the pub's tables, made from filtered noise
// and simple tones with the Web Audio API, so the game has sound before a
// single file is recorded or encoded. They were the game's only sounds before
// this engine; here they are rendered once each into buffers, in a few takes,
// and from then on they are ordinary files to the engine: mixed, placed,
// reverberated and limited like any recording.
//
// They are listed in the library's index as `synth/...` keys. A manifest event
// names them in `fallback`: a real recording in `files` wins when there is one,
// and a placeholder never beats them.

import type { AudioFile } from "./types";

/** What a footstep lands on, as far as its sound goes. */
export type SynthGround = "grass" | "stone" | "wood" | "floor" | "mud" | "water";

/** Every built-in combat sound. */
export type SynthCombat =
  | "blade" | "blunt" | "swing" | "arrow_loose" | "arrow_hit" | "spell_cast" | "spell_hit" | "crit"
  | "whiff" | "fizzle"
  | "heal" | "heal_fail"
  | "bleed" | "burn" | "stun" | "buff" | "debuff"
  | "hero_down" | "enemy_down" | "boss_down"
  | "boss" | "victory" | "defeat" | "your_turn";

/** The pub's game tables: the dice cup, dice on the felt, and the pot. */
export type SynthTable = "shake" | "tumble" | "settle" | "hold" | "coins";

/** How many takes of each: steps vary most, stings least. */
const STEP_TAKES = 6;
const COMBAT_TAKES = 4;
const STING_TAKES = 2;
const TABLE_TAKES = 4;
const TABLE_LENGTH: Record<SynthTable, number> = { shake: 0.5, tumble: 0.75, settle: 0.12, hold: 0.18, coins: 0.7 };
const STINGS: ReadonlySet<SynthCombat> = new Set(["boss", "victory", "defeat", "boss_down"]);

const SAMPLE_RATE = 44100;

/**
 * How each ground sounds: a burst of filtered noise (`filter`, around `freq`, ringing by `q`)
 * dying away over `decay` seconds, and for boards a low knock under it.
 */
const STEP: Record<SynthGround, { filter: BiquadFilterType; freq: number; q: number; decay: number; gain: number; knock?: number }> = {
  grass: { filter: "bandpass", freq: 1100, q: 0.6, decay: 0.09, gain: 0.5 },
  stone: { filter: "highpass", freq: 2200, q: 1.4, decay: 0.035, gain: 0.55 },
  wood: { filter: "bandpass", freq: 700, q: 1.6, decay: 0.06, gain: 0.5, knock: 150 },
  floor: { filter: "bandpass", freq: 650, q: 1.6, decay: 0.06, gain: 0.45, knock: 135 },
  mud: { filter: "lowpass", freq: 380, q: 1.0, decay: 0.12, gain: 0.75 },
  water: { filter: "bandpass", freq: 1500, q: 2.5, decay: 0.15, gain: 0.45 },
};

/** How long each sound runs, so the offline render is no longer than it needs to be. */
const COMBAT_LENGTH: Record<SynthCombat, number> = {
  blade: 0.3, blunt: 0.35, swing: 0.2, arrow_loose: 0.25, arrow_hit: 0.2, spell_cast: 0.3, spell_hit: 0.3, crit: 0.25,
  whiff: 0.2, fizzle: 0.2,
  heal: 0.6, heal_fail: 0.3,
  bleed: 0.15, burn: 0.35, stun: 0.35, buff: 0.25, debuff: 0.25,
  hero_down: 0.8, enemy_down: 0.35, boss_down: 1.0,
  boss: 2.0, victory: 1.1, defeat: 1.2, your_turn: 0.2,
};

/** Notes of a few bright chords, so heals and stings are not always the same three notes. */
const CHORDS = [[1047, 1319, 1568], [988, 1245, 1480], [1175, 1480, 1760], [932, 1175, 1397]];

/** A small seeded generator, so each take is the same take every time it is rendered. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything one render needs: its context, where sound goes, a slice of noise and the take's dice. */
interface Render {
  ctx: OfflineAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
  rnd: () => number;
}

const wobble = (r: Render, spread: number) => 1 + (r.rnd() * 2 - 1) * spread;

/** A burst of filtered noise from `at`, its filter sliding from `freq` to `freqTo`, rising over `attack` and dying over `decay`. */
function noiseAt(r: Render, at: number, o: { filter: BiquadFilterType; freq: number; freqTo?: number; q?: number; attack?: number; decay: number; gain: number }) {
  const { ctx } = r;
  const src = ctx.createBufferSource();
  src.buffer = r.noise;
  src.playbackRate.value = wobble(r, 0.1);
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.Q.value = o.q ?? 1;
  f.frequency.setValueAtTime(o.freq, at);
  const attack = o.attack ?? 0.004;
  if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, at + attack + o.decay);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + o.decay);
  src.connect(f).connect(env).connect(r.out);
  const length = attack + o.decay + 0.02;
  // The noise is a quarter second: longer sounds loop it.
  src.loop = length > 0.2;
  src.start(at, r.rnd() * 0.05);
  src.stop(at + length);
}

/** A pitched note from `at`, gliding from `freq` to `freqTo`, through a low-pass at `cut` when given. */
function toneAt(r: Render, at: number, o: { type: OscillatorType; freq: number; freqTo?: number; attack?: number; decay: number; gain: number; cut?: number }) {
  const { ctx } = r;
  const osc = ctx.createOscillator();
  osc.type = o.type;
  const attack = o.attack ?? 0.005;
  osc.frequency.setValueAtTime(o.freq, at);
  if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(o.freqTo, at + attack + o.decay);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + o.decay);
  let out: AudioNode = osc;
  if (o.cut) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = o.cut;
    out = osc.connect(f);
  }
  out.connect(env).connect(r.out);
  osc.start(at);
  osc.stop(at + attack + o.decay + 0.02);
}

/** One footstep on `ground`. Odd takes are the other foot, pitched a touch apart. */
function step(r: Render, ground: SynthGround, take: number) {
  const look = STEP[ground];
  const pitch = (take % 2 ? 0.94 : 1.06) * wobble(r, 0.08);
  const peak = look.gain * wobble(r, 0.15);
  const decay = look.decay * wobble(r, 0.2);
  noiseAt(r, 0.002, { filter: look.filter, freq: look.freq * wobble(r, 0.18), q: look.q, decay, gain: peak });
  if (look.knock) toneAt(r, 0.002, { type: "sine", freq: look.knock * pitch, freqTo: look.knock * pitch * 0.6, decay: 0.07, gain: peak * 0.9 });
}

/** One combat sound. Takes differ in pitch, level and (for heals and stings) chord. */
function combat(r: Render, sound: SynthCombat) {
  const v = 0.8 * wobble(r, 0.12);
  const p = wobble(r, 0.07);
  const t = 0.005;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r.rnd() * xs.length)];
  switch (sound) {
    case "blade":
      // A bright bite with a ring to it (the swing that brought it is a sound of its own).
      noiseAt(r, t, { filter: "highpass", freq: 2600 * p, q: 1.5, decay: 0.05, gain: v * 0.7 });
      toneAt(r, t, { type: "square", freq: 820 * p, freqTo: 560 * p, decay: 0.05, gain: v * 0.12, cut: 2400 });
      toneAt(r, t, { type: "sine", freq: 170 * p, freqTo: 90, decay: 0.09, gain: v * 0.6 });
      break;
    case "blunt":
      // A heavy thump with a little grit.
      toneAt(r, t, { type: "sine", freq: 120 * p, freqTo: 50, decay: 0.16, gain: v * 1.1 });
      noiseAt(r, t, { filter: "lowpass", freq: 600 * p, q: 0.9, decay: 0.09, gain: v * 0.8 });
      break;
    case "swing":
      // A swish through the air as a hand weapon comes round.
      noiseAt(r, t, { filter: "bandpass", freq: 700 * p, freqTo: 3200 * p, q: 1.2, attack: 0.03, decay: 0.09, gain: v * 0.55 });
      break;
    case "arrow_loose":
      // The bowstring's twang.
      toneAt(r, t, { type: "triangle", freq: 330 * p, freqTo: 300 * p, decay: 0.16, gain: v * 0.45 });
      noiseAt(r, t, { filter: "bandpass", freq: 2000 * p, q: 2, decay: 0.03, gain: v * 0.35 });
      break;
    case "arrow_hit":
      // The thunk of it going in.
      noiseAt(r, t, { filter: "lowpass", freq: 1100 * p, q: 1.2, decay: 0.05, gain: v * 0.8 });
      toneAt(r, t, { type: "sine", freq: 240 * p, freqTo: 120, decay: 0.07, gain: v * 0.7 });
      break;
    case "spell_cast":
      // A rising whoosh as the bolt leaves.
      noiseAt(r, t, { filter: "bandpass", freq: 350 * p, freqTo: 1900 * p, q: 3, attack: 0.08, decay: 0.15, gain: v * 0.5 });
      break;
    case "spell_hit":
      // A zap: a falling buzz and a crackle.
      toneAt(r, t, { type: "sawtooth", freq: 1400 * p, freqTo: 180 * p, decay: 0.13, gain: v * 0.35, cut: 3000 });
      noiseAt(r, t, { filter: "highpass", freq: 1800 * p, q: 0.8, decay: 0.08, gain: v * 0.5 });
      break;
    case "crit":
      // Laid over a perfect hit: an extra crack and a low punch.
      noiseAt(r, t, { filter: "highpass", freq: 3200 * p, q: 1.8, decay: 0.04, gain: v * 0.6 });
      toneAt(r, t, { type: "sine", freq: 95 * p, freqTo: 45, decay: 0.15, gain: v * 0.8 });
      break;
    case "whiff":
      // Cutting nothing but air.
      noiseAt(r, t, { filter: "bandpass", freq: 1600 * p, freqTo: 500 * p, q: 1.4, attack: 0.02, decay: 0.12, gain: v * 0.45 });
      break;
    case "fizzle":
      toneAt(r, t, { type: "sine", freq: 620 * p, freqTo: 260 * p, decay: 0.12, gain: v * 0.35 });
      noiseAt(r, t, { filter: "highpass", freq: 3000, decay: 0.1, gain: v * 0.15 });
      break;
    case "heal":
      // A soft rising chime, a different chord each take.
      pick(CHORDS).forEach((f, i) => toneAt(r, t + i * 0.06, { type: "sine", freq: f, attack: 0.01, decay: 0.32, gain: v * 0.35 }));
      break;
    case "heal_fail":
      toneAt(r, t, { type: "triangle", freq: 330 * p, freqTo: 220 * p, decay: 0.18, gain: v * 0.35 });
      break;
    case "bleed":
      // A drip.
      toneAt(r, t, { type: "sine", freq: 700 * p, freqTo: 1500 * p, decay: 0.07, gain: v * 0.4 });
      break;
    case "burn":
      // A short crackle of little pops.
      for (let i = 0; i < 5; i++) noiseAt(r, t + r.rnd() * 0.18, { filter: "highpass", freq: 2200 + r.rnd() * 2000, q: 1, decay: 0.015, gain: v * 0.45 });
      noiseAt(r, t, { filter: "bandpass", freq: 900, q: 0.7, attack: 0.03, decay: 0.15, gain: v * 0.2 });
      break;
    case "stun":
      // Seeing stars: two little falling bell notes.
      toneAt(r, t, { type: "triangle", freq: 1320 * p, freqTo: 990 * p, decay: 0.12, gain: v * 0.3 });
      toneAt(r, t + 0.1, { type: "triangle", freq: 990 * p, freqTo: 740 * p, decay: 0.14, gain: v * 0.3 });
      break;
    case "buff":
      toneAt(r, t, { type: "triangle", freq: 520 * p, freqTo: 880 * p, attack: 0.02, decay: 0.16, gain: v * 0.3 });
      break;
    case "debuff":
      toneAt(r, t, { type: "triangle", freq: 700 * p, freqTo: 360 * p, attack: 0.02, decay: 0.18, gain: v * 0.3 });
      break;
    case "hero_down":
      // Falling: a sinking groan and the thud of landing.
      toneAt(r, t, { type: "sawtooth", freq: 320 * p, freqTo: 70, attack: 0.02, decay: 0.45, gain: v * 0.45, cut: 900 });
      toneAt(r, t + 0.3, { type: "sine", freq: 95, freqTo: 45, decay: 0.2, gain: v * 0.9 });
      noiseAt(r, t + 0.3, { filter: "lowpass", freq: 400, decay: 0.12, gain: v * 0.5 });
      break;
    case "enemy_down":
      // A puff and a falling blip.
      noiseAt(r, t, { filter: "lowpass", freq: 2400 * p, freqTo: 300, q: 0.8, attack: 0.01, decay: 0.22, gain: v * 0.5 });
      toneAt(r, t + 0.02, { type: "square", freq: 660 * p, freqTo: 180 * p, decay: 0.18, gain: v * 0.16, cut: 2000 });
      break;
    case "boss_down":
      noiseAt(r, t, { filter: "lowpass", freq: 1800, freqTo: 120, q: 0.7, attack: 0.02, decay: 0.7, gain: v * 0.7 });
      toneAt(r, t, { type: "sawtooth", freq: 180, freqTo: 40, attack: 0.02, decay: 0.8, gain: v * 0.45, cut: 600 });
      toneAt(r, t + 0.05, { type: "sine", freq: 70, freqTo: 35, decay: 0.5, gain: v });
      break;
    case "boss":
      // Something big has turned up: a low swell and a dull gong.
      toneAt(r, t, { type: "sawtooth", freq: 55, attack: 0.35, decay: 1.4, gain: v * 0.5, cut: 380 });
      toneAt(r, t, { type: "sawtooth", freq: 82.4 * wobble(r, 0.01), attack: 0.35, decay: 1.4, gain: v * 0.4, cut: 380 });
      toneAt(r, t + 0.05, { type: "sine", freq: 110, freqTo: 104, decay: 1.8, gain: v * 0.6 });
      break;
    case "victory": {
      // Up the chord and hold the top.
      const [a, b, c] = pick(CHORDS).map((f) => f / 2);
      [a, b, c, a * 2].forEach((f, i) => toneAt(r, t + i * 0.11, { type: "triangle", freq: f, attack: 0.01, decay: i === 3 ? 0.55 : 0.16, gain: v * 0.45 }));
      break;
    }
    case "defeat":
      // Down a minor third or two, slow.
      [392, 311, 262].forEach((f, i) => toneAt(r, t + i * 0.2, { type: "triangle", freq: f * wobble(r, 0.01), attack: 0.02, decay: i === 2 ? 0.7 : 0.22, gain: v * 0.45 }));
      break;
    case "your_turn":
      toneAt(r, t, { type: "sine", freq: 1180 * p, decay: 0.05, gain: v * 0.22 });
      toneAt(r, t + 0.07, { type: "sine", freq: 1580 * p, decay: 0.07, gain: v * 0.22 });
      break;
  }
}

/**
 * One table sound. Dice are small and hard, so they click high (ivory on ivory,
 * or wood) and knock low through the tabletop; the felt deadens the rest.
 */
function table(r: Render, sound: SynthTable) {
  const v = 0.8 * wobble(r, 0.12);
  const p = wobble(r, 0.07);
  /** A die striking something: a bright click, and the knock of the wood under the felt. */
  const clack = (at: number, gain: number, bright = 1) => {
    noiseAt(r, at, { filter: "bandpass", freq: (2600 + r.rnd() * 1800) * p * bright, q: 2.2, decay: 0.012 + r.rnd() * 0.01, gain: gain * 0.8 });
    toneAt(r, at, { type: "sine", freq: (380 + r.rnd() * 160) * p, freqTo: 220 * p, decay: 0.035, gain: gain * 0.55 });
  };
  switch (sound) {
    case "shake": {
      // Dice rattling in a leather cup: a run of quick clicks, muffled, swelling and easing twice as the cup goes back and forth.
      for (let i = 0; i < 22; i++) {
        const at = 0.01 + (i / 22) * 0.42 + r.rnd() * 0.02;
        const swing = 0.55 + 0.45 * Math.abs(Math.sin((at / 0.42) * Math.PI * 2));
        noiseAt(r, at, { filter: "bandpass", freq: (1500 + r.rnd() * 1400) * p, q: 2.5, decay: 0.01 + r.rnd() * 0.008, gain: v * 0.45 * swing });
      }
      noiseAt(r, 0.01, { filter: "lowpass", freq: 500 * p, q: 0.8, attack: 0.06, decay: 0.35, gain: v * 0.18 });
      break;
    }
    case "tumble": {
      // Dice spilled onto the felt: each lands, bounces twice and rolls to a stop, a beat apart, with the odd click of one die on another.
      const dice = 3;
      for (let d = 0; d < dice; d++) {
        let at = 0.005 + d * (0.03 + r.rnd() * 0.04);
        let gain = v * (0.85 + r.rnd() * 0.3);
        let gap = 0.12 + r.rnd() * 0.05;
        for (let b = 0; b < 4; b++) {
          clack(at, gain, 0.8 + r.rnd() * 0.3);
          at += gap;
          gap *= 0.55;
          gain *= 0.5;
        }
      }
      for (let i = 0; i < 3; i++) noiseAt(r, 0.06 + r.rnd() * 0.3, { filter: "highpass", freq: 4200 * p, q: 1.5, decay: 0.008, gain: v * 0.35 });
      // The roll across the cloth.
      noiseAt(r, 0.02, { filter: "bandpass", freq: 900 * p, q: 0.7, attack: 0.04, decay: 0.4, gain: v * 0.12 });
      break;
    }
    case "settle":
      // One die rocking to a stop.
      clack(0.004, v * 0.5, 0.9);
      clack(0.045, v * 0.2, 0.9);
      break;
    case "hold":
      // A die set firmly aside: one solid wooden clack, a touch of ring.
      noiseAt(r, 0.004, { filter: "bandpass", freq: 1500 * p, q: 1.8, decay: 0.025, gain: v * 0.8 });
      toneAt(r, 0.004, { type: "sine", freq: 640 * p, freqTo: 480 * p, decay: 0.07, gain: v * 0.7 });
      toneAt(r, 0.004, { type: "triangle", freq: 1900 * p, decay: 0.06, gain: v * 0.12 });
      break;
    case "coins": {
      // Gold onto the pile: a handful of clinks, each a pair of inharmonic rings, landing over half a second.
      const n = 6 + Math.floor(r.rnd() * 3);
      for (let i = 0; i < n; i++) {
        const at = 0.005 + (i / n) * 0.42 + r.rnd() * 0.04;
        const f = (2900 + r.rnd() * 1600) * p;
        const g = v * (0.25 + r.rnd() * 0.2) * (1 - (i / n) * 0.5);
        toneAt(r, at, { type: "sine", freq: f, decay: 0.08 + r.rnd() * 0.08, gain: g });
        toneAt(r, at, { type: "sine", freq: f * 1.47, decay: 0.05, gain: g * 0.5 });
        noiseAt(r, at, { filter: "highpass", freq: 5000, q: 1, decay: 0.006, gain: g * 0.6 });
      }
      break;
    }
  }
}

const GROUNDS = Object.keys(STEP) as SynthGround[];
const TABLES = Object.keys(TABLE_LENGTH) as SynthTable[];
const COMBATS = Object.keys(COMBAT_LENGTH) as SynthCombat[];
const takesOf = (sound: SynthCombat) => (STINGS.has(sound) ? STING_TAKES : COMBAT_TAKES);

/** What a key renders: a footstep, a combat sound or a table sound, and which take. */
function parse(key: string): { kind: "step"; ground: SynthGround; take: number } | { kind: "combat"; sound: SynthCombat; take: number } | { kind: "table"; sound: SynthTable; take: number } | null {
  const m = /^synth\/(step|combat|table)\/([a-z_]+)_(\d+)$/.exec(key);
  if (!m) return null;
  const take = Number(m[3]);
  if (m[1] === "table") return (TABLES as string[]).includes(m[2]) ? { kind: "table", sound: m[2] as SynthTable, take } : null;
  if (m[1] === "step" && (GROUNDS as string[]).includes(m[2])) return { kind: "step", ground: m[2] as SynthGround, take };
  if (m[1] === "combat" && (COMBATS as string[]).includes(m[2])) return { kind: "combat", sound: m[2] as SynthCombat, take };
  return null;
}

/** Every built-in sound as an index entry, keyed `synth/step/<ground>_<n>`, `synth/combat/<sound>_<n>` and `synth/table/<sound>_<n>`. */
export function synthIndex(): Record<string, AudioFile> {
  const out: Record<string, AudioFile> = {};
  const entry = (duration: number): AudioFile => ({ urls: {}, duration, sampleRate: SAMPLE_RATE, channels: 1, synth: true });
  for (const g of GROUNDS) for (let i = 1; i <= STEP_TAKES; i++) out[`synth/step/${g}_${i}`] = entry(STEP[g].decay + 0.12);
  for (const c of COMBATS) for (let i = 1; i <= takesOf(c); i++) out[`synth/combat/${c}_${i}`] = entry(COMBAT_LENGTH[c]);
  for (const t of TABLES) for (let i = 1; i <= TABLE_TAKES; i++) out[`synth/table/${t}_${i}`] = entry(TABLE_LENGTH[t]);
  return out;
}

/** Render one built-in sound to a buffer. Null for a key that is not one. */
export async function renderSynth(key: string): Promise<AudioBuffer | null> {
  const what = parse(key);
  if (!what) return null;
  const Offline = globalThis.OfflineAudioContext ?? (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  const seconds = what.kind === "step" ? STEP[what.ground].decay + 0.12 : what.kind === "table" ? TABLE_LENGTH[what.sound] : COMBAT_LENGTH[what.sound];
  const ctx = new Offline(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  // A quarter second of white noise, the stuff every scuff and swish is cut from; seeded, like everything in a take.
  const rnd = seeded(key);
  const noise = ctx.createBuffer(1, Math.floor(SAMPLE_RATE * 0.25), SAMPLE_RATE);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  const r: Render = { ctx, out: ctx.destination, noise, rnd };
  if (what.kind === "step") step(r, what.ground, what.take);
  else if (what.kind === "table") table(r, what.sound);
  else combat(r, what.sound);
  return ctx.startRendering();
}
