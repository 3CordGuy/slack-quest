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
import type { Marker, Outfit } from "@gantt-quest/world";
import { markerUrl, type MarkerFace } from "../shoalsArt";
import { isCrewFace, paintCrewFace } from "../crewArt";
import { makeModelShip } from "./modelShip";
import { PIXEL_CAP_ROWS, PIXEL_LINE_ROWS, canDrawPixelText, drawPixelText, pixelTextWidth } from "./pixelFont";
import { SITTING_DROP, makeFigure, type Figure } from "./figures";
import { labelTexture, lookFor, spriteKey } from "./sprites";
import { OVERLAY_LAYER } from "./post";
import type { WorldMinigame, WorldRenderer } from "./WorldRenderer";

export type TableKind = "dice" | "shoals" | "crew";

/** Something clicked in the scene. */
export type TableAction = { type: "lay"; marker: Marker } | { type: "flip"; seat: string };

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
  /** Each seat's dice: ship, captain and crew held (drawn as pictures), and the rest as plain dice. */
  seats: { id: string; held: number[]; free: number[] }[];
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
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
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
      ctx.fillStyle = "#c99a3a";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = IVORY;
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

const CHIP_COLOR: Record<string, string> = { winner: "#ffd23f", helm: "#ffd23f", "to play": "#ffd23f", out: "#f08a8a", left: "#f08a8a", passed: "#a8a3c4", opened: "#a9d4fb" };

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
  /** Seconds left of a roll or a settle, for dice. */
  roll: number;
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
  /** A held ship, captain or crew: its picture on every face, so it reads the right way up from the seat whichever face is seen. */
  private dieIcons = new Map<number, THREE.Material[]>();
  private lastRoll = "";
  private discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_T, 20);

  constructor(private world: WorldRenderer, private group: THREE.Group, private kind: TableKind, private cb: TableCallbacks) {
    // Dice and markers are read up close: draw them at full resolution, not the chunky half.
    world.setSharp(true);
    this.buildTable();
    this.group.add(this.furniture, this.stools, this.pot);
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
    const cloth = lambert(this.kind === "shoals" ? "#2f6f8c" : this.kind === "crew" ? "#6b2f35" : "#2f6b4a");
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
    return { id, rig, folk, mine: false, sit: 1, seat, figure: null, plate, chip, tally, ring, items, yaw: 0, goal: 0, look: "", plateKey: "", chipKey: "", tallyKey: "", info: null, itemsKey: "", roll: 0 };
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
    const plateKey = firstName(info.name);
    if (r.plateKey !== plateKey) {
      r.plateKey = plateKey;
      const { texture, aspect } = labelTexture(plateKey);
      this.own(texture);
      r.plate.material.map = texture;
      r.plate.material.needsUpdate = true;
      r.plate.scale.set(0.17 * aspect, 0.17, 1);
      r.plate.center.set(0.5, 0);
    }
    const chipKey = info.chip ?? "";
    if (r.chipKey !== chipKey) {
      r.chipKey = chipKey;
      if (info.chip) {
        const t = this.own(chipTexture(info.chip, CHIP_COLOR[info.chip.split(" ")[0]] ?? "#a9d4fb"));
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
      const [px, pz] = this.kind === "crew" ? [0.24, -0.16] : [0, -0.34];
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

  private iconMaterials(v: number): THREE.Material[] {
    let mats = this.dieIcons.get(v);
    if (!mats) {
      const m = glowing(this.tex(`die:${v}:icon`, () => dieFace(v, false, true)), 0.55);
      mats = Array<THREE.Material>(6).fill(m);
      this.dieIcons.set(v, mats);
    }
    return mats;
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

  syncDice(scene: DiceScene | null) {
    const mats = this.dieMaterials();
    const rolled = !!scene && scene.round !== this.lastRound;
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
        wrap.userData.baseY = wrap.position.y;
        r.items.add(wrap);
      }
      if (rolled) r.roll = 0.7;
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
    const rolled = !!scene && scene.rollKey !== this.lastRoll;
    if (scene) this.lastRoll = scene.rollKey;
    this.clickables = [];
    const size = DIE * 0.85;
    const geo = new THREE.BoxGeometry(size, size, size);
    const big = DIE * 1.15;
    const heldGeo = new THREE.BoxGeometry(big, big, big);
    for (const r of this.rigs.values()) {
      const seat = scene?.seats.find((s) => s.id === r.id);
      const key = seat ? `${seat.held.join("")}|${seat.free.join("")}` : "";
      const tumble = rolled && scene?.rolled === r.id;
      if (key === r.itemsKey && !tumble) continue;
      r.itemsKey = key;
      r.items.clear();
      if (!seat) continue;
      const row = (values: number[], z: number, icon: boolean, spin: boolean) =>
        values.forEach((v, i) => {
          const s = icon ? big : size;
          const wrap = new THREE.Group();
          wrap.position.set((i - (values.length - 1) / 2) * s * 1.35, TOP + s / 2 + 0.01, z);
          // Held pictures sit square to the seat, so they read the right way up from it; loose dice lie as they fell.
          const die = new THREE.Mesh(icon ? heldGeo : geo, icon ? this.iconMaterials(v) : v === 0 ? mats.back : mats.shown);
          if (!icon) {
            if (v > 0) die.quaternion.setFromUnitVectors(FACE_NORMAL[v], UP);
            die.rotateOnWorldAxis(UP, 0.5 + i * 1.7 + v);
          }
          wrap.add(die);
          // Only the dice that were rolled tumble.
          if (spin) wrap.userData.baseY = wrap.position.y;
          r.items.add(wrap);
        });
      row(seat.held, STACK_Z - 0.1, true, false);
      row(seat.free, STACK_Z + 0.06, false, true);
      if (tumble) r.roll = 0.7;
    }
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
      if (r.roll > 0) r.roll = Math.max(0, r.roll - dt);
      for (const wrap of r.items.children) {
        if (wrap.userData.baseY === undefined || wrap.userData.pulse) continue;
        // A roll: spin and hop, settling.
        const k = r.roll / 0.7;
        wrap.rotation.y = k * k * 9;
        wrap.position.y = wrap.userData.baseY + Math.abs(Math.sin(k * 7)) * k * 0.12;
      }
    }
    for (const o of this.clickables) {
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
    for (const [m] of this.dieIcons.values()) m.dispose();
    for (const mats of [this.dieMats, this.dieBack, this.dieLit]) for (const m of mats ?? []) m.dispose();
    for (const t of this.textures) t.dispose();
    this.card.material.map?.dispose();
    this.card.material.dispose();
  }
}
