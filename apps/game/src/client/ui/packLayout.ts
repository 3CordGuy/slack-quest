// Where each thing lies in the pack's grid. The rules only count squares
// (carry.ts); the arrangement is the player's, kept per browser.
//
// A thing with a remembered place that is still free goes back there.
// Anything new takes the first gap that fits it, filling the grid a column
// at a time from the top left. If a new thing fits nowhere as things lie,
// the whole pack is tidied (biggest first) to make the room the rules say
// there is. Whatever still does not fit, in a pack that is over the limit
// or too awkwardly shaped, is laid out in extra rows under the grid.
//
// A chest in the hut is the same kind of grid, as many rows deep as it is
// big (hut.ts), and is laid out and remembered the same way, per chest.

import { PACK_COLS, PACK_ROWS } from "@gantt-quest/world";

export interface Shape {
  key: string;
  w: number;
  h: number;
}

export interface Spot {
  x: number;
  y: number;
}

export type Saved = Record<string, Spot>;

export interface Layout {
  spots: Map<string, Spot>;
  /** Rows drawn: the grid's own, or more while something spills over. */
  rows: number;
}

class Grid {
  private cells = new Map<number, string>();
  rows: number;
  /** `base` is how many rows the grid really has. */
  constructor(private base: number) {
    this.rows = base;
  }
  at(x: number, y: number) {
    return this.cells.get(y * PACK_COLS + x);
  }
  fits(s: Shape, x: number, y: number, maxRows = this.base) {
    if (x < 0 || y < 0 || x + s.w > PACK_COLS || y + s.h > maxRows) return false;
    for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) if (this.at(x + dx, y + dy)) return false;
    return true;
  }
  put(s: Shape, x: number, y: number) {
    for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) this.cells.set((y + dy) * PACK_COLS + x + dx, s.key);
    this.rows = Math.max(this.rows, y + s.h);
  }
  /** The first gap for `s`, a column at a time; in the grid proper, or (with `spill`) in the rows under it. */
  gap(s: Shape, spill = false): Spot | null {
    const from = spill ? this.base : 0;
    const to = spill ? this.rows + s.h : this.base;
    for (let x = 0; x + s.w <= PACK_COLS; x++) for (let y = from; y + s.h <= to; y++) if (this.fits(s, x, y, to)) return { x, y };
    return null;
  }
}

function pack(shapes: Shape[], saved: Saved, rows: number): Layout | null {
  const grid = new Grid(rows);
  const spots = new Map<string, Spot>();
  const loose: Shape[] = [];
  for (const s of shapes) {
    const at = saved[s.key];
    if (at && grid.fits(s, at.x, at.y)) {
      grid.put(s, at.x, at.y);
      spots.set(s.key, at);
    } else loose.push(s);
  }
  for (const s of loose) {
    const at = grid.gap(s);
    if (!at) return null;
    grid.put(s, at.x, at.y);
    spots.set(s.key, at);
  }
  return { spots, rows: grid.rows };
}

/** Lay a grid of `rows` rows out (the pack, unless told otherwise): remembered places first, then first gaps, tidying or spilling over only when it must. */
export function layoutPack(shapes: Shape[], saved: Saved, rows = PACK_ROWS): Layout {
  const kept = pack(shapes, saved, rows);
  if (kept) return kept;
  // Tidy: tallest and widest first packs tightest.
  const sorted = [...shapes].sort((a, b) => b.h - a.h || b.w - a.w);
  const grid = new Grid(rows);
  const spots = new Map<string, Spot>();
  for (const s of sorted) {
    const at = grid.gap(s) ?? grid.gap(s, true)!;
    grid.put(s, at.x, at.y);
    spots.set(s.key, at);
  }
  return { spots, rows: grid.rows };
}

/** The other things a shape set down at (x, y) would lie on. */
export function under(shapes: Shape[], spots: Map<string, Spot>, s: Shape, x: number, y: number): string[] {
  const hit: string[] = [];
  for (const o of shapes) {
    if (o.key === s.key) continue;
    const at = spots.get(o.key);
    if (at && x < at.x + o.w && at.x < x + s.w && y < at.y + o.h && at.y < y + s.h) hit.push(o.key);
  }
  return hit;
}

/** `chest` is the id of a container in the hut; without it, the pack. */
const storeKey = (playerId: string, chest?: number) => (chest === undefined ? `gq.pack.${playerId}` : `gq.chest.${playerId}.${chest}`);

export function loadSaved(playerId: string, chest?: number): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(playerId, chest)) ?? "{}") as Saved;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveSaved(playerId: string, spots: Map<string, Spot>, chest?: number) {
  try {
    localStorage.setItem(storeKey(playerId, chest), JSON.stringify(Object.fromEntries(spots)));
  } catch {
    // Not remembered: the pack is laid out afresh next time.
  }
}
