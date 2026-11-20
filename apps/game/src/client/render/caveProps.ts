// What there is to open and to break in a delve, as models: an old chest, an
// iron-bound strongbox, the hoard with coin spilling out of it, and crates.
// Low-poly in flat colours like the rest of the world. Their brass, gold and
// glints are lit from within a little, so a chest can be made out across a
// dark chamber before any torch reaches it.
//
// Each is built about its model's own middle, standing on y = 0, set a
// little forward the way places are (the renderer sets them back again).
// What moves is marked for the renderer to move:
// - a chest's lid hangs from a hinge (`userData.lid`), turned by its
//   rotation.x: 0 shut, LID_OPEN thrown back;
// - a crate's body is one group (`userData.body`), which a blow rocks;
// - a glint that twinkles carries `userData.twinkle` (its phase) and
//   `userData.size` (its full size).

import * as THREE from "three";
import type { Poi } from "@gantt-quest/world";
import { OVERLAY_LAYER } from "./post";

/** How far a chest's lid swings back when it is thrown open, about its hinge. */
export const LID_OPEN = -1.95;
/** The hoard's lid, before it is opened: pushed up a crack by what is inside. */
const HOARD_AJAR = -0.3;
/** Places are set back from their hex's middle by this much (placeOf in places/placing.ts): models are built this far forward. */
const FORWARD = 0.28;

type ChestKind = "chest" | "vault" | "hoard";

interface ChestLook {
  w: number;
  h: number;
  d: number;
  wood: string;
  /** The seams between planks, and the inside. */
  seam: string;
  /** Its bands. */
  metal: string;
  /** The hoard's gilt edging. */
  trim?: string;
  /** A rounded lid (stepped), or a flat one. */
  dome: boolean;
  /** Standing on four little feet. */
  feet: boolean;
  /** The faint light it gives off onto the floor around it while it is shut. */
  pool: number;
}

const LOOKS: Record<ChestKind, ChestLook> = {
  // Weathered boards and rusting bands.
  chest: { w: 0.62, h: 0.32, d: 0.42, wood: "#8a5a2b", seam: "#4a2f17", metal: "#5d554b", dome: true, feet: false, pool: 0.12 },
  // Dark wood all but hidden under iron: bands, corners and studs, and a heavy lock.
  vault: { w: 0.7, h: 0.38, d: 0.46, wood: "#4f3220", seam: "#2a190c", metal: "#4a5058", dome: false, feet: true, pool: 0.14 },
  // Big, gilt-edged, and too full to shut.
  hoard: { w: 0.92, h: 0.44, d: 0.58, wood: "#6b3a1e", seam: "#3a1e0d", metal: "#8c6a2a", trim: "#f2c14e", dome: true, feet: true, pool: 0.3 },
};

// ---------- shared pieces ----------

const geometries = new Map<string, THREE.BufferGeometry>();
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let geo = geometries.get(key);
  if (!geo) geometries.set(key, (geo = new THREE.BoxGeometry(w, h, d)));
  return geo;
}
const gem = new THREE.OctahedronGeometry(1, 0);
const disc = new THREE.CircleGeometry(1, 32);
/** Whether a shape is one of the shared ones above, kept for every chest and crate: not to be disposed with one model. */
export const sharedShape = (geo: THREE.BufferGeometry): boolean => geo === gem || geo === disc || geometries.get(boxKey(geo)) === geo;
/** The key a box of this shape would be kept under (see box), or "" if it is no plain box. */
function boxKey(geo: THREE.BufferGeometry): string {
  if (!(geo instanceof THREE.BoxGeometry)) return "";
  const { width, height, depth } = geo.parameters;
  return `${width.toFixed(3)}|${height.toFixed(3)}|${depth.toFixed(3)}`;
}

/** Light falling off softly from the middle to nothing at the edge, for the pools round what glows. */
let falloff: THREE.Texture | null = null;
function softEdge(): THREE.Texture {
  if (falloff) return falloff;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  falloff = new THREE.CanvasTexture(canvas);
  return falloff;
}

const materials = new Map<string, THREE.Material>();
/** Flat-shaded, lit by the scene; `glow` lights it a little from within (0 to 1). */
function lambert(color: string, glow = 0): THREE.Material {
  const key = `l|${color}|${glow}`;
  let mat = materials.get(key);
  if (!mat) materials.set(key, (mat = new THREE.MeshLambertMaterial({ color, flatShading: true, ...(glow > 0 ? { emissive: new THREE.Color(color).multiplyScalar(glow) } : {}) })));
  return mat;
}
/** Lit wholly from within: gold, and the dark inside a box. */
function shine(color: string): THREE.Material {
  const key = `b|${color}`;
  let mat = materials.get(key);
  if (!mat) materials.set(key, (mat = new THREE.MeshBasicMaterial({ color })));
  return mat;
}
/** A point of light that twinkles: each has its own material, so it can fade on its own. */
const sparkle = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });

/** A small seeded generator, so each chest and crate is drawn the same way every time. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function put(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}

/**
 * Not pointed at: what lies on the floor round a chest (its light, the coin spilt from the hoard) reaches into the
 * hexes beside it, and pointing there means those hexes, not the chest.
 */
const unpickable = <T extends THREE.Object3D>(o: T): T => {
  o.raycast = () => {};
  return o;
};

/** A glint that twinkles in place (the renderer turns it and pulses it). */
function glint(parent: THREE.Object3D, color: string, size: number, x: number, y: number, z: number, phase: number): void {
  const m = unpickable(put(parent, gem, sparkle(color), x, y, z));
  m.scale.setScalar(size);
  m.userData.twinkle = phase;
  m.userData.size = size;
  m.userData.glow = true;
}

/** A soft warm light on the floor round something that glows. */
function pool(parent: THREE.Object3D, color: string, radius: number, opacity: number, z = FORWARD): void {
  const mat = new THREE.MeshBasicMaterial({ color, map: softEdge(), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const m = unpickable(put(parent, disc, mat, 0, 0.012, z, -Math.PI / 2));
  m.scale.setScalar(radius);
  m.userData.glow = true;
}

// ---------- chests ----------

export const chestKind = (poi: Poi): ChestKind => (poi.loot === "hoard" || poi.loot === "vault" ? poi.loot : "chest");

/** Where a chest's lid rests when nothing is moving it: thrown back once it is open, and the hoard's pushed up a crack. */
export const restingLid = (poi: Poi): number => (poi.cleared ? LID_OPEN : chestKind(poi) === "hoard" ? HOARD_AJAR : 0);

/** Where the top of a chest is, in its model: what spills out of it comes from here. */
export function chestMouth(poi: Poi): THREE.Vector3 {
  const L = LOOKS[chestKind(poi)];
  return new THREE.Vector3(0, (L.feet ? 0.05 : 0) + L.h + 0.05, FORWARD);
}

/** A chest, strongbox or hoard, shut or thrown open. `lid` is the lid's angle now (restingLid, or part way while it swings). */
export function chestModel(poi: Poi, lid = restingLid(poi)): THREE.Group {
  const kind = chestKind(poi);
  const L = LOOKS[kind];
  const open = poi.cleared;
  const rnd = seeded(`${poi.id}|${poi.pos.q},${poi.pos.r}`);
  const g = new THREE.Group();
  const chest = new THREE.Group();
  chest.position.z = FORWARD;
  // Not set square to the world: a few degrees askew, its own way.
  chest.rotation.y = (rnd() - 0.5) * 0.5;
  g.add(chest);
  const wood = lambert(L.wood, 0.08);
  const seam = lambert(L.seam);
  // The iron catches what little light there is, so the shape of the bands shows in the dark.
  const metal = lambert(L.metal, kind === "hoard" ? 0.25 : 0.16);
  const brass = lambert("#d8b45a", 0.35);
  const trim = L.trim ? lambert(L.trim, 0.45) : null;
  const foot = L.feet ? 0.05 : 0;
  const top = foot + L.h;
  const bandX = [-L.w * 0.3, L.w * 0.3];

  if (L.feet) for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(chest, box(0.08, foot, 0.08), trim ?? metal, sx * (L.w / 2 - 0.05), foot / 2, sz * (L.d / 2 - 0.05));
  // The body, with the seams between its boards running round it.
  put(chest, box(L.w, L.h, L.d), wood, 0, foot + L.h / 2, 0);
  for (const y of [0.36, 0.68]) put(chest, box(L.w + 0.006, 0.014, L.d + 0.006), seam, 0, foot + L.h * y, 0);
  // Bands up the front, over and down the back.
  for (const x of bandX) put(chest, box(0.05, L.h + 0.008, L.d + 0.02), metal, x, foot + L.h / 2, 0);
  if (kind === "vault") {
    // Iron all round its middle, on every corner, and studded.
    put(chest, box(L.w + 0.02, 0.05, L.d + 0.02), metal, 0, foot + L.h * 0.5, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(chest, box(0.07, L.h + 0.012, 0.07), metal, sx * (L.w / 2), foot + L.h / 2, sz * (L.d / 2));
    const stud = lambert("#7d838c", 0.2);
    for (const x of [...bandX, -L.w * 0.12, L.w * 0.12]) for (const y of [0.22, 0.78]) put(chest, box(0.024, 0.024, 0.014), stud, x, foot + L.h * y, L.d / 2 + 0.014);
  }
  if (trim) {
    // Gilt along the top edge and down every corner.
    put(chest, box(L.w + 0.024, 0.035, L.d + 0.024), trim, 0, top - 0.018, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(chest, box(0.05, L.h, 0.05), trim, sx * (L.w / 2), foot + L.h / 2, sz * (L.d / 2));
  }
  // The lock on the front, and its keyhole.
  const lockW = kind === "vault" ? 0.13 : 0.09;
  put(chest, box(lockW, lockW * 1.15, 0.022), brass, 0, top - lockW * 0.75, L.d / 2 + 0.014);
  put(chest, box(0.018, 0.04, 0.01), shine("#1a1208"), 0, top - lockW * 0.8, L.d / 2 + 0.028);
  if (kind === "vault" && !open) {
    // A padlock hung on the hasp: its body, and the shackle through it.
    put(chest, box(0.1, 0.09, 0.05), brass, 0, top - 0.17, L.d / 2 + 0.06);
    put(chest, box(0.07, 0.06, 0.016), lambert("#9aa0a8", 0.25), 0, top - 0.1, L.d / 2 + 0.06);
  }
  // Inside: dark once it is open; the hoard's gold heaped up to the rim until it is taken.
  if (open || kind === "hoard") put(chest, box(L.w - 0.06, 0.012, L.d - 0.06), shine("#140d08"), 0, top - 0.004, 0);
  if (kind === "hoard" && !open) put(chest, box(L.w - 0.1, 0.06, L.d - 0.1), shine("#ffcf4a"), 0, top - 0.02, 0);

  // The lid, hung from a hinge along the back of the top.
  const hinge = new THREE.Group();
  hinge.position.set(0, top, -L.d / 2);
  hinge.rotation.x = lid;
  chest.add(hinge);
  g.userData.lid = hinge;
  // Built from the hinge forward: its front edge is at z = L.d.
  const steps: [number, number][] = L.dome ? [[L.d, 0.06], [L.d * 0.76, 0.05], [L.d * 0.46, 0.04]] : [[L.d + 0.02, 0.09]];
  let y = 0;
  for (const [depth, high] of steps) {
    put(hinge, box(L.dome ? L.w : L.w + 0.02, high, depth), wood, 0, y + high / 2, L.d / 2);
    for (const x of bandX) put(hinge, box(0.055, high + 0.004, depth + 0.014), metal, x, y + high / 2, L.d / 2);
    if (trim) put(hinge, box(L.w + 0.024, 0.02, depth + 0.02), trim, 0, y + 0.01, L.d / 2);
    y += high;
  }
  if (kind === "vault") {
    // An iron rim round the flat lid, and a band across it.
    put(hinge, box(L.w + 0.04, 0.03, L.d + 0.04), metal, 0, 0.015, L.d / 2);
    put(hinge, box(L.w + 0.03, 0.095, 0.05), metal, 0, 0.045, L.d / 2);
  }
  // The hasp, hanging down over the lock.
  put(hinge, box(0.05, 0.08, 0.016), brass, 0, -0.03, L.d + 0.014);

  if (kind === "hoard") {
    // Coin spilt down its front and across the floor, piled in stacks, with a few gems among it. Once the hoard is
    // taken a little is left lying about, dull.
    const coin = open ? lambert("#9b7d32", 0.1) : shine("#ffd45e");
    const coins = open ? 7 : 26;
    for (let i = 0; i < coins; i++) {
      const a = (rnd() - 0.5) * Math.PI * 1.3;
      const r = L.d / 2 + 0.05 + rnd() * 0.38;
      unpickable(put(g, box(0.075, 0.016, 0.075), coin, Math.sin(a) * r * 1.2, 0.01 + rnd() * 0.012, FORWARD + Math.cos(a) * r, rnd() * 0.3, rnd() * 3, rnd() * 0.3));
    }
    if (!open) {
      // Down the front of it, over the lip.
      for (let i = 0; i < 6; i++) put(chest, box(0.07, 0.016, 0.07), coin, (rnd() - 0.5) * L.w * 0.6, foot + L.h * (0.25 + rnd() * 0.75), L.d / 2 + 0.04, 1.1 + rnd() * 0.3, rnd(), 0);
      for (const [x, z, n] of [[-0.48, 0.18, 4], [0.5, 0.28, 3], [0.3, 0.62, 2]] as const) for (let k = 0; k < n; k++) unpickable(put(g, box(0.08, 0.02, 0.08), coin, x, 0.012 + k * 0.022, FORWARD + z, 0, rnd(), 0));
      const gems = ["#7fe0ff", "#ff6fb5", "#8cff7a"];
      gems.forEach((c, i) => {
        const m = unpickable(put(g, gem, shine(c), (i - 1) * 0.36, 0.05, FORWARD + L.d / 2 + 0.22 + rnd() * 0.12, 0, rnd() * 2, 0));
        m.scale.set(0.045, 0.06, 0.045);
      });
    }
  }

  if (!open) {
    // It glints: at the lock, along the bands, and (the hoard) all over the gold. And a little light pools round it.
    const pale = "#fff3c4";
    glint(chest, pale, 0.05, 0, top - lockW * 0.4, L.d / 2 + 0.03, rnd() * 6);
    glint(chest, pale, 0.042, bandX[1], top + 0.08, L.d / 2 - 0.03, rnd() * 6);
    glint(chest, pale, 0.042, bandX[0], foot + L.h * 0.5, L.d / 2 + 0.02, rnd() * 6);
    if (kind === "hoard") for (let i = 0; i < 5; i++) glint(g, i % 2 ? "#ffe9a0" : pale, 0.04, (rnd() - 0.5) * 0.9, 0.06 + rnd() * 0.5, FORWARD + (rnd() - 0.3) * 0.6, rnd() * 6);
    pool(g, kind === "hoard" ? "#ffb347" : "#ffd98a", kind === "hoard" ? 1.0 : 0.62, L.pool);
  }
  return g;
}

// ---------- crates ----------

/** A crate's size, and how it stands: from its id, so it is the same each time it is drawn. */
function crateShape(poi: Poi) {
  const rnd = seeded(`${poi.id}|${poi.pos.q},${poi.pos.r}|crate`);
  return { rnd, size: 0.62 + rnd() * 0.08, turn: (rnd() - 0.5) * 0.7, stacked: rnd() < 0.35 };
}

const CRATE_WOOD = "#a87b4a";
const CRATE_FRAME = "#6b4a2a";

/**
 * One box of boards: a frame of beams on its edges, the seams between its boards, and a brace across each side.
 * `hurt` is how knocked about it is: 0 sound, 1 a brace split and a board cracked, 2 a board stove in as well.
 */
function crateBox(parent: THREE.Object3D, s: number, hurt: 0 | 1 | 2): void {
  const wood = lambert(CRATE_WOOD, 0.12);
  const frame = lambert(CRATE_FRAME, 0.1);
  const seam = lambert("#4a321b");
  const dark = shine("#120b06");
  const t = Math.max(0.05, s * 0.1);
  const e = s / 2 - t / 2;
  put(parent, box(s - 0.02, s - 0.02, s - 0.02), wood, 0, s / 2, 0);
  for (const y of [0.36, 0.68]) put(parent, box(s - 0.012, 0.012, s - 0.012), seam, 0, s * y, 0);
  // The frame: a post up each corner, and beams round the top and the bottom.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(parent, box(t, s, t), frame, sx * e, s / 2, sz * e);
  for (const y of [t / 2, s - t / 2]) {
    for (const sz of [-1, 1]) put(parent, box(s, t, t), frame, 0, y, sz * e);
    for (const sx of [-1, 1]) put(parent, box(t, t, s), frame, sx * e, y, 0);
  }
  // A brace corner to corner across each side; the front's is split when it has been hit.
  const brace = Math.hypot(s - 2 * t, s - 2 * t);
  const tilt = Math.PI / 4;
  for (let side = 0; side < 4; side++) {
    const yaw = (side * Math.PI) / 2;
    const out = s / 2 + 0.006;
    const [x, z] = [Math.sin(yaw) * out, Math.cos(yaw) * out];
    const face = new THREE.Group();
    face.position.set(x, s / 2, z);
    face.rotation.y = yaw;
    parent.add(face);
    const lean = side % 2 ? tilt : -tilt;
    if (side === 0 && hurt > 0) {
      // Split in the middle: two halves, each knocked a little out of line, and a crack in the board behind.
      put(face, box(brace * 0.46, t * 0.8, 0.026), frame, -brace * 0.24 * Math.cos(lean), -brace * 0.24 * Math.sin(lean), 0, 0, 0, lean + 0.12);
      put(face, box(brace * 0.4, t * 0.8, 0.026), frame, brace * 0.27 * Math.cos(lean), brace * 0.27 * Math.sin(lean) + 0.02, 0.01, 0.15, 0, lean - 0.2);
      put(face, box(0.03, s * 0.55, 0.01), dark, s * 0.12, -s * 0.05, 0.004, 0, 0, 0.25);
    } else put(face, box(brace, t * 0.8, 0.026), frame, 0, 0, 0, 0, 0, lean);
  }
  if (hurt > 1) {
    // A board on top stove in, and one off the side.
    put(parent, box(s * 0.5, 0.01, s * 0.26), dark, -s * 0.08, s + 0.002, s * 0.08, 0, 0.3, 0);
    put(parent, box(0.01, s * 0.24, s * 0.5), dark, s / 2 + 0.004, s * 0.52, -s * 0.05);
  }
}

/** A health bar over a crate that has been knocked about. Drawn on the overlay layer, over everything. */
function crateBar(fraction: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 34;
  canvas.height = 6;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0e0b1c";
  ctx.fillRect(0, 0, 34, 6);
  ctx.fillStyle = "#1b1830";
  ctx.fillRect(1, 1, 32, 4);
  ctx.fillStyle = fraction > 0.5 ? "#c9a46a" : fraction > 0.25 ? "#ffd23f" : "#ff6b6b";
  ctx.fillRect(1, 1, Math.max(1, Math.round(32 * fraction)), 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(0.8, 0.14, 1);
  sprite.renderOrder = 5;
  sprite.layers.set(OVERLAY_LAYER);
  return sprite;
}

/** Where the top of a crate is, in its model: what flies off it when it breaks comes from here. */
export function crateMiddle(poi: Poi): THREE.Vector3 {
  return new THREE.Vector3(0, crateShape(poi).size * 0.55, FORWARD);
}

/** A crate: whole, knocked about (with its health over it), or broken into a pile of splinters. */
export function crateModel(poi: Poi): THREE.Group {
  const { rnd, size, turn, stacked } = crateShape(poi);
  const g = new THREE.Group();
  if (poi.cleared) {
    // Splinters: boards and beams lying every which way, a side half off and leaning on the rest.
    const wood = lambert("#8a6238", 0.06);
    const frame = lambert("#5a3c20", 0.05);
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 0.36;
      const long = 0.18 + rnd() * 0.28;
      put(g, box(long, 0.03, 0.08), i % 3 ? wood : frame, Math.cos(a) * r, 0.02 + rnd() * 0.03, FORWARD + Math.sin(a) * r, (rnd() - 0.5) * 0.3, rnd() * Math.PI, (rnd() - 0.5) * 0.4);
    }
    put(g, box(size * 0.55, size * 0.5, 0.03), wood, 0.08, size * 0.18, FORWARD - 0.08, -1.05, turn, 0.1);
    put(g, box(0.06, size * 0.8, 0.06), frame, -0.2, 0.04, FORWARD + 0.12, 0, turn + 0.8, Math.PI / 2);
    return g;
  }
  const hp = poi.hp ?? poi.maxHp ?? 1;
  const max = poi.maxHp ?? hp;
  const fraction = max > 0 ? hp / max : 1;
  const hurt: 0 | 1 | 2 = fraction >= 1 ? 0 : fraction > 0.45 ? 1 : 2;
  const body = new THREE.Group();
  body.position.z = FORWARD;
  body.rotation.y = turn;
  // Badly knocked about, it leans.
  if (hurt === 2) body.rotation.z = 0.06;
  g.add(body);
  g.userData.body = body;
  crateBox(body, size, hurt);
  if (stacked) {
    // A smaller one set on top, turned its own way.
    const small = new THREE.Group();
    small.position.set((rnd() - 0.5) * 0.1, size, (rnd() - 0.5) * 0.1);
    small.rotation.y = (rnd() - 0.5) * 1.2;
    body.add(small);
    crateBox(small, size * 0.55, 0);
  }
  if (fraction < 1) {
    const bar = crateBar(fraction);
    bar.position.set(0, size * (stacked ? 1.55 : 1) + 0.35, FORWARD);
    g.add(bar);
  }
  return g;
}
