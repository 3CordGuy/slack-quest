// Pixel-art item icons, drawn in code in the same style as the character
// sprites in render/sprites.ts: a 16x16 figure in a few flat colours with a
// dark one-pixel outline, shown with nearest-neighbour scaling.
//
// Each icon is keyed by the item's `icon` name. One colour in every icon,
// the "accent", is the item's rarity colour, so a rare helm has a blue plume
// and an epic one a purple plume.

const SIZE = 16;
/** Canvas is one pixel larger on every side to leave room for the outline. */
export const ART_PIXELS = SIZE + 2;
const OUTLINE = "#1b1830";

const C = {
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

interface Pen {
  /** Filled rectangle. */
  r(x: number, y: number, w: number, h: number, color: string): void;
  /** One-pixel line between two points. */
  l(x0: number, y0: number, x1: number, y1: number, color: string): void;
  accent: string;
  shade: string;
}

type Art = (p: Pen) => void;

/** Rows of a filled shape given as [y, x0, x1] spans. */
const spans = (p: Pen, color: string, rows: [number, number, number][]) => rows.forEach(([y, a, b]) => p.r(a, y, b - a + 1, 1, color));

const ART: Record<string, Art> = {
  // ---- weapons ----
  broadsword: (p) => {
    p.r(7, 1, 2, 10, C.steel);
    p.r(7, 1, 1, 10, C.shine);
    p.r(7, 0, 1, 1, C.shine);
    p.r(4, 11, 8, 1, C.gold);
    p.r(7, 12, 2, 3, C.bark);
    p.r(7, 15, 2, 1, p.accent);
  },
  "hammer-drop": (p) => {
    p.r(7, 6, 2, 9, C.wood);
    p.r(4, 1, 8, 5, C.iron);
    p.r(5, 2, 6, 1, C.steel);
    p.r(3, 2, 1, 3, C.steel);
    p.r(12, 2, 1, 3, C.steel);
    p.r(7, 3, 2, 2, p.accent);
    p.r(7, 15, 2, 1, C.gold);
  },
  "wizard-staff": (p) => {
    p.r(7, 5, 2, 11, C.wood);
    p.r(8, 5, 1, 11, C.bark);
    p.r(6, 0, 4, 4, p.accent);
    p.r(7, 1, 1, 1, C.shine);
    p.r(5, 3, 1, 2, C.gold);
    p.r(10, 3, 1, 2, C.gold);
    p.r(6, 4, 4, 1, C.gold);
  },
  "scroll-unfurled": (p) => {
    // A closed tome.
    p.r(3, 2, 10, 12, p.accent);
    p.r(3, 2, 2, 12, p.shade);
    p.r(5, 13, 8, 1, C.paper);
    p.r(7, 5, 4, 4, C.gold);
    p.r(8, 6, 2, 2, p.shade);
    p.r(12, 7, 1, 2, C.gold);
  },
  daggers: (p) => {
    p.l(3, 1, 8, 6, C.steel);
    p.l(4, 1, 9, 6, C.shine);
    p.l(12, 1, 7, 6, C.steel);
    p.l(11, 1, 6, 6, C.iron);
    p.r(5, 7, 6, 1, C.gold);
    p.l(9, 8, 12, 11, C.bark);
    p.l(6, 8, 3, 11, C.bark);
    p.r(12, 12, 1, 1, p.accent);
    p.r(3, 12, 1, 1, p.accent);
  },
  crossbow: (p) => {
    // A short bow with an arrow nocked.
    spans(p, C.wood, [[1, 9, 10], [2, 11, 11], [3, 12, 12], [12, 12, 12], [13, 11, 11], [14, 9, 10]]);
    p.r(12, 4, 2, 8, C.wood);
    p.r(13, 6, 1, 4, p.accent);
    p.r(8, 2, 1, 12, C.paper);
    p.r(2, 7, 11, 1, C.bark);
    spans(p, C.steel, [[6, 2, 2], [7, 1, 2], [8, 2, 2]]);
    p.r(9, 6, 2, 1, p.accent);
    p.r(9, 8, 2, 1, p.accent);
  },

  // ---- armor ----
  "root-staff": (p) => {
    // A crooked staff, roots at the top, a leaf budding.
    p.l(4, 15, 9, 4, C.wood);
    p.l(5, 15, 10, 4, C.bark);
    p.l(9, 4, 7, 1, C.wood);
    p.l(10, 4, 13, 2, C.wood);
    p.l(9, 4, 9, 1, C.bark);
    p.r(12, 1, 2, 2, "#a6d06a");
    p.r(6, 0, 2, 1, p.accent);
  },
  sickle: (p) => {
    // A curved blade on a short handle.
    p.l(3, 14, 7, 10, C.wood);
    p.l(4, 14, 8, 10, C.bark);
    spans(p, C.steel, [[2, 7, 11], [3, 11, 13], [4, 13, 14], [5, 14, 14], [6, 14, 14], [7, 13, 14], [8, 11, 13]]);
    spans(p, C.shine, [[3, 8, 10], [4, 11, 12]]);
    p.r(7, 10, 2, 1, p.accent);
  },
  lute: (p) => {
    // A round body, a long neck, the pegs bent back.
    spans(p, C.leather, [[8, 4, 9], [9, 3, 10], [10, 2, 11], [11, 2, 11], [12, 2, 11], [13, 3, 10], [14, 4, 9]]);
    p.r(6, 11, 2, 2, C.dark);
    p.l(8, 8, 13, 3, C.wood);
    p.l(9, 8, 14, 3, C.bark);
    p.r(13, 1, 2, 2, p.accent);
    p.l(5, 10, 11, 4, C.paper);
  },
  flute: (p) => {
    // A pale pipe on the slant, finger holes along it.
    p.l(2, 14, 13, 3, C.paper);
    p.l(3, 14, 14, 3, C.bone);
    p.l(2, 13, 12, 3, C.paper);
    for (const [x, y] of [[5, 11], [7, 9], [9, 7], [11, 5]]) p.r(x, y, 1, 1, C.dark);
    p.r(12, 2, 2, 2, p.accent);
  },
  orb: (p) => {
    // A glowing sphere on a short haft.
    spans(p, p.accent, [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 4, 11], [8, 6, 9]]);
    p.r(5, 3, 2, 2, C.shine);
    p.r(7, 9, 2, 6, C.wood);
    p.r(6, 9, 4, 1, C.gold);
  },
  scepter: (p) => {
    // A gold rod with a jewelled head.
    p.l(4, 15, 10, 6, C.gold);
    p.l(5, 15, 11, 6, "#b8891f");
    spans(p, C.gold, [[1, 10, 13], [2, 9, 14], [3, 9, 14], [4, 10, 13], [5, 11, 12]]);
    p.r(11, 2, 2, 2, p.accent);
    p.r(11, 2, 1, 1, C.shine);
  },
  "round-shield": (p) => {
    spans(p, C.iron, [[2, 5, 10], [3, 3, 12], [4, 2, 13], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 3, 12], [13, 5, 10]]);
    spans(p, p.accent, [[4, 5, 10], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 5, 10]]);
    p.r(7, 7, 2, 2, C.gold);
    p.r(5, 3, 3, 1, C.steel);
  },
  shield: (p) => {
    spans(p, C.iron, [[1, 3, 12], [2, 3, 12], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 4, 11], [10, 4, 11], [11, 5, 10], [12, 5, 10], [13, 6, 9], [14, 7, 8]]);
    p.r(7, 2, 2, 12, p.accent);
    p.r(4, 5, 8, 2, p.accent);
    p.r(4, 2, 2, 1, C.steel);
  },
  "chest-armor": (p) => {
    p.r(4, 3, 8, 11, C.iron);
    p.r(2, 2, 4, 3, C.steel);
    p.r(10, 2, 4, 3, C.steel);
    p.r(5, 5, 6, 1, C.steel);
    p.r(7, 6, 2, 3, p.accent);
    p.r(4, 11, 8, 1, C.gold);
    p.r(6, 2, 4, 1, C.dark);
  },
  "heavy-helm": (p) => {
    p.r(7, 0, 2, 2, p.accent);
    p.r(5, 2, 6, 2, C.steel);
    p.r(3, 4, 10, 8, C.iron);
    p.r(4, 3, 8, 1, C.steel);
    p.r(5, 7, 6, 1, C.dark);
    p.r(7, 7, 2, 5, C.steel);
    p.r(3, 12, 3, 2, C.iron);
    p.r(10, 12, 3, 2, C.iron);
  },
  "brutal-helm": (p) => {
    p.r(1, 0, 2, 5, C.bone);
    p.r(13, 0, 2, 5, C.bone);
    p.r(3, 3, 10, 9, C.iron);
    p.r(4, 2, 8, 1, C.steel);
    p.r(5, 6, 2, 2, p.accent);
    p.r(9, 6, 2, 2, p.accent);
    p.r(5, 12, 6, 2, C.iron);
    p.r(6, 10, 1, 3, C.dark);
    p.r(9, 10, 1, 3, C.dark);
  },
  hood: (p) => {
    // A peaked hood with a lined opening and two eyes in the shadow.
    spans(p, C.leather, [[0, 7, 8], [1, 6, 9], [2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 3, 12]]);
    spans(p, C.hide, [[12, 2, 13], [13, 2, 13], [14, 3, 12]]);
    spans(p, p.accent, [[4, 6, 9], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 5, 10], [9, 5, 10], [10, 6, 9]]);
    spans(p, C.dark, [[5, 6, 9], [6, 6, 9], [7, 6, 9], [8, 6, 9], [9, 6, 9]]);
    p.r(6, 7, 1, 1, C.shine);
    p.r(9, 7, 1, 1, C.shine);
    p.r(7, 12, 2, 1, C.gold);
  },
  "armored-pants": (p) => {
    p.r(4, 2, 8, 2, p.accent);
    p.r(4, 4, 3, 10, C.iron);
    p.r(9, 4, 3, 10, C.iron);
    p.r(7, 4, 2, 3, C.iron);
    p.r(4, 8, 3, 2, C.steel);
    p.r(9, 8, 3, 2, C.steel);
    p.r(4, 14, 3, 1, C.hide);
    p.r(9, 14, 3, 1, C.hide);
  },

  // ---- trinkets ----
  boots: (p) => {
    p.r(5, 3, 5, 8, C.leather);
    p.r(4, 2, 7, 2, p.accent);
    p.r(5, 10, 9, 3, C.leather);
    p.r(11, 10, 3, 1, C.hide);
    p.r(5, 13, 10, 1, C.bark);
    p.r(6, 5, 1, 4, C.hide);
  },
  ring: (p) => {
    spans(p, C.gold, [[6, 5, 10], [7, 4, 5], [7, 10, 11], [8, 4, 4], [8, 11, 11], [9, 4, 4], [9, 11, 11], [10, 4, 4], [10, 11, 11], [11, 4, 5], [11, 10, 11], [12, 5, 10]]);
    p.r(6, 2, 4, 4, p.accent);
    p.r(7, 3, 1, 1, C.shine);
  },
  "linked-rings": (p) => {
    const band = (x: number, y: number, color: string) =>
      spans(p, color, [[y, x + 1, x + 5], [y + 1, x, x], [y + 1, x + 6, x + 6], [y + 2, x, x], [y + 2, x + 6, x + 6], [y + 3, x, x], [y + 3, x + 6, x + 6], [y + 4, x, x], [y + 4, x + 6, x + 6], [y + 5, x, x], [y + 5, x + 6, x + 6], [y + 6, x + 1, x + 5]]);
    band(2, 3, C.gold);
    band(7, 6, p.accent);
  },
  "gem-chain": (p) => {
    p.l(3, 1, 7, 8, C.gold);
    p.l(12, 1, 8, 8, C.gold);
    spans(p, p.accent, [[9, 6, 9], [10, 5, 10], [11, 5, 10], [12, 6, 9], [13, 7, 8]]);
    p.r(6, 10, 1, 1, C.shine);
  },
  key: (p) => {
    spans(p, C.gold, [[1, 5, 10], [2, 4, 4], [2, 11, 11], [3, 4, 4], [3, 11, 11], [4, 4, 4], [4, 11, 11], [5, 4, 4], [5, 11, 11], [6, 5, 10]]);
    p.r(7, 3, 2, 2, p.accent);
    p.r(7, 7, 2, 8, C.gold);
    p.r(9, 11, 2, 1, C.gold);
    p.r(9, 13, 3, 1, C.gold);
  },
  "crowned-heart": (p) => {
    p.r(5, 1, 6, 2, C.gold);
    p.r(5, 0, 1, 1, C.gold);
    p.r(7, 0, 2, 1, C.gold);
    p.r(10, 0, 1, 1, C.gold);
    spans(p, p.accent, [[4, 3, 6], [4, 9, 12], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 3, 12], [9, 4, 11], [10, 5, 10], [11, 6, 9], [12, 7, 8]]);
    p.r(4, 5, 2, 1, C.shine);
  },

  // ---- hut materials ----
  "res-wood": (p) => {
    // Two stacked logs, cut ends to the right.
    const log = (x: number, y: number) => {
      p.r(x, y, 12, 5, C.wood);
      p.r(x, y, 9, 1, C.leather);
      p.r(x + 2, y + 2, 4, 1, C.bark);
      p.r(x + 9, y, 3, 5, C.paper);
      p.r(x + 10, y + 2, 1, 1, C.wood);
    };
    log(3, 2);
    log(1, 9);
  },
  "res-stone": (p) => {
    spans(p, C.iron, [[3, 6, 10], [4, 4, 12], [5, 3, 13], [6, 2, 13], [7, 2, 14], [8, 1, 14], [9, 1, 14], [10, 1, 14], [11, 2, 14], [12, 3, 13]]);
    spans(p, C.steel, [[4, 6, 9], [5, 4, 8], [6, 3, 5], [7, 3, 3]]);
    spans(p, "#646d7c", [[10, 9, 14], [11, 6, 14], [12, 3, 13]]);
    p.l(10, 5, 8, 8, C.dark);
    p.l(8, 8, 9, 10, C.dark);
  },
  "res-iron": (p) => ingot(p, C.steel, C.iron, "#646d7c", C.shine),
  "res-copper": (p) => ingot(p, "#e39a5c", "#c8743a", "#8f4d24", "#f6c79a"),
  "res-fur": (p) => {
    // A pelt stretched flat: four legs, a tail, darker along the spine.
    spans(p, C.leather, [[1, 6, 9], [2, 2, 3], [2, 5, 10], [2, 12, 13], [3, 2, 13], [4, 3, 12], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 3, 12], [10, 2, 13], [11, 2, 3], [11, 5, 10], [11, 12, 13], [12, 7, 8], [13, 7, 8], [14, 7, 7]]);
    p.r(7, 2, 2, 9, C.hide);
    spans(p, C.paper, [[4, 5, 5], [6, 10, 10], [8, 5, 5], [9, 10, 10]]);
  },
  "res-bone": (p) => {
    p.l(4, 10, 10, 4, C.bone);
    p.l(5, 11, 11, 5, C.bone);
    p.l(5, 10, 10, 5, C.shine);
    p.r(2, 9, 2, 2, C.bone);
    p.r(4, 12, 2, 2, C.bone);
    p.r(10, 2, 2, 2, C.bone);
    p.r(12, 4, 2, 2, C.bone);
    p.r(3, 11, 2, 2, C.bone);
    p.r(11, 3, 2, 2, C.bone);
  },

  "res-herbs": (p) => {
    // A tied bunch of leafy stems with a few small flowers.
    p.l(8, 15, 8, 6, "#3d6b2c");
    p.l(8, 13, 4, 6, "#3d6b2c");
    p.l(8, 13, 12, 6, "#3d6b2c");
    spans(p, "#4f8a3a", [[2, 6, 9], [3, 5, 10], [4, 3, 12], [5, 2, 13], [6, 2, 13], [7, 3, 12], [8, 5, 10]]);
    spans(p, "#6fae4a", [[3, 6, 8], [4, 4, 6], [5, 10, 12], [6, 7, 9]]);
    p.r(4, 2, 2, 2, "#c9a3e6");
    p.r(10, 1, 2, 2, "#c9a3e6");
    p.r(7, 0, 2, 2, C.paper);
    p.r(6, 11, 4, 2, C.leather);
  },
  "res-mushrooms": (p) => {
    // Two caps on pale stems, the near one larger.
    const shroom = (x: number, y: number, w: number) => {
      p.r(x + Math.floor(w / 2) - 1, y + 3, 2, 5, C.paper);
      spans(p, "#b8452f", [[y, x + 1, x + w - 2], [y + 1, x, x + w - 1], [y + 2, x, x + w - 1]]);
      p.r(x + 2, y, 1, 1, "#e07a5f");
      p.r(x + 1, y + 1, 1, 1, C.paper);
      p.r(x + w - 3, y + 1, 1, 1, C.paper);
    };
    shroom(8, 3, 7);
    shroom(1, 6, 9);
    p.r(1, 14, 14, 1, "#4f8a3a");
  },

  // ---- interface ----
  hand: (p) => {
    p.r(5, 6, 7, 7, C.leather);
    p.r(5, 2, 1, 4, C.leather);
    p.r(7, 1, 1, 5, C.leather);
    p.r(9, 1, 1, 5, C.leather);
    p.r(11, 2, 1, 4, C.leather);
    p.r(3, 7, 2, 3, C.leather);
    p.r(5, 13, 7, 2, p.accent);
  },
  cash: (p) => {
    spans(p, C.gold, [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 4, 11], [12, 5, 10]]);
    p.r(5, 3, 3, 1, C.shine);
    p.r(7, 5, 2, 6, C.wood);
    p.r(6, 6, 4, 1, C.wood);
    p.r(6, 9, 4, 1, C.wood);
  },
};

/** A cast bar seen from above and in front: lit top face, darker front, a glint. */
function ingot(p: Pen, top: string, front: string, under: string, glint: string) {
  spans(p, top, [[4, 5, 12], [5, 4, 13], [6, 3, 14]]);
  spans(p, front, [[7, 2, 14], [8, 2, 14], [9, 1, 14], [10, 1, 14]]);
  p.r(1, 11, 14, 1, under);
  p.r(6, 5, 4, 1, glint);
}

function darken(hex: string, by = 0.35): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - by)).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const cache = new Map<string, string>();

/**
 * Image URL for an item icon. `accent` is the rarity colour. With
 * `silhouette` the whole figure is drawn flat in the accent colour and
 * without an outline, for empty equipment slots.
 */
export function itemArtUrl(name: string, accent: string, silhouette = false): string {
  const key = `${name}|${accent}|${silhouette}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = ART_PIXELS;
  canvas.height = ART_PIXELS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = (color: string) => (silhouette ? accent : color);
  const pen: Pen = {
    accent,
    shade: darken(accent),
    r: (x, y, w, h, color) => {
      ctx.fillStyle = paint(color);
      ctx.fillRect(x + 1, y + 1, w, h);
    },
    l: (x0, y0, x1, y1, color) => {
      ctx.fillStyle = paint(color);
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        ctx.fillRect(Math.round(x0 + (x1 - x0) * t) + 1, Math.round(y0 + (y1 - y0) * t) + 1, 1, 1);
      }
    },
  };
  (ART[name] ?? ART["gem-chain"])(pen);

  if (!silhouette) {
    // Same outline pass as the character sprites: empty pixels touching a filled one go dark.
    const img = ctx.getImageData(0, 0, ART_PIXELS, ART_PIXELS);
    const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < ART_PIXELS && y < ART_PIXELS && img.data[(y * ART_PIXELS + x) * 4 + 3] > 0;
    ctx.fillStyle = OUTLINE;
    for (let y = 0; y < ART_PIXELS; y++) {
      for (let x = 0; x < ART_PIXELS; x++) {
        if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

export const ITEM_ART_NAMES = Object.keys(ART);
