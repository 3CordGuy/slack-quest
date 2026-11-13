// Timing: the marker a gatherer stops. Fishing, the quarry and felling's
// splitting block all use it. Having chosen where, the player stops a marker
// moving along a bar, and how close it is to the mark shifts the chance of
// each roll. The marker's motion is set by the server from the outing's seed;
// the server also times the stop itself, and only believes the moment the
// client reports within a round trip of what it saw.

/** How a marker moves: a fish darting about a line, or a pick swinging back and forth. */
export interface Motion {
  kind: "dart" | "swing";
  /** Milliseconds for one full cycle. */
  period: number;
  /** Where in its cycle the marker starts, 0 to 1. */
  phase: number;
  /** The mark: its centre on the bar (0 to 1) and its full width. */
  zone: number;
  width: number;
}

/** What a stop was worth: how it is named, and the points it adds to each roll. */
export const TIMING = {
  perfect: { label: "Perfect", bonus: 20 },
  good: { label: "Good", bonus: 10 },
  close: { label: "Close", bonus: 0 },
  miss: { label: "Missed", bonus: -15 },
  late: { label: "Too slow", bonus: -15 },
} as const;
export type TimingGrade = keyof typeof TIMING;
/** Longer than this and the moment has passed. */
export const TIMING_LIMIT_MS = 10_000;

/**
 * How much a hero's stat eases the timing. `pct` is their chance per roll for the spot's stat (20 to 95):
 * the weakest get a mark 0.7 times as wide and a marker 0.85 times as slow; the strongest 1.4 and 1.25.
 */
export function timingEase(pct: number): { width: number; pace: number } {
  const t = Math.max(0, Math.min(1, (pct - 20) / 75));
  return { width: 0.7 + 0.7 * t, pace: 0.85 + 0.4 * t };
}

/** Where the marker is on the bar, 0 to 1, `ms` after it started moving. */
export function markerAt(m: Motion, ms: number): number {
  const turn = ms / m.period + m.phase;
  if (m.kind === "swing") return 0.5 - 0.5 * Math.cos(2 * Math.PI * turn);
  // A fish: a long run back and forth with a quicker flick on top.
  const x = 0.5 + 0.4 * Math.sin(2 * Math.PI * turn) + 0.08 * Math.sin(2 * Math.PI * turn * 2.7 + m.phase * 9);
  return Math.max(0, Math.min(1, x));
}

/** How good a stop `ms` after the start was. No moment at all (an outing from before timing) counts as close. */
export function timingGrade(m: Motion, ms: number | undefined): TimingGrade {
  if (ms === undefined || !Number.isFinite(ms)) return "close";
  if (ms > TIMING_LIMIT_MS) return "late";
  const off = Math.abs(markerAt(m, ms) - m.zone);
  if (off <= m.width * 0.18) return "perfect";
  if (off <= m.width / 2) return "good";
  if (off <= m.width) return "close";
  return "miss";
}

