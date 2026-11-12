// The first thing a new player sees: a pixel-art title over the Harbor at
// dusk. Both are drawn in code, like the rest of the game's art: the title
// from a tiny 5x7 bitmap font, the backdrop on a 192x108 canvas scaled up
// with nearest-neighbour filtering. The canvas is cheap enough for phones
// (a few hundred rects a frame at ~7 fps) and holds still for anyone who
// prefers reduced motion.

import { useEffect, useRef } from "react";
import anchorSvg from "../../public/favicon.svg?raw";
import "./welcome.css";

// ---------------------------------------------------------------- title ---

/** 5x7 glyphs, enough for the Harbor's name. Unknown letters fall back to plain text. */
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
};
/** Gold, lit from above: one colour per glyph row. */
const ROW_GOLD = ["#fff1a8", "#ffe27a", "#ffd23f", "#ffd23f", "#f5b93a", "#e8a22e", "#d48a24"];
const OUTLINE = "#1b1830";
const SHADOW = "#0e0b1c";

/** Whether the bitmap font can draw `text`. */
export const canPixelText = (text: string) => [...text.toUpperCase()].every((c) => c === " " || GLYPHS[c]);

const rectPath = (cells: Iterable<string>) => {
  let d = "";
  for (const k of cells) {
    const [x, y] = k.split(",");
    d += `M${x} ${y}h1v1h-1z`;
  }
  return d;
};

/** Text in the bitmap font: gold fill, dark outline and a hard drop shadow. Drawn at `scale` screen pixels per art pixel. */
export function PixelText({ text, scale, className }: { text: string; scale: number; className?: string }) {
  const fill: Map<string, string> = new Map();
  let x = 1;
  for (const c of text.toUpperCase()) {
    if (c === " ") {
      x += 3;
      continue;
    }
    GLYPHS[c]?.forEach((row, r) => [...row].forEach((on, col) => on === "#" && fill.set(`${x + col},${r + 1}`, ROW_GOLD[r])));
    x += 6;
  }
  const w = x + 1;
  const h = 10;
  const outline = new Set<string>();
  for (const k of fill.keys()) {
    const [px, py] = k.split(",").map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = `${px + dx},${py + dy}`;
      if (!fill.has(n)) outline.add(n);
    }
  }
  const shadow = new Set<string>();
  for (const k of [...fill.keys(), ...outline]) {
    const [px, py] = k.split(",").map(Number);
    const n = `${px + 1},${py + 1}`;
    if (!fill.has(n) && !outline.has(n)) shadow.add(n);
  }
  const byColour = new Map<string, string[]>();
  for (const [k, c] of fill) byColour.set(c, [...(byColour.get(c) ?? []), k]);
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} width={w * scale} height={h * scale} shapeRendering="crispEdges" aria-hidden focusable="false">
      <path fill={SHADOW} d={rectPath(shadow)} />
      <path fill={OUTLINE} d={rectPath(outline)} />
      {[...byColour].map(([c, cells]) => (
        <path key={c} fill={c} d={rectPath(cells)} />
      ))}
    </svg>
  );
}

/** The anchor from the favicon, without its tile. */
const ANCHOR = anchorSvg.replace(/<rect[^>]*\/>/, "");
export function AnchorMark() {
  return <span className="anchor-mark" aria-hidden dangerouslySetInnerHTML={{ __html: ANCHOR }} />;
}

/** "The Heylets Harbor" as a pixel-art title, with the name as real text for screen readers and search. */
export function HarborTitle({ name }: { name: string }) {
  const full = /^the /i.test(name) ? name : `The ${name}`;
  const rest = full.replace(/^the /i, "");
  return (
    <h1 className="harbor-title">
      <span className="visually-hidden">{full}</span>
      {canPixelText(rest) ? (
        <>
          <span className="harbor-title-the">
            <span className="rule" />
            <PixelText text="THE" scale={3} />
            <span className="rule" />
          </span>
          <PixelText className="harbor-title-name" text={rest} scale={7} />
        </>
      ) : (
        <span aria-hidden className="harbor-title-plain">{full}</span>
      )}
    </h1>
  );
}

// ------------------------------------------------------------- backdrop ---

const BW = 192;
const BH = 108;
const HORIZON = 64;
const SUN_X = 174;

const SKY = ["#120e24", "#161130", "#1c153a", "#241a46", "#2f2054", "#3e2760", "#522e6a", "#6a3670", "#843f70", "#a04c6c", "#bb5d66", "#d5735f", "#e8915a"];
const SEA = ["#4a3266", "#3a2f60", "#2f3260", "#28385f", "#23375a", "#1f3352", "#1b2d49", "#182841", "#16233a"];

const SHIP = [
  "......ff......",
  "......m.......",
  "...sss.m.sss..",
  "..ssss.m.ssss.",
  "..ssss.m.ssss.",
  "...sss.m..sss.",
  ".......m......",
  "tttttttttttttt",
  ".HHHHHHHHHHHH.",
  "..HHHHHHHHHH..",
];
const SHIP_COLOUR: Record<string, string> = { f: "#ffd23f", m: "#2a1d18", s: "#f1d9b8", t: "#b07a52", H: "#5a3626" };

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (a: number, b: number, c: number) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const rand = mulberry(7);
const STARS = Array.from({ length: 46 }, () => ({ x: Math.floor(rand() * BW), y: Math.floor(rand() * 34), b: rand() }));
/** Wave crests per sea row: a fixed phase and gap, scrolled each frame. */
const WAVES = Array.from({ length: BH - HORIZON }, () => ({ phase: Math.floor(rand() * 40), gap: 14 + Math.floor(rand() * 18) }));

/** Height of the far island silhouettes above the horizon at column x. */
function islandHeight(x: number): number {
  const hump = (cx: number, w: number, h: number) => (Math.abs(x - cx) < w ? Math.round(h * Math.cos(((x - cx) / w) * (Math.PI / 2))) : 0);
  return Math.max(hump(28, 24, 8), hump(58, 16, 4), hump(120, 18, 3));
}

function drawScene(ctx: CanvasRenderingContext2D, t: number) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  // Sky: stepped bands, each boundary dithered one row.
  const band = HORIZON / SKY.length;
  for (let i = 0; i < SKY.length; i++) px(0, Math.floor(i * band), BW, Math.ceil(band) + 1, SKY[i]);
  for (let i = 1; i < SKY.length; i++) {
    const y = Math.floor(i * band) - 1;
    ctx.fillStyle = SKY[i];
    for (let x = y % 2; x < BW; x += 2) ctx.fillRect(x, y, 1, 1);
  }
  // Stars, a few of them twinkling.
  for (const [i, s] of STARS.entries()) {
    const twinkle = hash(i, Math.floor(t / 6), 1) < 0.12;
    ctx.globalAlpha = twinkle ? 0.25 : 0.35 + s.b * 0.6;
    px(s.x, s.y, 1, 1, s.b > 0.92 ? "#fff1a8" : "#f1eee4");
  }
  ctx.globalAlpha = 1;
  // The setting sun, cut by thin bands of cloud.
  for (let y = HORIZON - 11; y < HORIZON; y++) {
    const dy = y - HORIZON + 1;
    const half = Math.floor(Math.sqrt(Math.max(0, 121 - dy * dy)));
    px(SUN_X - half, y, half * 2 + 1, 1, y > HORIZON - 5 ? "#ffb347" : "#ffd23f");
  }
  for (const [y, x0, w] of [[HORIZON - 4, 154, 44], [HORIZON - 7, 162, 26], [HORIZON - 15, 130, 30], [HORIZON - 19, 100, 20]] as const) px(x0, y, w, 1, "#843f70");
  // Far islands, and a lighthouse on the right-hand one.
  for (let x = 0; x < BW; x++) {
    const h = islandHeight(x);
    if (h) px(x, HORIZON - h, 1, h, "#2a1d45");
  }
  const lx = 28;
  const ltop = HORIZON - 8 - 14;
  for (let y = 0; y < 14; y++) px(lx - 1 - (y > 7 ? 1 : 0), ltop + y, 3 + (y > 7 ? 2 : 0), 1, Math.floor(y / 3) % 2 ? "#b9433d" : "#e8dcc0");
  px(lx - 2, ltop - 1, 5, 1, OUTLINE);
  px(lx - 1, ltop - 3, 3, 2, "#2a1d18");
  const lit = Math.floor(t / 4) % 6 !== 0;
  if (lit) {
    px(lx, ltop - 3, 1, 2, "#fff1a8");
    ctx.globalAlpha = 0.3;
    px(lx - 3, ltop - 3, 7, 2, "#ffd23f");
    // The beam swings between left and right.
    const dir = Math.floor(t / 16) % 2 ? 1 : -1;
    for (let i = 4; i < 26; i++) px(lx + dir * i, ltop - 3 + Math.round(i / 12), 1, 1, "#ffd23f");
    ctx.globalAlpha = 1;
  }
  // Sea: bands that widen towards the viewer.
  let y = HORIZON;
  for (let i = 0; i < SEA.length && y < BH; i++) {
    const h = 1 + i;
    px(0, y, BW, h + 1, SEA[i]);
    y += h;
  }
  px(0, y, BW, BH - y, SEA[SEA.length - 1]);
  // Wave crests drifting sideways, longer and faster up close.
  for (let row = 1; row < BH - HORIZON; row++) {
    const yy = HORIZON + row;
    const depth = row / (BH - HORIZON);
    const len = 1 + Math.floor(depth * 5);
    const { phase, gap } = WAVES[row];
    const step = gap + Math.floor(depth * 22);
    const shift = Math.floor(t * (0.2 + depth * 0.9)) + phase;
    ctx.fillStyle = depth > 0.6 ? "#3f6fa8" : "#4a4f86";
    for (let x = (shift % step) - step; x < BW; x += step) ctx.fillRect(x, yy, len, 1);
  }
  // The sun's reflection, shimmering.
  for (let row = 0; row < BH - HORIZON; row++) {
    const w = 3 + Math.floor(row / 4);
    for (let x = SUN_X - w; x <= SUN_X + w; x++) {
      const r = hash(x, row, Math.floor(t / 2));
      if (r < 0.22 - row * 0.004) px(x, HORIZON + row, 1 + (row > 20 ? 1 : 0), 1, r < 0.08 ? "#ffd23f" : "#e8915a");
    }
  }
  // A ship crossing the bay, bobbing.
  const sx = Math.floor((t * 0.12) % (BW + 40)) - 20;
  const sy = HORIZON + 1 - SHIP.length + 3 + (Math.floor(t / 7) % 2);
  SHIP.forEach((row, r) => [...row].forEach((c, col) => SHIP_COLOUR[c] && px(sx + col, sy + r, 1, 1, SHIP_COLOUR[c])));
  ctx.globalAlpha = 0.5;
  for (let i = 1; i < 6; i++) if (hash(i, Math.floor(t / 3), 2) < 0.6) px(sx - i * 2, sy + SHIP.length - 1, 2, 1, "#a9a4c4");
  ctx.globalAlpha = 1;
  // The near pier, with a lantern.
  px(0, BH - 20, 46, 2, "#5a3d22");
  px(0, BH - 18, 46, 1, "#3a2a20");
  for (const x of [4, 18, 32, 44]) px(x, BH - 20, 3, 20, "#3a2a20");
  for (const x of [4, 18, 32, 44]) px(x, BH - 20, 1, 20, "#5a3d22");
  px(32, BH - 27, 1, 7, "#2a1d18");
  px(31, BH - 29, 3, 3, "#2a1d18");
  const flicker = hash(3, Math.floor(t / 2), 9) < 0.85;
  px(32, BH - 28, 1, 1, flicker ? "#ffd23f" : "#f5b93a");
  ctx.globalAlpha = flicker ? 0.22 : 0.16;
  px(28, BH - 32, 9, 9, "#ffd23f");
  ctx.globalAlpha = 1;
}

/** The Harbor at dusk, filling the screen behind the panels. */
export function HarborBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    let t = 400;
    drawScene(ctx, t);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      t++;
      drawScene(ctx, t);
    }, 140);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="harbor-backdrop" aria-hidden>
      <canvas ref={ref} width={BW} height={BH} />
      <div className="harbor-backdrop-shade" />
    </div>
  );
}
