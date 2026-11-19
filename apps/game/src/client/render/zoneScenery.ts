// What stands on a zone's hexes, drawn: the walls and towers of a ruin, the
// pillars of a hall, braziers, statues, the ribs of something long dead
// (`Tile.prop`, the kinds in the world's zone/props.ts), the ladders up its
// cliffs (`Tile.ladder`), parapets round its paved heights, and the rock of
// the cliffs themselves.
//
// Everything is low-poly and faceted, and built once into a few big meshes:
// each piece is a simple solid (a box, a prism, a lump of rock, a bent tube)
// set in place and painted face by face, so a map of a thousand hexes costs a
// handful of draw calls. The paint is the climate's: snow lies on whatever
// faces up in the frost, sand drifts against the foot of things in the dunes,
// moss creeps over the mire's stone, and the ashlands' is soot-black with
// embers in its cracks. Which pillar is cracked, which way a statue faces and
// where the rubble fell all come from a hash of the hex, so every screen
// draws the same ruin and nothing is saved.
//
// Fire is the exception: flames (torchFlame) flicker, sparks rise, a waygate's
// portal turns, and the fires nearest the view carry real light. The rest
// make do with a soft pool of glow laid on the ground round them.

import * as THREE from "three";
import type { Clime, Tile } from "@gantt-quest/world";
import { flickerFlame, torchFlame } from "./torchFlame";
import { HIDES } from "./silhouette";
import { moteField, type Mote, type MoteField } from "./motes";

const SQRT3 = Math.sqrt(3);
/** From a hex's middle to the middle of a side. */
const APO = SQRT3 / 2;
/** The six neighbours, in the world's HEX_DIRS order, and the way out through each side (an angle in the x-z plane). */
const DIRS = [{ q: 1, r: -1 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }];
const SIDE = [-60, 0, 60, 120, 180, 240].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return { a, x: Math.cos(a), z: Math.sin(a) };
});
/** One level of the ground, in world units: 0.42 of a tile's `h`, which is drawn 1.1 tall. */
const LEVEL = 0.42 * 1.1;
/** How many real lights the fires share: the ones nearest the view have them. */
const LIGHT_BUDGET = 6;
/** How many flames a map may burn: past this the small ones (wall torches) are left out. */
const FLAME_BUDGET = 56;
/** The ground is built in squares this many world units across, so what is out of view is not drawn. */
const CHUNK = 16;
/** Where a floating map's slab of rock ends and its roots begin to trail away. */
const RIM = -0.5;

const hash = (q: number, r: number, salt: number) => {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};
const key = (q: number, r: number) => `${q},${r}`;
/** The turn about y that points a piece's own +x along an angle of the x-z plane, or its own +z. */
const alongX = (a: number) => -a;
const faceZ = (a: number) => Math.PI / 2 - a;

// ---------------------------------------------------------------- colours ---

const col = (hex: string) => new THREE.Color(hex);
/** Tones that are painted as they are: the dark of a doorway, an arrow slit. */
const RAW = new WeakSet<THREE.Color>();
const raw = (hex: string) => {
  const c = col(hex);
  RAW.add(c);
  return c;
};
const DARK = raw("#0d0c12");
const SNOW = col("#eef3f8");
const RIME = col("#cfe0f0");
const SAND = col("#e2c58c");
const MOSS = col("#5f7a34");
const MOSS_DARK = col("#3c4f2a");
const ASH_DUST = col("#6b6670");
const LICHEN = col("#a8ab7c");
const EMBER = col("#ff6a1c").multiplyScalar(1.5);
const EMBER_DEEP = col("#d2360c");
const FIRE = col("#ff9a4a");
const ICE = col("#9fd0f0");
const ICE_LIGHT = col("#d6eefc");
const ICE_DEEP = col("#5a98d6");
const ROPE = col("#b89a62");

interface Pal {
  stone: THREE.Color;
  stoneDark: THREE.Color;
  stoneLight: THREE.Color;
  /** Inlay and fittings: gold in the greenwood, verdigris in the mire, ember in the ashlands. */
  trim: THREE.Color;
  /** Whether that inlay gives light of its own. */
  trimGlows: boolean;
  wood: THREE.Color;
  woodDark: THREE.Color;
  canvas: THREE.Color;
  canvasDark: THREE.Color;
  bone: THREE.Color;
  boneDark: THREE.Color;
  iron: THREE.Color;
  roof: THREE.Color;
  thatch: THREE.Color;
  bark: THREE.Color;
  leaf: THREE.Color[];
  /** The rock of a cliff, in bands, and the lip of earth (or ice) at its top. */
  cliff: THREE.Color[];
  lip: THREE.Color;
  /** Carved signs that glow, and a waygate's light. */
  glyph: THREE.Color;
  crystal: THREE.Color;
  crystalDeep: THREE.Color;
  cap: THREE.Color;
  gill: THREE.Color;
  gillGlows: boolean;
  basalt: THREE.Color;
}

const PALS: Record<Clime, Pal> = {
  greenwood: {
    stone: col("#8a8f99"), stoneDark: col("#676c78"), stoneLight: col("#a6abb3"), trim: col("#cfa646"), trimGlows: false,
    wood: col("#7d5834"), woodDark: col("#4f3822"), canvas: col("#cfc19c"), canvasDark: col("#a89a78"), bone: col("#e4dcc4"), boneDark: col("#b9ae90"),
    iron: col("#34343c"), roof: col("#4d5e7c"), thatch: col("#b39a55"), bark: col("#5d4632"), leaf: [col("#3f7d3a"), col("#4f9444"), col("#2f6a36")],
    cliff: [col("#746e64"), col("#625d55"), col("#827b6e")], lip: col("#4f3f2c"),
    glyph: col("#6fe3ff"), crystal: col("#7fe0ff"), crystalDeep: col("#2f7fe0"), cap: col("#b5482f"), gill: col("#e8dcc0"), gillGlows: false, basalt: col("#3e424b"),
  },
  frost: {
    stone: col("#8794a8"), stoneDark: col("#5f6b80"), stoneLight: col("#aab6c6"), trim: col("#bfdcee"), trimGlows: false,
    wood: col("#6a5340"), woodDark: col("#463628"), canvas: col("#a7917a"), canvasDark: col("#7f6b58"), bone: col("#e9eef0"), boneDark: col("#b9c4cc"),
    iron: col("#2f3440"), roof: col("#586d8a"), thatch: col("#9a8a62"), bark: col("#4f4038"), leaf: [col("#3b5f52"), col("#2f5048"), col("#46705c")],
    cliff: [col("#7d8a9c"), col("#93a1b3"), col("#667488")], lip: col("#c4d4e2"),
    glyph: col("#a6ecff"), crystal: col("#b6f0ff"), crystalDeep: col("#4f9fe8"), cap: col("#c9d8e6"), gill: col("#8fc4e8"), gillGlows: false, basalt: col("#3a4250"),
  },
  dunes: {
    stone: col("#cfa877"), stoneDark: col("#a97f52"), stoneLight: col("#e3c596"), trim: col("#38b5a6"), trimGlows: false,
    wood: col("#a07a4c"), woodDark: col("#6f5030"), canvas: col("#e2d1a6"), canvasDark: col("#bfa878"), bone: col("#f2e8cc"), boneDark: col("#cdbf9a"),
    iron: col("#4a3f38"), roof: col("#b5633c"), thatch: col("#c9ab62"), bark: col("#7a6248"), leaf: [col("#8a8f4a"), col("#9c9a52"), col("#77803f")],
    cliff: [col("#b0603a"), col("#c57a48"), col("#9a4f30")], lip: col("#d8b072"),
    glyph: col("#ffd36b"), crystal: col("#ffcf8a"), crystalDeep: col("#f0783c"), cap: col("#d08a4a"), gill: col("#f0dfb4"), gillGlows: false, basalt: col("#5a443c"),
  },
  mire: {
    stone: col("#667060"), stoneDark: col("#485044"), stoneLight: col("#838c78"), trim: col("#7fb894"), trimGlows: false,
    wood: col("#5a4630"), woodDark: col("#3a2d20"), canvas: col("#8f9274"), canvasDark: col("#6c7058"), bone: col("#cfd0b0"), boneDark: col("#a0a284"),
    iron: col("#2c302c"), roof: col("#3f4a3a"), thatch: col("#7a7a48"), bark: col("#3f3528"), leaf: [col("#3d5a34"), col("#4a6238"), col("#2f4a2e")],
    cliff: [col("#4a4638"), col("#3d3a2f"), col("#585343")], lip: col("#3a4428"),
    glyph: col("#8dff9a"), crystal: col("#9dffc0"), crystalDeep: col("#2fb878"), cap: col("#3f8a84"), gill: col("#7dffd8"), gillGlows: true, basalt: col("#30352f"),
  },
  ash: {
    stone: col("#48424c"), stoneDark: col("#2e2a33"), stoneLight: col("#5e5763"), trim: col("#ff7a2a").multiplyScalar(1.35), trimGlows: true,
    wood: col("#3a2e2a"), woodDark: col("#241c1a"), canvas: col("#6a5650"), canvasDark: col("#4a3c38"), bone: col("#b9ada0"), boneDark: col("#857a70"),
    iron: col("#1f1c22"), roof: col("#2a2428"), thatch: col("#4a4038"), bark: col("#2a2222"), leaf: [],
    cliff: [col("#2a252d"), col("#35303a"), col("#1f1b22")], lip: col("#3e3842"),
    glyph: col("#ff5a2a"), crystal: col("#ff7a6a"), crystalDeep: col("#e02848"), cap: col("#5a5560"), gill: col("#ff8a3a"), gillGlows: true, basalt: col("#26232b"),
  },
};
const BANNERS = [col("#a8323a"), col("#2f7f86"), col("#c9992e"), col("#6a4a9a"), col("#3d6fb0")];

// ---------------------------------------------------------------- the kit ---

const SOLID = 0;
const GLOW = 1;
const WARM = 2;
const COOL = 3;
const FADE = 4;
const LAYERS = 5;

class Bucket {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
}

const unitCache = new Map<string, Float32Array>();
/** A shape's triangles, made once: every piece of that shape is this one moved into place. */
function unit(name: string, make: () => THREE.BufferGeometry): Float32Array {
  let got = unitCache.get(name);
  if (!got) {
    const g = make();
    const flat = g.index ? g.toNonIndexed() : g;
    got = new Float32Array(flat.getAttribute("position").array);
    if (flat !== g) flat.dispose();
    g.dispose();
    unitCache.set(name, got);
  }
  return got;
}
/** A lump of rock: a regular solid knocked out of true, every corner by its own amount. */
function rockGeometry(variant: number): THREE.BufferGeometry {
  const base = [new THREE.IcosahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0), new THREE.IcosahedronGeometry(1, 1), new THREE.OctahedronGeometry(1, 0)][variant % 4];
  const amount = [0.2, 0.13, 0.13, 0.1][variant % 4];
  const g = base.index ? base.toNonIndexed() : base;
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
    // Corners shared between faces move together: the jolt comes from where the corner is.
    const k = 1 + (hash(Math.round(x * 50), Math.round(y * 50) + Math.round(z * 50) * 7, 3 + variant) - 0.5) * 2 * amount;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  return g;
}
const U = {
  box: () => unit("box", () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
  cyl: (sides: number, ratio: number) => unit(`cyl${sides}:${ratio.toFixed(2)}`, () => new THREE.CylinderGeometry(ratio, 1, 1, sides).translate(0, 0.5, 0)),
  cone: (sides: number) => unit(`cone${sides}`, () => new THREE.ConeGeometry(1, 1, sides).translate(0, 0.5, 0)),
  rock: (variant: number) => unit(`rock${variant % 4}`, () => rockGeometry(variant)),
  dome: (sides: number) => unit(`dome${sides}`, () => new THREE.SphereGeometry(1, sides, 3, 0, Math.PI * 2, 0, Math.PI / 2)),
  disc: (sides: number) => unit(`disc${sides}`, () => new THREE.CircleGeometry(1, sides).rotateX(-Math.PI / 2)),
  torus: () => unit("torus", () => new THREE.TorusGeometry(1, 0.12, 4, 12)),
};

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _f = new THREE.Matrix4();
/** A piece's own place: tilted (x, z) in its own frame, then turned about y, then moved. */
function placed(x: number, y: number, z: number, sx: number, sy: number, sz: number, ry: number, rx: number, rz: number): THREE.Matrix4 {
  _e.set(rx, ry, rz, "YXZ");
  return _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}
/** The light a glowing facet is shaded by: baked in, as it gives its own. */
const GEM_LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();

interface Emitter {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  power: number;
  range: number;
  /** A fire wavers; a crystal breathes. */
  fire: boolean;
}
interface Pool {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  radius: number;
  strength: number;
  layer: number;
}

/**
 * What the pieces are built with. A hex's pieces are set down in its own frame (the middle of its top at the
 * origin, y up), which `push` and `pop` move about for a part made of several; every triangle is painted as it
 * is added, by which way it faces and how high it is, in the hex's climate.
 */
class Kit {
  private buckets = new Map<string, Bucket>();
  private cur: Bucket[] = [];
  private stack: THREE.Matrix4[] = [];
  private M = new THREE.Matrix4();
  private faces = 0;
  /** The ground the piece stands on: its paint is darker near it. */
  baseY = 0;
  clime: Clime = "greenwood";
  flames: { at: THREE.Vector3; size: number; small: boolean }[] = [];
  emitters: Emitter[] = [];
  pools: Pool[] = [];
  motes: Mote[] = [];
  portals: { matrix: THREE.Matrix4; color: THREE.Color; deep: THREE.Color }[] = [];

  begin(x: number, y: number, z: number, clime: Clime) {
    const [cx, cz] = [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
    this.cur = [];
    for (let layer = 0; layer < LAYERS; layer++) {
      const id = `${layer}|${cx}|${cz}`;
      let b = this.buckets.get(id);
      if (!b) this.buckets.set(id, (b = new Bucket()));
      this.cur.push(b);
    }
    this.M.makeTranslation(x, y, z);
    this.stack.length = 0;
    this.baseY = y;
    this.clime = clime;
  }

  push(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1) {
    this.stack.push(this.M.clone());
    this.M.multiply(placed(x, y, z, s, s, s, ry, rx, rz));
  }

  pop() {
    this.M.copy(this.stack.pop()!);
  }

  /** A point of the piece's own frame, in the world. */
  world(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.M);
  }

  /** The current frame, for something that is drawn on its own (a portal). */
  frame(): THREE.Matrix4 {
    return this.M.clone();
  }

  /**
   * Add triangles (`src`, nine numbers each), moved by `m` within the current frame and painted `tone`.
   * `plain`: solid pieces are not weathered, glowing ones not shaded.
   */
  put(layer: number, src: ArrayLike<number>, m: THREE.Matrix4 | null, tone: THREE.Color, plain = false) {
    const e = (m ? _f.multiplyMatrices(this.M, m) : this.M).elements;
    const b = this.cur[layer];
    const { pos, nor, col: out } = b;
    const flat = plain || RAW.has(tone);
    for (let i = 0; i < src.length; i += 9) {
      const ax = e[0] * src[i] + e[4] * src[i + 1] + e[8] * src[i + 2] + e[12];
      const ay = e[1] * src[i] + e[5] * src[i + 1] + e[9] * src[i + 2] + e[13];
      const az = e[2] * src[i] + e[6] * src[i + 1] + e[10] * src[i + 2] + e[14];
      const bx = e[0] * src[i + 3] + e[4] * src[i + 4] + e[8] * src[i + 5] + e[12];
      const by = e[1] * src[i + 3] + e[5] * src[i + 4] + e[9] * src[i + 5] + e[13];
      const bz = e[2] * src[i + 3] + e[6] * src[i + 4] + e[10] * src[i + 5] + e[14];
      const cx = e[0] * src[i + 6] + e[4] * src[i + 7] + e[8] * src[i + 8] + e[12];
      const cy = e[1] * src[i + 6] + e[5] * src[i + 7] + e[9] * src[i + 8] + e[13];
      const cz = e[2] * src[i + 6] + e[6] * src[i + 7] + e[10] * src[i + 8] + e[14];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      const j = this.jitter();
      let [r, g, bl] = [tone.r, tone.g, tone.b];
      if (layer === GLOW) {
        if (!flat) {
          const k = 0.5 + 0.75 * Math.max(0, nx * GEM_LIGHT.x + ny * GEM_LIGHT.y + nz * GEM_LIGHT.z) + (j - 0.5) * 0.16;
          r *= k;
          g *= k;
          bl *= k;
        }
      } else if (layer === SOLID || layer === FADE) {
        const k = 0.93 + j * 0.14;
        r *= k;
        g *= k;
        bl *= k;
        if (!flat) [r, g, bl] = this.weather(r, g, bl, (ay + by + cy) / 3 - this.baseY, ny, j);
      }
      if (layer === FADE) out.push(r, g, bl, 1, r, g, bl, 1, r, g, bl, 1);
      else out.push(r, g, bl, r, g, bl, r, g, bl);
    }
  }

  private jitter(): number {
    const n = Math.sin(++this.faces * 12.9898) * 43758.5453;
    return n - Math.floor(n);
  }

  /** The climate's hand on a face `y` above the ground, facing up by `ny`. */
  private weather(r: number, g: number, b: number, y: number, ny: number, j: number): [number, number, number] {
    const mix = (to: THREE.Color, k: number) => {
      r += (to.r - r) * k;
      g += (to.g - g) * k;
      b += (to.b - b) * k;
    };
    // Whatever stands on the ground is darker where it meets it.
    const foot = y < 0.4 ? 0.78 + 0.22 * Math.max(0, y / 0.4) : 1;
    r *= foot;
    g *= foot;
    b *= foot;
    switch (this.clime) {
      case "frost":
        if (ny > 0.6) mix(SNOW, 0.92);
        else if (ny > 0.25) mix(SNOW, 0.45);
        else mix(RIME, j > 0.8 ? 0.28 : 0.1);
        break;
      case "dunes":
        if (y < 0.34 && ny > -0.3) mix(SAND, (1 - Math.max(0, y) / 0.34) * 0.6);
        if (ny > 0.6) mix(SAND, 0.32);
        break;
      case "mire":
        if (ny > 0.55) mix(MOSS, 0.35 + j * 0.4);
        else if (j > 0.7 || y < 0.5) mix(MOSS_DARK, 0.32);
        break;
      case "ash":
        if (ny > 0.6) mix(ASH_DUST, 0.3);
        break;
      default:
        if (ny > 0.6 && j > 0.5) mix(MOSS, 0.3);
        else if (j > 0.92) mix(LICHEN, 0.22);
    }
    return [r, g, b];
  }

  // ---- solids: each stands on the point given, the middle of its foot ----

  box(tone: THREE.Color, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, layer = SOLID, plain = false) {
    this.put(layer, U.box(), placed(x, y, z, w, h, d, ry, rx, rz), tone, plain);
  }

  /** A prism or a tapered post: `r0` across at the foot, `r1` at the top. `flat` squashes it front to back. */
  cyl(tone: THREE.Color, r0: number, r1: number, h: number, x = 0, y = 0, z = 0, sides = 8, ry = 0, rx = 0, rz = 0, flat = 1, layer = SOLID, plain = false) {
    this.put(layer, U.cyl(sides, r1 / r0), placed(x, y, z, r0, h, r0 * flat, ry, rx, rz), tone, plain);
  }

  cone(tone: THREE.Color, r: number, h: number, x = 0, y = 0, z = 0, sides = 6, ry = 0, rx = 0, rz = 0, layer = SOLID, plain = false) {
    this.put(layer, U.cone(sides), placed(x, y, z, r, h, r, ry, rx, rz), tone, plain);
  }

  /** A lump of rock (or of anything), its middle at the point given. */
  blob(tone: THREE.Color, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, variant = 0, ry = 0, rx = 0, rz = 0, layer = SOLID, plain = false) {
    this.put(layer, U.rock(variant), placed(x, y, z, sx, sy, sz, ry, rx, rz), tone, plain);
  }

  /** Half a ball, flat side down. */
  dome(tone: THREE.Color, r: number, h: number, x = 0, y = 0, z = 0, sides = 8, layer = SOLID) {
    this.put(layer, U.dome(sides), placed(x, y, z, r, h, r, 0, 0, 0), tone);
  }

  /** A flat round, facing up (or down, turned over). */
  disc(tone: THREE.Color, r: number, x = 0, y = 0, z = 0, sides = 10, down = false, layer = SOLID, plain = false) {
    this.put(layer, U.disc(sides), placed(x, y, z, r, 1, r, 0, down ? Math.PI : 0, 0), tone, plain);
  }

  /** A flat face through these points, seen from the side `out` points to (and from behind too, if `both`). */
  poly(tone: THREE.Color, pts: number[][], out: number[], both = false, layer = SOLID, plain = false) {
    const tris: number[] = [];
    const [a, b, c] = pts;
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
      for (const v of tri) tris.push(v[0], v[1], v[2]);
      if (both) for (const v of [tri[0], tri[2], tri[1]]) tris.push(v[0], v[1], v[2]);
    }
    this.put(layer, tris, null, tone, plain);
  }

  /**
   * A bent, tapering limb through these points: a rib, a branch, a horn, an arm. `radius` is how thick it is
   * along its length (0 at the start, 1 at the end); `squash` flattens it across the plane it bends in.
   */
  tube(tone: THREE.Color, pts: number[][], radius: (t: number) => number, sides = 6, squash = 1, layer = SOLID, plain = false) {
    const n = pts.length;
    const P = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const T = P.map((_, i) => P[Math.min(n - 1, i + 1)].clone().sub(P[Math.max(0, i - 1)]).normalize());
    // It bends in one plane, near enough: the rings are set square to that plane's normal.
    const ref = new THREE.Vector3().crossVectors(T[0], T[n - 1]);
    if (ref.lengthSq() < 0.003) ref.crossVectors(T[0], Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    ref.normalize();
    const rings: THREE.Vector3[][] = [];
    const n1 = new THREE.Vector3();
    const n2 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      n1.copy(ref).addScaledVector(T[i], -ref.dot(T[i])).normalize();
      n2.crossVectors(T[i], n1).normalize();
      const r = Math.max(0.004, radius(n === 1 ? 0 : i / (n - 1)));
      const ring: THREE.Vector3[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        ring.push(P[i].clone().addScaledVector(n1, Math.cos(a) * r * squash).addScaledVector(n2, Math.sin(a) * r));
      }
      rings.push(ring);
    }
    const tris: number[] = [];
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < n - 1; i++)
      for (let s = 0; s < sides; s++) {
        const [a, b, c, d] = [rings[i][s], rings[i][(s + 1) % sides], rings[i + 1][(s + 1) % sides], rings[i + 1][s]];
        tri(a, c, b);
        tri(a, d, c);
      }
    for (let s = 1; s < sides - 1; s++) {
      tri(rings[0][0], rings[0][s], rings[0][s + 1]);
      tri(rings[n - 1][0], rings[n - 1][s + 1], rings[n - 1][s]);
    }
    this.put(layer, tris, null, tone, plain);
  }

  // ---- fire and light ----

  /** A flame standing on this point, with the light and the sparks that go with it. */
  fire(x: number, y: number, z: number, size: number, opts: { power?: number; range?: number; pool?: number; sparks?: number; small?: boolean } = {}) {
    const at = this.world(x, y, z);
    this.flames.push({ at, size, small: !!opts.small });
    this.emitters.push({ x: at.x, y: at.y + size * 1.6, z: at.z, color: FIRE, power: opts.power ?? 1, range: opts.range ?? 8.5, fire: true });
    this.pools.push({ x: at.x, y: at.y, z: at.z, color: FIRE, radius: opts.pool ?? 3.4, strength: 0.42 * (opts.power ?? 1), layer: WARM });
    for (let i = 0; i < (opts.sparks ?? 0); i++) {
      const n = hash(Math.round(at.x * 31), Math.round(at.z * 31), 900 + i);
      this.motes.push({ x: at.x + (n - 0.5) * size * 0.8, y: at.y + size * 0.6, z: at.z + (hash(i, Math.round(at.x * 17), 901) - 0.5) * size * 0.8, color: i % 3 === 0 ? col("#ffd27a") : col("#ff8a3a"), rise: 1.3 + n * 1.6, sway: 0.1 + n * 0.16, rate: 0.35 + hash(i, Math.round(at.z * 13), 902) * 0.5, phase: hash(i, Math.round(at.x * 7 + at.z * 11), 903), size: 0.5 + n * 0.7 });
    }
  }

  /** A cold light: a crystal's, a waygate's. */
  shine(x: number, y: number, z: number, color: THREE.Color, power: number, range: number, pool: number) {
    const at = this.world(x, y, z);
    this.emitters.push({ x: at.x, y: at.y, z: at.z, color, power, range, fire: false });
    this.pools.push({ x: at.x, y: this.baseY, z: at.z, color, radius: pool, strength: 0.34 * power, layer: COOL });
  }

  /** Only the pool of glow on the ground, for a light too small to be given a real one. */
  glowPool(x: number, z: number, color: THREE.Color, radius: number, strength: number, warm = false) {
    const at = this.world(x, 0, z);
    this.pools.push({ x: at.x, y: this.baseY, z: at.z, color, radius, strength, layer: warm ? WARM : COOL });
  }

  /** Where a layer's triangles are kept for the square of the map a point is in, for what is laid straight into it. */
  bucketAt(layer: number, x: number, z: number): Bucket {
    const id = `${layer}|${Math.floor(x / CHUNK)}|${Math.floor(z / CHUNK)}`;
    let b = this.buckets.get(id);
    if (!b) this.buckets.set(id, (b = new Bucket()));
    return b;
  }

  /** The layer's meshes, one for each square of the map that has anything in it. */
  meshes(layer: number, material: THREE.Material): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [id, b] of this.buckets) {
      if (!id.startsWith(`${layer}|`) || b.pos.length === 0) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, layer === FADE ? 4 : 3));
      g.computeBoundingSphere();
      out.push(new THREE.Mesh(g, material));
    }
    return out;
  }
}

// ---------------------------------------------------------------- a hex ---

/** One hex's piece, and what its builder is told of the hexes round it. */
interface Ctx {
  t: Tile;
  pal: Pal;
  clime: Clime;
  /** A steady number from 0 to 1 for this hex and a salt. */
  n(salt: number): number;
  /** What stands on the hex through side `i`, if anything. */
  kindAt(i: number): string | undefined;
  /** How far the hex through side `i` stands above this one (below, if negative); nothing if there is no hex there. */
  rise(i: number): number | undefined;
  /** The side that looks out on the most open ground: a statue faces it, a tent opens on it. */
  open: number;
}

/** Kinds that join up into runs: a wall goes on into the tower, the arch or the palisade beside it. */
const RUNS = new Set(["wall", "wall_broken", "tower", "arch", "palisade"]);
/** Kinds that leave their hex open to walk on. */
const WALKABLE = new Set(["arch", "banner", "stairs"]);
const WALL_H = 2.2;
const WALL_T = 0.62;

const joined = (c: Ctx) => SIDE.map((_, i) => RUNS.has(c.kindAt(i) ?? ""));

// ---- shared trimmings ----

/** Icicles hanging in a row under an edge. */
function icicles(k: Kit, c: Ctx, x0: number, x1: number, y: number, z: number, count: number, salt: number) {
  for (let i = 0; i < count; i++) {
    const x = x0 + ((i + 0.3 + c.n(salt + i) * 0.4) / count) * (x1 - x0);
    k.cone(c.n(salt + 20 + i) < 0.5 ? ICE : ICE_LIGHT, 0.028 + c.n(salt + 40 + i) * 0.03, 0.12 + c.n(salt + 60 + i) * 0.3, x, y, z, 5, 0, Math.PI, 0);
  }
}

/** A trail of moss or vine hanging down a face. */
function vine(k: Kit, x: number, top: number, z: number, long: number, ry = 0) {
  k.box(MOSS_DARK, 0.05, long, 0.025, x, top - long, z, ry);
  k.box(MOSS, 0.09, 0.07, 0.04, x, top - long * 0.45, z, ry);
}

/** A crack with the fire showing in it. */
function emberCrack(k: Kit, x: number, y: number, z: number, long: number, ry: number, lean: number) {
  k.box(EMBER, 0.035, long, 0.02, x, y, z, ry, 0, lean, GLOW, true);
  k.box(EMBER_DEEP, 0.03, long * 0.6, 0.02, x + Math.sin(lean) * -long * 0.9, y + long * 0.85, z, ry, 0, -lean * 1.4, GLOW, true);
}

/** What the climate heaps against the foot of a thing: a drift of snow or sand, a hummock of moss, a bank of cinders. */
function drift(k: Kit, c: Ctx, x: number, z: number, size: number, salt: number) {
  const tone = c.clime === "frost" ? SNOW : c.clime === "dunes" ? SAND : c.clime === "mire" ? MOSS_DARK : c.clime === "ash" ? ASH_DUST : null;
  if (!tone) return;
  k.blob(tone, size, size * (c.clime === "mire" ? 0.22 : 0.3), size * 0.8, x, 0, z, 2, c.n(salt) * 6, 0, 0, SOLID, true);
  if (c.clime === "ash" && c.n(salt + 1) < 0.6) k.blob(EMBER, size * 0.16, size * 0.08, size * 0.14, x + size * 0.3, size * 0.14, z + size * 0.1, 3, 0, 0, 0, GLOW, true);
}

/** Fallen stone: blocks lying where they dropped and smaller pieces among them. */
function rubble(k: Kit, c: Ctx, count: number, reach: number, salt: number, clear = 0) {
  for (let i = 0; i < count; i++) {
    const a = c.n(salt + i) * Math.PI * 2;
    const d = clear + c.n(salt + 30 + i) * (reach - clear);
    const s = 0.1 + c.n(salt + 60 + i) * 0.14;
    const tone = [c.pal.stone, c.pal.stoneDark, c.pal.stoneLight][i % 3];
    if (i % 3 === 0) k.blob(tone, s, s * 0.7, s * 0.9, Math.cos(a) * d, s * 0.3, Math.sin(a) * d, i, a);
    else k.box(tone, s * 1.8, s * 1.1, s * 1.3, Math.cos(a) * d, -0.02, Math.sin(a) * d, a * 3, (c.n(salt + 90 + i) - 0.5) * 0.5, (c.n(salt + 120 + i) - 0.5) * 0.5);
  }
}

/** The inlay: a band or a sign in the climate's own metal, which in the ashlands is a seam of fire. */
function inlay(k: Kit, c: Ctx, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
  if (c.pal.trimGlows) k.box(c.pal.trim, w, h, d, x, y, z, ry, rx, rz, GLOW, true);
  else k.box(c.pal.trim, w, h, d, x, y, z, ry, rx, rz, SOLID, true);
}

/** A cloth hanging flat against something, with a forked tail. */
function hanging(k: Kit, tone: THREE.Color, trim: THREE.Color, w: number, long: number, x: number, top: number, z: number, out: number) {
  const o = [0, 0, out];
  const zz = z + out * 0.012;
  k.poly(tone, [[x - w / 2, top, zz], [x + w / 2, top, zz], [x + w / 2, top - long, zz], [x, top - long + w * 0.4, zz], [x - w / 2, top - long, zz]], o, false, SOLID, true);
  k.poly(trim, [[x, top - long * 0.25, zz + out * 0.008], [x + w * 0.22, top - long * 0.45, zz + out * 0.008], [x, top - long * 0.65, zz + out * 0.008], [x - w * 0.22, top - long * 0.45, zz + out * 0.008]], o, false, SOLID, true);
  k.box(trim, w + 0.06, 0.04, 0.03, x, top - 0.01, z + out * 0.015, 0, 0, 0, SOLID, true);
}

/** A ladder from one point up to another, its rungs `wide` across along (tx, tz). */
function ladder(k: Kit, pal: Pal, a: number[], b: number[], wide: number, tx: number, tz: number) {
  const rail = (s: number) => {
    const [ox, oz] = [tx * wide * 0.5 * s, tz * wide * 0.5 * s];
    k.tube(pal.wood, [[a[0] + ox, a[1], a[2] + oz], [b[0] + ox, b[1], b[2] + oz]], () => 0.034, 4);
  };
  rail(-1);
  rail(1);
  const long = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const rungs = Math.max(2, Math.round(long / 0.24));
  for (let i = 1; i < rungs; i++) {
    const t = i / rungs;
    const [x, y, z] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    k.tube(i % 4 === 0 ? pal.woodDark : pal.wood, [[x - tx * wide * 0.56, y, z - tz * wide * 0.56], [x + tx * wide * 0.56, y, z + tz * wide * 0.56]], () => 0.024, 4);
  }
}

// ---- masonry ----

/** A stretch of wall from the middle of the hex out through the side at angle `a`, `h` high. */
function wallRun(k: Kit, c: Ctx, a: number, len: number, h: number, salt: number, crenels = true) {
  const P = c.pal;
  const T = WALL_T;
  k.push(0, 0, 0, alongX(a));
  k.box(P.stone, len, h, T, len / 2, 0, 0);
  k.box(P.stoneDark, len, 0.26, T + 0.14, len / 2, 0, 0);
  k.box(P.stoneLight, len, 0.08, T + 0.1, len / 2, h - 0.38, 0);
  k.box(P.stoneLight, len, 0.09, T + 0.2, len / 2, h, 0);
  for (const s of [-1, 1]) {
    const face = s * (T / 2);
    if (crenels)
      for (const x of [0.2, 0.64]) {
        if (x > len - 0.1) continue;
        k.box(P.stone, 0.27, 0.32, 0.17, x, h + 0.09, s * (T / 2 + 0.015));
        k.box(P.stoneLight, 0.31, 0.05, 0.21, x, h + 0.41, s * (T / 2 + 0.015));
      }
    // Dressed blocks standing a little proud of the face.
    for (let j = 0; j < 4; j++) {
      const w = 0.2 + c.n(salt + j * 3 + s) * 0.16;
      const x = 0.1 + w / 2 + c.n(salt + 20 + j * 5 + s) * Math.max(0, len - 0.2 - w);
      const y = 0.34 + c.n(salt + 40 + j * 7 + s) * (h - 1.0);
      k.box(c.n(salt + 60 + j + s) < 0.5 ? P.stoneLight : P.stoneDark, w, 0.15, 0.045, x, y, face);
    }
    // An arrow slit, on some.
    if (c.n(salt + 5) < 0.45 && len > 0.6) {
      k.box(DARK, 0.07, 0.56, 0.02, len * 0.5, h * 0.42, face + s * 0.004);
      k.box(P.stoneLight, 0.2, 0.05, 0.05, len * 0.5, h * 0.42 - 0.05, face);
    }
    if (c.clime === "frost") icicles(k, c, 0.05, len - 0.05, h - 0.38, s * (T / 2 + 0.04), 3, salt + 200 + s);
    else if (c.clime === "mire" && c.n(salt + 210 + s) < 0.7) vine(k, 0.15 + c.n(salt + 211 + s) * (len - 0.3), h, s * (T / 2 + 0.06), 0.5 + c.n(salt + 212 + s) * 0.8);
    else if (c.clime === "ash" && c.n(salt + 220 + s) < 0.5) emberCrack(k, 0.2 + c.n(salt + 221 + s) * (len - 0.4), 0.06, s * (T / 2 + 0.012), 0.22 + c.n(salt + 222 + s) * 0.2, 0, (c.n(salt + 223 + s) - 0.5) * 0.9);
    if ((c.clime === "dunes" || c.clime === "frost") && c.n(salt + 230 + s) < 0.55) drift(k, c, len * 0.5, s * (T / 2 + 0.22), 0.34 + c.n(salt + 231 + s) * 0.14, salt + 232 + s);
  }
  if (c.clime === "frost") k.blob(SNOW, len * 0.42, 0.07, T * 0.3, len * 0.5, h + 0.1, 0, 2, 0, 0, 0, SOLID, true);
  k.pop();
}

/** The pier a wall ends in or turns at. */
function wallPier(k: Kit, c: Ctx, a: number, h: number, wide = 0.74) {
  const P = c.pal;
  k.push(0, 0, 0, alongX(a));
  k.box(P.stoneDark, wide + 0.12, 0.3, wide + 0.12);
  k.box(P.stone, wide, h + 0.16, wide);
  k.box(P.stoneLight, wide + 0.1, 0.1, wide + 0.1, 0, h + 0.16, 0);
  k.cone(P.stoneDark, (wide + 0.02) * 0.707, 0.24, 0, h + 0.26, 0, 4, Math.PI / 4);
  inlay(k, c, wide + 0.02, 0.05, wide + 0.02, 0, h - 0.5, 0);
  k.pop();
}

function wall(k: Kit, c: Ctx) {
  const runs = joined(c);
  const to = runs.flatMap((on, i) => (on ? [i] : []));
  if (to.length === 0) {
    // A length of wall on its own: across the hex, a pier at each end.
    const a = SIDE[Math.floor(c.n(1) * 2.99)].a;
    wallRun(k, c, a, 0.62, WALL_H, 10);
    wallRun(k, c, a + Math.PI, 0.62, WALL_H, 50);
    for (const s of [-1, 1]) {
      k.push(Math.cos(a) * 0.62 * s, 0, Math.sin(a) * 0.62 * s);
      wallPier(k, c, a, WALL_H, 0.7);
      k.pop();
    }
    return;
  }
  to.forEach((i, j) => wallRun(k, c, SIDE[i].a, APO + 0.004, WALL_H, 10 + j * 40));
  const straight = to.length === 2 && (to[1] - to[0] + 6) % 6 === 3;
  if (!straight) wallPier(k, c, SIDE[to[0]].a, WALL_H);
  else if ((((c.t.q - c.t.r) % 3) + 3) % 3 === 0) {
    // Along a straight run, a buttress every third hex.
    k.push(0, 0, 0, alongX(SIDE[to[0]].a));
    k.box(c.pal.stoneDark, 0.4, WALL_H * 0.78, WALL_T + 0.36);
    k.box(c.pal.stone, 0.34, 0.16, WALL_T + 0.28, 0, WALL_H * 0.78, 0, 0, 0, 0);
    k.pop();
  }
  // Now and then, a torch in a bracket or a banner hung on the wall, on the side that looks out on open ground.
  const side = SIDE[c.open];
  const along = SIDE[to[0]];
  const s = Math.sign(Math.sin(side.a - along.a)) || 1;
  const dress = c.n(7);
  k.push(0, 0, 0, alongX(along.a));
  if (dress < 0.16) {
    const z = s * (WALL_T / 2);
    k.box(c.pal.iron, 0.05, 0.05, 0.22, 0.42, 1.42, z + s * 0.1);
    k.cyl(c.pal.iron, 0.05, 0.075, 0.1, 0.42, 1.45, z + s * 0.2, 6);
    k.fire(0.42, 1.55, z + s * 0.2, 0.11, { power: 0.55, range: 6, pool: 2.4, small: true, sparks: 2 });
  } else if (dress < 0.3) hanging(k, BANNERS[Math.floor(c.n(8) * BANNERS.length * 0.999)], c.pal.trim, 0.42, 1.05, 0.44, WALL_H - 0.44, s * (WALL_T / 2 + 0.03), s);
  k.pop();
}

function wallBroken(k: Kit, c: Ctx) {
  const P = c.pal;
  const runs = joined(c);
  let to = runs.flatMap((on, i) => (on ? [i] : []));
  const alone = to.length === 0;
  if (alone) {
    const i = Math.floor(c.n(1) * 2.99);
    to = [i, i + 3];
  }
  to.forEach((i, j) => {
    const stands = !alone && c.kindAt(i) !== "wall_broken" && c.kindAt(i) !== "palisade";
    const len = alone ? 0.66 : APO + 0.004;
    k.push(0, 0, 0, alongX(SIDE[i].a));
    k.box(P.stoneDark, len, 0.24, WALL_T + 0.14, len / 2, 0, 0);
    const parts = 3;
    for (let p = 0; p < parts; p++) {
      const salt = 300 + j * 50 + p * 9;
      // Stepping up to a wall that still stands beside it; otherwise as it fell.
      const h = p === parts - 1 && stands ? 1.45 + c.n(salt) * 0.4 : 0.45 + c.n(salt) * (p === 0 ? 0.75 : 0.6);
      const x = (len / parts) * (p + 0.5);
      k.box(p % 2 ? P.stone : P.stoneLight, len / parts + 0.01, h, WALL_T, x, 0, 0);
      // The broken top: a block or two left askew on it.
      k.box(P.stoneDark, 0.22, 0.16, WALL_T * 0.8, x + (c.n(salt + 1) - 0.5) * 0.08, h - 0.03, (c.n(salt + 2) - 0.5) * 0.1, (c.n(salt + 3) - 0.5) * 0.5, 0, (c.n(salt + 4) - 0.5) * 0.5);
      if (c.n(salt + 5) < 0.5) k.box(P.stone, 0.16, 0.13, 0.2, x + 0.05, h + 0.1, (c.n(salt + 6) - 0.5) * 0.3, c.n(salt + 7) * 3, 0, 0.2);
      if (c.clime === "mire" && c.n(salt + 8) < 0.5) vine(k, x, h, (c.n(salt + 9) < 0.5 ? -1 : 1) * (WALL_T / 2 + 0.03), Math.min(h - 0.1, 0.3 + c.n(salt + 10) * 0.4));
      if (c.clime === "ash" && c.n(salt + 8) < 0.4) emberCrack(k, x, 0.05, (c.n(salt + 9) < 0.5 ? -1 : 1) * (WALL_T / 2 + 0.012), 0.2, 0, (c.n(salt + 10) - 0.5) * 0.8);
    }
    k.pop();
  });
  rubble(k, c, 7 + Math.floor(c.n(2) * 4), 0.82, 400, 0.42);
  drift(k, c, (c.n(3) - 0.5) * 0.8, (c.n(4) - 0.5) * 0.8, 0.36, 5);
}

function tower(k: Kit, c: Ctx) {
  const P = c.pal;
  const runs = joined(c);
  runs.forEach((on, i) => on && wallRun(k, c, SIDE[i].a, APO + 0.004, WALL_H, 10 + i * 40));
  const H = 3.5 + c.n(1) * 0.5;
  const turn = c.n(2) * 0.6;
  k.cyl(P.stoneDark, 0.9, 0.86, 0.34, 0, 0, 0, 10, turn);
  k.cyl(P.stone, 0.8, 0.72, H, 0, 0, 0, 10, turn);
  k.cyl(P.stoneLight, 0.78, 0.77, 0.09, 0, H * 0.52, 0, 10, turn);
  k.cyl(P.trim, 0.775, 0.77, 0.05, 0, H * 0.52 + 0.09, 0, 10, turn, 0, 0, 1, P.trimGlows ? GLOW : SOLID, true);
  // The head of it stands out over the shaft on a ring of corbels.
  k.cyl(P.stoneDark, 0.72, 0.86, 0.22, 0, H - 0.22, 0, 10, turn);
  k.cyl(P.stoneLight, 0.88, 0.88, 0.12, 0, H, 0, 10, turn);
  // Dressed blocks, and window slits up the side that looks out; one of them is lit.
  for (let j = 0; j < 9; j++) {
    const a = c.n(20 + j) * Math.PI * 2;
    const y = 0.5 + c.n(40 + j) * (H - 1.2);
    const r = 0.8 - (0.08 * y) / H;
    k.box(j % 2 ? P.stoneLight : P.stoneDark, 0.24, 0.15, 0.05, Math.sin(a) * r, y, Math.cos(a) * r, a);
  }
  const out = SIDE[c.open].a;
  [0, 1.9, -2.3].forEach((off, j) => {
    const a = faceZ(out + off);
    const y = j === 0 ? H * 0.62 : H * (0.3 + 0.16 * j);
    const r = 0.8 - (0.08 * y) / H + 0.004;
    const lit = j === 0;
    k.box(lit ? col("#ffc46a") : DARK, 0.1, 0.5, 0.02, Math.sin(a) * r, y, Math.cos(a) * r, a, 0, 0, lit ? GLOW : SOLID, true);
    k.box(P.stoneLight, 0.24, 0.06, 0.07, Math.sin(a) * r, y - 0.06, Math.cos(a) * r, a);
  });
  // A door at its foot, where no wall runs in.
  if (!runs[c.open]) {
    const a = faceZ(out);
    k.push(0, 0, 0, a);
    k.box(DARK, 0.36, 0.72, 0.03, 0, 0.3, 0.81);
    k.box(P.woodDark, 0.3, 0.66, 0.03, 0, 0.3, 0.8);
    k.box(P.stoneLight, 0.52, 0.1, 0.1, 0, 1.02, 0.8);
    k.box(P.stoneDark, 0.6, 0.3, 0.3, 0, 0, 0.84);
    k.pop();
  }
  const top = c.n(3);
  if (top < 0.42) {
    // A cone of slates, with a spike on it.
    k.cone(P.roof, 1.0, 1.35, 0, H + 0.12, 0, 10, turn);
    k.cyl(P.stoneDark, 0.5, 0.92, 0.1, 0, H + 0.1, 0, 10, turn);
    k.cyl(P.iron, 0.03, 0.01, 0.4, 0, H + 1.4, 0, 4);
    inlay(k, c, 0.1, 0.1, 0.1, 0, H + 1.42, 0, 0.8);
  } else {
    // Open to the sky: a ring of merlons round the walk.
    for (let j = 0; j < 8; j++) {
      const a = turn + (j / 8) * Math.PI * 2;
      k.box(P.stone, 0.34, 0.36, 0.17, Math.sin(a) * 0.8, H + 0.12, Math.cos(a) * 0.8, a);
      k.box(P.stoneLight, 0.38, 0.05, 0.21, Math.sin(a) * 0.8, H + 0.48, Math.cos(a) * 0.8, a);
    }
    k.disc(P.stoneDark, 0.8, 0, H + 0.125, 0, 10);
    if (top > 0.74) {
      // The roof fell in long ago: a few rafters and what is left of the cone.
      k.put(SOLID, unit("roofBroken", () => new THREE.ConeGeometry(1, 1, 10, 1, true, 0, Math.PI * 1.05).translate(0, 0.5, 0)), placed(0, H + 0.12, 0, 0.98, 1.2, 0.98, turn + c.n(4) * 6, 0, 0), P.roof);
      for (let j = 0; j < 3; j++) {
        const a = turn + 2 + j * 1.1;
        k.tube(P.woodDark, [[Math.sin(a) * 0.82, H + 0.16, Math.cos(a) * 0.82], [Math.sin(a) * 0.1, H + 1.1, Math.cos(a) * 0.1]], () => 0.035, 4);
      }
    } else if (c.n(5) < 0.5) {
      // A watch fire kept on the top of it.
      k.cyl(P.iron, 0.14, 0.24, 0.16, 0, H + 0.13, 0, 8);
      k.blob(EMBER, 0.16, 0.06, 0.16, 0, H + 0.3, 0, 1, 0, 0, 0, GLOW, true);
      k.fire(0, H + 0.3, 0, 0.2, { power: 0.9, range: 8, pool: 0, sparks: 5 });
    }
  }
  if (c.clime === "frost") {
    for (let j = 0; j < 6; j++) {
      const a = c.n(60 + j) * Math.PI * 2;
      k.cone(ICE, 0.035, 0.2 + c.n(70 + j) * 0.3, Math.sin(a) * 0.86, H - 0.2, Math.cos(a) * 0.86, 5, 0, Math.PI, 0);
    }
  }
  if (c.clime === "mire") for (let j = 0; j < 4; j++) { const a = c.n(60 + j) * Math.PI * 2; vine(k, Math.sin(a) * 0.82, H * 0.52, Math.cos(a) * 0.82, 0.5 + c.n(70 + j) * 0.9, a); }
  if (c.clime === "ash") for (let j = 0; j < 3; j++) { const a = c.n(60 + j) * Math.PI * 2; emberCrack(k, Math.sin(a) * 0.9, 0.05, Math.cos(a) * 0.9, 0.3, a, (c.n(80 + j) - 0.5) * 0.8); }
  drift(k, c, Math.cos(out + 2) * 0.95, Math.sin(out + 2) * 0.95, 0.4, 90);
}

/** The gate's wall, with the way through it cut out: built along x, the way through along z. */
const GATE = { half: 0.4, spring: 1.38, high: 2.5, thick: 0.72 };
function gateWall(): Float32Array {
  return unit("gate", () => {
    const s = new THREE.Shape();
    s.moveTo(-APO - 0.004, 0);
    s.lineTo(-GATE.half, 0);
    s.lineTo(-GATE.half, GATE.spring);
    s.absarc(0, GATE.spring, GATE.half, Math.PI, 0, true);
    s.lineTo(GATE.half, 0);
    s.lineTo(APO + 0.004, 0);
    s.lineTo(APO + 0.004, GATE.high);
    s.lineTo(-APO - 0.004, GATE.high);
    s.lineTo(-APO - 0.004, 0);
    return new THREE.ExtrudeGeometry(s, { depth: GATE.thick, bevelEnabled: false, curveSegments: 5 }).translate(0, 0, -GATE.thick / 2);
  });
}

function arch(k: Kit, c: Ctx) {
  const P = c.pal;
  const runs = joined(c);
  // In line with the walls beside it: through a pair of them that face each other, or along the one there is.
  let axis = [0, 1, 2].find((i) => runs[i] && runs[i + 3]) ?? runs.findIndex(Boolean);
  if (axis < 0) axis = (c.open + 1 + Math.floor(c.n(1) * 1.99)) % 3;
  const timber = runs.some(Boolean) && SIDE.every((_, i) => !runs[i] || c.kindAt(i) === "palisade");
  k.push(0, 0, 0, alongX(SIDE[axis].a));
  if (timber) {
    // A camp's gate: two great posts and a beam across, hung with a skull and rags.
    for (const s of [-1, 1]) {
      k.cyl(P.wood, 0.15, 0.12, 2.7, s * 0.56, 0, 0, 7);
      k.cone(P.woodDark, 0.12, 0.26, s * 0.56, 2.7, 0, 7);
      k.cyl(ROPE, 0.16, 0.16, 0.07, s * 0.56, 2.0, 0, 7);
      for (const x of [0.74, 0.86]) {
        const h = 1.75 + hash(c.t.q + s, c.t.r, x * 10) * 0.25;
        k.cyl(P.wood, 0.085, 0.075, h, s * x, 0, 0, 6);
        k.cone(P.woodDark, 0.075, 0.2, s * x, h, 0, 6);
      }
      hanging(k, BANNERS[Math.floor(c.n(8) * BANNERS.length * 0.999)], P.bone, 0.26, 0.62, s * 0.3, 2.22, 0.1, 1);
      hanging(k, BANNERS[Math.floor(c.n(8) * BANNERS.length * 0.999)], P.bone, 0.26, 0.62, s * 0.3, 2.22, -0.1, -1);
    }
    k.cyl(P.woodDark, 0.1, 0.1, 1.5, -0.75, 2.3, 0, 6, 0, 0, -Math.PI / 2);
    k.cyl(P.wood, 0.07, 0.07, 1.3, -0.65, 2.56, 0, 6, 0, 0, -Math.PI / 2);
    k.blob(P.bone, 0.13, 0.12, 0.12, 0, 2.5, 0.12, 2);
    k.cone(P.bone, 0.035, 0.24, -0.1, 2.56, 0.12, 5, 0, 0, 0.9);
    k.cone(P.bone, 0.035, 0.24, 0.1, 2.56, 0.12, 5, 0, 0, -0.9);
    k.pop();
    return;
  }
  const { half, spring, high, thick } = GATE;
  k.put(SOLID, gateWall(), null, P.stone);
  for (const s of [-1, 1]) {
    // The piers' feet, and the stones the arch springs from.
    k.box(P.stoneDark, APO - half + 0.06, 0.3, thick + 0.16, s * (half + (APO - half) / 2 + 0.03), 0, 0);
    k.box(P.stoneLight, 0.16, 0.12, thick + 0.1, s * (half + 0.05), spring - 0.12, 0);
    for (const z of [-1, 1]) {
      for (const x of [0.22, 0.66]) {
        k.box(P.stone, 0.27, 0.32, 0.17, s * x, high + 0.09, z * (thick / 2 + 0.015));
        k.box(P.stoneLight, 0.31, 0.05, 0.21, s * x, high + 0.41, z * (thick / 2 + 0.015));
      }
      k.box(c.n(30 + s + z) < 0.5 ? P.stoneLight : P.stoneDark, 0.24, 0.15, 0.045, s * 0.66, 0.5 + c.n(40 + s * 2 + z) * 1.2, z * (thick / 2));
    }
    if (c.clime === "frost") icicles(k, c, s * 0.1, s * 0.34, spring + half * 0.86, 0, 2, 50 + s);
    if (c.clime === "mire") vine(k, s * 0.62, high, thick / 2 + 0.05, 0.6 + c.n(60 + s) * 0.7);
    if (c.clime === "ash") emberCrack(k, s * 0.64, 0.06, thick / 2 + 0.012, 0.3, 0, s * 0.4);
  }
  k.box(P.stoneLight, APO * 2, 0.09, thick + 0.2, 0, high, 0);
  k.box(P.stoneLight, APO * 2, 0.08, thick + 0.1, 0, high - 0.34, 0);
  // The ring of stones round the opening, and its keystone.
  for (let j = 0; j < 7; j++) {
    const phi = ((j + 0.5) / 7) * Math.PI;
    const keystone = j === 3;
    const tone = keystone ? P.trim : j % 2 ? P.stoneLight : P.stoneDark;
    k.box(tone, keystone ? 0.2 : 0.17, keystone ? 0.22 : 0.15, thick + (keystone ? 0.12 : 0.07), Math.cos(phi) * half, spring + Math.sin(phi) * half, 0, 0, 0, phi - Math.PI / 2, keystone && P.trimGlows ? GLOW : SOLID, keystone);
  }
  if (c.clime === "frost") k.blob(SNOW, 0.6, 0.08, thick * 0.3, 0, high + 0.1, 0, 2, 0, 0, 0, SOLID, true);
  k.pop();
}

function pillar(k: Kit, c: Ctx) {
  const P = c.pal;
  const round = c.n(1) < 0.4;
  const H = 2.55;
  k.push(0, 0, 0, round ? 0 : Math.floor(c.n(2) * 2.99) * (Math.PI / 6));
  k.box(P.stoneDark, 1.0, 0.2, 1.0);
  k.box(P.stone, 0.82, 0.16, 0.82, 0, 0.2, 0);
  if (round) {
    k.cyl(P.stone, 0.31, 0.27, H, 0, 0.36, 0, 8);
    for (const [y, r] of [[0.36, 0.34], [0.36 + H * 0.33, 0.31], [0.36 + H * 0.66, 0.295], [0.36 + H - 0.08, 0.3]]) k.cyl(P.stoneLight, r, r, 0.07, 0, y, 0, 8);
    if (P.trimGlows) k.cyl(P.trim, 0.3, 0.3, 0.05, 0, 0.36 + H * 0.5, 0, 8, 0, 0, 0, 1, GLOW, true);
    else k.cyl(P.trim, 0.3, 0.3, 0.05, 0, 0.36 + H * 0.5, 0, 8, 0, 0, 0, 1, SOLID, true);
  } else {
    k.box(P.stone, 0.54, H, 0.54, 0, 0.36, 0);
    // Carved bands, inlaid: one low, one high, and a line down each face between them with a sign on it.
    inlay(k, c, 0.57, 0.06, 0.57, 0, 0.36 + 0.5, 0);
    inlay(k, c, 0.57, 0.06, 0.57, 0, 0.36 + H - 0.45, 0);
    k.box(P.stoneLight, 0.6, 0.1, 0.6, 0, 0.36 + 0.3, 0);
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      const [x, z] = [Math.sin(a) * 0.272, Math.cos(a) * 0.272];
      k.box(P.stoneDark, 0.2, H - 1.5, 0.02, x, 0.36 + 0.75, z, a);
      inlay(k, c, 0.035, H - 1.7, 0.03, x, 0.36 + 0.85, z, a);
      inlay(k, c, 0.14, 0.14, 0.03, x, 0.36 + H * 0.52, z, a, 0, Math.PI / 4);
    }
  }
  // The capital: stepping out to carry what is no longer there.
  const y = 0.36 + H;
  k.box(P.stoneLight, 0.66, 0.12, 0.66, 0, y, 0);
  k.box(P.stone, 0.84, 0.16, 0.84, 0, y + 0.12, 0);
  k.box(P.stoneDark, 0.94, 0.1, 0.94, 0, y + 0.28, 0);
  if (c.clime === "frost") {
    k.blob(SNOW, 0.4, 0.1, 0.4, 0, y + 0.4, 0, 2, 0, 0, 0, SOLID, true);
    for (const s of [-1, 1]) icicles(k, c, -0.4, 0.4, y + 0.28, s * 0.47, 3, 30 + s);
  }
  if (c.clime === "mire") for (let j = 0; j < 3; j++) vine(k, (c.n(40 + j) - 0.5) * 0.4, y, (j % 2 ? 1 : -1) * 0.3, 0.6 + c.n(50 + j) * 1.0);
  if (c.clime === "ash") emberCrack(k, 0.1, 0.4, 0.28, 0.4, 0, 0.3);
  k.pop();
  drift(k, c, (c.n(60) - 0.5) * 0.5, 0.55 * (c.n(61) < 0.5 ? -1 : 1), 0.36, 62);
}

function pillarBroken(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = Math.floor(c.n(2) * 2.99) * (Math.PI / 6);
  const stump = 0.5 + c.n(1) * 0.8;
  k.push(0, 0, 0, turn);
  k.box(P.stoneDark, 1.0, 0.2, 1.0);
  k.box(P.stone, 0.82, 0.16, 0.82, 0, 0.2, 0);
  k.box(P.stone, 0.54, stump, 0.54, 0, 0.36, 0);
  inlay(k, c, 0.57, 0.06, 0.57, 0, 0.36 + Math.min(0.5, stump - 0.12), 0);
  // Sheared off: the break is a lump of raw stone.
  k.blob(P.stoneLight, 0.3, 0.16, 0.3, 0.03, 0.36 + stump, -0.02, 0, c.n(3) * 6, 0.2, 0.15);
  k.pop();
  // Its drums, lying where they rolled.
  const fell = c.n(4) * Math.PI * 2;
  for (let j = 0; j < 3; j++) {
    const a = fell + (j - 1) * 0.9 + (c.n(10 + j) - 0.5) * 0.4;
    const d = 0.62 + j * 0.06 + c.n(20 + j) * 0.12;
    k.push(Math.cos(a) * d, 0.24, Math.sin(a) * d, c.n(30 + j) * 6, 0, Math.PI / 2 + (c.n(40 + j) - 0.5) * 0.3);
    k.box(j % 2 ? P.stone : P.stoneLight, 0.5, 0.4 + c.n(50 + j) * 0.25, 0.5, 0, -0.25, 0);
    if (j === 0) inlay(k, c, 0.53, 0.06, 0.53, 0, -0.1, 0);
    k.pop();
  }
  // And a piece of the capital.
  const a = fell + 2.6;
  k.box(P.stoneDark, 0.6, 0.14, 0.5, Math.cos(a) * 0.6, 0.02, Math.sin(a) * 0.6, a, 0.3, 0.12);
  rubble(k, c, 5, 0.85, 70, 0.5);
  drift(k, c, Math.cos(fell + 4) * 0.5, Math.sin(fell + 4) * 0.5, 0.34, 90);
}

/** The block a statue or an obelisk stands on; returns the height of its top. */
function pedestal(k: Kit, c: Ctx, wide: number): number {
  const P = c.pal;
  k.box(P.stoneDark, wide + 0.2, 0.2, wide + 0.2);
  k.box(P.stone, wide, 0.46, wide, 0, 0.2, 0);
  inlay(k, c, wide + 0.03, 0.06, wide + 0.03, 0, 0.5, 0);
  k.box(P.stoneLight, wide + 0.08, 0.1, wide + 0.08, 0, 0.66, 0);
  if (c.clime === "ash") emberCrack(k, 0.1, 0.22, wide / 2 + 0.012, 0.3, 0, 0.4);
  return 0.76;
}

function statue(k: Kit, c: Ctx) {
  const P = c.pal;
  const who = Math.floor(c.n(1) * 2.999);
  const headless = c.n(2) < 0.2;
  k.push(0, 0, 0, faceZ(SIDE[c.open].a));
  const y = pedestal(k, c, 0.88);
  const limb = (pts: number[][], r = 0.085) => k.tube(P.stone, pts, (t) => r * (1 - t * 0.25), 6);
  if (who === 1) {
    // The captain: in plate, a shield on the arm and a spear grounded beside.
    for (const s of [-1, 1]) {
      k.box(P.stone, 0.2, 0.72, 0.24, s * 0.15, y, 0);
      k.box(P.stoneLight, 0.23, 0.14, 0.27, s * 0.15, y + 0.3, 0.01);
      k.blob(P.stoneLight, 0.19, 0.16, 0.2, s * 0.43, y + 1.62, 0, 1);
    }
    k.cyl(P.stoneDark, 0.37, 0.28, 0.42, 0, y + 0.66, 0, 6);
    k.cyl(P.stone, 0.27, 0.35, 0.62, 0, y + 1.02, 0, 8);
    inlay(k, c, 0.56, 0.06, 0.5, 0, y + 1.02, 0);
    k.box(P.stoneLight, 0.3, 0.3, 0.1, 0, y + 1.25, 0.26);
    limb([[-0.43, y + 1.58, 0], [-0.52, y + 1.25, 0.1], [-0.44, y + 1.02, 0.26]]);
    k.cyl(P.stoneLight, 0.36, 0.36, 0.08, -0.46, y + 1.0, 0.3, 6, 0, Math.PI / 2, 0);
    inlay(k, c, 0.14, 0.14, 0.05, -0.46, y + 1.0 - 0.07, 0.38, 0, 0, Math.PI / 4);
    limb([[0.43, y + 1.58, 0], [0.56, y + 1.3, 0.12], [0.54, y + 1.12, 0.28]]);
    k.cyl(P.stoneDark, 0.035, 0.03, 3.0, 0.56, y, 0.3, 5);
    k.cone(P.trim, 0.09, 0.34, 0.56, y + 3.0, 0.3, 4, 0, 0, 0, P.trimGlows ? GLOW : SOLID, true);
    if (!headless) {
      k.blob(P.stone, 0.18, 0.2, 0.19, 0, y + 1.86, 0.01, 1);
      k.box(P.stoneDark, 0.3, 0.07, 0.26, 0, y + 1.9, 0.02);
      k.box(P.trim, 0.05, 0.24, 0.36, 0, y + 1.96, -0.03, 0, 0, 0, P.trimGlows ? GLOW : SOLID, true);
    }
  } else {
    // Robed. The warden leans on a great sword; the oracle holds out a bowl.
    k.cyl(P.stoneDark, 0.46, 0.44, 0.1, 0, y, 0, 8);
    k.cyl(P.stone, 0.42, 0.25, 1.22, 0, y + 0.04, 0, 8);
    for (let f = 0; f < 5; f++) {
      const a = -0.9 + f * 0.45;
      k.box(P.stoneDark, 0.05, 1.0, 0.04, Math.sin(a) * 0.37, y + 0.08, Math.cos(a) * 0.37, a, -0.14);
    }
    k.cyl(P.stone, 0.26, 0.31, 0.5, 0, y + 1.24, 0, 8);
    k.box(P.stoneLight, 0.8, 0.2, 0.36, 0, y + 1.62, 0);
    inlay(k, c, 0.5, 0.05, 0.34, 0, y + 1.28, 0.02);
    if (!headless) {
      k.blob(P.stoneDark, 0.25, 0.27, 0.26, 0, y + 2.04, -0.05, 1);
      k.blob(P.stoneLight, 0.15, 0.18, 0.13, 0, y + 2.0, 0.1, 0);
    }
    if (who === 0) {
      for (const s of [-1, 1]) limb([[s * 0.4, y + 1.7, 0], [s * 0.4, y + 1.36, 0.2], [s * 0.1, y + 1.14, 0.36]], 0.095);
      k.box(P.stoneLight, 0.13, 1.1, 0.045, 0, y, 0.38);
      k.box(P.trim, 0.46, 0.06, 0.09, 0, y + 1.08, 0.38, 0, 0, 0, P.trimGlows ? GLOW : SOLID, true);
      k.box(P.stoneDark, 0.07, 0.22, 0.07, 0, y + 1.12, 0.38);
      k.blob(P.trim, 0.07, 0.07, 0.07, 0, y + 1.38, 0.38, 1, 0, 0, 0, P.trimGlows ? GLOW : SOLID, true);
    } else {
      for (const s of [-1, 1]) limb([[s * 0.4, y + 1.7, 0], [s * 0.36, y + 1.5, 0.26], [s * 0.14, y + 1.52, 0.46]], 0.09);
      k.cyl(P.trim, 0.1, 0.24, 0.13, 0, y + 1.5, 0.5, 8, 0, 0, 0, 1, P.trimGlows ? GLOW : SOLID, true);
      k.cyl(P.trim, 0.33, 0.33, 0.035, 0, y + 2.06, -0.2, 10, 0, Math.PI / 2, 0, 1, P.trimGlows ? GLOW : SOLID, true);
      if (c.clime !== "greenwood" && c.clime !== "dunes") {
        k.blob(P.glyph, 0.11, 0.11, 0.11, 0, y + 1.7, 0.5, 2, 0, 0, 0, GLOW);
        k.glowPool(0, 0.3, P.glyph, 1.9, 0.22);
      }
    }
  }
  if (headless) k.blob(P.stone, 0.2, 0.21, 0.2, 0.5, 0.14, 0.62, 1, 1.2, 0.4);
  if (c.clime === "mire") { vine(k, -0.3, y + 1.6, 0.2, 0.8); vine(k, 0.34, y + 1.55, -0.16, 0.6, 2); }
  k.pop();
  drift(k, c, Math.cos(SIDE[c.open].a + 2.4) * 0.6, Math.sin(SIDE[c.open].a + 2.4) * 0.6, 0.36, 90);
}

function obelisk(k: Kit, c: Ctx) {
  const P = c.pal;
  const H = 3.0;
  const [r0, r1] = [0.36, 0.2];
  k.push(0, 0, 0, Math.floor(c.n(1) * 2.99) * (Math.PI / 6), (c.n(2) - 0.5) * 0.05, (c.n(3) - 0.5) * 0.05);
  k.box(P.stoneDark, 0.96, 0.18, 0.96);
  k.box(P.stone, 0.74, 0.16, 0.74, 0, 0.18, 0);
  k.cyl(c.clime === "ash" ? P.stoneDark : P.stone, r0, r1, H, 0, 0.34, 0, 4, Math.PI / 4);
  k.cone(P.trim, r1, 0.4, 0, 0.34 + H, 0, 4, Math.PI / 4, 0, 0, P.trimGlows ? GLOW : SOLID, true);
  // Written on all four sides: a column of signs up each face, faintly alight.
  const lean = Math.atan(((r0 - r1) * Math.SQRT1_2) / H);
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2;
    for (let g = 0; g < 6; g++) {
      const y = 0.34 + 0.34 + g * 0.4;
      const out = (r0 + ((r1 - r0) * (y - 0.34)) / H) * Math.SQRT1_2 + 0.006;
      const kind = Math.floor(hash(c.t.q + f, c.t.r + g, 31) * 3.99);
      const [w, h] = kind === 0 ? [0.16, 0.05] : kind === 1 ? [0.05, 0.2] : kind === 2 ? [0.12, 0.12] : [0.18, 0.04];
      const tone = P.glyph.clone().multiplyScalar(0.55 + hash(c.t.q + g, c.t.r + f, 32) * 0.5);
      k.box(tone, w * (1 - g * 0.06), h, 0.012, Math.sin(a) * out, y, Math.cos(a) * out, a, -lean, kind === 2 ? Math.PI / 4 : 0, GLOW, true);
      if (kind === 3) k.box(tone, 0.05, 0.14, 0.012, Math.sin(a) * out, y + 0.06, Math.cos(a) * out, a, -lean, 0, GLOW, true);
    }
  }
  if (c.clime === "frost") k.blob(SNOW, 0.42, 0.08, 0.42, 0, 0.36, 0, 2, 0, 0, 0, SOLID, true);
  k.pop();
  k.glowPool(0, 0, P.glyph, 2.3, 0.3);
  drift(k, c, 0.5, -0.4, 0.34, 40);
}

function altar(k: Kit, c: Ctx) {
  const P = c.pal;
  k.push(0, 0, 0, faceZ(SIDE[c.open].a));
  k.box(P.stoneDark, 1.5, 0.12, 1.1);
  k.box(P.stone, 1.3, 0.12, 0.9, 0, 0.12, 0);
  for (const s of [-1, 1]) {
    k.box(P.stoneDark, 0.24, 0.5, 0.6, s * 0.4, 0.24, 0);
    inlay(k, c, 0.26, 0.05, 0.62, s * 0.4, 0.6, 0);
  }
  k.box(P.stoneLight, 1.22, 0.16, 0.76, 0, 0.74, 0);
  inlay(k, c, 1.24, 0.04, 0.78, 0, 0.8, 0);
  // A sign cut into its face, and the runnel the offerings drained by.
  k.box(P.glyph.clone().multiplyScalar(0.7), 0.16, 0.16, 0.012, 0, 0.42, 0.306, 0, 0, Math.PI / 4, GLOW, true);
  k.box(DARK, 0.04, 0.012, 0.6, 0.3, 0.9, 0.05);
  // A cloth across it, a bowl, and two stubs of candle still burning.
  const cloth = BANNERS[Math.floor(c.n(1) * BANNERS.length * 0.999)];
  k.box(cloth, 0.4, 0.02, 0.8, -0.12, 0.9, 0, 0, 0, 0, SOLID, true);
  k.box(cloth, 0.4, 0.3, 0.02, -0.12, 0.6, 0.4, 0, 0, 0, SOLID, true);
  k.box(P.trim, 0.4, 0.035, 0.025, -0.12, 0.62, 0.402, 0, 0, 0, SOLID, true);
  k.cyl(P.trim, 0.08, 0.15, 0.09, -0.12, 0.92, 0, 8, 0, 0, 0, 1, P.trimGlows ? GLOW : SOLID, true);
  for (const s of [-1, 1]) {
    const h = 0.12 + c.n(5 + s) * 0.1;
    k.cyl(P.bone, 0.035, 0.03, h, 0.3 + s * 0.14, 0.9, -0.2 + s * 0.06, 6);
    k.cone(col("#ffd98a"), 0.022, 0.07, 0.3 + s * 0.14, 0.9 + h, -0.2 + s * 0.06, 5, 0, 0, 0, GLOW, true);
  }
  k.glowPool(0.3, -0.2, FIRE, 1.6, 0.2, true);
  if (c.clime === "frost") icicles(k, c, -0.55, 0.55, 0.74, 0.38, 4, 20);
  if (c.clime === "mire") vine(k, 0.48, 0.74, 0.39, 0.5);
  k.pop();
  drift(k, c, -0.6, 0.5, 0.3, 30);
}

function well(k: Kit, c: Ctx) {
  const P = c.pal;
  k.push(0, 0, 0, faceZ(SIDE[c.open].a) + 0.4);
  const stones = 10;
  for (let j = 0; j < stones; j++) {
    const a = (j / stones) * Math.PI * 2;
    const tone = [P.stone, P.stoneLight, P.stoneDark][j % 3];
    k.box(tone, 0.34, 0.46 + hash(c.t.q, c.t.r, 10 + j) * 0.06, 0.2, Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5, a);
    k.box(P.stoneLight, 0.36, 0.07, 0.26, Math.sin(a + 0.31) * 0.5, 0.48, Math.cos(a + 0.31) * 0.5, a + 0.31);
  }
  k.disc(c.clime === "mire" ? raw("#16261c") : c.clime === "ash" ? raw("#2a0f08") : DARK, 0.44, 0, 0.26, 0, 10, false, SOLID, true);
  if (c.clime === "ash") k.disc(EMBER_DEEP, 0.2, 0, 0.27, 0, 7, false, GLOW, true);
  // The frame over it: two posts, a roof of two boards, the windlass and its rope.
  for (const s of [-1, 1]) {
    k.box(P.wood, 0.09, 1.5, 0.09, s * 0.62, 0, 0);
    k.poly(P.roof, [[-0.74, 1.46, 0], [0.74, 1.46, 0], [0.74, 1.24, s * 0.34], [-0.74, 1.24, s * 0.34]], [0, 1, s], true);
  }
  k.cyl(P.woodDark, 0.06, 0.06, 1.24, -0.62, 1.12, 0, 6, 0, 0, -Math.PI / 2);
  k.cyl(ROPE, 0.075, 0.075, 0.3, -0.15, 1.12, 0, 6, 0, 0, -Math.PI / 2, 1, SOLID, true);
  k.box(ROPE, 0.025, 0.5, 0.025, 0.05, 0.62, 0, 0, 0, 0, SOLID, true);
  k.cyl(P.wood, 0.09, 0.11, 0.16, 0.05, 0.48, 0, 7);
  k.box(P.iron, 0.3, 0.03, 0.03, 0.78, 1.12, 0);
  k.box(P.iron, 0.03, 0.2, 0.03, 0.92, 0.94, 0);
  if (c.clime === "frost") icicles(k, c, -0.7, 0.7, 1.25, 0.34, 4, 30);
  k.pop();
  drift(k, c, 0.7, -0.3, 0.3, 40);
}

function stairs(k: Kit, c: Ctx) {
  const P = c.pal;
  // Up toward the highest ground beside it.
  let to = 0;
  let best = -Infinity;
  SIDE.forEach((_, i) => {
    const r = c.rise(i);
    if (r !== undefined && r > best + 0.01) [best, to] = [r, i];
  });
  const up = THREE.MathUtils.clamp(best, 0.3, 2.6);
  if (best < 0.2) to = c.open;
  const steps = THREE.MathUtils.clamp(Math.round(up / 0.155), 2, 13);
  const [x0, x1] = [-0.05, APO + 0.01];
  const run = (x1 - x0) / steps;
  k.push(0, 0, 0, alongX(SIDE[to].a));
  for (let i = 0; i < steps; i++) {
    const h = ((i + 1) * up) / steps;
    const x = x0 + run * (i + 0.5);
    k.box(i % 2 ? P.stone : P.stoneLight, run + 0.012, h, 1.02, x, -0.02, 0);
    // The cheeks: a low stepped wall either side.
    for (const s of [-1, 1]) k.box(P.stoneDark, run + 0.012, h + 0.14, 0.14, x, -0.02, s * 0.58);
  }
  for (const s of [-1, 1]) {
    k.box(P.stoneDark, 0.2, 0.42, 0.2, x0 - 0.06, -0.02, s * 0.58);
    inlay(k, c, 0.22, 0.05, 0.22, x0 - 0.06, 0.4, s * 0.58);
    k.cone(P.stoneLight, 0.15, 0.12, x0 - 0.06, 0.45, s * 0.58, 4, Math.PI / 4);
    if (c.clime === "mire") vine(k, x1 - 0.2, up + 0.1, s * 0.66, Math.min(up, 0.5));
  }
  k.pop();
}

// ---- fire ----

function brazier(k: Kit, c: Ctx) {
  const P = c.pal;
  k.push(0, 0, 0, Math.floor(c.n(1) * 2.99) * (Math.PI / 6));
  k.box(P.stoneDark, 0.74, 0.14, 0.74);
  k.box(P.stone, 0.56, 0.36, 0.56, 0, 0.14, 0);
  inlay(k, c, 0.59, 0.05, 0.59, 0, 0.36, 0);
  k.box(P.stoneLight, 0.64, 0.08, 0.64, 0, 0.5, 0);
  // The iron: three legs gripping a bowl of coals.
  for (let j = 0; j < 3; j++) {
    const a = (j / 3) * Math.PI * 2 + 0.5;
    k.tube(P.iron, [[Math.sin(a) * 0.22, 0.58, Math.cos(a) * 0.22], [Math.sin(a) * 0.08, 0.8, Math.cos(a) * 0.08], [Math.sin(a) * 0.2, 1.06, Math.cos(a) * 0.2]], () => 0.028, 4);
  }
  k.cyl(P.iron, 0.14, 0.35, 0.2, 0, 1.0, 0, 8);
  k.cyl(P.iron, 0.37, 0.37, 0.045, 0, 1.19, 0, 8);
  k.disc(EMBER_DEEP, 0.31, 0, 1.24, 0, 8, false, GLOW, true);
  for (let j = 0; j < 5; j++) k.blob(j % 2 ? EMBER : EMBER_DEEP, 0.09, 0.06, 0.09, (c.n(10 + j) - 0.5) * 0.36, 1.26, (c.n(20 + j) - 0.5) * 0.36, j, c.n(30 + j) * 6, 0, 0, GLOW, true);
  k.fire(0, 1.26, 0, 0.25, { power: 1.15, range: 9, pool: 3.6, sparks: 9 });
  if (c.clime === "frost") icicles(k, c, -0.3, 0.3, 0.5, 0.33, 3, 40);
  k.pop();
  drift(k, c, 0.5, 0.42, 0.26, 50);
}

function campfire(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = c.n(1) * 6;
  k.disc(raw("#221c1a"), 0.5, 0, 0.012, 0, 9, false, SOLID, true);
  for (let j = 0; j < 9; j++) {
    const a = turn + (j / 9) * Math.PI * 2;
    const s = 0.1 + c.n(10 + j) * 0.05;
    k.blob([P.stone, P.stoneDark, P.stoneLight][j % 3], s, s * 0.75, s, Math.sin(a) * 0.44, s * 0.4, Math.cos(a) * 0.44, j, a);
  }
  // Logs stood together over the embers.
  for (let j = 0; j < 5; j++) {
    const a = turn + (j / 5) * Math.PI * 2 + 0.3;
    k.tube(j % 2 ? P.woodDark : P.wood, [[Math.sin(a) * 0.34, 0.03, Math.cos(a) * 0.34], [Math.sin(a) * 0.02, 0.44, Math.cos(a) * 0.02]], () => 0.055, 5);
  }
  for (let j = 0; j < 6; j++) k.blob(j % 2 ? EMBER : EMBER_DEEP, 0.08, 0.05, 0.08, (c.n(20 + j) - 0.5) * 0.36, 0.06, (c.n(30 + j) - 0.5) * 0.36, j, 0, 0, 0, GLOW, true);
  k.fire(0, 0.1, 0, 0.31, { power: 1.2, range: 9, pool: 3.8, sparks: 10 });
  // A log to sit on, a stack of split wood, and a pot hung over the fire on some.
  const seat = turn + 1.2;
  k.cyl(P.wood, 0.13, 0.13, 0.72, Math.sin(seat) * 0.78 - Math.cos(seat) * 0.36, 0.13, Math.cos(seat) * 0.78 + Math.sin(seat) * 0.36, 7, seat, 0, Math.PI / 2);
  const pile = turn + 3.6;
  for (let j = 0; j < 4; j++) k.cyl(j % 2 ? P.wood : P.woodDark, 0.05, 0.05, 0.4, Math.sin(pile) * 0.8 + (j % 2) * 0.09 - 0.2, 0.05 + Math.floor(j / 2) * 0.09, Math.cos(pile) * 0.8, 5, pile + 0.3, 0, Math.PI / 2);
  if (c.n(2) < 0.6) {
    const a = turn + 0.4;
    for (const s of [-1, 1]) k.tube(P.woodDark, [[Math.sin(a) * 0.5 * s, 0, Math.cos(a) * 0.5 * s], [Math.sin(a) * 0.46 * s, 0.9, Math.cos(a) * 0.46 * s]], () => 0.025, 4);
    k.tube(P.iron, [[Math.sin(a) * -0.5, 0.86, Math.cos(a) * -0.5], [Math.sin(a) * 0.5, 0.86, Math.cos(a) * 0.5]], () => 0.018, 4);
    k.box(P.iron, 0.015, 0.2, 0.015, 0, 0.66, 0);
    k.cyl(P.iron, 0.09, 0.13, 0.14, 0, 0.54, 0, 7);
  }
}

// ---- camps ----

function tent(k: Kit, c: Ctx) {
  const P = c.pal;
  const cloth = BANNERS[Math.floor(c.n(1) * BANNERS.length * 0.999)];
  k.push(0, 0, 0, faceZ(SIDE[c.open].a));
  if (c.n(2) < 0.32) {
    // A round pavilion: a drum of canvas under a peaked roof, a pennant at the top.
    k.cyl(P.canvasDark, 0.76, 0.76, 0.52, 0, 0, 0, 8);
    k.cone(P.canvas, 0.9, 1.0, 0, 0.5, 0, 8);
    k.cyl(cloth, 0.91, 0.84, 0.1, 0, 0.46, 0, 8, 0, 0, 0, 1, SOLID, true);
    k.box(DARK, 0.34, 0.46, 0.03, 0, 0, 0.705);
    k.poly(P.canvas, [[0.17, 0.46, 0.72], [0.17, 0, 0.72], [0.34, 0, 0.78]], [0.3, 0, 1], true);
    k.cyl(P.woodDark, 0.025, 0.02, 0.5, 0, 1.46, 0, 4);
    k.poly(cloth, [[0, 1.92, 0], [0.36, 1.84, 0.04], [0, 1.74, 0]], [0, 0, 1], true, SOLID, true);
    for (let j = 0; j < 4; j++) {
      const a = (j / 4) * Math.PI * 2 + 0.78;
      k.tube(ROPE, [[Math.sin(a) * 0.86, 0.52, Math.cos(a) * 0.86], [Math.sin(a) * 1.12, 0.02, Math.cos(a) * 1.12]], () => 0.012, 3, 1, SOLID, true);
    }
  } else {
    // A ridge tent: canvas over a pole, laced shut at the back and tied open at the front.
    const [w, h, l] = [0.66, 1.12, 0.72];
    for (const s of [-1, 1]) {
      for (let p = 0; p < 3; p++) {
        const [z0, z1] = [-l + (p * 2 * l) / 3, -l + ((p + 1) * 2 * l) / 3];
        k.poly(p === 1 ? P.canvasDark : P.canvas, [[s * w, 0, z0], [s * w, 0, z1], [0, h, z1], [0, h, z0]], [s, 0.6, 0]);
      }
      k.poly(cloth, [[s * (w + 0.012), 0, -l], [s * (w + 0.012), 0, l], [s * (w * 0.87 + 0.012), h * 0.13, l], [s * (w * 0.87 + 0.012), h * 0.13, -l]], [s, 0.6, 0], false, SOLID, true);
      k.poly(P.canvas, [[s * w, 0, l], [s * 0.13, 0, l], [0, h, l]], [0, 0, 1]);
      k.poly(P.canvasDark, [[s * w, 0, -l], [0, 0, -l], [0, h, -l]], [0, 0, -1]);
      for (const z of [-0.4, 0.4]) {
        k.tube(ROPE, [[s * w * 0.5, h * 0.5, z], [s * (w + 0.3), 0.02, z * 1.25]], () => 0.012, 3, 1, SOLID, true);
        k.cyl(P.woodDark, 0.02, 0.015, 0.12, s * (w + 0.3), 0, z * 1.25, 4, 0, 0, s * -0.4);
      }
    }
    k.poly(DARK, [[-0.13, 0, l - 0.01], [0.13, 0, l - 0.01], [0, h * 0.86, l - 0.01]], [0, 0, 1]);
    k.cyl(P.woodDark, 0.03, 0.03, h + 0.14, 0, 0, l, 5);
    k.cyl(P.woodDark, 0.03, 0.03, h + 0.14, 0, 0, -l, 5);
    k.cyl(P.wood, 0.028, 0.028, 2 * l + 0.24, 0, h + 0.02, -l - 0.12, 5, 0, Math.PI / 2, 0);
    // A bedroll put out by the door.
    k.cyl(cloth, 0.085, 0.085, 0.46, 0.2, 0.085, 0.84, 7, 0.3, 0, Math.PI / 2, 1, SOLID, true);
  }
  k.pop();
  drift(k, c, Math.cos(SIDE[c.open].a + 2.6) * 0.75, Math.sin(SIDE[c.open].a + 2.6) * 0.75, 0.32, 40);
}

/** A run of sharpened stakes from the middle of the hex out through the side at angle `a`. */
function stakeRun(k: Kit, c: Ctx, a: number, len: number, salt: number) {
  const P = c.pal;
  k.push(0, 0, 0, alongX(a));
  const count = Math.round(len / 0.168);
  for (let j = 0; j < count; j++) {
    const x = ((j + 0.5) / count) * len;
    const h = 1.72 + c.n(salt + j) * 0.34;
    const lean = (c.n(salt + 20 + j) - 0.5) * 0.1;
    k.push(x, -0.04, (c.n(salt + 40 + j) - 0.5) * 0.05, c.n(salt + 60 + j) * 3, lean, lean * 0.6);
    k.cyl(j % 3 === 1 ? P.woodDark : P.wood, 0.09, 0.078, h, 0, 0, 0, 6);
    k.cone(j % 3 === 1 ? P.wood : P.woodDark, 0.078, 0.22, 0, h, 0, 6);
    k.pop();
  }
  // Lashed to two rails on the inside.
  for (const y of [0.55, 1.3]) {
    k.box(P.woodDark, len, 0.07, 0.06, len / 2, y, 0.11);
    k.box(ROPE, 0.05, 0.1, 0.24, len * 0.3, y - 0.015, 0, 0, 0, 0, SOLID, true);
    k.box(ROPE, 0.05, 0.1, 0.24, len * 0.8, y - 0.015, 0, 0, 0, 0, SOLID, true);
  }
  if ((c.clime === "dunes" || c.clime === "frost") && c.n(salt + 90) < 0.5) drift(k, c, len * 0.5, -0.24, 0.3, salt + 91);
  k.pop();
}

function palisade(k: Kit, c: Ctx) {
  const runs = joined(c);
  let to = runs.flatMap((on, i) => (on ? [i] : []));
  if (to.length === 0) {
    const i = Math.floor(c.n(1) * 2.99);
    to = [i, i + 3];
    to.forEach((s, j) => stakeRun(k, c, SIDE[s % 6].a, 0.78, 10 + j * 100));
  } else to.forEach((s, j) => stakeRun(k, c, SIDE[s].a, APO + 0.004, 10 + j * 100));
  // A stouter post where the runs meet, and a brace behind it.
  k.cyl(c.pal.woodDark, 0.12, 0.1, 2.2, 0, -0.04, 0, 7);
  k.cone(c.pal.wood, 0.1, 0.26, 0, 2.16, 0, 7);
  const a = SIDE[to[0] % 6].a + Math.PI / 2;
  k.tube(c.pal.wood, [[Math.cos(a) * 0.7, 0, Math.sin(a) * 0.7], [Math.cos(a) * 0.1, 1.25, Math.sin(a) * 0.1]], () => 0.05, 5);
}

/** A cartwheel in the x-y plane, its hub at the origin of the current frame. */
function wheel(k: Kit, pal: Pal, r: number) {
  k.put(SOLID, U.torus(), placed(0, 0, 0, r, r, r * 0.9, 0, 0, 0), pal.woodDark);
  for (let j = 0; j < 3; j++) k.box(pal.wood, 0.05, r * 1.9, 0.04, Math.sin((j * Math.PI) / 3) * r * 0.95, -Math.cos((j * Math.PI) / 3) * r * 0.95, 0, 0, 0, (j * Math.PI) / 3);
  k.cyl(pal.iron, 0.06, 0.06, 0.12, 0, 0, -0.06, 6, 0, Math.PI / 2, 0);
}

function cart(k: Kit, c: Ctx) {
  const P = c.pal;
  // Lengthwise toward a corner of the hex, where there is most room; down on the side whose wheel came off.
  k.push(0, 0, 0, faceZ(SIDE[c.open].a + Math.PI / 6));
  k.push(0.48, 0.33, -0.05, 0, 0, 0.3);
  k.cyl(P.woodDark, 0.04, 0.04, 1.08, 0.06, 0, 0, 5, 0, 0, Math.PI / 2);
  k.push(0.07, 0, 0, Math.PI / 2);
  wheel(k, P, 0.33);
  k.pop();
  // The bed and its boards.
  k.box(P.wood, 0.8, 0.07, 1.2, -0.48, 0.05, 0);
  for (let p = 0; p < 4; p++) k.box(P.woodDark, 0.015, 0.012, 1.2, -0.78 + p * 0.2, 0.12, 0);
  for (const s of [-1, 1]) {
    k.box(P.woodDark, 0.045, 0.24, 1.2, -0.48 + s * 0.4, 0.1, 0);
    k.box(P.wood, 0.05, 0.05, 1.26, -0.48 + s * 0.4, 0.34, 0);
    k.tube(P.wood, [[-0.48 + s * 0.3, 0.08, 0.6], [-0.48 + s * 0.26, 0.02, 1.2]], () => 0.035, 5);
  }
  k.box(P.woodDark, 0.8, 0.24, 0.045, -0.48, 0.1, -0.58);
  k.blob(P.canvas, 0.2, 0.14, 0.17, -0.6, 0.24, -0.25, 2, 0.5);
  k.blob(P.canvasDark, 0.17, 0.12, 0.15, -0.36, 0.22, -0.1, 2, 2);
  k.box(P.wood, 0.3, 0.26, 0.3, -0.5, 0.12, 0.28, 0.3);
  k.pop();
  // The wheel that came off, lying flat, and a board or two.
  k.push(-0.62, 0.05, 0.5, 0.7, Math.PI / 2 - 0.08);
  wheel(k, P, 0.33);
  k.pop();
  k.box(P.woodDark, 0.5, 0.03, 0.09, -0.3, 0.01, -0.72, 0.5, 0, 0.04);
  k.pop();
  drift(k, c, 0.4, 0.55, 0.3, 30);
}

function banner(k: Kit, c: Ctx) {
  const P = c.pal;
  const cloth = BANNERS[Math.floor(c.n(1) * BANNERS.length * 0.999)];
  // The pole stands toward a corner of the hex, out of the way of whoever walks through.
  const corner = SIDE[Math.floor(c.n(2) * 5.99)].a + Math.PI / 6;
  k.push(Math.cos(corner) * 0.66, 0, Math.sin(corner) * 0.66, faceZ(SIDE[c.open].a));
  k.cyl(P.wood, 0.045, 0.03, 3.0, 0, 0, 0, 6);
  k.cone(P.trim, 0.06, 0.2, 0, 3.0, 0, 4, 0, 0, 0, P.trimGlows ? GLOW : SOLID, true);
  k.box(P.woodDark, 0.72, 0.05, 0.05, 0, 2.78, 0.04);
  for (let j = 0; j < 3; j++) k.blob([P.stone, P.stoneDark, P.stoneLight][j], 0.14, 0.1, 0.12, Math.sin(j * 2.1) * 0.14, 0.05, Math.cos(j * 2.1) * 0.14, j, j);
  // The cloth: hung from the bar, falling in a slow wave to a forked tail.
  const rows = [2.76, 2.44, 2.12, 1.84];
  const wave = [0.05, 0.1, 0.03, 0.09];
  const half = 0.3;
  for (let r = 0; r < rows.length - 1; r++) {
    const tone = r === 1 ? cloth.clone().multiplyScalar(0.86) : cloth;
    k.poly(tone, [[-half, rows[r], wave[r]], [half, rows[r], wave[r]], [half, rows[r + 1], wave[r + 1]], [-half, rows[r + 1], wave[r + 1]]], [0, 0, 1], true, SOLID, true);
  }
  for (const s of [-1, 1]) k.poly(cloth, [[s * half, 1.84, 0.09], [0, 1.84, 0.09], [s * half * 0.72, 1.52, 0.06]], [0, 0, 1], true, SOLID, true);
  for (const s of [-1, 1]) k.poly(P.trim, [[0, 2.5, 0.09 + s * 0.012], [0.13, 2.3, 0.075 + s * 0.012], [0, 2.1, 0.045 + s * 0.012], [-0.13, 2.3, 0.075 + s * 0.012]], [0, 0, s], false, SOLID, true);
  k.pop();
}

function barrel(k: Kit, pal: Pal, r: number, h: number) {
  k.cyl(pal.wood, r * 0.86, r, h / 2, 0, 0, 0, 8);
  k.cyl(pal.wood, r, r * 0.86, h / 2, 0, h / 2, 0, 8);
  k.cyl(pal.iron, r * 0.95, r * 0.99, 0.04, 0, h * 0.18, 0, 8);
  k.cyl(pal.iron, r * 0.99, r * 0.95, 0.04, 0, h * 0.75, 0, 8);
  k.disc(pal.woodDark, r * 0.8, 0, h + 0.002, 0, 8);
}

function barrels(k: Kit, c: Ctx) {
  const P = c.pal;
  k.push(0, 0, 0, c.n(1) * 6);
  k.push(-0.34, 0, -0.22);
  barrel(k, P, 0.25, 0.62);
  k.pop();
  k.push(0.2, 0, -0.4, 1);
  barrel(k, P, 0.23, 0.58);
  k.pop();
  k.push(-0.1, 0.6, -0.32, 2);
  barrel(k, P, 0.19, 0.46);
  k.pop();
  k.push(0.62, 0.22, 0.2, 0.5, 0, Math.PI / 2);
  barrel(k, P, 0.22, 0.56);
  k.pop();
  // A crate, and sacks slumped against it.
  k.box(P.wood, 0.4, 0.36, 0.4, -0.36, 0, 0.42, 0.3);
  for (const s of [-1, 1]) k.box(P.woodDark, 0.42, 0.05, 0.05, -0.36 + Math.sin(0.3) * s * 0.18, 0.31, 0.42 + Math.cos(0.3) * s * 0.18, 0.3);
  k.box(P.woodDark, 0.05, 0.37, 0.42, -0.36, 0, 0.42, 0.3);
  k.blob(P.canvas, 0.22, 0.17, 0.18, 0.1, 0.13, 0.5, 2, 0.4);
  k.blob(P.canvasDark, 0.2, 0.15, 0.17, 0.3, 0.11, 0.7, 2, 1.8);
  k.blob(P.canvas, 0.17, 0.13, 0.15, 0.14, 0.34, 0.56, 2, 3);
  k.pop();
  drift(k, c, -0.6, -0.5, 0.26, 20);
}

// ---- the wild ----

function standingStone(k: Kit, c: Ctx) {
  const P = c.pal;
  const tall = c.clime === "dunes" ? 1.18 : 1;
  const lean = (0.06 + c.n(1) * 0.12) * (c.clime === "dunes" ? 1.7 : 1);
  const turn = c.n(2) * 6;
  const rock = c.clime === "dunes" ? P.cliff : [P.stone, P.stoneDark, P.stoneLight];
  k.push(0, -0.06, 0, turn, lean, (c.n(3) - 0.5) * 0.12);
  k.cyl(rock[0], 0.44, 0.38, 1.15 * tall, 0, 0, 0, 5, 0, 0, 0, 0.7);
  k.cyl(rock[1], 0.38, 0.31, 1.0 * tall, 0.02, 1.13 * tall, 0, 5, 0.45, 0, 0, 0.72);
  k.cyl(rock[2], 0.31, 0.17, 0.95 * tall, 0, 2.1 * tall, 0.01, 5, 0.95, 0, 0, 0.75);
  if (c.clime === "frost") k.blob(SNOW, 0.2, 0.07, 0.15, 0, 3.06 * tall, 0, 2, 0, 0, 0, SOLID, true);
  // Rings cut round it; on some, a sign that still gives light.
  k.cyl(P.stoneDark, 0.415, 0.41, 0.04, 0, 0.7 * tall, 0, 5, 0, 0, 0, 0.72, SOLID, true);
  if (c.n(4) < 0.3 || c.clime === "ash") {
    const tone = P.glyph;
    k.box(tone, 0.05, 0.5, 0.012, 0, 1.3 * tall, 0.265, 0, 0, 0, GLOW, true);
    k.box(tone, 0.2, 0.05, 0.012, 0, 1.62 * tall, 0.26, 0, 0, 0, GLOW, true);
    k.box(tone, 0.14, 0.14, 0.012, 0, 1.0 * tall, 0.3, 0, 0, Math.PI / 4, GLOW, true);
    k.pop();
    k.glowPool(0, 0, tone, 2.0, 0.26);
  } else k.pop();
  for (let j = 0; j < 3; j++) {
    const a = turn + j * 2.2;
    k.blob(rock[j % 3], 0.14 + c.n(10 + j) * 0.08, 0.1, 0.14, Math.cos(a) * 0.58, 0.05, Math.sin(a) * 0.58, j, a);
  }
  drift(k, c, Math.cos(turn + 1) * 0.5, Math.sin(turn + 1) * 0.5, 0.36, 20);
}

function boulder(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = c.n(1) * 6;
  const rock = P.cliff;
  k.push(0, 0, 0, turn);
  k.blob(rock[0], 0.8, 0.72, 0.7, 0, 0.5, 0, 2, 0, (c.n(2) - 0.5) * 0.4, (c.n(3) - 0.5) * 0.4);
  k.blob(rock[1], 0.46, 0.42, 0.44, 0.56, 0.24, 0.3, 0, 1, 0.3);
  k.blob(rock[2], 0.34, 0.26, 0.3, -0.5, 0.14, 0.44, 1, 2);
  for (let j = 0; j < 4; j++) {
    const a = j * 1.7 + 0.5;
    k.blob(rock[j % 3], 0.1 + c.n(10 + j) * 0.07, 0.08, 0.1, Math.cos(a) * 0.82, 0.04, Math.sin(a) * 0.82, j, a);
  }
  if (c.clime === "frost") k.blob(SNOW, 0.5, 0.12, 0.44, 0, 1.12, 0, 2, 0, 0, 0, SOLID, true);
  if (c.clime === "ash") {
    emberCrack(k, 0.2, 0.2, 0.7, 0.4, 0.2, 0.5);
    emberCrack(k, -0.6, 0.3, 0.3, 0.3, -1.1, -0.4);
  }
  if (c.clime === "mire") { vine(k, 0.3, 0.9, 0.62, 0.5, 0.3); vine(k, -0.4, 0.8, 0.5, 0.4, -0.6); }
  k.pop();
  drift(k, c, Math.cos(turn + 3) * 0.7, Math.sin(turn + 3) * 0.7, 0.4, 20);
}

function ribs(k: Kit, c: Ctx) {
  const P = c.pal;
  // Along the spine: toward the next ribs, or the skull, if there are any; each hex carries two pairs.
  const bony = (i: number) => c.kindAt(i) === "ribs" || c.kindAt(i) === "skull";
  let axis = [0, 1, 2].find((i) => bony(i) && bony(i + 3)) ?? SIDE.findIndex((_, i) => bony(i));
  if (axis < 0) axis = Math.floor(c.n(1) * 2.99);
  axis %= 3;
  k.push(0, 0, 0, alongX(SIDE[axis].a));
  const pairs = [-APO / 2, APO / 2];
  pairs.forEach((x, p) => {
    for (const s of [-1, 1]) {
      const salt = 20 + p * 10 + (s + 1);
      const H = 2.35 + c.n(salt) * 0.5;
      const W = 0.92 + c.n(salt + 1) * 0.08;
      const whole = c.n(salt + 2) < 0.72 ? 1 : 0.5 + c.n(salt + 3) * 0.3;
      const lean = (c.n(salt + 4) - 0.5) * 0.3;
      const pts: number[][] = [];
      const steps = 9;
      for (let i = 0; i <= steps * whole; i++) {
        const phi = (i / steps) * 1.42;
        pts.push([x + lean * Math.sin(phi), -0.12 + (H * Math.sin(phi)) / Math.sin(1.42), s * W * (Math.cos(phi) + 0.1 * Math.sin(phi * 2))]);
      }
      k.tube(s * p > 0 ? P.boneDark : P.bone, pts, (t) => 0.135 * (1 - 0.72 * t * whole), 6, 0.62);
      // The stub of the one that broke, with the rest of it lying by.
      if (whole < 1) k.tube(P.boneDark, [[x + 0.3, 0.05, s * 0.5], [x + 0.55, 0.07, s * 0.2], [x + 0.75, 0.03, s * -0.02]], (t) => 0.07 * (1 - 0.6 * t), 5, 0.7);
    }
  });
  // The spine, half sunk: a knuckle of bone under each pair and one between.
  for (const x of [-APO / 2, 0, APO / 2]) {
    k.blob(P.bone, 0.2, 0.17, 0.24, x, 0.07, 0, 1, x * 3);
    k.box(P.boneDark, 0.09, 0.3, 0.1, x, 0.12, 0, 0, 0, 0.15);
    for (const s of [-1, 1]) k.cone(P.bone, 0.06, 0.26, x, 0.12, s * 0.16, 5, 0, s * 1.2, 0);
  }
  if (c.clime === "mire") { vine(k, -APO / 2, 1.9, 0.5, 0.8); vine(k, APO / 2, 2.0, -0.46, 0.7); }
  k.pop();
  drift(k, c, 0.1, 0.7, 0.36, 60);
  drift(k, c, -0.2, -0.72, 0.3, 70);
}

function skull(k: Kit, c: Ctx) {
  const P = c.pal;
  // Looking away from the ribs behind it, if it has any.
  const body = SIDE.findIndex((_, i) => c.kindAt(i) === "ribs");
  const facing = body >= 0 ? SIDE[(body + 3) % 6].a : SIDE[c.open].a;
  k.push(0, -0.04, -0.1, faceZ(facing) + (c.n(1) - 0.5) * 0.3, -0.2, (c.n(2) - 0.5) * 0.16);
  k.blob(P.bone, 0.56, 0.44, 0.58, 0, 0.56, -0.3, 2);
  k.box(P.bone, 0.92, 0.13, 0.3, 0, 0.72, 0.16, 0, -0.2);
  // The muzzle, long and narrowing, and the teeth along it.
  k.cyl(P.bone, 0.38, 0.2, 0.95, 0, 0.5, 0.1, 6, 0, Math.PI / 2, 0, 0.62);
  k.blob(P.boneDark, 0.2, 0.15, 0.16, 0, 0.56, 1.02, 1);
  for (const s of [-1, 1]) {
    k.blob(DARK, 0.15, 0.14, 0.12, s * 0.33, 0.6, 0.06, 1, s * 0.5);
    k.blob(DARK, 0.05, 0.04, 0.06, s * 0.07, 0.6, 1.1, 3);
    for (let j = 0; j < 5; j++) k.cone(j % 2 ? P.bone : P.boneDark, 0.05 - j * 0.004, 0.26 - j * 0.02, s * (0.31 - j * 0.03), 0.4 - j * 0.004, 0.3 + j * 0.17, 5, 0, Math.PI, 0);
    // Horns sweeping back and up.
    k.tube(P.boneDark, [[s * 0.4, 0.72, -0.34], [s * 0.78, 0.98, -0.6], [s * 1.0, 1.45, -0.7], [s * 0.96, 1.92, -0.52]], (t) => 0.15 * (1 - t * 0.86), 6);
    // The jaw, dropped and lying askew under it.
    k.tube(P.boneDark, [[s * 0.4, 0.2, -0.3], [s * 0.3, 0.1, 0.3], [s * 0.1, 0.12, 0.9]], (t) => 0.07 * (1 - t * 0.4), 5);
  }
  if (c.clime === "ash") {
    for (const s of [-1, 1]) k.blob(EMBER, 0.06, 0.06, 0.05, s * 0.36, 0.6, 0.1, 3, 0, 0, 0, GLOW, true);
  }
  if (c.clime === "mire") { vine(k, 0.5, 0.9, -0.2, 0.5, 1.2); vine(k, -0.3, 0.74, 0.34, 0.4); }
  if (c.clime === "frost") k.blob(SNOW, 0.36, 0.08, 0.36, 0, 1.0, -0.3, 2, 0, 0, 0, SOLID, true);
  k.pop();
  drift(k, c, Math.cos(facing + 1.6) * 0.7, Math.sin(facing + 1.6) * 0.7, 0.4, 20);
}

function crystal(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = c.n(1) * 6;
  const spar = (tone: THREE.Color, r: number, h: number, x: number, z: number, ry: number, tilt: number) => {
    k.push(x, -0.05, z, ry, tilt);
    k.cyl(tone, r, r * 0.86, h, 0, 0, 0, 6, 0, 0, 0, 1, GLOW);
    k.cone(tone, r * 0.86, r * 2.2, 0, h, 0, 6, 0, 0, 0, GLOW);
    k.pop();
  };
  // The rock it grew from.
  for (let j = 0; j < 5; j++) {
    const a = turn + j * 1.3;
    k.blob(j % 2 ? P.stoneDark : P.basalt, 0.26 + c.n(10 + j) * 0.1, 0.16, 0.24, Math.cos(a) * 0.5, 0.06, Math.sin(a) * 0.5, j, a);
  }
  spar(P.crystal, 0.25, 2.1 + c.n(2) * 0.6, 0, 0, turn, 0.08 + c.n(3) * 0.1);
  const more = 4 + Math.floor(c.n(4) * 2.99);
  for (let j = 0; j < more; j++) {
    const a = turn + (j / more) * Math.PI * 2 + c.n(20 + j) * 0.5;
    const d = 0.26 + c.n(30 + j) * 0.24;
    spar(j % 2 ? P.crystalDeep : P.crystal, 0.1 + c.n(40 + j) * 0.08, 0.6 + c.n(50 + j) * 1.1, Math.sin(a) * d, Math.cos(a) * d, a, 0.3 + c.n(60 + j) * 0.5);
  }
  // Splinters of it on the ground.
  for (let j = 0; j < 4; j++) {
    const a = turn + j * 1.7 + 0.8;
    k.blob(P.crystal, 0.06, 0.1, 0.05, Math.cos(a) * 0.8, 0.05, Math.sin(a) * 0.8, 3, a, 0.6, 0, GLOW);
  }
  k.shine(0, 1.3, 0, P.crystal, 0.95, 6.5, 2.8);
  for (let j = 0; j < 5; j++) {
    const at = k.world((c.n(70 + j) - 0.5) * 0.9, 0.4 + c.n(80 + j) * 1.6, (c.n(90 + j) - 0.5) * 0.9);
    k.motes.push({ x: at.x, y: at.y, z: at.z, color: P.crystal, rise: 0.7, sway: 0.12, rate: 0.16 + c.n(100 + j) * 0.12, phase: c.n(110 + j), size: 0.7 });
  }
}

function iceSpire(k: Kit, c: Ctx) {
  const turn = c.n(1) * 6;
  k.blob(SNOW, 0.8, 0.16, 0.74, 0, 0.02, 0, 2, turn, 0, 0, SOLID, true);
  k.push(0, 0, 0, turn, (c.n(2) - 0.5) * 0.14, (c.n(3) - 0.5) * 0.14);
  k.cyl(ICE_DEEP, 0.44, 0.31, 1.25, 0, 0, 0, 5, 0, 0, 0, 1, SOLID, true);
  k.cyl(ICE, 0.31, 0.18, 1.1, 0.04, 1.22, 0.02, 5, 0.5, 0.05, 0, 1, SOLID, true);
  k.cone(ICE_LIGHT, 0.18, 1.2, 0.07, 2.3, 0.05, 5, 1.0, 0.07, 0, SOLID, true);
  k.pop();
  for (let j = 0; j < 4; j++) {
    const a = turn + (j / 4) * Math.PI * 2 + c.n(10 + j);
    const d = 0.44 + c.n(20 + j) * 0.14;
    k.cone(j % 2 ? ICE : ICE_DEEP, 0.15 + c.n(30 + j) * 0.08, 0.8 + c.n(40 + j) * 0.9, Math.sin(a) * d, -0.03, Math.cos(a) * d, 5, a, 0.2 + c.n(50 + j) * 0.2, 0, SOLID, true);
  }
  // A cold light in the heart of it, and its glints.
  k.cone(ICE_LIGHT.clone().multiplyScalar(1.15), 0.05, 0.9, 0.05, 1.5, 0.3, 4, turn, 0.1, 0, GLOW, true);
  k.glowPool(0, 0, ICE, 1.9, 0.2);
}

/** A limb of a tree: out and up from `from`, with a kink in it; twigs fork off its end. */
function bough(k: Kit, tone: THREE.Color, from: number[], a: number, out: number, up: number, thick: number, twigs: number, salt: number, n: (s: number) => number): number[] {
  const mid = [from[0] + Math.sin(a) * out * 0.5, from[1] + up * 0.34, from[2] + Math.cos(a) * out * 0.5];
  const end = [from[0] + Math.sin(a + 0.3) * out, from[1] + up, from[2] + Math.cos(a + 0.3) * out];
  k.tube(tone, [from, mid, end], (t) => thick * (1 - t * 0.55), 5);
  for (let j = 0; j < twigs; j++) {
    const b = a + (j - (twigs - 1) / 2) * 0.9 + (n(salt + j) - 0.5) * 0.5;
    const l = out * (0.4 + n(salt + 10 + j) * 0.3);
    k.tube(tone, [end, [end[0] + Math.sin(b) * l * 0.6, end[1] + l * 0.5, end[2] + Math.cos(b) * l * 0.6], [end[0] + Math.sin(b + 0.4) * l, end[1] + l * 1.1, end[2] + Math.cos(b + 0.4) * l]], (t) => thick * 0.45 * (1 - t * 0.8), 4);
  }
  return end;
}

function deadTree(k: Kit, c: Ctx) {
  const P = c.pal;
  const wood = c.clime === "ash" ? P.woodDark : col("#6e675d");
  const turn = c.n(1) * 6;
  k.push(0, 0, 0, turn, (c.n(2) - 0.5) * 0.12);
  k.tube(wood, [[0, -0.1, 0], [0.05, 0.75, 0.03], [-0.05, 1.5, 0.07], [0.04, 2.15, 0.0], [0.1, 2.7, -0.06]], (t) => 0.2 * (1 - t * 0.72), 6);
  for (let j = 0; j < 4; j++) {
    const a = (j / 4) * Math.PI * 2 + 0.4;
    k.tube(wood, [[Math.sin(a) * 0.1, 0.22, Math.cos(a) * 0.1], [Math.sin(a) * 0.36, 0.03, Math.cos(a) * 0.36], [Math.sin(a) * 0.56, -0.05, Math.cos(a) * 0.56]], (t) => 0.1 * (1 - t * 0.6), 5);
  }
  const limbs = 4;
  for (let j = 0; j < limbs; j++) {
    const a = (j / limbs) * Math.PI * 2 + c.n(10 + j) * 0.8;
    const y = 1.1 + j * 0.34;
    bough(k, wood, [0, y, 0.03], a, 0.7 + c.n(20 + j) * 0.4, 0.55 + c.n(30 + j) * 0.4, 0.09, 2, 40 + j * 5, c.n);
  }
  // A limb that came down.
  k.tube(wood, [[0.5, 0.05, 0.3], [0.8, 0.06, 0.1], [1.0, 0.04, -0.14]], (t) => 0.06 * (1 - t * 0.5), 5);
  if (c.clime === "ash") {
    emberCrack(k, 0.02, 0.3, 0.19, 0.5, 0, 0.2);
    k.glowPool(0, 0, EMBER_DEEP, 1.4, 0.2, true);
  }
  if (c.clime === "mire") { vine(k, 0.3, 1.6, 0.3, 0.7); vine(k, -0.36, 1.9, -0.2, 0.6, 1); }
  k.pop();
  drift(k, c, 0.4, -0.4, 0.3, 60);
}

function greatTree(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = c.n(1) * 6;
  const bare = P.leaf.length === 0;
  const flatTop = c.clime === "dunes";
  k.push(0, 0, 0, turn);
  // The bole, and the roots it stands on.
  k.tube(P.bark, [[0, -0.1, 0], [0.04, 0.8, 0.02], [-0.03, 1.6, 0.05], [0.03, 2.3, 0]], (t) => 0.56 * (1 - t * 0.38), 8);
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2 + c.n(10 + j) * 0.5;
    const far = 0.86 + c.n(20 + j) * 0.14;
    k.tube(P.bark, [[Math.sin(a) * 0.3, 0.6, Math.cos(a) * 0.3], [Math.sin(a) * 0.62, 0.16, Math.cos(a) * 0.62], [Math.sin(a + 0.2) * far, -0.06, Math.cos(a + 0.2) * far]], (t) => 0.2 * (1 - t * 0.66), 5);
  }
  // A hollow in it; in the ashlands something still smoulders inside.
  k.blob(c.clime === "ash" ? EMBER_DEEP : DARK, 0.16, 0.24, 0.08, 0.02, 0.95, 0.5, 1, 0, 0, 0, c.clime === "ash" ? GLOW : SOLID, true);
  if (c.clime === "ash") k.glowPool(0, 0.6, EMBER, 1.8, 0.26, true);
  const limbs = bare ? 6 : 5;
  const ends: number[][] = [];
  for (let j = 0; j < limbs; j++) {
    const a = (j / limbs) * Math.PI * 2 + c.n(30 + j) * 0.5;
    ends.push(bough(k, P.bark, [0, 2.1, 0], a, 1.0 + c.n(40 + j) * 0.3, flatTop ? 0.9 : 1.1 + c.n(50 + j) * 0.5, 0.24, bare ? 3 : 1, 60 + j * 7, c.n));
  }
  if (!bare) {
    // The crown: great lumps of leaf, one over the middle and one on the end of every limb.
    const squat = flatTop ? 0.34 : 0.72;
    k.blob(P.leaf[0], 1.15, 1.0 * squat + 0.1, 1.1, 0, flatTop ? 3.5 : 4.0, 0, 2, 1);
    ends.forEach((e, j) => {
      const r = 0.74 + c.n(80 + j) * 0.26;
      k.blob(P.leaf[(j + 1) % P.leaf.length], r, r * squat + 0.05, r * 0.94, e[0] * 1.08, e[1] + (flatTop ? 0.12 : 0.3), e[2] * 1.08, 2, j * 1.3);
      if (j % 2 === 0) k.blob(P.leaf[(j + 2) % P.leaf.length], r * 0.6, r * 0.5 * squat + 0.04, r * 0.6, e[0] * 0.5, e[1] + (flatTop ? 0.3 : 1.0), e[2] * 0.5, 0, j);
      // The mire's trees trail moss.
      if (c.clime === "mire") for (let m = 0; m < 2; m++) vine(k, e[0] * (1.0 + m * 0.2) + (c.n(90 + j + m) - 0.5) * 0.5, e[1] - 0.1, e[2] * (1.0 + m * 0.2) + (c.n(95 + j + m) - 0.5) * 0.5, 0.5 + c.n(100 + j + m) * 0.8, j);
    });
  }
  k.pop();
  drift(k, c, Math.cos(turn) * 0.8, Math.sin(turn) * 0.8, 0.36, 110);
}

function mushrooms(k: Kit, c: Ctx) {
  const P = c.pal;
  const turn = c.n(1) * 6;
  const stalk = c.clime === "ash" ? col("#8a8088") : col("#e2d8c2");
  const one = (x: number, z: number, h: number, r: number, bend: number, salt: number) => {
    const [tx, tz] = [x + Math.sin(bend) * h * 0.14, z + Math.cos(bend) * h * 0.14];
    k.tube(stalk, [[x, -0.05, z], [x + Math.sin(bend) * h * 0.1, h * 0.5, z + Math.cos(bend) * h * 0.1], [tx, h, tz]], (t) => r * 0.2 * (1 - t * 0.3), 6);
    k.cyl(stalk, r * 0.22, r * 0.14, 0.05, tx * 0.98 + x * 0.02, h * 0.72, tz * 0.98 + z * 0.02, 6);
    k.dome(salt % 2 ? P.cap : P.cap.clone().multiplyScalar(0.85), r, r * 0.5, tx, h - 0.02, tz, 9);
    k.disc(P.gill, r * 0.97, tx, h - 0.018, tz, 9, true, P.gillGlows ? GLOW : SOLID, P.gillGlows);
    // Pale spots on the cap.
    for (let j = 0; j < 4; j++) {
      const a = c.n(salt + j) * 6;
      const d = r * (0.25 + c.n(salt + 10 + j) * 0.45);
      k.blob(P.gill, r * 0.1, r * 0.04, r * 0.1, tx + Math.sin(a) * d, h - 0.02 + r * 0.5 * Math.sqrt(Math.max(0, 1 - (d / r) ** 2)), tz + Math.cos(a) * d, 1, a, 0, 0, P.gillGlows ? GLOW : SOLID, true);
    }
  };
  k.push(0, 0, 0, turn);
  one(-0.12, -0.14, 1.75 + c.n(2) * 0.3, 0.74, 0.6, 20);
  one(0.5, 0.26, 1.05 + c.n(3) * 0.2, 0.5, 2.2, 40);
  one(-0.46, 0.46, 0.62 + c.n(4) * 0.2, 0.34, 4.0, 60);
  one(0.2, -0.66, 0.36, 0.2, 5.2, 80);
  one(0.62, -0.3, 0.24, 0.14, 1, 100);
  k.pop();
  if (P.gillGlows) k.glowPool(0, 0, P.gill, 2.2, 0.3);
  drift(k, c, -0.6, -0.4, 0.26, 120);
}

function stiltHut(k: Kit, c: Ctx) {
  const P = c.pal;
  const floor = 1.14;
  k.push(0, 0, 0, faceZ(SIDE[c.open].a));
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.42], [0.5, 0.42]]) {
    k.tube(P.woodDark, [[x * 1.16, -0.06, z * 1.16], [x, floor, z]], () => 0.06, 5);
  }
  k.tube(P.wood, [[-0.56, 0.2, -0.56], [0.5, floor - 0.1, -0.5]], () => 0.035, 4);
  k.tube(P.wood, [[0.56, 0.2, 0.46], [0.5, floor - 0.1, -0.5]], () => 0.035, 4);
  k.tube(P.wood, [[-0.56, 0.2, 0.46], [-0.5, floor - 0.1, -0.5]], () => 0.035, 4);
  k.box(P.wood, 1.34, 0.08, 1.3, 0, floor, 0);
  for (let p = 0; p < 6; p++) k.box(P.woodDark, 0.015, 0.012, 1.3, -0.56 + p * 0.224, floor + 0.08, 0);
  // The hut: boards, a dark doorway on to a little porch, a window with a light in it.
  const [w, h, d, back] = [1.02, 0.82, 0.86, -0.16];
  k.box(P.wood, w, h, d, 0, floor + 0.08, back);
  for (let p = 0; p < 5; p++) {
    for (const s of [-1, 1]) k.box(P.woodDark, 0.02, h, 0.02, s * (w / 2 + 0.004), floor + 0.08, back - d / 2 + 0.1 + p * 0.165);
    k.box(P.woodDark, 0.02, h, 0.02, -w / 2 + 0.1 + p * 0.2, floor + 0.08, back - d / 2 - 0.004);
  }
  k.box(DARK, 0.3, 0.6, 0.02, -0.14, floor + 0.08, back + d / 2 + 0.006);
  k.box(P.woodDark, 0.38, 0.06, 0.05, -0.14, floor + 0.68, back + d / 2 + 0.01);
  k.box(col("#ffc46a"), 0.2, 0.2, 0.02, 0.28, floor + 0.4, back + d / 2 + 0.006, 0, 0, 0, GLOW, true);
  k.box(P.woodDark, 0.26, 0.04, 0.04, 0.28, floor + 0.36, back + d / 2 + 0.01);
  k.box(P.woodDark, 0.03, 0.22, 0.03, 0.28, floor + 0.39, back + d / 2 + 0.012);
  k.glowPool(0.28, 0.9, FIRE, 1.6, 0.16, true);
  // Thatch: a steep hipped roof well out over the walls, with a second course at the eaves.
  k.cyl(P.thatch.clone().multiplyScalar(0.8), 1.1, 0.86, 0.16, 0, floor + h + 0.02, back, 4, Math.PI / 4);
  k.cone(P.thatch, 0.98, 0.95, 0, floor + h + 0.16, back, 4, Math.PI / 4);
  k.cyl(P.woodDark, 0.03, 0.02, 0.3, 0, floor + h + 1.04, back, 4);
  // The porch rail, and the ladder up to it.
  for (const s of [-1, 1]) k.box(P.wood, 0.05, 0.4, 0.05, s * 0.62, floor + 0.08, 0.58);
  k.box(P.wood, 0.5, 0.04, 0.04, 0.38, floor + 0.44, 0.58);
  ladder(k, P, [-0.3, -0.04, 1.02], [-0.3, floor + 0.3, 0.66], 0.36, 1, 0);
  if (c.clime === "frost") icicles(k, c, -0.6, 0.6, floor + h + 0.04, back + 0.74, 5, 30);
  if (c.clime === "mire") { vine(k, 0.6, floor + h + 0.1, back + 0.7, 0.6); vine(k, -0.66, floor, 0.5, 0.7, 1.5); }
  k.pop();
}

function basalt(k: Kit, c: Ctx) {
  const P = c.pal;
  const slope = c.n(1) * 6;
  const light = P.basalt.clone().lerp(P.stoneLight, 0.3);
  const column = (x: number, z: number, r: number, h: number, j: number) => {
    k.cyl(j % 2 ? P.basalt : P.basalt.clone().multiplyScalar(1.18), r, r, h, x, -0.05, z, 6);
    k.cyl(light, r * 0.98, r * 0.86, 0.045, x, h - 0.05, z, 6);
    if (c.clime === "ash" && j % 3 === 0) k.box(EMBER, 0.03, Math.min(0.6, h * 0.5), 0.02, x + Math.cos(slope) * r * 0.9, 0.02, z + Math.sin(slope) * r * 0.9, -slope + Math.PI / 2, 0, 0, GLOW, true);
  };
  column(0, 0, 0.289, 2.3 + c.n(2) * 0.7, 0);
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2;
    const [x, z] = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    const h = Math.max(0.4, 1.5 + 1.1 * Math.cos(a - slope) + (c.n(10 + j) - 0.5) * 0.7);
    column(x, z, 0.289, h, j + 1);
  }
  // Stubs round the foot of them, and one that fell.
  for (let j = 0; j < 3; j++) {
    const a = slope + Math.PI + (j - 1) * 1.05 + Math.PI / 6;
    column(Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.17, 0.25 + c.n(20 + j) * 0.4, j);
  }
  k.cyl(P.basalt, 0.2, 0.2, 0.7, Math.cos(slope + 2.4) * 0.72, 0.17, Math.sin(slope + 2.4) * 0.72, 6, c.n(3) * 3, 0, Math.PI / 2);
  drift(k, c, Math.cos(slope + 4) * 0.74, Math.sin(slope + 4) * 0.74, 0.3, 30);
}

// ---- the way in ----

const GATE_RING = { mid: 1.34, inner: 0.86, outer: 1.17 };
function waygate(k: Kit, c: Ctx) {
  const P = c.pal;
  const { mid, inner, outer } = GATE_RING;
  k.cyl(P.stoneDark, 1.0, 1.0, 0.12, 0, 0, 0, 6);
  k.cyl(P.stone, 0.82, 0.82, 0.1, 0, 0.12, 0, 6);
  inlay(k, c, 0.5, 0.012, 0.5, 0, 0.215, 0, Math.PI / 4);
  k.push(0, 0, 0, faceZ(SIDE[c.open].a));
  // The ring: wedges of stone set round, every third one cut with a sign that burns cold.
  const blocks = 14;
  const wide = 2 * outer * Math.tan(Math.PI / blocks) + 0.015;
  for (let j = 0; j < blocks; j++) {
    const phi = ((j + 0.5) / blocks) * Math.PI * 2;
    const top = j === 3;
    const tone = top ? P.stoneLight : j % 2 ? P.stone : P.stoneDark;
    const deep = top ? 0.44 : 0.36 + (j % 3 === 0 ? 0.04 : 0);
    k.push(Math.cos(phi) * inner, mid + Math.sin(phi) * inner, 0, 0, 0, phi - Math.PI / 2);
    k.box(tone, wide, outer - inner + (top ? 0.1 : 0), deep, 0, 0, 0);
    if (j % 3 === 0 || top) {
      for (const s of [-1, 1]) {
        k.box(P.glyph, 0.06, 0.2, 0.012, 0, 0.05, s * (deep / 2 + 0.004), 0, 0, 0, GLOW, true);
        k.box(P.glyph, 0.16, 0.05, 0.012, 0, 0.16, s * (deep / 2 + 0.004), 0, 0, 0, GLOW, true);
      }
    }
    k.pop();
  }
  for (const s of [-1, 1]) {
    k.box(P.stoneDark, 0.44, 0.52, 0.62, s * 1.0, 0, 0);
    k.box(P.stoneLight, 0.36, 0.08, 0.54, s * 1.0, 0.52, 0);
    k.cone(P.glyph, 0.07, 0.2, s * 1.0, 0.6, 0, 4, Math.PI / 4, 0, 0, GLOW);
    if (c.clime === "mire") vine(k, s * 0.9, mid + 0.8, 0.2, 0.7);
    if (c.clime === "frost") icicles(k, c, s * 0.2, s * 0.8, mid + inner * 0.72, 0, 2, 30 + s);
  }
  if (c.clime === "frost") k.blob(SNOW, 0.5, 0.07, 0.16, 0, mid + outer + 0.06, 0, 2, 0, 0, 0, SOLID, true);
  // The portal itself is drawn apart (it turns), and its light.
  k.push(0, mid, 0);
  k.portals.push({ matrix: k.frame(), color: P.glyph, deep: P.crystalDeep });
  k.pop();
  k.shine(0, mid, 0.5, P.glyph, 1.3, 7.5, 3.2);
  for (let j = 0; j < 16; j++) {
    const a = c.n(40 + j) * Math.PI * 2;
    const d = 0.3 + c.n(60 + j) * 0.6;
    const at = k.world(Math.cos(a) * d, mid + Math.sin(a) * d - 0.4, (c.n(80 + j) - 0.5) * 0.7);
    k.motes.push({ x: at.x, y: at.y, z: at.z, color: P.glyph, rise: 0.9 + c.n(100 + j), sway: 0.16, rate: 0.2 + c.n(120 + j) * 0.2, phase: c.n(140 + j), size: 0.6 + c.n(160 + j) * 0.6 });
  }
  k.pop();
}

/** Every kind of thing a hex may carry (`Tile.prop`), and how it is drawn. */
const DRAW = {
  wall,
  wall_broken: wallBroken,
  tower,
  arch,
  pillar,
  pillar_broken: pillarBroken,
  statue,
  obelisk,
  altar,
  well,
  stairs,
  brazier,
  campfire,
  tent,
  palisade,
  cart,
  banner,
  barrels,
  standing_stone: standingStone,
  boulder,
  ribs,
  skull,
  crystal,
  ice_spire: iceSpire,
  dead_tree: deadTree,
  great_tree: greatTree,
  mushrooms,
  stilt_hut: stiltHut,
  basalt,
  waygate,
} satisfies Record<string, (k: Kit, c: Ctx) => void>;

/** The kinds drawn here: every one in the world's PROPS must be among them. */
export const SCENERY_KINDS: readonly string[] = Object.keys(DRAW);

// ---------------------------------------------------------------- the map ---

type Place = { x: number; y: number; z: number };

export interface SceneryOptions {
  /**
   * The map floats over a void (a backdrop other than the sea): its rim is faced with rock all the way down
   * and trails away into roots, so the land is a thick slab and not a sheet.
   */
  floating?: boolean;
}

/** A waygate's portal: a disc of slow, turning light. */
function portalMaterial(color: THREE.Color, deep: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uDeep: { value: deep }, gqRise: { value: (globalThis as { __gqRise?: Float32Array }).__gqRise ?? new Float32Array(4) } },
    vertexShader: /* glsl */ `
      #include <common>
      varying vec2 vAt;
      void main() {
        vAt = position.xy;
        vec3 transformed = position;
        #include <project_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uDeep;
      varying vec2 vAt;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        float r = length(vAt);
        float a = atan(vAt.y, vAt.x);
        // Two arms winding in, and a slow boil under them.
        float arms = 0.5 + 0.5 * sin(a * 2.0 + r * 9.0 - uTime * 1.3);
        float fine = 0.5 + 0.5 * sin(a * 5.0 - r * 16.0 + uTime * 0.8 + noise(vAt * 3.0 + uTime * 0.2) * 4.0);
        float boil = noise(vec2(cos(a), sin(a)) * (2.0 + r * 3.0) + vec2(uTime * 0.25, -uTime * 0.18));
        float heart = smoothstep(0.75, 0.0, r);
        float edge = smoothstep(1.0, 0.86, r);
        float rim = smoothstep(0.7, 0.98, r) * edge;
        float glow = 0.22 + 0.5 * arms * (0.4 + 0.6 * boil) + 0.22 * fine + 0.75 * heart * heart + 0.5 * rim;
        vec3 c = mix(uDeep, uColor, clamp(arms * 0.6 + heart * 0.7 + rim * 0.5, 0.0, 1.0)) * glow;
        c += vec3(1.0) * pow(heart, 5.0) * 0.5;
        gl_FragColor = vec4(c * edge, edge * (0.62 + 0.3 * arms));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * A zone's scenery: everything in `group`, built once from the map's tiles. `place` gives the middle of a
 * tile's top in the world. Call `update` every frame and `dispose` when the map is redrawn.
 */
export class ZoneScenery {
  readonly group = new THREE.Group();
  /** Where every fire and cold light on the map is, for anything else that wants to know (fireflies, sound). */
  readonly lights: { at: THREE.Vector3; fire: boolean }[] = [];
  private flames: THREE.Group[] = [];
  private emitters: Emitter[] = [];
  private slots: { light: THREE.PointLight; of: Emitter | null; gain: number }[] = [];
  private warm: THREE.MeshBasicMaterial;
  private cool: THREE.MeshBasicMaterial;
  private glow: THREE.MeshBasicMaterial;
  private portals: THREE.ShaderMaterial[] = [];
  private motes: MoteField | null = null;
  private since = 1;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(tiles: readonly Tile[], place: (t: Tile) => Place, opts: SceneryOptions = {}) {
    const byKey = new Map<string, Tile>();
    for (const t of tiles) if (t.biome !== "fog") byKey.set(key(t.q, t.r), t);
    const at = new Map<Tile, Place>();
    for (const t of byKey.values()) at.set(t, place(t));
    const kit = new Kit();
    const walkable = (t: Tile | undefined) => !!t && t.biome !== "water" && t.biome !== "rock" && (!t.prop || WALKABLE.has(t.prop));

    for (const t of byKey.values()) {
      const p = at.get(t)!;
      const clime = t.clime ?? "greenwood";
      const nb = (i: number) => byKey.get(key(t.q + DIRS[i].q, t.r + DIRS[i].r));
      if (t.prop && t.prop in DRAW) {
        // The side that looks out on the most open ground: the one whose neighbours, and their neighbours' share, are clearest.
        let open = Math.floor(hash(t.q, t.r, 777) * 5.99);
        let best = -1;
        for (let i = 0; i < 6; i++) {
          const score = (walkable(nb(i)) ? 2 : 0) + (walkable(nb((i + 1) % 6)) ? 1 : 0) + (walkable(nb((i + 5) % 6)) ? 1 : 0) + hash(t.q, t.r, 780 + i) * 0.5;
          if (score > best) [best, open] = [score, i];
        }
        const ctx: Ctx = {
          t,
          pal: PALS[clime],
          clime,
          n: (salt) => hash(t.q, t.r, salt),
          kindAt: (i) => nb(((i % 6) + 6) % 6)?.prop,
          rise: (i) => {
            const n = nb(i);
            return n ? at.get(n)!.y - p.y : undefined;
          },
          open,
        };
        kit.begin(p.x, p.y, p.z, clime);
        (DRAW as Record<string, (k: Kit, c: Ctx) => void>)[t.prop](kit, ctx);
      }
      if (t.ladder) this.ladders(kit, t, p, nb, at);
      this.edges(kit, t, p, nb, at, !!opts.floating);
    }
    if (opts.floating) this.roots(kit, byKey, at);
    this.pools(kit, byKey, at);

    // ---- the meshes ----
    const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const mesh of kit.meshes(SOLID, solid)) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Drawn with the trees, before the figures: whoever stands behind a wall or a pillar is shown through it.
      mesh.renderOrder = HIDES;
      this.group.add(mesh);
    }
    this.glow = new THREE.MeshBasicMaterial({ vertexColors: true });
    for (const mesh of kit.meshes(GLOW, this.glow)) {
      mesh.userData.glow = true;
      this.group.add(mesh);
    }
    const fade = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
    for (const mesh of kit.meshes(FADE, fade)) {
      mesh.renderOrder = -3;
      this.group.add(mesh);
    }
    const pool = () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.warm = pool();
    this.cool = pool();
    for (const [layer, material] of [[WARM, this.warm], [COOL, this.cool]] as const)
      for (const mesh of kit.meshes(layer, material)) {
        mesh.userData.glow = true;
        mesh.renderOrder = 1;
        this.group.add(mesh);
      }

    // ---- fire: flames, sparks, portals, and the lights the nearest of them carry ----
    const big = kit.flames.filter((f) => !f.small);
    const small = kit.flames.filter((f) => f.small).slice(0, Math.max(0, FLAME_BUDGET - big.length));
    for (const f of [...big, ...small]) {
      const flame = torchFlame(f.size);
      flame.position.copy(f.at);
      this.flames.push(flame);
      this.group.add(flame);
    }
    if (kit.motes.length > 0) {
      this.motes = moteField(kit.motes, 0.11);
      this.group.add(this.motes.points);
    }
    const disc = new THREE.CircleGeometry(0.9, 40);
    for (const p of kit.portals) {
      const material = portalMaterial(p.color, p.deep);
      const mesh = new THREE.Mesh(disc, material);
      mesh.applyMatrix4(p.matrix);
      mesh.userData.glow = true;
      mesh.renderOrder = 2;
      this.portals.push(material);
      this.group.add(mesh);
    }
    this.emitters = kit.emitters;
    for (const e of kit.emitters) this.lights.push({ at: new THREE.Vector3(e.x, e.y, e.z), fire: e.fire });
    // A fixed handful of lights, moved to whichever fires are nearest the view: the count never changes, so no
    // material is built again as the camera moves.
    for (let i = 0; i < Math.min(LIGHT_BUDGET, this.emitters.length); i++) {
      const light = new THREE.PointLight("#ffffff", 0, 8, 1.5);
      this.slots.push({ light, of: null, gain: 0 });
      this.group.add(light);
    }
  }

  /** The ladders standing on a hex: each leans on the cliff of the higher hex beside it, from this top to that one. */
  private ladders(kit: Kit, t: Tile, p: Place, nb: (i: number) => Tile | undefined, at: Map<Tile, Place>) {
    const clime = t.clime ?? "greenwood";
    for (let i = 0; i < 6; i++) {
      if (!((t.ladder ?? 0) & (1 << i))) continue;
      const up = nb(i);
      if (!up) continue;
      const top = at.get(up)!.y - p.y;
      if (top < 0.2) continue;
      const side = SIDE[i];
      kit.begin(p.x, p.y, p.z, clime);
      const pal = PALS[clime];
      // Its feet well out on the lower hex, its head against the lip above and a little over it, to take hold of.
      const shift = (hash(t.q, t.r, 600 + i) - 0.5) * 0.3;
      const [tx, tz] = [-side.z, side.x];
      const foot = APO - 0.2 - top * 0.16;
      const head = APO - 0.075;
      const over = 0.34;
      const lean = (head - foot) / top;
      const a = [side.x * foot + tx * shift, -0.03, side.z * foot + tz * shift];
      const b = [side.x * (head + lean * over) + tx * shift, top + over, side.z * (head + lean * over) + tz * shift];
      ladder(kit, pal, a, b, 0.44, tx, tz);
      // Lashed to two pegs driven in at the top.
      for (const s of [-1, 1]) {
        const [x, z] = [side.x * (APO + 0.12) + tx * (shift + s * 0.24), side.z * (APO + 0.12) + tz * (shift + s * 0.24)];
        kit.cyl(pal.woodDark, 0.03, 0.025, 0.2, x, top - 0.03, z, 4);
        kit.tube(ROPE, [[x, top + 0.1, z], [side.x * (head + lean * 0.1) + tx * (shift + s * 0.22), top + 0.1, side.z * (head + lean * 0.1) + tz * (shift + s * 0.22)]], () => 0.014, 3, 1, SOLID, true);
      }
    }
  }

  /**
   * A hex's edges: where the ground drops away beside it, the face of the drop (dressed stone under paving,
   * living rock under anything else, with what the climate hangs on it), and a parapet along the brink of
   * paved ground that stands two levels up or more.
   */
  private edges(kit: Kit, t: Tile, p: Place, nb: (i: number) => Tile | undefined, at: Map<Tile, Place>, floating: boolean) {
    const clime = t.clime ?? "greenwood";
    const pal = PALS[clime];
    const paved = t.biome === "paved";
    const water = t.biome === "water";
    const n = (salt: number) => hash(t.q, t.r, salt);
    const walled: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const next = nb(i);
      const drop = next ? p.y - at.get(next)!.y : Infinity;
      walled.push(paved && (drop === Infinity || drop >= LEVEL * 2 - 0.12));
    }
    for (let i = 0; i < 6; i++) {
      const next = nb(i);
      const side = SIDE[i];
      // How far down the face goes: to the hex below, to the rim of a floating map, or (paved, by the sea) to the water.
      let foot: number;
      if (next) foot = at.get(next)!.y - 0.03;
      else if (floating) foot = RIM;
      else if (paved) foot = 0.04;
      else continue;
      const head = p.y - (water ? 0.0 : 0.085);
      const tall = head - foot;
      // A shore is left as it is: only a real drop to the water is faced.
      if (tall < (!next ? 0.1 : next.biome === "water" ? 0.9 : 0.34)) continue;
      const salt = 500 + i * 37;
      kit.begin(p.x, foot, p.z, clime);
      kit.push(side.x * APO, 0, side.z * APO, faceZ(side.a));
      // In this frame the face is the x-y plane: x along the edge, y up from its foot, z out from it.
      if (paved) {
        kit.box(pal.stone, 1.012, tall, 0.07, 0, 0, 0);
        if (tall > 0.5) {
          kit.box(pal.stoneDark, 1.03, Math.min(0.26, tall * 0.3), 0.16, 0, 0, 0);
          kit.box(pal.stoneLight, 1.03, 0.07, 0.13, 0, tall - 0.16, 0);
        }
        for (let j = 0; j < Math.min(6, Math.round(tall * 3)); j++) {
          const w = 0.2 + n(salt + j) * 0.16;
          kit.box(n(salt + 10 + j) < 0.5 ? pal.stoneLight : pal.stoneDark, w, 0.14, 0.11, (n(salt + 20 + j) - 0.5) * (0.96 - w), 0.2 + n(salt + 30 + j) * Math.max(0.05, tall - 0.6), 0);
        }
        if (clime === "frost" && tall > 0.6) icicles(kit, { n } as Ctx, -0.45, 0.45, tall - 0.16, 0.07, 3, salt + 40);
        if (clime === "mire" && n(salt + 50) < 0.6) vine(kit, (n(salt + 51) - 0.5) * 0.7, tall, 0.06, Math.min(tall * 0.8, 0.4 + n(salt + 52) * 0.8));
        if (clime === "ash" && n(salt + 50) < 0.4) emberCrack(kit, (n(salt + 51) - 0.5) * 0.6, 0.05, 0.05, Math.min(0.4, tall * 0.4), 0, (n(salt + 52) - 0.5) * 0.9);
      } else {
        // Living rock, in bands: the two corners stay on the hex's own, the middle of each band stands out by its own amount.
        const rows = Math.max(1, Math.round(tall / 0.4));
        const mid: number[][] = [];
        for (let r = 0; r <= rows; r++) {
          const out = r === rows ? 0.02 : 0.05 + n(salt + r * 3) * (tall < 0.6 ? 0.05 : 0.13);
          mid.push([(n(salt + 60 + r) - 0.5) * 0.3, (tall * r) / rows, out]);
        }
        const [ax, bx] = [-0.506, 0.506];
        for (let r = 0; r < rows; r++) {
          const [y0, y1] = [mid[r][1], mid[r + 1][1]];
          const top = r === rows - 1;
          const tone = top ? pal.lip : pal.cliff[(r + Math.floor(n(salt + 70) * 3)) % 3];
          const face = [0, 0.2, 1];
          kit.poly(tone, [[ax, y0, 0.004], [mid[r][0], y0, mid[r][2]], [mid[r + 1][0], y1, mid[r + 1][2]]], face);
          kit.poly(tone, [[ax, y0, 0.004], [mid[r + 1][0], y1, mid[r + 1][2]], [ax, y1, 0.004]], face);
          kit.poly(top ? pal.lip : pal.cliff[(r + 1 + Math.floor(n(salt + 70) * 3)) % 3], [[mid[r][0], y0, mid[r][2]], [bx, y0, 0.004], [mid[r + 1][0], y1, mid[r + 1][2]]], face);
          kit.poly(tone, [[bx, y0, 0.004], [bx, y1, 0.004], [mid[r + 1][0], y1, mid[r + 1][2]]], face);
        }
        if (tall > 0.7) {
          // A lump of rock standing off the face, on some; and what the climate hangs from the lip.
          if (n(salt + 80) < 0.4) kit.blob(pal.cliff[1], 0.2 + n(salt + 81) * 0.12, 0.16 + n(salt + 82) * 0.14, 0.1, (n(salt + 83) - 0.5) * 0.5, tall * (0.25 + n(salt + 84) * 0.4), 0.07, 0, n(salt + 85) * 3);
          if (clime === "frost" && n(salt + 90) < 0.6) icicles(kit, { n } as Ctx, -0.4, 0.4, tall - 0.04, 0.05, 3, salt + 91);
          else if ((clime === "greenwood" || clime === "mire") && n(salt + 90) < 0.5) {
            for (let j = 0; j < 2; j++) {
              const x = (n(salt + 92 + j) - 0.5) * 0.7;
              const long = Math.min(tall * 0.7, 0.3 + n(salt + 94 + j) * 0.5);
              kit.tube(clime === "mire" ? MOSS_DARK : pal.bark, [[x, tall - 0.02, 0.03], [x + 0.03, tall - long * 0.5, 0.09], [x - 0.02, tall - long, 0.06]], (u) => 0.022 * (1 - u * 0.7), 4);
            }
          } else if (clime === "ash" && n(salt + 90) < 0.45) emberCrack(kit, (n(salt + 92) - 0.5) * 0.5, tall * 0.1, 0.09, Math.min(0.5, tall * 0.35), 0, (n(salt + 93) - 0.5));
          else if (clime === "dunes" && next && n(salt + 90) < 0.4) kit.blob(SAND, 0.3, 0.14, 0.2, (n(salt + 92) - 0.5) * 0.4, 0.03, 0.14, 2, 0, 0, 0, SOLID, true);
        }
      }
      kit.pop();
    }
    if (!paved) return;
    // The parapet: a low wall along each brink, two merlons on it; left open where a ladder comes up.
    kit.begin(p.x, p.y, p.z, clime);
    for (let i = 0; i < 6; i++) {
      if (!walled[i]) continue;
      const next = nb(i);
      const side = SIDE[i];
      const climbed = !!next && (((next.ladder ?? 0) & (1 << ((i + 3) % 6))) !== 0 || next.prop === "stairs");
      kit.push(side.x * APO, 0, side.z * APO, faceZ(side.a));
      const back = -0.12;
      if (climbed) {
        for (const s of [-1, 1]) {
          kit.box(pal.stone, 0.2, 0.44, 0.17, s * 0.4, -0.1, back);
          kit.box(pal.stoneLight, 0.24, 0.05, 0.21, s * 0.4, 0.34, back);
        }
      } else {
        kit.box(pal.stone, 1.0, 0.4, 0.17, 0, -0.1, back);
        for (const s of [-1, 1]) {
          kit.box(pal.stone, 0.3, 0.24, 0.17, s * 0.3, 0.3, back);
          kit.box(pal.stoneLight, 0.34, 0.05, 0.21, s * 0.3, 0.54, back);
        }
        if (clime === "frost") kit.blob(SNOW, 0.12, 0.05, 0.07, 0, 0.31, back, 2, 0, 0, 0, SOLID, true);
      }
      // A post at the corner where two brinks meet.
      if (walled[(i + 5) % 6]) {
        kit.box(pal.stoneDark, 0.22, 0.72, 0.22, 0.5, -0.1, back - 0.02, Math.PI / 6);
        kit.cone(pal.stoneLight, 0.17, 0.12, 0.5, 0.62, back - 0.02, 4, Math.PI / 6 + Math.PI / 4);
      }
      kit.pop();
    }
  }

  /**
   * Under the rim of a floating map: the rock trails away downward and inward in ragged points, darker as it
   * goes, and is gone before it ends. Its corners are worked out from where they are, so the pieces under two
   * hexes that share one meet there.
   */
  private roots(kit: Kit, byKey: Map<string, Tile>, at: Map<Tile, Place>) {
    // First, which way is "in" at every corner of the rim: away from the open sides that meet there.
    const inward = new Map<string, THREE.Vector2>();
    const cornerKey = (x: number, z: number) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
    const corners = (p: Place, i: number) => {
      const s = SIDE[i];
      return [-1, 1].map((e) => ({ x: p.x + Math.cos(s.a + (e * Math.PI) / 6), z: p.z + Math.sin(s.a + (e * Math.PI) / 6) }));
    };
    const open: { t: Tile; p: Place; i: number }[] = [];
    for (const t of byKey.values()) {
      const p = at.get(t)!;
      for (let i = 0; i < 6; i++) {
        if (byKey.has(key(t.q + DIRS[i].q, t.r + DIRS[i].r))) continue;
        open.push({ t, p, i });
        for (const c of corners(p, i)) {
          const id = cornerKey(c.x, c.z);
          inward.set(id, (inward.get(id) ?? new THREE.Vector2()).add(new THREE.Vector2(-SIDE[i].x, -SIDE[i].z)));
        }
      }
    }
    for (const v of inward.values()) v.normalize();
    const DEEP = [RIM, RIM - 1.0, RIM - 2.5];
    const PULL = [0, 0.3, 0.85];
    for (const { t, p, i } of open) {
      const clime = t.clime ?? "greenwood";
      const pal = PALS[clime];
      const s = SIDE[i];
      const [a, b] = corners(p, i);
      const mid = { x: p.x + s.x * APO, z: p.z + s.z * APO };
      const bucket = kit.bucketAt(FADE, p.x, p.z);
      const tone = pal.cliff[Math.floor(hash(t.q, t.r, 640 + i) * 2.99)];
      // Three columns (corner, middle, corner) by three rows; the middle hangs lower, so the edge is toothed.
      const point = (c: { x: number; z: number }, row: number, middle: boolean) => {
        const id = cornerKey(c.x, c.z);
        const way = middle ? new THREE.Vector2(-s.x, -s.z) : inward.get(id)!;
        const h = hash(Math.round(c.x * 20), Math.round(c.z * 20), 650 + row);
        const pull = PULL[row] * (0.7 + h * 0.6);
        const y = DEEP[row] - (row === 0 ? 0 : h * 0.7 + (middle ? 0.5 * row : 0));
        return [c.x + way.x * pull, y, c.z + way.y * pull];
      };
      const shade = (row: number) => [1, 0.5, 0.16][row];
      const alpha = (row: number) => [1, 0.9, 0][row];
      const quad = (c0: { x: number; z: number }, m0: boolean, c1: { x: number; z: number }, m1: boolean, row: number) => {
        const [p00, p10, p01, p11] = [point(c0, row, m0), point(c1, row, m1), point(c0, row + 1, m0), point(c1, row + 1, m1)];
        for (const tri of [[p00, p01, p11, row, row + 1, row + 1], [p00, p11, p10, row, row + 1, row]] as const) {
          const [u, v, w] = [tri[0] as number[], tri[1] as number[], tri[2] as number[]];
          let nx = (v[1] - u[1]) * (w[2] - u[2]) - (v[2] - u[2]) * (w[1] - u[1]);
          let ny = (v[2] - u[2]) * (w[0] - u[0]) - (v[0] - u[0]) * (w[2] - u[2]);
          let nz = (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
          // Facing out from the land, whichever way its corners were given.
          const flip = nx * s.x + nz * s.z < 0;
          const order = flip ? [u, w, v] : [u, v, w];
          const rowsOf = flip ? [tri[3], tri[5], tri[4]] : [tri[3], tri[4], tri[5]];
          if (flip) [nx, ny, nz] = [-nx, -ny, -nz];
          const len = Math.hypot(nx, ny, nz) || 1;
          order.forEach((q, j) => {
            bucket.pos.push(q[0], q[1], q[2]);
            bucket.nor.push(nx / len, ny / len, nz / len);
            const k = shade(rowsOf[j] as number);
            bucket.col.push(tone.r * k, tone.g * k, tone.b * k, alpha(rowsOf[j] as number));
          });
        }
      };
      for (let row = 0; row < 2; row++) {
        quad(a, false, mid, true, row);
        quad(mid, true, b, false, row);
      }
    }
  }

  /**
   * The pools of glow on the ground round every fire and cold light: each hex a light reaches wears a sheet a
   * hair over its top, bright by how near each point of it is. Laid hex by hex, the glow keeps to the ground
   * on a terraced map and never hangs in the air over a drop.
   */
  private pools(kit: Kit, byKey: Map<string, Tile>, at: Map<Tile, Place>) {
    // A hex's top as a fan: its middle, a ring half way out, its corners and the middles of its sides.
    const ring: number[][] = [[0, 0]];
    for (let j = 0; j < 6; j++) ring.push([Math.sin((j * Math.PI) / 3) * 0.5, Math.cos((j * Math.PI) / 3) * 0.5]);
    for (let j = 0; j < 12; j++) ring.push([Math.sin((j * Math.PI) / 6) * (j % 2 ? APO : 1) * 0.985, Math.cos((j * Math.PI) / 6) * (j % 2 ? APO : 1) * 0.985]);
    const tris: number[][] = [];
    for (let j = 0; j < 6; j++) {
      tris.push([0, 1 + j, 1 + ((j + 1) % 6)]);
      const [o0, o1, o2] = [7 + j * 2, 7 + j * 2 + 1, 7 + ((j * 2 + 2) % 12)];
      tris.push([1 + j, o0, o1], [1 + j, o1, 1 + ((j + 1) % 6)], [1 + ((j + 1) % 6), o1, o2]);
    }
    for (const pool of kit.pools) {
      if (pool.radius <= 0) continue;
      const r0 = Math.round(pool.z / 1.5);
      const q0 = Math.round(pool.x / SQRT3 - r0 / 2);
      const span = Math.ceil(pool.radius / 1.5) + 1;
      for (let dq = -span; dq <= span; dq++)
        for (let dr = -span; dr <= span; dr++) {
          const t = byKey.get(key(q0 + dq, r0 + dr));
          if (!t || t.biome === "water") continue;
          const p = at.get(t)!;
          if (Math.hypot(p.x - pool.x, p.z - pool.z) > pool.radius + 1) continue;
          // Ground well above the light is not lit by it; ground below it is, more faintly the further down.
          const lift = p.y - pool.y;
          if (lift > 0.75) continue;
          const reach = pool.radius * (lift < -0.3 ? Math.max(0.5, 1 + lift * 0.18) : 1);
          const bright = ring.map(([x, z]) => {
            const d = Math.hypot(p.x + x - pool.x, p.z + z - pool.z);
            return pool.strength * Math.pow(Math.max(0, 1 - d / reach), 2.1);
          });
          if (Math.max(...bright) < 0.004) continue;
          const b = kit.bucketAt(pool.layer, p.x, p.z);
          for (const tri of tris)
            for (const v of tri) {
              b.pos.push(p.x + ring[v][0], p.y + 0.022, p.z + ring[v][1]);
              b.nor.push(0, 1, 0);
              b.col.push(pool.color.r * bright[v], pool.color.g * bright[v], pool.color.b * bright[v]);
            }
        }
    }
  }

  /**
   * Once a frame. `focus` is what the view looks at: the fires nearest it carry the real lights. `dark` is how
   * dark the scene is, 0 (broad day) to 1 (night, or a place that is always dim): fire shows more as the light goes.
   */
  update(clock: number, dt: number, focus: THREE.Vector3, dark = 0) {
    const live = this.still ? 0 : 1;
    for (const f of this.flames) if (Math.abs(f.position.x - focus.x) + Math.abs(f.position.z - focus.z) < 70) flickerFlame(f, clock);
    this.motes?.tick(clock);
    for (const p of this.portals) p.uniforms.uTime.value = clock * (live ? 1 : 0.1);
    // Glow on the ground is faint by day, when the sun drowns it.
    const shown = 0.3 + 0.7 * dark;
    const waver = 1 + live * (Math.sin(clock * 9.1) * 0.05 + Math.sin(clock * 15.3) * 0.035);
    this.warm.color.setScalar(shown * waver);
    this.cool.color.setScalar((0.4 + 0.6 * dark) * (1 + live * Math.sin(clock * 1.3) * 0.08));
    this.glow.color.setScalar(1 + live * Math.sin(clock * 1.7) * 0.05);
    if (this.slots.length === 0) return;
    // A few times a second: which fires are nearest. A light whose fire has dropped out fades, moves, and comes up again.
    this.since += dt;
    if (this.since > 0.2) {
      this.since = 0;
      const near = [...this.emitters].sort((a, b) => (a.x - focus.x) ** 2 + (a.z - focus.z) ** 2 - ((b.x - focus.x) ** 2 + (b.z - focus.z) ** 2)).slice(0, this.slots.length);
      const wanted = new Set(near);
      for (const s of this.slots) if (s.of && wanted.has(s.of)) wanted.delete(s.of);
      const free = [...wanted];
      for (const s of this.slots) {
        if (s.of && near.includes(s.of)) continue;
        if (s.gain > 0.02 && s.of) continue;
        s.of = free.shift() ?? null;
        if (s.of) {
          s.light.position.set(s.of.x, s.of.y, s.of.z);
          s.light.color.copy(s.of.color);
          s.light.distance = s.of.range;
        }
      }
      for (const s of this.slots) s.light.userData.keep = !!s.of && near.includes(s.of);
    }
    this.slots.forEach((s, i) => {
      const goal = s.light.userData.keep ? 1 : 0;
      s.gain += (goal - s.gain) * Math.min(1, dt * 5);
      const e = s.of;
      if (!e) {
        s.light.intensity = 0;
        return;
      }
      const flick = e.fire ? 1 + live * (Math.sin(clock * 8.7 + i * 2.1) * 0.07 + Math.sin(clock * 14.9 + i) * 0.05) : 1 + live * Math.sin(clock * 1.3 + i) * 0.1;
      s.light.intensity = e.power * 4.6 * s.gain * flick * (0.4 + 0.6 * dark);
    });
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        for (const one of Array.isArray(m) ? m : [m]) one.dispose();
      }
    });
    this.motes?.dispose();
    this.group.clear();
    this.flames = [];
    this.slots = [];
  }
}
