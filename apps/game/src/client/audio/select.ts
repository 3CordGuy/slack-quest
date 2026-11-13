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
