// The living parts of the map: a slow day and night with a moving sun and
// shadows, varied rocks on the hills, low-poly grass (tufts, meadows of
// thick grass, tall grass that parts as you wade through it, and dry patches of
// dead grass and burnt ground) leaning in the wind, and two flat, pixel-art touches that move — wave crests on the water
// and wisps drifting through the air.
//
// Everything here is decoration. Nothing reads or changes game state, and the
// time of day comes from the wall clock, so everyone in a crew sees the same
// sky.

import * as THREE from "three";
import { devTools } from "../devTools";
import { fancy } from "./fancy";
import { WIND_DIR, addFieldSway, gustAt, setFieldCalm, windPower } from "./wind";
import type { Tile } from "@gantt-quest/world";
import type { LightKind } from "./props";
import type { LampLight } from "./tableLamps";

/** One full day, in milliseconds. */
const DAY_MS = 10 * 60 * 1000;
/** Half-width of the area around the camera target that gets shadows. */
const SHADOW_REACH = 24;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (a: number, b: number, salt: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

export function pixelTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A smooth colour ramp, top to bottom or (radial) from the middle out: for additive glows, which fade to black. */
function ramp(stops: [number, string][], w: number, h: number, radial: boolean): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const grad = radial ? ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2) : ctx.createLinearGradient(0, 0, 0, h);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fill single pixels from rows of text: any non-space character is a pixel, and letters pick the colour. */
export function stamp(ctx: CanvasRenderingContext2D, rows: string[], colors: Record<string, string>) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === " ") return;
      ctx.fillStyle = colors[ch] ?? "#ffffff";
      ctx.fillRect(x, y, 1, 1);
    });
  });
}

/** The radius a hex is drawn at: its full place in the grid, so its rim meets its neighbours' with no gap to see the sea through. */
export const TILE_RADIUS = 1;
/**
 * The radius of the rounding where a hex's top turns down into its wall. Two neighbours on a level round down
 * into each other and meet at the foot of the curve, which is the soft groove between tiles.
 */
export const TILE_FILLET = 0.09;
/** How many flat strips the rounding is made of. Their normals turn smoothly, so it is lit as a curve. */
const FILLET_STEPS = 5;

/**
 * The top of one hex, centred on the origin with its flat at y = 0 and a point toward +z: the flat itself and,
 * round its rim, a quarter-round fillet turning down to the vertical at `TILE_RADIUS`, `TILE_FILLET` below.
 * So where two hexes meet the light rolls off one and onto the next instead of snapping at a hard corner.
 * Calls `vertex` three times a triangle with a point and its normal.
 */
export function hexTop(vertex: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void) {
  const inner = TILE_RADIUS - TILE_FILLET;
  const corner = (i: number) => [Math.sin((i * Math.PI) / 3), Math.cos((i * Math.PI) / 3)];
  for (let i = 0; i < 6; i++) {
    const [ax, az] = corner(i);
    const [bx, bz] = corner(i + 1);
    vertex(0, 0, 0, 0, 1, 0);
    vertex(ax * inner, 0, az * inner, 0, 1, 0);
    vertex(bx * inner, 0, bz * inner, 0, 1, 0);
    // This side's own way out: the fillet rolls toward it, and keeps a crisp crease at the hex's corners.
    const ox = Math.sin(((i + 0.5) * Math.PI) / 3);
    const oz = Math.cos(((i + 0.5) * Math.PI) / 3);
    for (let k = 0; k < FILLET_STEPS; k++) {
      const ring = (step: number, x: number, z: number) => {
        const a = (step / FILLET_STEPS) * (Math.PI / 2);
        const r = inner + TILE_FILLET * Math.sin(a);
        vertex(x * r, -TILE_FILLET * (1 - Math.cos(a)), z * r, ox * Math.sin(a), Math.cos(a), oz * Math.sin(a));
      };
      ring(k, ax, az);
      ring(k + 1, ax, az);
      ring(k + 1, bx, bz);
      ring(k, ax, az);
      ring(k + 1, bx, bz);
      ring(k, bx, bz);
    }
  }
}

/** How many shapes of grass tuft there are; each tuft is one of them, turned its own way. */
const GRASS_KINDS = 3;

/** Grass colours, root to tip, shared by the tufts and the meadows. */
const GRASS_ROOT = new THREE.Color("#4a8a3a");
const GRASS_MID = new THREE.Color("#79bd50");
const GRASS_TIP = new THREE.Color("#c8ef86");
/** A dry tip, for the odd blade in a meadow gone to seed. */
const GRASS_STRAW = new THREE.Color("#dfe08c");
type Tones = readonly [THREE.Color, THREE.Color, THREE.Color];
const GREEN: Tones = [GRASS_ROOT, GRASS_MID, GRASS_TIP];
const SEEDING: Tones = [GRASS_ROOT, GRASS_MID, GRASS_STRAW];
/** Dead grass, root to tip: straw gone pale at the ends. */
const DEAD: Tones = [new THREE.Color("#8f8448"), new THREE.Color("#c6af60"), new THREE.Color("#eedd9a")];
/** Grass not quite dead yet: a tired olive. */
const FADING: Tones = [new THREE.Color("#5f7a3a"), new THREE.Color("#93a352"), new THREE.Color("#cfd48a")];
/** Grass on dry ground, burnt brown. */
const BURNT: Tones = [new THREE.Color("#7a6a40"), new THREE.Color("#a88f58"), new THREE.Color("#d2bd8c")];

/** The arrays a clump of blades is built into. */
interface Blades {
  pos: number[];
  nor: number[];
  col: number[];
  /** Where on the ground (x, z) the blade each vertex belongs to is rooted: the fields' shader moves a whole blade by where its root is. */
  root: number[];
}

/**
 * One blade of grass: a strip of three triangles from (rx, rz) on the ground, `h` tall and `w` across at the
 * root, narrowing to a point and curling out toward (ox, oz) by `lean` of its height, the more the higher.
 * Both faces of each triangle are written, wound either way, so either side is lit from above alike (a
 * double-sided material would turn the back faces' normals downward and leave them black). Its normals point
 * up, tipped the way it leans, so it is lit like the ground it grows from rather than going dark side-on.
 */
function pushBlade(out: Blades, rx: number, rz: number, ox: number, oz: number, across: number, h: number, w: number, lean: number, shade: number, tones: Tones = GREEN) {
  const [root, mid, tip] = tones;
  const sx = Math.sin(across), sz = Math.cos(across);
  const at = (f: number, half: number, side: number) => {
    const reach = lean * h * f * f;
    return [rx + ox * reach + sx * half * side, h * f, rz + oz * reach + sz * half * side];
  };
  const bl = at(0, w, -1), br = at(0, w, 1), ml = at(0.5, w * 0.7, -1), mr = at(0.5, w * 0.7, 1), tp = at(1, 0, 0);
  const n = new THREE.Vector3(ox * 0.35, 1, oz * 0.35).normalize();
  const c = new THREE.Color();
  const strip: [number[], THREE.Color][][] = [
    [[bl, root], [br, root], [mr, mid]],
    [[bl, root], [mr, mid], [ml, mid]],
    [[ml, mid], [mr, mid], [tp, tip]],
  ];
  for (const tri of strip)
    for (const [v, tone] of [...tri, ...[...tri].reverse()]) {
      out.pos.push(v[0], v[1], v[2]);
      out.nor.push(n.x, n.y, n.z);
      c.copy(tone).multiplyScalar(shade);
      out.col.push(c.r, c.g, c.b);
      out.root.push(rx, rz);
    }
}

function bladesGeometry(out: Blades): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(out.nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(out.col, 3));
  geo.setAttribute("aRoot", new THREE.Float32BufferAttribute(out.root, 2));
  return geo;
}

/** A tuft of grass, low-poly: a clump of blades rooted near the middle that curl outward. About 1 tall, on y = 0. */
function tuftGeometry(kind: number): THREE.BufferGeometry {
  const r = (i: number) => hash(kind, i, 977);
  const blades = 5 + kind * 2;
  const out: Blades = { pos: [], nor: [], col: [], root: [] };
  for (let b = 0; b < blades; b++) {
    const k = b * 8;
    const a = (b / blades) * Math.PI * 2 + (r(k) - 0.5) * 0.9;
    const ox = Math.sin(a), oz = Math.cos(a);
    const d = 0.03 + r(k + 2) * 0.09;
    // Across the blade: square to the way it leans, give or take a twist.
    pushBlade(out, ox * d, oz * d, ox, oz, a + Math.PI / 2 + (r(k + 1) - 0.5) * 0.9, 0.55 + r(k + 3) * 0.45, 0.07 + r(k + 5) * 0.04, 0.2 + r(k + 4) * 0.35, 0.88 + r(k + 6) * 0.24);
  }
  return bladesGeometry(out);
}

/** How many different meadow patches there are; each meadow hex is one of them, turned by sixths. */
const MEADOW_KINDS = 2;
/** Blades in one meadow hex. */
const MEADOW_BLADES = 130;
/** The tallest a meadow's blades stand, world units: short enough that a hero's feet still show. */
const MEADOW_H = 0.36;

/**
 * A whole hex of grass, as one piece: blades scattered evenly over a pointy-topped hex of radius 1 (a little
 * inside it, so a lone meadow does not spill far onto its neighbours), each leaning its own way, a few of them
 * dry at the tip. A hex turned by a sixth still fits its hex, so each patch can be laid six ways.
 */
function meadowGeometry(kind: number): THREE.BufferGeometry {
  const r = (i: number) => hash(kind + 11, i, 431);
  const out: Blades = { pos: [], nor: [], col: [], root: [] };
  const inside = (x: number, z: number) => Math.abs(x) <= 0.866 && Math.abs(z) + Math.abs(x) * 0.577 <= 1;
  // Jittered rows, so the blades cover the hex evenly with no bald spots and no lines.
  const step = Math.sqrt((2.6 * 0.94 * 0.94) / MEADOW_BLADES);
  let i = 0;
  for (let gz = -1; gz <= 1; gz += step)
    for (let gx = -0.9; gx <= 0.9; gx += step) {
      const k = (i++) * 9;
      const x = (gx + (r(k) - 0.5) * step) * 0.94, z = (gz + (r(k + 1) - 0.5) * step) * 0.94;
      if (!inside(x / 0.94, z / 0.94)) continue;
      const a = r(k + 2) * Math.PI * 2;
      const h = MEADOW_H * (0.5 + r(k + 3) * 0.5);
      const dry = r(k + 7) < 0.08;
      pushBlade(out, x, z, Math.sin(a), Math.cos(a), a + Math.PI / 2 + (r(k + 4) - 0.5), h, 0.035 + r(k + 5) * 0.025, 0.25 + r(k + 6) * 0.4, 0.84 + r(k + 8) * 0.3, dry ? SEEDING : GREEN);
    }
  return bladesGeometry(out);
}

/**
 * Where the meadows are: a smooth swell over the map, so the hexes it picks come in patches of several
 * together that read as fields, not one here and one there. About a third of open grass.
 */
export const meadowAt = (x: number, z: number) =>
  Math.sin(x * 0.31 + 1.3) * Math.sin(z * 0.37 + 0.4) + 0.6 * Math.sin((x - z) * 0.17 + 2.1) + 0.3 * Math.sin(x * 0.83 + z * 0.61) > 0.35;

/** Dry patches: two of dead grass, flopped over and gone to straw, and one of dry ground, thin and burnt brown. */
const DRY_KINDS = 3;
/** The kind that is dry ground rather than dead grass. */
const DRY_GROUND = 2;
/** The tallest a dry patch's blades stand: dead grass lies lower than living. */
const DRY_H = 0.34;

/**
 * A hex gone dry, in one piece like a meadow, told from it by colour alone (the renderer tints the ground
 * under it to match). Dead grass is still thick, but straw-coloured, bent over and short, with an odd olive
 * blade not quite gone. Dry ground grows thinner, lower grass, burnt brown.
 */
function dryGeometry(kind: number): THREE.BufferGeometry {
  const r = (i: number) => hash(kind + 23, i, 613);
  const out: Blades = { pos: [], nor: [], col: [], root: [] };
  const burnt = kind === DRY_GROUND;
  const inside = (x: number, z: number) => Math.abs(x) <= 0.866 && Math.abs(z) + Math.abs(x) * 0.577 <= 1;
  const blades = burnt ? 75 : 115;
  const step = Math.sqrt((2.6 * 0.94 * 0.94) / blades);
  let i = 0;
  for (let gz = -1; gz <= 1; gz += step)
    for (let gx = -0.9; gx <= 0.9; gx += step) {
      const k = 1000 + (i++) * 9;
      const x = (gx + (r(k) - 0.5) * step) * 0.94, z = (gz + (r(k + 1) - 0.5) * step) * 0.94;
      if (!inside(x / 0.94, z / 0.94)) continue;
      const a = r(k + 3) * Math.PI * 2;
      const tones = burnt ? (r(k + 7) < 0.25 ? DEAD : BURNT) : r(k + 7) < 0.15 ? FADING : DEAD;
      const h = DRY_H * (burnt ? 0.3 + r(k + 5) * 0.5 : 0.4 + r(k + 5) * 0.6);
      pushBlade(out, x, z, Math.sin(a), Math.cos(a), a + Math.PI / 2 + (r(k + 4) - 0.5), h, 0.04 + r(k + 6) * 0.03, 0.45 + r(k + 8) * 0.5, 0.86 + r(k + 2) * 0.26, tones);
    }
  return bladesGeometry(out);
}

/**
 * Which dry patch a hex of open grass is, or -1 if it is not one: another smooth swell over the map, apart
 * from the meadows', so dry ground comes in patches too and never where a meadow is. About a sixth of open
 * grass; a third of that is dry ground, the rest dead grass. The renderer asks too, to tint the ground under it.
 */
export function dryPatch(t: Tile, x: number, z: number): number {
  if (t.biome !== "plains" || t.path || t.grass || meadowAt(x, z)) return -1;
  const swell = Math.sin(x * 0.27 + 4.1) * Math.sin(z * 0.33 + 2.6) + 0.6 * Math.sin((x + z) * 0.19 + 0.7) + 0.3 * Math.sin(x * 0.71 - z * 0.53 + 1.9);
  if (swell < 0.55) return -1;
  // The driest in the middle of the swell: dry ground there, dead grass round it.
  return swell > 1.05 ? DRY_GROUND : hash(t.q, t.r, 98) < 0.5 ? 0 : 1;
}

/** Tall grass, root to tip: deeper than the meadow's, and gone to pale seed at the top of some. */
const TALL: Tones = [new THREE.Color("#356f31"), new THREE.Color("#5c9f45"), new THREE.Color("#a9d873")];
const TALL_SEED: Tones = [new THREE.Color("#356f31"), new THREE.Color("#7aa850"), new THREE.Color("#e6dc9a")];
/** How many different patches of tall grass there are. */
const TALL_KINDS = 2;
/** The tallest its blades stand, world units: up to a hero's waist. */
const TALL_H = 0.82;

/**
 * A hex of tall grass, in one piece like a meadow: more blades, three times the height, standing straighter,
 * every one in five topped with seed. It is the fields' shader that parts it round anyone walking through.
 */
function tallGeometry(kind: number): THREE.BufferGeometry {
  const r = (i: number) => hash(kind + 37, i, 719);
  const out: Blades = { pos: [], nor: [], col: [], root: [] };
  const inside = (x: number, z: number) => Math.abs(x) <= 0.866 && Math.abs(z) + Math.abs(x) * 0.577 <= 1;
  const blades = 170;
  const step = Math.sqrt((2.6 * 0.97 * 0.97) / blades);
  let i = 0;
  for (let gz = -1; gz <= 1; gz += step)
    for (let gx = -0.9; gx <= 0.9; gx += step) {
      const k = (i++) * 9;
      const x = (gx + (r(k) - 0.5) * step) * 0.97, z = (gz + (r(k + 1) - 0.5) * step) * 0.97;
      if (!inside(x / 0.97, z / 0.97)) continue;
      const a = r(k + 2) * Math.PI * 2;
      const seeded = r(k + 7) < 0.2;
      const h = TALL_H * (seeded ? 0.8 + r(k + 3) * 0.2 : 0.5 + r(k + 3) * 0.42);
      pushBlade(out, x, z, Math.sin(a), Math.cos(a), a + Math.PI / 2 + (r(k + 4) - 0.5), h, 0.04 + r(k + 5) * 0.028, 0.08 + r(k + 6) * 0.2, 0.8 + r(k + 8) * 0.32, seeded ? TALL_SEED : TALL);
    }
  return bladesGeometry(out);
}

/**
 * Whether a hex of open grass is tall grass: a third smooth swell over the map, so it too comes in patches,
 * and never where a path, a dry patch or a meadow is. About a tenth of open grass. The renderer asks too, to
 * deepen the ground under it.
 */
export function tallGrass(t: Tile, x: number, z: number): boolean {
  if (t.biome !== "plains" || t.path) return false;
  // Set down as tall grass, whatever the swells say (the Harbor's oak hill).
  if (t.grass === "tall") return true;
  if (meadowAt(x, z) || dryPatch(t, x, z) >= 0) return false;
  return Math.sin(x * 0.29 + 0.4) * Math.sin(z * 0.35 + 5.1) + 0.6 * Math.sin((x * 0.6 - z) * 0.21 + 3.3) + 0.3 * Math.sin(x * 0.77 + z * 0.49 + 0.6) > 0.3;
}

/** The ridge along a path's edge, as tints on its dirt: shaded where it rises, lit along the crest, olive at its foot in the grass. */
const RIDGE_FOOT_IN = new THREE.Color(0.86, 0.84, 0.82);
const RIDGE_CREST = new THREE.Color(1.1, 1.06, 1.0);
const RIDGE_FOOT_OUT = new THREE.Color(0.78, 1.0, 0.72);
/** Half a path's width: the same everywhere, so a path's ends meet its neighbours' exactly at the shared side. */
const PATH_HALF = 0.24;
/** From a hex's middle to the middle of a side. */
const SIDE_REACH = (TILE_RADIUS * Math.sqrt(3)) / 2;
/** The way out through each side, in the world's HEX_DIRS order (top right, clockwise), as (x, z). */
const SIDE_WAY = [-60, 0, 60, 120, 180, 240].map((deg) => ({ x: Math.cos((deg * Math.PI) / 180), z: Math.sin((deg * Math.PI) / 180) }));

/**
 * How far out from a path hex's middle its dirt reaches, in a direction `phi` (radians, from +x toward +z): the
 * union of a strip out to each side it joins (`bits`, as Tile.path) and a round middle that rounds off its
 * joints, or makes a round end where only one strip leaves.
 */
function pathReach(bits: number, phi: number): number {
  let arms = 0;
  let reach = 0;
  for (let i = 0; i < 6; i++) {
    if (!(bits & (1 << i))) continue;
    arms++;
    const a = Math.atan2(Math.sin(phi - Math.atan2(SIDE_WAY[i].z, SIDE_WAY[i].x)), Math.cos(phi - Math.atan2(SIDE_WAY[i].z, SIDE_WAY[i].x)));
    if (Math.abs(a) >= Math.PI / 2) continue;
    const side = Math.abs(Math.sin(a)) < 1e-6 ? Infinity : PATH_HALF / Math.abs(Math.sin(a));
    reach = Math.max(reach, Math.min(side, SIDE_REACH / Math.cos(a)));
  }
  return Math.max(reach, PATH_HALF * (arms === 1 ? 1.3 : 1.02));
}

/** Whether a spot (dx, dz from a hex's middle) is on the dirt of a path hex, give or take `margin`. */
function onPath(bits: number, dx: number, dz: number, margin: number): boolean {
  const d = Math.hypot(dx, dz);
  return d < pathReach(bits, Math.atan2(dz, dx)) + margin;
}

/** Two scallops of a cut-out wave: a white crest over a lighter blue body. */
const waveTexture = () =>
  pixelTexture(24, 6, (ctx) =>
    stamp(
      ctx,
      [
        "    wwww        wwww    ",
        "  wwbbbbww    wwbbbbww  ",
        " wbbbbbbbbw  wbbbbbbbbw ",
        "wbbbbbbbbbbwwbbbbbbbbbbw",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      { w: "#f2f9ff", b: "#4f95e4" },
    ),
  );

/** Width of a wave strip: short enough that two rows fit inside a hex at any angle. */
const WAVE_WIDTH = 1.3;
/** How far each row sits from the middle of its hex. */
const WAVE_ROW = 0.3;
/** World units covered by one repeat of the floorboard texture: about one hex across. */
const BOARD_SPAN = 1.76;

/**
 * Floorboards for a hut: four rows of planks with staggered ends, a dark seam
 * between rows, and a few streaks of grain. Flat colours only, so it sits with
 * the rest of the scenery.
 */
const floorTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const boards = ["#b58d5e", "#a98253", "#bd9566", "#b08a5c"];
    const seam = "#7f5f3c";
    const grain = "#9c7749";
    const light = "#c9a274";
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      // Each row is two planks, with the joint somewhere different every row.
      const joint = [11, 25, 5, 19][row];
      for (let x = 0; x < 32; x++) {
        const plank = x < joint ? row : row + 2;
        ctx.fillStyle = boards[plank % boards.length];
        ctx.fillRect(x, y, 1, 7);
      }
      ctx.fillStyle = seam;
      ctx.fillRect(0, y + 7, 32, 1);
      ctx.fillRect(joint, y, 1, 7);
      // Short streaks along the plank, darker and lighter.
      for (let i = 0; i < 5; i++) {
        const gx = Math.floor(hash(row, i, 300) * 28);
        const gy = y + 1 + Math.floor(hash(row, i, 301) * 5);
        const len = 2 + Math.floor(hash(row, i, 302) * 4);
        ctx.fillStyle = i % 3 === 2 ? light : grain;
        ctx.fillRect(gx, gy, len, 1);
      }
    }
    // One knot.
    ctx.fillStyle = seam;
    ctx.fillRect(21, 11, 2, 2);
  });

/** Raindrops in the air at once. */
const DROPS = 150;
/** Droplets in one splash against the rocks. */
const SPLASH_DROPS = 6;
/** How long one spell of weather lasts before the sky starts turning to the next. */
const WEATHER_SPELL_MS = 7 * 60 * 1000;
/** Puffs of smoke in the air over one chimney at a time. */
const PUFFS = 5;
/** Lumps in one puff: a small low-poly cloud. */
const LOBES = 5;

/**
 * What the pixel decorations (smoke rings, wisps) need to know about the view: how big the picture being drawn
 * is, in its own pixels, and how many of those make one chunky pixel (1 as a rule, 2 with "Fancy graphics" on,
 * when the world is drawn at full resolution). One per ambience, shared by its materials, kept current by `trackView`.
 */
type PixelView = { uRes: { value: THREE.Vector2 }; uFine: { value: number } };
const viewSize = new THREE.Vector2();
/** Before `object` is drawn, note the size of the picture it is drawn into (the screen, or the finishing pass's target). */
function trackView(object: THREE.Object3D, view: PixelView) {
  object.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    if (target) view.uRes.value.set(target.width, target.height);
    else view.uRes.value.copy(renderer.getDrawingBufferSize(viewSize));
  };
}
/** Chunky pixels across that `world` units come to at this depth, as a float (GLSL; `depth` is -view z). */
const CELLS_GLSL = /* glsl */ `
  uniform vec2 uRes;
  uniform float uFine;
  float cellsAcross(float world, float depth) {
    return world * projectionMatrix[1][1] * 0.5 * uRes.y / depth / uFine;
  }
`;

/**
 * Chimney smoke: small low-poly clouds, each a few faceted lumps (one instance of a 20-sided ball each, placed by
 * `puff`). Each face is one flat tone, lit by a fixed light from above in three bands (tops light, sides between,
 * undersides dark), like the props' flat-shaded rocks and bushes; `uShade` follows the daylight.
 */
function smokeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uShade: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uShade;
      varying vec3 vWorld;
      void main() {
        // The face's own normal, so each facet is one flat tone.
        vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        float lit = dot(normal, normalize(vec3(0.35, 1.0, 0.25)));
        float band = lit > 0.6 ? 1.0 : lit > -0.15 ? 0.84 : 0.68;
        gl_FragColor = vec4(vec3(uShade * band, uShade * band, uShade * band * 1.03), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Wisps: each a ribbon along its trail, so it is one unbroken stroke however near the camera is (single pixels
 * spaced along the path came apart into a row of dots up close). Its width is set in the world, at least one
 * chunky pixel and at most three, in whole chunky pixels, so it thickens a little as the camera comes in.
 * `aDir` is the way the trail runs at each point; `aSide` is which edge of the ribbon a corner is on.
 */
function wispMaterial(view: PixelView): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: view,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      ${CELLS_GLSL}
      attribute vec3 aDir;
      attribute float aSide;
      attribute vec4 aTint;
      varying vec4 vTint;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec4 clip = projectionMatrix * mv;
        vec4 ahead = projectionMatrix * modelViewMatrix * vec4(position + aDir, 1.0);
        vec2 run = (ahead.xy / ahead.w - clip.xy / clip.w) * uRes;
        float len = length(run);
        vec2 across = len > 1e-4 ? vec2(-run.y, run.x) / len : vec2(0.0, 1.0);
        float px = clamp(floor(cellsAcross(0.03, -mv.z) + 0.5), 1.0, 3.0) * uFine;
        clip.xy += across * aSide * px / uRes * clip.w;
        gl_Position = clip;
        vTint = aTint;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vTint;
      void main() {
        gl_FragColor = vTint;
        #include <colorspace_fragment>
      }
    `,
  });
}
/**
 * Cobbles for the Harbor's streets, as quiet as the floorboards: irregular
 * rounded stones of uneven size in four near-identical greys, with joints
 * only a shade darker and now and then a faintly mossy stone. Each pixel
 * belongs to the nearest of a scatter of stone centres, and the pixels where
 * two stones meet are the joint. The scatter wraps, so the sheet tiles.
 */
const cobbleTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const SIZE = 32;
    const CELLS = 5;
    const step = SIZE / CELLS;
    const stones = ["#72757c", "#6d7077", "#75787f", "#6f7279"];
    // One centre per cell of a coarse grid, pushed well off the middle so no rows or columns show.
    const centres: { x: number; y: number; tone: string }[] = [];
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        centres.push({
          x: (cx + 0.15 + hash(cx, cy, 610) * 0.7) * step,
          y: (cy + 0.15 + hash(cx, cy, 611) * 0.7) * step,
          tone: hash(cx, cy, 612) < 0.07 ? "#6b746c" : stones[Math.floor(hash(cx, cy, 613) * stones.length)],
        });
      }
    }
    const wrap = (d: number) => Math.min(Math.abs(d), SIZE - Math.abs(d));
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let best = Infinity;
        let second = Infinity;
        let tone = stones[0];
        for (const c of centres) {
          const d = Math.hypot(wrap(x + 0.5 - c.x), wrap(y + 0.5 - c.y));
          if (d < best) {
            second = best;
            best = d;
            tone = c.tone;
          } else if (d < second) second = d;
        }
        ctx.fillStyle = second - best < 1.1 ? "#63666d" : tone;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });

/**
 * Planks for the piers: long weathered boards running out to sea, in close
 * browns with thin dark gaps and the odd nail. Quieter than the hut floor.
 */
const pierTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const boards = ["#9a7748", "#927044", "#a07d4e", "#967446"];
    for (let col = 0; col < 4; col++) {
      const x = col * 8;
      // Each run is two boards end to end, the joint somewhere different every run.
      const joint = [9, 22, 15, 4][col];
      for (let y = 0; y < 32; y++) {
        ctx.fillStyle = boards[(y < joint ? col : col + 2) % boards.length];
        ctx.fillRect(x, y, 7, 1);
      }
      ctx.fillStyle = "#7a5c38";
      ctx.fillRect(x + 7, 0, 1, 32);
      ctx.fillRect(x, joint, 7, 1);
      ctx.fillStyle = "#6b5234";
      ctx.fillRect(x + 3, (joint + 2) % 32, 1, 1);
      // A streak or two of pale, salt-bleached grain.
      ctx.fillStyle = "#a98658";
      for (let i = 0; i < 2; i++) ctx.fillRect(x + 1 + Math.floor(hash(col, i, 630) * 5), Math.floor(hash(col, i, 631) * 28), 1, 2 + Math.floor(hash(col, i, 632) * 3));
    }
  });

/**
 * Mud for the Harbor's unpaved ground: one brown with a faint scatter of
 * darker wet patches, paler grit and a few short ruts. Barely there.
 */
const mudTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    ctx.fillStyle = "#5f5140";
    ctx.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(hash(i, 1, 620) * 32);
      const y = Math.floor(hash(i, 2, 620) * 32);
      const kind = hash(i, 3, 620);
      ctx.fillStyle = kind < 0.5 ? "#574a3a" : kind < 0.85 ? "#665846" : "#52463a";
      // Mostly single pixels; some smears two or three long, and a few ruts.
      const len = kind < 0.5 ? 1 + Math.floor(hash(i, 4, 620) * 3) : kind < 0.85 ? 1 : 4 + Math.floor(hash(i, 4, 620) * 3);
      for (let dx = 0; dx < len; dx++) ctx.fillRect((x + dx) % 32, y, 1, 1);
    }
  });

/**
 * Trodden earth for the dirt paths, in the same pixel style as the mud: dusty brown grit, a scatter of small
 * pebbles with a pale top, and darker smears where feet and wheels have worn it. It is laid by world position,
 * so it runs on unbroken from one path hex into the next.
 */
const pathTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    ctx.fillStyle = "#a88b5e";
    ctx.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 70; i++) {
      const x = Math.floor(hash(i, 1, 640) * 32);
      const y = Math.floor(hash(i, 2, 640) * 32);
      const kind = hash(i, 3, 640);
      if (kind < 0.42) {
        // Grit: single pixels a shade either way.
        ctx.fillStyle = hash(i, 4, 640) < 0.5 ? "#9a7e53" : "#b5996a";
        ctx.fillRect(x, y, 1, 1);
      } else if (kind < 0.7) {
        // Worn smears, two to five long, darker.
        ctx.fillStyle = hash(i, 4, 640) < 0.6 ? "#937650" : "#8a6d48";
        const len = 2 + Math.floor(hash(i, 5, 640) * 3.99);
        for (let dx = 0; dx < len; dx++) ctx.fillRect((x + dx) % 32, y, 1, 1);
      } else if (kind < 0.9) {
        // A pebble: two by two, grey, lit on top.
        ctx.fillStyle = "#8e877a";
        ctx.fillRect(x, y, 2, 2);
        ctx.fillStyle = "#bdb6a6";
        ctx.fillRect(x, y, 1, 1);
      } else {
        // A dry crack.
        ctx.fillStyle = "#7c6242";
        for (let k = 0; k < 4; k++) ctx.fillRect((x + k) % 32, (y + (k >> 1)) % 32, 1, 1);
      }
    }
  });

/**
 * A puddle: a blocky pixel blob of dark water, stepped at the ends rather than
 * round, with a pale glint along its far edge.
 */
/**
 * A hollow in the ground, one unit across and one unit high, to be scaled to size: a bank that rises
 * from the ground to a lip and falls away inside to the water, and the water lying in it. The outline
 * is a rough nine-sided ring, not a circle, so it reads as dug earth.
 */
function hollowGeometry(): { bank: THREE.BufferGeometry; water: THREE.BufferGeometry } {
  const SIDES = 9;
  const WATER_LEVEL = 0.3;
  const ring = (reach: number, y: number) =>
    Array.from({ length: SIDES + 1 }, (_, i) => {
      const k = i % SIDES;
      const a = (k / SIDES) * Math.PI * 2;
      const r = reach * (0.85 + 0.3 * hash(k, 1, 410));
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    });
  const foot = ring(1, 0);
  const lip = ring(0.8, 1);
  const shore = ring(0.6, WATER_LEVEL);
  const bank: number[] = [];
  const water: number[] = [];
  for (let i = 0; i < SIDES; i++) {
    // Up the outside of the bank, then down the inside to the water's edge.
    bank.push(...foot[i], ...lip[i], ...foot[i + 1], ...lip[i], ...lip[i + 1], ...foot[i + 1]);
    bank.push(...lip[i], ...shore[i], ...lip[i + 1], ...shore[i], ...shore[i + 1], ...lip[i + 1]);
    water.push(0, WATER_LEVEL, 0, ...shore[i + 1], ...shore[i]);
  }
  const make = (points: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    g.computeVertexNormals();
    return g;
  };
  return { bank: make(bank), water: make(water) };
}

/**
 * Which way the wind blows across the map, as a unit vector on the ground:
 * mostly along +x, a little toward +z. Wisps travel this way and rain slants
 * with it, fixed in the world so turning the camera never turns the weather.
 */
const WIND = (() => {
  const a = 0.35;
  return { x: Math.cos(a), z: Math.sin(a) };
})();

/** Pixels in one wisp's trail. */
const TRAIL = 34;

interface Tuft {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
  /** Which shape of tuft, its place among that shape's instances, and how it is turned about y. */
  kind?: number;
  index?: number;
  yaw?: number;
}
/** A hex covered whole by one patch of grass (a meadow, or a dry one): where, turned how many sixths, which patch. */
interface FieldPatch {
  x: number;
  y: number;
  z: number;
  turn: number;
  kind: number;
  /** 0 to 1: how light or dark this one is. */
  tone: number;
}
interface Crest {
  /** Centre of the water hex it belongs to. */
  x: number;
  y: number;
  z: number;
  phase: number;
}
interface Wisp {
  offset: number;
  speed: number;
}

/** How many plain lights candles and lanterns share. Fixed, so adding a candle never recompiles a material. */
const GLOW_LIGHTS = 4;

/**
 * How many of a hut's candles, lanterns and fires throw shadows at once: the
 * ones nearest your hero. Fixed, so walking past a candle never changes the
 * number of shadow-casting lights (and recompiles every material); lights are
 * moved between pieces instead.
 */
export const SHADOW_SLOTS = 6;
/**
 * A lit window or lantern on a building: a soft halo that comes up as the light goes, and, with `light`, one of the
 * plain lights outdoors (shared with the props' lights, so the light count never changes).
 */
/**
 * The light a lighthouse's lamp throws on the ironwork round it (the lantern's glazing bars, the gallery's posts
 * and rails) as its beams turn: laid over the iron as a skin, added to what is there. Each point shines by how
 * nearly a beam points at it from the lamp, so the highlight runs round the rails with the beam, and by how near
 * the lamp it is. The ambience sets where the lamp is, which way the beams point and how strong the shine is
 * (see `setBeacon` and `sweep`); until it does, nothing shows.
 */
export function beaconShine(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uCentre: { value: new THREE.Vector3() }, uTurn: { value: 0 }, uGain: { value: 0 }, uNear: { value: 0.17 }, uColor: { value: new THREE.Color("#ffe2a0") } },
    vertexShader: /* glsl */ `
      uniform vec3 uCentre;
      varying vec2 vOut;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vOut = world.xz - uCentre.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTurn;
      uniform float uGain;
      uniform float uNear;
      uniform vec3 uColor;
      varying vec2 vOut;
      void main() {
        float far = max(length(vOut), 0.0001);
        // Two beams, back to back: either one pointing this way counts.
        float facing = abs(dot(vOut / far, vec2(cos(uTurn), -sin(uTurn))));
        float shine = pow(facing, 14.0) * pow(min(1.0, uNear / far), 1.5) * uGain;
        gl_FragColor = vec4(uColor * shine, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}
export type BuildingGlow = { pos: THREE.Vector3; /** The halo's width; 0 for a light with no halo. */ size: number; light?: LightKind };
/** Shadow maps a moving hero may redraw in one frame. Others wait their turn (a frame or two), oldest first. */
const MOVE_REDRAWS = 2;
/** How far past a light's reach a hero can stand and still throw a shadow it draws: about a hero's height. */
const STIR_MARGIN = 1.6;
/** How much nearer (in world units) another piece must be before a shadow slot is handed to it from the one it lights. */
const SLOT_HOLD = 1;
/** How much nearer a fire counts as when the slots are handed out. */
const FIRE_PULL = 3;
/**
 * Seconds a piece's shadow takes to fade in or out when a slot changes hands. Meanwhile the piece's light is
 * shared between its slot and a plain light in the same spot, so its brightness never changes; only the shadow fades.
 */
const SLOT_FADE = 0.45;
/** Plain lights added indoors only, for pieces whose shadow is fading: they need a plain light alongside their slot. */
const FADE_GLOWS = 2;

/** How each kind of small light looks outdoors, and indoors under the lamp. Outdoor fires past the first use these too. */
const GLOW: Record<LightKind, { color: string; power: number; range: number; flicker: boolean }> = {
  candle: { color: "#ffb35c", power: 0.9, range: 3.2, flicker: true },
  lamp: { color: "#ffd08a", power: 1.5, range: 4.5, flicker: false },
  fire: { color: "#ff9548", power: 2.2, range: 5, flicker: true },
};

/** What a table lantern's light warms toward as it flares. */
const FLARE_WHITE = new THREE.Color("#ffe9c2");

export class Ambience {
  /** Everything built for the current map. */
  readonly group = new THREE.Group();
  private hemi = new THREE.HemisphereLight("#ffffff", "#5a6a8a", 1.5);
  private sun = new THREE.DirectionalLight("#fff3d6", 1.6);
  private background = new THREE.Color("#a9dcf7");
  /** How much of the day's light there is, 0 (night) to 1. */
  private daylight = 1;
  /** How dark it is outdoors, 0 (full day) to 1 (deep night). Always 0 indoors. */
  get night(): number {
    return this.indoors ? 0 : 1 - this.daylight;
  }
  /** A room: steady lamplight, a dark backdrop and no wind. */
  private indoors = false;
  /** Direction to the sun (or the moon), for anything that must face it. */
  readonly sunDir = new THREE.Vector3(-0.4, 0.8, 0.4);
  /** A hut's hanging lamp over the middle of the room, which its owner can put out. */
  private lamp = new THREE.PointLight("#ffd7a1", 0, 0, 0);
  /** Whether the hut's hanging lamp is lit. Off, the room is lit only by its candles, lanterns and fires. */
  private lampOn = true;
  /** In the Haunted Caverns: dark as indoors, no hanging lamp, and a torch carried by each hero. */
  private cave = false;
  /** One warm, flickering torch per hero in the caverns (at most four). No shadows: they move with every step. */
  private torches = Array.from({ length: 4 }, () => new THREE.PointLight("#ffb070", 0, 7, 1.4));
  private torchCount = 0;
  /** The lamp's glowing lantern, dimmed when the lamp is put out. */
  private lanternMat: THREE.MeshBasicMaterial | null = null;
  /**
   * Firelight outdoors: one warm light for the campfire nearest the camera's
   * target, no shadows, showing only once the light starts to go. Always in the
   * scene outdoors, so adding a fire never changes the number of lights (and
   * recompiles every material). Hidden indoors, where the shadow slots light the fires.
   */
  private fireLight = new THREE.PointLight("#ff9548", 0, 6, 2);
  /**
   * Indoors, the candles, lanterns and fires nearest your hero each get one of
   * these: a light with its own shadow map, so every one of them throws the
   * hero's and the furniture's shadows. The maps are drawn only when something
   * in reach changes (see stir), not every frame. Hidden outdoors.
   */
  private slots = Array.from({ length: SHADOW_SLOTS }, () => new THREE.PointLight("#ffb35c", 0, 6, 1));
  /** The piece each slot is lighting, or null while it has none. */
  private slotOf: ({ pos: THREE.Vector3; kind: LightKind } | null)[] = Array(SHADOW_SLOTS).fill(null);
  /**
   * How much of its piece's light each slot carries, 0 to 1; a plain light carries the rest. It eases up after a
   * slot is handed to a piece and down before the slot leaves it, so a shadow fades rather than pops.
   */
  private slotWeight: number[] = Array(SHADOW_SLOTS).fill(0);
  /** A room just built: its slots start at full strength instead of fading in. */
  private freshRoom = false;
  private lastClock = 0;
  /** Slots a moving hero has asked to redraw, waiting for their turn. */
  private stirred = new Set<number>();
  /** The frame each slot's map was last drawn on, so the longest-waiting go first. */
  private drawnAt: number[] = Array(SHADOW_SLOTS).fill(0);
  private frameNo = 0;
  /** Where your hero stands, for picking the slot to redraw first. */
  private focus = new THREE.Vector3();
  /**
   * Candles, lanterns and fires past those: a few plain lights (no shadows)
   * handed to the ones nearest each frame. Also always in the scene, for the same reason.
   */
  private glows = Array.from({ length: GLOW_LIGHTS }, () => new THREE.PointLight("#ffb35c", 0, 4, 2));
  /** A couple more plain lights indoors, so pieces whose shadow is fading in or out always have one. Hidden outdoors. */
  private fadeGlows = Array.from({ length: FADE_GLOWS }, () => new THREE.PointLight("#ffb35c", 0, 4, 2));
  private lights: { pos: THREE.Vector3; kind: LightKind }[] = [];
  private flames: THREE.Mesh[] = [];
  /** The lanterns over the pub's game tables: lit by the plain lights only, never a shadow slot. Their owner moves and brightens them. */
  private tableLamps: LampLight[] = [];
  private lampColor = new THREE.Color();

  /** The grass, one mesh for each shape of tuft. */
  private grass: THREE.InstancedMesh[] = [];
  private tufts: Tuft[] = [];
  private waves: THREE.InstancedMesh[] = [];
  private crests: Crest[] = [];
  private wisps: Wisp[] = [];
  /** The map's extent, which gusts are scattered over. */
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private wispRibbon: THREE.Mesh | null = null;
  /** Low cloud and rain: set for a map with streets. */
  /** The map is the Harbor (it has streets): its weather runs wetter. */
  private wetPort = false;
  private outdoors = true;
  /** How cloudy and how rainy it is right now, 0 to 1 each. */
  private cloud = 0;
  private rainfall = 0;
  private rain: THREE.Points | null = null;
  /** Where the sea breaks on rock: a point on the shared edge, the way out to sea, and its own rhythm. */
  private splashes: { x: number; y: number; z: number; nx: number; nz: number; phase: number; period: number }[] = [];
  private splashPoints: THREE.Points | null = null;
  private shoreSplashes: typeof this.splashes = [];
  private rockSplashes: typeof this.splashes = [];
  /** Chimney smoke: little low-poly clouds rising from each stack. Outlives a map rebuild, so it is kept out of `group`. */
  private smoke: THREE.InstancedMesh | null = null;
  private wispAt = new THREE.Vector3();
  private wispAhead = new THREE.Vector3();
  private wispBehind = new THREE.Vector3();
  /** How many of the picture's pixels make one chunky pixel: 1 as a rule, 2 while the world is drawn at full resolution. */
  set fine(fine: number) {
    this.pixelView.uFine.value = fine;
  }
  private pixelView: PixelView = { uRes: { value: new THREE.Vector2(1, 1) }, uFine: { value: 1 } };
  private stacks: THREE.Vector3[] = [];
  /**
   * A lighthouse's lamp: two soft beams turning slowly round it and a glow on the lantern. Additive meshes and a
   * sprite, no light of its own, so the light count never changes. Kept out of `group`, like the smoke.
   */
  private beacon: { root: THREE.Group; spin: THREE.Group; beams: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial; halo: THREE.Sprite; scale: number; shine?: THREE.ShaderMaterial } | null = null;
  /**
   * Buildings' lit windows and lanterns: additive halos that come up at dusk, and the window panes, which warm from
   * their daytime colour (`userData.unlit`) to their lit one (`userData.lit`) with them. Kept out of `group`, like the smoke.
   */
  private lamps: { root: THREE.Group; glow: THREE.SpriteMaterial; halos: THREE.Sprite[]; sizes: number[]; panes: THREE.MeshBasicMaterial[] } | null = null;
  /** The lights buildings ask for, lit outdoors along with the props' lights. */
  private poiLights: { pos: THREE.Vector3; kind: LightKind }[] = [];
  private paneLit = new THREE.Color();
  private flatTint = new THREE.Color();
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private m = new THREE.Matrix4();

  constructor(private scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    // Hard-edged shadows suit the flat, pixelated look.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    scene.background = this.background;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_REACH;
    cam.right = SHADOW_REACH;
    cam.top = SHADOW_REACH;
    cam.bottom = -SHADOW_REACH;
    cam.near = 1;
    cam.far = 120;
    this.sun.shadow.bias = -0.0015;
    this.sun.shadow.normalBias = 0.04;
    this.lamp.shadow.mapSize.set(512, 512);
    this.lamp.shadow.camera.near = 0.2;
    this.lamp.shadow.camera.far = 30;
    this.lamp.shadow.bias = -0.004;
    // A room stands still: the lamp's shadows are redrawn only when something changes (see stir).
    this.lamp.shadow.autoUpdate = false;
    this.lamp.visible = false;
    this.slots.forEach((s, i) => {
      // 256 a face: six of them, so a phone keeps its memory, and the coarse edge suits the pixels.
      s.shadow.mapSize.set(256, 256);
      s.shadow.camera.near = 0.1;
      s.shadow.bias = -0.004;
      s.shadow.autoUpdate = false;
      // Always casting while indoors: only the light's place and strength change, so no material ever recompiles.
      s.castShadow = true;
      s.visible = false;
    });
    for (const g of this.fadeGlows) g.visible = false;
    for (const t of this.torches) t.visible = false;
    scene.add(this.hemi, this.sun, this.sun.target, this.lamp, this.fireLight, ...this.slots, ...this.glows, ...this.fadeGlows, ...this.torches, this.group);
  }

  /** Lay out the decoration for a map. `skip` holds the hexes to leave clear. */
  build(tiles: Tile[], skip: (t: Tile) => boolean, place: (t: Tile) => { x: number; y: number; z: number }) {
    this.clear();

    // ---- rocks: one to three per hill, in three shapes and a few greys ----
    const shapes = [
      new THREE.DodecahedronGeometry(0.3, 0),
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.BoxGeometry(0.34, 0.5, 0.3),
      new THREE.TetrahedronGeometry(0.34, 0),
    ];
    const tones = ["#8d8674", "#7b786f", "#9c917b", "#6d6960", "#a39a86"];
    const rocks: { m: THREE.Matrix4; tone: string }[][] = shapes.map(() => []);
    const tufts: Tuft[] = [];
    const meadows: FieldPatch[] = [];
    const drys: FieldPatch[] = [];
    const talls: FieldPatch[] = [];
    const crests: Crest[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (const t of tiles) {
      const p = place(t);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      const n = (salt: number) => hash(t.q, t.r, salt);

      if (t.biome === "water") {
        crests.push({ x: p.x, y: p.y - 0.13, z: p.z, phase: p.x * 0.35 + n(21) * 1.5 });
        continue;
      }
      if (skip(t)) continue;

      if (t.biome === "hills") {
        const count = 1 + Math.floor(n(40) * 2.99);
        for (let i = 0; i < count; i++) {
          const shape = Math.floor(n(41 + i) * shapes.length);
          const s = (i === 0 ? 0.8 : 0.4) + n(44 + i) * 0.55;
          // Slabs and spires stand taller; boulders sit squat.
          const tall = shape === 2 ? 0.9 + n(47 + i) * 0.9 : shape === 3 ? 1.1 + n(47 + i) * 0.6 : 0.65 + n(47 + i) * 0.3;
          const angle = (i / count) * Math.PI * 2 + n(50) * 6;
          const spread = i === 0 ? 0.15 : 0.5;
          rocks[shape].push({
            m: new THREE.Matrix4().compose(
              new THREE.Vector3(p.x + Math.sin(angle) * spread, p.y + 0.1 * s * tall, p.z + Math.cos(angle) * spread * 0.9 - 0.12),
              new THREE.Quaternion().setFromEuler(new THREE.Euler((n(53 + i) - 0.5) * 0.5, n(56 + i) * 6, (n(59 + i) - 0.5) * 0.4)),
              new THREE.Vector3(s, s * tall, s),
            ),
            tone: tones[Math.floor(n(62 + i) * tones.length)],
          });
        }
        if (n(70) < 0.35) tufts.push({ x: p.x + (n(71) - 0.5) * 1.1, y: p.y, z: p.z + 0.45, size: 0.3, phase: n(72) * 6 });
      } else if (dryPatch(t, p.x, p.z) >= 0) {
        // A dry patch: dead grass, or bare earth, over the whole hex.
        drys.push({ x: p.x, y: p.y, z: p.z, turn: Math.floor(n(95) * 6), kind: dryPatch(t, p.x, p.z), tone: n(97) });
      } else if (tallGrass(t, p.x, p.z)) {
        // Tall grass, to wade through.
        talls.push({ x: p.x, y: p.y, z: p.z, turn: Math.floor(n(95) * 6), kind: Math.floor(n(96) * TALL_KINDS), tone: n(97) });
      } else if (t.biome === "plains" && !t.path && meadowAt(p.x, p.z)) {
        // A meadow: the whole hex grown thick with grass, one patch of a few, turned by sixths.
        meadows.push({ x: p.x, y: p.y, z: p.z, turn: Math.floor(n(95) * 6), kind: Math.floor(n(96) * MEADOW_KINDS), tone: n(97) });
      } else if (t.biome === "plains") {
        // Along a path's edge, a few tufts stand just behind the ridge it throws up (the fringe of blades along it is
        // drawn with the path), far enough back that the wind does not lay them over the dirt.
        if (t.path)
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 + n(140 + i) * 1.1;
            const r = pathReach(t.path, a) + 0.16 + n(150 + i) * 0.08;
            if (r > SIDE_REACH - TILE_FILLET - 0.04) continue;
            tufts.push({ x: p.x + Math.cos(a) * r, y: p.y, z: p.z + Math.sin(a) * r, size: 0.17 + n(160 + i) * 0.1, phase: p.x * 0.6 + p.z * 0.35 + n(170 + i) });
          }
        const count = 1 + Math.floor(n(80) * 3.99) + (t.path ? 2 : 0);
        for (let i = 0; i < count; i++) {
          const angle = n(81 + i) * Math.PI * 2;
          const spread = 0.25 + n(84 + i) * 0.5;
          // Grass grows beside a path, not on it.
          if (t.path && onPath(t.path, Math.sin(angle) * spread, Math.cos(angle) * spread, 0.24)) continue;
          tufts.push({
            x: p.x + Math.sin(angle) * spread,
            y: p.y,
            z: p.z + Math.cos(angle) * spread,
            size: 0.3 + n(87 + i) * 0.2,
            phase: p.x * 0.6 + p.z * 0.35 + n(90 + i),
          });
        }
      }
    }

    const tone = new THREE.Color();
    shapes.forEach((geometry, s) => {
      const list = rocks[s];
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), Math.max(1, list.length));
      mesh.count = list.length;
      list.forEach((rock, i) => {
        mesh.setMatrixAt(i, rock.m);
        mesh.setColorAt(i, tone.set(rock.tone));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    });

    // ---- waves: two rows of upright paper cut-outs on each water hex ----
    // Each strip is short enough to stay inside its own hex however the view is turned.
    // The scallops scroll along it, the back row one way and the front row the other.
    this.crests = crests;
    this.waves = [0, 1].map(() => {
      const strip = new THREE.PlaneGeometry(WAVE_WIDTH, WAVE_WIDTH * (6 / 24) * 1.25);
      strip.translate(0, WAVE_WIDTH * (6 / 24) * 0.625, 0);
      const map = waveTexture();
      map.wrapS = THREE.RepeatWrapping;
      map.repeat.x = 0.8;
      const mesh = new THREE.InstancedMesh(strip, new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }), Math.max(1, crests.length));
      mesh.count = crests.length;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });

    this.bounds = { minX, maxX, minZ, maxZ };

    // ---- a hut is lit by a lamp hung over the middle of the room, not by the sky ----
    // The caverns light like a room with its lamp out: no sun, no sky, and the heroes' torches doing the work.
    const cave = (this.cave = tiles.some((t) => (t.biome as string) === "cave"));
    for (const t of this.torches) t.visible = cave;
    const inside = cave || tiles.some((t) => (t.biome as string) === "floor");
    this.lamp.visible = inside;
    // Casting even while it is out (at no strength, its map not redrawn), so putting it out never recompiles a material.
    this.lamp.castShadow = inside;
    this.sun.castShadow = !inside;
    this.fireLight.visible = !inside;
    for (const s of this.slots) s.visible = inside;
    for (const g of this.fadeGlows) g.visible = inside;
    this.slotOf.fill(null);
    this.slotWeight.fill(0);
    this.freshRoom = inside;
    this.stirAll();
    if (inside) this.lamp.position.set((minX + maxX) / 2, 2.7, (minZ + maxZ) / 2);
    if (inside && !cave) {
      this.lanternMat = new THREE.MeshBasicMaterial({ color: this.lampOn ? "#ffe2a8" : "#4a3f30" });
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), this.lanternMat);
      lantern.position.copy(this.lamp.position);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.28), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      cap.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.16);
      const chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.04), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      chain.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.99);
      this.group.add(lantern, cap, chain);
    }

    // ---- floorboards and cobbles: laid as one sheet each, so the pattern runs across hexes ----
    const lay = (biome: string, map: THREE.CanvasTexture, span: number, material?: THREE.Material) => {
      const under = tiles.filter((t) => (t.biome as string) === biome);
      if (under.length === 0) return;
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      for (const t of under) {
        const p = place(t);
        // Draped over the hex, fillet and all, a hair off its surface. The pattern is still laid straight down from above.
        hexTop((x, y, z, nx, ny, nz) => {
          positions.push(p.x + x + nx * 0.006, p.y + y + ny * 0.006, p.z + z + nz * 0.006);
          normals.push(nx, ny, nz);
          uvs.push((p.x + x) / span, (p.z + z) / span);
        });
      }
      const sheet = new THREE.BufferGeometry();
      sheet.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      sheet.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      sheet.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      const mesh = new THREE.Mesh(sheet, material ?? new THREE.MeshLambertMaterial({ map }));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    // The Harbor's grass is drabbed by the wet, as the renderer does for every grass tile in a port.
    const wet = tiles.some((t) => (t.biome as string) === "cobble");
    const grassTint = new THREE.Color("#7cb856");
    if (wet) grassTint.lerp(new THREE.Color("#5d6a5c"), 0.5);
    lay("floor", floorTexture(), BOARD_SPAN);
    lay("cobble", cobbleTexture(), BOARD_SPAN);
    lay("mud", mudTexture(), BOARD_SPAN);
    lay("dock", pierTexture(), BOARD_SPAN);
    // ---- grass edges: where a dirt path meets grass, the grass breaks up into tiny hexes across the dirt ----
    // The tiny hexes sit on one lattice for the whole map, so they line up across tile borders, and thin out
    // the further they are from the grass: about half the edge row, a few just beyond it, then bare dirt.
    const byKey = new Map(tiles.map((t) => [`${t.q},${t.r}`, t]));
    const MINI = 0.13;
    const stepX = Math.sqrt(3) * MINI;
    const stepZ = 1.5 * MINI;
    const APOTHEM = 0.985 * Math.cos(Math.PI / 6);
    const bits: { m: THREE.Matrix4; tone: number }[] = [];
    for (const t of tiles) {
      if ((t.biome as string) !== "mud" || skip(t)) continue;
      const p = place(t);
      // The sides of this hex that face grass, as their two corners.
      const edges: { ax: number; az: number; bx: number; bz: number; y: number }[] = [];
      for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
        const nb = byKey.get(`${t.q + dq},${t.r + dr}`);
        if (!nb || (nb.biome as string) !== "plains") continue;
        const o = place(nb);
        const side = (((Math.round(Math.atan2(o.x - p.x, o.z - p.z) / (Math.PI / 3) - 0.5) % 6) + 6) % 6);
        const a = (side * Math.PI) / 3;
        const b = ((side + 1) * Math.PI) / 3;
        edges.push({ ax: p.x + Math.sin(a) * 0.985, az: p.z + Math.cos(a) * 0.985, bx: p.x + Math.sin(b) * 0.985, bz: p.z + Math.cos(b) * 0.985, y: o.y });
      }
      if (edges.length === 0) continue;
      const toEdge = (x: number, z: number, e: (typeof edges)[number]) => {
        const dx = e.bx - e.ax, dz = e.bz - e.az;
        const f = Math.max(0, Math.min(1, ((x - e.ax) * dx + (z - e.az) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(x - (e.ax + dx * f), z - (e.az + dz * f));
      };
      for (let row = Math.floor((p.z - 1) / stepZ); row <= Math.ceil((p.z + 1) / stepZ); row++) {
        const z = row * stepZ;
        const shift = row % 2 === 0 ? 0 : stepX / 2;
        for (let col = Math.floor((p.x - 1) / stepX) - 1; col <= Math.ceil((p.x + 1) / stepX) + 1; col++) {
          const x = col * stepX + shift;
          // Only whole tiny hexes, inside this tile.
          const vx = x - p.x, vz = z - p.z;
          let inside = true;
          for (let k = 0; k < 6; k++) {
            const n = Math.PI / 6 + (k * Math.PI) / 3;
            if (vx * Math.sin(n) + vz * Math.cos(n) > APOTHEM - MINI * 0.9) inside = false;
          }
          if (!inside) continue;
          let near = Infinity;
          let y = p.y;
          for (const e of edges) {
            const d = toEdge(x, z, e);
            if (d < near) {
              near = d;
              y = e.y;
            }
          }
          const roll = hash(col, row, 660);
          const keep = near < MINI * 1.2 ? 0.5 : near < MINI * 2.6 ? 0.15 : 0;
          if (roll >= keep) continue;
          // The first row stands at the grass's height; the scattered ones further out sit lower, on the dirt.
          const top = near < MINI * 1.2 ? y : p.y + 0.02;
          bits.push({
            m: new THREE.Matrix4().compose(new THREE.Vector3(x, (top + p.y) / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, Math.max(0.02, top - p.y + 0.012), 1)),
            tone: hash(col, row, 661),
          });
        }
      }
    }
    if (bits.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(MINI * 0.96, MINI * 0.96, 1, 6), new THREE.MeshLambertMaterial({ flatShading: true }), bits.length);
      const c = new THREE.Color();
      bits.forEach((bit, i) => {
        mesh.setMatrixAt(i, bit.m);
        // Mostly the grass's own green, with the odd lighter or darker one.
        mesh.setColorAt(i, c.copy(grassTint).offsetHSL(0, 0, bit.tone < 0.15 ? -0.04 : bit.tone > 0.85 ? 0.04 : 0));
      });
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    // ---- grass: low-poly tufts, each turned its own way, that lean with the wind ----
    // Each is tinted a shade lighter or darker; in the wet port, drabbed the way its ground is.
    this.tufts = tufts;
    const plain = new THREE.Color("#7cb856");
    const drab = new THREE.Color(grassTint.r / plain.r, grassTint.g / plain.g, grassTint.b / plain.b);
    const counts = new Array<number>(GRASS_KINDS).fill(0);
    for (const t of tufts) {
      const kx = Math.round(t.x * 100), kz = Math.round(t.z * 100);
      t.kind = Math.floor(hash(kx, kz, 5) * GRASS_KINDS);
      t.index = counts[t.kind]++;
      t.yaw = hash(kx, kz, 6) * Math.PI * 2;
    }
    this.grass = counts.map((count, kind) => {
      const mesh = new THREE.InstancedMesh(
        tuftGeometry(kind),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
        Math.max(1, count),
      );
      mesh.count = count;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    });
    const tint = new THREE.Color();
    for (const t of tufts) {
      const kx = Math.round(t.x * 100), kz = Math.round(t.z * 100);
      this.grass[t.kind!].setColorAt(t.index!, tint.copy(drab).multiplyScalar(0.9 + hash(kx, kz, 7) * 0.2));
    }

    // ---- meadows and dry patches: whole hexes of grass, each one instance of a patch of blades ----
    // Placed once and never again: the wind bends their blades in the shader, so a field costs no more each
    // frame than a single tuft does.
    // A meadow is drabbed in the wet port as the tufts are; a dry patch is not (the drab, made for green, would turn its straw to rust).
    const fields = (patches: FieldPatch[], kinds: number, geometry: (kind: number) => THREE.BufferGeometry, height: number, base: THREE.Color) => {
      for (let kind = 0; kind < kinds; kind++) {
        const list = patches.filter((m) => m.kind === kind);
        if (list.length === 0) continue;
        const material = new THREE.MeshLambertMaterial({ vertexColors: true });
        addFieldSway(material, height);
        const mesh = new THREE.InstancedMesh(geometry(kind), material, list.length);
        const at = new THREE.Matrix4();
        const up = new THREE.Vector3(0, 1, 0);
        const turn = new THREE.Quaternion();
        list.forEach((m, i) => {
          mesh.setMatrixAt(i, at.compose(new THREE.Vector3(m.x, m.y, m.z), turn.setFromAxisAngle(up, (m.turn * Math.PI) / 3), new THREE.Vector3(1, 1, 1)));
          mesh.setColorAt(i, tint.copy(base).multiplyScalar(0.94 + m.tone * 0.12));
        });
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    };
    fields(meadows, MEADOW_KINDS, meadowGeometry, MEADOW_H, drab);
    fields(drys, DRY_KINDS, dryGeometry, DRY_H, new THREE.Color(1, 1, 1));
    fields(talls, TALL_KINDS, tallGeometry, TALL_H, drab);

    // ---- dirt paths: a sheet of trodden earth on each path hex, all in one mesh ----
    // Each hex's dirt is the shape pathReach gives, sampled round its middle: often enough to be round where it
    // is round, and at the exact angles of each strip's corners and of the notches between strips. Its edge is
    // pushed in and out by a smooth wobble of where it lies in the world, so it is ragged, not ruled; a strip's
    // end, where it meets the next hex's, is left straight, and its corners move the same in both hexes (they
    // are the same point), so the two still meet. Out past the flat of the tile it bends down over the rounded
    // rim, so two hexes' strips meet in the seam between them. A pixel texture of grit and pebbles is laid over
    // it by world position.
    const pathPos: number[] = [];
    const pathCol: number[] = [];
    const pathUv: number[] = [];
    const dirt = wet ? new THREE.Color(0.88, 0.85, 0.82) : new THREE.Color(1, 1, 1);
    const flat = SIDE_REACH - TILE_FILLET;
    /** How far below the flat of the tile a point this far out (along the nearest side's normal) lies. */
    const sag = (x: number, z: number) => {
      const out = Math.max(...SIDE_WAY.map((w) => x * w.x + z * w.z));
      if (out <= flat) return 0;
      const over = Math.min(TILE_FILLET, out - flat);
      return TILE_FILLET - Math.sqrt(TILE_FILLET * TILE_FILLET - over * over);
    };
    /** The wobble of a path's edge at a world point: a smooth push, up to about a tenth of a unit, either way. */
    const wobble = (x: number, z: number) => [
      0.075 * (0.6 * Math.sin(x * 5.3 + z * 2.1) + 0.4 * Math.sin(x * 11.7 - z * 7.9 + 1.7)),
      0.075 * (0.6 * Math.sin(z * 4.9 - x * 2.7 + 0.8) + 0.4 * Math.sin(z * 12.3 + x * 8.3 + 2.9)),
    ];
    const shade = new THREE.Color();
    /** The grass that spills over the paths' edges, in world space. */
    const fringe: Blades = { pos: [], nor: [], col: [], root: [] };
    for (const t of tiles) {
      if (!t.path) continue;
      const p = place(t);
      const angles: number[] = [];
      for (let k = 0; k < 96; k++) angles.push((k / 96) * Math.PI * 2);
      const corner = Math.atan2(PATH_HALF, SIDE_REACH);
      const ends: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        if (!(t.path & (1 << i))) continue;
        const a = Math.atan2(SIDE_WAY[i].z, SIDE_WAY[i].x);
        ends.push([a - corner, a + corner]);
        for (const d of [0, corner - 1e-3, corner, corner + 1e-3, Math.PI / 6]) angles.push(a + d, a - d);
      }
      const ring = angles.map((a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b).filter((a, i, all) => i === 0 || a - all[i - 1] > 1e-5);
      /** Whether an angle looks out through the straight end of one of this hex's strips (not at its corners). */
      const atEnd = (a: number) => ends.some(([lo, hi]) => Math.sin(a - lo) > 2e-3 && Math.sin(hi - a) > 2e-3 && Math.cos(a - (lo + hi) / 2) > 0);
      /** The point at angle `a`, `f` of the way out to the dirt's edge, wobbled more the nearer the edge it is. */
      const point = (a: number, f: number) => {
        const r = pathReach(t.path!, a) * f;
        let dx = Math.cos(a) * r, dz = Math.sin(a) * r;
        if (!atEnd(a)) {
          const [wx, wz] = wobble(p.x + dx, p.z + dz);
          const k = Math.max(0, (f - 0.6) / 0.4);
          dx += wx * k;
          dz += wz * k;
        }
        return [p.x + dx, p.y + 0.012 - sag(dx, dz), p.z + dz];
      };
      const put = (v: number[], tint?: THREE.Color) => {
        pathPos.push(v[0], v[1], v[2]);
        shade.copy(dirt).multiplyScalar(0.93 + hash(Math.round(v[0] * 23), Math.round(v[2] * 23), 41) * 0.12);
        if (tint) shade.multiply(tint);
        pathCol.push(shade.r, shade.g, shade.b);
        pathUv.push(v[0] / BOARD_SPAN, v[2] / BOARD_SPAN);
      };
      // The fringe: short blades rooted all along the ragged edge, just behind the ridge, standing up and leaning a
      // little away from the path, so the grass crowds the edge without the wind laying it over the dirt. None at
      // a strip's end, where it runs on into the next hex.
      for (let k = 0; k < 72; k++) {
        const a = ((k + hash(t.q, t.r, 300 + k) * 0.8) / 72) * Math.PI * 2;
        if (atEnd(a)) continue;
        const edge = point(a, 1);
        const ox = edge[0] - p.x, oz = edge[2] - p.z;
        const out = Math.hypot(ox, oz) || 1;
        // Not out over the rounded rim of the tile, where the dirt bends down into the seam.
        if (out > SIDE_REACH - TILE_FILLET - 0.02) continue;
        const r = (i: number) => hash(t.q * 7 + k, t.r * 13 + i, 311);
        for (let j = 0; j < 2; j++) {
          const back = 0.11 + r(j * 5) * 0.07;
          const rx = edge[0] + (ox / out) * back, rz = edge[2] + (oz / out) * back;
          // Leaning out, away from the path, give or take.
          const lean = Math.atan2(oz, ox) + (r(j * 5 + 1) - 0.5) * 1.6;
          const tones = r(j * 5 + 2) < 0.12 ? SEEDING : GREEN;
          const h = 0.1 + r(j * 5 + 3) * 0.1;
          const start = fringe.pos.length;
          const rootStart = fringe.root.length;
          pushBlade(fringe, rx - p.x, rz - p.z, Math.cos(lean), Math.sin(lean), lean + Math.PI / 2, h, 0.025 + r(j * 5 + 4) * 0.02, 0.25 + r(j * 5 + 2) * 0.35, 0.86 + r(j * 5 + 3) * 0.24, tones);
          // pushBlade builds about (0, 0); lift it to where the hex lies.
          for (let v = start; v < fringe.pos.length; v += 3) {
            fringe.pos[v] += p.x;
            fringe.pos[v + 1] += p.y + 0.012;
            fringe.pos[v + 2] += p.z;
          }
          for (let v = rootStart; v < fringe.root.length; v += 2) {
            fringe.root[v] += p.x;
            fringe.root[v + 1] += p.z;
          }
        }
      }
      // Three rings out from the middle (the flat, the start of the rim, the edge), so the bend over the rim follows it.
      const steps = [0.8, 0.92, 1];
      const middle = [p.x, p.y + 0.012, p.z];
      for (let k = 0; k < ring.length; k++) {
        const a0 = ring[k], a1 = ring[(k + 1) % ring.length];
        let in0 = middle, in1 = middle;
        for (const f of steps) {
          const o0 = point(a0, f), o1 = point(a1, f);
          // Wound so they face up.
          if (in0 === middle) for (const v of [middle, o1, o0]) put(v);
          else for (const v of [in0, o1, o0, in0, in1, o1]) put(v);
          in0 = o0;
          in1 = o1;
        }
      }
      // The ridges: a low bank of earth thrown up along each side of the path, as round a puddle: shaded dirt
      // rising from the path, a lit crest, and a foot gone olive where it runs out under the grass. It follows the
      // ragged edge, stops short of the tile's rounded rim, and leaves a strip's end open into the next hex.
      const edge = ring.map((a) => ({ v: point(a, 1), end: atEnd(a) }));
      const bank = edge.map(({ v }, k) => {
        const prev = edge[(k + edge.length - 1) % edge.length].v, next = edge[(k + 1) % edge.length].v;
        let nx = next[2] - prev[2], nz = -(next[0] - prev[0]);
        const len = Math.hypot(nx, nz) || 1;
        nx /= len;
        nz /= len;
        if (nx * (v[0] - p.x) + nz * (v[2] - p.z) < 0) [nx, nz] = [-nx, -nz];
        const y = p.y + 0.012;
        return [
          [v[0] - nx * 0.02, y, v[2] - nz * 0.02],
          [v[0] + nx * 0.045, y + 0.03, v[2] + nz * 0.045],
          [v[0] + nx * 0.11, p.y + 0.004, v[2] + nz * 0.11],
        ];
      });
      const rim = SIDE_REACH - TILE_FILLET - 0.13;
      const tints = [RIDGE_FOOT_IN, RIDGE_CREST, RIDGE_FOOT_OUT];
      for (let k = 0; k < edge.length; k++) {
        const k1 = (k + 1) % edge.length;
        if (edge[k].end || edge[k1].end) continue;
        if ([edge[k].v, edge[k1].v].some((v) => Math.hypot(v[0] - p.x, v[2] - p.z) > rim)) continue;
        for (let j = 0; j < 2; j++) {
          const i0 = bank[k][j], i1 = bank[k1][j], o0 = bank[k][j + 1], o1 = bank[k1][j + 1];
          const ti = tints[j], to = tints[j + 1];
          put(i0, ti); put(o1, to); put(o0, to);
          put(i0, ti); put(i1, ti); put(o1, to);
        }
      }
    }
    if (pathPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pathPos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(pathCol, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(pathUv, 2));
      geo.computeVertexNormals();
      const map = pathTexture();
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, vertexColors: true }));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (fringe.pos.length > 0) {
      // One instance, placed where it was built, so the field sway (which works per instance) bends it in the wind.
      const material = new THREE.MeshLambertMaterial({ vertexColors: true });
      addFieldSway(material, 0.25);
      const mesh = new THREE.InstancedMesh(bladesGeometry(fringe), material, 1);
      mesh.setMatrixAt(0, new THREE.Matrix4());
      mesh.setColorAt(0, drab);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // ---- puddles: standing water on the mud and in the dips of the street ----
    // Each is a real hollow, not a picture of one: a low bank of earth or stone thrown up round a dip,
    // with the water lying in it below the lip. The bank takes the light and the shadows like the ground does.
    const pools: { m: THREE.Matrix4; stone: boolean }[] = [];
    for (const t of tiles) {
      const stone = (t.biome as string) === "cobble";
      const wet = (t.biome as string) === "mud" ? 0.45 : stone ? 0.22 : 0;
      if (wet === 0 || skip(t) || hash(t.q, t.r, 400) > wet) continue;
      const p = place(t);
      const size = 0.28 + hash(t.q, t.r, 401) * 0.3;
      pools.push({
        stone,
        m: new THREE.Matrix4().compose(
          new THREE.Vector3(p.x + (hash(t.q, t.r, 402) - 0.5) * 0.7, p.y, p.z + (hash(t.q, t.r, 403) - 0.5) * 0.7),
          // Turned any way round: each hollow is longer than it is wide, and no two lie alike.
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, hash(t.q, t.r, 404) * Math.PI * 2, 0)),
          new THREE.Vector3(size * 0.95, 0.035 + size * 0.06, size * 0.62),
        ),
      });
    }
    if (pools.length > 0) {
      const { bank, water } = hollowGeometry();
      const banks = new THREE.InstancedMesh(bank, new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide }), pools.length);
      const waters = new THREE.InstancedMesh(water, new THREE.MeshLambertMaterial({ color: "#3b4a63", flatShading: true, side: THREE.DoubleSide }), pools.length);
      const earth = new THREE.Color("#4f4335");
      const cobble = new THREE.Color("#5c5f66");
      pools.forEach((pool, i) => {
        banks.setMatrixAt(i, pool.m);
        banks.setColorAt(i, pool.stone ? cobble : earth);
        waters.setMatrixAt(i, pool.m);
      });
      banks.receiveShadow = true;
      waters.receiveShadow = true;
      this.group.add(banks, waters);
    }

    // ---- splashes: where the sea meets rock (hills, the rampart), it breaks in little pixel bursts ----
    {
      const byKey = new Map(tiles.map((t) => [`${t.q},${t.r}`, t]));
      const rocky = new Set(["hills", "rampart"]);
      const splashes: typeof this.splashes = [];
      for (const t of tiles) {
        if (!rocky.has(t.biome as string) || skip(t)) continue;
        const p = place(t);
        for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const nb = byKey.get(`${t.q + dq},${t.r + dr}`);
          if (!nb || (nb.biome as string) !== "water") continue;
          const o = place(nb);
          const dx = o.x - p.x, dz = o.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          // One or two spots along each wet edge, a little apart, so a long shore does not pulse in step.
          const count = 1 + (hash(t.q * 3 + dq, t.r * 5 + dr, 700) < 0.4 ? 1 : 0);
          for (let i = 0; i < count; i++) {
            const along = (hash(t.q + i, t.r + dq * 7 + dr, 701) - 0.5) * 0.9;
            splashes.push({
              x: (p.x + o.x) / 2 - (dz / len) * along,
              z: (p.z + o.z) / 2 + (dx / len) * along,
              y: o.y + 0.02,
              nx: dx / len,
              nz: dz / len,
              phase: hash(t.q, t.r, 702 + i * 3 + dq) * 10,
              period: 2.2 + hash(t.q, t.r, 703 + i + dr) * 2.6,
            });
          }
        }
      }
      this.shoreSplashes = splashes;
      this.rockSplashes = [];
      this.layOutSplashes();
    }

    // ---- weather: outdoors the sky changes with the clock (see weather()); a port with streets is wetter than an island ----
    this.wetPort = tiles.some((t) => (t.biome as string) === "cobble");
    this.outdoors = !tiles.some((t) => (t.biome as string) === "floor");
    if (this.outdoors && !this.still) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DROPS * 2 * 3), 3));
      this.rain = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, color: "#b9c7dc", transparent: true, opacity: 0.42, depthWrite: false }));
      this.rain.frustumCulled = false;
      this.group.add(this.rain);
    }

    // ---- wisps: thin ribbons that sway gently as they cross ----
    // No wind indoors.
    const indoors = (this.indoors = tiles.some((t) => (t.biome as string) === "floor" || (t.biome as string) === "cave"));
    const count = this.still || indoors ? 0 : Math.min(14, Math.max(7, Math.round(tiles.length / 30)));
    for (let i = 0; i < count; i++) {
      this.wisps.push({ offset: hash(i, 4, 100), speed: 0.1 + hash(i, 5, 100) * 0.07 });
    }
    if (count > 0) {
      // Two corners per point along the trail, one each side, joined point to point into a strip.
      const corners = count * TRAIL * 2;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(corners * 3), 3));
      geometry.setAttribute("aDir", new THREE.BufferAttribute(new Float32Array(corners * 3), 3));
      geometry.setAttribute("aTint", new THREE.BufferAttribute(new Float32Array(corners * 4), 4));
      geometry.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array(corners).map((_, k) => (k % 2 ? 1 : -1)), 1));
      const index: number[] = [];
      for (let n = 0; n < count; n++) {
        for (let i = 0; i < TRAIL - 1; i++) {
          const a = (n * TRAIL + i) * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      geometry.setIndex(index);
      this.wispRibbon = new THREE.Mesh(geometry, wispMaterial(this.pixelView));
      this.wispRibbon.frustumCulled = false;
      trackView(this.wispRibbon, this.pixelView);
      this.group.add(this.wispRibbon);
    }
  }

  private clear() {
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh | THREE.Points;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.Material & { map?: THREE.Texture | null };
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
    this.grass = [];
    this.waves = [];
    this.wispRibbon = null;
    this.rain = null;
    this.splashPoints = null;
    this.splashes = [];
    this.shoreSplashes = [];
    this.rockSplashes = [];
    this.tufts = [];
    this.crests = [];
    this.wisps = [];
  }

  dispose() {
    this.clear();
    this.setSmoke([]);
    this.setBeacon(null);
    this.setGlows([], []);
    this.scene.remove(this.hemi, this.sun, this.sun.target, this.lamp, this.fireLight, ...this.slots, ...this.glows, ...this.fadeGlows, this.group);
    this.lamp.shadow.map?.dispose();
    this.fireLight.shadow.map?.dispose();
    for (const s of this.slots) s.shadow.map?.dispose();
    this.sun.shadow.map?.dispose();
  }

  /** Time of day from 0 to 1: 0 is midnight, 0.5 is noon. */
  /**
   * The weather, 0 (clear) to 1 (heavy rain), from the wall clock like the time of day, so a crew shares one sky.
   * A new spell starts every few minutes and the sky eases from one to the next. The Harbor runs wetter than an island.
   */
  private weather(): number {
    if (devTools.on) {
      const forced = (globalThis as { __gqWeather?: number }).__gqWeather;
      if (typeof forced === "number") return forced;
    }
    const at = Date.now() / WEATHER_SPELL_MS;
    const spell = Math.floor(at);
    const bias = this.wetPort ? 0.12 : -0.08;
    const of = (k: number) => Math.max(0, Math.min(1, hash(k, 7, 700) + bias));
    // Hold each spell for most of its length, then ease into the next.
    const blend = smooth(0.7, 1, at - spell);
    return of(spell) * (1 - blend) + of(spell + 1) * blend;
  }

  /**
   * Whether this spell of weather is a storm, 0 to 1: a downpour with thunder and lightning. Its own
   * kind of weather, not just the heaviest rain: about half of the heaviest spells are storms, and the
   * rest are plain downpours. Shared by a crew, like the weather itself.
   */
  private stormy(): number {
    if (devTools.on) {
      const forced = (globalThis as { __gqStorm?: number }).__gqStorm;
      if (typeof forced === "number") return forced;
      // Holding the weather by hand holds the storm off too, unless it is asked for.
      if (typeof (globalThis as { __gqWeather?: number }).__gqWeather === "number") return 0;
    }
    const at = Date.now() / WEATHER_SPELL_MS;
    const spell = Math.floor(at);
    const bias = this.wetPort ? 0.12 : -0.08;
    const of = (k: number) => (hash(k, 7, 700) + bias > 0.85 && hash(k, 11, 700) < 0.5 ? 1 : 0);
    const blend = smooth(0.7, 1, at - spell);
    return of(spell) * (1 - blend) + of(spell + 1) * blend;
  }

  private timeOfDay(): number {
    if (devTools.on) {
      const forced = (globalThis as { __gqTime?: number }).__gqTime;
      if (typeof forced === "number") return forced;
    }
    return (Date.now() % DAY_MS) / DAY_MS;
  }

  /** Advance the sky and everything that sways. `yaw` is the camera's turn; `target` is what it looks at. */
  /** `focus`, if given, is where your own hero stands: the lights near you are the ones that matter. */
  update(clock: number, yaw: number, target: THREE.Vector3, focus?: THREE.Vector3) {
    this.light(target, clock);
    this.fall(clock, target);
    this.puff(clock);
    this.sweep(clock);
    this.glimmer(clock);
    this.splash(clock);
    this.flicker(clock, focus ?? target);
    const motion = this.still ? 0 : 1;

    if (this.grass.length > 0) {
      // With the fancy wind, every tuft leans the way the wind blows, by the gust passing over it, so the
      // gusts can be seen crossing the grass. Without it, each sways to and fro in its own time.
      const blowing = windPower() > 0;
      setFieldCalm(blowing ? 0 : motion);
      for (const t of this.tufts) {
        // A slow swell with a quicker flutter on top, rolling across the island.
        const lean = blowing
          ? gustAt(t.x, t.z) * 0.55 + Math.sin(clock * 3.1 + t.phase * 1.7) * 0.05 * windPower()
          : motion * (Math.sin(clock * 1.3 + t.phase) * 0.22 + Math.sin(clock * 3.1 + t.phase * 1.7) * 0.07 + 0.08);
        const w = t.size * 1.4;
        const h = t.size * 1.45;
        const cos = Math.cos(t.yaw!);
        const sin = Math.sin(t.yaw!);
        // Columns: its own turn about y, scaled, with the up column sheared downwind so it bends from the root.
        this.m.set(
          cos * w, WIND_DIR.x * lean * h, sin * w, t.x,
          0, h, 0, t.y,
          -sin * w, WIND_DIR.z * lean * h, cos * w, t.z,
          0, 0, 0, 1,
        );
        this.grass[t.kind!].setMatrixAt(t.index!, this.m);
      }
      for (const mesh of this.grass) mesh.instanceMatrix.needsUpdate = true;
    }

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.waves.forEach((mesh, row) => {
      // The fancy water makes its own waves; the paper crests would sit oddly on it.
      mesh.visible = !this.smoothSea;
      // Front row (toward the camera) is row 1.
      const off = row ? WAVE_ROW : -WAVE_ROW;
      this.crests.forEach((c, i) => {
        const bob = motion * Math.sin(clock * 1.8 + c.phase * 2 + row * 1.6) * 0.03;
        this.m.set(
          cos, 0, sin, c.x + sin * off,
          0, 1, 0, c.y + bob - (row ? 0.03 : 0),
          -sin, 0, cos, c.z + cos * off,
          0, 0, 0, 1,
        );
        mesh.setMatrixAt(i, this.m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(this.flatTint);
      material.map!.offset.x = motion * clock * (row ? 0.11 : -0.08) + row * 0.25;
    });

    if (this.wispRibbon) {
      const pos = this.wispRibbon.geometry.getAttribute("position") as THREE.BufferAttribute;
      const dir = this.wispRibbon.geometry.getAttribute("aDir") as THREE.BufferAttribute;
      const col = this.wispRibbon.geometry.getAttribute("aTint") as THREE.BufferAttribute;
      const glow = 0.72 + 0.28 * this.daylight;
      const b = this.bounds;
      this.wisps.forEach((w, n) => {
        const t = clock * w.speed + w.offset;
        // Every crossing is a new gust: its own place, height, length and sway.
        const gust = Math.floor(t);
        const r = (salt: number) => hash(n + 1, gust, 200 + salt);
        const head = t - gust;
        const x0 = b.minX + r(1) * (b.maxX - b.minX);
        const y0 = 1.2 + r(2) * 2.6;
        const z0 = b.minZ + r(3) * (b.maxZ - b.minZ);
        const reach = 4 + r(4) * 3;
        // A long, soft wave with a fainter, slower one under it, so no two gusts sway alike.
        const swell = 0.12 + r(10) * 0.1;
        const beat = 7 + r(11) * 6;
        const under = 0.06 + r(8) * 0.06;
        const underBeat = 3 + r(9) * 3;
        const drift = (r(12) - 0.5) * 0.8;
        const life = smooth(0, 0.12, head) * (1 - smooth(0.66, 1, head));
        /** Where the trail is at `s` along the gust's path. */
        const at = (s: number, out: THREE.Vector3) => {
          const along = (s - 0.5) * reach;
          const up = Math.sin(s * beat + r(13) * 6) * swell + Math.sin(s * underBeat + r(6) * 6) * under + (s - 0.5) * drift;
          return out.set(x0 + WIND.x * along, y0 + up, z0 + WIND.z * along);
        };
        for (let i = 0; i < TRAIL; i++) {
          // Each point follows the head a little further back along the same path.
          const s = head - i * 0.0095;
          at(s, this.wispAt);
          // Which way the trail runs here, for the ribbon's width to lie across it.
          at(s + 0.0095, this.wispAhead).sub(at(s - 0.0095, this.wispBehind));
          // Fades toward the tail, and the whole trail fades in at the start of a crossing and out over its last third.
          const fade = s <= 0 ? 0 : life * (1 - i / TRAIL) ** 0.8;
          for (let side = 0; side < 2; side++) {
            const k = (n * TRAIL + i) * 2 + side;
            pos.setXYZ(k, this.wispAt.x, this.wispAt.y, this.wispAt.z);
            dir.setXYZ(k, this.wispAhead.x, this.wispAhead.y, this.wispAhead.z);
            col.setXYZW(k, 1, 0.95 + 0.05 * this.daylight, glow, fade * (0.55 + 0.35 * this.daylight));
          }
        }
      });
      pos.needsUpdate = true;
      dir.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  /** Rain: each drop is two pixels, one above the other, falling on a slant with the wind around wherever the camera looks. */
  private fall(clock: number, target: THREE.Vector3) {
    if (!this.rain) return;
    const pos = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    // Only as many drops fall as the weather calls for; the rest wait out of sight.
    const falling = Math.round(DROPS * this.rainfall);
    (this.rain.material as THREE.PointsMaterial).opacity = 0.2 + 0.25 * this.rainfall;
    this.rain.visible = falling > 0;
    for (let i = 0; i < DROPS; i++) {
      if (i >= falling) {
        pos.setXYZ(i * 2, 0, -100, 0);
        pos.setXYZ(i * 2 + 1, 0, -100, 0);
        continue;
      }
      const life = (clock * (0.9 + hash(i, 1, 500) * 0.5) + hash(i, 2, 500)) % 1;
      const y = 8 * (1 - life);
      // Drops are spread around wherever the camera looks, and blown downwind as they fall.
      const x = target.x + (hash(i, 3, 500) - 0.5) * 30 + life * 2.2 * WIND.x;
      const z = target.z + (hash(i, 4, 500) - 0.5) * 30 + life * 2.2 * WIND.z;
      pos.setXYZ(i * 2, x, y, z);
      pos.setXYZ(i * 2 + 1, x - 0.07 * WIND.x, y + 0.24, z - 0.07 * WIND.z);
    }
    pos.needsUpdate = true;
  }

  /** Draw smoke rising from these points (chimney tops). An empty list clears it. */
  /** Light or put out a hut's hanging lamp. */
  /** Where each hero's torch is in the caverns this frame (at most four). Ignored outside them. */
  setTorches(at: THREE.Vector3[]) {
    if (!this.cave) return;
    this.torchCount = Math.min(at.length, this.torches.length);
    for (let i = 0; i < this.torchCount; i++) this.torches[i].position.set(at[i].x + 0.25, at[i].y + 1.15, at[i].z + 0.15);
  }

  setLampOn(on: boolean) {
    if (on === this.lampOn) return;
    this.lampOn = on;
    this.lanternMat?.color.set(on ? "#ffe2a8" : "#4a3f30");
    // The lamp's map has been left alone while it was out, and the small lights change their reach with it (see flicker).
    this.stirAll();
  }

  /** The lights the props ask for (hearths, campfires, candles, lanterns) and the flames to flicker. The meshes belong to the caller. */
  setLights(lights: { pos: THREE.Vector3; kind: LightKind }[], flames: THREE.Mesh[]) {
    this.lights = lights;
    this.flames = flames;
    // Called whenever a piece is placed, moved, turned or taken away: every shadow in the room may have changed.
    this.stirAll();
  }

  /**
   * The lanterns hung over the pub's game tables (see TableLamps). They share the plain lights with the candles
   * past the shadow slots, nearest first, so they never add a light or a shadow map. Same objects every frame.
   */
  setTableLamps(lamps: LampLight[]) {
    this.tableLamps = lamps;
  }

  /** Redraw every indoor shadow map on the next frame: the room itself changed (a piece, a wall, the lamp). */
  stirAll() {
    this.lamp.shadow.needsUpdate = true;
    this.slots.forEach((s, i) => {
      s.shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
    });
    this.stirred.clear();
  }

  /**
   * Something that throws a shadow (a hero) moved at `at`, or appeared or went
   * away there. Call it for where it was as well as where it is, so a shadow
   * left behind is cleared. The maps of the lights within reach are redrawn:
   * the lamp's straight away, the others a few a frame (see settleShadows).
   */
  stir(at: THREE.Vector3) {
    if (!this.indoors) return;
    if (this.lampOn) this.lamp.shadow.needsUpdate = true;
    this.slots.forEach((s, i) => {
      if (!this.slotOf[i] || s.shadow.needsUpdate) return;
      const reach = s.distance + STIR_MARGIN;
      if (s.position.distanceToSquared(at) <= reach * reach) this.stirred.add(i);
    });
  }

  /**
   * Hand out this frame's redraws, just before drawing: the slot nearest your
   * hero every frame (its shadow is the one you look at), then the ones that
   * have waited longest. Standing still, nothing is redrawn.
   */
  settleShadows() {
    this.frameNo++;
    if (this.stirred.size === 0) return;
    const waiting = [...this.stirred];
    let first = waiting[0];
    for (const i of waiting) if (this.slots[i].position.distanceToSquared(this.focus) < this.slots[first].position.distanceToSquared(this.focus)) first = i;
    const order = [first, ...waiting.filter((i) => i !== first).sort((a, b) => this.drawnAt[a] - this.drawnAt[b])];
    for (const i of order.slice(0, MOVE_REDRAWS)) {
      this.slots[i].shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
      this.stirred.delete(i);
    }
  }

  /**
   * Give the slots to these lights (the nearest few). A slot keeps its light while that light is still wanted,
   * so walking hands over only the slot whose light fell out. That slot's shadow fades out first (its weight
   * eases to 0), and only then is the slot moved to the new piece, redrawn once, and faded in.
   */
  private assignSlots(want: { pos: THREE.Vector3; kind: LightKind }[], dt: number) {
    const same = (a: { pos: THREE.Vector3; kind: LightKind }, b: { pos: THREE.Vector3; kind: LightKind }) => a.kind === b.kind && a.pos.distanceToSquared(b.pos) < 1e-6;
    const step = dt / SLOT_FADE;
    const left = [...want];
    const free: number[] = [];
    this.slotOf.forEach((cur, i) => {
      if (!cur) {
        free.push(i);
        return;
      }
      const k = left.findIndex((l) => same(l, cur));
      if (k >= 0) {
        // Still wanted (perhaps again, part way through fading out): ease back up.
        this.slotOf[i] = left[k];
        left.splice(k, 1);
        this.slotWeight[i] = Math.min(1, this.slotWeight[i] + step);
        return;
      }
      // No longer wanted. A piece taken out of the room goes at once; one walked away from fades out first.
      const still = this.lights.find((l) => same(l, cur));
      this.slotWeight[i] = still ? Math.max(0, this.slotWeight[i] - step) : 0;
      if (still) this.slotOf[i] = still;
      if (this.slotWeight[i] > 0) return;
      this.slotOf[i] = null;
      free.push(i);
    });
    for (const i of free) {
      const next = left.shift() ?? null;
      this.slotOf[i] = next;
      if (!next) continue;
      this.slotWeight[i] = this.freshRoom ? 1 : 0;
      this.slots[i].position.copy(next.pos);
      this.slots[i].shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
      this.stirred.delete(i);
    }
    this.freshRoom = false;
  }

  /** Lick the flames up and down, and let the lights breathe with them. */
  private flicker(clock: number, target: THREE.Vector3) {
    const motion = this.still ? 0 : 1;
    for (const f of this.flames) {
      const k = f.userData.flame as number;
      const seed = k * 1.7 + f.position.x * 9.1 + f.position.z * 5.3;
      // Steps rather than a smooth swell, so it reads as pixel fire.
      const step = Math.floor(clock * 9 + seed);
      const jitter = hash(step, k, 900);
      f.scale.y = 1 + motion * (Math.sin(clock * 6.3 + seed) * 0.18 + (jitter - 0.5) * 0.45);
      f.scale.x = f.scale.z = 1 + motion * (hash(step, k, 901) - 0.5) * 0.25;
    }
    // Indoors the lights are part of the room; outdoors they show only as the day goes.
    const dusk = this.indoors ? 1 : 1 - this.daylight;
    const near = (a: { pos: THREE.Vector3 }, b: { pos: THREE.Vector3 }) => a.pos.distanceToSquared(target) - b.pos.distanceToSquared(target);
    const sorted = (this.indoors ? [...this.lights] : [...this.lights, ...this.poiLights]).sort(near);
    this.focus.copy(target);

    if (this.indoors) {
      // Indoors the nearest few each throw shadows. A piece already holding a slot keeps it until another is
      // clearly nearer (SLOT_HOLD), so walking along the edge between two never hands a slot back and forth.
      // Matched by place, since setLights hands over new objects for the same pieces.
      const slotted = (l: { pos: THREE.Vector3; kind: LightKind }) => this.slotOf.some((o) => o && o.kind === l.kind && o.pos.distanceToSquared(l.pos) < 1e-6);
      // A fire is the brightest thing in the room and throws the longest shadows, so it counts as a little nearer.
      const keyed = sorted.map((l) => ({ l, d: l.pos.distanceTo(target) - (slotted(l) ? SLOT_HOLD : 0) - (l.kind === "fire" ? FIRE_PULL : 0) }));
      keyed.sort((a, b) => a.d - b.d);
      const dt = Math.min(0.1, Math.max(0, clock - this.lastClock));
      this.lastClock = clock;
      this.assignSlots(keyed.slice(0, SHADOW_SLOTS).map((k) => k.l), dt);
      // Only their strength changes from frame to frame (the flicker and the fades), which needs no redraw of
      // their maps; their place and reach change only when a slot is handed to another piece.
      this.slots.forEach((s, i) => {
        const l = this.slotOf[i];
        if (!l) {
          // Kept in the scene (at no strength) rather than hidden, so the light count stays fixed.
          s.intensity = 0;
          return;
        }
        const look = this.roomLook(l, clock, motion);
        this.reach(s, look.distance, look.decay);
        s.color.set(look.color);
        s.intensity = look.intensity * this.slotWeight[i];
      });
      // Whatever share of a piece's light its slot does not carry (all of it, for a piece with no slot) goes to a
      // plain light in the same spot with the same look, so the piece is always exactly as bright: handing it to
      // or from a slot only fades its shadow in or out.
      const share = (l: { pos: THREE.Vector3; kind: LightKind }) => {
        const i = this.slotOf.indexOf(l);
        return i < 0 ? 1 : 1 - this.slotWeight[i];
      };
      // The table lanterns join them here, nearest first with the rest.
      const rest: { pos: THREE.Vector3; color: THREE.ColorRepresentation; distance: number; decay: number; intensity: number }[] = [
        ...sorted.filter((l) => share(l) > 0.001).map((l) => {
          const look = this.roomLook(l, clock, motion);
          return { pos: l.pos, ...look, intensity: look.intensity * share(l) };
        }),
        ...this.tableLamps.map((l) => ({ pos: l.pos, color: this.lampColor.set("#ffa64d").lerp(FLARE_WHITE, Math.min(1, l.flare * 0.6)).getHex(), distance: 3, decay: 2, intensity: l.power })),
      ].sort(near);
      [...this.glows, ...this.fadeGlows].forEach((g, i) => {
        const l = rest[i];
        if (!l) {
          g.intensity = 0;
          return;
        }
        g.position.copy(l.pos);
        g.color.set(l.color);
        g.distance = l.distance;
        g.decay = l.decay;
        g.intensity = l.intensity;
      });
      return;
    }

    // Outdoors the nearest campfire glows once the light starts to go; nothing but the sun throws shadows.
    const fire = sorted.find((l) => l.kind === "fire");
    const light = this.fireLight;
    light.castShadow = false;
    if (fire) {
      light.position.copy(fire.pos);
      light.color.set("#ff9548");
      light.distance = 6;
      light.decay = 2;
      light.intensity = 3.2 * dusk * this.waver(clock, 0, motion);
    } else {
      // Kept in the scene (at no strength) rather than hidden, so the light count stays fixed.
      light.intensity = 0;
    }
    const rest = sorted.filter((l) => l !== fire);

    // Everything else, nearest first, shares the plain lights.
    this.glows.forEach((g, i) => {
      const l = rest[i];
      if (!l) {
        g.intensity = 0;
        return;
      }
      const look = GLOW[l.kind];
      g.position.copy(l.pos);
      g.color.set(look.color);
      g.distance = look.range;
      g.decay = 2;
      g.intensity = look.power * dusk * (look.flicker ? this.waver(clock, i + 1, motion) : 1);
    });
  }

  /**
   * How a candle, lantern or fire lights a room, the same whether it holds a shadow slot or a plain light.
   * Its flicker is keyed to the piece's place, not to the light carrying it, so it never jumps on a hand-over.
   */
  private roomLook(l: { pos: THREE.Vector3; kind: LightKind }, clock: number, motion: number): { color: string; distance: number; decay: number; intensity: number } {
    const wave = this.waver(clock, Math.abs(Math.floor(l.pos.x * 13 + l.pos.z * 7)) % 7, motion);
    if (l.kind === "fire") return { color: "#ff9548", distance: 6, decay: 2, intensity: 3.2 * wave };
    const look = GLOW[l.kind];
    const flick = look.flicker ? wave : 1;
    // Under the lamp a small light is only a warm spot, as it always was; its shadow is a faint one close by.
    if (this.lampOn) return { color: look.color, distance: look.range, decay: 2, intensity: look.power * flick };
    // With the lamp out the small lights carry the room: more reach, fading gently (decay 1), so a hero a hex or
    // two away still throws a shadow you can see. Several share the room, so each is softer than the one shadow
    // light there used to be.
    return { color: look.color, distance: Math.max(look.range * 2, 6), decay: 1, intensity: look.power * 2.6 * flick };
  }

  /** Set a slot's reach and falloff. A new reach moves its shadow camera's far plane, so its map is redrawn. */
  private reach(s: THREE.PointLight, distance: number, decay: number) {
    s.decay = decay;
    if (s.distance === distance) return;
    s.distance = distance;
    s.shadow.needsUpdate = true;
  }

  /** A gentle unsteadiness for a flame's light, different for each `n`. */
  private waver(clock: number, n: number, motion: number): number {
    return 1 + motion * (Math.sin(clock * (8.1 + n * 0.7) + n) * 0.07 + Math.sin(clock * 13.7 + 1.3 + n * 2.1) * 0.05 + (hash(Math.floor(clock * 9), 3 + n, 902) - 0.5) * 0.1);
  }

  setSmoke(stacks: THREE.Vector3[]) {
    if (this.smoke) {
      this.scene.remove(this.smoke);
      this.smoke.geometry.dispose();
      (this.smoke.material as THREE.Material).dispose();
      this.smoke = null;
    }
    this.stacks = stacks;
    if (stacks.length === 0) return;
    // One low-poly ball per lump of every puff; `puff` places and sizes them.
    this.smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), smokeMaterial(), stacks.length * PUFFS * LOBES);
    this.smoke.frustumCulled = false;
    this.scene.add(this.smoke);
  }

  /**
   * Put a lighthouse's turning beam at `at` (the middle of its lantern), or take it away with null.
   * Each beam is an open cone lying on its side, apex in the lantern, coloured by a ramp that fades to black
   * along its length: drawn additively, black adds nothing, so it thins out to nothing with no hard end.
   * `scale` is how big the tower is drawn (1 is the size it is modelled at): the beams and the lantern's glow
   * grow with it, and the beams reach further again, well out over the water. `shine` is the light on the ironwork
   * round the lamp (see `beaconShine`), which follows the beams round.
   */
  setBeacon(at: THREE.Vector3 | null, scale = 1, shine?: THREE.ShaderMaterial) {
    if (this.beacon) {
      this.scene.remove(this.beacon.root);
      this.beacon.root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) o.geometry.dispose();
      });
      this.beacon.beams.map?.dispose();
      this.beacon.beams.dispose();
      this.beacon.glow.map?.dispose();
      this.beacon.glow.dispose();
      this.beacon = null;
    }
    if (!at) return;
    // A cone's apex is the top of the texture (the canvas's first row), its open end the bottom.
    const beams = new THREE.MeshBasicMaterial({
      map: ramp([[0, "#fff1c0"], [0.1, "#c9a650"], [0.45, "#3a2f14"], [1, "#000000"]], 2, 64, false),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const root = new THREE.Group();
    root.position.copy(at);
    const spin = new THREE.Group();
    root.add(spin);
    // A tower drawn bigger throws a longer beam, not only a fatter one.
    const LENGTH = 3.4 * scale * (scale > 1 ? 1.6 : 1);
    for (const side of [1, -1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5 * scale, LENGTH, 14, 1, true), beams);
      // Lay it on its side with the apex at the lantern, pointing out along x (and back, for the second beam).
      cone.rotation.z = (side * Math.PI) / 2;
      cone.position.x = (side * LENGTH) / 2;
      // Level with the middle of the lantern's glass, so the beam leaves the lamp and clears the gallery's floor and rail.
      cone.position.y = 0.06 * scale;
      cone.renderOrder = 2;
      spin.add(cone);
    }
    const glow = new THREE.SpriteMaterial({
      // A haze, not a ball of light: warm and dim at its middle, so the lamp, the glass and the dark bars across
      // it still read through it, and fading out smoothly with no bright core of its own (the lamp is the core).
      map: ramp([[0, "#a37c34"], [0.3, "#6e5120"], [0.65, "#261b09"], [1, "#000000"]], 64, 64, true),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const halo = new THREE.Sprite(glow);
    halo.renderOrder = 2;
    // The glow is a flat sheet facing the eye. Left at the lamp, the near half of the lantern (its roof, its bars,
    // the gallery rail) would cut it off along a hard line; so it is held just in front of the lantern, toward
    // whoever is looking, and spills over the ironwork the way a bright lamp does. Anything nearer still hides it.
    const reach = 0.45 * scale;
    const toEye = new THREE.Vector3();
    halo.onBeforeRender = (_renderer, _scene, camera) => {
      toEye.setFromMatrixPosition(camera.matrixWorld).sub(root.position).normalize().multiplyScalar(reach);
      halo.position.copy(toEye);
      halo.updateMatrixWorld();
    };
    root.add(halo);
    root.traverse((o) => (o.frustumCulled = false));
    this.scene.add(root);
    if (shine) {
      (shine.uniforms.uCentre.value as THREE.Vector3).copy(at);
      // The glazing bars stand this far from the lamp: the brightest ironwork. Further out it is dimmer.
      shine.uniforms.uNear.value = 0.17 * scale;
    }
    this.beacon = { root, spin, beams, glow, halo, scale, shine };
  }

  /** The lighthouse's beam turns slowly; faint by day, plain at dusk and night. */
  private sweep(clock: number) {
    const b = this.beacon;
    if (!b) return;
    const dark = this.night;
    // A full turn every 24 seconds or so: slow enough to be calm, never a strobe. Held still when motion is reduced.
    b.spin.rotation.y = this.still ? 0.6 : clock * 0.26;
    b.beams.opacity = 0.06 + 0.5 * dark;
    // The glow breathes very gently, and is barely there at noon.
    const breathe = this.still ? 1 : 0.92 + 0.08 * Math.sin(clock * 1.3);
    // With fancy graphics on, the finishing pass already makes the lamp glow: the haze and the glints are turned
    // well down there, or the two together bury the lantern in light.
    const soft = fancy.get();
    b.glow.opacity = (0.12 + 0.5 * dark) * breathe * (soft ? 0.3 : 1);
    const size = (0.75 + 0.35 * dark) * b.scale;
    b.halo.scale.set(size, size, 1);
    // The ironwork round the lamp catches each beam as it comes by: brightest where a beam points straight at it,
    // gone a bar or so to either side.
    if (b.shine) {
      b.shine.uniforms.uTurn.value = b.spin.rotation.y;
      b.shine.uniforms.uGain.value = (0.07 + 0.38 * dark) * (soft ? 0.6 : 1);
    }
  }

  /** Light buildings' windows and lanterns (see `BuildingGlow`), and warm these panes with the dusk. Empty lists clear them. */
  setGlows(glows: BuildingGlow[], panes: THREE.MeshBasicMaterial[]) {
    if (this.lamps) {
      this.scene.remove(this.lamps.root);
      this.lamps.glow.map?.dispose();
      this.lamps.glow.dispose();
      this.lamps = null;
    }
    this.poiLights = glows.flatMap((g) => (g.light ? [{ pos: g.pos.clone(), kind: g.light }] : []));
    if (glows.length === 0 && panes.length === 0) return;
    const glow = new THREE.SpriteMaterial({
      map: ramp([[0, "#ffe2a0"], [0.3, "#d98a3a"], [0.65, "#4a2a10"], [1, "#000000"]], 64, 64, true),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const root = new THREE.Group();
    // A glow of no size is only a light: it has no halo.
    const shown = glows.filter((g) => g.size > 0);
    const halos = shown.map((g) => {
      const halo = new THREE.Sprite(glow);
      halo.position.copy(g.pos);
      // Drawn before the heroes (order 2), whose cards ignore depth: a hero at the door stands in front of the glow, not under it.
      halo.renderOrder = 1;
      root.add(halo);
      return halo;
    });
    this.scene.add(root);
    this.lamps = { root, glow, halos, sizes: shown.map((g) => g.size), panes };
  }

  /** Windows and lanterns come up as the light goes, each breathing a little on its own. */
  private glimmer(clock: number) {
    const l = this.lamps;
    if (!l) return;
    const dark = this.night;
    l.glow.opacity = 0.85 * smooth(0.12, 0.8, dark);
    l.root.visible = l.glow.opacity > 0.01;
    const motion = this.still ? 0 : 0.6;
    l.halos.forEach((h, i) => {
      const s = l.sizes[i] * (0.8 + 0.3 * dark) * this.waver(clock, i + 5, motion);
      h.scale.set(s, s, 1);
    });
    const warm = smooth(0.05, 0.7, dark);
    for (const p of l.panes) p.color.set(p.userData.unlit as string).lerp(this.paneLit.set(p.userData.lit as string), warm);
  }

  /** Puffs leave the stack one after another, drift with the wind as they climb, and thin out. */
  /**
   * Rocks standing out of the sea (and the wreck on them): the water breaks
   * around each one too. `rocks` are their bases at the water line.
   */
  setSeaRocks(rocks: THREE.Vector3[]) {
    const out: typeof this.splashes = [];
    rocks.forEach((r, n) => {
      // Three spots around each rock, never in step.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + hash(n, i, 720) * 1.2;
        const nx = Math.cos(a), nz = Math.sin(a);
        out.push({ x: r.x + nx * 0.42, y: r.y + 0.02, z: r.z + nz * 0.42, nx, nz, phase: hash(n, i, 721) * 10, period: 1.8 + hash(n, i, 722) * 2.4 });
      }
    });
    this.rockSplashes = out;
    this.layOutSplashes();
  }

  /** (Re)build the splash points for the shore and the rocks together. */
  private layOutSplashes() {
    if (this.splashPoints) {
      this.group.remove(this.splashPoints);
      this.splashPoints.geometry.dispose();
      (this.splashPoints.material as THREE.Material).dispose();
      this.splashPoints = null;
    }
    this.splashes = [...this.shoreSplashes, ...this.rockSplashes];
    if (this.splashes.length === 0 || this.still) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.splashes.length * SPLASH_DROPS * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.splashes.length * SPLASH_DROPS * 4), 4));
    this.splashPoints = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    this.splashPoints.frustumCulled = false;
    this.group.add(this.splashPoints);
  }

  /**
   * The sea breaking on rock: every few seconds each spot throws up a handful
   * of white pixels that arc out over the water and drop back, quick and small.
   */
  private splash(clock: number) {
    if (!this.splashPoints) return;
    const pos = this.splashPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.splashPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
    const glow = 0.75 + 0.25 * this.daylight;
    this.splashes.forEach((s, n) => {
      const cycle = (clock + s.phase) / s.period;
      const burst = Math.floor(cycle);
      // The burst lasts the first fifth of each cycle; the rest of the time the water is calm.
      const t = (cycle - burst) / 0.2;
      for (let i = 0; i < SPLASH_DROPS; i++) {
        const k = n * SPLASH_DROPS + i;
        if (t >= 1) {
          col.setXYZW(k, 1, 1, 1, 0);
          continue;
        }
        const r = (salt: number) => hash(n + i * 13, burst, 710 + salt);
        // Thrown out to sea and to either side, up, then falling back.
        const out = (0.1 + r(1) * 0.25) * t;
        const side = (r(2) - 0.5) * 0.5 * t;
        const up = (0.25 + r(3) * 0.35) * (4 * t * (1 - t));
        pos.setXYZ(k, s.x + s.nx * out - s.nz * side, s.y + up, s.z + s.nz * out + s.nx * side);
        // Whiter at the top of the throw, fading as it falls.
        col.setXYZW(k, glow, glow, glow + 0.05, (1 - t) * 0.9);
      }
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  private puff(clock: number) {
    if (!this.smoke) return;
    (this.smoke.material as THREE.ShaderMaterial).uniforms.uShade.value = 0.52 + 0.45 * this.daylight;
    const { turn, at, size, m, spin } = this.smokeScratch;
    this.stacks.forEach((stack, n) => {
      for (let i = 0; i < PUFFS; i++) {
        // Each puff is blown out of the pot small, floats up, swells and leans downwind, and comes apart near the
        // top: its lumps drift away from each other and shrink away one by one. Every time round it is a new puff,
        // with its own size and its own lumps.
        const phase = this.still ? (i + 0.5) / PUFFS : clock * 0.12 + i / PUFFS + n * 0.37;
        const lap = Math.floor(phase);
        const life = phase - lap;
        const r = (salt: number) => hash(n * PUFFS + i + 1, lap, 700 + salt);
        const big = (0.07 + r(1) * 0.05) * (1 + life * (0.9 + r(2) * 0.6));
        const sway = Math.sin(life * 5 + i * 1.7 + n) * 0.05 * life;
        const lean = life * life * 0.5;
        const cx = stack.x + WIND.x * lean + sway;
        const cy = stack.y + 0.06 + life * (1.5 + r(3) * 0.5);
        const cz = stack.z + WIND.z * lean;
        for (let l = 0; l < LOBES; l++) {
          const k = (n * PUFFS + i) * LOBES + l;
          const q = (salt: number) => hash(k + 1, lap, 760 + salt);
          // The first lump is the middle of the puff; the rest sit round it, mostly to the sides, a little up.
          const a = q(1) * Math.PI * 2;
          const out = l === 0 ? 0 : 0.55 + q(2) * 0.45;
          // Lumps swell in one after another, and each lets go at its own moment near the top, drifting off.
          const born = smooth(l * 0.015, 0.06 + l * 0.015, life);
          const leave = 0.45 + q(3) * 0.45;
          const gone = smooth(leave - 0.15, leave + 0.1, life);
          const loose = 1 + Math.max(0, life - (leave - 0.25)) * 2.2;
          const lump = big * (l === 0 ? 1 : 0.55 + q(4) * 0.35);
          at.set(
            cx + Math.cos(a) * out * big * loose,
            cy + (l === 0 ? 0 : (q(5) - 0.35) * big * 0.8) + (loose - 1) * big * 0.4,
            cz + Math.sin(a) * out * big * loose,
          );
          // Each lump is turned its own way and turns slowly as it rises, so its facets catch the light differently.
          spin.set(q(6) * 6.3 + life * (q(7) - 0.5) * 2, q(8) * 6.3 + life * (q(9) - 0.5) * 2, q(10) * 6.3);
          turn.setFromEuler(spin);
          // A little squat, like a cloud.
          const s0 = Math.max(lump * born * (1 - gone), 1e-5);
          size.set(s0, s0 * 0.85, s0);
          this.smoke!.setMatrixAt(k, m.compose(at, turn, size));
        }
      }
    });
    this.smoke.instanceMatrix.needsUpdate = true;
  }
  private smokeScratch = {
    turn: new THREE.Quaternion(),
    at: new THREE.Vector3(),
    size: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    spin: new THREE.Euler(),
  };

  /**
   * How high the sun stands: about 1.2 at noon, 0 as it crosses the horizon, down to about -0.8 at midnight.
   * A large number indoors, where there is no sun to be low.
   */
  sunHeight = 9;
  /** In the caverns: under the rock, where no weather reaches. */
  get underground(): boolean {
    return this.cave;
  }
  /** Where every candle, lantern, fire and lit building on this map is. */
  lampSpots(): THREE.Vector3[] {
    return [...this.poiLights, ...this.lights].map((l) => l.pos);
  }
  /** Under the open sky: not in a room, not in the caverns. */
  get openSky(): boolean {
    return this.outdoors && !this.cave;
  }
  /** How overcast it is right now, 0 (clear) to 1. */
  get overcast(): number {
    return this.cloud;
  }
  /** How much of a storm it is outdoors right now, 0 to 1: thunder and lightning, on top of heavy rain. */
  get storming(): number {
    return this.outdoors ? this.stormy() * this.rainfall : 0;
  }
  /** How hard it is raining outdoors right now, 0 to 1. */
  get raining(): number {
    return this.outdoors ? this.rainfall : 0;
  }
  /** Set while the fancy water is on: the paper wave crests are put away. */
  smoothSea = false;
  /** The sun's or moon's light, colour and strength together, for glints on the water. Fills and returns `out`. */
  sunGlint(out: THREE.Color): THREE.Color {
    return out.copy(this.sun.color).multiplyScalar(this.sun.visible ? this.sun.intensity * 0.6 : 0);
  }
  /**
   * The sky outside right now, for the sound: the time of day (0 midnight, 0.5 noon), how dark it is and how
   * hard it rains, 0 to 1 each. Unlike `night`, it holds indoors too, where the rain is still on the roof.
   */
  sky(): { time: number; night: number; rain: number; storm: number } {
    const time = this.timeOfDay();
    const height = Math.sin((time - 0.25) * Math.PI * 2) + 0.2;
    const rain = smooth(0.6, 0.9, this.weather());
    return { time, night: 1 - smooth(-0.25, 0.3, height), rain, storm: this.stormy() * rain };
  }

  private light(target: THREE.Vector3, clock: number) {
    const t = this.indoors ? 0.42 : this.timeOfDay();
    const angle = (t - 0.25) * Math.PI * 2;
    // Nudged up so the day is a little longer than the night.
    const height = Math.sin(angle) + 0.2;
    const day = height >= 0;
    const daylight = smooth(-0.25, 0.3, height);
    const glow = 1 - smooth(0, 0.5, Math.abs(height));
    this.daylight = daylight;
    // For the colour grade, which has its own, longer golden hour than the sky's glow.
    this.sunHeight = this.indoors ? 9 : height;

    // By night the same light is the moon, on the other side of the sky.
    const side = day ? -Math.cos(angle) : Math.cos(angle);
    const dir = this.sunDir.set(side * 0.9, Math.max(Math.abs(height), 0.3) * 1.1, 0.42).normalize();
    this.sun.position.copy(target).addScaledVector(dir, 50);
    this.sun.target.position.copy(target);
    if (day) {
      this.sun.color.set("#ff8a4c").lerp(SUN_NOON, smooth(0.05, 0.6, height));
      this.sun.intensity = 1.6 * smooth(0, 0.35, height);
    } else {
      this.sun.color.set("#9db4ff");
      this.sun.intensity = 0.7 * smooth(0, 0.35, -height);
    }

    if (this.indoors && this.cave) {
      // The caverns: cold dark stone, and a warm torch around each hero.
      this.sun.intensity = 0;
      this.lamp.intensity = 0;
      this.hemi.intensity = 0.28;
      this.hemi.color.set("#8ea0c8");
      this.hemi.groundColor.set("#141018");
      this.background.set("#07060b");
      this.torches.forEach((t, i) => {
        t.intensity = i < this.torchCount ? 2.4 * (this.still ? 1 : 1 + Math.sin(clock * 9 + i * 2.1) * 0.06 + Math.sin(clock * 15.7 + i) * 0.04) : 0;
      });
      return;
    }
    if (this.indoors) {
      // The lamp does the work; a low fill keeps the corners readable. It wavers a little, like a flame.
      this.sun.intensity = 0;
      // With a fire going, the lamp and fill step back so the room is not overlit.
      const fire = this.lights.some((l) => l.kind === "fire");
      // Under the pub's table lanterns the room lamp is turned down a little, so each table sits in its own pool of light.
      const pooled = this.tableLamps.length > 0 ? 0.75 : 1;
      if (this.lampOn) {
        this.lamp.intensity = (fire ? 1.15 : 1.5) * pooled * (this.still ? 1 : 1 + Math.sin(clock * 7) * 0.035 + Math.sin(clock * 13.3) * 0.02);
        this.hemi.intensity = (fire ? 0.8 : 0.95) * (0.6 + 0.4 * pooled);
      } else {
        // Lamp out: a faint fill so the room never goes black, and the candles, lanterns and fires do the rest.
        this.lamp.intensity = 0;
        this.hemi.intensity = 0.15;
      }
      this.hemi.color.set("#ffe9c9");
      this.hemi.groundColor.set("#3b2f2a");
      this.background.set("#1d1a2b");
      return;
    }
    this.hemi.intensity = 1.0 + 0.5 * daylight;
    this.hemi.color.set("#7686c8").lerp(WHITE, daylight).lerp(DUSK, glow * 0.4);
    this.hemi.groundColor.set("#232a4d").lerp(GROUND_DAY, daylight);
    if (this.indoors) this.background.set("#1d1a2b");
    else this.background.set("#161c3c").lerp(SKY_DAY, daylight).lerp(DUSK, glow * 0.7);
    // Cloud comes in before the rain does; indoors there is no sky.
    const wet = this.outdoors ? this.weather() : 0;
    this.cloud = smooth(0.3, 0.6, wet);
    this.rainfall = smooth(0.6, 0.9, wet);
    if (this.cloud > 0) {
      // Low cloud: a weaker, greyer sun, a slate sky, and everything a shade cooler.
      const c = this.cloud;
      this.sun.intensity *= 1 - 0.45 * c;
      this.hemi.intensity *= 1 - 0.08 * c;
      this.hemi.color.lerp(SLATE, 0.45 * c);
      this.background.lerp(SLATE, 0.8 * c).multiplyScalar(1 - c * (0.25 - 0.2 * daylight));
    }
    // Unlit cut-outs (grass, wave crests) are tinted by hand to match.
    this.flatTint.set("#56669c").lerp(WHITE, daylight).lerp(DUSK, glow * 0.2);
    if (this.cloud > 0) this.flatTint.lerp(SLATE, 0.35 * this.cloud).multiplyScalar(1 - 0.18 * this.cloud);
  }
}

const WHITE = new THREE.Color("#ffffff");
const SLATE = new THREE.Color("#7f8b98");
const SUN_NOON = new THREE.Color("#fff3d6");
const SKY_DAY = new THREE.Color("#a9dcf7");
const GROUND_DAY = new THREE.Color("#5a6a8a");
const DUSK = new THREE.Color("#f2a56b");
