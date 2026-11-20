// Pixel art for the pub's Turn the Tide table: the nine cards, their back,
// and the tide token. A card is 48 by 62 pixels: its rank in the corner, a pip
// for each copy in the deck, a 16-pixel picture drawn double size in a
// coloured window, and its name. Each is drawn once on a small canvas, which
// the table scene (render/TableStage.ts) makes a texture of and the panel
// shows as an image at a whole multiple with `image-rendering: pixelated`.

import { tideCard, type Tide } from "@gantt-quest/world";
import { paintCrewFace } from "./crewArt";
import { drawPixelText, drawSmallDigits, pixelTextWidth } from "./render/pixelFont";

export const TIDE_CARD_W = 48;
export const TIDE_CARD_H = 62;
export const TIDE_TOKEN_PX = 16;
export type TideFace = number | "back";

const INK = "#1b1830";
const PAPER = "#f4efe1";

const PALETTE: Record<string, string> = {
  k: INK,
  w: "#f4efe1", // white: feathers, eyes, stars
  e: "#aab3bf", // steel, grey feathers
  d: "#565a63", // storm cloud
  D: "#3d4048", // its underside
  g: "#d9a43a", // gold, brass
  y: "#ffd23f", // lightning, lantern
  l: "#ffe9a0", // moonlight
  o: "#e08a3a", // beak, feet
  h: "#6b3f1f", // wood
  t: "#a07a4c", // pale wood
  s: "#e8b38a", // skin
  n: "#2f5a4a", // the smuggler's cloak
  N: "#1f3d33", // its shade
  b: "#3f6fa8", // sea
  c: "#7db6f2", // wave caps, rain, glass
  r: "#b9433d", // red
};

/** The window's colour behind each picture, and the colour of the rank's badge. */
const TINT: Record<number, { sky: string; badge: string }> = {
  1: { sky: "#4a3626", badge: "#8a5a2b" },
  2: { sky: "#8fc7ee", badge: "#3f7fd0" },
  3: { sky: "#2b3a67", badge: "#c99a3a" },
  4: { sky: "#7a2a2e", badge: "#b9433d" },
  5: { sky: "#1b1f45", badge: "#5a55a8" },
  6: { sky: "#1f5f7a", badge: "#2f8f94" },
  7: { sky: "#39404f", badge: "#565a63" },
  8: { sky: "#6b4a3a", badge: "#2f5a4a" },
  9: { sky: "#12233f", badge: "#8a3fa0" },
};

const ART: Record<number, string[]> = {
  // The Stowaway: eyes under the lid of a barrel.
  1: [
    "................",
    "...kkkkkkkkkk...",
    "..kttttttttttk..",
    "...kkkkkkkkkk...",
    "...kkwwkkwwkk...",
    "...kkwkkkwkkk...",
    "..kkkkkkkkkkkk..",
    "..khhthhhhthhk..",
    "..kggggggggggk..",
    ".khhhthhhhthhhk.",
    ".khhhthhhhthhhk.",
    ".khhhthhhhthhhk.",
    "..kggggggggggk..",
    "..khhthhhhthhk..",
    "...kkkkkkkkkk...",
    "................",
  ],
  // The Gull, on a mooring post.
  2: [
    "................",
    "......kkkk......",
    ".....kwwwwk.....",
    "....kwwwkwwkoo..",
    "....kwwwwwwkok..",
    ".....kwwwwwk....",
    "...kkkwwwwwk....",
    "..keeewwwwwwk...",
    ".keeeeewwwwwk...",
    ".kkeeeeewwwwk...",
    "...kkeeewwwk....",
    ".....kkkkkk.....",
    "......o..o......",
    ".....oo.oo......",
    "....khhhhhhk....",
    "....khthhthk....",
  ],
  // The Spyglass, brass and wood, under two stars.
  3: [
    "................",
    "..w.........kk..",
    "...........kcck.",
    "..........kgcck.",
    ".........kggkk..",
    "........kggk....",
    ".......khhk.....",
    "......khhk...w..",
    ".....khhk.......",
    "....kggk........",
    "...khhk.........",
    "..khhk..........",
    ".kggk...........",
    ".kkk......w.....",
    "................",
    "................",
  ],
  // The Cutlass: a curved blade, a gold guard.
  4: [
    "................",
    "............kkk.",
    "...........kwek.",
    "..........kwek..",
    ".........kwwek..",
    "........kwwek...",
    ".......kwwek....",
    "......kwwek.....",
    ".....kwwek......",
    "....kwwek.......",
    "..kgkweek.......",
    "..kggkkk........",
    ".khhgggk........",
    "khhk.kgk........",
    "kkk...k.........",
    "................",
  ],
  // The Moon over the water.
  5: [
    "................",
    ".....kkkkk......",
    "....klllllk..w..",
    "...klllkkk......",
    "..klllk.........",
    "..klllk.....w...",
    "..klllk.........",
    "..klllk.........",
    "..kllllk........",
    "...kllllkkkk....",
    "....klllllllk...",
    ".....kkkkkkk....",
    "................",
    ".bbbcbbbbcbbbbc.",
    "bbcbbbbcbbbbcbbb",
    "bbbbbcbbbbbcbbbb",
  ],
  // The Anchor.
  6: [
    "......kkkk......",
    ".....keeeek.....",
    ".....kek.ek.....",
    ".....keeeek.....",
    "......kwek......",
    "...kkkkwekkkk...",
    "...keeeweeeek...",
    "...kkkkwekkkk...",
    "......kwek......",
    ".kk...kwek...kk.",
    "kwek..kwek..kwek",
    "kwwek.kwek.kweek",
    ".kwwekkwekkweek.",
    "..kwwwwweeeeek..",
    "...kkweeeeekk...",
    ".....kkkkkk.....",
  ],
  // The Storm: a black cloud, a bolt, rain.
  7: [
    "................",
    "......kkkk......",
    "...kkkddddkkk...",
    "..kddddddddddk..",
    ".kddddddddddddk.",
    "kddddddddddddddk",
    "kDDDDDDDDDDDDDDk",
    ".kkkkkkkkkkkkkk.",
    ".......yy.......",
    ".c....yy....c...",
    ".....yyyy.......",
    "..c....yy..c....",
    "......yy........",
    ".c...yy.....c...",
    ".....y...c......",
    "................",
  ],
  // The Smuggler: hooded, with a shuttered lantern.
  8: [
    "................",
    ".....kkkkkk.....",
    "....knnnnnnk....",
    "...knnnnnnnnk...",
    "...knkkkkkknk...",
    "...knswsswsnk...",
    "...knsksskNnk...",
    "...kNnssssnNk...",
    "..knnNnnnnNnk...",
    ".knnnnnnnnnnk.k.",
    ".knnnNnnnnnnkkyk",
    ".knnnNnnnnnsklyk",
    ".knnnNnnnnnnkkyk",
    ".knnnNnnnnnnk.k.",
    ".kNNNNNNNNNNk...",
    ".kkkkkkkkkkkk...",
  ],
};

function paintArt(ctx: CanvasRenderingContext2D, rank: number, x: number, y: number, scale: number) {
  // The Kraken is the one already on the dice of Cargo and Krakens.
  if (rank === 9) return paintCrewFace(ctx, 1, x, y, scale);
  ART[rank]?.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const color = PALETTE[ch];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
    }),
  );
}

/** The card's outline: a rectangle with its corners nipped off. */
function blank(ctx: CanvasRenderingContext2D, fill: string) {
  const W = TIDE_CARD_W;
  const H = TIDE_CARD_H;
  ctx.fillStyle = INK;
  ctx.fillRect(1, 0, W - 2, H);
  ctx.fillRect(0, 1, W, H - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(1, 1, W - 2, H - 2);
}

function paintBack(ctx: CanvasRenderingContext2D) {
  const W = TIDE_CARD_W;
  const H = TIDE_CARD_H;
  blank(ctx, "#22304f");
  // A rope border, and waves all the way down.
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      const edge = x === 3 || y === 3 || x === W - 4 || y === H - 4;
      const wave = (y + Math.floor(Math.sin((x + (Math.floor(y / 6) % 2) * 3) * 1.05) * 1.6)) % 6 === 0;
      if (edge) ctx.fillStyle = (x + y) % 2 === 0 ? "#e2c48f" : "#a8862a";
      else if (wave) ctx.fillStyle = "#3f6fa8";
      else continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // The moon in the middle, in a dark round.
  const cx = W / 2 - 0.5;
  const cy = H / 2 - 0.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 11) continue;
      const moon = d < 7.5 && Math.hypot(x - cx - 3.5, y - cy - 1.5) > 6.5;
      ctx.fillStyle = d > 10 ? "#a8862a" : moon ? "#ffe9a0" : "#1b1f45";
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function paintFront(ctx: CanvasRenderingContext2D, rank: number) {
  const W = TIDE_CARD_W;
  const def = tideCard(rank);
  const tint = TINT[rank] ?? TINT[1];
  blank(ctx, PAPER);
  // The rank, in its badge.
  ctx.fillStyle = INK;
  ctx.fillRect(3, 2, 11, 12);
  ctx.fillStyle = tint.badge;
  ctx.fillRect(4, 3, 9, 10);
  ctx.save();
  ctx.translate(6, 4);
  ctx.scale(2, 2);
  drawSmallDigits(ctx, String(rank), 0, -0.5, PAPER);
  ctx.restore();
  // A pip for every copy in the deck, so the odds are on the card.
  const count = def?.count ?? 1;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = INK;
    ctx.fillRect(W - 7 - i * 5, 6, 4, 4);
    ctx.fillStyle = tint.badge;
    ctx.fillRect(W - 6 - i * 5, 7, 2, 2);
  }
  // The picture in its window.
  ctx.fillStyle = INK;
  ctx.fillRect(3, 15, W - 6, 36);
  ctx.fillStyle = tint.sky;
  ctx.fillRect(4, 16, W - 8, 34);
  paintArt(ctx, rank, (W - 32) / 2, 17, 2);
  const name = def?.name ?? "";
  drawPixelText(ctx, name, Math.round((W - pixelTextWidth(name)) / 2), 52, INK);
}

const canvases = new Map<string, HTMLCanvasElement>();
const urls = new Map<string, string>();

function canvasFor(key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let canvas = canvases.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    paint(canvas.getContext("2d")!);
    canvases.set(key, canvas);
  }
  return canvas;
}

const urlFor = (key: string, canvas: HTMLCanvasElement): string => urls.get(key) ?? urls.set(key, canvas.toDataURL()).get(key)!;

/** A card at its own size, face up or (`"back"`) face down. Drawn once and kept. */
export function tideCardCanvas(face: TideFace): HTMLCanvasElement {
  return canvasFor(`card:${face}`, TIDE_CARD_W, TIDE_CARD_H, (ctx) => (face === "back" ? paintBack(ctx) : paintFront(ctx, face)));
}
export const tideCardUrl = (face: TideFace): string => urlFor(`card:${face}`, tideCardCanvas(face));

/** The tide token, 16 pixels across: the sea up to the brim at high tide, and at low a strip of it under bare sand. */
export function tideTokenCanvas(tide: Tide): HTMLCanvasElement {
  return canvasFor(`tide:${tide}`, TIDE_TOKEN_PX, TIDE_TOKEN_PX, (ctx) => {
    const c = (TIDE_TOKEN_PX - 1) / 2;
    const line = tide === "high" ? 4 : 11;
    for (let y = 0; y < TIDE_TOKEN_PX; y++) {
      for (let x = 0; x < TIDE_TOKEN_PX; x++) {
        const d = Math.hypot(x - c, y - c);
        if (d > 8) continue;
        const cap = y === line + (Math.floor((x + 1) / 2) % 2);
        const sea = y > line;
        ctx.fillStyle = d > 7 ? INK : cap ? "#f4efe1" : sea ? ((x + y * 2) % 5 === 0 ? "#7db6f2" : "#3f7fd0") : tide === "high" ? "#bfe1fb" : (x * 3 + y) % 4 === 0 ? "#b8913f" : "#e6c877";
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });
}
export const tideTokenUrl = (tide: Tide): string => urlFor(`tide:${tide}`, tideTokenCanvas(tide));
