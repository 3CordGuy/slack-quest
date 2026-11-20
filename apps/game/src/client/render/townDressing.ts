// What dresses the Harbor and is not a place: the round of paving under the
// waygate and the standing stones about it, the lamps along the streets, the
// well in the square, the quay's kerb, mooring posts, cargo and crane, and
// the forecourt of the caverns with its stone keepers and braziers.
//
// Where each piece stands is the map's to say (HARBOR_DECOR in the world's
// harbor.ts): this file only draws them. Everything that does not move is
// folded into one mesh, painted by vertex, and everything that gives light
// into two more (warm lamplight, the gate's cold fire), so the whole town's
// dressing costs a handful of draw calls however much of it there is.

import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";
import { HARBOR_BOATS, HARBOR_BRIDGE, HARBOR_CAVE, HARBOR_CAVE_STEPS, HARBOR_COURT, HARBOR_DECOR, HARBOR_FORECOURT, HARBOR_GATE, HARBOR_PIERS, HARBOR_SIDES, tileAt, type DecorKind, type HarborDecor, type WorldMap } from "@gantt-quest/world";
import type { BuildingGlow } from "./ambience";
import { moteField, type Mote, type MoteField } from "./motes";
import { torchFlame } from "./torchFlame";

type Place = { x: number; y: number; z: number };

/** A fixed 0..1 value for a pair of numbers. */
const hash = (a: number, b: number, salt: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

/**
 * Shapes gathered into one mesh, each painted its own colour. Every shape is given by where its foot is (the
 * middle of its underside), so a thing is built up from the ground the way it stands.
 */
class Paint {
  private pos: number[] = [];
  private col: number[] = [];
  private M = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private tone = new THREE.Color();
  private pieces = 0;

  /** Work in a frame moved to (x, y, z), turned `ry` about the upright and `s` times the size, until `pop`. */
  push(x = 0, y = 0, z = 0, ry = 0, s = 1) {
    this.stack.push(this.M.clone());
    this.M.multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(s, s, s)));
  }

  pop() {
    this.M.copy(this.stack.pop()!);
  }

  /** A point of the current frame, in the frame everything is gathered in. */
  at(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.M);
  }

  /** Any shape, its own middle put at (x, y, z) and turned. Each piece is a shade off its colour, so no two stones match. */
  shape(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), new THREE.Vector3(sx, sy, sz)).premultiply(this.M);
    const p = flat.getAttribute("position");
    const v = new THREE.Vector3();
    const shade = 0.93 + hash(this.pieces++, 3, 5) * 0.14;
    this.tone.set(color).multiplyScalar(shade);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      this.col.push(this.tone.r, this.tone.g, this.tone.b);
    }
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
  }

  box(color: string, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    this.shape(new THREE.BoxGeometry(w, h, d), color, x, y + h / 2, z, ry, rx, rz);
  }

  cyl(color: string, top: number, bottom: number, h: number, x: number, y: number, z: number, sides = 8, ry = 0, rx = 0, rz = 0) {
    this.shape(new THREE.CylinderGeometry(top, bottom, h, sides), color, x, y + h / 2, z, ry, rx, rz);
  }

  cone(color: string, r: number, h: number, x: number, y: number, z: number, sides = 6, ry = 0) {
    this.shape(new THREE.ConeGeometry(r, h, sides), color, x, y + h / 2, z, ry);
  }

  /** A rough lump, its middle at (x, y, z). */
  blob(color: string, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0, rx = 0) {
    this.shape(new THREE.DodecahedronGeometry(1, 0), color, x, y, z, ry, rx, 0, sx, sy, sz);
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  mesh(material: THREE.Material): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }
}

// ---- the colours of the town ----
const STONE = "#8a8f98";
const STONE_DARK = "#6a6f79";
const STONE_PALE = "#a4a8ae";
const OLD = "#7a7f8a";
const TIMBER = "#6b4a2b";
const TIMBER_DARK = "#4a3320";
const TIMBER_PALE = "#8d6a44";
const IRON = "#2e2c31";
const BRASS = "#c79a3e";
const ROPE = "#c4a06a";
const LAMP = "#ffd98a";
const FIRE = "#ffb04a";
const RUNE = "#8fe9ff";
const GHOST = "#a8ffd0";

/** What a piece is drawn into: what stands, what gives warm light, what burns cold. And what it tells the town. */
interface Kit {
  solid: Paint;
  warm: Paint;
  cool: Paint;
  glows: BuildingGlow[];
  /** Fires to light: where, and how big. */
  fires: { at: THREE.Vector3; size: number }[];
  /** Pieces that hang in the air and bob: where each rests, and what it is. */
  floats: { at: THREE.Vector3; kind: "capital" | "drum"; turn: number; scale: number }[];
}

/** A ship's lantern on a bracket: glass that glows, caged in iron, under a cap. Its middle at (x, y, z). */
function lantern(k: Kit, x: number, y: number, z: number, s = 1, light: BuildingGlow["light"] = "lamp", halo = 0.85) {
  k.warm.box(LAMP, 0.1 * s, 0.14 * s, 0.1 * s, x, y - 0.07 * s, z);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.solid.box(IRON, 0.018 * s, 0.16 * s, 0.018 * s, x + dx * 0.058 * s, y - 0.08 * s, z + dz * 0.058 * s);
  k.solid.box(IRON, 0.15 * s, 0.022 * s, 0.15 * s, x, y - 0.1 * s, z);
  k.solid.cone(IRON, 0.115 * s, 0.08 * s, x, y + 0.075 * s, z, 4, Math.PI / 4);
  k.solid.box(BRASS, 0.03 * s, 0.03 * s, 0.03 * s, x, y + 0.15 * s, z);
  k.glows.push({ pos: k.solid.at(x, y, z), size: halo * s, light });
}

/** A coil of rope lying flat. */
function coil(k: Kit, x: number, y: number, z: number, r = 0.12) {
  for (let i = 0; i < 3; i++) k.solid.shape(new THREE.TorusGeometry(r - i * 0.012, 0.022, 5, 12), ROPE, x, y + 0.022 + i * 0.036, z, 0, Math.PI / 2);
}

function crate(k: Kit, x: number, y: number, z: number, s: number, ry: number, tone = TIMBER_PALE) {
  k.solid.push(x, y, z, ry, s);
  k.solid.box(tone, 0.36, 0.34, 0.36, 0, 0, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.solid.box(TIMBER_DARK, 0.05, 0.36, 0.05, sx * 0.17, 0, sz * 0.17);
  k.solid.box(TIMBER_DARK, 0.4, 0.04, 0.4, 0, 0.32, 0);
  k.solid.box(TIMBER, 0.38, 0.05, 0.05, 0, 0.15, 0.17, 0, 0, 0.72);
  k.solid.pop();
}

function barrel(k: Kit, x: number, y: number, z: number, s = 1, lying = false) {
  k.solid.push(x, y, z, hash(x, z, 9) * 6, s);
  const body = (r: number, h: number, yy: number, c: string) => (lying ? k.solid.cyl(c, r, r, h, 0, 0.17 - r, yy - 0.2, 10, 0, Math.PI / 2) : k.solid.cyl(c, r, r, h, 0, yy, 0, 10));
  body(0.15, 0.12, 0, TIMBER);
  body(0.17, 0.18, 0.12, TIMBER_PALE);
  body(0.15, 0.12, 0.3, TIMBER);
  body(0.158, 0.03, 0.09, IRON);
  body(0.158, 0.03, 0.3, IRON);
  k.solid.pop();
}

/** A standing stone of the waygate's court: an old column, fluted, banded with brass, signs burning cold up its face. `tall` whole; shorter is broken off. */
function courtPillar(k: Kit, tall: number, whole: boolean, seed: number) {
  const s = k.solid;
  s.box(STONE_DARK, 0.56, 0.42, 0.56, 0, -0.3, 0);
  s.box(OLD, 0.48, 0.1, 0.48, 0, 0.12, 0, 0.1);
  const drums = Math.max(1, Math.round(tall / 0.42));
  const each = (tall - 0.22) / drums;
  for (let i = 0; i < drums; i++) {
    const r = 0.19 - i * 0.006;
    s.cyl(i % 2 ? OLD : STONE, r - 0.008, r, each - 0.012, (hash(seed, i, 1) - 0.5) * 0.02, 0.22 + i * each, (hash(seed, i, 2) - 0.5) * 0.02, 10, hash(seed, i, 3) * 6);
  }
  s.cyl(BRASS, 0.2, 0.2, 0.045, 0, 0.5, 0, 10);
  // Signs up the side that faces the gate, and round the foot.
  for (let i = 0; i < Math.floor((tall - 0.5) / 0.3); i++) {
    const y = 0.72 + i * 0.3;
    const kind = Math.floor(hash(seed, i, 4) * 2.99);
    if (kind === 0) k.cool.box(RUNE, 0.035, 0.15, 0.012, 0, y, 0.19);
    else if (kind === 1) k.cool.box(RUNE, 0.1, 0.03, 0.012, 0, y + 0.05, 0.19);
    else k.cool.box(RUNE, 0.07, 0.07, 0.012, 0, y + 0.03, 0.19, 0, 0, Math.PI / 4);
  }
  if (whole) {
    s.cyl(BRASS, 0.19, 0.19, 0.04, 0, tall - 0.02, 0, 10);
    // Its capital came away long ago and never fell: it hangs a hand above the shaft.
    k.floats.push({ at: s.at(0, tall + 0.3, 0), kind: "capital", turn: hash(seed, 7, 5) * 6, scale: 1 });
  } else {
    // Snapped: a jagged top, the next drum hanging over it where it broke, and rubble at its foot.
    s.blob(STONE_DARK, 0.17, 0.09, 0.15, 0.02, tall + 0.02, 0, hash(seed, 8, 6) * 6, 0.3);
    k.floats.push({ at: s.at(0.05, tall + 0.42, -0.03), kind: "drum", turn: hash(seed, 9, 5) * 6, scale: 1 });
    s.blob(OLD, 0.16, 0.11, 0.13, 0.42, 0.08, 0.2, 1.2);
    s.blob(STONE_DARK, 0.1, 0.07, 0.09, 0.3, 0.05, 0.42, 2.2);
  }
}

/** Every kind of piece, drawn about its own foot with its front toward +z. */
const DRAW: Record<DecorKind, (k: Kit, d: HarborDecor) => void> = {
  lamp(k) {
    // A lamp post: a timber mast stepped in a stone foot, a brass band, an iron arm with a ship's lantern slung from it, and a turn of rope at its foot.
    const s = k.solid;
    s.box(STONE_DARK, 0.3, 0.42, 0.3, 0, -0.26, 0);
    s.box(STONE, 0.24, 0.07, 0.24, 0, 0.16, 0);
    s.cyl(TIMBER_DARK, 0.04, 0.055, 1.8, 0, 0.2, 0, 6);
    s.cyl(BRASS, 0.06, 0.06, 0.05, 0, 0.62, 0, 6);
    s.cyl(BRASS, 0.05, 0.05, 0.04, 0, 1.94, 0, 6);
    s.cone(IRON, 0.05, 0.1, 0, 1.98, 0, 5);
    s.box(IRON, 0.03, 0.03, 0.36, 0, 1.82, 0.16);
    s.box(IRON, 0.02, 0.02, 0.3, 0, 1.7, 0.1, 0, -0.75);
    s.box(IRON, 0.014, 0.1, 0.014, 0, 1.72, 0.31);
    lantern(k, 0, 1.6, 0.31, 1.25);
    coil(k, 0.02, 0.2, 0, 0.1);
  },
  pillar(k, d) {
    courtPillar(k, 2.5, true, d.at.q * 7 + d.at.r);
  },
  pillar_broken(k, d) {
    courtPillar(k, 1.25 + hash(d.at.q, d.at.r, 3) * 0.4, false, d.at.q * 7 + d.at.r);
  },
  stump(k, d) {
    // All that is left of one: its foot, a drum's worth of shaft, and what fell.
    const s = k.solid;
    const n = (i: number) => hash(d.at.q + i, d.at.r, 8);
    s.box(STONE_DARK, 0.56, 0.42, 0.56, 0, -0.3, 0);
    s.box(OLD, 0.48, 0.1, 0.48, 0, 0.12, 0, 0.1);
    s.cyl(STONE, 0.17, 0.19, 0.3, 0, 0.22, 0, 10);
    s.blob(STONE_DARK, 0.15, 0.07, 0.13, 0.02, 0.53, 0, n(1) * 6, 0.25);
    s.cyl(OLD, 0.17, 0.17, 0.36, 0.5, 0.0, 0.14, 10, 0.5, Math.PI / 2 - 0.1);
    s.blob(STONE, 0.12, 0.08, 0.1, -0.4, 0.06, 0.3, 2);
    k.cool.box(RUNE, 0.07, 0.07, 0.012, 0, 0.36, 0.185, 0, 0, Math.PI / 4);
  },
  brazier(k) {
    // A fire basket on a stone pedestal: iron straps, coals, and a real flame the renderer flickers.
    const s = k.solid;
    s.box(STONE_DARK, 0.52, 0.5, 0.52, 0, -0.3, 0);
    s.box(STONE, 0.44, 0.16, 0.44, 0, 0.2, 0);
    s.cyl(STONE_PALE, 0.13, 0.17, 0.5, 0, 0.36, 0, 8);
    s.cyl(IRON, 0.3, 0.16, 0.2, 0, 0.86, 0, 8);
    s.cyl(IRON, 0.32, 0.32, 0.035, 0, 1.05, 0, 8);
    for (let i = 0; i < 4; i++) s.box(IRON, 0.03, 0.26, 0.03, Math.cos((i * Math.PI) / 2 + 0.4) * 0.27, 0.84, Math.sin((i * Math.PI) / 2 + 0.4) * 0.27);
    k.warm.cyl(FIRE, 0.24, 0.2, 0.05, 0, 1.03, 0, 8);
    k.fires.push({ at: s.at(0, 1.06, 0), size: 0.34 });
    k.glows.push({ pos: s.at(0, 1.3, 0), size: 1.5, light: "fire" });
  },
  planter(k, d) {
    // Half a cask of earth with something in flower.
    const s = k.solid;
    const n = (i: number) => hash(d.at.q * 3 + (d.corner ?? 0), d.at.r, 20 + i);
    s.cyl(TIMBER, 0.24, 0.2, 0.26, 0, 0, 0, 10);
    s.cyl(IRON, 0.245, 0.235, 0.03, 0, 0.17, 0, 10);
    s.cyl("#3a2c20", 0.21, 0.21, 0.03, 0, 0.25, 0, 10);
    const bloom = ["#e8c14a", "#d6583f", "#e9e3cf", "#b06fd0", "#e58a9c"];
    for (let i = 0; i < 9; i++) {
      const a = n(i) * 6.28, r = 0.03 + n(i + 20) * 0.15;
      const h = 0.12 + n(i + 40) * 0.16;
      s.cone("#4f8a3f", 0.06, h, Math.cos(a) * r, 0.27, Math.sin(a) * r, 4, a);
      if (i % 3 !== 2) s.blob(bloom[Math.floor(n(i + 60) * 4.99)], 0.04, 0.035, 0.04, Math.cos(a) * r, 0.29 + h, Math.sin(a) * r, a);
    }
  },
  bench(k) {
    // A plank bench with a back, on trestle ends: somewhere to sit and watch the square.
    const s = k.solid;
    s.push(0, 0, -0.12);
    for (const x of [-0.36, 0.36]) {
      s.box(TIMBER_DARK, 0.06, 0.26, 0.3, x, 0, 0);
      s.box(TIMBER_DARK, 0.05, 0.36, 0.05, x, 0.26, -0.13, 0, -0.12);
    }
    s.box(TIMBER_PALE, 0.9, 0.045, 0.14, 0, 0.26, 0.07);
    s.box(TIMBER, 0.9, 0.045, 0.14, 0, 0.26, -0.07);
    s.box(TIMBER_PALE, 0.9, 0.11, 0.035, 0, 0.44, -0.16, 0, -0.12);
    s.pop();
  },
  crates(k, d) {
    const n = hash(d.at.q, d.at.r, 30);
    crate(k, -0.16, 0, 0.02, 1, 0.2 + n);
    crate(k, 0.24, 0, -0.06, 0.82, -0.3 + n, TIMBER);
    crate(k, -0.12, 0.36, 0.0, 0.74, 0.7 + n);
    // A sack slumped against them.
    k.solid.blob("#b9a57c", 0.15, 0.12, 0.13, 0.18, 0.1, 0.3, n * 6);
    k.solid.blob("#a8946c", 0.06, 0.05, 0.06, 0.18, 0.23, 0.3);
  },
  barrels(k) {
    barrel(k, -0.14, 0, 0.04);
    barrel(k, 0.2, 0, -0.08, 0.9);
    barrel(k, 0.06, 0, 0.3, 0.82, true);
  },
  nets(k) {
    // A net hung to dry between two posts, its floats along the top, and a lobster pot under it.
    const s = k.solid;
    for (const x of [-0.5, 0.5]) s.cyl(TIMBER_DARK, 0.03, 0.04, 1.1, x, -0.1, 0, 5);
    s.box(TIMBER, 1.06, 0.04, 0.04, 0, 0.94, 0);
    for (let i = 0; i < 9; i++) s.box("#6f6a55", 0.012, 0.74, 0.012, -0.44 + i * 0.11, 0.2, 0.02 * Math.sin(i), 0, 0, 0.12);
    for (let i = 0; i < 5; i++) s.box("#6f6a55", 0.96, 0.012, 0.012, 0, 0.26 + i * 0.15, 0.012);
    for (let i = 0; i < 5; i++) s.blob(i % 2 ? "#c0563a" : "#d9c9a0", 0.04, 0.04, 0.04, -0.4 + i * 0.2, 0.91, 0.04);
    s.cyl(TIMBER_PALE, 0.14, 0.14, 0.3, 0.2, 0.02, 0.3, 6, 0.4, Math.PI / 2);
    coil(k, -0.3, 0, 0.28, 0.12);
  },
  bollard(k) {
    // A mooring post at the quay's edge: iron, capped, worn bright where the lines run, a hawser made fast round it.
    const s = k.solid;
    s.push(0, 0, -0.14);
    s.box(STONE_PALE, 0.3, 0.3, 0.3, 0, -0.22, 0);
    s.cyl(IRON, 0.07, 0.09, 0.3, 0, 0.08, 0, 8);
    s.cyl(IRON, 0.11, 0.09, 0.06, 0, 0.38, 0, 8);
    s.cyl(BRASS, 0.076, 0.076, 0.03, 0, 0.26, 0, 8);
    for (let i = 0; i < 2; i++) s.shape(new THREE.TorusGeometry(0.1, 0.02, 5, 12), ROPE, 0, 0.14 + i * 0.04, 0, 0, Math.PI / 2);
    s.pop();
  },
  banner(k) {
    // A tall pole with a long banner down it: oxblood, edged and barred in gold, a brass finial on top.
    const s = k.solid;
    s.box(STONE_DARK, 0.26, 0.4, 0.26, 0, -0.26, 0);
    s.cyl(TIMBER_DARK, 0.03, 0.045, 2.9, 0, 0.14, 0, 6);
    s.cone(BRASS, 0.06, 0.16, 0, 3.04, 0, 4);
    s.box(TIMBER_DARK, 0.03, 0.03, 0.5, 0, 2.86, 0.2);
    s.box("#7c2a26", 0.02, 1.5, 0.4, 0, 1.36, 0.22);
    s.box("#d9b45a", 0.024, 0.06, 0.4, 0, 2.7, 0.22);
    s.box("#d9b45a", 0.024, 0.05, 0.4, 0, 1.6, 0.22);
    s.shape(new THREE.ConeGeometry(0.2, 0.26, 4), "#7c2a26", 0, 1.24, 0.22, 0, Math.PI, 0, 0.06, 1, 1);
    s.box("#d9b45a", 0.026, 0.2, 0.2, 0, 2.12, 0.22, 0, Math.PI / 4);
  },
  milestone(k) {
    const s = k.solid;
    s.box(STONE_DARK, 0.3, 0.3, 0.2, 0, -0.2, 0);
    s.box(STONE_PALE, 0.26, 0.4, 0.14, 0, 0.1, 0, 0, -0.06);
    s.cyl(STONE_PALE, 0.13, 0.13, 0.14, 0, 0.44, -0.024, 10, 0, Math.PI / 2);
    s.box(STONE_DARK, 0.14, 0.03, 0.01, 0, 0.36, 0.062, 0, -0.06);
    s.box(STONE_DARK, 0.1, 0.03, 0.01, 0, 0.28, 0.066, 0, -0.06);
  },
  mast(k) {
    // The harbour's signal mast, at the foot of the middle pier: a tall spar stepped in a stone bed and stayed
    // with rope, a yard across it with two signal flags flying from the halyards, a brass ball at the truck.
    const s = k.solid;
    s.push(0, 0, -0.2);
    s.cyl(STONE_DARK, 0.2, 0.24, 0.5, 0, -0.3, 0, 8);
    s.cyl(TIMBER, 0.045, 0.07, 3.6, 0, 0.2, 0, 6);
    s.cyl(BRASS, 0.075, 0.075, 0.05, 0, 0.6, 0, 6);
    s.blob(BRASS, 0.07, 0.07, 0.07, 0, 3.86, 0);
    s.cyl(TIMBER_DARK, 0.025, 0.025, 1.5, 0, 2.9, 0, 5, 0, 0, Math.PI / 2);
    for (const x of [-1, 1]) s.box(ROPE, 0.014, 2.86, 0.014, x * 0.37, 0.2, 0, 0, 0, x * 0.258);
    s.box("#c0392b", 0.34, 0.24, 0.016, -0.5, 2.56, 0);
    s.box("#e8dcc0", 0.34, 0.08, 0.018, -0.5, 2.64, 0);
    s.box("#f1c232", 0.3, 0.22, 0.016, 0.5, 2.6, 0);
    s.box("#2f5d8a", 0.12, 0.22, 0.018, 0.5, 2.6, 0);
    s.box(ROPE, 0.012, 0.36, 0.012, -0.5, 2.56, 0);
    s.box(ROPE, 0.012, 0.32, 0.012, 0.5, 2.6, 0);
    s.pop();
  },
  railpost(k) {
    // A post of the bridge's rail: a pile driven down beside the planking, capped in brass, with the hand rope
    // made fast round its head and sagging away to the posts either side.
    const s = k.solid;
    s.cyl(TIMBER_DARK, 0.055, 0.07, 1.7, 0, -0.85, 0, 6);
    s.cyl(BRASS, 0.062, 0.062, 0.04, 0, 0.8, 0, 6);
    s.cone(TIMBER, 0.06, 0.07, 0, 0.85, 0, 6);
    for (let i = 0; i < 2; i++) s.shape(new THREE.TorusGeometry(0.075, 0.016, 5, 10), ROPE, 0, 0.66 + i * 0.035, 0, 0, Math.PI / 2);
    // (The planking's edge runs from this point down to the next either side: a hex's side long, a sixth of a turn off square.)
    for (const side of [-1, 1]) {
      s.box(ROPE, 1.0, 0.022, 0.022, side * 0.433, 0.56, 0.25, (-side * Math.PI) / 6);
      s.box(TIMBER_DARK, 1.0, 0.045, 0.035, side * 0.433, 0.12, 0.25, (-side * Math.PI) / 6);
    }
    for (const side of [-1, 1]) s.cyl(TIMBER_DARK, 0.04, 0.05, 1.5, side * 0.866, -0.85, 0.5, 6);
  },
  garden(k, d) {
    // A hut's own patch of garden: a bed of turned earth with rows of greens and a few flowers, a short run of
    // pickets along two sides of it, and something left out (a pail, a spade stuck in the ground).
    const s = k.solid;
    const n = (i: number) => hash(d.at.q * 5 + i, d.at.r * 3, 90);
    s.box("#4a3a28", 0.62, 0.05, 0.44, 0, 0, 0);
    const bloom = ["#e8c14a", "#d6583f", "#e9e3cf", "#b06fd0", "#e58a9c"];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 5; i++) {
        const x = -0.24 + i * 0.12, z = -0.14 + row * 0.14;
        const h = 0.07 + n(row * 5 + i) * 0.09;
        s.cone(row === 1 ? "#5f9a45" : "#4f8a3f", 0.045, h, x, 0.05, z, 4, i);
        if (row === 2 && n(40 + i) < 0.6) s.blob(bloom[Math.floor(n(50 + i) * 4.99)], 0.03, 0.03, 0.03, x, 0.07 + h, z);
      }
    }
    for (let i = 0; i < 6; i++) {
      s.box(i % 2 ? TIMBER_PALE : "#a98a5e", 0.05, 0.3 + n(60 + i) * 0.04, 0.02, -0.3 + i * 0.12, 0, -0.26);
      s.cone(TIMBER_PALE, 0.03, 0.04, -0.3 + i * 0.12, 0.3, -0.26, 4, Math.PI / 4);
    }
    s.box(TIMBER, 0.68, 0.025, 0.02, 0, 0.17, -0.275);
    for (let i = 0; i < 4; i++) s.box(i % 2 ? "#a98a5e" : TIMBER_PALE, 0.02, 0.3, 0.05, -0.35, 0, -0.2 + i * 0.12);
    s.box(TIMBER, 0.02, 0.025, 0.44, -0.365, 0.17, -0.02);
    if (n(70) < 0.5) {
      s.cyl(TIMBER_PALE, 0.07, 0.055, 0.12, 0.4, 0, 0.14, 8);
      s.cyl(IRON, 0.072, 0.07, 0.02, 0.4, 0.08, 0.14, 8);
    } else {
      s.box(TIMBER_DARK, 0.02, 0.42, 0.02, 0.4, 0.04, 0.1, 0, 0.12);
      s.box(IRON, 0.08, 0.1, 0.012, 0.4, 0, 0.09, 0, 0.12);
    }
  },
  rack(k) {
    // A rack of split fish drying in the wind.
    const s = k.solid;
    for (const x of [-0.5, 0.5]) {
      s.cyl(TIMBER, 0.025, 0.03, 1.0, x, -0.1, -0.16, 5, 0, 0.22);
      s.cyl(TIMBER, 0.025, 0.03, 1.0, x, -0.1, 0.16, 5, 0, -0.22);
    }
    s.box(TIMBER_DARK, 1.14, 0.03, 0.03, 0, 0.84, 0);
    for (let i = 0; i < 7; i++) {
      s.box(i % 3 ? "#c9b48a" : "#b98f6a", 0.07, 0.24, 0.016, -0.42 + i * 0.14, 0.58, 0, 0.2 * Math.sin(i * 2));
      s.cone("#8a8f98", 0.035, 0.07, -0.42 + i * 0.14, 0.51, 0, 3, i);
    }
  },
  cairn(k, d) {
    // Stones heaped by those who went up the lane before, the top one marked.
    const s = k.solid;
    const n = (i: number) => hash(d.at.q + (d.corner ?? 0), d.at.r, 40 + i);
    let y = 0;
    for (let i = 0; i < 5; i++) {
      const r = 0.26 - i * 0.04;
      s.blob(i % 2 ? STONE : OLD, r, r * 0.55, r * 0.9, (n(i) - 0.5) * 0.06, y + r * 0.4, (n(i + 9) - 0.5) * 0.06, n(i + 5) * 6);
      y += r * 0.72;
    }
    k.cool.box(GHOST, 0.05, 0.05, 0.012, 0, y - 0.05, 0.08, 0, 0, Math.PI / 4);
  },
  well(k) {
    // The town well: a round wall of dressed stone, dark water in it, and over it a little shingled roof on two
    // posts with the windlass between them, its rope down to a bucket on the rim. A lantern hangs under the eaves.
    const s = k.solid;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      for (let c = 0; c < 3; c++) {
        const aa = a + (c % 2) * 0.26;
        s.box(c === 2 ? STONE_PALE : i % 2 ? STONE : OLD, 0.31, c === 2 ? 0.1 : 0.2, c === 2 ? 0.26 : 0.2, Math.cos(aa) * 0.58, c * 0.2, Math.sin(aa) * 0.58, -aa + Math.PI / 2);
      }
    }
    s.cyl("#1d3442", 0.5, 0.5, 0.04, 0, 0.3, 0, 12);
    s.cyl(STONE_DARK, 0.78, 0.82, 0.06, 0, 0, 0, 12);
    for (const x of [-0.6, 0.6]) {
      s.box(TIMBER_DARK, 0.1, 1.5, 0.1, x, 0.06, 0);
      s.box(TIMBER, 0.07, 0.4, 0.07, x * 0.82, 1.2, 0, 0, 0, x > 0 ? 0.7 : -0.7);
    }
    s.cyl(TIMBER, 0.07, 0.07, 1.1, 0, 1.12, 0, 8, 0, 0, Math.PI / 2);
    s.cyl(ROPE, 0.085, 0.085, 0.34, 0.06, 1.1, 0, 8, 0, 0, Math.PI / 2);
    s.box(IRON, 0.03, 0.26, 0.03, 0.72, 1.02, 0);
    s.box(IRON, 0.16, 0.03, 0.03, 0.78, 1.0, 0);
    s.box(ROPE, 0.02, 0.5, 0.02, 0.12, 0.68, 0.3, 0, 0.56);
    // The roof: two pitches of shingles and a ridge.
    for (const side of [1, -1]) {
      for (let course = 0; course < 3; course++) s.box(course % 2 ? "#7a4a36" : "#8a5540", 1.56 - course * 0.03, 0.04, 0.24, 0, 1.92 - course * 0.13, side * (0.1 + course * 0.2), 0, side * 0.6);
    }
    s.box("#5c3626", 1.6, 0.05, 0.08, 0, 1.97, 0);
    s.box(TIMBER_DARK, 1.36, 0.07, 0.07, 0, 1.52, 0);
    // The bucket on the rim, banded.
    s.cyl(TIMBER_PALE, 0.11, 0.09, 0.18, 0.18, 0.5, 0.56, 8);
    s.cyl(IRON, 0.112, 0.105, 0.025, 0.18, 0.62, 0.56, 8);
    lantern(k, -0.3, 1.4, 0.1, 1.1);
    s.box(IRON, 0.014, 0.1, 0.014, -0.3, 1.5, 0.1);
  },
  statue(k, d) {
    // A keeper of the caverns: a cloaked, hooded figure twice a hero's height on a stepped plinth, hands closed
    // about the haft of a great lantern-staff grounded before it. Nobody remembers who cut them. The lantern still burns.
    const s = k.solid;
    const side = hash(d.at.q, d.at.r, 50) > 0.5 ? 1 : -1;
    s.box(STONE_DARK, 1.3, 0.4, 1.3, 0, -0.2, 0);
    s.box(OLD, 1.16, 0.22, 1.16, 0, 0.2, 0);
    s.box(STONE, 0.98, 0.5, 0.98, 0, 0.42, 0);
    s.box(OLD, 1.06, 0.08, 1.06, 0, 0.92, 0);
    k.cool.box(GHOST, 0.16, 0.16, 0.014, 0, 0.6, 0.495, 0, 0, Math.PI / 4);
    // The robe, in falling folds; the shoulders under the cloak; the hood, and the dark where a face would be.
    s.cyl(OLD, 0.3, 0.46, 1.5, 0, 1.0, 0, 8);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.2;
      s.box(STONE, 0.1, 1.4, 0.08, Math.cos(a) * 0.37, 1.0, Math.sin(a) * 0.37, -a, 0, 0);
    }
    s.cyl(STONE, 0.36, 0.32, 0.5, 0, 2.5, 0, 8);
    s.blob(STONE, 0.5, 0.2, 0.34, 0, 2.94, -0.02);
    s.cyl(OLD, 0.21, 0.27, 0.3, 0, 3.0, 0.02, 8);
    s.blob(STONE_PALE, 0.27, 0.3, 0.29, 0, 3.36, -0.02);
    s.cone(STONE_PALE, 0.2, 0.3, 0, 3.52, -0.1, 6);
    s.blob("#17181d", 0.17, 0.2, 0.1, 0, 3.32, 0.2);
    for (const x of [-0.06, 0.06]) k.cool.box(GHOST, 0.035, 0.02, 0.012, x, 3.34, 0.3);
    // Arms forward to the staff, and the staff itself: taller than the figure, a lantern caged at its head.
    for (const x of [-1, 1]) {
      s.box(OLD, 0.17, 0.62, 0.17, x * 0.34, 2.3, 0.2, 0, -0.9, x * 0.25);
      s.blob(STONE_PALE, 0.1, 0.1, 0.1, x * 0.12 + side * 0.04, 2.36, 0.5);
    }
    s.cyl(STONE_DARK, 0.055, 0.07, 3.3, side * 0.04, 1.0, 0.52, 6);
    s.box(STONE_DARK, 0.3, 0.06, 0.3, side * 0.04, 4.28, 0.52);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) s.box(IRON, 0.035, 0.36, 0.035, side * 0.04 + dx * 0.12, 4.32, 0.52 + dz * 0.12);
    k.warm.box(FIRE, 0.19, 0.3, 0.19, side * 0.04, 4.35, 0.52);
    s.cone(STONE_DARK, 0.24, 0.22, side * 0.04, 4.68, 0.52, 4, Math.PI / 4);
    k.glows.push({ pos: s.at(side * 0.04, 4.5, 0.52), size: 1.5, light: "fire" });
  },
  crane(k) {
    // The quay's crane: a great timber post stepped in a stone bed, a jib braced out over the water with a block at
    // its head, the fall running down to a hook with a sling of cargo on it, and the treadwheel that works it.
    const s = k.solid;
    s.cyl(STONE_DARK, 0.9, 0.94, 0.14, 0, 0, 0, 6, Math.PI / 6);
    s.box(TIMBER_DARK, 1.2, 0.14, 0.2, 0, 0.14, 0, Math.PI / 4);
    s.box(TIMBER_DARK, 1.2, 0.14, 0.2, 0, 0.14, 0, -Math.PI / 4);
    s.cyl(TIMBER, 0.11, 0.13, 3.0, 0, 0.2, -0.1, 8);
    for (const a of [0.8, -0.8, Math.PI]) s.box(TIMBER_DARK, 0.08, 1.1, 0.08, Math.sin(a) * 0.36, 0.22, -0.1 + Math.cos(a) * 0.36, a, -0.62);
    // The jib, rising out over the harbour, and its stay back to the masthead.
    s.box(TIMBER, 0.13, 0.13, 2.6, 0, 2.5, 0.92, 0, -0.52);
    s.box(TIMBER_DARK, 0.07, 0.07, 1.5, 0, 1.76, 0.5, 0, -1.02);
    s.box(IRON, 0.16, 0.05, 0.16, 0, 3.2, -0.1);
    s.cone(BRASS, 0.07, 0.16, 0, 3.25, -0.1, 4);
    s.cyl(IRON, 0.1, 0.1, 0.07, 0, 3.12, 2.02, 8, 0, 0, Math.PI / 2);
    s.box(ROPE, 0.022, 1.5, 0.022, 0, 1.66, 2.04);
    s.box(ROPE, 0.022, 0.022, 2.3, 0, 2.86, 0.96, 0, -0.55);
    s.box(IRON, 0.05, 0.14, 0.05, 0, 1.54, 2.04);
    // A sling of cargo on the hook: a crate and a cask, roped together.
    s.push(0, 1.08, 2.04, 0.5);
    s.box(TIMBER_PALE, 0.4, 0.34, 0.4, 0, 0, 0);
    s.box(TIMBER_DARK, 0.44, 0.04, 0.44, 0, 0.3, 0);
    for (const x of [-0.16, 0.16]) s.box(ROPE, 0.02, 0.5, 0.02, x, 0.02, 0, 0, 0, x > 0 ? 0.3 : -0.3);
    s.pop();
    // The treadwheel, on its axle beside the post.
    for (const x of [-0.16, 0.16]) s.shape(new THREE.TorusGeometry(0.6, 0.045, 5, 16), TIMBER_PALE, x - 0.62, 0.86, -0.2, Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      s.box(TIMBER, 0.34, 0.03, 0.12, -0.62, 0.845 + Math.sin(a) * 0.6, -0.2 + Math.cos(a) * 0.6, 0, a);
    }
    for (let i = 0; i < 3; i++) s.box(TIMBER_DARK, 0.05, 1.16, 0.05, -0.62, 0.28, -0.2, 0, (i / 3) * Math.PI);
    s.cyl(IRON, 0.05, 0.05, 0.8, -0.4, 0.82, -0.2, 6, 0, 0, Math.PI / 2);
    for (const x of [-0.86, -0.38]) s.box(TIMBER_DARK, 0.07, 0.86, 0.07, x, 0.1, -0.2);
    lantern(k, 0.26, 1.5, -0.1, 1.2);
    s.box(IRON, 0.3, 0.025, 0.025, 0.13, 1.66, -0.1);
    barrel(k, 0.5, 0.14, -0.5, 0.9);
    coil(k, 0.5, 0.14, 0.2, 0.14);
  },
};

let courtArt: THREE.CanvasTexture | null = null;
/**
 * The court's paving, seen from straight above: rings of worn flags about the gate, brass let into the stone in
 * two circles with a compass of eight points between them, and marks cut round the rim. Made once and shared.
 */
function courtTexture(): THREE.CanvasTexture {
  if (courtArt) return courtArt;
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  ctx.fillStyle = "#3b3e46";
  ctx.fillRect(0, 0, size, size);
  // Rings of flags, each ring's joints offset from the last, no two flags quite one shade.
  const rings = [0.0, 0.2, 0.36, 0.5, 0.63, 0.76, 0.88, 1.0];
  for (let k = 0; k < rings.length - 1; k++) {
    const [r0, r1] = [rings[k] * c, rings[k + 1] * c];
    const count = k === 0 ? 1 : Math.round(6 + k * 5);
    for (let i = 0; i < count; i++) {
      const a0 = ((i + (k % 2) * 0.5) / count) * Math.PI * 2;
      const a1 = a0 + (Math.PI * 2) / count;
      const n = hash(k, i, 60);
      const v = 104 + Math.floor(n * 40) + (k === rings.length - 2 ? -14 : 0);
      ctx.fillStyle = `rgb(${v - 6}, ${v}, ${v + 10})`;
      ctx.beginPath();
      ctx.arc(c, c, r1 - 2.5, a0 + 2.5 / r1, a1 - 2.5 / r1);
      ctx.arc(c, c, r0 + 2.5, a1 - 2.5 / Math.max(r0, 12), a0 + 2.5 / Math.max(r0, 12), true);
      ctx.closePath();
      ctx.fill();
      // Wear: a paler patch, a chip, a crack now and then.
      ctx.fillStyle = `rgba(255,255,255,${0.04 + hash(k, i, 61) * 0.07})`;
      ctx.beginPath();
      ctx.arc(c + Math.cos((a0 + a1) / 2) * ((r0 + r1) / 2), c + Math.sin((a0 + a1) / 2) * ((r0 + r1) / 2), (r1 - r0) * (0.2 + hash(k, i, 62) * 0.2), 0, Math.PI * 2);
      ctx.fill();
      if (hash(k, i, 63) < 0.22) {
        ctx.strokeStyle = "rgba(30,32,38,0.6)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const am = a0 + (a1 - a0) * (0.3 + hash(k, i, 64) * 0.4);
        ctx.moveTo(c + Math.cos(am) * (r0 + 6), c + Math.sin(am) * (r0 + 6));
        ctx.lineTo(c + Math.cos(am + 0.03) * ((r0 + r1) / 2), c + Math.sin(am + 0.03) * ((r0 + r1) / 2));
        ctx.lineTo(c + Math.cos(am - 0.01) * (r1 - 6), c + Math.sin(am - 0.01) * (r1 - 6));
        ctx.stroke();
      }
    }
  }
  // The brass: two circles, and the compass between them.
  const brass = (w: number) => {
    ctx.strokeStyle = "#c79a3e";
    ctx.lineWidth = w;
  };
  for (const [r, w] of [[0.44, 7], [0.905, 9], [0.47, 2], [0.875, 2]]) {
    brass(w);
    ctx.beginPath();
    ctx.arc(c, c, r * c, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const long = i % 2 === 0;
    const [r0, r1, half] = [0.47 * c, (long ? 0.87 : 0.72) * c, long ? 0.075 : 0.05];
    const tip = [c + Math.cos(a) * r1, c + Math.sin(a) * r1];
    for (const s of [-1, 1]) {
      ctx.fillStyle = s < 0 ? "#d9b45a" : "#8f6c26";
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(c + Math.cos(a + s * half) * r0, c + Math.sin(a + s * half) * r0);
      ctx.lineTo(c + Math.cos(a) * (r0 + (r1 - r0) * 0.12), c + Math.sin(a) * (r0 + (r1 - r0) * 0.12));
      ctx.closePath();
      ctx.fill();
    }
  }
  // Marks cut round the rim, between the outer circle and the kerb.
  ctx.fillStyle = "rgba(34,36,44,0.75)";
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ctx.save();
    ctx.translate(c + Math.cos(a) * 0.945 * c, c + Math.sin(a) * 0.945 * c);
    ctx.rotate(a + Math.PI / 2);
    const kind = Math.floor(hash(i, 2, 65) * 3.99);
    if (kind === 0) ctx.fillRect(-2, -9, 4, 18);
    else if (kind === 1) {
      ctx.fillRect(-7, -2, 14, 4);
      ctx.fillRect(-2, -9, 4, 9);
    } else if (kind === 2) {
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-5, -5, 10, 10);
    } else {
      ctx.fillRect(-7, -8, 4, 16);
      ctx.fillRect(3, -8, 4, 16);
    }
    ctx.restore();
  }
  courtArt = new THREE.CanvasTexture(canvas);
  courtArt.colorSpace = THREE.SRGBColorSpace;
  courtArt.anisotropy = 8;
  return courtArt;
}

/** How wide the waygate's court is paved, from its middle: out to where the far corners of the hexes round the gate are. */
export const COURT_RADIUS = 2.52;

export interface TownDressing {
  group: THREE.Group;
  /** Its lamps, lanterns and fires, for the ambience to halo and light after dark. */
  glows: BuildingGlow[];
  /** Where anything of it stands, so nothing wild (an old oak) is grown through it. */
  spots: { x: number; z: number }[];
  update(clock: number, dark: number): void;
  dispose(): void;
}

/** Where a piece of the town's dressing stands: the middle of its hex's top, or one of its corners. */
function spotOf(d: HarborDecor, place: (p: HexPos) => Place): Place & { turn: number } {
  const p = place(d.at);
  if (d.corner === undefined) return { ...p, turn: -((d.turn ?? 0) * Math.PI) / 3 };
  const a = (d.corner * Math.PI) / 3;
  // On a corner it faces the hex it is named from, unless it is turned.
  return { x: p.x + Math.sin(a), y: p.y, z: p.z - Math.cos(a), turn: -((d.corner + (d.turn ?? 0)) * Math.PI) / 3 };
}

/**
 * The Harbor's dressing, built once from the map. `place` gives the middle of a hex's top in the world.
 * Call `update` every frame and `dispose` when the map is redrawn.
 */
export function buildTownDressing(map: WorldMap, place: (p: HexPos) => Place): TownDressing {
  const group = new THREE.Group();
  const kit: Kit = { solid: new Paint(), warm: new Paint(), cool: new Paint(), glows: [], fires: [], floats: [] };
  const spots: { x: number; z: number }[] = [];
  const key = (p: HexPos) => `${p.q},${p.r}`;
  const next = (p: HexPos, side: number): HexPos => ({ q: p.q + HARBOR_SIDES[side].q, r: p.r + HARBOR_SIDES[side].r });
  /** The two ends of a hex's side, about its middle: side 0 is the top right one, then clockwise (as HARBOR_SIDES). */
  const sideEnds = (side: number) => [side, side + 1].map((c) => ({ x: Math.sin((c * Math.PI) / 3), z: -Math.cos((c * Math.PI) / 3) }));
  const open = (p: HexPos) => {
    const t = tileAt(map, p);
    return !!t && !t.built && !t.blocker && t.biome !== "water" && t.biome !== "rampart";
  };

  // ---- every piece the map lists ----
  for (const d of HARBOR_DECOR) {
    const at = spotOf(d, place);
    spots.push({ x: at.x, z: at.z });
    for (const paint of [kit.solid, kit.warm, kit.cool]) paint.push(at.x, at.y, at.z, at.turn);
    DRAW[d.kind](kit, d);
    for (const paint of [kit.solid, kit.warm, kit.cool]) paint.pop();
  }

  // ---- the waygate's court: one round of paving over the seven hexes, and a kerb of dressed stone round it ----
  const gateAt = place(HARBOR_GATE);
  const courtY = Math.max(gateAt.y, ...HARBOR_COURT.map((p) => place(p).y)) + 0.022;
  const paving = new THREE.Mesh(new THREE.CircleGeometry(COURT_RADIUS, 72).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: courtTexture() }));
  paving.position.set(gateAt.x, courtY, gateAt.z);
  paving.receiveShadow = true;
  group.add(paving);
  {
    const s = kit.solid;
    s.push(gateAt.x, courtY, gateAt.z);
    const stones = 44;
    for (let i = 0; i < stones; i++) {
      const a = ((i + 0.5) / stones) * Math.PI * 2;
      s.box(i % 2 ? STONE_PALE : STONE, (Math.PI * 2 * COURT_RADIUS) / stones - 0.015, 0.11, 0.17, Math.cos(a) * (COURT_RADIUS + 0.05), -0.075, Math.sin(a) * (COURT_RADIUS + 0.05), -a + Math.PI / 2);
    }
    s.pop();
  }

  // ---- the quay's kerb: dressed stone along every side of the paving that looks on the water ----
  const forecourt = new Set([...HARBOR_FORECOURT, ...HARBOR_CAVE_STEPS].map(key));
  for (const t of map.tiles) {
    if (t.biome !== "cobble") continue;
    const p = place(t);
    for (let side = 0; side < 6; side++) {
      const other = tileAt(map, next(t, side));
      const [a, b] = sideEnds(side);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const along = Math.atan2(-(b.z - a.z), b.x - a.x);
      const s = kit.solid;
      if (other?.biome === "water") {
        // A coping stone and a half along the side, proud of the paving, and the wall under it going down into the water.
        s.push(p.x + mid.x * 0.97, p.y, p.z + mid.z * 0.97, along);
        s.box(STONE_PALE, 0.52, 0.1, 0.2, -0.25, -0.02, 0);
        s.box(STONE, 0.46, 0.1, 0.2, 0.25, -0.02, 0);
        s.box(STONE_DARK, 1.0, 0.5, 0.14, 0, -0.5, 0.02);
        // And a timber fender pile against the wall, iron-banded, where a hull would lie.
        s.box(TIMBER_DARK, 0.11, 1.3, 0.1, 0.02, -1.24, -0.14);
        s.box(IRON, 0.125, 0.03, 0.115, 0.02, -0.1, -0.14);
        s.pop();
      } else if (forecourt.has(key(t)) && other && !forecourt.has(key(other))) {
        const drop = p.y - place(other).y;
        if (!open(other) || !open(t)) {
          // Where nobody walks (the rock behind, the grass beyond a keeper's niche): a low wall with a coping, a pier at each end.
          if (other.biome === "hills" || key(other) === key(HARBOR_CAVE)) continue;
          s.push(p.x + mid.x * 0.94, p.y, p.z + mid.z * 0.94, along);
          s.box(STONE_DARK, 0.98, 0.4 + Math.max(0, drop), 0.2, 0, -Math.max(0, drop), 0);
          s.box(STONE_PALE, 1.02, 0.07, 0.26, 0, 0.4, 0);
          for (const x of [-0.5, 0.5]) {
            s.box(STONE, 0.2, 0.56 + Math.max(0, drop), 0.26, x, -Math.max(0, drop), 0);
            s.cone(STONE_PALE, 0.15, 0.1, x, 0.56, 0, 4, Math.PI / 4);
          }
          s.pop();
        } else if (drop > 0.03) {
          // Where the terrace is walked onto: its edge faced with a dressed riser, a pale nosing along the top.
          s.push(p.x + mid.x * 0.985, p.y, p.z + mid.z * 0.985, along);
          s.box(STONE, 0.98, drop + 0.3, 0.08, 0, -drop - 0.3, 0);
          s.box(STONE_PALE, 1.0, 0.035, 0.13, 0, -0.03, -0.02);
          s.pop();
        }
      }
    }
  }

  // ---- the harbour works: every pier is a deck on piles, not a block ----
  // Under each hex of planking that looks on the water: a heavy pile at every corner on the water's side, driven
  // down out of sight, the ones at the outer corners standing proud of the deck as mooring posts with a turn of
  // rope on them; a beam along each open edge; cross-braces between the piles under it; a rope fender hung on
  // some; and at each pier's head a ladder down to the water. (The bridge has its own rail and piles.)
  const bridge = new Set(HARBOR_BRIDGE.map(key));
  const heads = new Set(HARBOR_PIERS.map(key));
  for (const t of map.tiles) {
    if (t.biome !== "dock" || bridge.has(key(t))) continue;
    const p = place(t);
    const wet = [0, 1, 2, 3, 4, 5].map((side) => (tileAt(map, next(t, side))?.biome ?? "water") === "water");
    const s = kit.solid;
    for (let side = 0; side < 6; side++) {
      if (!wet[side]) continue;
      const [a, b] = sideEnds(side);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      s.push(p.x + mid.x * 0.985, p.y, p.z + mid.z * 0.985, Math.atan2(-(b.z - a.z), b.x - a.x));
      s.box(TIMBER_DARK, 1.0, 0.11, 0.13, 0, -0.03, 0);
      s.box(TIMBER, 1.08, 0.06, 0.06, 0, -0.62, 0.02, 0, 0, 0.52);
      s.box(TIMBER, 1.08, 0.06, 0.06, 0, -0.62, 0.02, 0, 0, -0.52);
      s.box(TIMBER_DARK, 1.0, 0.07, 0.08, 0, -0.34, 0.02);
      if (hash(t.q, t.r, 200 + side) < 0.4) {
        // A fender: a fat bolster of old rope hung over the side on two lines.
        s.cyl("#5a4a34", 0.075, 0.075, 0.3, 0.1, -0.36, -0.12, 7);
        s.box(ROPE, 0.014, 0.2, 0.014, 0.1, -0.08, -0.1);
      }
      if (heads.has(key(t)) && side === 4) {
        // The ladder, on the pier head's west side: two stiles and five rungs, down past the water line.
        for (const x of [-0.15, 0.15]) s.box(TIMBER_PALE, 0.04, 1.3, 0.04, x, -1.05, -0.1);
        for (let i = 0; i < 5; i++) s.box(TIMBER_PALE, 0.3, 0.03, 0.035, 0, -0.9 + i * 0.22, -0.1);
        for (const x of [-0.15, 0.15]) s.cyl(IRON, 0.03, 0.03, 0.22, x, 0.08, -0.06, 5);
      }
      s.pop();
    }
    for (let corner = 0; corner < 6; corner++) {
      const [before, after] = [wet[(corner + 5) % 6], wet[corner]];
      if (!before && !after) continue;
      const a = (corner * Math.PI) / 3;
      const outer = before && after;
      const top = outer ? 0.46 : 0.1;
      s.push(p.x + Math.sin(a) * 1.0, p.y, p.z - Math.cos(a) * 1.0);
      s.cyl(TIMBER, 0.085, 0.1, 1.9 + top, 0, -1.9, 0, 7, hash(t.q + corner, t.r, 210) * 6);
      s.cyl(IRON, 0.092, 0.092, 0.035, 0, top - 0.09, 0, 7);
      s.cone(TIMBER_DARK, 0.085, 0.07, 0, top, 0, 7);
      if (outer) for (let i = 0; i < 2; i++) s.shape(new THREE.TorusGeometry(0.11, 0.022, 5, 10), ROPE, 0, 0.16 + i * 0.045, 0, 0, Math.PI / 2);
      s.pop();
    }
  }

  // ---- the boats: each afloat beside a pier, made fast to it, riding the swell ----
  const boats = HARBOR_BOATS.map((boat, i) => {
    const at = place(boat.at);
    const hull = new Paint();
    const paint = ["#2f5d8a", "#8c3b2f", "#3f6f4f"][i % 3];
    hull.shape(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), "#7d5f3c", 0, 0.16, 0, 0, 0, 0, 0.36, 0.3, 0.92);
    hull.shape(new THREE.TorusGeometry(1, 0.07, 5, 18), paint, 0, 0.17, 0, 0, Math.PI / 2, 0, 0.36, 0.92, 0.5);
    hull.shape(new THREE.CylinderGeometry(1, 1, 0.02, 14), "#4a3524", 0, 0.03, 0, 0, 0, 0, 0.28, 1, 0.8);
    for (const z of [-0.3, 0.22]) hull.box(TIMBER_PALE, 0.62, 0.035, 0.14, 0, 0.1, z);
    hull.box(TIMBER_DARK, 0.05, 0.1, 0.1, 0, 0.14, 0.86);
    // Her oars shipped along the thwarts, and a coil of line in the bow.
    for (const x of [-0.14, 0.14]) {
      hull.cyl(TIMBER_PALE, 0.016, 0.016, 1.1, x, 0.135, -0.05, 5, 0, Math.PI / 2);
      hull.box(TIMBER_PALE, 0.07, 0.014, 0.22, x, 0.14, -0.66);
    }
    for (let k = 0; k < 2; k++) hull.shape(new THREE.TorusGeometry(0.07, 0.018, 5, 10), ROPE, 0, 0.07 + k * 0.03, 0.56, 0, Math.PI / 2);
    const mesh = hull.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.castShadow = true;
    const boatGroup = new THREE.Group();
    boatGroup.add(mesh);
    boatGroup.position.set(at.x, at.y, at.z);
    boatGroup.rotation.y = -(boat.turn * Math.PI) / 3;
    group.add(boatGroup);
    // Her painter: from the bow up to the nearest planking or paving beside her.
    const berth = [0, 1, 2, 3, 4, 5].map((side) => next(boat.at, side)).find((n) => ["dock", "cobble"].includes(tileAt(map, n)?.biome ?? ""));
    if (berth) {
      const to = place(berth);
      const bow = new THREE.Vector3(0, 0.26, 0.84).applyAxisAngle(new THREE.Vector3(0, 1, 0), boatGroup.rotation.y).add(boatGroup.position);
      const post = new THREE.Vector3(at.x + (to.x - at.x) * 0.52, to.y + 0.12, at.z + (to.z - at.z) * 0.52);
      const d = post.clone().sub(bow);
      kit.solid.shape(new THREE.BoxGeometry(0.02, 0.02, d.length()), ROPE, (bow.x + post.x) / 2, (bow.y + post.y) / 2 - 0.04, (bow.z + post.z) / 2, Math.atan2(d.x, d.z), -Math.atan2(d.y, Math.hypot(d.x, d.z)));
    }
    return { group: boatGroup, y: at.y, phase: i * 2.3, turn: boatGroup.rotation.y };
  });

  // ---- fold it all up ----
  const solid = kit.solid.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  solid.castShadow = true;
  solid.receiveShadow = true;
  group.add(solid);
  const warmMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const coolMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  if (!kit.warm.empty) group.add(kit.warm.mesh(warmMat));
  if (!kit.cool.empty) group.add(kit.cool.mesh(coolMat));
  for (const f of kit.fires) {
    const flame = torchFlame(f.size);
    flame.position.copy(f.at);
    group.add(flame);
  }

  // ---- what hangs in the air over the broken stones: one shape each kind, a mesh a piece ----
  const floatMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const shapes = {
    capital: (() => {
      const p = new Paint();
      p.cyl(OLD, 0.3, 0.2, 0.14, 0, -0.14, 0, 10);
      p.box(STONE_PALE, 0.62, 0.1, 0.62, 0, 0, 0);
      p.box(OLD, 0.5, 0.05, 0.5, 0, 0.1, 0);
      return p.mesh(floatMat).geometry;
    })(),
    drum: (() => {
      const p = new Paint();
      p.cyl(OLD, 0.18, 0.19, 0.3, 0, -0.15, 0, 10);
      p.blob(STONE_DARK, 0.15, 0.07, 0.13, 0, 0.17, 0, 1, 0.3);
      p.blob(STONE_DARK, 0.14, 0.06, 0.12, 0, -0.16, 0, 2, -0.2);
      return p.mesh(floatMat).geometry;
    })(),
  };
  const floats = kit.floats.map((f, i) => {
    const mesh = new THREE.Mesh(shapes[f.kind], floatMat);
    mesh.position.copy(f.at);
    mesh.rotation.y = f.turn;
    mesh.userData.glow = true;
    group.add(mesh);
    return { mesh, at: f.at, phase: i * 1.7, turn: f.turn, kind: f.kind };
  });

  // ---- the caverns breathe: pale motes drift out of the mouth and over the forecourt ----
  let motes: MoteField | null = null;
  {
    const mouth = place(HARBOR_CAVE);
    const ghost = new THREE.Color(GHOST);
    const pale = new THREE.Color("#d8fff0");
    const dust: Mote[] = [];
    for (let i = 0; i < 34; i++) {
      dust.push({
        x: mouth.x + (hash(i, 1, 70) - 0.5) * 2.6, y: mouth.y + 0.15 + hash(i, 2, 70) * 0.9, z: mouth.z - 0.6 + hash(i, 3, 70) * 2.6,
        color: i % 4 === 0 ? pale : ghost, rise: 0.7 + hash(i, 4, 70) * 1.3, sway: 0.2 + hash(i, 5, 70) * 0.3, rate: 0.08 + hash(i, 6, 70) * 0.12, phase: hash(i, 7, 70), size: 0.5 + hash(i, 8, 70) * 0.6,
      });
    }
    motes = moteField(dust, 0.09, { opacity: 0.75 });
    group.add(motes.points);
  }

  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    group,
    glows: kit.glows,
    spots,
    update(clock, dark) {
      const t = clock * (still ? 0.12 : 1);
      // Lamps are dull glass by day and come up with the dusk; the cold signs never go out, and breathe.
      warmMat.color.setScalar(0.5 + 0.5 * Math.min(1, dark * 1.6));
      coolMat.color.setScalar((0.62 + 0.38 * dark) * (0.88 + 0.12 * Math.sin(t * 1.3)));
      for (const f of floats) {
        f.mesh.position.y = f.at.y + Math.sin(t * 0.7 + f.phase) * 0.07;
        f.mesh.rotation.set(Math.sin(t * 0.4 + f.phase) * 0.07, f.turn + t * (f.kind === "drum" ? 0.16 : 0.06), Math.sin(t * 0.33 + f.phase * 2) * 0.07);
      }
      motes?.tick(t);
      // The boats ride the swell: up and down a hand's breadth, rolling and nodding a little, each in her own time.
      for (const b of boats) {
        b.group.position.y = b.y - 0.05 + Math.sin(t * 1.1 + b.phase) * 0.035;
        b.group.rotation.set(Math.sin(t * 0.9 + b.phase) * 0.035, b.turn + Math.sin(t * 0.31 + b.phase) * 0.03, Math.sin(t * 1.3 + b.phase * 1.7) * 0.06);
      }
    },
    dispose() {
      group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        for (const one of Array.isArray(m) ? m : [m]) one.dispose();
      });
      shapes.capital.dispose();
      shapes.drum.dispose();
      motes?.dispose();
      group.clear();
    },
  };
}

/**
 * The front of the Harbor's caverns, in the entrance model's own space (its arch's face at z = `face`, its middle
 * at x = 0, about 0.64 wide and 0.66 tall: see caveMouth): a crag of dark rock standing over the wall, and cut
 * into its foot a doorway of dressed stone. Squared piers either side on stepped bases, an arch of wedge stones
 * sprung between them with a keystone that burns pale, a heavy lintel course and a cornice over it, timber props
 * inside the arch as in a mine, a worn sill, and an iron lantern on a bracket off each pier. Returns what to add
 * to the model, and the lights in it.
 */
export function grandCaveFront(face: number): { group: THREE.Group; glows: BuildingGlow[] } {
  const kit: Kit = { solid: new Paint(), warm: new Paint(), cool: new Paint(), glows: [], fires: [], floats: [] };
  const s = kit.solid;
  const ROCK = "#3d4048";
  const ROCK_PALE = "#565a63";
  const ROCK_DEEP = "#2c2e35";
  // The crag: one great mass behind and over the doorway, shoulders either side, spires off it, scree at its feet.
  s.blob(ROCK, 1.05, 1.2, 0.8, 0, 0.7, face - 1.0, 0.3);
  s.blob(ROCK_DEEP, 0.8, 0.9, 0.7, -0.75, 0.5, face - 0.8, 1.1);
  s.blob(ROCK, 0.76, 0.84, 0.66, 0.8, 0.46, face - 0.78, 2.3);
  s.blob(ROCK_PALE, 0.62, 0.5, 0.5, 0.1, 1.5, face - 0.92, 0.8, 0.2);
  s.cone(ROCK_PALE, 0.36, 1.3, -0.5, 1.2, face - 1.05, 5, 0.8);
  s.cone(ROCK, 0.3, 1.0, 0.62, 1.1, face - 1.1, 5, 1.7);
  s.cone(ROCK_DEEP, 0.26, 0.9, 0.05, 1.8, face - 1.15, 5, 0.3);
  s.cone(ROCK_PALE, 0.3, 0.8, -1.15, 0.3, face - 0.6, 5, 2.0);
  s.cone(ROCK, 0.28, 0.72, 1.2, 0.26, face - 0.62, 5, 0.5);
  for (const [x, z, r] of [[-0.95, 0.2, 0.13], [1.0, 0.12, 0.11], [-1.2, -0.1, 0.16], [0.86, 0.3, 0.08]]) s.blob(ROCK_PALE, r * 1.2, r * 0.7, r, x, r * 0.4, face + z, x * 3);
  // The rock face the doorway is cut into, close behind the dressed stone.
  s.box(ROCK_DEEP, 1.5, 1.16, 0.3, 0, 0, face - 0.33);
  // The doorway. Piers: stepped base, shaft with a sunk panel, capital.
  const DRESSED = "#6f737c";
  const DRESSED_PALE = "#8a8e96";
  const DRESSED_DARK = "#555962";
  for (const side of [-1, 1]) {
    const x = side * 0.5;
    s.box(DRESSED_DARK, 0.3, 0.07, 0.3, x, 0, face - 0.02);
    s.box(DRESSED, 0.25, 0.06, 0.26, x, 0.07, face - 0.02);
    s.box(DRESSED_PALE, 0.19, 0.5, 0.2, x, 0.13, face - 0.04);
    s.box(DRESSED_DARK, 0.1, 0.34, 0.012, x, 0.2, face + 0.062);
    s.box(DRESSED, 0.25, 0.05, 0.26, x, 0.63, face - 0.02);
    s.box(DRESSED_DARK, 0.29, 0.045, 0.3, x, 0.68, face - 0.02);
    kit.cool.box(GHOST, 0.035, 0.12, 0.01, x, 0.3, face + 0.07);
    kit.cool.box(GHOST, 0.08, 0.025, 0.01, x, 0.4, face + 0.07);
    // A lantern on an iron bracket off the pier, outside it.
    s.box(IRON, 0.16, 0.016, 0.016, x + side * 0.16, 0.6, face + 0.05);
    s.box(IRON, 0.012, 0.05, 0.012, x + side * 0.23, 0.555, face + 0.05);
    lantern(kit, x + side * 0.23, 0.5, face + 0.05, 0.62, "candle", 0.5);
    // Buttress: the wall stepping out to the rock either side.
    s.box(DRESSED_DARK, 0.2, 0.44, 0.22, x + side * 0.26, 0, face - 0.1);
    s.box(DRESSED, 0.22, 0.04, 0.24, x + side * 0.26, 0.44, face - 0.1);
  }
  // The arch: nine wedge stones on a half round over the way in, the middle one bigger and proud of the rest.
  const [cy, r] = [0.37, 0.4];
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.06 + (i / 8) * 0.88);
    const keystone = i === 4;
    s.box(keystone ? DRESSED_PALE : i % 2 ? DRESSED : DRESSED_DARK, 0.15, keystone ? 0.2 : 0.15, keystone ? 0.26 : 0.2, Math.cos(a) * r, cy + Math.sin(a) * r - 0.075 - (keystone ? 0.01 : 0), face - 0.03 + (keystone ? 0.02 : 0), 0, 0, a - Math.PI / 2);
  }
  kit.cool.box(GHOST, 0.07, 0.07, 0.01, 0, cy + r - 0.02, face + 0.125, 0, 0, Math.PI / 4);
  // Over it: the lintel course from pier to pier, a cornice, and a low pediment with a pale boss in it.
  s.box(DRESSED, 1.3, 0.09, 0.26, 0, 0.84, face - 0.03);
  s.box(DRESSED_PALE, 1.42, 0.05, 0.32, 0, 0.93, face - 0.03);
  s.box(DRESSED_DARK, 1.0, 0.1, 0.22, 0, 0.98, face - 0.05);
  s.box(DRESSED, 0.56, 0.1, 0.2, 0, 1.08, face - 0.06);
  s.cone(DRESSED_PALE, 0.09, 0.14, -0.62, 0.98, face - 0.03, 4, Math.PI / 4);
  s.cone(DRESSED_PALE, 0.09, 0.14, 0.62, 0.98, face - 0.03, 4, Math.PI / 4);
  kit.cool.box(GHOST, 0.1, 0.035, 0.01, 0, 1.03, face + 0.062);
  // Spandrels: the wall between the arch and the lintel.
  for (const side of [-1, 1]) s.box(DRESSED_DARK, 0.26, 0.2, 0.16, side * 0.42, 0.66, face - 0.06);
  // Timber props inside the arch, as in a mine: two posts and a cap, dark with pitch.
  for (const x of [-0.27, 0.27]) s.box("#3a2a1c", 0.07, 0.6, 0.07, x, 0.01, face - 0.1, 0, 0, x > 0 ? 0.05 : -0.05);
  s.box("#3a2a1c", 0.66, 0.07, 0.08, 0, 0.6, face - 0.1);
  // The sill: one worn slab, low enough to stand on.
  s.box(DRESSED, 0.86, 0.025, 0.2, 0, 0, face + 0.02);

  const group = new THREE.Group();
  const lambert = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  group.add(s.mesh(lambert));
  const warm = kit.warm.mesh(new THREE.MeshBasicMaterial({ vertexColors: true }));
  warm.userData.glow = true;
  const cool = kit.cool.mesh(new THREE.MeshBasicMaterial({ vertexColors: true }));
  cool.userData.glow = true;
  group.add(warm, cool);
  return { group, glows: kit.glows };
}
