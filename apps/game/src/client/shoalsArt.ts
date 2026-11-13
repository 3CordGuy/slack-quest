// Pixel art for the pub's Shoals table: the markers, face up and face down.
// Each is drawn once on a small canvas and handed out as an image URL (the
// table scene makes textures of them; the rules show them at a whole multiple
// with `image-rendering: pixelated`, to match the sprites).

import type { Marker } from "@gantt-quest/world";

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

