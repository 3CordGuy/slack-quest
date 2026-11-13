// What is drawn on small canvases rather than modelled: name plates, speech
// bubbles, floating numbers and battle effects, all pixel-crisp. Also the
// characters' pictures for the HUD, which are rendered from their models
// (figures.ts) by portraits.ts.

import * as THREE from "three";
import { SLOTS, barPixels, healthBand, type HealthBand, type Outfit } from "@gantt-quest/world";
import { LOOKS, mergeLook, type Look, type LookPalette } from "./looks";
import { PIXEL_LINE_ROWS, canDrawPixelText, drawPixelText, drawSmallDigits, pixelTextWidth } from "./pixelFont";
import { portraitUrl } from "./portraits";

const OUTLINE = "#1b1830";

const pictures = new Map<string, string>();

// Admin palette overrides (from the content bundle), laid over LOOKS. Every
// change bumps the revision, which is part of every figure's key: the pictures
// start afresh and the world renderer, which compares keys, rebuilds its units.
let palettes: Record<string, LookPalette> = {};
let revision = 0;

/** Replace the palette overrides in force. Figures built from now on use them. */
export function setLookOverrides(next: Record<string, LookPalette>): void {
  if (JSON.stringify(next) === JSON.stringify(palettes)) return;
  palettes = next;
  revision++;
  pictures.clear();
}

/** A kind's look as currently drawn: the stock look with any admin palette over it. Unknown kinds get the bandit. */
export function lookFor(kind: string): Look {
  return mergeLook(LOOKS[kind] ?? LOOKS.bandit, palettes[kind]);
}

/** What tells one figure from another: the kind plus whatever is being worn, whether they are asleep or fishing, and the overrides in force. */
export function spriteKey(kind: string, outfit?: Outfit, asleep = false, rod = false): string {
  const worn = outfit ? `|${SLOTS.map((s) => (outfit[s] ? `${outfit[s]!.ref}:${outfit[s]!.rarity[0]}` : "-")).join(",")}` : "";
  return `${kind}${worn}${asleep ? "|zz" : ""}${rod ? "|rod" : ""}|r${revision}`;
}

/**
 * A figure's picture drawn with a given palette (undefined: the stock look) rather than the one in force,
 * as an image URL: the admin page's live preview. Same models as the game, no cache.
 */
export function previewSpriteUrl(kind: string, palette: LookPalette | undefined, outfit?: Outfit, asleep = false): string {
  return portraitUrl(kind, mergeLook(LOOKS[kind] ?? LOOKS.bandit, palette), outfit, asleep);
}

/**
 * A hero class, enemy kind or townsperson as an image URL, for the HUD. Pass a hero's outfit to show
 * them wearing it. `large` draws it at twice the detail, for the character sheet's full figure.
 */
export function spriteDataUrl(kind: string, outfit?: Outfit, large = false): string {
  const key = `${spriteKey(kind, outfit)}${large ? "|L" : ""}`;
  let url = pictures.get(key);
  if (!url) pictures.set(key, (url = portraitUrl(kind, lookFor(kind), outfit, false, large ? 2 : 1)));
  return url;
}

let zTexture: THREE.CanvasTexture | null = null;

/** A pixel-art "Z" for someone asleep: pale blue with a dark outline. Shared by every sleeper. */
export function sleepZTexture(): THREE.CanvasTexture {
  if (zTexture) return zTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 9;
  canvas.height = 9;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#dbe9ff";
  ctx.fillRect(2, 2, 5, 1);
  ctx.fillRect(5, 3, 1, 1);
  ctx.fillRect(4, 4, 1, 1);
  ctx.fillRect(3, 5, 1, 1);
  ctx.fillRect(2, 6, 5, 1);
  // A one-pixel dark outline around the letter.
  const img = ctx.getImageData(0, 0, 9, 9);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < 9 && y < 9 && img.data[(y * 9 + x) * 4 + 3] > 0;
  ctx.fillStyle = OUTLINE;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) ctx.fillRect(x, y, 1, 1);
  zTexture = new THREE.CanvasTexture(canvas);
  zTexture.magFilter = THREE.NearestFilter;
  zTexture.minFilter = THREE.NearestFilter;
  zTexture.generateMipmaps = false;
  zTexture.colorSpace = THREE.SRGBColorSpace;
  return zTexture;
}

/** A short text label as a pixel-crisp texture, for floating combat numbers. */
export function textTexture(text: string, color: string): THREE.CanvasTexture {
  const font = "bold 18px ui-monospace, Menlo, monospace";
  const canvas = document.createElement("canvas");
  // 64 wide fits a damage number; longer text ("+10 XP", "LEVEL UP") gets a wider canvas, so the sprite's aspect follows it.
  const measureCtx = canvas.getContext("2d")!;
  measureCtx.font = font;
  canvas.width = Math.max(64, Math.ceil(measureCtx.measureText(text).width) + 10);
  canvas.height = 24;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(text, canvas.width / 2, 12);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, 12);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** What a hero's overhead plate shows beside their name: level, how full their HP and XP are (0 to 1), and outings left. */
export interface PlateStats {
  level: number;
  hp: number;
  xp: number;
  /** Just earned XP: the XP bar is drawn lit up for a moment. */
  glow?: boolean;
  /** Gathering outings: one lightning bolt each, lit for those left. Only on your own plate. */
  bolts?: { left: number; max: number };
}

const PLATE_BG: [number, number, number, number] = [27, 24, 48, 225];
const PLATE_EDGE = "#0e0b1c";
const PLATE_FILL = "rgba(27, 24, 48, 0.9)";
const PLATE_SHEEN = "rgba(74, 69, 112, 0.55)";
const NAME_INK = "#f1eee4";
const BAR_TRACK = "#3b3560";
const HP_COLOR: Record<HealthBand, string> = { good: "#6ee06e", hurt: "#ffd23f", low: "#ff6b6b" };
const XP_COLOR = "#7d8cff";
/** The XP bar as it lights up on a gain: pale blue track, near-white fill. */
const XP_GLOW_TRACK = "#5f7fd8";
const XP_GLOW_COLOR = "#e4f4ff";

/** A small heater shield for the level: gold rim, dark field. 11 by 12. */
const SHIELD = [
  "###########",
  "#.........#",
  "#.........#",
  "#.........#",
  "#.........#",
  "#.........#",
  "#.........#",
  "#.........#",
  ".#.......#.",
  "..#.....#..",
  "...#...#...",
  "....###....",
];
/** The rim lit from above: one colour per row. */
const SHIELD_RIM = ["#fff1a8", "#ffe27a", "#ffd23f", "#ffd23f", "#ffd23f", "#f5b93a", "#f5b93a", "#e8a22e", "#e8a22e", "#d48a24", "#d48a24", "#b8741c"];
const SHIELD_FIELD = "#33295f";
const SHIELD_FIELD_LIT = "#40357a";
const SHIELD_INK = "#fff6d8";

/** A lightning bolt for one gathering outing. 5 by 7. */
const BOLT = ["...##", "..##.", ".##..", "#####", "..##.", ".##..", "##..."];
const BOLT_ON = ["#fff1a8", "#ffe066", "#ffe066", "#ffd23f", "#f5b93a", "#e8a22e", "#d48a24"];
const BOLT_OFF = "#4a4570";

/** Rows of a plain name tag: a line of text with a row of margin above and below. */
const TAG_ROWS = PIXEL_LINE_ROWS + 3;
/** A plate: border, the name line, the HP bar, a gap, the XP bar, border. */
const PLATE_ROWS = 18;
const TEXT_X = 14;
const TEXT_Y = 3;
const HP_Y = 12;
const XP_Y = 15;
/** Bars never shorter than this, so a short name still gets a readable bar. */
const MIN_BAR = 26;

/** The key a plate is cached and redrawn by: it changes only when a pixel of it would. */
export function plateKey(text: string, plate?: PlateStats): string {
  if (!plate) return text;
  const inner = plateWidth(text, plate) - TEXT_X - 3;
  const bolts = plate.bolts ? `|${plate.bolts.left}/${plate.bolts.max}` : "";
  return `${text}|${plate.level}|${barPixels(plate.hp, inner)}:${healthBand(plate.hp)}|${barPixels(plate.xp, inner)}${bolts}${plate.glow ? "|glow" : ""}`;
}

const LABEL_FONT = "12px ui-monospace, Menlo, Consolas, monospace";
let measurer: CanvasRenderingContext2D | null = null;
function measure(text: string): number {
  if (!measurer) {
    measurer = document.createElement("canvas").getContext("2d")!;
    measurer.font = LABEL_FONT;
    (measurer as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
  }
  return Math.ceil(measurer.measureText(text).width);
}

/** Width of the bolts after a name, with the gap before them. */
const boltsWidth = (plate: PlateStats) => (plate.bolts && plate.bolts.max > 0 ? 4 + plate.bolts.max * 6 - 1 : 0);
/** A name's width: in the bitmap font, or the system font for a name it cannot draw. */
const nameWidth = (text: string) => (canDrawPixelText(text) ? pixelTextWidth(text) : measure(text));
function plateWidth(text: string, plate: PlateStats): number {
  const line = nameWidth(text) + boltsWidth(plate);
  return TEXT_X + Math.max(MIN_BAR, line) + 3;
}

function makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Fill the cells of a pixel pattern at (x, y), one colour per row or one for all. */
function stamp(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, ink: string | string[], mark = "#") {
  rows.forEach((row, r) => {
    ctx.fillStyle = typeof ink === "string" ? ink : ink[r];
    for (let c = 0; c < row.length; c++) if (row[c] === mark) ctx.fillRect(x + c, y + r, 1, 1);
  });
}

/** The level shield at (x, y): rim, field with a lit top-left, and the number. */
function drawShield(ctx: CanvasRenderingContext2D, level: number, x: number, y: number) {
  // The field is everything inside the rim, row by row.
  SHIELD.forEach((row, r) => {
    const first = row.indexOf("#");
    const last = row.lastIndexOf("#");
    if (r === 0 || last - first < 2) return;
    ctx.fillStyle = r <= 2 ? SHIELD_FIELD_LIT : SHIELD_FIELD;
    ctx.fillRect(x + first + 1, y + r, last - first - 1, 1);
  });
  stamp(ctx, SHIELD, x, y, SHIELD_RIM);
  const digits = String(Math.min(99, Math.max(0, level)));
  if (digits.length === 1) {
    drawPixelText(ctx, digits, x + 3, y + 2, SHIELD_INK);
  } else {
    drawSmallDigits(ctx, digits, x + 2, y + 3, SHIELD_INK);
  }
}

/** Text the bitmap font cannot draw, in the system font snapped to solid pixels, top-left at (x, y). */
function drawSystemText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  const scratch = document.createElement("canvas");
  scratch.width = measure(text) + 2;
  scratch.height = 13;
  const sc = scratch.getContext("2d", { willReadFrequently: true })!;
  sc.font = LABEL_FONT;
  (sc as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
  sc.textBaseline = "middle";
  sc.fillStyle = "#ffffff";
  sc.fillText(text, 0, 7);
  const px = sc.getImageData(0, 0, scratch.width, scratch.height).data;
  ctx.fillStyle = NAME_INK;
  for (let k = 0; k < px.length; k += 4) {
    if (px[k + 3] < 96) continue;
    const i = k / 4;
    ctx.fillRect(x + (i % scratch.width), y + Math.floor(i / scratch.width), 1, 1);
  }
}

/** A plain name tag, in the bitmap font where it can draw the name and the system font where it cannot. */
function tagTexture(text: string): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  if (canDrawPixelText(text)) {
    canvas.width = pixelTextWidth(text) + 6;
    canvas.height = TAG_ROWS;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `rgba(${PLATE_BG[0]}, ${PLATE_BG[1]}, ${PLATE_BG[2]}, ${PLATE_BG[3] / 255})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawPixelText(ctx, text, 3, 1, NAME_INK);
    return { texture: makeTexture(canvas), aspect: canvas.width / canvas.height };
  }
  // A name the bitmap font cannot draw: the system font, snapped to solid pixels.
  canvas.width = measure(text) + 8;
  canvas.height = 15;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = LABEL_FONT;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, canvas.width / 2, 15 / 2 + 1);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let k = 0; k < px.length; k += 4) {
    const ink = px[k + 3] >= 96;
    px[k] = ink ? 241 : PLATE_BG[0];
    px[k + 1] = ink ? 238 : PLATE_BG[1];
    px[k + 2] = ink ? 228 : PLATE_BG[2];
    px[k + 3] = ink ? 255 : PLATE_BG[3];
  }
  ctx.putImageData(image, 0, 0);
  return { texture: makeTexture(canvas), aspect: canvas.width / canvas.height };
}

/**
 * A name tag, and with `plate` a hero's overhead plate: their level on a
 * little gold shield, the name in the bitmap font, then a thin HP bar
 * (green, yellow, red as it drops) and a thinner XP bar. On your own plate,
 * a lightning bolt for each gathering outing, lit for those left. Every
 * pixel is solid, so it stays as crisp as the sprite under it.
 */
export function labelTexture(text: string, plate?: PlateStats): { texture: THREE.CanvasTexture; aspect: number } {
  if (!plate) return tagTexture(text);
  const canvas = document.createElement("canvas");
  canvas.width = plateWidth(text, plate);
  canvas.height = PLATE_ROWS;
  const ctx = canvas.getContext("2d")!;
  const p = plate;
  const w = canvas.width;
  // The plate: a dark rim, its field, and a faint sheen along the top.
  ctx.fillStyle = PLATE_EDGE;
  ctx.fillRect(6, 1, w - 6, PLATE_ROWS - 1);
  ctx.fillStyle = PLATE_FILL;
  ctx.fillRect(7, 2, w - 8, PLATE_ROWS - 3);
  ctx.fillStyle = PLATE_SHEEN;
  ctx.fillRect(12, 2, w - 14, 1);
  drawShield(ctx, p.level, 1, 3);
  if (canDrawPixelText(text)) drawPixelText(ctx, text, TEXT_X, TEXT_Y, NAME_INK);
  else drawSystemText(ctx, text, TEXT_X, TEXT_Y - 2);
  if (p.bolts && p.bolts.max > 0) {
    let x = TEXT_X + nameWidth(text) + 4;
    for (let i = 0; i < p.bolts.max; i++) {
      stamp(ctx, BOLT, x, TEXT_Y, i < p.bolts.left ? BOLT_ON : BOLT_OFF);
      x += 6;
    }
  }
  const inner = w - TEXT_X - 3;
  const bar = (y: number, rows: number, fraction: number, colour: string, track = BAR_TRACK) => {
    ctx.fillStyle = track;
    ctx.fillRect(TEXT_X, y, inner, rows);
    const filled = barPixels(fraction, inner);
    if (filled > 0) {
      ctx.fillStyle = colour;
      ctx.fillRect(TEXT_X, y, filled, rows);
    }
  };
  bar(HP_Y, 2, p.hp, HP_COLOR[healthBand(p.hp)]);
  if (p.glow) bar(XP_Y, 2, p.xp, XP_GLOW_COLOR, XP_GLOW_TRACK);
  else bar(XP_Y, 2, p.xp, XP_COLOR);
  return { texture: makeTexture(canvas), aspect: canvas.width / canvas.height };
}

// ---------- speech bubbles ----------

const BUBBLE_FILL: [number, number, number] = [250, 246, 232];
const BUBBLE_EDGE: [number, number, number] = [27, 24, 48];
const BUBBLE_INK: [number, number, number] = [35, 31, 58];
/** Widest a line of speech may be, in pixels of text, so a bubble stays narrow on a phone. */
const BUBBLE_TEXT_WIDTH = 120;
const BUBBLE_MAX_LINES = 3;
/** Rows per line: the system font's, and the pixel font's (9 rows of glyph and 2 between lines). */
const BUBBLE_LINE_ROWS = 13;
const BUBBLE_PIXEL_LINE_ROWS = PIXEL_LINE_ROWS + 2;
/** Rows the tail hangs below the box. */
export const BUBBLE_TAIL_ROWS = 4;

/**
 * Break speech into at most three lines that fit the bubble, ending in an
 * ellipsis if it had to be cut. `width` measures a line in whichever font
 * the bubble is drawn in.
 */
export function wrapSpeech(text: string, width: (s: string) => number = measure): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let cut = false;
  const fits = (s: string) => width(s) <= BUBBLE_TEXT_WIDTH;
  for (let word of words) {
    const tryLine = line ? `${line} ${word}` : word;
    if (fits(tryLine)) {
      line = tryLine;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
      if (lines.length === BUBBLE_MAX_LINES) {
        cut = true;
        break;
      }
    }
    // A word too long for a line on its own is broken wherever it runs out of room.
    while (!fits(word)) {
      let n = word.length - 1;
      while (n > 1 && !fits(word.slice(0, n))) n--;
      lines.push(word.slice(0, n));
      word = word.slice(n);
      if (lines.length === BUBBLE_MAX_LINES) {
        cut = true;
        break;
      }
    }
    if (cut) break;
    line = word;
  }
  if (!cut && line) lines.push(line);
  if (cut && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && !fits(`${last}…`)) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines.length > 0 ? lines : ["…"];
}

/**
 * A speech bubble: pale, with a one-pixel dark outline, clipped corners and a
 * tail at the bottom middle pointing down at the speaker. The text is drawn as
 * text on a canvas (never markup): in the bitmap font the plates use, or, for
 * speech it has no glyphs for (an emoji, another script), in the system font
 * snapped to solid pixels.
 */
export function bubbleTexture(text: string): { texture: THREE.CanvasTexture; width: number; rows: number } {
  // The ellipsis a cut line ends with is in the bitmap font too, so the check is on the speech itself.
  const pixel = canDrawPixelText(text);
  const lineWidth = pixel ? pixelTextWidth : measure;
  const lines = wrapSpeech(text, lineWidth);
  const textW = Math.max(...lines.map(lineWidth));
  const width = Math.max(16, textW + 10);
  const lineRows = pixel ? BUBBLE_PIXEL_LINE_ROWS : BUBBLE_LINE_ROWS;
  // Pixel font: outline, a row of margin, the lines, a row of margin, outline.
  const box = pixel ? lines.length * lineRows + 2 : lines.length * lineRows + 4;
  const rows = box + BUBBLE_TAIL_ROWS;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const left = Math.floor((width - textW) / 2);
  if (pixel) {
    lines.forEach((line, i) => drawPixelText(ctx, line, left, 2 + i * lineRows, "#ffffff"));
  } else {
    ctx.font = LABEL_FONT;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    lines.forEach((line, i) => ctx.fillText(line, left, 2 + i * lineRows + lineRows / 2 + 1));
  }
  const image = ctx.getImageData(0, 0, width, rows);
  const px = image.data;
  const mid = Math.floor(width / 2);
  // What each pixel is: outside, edge, or inside the bubble (box with clipped corners, plus the tail).
  const shape = (x: number, y: number): 0 | 1 | 2 => {
    if (y < box) {
      const sideX = x === 0 || x === width - 1;
      const sideY = y === 0 || y === box - 1;
      // Corners are clipped, and the pixel diagonally inside each one is outline, so they read as round.
      if (sideX && sideY) return 0;
      if ((x === 1 || x === width - 2) && (y === 1 || y === box - 2)) return 1;
      // The outline is open where the tail joins the box.
      if (y === box - 1 && Math.abs(x - mid) <= 2) return 2;
      return sideX || sideY ? 1 : 2;
    }
    // The tail narrows a pixel each row to a point.
    const t = y - box;
    const half = 2 - t;
    if (half < 0) return x === mid ? 1 : 0;
    if (x === mid - half - 1 || x === mid + half + 1) return 1;
    if (x >= mid - half && x <= mid + half) return 2;
    return 0;
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const ink = px[k + 3] >= 96;
      const s = shape(x, y);
      const colour = s === 0 ? null : s === 1 ? BUBBLE_EDGE : ink ? BUBBLE_INK : BUBBLE_FILL;
      px[k] = colour?.[0] ?? 0;
      px[k + 1] = colour?.[1] ?? 0;
      px[k + 2] = colour?.[2] ?? 0;
      px[k + 3] = colour ? 255 : 0;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, width, rows };
}

// ---------- battle effects ----------

export type FxKind = "slash" | "bolt" | "arrow" | "burst" | "spark" | "mote" | "dust" | "fleck" | "splash";

const fxCache = new Map<string, THREE.CanvasTexture>();

/**
 * A small pixel effect in one colour: a crescent swipe, a spell bolt, an
 * arrow, an impact burst, or healing sparkles. `flip` mirrors it for
 * attacks travelling right to left.
 */
export function fxTexture(kind: FxKind, color: string, flip = false): THREE.CanvasTexture {
  const key = `${kind}|${color}|${flip}`;
  const hit = fxCache.get(key);
  if (hit) return hit;
  const N = 16;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const dot = (x: number, y: number, c = color) => {
    ctx.fillStyle = c;
    ctx.fillRect(flip ? N - 1 - x : x, y, 1, 1);
  };
  if (kind === "slash") {
    // A crescent sweeping from upper left round to lower right, thickest in the middle.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - 2.5;
        const dy = y - 13.5;
        const d = Math.hypot(dx, dy);
        const a = Math.atan2(-dy, dx);
        if (a < 0.05 || a > 1.5) continue;
        const width = 0.6 + 2.6 * Math.sin(((a - 0.05) / 1.45) * Math.PI);
        if (Math.abs(d - 11) <= width / 2 + 0.3) dot(x, y, Math.abs(d - 11.4) < 0.7 ? "#ffffff" : color);
      }
    }
  } else if (kind === "bolt") {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 9.5, y - 7.5);
      if (d < 3.6) dot(x, y, d < 1.8 ? "#ffffff" : color);
    }
    // A short trail behind it.
    for (let x = 1; x < 6; x++) if (x % 2) dot(x, 7);
    dot(3, 9);
    dot(4, 5);
  } else if (kind === "arrow") {
    for (let x = 2; x < 12; x++) dot(x, 8, "#e8dcc0");
    dot(12, 8);
    dot(13, 8);
    dot(11, 7);
    dot(11, 9);
    dot(12, 7);
    dot(12, 9);
    dot(2, 7, "#ffffff");
    dot(2, 9, "#ffffff");
    dot(3, 7, "#ffffff");
    dot(3, 9, "#ffffff");
  } else if (kind === "burst") {
    for (let i = 2; i < 7; i++) {
      dot(8 + i, 8);
      dot(7 - i, 8);
      dot(8, 8 + i - 1);
      dot(8, 7 - i + 1);
    }
    for (let i = 2; i < 5; i++) {
      dot(8 + i, 8 + i);
      dot(7 - i, 7 - i);
      dot(8 + i, 7 - i);
      dot(7 - i, 8 + i);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(7, 7, 2, 2);
  } else if (kind === "dust") {
    // A footfall's puff: a lumpy little cloud, paler at the top, with a speck thrown off each side.
    for (const [x, y, w] of [[6, 7, 3], [5, 8, 6], [4, 9, 8], [5, 10, 6]] as const) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, 1);
    }
    dot(7, 7, "#ffffff");
    dot(2, 9);
    dot(13, 8);
  } else if (kind === "fleck") {
    // Grass kicked up: short blades, each a bright tip over a dark root so they read against the grass.
    for (const [x, y] of [[3, 9], [5, 7], [8, 8], [10, 6], [12, 8], [6, 10]] as const) {
      dot(x, y);
      dot(x, y + 1, "#3f7a2c");
    }
    dot(4, 8, "#3f7a2c");
    dot(11, 7);
  } else if (kind === "splash") {
    // A splash: drops flung up and out from a flat ring.
    for (let x = 4; x < 12; x++) dot(x, 11);
    dot(3, 10);
    dot(12, 10);
    for (const [x, y] of [[4, 7], [3, 5], [11, 7], [12, 5], [7, 6], [8, 4]] as const) dot(x, y);
    dot(8, 5, "#ffffff");
  } else if (kind === "mote") {
    // One XP mote: a solid 4x4 pixel, a white glint in its corner, in the middle of the tile.
    ctx.fillStyle = color;
    ctx.fillRect(6, 6, 4, 4);
    dot(6, 6, "#ffffff");
  } else {
    for (const [cx, cy] of [[4, 4], [11, 6], [6, 11], [12, 12]]) {
      dot(cx, cy, "#ffffff");
      dot(cx - 1, cy);
      dot(cx + 1, cy);
      dot(cx, cy - 1);
      dot(cx, cy + 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  fxCache.set(key, tex);
  return tex;
}
