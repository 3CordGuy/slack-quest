// The game's sounds, made on the spot with the Web Audio API: no sound files.
// Browsers keep a page quiet until it is touched, so the AudioContext is made
// (or woken) on the first pointer press or key press. Everything here is
// wrapped so that a browser without audio, or one that refuses it, stays silent
// instead of breaking the game.

import type { StepGround } from "./render/footsteps";

const MUTE_KEY = "gq.muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let armed = false;
let muted = readMuted();
const muteListeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    // Private windows and blocked storage: the choice lasts for this visit only.
  }
  try {
    if (master && ctx) master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.02);
  } catch {
    // Nothing to quiet.
  }
  for (const fn of muteListeners) fn(next);
}

/** Hear about the sound being muted or unmuted (from any button). Returns a function that stops listening. */
export function onMuteChange(fn: (muted: boolean) => void): () => void {
  muteListeners.add(fn);
  return () => muteListeners.delete(fn);
}

/** Wake the sound on the first press: browsers do not let a page start it on its own. Safe to call more than once. */
export function armAudio() {
  if (armed || typeof addEventListener !== "function") return;
  armed = true;
  const wake = () => {
    try {
      if (!ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(ctx.destination);
        // A quarter second of white noise, the stuff every step is cut from.
        noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    } catch {
      ctx = null;
    }
  };
  addEventListener("pointerdown", wake, { capture: true });
  addEventListener("keydown", wake, { capture: true });
}

/**
 * How each ground sounds: a burst of filtered noise (`filter`, around `freq`, ringing by `q`)
 * dying away over `decay` seconds, and for boards a low knock under it.
 */
const STEP: Record<StepGround, { filter: BiquadFilterType; freq: number; q: number; decay: number; gain: number; knock?: number }> = {
  grass: { filter: "bandpass", freq: 1100, q: 0.6, decay: 0.09, gain: 0.5 },
  stone: { filter: "highpass", freq: 2200, q: 1.4, decay: 0.035, gain: 0.55 },
  wood: { filter: "bandpass", freq: 700, q: 1.6, decay: 0.06, gain: 0.5, knock: 150 },
  floor: { filter: "bandpass", freq: 650, q: 1.6, decay: 0.06, gain: 0.45, knock: 135 },
  mud: { filter: "lowpass", freq: 380, q: 1.0, decay: 0.12, gain: 0.75 },
  water: { filter: "bandpass", freq: 1500, q: 2.5, decay: 0.15, gain: 0.45 },
};

/** Everything is quiet: your own steps at full volume sit well under any music or speech. */
const STEP_LEVEL = 0.22;

/** When recent steps were played, to keep a crowd's footsteps from piling into a roar. */
const recent: number[] = [];
const CROWD_WINDOW = 0.14;
const CROWD_MAX = 3;
/** Left foot, right foot: alternate steps are pitched a touch apart. */
let foot = 0;

/**
 * One footstep on `ground`, at `volume` (0 to 1). `mine` is your own hero's step, which is always heard;
 * other heroes' steps are dropped when several have just played.
 */
export function playFootstep(ground: StepGround, volume: number, mine = false) {
  if (muted || !ctx || !master || !noise || volume <= 0.01) return;
  try {
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    while (recent.length && recent[0] < now - CROWD_WINDOW) recent.shift();
    if (!mine && recent.length >= CROWD_MAX) return;
    recent.push(now);

    const look = STEP[ground];
    foot ^= 1;
    // Never the same step twice: the pitch, the filter, the loudness and the slice of noise all wander.
    const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;
    const pitch = (foot ? 0.94 : 1.06) * jitter(0.08);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = pitch;
    const filter = ctx.createBiquadFilter();
    filter.type = look.filter;
    filter.frequency.value = look.freq * jitter(0.18);
    filter.Q.value = look.q;
    const env = ctx.createGain();
    const peak = STEP_LEVEL * look.gain * volume * jitter(0.15);
    const decay = look.decay * jitter(0.2);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    src.connect(filter).connect(env).connect(master);
    src.start(now, Math.random() * 0.15, decay + 0.02);

    if (look.knock) {
      // A hollow board: a short low thump beneath the scuff.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(look.knock * pitch, now);
      osc.frequency.exponentialRampToValueAtTime(look.knock * pitch * 0.6, now + 0.07);
      const body = ctx.createGain();
      body.gain.setValueAtTime(0.0001, now);
      body.gain.exponentialRampToValueAtTime(peak * 0.9, now + 0.005);
      body.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      osc.connect(body).connect(master);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch {
    // A step missed is no loss.
  }
}

// ---------- combat ----------

/** Every combat sound, by what happened. See playCombat. */
export type CombatSound =
  | "blade" | "blunt" | "arrow_loose" | "arrow_hit" | "spell_cast" | "spell_hit"
  | "whiff" | "fizzle"
  | "heal" | "heal_fail"
  | "bleed" | "burn" | "stun" | "buff" | "debuff"
  | "hero_down" | "enemy_down" | "boss_down"
  | "boss" | "victory" | "defeat" | "your_turn";

/** Combat sits a touch above footsteps but stays quiet. */
const COMBAT_LEVEL = 0.2;
/** Stings and the boss's entrance always play; everything else is thinned out when a lot lands at once. */
const ALWAYS: ReadonlySet<CombatSound> = new Set(["boss", "victory", "defeat", "hero_down", "boss_down"]);
const combatRecent: number[] = [];
const COMBAT_WINDOW = 0.15;
const COMBAT_MAX = 4;
const lastOf = new Map<CombatSound, number>();

const wobble = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;

/** A burst of filtered noise from `at`, its filter sliding from `freq` to `freqTo`, rising over `attack` and dying over `decay`. */
function noiseAt(at: number, o: { filter: BiquadFilterType; freq: number; freqTo?: number; q?: number; attack?: number; decay: number; gain: number }) {
  if (!ctx || !master || !noise) return;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = wobble(0.1);
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.Q.value = o.q ?? 1;
  f.frequency.setValueAtTime(o.freq, at);
  if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, at + (o.attack ?? 0.004) + o.decay);
  const env = ctx.createGain();
  const attack = o.attack ?? 0.004;
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + o.decay);
  src.connect(f).connect(env).connect(master);
  const length = attack + o.decay + 0.02;
  // The noise buffer is a quarter second: longer sounds loop it.
  src.loop = length > 0.2;
  src.start(at, Math.random() * 0.05);
  src.stop(at + length);
}

/** A pitched note from `at`, gliding from `freq` to `freqTo`, through a low-pass at `cut` when given. */
function toneAt(at: number, o: { type: OscillatorType; freq: number; freqTo?: number; attack?: number; decay: number; gain: number; cut?: number }) {
  if (!ctx || !master) return;
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
  out.connect(env).connect(master);
  osc.start(at);
  osc.stop(at + attack + o.decay + 0.02);
}

/** Notes of a few bright chords, so heals and stings are not always the same three notes. */
const CHORDS = [[1047, 1319, 1568], [988, 1245, 1480], [1175, 1480, 1760], [932, 1175, 1397]];
const pick = <T,>(xs: readonly T[]) => xs[(Math.random() * xs.length) | 0];

/**
 * One combat sound, now. `big` is a perfect roll (or a boss): a little louder, lower and with an
 * extra crack. Nothing plays while muted or before the page has been touched.
 */
export function playCombat(sound: CombatSound, big = false) {
  if (muted || !ctx || !master || !noise) return;
  try {
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (!ALWAYS.has(sound)) {
      while (combatRecent.length && combatRecent[0] < now - COMBAT_WINDOW) combatRecent.shift();
      if (combatRecent.length >= COMBAT_MAX) return;
      // The same sound twice within a few frames (a sweep hitting several at once) is heard once.
      if (now - (lastOf.get(sound) ?? -1) < 0.05) return;
      combatRecent.push(now);
    }
    lastOf.set(sound, now);
    // Dev server only: the last few combat sounds played, for checking what fired when (`__gqSounds` in the console).
    if (import.meta.env.DEV) {
      const log = ((globalThis as { __gqSounds?: { sound: CombatSound; big: boolean; at: number }[] }).__gqSounds ??= []);
      log.push({ sound, big, at: Math.round(performance.now()) });
      if (log.length > 100) log.shift();
    }
    const v = COMBAT_LEVEL * (big ? 1.4 : 1) * wobble(0.12);
    const p = (big ? 0.85 : 1) * wobble(0.07);
    const t = now + 0.005;
    switch (sound) {
      case "blade":
        // A swish through the air, then a bright bite.
        noiseAt(t, { filter: "bandpass", freq: 700 * p, freqTo: 3200 * p, q: 1.2, attack: 0.03, decay: 0.09, gain: v * 0.55 });
        noiseAt(t + 0.07, { filter: "highpass", freq: 2600 * p, q: 1.5, decay: 0.05, gain: v * 0.7 });
        toneAt(t + 0.07, { type: "square", freq: 820 * p, freqTo: 560 * p, decay: 0.05, gain: v * 0.12, cut: 2400 });
        toneAt(t + 0.07, { type: "sine", freq: 170 * p, freqTo: 90, decay: 0.09, gain: v * 0.6 });
        break;
      case "blunt":
        // A heavy thump with a little grit.
        noiseAt(t, { filter: "bandpass", freq: 500 * p, freqTo: 900 * p, q: 0.8, attack: 0.03, decay: 0.05, gain: v * 0.3 });
        toneAt(t + 0.05, { type: "sine", freq: 120 * p, freqTo: 50, decay: 0.16, gain: v * 1.1 });
        noiseAt(t + 0.05, { filter: "lowpass", freq: 600 * p, q: 0.9, decay: 0.09, gain: v * 0.8 });
        break;
      case "arrow_loose":
        // The bowstring's twang.
        toneAt(t, { type: "triangle", freq: 330 * p, freqTo: 300 * p, decay: 0.16, gain: v * 0.45 });
        noiseAt(t, { filter: "bandpass", freq: 2000 * p, q: 2, decay: 0.03, gain: v * 0.35 });
        break;
      case "arrow_hit":
        // The thunk of it going in.
        noiseAt(t, { filter: "lowpass", freq: 1100 * p, q: 1.2, decay: 0.05, gain: v * 0.8 });
        toneAt(t, { type: "sine", freq: 240 * p, freqTo: 120, decay: 0.07, gain: v * 0.7 });
        break;
      case "spell_cast":
        // A rising whoosh as the bolt leaves.
        noiseAt(t, { filter: "bandpass", freq: 350 * p, freqTo: 1900 * p, q: 3, attack: 0.08, decay: 0.15, gain: v * 0.5 });
        break;
      case "spell_hit":
        // A zap: a falling buzz and a crackle.
        toneAt(t, { type: "sawtooth", freq: 1400 * p, freqTo: 180 * p, decay: 0.13, gain: v * 0.35, cut: 3000 });
        noiseAt(t, { filter: "highpass", freq: 1800 * p, q: 0.8, decay: 0.08, gain: v * 0.5 });
        break;
      case "whiff":
        // Cutting nothing but air.
        noiseAt(t, { filter: "bandpass", freq: 1600 * p, freqTo: 500 * p, q: 1.4, attack: 0.02, decay: 0.12, gain: v * 0.45 });
        break;
      case "fizzle":
        toneAt(t, { type: "sine", freq: 620 * p, freqTo: 260 * p, decay: 0.12, gain: v * 0.35 });
        noiseAt(t, { filter: "highpass", freq: 3000, decay: 0.1, gain: v * 0.15 });
        break;
      case "heal": {
        // A soft rising chime, a different chord each time.
        const chord = pick(CHORDS);
        chord.forEach((f, i) => toneAt(t + i * 0.06, { type: "sine", freq: f, attack: 0.01, decay: 0.32, gain: v * 0.35 }));
        break;
      }
      case "heal_fail":
        toneAt(t, { type: "triangle", freq: 330 * p, freqTo: 220 * p, decay: 0.18, gain: v * 0.35 });
        break;
      case "bleed":
        // A drip.
        toneAt(t, { type: "sine", freq: 700 * p, freqTo: 1500 * p, decay: 0.07, gain: v * 0.4 });
        break;
      case "burn":
        // A short crackle of little pops.
        for (let i = 0; i < 5; i++) noiseAt(t + Math.random() * 0.18, { filter: "highpass", freq: 2200 + Math.random() * 2000, q: 1, decay: 0.015, gain: v * 0.45 });
        noiseAt(t, { filter: "bandpass", freq: 900, q: 0.7, attack: 0.03, decay: 0.15, gain: v * 0.2 });
        break;
      case "stun":
        // Seeing stars: two little falling bell notes.
        toneAt(t, { type: "triangle", freq: 1320 * p, freqTo: 990 * p, decay: 0.12, gain: v * 0.3 });
        toneAt(t + 0.1, { type: "triangle", freq: 990 * p, freqTo: 740 * p, decay: 0.14, gain: v * 0.3 });
        break;
      case "buff":
        toneAt(t, { type: "triangle", freq: 520 * p, freqTo: 880 * p, attack: 0.02, decay: 0.16, gain: v * 0.3 });
        break;
      case "debuff":
        toneAt(t, { type: "triangle", freq: 700 * p, freqTo: 360 * p, attack: 0.02, decay: 0.18, gain: v * 0.3 });
        break;
      case "hero_down":
        // Falling: a sinking groan and the thud of landing.
        toneAt(t, { type: "sawtooth", freq: 320 * p, freqTo: 70, attack: 0.02, decay: 0.45, gain: v * 0.45, cut: 900 });
        toneAt(t + 0.3, { type: "sine", freq: 95, freqTo: 45, decay: 0.2, gain: v * 0.9 });
        noiseAt(t + 0.3, { filter: "lowpass", freq: 400, decay: 0.12, gain: v * 0.5 });
        break;
      case "enemy_down":
        // A puff and a falling blip.
        noiseAt(t, { filter: "lowpass", freq: 2400 * p, freqTo: 300, q: 0.8, attack: 0.01, decay: 0.22, gain: v * 0.5 });
        toneAt(t + 0.02, { type: "square", freq: 660 * p, freqTo: 180 * p, decay: 0.18, gain: v * 0.16, cut: 2000 });
        break;
      case "boss_down":
        noiseAt(t, { filter: "lowpass", freq: 1800, freqTo: 120, q: 0.7, attack: 0.02, decay: 0.7, gain: v * 0.7 });
        toneAt(t, { type: "sawtooth", freq: 180, freqTo: 40, attack: 0.02, decay: 0.8, gain: v * 0.45, cut: 600 });
        toneAt(t + 0.05, { type: "sine", freq: 70, freqTo: 35, decay: 0.5, gain: v });
        break;
      case "boss":
        // Something big has turned up: a low swell and a dull gong.
        toneAt(t, { type: "sawtooth", freq: 55, attack: 0.35, decay: 1.4, gain: v * 0.5, cut: 380 });
        toneAt(t, { type: "sawtooth", freq: 82.4 * wobble(0.01), attack: 0.35, decay: 1.4, gain: v * 0.4, cut: 380 });
        toneAt(t + 0.05, { type: "sine", freq: 110, freqTo: 104, decay: 1.8, gain: v * 0.6 });
        break;
      case "victory": {
        // Up the chord and hold the top.
        const [a, b, c] = pick(CHORDS).map((f) => f / 2);
        [a, b, c, a * 2].forEach((f, i) => toneAt(t + i * 0.11, { type: "triangle", freq: f, attack: 0.01, decay: i === 3 ? 0.55 : 0.16, gain: v * 0.45 }));
        break;
      }
      case "defeat":
        // Down a minor third or two, slow.
        [392, 311, 262].forEach((f, i) => toneAt(t + i * 0.2, { type: "triangle", freq: f * wobble(0.01), attack: 0.02, decay: i === 2 ? 0.7 : 0.22, gain: v * 0.45 }));
        break;
      case "your_turn":
        toneAt(t, { type: "sine", freq: 1180 * p, decay: 0.05, gain: v * 0.22 });
        toneAt(t + 0.07, { type: "sine", freq: 1580 * p, decay: 0.07, gain: v * 0.22 });
        break;
    }
  } catch {
    // A sound missed is no loss.
  }
}
