// Felling, played in the Harbor through the hero's eyes (rules in
// packages/world/src/felling.ts). A WorldMinigame: the world renderer swings
// its camera down into this one's and hands it the presses, the pointer and
// the keys.
//
// Three trees, thin to thick, left to right, stood on open land round the
// felling spot (the scene reads the map to find where: along the tree line if
// it can, never over the water or into a building). Before the round you take
// in all three; once it starts you crouch beside the one you are cutting,
// side on to its notch, so the wedge you cut out of it shows in profile.
//
// The cut's angle follows the pointer: above the notch cuts down from above,
// below it cuts up from below, and the further up or down, the steeper. A
// guide on the trunk shows the line the cut will run along, and where the axe
// will bind. Every chop goes through the same rules the server replays the
// round by (felling.ts), so what you see is what is paid.

import * as THREE from "three";
import { ANGLE_MAX, ANGLE_MIN, CHOP_GAP_MS, FELL_DEPTH, FELL_ROUND_MS, REGROW_MS, TREE_SLOTS, chopTree, cutAngle, freshCut, reachOf, type Chop, type Notch, type TreeCut, type TreeSize } from "@gantt-quest/world";
import { audio } from "../audio/engine";
import { soundName } from "../audio/names";
import type { WorldMinigame } from "./WorldRenderer";
import { fxTexture, type FxKind } from "./sprites";

export type FellingMode = "arrive" | "intro" | "chop" | "over" | "leaving";

/** What the panel shows over the view. */
export interface FellingHud {
  mode: FellingMode;
  /** Time left in the round. */
  leftMs: number;
  /** The tree being cut. */
  current: number;
  /** The angle the next chop goes in at: degrees off level, positive from above. */
  angle: number;
  /** How far down each tree is (1 is falling) and whether it is still growing back. */
  trees: { progress: number; growing: boolean }[];
  felled: number;
  /** The cut on the side being aimed at has gone as deep as it can: the other side must meet it. */
  bound: boolean;
  /** Whether the other side already has a cut in it waiting to be met. */
  otherCut: boolean;
  /** The last thing a chop did worth saying, for the word in the middle of the view: `n` counts them, so each is new. */
  pop: { n: number; kind: "chunk" | "felled" | "bound" } | null;
}

/** What is under a point of the map (world units): its biome, the height of its top, and whether something stands on that hex. */
export type GroundAt = (x: number, z: number) => { biome: string; top: number; poi: boolean } | null;

export interface FellingHooks {
  hud(h: FellingHud): void;
  /** The round has run its time: every chop in it, to report. */
  chopped(chops: Chop[]): void;
  /** The camera is back in the usual view: the game can be taken down. */
  left(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 0.64;
/** How far in front the trees stand, and how far apart. */
const TREE_DIST = 1.9;
const TREE_GAP = 0.66;
/** Half the view's width, at least, whatever the shape of the window: the three trees always fit across it. */
const HALF_WIDTH = THREE.MathUtils.degToRad(26);
/** How long the camera takes to swing in, and back out. */
const ARRIVE_S = 1.9;
const LEAVE_S = 1.4;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** The axe, from the butt of the haft: where the head sits up it, how far out the middle of its edge is, and its size in the world. */
const AXE_HEAD = 0.37;
const AXE_EDGE = 0.112;
const AXE_SCALE = 0.85;
/** How long a chop takes, and how much of it is the blow (the rest is drawing the axe back). Quick: you click as fast as you like. */
const SWING_S = 0.2;
const STRIKE_PART = 0.38;
/** How far the axe is drawn back between blows: turned about the hands, in the plane of its blade (radians). */
const BACKSWING = 1.05;
/** When the axe binds it stays in the cut this long before it comes free. */
const STUCK_S = 0.14;
/** How a swing goes, 0 at rest to 1 at the blow. */
function swingCurve(t: number): number {
  if (t < 0) return 0;
  const u = t / SWING_S;
  if (u < STRIKE_PART) return (u / STRIKE_PART) ** 2;
  return 1 - easeInOut((u - STRIKE_PART) / (1 - STRIKE_PART));
}
/** How far round from looking straight at a tree its notch faces: far enough that the wedge bites out of its outline, near enough that you see into it. */
const NOTCH_TURN = THREE.MathUtils.degToRad(40);

const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const HEARTWOOD = new THREE.Color("#ffe3a6");
/** A cut under way shows as a line of fresh pale wood. */
const KERF = new THREE.Color("#fff0c4");

/** Each tree's trunk and crown: radius at the foot and the top, the trunk's height and where the cut goes in, and its crown. */
const MODELS: Record<TreeSize, { rBottom: number; rTop: number; height: number; cutY: number; bark: string; crown: (add: (g: THREE.BufferGeometry, c: string, y: number) => THREE.Mesh) => number }> = {
  small: {
    rBottom: 0.05, rTop: 0.038, height: 0.46, cutY: 0.2, bark: "#7a5230",
    crown: (add) => {
      add(new THREE.ConeGeometry(0.2, 0.36, 7), "#4f9a46", 0.58);
      add(new THREE.ConeGeometry(0.14, 0.28, 7), "#5cad4f", 0.78);
      return 0.95;
    },
  },
  medium: {
    rBottom: 0.075, rTop: 0.058, height: 0.62, cutY: 0.27, bark: "#d6cfbf",
    crown: (add) => {
      add(new THREE.IcosahedronGeometry(0.3, 1), "#86b84a", 0.84);
      add(new THREE.IcosahedronGeometry(0.2, 1), "#9cc957", 1.1);
      return 1.3;
    },
  },
  large: {
    rBottom: 0.112, rTop: 0.085, height: 0.8, cutY: 0.34, bark: "#5e3f22",
    crown: (add) => {
      add(new THREE.IcosahedronGeometry(0.44, 1), "#2f7a3d", 1.12);
      add(new THREE.IcosahedronGeometry(0.3, 1), "#3a8743", 1.38).position.x = 0.16;
      add(new THREE.IcosahedronGeometry(0.28, 1), "#2a6e36", 1.22).position.x = -0.24;
      return 1.62;
    },
  },
};

/** The trunk's width at the cut, which the rules' depths are shares of. */
const widthAt = (size: TreeSize) => {
  const m = MODELS[size];
  return 2 * THREE.MathUtils.lerp(m.rBottom, m.rTop, m.cutY / m.height);
};

const tanOf = (deg: number) => Math.tan(THREE.MathUtils.degToRad(Math.abs(deg)));

/**
 * A felling axe, held at the butt of its haft (the group's origin): the haft
 * runs up +Y, a little bowed, with a leather grip and a knob at the butt; the
 * head sits across the top, its bit flaring out along +X to a curved edge,
 * thinning to it, with a bright band of honed steel along the edge, and a
 * square poll behind. The edge runs along Y, like the haft, as on any axe.
 */
function axeModel(): THREE.Group {
  const axe = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 11;
    axe.add(mesh);
    return mesh;
  };
  // The haft: a gentle S, thicker toward the butt.
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.01, 0.12, 0), new THREE.Vector3(0.004, 0.27, 0), new THREE.Vector3(0, AXE_HEAD + 0.03, 0)]);
  add(new THREE.TubeGeometry(curve, 10, 0.0105, 6, false), lambert("#9a7448"));
  add(new THREE.CylinderGeometry(0.016, 0.014, 0.022, 7).translate(0, 0.004, 0), lambert("#6a4a2c"));
  add(new THREE.CylinderGeometry(0.0135, 0.0135, 0.1, 7).translate(-0.004, 0.07, 0), lambert("#5a3a22"));
  for (const y of [0.03, 0.06, 0.09]) add(new THREE.CylinderGeometry(0.0142, 0.0142, 0.006, 7).translate(-0.005, y, 0), lambert("#3e2716"));
  // The head, in profile: the poll behind, the eye round the haft, the bit flaring to a curved edge, bearded below.
  const shape = new THREE.Shape();
  shape.moveTo(-0.032, -0.022);
  shape.lineTo(-0.032, 0.022);
  shape.lineTo(0.03, 0.02);
  shape.quadraticCurveTo(0.07, 0.03, 0.104, 0.05);
  shape.quadraticCurveTo(0.124, 0.0, 0.106, -0.058);
  shape.quadraticCurveTo(0.07, -0.03, 0.03, -0.02);
  shape.closePath();
  const head = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false, curveSegments: 5 }).translate(0, 0, -0.015);
  // Thin toward the edge, and the edge itself honed bright.
  const pos = head.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const steel = new THREE.Color("#8e98a4"), dark = new THREE.Color("#5f6872"), honed = new THREE.Color("#eef3f8");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = THREE.MathUtils.clamp((x - 0.02) / 0.09, 0, 1);
    pos.setZ(i, pos.getZ(i) * (1 - 0.85 * t));
    const c = x > 0.09 ? honed : x < -0.012 ? dark : steel;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  head.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  head.computeVertexNormals();
  add(head, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })).position.y = AXE_HEAD;
  // The wedge driven into the top of the eye.
  add(new THREE.BoxGeometry(0.012, 0.006, 0.022), lambert("#3a2a1a")).position.set(0.002, AXE_HEAD + 0.024, 0);
  axe.scale.setScalar(AXE_SCALE);
  return axe;
}

/**
 * A trunk that takes a felling notch: a column of many thin rings round the
 * height of the cut. Each draw pulls in the corners that fall inside the
 * wedges cut out so far, onto the planes of their faces (pale wood), and
 * darkens the line of each cut still under way.
 */
class NotchTrunk {
  readonly mesh: THREE.Mesh;
  private ys: number[] = [];
  private readonly sides = 40;
  private readonly w: number;
  private readonly rCut: number;
  private bark: THREE.Color;
  /** The way the notch faces, and across it, in the tree's own space. */
  private n: THREE.Vector3;
  private s: THREE.Vector3;
  private step: number;

  constructor(private size: TreeSize, front: THREE.Vector3) {
    const m = MODELS[size];
    this.w = widthAt(size);
    this.rCut = this.w / 2;
    this.n = front.clone().setY(0).normalize();
    this.s = new THREE.Vector3().crossVectors(UP, this.n);
    this.bark = new THREE.Color(m.bark);
    // Rings close together where a wedge can reach (its steepest, deepest), and a few beyond.
    const tan = Math.tan(THREE.MathUtils.degToRad(ANGLE_MAX));
    const reach = this.w * tan * 1.02;
    this.step = this.w / 15;
    const lo = Math.max(0.01, m.cutY - reach);
    const hi = Math.min(m.height - 0.01, m.cutY + reach);
    this.ys.push(0);
    for (let y = lo; y < hi; y += this.step) this.ys.push(y);
    this.ys.push(hi, m.height);
    const n = this.sides;
    const verts = this.ys.length * n;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    // Fresh-cut wood lights itself a little, so the notch reads at dusk as well as at noon.
    geo.setAttribute("glow", new THREE.BufferAttribute(new Float32Array(verts), 1));
    const index: number[] = [];
    for (let i = 0; i < this.ys.length - 1; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
        // Wound so the faces look outward (counter-clockwise seen from outside): the side facing you is drawn, not the inside of the far side.
        index.push(a, b, c, b, d, c);
      }
    }
    geo.setIndex(index);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vGlow;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * 0.55;");
    };
    mat.customProgramCacheKey = () => "notch-trunk";
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.draw(freshCut());
  }

  /** A point on the profile through the trunk's axis: `d` of the width in from the notch's side, at height `y`. */
  at(d: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.n).multiplyScalar(this.rCut - d * this.w).addScaledVector(UP, y);
  }

  get cutY(): number {
    return MODELS[this.size].cutY;
  }

  get width(): number {
    return this.w;
  }

  /** How deep the wedges cut out of it so far reach at height y (a share of the width in from the notch's side). */
  carved(cut: TreeCut, y: number): number {
    let e = 0;
    const dy = y - MODELS[this.size].cutY;
    for (const k of cut.notches) e = Math.max(e, k.depth - Math.abs(dy) / (this.w * tanOf(dy >= 0 ? k.top : k.bottom)));
    return e;
  }

  /** Draw the trunk as `cut` leaves it; `severed`, only what is above the notch (the part that falls). */
  draw(cut: TreeCut, severed = false) {
    const m = MODELS[this.size];
    const n = this.sides;
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const glow = this.mesh.geometry.getAttribute("glow") as THREE.BufferAttribute;
    const carved = (y: number) => this.carved(cut, y);
    // The cuts under way: the line each runs along, from its point at the cut's height out to the bark.
    const kerfs: { depth: number; tan: number; up: boolean }[] = [];
    if (cut.top > cut.floor + 1e-6) kerfs.push({ depth: cut.top, tan: tanOf(cut.topAngle), up: true });
    if (cut.bottom > cut.floor + 1e-6) kerfs.push({ depth: cut.bottom, tan: tanOf(cut.bottomAngle), up: false });
    const k = this.step * 1.3;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.ys.length; i++) {
      const y = this.ys[i];
      const r = THREE.MathUtils.lerp(m.rBottom, m.rTop, y / m.height);
      const e = i === 0 || i === this.ys.length - 1 ? 0 : carved(y);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2;
        let u = Math.cos(a) * r;
        const v = Math.sin(a) * r;
        let c = this.bark;
        if (e > 0 && (this.rCut - u) / this.w < e) {
          u = Math.max(this.rCut - e * this.w, -Math.sqrt(Math.max(0, r * r - v * v)));
          c = HEARTWOOD;
        }
        const d = (this.rCut - u) / this.w;
        for (const kf of kerfs) {
          if (d > kf.depth + 0.02) continue;
          const line = m.cutY + (kf.up ? 1 : -1) * (kf.depth - d) * this.w * kf.tan;
          if (Math.abs(y - line) < k) c = KERF;
        }
        p.copy(this.n).multiplyScalar(u).addScaledVector(this.s, v).setY(severed ? Math.max(y, m.cutY) : y);
        pos.setXYZ(i * n + j, p.x, p.y, p.z);
        col.setXYZ(i * n + j, c.r, c.g, c.b);
        glow.setX(i * n + j, c === this.bark ? 0 : 1);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    glow.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
  }
}

interface TreeObj {
  size: TreeSize;
  root: THREE.Group;
  /** What falls: the trunk and the crown. */
  body: THREE.Group;
  trunk: NotchTrunk;
  /** Left behind when it falls, until the new one has grown. */
  stump: THREE.Mesh;
  ring: THREE.Mesh;
  /** The way the notch faces, and the tree falls (the tree's own space). */
  front: THREE.Vector3;
  cut: TreeCut;
  /** performance.now() when it came down; it stands again REGROW_MS later. */
  fellAt: number;
  shake: number;
}

interface Bit {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  floor: number;
}

/** A thin strip in the profile plane of a tree, drawn over everything: for the guide on the trunk. */
function strip(color: string, opacity: number): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  return mesh;
}

/** Lay a strip from `a` to `b`, `width` wide across `across`. */
function layStrip(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, across: THREE.Vector3, width: number) {
  const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const along = b.clone().sub(a).normalize();
  const side = new THREE.Vector3().crossVectors(along, across).normalize().multiplyScalar(width / 2);
  const pts = [a.clone().add(side), a.clone().sub(side), b.clone().add(side), b.clone().sub(side)];
  pts.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
  pos.needsUpdate = true;
}

export class FellingScene implements WorldMinigame {
  private mode: FellingMode = "arrive";
  /** 0 the usual view, 1 all the way into this one. */
  private blend = 0;
  /** Along the tree line, the way you face to chop, and across it to the right. */
  private out: THREE.Vector3;
  private right: THREE.Vector3;
  private wideEye: THREE.Vector3;
  private wideLook: THREE.Vector3;
  /** Where the eye is and what it looks at, eased toward the shot the mode wants. */
  private eye: THREE.Vector3;
  private look: THREE.Vector3;
  private settled = false;

  private trees: TreeObj[] = [];
  private current = 2;
  private angle = 40;
  private axe: THREE.Group;
  /** Seconds into the axe's swing, or -1 at rest. */
  private swingT = -1;
  /** Seconds the axe has yet to stay in a cut it bound in. */
  private stuck = 0;
  /** Where the axe comes down on the chop under way: its pose at the blow (the hands, and how it is turned). */
  private blow: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;
  /** What the chop under way does when the edge lands (the trunk redrawn, chips, sounds), and when that is. */
  private impact: (() => void) | null = null;
  private impactAt = 0;
  private axePlaced = false;
  private bits: Bit[] = [];
  private shake = 0;

  /** The guide on the trunk: the line the cut will run, and the point where the axe binds. */
  private guide: THREE.Mesh;
  private guideStop: THREE.Mesh;

  private roundStart = 0;
  private lastChop = -Infinity;
  private chops: Chop[] = [];
  private felled = 0;
  private pop: FellingHud["pop"] = null;
  private hudAt = 0;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private raycaster = new THREE.Raycaster();

  /**
   * `group` stands on the felling hex; `seaward` is the way out of the tree
   * line, away from the town (world space, on the ground); `groundAt` reads
   * the map, so the trees are only ever put on open land.
   */
  constructor(private group: THREE.Group, seaward: THREE.Vector3, private ground: GroundAt, private hooks: FellingHooks) {
    const sea = seaward.clone().setY(0).normalize();
    this.out = this.chooseFacing(sea);
    this.right = new THREE.Vector3(-this.out.z, 0, this.out.x);
    this.wideEye = new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.wideLook = new THREE.Vector3().addScaledVector(this.out, TREE_DIST);
    this.wideLook.y = this.heightAt(this.wideLook) + 0.62;
    this.eye = this.wideEye.clone();
    this.look = this.wideLook.clone();

    TREE_SLOTS.forEach((size, slot) => {
      const root = new THREE.Group();
      root.position.copy(this.treeSpot(this.out, slot));
      root.position.y = this.heightAt(root.position);
      // The notch faces round from you to the right, where the axe in your right hand comes in: you cut it on that side.
      const toYou = this.out.clone().negate();
      const front = toYou.clone().applyAxisAngle(UP, NOTCH_TURN);
      const body = new THREE.Group();
      const trunk = new NotchTrunk(size, front);
      body.add(trunk.mesh);
      MODELS[size].crown((geo, color, y) => {
        const mesh = new THREE.Mesh(geo, lambert(color));
        mesh.position.y = y;
        mesh.castShadow = true;
        body.add(mesh);
        return mesh;
      });
      root.add(body);
      body.traverse((o) => (o.userData.slot = slot));
      const m = MODELS[size];
      const stump = new THREE.Mesh(new THREE.CylinderGeometry(trunk.width / 2, m.rBottom, m.cutY, 12).translate(0, m.cutY / 2, 0), lambert(m.bark));
      const top = new THREE.Mesh(new THREE.CircleGeometry(trunk.width / 2 - 0.004, 12).rotateX(-Math.PI / 2), lambert("#d9b86e"));
      top.position.y = m.cutY + 0.001;
      stump.add(top);
      stump.visible = false;
      root.add(stump);
      const ring = new THREE.Mesh(new THREE.RingGeometry(m.rBottom + 0.07, m.rBottom + 0.1, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffe27a", transparent: true, opacity: 0.85, depthWrite: false }));
      ring.position.y = 0.02;
      root.add(ring);
      group.add(root);
      this.trees.push({ size, root, body, trunk, stump, ring, front, cut: freshCut(), fellAt: -Infinity, shake: 0 });
    });

    this.guide = strip("#ffe27a", 0.55);
    this.guideStop = strip("#ff7a5a", 0.95);
    group.add(this.guide, this.guideStop);

    this.axe = axeModel();
    group.add(this.axe);
    this.emit(true);
  }

  // ---------- where things stand ----------

  /** A tree's place, in the group's space, for a facing. */
  private treeSpot(facing: THREE.Vector3, slot: number): THREE.Vector3 {
    const right = new THREE.Vector3(-facing.z, 0, facing.x);
    return new THREE.Vector3().addScaledVector(facing, TREE_DIST + (slot === 1 ? 0.15 : 0)).addScaledVector(right, (slot - 1) * TREE_GAP);
  }

  /** The map under a point in the group's space. */
  private under(p: THREE.Vector3) {
    return this.ground(this.group.position.x + p.x, this.group.position.z + p.z);
  }

  /** Open ground: on the map, not water or a jetty, and no building or spot on that hex (bar this one). */
  private open(p: THREE.Vector3): boolean {
    const g = this.under(p);
    if (!g || g.biome === "water" || g.biome === "dock" || g.biome === "rampart" || g.biome === "rock") return false;
    return !g.poi || Math.hypot(p.x, p.z) < 0.8;
  }

  /** The ground's height at a point, in the group's space (its origin is the felling hex's top). */
  private heightAt(p: THREE.Vector3): number {
    const g = this.under(p);
    return g ? g.top - this.group.position.y : 0;
  }

  /**
   * Which way to face to chop: round the compass in steps, keeping only ways
   * where all three trees, and the ground between, are open; of those, the
   * one with the most forest under the trees, level with this hex, nearest to
   * looking along the tree line rather than out to sea.
   */
  private chooseFacing(sea: THREE.Vector3): THREE.Vector3 {
    let best: { dir: THREE.Vector3; score: number } | null = null;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const spots = [0, 1, 2].map((slot) => this.treeSpot(dir, slot));
      const between = spots.map((p) => p.clone().multiplyScalar(0.5));
      // Room round each trunk too, so no tree hangs over the edge of its hex into the water.
      const round = spots.flatMap((p) => [0, 1, 2, 3, 4, 5].map((k) => p.clone().add(new THREE.Vector3(Math.sin(k * 1.05) * 0.35, 0, Math.cos(k * 1.05) * 0.35))));
      if (![...spots, ...between, ...round].every((p) => this.open(p))) continue;
      let score = 0;
      for (const p of spots) {
        const g = this.under(p)!;
        if (g.biome === "forest") score += 2;
        score -= Math.abs(g.top - this.group.position.y) * 4;
      }
      // Along the coast beats out to sea or in to town.
      score -= Math.abs(dir.dot(sea)) * 1.5;
      if (!best || score > best.score) best = { dir, score };
    }
    return best?.dir ?? sea.clone().negate();
  }

  // ---------- what the panel calls ----------

  /** Where the game's own trees stand, in world space, and how far round them the wood should be cleared. */
  clearing(): { x: number; z: number; radius: number } {
    const c = this.group.localToWorld(new THREE.Vector3().addScaledVector(this.out, 1.3));
    return { x: c.x, z: c.z, radius: 2 };
  }

  /** Start the round now. */
  startChop() {
    this.mode = "chop";
    this.roundStart = performance.now();
    this.lastChop = -Infinity;
    this.chops = [];
    this.felled = 0;
    this.pop = null;
    this.emit(true);
  }

  /** A button for a tree: cut that one. */
  pick(slot: number) {
    const next = Math.max(0, Math.min(TREE_SLOTS.length - 1, slot));
    if (next === this.current) return;
    this.current = next;
    this.settled = false;
    this.emit(true);
  }

  /** Another outing: a fresh stand. */
  reset() {
    this.mode = "intro";
    for (const t of this.trees) {
      t.cut = freshCut();
      t.fellAt = -Infinity;
      t.trunk.draw(t.cut);
      t.stump.visible = false;
    }
    this.current = 2;
    this.pop = null;
    this.impact = null;
    this.blow = null;
    this.swingT = -1;
    this.stuck = 0;
    this.emit(true);
  }

  /** Done: swing back out to the usual view, then tell the panel. */
  leave() {
    if (this.mode === "leaving") return;
    this.mode = "leaving";
    this.emit(true);
  }

  /** The panel is showing the results. */
  finished() {
    this.mode = "over";
    this.emit(true);
  }

  // ---------- the minigame ----------

  frame(dt: number, now: number, aspect: number) {
    if (this.mode === "leaving") {
      this.blend = Math.max(0, this.blend - dt / (this.still ? 0.2 : LEAVE_S));
      if (this.blend === 0) {
        this.mode = "arrive";
        this.hooks.left();
      }
    } else if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / (this.still ? 0.2 : ARRIVE_S));
      if (this.blend === 1 && this.mode === "arrive") {
        this.mode = "intro";
        this.emit(true);
      }
    }

    // The round's clock.
    if (this.mode === "chop" && now - this.roundStart >= FELL_ROUND_MS) {
      this.mode = "over";
      this.emit(true);
      this.hooks.chopped(this.chops);
    }

    this.stepTrees(dt, now);
    this.stepBits(dt);
    // While cutting, crouched beside the tree; otherwise, standing back to take in all three.
    const shot = this.mode === "chop" ? this.closeShot(this.current) : { eye: this.wideEye, look: this.wideLook };
    const k = this.still || !this.settled ? 1 - Math.exp(-dt * 6) : 1 - Math.exp(-dt * 10);
    this.eye.lerp(shot.eye, this.still ? 1 : k);
    this.look.lerp(shot.look, this.still ? 1 : k);
    if (this.eye.distanceToSquared(shot.eye) < 1e-5) this.settled = true;
    this.stepGuide();
    this.stepAxe(dt);
    if (now - this.hudAt > 100) this.emit(false, now);

    const eye = this.group.localToWorld(this.eye.clone());
    if (this.shake > 0 && !this.still) {
      eye.x += (Math.random() - 0.5) * this.shake;
      eye.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 0.12);
    }
    // Wide enough for all three trees however narrow the window; closer in, a little tighter.
    const wide = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(HALF_WIDTH) / Math.max(0.3, aspect))), 50, 92);
    const fov = this.mode === "chop" ? THREE.MathUtils.clamp(wide * 0.85, 42, 76) : wide;
    return { eye, look: this.group.localToWorld(this.look.clone()), blend: easeInOut(this.blend), fov };
  }

  /** Crouched beside a tree, side on to its notch, the cut at the middle of the view (in the group's space). */
  private closeShot(slot: number): { eye: THREE.Vector3; look: THREE.Vector3 } {
    const t = this.trees[slot];
    const m = MODELS[t.size];
    const base = t.root.position;
    // The notch's side of the trunk is the middle of the view, so the wedge is what you look at, and the axe comes
    // in from the right across the bark.
    const look = base.clone().addScaledVector(t.front, t.trunk.width * 0.45).setY(base.y + m.cutY);
    const back = 0.36 + t.trunk.width * 2.5;
    const toYou = this.out.clone().negate();
    const eye = look.clone().addScaledVector(toYou, back).setY(base.y + m.cutY + 0.07 + t.trunk.width * 0.4);
    return { eye, look };
  }

  press(ndc: THREE.Vector2, camera: THREE.Camera) {
    if (this.mode !== "chop") return;
    this.raycaster.setFromCamera(ndc, camera);
    const hit = this.raycaster.intersectObjects(this.trees.map((t) => t.body), true)[0];
    const slot = hit ? (hit.object.userData.slot as number) : this.current;
    // A press on another tree turns to it; anywhere else (on this one, or beside it) is a chop at the angle the pointer gives.
    if (slot !== this.current) return this.pick(slot);
    this.aimAt(ndc, camera);
    this.chop(this.current);
  }

  hover(ndc: THREE.Vector2, camera: THREE.Camera) {
    if (this.mode === "chop" || this.mode === "intro") this.aimAt(ndc, camera);
  }

  key(e: KeyboardEvent): boolean {
    if (this.mode !== "chop") return e.key === " ";
    if (e.repeat && e.key !== " " && e.key !== "Enter") return e.key.startsWith("Arrow");
    if (e.key === "1" || e.key === "2" || e.key === "3") return this.pick(Number(e.key) - 1), true;
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") return this.pick(this.current - 1), true;
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") return this.pick(this.current + 1), true;
    if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") return this.tilt(5), true;
    if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") return this.tilt(-5), true;
    if (e.key === "Tab") return this.setAngle(-this.angle), true;
    if (e.key === " " || e.key === "Enter") return this.chop(this.current), true;
    return false;
  }

  // ---------- aiming ----------

  /** The angle from where the pointer is: the cut runs from it to the trunk's middle at the height of the cut. */
  private aimAt(ndc: THREE.Vector2, camera: THREE.Camera) {
    const t = this.trees[this.current];
    const mid = this.group.localToWorld(t.root.position.clone().setY(t.root.position.y + t.trunk.cutY)).project(camera);
    const aspect = (camera as THREE.PerspectiveCamera).aspect ?? 1;
    const dx = Math.abs(ndc.x - mid.x) * aspect;
    const dy = ndc.y - mid.y;
    this.setAngle(THREE.MathUtils.radToDeg(Math.atan2(dy, Math.max(0.02, dx))));
  }

  /** Steeper from above (+) or from below (-), passing from one side to the other at the flattest. */
  private tilt(by: number) {
    let a = this.angle + by;
    if (Math.abs(a) < ANGLE_MIN) a = this.angle > 0 ? -ANGLE_MIN : ANGLE_MIN;
    this.setAngle(a);
  }

  private setAngle(a: number) {
    const next = cutAngle(a) ?? this.angle;
    if (next === this.angle) return;
    this.angle = next;
    this.emit(true);
  }

  /** The cut on the side aimed at can go no deeper: only a cut from the other side meeting it gets further. */
  private boundNow(t: TreeObj): boolean {
    const deep = this.angle > 0 ? t.cut.top : t.cut.bottom;
    return deep >= Math.min(1, t.cut.floor + reachOf(t.size, this.angle)) - 1e-9;
  }

  private stepGuide() {
    const t = this.trees[this.current];
    const show = this.mode === "chop" && this.blend >= 1 && performance.now() >= t.fellAt + REGROW_MS;
    this.guide.visible = this.guideStop.visible = show;
    if (!show) return;
    const tr = t.trunk;
    const reach = Math.min(1, t.cut.floor + reachOf(t.size, this.angle));
    const tan = Math.tan(THREE.MathUtils.degToRad(Math.abs(this.angle)));
    const sign = this.angle > 0 ? 1 : -1;
    // From well outside the bark down to where the axe will bind, along the angle: the point of a cut stays at the cut's height.
    const lineY = (d: number) => tr.cutY + sign * (reach - d) * tr.width * tan;
    const from = Math.min(-0.25, -0.08 / Math.max(0.2, tan));
    const toWorld = (d: number, y: number) => tr.at(d, y).add(t.root.position);
    const a = toWorld(from, lineY(from));
    const b = toWorld(reach, lineY(reach));
    const across = new THREE.Vector3().crossVectors(UP, t.front).normalize();
    layStrip(this.guide, a, b, across, Math.max(0.004, tr.width * 0.035));
    const bound = this.boundNow(t);
    (this.guide.material as THREE.MeshBasicMaterial).color.set(bound ? "#ff7a5a" : "#ffe27a");
    // A short bar across the line where it binds.
    const tip = toWorld(reach, lineY(reach));
    const dir = b.clone().sub(a).normalize();
    const perp = new THREE.Vector3().crossVectors(dir, across).normalize().multiplyScalar(tr.width * 0.18);
    layStrip(this.guideStop, tip.clone().add(perp), tip.clone().sub(perp), across, Math.max(0.008, tr.width * 0.08));
  }

  // ---------- chopping ----------

  /** A chop at a tree. The same limits the server replays by: no quicker than CHOP_GAP_MS, and not at a tree still growing back. */
  private chop(slot: number) {
    if (this.mode !== "chop") return;
    const now = performance.now();
    const at = Math.round(now - this.roundStart);
    const tree = this.trees[slot];
    if (at - this.lastChop < CHOP_GAP_MS || now < tree.fellAt + REGROW_MS || at > FELL_ROUND_MS) return;
    this.lastChop = at;
    this.chops.push({ slot, at, angle: this.angle });
    // The rules take the chop at once; what you see of it waits for the edge to land.
    const { cut, result, notch } = chopTree(tree.cut, tree.size, this.angle);
    tree.cut = result === "felled" ? freshCut() : cut;
    // The swing: on from wherever the axe is (a quick clicker never waits for it to come all the way back), to the
    // edge in the cut just made.
    const kNow = this.stuck > 0 ? 1 : this.swingT >= 0 ? swingCurve(this.swingT) : 0;
    if (this.impact) this.landBlow();
    this.stuck = 0;
    this.swingT = SWING_S * STRIKE_PART * Math.sqrt(kNow);
    this.impactAt = now + (SWING_S * STRIKE_PART - this.swingT) * 1000;
    const strike = this.strikeAt(tree, cut, this.angle);
    this.blow = this.blowPose(strike);
    if (result === "felled") tree.fellAt = this.impactAt;
    this.impact = () => {
      const away = tree.front.clone();
      if (result === "bound") {
        // The axe sticks: a thud, a jolt, no chips, and it stays in the cut a moment.
        this.shake = 0.012;
        tree.shake = 0.12;
        this.stuck = STUCK_S;
        audio.play(soundName.chop("miss"));
        this.pop = { n: (this.pop?.n ?? 0) + 1, kind: "bound" };
      } else {
        tree.shake = 0.2;
        for (let i = 0; i < 3; i++) this.bit("fleck", "#e8c88a", strike.edge.clone(), away.clone().multiplyScalar(0.6 + Math.random() * 0.6).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8)), 0.4, 0.035);
        audio.play(soundName.chop(result === "bite" ? "good" : "perfect"));
      }
      if (notch) this.chunkOut(tree, notch, cut);
      if (result === "chunk") {
        this.shake = 0.02;
        this.pop = { n: (this.pop?.n ?? 0) + 1, kind: "chunk" };
      }
      tree.trunk.draw(cut, result === "felled");
      if (result === "felled") {
        this.felled++;
        this.shake = 0.03;
        this.pop = { n: (this.pop?.n ?? 0) + 1, kind: "felled" };
        audio.play(soundName.fall("timber"), { delay: 0.15 });
      }
      this.emit(true);
    };
    this.emit(true);
  }

  /** The edge has landed: what the chop did shows. */
  private landBlow() {
    const hit = this.impact;
    this.impact = null;
    hit?.();
  }

  /**
   * Where the edge goes in for a chop at `angle`, as `cut` stands: on the line of the cut on that side, some way down
   * it from where it meets the wood (so the bit is seen buried in the cut), or on the face of the notch where
   * there is no cut yet. With the way into the wood along the cut, and across the trunk (the line of the edge).
   */
  private strikeAt(t: TreeObj, cut: TreeCut, angle: number): { edge: THREE.Vector3; dir: THREE.Vector3; across: THREE.Vector3 } {
    const tr = t.trunk;
    const sign = angle > 0 ? 1 : -1;
    const tan = tanOf(angle);
    const tip = Math.max(cut.floor, angle > 0 ? cut.top : cut.bottom);
    const yAt = (d: number) => tr.cutY + sign * (tip - d) * tr.width * tan;
    let entry = tip;
    for (let d = -0.3; d < tip; d += 0.01) {
      if (d >= Math.max(0, tr.carved(cut, yAt(d)))) {
        entry = d;
        break;
      }
    }
    const d = tip - entry < 0.03 ? tip : entry + (tip - entry) * 0.6;
    const edge = tr.at(d, yAt(d)).add(t.root.position);
    const dir = t.front.clone().negate().addScaledVector(UP, -sign * tan).normalize();
    const across = new THREE.Vector3().crossVectors(UP, t.front).normalize();
    return { edge, dir, across };
  }

  /** The axe at the blow: the bit along the cut into the wood, the edge (and so the haft) across the trunk, the hands toward you. */
  private blowPose(strike: { edge: THREE.Vector3; dir: THREE.Vector3; across: THREE.Vector3 }): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const y = strike.across.clone();
    if (y.dot(strike.edge.clone().sub(this.eye)) < 0) y.negate();
    const z = new THREE.Vector3().crossVectors(strike.dir, y);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(strike.dir, y, z));
    const pos = strike.edge.clone().sub(new THREE.Vector3(AXE_EDGE, AXE_HEAD, 0).multiplyScalar(AXE_SCALE).applyQuaternion(quat));
    return { pos, quat };
  }

  /** A wedge knocked out of the trunk: a pale chunk the shape of the new notch, flying out the front. */
  private chunkOut(tree: TreeObj, notch: Notch, cut: TreeCut) {
    const tr = tree.trunk;
    const prev = cut.notches.length > 1 ? cut.notches[cut.notches.length - 2].depth : 0;
    const depth = Math.max(0.04, notch.depth - prev);
    const tanT = Math.tan(THREE.MathUtils.degToRad(Math.abs(notch.top)));
    const tanB = Math.tan(THREE.MathUtils.degToRad(Math.abs(notch.bottom)));
    // In profile: the point, and the cut faces out to the notch it came out of.
    const run = depth * tr.width;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(run, run * tanT);
    shape.lineTo(run, -run * tanB);
    shape.closePath();
    const thick = tr.width * 0.75;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false }).translate(-run, 0, -thick / 2);
    const mesh = new THREE.Mesh(geo, lambert("#e2c27c"));
    // Its +x runs out along the notch's face, +z across it.
    const across = new THREE.Vector3().crossVectors(tree.front, UP).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tree.front, UP, across));
    mesh.position.copy(tr.at(prev, tr.cutY)).add(tree.root.position).addScaledVector(tree.front, -run);
    mesh.castShadow = true;
    this.group.add(mesh);
    const vel = tree.front.clone().multiplyScalar(0.9 + Math.random() * 0.4).setY(0.9);
    this.bits.push({ obj: mesh, vel, spin: new THREE.Vector3(0, 0, -6), age: 0, life: 1.4, floor: tree.root.position.y + 0.02 });
    for (let i = 0; i < 5; i++) this.bit("fleck", "#f0d49a", mesh.position.clone(), tree.front.clone().multiplyScalar(0.8 + Math.random()).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.8 + Math.random(), (Math.random() - 0.5) * 1.2)), 0.5, 0.04);
  }

  private stepTrees(dt: number, now: number) {
    this.trees.forEach((t, slot) => {
      const since = now - t.fellAt;
      // (A tree's last chop is still on its way down until the edge lands.)
      const growing = since >= 0 && since < REGROW_MS;
      // It goes over toward its notch, pivoting on the hinge left at the back of the cut.
      const fallAxis = new THREE.Vector3().crossVectors(UP, t.front).normalize();
      if (growing) {
        const fall = Math.min(1, since / 650);
        t.stump.visible = true;
        if (fall < 1) {
          const hinge = new THREE.Vector3().addScaledVector(t.front, -t.trunk.width * 0.4).setY(t.trunk.cutY);
          const q = new THREE.Quaternion().setFromAxisAngle(fallAxis, (Math.PI / 2) * fall * fall);
          t.body.quaternion.copy(q);
          t.body.position.copy(hinge).sub(hinge.clone().applyQuaternion(q));
          t.body.scale.setScalar(1);
        } else {
          // Gone, and a new one rising in its place.
          const rise = Math.min(1, (since - 650) / Math.max(1, REGROW_MS - 650));
          if (t.body.position.lengthSq() > 0) t.trunk.draw(t.cut);
          t.body.quaternion.identity();
          t.body.position.set(0, 0, 0);
          t.body.scale.setScalar(Math.max(0.001, rise * rise));
        }
      } else {
        t.stump.visible = false;
        t.body.scale.setScalar(1);
        t.body.position.set(0, 0, 0);
        t.shake = Math.max(0, t.shake - dt);
        t.body.quaternion.setFromAxisAngle(fallAxis, Math.sin(now / 18) * 0.04 * t.shake);
      }
      t.ring.visible = (this.mode === "chop" || this.mode === "intro") && slot === this.current && !growing;
    });
  }

  // ---------- the axe and the bits flying ----------

  private stepAxe(dt: number) {
    this.axe.visible = this.blend > 0.85 && this.mode !== "leaving";
    if (this.stuck > 0) this.stuck = Math.max(0, this.stuck - dt);
    else if (this.swingT >= 0) {
      this.swingT += dt;
      if (this.swingT > SWING_S) this.swingT = -1;
    }
    if (this.impact && performance.now() >= this.impactAt) this.landBlow();
    const swinging = this.swingT >= 0 || this.stuck > 0;
    const k = this.stuck > 0 ? 1 : swingCurve(this.swingT);
    const t = this.trees[this.current];
    const standing = performance.now() >= t.fellAt + REGROW_MS || (swinging && this.blow);
    let pos: THREE.Vector3;
    let quat: THREE.Quaternion;
    if (this.mode === "chop" && standing) {
      // Drawn back, already turned to the cut it will make; a chop swings it round about the hands, in the plane of
      // its blade, until the edge is in the cut.
      const blow = swinging && this.blow ? this.blow : this.blowPose(this.strikeAt(t, t.cut, this.angle));
      const back = blow.quat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), BACKSWING));
      const backPos = blow.pos.clone().lerp(this.eye, 0.22).addScaledVector(UP, -0.05);
      pos = backPos.lerp(blow.pos, k);
      quat = back.slerp(blow.quat, k);
    } else {
      // Carried: in the right hand, low in the view, head up.
      const fwd = this.look.clone().sub(this.eye).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd);
      pos = this.eye.clone().addScaledVector(fwd, 0.5).addScaledVector(right, 0.28).addScaledVector(up, -0.34);
      quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right.clone().negate(), up, fwd));
      quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, -0.25)));
    }
    if (!this.axePlaced || swinging || this.still) {
      this.axe.position.copy(pos);
      this.axe.quaternion.copy(quat);
      this.axePlaced = true;
    } else {
      // Between blows it eases to where it should be: round to a new angle, or over to another tree.
      const a = 1 - Math.exp(-dt * 12);
      this.axe.position.lerp(pos, a);
      this.axe.quaternion.slerp(quat, a);
    }
  }

  private bit(kind: FxKind, color: string, at: THREE.Vector3, vel: THREE.Vector3, life: number, size: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture(kind, color), transparent: true, depthWrite: false }));
    sprite.position.copy(at);
    sprite.scale.setScalar(size);
    this.group.add(sprite);
    this.bits.push({ obj: sprite, vel, spin: new THREE.Vector3(), age: 0, life, floor: 0.01 });
  }

  private stepBits(dt: number) {
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i];
      b.age += dt;
      b.vel.y -= 4 * dt;
      b.obj.position.addScaledVector(b.vel, dt);
      if (b.obj.position.y <= b.floor) {
        b.obj.position.y = b.floor;
        b.vel.set(0, 0, 0);
        b.spin.set(0, 0, 0);
      }
      b.obj.rotation.x += b.spin.x * dt;
      b.obj.rotation.z += b.spin.z * dt;
      const fade = b.obj as THREE.Sprite;
      if (fade.isSprite) fade.material.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) {
        this.group.remove(b.obj);
        const mesh = b.obj as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose();
        this.bits.splice(i, 1);
      }
    }
  }

  private emit(force: boolean, now = performance.now()) {
    if (!force && now - this.hudAt < 100) return;
    this.hudAt = now;
    const t = this.trees[this.current];
    const other = this.angle > 0 ? t.cut.bottom : t.cut.top;
    this.hooks.hud({
      mode: this.mode,
      leftMs: this.mode === "chop" ? Math.max(0, FELL_ROUND_MS - (now - this.roundStart)) : FELL_ROUND_MS,
      current: this.current,
      angle: this.angle,
      trees: this.trees.map((tree) => {
        const growing = now < tree.fellAt + REGROW_MS;
        return { progress: growing ? 0 : Math.min(1, tree.cut.floor / FELL_DEPTH), growing };
      }),
      felled: this.felled,
      bound: this.boundNow(t),
      otherCut: other > t.cut.floor + 1e-6,
      pop: this.pop,
    });
  }
}

/** For the panel: how thick each tree is, in words. */
export const THICKNESS: Record<TreeSize, string> = { small: "Thin", medium: "Stout", large: "Thick" };
