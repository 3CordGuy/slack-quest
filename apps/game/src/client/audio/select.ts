// Small pure pieces of the engine, kept apart so they can be tested without a
// browser: naming, matching file patterns, falling back from a specific sound
// to a general one, and picking the next take.

/** A display name as a sound name: "Aimed Shot" → "aimed_shot". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const patternCache = new Map<string, RegExp>();

function patternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    re = new RegExp(`^${body}$`);
    patternCache.set(pattern, re);
  }
  return re;
}

/** The file keys matched by an event's `files`, in a stable order, each once. */
export function expandFiles(patterns: string | string[], keys: Iterable<string>): string[] {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const all = [...keys];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    const matches = p.includes("*") ? all.filter((k) => patternRegex(p).test(k)).sort() : all.includes(p) ? [p] : [];
    for (const m of matches) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * Which takes an event plays: its real recordings when it has any; else its built-in sounds
 * (`fallback`); a placeholder only when there is nothing else at all.
 */
export function chooseTakes(ev: { files: string | string[]; fallback?: string | string[] }, keys: Iterable<string>, isPlaceholder: (key: string) => boolean): string[] {
  const all = [...keys];
  const takes = expandFiles(ev.files, all);
  const real = takes.filter((k) => !isPlaceholder(k));
  if (real.length > 0) return real;
  const built = ev.fallback ? expandFiles(ev.fallback, all) : [];
  return built.length > 0 ? built : takes;
}

/** The first name that can sound, most specific first; null when none can. */
export function resolveName(candidates: string[], playable: (name: string) => boolean): string | null {
  for (const name of candidates) if (playable(name)) return name;
  return null;
}

export type Order = "random" | "shuffle" | "sequence";

/** Picks the next take of one sound, remembering what it played. */
export class TakePicker {
  private last = -1;
  private deck: number[] = [];

  next(count: number, order: Order = "random", rng: () => number = Math.random): number {
    if (count <= 1) return (this.last = 0);
    if (order === "sequence") return (this.last = (this.last + 1) % count);
    if (order === "shuffle") {
      if (this.deck.length === 0 || this.deck.some((i) => i >= count)) {
        this.deck = Array.from({ length: count }, (_, i) => i);
        for (let i = count - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
        // A fresh deck never opens with the take that closed the last one.
        if (this.deck[this.deck.length - 1] === this.last) this.deck.unshift(this.deck.pop()!);
      }
      return (this.last = this.deck.pop()!);
    }
    // Random, never the same take twice in a row.
    if (this.last < 0 || this.last >= count) return (this.last = Math.min(count - 1, Math.floor(rng() * count)));
    let pick = Math.min(count - 2, Math.floor(rng() * (count - 1)));
    if (pick >= this.last) pick += 1;
    return (this.last = pick);
  }
}

/**
 * How a sound placed in the world reaches you. `dx`, `dz` is where it is from
 * where you stand, and `yaw` how the camera is turned about the map, so that
 * left and right match the screen. Gives its level, its pan (−1 left to 1
 * right; near sounds stay close to the middle) and a low-pass cutoff in Hz
 * that comes down with distance, as air takes the top off.
 */
export function placeSound(dx: number, dz: number, yaw: number, ref = 4, max = 32): Placed {
  const dist = Math.hypot(dx, dz);
  const side = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const ahead = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));
  const far = Math.max(0, Math.min(1, (dist - ref) / (max - ref)));
  return { gain: distanceGain(dist, ref, max), pan: Math.max(-1, Math.min(1, (side / Math.hypot(dist, 2.5)) * 0.9)), cutoff: 20000 * 2 ** (-3 * far), side, ahead };
}

/** A sound's place around you. `side` and `ahead` are map units to the right of the screen and up it, for headphone (HRTF) placing. */
export interface Placed {
  gain: number;
  pan: number;
  cutoff: number;
  side: number;
  ahead: number;
}

/** The level a curve gives at `x`: straight lines between its points, flat beyond its ends. */
export function curveAt(curve: [number, number][], x: number): number {
  if (curve.length === 0) return 1;
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x > x1) continue;
    const [x0, y0] = curve[i - 1];
    return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return curve[curve.length - 1][1];
}

/**
 * Seconds until the next bar (or beat) line of a playing loop. `elapsed` is
 * how long it has played and `offset` where in the file it started; bars are
 * counted from `origin` (the file's start, or its loop start).
 */
export function untilNextLine(elapsed: number, offset: number, region: { start: number; end: number }, origin: number, unit: number): number {
  let pos = offset + elapsed;
  const span = region.end - region.start;
  if (pos >= region.end && span > 0) pos = region.start + ((pos - region.start) % span);
  const into = (((pos - origin) % unit) + unit) % unit;
  const wait = unit - into;
  // Too close to make cleanly: take the line after.
  return wait < 0.03 ? wait + unit : wait;
}

/** How long a piece rests before its next play, in seconds: its `gap` as it is, or somewhere in its range. Never less than nothing. */
export function nextGap(gap: number | [number, number] | undefined, rng: () => number = Math.random): number {
  if (gap === undefined) return 0;
  return Math.max(0, typeof gap === "number" ? gap : inRange(gap, rng));
}

/** A random value in a range, or `fallback` without one. */
export function inRange(range: [number, number] | undefined, rng: () => number = Math.random, fallback = 0): number {
  if (!range) return fallback;
  return range[0] + (range[1] - range[0]) * rng();
}

/**
 * Distance falloff for a sound placed in the world, from where you stand: full
 * within `ref`, then inverse distance, silent past `max`. The same curve as a
 * Web Audio panner's "inverse" model.
 */
export function distanceGain(distance: number, ref = 4, max = 32, rolloff = 1): number {
  if (distance >= max) return 0;
  if (distance <= ref) return 1;
  return ref / (ref + rolloff * (distance - ref));
}
