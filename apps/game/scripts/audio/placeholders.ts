// Rough synthesized stand-ins for every file the starter manifest names, so
// the engine can be heard before the real sounds exist. Run with
// `pnpm audio:placeholders`. It never overwrites a file of yours: only missing
// files, and placeholders it made before, are written. Each is tagged inside
// the WAV, and `pnpm audio:build` leaves tagged files out of what ships.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_TAG, readWav } from "./wav.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../audio");
const RATE = 48000;

let seed = 1;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const noise = () => rand() * 2 - 1;

type Synth = (t: number, i: number) => number;

function render(seconds: number, fn: Synth): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE, i);
  return out;
}

/** A one-pole low-pass over noise, for thuds and wash. */
function filtered(seconds: number, cutoff: (t: number) => number, env: (t: number) => number): Float32Array {
  let y = 0;
  return render(seconds, (t) => {
    const a = Math.min(1, (2 * Math.PI * cutoff(t)) / RATE);
    y += a * (noise() - y);
    return y * env(t);
  });
}

const decay = (rate: number) => (t: number) => Math.exp(-t * rate);
const tone = (seconds: number, freq: (t: number) => number, env: (t: number) => number, shape: (p: number) => number = Math.sin) => {
  let phase = 0;
  return render(seconds, (t) => {
    phase += (2 * Math.PI * freq(t)) / RATE;
    return shape(phase) * env(t);
  });
};
const square = (p: number): number => (Math.sin(p) >= 0 ? 0.5 : -0.5);

function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

function after(seconds: number, part: Float32Array): Float32Array {
  const out = new Float32Array(part.length + Math.round(seconds * RATE));
  out.set(part, out.length - part.length);
  return out;
}

/** A few notes one after another: [frequency, seconds each]. */
function notes(freqs: number[], each: number, shape = square, level = 0.5): Float32Array {
  return mix(...freqs.map((f, i) => after(i * each, tone(each * 1.6, () => f, (t) => level * Math.min(1, t * 200) * Math.exp(-t * (3 / each)), shape))));
}

/** Make a buffer loop cleanly: fold its last stretch back over its start. */
function seamless(samples: Float32Array, overlap: number): Float32Array {
  const n = Math.round(overlap * RATE);
  const out = samples.slice(0, samples.length - n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] = samples[i] * Math.sin((k * Math.PI) / 2) + samples[samples.length - n + i] * Math.cos((k * Math.PI) / 2);
  }
  return out;
}

/** A looping tune: a bass note and an arpeggio per bar, in whole bars so the file loops as it is. */
function tune(bpm: number, chords: number[][], shape: (p: number) => number): Float32Array {
  const beat = 60 / bpm;
  const parts: Float32Array[] = [];
  chords.forEach((chord, bar) => {
    parts.push(after(bar * 4 * beat, tone(4 * beat, () => chord[0] / 2, (t) => 0.22 * Math.min(1, t * 50) * Math.min(1, (4 * beat - t) * 20))));
    for (let step = 0; step < 8; step++) {
      const f = chord[[0, 1, 2, 1, 3, 2, 1, 2][step] % chord.length];
      parts.push(after((bar * 4 + step / 2) * beat, tone(beat / 2, () => f, (t) => 0.16 * Math.min(1, t * 300) * Math.min(1, (beat / 2 - t) * 60) * Math.exp(-t * 5), shape)));
    }
  });
  return mix(...parts).slice(0, Math.round(chords.length * 4 * beat * RATE));
}

function wav(samples: Float32Array): Buffer {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0.9 ? 0.9 / peak : 1;
  const tag = Buffer.from(`INFOISFT${"\0".repeat(4)}${PLACEHOLDER_TAG}\0\0`, "latin1");
  tag.writeUInt32LE(PLACEHOLDER_TAG.length + 2, 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length * 2 + 8 + tag.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length * 2, 40);
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * scale)) * 32767), i * 2);
  const list = Buffer.alloc(8);
  list.write("LIST", 0, "latin1");
  list.writeUInt32LE(tag.length, 4);
  return Buffer.concat([header, data, list, tag]);
}

const files: Record<string, () => Float32Array> = {};
const takes = (base: string, count: number, make: (take: number) => Float32Array) => {
  for (let i = 1; i <= count; i++) files[`${base}_${String(i).padStart(2, "0")}`] = () => make(i);
};

// Footsteps: a short thud, brighter or duller by the ground.
const footstep = (cutoff: number, rate: number, level: number) => (take: number) => filtered(0.16, (t) => cutoff * (0.85 + take * 0.1) * Math.exp(-t * 12), (t) => level * Math.exp(-t * rate));
takes("sfx/footsteps/grass", 3, footstep(2600, 38, 1.6));
takes("sfx/footsteps/stone", 3, (take) => mix(footstep(5200, 60, 1.4)(take), tone(0.05, () => 900 + take * 120, decay(110))));
takes("sfx/footsteps/wood", 3, (take) => mix(footstep(900, 30, 2)(take), tone(0.12, () => 150 + take * 14, (t) => 0.7 * Math.exp(-t * 34))));
takes("sfx/footsteps/mud", 3, (take) => filtered(0.24, (t) => 500 + 900 * Math.sin(Math.min(1, t * 8) * Math.PI) + take * 60, (t) => 2.2 * Math.sin(Math.min(1, t / 0.24) * Math.PI) ** 2));

// Combat.
takes("sfx/combat/swing", 2, (take) => filtered(0.22, (t) => 600 + 3800 * Math.sin((t / 0.22) * Math.PI) + take * 300, (t) => 1.5 * Math.sin((t / 0.22) * Math.PI) ** 2));
takes("sfx/combat/bow", 1, () => mix(tone(0.25, (t) => 240 * Math.exp(-t * 6), (t) => 0.7 * Math.exp(-t * 18), square), filtered(0.18, () => 5000, (t) => 0.7 * Math.exp(-t * 30))));
takes("sfx/combat/cast", 1, () => tone(0.34, (t) => 320 + 1500 * (t / 0.34) ** 2, (t) => 0.5 * Math.sin((t / 0.34) * Math.PI)));
takes("sfx/combat/hit", 3, (take) => mix(filtered(0.2, (t) => 3200 * Math.exp(-t * 20), (t) => 2 * Math.exp(-t * 26)), tone(0.2, (t) => (100 + take * 14) * Math.exp(-t * 7), (t) => 0.9 * Math.exp(-t * 16))));
takes("sfx/combat/magic_hit", 1, () => mix(tone(0.35, (t) => 1300 * Math.exp(-t * 7), (t) => 0.5 * Math.exp(-t * 9)), filtered(0.3, () => 7000, (t) => 0.6 * Math.exp(-t * 14))));
takes("sfx/combat/crit", 1, () => mix(tone(0.4, () => 1568, (t) => 0.4 * Math.exp(-t * 8)), tone(0.4, () => 2349, (t) => 0.3 * Math.exp(-t * 10))));
takes("sfx/combat/miss", 1, () => filtered(0.2, (t) => 2500 + 4000 * (t / 0.2), (t) => 0.9 * Math.sin((t / 0.2) * Math.PI) ** 3));
takes("sfx/combat/heal", 1, () => notes([523, 659, 784, 1047], 0.08, Math.sin, 0.45));
takes("sfx/combat/tick", 1, () => filtered(0.12, () => 6000, (t) => 0.9 * Math.exp(-t * 40)));
takes("sfx/combat/down", 1, () => mix(tone(0.5, (t) => 180 * Math.exp(-t * 4), (t) => 0.9 * Math.exp(-t * 6)), filtered(0.4, () => 700, (t) => 1.6 * Math.exp(-t * 9))));

// Moments.
files["sfx/ui/your_turn"] = () => notes([784, 1047], 0.09, Math.sin, 0.4);
files["sfx/ui/level_up"] = () => notes([523, 659, 784, 1047, 1319], 0.09);
files["sfx/ui/loot"] = () => notes([659, 988], 0.07);
files["sfx/ui/gold"] = () => notes([1976, 2637], 0.05, Math.sin, 0.35);
files["sfx/ui/pickup"] = () => tone(0.12, (t) => 500 + 900 * (t / 0.12), (t) => 0.4 * Math.sin((t / 0.12) * Math.PI));
files["music/stingers/battle_start"] = () => notes([196, 233, 196, 294], 0.13);
files["music/stingers/victory"] = () => notes([392, 523, 659, 784, 1047], 0.14);
files["music/stingers/defeat"] = () => notes([392, 349, 311, 262, 196], 0.2);

// Loops.
const A = [220, 262, 330, 440];
const F = [175, 220, 262, 349];
const C = [262, 330, 392, 523];
const G = [196, 247, 294, 392];
const E = [165, 208, 247, 330];
files["music/harbor"] = () => tune(84, [C, A, F, G], Math.sin);
// A stem for the Harbor tune that comes in at night: the same chords, held, an octave up. Exactly as long as the tune.
files["music/harbor_night"] = () => {
  const bar = (60 / 84) * 4;
  return mix(...[C, A, F, G].flatMap((chord, i) => [chord[2] * 2, chord[3] * 2].map((f) => after(i * bar, tone(bar, (t) => f * (1 + 0.004 * Math.sin(t * 30)), (t) => 0.12 * Math.sin((t / bar) * Math.PI)))))).slice(0, Math.round(4 * bar * RATE));
};
files["music/island"] = () => tune(96, [A, F, C, E], Math.sin);
files["music/battle"] = () => tune(138, [A, A, F, E], square);
// Rain: bright hiss. Night: a cricket-like chirp, pulsing.
files["ambience/rain"] = () => seamless(mix(filtered(10, () => 9000, () => 0.5), filtered(10, () => 1200, () => 0.6)), 2);
files["ambience/night"] = () => tone(8, () => 4200, (t) => 0.12 * (Math.sin(t * 2 * Math.PI * 22) > 0.2 ? 1 : 0) * (Math.sin(t * 2 * Math.PI * 1.5) > 0 ? 1 : 0));
files["ambience/shore"] = () => seamless(filtered(14, (t) => 500 + 700 * (0.5 + 0.5 * Math.sin((t / 6) * 2 * Math.PI)), (t) => 1.2 * (0.45 + 0.55 * Math.sin((t / 6) * Math.PI) ** 2)), 2);
// A fire: a low roar with sharp crackles scattered over it.
files["ambience/fire"] = () => {
  const pops = render(6, () => (rand() < 0.0009 ? 1 : 0));
  let env = 0;
  let y = 0;
  const crackle = render(6, (_t, i) => {
    env = Math.max(pops[i], env * 0.996);
    y += 0.6 * (noise() - y);
    return y * env * 0.9;
  });
  return seamless(mix(crackle, filtered(6, () => 260, (t) => 1.1 * (0.8 + 0.2 * Math.sin(t * 9)))), 1);
};
files["ambience/room"] = () => seamless(filtered(8, () => 180, () => 1.5), 2);

// Impulse responses: a burst of noise dying away, longer and brighter or shorter and duller by the place.
const impulse = (seconds: number, cutoff: number, early = 0) =>
  filtered(seconds, (t) => cutoff * Math.exp(-t * (1.5 / seconds)) + 300, (t) => (t < 0.004 ? 0 : Math.exp(-t * (6.9 / seconds))) * (1 + early * Math.exp(-t * 60)));
files["ir/room"] = () => impulse(0.45, 5000, 2);
files["ir/hall"] = () => impulse(1.1, 4000, 1);
files["ir/open"] = () => impulse(0.3, 2500, 3);
files["ir/woods"] = () => impulse(0.8, 1800);
files["ir/stone"] = () => impulse(1.4, 7000, 1);

let written = 0;
let kept = 0;
for (const [key, make] of Object.entries(files)) {
  const path = join(SRC, `${key}.wav`);
  // Yours, not a placeholder: leave it alone.
  if (existsSync(path) && !readWav(path)?.placeholder) {
    kept++;
    continue;
  }
  seed = [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, wav(make()));
  written++;
}
console.log(`${written} placeholder${written === 1 ? "" : "s"} written to ${SRC}${kept ? `; ${kept} file${kept === 1 ? "" : "s"} of yours left alone` : ""}.`);
