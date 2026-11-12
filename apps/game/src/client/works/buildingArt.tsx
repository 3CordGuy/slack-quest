// Pixel-art pictures of the Harbor's crew projects, for the works panel's
// tabs: the apothecary, the smithy, the lighthouse and the galley, plus a
// padlock for a project that is not open yet. Drawn in code like the item
// icons in itemArt.ts (16x16, flat colours, a dark one-pixel outline, shown
// with nearest-neighbour scaling) but kept apart from that table, as these
// are pictures of places rather than things anyone carries.

const SIZE = 16;
const PIXELS = SIZE + 2;
const OUTLINE = "#1b1830";

interface Pen {
  r(x: number, y: number, w: number, h: number, color: string): void;
  l(x0: number, y0: number, x1: number, y1: number, color: string): void;
}
type Art = (p: Pen) => void;

/** Rows of a filled shape given as [y, x0, x1] spans. */
const spans = (p: Pen, color: string, rows: [number, number, number][]) => rows.forEach(([y, a, b]) => p.r(a, y, b - a + 1, 1, color));

const ART: Record<string, Art> = {
  apothecary: (p) => {
    // A narrow plastered shop under a dark green roof, a lit window, a green sign and herbs by the door.
    spans(p, "#2f5a3a", [[1, 7, 8], [2, 6, 9], [3, 5, 10], [4, 4, 11], [5, 3, 12], [6, 2, 13]]);
    spans(p, "#4f8a4a", [[2, 7, 7], [3, 6, 6], [4, 5, 5], [5, 4, 4]]);
    p.r(3, 7, 10, 8, "#d9ccb0");
    p.r(12, 7, 1, 8, "#b8a988");
    p.r(2, 6, 12, 1, "#4a3a2a");
    p.r(5, 10, 3, 5, "#3e5a3a");
    p.r(7, 12, 1, 1, "#e0b12e");
    p.r(9, 9, 3, 3, "#ffe2a0");
    p.r(10, 9, 1, 3, "#c9b37a");
    p.r(13, 8, 2, 1, "#3a2c22");
    p.r(13, 9, 3, 3, "#3f8a46");
    p.r(14, 10, 1, 1, "#cfe8a0");
    p.r(1, 12, 2, 3, "#5f9e4a");
    p.r(1, 11, 1, 1, "#8fb84f");
    p.r(0, 15, 16, 1, "#8b95a5");
  },
  smithy: (p) => {
    // An open shed with a chimney, the forge glowing at the back, and an anvil out front.
    p.r(2, 0, 3, 5, "#6f737a");
    p.r(2, 0, 3, 1, "#5d6168");
    spans(p, "#4a4f5a", [[4, 1, 14], [5, 0, 15]]);
    p.r(1, 4, 13, 1, "#6f7f95");
    p.r(2, 6, 12, 4, "#8a6a44");
    p.r(1, 6, 1, 9, "#5a3d22");
    p.r(14, 6, 1, 9, "#5a3d22");
    p.r(2, 10, 5, 5, "#7b8494");
    p.r(3, 10, 3, 1, "#ff7a2a");
    p.r(4, 9, 1, 1, "#ffc04a");
    p.r(8, 11, 6, 2, "#3a3d44");
    p.r(8, 11, 5, 1, "#6f737a");
    p.r(14, 11, 1, 1, "#3a3d44");
    p.r(10, 13, 2, 2, "#6b4a2b");
    p.r(0, 15, 16, 1, "#8b95a5");
  },
  lighthouse: (p) => {
    // A striped tower on its rocks: red cap, a lit lantern throwing its light both ways, the gallery, a door.
    p.r(7, 0, 2, 1, "#8c3b2f");
    p.r(6, 1, 4, 1, "#8c3b2f");
    p.r(6, 2, 4, 2, "#ffd23f");
    p.r(7, 2, 2, 1, "#fff4cc");
    p.r(6, 2, 1, 2, "#2b2a33");
    p.r(9, 2, 1, 2, "#2b2a33");
    p.r(11, 2, 3, 1, "#fff1c0");
    p.r(2, 3, 3, 1, "#fff1c0");
    p.r(4, 4, 8, 1, "#4a4458");
    spans(p, "#f1ece0", [[5, 6, 9], [6, 6, 9], [7, 6, 9]]);
    spans(p, "#b9433d", [[8, 5, 10], [9, 5, 10], [10, 5, 10]]);
    spans(p, "#f1ece0", [[11, 5, 10], [12, 4, 11], [13, 4, 11]]);
    p.r(9, 5, 1, 3, "#c9c3b5");
    p.r(10, 8, 1, 3, "#8c3b2f");
    p.r(10, 11, 1, 3, "#c9c3b5");
    p.r(7, 12, 2, 2, "#4a3a2a");
    spans(p, "#5d6270", [[14, 2, 13], [15, 1, 14]]);
    p.r(3, 14, 3, 1, "#7b8291");
    p.r(11, 15, 2, 1, "#7b8291");
  },
  galley: (p) => {
    // A timber cookhouse under a russet roof, a stone chimney, a lit window and a cauldron on a fire.
    p.r(11, 0, 2, 6, "#8b95a5");
    spans(p, "#a0522d", [[3, 5, 10], [4, 4, 11], [5, 3, 12], [6, 2, 13], [7, 1, 14]]);
    spans(p, "#c46a3a", [[4, 5, 6], [5, 4, 5], [6, 3, 4]]);
    p.r(2, 8, 12, 7, "#8a6a44");
    p.r(2, 8, 1, 7, "#5a3d22");
    p.r(13, 8, 1, 7, "#5a3d22");
    p.r(4, 9, 2, 2, "#ffd08a");
    p.r(7, 11, 2, 4, "#3a2c22");
    p.r(10, 12, 4, 3, "#2e2a2a");
    p.r(10, 12, 4, 1, "#d9b45a");
    p.r(0, 15, 16, 1, "#8b95a5");
    p.r(11, 15, 2, 1, "#ff9a3c");
  },
  lock: (p) => {
    // A padlock: an iron shackle over a brass body with a keyhole.
    spans(p, "#8b95a5", [[2, 5, 10], [3, 4, 5], [3, 10, 11], [4, 4, 4], [4, 11, 11], [5, 4, 4], [5, 11, 11], [6, 4, 4], [6, 11, 11]]);
    p.r(6, 2, 4, 1, "#c9d1dc");
    p.r(2, 7, 12, 8, "#e0b12e");
    p.r(2, 7, 12, 1, "#f6d77a");
    p.r(2, 14, 12, 1, "#a07a1f");
    p.r(7, 9, 2, 2, "#2a2740");
    p.r(7, 11, 2, 2, "#2a2740");
    p.r(7, 11, 1, 1, "#2a2740");
  },
};

const cache = new Map<string, string>();

function draw(art: Art): string {
  const canvas = document.createElement("canvas");
  canvas.width = PIXELS;
  canvas.height = PIXELS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const pen: Pen = {
    r: (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, y + 1, w, h);
    },
    l: (x0, y0, x1, y1, color) => {
      ctx.fillStyle = color;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        ctx.fillRect(Math.round(x0 + (x1 - x0) * t) + 1, Math.round(y0 + (y1 - y0) * t) + 1, 1, 1);
      }
    },
  };
  art(pen);
  // Empty pixels touching a filled one go dark: the outline every icon in the game has.
  const img = ctx.getImageData(0, 0, PIXELS, PIXELS);
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < PIXELS && y < PIXELS && img.data[(y * PIXELS + x) * 4 + 3] > 0;
  ctx.fillStyle = OUTLINE;
  for (let y = 0; y < PIXELS; y++) {
    for (let x = 0; x < PIXELS; x++) {
      if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL();
}

function artUrl(name: string): string {
  let url = cache.get(name);
  if (!url) {
    url = draw(ART[name] ?? ART.lock);
    cache.set(name, url);
  }
  return url;
}

/**
 * A crew project's picture. Sizes that are a multiple of 18 keep every art pixel the same size.
 * `dim` greys it out, for a project that is locked.
 */
export function BuildingIcon({ id, size = 36, dim = false }: { id: string; size?: number; dim?: boolean }) {
  return <img className={`pixel-icon building-icon ${dim ? "dim" : ""}`} aria-hidden alt="" draggable={false} width={size} height={size} src={artUrl(id)} />;
}

/** The padlock, for a locked project. */
export function LockIcon({ size = 18 }: { size?: number }) {
  return <img className="pixel-icon" aria-hidden alt="" draggable={false} width={size} height={size} src={artUrl("lock")} />;
}
