// The pen and palette every code-drawn 16x16 icon is painted with: gear and
// materials in itemArt.ts, and the pub, brews and hut furniture in
// thingArt.ts. Kept apart so both tables can share it without importing
// each other.

export const C = {
  steel: "#c9d1dc",
  shine: "#f1f5fa",
  iron: "#8b95a5",
  wood: "#8a5a2b",
  bark: "#5a3d22",
  leather: "#a0683a",
  hide: "#6b4a2b",
  gold: "#e0b12e",
  paper: "#e8dcc0",
  bone: "#eee6cf",
  dark: "#2a2740",
};

export interface Pen {
  /** Filled rectangle. */
  r(x: number, y: number, w: number, h: number, color: string): void;
  /** One-pixel line between two points. */
  l(x0: number, y0: number, x1: number, y1: number, color: string): void;
  accent: string;
  shade: string;
}

export type Art = (p: Pen) => void;

/** Rows of a filled shape given as [y, x0, x1] spans. */
export const spans = (p: Pen, color: string, rows: [number, number, number][]) => rows.forEach(([y, a, b]) => p.r(a, y, b - a + 1, 1, color));
