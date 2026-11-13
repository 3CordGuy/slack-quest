// Pixel art for the pub's Shoals table: the round table seen from above,
// the markers (face up and face down), a gold coin, a passage star, and
// players' names in the bitmap font. Each is drawn once on a small canvas
// and handed out as an image URL, shown at a whole multiple with
// `image-rendering: pixelated` so it matches the sprites.

import type { Marker } from "@gantt-quest/world";
import { canDrawPixelText, drawPixelText, pixelTextWidth, PIXEL_LINE_ROWS } from "./render/pixelFont";

const INK = "#1b1830";
const cache = new Map<string, string>();

function draw(key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): string {
  let url = cache.get(key);
  if (url) return url;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  paint(canvas.getContext("2d")!);
  url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

const px = (ctx: CanvasRenderingContext2D, x: number, y: number, color: string) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
};

/** Native size of the table art. Shown at about twice this. */
export const TABLE_PX = 112;

/**
 * The table, from above: a dark outline, a wooden rim lit from the top
 * left with plank seams, and a sea-green baize marked like a chart, with
 * faint rhumb lines running out from a compass ring in the middle.
 */
export function tableUrl(): string {
  return draw("table", TABLE_PX, TABLE_PX, (ctx) => {
    const c = (TABLE_PX - 1) / 2;
    const R = TABLE_PX / 2 - 0.5;
    const RIM = R - 7;
    for (let y = 0; y < TABLE_PX; y++) {
      for (let x = 0; x < TABLE_PX; x++) {
        const dx = x - c;
        const dy = y - c;
        const d = Math.hypot(dx, dy);
        if (d > R) continue;
        const ang = Math.atan2(dy, dx);
        if (d > R - 1.2) {
          px(ctx, x, y, INK);
        } else if (d > RIM) {
          // The rim: lit where it faces the top left, in shade at the bottom right.
          const light = -(dx + dy) / (Math.SQRT2 * d);
          const seam = Math.abs(((ang + Math.PI) / (Math.PI / 8)) % 1 - 0.5) > 0.47;
          const edge = d > R - 2.2 ? (light > 0.3 ? "#c8904f" : "#8a5a2b") : null;
          px(ctx, x, y, seam ? "#4a2f17" : edge ?? (light > 0.45 ? "#a8743d" : light < -0.45 ? "#6b4424" : "#8a5a2b"));
        } else if (d > RIM - 1.2) {
          px(ctx, x, y, "#3a2412");
        } else if (d > RIM - 2.4) {
          // A shadow the rim throws on the baize, deeper at the top left.
          px(ctx, x, y, -(dx + dy) > 0 ? "#123d36" : "#17493f");
        } else {
          let color = (x + y) % 2 === 0 && (x * 7 + y * 13) % 11 === 0 ? "#22665a" : "#1d5a4f";
          // A compass ring and its rhumb lines, faint, dotted.
          const ring = Math.abs(d - 13) < 0.6 && (x + y) % 2 === 0;
          const spoke = d > 16 && d < RIM - 5 && (x + y) % 3 === 0 && Math.abs(((ang + Math.PI) / (Math.PI / 4)) % 1 - 0.5) > 0.485;
          if (ring || spoke) color = "#2b7867";
          px(ctx, x, y, color);
        }
      }
    }
  });
}

/** Native size of a marker. */
export const MARKER_PX = 12;
export type MarkerFace = Marker | "back";

/**
 * A marker, 12 pixels across: blue water with white-capped waves for a
 * Channel, sand around a dark rock for a Shoal, and face down a wooden
 * disc with a rope ring.
 */
export function markerUrl(face: MarkerFace): string {
  return draw(`marker:${face}`, MARKER_PX, MARKER_PX, (ctx) => {
    const c = (MARKER_PX - 1) / 2;
    for (let y = 0; y < MARKER_PX; y++) {
      for (let x = 0; x < MARKER_PX; x++) {
        const dx = x - c;
        const dy = y - c;
        const d = Math.hypot(dx, dy);
        if (d > 6) continue;
        if (d > 5.0) {
          px(ctx, x, y, INK);
          continue;
        }
        // The lower edge is the disc's thickness, in shade.
        const under = dy > 0 && d > 4.0;
        let color: string;
        if (face === "channel") {
          const wave = (y + Math.floor((x + 1) / 3)) % 4 === 0;
          color = under ? "#2c5e9e" : wave ? "#a9d4fb" : dx + dy < -4 ? "#6aa6ec" : "#3f7fd0";
        } else if (face === "shoal") {
          const rock = Math.hypot(dx + 0.3, dy + 0.4) < 2.4;
          const lit = dx + dy < -1.2;
          color = rock ? (lit ? "#8a8270" : "#4d473b") : under ? "#a9853a" : (x * 5 + y * 3) % 7 === 0 ? "#b8913f" : dx + dy < -4 ? "#ecd08a" : "#d9b45a";
        } else {
          const rope = d > 3.4 && d <= 4.4 && (x + y) % 2 === 0;
          color = rope ? "#e2c48f" : under ? "#4a3018" : x % 3 === 0 ? "#5a3d22" : dx + dy < -4 ? "#8a5a2b" : "#6b4a2b";
        }
        px(ctx, x, y, color);
      }
    }
  });
}

/** A gold coin, 7 by 5, tilted so it reads as lying flat: a lit face over a darker rim. */
const COIN = [".#####.", "#yyooo#", "#ooooo#", "#ddddd#", ".#####."];
export const COIN_W = COIN[0].length;
export const COIN_H = COIN.length;
/** A heap of up to nine coins, with its native size. */
export function coinPile(coins: number): { url: string; w: number; h: number } {
  const n = Math.max(1, Math.min(9, coins));
  // Coins in a little heap: the narrowest bottom row that holds them all as a pyramid, then rows of one fewer.
  let base = 1;
  while ((base * (base + 1)) / 2 < n) base++;
  const rows: number[] = [];
  for (let left = n, width = base; left > 0; width--) {
    const take = Math.min(width, left);
    rows.push(take);
    left -= take;
  }
  const w = 4 * (COIN_W - 2) + 2;
  const h = COIN_H + (rows.length - 1) * 3 + 1;
  const url = draw(`coins:${n}`, w, h, (ctx) => {
    rows.forEach((count, level) => {
      const rowW = count * (COIN_W - 2) + 2;
      const x0 = Math.floor((w - rowW) / 2);
      const y0 = h - COIN_H - 1 - level * 3;
      for (let i = 0; i < count; i++) {
        COIN.forEach((row, r) => {
          for (let col = 0; col < row.length; col++) {
            const ch = row[col];
            if (ch === ".") continue;
            px(ctx, x0 + i * (COIN_W - 2) + col, y0 + r, ch === "#" ? "#7a5410" : ch === "y" ? "#fff2a8" : ch === "d" ? "#c8971f" : "#ffd23f");
          }
        });
      }
    });
    // A shadow under the heap.
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(1, h - 1, w - 2, 1);
  });
  return { url, w, h };
}

/** A passage star, 7 by 7, gold when won and an outline when still to win. */
const STAR = ["...#...", "..###..", "#######", ".#####.", "..###..", ".##.##.", "##...##"];
export function starUrl(won: boolean): string {
  return draw(`star:${won}`, 7, 7, (ctx) => {
    STAR.forEach((row, r) => {
      for (let col = 0; col < row.length; col++) {
        if (row[col] !== "#") continue;
        const inner = r > 0 && r < 6 && col > 0 && col < 6 && STAR[r - 1][col] === "#" && STAR[r + 1]?.[col] === "#" && row[col - 1] === "#" && row[col + 1] === "#";
        if (won) px(ctx, col, r, r < 3 ? "#fff2a8" : "#ffd23f");
        else if (!inner) px(ctx, col, r, "#6c6790");
      }
    });
  });
}

/** A first name in the bitmap font, light ink over a dark one-pixel shadow, or null when the font cannot draw it. */
export function nameUrl(text: string, ink = "#f1eee4"): { url: string; w: number; h: number } | null {
  if (!canDrawPixelText(text)) return null;
  const w = pixelTextWidth(text) + 2;
  const h = PIXEL_LINE_ROWS + 1;
  const url = draw(`name:${ink}:${text}`, w, h, (ctx) => {
    drawPixelText(ctx, text, 1, 1, INK);
    drawPixelText(ctx, text, 0, 1, INK);
    drawPixelText(ctx, text, 1, 0, INK);
    drawPixelText(ctx, text, 0, 0, ink);
  });
  return { url, w, h };
}
