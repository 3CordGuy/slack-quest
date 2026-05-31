// Procedural sound effects for camp mini-games via Web Audio API.
// No audio files — every sound is synthesized at call time.
//
// The AudioContext is created lazily on the first play call. This sidesteps
// browser autoplay restrictions because every entry point (clicking Quick
// Strike, swinging the hammer, etc.) is a user gesture.
//
// Mute persists via localStorage("sounds_muted") to match the convention used
// elsewhere in the app (see CombatPage's combat_auto_resolve flag).

let ctx: AudioContext | null = null;

function isMuted(): boolean {
  try {
    return localStorage.getItem("sounds_muted") === "true";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem("sounds_muted", muted ? "true" : "false");
  } catch {
    /* localStorage unavailable — silently ignore */
  }
}

export function getMuted(): boolean {
  return isMuted();
}

function getCtx(): AudioContext | null {
  if (isMuted()) return null;
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

// Schedule a basic oscillator with linear attack + exponential decay.
function tone(opts: {
  type?: OscillatorType;
  startFreq: number;
  endFreq?: number;
  duration: number;
  gain?: number;
  attack?: number;
  delay?: number;
}): void {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  const gainNode = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.startFreq, t0);
  if (opts.endFreq != null && opts.endFreq !== opts.startFreq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(0.0001, opts.endFreq), t0 + opts.duration);
  }
  const peak = opts.gain ?? 0.2;
  const attack = opts.attack ?? 0.005;
  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.linearRampToValueAtTime(peak, t0 + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  osc.connect(gainNode);
  gainNode.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.02);
}

// Short filtered-noise burst — useful for impacts, rustles, splashes.
function noiseBurst(opts: {
  duration: number;
  gain?: number;
  filterType?: BiquadFilterType;
  filterFreq?: number;
  delay?: number;
}): void {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const samples = Math.max(1, Math.floor(c.sampleRate * opts.duration));
  const buf = c.createBuffer(1, samples, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = opts.filterType ?? "lowpass";
  filter.frequency.value = opts.filterFreq ?? 800;
  const gainNode = c.createGain();
  const peak = opts.gain ?? 0.2;
  gainNode.gain.setValueAtTime(peak, t0);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  src.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(c.destination);
  src.start(t0);
  src.stop(t0 + opts.duration + 0.02);
}

// === Mining ===

// Soft tick under the swinging marker. Cheap to call on every animation frame
// crossing event — kept very short so it doesn't pile up.
export function playGaugeSwing(): void {
  noiseBurst({ duration: 0.04, gain: 0.04, filterType: "highpass", filterFreq: 2000 });
}

// Dull thud on plain rock — low sine + low-pass noise.
export function playDullRock(): void {
  tone({ type: "sine", startFreq: 110, endFreq: 60, duration: 0.18, gain: 0.28 });
  noiseBurst({ duration: 0.1, gain: 0.12, filterType: "lowpass", filterFreq: 300 });
}

// Soft clink for thin seam — mid-high triangle pop.
export function playThinSeam(): void {
  tone({ type: "triangle", startFreq: 620, endFreq: 420, duration: 0.18, gain: 0.22 });
  tone({ type: "sine", startFreq: 950, endFreq: 700, duration: 0.12, gain: 0.12, delay: 0.02 });
}

// Bright metallic ring for rich vein — sweep + harmonic shimmer.
export function playRichVein(): void {
  tone({ type: "square", startFreq: 880, endFreq: 320, duration: 0.32, gain: 0.18 });
  tone({ type: "sine", startFreq: 1320, endFreq: 660, duration: 0.32, gain: 0.16, delay: 0.01 });
  tone({ type: "sine", startFreq: 1760, endFreq: 1100, duration: 0.25, gain: 0.1, delay: 0.04 });
}

// Ascending 4-note fanfare on completion.
export function playMinigameComplete(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    tone({ type: "triangle", startFreq: freq, duration: 0.18, gain: 0.18, delay: i * 0.09 });
  });
}
