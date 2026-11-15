// The pub's game tables, seen first person. Not a scene of its own: a
// minigame played in the pub's renderer (WorldRenderer.startMinigame), built
// at the table's hex, which the camera drops into from the usual view.
//
// You sit at the table and look across it at everyone else, drawn as the same
// pixel characters you see in the room, with a stool each, their markers or
// dice in front of them and the pot in the middle. It shows what the server
// sends (the views in packages/world); the panel over it (DiceTable,
// ShoalsTable) makes the choices, and a click on a marker in the scene is
// handed to it as an action to ask the server for.
//
// Everyone is placed relative to you: slot 0 is your own seat, at the bottom of
// the view, and the rest go round the table from there.

import * as THREE from "three";
import type { Marker, Outfit, Tide, TidePlay } from "@gantt-quest/world";
import { markerUrl, type MarkerFace } from "../shoalsArt";
import { crewRim, isCrewFace, paintCrewFace } from "../crewArt";
import { TIDE_CARD_H, TIDE_CARD_W, TIDE_TOKEN_PX, tideCardCanvas, tideTokenCanvas, type TideFace } from "../tideArt";
import { makeModelShip } from "./modelShip";
import { sounds } from "../audio/gameSounds";
import { PIXEL_CAP_ROWS, PIXEL_LINE_ROWS, canDrawPixelText, drawPixelText, pixelTextWidth } from "./pixelFont";
import { SITTING_DROP, makeFigure, type Figure } from "./figures";
import { labelTexture, lookFor, spriteKey } from "./sprites";
import { OVERLAY_LAYER } from "./post";
import type { WorldMinigame, WorldRenderer } from "./WorldRenderer";

export type TableKind = "dice" | "shoals" | "crew" | "tide";

/** Something clicked in the scene. */
export type TableAction = { type: "lay"; marker: Marker } | { type: "flip"; seat: string } | { type: "keep"; index: number } | { type: "card"; index: number };

/** Who is in a seat, and how they look and are doing. */
export interface SeatInfo {
  id: string;
  name: string;
  classId: string;
  outfit?: Outfit;
  /** Whose turn it is, who is out, who won. */
  turn: boolean;
  out: boolean;
  won: boolean;
  /** A word over their head: "to play", "says 3", "passed". */
  chip: string | null;
  /** The chip's colour, when its first word does not decide it. */
  chipInk?: string;
  /** A score in a crate beside the name (Cargo and Krakens' cargo), gold-banded for whoever leads. */
  crate?: { score: number; lead: boolean };
  /** Dice or markers left, of how many they began with. */
  pips?: { on: number; of: number };
  /** Passages won, of how many it takes. */
  stars?: { on: number; of: number };
}

export interface DiceScene {
  round: number;
  /** Each seat's dice: yours, face up; the rest only their count. */
  seats: { id: string; count: number; dice: number[] | null }[];
  /** After a call: every die, and which face the bid named (those are lit). */
  reveal: { hands: { id: string; dice: number[] }[]; face: number } | null;
}

export interface ShoalsScene {
  /** Your hand and whether a click on it lays a marker. */
  hand: Record<Marker, number> | null;
  canLay: boolean;
  seats: { id: string; down: number; shown: Marker[]; peeks: Marker[]; struck: boolean; ghost: boolean; canFlip: boolean }[];
}

export interface CrewScene {
  /** Changes with every roll: the dice of whoever just rolled tumble. */
  rollKey: string;
  /** Who rolled last, if their dice should tumble now. */
  rolled: string | null;
  /**
   * Each seat's dice: ship and captain held (drawn as pictures), and the rest. `fresh`: how many of the held came in on
   * this roll; `thrown`: which of the rest were thrown in it (all, if not given). Once the cargo is in (`cargo`), a 1 in
   * it is the Kraken. `keep`: which of the rest are held; they sit lit in the held pool beside the ship. Your own dice can be
   * clicked (`canKeep`) to hold a loose one or let a held one go. The ship cannot be let go. `taken`: the Kraken has
   * this seat's dice, so there are none to draw.
   */
  seats: { id: string; held: number[]; free: number[]; fresh?: number; thrown?: number[]; cargo?: boolean; keep?: number[]; canKeep?: boolean; taken?: boolean }[];
  /** The latest throw left a Kraken in the cargo as the rolls ran out. */
  sunk?: boolean;
  /** The round being played: when it changes, anyone the Kraken robbed is dealt their dice again. */
  round?: number;
}

export interface TideScene {
  /** Which hand this is: a new number is a fresh deal, seen to come off the deck. */
  hand: number;
  /** Changes with every card played: the card just played is seen to go down, and what it did is acted out. */
  playKey: string;
  /** The card just played and what came of it. */
  play: TidePlay | null;
  tide: Tide;
  /** Cards left to draw. */
  deck: number;
  /** The buried card: face down (null) unless you may see it. */
  buried: number | null;
  dealt: boolean;
  /** The hand is over and the cards are shown; `winners` took it. */
  shown: boolean;
  winners: string[];
  /** Each seat's hand (a rank, or "back" for a card you cannot see) and what they have played, oldest first. `pick`: your own cards can be clicked, and which one is picked. */
  seats: { id: string; hand: TideFace[]; known?: boolean; played: number[]; pick?: { can: boolean; index: number | null } }[];
}

/** A card on its way somewhere: from `from` to `to` over `dur` seconds once `t` reaches 0, lifting `lift` on the way, turning face up as it goes if `flip`, unseen until it sets off if `hide`. */
interface Slide {
  t: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  lift: number;
  flip: boolean;
  hide: boolean;
  /** Whole turns it spins flat on the way, for a card caught by the Storm. */
  spin: number;
}

export interface TableCallbacks {
  /** A click on something in the scene. */
  pick(action: TableAction): void;
  /** Escape: get up from the table. */
  stand(): void;
  /** The camera is back in the usual view: the scene can be taken down. */
  left(): void;
}

// ---------- sizes (world units; a hero is 1.5 tall, a hex 1.7 across) ----------

const TABLE_R = 0.75;
/** The height of the tabletop. */
const TOP = 0.62;
/**
 * Where the card's top edge hangs: in front of the table's near rim, just below your own dice. From your seat that is the
 * empty band of the view between your dice and the controls, so it hides no one's face or dice, and the bid sits
 * right under the dice you are weighing it against.
 */
const CARD_Y = TOP + 0.23;
const CARD_Z = TABLE_R + 0.25;
const SEAT_R = 1.35;
const STOOL_H = 0.3;
/** How tall a seated character is drawn. */
const FOLK_H = 1.05;
/** Where a seated player's model stands so that they sit on the stool's top. */
const SEAT_Y = STOOL_H - FOLK_H * SITTING_DROP;
/** From the middle of the table out to a seat's stack or dice, and to the hand. */
const STACK_Z = 0.46;
const HAND_Z = 0.6;
const DIE = 0.1;
const DISC_R = 0.07;
const DISC_T = 0.022;
/** A playing card lying on the table: across, along, and how thick. */
const CARD_AX = 0.105;
const CARD_AL = (CARD_AX * TIDE_CARD_H) / TIDE_CARD_W;
const CARD_T = 0.004;
/** Seconds for a played card to go from the hand to the table. */
const PLAY_S = 0.45;
/** A Cutlass clash: the cards meet and shake, then (unless they tie) one wins at CLASH_HIT_S and both go. */
const CLASH_HIT_S = 0.82;
const CLASH_S = 1.95;
const CLASH_TIE_S = 1.1;
/** Where the deck, the buried card and the tide token lie, from the middle of the table. */
const DECK_AT = new THREE.Vector3(-0.15, TOP + 0.008 + CARD_T / 2, 0.04);
const BURIED_AT = new THREE.Vector3(-0.01, TOP + 0.008 + CARD_T / 2, 0.06);
const TOKEN_AT = new THREE.Vector3(0.17, TOP + 0.018, 0.04);
/** What an aimed card draws across the table in: gold for a Gull, blue for a Spyglass, red for a Cutlass. */
const AIM_INK: Record<number, string> = { 2: "#ffd23f", 3: "#7db6f2", 4: "#f0625a" };
const VFOV = 50;
const IN_S = 1.5;
/** Seconds to get onto a stool, and how far in front of it you stand to do so. */
const SIT_S = 0.5;
/** How far down to your seat the camera is as your own figure starts to thin away, and when it is gone. */
const FADE_FROM = 0.3;
const FADE_TO = 0.8;
/** Seconds for the room's table to go and this one to come in. */
const SWAP_S = 0.8;
/** How far in from your stool the room has your hero standing: a quarter hex toward the camera from the middle of the table's hex. */
const STOOD_AT = SEAT_R + 0.05 - 0.25;
const STEP_IN = 0.4;
const OUT_S = 1.0;
/** A throw of the dice: seconds of the cup being shaken before they leave it, and from leaving it to coming to rest. */
const SHAKE_S = 0.4;
const THROW_S = 0.95;
/** How far through a throw (0 to 1) a die lands, and each bounce after, and how high each bounce goes. */
const LANDINGS = [0.36, 0.62, 0.8, 0.92];
const BOUNCES = [0.07, 0.03, 0.01];

/** When the Kraken comes for a sunk throw: just after its last die has stopped. */
const KRAKEN_AT = SHAKE_S + THROW_S + 0.25;
/** The Kraken's visit, in seconds: its arms come up out of the table, close over the dice, drag them under, and the water shuts. */
const ARMS_UP_S = 0.45;
const ARMS_CURL_S = 0.3;
const ARMS_PULL_S = 0.55;
const POOL_SHUT_S = 0.25;
const SINK_S = ARMS_UP_S + ARMS_CURL_S + ARMS_PULL_S + POOL_SHUT_S;
/** The dark water it comes out of, across and deep (the rig's x and z), round the seat's dice. */
const POOL_X = 0.3;
const POOL_Z = 0.19;
const ARMS = 6;
const ARM_JOINTS = 7;
const ARM_SEG = 0.05;
/** New dice for a seat the Kraken robbed: how high over the table they appear, how long they hang there, and the pause before them. */
const DROP_H = 0.42;
const HANG_S = 0.22;
const REDEAL_S = 0.35;

/** A die in the air: where it left the cup and where it comes to rest (in its seat's frame), how it tumbles, and when. */
interface Throw {
  from: THREE.Vector3;
  to: THREE.Vector3;
  axis: THREE.Vector3;
  turns: number;
  delay: number;
  /** Seconds since the throw was made, the shake included. */
  t: number;
  /** Seconds it hangs where it starts, popping into being, before it falls (dice dealt out of the air). */
  hang?: number;
}

/** The Kraken at a seat's dice (in the rig's frame). */
interface Sink {
  group: THREE.Group;
  /** Seconds since it came up; below zero, it is waiting for the dice to stop. */
  t: number;
  pool: THREE.Mesh;
  ripple: THREE.Mesh;
  /** Each arm's joints from the water up, every one a child of the one before. */
  arms: { joints: THREE.Group[]; phase: number }[];
  /** The dice it is taking and the height each lay at, once it has come up. */
  dice: { o: THREE.Object3D; y: number }[] | null;
  dispose(): void;
}

/** Height over its resting place a die is at, `k` of the way through a throw that began `drop` above it: an arc down to the felt, then a few bounces. */
function throwHeight(k: number, drop: number): number {
  if (k < LANDINGS[0]) {
    const u = k / LANDINGS[0];
    // Tossed a touch upward out of the cup, then falling.
    return drop * (1 - u * u) + 0.05 * Math.sin(u * Math.PI);
  }
  for (let b = 0; b < BOUNCES.length; b++) {
    if (k < LANDINGS[b + 1]) {
      const u = (k - LANDINGS[b]) / (LANDINGS[b + 1] - LANDINGS[b]);
      return BOUNCES[b] * 4 * u * (1 - u);
    }
  }
  return 0;
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** 0 to 1, overshooting a little before it settles. */
const popOut = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
const lambert = (color: string, emissive?: string) => new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: emissive ?? "#000000" });
/** A material showing a texture that also lights itself a little, so the art reads in the pub's dim light. */
const glowing = (map: THREE.Texture, glow = 0.45) => new THREE.MeshLambertMaterial({ map, flatShading: true, emissive: "#ffffff", emissiveMap: map, emissiveIntensity: glow });
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

// ---------- art ----------

const IVORY = "#f4efe1";
const INK = "#2a2118";
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.25], [0.72, 0.25], [0.28, 0.5], [0.72, 0.5], [0.28, 0.75], [0.72, 0.75]],
};

function canvasTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void, crisp = false): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  paint(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (crisp) {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
  }
  return tex;
}

/** One face of a die: ivory with its pips, or (0) the back of a die you cannot see: a walnut face with a gold mark. `icon`: a held ship, captain or crew, drawn as its picture in a gold rim. */
function dieFace(value: number, lit = false, icon = false): THREE.CanvasTexture {
  if (icon && isCrewFace(value)) {
    return canvasTexture(64, 64, (ctx) => {
      ctx.fillStyle = crewRim(value);
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = lit ? "#ffe9a0" : IVORY;
      ctx.fillRect(4, 4, 56, 56);
      paintCrewFace(ctx, value, 8, 8, 3);
    }, true);
  }
  return canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = value === 0 ? "#5a3d22" : lit ? "#ffe9a0" : IVORY;
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = value === 0 ? "#3a2412" : "#cfc6ad";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 60, 60);
    if (value === 0) {
      ctx.fillStyle = "#d9b45a";
      ctx.beginPath();
      ctx.moveTo(32, 20);
      ctx.lineTo(44, 32);
      ctx.lineTo(32, 44);
      ctx.lineTo(20, 32);
      ctx.fill();
      return;
    }
    ctx.fillStyle = value === 1 ? "#b9433d" : INK;
    for (const [x, y] of PIPS[value]) {
      ctx.beginPath();
      ctx.arc(x * 64, y * 64, value === 1 ? 8 : 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** A marker's art as a texture. `peek`: it lies face down but is yours, so you see its face through a veil and a rope ring. */
function markerTexture(face: MarkerFace, peek = false): THREE.CanvasTexture {
  const S = 96;
  const tex = canvasTexture(S, S, () => undefined, true);
  const canvas = tex.image as HTMLCanvasElement;
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, 0, 0, S, S);
    if (peek) {
      ctx.fillStyle = "rgba(60, 36, 16, 0.5)";
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#e2c48f";
      ctx.lineWidth = 5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S * 0.38, 0, Math.PI * 2);
      ctx.stroke();
    }
    tex.needsUpdate = true;
  };
  img.src = markerUrl(face);
  return tex;
}

/** Pixel text (the game's bitmap font), `scale` canvas pixels to a glyph pixel, with its capitals' top-left at (x, y). Returns its width. */
function bigText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ink: string, scale: number): number {
  if (!canDrawPixelText(text)) {
    // A name the bitmap font cannot draw: the system font, as small as it will go.
    ctx.font = `bold ${7 * scale}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = ink;
    ctx.textBaseline = "top";
    ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  }
  const w = pixelTextWidth(text);
  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, w);
  tmp.height = PIXEL_LINE_ROWS;
  drawPixelText(tmp.getContext("2d")!, text, 0, 0, ink);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, x, y, w * scale, PIXEL_LINE_ROWS * scale);
  return w * scale;
}

const textWidth = (text: string, scale: number) => (canDrawPixelText(text) ? pixelTextWidth(text) * scale : text.length * 5 * scale);

/** A die face as a `side`-pixel picture (as tall as the card's large type): ivory, a dark rim, its pips. */
function drawDie(ctx: CanvasRenderingContext2D, value: number, x: number, y: number, side: number) {
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, side, side);
  ctx.fillStyle = IVORY;
  ctx.fillRect(x + 1, y + 1, side - 2, side - 2);
  ctx.fillStyle = value === 1 ? "#b9433d" : INK;
  const size = value === 1 ? Math.round(side / 4) : Math.max(2, Math.round(side / 7));
  for (const [fx, fy] of PIPS[value] ?? []) ctx.fillRect(Math.round(x + 1 + fx * (side - 2) - size / 2), Math.round(y + 1 + fy * (side - 2) - size / 2), size, size);
}

/**
 * What the card over the table says. All of it is optional: a small `caption` along the top (the phase, the pot),
 * a `main` line in large type ending in a die if there is one (the bid), the `prompt` (what is happening, and what to
 * do on your turn), wrapped, and a muted `foot` (your own dice or markers). `yours`: it is your move, and the card is rimmed in gold.
 */
export interface TableCard {
  caption?: string;
  main?: string;
  die?: number;
  prompt?: string;
  foot?: string;
  yours?: boolean;
}

/** The card's width in its own pixels, and world units per pixel: big enough that its smallest type reads from your seat. */
const CARD_W = 200;
const CARD_PX = 0.0037;
/** Lines of prompt the card will hold; past that the last is cut short. */
const CARD_LINES = 4;

/** Split `text` into lines no wider than `max` pixels at `scale`, breaking between words. */
function wrapText(text: string, max: number, scale: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, scale) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The card hung over the table (see TableCard). Drawn at the font's own size and shown unsmoothed, so it stays crisp. Returns its height in pixels. */
function cardTexture(card: TableCard): { texture: THREE.CanvasTexture; height: number } {
  const W = CARD_W;
  // Kept short: it hangs between your dice and the controls.
  const PAD = 5;
  const GAP = 3;
  const ROW = PIXEL_LINE_ROWS + 1;
  /** The bid's type: twice the font's size, and a die as tall as its capitals. */
  const BIG = 2;
  const DIE = PIXEL_CAP_ROWS * BIG;
  let lines = card.prompt ? wrapText(card.prompt, W - PAD * 2, 1) : [];
  if (lines.length > CARD_LINES) lines = [...lines.slice(0, CARD_LINES - 1), `${lines[CARD_LINES - 1]}...`];
  const foot = card.foot ? wrapText(card.foot, W - PAD * 2, 1) : [];
  const blocks = [card.caption ? ROW : 0, card.main ? DIE + 1 : 0, lines.length * ROW, foot.length * ROW].filter((h) => h > 0);
  const H = PAD * 2 + blocks.reduce((n, h) => n + h, 0) + Math.max(0, blocks.length - 1) * GAP;
  const texture = canvasTexture(W, H, (ctx) => {
    // A gold rim on your turn; walnut otherwise. The paper lets the table show through a little; the type is solid.
    const rim = card.yours ? 3 : 2;
    ctx.fillStyle = card.yours ? "rgba(217, 165, 32, 0.95)" : "rgba(107, 74, 43, 0.85)";
    ctx.fillRect(0, 0, W, H);
    ctx.clearRect(rim, rim, W - rim * 2, H - rim * 2);
    ctx.fillStyle = card.yours ? "rgba(255, 243, 207, 0.8)" : "rgba(239, 228, 200, 0.72)";
    ctx.fillRect(rim, rim, W - rim * 2, H - rim * 2);
    const centred = (text: string, y: number, ink: string, scale: number) => bigText(ctx, text, Math.round((W - textWidth(text, scale)) / 2), y, ink, scale);
    let y = PAD;
    const gap = () => (y += GAP);
    if (card.caption) {
      centred(card.caption, y, "#6b4a2b", 1);
      y += ROW;
      gap();
    }
    if (card.main) {
      const total = textWidth(card.main, BIG) + (card.die ? 5 + DIE : 0);
      const x = Math.round((W - total) / 2);
      bigText(ctx, card.main, x, y, INK, BIG);
      if (card.die) drawDie(ctx, card.die, x + textWidth(card.main, BIG) + 5, y, DIE);
      y += DIE + 1;
      gap();
    }
    for (const line of lines) {
      centred(line, y, INK, 1);
      y += ROW;
    }
    if (lines.length) gap();
    for (const line of foot) {
      centred(line, y, "#8a6a44", 1);
      y += ROW;
    }
  }, true);
  return { texture, height: H };
}

/** A row of pips (dice or markers left) and passage stars, small, under a name. */
function tallyTexture(pips: SeatInfo["pips"], stars: SeatInfo["stars"]): THREE.CanvasTexture {
  const STAR = ["..#..", ".###.", "#####", ".###.", "#...#"];
  const w = (pips?.of ?? 0) * 7 + (stars ? 3 + stars.of * 7 : 0);
  return canvasTexture(Math.max(8, w), 9, (ctx) => {
    let x = 0;
    for (let i = 0; i < (pips?.of ?? 0); i++, x += 7) {
      ctx.fillStyle = "#1b1830";
      ctx.fillRect(x, 1, 7, 7);
      ctx.fillStyle = i < pips!.on ? "#ffd23f" : "#3a3558";
      ctx.fillRect(x + 1, 2, 5, 5);
    }
    if (stars) {
      x += 3;
      for (let i = 0; i < stars.of; i++, x += 7) {
        ctx.fillStyle = i < stars.on ? "#ffd23f" : "#3a3558";
        STAR.forEach((row, r) => [...row].forEach((c, k) => c === "#" && ctx.fillRect(x + k, 2 + r, 1, 1)));
      }
    }
  }, true);
}

/** A word over someone's head in the bitmap font, with a dark outline. */
function chipTexture(text: string, ink: string): THREE.CanvasTexture {
  const w = textWidth(text, 1);
  return canvasTexture(w + 4, PIXEL_LINE_ROWS + 4, (ctx) => {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) bigText(ctx, text, 2 + dx, 2 + dy, "#1b1830", 1);
    bigText(ctx, text, 2, 2, ink, 1);
  }, true);
}

/**
 * A name plate with a cargo crate after it: a little slatted wooden box, as tall as the plate, with the score
 * stencilled on it. Banded in gold for whoever leads the round.
 */
function withCrate(plate: { texture: THREE.CanvasTexture; aspect: number }, crate: { score: number; lead: boolean }): { texture: THREE.CanvasTexture; aspect: number } {
  const tag = plate.texture.image as HTMLCanvasElement;
  const h = tag.height;
  const text = String(crate.score);
  const cw = Math.max(h, pixelTextWidth(text) + 6);
  const texture = canvasTexture(tag.width + 2 + cw, h, (ctx) => {
    ctx.drawImage(tag, 0, 0);
    const x = tag.width + 2;
    // The box: a dark edge, the boards, a slat across the top and bottom, and the corners bound in iron or gold.
    ctx.fillStyle = "#3a2414";
    ctx.fillRect(x, 0, cw, h);
    ctx.fillStyle = "#a0703c";
    ctx.fillRect(x + 1, 1, cw - 2, h - 2);
    ctx.fillStyle = "#7a5230";
    ctx.fillRect(x + 1, 1, cw - 2, 1);
    ctx.fillRect(x + 1, h - 2, cw - 2, 1);
    ctx.fillStyle = crate.lead ? "#ffd23f" : "#5a5f6a";
    for (const [cx, cy] of [[x, 0], [x + cw - 2, 0], [x, h - 2], [x + cw - 2, h - 2]]) ctx.fillRect(cx, cy, 2, 2);
    // The score, stencilled dark with a light edge so it reads on the wood.
    const tx = x + Math.round((cw - pixelTextWidth(text)) / 2);
    const ty = Math.max(0, Math.round((h - PIXEL_LINE_ROWS) / 2) + 1);
    drawPixelText(ctx, text, tx, ty, crate.lead ? "#fff3cf" : "#f4efe1");
  }, true);
  plate.texture.dispose();
  return { texture, aspect: texture.image.width / texture.image.height };
}

const CHIP_COLOR: Record<string, string> = { anchored: "#7db6f2",  winner: "#ffd23f", helm: "#ffd23f", "to play": "#ffd23f", out: "#f08a8a", left: "#f08a8a", passed: "#a8a3c4", opened: "#a9d4fb" };

// ---------- the scene ----------

interface Rig {
  id: string;
  /** Turned about y so its local +z points from the middle of the table out to the seat. */
  rig: THREE.Group;
  folk: THREE.Group;
  /** Your own seat: drawn while the camera comes down to it and goes back up, not while it looks out from it. */
  mine: boolean;
  /** How far onto the stool they are, 0 (standing in front of it) to 1 (sat). Everyone but you is found sitting. */
  sit: number;
  /** Where the player sits, facing the table, and their model once they have a look. */
  seat: THREE.Group;
  figure: Figure | null;
  plate: THREE.Sprite;
  chip: THREE.Sprite;
  tally: THREE.Sprite;
  ring: THREE.Mesh;
  items: THREE.Group;
  /** Where the rig's turned to now and is turning to, in radians (about y). */
  yaw: number;
  goal: number;
  look: string;
  plateKey: string;
  chipKey: string;
  tallyKey: string;
  info: SeatInfo | null;
  itemsKey: string;
  /** The Kraken, while it is at this seat's dice. */
  sink: Sink | null;
  /** The hand the Kraken took (or is taking): while the seat still has it, there are no dice to draw. */
  sunkHand: string | null;
  /** New dice are due: seconds until they drop, once the Kraken has gone. */
  redeal: number | null;
  /** The next dice built here fall out of the air. */
  dropIn: boolean;
}

const FACE_NORMAL: Record<number, THREE.Vector3> = {
  2: new THREE.Vector3(1, 0, 0),
  5: new THREE.Vector3(-1, 0, 0),
  1: new THREE.Vector3(0, 1, 0),
  6: new THREE.Vector3(0, -1, 0),
  3: new THREE.Vector3(0, 0, 1),
  4: new THREE.Vector3(0, 0, -1),
};
const UP = new THREE.Vector3(0, 1, 0);
/** Which way is up in each face's picture, on a die as BoxGeometry lays its textures out. */
const FACE_PICTURE_UP: Record<number, THREE.Vector3> = {
  2: new THREE.Vector3(0, 1, 0),
  5: new THREE.Vector3(0, 1, 0),
  1: new THREE.Vector3(0, 0, -1),
  6: new THREE.Vector3(0, 0, 1),
  3: new THREE.Vector3(0, 1, 0),
  4: new THREE.Vector3(0, 1, 0),
};
/**
 * A die turned to show `v` on top with that face's picture the right way up from the seat: the picture's
 * top toward the middle of the table (the seat's frame has +z pointing out to the seat).
 */
function faceUpright(v: number): THREE.Quaternion {
  const n = FACE_NORMAL[v];
  const u = FACE_PICTURE_UP[v];
  const local = new THREE.Matrix4().makeBasis(n, u, n.clone().cross(u));
  const top = new THREE.Vector3(0, 1, 0);
  const away = new THREE.Vector3(0, 0, -1);
  const world = new THREE.Matrix4().makeBasis(top, away, top.clone().cross(away));
  return new THREE.Quaternion().setFromRotationMatrix(world.multiply(local.transpose()));
}

export class TableStage implements WorldMinigame {
  private rigs = new Map<string, Rig>();
  private stools = new THREE.Group();
  private clickables: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private textures: THREE.Texture[] = [];
  private cache = new Map<string, THREE.Texture>();
  private pot = new THREE.Group();
  /** The table itself. With the stools, it grows up out of the floor as the room's own table shrinks away. */
  private furniture = new THREE.Group();
  /** The room's table at this hex, which this one takes the place of while you sit at it. */
  private old: THREE.Object3D | undefined;
  /** How far the swap has gone, 0 to 1: the room's table goes in the first half, this one comes in the second. */
  private swap = 0;
  private potKey = "";
  private card: THREE.Sprite;
  private cardKey = "";
  private chairs = 0;
  private order: (SeatInfo | undefined)[] = [];
  private inT = 0;
  /** Your hero has walked up to the table, and has sat down once. */
  private arrived = false;
  private sat = false;
  private leaving = false;
  private disposed = false;
  private clock = 0;
  private lastRound = -1;
  private dieMats: THREE.Material[] | null = null;
  private dieBack: THREE.Material[] | null = null;
  private dieLit: THREE.Material[] | null = null;
  /** Cargo and Krakens' dice: the ship printed on the 6, the captain on the 5 and the Kraken on the 1, pips on the rest; and the same lit, for a kept die. */
  private crewDice: { shown: THREE.Material[]; lit: THREE.Material[] } | null = null;
  private lastRoll = "";
  private crewScene: CrewScene | null = null;
  private lastCrewRound: number | undefined;
  /** The dice have been told what is on the table at least once: a change after that is a roll to be seen and heard, not the state you sat down to. */
  private primed = false;
  private lastReveal = "";
  private discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_T, 20);
  private cardGeo = new THREE.BoxGeometry(CARD_AX, CARD_T, CARD_AL);
  /** Turn the Tide: the deck, the buried card and the tide token in the middle of the table. */
  private middle = new THREE.Group();
  private middleKey = "";
  /** What the card table last showed, to tell what has changed, and the key of the last thing acted out. */
  private tidePrev: TideScene | null = null;
  private tideEv = "";
  /** The card table has been told what is on it at least once: what it is told after that is a change to act out. */
  private tideTold = false;
  /** Things that are on the table only for a moment: a line from a player to whoever they played on, a card called out, a clash. */
  private fx = new THREE.Group();
  private lineGeo = new THREE.BoxGeometry(0.014, 0.004, 1).translate(0, 0, 0.5);
  private ringGeo = new THREE.RingGeometry(0.075, 0.092, 28);

  constructor(private world: WorldRenderer, private group: THREE.Group, private kind: TableKind, private cb: TableCallbacks) {
    // Dice and markers are read up close: draw them at full resolution, not the chunky half.
    world.setSharp(true);
    this.buildTable();
    this.group.add(this.furniture, this.stools, this.pot, this.middle, this.fx);
    this.old = world.poiObject(kind);
    this.showSwap();
    // Hung above the middle of the table, turned to face whoever looks at it (a sprite faces each viewer's own camera).
    // Drawn over the table's rim, not hidden behind it.
    this.card = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    this.card.renderOrder = 9;
    this.card.scale.set(0.64, 0.32, 1);
    // Hung by its top edge (see setCard).
    this.card.center.set(0.5, 1);
    this.card.layers.set(OVERLAY_LAYER);
    this.card.position.set(0, CARD_Y, CARD_Z);
    this.card.visible = false;
    this.group.add(this.card);
  }

  // ---------- building ----------

  private tex<T extends THREE.Texture>(key: string, make: () => T): T {
    let t = this.cache.get(key) as T | undefined;
    if (!t) {
      t = make();
      this.cache.set(key, t);
      this.textures.push(t);
    }
    return t;
  }

  private own<T extends THREE.Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }

  private buildTable() {
    const wood = lambert("#6b4a2b");
    const rim = lambert("#a07a4c");
    const cloth = lambert(this.kind === "shoals" ? "#2f6f8c" : this.kind === "crew" ? "#6b2f35" : this.kind === "tide" ? "#3a3570" : "#2f6b4a");
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.furniture.add(m);
      return m;
    };
    // A pedestal and a broad foot, a wooden top with a cloth let into it.
    add(new THREE.CylinderGeometry(0.14, 0.2, TOP - 0.04, 8), wood, 0, (TOP - 0.04) / 2, 0);
    add(new THREE.CylinderGeometry(0.42, 0.46, 0.05, 10), wood, 0, 0.025, 0);
    add(new THREE.CylinderGeometry(TABLE_R, TABLE_R * 0.92, 0.07, 28), rim, 0, TOP - 0.035, 0);
    add(new THREE.CylinderGeometry(TABLE_R - 0.07, TABLE_R - 0.07, 0.01, 28), cloth, 0, TOP + 0.002, 0);
    if (this.kind === "crew") {
      // The model ship in full sail, in the middle of the table where everyone's dice face it.
      const ship = makeModelShip(0.62);
      ship.position.set(0, TOP + 0.008, -0.02);
      ship.rotation.y = 0.35;
      this.furniture.add(ship);
    }
  }

  /** A set of stools, one for every chair. */
  private buildStools(chairs: number) {
    this.stools.clear();
    const wood = lambert("#5a3d22");
    const top = lambert("#7a5230");
    for (let i = 0; i < chairs; i++) {
      const a = Math.PI / 2 + (i * Math.PI * 2) / chairs;
      const g = new THREE.Group();
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, STOOL_H - 0.04, 7), wood);
      leg.position.y = (STOOL_H - 0.04) / 2;
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 9), top);
      seat.position.y = STOOL_H - 0.025;
      g.add(leg, seat);
      g.position.set(Math.cos(a) * SEAT_R, 0, Math.sin(a) * SEAT_R);
      this.stools.add(g);
    }
  }

  private makeRig(id: string): Rig {
    const rig = new THREE.Group();
    const folk = new THREE.Group();
    folk.position.z = SEAT_R + 0.05;
    const seat = new THREE.Group();
    seat.position.y = SEAT_Y;
    // The rig's +z points out from the table: they sit facing in.
    seat.rotation.y = Math.PI;
    const overlay = (map: THREE.Texture | null, y: number, order: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
      s.renderOrder = order;
      // Drawn after the depth-of-field blur, so it stays crisp however far from the focus it sits.
      s.layers.set(OVERLAY_LAYER);
      s.position.y = y;
      return s;
    };
    const plate = overlay(null, STOOL_H + FOLK_H + 0.04, 7);
    const tally = overlay(null, STOOL_H + FOLK_H - 0.1, 7);
    const chip = overlay(null, STOOL_H + FOLK_H + 0.3, 8);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.36, 28), new THREE.MeshBasicMaterial({ color: "#ffd23f", transparent: true, opacity: 0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.012, SEAT_R + 0.05);
    chip.visible = false;
    tally.visible = false;
    folk.add(seat, plate, tally, chip);
    const items = new THREE.Group();
    rig.add(folk, ring, items);
    this.group.add(rig);
    return { id, rig, folk, mine: false, sit: 1, seat, figure: null, plate, chip, tally, ring, items, yaw: 0, goal: 0, look: "", plateKey: "", chipKey: "", tallyKey: "", info: null, itemsKey: "", sink: null, sunkHand: null, redeal: null, dropIn: false };
  }

  // ---------- what the panel tells it ----------

  /** Everyone at the table, slot 0 being your own seat. A slot with nobody is an empty stool. */
  setSeats(chairs: number, placed: (SeatInfo | undefined)[]) {
    if (this.chairs !== chairs) {
      this.chairs = chairs;
      this.buildStools(chairs);
    }
    this.order = placed;
    const seen = new Set<string>();
    placed.forEach((info, i) => {
      if (!info) return;
      seen.add(info.id);
      const r = this.rigs.get(info.id) ?? this.rigs.set(info.id, this.makeRig(info.id)).get(info.id)!;
      const angle = Math.PI / 2 + (i * Math.PI * 2) / chairs;
      // Local +z, turned to point at angle a (x = cos, z = sin): yaw = pi/2 - a.
      const goal = Math.PI / 2 - angle;
      if (!r.info) r.yaw = goal;
      r.goal = goal;
      r.info = info;
      this.dress(r, info, i === 0);
    });
    for (const [id, r] of this.rigs) {
      if (seen.has(id)) continue;
      this.group.remove(r.rig);
      this.disposeRig(r);
      this.rigs.delete(id);
    }
  }

  /** The look of a seat: the character, their name, a word over their head, what they have left. */
  private dress(r: Rig, info: SeatInfo, mine: boolean) {
    // You are seen to sit down: your seat starts with you on your feet.
    if (mine && !r.mine && !this.sat) r.sit = 0;
    r.mine = mine;
    const look = spriteKey(info.classId, info.outfit);
    if (r.look !== look) {
      r.look = look;
      if (r.figure) {
        r.seat.remove(r.figure.root);
        r.figure.dispose();
      }
      r.figure = makeFigure(info.classId, lookFor(info.classId), info.outfit);
      r.figure.setSize(FOLK_H);
      r.seat.add(r.figure.root);
    }
    // Out of the game: greyed.
    r.figure?.setDim(!!info.out);
    const plateKey = `${firstName(info.name)}|${info.crate ? `${info.crate.score}${info.crate.lead ? "*" : ""}` : ""}`;
    if (r.plateKey !== plateKey) {
      r.plateKey = plateKey;
      const { texture, aspect } = info.crate ? withCrate(labelTexture(firstName(info.name)), info.crate) : labelTexture(firstName(info.name));
      this.own(texture);
      r.plate.material.map = texture;
      r.plate.material.needsUpdate = true;
      r.plate.scale.set(0.17 * aspect, 0.17, 1);
      r.plate.center.set(0.5, 0);
    }
    const chipKey = `${info.chip ?? ""}|${info.chipInk ?? ""}`;
    if (r.chipKey !== chipKey) {
      r.chipKey = chipKey;
      if (info.chip) {
        const t = this.own(chipTexture(info.chip, info.chipInk ?? CHIP_COLOR[info.chip.split(" ")[0]] ?? "#a9d4fb"));
        r.chip.material.map = t;
        r.chip.material.needsUpdate = true;
        r.chip.scale.set(0.18 * (t.image.width / t.image.height), 0.18, 1);
      }
      r.chip.visible = !!info.chip;
    }
    const tallyKey = `${info.pips?.on}/${info.pips?.of}|${info.stars?.on}/${info.stars?.of}`;
    if (r.tallyKey !== tallyKey) {
      r.tallyKey = tallyKey;
      r.tally.visible = !!(info.pips || info.stars);
      if (info.pips || info.stars) {
        const t = this.own(tallyTexture(info.pips, info.stars));
        r.tally.material.map = t;
        r.tally.material.needsUpdate = true;
        r.tally.scale.set(0.016 * t.image.width, 0.016 * t.image.height, 1);
      }
    }
  }

  /** The heap of gold in the middle: a coin for every five. Rebuilt only when the pot changes. */
  setPot(gold: number) {
    const key = String(Math.max(0, Math.round(gold)));
    if (key === this.potKey) return;
    this.potKey = key;
    this.pot.clear();
    if (gold <= 0) return;
    const coins = Math.max(1, Math.min(30, Math.ceil(gold / 5)));
    const geo = new THREE.CylinderGeometry(0.036, 0.036, 0.012, 10);
    const mat = lambert("#e0b43a", "#5a4300");
    const per = 6;
    for (let c = 0; c < coins; c++) {
      const stack = Math.floor(c / per);
      const a = stack * 2.4;
      const m = new THREE.Mesh(geo, mat);
      // Crew: the far side has a seat's dice and the middle the ship, so the pot goes beside the ship.
      // Tide: the deck and the tide token have the middle, so the pot sits just beyond them.
      const [px, pz] = this.kind === "crew" ? [0.24, -0.16] : this.kind === "tide" ? [0, -0.19] : [0, -0.34];
      m.position.set(px + Math.cos(a) * (stack ? 0.085 : 0), TOP + 0.014 + (c % per) * 0.013, pz + Math.sin(a) * (stack ? 0.085 : 0));
      m.rotation.y = c * 0.7;
      this.pot.add(m);
    }
  }

  /** The card hanging over the table, facing everyone: what the bid is, or what the last call found. Null puts it away. */
  setCard(card: TableCard | null) {
    const key = card ? JSON.stringify(card) : "";
    if (key === this.cardKey) return;
    this.cardKey = key;
    this.card.visible = !!card;
    if (!card) return;
    const mat = this.card.material;
    const old = mat.map;
    const { texture, height } = cardTexture(card);
    mat.map = texture;
    mat.needsUpdate = true;
    old?.dispose();
    // Its top edge stays put under your dice, so a longer card grows down toward you rather than up over them.
    this.card.scale.set(CARD_W * CARD_PX, height * CARD_PX, 1);
  }

  // ---------- dice ----------

  private crewMaterials(): { shown: THREE.Material[]; lit: THREE.Material[] } {
    if (!this.crewDice) {
      const face = (v: number, lit: boolean) => glowing(this.tex(`crew:${v}:${lit}`, () => dieFace(v, lit, true)), lit ? 0.75 : isCrewFace(v) ? 0.55 : 0.4);
      // BoxGeometry's faces are +x, -x, +y, -y, +z, -z.
      const order = [2, 5, 1, 6, 3, 4];
      this.crewDice = { shown: order.map((v) => face(v, false)), lit: order.map((v) => face(v, true)) };
    }
    return this.crewDice;
  }

  private dieMaterials(): { shown: THREE.Material[]; back: THREE.Material[]; lit: THREE.Material[] } {
    if (!this.dieMats) {
      const face = (v: number, lit = false, icon = false) => glowing(this.tex(`die:${v}:${lit}:${icon}`, () => dieFace(v, lit, icon)), lit ? 0.8 : icon ? 0.55 : 0.4);
      // BoxGeometry's faces are +x, -x, +y, -y, +z, -z.
      const order = [2, 5, 1, 6, 3, 4];
      this.dieMats = order.map((v) => face(v));
      this.dieLit = order.map((v) => face(v, true));
      this.dieBack = order.map(() => face(0));
    }
    return { shown: this.dieMats, back: this.dieBack!, lit: this.dieLit! };
  }

  /**
   * Throw these dice (wrappers already standing where they will come to rest) from the seat's side
   * of the table: after a shake of the cup, each flies out, lands, bounces and rolls to a stop on its
   * face. The sounds are timed to it. `held` are set aside as they land, with a firmer clack; `yours`
   * is louder than anyone else's throw.
   */
  private throwDice(wraps: THREE.Object3D[], opts: { held?: Set<THREE.Object3D>; yours: boolean; sunk?: boolean }) {
    if (wraps.length === 0) return;
    const quiet = opts.yours ? 0 : -5;
    sounds.table("shake", { gainDb: quiet });
    wraps.forEach((wrap, i) => {
      const to = wrap.position.clone();
      // Out of the cup in your hand, over the near rim, a little to the side each.
      const from = new THREE.Vector3(to.x * 0.4 + (Math.random() - 0.5) * 0.12, TOP + 0.26 + Math.random() * 0.06, STACK_Z + 0.42);
      const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).normalize();
      const delay = SHAKE_S + i * 0.05 + Math.random() * 0.03;
      const held = !!opts.held?.has(wrap);
      wrap.userData.throw = { from, to, axis, turns: 2 + Math.random() * 1.5, delay, t: 0 } satisfies Throw;
      wrap.position.copy(from);
      wrap.visible = false;
      // A die coming to rest; a held one is set aside just after with a firmer clack.
      sounds.table("settle", { delay: delay + THROW_S * 0.9, gainDb: quiet });
      if (held) sounds.table("hold", { delay: delay + THROW_S + 0.12, gainDb: quiet });
    });
    sounds.table("roll", { delay: SHAKE_S + THROW_S * LANDINGS[0], gainDb: quiet });
    // The Kraken rises as the last die stops.
    if (opts.sunk) sounds.table("kraken", { delay: KRAKEN_AT });
  }

  /** Deal these dice (wrappers standing where they will rest) out of the air: each pops into being over its place, hangs a moment, and drops. */
  private dropDice(wraps: THREE.Object3D[], yours: boolean) {
    const quiet = yours ? -3 : -8;
    wraps.forEach((wrap, i) => {
      const to = wrap.position.clone();
      const from = to.clone().setY(to.y + DROP_H + Math.random() * 0.05);
      const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).normalize();
      const delay = i * 0.06 + Math.random() * 0.03;
      wrap.userData.throw = { from, to, axis, turns: 1 + Math.random(), delay, t: 0, hang: HANG_S } satisfies Throw;
      wrap.position.copy(from);
      wrap.scale.setScalar(0.001);
      wrap.visible = false;
      sounds.table("settle", { delay: delay + HANG_S + THROW_S * 0.9, gainDb: quiet });
    });
    if (wraps.length) sounds.table("roll", { delay: HANG_S + THROW_S * LANDINGS[0], gainDb: quiet });
  }

  /** The Kraken for this seat's dice: a pool of dark water round them and its arms, all still under the table. */
  private makeSink(r: Rig): Sink {
    const group = new THREE.Group();
    group.position.set(0, TOP + 0.01, STACK_Z - 0.02);
    const flat = (geo: THREE.BufferGeometry, color: string) => {
      // Lying on the cloth: nudged toward the eye so the two do not fight.
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.rotation.x = -Math.PI / 2;
      group.add(m);
      return m;
    };
    const pool = flat(new THREE.CircleGeometry(1, 28), "#07131c");
    const ripple = flat(new THREE.RingGeometry(0.86, 1, 28), "#8fd6e6");
    ripple.visible = false;
    const skin = lambert("#8a3fa0", "#2b1033");
    // An arm's pieces, thick at the water and thin at the tip, each standing on its own foot.
    const segs = Array.from({ length: ARM_JOINTS }, (_, i) => {
      const at = (j: number) => 0.024 - (0.019 * j) / ARM_JOINTS;
      return new THREE.CylinderGeometry(at(i + 1), at(i), ARM_SEG, 6).translate(0, ARM_SEG / 2, 0);
    });
    const arms = Array.from({ length: ARMS }, (_, a) => {
      const angle = (a / ARMS) * Math.PI * 2 + 0.3;
      const root = new THREE.Group();
      root.position.set(Math.cos(angle) * POOL_X * 0.82, 0, Math.sin(angle) * POOL_Z * 0.82);
      // Its +z toward the middle of the pool, which is the way it curls.
      root.rotation.y = Math.atan2(-root.position.x, -root.position.z);
      root.scale.setScalar(a % 2 ? 0.8 : 1);
      group.add(root);
      const joints: THREE.Group[] = [];
      let parent: THREE.Object3D = root;
      for (let i = 0; i < ARM_JOINTS; i++) {
        const joint = new THREE.Group();
        joint.position.y = i ? ARM_SEG : 0;
        joint.scale.setScalar(0.001);
        joint.add(new THREE.Mesh(segs[i], skin));
        parent.add(joint);
        parent = joint;
        joints.push(joint);
      }
      return { joints, phase: a * 1.9 };
    });
    group.visible = false;
    r.rig.add(group);
    const dispose = () => {
      r.rig.remove(group);
      for (const g of [...segs, pool.geometry, ripple.geometry]) g.dispose();
      for (const m of [skin, pool.material, ripple.material]) (m as THREE.Material).dispose();
    };
    return { group, t: -KRAKEN_AT, pool, ripple, arms, dice: null, dispose };
  }

  /** The Kraken is done with this seat (or its dice have changed under it): take it away. `keep`: the dice stay gone. */
  private endSink(r: Rig, keep = false) {
    r.sink?.dispose();
    r.sink = null;
    if (!keep) {
      r.sunkHand = null;
      r.redeal = null;
    }
  }

  /** A frame of the Kraken's visit: up out of the table, over the dice, and under with them. */
  private animateSink(r: Rig, dt: number) {
    const s = r.sink!;
    s.t += dt;
    if (s.t < 0) return;
    const t = s.t;
    s.group.visible = true;
    s.dice ??= r.items.children.map((o) => ({ o, y: (o.userData.throw as Throw | undefined)?.to.y ?? o.position.y }));
    const up = clamp01(t / ARMS_UP_S);
    const curl = smoother(clamp01((t - ARMS_UP_S) / ARMS_CURL_S));
    const pull = clamp01((t - ARMS_UP_S - ARMS_CURL_S) / ARMS_PULL_S) ** 2;
    const shut = smoother(clamp01((t - (SINK_S - POOL_SHUT_S)) / POOL_SHUT_S));
    const open = smoother(clamp01(t / 0.2)) * (1 - shut);
    s.pool.scale.set(Math.max(0.001, POOL_X * open), Math.max(0.001, POOL_Z * open), 1);
    (s.pool.material as THREE.MeshBasicMaterial).opacity = 0.92;
    // A ring of foam runs out from where the arms close on the dice.
    const wave = clamp01((t - ARMS_UP_S - ARMS_CURL_S * 0.6) / 0.45);
    s.ripple.visible = wave > 0 && wave < 1;
    s.ripple.scale.set(POOL_X * (0.7 + wave * 0.7), POOL_Z * (0.7 + wave * 0.7), 1);
    (s.ripple.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - wave);
    // The arms grow from the water up, and go back down into it tip first.
    const grown = (1 - (1 - up) ** 2) * (1 - smoother(clamp01((pull - 0.25) / 0.75)));
    s.group.position.y = TOP + 0.01;
    for (const arm of s.arms) {
      arm.joints.forEach((joint, i) => {
        joint.scale.setScalar(THREE.MathUtils.clamp(grown * ARM_JOINTS - i, 0.001, 1));
        // Leaning out and swaying as it comes up; then every joint bends in over the dice.
        const sway = Math.sin(t * 11 + arm.phase + i * 0.9) * 0.11 * (1 - curl);
        joint.rotation.x = (i ? 0.05 : -0.4) + sway + curl * (i ? 0.44 + pull * 0.12 : 0.45);
      });
    }
    s.dice.forEach(({ o, y }, i) => {
      if (o.userData.throw) return;
      // Rattled as the arms close; then down through the cloth, shrinking away as it goes under.
      const drop = pull * 0.17;
      o.position.y = y + Math.sin(t * 45 + i * 2.1) * 0.004 * curl * (1 - pull) - drop;
      o.rotation.z = Math.sin(i * 3.7) * 0.5 * pull;
      o.scale.setScalar(Math.max(0.001, 1 - smoother(clamp01((drop - 0.03) / 0.1))));
    });
    if (t < SINK_S) return;
    // Gone, dice and all: the seat is bare until it is dealt new ones.
    this.endSink(r, true);
    r.items.clear();
    r.itemsKey = "";
  }

  syncDice(scene: DiceScene | null) {
    const mats = this.dieMaterials();
    const rolled = !!scene && scene.round !== this.lastRound && this.primed;
    // Every die shown after a call: the cups come up.
    const reveal = scene?.reveal ? `${scene.round}|${scene.reveal.face}` : "";
    if (reveal && reveal !== this.lastReveal && this.primed) sounds.table("reveal");
    this.lastReveal = reveal;
    this.primed = true;
    if (scene) this.lastRound = scene.round;
    this.clickables = [];
    for (const r of this.rigs.values()) {
      const seat = scene?.seats.find((s) => s.id === r.id);
      const hand = scene?.reveal?.hands.find((h) => h.id === r.id)?.dice ?? seat?.dice ?? null;
      const count = scene?.reveal ? (hand?.length ?? 0) : (seat?.count ?? 0);
      const key = `${count}|${hand?.join("") ?? "h"}|${scene?.reveal?.face ?? 0}`;
      if (key === r.itemsKey && !rolled) continue;
      r.itemsKey = key;
      r.items.clear();
      if (!scene || count === 0) continue;
      const geo = new THREE.BoxGeometry(DIE, DIE, DIE);
      for (let i = 0; i < count; i++) {
        const v = hand?.[i] ?? 0;
        const lit = !!scene.reveal && v === scene.reveal.face;
        // A wrapper turned to roll, and the die inside it, turned so the face wanted is up.
        const wrap = new THREE.Group();
        wrap.position.set((i - (count - 1) / 2) * (DIE * 1.45), TOP + DIE / 2 + 0.01 + (lit ? 0.04 : 0), STACK_Z);
        const die = new THREE.Mesh(geo, v === 0 ? mats.back : lit ? mats.lit : mats.shown);
        if (v > 0) die.quaternion.setFromUnitVectors(FACE_NORMAL[v], UP);
        die.rotateOnWorldAxis(UP, 0.5 + i * 1.7 + v);
        wrap.add(die);
        r.items.add(wrap);
      }
      if (rolled) this.throwDice([...r.items.children], { yours: r.mine });
    }
  }

  // ---------- ship, captain and crew ----------

  /**
   * Each seat's five dice in front of them: the cargo (or, before the crew is
   * in, the dice still rolling) in a row nearest the seat, and behind it, toward
   * the ship, ship, captain and crew showing their pictures, a size larger so
   * they stand out over the loose dice.
   */
  syncCrew(scene: CrewScene | null) {
    const mats = this.dieMaterials();
    const rolled = !!scene && scene.rollKey !== this.lastRoll && this.primed;
    // A new round (seen to begin, not found begun): whoever the Kraken robbed is dealt their dice again.
    const newRound = !!scene && this.primed && this.lastCrewRound !== undefined && scene.round !== this.lastCrewRound;
    this.primed = true;
    this.crewScene = scene;
    if (scene) {
      this.lastRoll = scene.rollKey;
      this.lastCrewRound = scene.round;
    }
    this.clickables = [];
    const size = DIE * 0.85;
    const geo = new THREE.BoxGeometry(size, size, size);
    const big = DIE * 1.15;
    const heldGeo = new THREE.BoxGeometry(big, big, big);
    for (const r of this.rigs.values()) {
      const seat = scene?.seats.find((s) => s.id === r.id);
      const key = seat ? `${seat.held.join("")}|${seat.free.join("")}|${seat.cargo}|${seat.keep?.join(",")}|${seat.canKeep}` : "";
      const tumble = rolled && scene?.rolled === r.id;
      // The Kraken has these dice, or is taking them: they are its to move, and then there are none, for as long as
      // the seat's hand is the one it took.
      const hand = seat ? `${seat.held.join("")}|${seat.free.join("")}` : "";
      if (r.sunkHand !== null && (tumble || r.sunkHand !== hand)) this.endSink(r);
      if (r.sunkHand === null && seat?.taken && !tumble) r.sunkHand = hand;
      if (r.sunkHand !== null) {
        if (!r.sink) {
          r.items.clear();
          r.itemsKey = "";
        }
        continue;
      }
      if (key === r.itemsKey && !tumble) {
        // Clickables are rebuilt each time, so gather them again from what stays.
        r.items.traverse((o) => o.userData.action && this.clickables.push(o));
        continue;
      }
      r.itemsKey = key;
      r.items.clear();
      if (!seat) continue;
      const thrown: THREE.Object3D[] = [];
      const held = new Set<THREE.Object3D>();
      const keep = new Set(seat.keep ?? []);
      const throwFree = new Set(seat.thrown ?? seat.free.map((_, i) => i));
      const crew = this.crewMaterials();
      /** A die you may click: to hold it on your next roll, or to put back one you picked. A Kraken cannot be held. */
      const clickable = (wrap: THREE.Group, i: number, w: number) => {
        wrap.userData.action = { type: "keep", index: i } satisfies TableAction;
        wrap.userData.baseY = wrap.position.y;
        // A click anywhere near the die does it: an invisible, generous box round it.
        wrap.add(new THREE.Mesh(new THREE.BoxGeometry(w * 1.5, w * 2, w * 1.5), new THREE.MeshBasicMaterial({ visible: false })));
        this.clickables.push(wrap);
      };
      // The held pool, in a row toward the ship, a size larger and reading the right way up from the seat: the ship,
      // then (lit) the dice held.
      const pool = [...seat.held.map((v) => ({ v, i: -1 })), ...seat.free.map((v, i) => ({ v, i })).filter(({ i }) => keep.has(i))];
      pool.forEach(({ v, i }, slot) => {
        const picked = i >= 0;
        const wrap = new THREE.Group();
        wrap.position.set((slot - (pool.length - 1) / 2) * big * 1.35, TOP + big / 2 + 0.01, STACK_Z - 0.1);
        const die = new THREE.Mesh(heldGeo, picked ? crew.lit : crew.shown);
        die.quaternion.copy(faceUpright(v));
        wrap.add(die);
        r.items.add(wrap);
        if (tumble && slot < seat.held.length && slot >= seat.held.length - (seat.fresh ?? 0)) {
          thrown.push(wrap);
          held.add(wrap);
        }
        if (picked && seat.canKeep) clickable(wrap, i, big);
      });
      // The loose dice, to be rolled again, nearest the seat, each lying on the face it rolled: a picture face square to the seat so it reads, pips any old way.
      const loose = seat.free.map((v, i) => ({ v, i })).filter(({ i }) => !keep.has(i));
      loose.forEach(({ v, i }, slot) => {
        const wrap = new THREE.Group();
        wrap.position.set((slot - (loose.length - 1) / 2) * size * 1.5, TOP + size / 2 + 0.01, STACK_Z + 0.06);
        const die = new THREE.Mesh(geo, v === 0 ? mats.back : crew.shown);
        if (isCrewFace(v)) die.quaternion.copy(faceUpright(v));
        else if (v > 0) {
          die.quaternion.setFromUnitVectors(FACE_NORMAL[v], UP);
          die.rotateOnWorldAxis(UP, 0.5 + i * 1.7 + v);
        }
        wrap.add(die);
        r.items.add(wrap);
        if (tumble && throwFree.has(i)) thrown.push(wrap);
        if (seat.canKeep && !(seat.cargo && v === 1)) clickable(wrap, i, size);
      });
      if (tumble) this.throwDice(thrown, { held, yours: r.mine, sunk: !!scene?.sunk });
      if (tumble && scene?.sunk) {
        r.sunkHand = hand;
        r.sink = this.makeSink(r);
      } else if (r.dropIn) this.dropDice([...r.items.children], r.mine);
      r.dropIn = false;
    }
    if (newRound) for (const r of this.rigs.values()) if (r.sunkHand !== null) r.redeal = REDEAL_S;
  }

  // ---------- shoals ----------

  private disc(face: MarkerFace, peek = false): THREE.Mesh {
    const top = glowing(this.tex(`m:${face}:${peek}`, () => markerTexture(face, peek)), 0.5);
    const side = lambert("#6b4a2b");
    const under = glowing(this.tex("m:back:false", () => markerTexture("back")), 0.4);
    return new THREE.Mesh(this.discGeo, [side, top, under]);
  }

  syncShoals(scene: ShoalsScene | null) {
    this.clickables = [];
    for (const r of this.rigs.values()) {
      const seat = scene?.seats.find((s) => s.id === r.id);
      const mine = r === this.rigs.get(this.order[0]?.id ?? "");
      const key = scene ? `${seat?.down}|${seat?.shown.join(",")}|${seat?.peeks.join(",")}|${seat?.struck}|${seat?.ghost}|${seat?.canFlip}|${mine ? `${scene.hand?.channel}${scene.hand?.shoal}${scene.canLay}` : ""}` : "";
      if (key === r.itemsKey) {
        // Clickables are rebuilt each time, so gather them again from what stays.
        r.items.traverse((o) => o.userData.action && this.clickables.push(o));
        continue;
      }
      r.itemsKey = key;
      r.items.clear();
      if (!scene) continue;
      if (seat && (seat.down > 0 || seat.shown.length > 0)) {
        // The face-down markers, fanned toward the middle so each can be seen, yours showing their faces through a veil.
        const pile = new THREE.Group();
        pile.position.set(-0.1, TOP + 0.012, STACK_Z);
        for (let i = 0; i < seat.down; i++) {
          const peek = seat.peeks[seat.down - 1 - i];
          const d = this.disc(peek ?? "back", !!peek);
          d.position.set(0, i * DISC_T, -i * 0.032);
          d.rotation.y = (i * 0.7) % 1;
          pile.add(d);
        }
        if (seat.canFlip) {
          pile.userData.action = { type: "flip", seat: r.id } satisfies TableAction;
          pile.userData.pulse = true;
          pile.userData.baseY = pile.position.y;
          // A click anywhere near the pile turns it: an invisible, generous disc over it.
          const hit = new THREE.Mesh(new THREE.CylinderGeometry(DISC_R * 1.7, DISC_R * 1.7, 0.1, 12), new THREE.MeshBasicMaterial({ visible: false }));
          hit.position.set(0, 0.04, -0.03);
          pile.add(hit);
          this.clickables.push(pile);
        }
        r.items.add(pile);
        // What has been turned over, in a row beside it, face up.
        seat.shown.forEach((m, i) => {
          const d = this.disc(m);
          d.position.set(0.07 + i * DISC_R * 2.2, TOP + 0.012 + DISC_T / 2, STACK_Z);
          if (seat.struck && m === "shoal" && i === seat.shown.length - 1) {
            for (const mat of d.material as THREE.MeshLambertMaterial[]) mat.emissive = new THREE.Color("#a01818");
            d.material = (d.material as THREE.MeshLambertMaterial[]).map((mat) => mat.clone());
            d.position.y += 0.012;
          }
          r.items.add(d);
        });
      }
      if (mine && scene.hand) {
        // Your hand, face up along the near edge: a click on one lays it.
        const faces: Marker[] = [...Array<Marker>(scene.hand.channel).fill("channel"), ...Array<Marker>(scene.hand.shoal).fill("shoal")];
        faces.forEach((m, i) => {
          const d = this.disc(m);
          d.position.set((i - (faces.length - 1) / 2) * DISC_R * 2.6, TOP + 0.012 + DISC_T / 2, HAND_Z);
          if (scene.canLay) {
            d.userData.action = { type: "lay", marker: m } satisfies TableAction;
            d.userData.pulse = true;
            d.userData.baseY = d.position.y;
            d.scale.setScalar(1.18);
            this.clickables.push(d);
          }
          r.items.add(d);
        });
      }
    }
  }

  // ---------- turn the tide ----------

  private cardTex(face: TideFace): THREE.CanvasTexture {
    return this.tex(`tc:${face}`, () =>
      canvasTexture(TIDE_CARD_W * 4, TIDE_CARD_H * 4, (ctx) => {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tideCardCanvas(face), 0, 0, TIDE_CARD_W * 4, TIDE_CARD_H * 4);
      }),
    );
  }

  /** A card lying flat, its top toward the middle of the table: `face` up, the back underneath. `dim`: a card that is out of play. */
  private playingCard(face: TideFace, glow = 0.5): THREE.Mesh {
    const edge = lambert("#d8ccb0");
    const top = glowing(this.cardTex(face), glow);
    const under = glowing(this.cardTex("back"), 0.3);
    return new THREE.Mesh(this.cardGeo, [edge, edge, top, under, edge, edge]);
  }

  /** A point by a seat (the seat's own bearings: +z out toward them) as a point on the table, and back. */
  private toTable(r: Rig, p: THREE.Vector3): THREE.Vector3 {
    return p.clone().applyAxisAngle(UP, r.goal);
  }
  private toSeat(r: Rig, p: THREE.Vector3): THREE.Vector3 {
    return p.clone().applyAxisAngle(UP, -r.goal);
  }

  /** Send `o` on its way to where it lies now, after `delay` seconds. */
  private slide(o: THREE.Object3D, from: THREE.Vector3, opts: { delay?: number; dur?: number; lift?: number; flip?: boolean; hide?: boolean; spin?: number } = {}) {
    const sl: Slide = { t: -(opts.delay ?? 0), dur: opts.dur ?? PLAY_S, from: from.clone(), to: o.position.clone(), lift: opts.lift ?? 0.08, flip: !!opts.flip, hide: !!opts.hide, spin: opts.spin ?? 0 };
    o.userData.slide = sl;
    this.stepCard(o, 0);
  }

  /** Move a card along its way, and lift the one that won the hand. */
  private stepCard(o: THREE.Object3D, dt: number) {
    const sl = o.userData.slide as Slide | undefined;
    if (sl) {
      sl.t += dt;
      const k = smoother(Math.min(1, Math.max(0, sl.t / sl.dur)));
      o.visible = !(sl.hide && sl.t < 0);
      o.position.lerpVectors(sl.from, sl.to, k);
      o.position.y += Math.sin(k * Math.PI) * sl.lift;
      o.rotation.z = sl.flip ? (1 - k) * Math.PI : 0;
      if (sl.spin) o.rotation.y = k * sl.spin * Math.PI * 2;
      if (sl.t >= sl.dur) delete o.userData.slide;
    }
    const w = o.userData.win as { t: number; y: number; s: number } | undefined;
    if (w) {
      w.t += dt;
      if (w.t > 0) {
        const up = Math.min(1, w.t / 0.3);
        o.position.y = w.y + up * 0.04 + Math.sin(this.clock * 5) * 0.008 * up;
        o.scale.setScalar(w.s * (1 + 0.2 * up));
      }
    }
  }

  /** Put `o` on the table for `life` seconds, starting after `delay`; `tick` is told how far through it is, 0 to 1. */
  private addFx(o: THREE.Object3D, delay: number, life: number, tick: (k: number) => void) {
    o.userData.fx = { t: -delay, life, tick };
    o.visible = false;
    this.fx.add(o);
  }

  /** A line drawn across the table from `from` to `to`, and a ring round where it lands. */
  private aim(from: THREE.Vector3, to: THREE.Vector3, ink: string, delay: number) {
    const d = to.clone().sub(from);
    const len = Math.hypot(d.x, d.z);
    const mat = new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.9 });
    const line = new THREE.Mesh(this.lineGeo, mat);
    line.position.set(from.x, TOP + 0.03, from.z);
    line.rotation.y = Math.atan2(d.x, d.z);
    this.addFx(line, delay, 1.4, (k) => {
      line.scale.z = Math.max(0.001, len * Math.min(1, k / 0.22));
      mat.opacity = 0.9 * Math.min(1, (1 - k) / 0.3);
    });
    this.ring(to, ink, delay + 0.25, 1.2);
  }

  /** A ring pulsing on the cloth round `at`. */
  private ring(at: THREE.Vector3, ink: string, delay: number, life: number) {
    const mat = new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(this.ringGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, TOP + 0.028, at.z);
    this.addFx(ring, delay, life, (k) => {
      ring.scale.setScalar(1 + 0.2 * Math.sin(k * Math.PI * 4));
      mat.opacity = 0.9 * Math.min(1, (1 - k) / 0.3);
    });
  }

  /** A picture hung in the air over `at`, `up` above the table, facing whoever looks: it pops in, drifts up a little and fades. */
  private float(map: THREE.Texture, at: THREE.Vector3, up: number, height: number, delay: number, life: number) {
    const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.renderOrder = 10;
    s.layers.set(OVERLAY_LAYER);
    const aspect = (map.image as { width: number; height: number }).width / (map.image as { width: number; height: number }).height;
    this.addFx(s, delay, life, (k) => {
      const pop = Math.min(1, k / 0.12);
      s.scale.set(height * aspect * pop, height * pop, 1);
      s.position.set(at.x, TOP + up + k * 0.04, at.z);
      mat.opacity = Math.min(1, (1 - k) / 0.2);
    });
  }

  /** A word in the air over `at`. */
  private word(text: string, ink: string, at: THREE.Vector3, up: number, delay: number, life = 1.2) {
    this.float(this.own(chipTexture(text, ink)), at, up, 0.15, delay, life);
  }

  /**
   * Two cards brought up from `a` and `b` to meet over the table between them. On a tie they shake and go back;
   * otherwise the winner's card drives through, grown and lit gold, and the loser's is knocked back tumbling, red.
   * A card is face up only if this viewer may see it.
   */
  private clash(a: THREE.Vector3, b: THREE.Vector3, delay: number, how: { won: 0 | 1 | null; faces: [TideFace, TideFace] }) {
    const life = how.won === null ? CLASH_TIE_S : CLASH_S;
    [a, b].forEach((p, i) => {
      const face = how.faces[i];
      const c = this.playingCard(face, face === "back" ? 0.45 : 0.6);
      const top = (c.material as THREE.MeshLambertMaterial[])[2];
      const side = i ? 1 : -1;
      const mid = new THREE.Vector3((a.x + b.x) / 2 + side * 0.035, TOP + 0.16, (a.z + b.z) / 2);
      const start = new THREE.Vector3(p.x, TOP + 0.03, p.z);
      const other = i ? a : b;
      const wins = how.won === i;
      const loses = how.won !== null && !wins;
      // The winner drives on a little past the middle toward the other hand; the loser is thrown back over its own.
      const through = mid.clone().lerp(new THREE.Vector3(other.x, mid.y + 0.04, other.z), 0.18);
      const thrown = start.clone().lerp(mid, -0.25).setY(TOP + 0.03);
      c.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      this.addFx(c, delay, life, (k) => {
        const t = k * life;
        if (how.won === null || t < CLASH_HIT_S) {
          // Up to meet, a shake, and (on a tie) back again.
          const back = how.won === null ? smoother(Math.max(0, (t - 0.82) / 0.28)) : 0;
          const go = (t < 0.38 ? smoother(t / 0.38) : 1) * (1 - back);
          c.position.lerpVectors(start, mid, go);
          c.rotation.z = side * 0.6 * go + (t > 0.38 && t < 0.82 ? Math.sin(t * 73) * 0.1 : 0);
          return;
        }
        const u = t - CLASH_HIT_S;
        if (wins) {
          const push = smoother(Math.min(1, u / 0.25));
          const home = smoother(Math.max(0, (u - 0.75) / 0.3));
          c.position.lerpVectors(mid, through, push).lerp(start, home);
          c.rotation.z = side * 0.6 * (1 - push) * (1 - home);
          c.scale.setScalar(1 + 0.35 * push * (1 - home));
          top.emissive.set("#ffd23f");
          top.emissiveIntensity = 0.45 + (0.5 + 0.35 * Math.sin(u * 14)) * push * (1 - home);
        } else if (loses) {
          const fly = smoother(Math.min(1, u / 0.45));
          c.position.lerpVectors(mid, thrown, fly);
          c.position.y += Math.sin(fly * Math.PI) * 0.1;
          c.rotation.x = -side * fly * Math.PI * 2;
          c.rotation.z = side * 0.6 * (1 - fly);
          top.color.set("#f08a8a");
          top.emissive.set("#a01818");
          top.emissiveIntensity = 0.3 + 0.4 * fly;
        }
      });
    });
    if (how.won !== null) {
      const [win, lose] = how.won === 0 ? [a, b] : [b, a];
      this.ring(win, "#ffd23f", delay + CLASH_HIT_S, 1.3);
      this.word("wins", "#ffd23f", win, 0.32, delay + CLASH_HIT_S + 0.05, 1.3);
      this.word("out", "#f08a8a", lose, 0.26, delay + CLASH_HIT_S + 0.3, 1.1);
    }
  }

  /**
   * The Storm, over the middle of the table: a black cloud gathers, rain comes down on the cloth, lightning
   * strikes twice (the first with the storm's own thunder, the cloth lit white under it), and it blows over.
   */
  private storm(delay: number) {
    const LIFE = 2.8;
    const CLOUD_Y = TOP + 0.52;
    const g = new THREE.Group();
    const own = <T extends THREE.Mesh>(m: T): T => {
      m.userData.ownGeo = true;
      g.add(m);
      return m;
    };
    const puffs = [[-0.24, 0, 0.02, 0.13], [-0.1, 0.04, -0.05, 0.16], [0.06, 0.02, 0.05, 0.17], [0.22, 0, -0.02, 0.13], [0, -0.03, 0.1, 0.12], [-0.02, 0.07, 0, 0.13]].map(([x, dy, z, size], i) => {
      const m = own(new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), lambert(i % 2 ? "#4a4f5a" : "#33363e")));
      m.position.set(x, CLOUD_Y + dy, z);
      m.rotation.set(i, i * 1.7, 0);
      return m;
    });
    const rainMat = new THREE.MeshBasicMaterial({ color: "#9cc8f5", transparent: true, opacity: 0.8 });
    const drops = Array.from({ length: 22 }, (_, i) => {
      const m = own(new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.06, 0.005), rainMat));
      const a = i * 2.4;
      const d = 0.08 + ((i * 37) % 100) / 100 * 0.5;
      m.position.set(Math.cos(a) * d, 0, Math.sin(a) * d * 0.7);
      m.rotation.z = 0.18;
      m.userData.phase = ((i * 53) % 100) / 100;
      return m;
    });
    // A bolt: a crooked line of bright strokes from the cloud down to the cloth.
    const boltMat = new THREE.MeshBasicMaterial({ color: "#fff7c0" });
    const bolt = (x: number, z: number) => {
      const b = new THREE.Group();
      const pts = [0, 1, 2, 3, 4].map((i) => new THREE.Vector3(x + (i % 2 ? 0.06 : -0.03) * (i === 0 || i === 4 ? 0 : 1), CLOUD_Y - 0.05 - (i / 4) * (CLOUD_Y - 0.05 - TOP - 0.01), z + (i === 2 ? 0.04 : 0)));
      for (let i = 0; i < pts.length - 1; i++) {
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, pts[i].distanceTo(pts[i + 1])), boltMat);
        seg.userData.ownGeo = true;
        seg.position.copy(pts[i]).lerp(pts[i + 1], 0.5);
        seg.lookAt(pts[i + 1]);
        b.add(seg);
      }
      b.visible = false;
      g.add(b);
      return b;
    };
    const bolts = [bolt(-0.06, 0), bolt(0.12, 0.06)];
    const flashMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const flash = own(new THREE.Mesh(new THREE.CircleGeometry(TABLE_R - 0.07, 28), flashMat));
    flash.rotation.x = -Math.PI / 2;
    flash.position.y = TOP + 0.02;
    /** When each bolt strikes, as a share of the storm's life, and how long it is seen. */
    const STRIKES = [0.3, 0.55];
    const SEEN = 0.045;
    // The thunder is the storm's own, from the weather: it cracks with the first bolt.
    setTimeout(() => !this.disposed && sounds.thunder(() => undefined), (delay + STRIKES[0] * LIFE) * 1000);
    this.addFx(g, delay, LIFE, (k) => {
      // Gathering for the first fifth, blowing over for the last.
      const body = Math.min(1, k / 0.2) * Math.min(1, (1 - k) / 0.18);
      puffs.forEach((m, i) => {
        m.scale.setScalar(Math.max(0.001, smoother(body)));
        m.position.y = CLOUD_Y + Math.sin(this.clock * 2 + i) * 0.012;
        m.rotation.y += 0.01;
      });
      rainMat.opacity = 0.8 * Math.min(1, Math.max(0, (k - 0.12) / 0.1)) * Math.min(1, (1 - k) / 0.2);
      for (const d of drops) d.position.y = CLOUD_Y - 0.06 - ((k * LIFE * 1.9 + (d.userData.phase as number)) % 1) * (CLOUD_Y - 0.06 - TOP);
      let lit = 0;
      bolts.forEach((b, i) => {
        const since = k - STRIKES[i];
        // Each bolt flickers: on, off for a blink, on again.
        b.visible = since >= 0 && since < SEEN * 2.2 && !(since > SEEN && since < SEEN * 1.3);
        if (since >= 0) lit = Math.max(lit, Math.max(0, 1 - since / 0.12));
      });
      flashMat.opacity = 0.45 * lit;
    });
  }

  /**
   * The card table. Besides showing where everything lies, it acts out what changed since it was last told:
   * a deal, a draw, a card played and what it did, a Storm, a swap with the buried card, and the cards shown
   * at the end of a hand. Nothing is acted out for the state the table was in when you sat down.
   */
  syncTide(scene: TideScene | null): number {
    this.clickables = [];
    const prev = this.tidePrev;
    this.tidePrev = scene;
    const y = TOP + 0.008 + CARD_T / 2;
    const evKey = scene ? `${scene.hand}:${scene.playKey}:${scene.shown}:${!!scene.play?.swapped}` : "";
    // The table as you found it is not acted out, but the first deal at a table you were sitting at is.
    const event = this.tideTold && !!scene && evKey !== this.tideEv;
    this.tideTold = true;
    this.tideEv = evKey;
    if (scene) this.primed = true;
    const dealing = event && (!prev || scene!.hand !== prev.hand);
    /** The card just played, if that is what changed. */
    const play = event && !dealing && scene!.playKey !== prev!.playKey ? scene!.play : null;
    const swapped = event && !dealing && !play && !!scene!.play?.swapped && !prev!.play?.swapped;
    const showing = event && !dealing && scene!.shown && !prev!.shown;
    /** Seconds until what the card did has been acted out: what follows it (a draw, the cards shown) waits that long. */
    const clashed = !!play && play.card === 4 && !!play.target && !play.tie && !!play.out?.length;
    const after = play ? (play.moved ? 2.7 : clashed ? PLAY_S + 0.1 + CLASH_S : play.target ? 1.6 : 0.6) : swapped ? 0.7 : 0;
    /** Where a seat's cards lie, by that seat: its hand, and the row it plays to. */
    const handAt = (mine: boolean, n: number, i: number) => new THREE.Vector3((i - (n - 1) / 2) * (mine ? CARD_AX * 1.5 : CARD_AX * 0.75), y + i * 0.0015, mine ? HAND_Z - 0.03 : STACK_Z + 0.05);
    /** The same, as a point on the table: the middle of a seat's hand. */
    const handSpot = (id: string): THREE.Vector3 | null => {
      const r = this.rigs.get(id);
      const seat = scene?.seats.find((s) => s.id === id);
      return r && seat ? this.toTable(r, handAt(!!seat.pick, 1, 0)) : null;
    };
    const inHand = scene ? scene.seats.filter((s) => s.hand.length > 0).length : 0;

    // The middle: the deck, as tall as it is deep, the buried card beside it, and the tide token.
    const mid = scene ? `${scene.deck}|${scene.buried}|${scene.dealt}|${scene.tide}|${evKey}` : "";
    if (mid !== this.middleKey) {
      const turned = this.primed && !!scene && !!prev && prev.tide !== scene.tide;
      this.middleKey = mid;
      this.middle.clear();
      if (scene) {
        for (let i = 0; i < Math.ceil(scene.deck / 2); i++) {
          const c = this.playingCard("back", 0.3);
          c.position.set(DECK_AT.x, DECK_AT.y + i * CARD_T, DECK_AT.z);
          c.rotation.y = 0.12 + (i % 3) * 0.02;
          this.middle.add(c);
        }
        if (scene.dealt) {
          // Buried: lying crossways, face down unless it is yours to see.
          const b = this.playingCard(scene.buried ?? "back", scene.buried === null ? 0.3 : 0.6);
          b.position.copy(BURIED_AT);
          b.rotation.y = Math.PI / 2;
          this.middle.add(b);
          const by = swapped ? handSpot(scene.play!.by) : null;
          if (dealing) this.slide(b, DECK_AT, { hide: true });
          else if (by) this.slide(b, by, { dur: 0.6, lift: 0.12, flip: scene.buried !== null });
          // Turned up where it lies: for the Smuggler's player as they look, and for everyone once the hand is over.
          else if (event && prev?.buried === null && scene.buried !== null) this.slide(b, BURIED_AT, { delay: showing ? after + 0.3 * inHand + 0.2 : PLAY_S + 0.2, lift: 0.07, flip: true });
        }
        const face = glowing(this.tex(`tt:${scene.tide}`, () => canvasTexture(TIDE_TOKEN_PX * 4, TIDE_TOKEN_PX * 4, (ctx) => {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tideTokenCanvas(scene.tide), 0, 0, TIDE_TOKEN_PX * 4, TIDE_TOKEN_PX * 4);
        })), 0.6);
        const token = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 24), [lambert(scene.tide === "high" ? "#3f7fd0" : "#b8913f"), face, lambert("#6b4a2b")]);
        token.position.copy(TOKEN_AT);
        // A cylinder's cap has its picture's top toward -x: turn it to face your seat.
        token.rotation.y = -Math.PI / 2;
        if (turned) token.userData.flip = 0;
        this.middle.add(token);
      }
      if (turned) sounds.table("reveal");
    }

    // What the card did, drawn over the table for a moment.
    if (play && scene) {
      sounds.table("hold");
      const by = this.rigs.get(play.by);
      const from = by ? this.toTable(by, new THREE.Vector3(0, y, STACK_Z - 0.13)) : null;
      const to = play.target ? handSpot(play.target) : null;
      const middle = new THREE.Vector3(0, 0, 0.05);
      if (from && to) {
        this.aim(from, to, AIM_INK[play.card] ?? "#ffd23f", PLAY_S * 0.8);
        if (play.guess) {
          // A Gull: the card it called, held up over whoever it was called on, and whether that was right.
          this.float(this.cardTex(play.guess), to, 0.2, 0.2, PLAY_S + 0.2, 1.7);
          this.word(play.hit ? "right!" : "wrong", play.hit ? "#ffd23f" : "#f08a8a", to, 0.43, PLAY_S + 0.7, 1.2);
        } else if (play.card === 3) {
          this.word("looks", AIM_INK[3], to, 0.2, PLAY_S + 0.3, 1.1);
        } else if (play.card === 4) {
          const mine = handSpot(play.by);
          // Whoever is out shows their card (it is turned up anyway); the one left standing keeps theirs hidden, unless it is yours or you know it.
          const lost = play.out?.[0];
          const faceOf = (id: string): TideFace => {
            const s = scene.seats.find((x) => x.id === id);
            return (id === lost ? s?.played.at(-1) : s?.hand[0]) ?? "back";
          };
          const won = play.tie || !lost ? null : lost === play.target ? 0 : 1;
          if (mine) this.clash(mine, to, PLAY_S + 0.1, { won, faces: [faceOf(play.by), faceOf(play.target!)] });
          this.word(play.tie ? "matched" : "clash!", play.tie ? "#7db6f2" : AIM_INK[4], new THREE.Vector3((from.x + to.x) / 2, 0, (from.z + to.z) / 2), 0.34, PLAY_S + 0.4, 0.8);
        }
      }
      if (play.wasted && from) this.word("all at anchor", "#a8a3c4", from, 0.2, PLAY_S, 1.3);
      if (play.tide) this.word(`${play.tide} tide`, play.tide === "high" ? "#a9d4fb" : "#e6c877", TOKEN_AT, 0.3, 0.3, 1.4);
      if (play.card === 6) {
        const at = handSpot(play.by);
        if (at) this.ring(at, "#7db6f2", PLAY_S, 1.4);
      }
      if (play.card === 7) this.storm(PLAY_S * 0.5);
      if (play.card === 7 && !play.moved) this.word("nothing to blow about", "#a8a3c4", middle, 0.3, PLAY_S + 0.6, 1.4);
      if (play.card === 8 && scene.buried === null) {
        this.ring(BURIED_AT, "#ffd23f", PLAY_S, 1.2);
        this.word("looks", "#ffd23f", BURIED_AT, 0.2, PLAY_S + 0.1, 1.1);
      }
    }
    if (swapped) this.word("swapped", "#ffd23f", BURIED_AT, 0.24, 0.5, 1.2);
    if (showing) sounds.table("reveal", { delay: after });
    if (dealing) sounds.table("hold", { delay: 0.25 });

    let shownIx = 0;
    for (const r of this.rigs.values()) {
      const at = scene ? scene.seats.findIndex((s) => s.id === r.id) : -1;
      const seat = at >= 0 ? scene!.seats[at] : undefined;
      const key = seat ? `${seat.hand.join(",")}|${seat.known}|${seat.played.join(",")}|${seat.pick?.can}|${seat.pick?.index}|${evKey}` : "";
      if (key === r.itemsKey) {
        r.items.traverse((o) => o.userData.action && this.clickables.push(o));
        continue;
      }
      r.itemsKey = key;
      r.items.clear();
      if (!seat || !scene) continue;
      const was = event ? prev?.seats.find((s) => s.id === r.id) : undefined;
      const mine = !!seat.pick;
      const handMid = handAt(mine, 1, 0);
      // What they have played, face up in a row toward the middle, each lapping the last.
      const lap = Math.min(CARD_AX * 0.62, 0.42 / Math.max(1, seat.played.length));
      seat.played.forEach((rank, i) => {
        const c = this.playingCard(rank);
        c.position.set((i - (seat.played.length - 1) / 2) * lap, y + i * 0.0015, STACK_Z - 0.13);
        r.items.add(c);
        if (!was || dealing || i < was.played.length) return;
        // The card they played goes down first; a card after it is the one they were holding when they were put out, turned up once that has been acted out.
        const played = !!play && play.by === r.id && i === was.played.length;
        if (played) this.slide(c, new THREE.Vector3(handMid.x, y + 0.02, handMid.z), { flip: true });
        else this.slide(c, handMid, { delay: play ? (clashed ? PLAY_S + 0.1 + CLASH_HIT_S + 0.45 : PLAY_S + (play.target ? 1.0 : 0.2)) : 0, dur: 0.5, lift: 0.1, flip: true, hide: false });
      });
      // Their hand: face down in front of them, or face up if you may see it. Your own lies nearer you, larger, and can be clicked.
      seat.hand.forEach((face, i) => {
        const c = this.playingCard(face, face === "back" ? 0.3 : seat.known ? 0.35 : 0.55);
        c.position.copy(handAt(mine, seat.hand.length, i));
        const picked = mine && seat.pick!.index === i;
        if (mine) {
          c.scale.setScalar(1.25);
          if (picked) c.position.z -= 0.05;
          if (seat.pick!.can) {
            c.userData.action = { type: "card", index: i } satisfies TableAction;
            if (!picked) c.userData.baseY = c.position.y;
            this.clickables.push(c);
          }
          if (picked) c.position.y += 0.03;
        }
        r.items.add(c);
        if (!event) return;
        const up = face !== "back";
        const drawn = !!was && seat.hand.length > was.hand.length && i === seat.hand.length - 1;
        const moved = play?.moved;
        if (dealing) {
          // Off the deck, round the table a seat at a time; whoever leads then draws.
          this.slide(c, this.toSeat(r, DECK_AT), { delay: 0.25 + at * 0.16 + (i > 0 ? 0.5 + scene.seats.length * 0.16 : 0), dur: 0.5, lift: 0.14, flip: up, hide: true });
        } else if (moved?.includes(r.id) && i === 0) {
          // A Storm: the card comes round from the player before.
          const giver = handSpot(moved[(moved.indexOf(r.id) + moved.length - 1) % moved.length]);
          // It is caught up as the first bolt strikes, and comes down spinning in front of whoever is next round the table.
          if (giver) this.slide(c, this.toSeat(r, giver), { delay: 1.15, dur: 1.2, lift: 0.3, flip: up, spin: 2 });
        } else if (swapped && scene.play!.by === r.id && i === 0) {
          this.slide(c, this.toSeat(r, BURIED_AT), { dur: 0.6, lift: 0.12, flip: up });
        } else if (drawn) {
          this.slide(c, this.toSeat(r, DECK_AT), { delay: after + 0.1, dur: 0.5, lift: 0.14, flip: up, hide: true });
        } else if (up && was?.hand[i] === "back") {
          // Turned up where it lies: a card you have been shown, or everyone's as the hand ends, one seat after another.
          this.slide(c, c.position, { delay: showing ? after + 0.3 * shownIx : PLAY_S + 0.5, lift: 0.07, flip: true });
        }
        if (showing && scene.winners.includes(r.id)) c.userData.win = { t: -(after + 0.3 * inHand + 0.35), y: c.position.y, s: c.scale.x };
      });
      if (showing && seat.hand.length > 0) shownIx++;
    }
    // Seconds until your own cards have come to rest: your hand in the dock is not shown before then.
    let wait = 0;
    const mine = scene?.seats.find((s) => s.pick);
    this.rigs.get(mine?.id ?? "")?.items.traverse((o) => {
      const sl = o.userData.slide as Slide | undefined;
      if (sl) wait = Math.max(wait, sl.dur - sl.t);
    });
    return wait;
  }

  // ---------- input ----------

  press(ndc: THREE.Vector2, camera: THREE.Camera) {
    if (this.leaving) return;
    this.raycaster.setFromCamera(ndc, camera);
    const hit = this.raycaster.intersectObjects(this.clickables, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.action) o = o.parent;
    if (o) this.cb.pick(o.userData.action as TableAction);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key !== "Escape") return false;
    this.cb.stand();
    return true;
  }

  /**
   * The room keeps drawing your hero while they walk up and its own table goes; once that is gone they are
   * the table's to draw, stepping back as it comes in and then up onto their stool.
   */
  ownHero(): boolean {
    return this.swap < 0.5;
  }

  /** How much of the room's table is left, and how much of this one is in, each 0 to 1. */
  private oldShare(): number {
    return 1 - smoother(Math.min(1, this.swap * 2));
  }
  private newShare(): number {
    return smoother(Math.max(0, this.swap * 2 - 1));
  }

  /** Size the two tables by how far the swap has gone. */
  private showSwap() {
    const gone = this.oldShare();
    if (this.old) {
      this.old.visible = gone > 0.001;
      this.old.scale.setScalar(Math.max(0.001, gone));
    }
    const here = this.newShare();
    for (const g of [this.furniture, this.stools]) {
      g.visible = here > 0.001;
      g.scale.setScalar(Math.max(0.001, here));
    }
    this.pot.visible = this.swap >= 1;
  }

  // ---------- each frame ----------

  /** The head of this player's seat, for their chat bubble. Not yours: you look out of it. */
  bubbleAnchor(unitId: string): THREE.Vector3 | null {
    const r = this.rigs.get(unitId);
    if (!r || r.mine) return null;
    return r.folk.localToWorld(new THREE.Vector3(0, STOOL_H + FOLK_H - 0.1, 0));
  }

  frame(dt: number, now: number, aspect: number): { eye: THREE.Vector3; look: THREE.Vector3; blend: number; fov: number } {
    void now;
    this.clock += dt;
    // The camera waits for you to walk up to the table, and comes down as you take your seat.
    if (!this.arrived && this.world.heroSettled()) this.arrived = true;
    // Sitting down: you walk up, the tables swap, you take your stool, and the camera comes down as you do.
    // Getting up runs it backwards as the camera goes: off the stool, then the tables swap back.
    if (this.leaving) this.swap = Math.min(this.swap, this.inT / 0.3);
    else if (this.arrived) this.swap = Math.min(1, this.swap + dt / SWAP_S);
    this.showSwap();
    this.inT = this.leaving ? Math.max(0, this.inT - dt / OUT_S) : this.swap >= 1 ? Math.min(1, this.inT + dt / IN_S) : 0;
    if (this.leaving && this.inT <= 0) setTimeout(() => this.finish(), 0);
    this.animate(dt);
    this.card.position.y = CARD_Y + Math.sin(this.clock * 1.6) * 0.012;
    const base = this.group.position;
    const sway = Math.sin(this.clock * 0.9) * 0.006;
    // A tall window (a phone) sees little across: back the eye off and open the lens until the stools at either side are in.
    const back = THREE.MathUtils.clamp(0.8 / aspect, 1, 1.3);
    const eye = new THREE.Vector3(base.x, base.y + 1.75 * back + sway, base.z + (SEAT_R + 1.0) * back);
    const look = new THREE.Vector3(base.x, base.y + TOP + 0.08, base.z - 0.05);
    const fov = Math.max(VFOV, Math.min(72, (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(26)) / aspect) * 180) / Math.PI));
    return { eye, look, blend: smoother(this.inT), fov };
  }

  private animate(dt: number) {
    const ease = 1 - Math.exp(-dt * 7);
    for (const r of this.rigs.values()) {
      // Turn to a new place round the table the short way.
      let d = r.goal - r.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      r.yaw += d * ease;
      r.rig.rotation.y = r.yaw;
      // You watch yourself sit down as the camera drops in; from your seat, your own head would be in the way.
      // Until you have walked up, the room is still drawing you; then you get onto the stool, and off it to leave.
      // Leaving, they are still sat as the camera backs out far enough to show them, and get up before the tables swap back.
      if (r.mine) r.sit = this.leaving ? Math.min(r.sit, Math.max(0, (this.inT - 0.3) / 0.2)) : this.swap >= 1 ? Math.min(1, r.sit + dt / SIT_S) : 0;
      if (r.mine && r.sit >= 1) this.sat = true;
      // The camera comes down through you to your own eyes: you thin away as it nears instead of blinking out.
      r.folk.visible = this.swap >= (r.mine ? 0.5 : 1);
      if (r.mine) r.figure?.setFade(1 - (smoother(this.inT) - FADE_FROM) / (FADE_TO - FADE_FROM));
      r.plate.visible = !r.mine;
      // Your own chip would hang right in front of your eyes, huge; the card says when it is your turn.
      r.chip.visible = !r.mine && !!r.info?.chip;
      // Your own tally sits right under the camera and fills the screen over the table; it is in the dock instead.
      r.tally.visible = !r.mine && !!(r.info?.pips || r.info?.stars);
      r.items.visible = this.swap >= 1;
      const info = r.info;
      const glow = info && (info.turn || info.won) ? 0.55 + 0.35 * Math.sin(this.clock * 4) : 0;
      (r.ring.material as THREE.MeshBasicMaterial).opacity = glow;
      // The one who won bounces a little.
      // Getting on: from where the room had them standing, back a step as the table comes in, then from their
      // feet in front of the stool a small hop up and back onto it.
      const on = smoother(r.sit);
      const stand = r.mine ? STOOD_AT + (STEP_IN - STOOD_AT) * this.newShare() : STEP_IN;
      r.seat.position.set(0, SEAT_Y * on + Math.sin(r.sit * Math.PI) * 0.1 + (info?.won ? Math.abs(Math.sin(this.clock * 5)) * 0.06 : 0), -stand * (1 - on));
      r.figure?.update({ time: this.clock, stride: 0, walking: false, lean: 0, lying: false, sitting: r.sit });
      if (r.sink) this.animateSink(r, dt);
      else if (r.redeal !== null && (r.redeal -= dt) <= 0) {
        // The Kraken has gone and a new round is on: this seat's dice come back, out of the air.
        r.redeal = null;
        r.sunkHand = null;
        r.dropIn = true;
        this.syncCrew(this.crewScene);
        r.dropIn = false;
      }
      for (const wrap of r.items.children) {
        this.stepCard(wrap, dt);
        const th = wrap.userData.throw as Throw | undefined;
        if (!th) continue;
        th.t += dt;
        const k = clamp01((th.t - th.delay - (th.hang ?? 0)) / THROW_S);
        // Still in the cup until its moment comes.
        wrap.visible = th.t >= th.delay;
        // Dealt out of the air: it swells into being where it hangs.
        if (th.hang) wrap.scale.setScalar(Math.max(0.001, popOut(clamp01((th.t - th.delay) / th.hang))));
        // Out over the felt, slowing as it goes; down onto the cloth, then smaller and smaller bounces.
        const go = 1 - (1 - k) ** 3;
        wrap.position.x = th.from.x + (th.to.x - th.from.x) * go;
        wrap.position.z = th.from.z + (th.to.z - th.from.z) * go;
        wrap.position.y = th.to.y + throwHeight(k, th.from.y - th.to.y);
        // Tumbling the whole way, the turn running out just as it stops on the face it rolled.
        wrap.quaternion.setFromAxisAngle(th.axis, (1 - k) ** 2 * th.turns * Math.PI * 2);
        if (k >= 1) {
          wrap.position.copy(th.to);
          wrap.quaternion.identity();
          wrap.scale.setScalar(1);
          wrap.visible = true;
          delete wrap.userData.throw;
        }
      }
    }
    for (const o of [...this.fx.children]) {
      const f = o.userData.fx as { t: number; life: number; tick(k: number): void };
      f.t += dt;
      if (f.t < 0) continue;
      if (f.t >= f.life) {
        this.fx.remove(o);
        o.traverse((c) => {
          const mesh = c as THREE.Mesh;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m?.dispose();
          if (c.userData.ownGeo) mesh.geometry?.dispose();
        });
        continue;
      }
      o.visible = true;
      f.tick(f.t / f.life);
    }
    for (const o of this.middle.children) {
      this.stepCard(o, dt);
      // The tide token, turned: it spins up off the cloth and comes down on its new face.
      const f = o.userData.flip as number | undefined;
      if (f === undefined) continue;
      const k = Math.min(1, f + dt / 0.7);
      o.userData.flip = k;
      o.rotation.z = (1 - smoother(k)) * Math.PI * 3;
      o.position.y = TOP + 0.018 + Math.sin(k * Math.PI) * 0.14;
      if (k >= 1) delete o.userData.flip;
    }
    for (const o of this.clickables) {
      // A die still in the air is the throw's to move, and a card on its way the slide's.
      if (o.userData.throw || o.userData.slide) continue;
      const base = o.userData.baseY as number | undefined;
      if (base !== undefined) o.position.y = base + (0.5 + 0.5 * Math.sin(this.clock * 5)) * 0.018;
    }
  }

  /** Get up: the camera rises back out to the room, then the scene is taken down. */
  leave() {
    this.leaving = true;
  }

  private finish() {
    if (this.disposed) return;
    this.dispose();
    // Only if the view is still ours: another game may have taken it over meanwhile.
    if (this.world.playing === this) this.world.endMinigame();
    this.cb.left();
  }

  private disposeRig(r: Rig) {
    r.sink?.dispose();
    r.figure?.dispose();
    for (const s of [r.plate, r.chip, r.tally]) s.material.dispose();
    r.ring.geometry.dispose();
    (r.ring.material as THREE.Material).dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // The room's table back as it was.
    if (this.old) {
      this.old.visible = true;
      this.old.scale.setScalar(1);
    }
    this.world.setSharp(false);
    for (const r of this.rigs.values()) this.disposeRig(r);
    this.discGeo.dispose();
    this.cardGeo.dispose();
    this.lineGeo.dispose();
    this.ringGeo.dispose();
    for (const m of [...(this.crewDice?.shown ?? []), ...(this.crewDice?.lit ?? [])]) m.dispose();
    for (const mats of [this.dieMats, this.dieBack, this.dieLit]) for (const m of mats ?? []) m.dispose();
    for (const t of this.textures) t.dispose();
    this.card.material.map?.dispose();
    this.card.material.dispose();
  }
}
