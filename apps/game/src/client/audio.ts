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
