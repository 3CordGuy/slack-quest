// Low-poly models of the gear, materials and gold: each icon name has a little model built from faceted
// shapes (flat-shaded, like the heroes in render/figures.ts) with its accent parts in the item's rarity
// colour. ui/voxel.ts poses and lights them, frames each one to its picture and inks the outline for the
// item icons; render/figures.ts puts the same weapons and shields in the heroes' hands (see HOLD there), so
// what a hero holds is what is in their bag.
//
// Units are roughly the 16x16 icon's pixels, y up, the item's front toward +z. A model is built upright and
// `lean` tips it in the picture (a long weapon lies on the diagonal), `spin` turns it about its own upright to
// show its depth, `tip` leans the top away to show a little of it.
//
// An icon with no model here, or one an admin has redrawn, is still shown as its pixel art in blocks.

import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { C } from "../artKit";

type V3 = [number, number, number];

interface Place {
  at?: V3;
  rot?: V3;
  scale?: V3 | number;
}

/** Paint for one part: a colour, or a colour that glows (crystals, runes, eyes in the dark). */
type Paint = string | { glow: string };

export interface Kit {
  /** The rarity colour, and a darker shade of it. */
  a: string;
  s: string;
  add(geo: THREE.BufferGeometry, paint: Paint | Paint[], place?: Place): THREE.Mesh;
  /** A box with its edges cut off by `bevel`, so it catches the light on every corner. */
  box(w: number, h: number, d: number, paint: Paint, place?: Place, bevel?: number): THREE.Mesh;
  cyl(rTop: number, rBottom: number, h: number, sides: number, paint: Paint | Paint[], place?: Place): THREE.Mesh;
  cone(r: number, h: number, sides: number, paint: Paint, place?: Place): THREE.Mesh;
  ball(r: number, paint: Paint, place?: Place, detail?: number): THREE.Mesh;
  /** A cut crystal: eight faces, `h` tall. */
  gem(r: number, h: number, paint: Paint, place?: Place): THREE.Mesh;
  /** A dome, open at the bottom, `sides` round. */
  dome(r: number, sides: number, paint: Paint, place?: Place): THREE.Mesh;
  /** A shape turned about the upright: [radius, y] from the bottom up. */
  lathe(profile: [number, number][], sides: number, paint: Paint, place?: Place): THREE.Mesh;
  /** A flat outline ([x, y] round it) given `depth`, edges bevelled, centred front to back. */
  plate(outline: [number, number][], depth: number, paint: Paint, place?: Place, bevel?: number): THREE.Mesh;
  /** A round bar bent through `points`. */
  rod(points: V3[], r: number, paint: Paint, place?: Place, sides?: number): THREE.Mesh;
  ring(R: number, r: number, paint: Paint, place?: Place, radial?: number, tubular?: number): THREE.Mesh;
  /** The tightest solid round some points. */
  hull(points: V3[], paint: Paint, place?: Place): THREE.Mesh;
  /** Build some parts together, placed as one (a pair of daggers, a pair of boots). */
  within(place: Place, build: () => void): void;
  /**
   * Build some parts that hang loose from `pivot` (a flail's ball on its chain, a lantern from its hook), in the
   * model's own units as usual: in a hero's hand they swing from there as a pendulum (see figures.ts), weighted
   * at `bob`. In a picture they stay as built.
   */
  dangle(pivot: V3, bob: V3, build: () => void, opts?: Pick<Dangle, "limit" | "clear" | "size" | "mass">): void;
}

/** What a group made by Kit.dangle carries in its userData. */
export interface Dangle {
  pivot: V3;
  bob: V3;
  /** How far it may swing from where it was built, in radians (a clapper inside its bell). */
  limit?: number;
  /** A haft or pole it cannot swing through: the weight is kept `r` from the line `from` to `to`. */
  clear?: { from: V3; to: V3; r: number };
  /** How big the weight is round `bob`, for keeping it off the body of whoever holds it. */
  size?: number;
  /**
   * How heavy it is at `bob`, against what hangs below it (1 if not given): a length of chain is light beside the
   * ball on its end, so the ball pulls it straight. A dangle built inside another hangs from its end (its `pivot`
   * is the outer one's `bob`), making a chain of joints.
   */
  mass?: number;
}

export interface LowPolyDef {
  build: (k: Kit) => void;
  lean?: number;
  spin?: number;
  tip?: number;
  /** Extra room round the model in its picture, as a share of its size (small things look better smaller). */
  pad?: number;
  /** What one hand holds, when the picture shows more than that (one of a pair of daggers). */
  inHand?: (k: Kit) => void;
}

const DIAG = -Math.PI / 4;

/** Points of a blade `len` long, `w` wide and `t` thick, the last `tip` tapering to a point; diamond in section. */
const bladePoints = (len: number, w: number, t: number, tip: number, from = 0): V3[] => {
  const pts: V3[] = [];
  for (const y of [from, from + len - tip]) pts.push([-w / 2, y, 0], [w / 2, y, 0], [0, y, t / 2], [0, y, -t / 2]);
  pts.push([0, from + len, 0]);
  return pts;
};

/** A box's corners each cut back by `b` along all three edges: the 24 points of a chamfered box. */
const chamferPoints = (w: number, h: number, d: number, b: number): V3[] => {
  const pts: V3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = (sx * w) / 2;
        const y = (sy * h) / 2;
        const z = (sz * d) / 2;
        pts.push([x - sx * b, y, z], [x, y - sy * b, z], [x, y, z - sz * b]);
      }
  return pts;
};

/**
 * The outline of a curved, single-edged blade, for a plate: `len` long from y = 3, its edge toward +x and its
 * point swept back toward -x by `sweep` at the tip. It is `w0` wide at the hilt and `w1` at its broadest, two
 * thirds of the way up, and comes to its point over the last `tip` of its length, the edge rounding in to
 * meet the back.
 */
const curvedBlade = (len: number, sweep: number, w0: number, w1: number, tip: number): [number, number][] => {
  const STEPS = 12;
  const at = (i: number) => {
    const t = i / STEPS;
    const wide = w0 + (w1 - w0) * Math.sin(Math.min(1, t / 0.66) * (Math.PI / 2));
    const taper = t > 1 - tip ? Math.sqrt(Math.max(0, (1 - t) / tip)) : 1;
    return { y: 3 + len * t, x: -sweep * t * t, half: (wide / 2) * taper };
  };
  const edge: [number, number][] = [];
  const back: [number, number][] = [];
  for (let i = 0; i <= STEPS; i++) {
    const p = at(i);
    edge.push([p.x + p.half * 1.25, p.y]);
    if (i < STEPS) back.unshift([p.x - p.half * 0.75, p.y]);
  }
  return [...edge, ...back];
};

const v3 = ([x, y, z]: V3) => new THREE.Vector3(x, y, z);

/** A horn: a cone curled toward +x (or -x), `h` long, its base at the origin. */
function hornGeometry(r: number, h: number, curl: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, 6, 5);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setX(i, p.getX(i) + curl * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** Push each corner of a rough solid in or out a little, the same way every time, so a stone looks hewn. */
function roughen(geo: THREE.BufferGeometry, by: number, seed: number): THREE.BufferGeometry {
  const g = mergeVertices(geo);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const n = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    const k = 1 + by * ((n - Math.floor(n)) * 2 - 1);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  return g;
}

// ---------- shared pieces ----------

/** A book standing, its cover toward you: covers, pages, a rounded spine, gold corners. */
function book(k: Kit, cover: Paint, spine: Paint, corner: Paint) {
  k.box(10.5, 13, 0.8, cover, { at: [0, 0, -1.5] }, 0.2);
  k.box(10.5, 13, 0.8, cover, { at: [0, 0, 1.5] }, 0.2);
  k.box(9.8, 12.2, 2.4, C.paper, { at: [0.35, 0, 0] });
  k.cyl(1.9, 1.9, 13, 6, spine, { at: [-5, 0, 0] });
  for (const y of [5.7, -5.7]) k.box(1.7, 1.7, 0.35, corner, { at: [4.5, y, 1.95] }, 0.1);
}

/** A short bow's stave, tips and grip, unstrung: the grip at (3.2, 0, 0), the tips at (-0.5, ±8, 0). */
function bowStave(k: Kit) {
  const stave: V3[] = Array.from({ length: 9 }, (_, i) => {
    const y = -8 + i * 2;
    const t = y / 8;
    return [3.2 * (1 - t * t) - 0.5 * t ** 6, y, 0];
  });
  k.rod(stave, 0.6, C.wood, {}, 6);
  for (const y of [-8, 8]) k.ball(0.6, C.bark, { at: [-0.5, y, 0] });
  k.cyl(0.85, 0.85, 2.8, 6, k.a, { at: [3.2, 0, 0] });
}

/** A dagger, its guard at the origin. */
function dagger(k: Kit) {
  k.hull(bladePoints(8, 1.9, 0.75, 2.6, 0.3), C.steel);
  k.box(4.6, 0.8, 1.2, C.gold, {}, 0.25);
  k.cyl(0.5, 0.55, 2.8, 6, C.bark, { at: [0, -1.8, 0] });
  k.ball(0.8, k.a, { at: [0, -3.5, 0] });
}

/** A gaff hook, its collar at the origin: a bound wooden grip, a steel shank curling over into a barbed point toward +x. */
function gaffHook(k: Kit) {
  k.cyl(0.6, 0.7, 4.4, 6, C.wood, { at: [0, -2.2, 0] });
  for (const y of [-3.3, -1.2]) k.cyl(0.74, 0.74, 0.4, 6, C.leather, { at: [0, y, 0] });
  k.ball(0.75, C.iron, { at: [0, -4.6, 0] });
  k.cyl(0.85, 0.85, 0.9, 6, k.a, { at: [0, 0.3, 0] });
  k.rod([[0, 0.6, 0], [0, 4.5, 0], [0.5, 6.8, 0], [2.2, 7.8, 0], [3.9, 6.9, 0], [4.3, 5, 0]], 0.42, C.steel, {}, 6);
  k.cone(0.5, 1.6, 4, C.shine, { at: [4.3, 4.2, 0], rot: [0, 0, Math.PI] });
  k.cone(0.25, 1.1, 4, C.steel, { at: [4.6, 3.9, 0], rot: [0, 0, -0.6] });
}

/** A cone pointing out from `centre` along `dir`, its base `out` from the centre: a spike on a ball. */
function spike(k: Kit, centre: V3, dir: THREE.Vector3, out: number, r: number, h: number, paint: Paint) {
  const d = dir.clone().normalize();
  const turn = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
  k.cone(r, h, 4, paint, { at: [centre[0] + d.x * (out + h / 2), centre[1] + d.y * (out + h / 2), centre[2] + d.z * (out + h / 2)], rot: [turn.x, turn.y, turn.z] });
}

/** One boot, toe toward +z. */
/** The ballast flail: the haft, and the chain and ball, which hang loose (`loose`: in a hand, a straight chain that swings). */
function flail(k: Kit, loose: boolean) {
  k.cyl(0.6, 0.7, 10, 6, C.wood, { at: [0, -1, 0] });
  k.cyl(0.8, 0.8, 3, 6, C.leather, { at: [0, -3.8, 0] });
  k.ball(0.85, C.gold, { at: [0, -6.4, 0] });
  k.cyl(0.95, 0.85, 1.2, 6, k.a, { at: [0, 4.4, 0] });
  k.ring(0.7, 0.22, C.iron, { at: [0, 5.5, 0], rot: [0, Math.PI / 2, 0] }, 4, 8);
  const ball: V3 = [5.9, 3.4, 0];
  const pivot: V3 = [0, 6.1, 0];
  const links = (chain: THREE.Curve<THREE.Vector3>, n: number, last: boolean, first = 0) => {
    for (let i = 0; i <= n; i++) {
      if (i === n && !last) continue;
      const t = i / n;
      const at = chain.getPoint(t);
      const along = chain.getTangent(t);
      const link = k.ring(0.55, 0.18, C.iron, { at: [at.x, at.y, at.z], scale: [1.5, 1, 1] }, 4, 6);
      link.rotation.order = "ZYX";
      link.rotation.set((first + i) % 2 ? Math.PI / 2 : 0, 0, Math.atan2(along.y, along.x));
    }
  };
  const head = () => {
    k.ball(2.4, C.iron, { at: ball }, 1);
    k.ring(2.42, 0.32, k.a, { at: ball, rot: [Math.PI / 2, 0, 0] }, 4, 16);
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const seen = new Set<string>();
    const p = ico.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const d = new THREE.Vector3().fromBufferAttribute(p, i);
      const key = d.toArray().map((n) => n.toFixed(2)).join();
      if (seen.has(key) || Math.abs(d.y) < 0.2) continue;
      seen.add(key);
      spike(k, ball, d, 2.1, 0.45, 1.4, C.steel);
    }
    ico.dispose();
  };
  const weight = { clear: { from: [0, 5.5, 0] as V3, to: [0, -7, 0] as V3, r: 3 }, size: 3 };
  if (!loose) {
    // The picture: one chain curled over from the ring to the ball.
    k.dangle(pivot, ball, () => {
      links(new THREE.CatmullRomCurve3([v3(pivot), v3([1.6, 7.6, 0]), v3([3.7, 7.6, 0]), v3([5.3, 6.1, 0])]), 7, true);
      head();
    }, weight);
    return;
  }
  // In hand: a straight chain, jointed half way, so it bends as it swings; the ball on the lower half.
  const end = v3(ball).lerp(v3(pivot), 2.2 / Math.hypot(ball[0] - pivot[0], ball[1] - pivot[1]));
  const knee = v3(pivot).lerp(end, 0.5);
  const kneeAt = knee.toArray() as V3;
  k.dangle(pivot, kneeAt, () => {
    links(new THREE.LineCurve3(v3(pivot), knee), 2, false);
    k.dangle(kneeAt, ball, () => {
      links(new THREE.LineCurve3(knee, end), 2, true, 2);
      head();
    }, weight);
  }, { size: 0.6, mass: 0.25 });
}

function boot(k: Kit) {
  k.cyl(1.9, 2.1, 7, 6, C.leather, { at: [0, 2.5, 0] });
  k.box(3.8, 2.8, 7, C.leather, { at: [0, -1.5, 1.6] }, 0.9);
  k.box(4, 0.8, 7.6, C.bark, { at: [0, -3.2, 1.8] }, 0.25);
  k.box(3.2, 1.2, 2, C.bark, { at: [0, -3.8, -1.3] }, 0.2);
  k.cyl(2.45, 2.35, 1.6, 6, k.a, { at: [0, 6.6, 0] });
}

/** Three cast bars, two below and one across them. */
function ingots(k: Kit, color: string) {
  const bar: V3[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar.push([sx * 4.4, 0, sz * 1.9], [sx * 3.4, 2.2, sz * 1.2]);
  k.hull(bar, color, { at: [0, -2.2, -2.2] });
  k.hull(bar, color, { at: [0, -2.2, 2.2] });
  k.hull(bar, color, { at: [0, 0.05, 0], rot: [0, Math.PI / 2, 0] });
}

/** A mushroom of size `s` standing at (x, z). */
function mushroom(k: Kit, x: number, z: number, s: number) {
  k.cyl(0.85 * s, 1.1 * s, 4 * s, 6, C.paper, { at: [x, 2 * s, z] });
  k.cyl(2.8 * s, 2.8 * s, 0.25, 8, "#e8d6b0", { at: [x, 4 * s, z] });
  k.dome(3 * s, 8, "#b8452f", { at: [x, 4 * s, z], scale: [1, 0.7, 1] });
  for (const [a, up] of [[0.4, 0.55], [2.3, 0.6], [4.1, 0.5], [5.4, 0.85]] as const) {
    const r = 3 * s * Math.cos(up);
    k.ball(0.5 * s, C.paper, { at: [x + Math.cos(a) * r, 4 * s + 2.1 * s * Math.sin(up), z + Math.sin(a) * r] });
  }
}

/** A heart's outline, `size` across, its point at the bottom. */
const heartOutline = (size: number): [number, number][] =>
  Array.from({ length: 18 }, (_, i) => {
    const t = (i / 18) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [(x * size) / 32, (y * size) / 32] as [number, number];
  });

// ---------- the models ----------

export const LOW_POLY: Record<string, LowPolyDef> = {
  // ---- weapons ----
  broadsword: {
    lean: DIAG,
    build: (k) => {
      k.hull(bladePoints(13.5, 2.7, 0.9, 3.2, 3), C.steel);
      k.box(8, 1.1, 1.6, C.gold, { at: [0, 2.7, 0] }, 0.3);
      for (const x of [-4.1, 4.1]) k.ball(0.75, C.gold, { at: [x, 2.7, 0] });
      k.cyl(0.6, 0.65, 3.8, 6, C.bark, { at: [0, 0.3, 0] });
      k.ball(1.15, k.a, { at: [0, -2, 0] });
    },
  },
  "hammer-drop": {
    lean: -0.6,
    spin: 0.6,
    build: (k) => {
      k.cyl(0.6, 0.7, 12, 6, C.wood, { at: [0, 0, 0] });
      k.box(8, 5, 5, C.iron, { at: [0, 7.5, 0] }, 0.8);
      for (const x of [-4.3, 4.3]) k.cyl(2.1, 2.1, 0.8, 8, C.steel, { at: [x, 7.5, 0], rot: [0, 0, Math.PI / 2] });
      k.gem(1.3, 2, { glow: k.a }, { at: [0, 7.5, 2.7], rot: [Math.PI / 2, 0, 0] });
      k.cyl(0.95, 0.95, 0.8, 6, C.gold, { at: [0, 4.6, 0] });
      k.ball(1, C.gold, { at: [0, -6.3, 0] });
    },
  },
  "wizard-staff": {
    lean: DIAG,
    build: (k) => {
      k.cyl(0.55, 0.7, 17, 6, C.wood, { at: [0, -1.5, 0] });
      k.cyl(0.8, 0.8, 2.6, 6, C.leather, { at: [0, -1, 0] });
      k.cyl(1, 0.7, 1, 6, C.gold, { at: [0, 7.4, 0] });
      // A carved head, verdigris-green like old ship fittings, round a gem that throws teal light.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        k.rod([[0, 7.6, 0], [Math.cos(a) * 1.8, 9.5, Math.sin(a) * 1.8], [Math.cos(a) * 1.1, 11.6, Math.sin(a) * 1.1]], 0.3, "#3f8f86", {}, 4);
      }
      k.gem(1.5, 3.8, { glow: "#5fe6e0" }, { at: [0, 10.2, 0] });
    },
  },
  "scroll-unfurled": {
    // A closed tome.
    spin: 0.55,
    tip: 0.25,
    lean: 0.12,
    build: (k) => {
      book(k, k.a, k.s, C.gold);
      k.cyl(2.4, 2.4, 0.5, 6, C.gold, { at: [0.5, 1, 1.95], rot: [Math.PI / 2, 0, 0] });
      k.cyl(1.2, 1.2, 0.4, 6, k.s, { at: [0.5, 1, 2.25], rot: [Math.PI / 2, 0, 0] });
      k.box(0.8, 2.6, 0.2, C.gold, { at: [2, -7.4, 0] });
    },
  },
  daggers: {
    spin: 0.3,
    inHand: dagger,
    build: (k) => {
      k.within({ at: [0, 0, -0.5], rot: [0, 0, 0.62] }, () => dagger(k));
      k.within({ at: [0, 0, 0.5], rot: [0, 0, -0.62] }, () => dagger(k));
    },
  },
  crossbow: {
    // A short bow with an arrow nocked: the stave on one diagonal, the arrow on the other.
    lean: -DIAG,
    spin: 0.3,
    // In an archer's hand, the stave alone: the figure strings it and nocks an arrow of its own, to draw (see figures.ts).
    inHand: bowStave,
    build: (k) => {
      bowStave(k);
      k.cyl(0.12, 0.12, 16, 3, C.paper, { at: [-0.5, 0, 0] });
      k.cyl(0.25, 0.25, 10.5, 4, C.paper, { at: [3.6, 0, 0.9], rot: [0, 0, Math.PI / 2] });
      k.cone(0.75, 2, 4, C.steel, { at: [9.6, 0, 0.9], rot: [0, 0, -Math.PI / 2] });
      for (const r of [0, Math.PI / 2]) k.box(2.4, 1.3, 0.12, k.a, { at: [-0.4, 0, 0.9], rot: [r, 0, 0] });
    },
  },
  "root-staff": {
    // A crooked staff, roots curled round a stone at the head, a leaf budding.
    lean: DIAG,
    build: (k) => {
      k.rod([[0, -10, 0], [0.6, -5, 0.3], [-0.5, 0, 0], [0.7, 4, -0.3], [0, 7.2, 0]], 0.75, C.wood, {}, 6);
      k.ball(0.75, C.wood, { at: [0, -10, 0] });
      k.rod([[0, 7, 0], [-1.6, 8.5, 0.5], [-2.5, 10.5, 0], [-1.3, 12.2, 0]], 0.45, C.wood, {}, 5);
      k.rod([[0, 7, 0], [1.5, 9, -0.3], [2.3, 11, 0.2], [1.2, 12.7, 0.4]], 0.45, C.bark, {}, 5);
      k.rod([[0, 7, 0], [0.2, 9.5, 0.9], [-0.3, 11.8, 0.5]], 0.4, C.bark, {}, 5);
      k.ball(1.4, { glow: k.a }, { at: [0, 10.4, 0] });
      k.add(new THREE.OctahedronGeometry(1), "#a6d06a", { at: [2.3, 4.6, 0.2], rot: [0, 0, -0.9], scale: [1.2, 2.1, 0.35] });
      k.add(new THREE.OctahedronGeometry(1), "#7fae4a", { at: [-1.9, 1.4, 0], rot: [0, 0, 0.8], scale: [1, 1.8, 0.3] });
    },
  },
  sickle: {
    lean: -0.25,
    spin: 0.5,
    build: (k) => {
      k.cyl(0.7, 0.6, 7, 6, C.wood, { at: [0, -3.5, 0] });
      k.cyl(0.85, 0.85, 1, 6, k.a, { at: [0, 0.2, 0] });
      const deg = Math.PI / 180;
      const outline: [number, number][] = [];
      for (let d = 200; d >= -20; d -= 20) outline.push([3.5 + 4.6 * Math.cos(d * deg), 2.5 + 4.6 * Math.sin(d * deg)]);
      outline.push([8.4, -0.5]);
      for (let d = -20; d <= 200; d += 20) outline.push([3.9 + 3.3 * Math.cos(d * deg), 2 + 3.3 * Math.sin(d * deg)]);
      k.plate(outline, 0.5, C.steel, {}, 0.15);
    },
  },
  lute: {
    lean: DIAG,
    spin: 0.4,
    build: (k) => {
      k.dome(4.5, 10, C.leather, { at: [0, -3, 0], rot: [-Math.PI / 2, 0, 0], scale: [1, 0.6, 1.25] });
      k.cyl(4.5, 4.5, 0.4, 10, "#c99a5c", { at: [0, -3, 0.2], rot: [Math.PI / 2, 0, 0], scale: [1, 1, 1.25] });
      k.cyl(1.3, 1.3, 0.2, 8, C.dark, { at: [0, -1.4, 0.45], rot: [Math.PI / 2, 0, 0] });
      k.box(3, 0.6, 0.5, C.bark, { at: [0, -5.6, 0.6] });
      k.box(1.8, 9, 1, C.wood, { at: [0, 5.6, 0.2] });
      k.box(1.5, 9, 0.3, C.bark, { at: [0, 5.6, 0.85] });
      k.box(2, 3.2, 1, k.a, { at: [0, 11.3, -0.8], rot: [-0.6, 0, 0] }, 0.2);
      for (const x of [-0.5, -0.17, 0.17, 0.5]) k.box(0.12, 15.6, 0.12, C.paper, { at: [x, 2.2, 1.08] });
    },
  },
  flute: {
    lean: DIAG,
    spin: 0,
    build: (k) => {
      k.cyl(0.85, 0.85, 16, 8, C.paper, {});
      k.cyl(1.02, 1.02, 0.9, 8, k.a, { at: [0, 7.1, 0] });
      k.cyl(1.02, 1.02, 0.7, 8, C.gold, { at: [0, -7.5, 0] });
      k.cyl(1.02, 1.02, 0.5, 8, C.gold, { at: [0, 3.6, 0] });
      k.cyl(0.48, 0.48, 0.3, 6, C.dark, { at: [0, 5.4, 0.78], rot: [Math.PI / 2, 0, 0] });
      for (const y of [1.6, -0.2, -2, -3.8, -5.6]) k.cyl(0.36, 0.36, 0.3, 6, C.dark, { at: [0, y, 0.78], rot: [Math.PI / 2, 0, 0] });
    },
  },
  accordion: {
    // A squeeze box, built along its length (y), the top edge toward -x: a lacquered end board at each end, the
    // treble one keyed on its face and the bass one studded with buttons, pleated bellows between and a strap
    // along the top in the rarity colour. Laid on its side in the picture; held by an end board in each hand.
    lean: -Math.PI / 2,
    spin: 0.35,
    tip: 0.15,
    build: (k) => {
      const lacquer = "#b8333a";
      for (const s of [-1, 1]) {
        k.box(7.4, 2.2, 4.6, lacquer, { at: [0, s * 6.4, 0] }, 0.3);
        k.box(7.6, 0.35, 4.8, C.gold, { at: [0, s * 7.6, 0] }, 0.1);
      }
      // The bellows: folds standing out pale, and the dark between them.
      for (let i = 0; i <= 20; i++) {
        const y = -5 + i * 0.5;
        if (i % 2 === 0) k.box(6.9, 0.32, 4.3, C.paper, { at: [0, y, 0] }, 0.08);
        else k.box(6.2, 0.5, 3.7, C.dark, { at: [0, y, 0] });
      }
      // The treble keys, white with the black among them, and the bass buttons.
      for (let i = 0; i < 7; i++) k.box(0.8, 1.6, 0.35, C.bone, { at: [-2.7 + i * 0.9, -6.5, 2.42] }, 0.06);
      for (const i of [0, 1, 3, 4, 5]) k.box(0.45, 0.9, 0.3, C.dark, { at: [-2.25 + i * 0.9, -6.1, 2.66] });
      for (const x of [-2.1, -0.7, 0.7, 2.1]) for (const y of [5.9, 6.9]) k.cyl(0.32, 0.32, 0.3, 6, C.shine, { at: [x, y, 2.42], rot: [Math.PI / 2, 0, 0] });
      k.box(0.5, 10.6, 1.6, k.a, { at: [-3.95, 0, -1.1] }, 0.1);
    },
  },
  orb: {
    lean: -0.2,
    build: (k) => {
      k.add(new THREE.IcosahedronGeometry(4.6, 1), { glow: k.a }, { at: [0, 3.6, 0] });
      k.ball(0.9, C.shine, { at: [-1.7, 5.3, 3.8] });
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        k.rod([[0, -1.5, 0], [Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6], [Math.cos(a) * 3.8, 2.4, Math.sin(a) * 3.8]], 0.35, C.gold, {}, 4);
      }
      k.cyl(1.4, 0.9, 1.2, 6, C.gold, { at: [0, -1.5, 0] });
      k.cyl(0.7, 0.8, 6, 6, C.wood, { at: [0, -5, 0] });
      k.ball(0.85, C.gold, { at: [0, -8.2, 0] });
    },
  },
  scepter: {
    lean: DIAG,
    build: (k) => {
      k.cyl(0.55, 0.65, 13, 6, C.gold, { at: [0, -3, 0] });
      for (const y of [-9.6, -2.2]) k.cyl(0.9, 0.9, 0.6, 6, "#b8891f", { at: [0, y, 0] });
      k.lathe([[0, 3.2], [1.6, 3.6], [2.6, 5], [2.4, 6.6], [1.4, 7.5], [0, 7.8]], 6, C.gold);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        k.cone(0.4, 1.4, 4, C.gold, { at: [Math.cos(a) * 1.9, 7.7, Math.sin(a) * 1.9] });
      }
      k.gem(1.4, 2.9, { glow: k.a }, { at: [0, 9, 0] });
    },
  },
  "pager-axe": {
    // A long haft and a broad bearded blade.
    lean: DIAG,
    spin: 0.4,
    build: (k) => {
      k.cyl(0.6, 0.7, 20, 6, C.wood, { at: [0, -2, 0] });
      for (const y of [-10, 2.4]) k.cyl(0.82, 0.82, 1.3, 6, k.a, { at: [0, y, 0] });
      k.ball(0.8, C.iron, { at: [0, 8.2, 0] });
      k.box(1.8, 5, 1.6, C.iron, { at: [0, 5.4, 0] }, 0.3);
      k.plate([[0.6, 7.6], [3, 7.9], [6.2, 9.6], [6.9, 6], [6.5, 2], [5.2, -0.8], [3.6, 1.5], [1.8, 3.1], [0.6, 3.3]], 0.6, C.steel, {}, 0.22);
      k.cone(0.6, 2.6, 4, C.iron, { at: [-1.9, 5.6, 0], rot: [0, 0, Math.PI / 2] });
    },
  },
  maul: {
    // A ship's anchor swung upside down, rusted and hung with weed: gripped low on a broad flat shank, the eye
    // and a length of chain under the fist, and up top a pointed crown whose arms spread in a wide, shallow arc
    // to big barbed flukes. Rope wound round the grip, banded in the accent.
    lean: DIAG,
    spin: 0.5,
    build: (k) => {
      const rust = "#7a4b34";
      const dark = "#5a3626";
      const weed = "#6f6a2c";
      k.box(1.7, 18, 1.1, rust, { at: [0, -1.2, 0] }, 0.25);
      k.cyl(1.15, 1.15, 3.6, 6, C.leather, { at: [0, -9, 0] });
      k.cyl(1.2, 1.2, 0.6, 6, k.a, { at: [0, -7, 0] });
      k.ring(1.45, 0.42, dark, { at: [0, -12.5, 0] }, 6, 10);
      k.ring(0.75, 0.22, C.iron, { at: [0, -14.6, 0], rot: [0, Math.PI / 2, 0] }, 4, 8);
      k.ring(0.75, 0.22, C.iron, { at: [0, -15.9, 0] }, 4, 8);
      // The crown and arms: one broad crescent, pointed at the top.
      k.plate([[-6.9, 6.7], [-5.4, 8.5], [-3, 9.6], [0, 11], [3, 9.6], [5.4, 8.5], [6.9, 6.7], [6, 6.1], [4.6, 7.3], [2.6, 8.1], [0.9, 8.3], [-0.9, 8.3], [-2.6, 8.1], [-4.6, 7.3], [-6, 6.1]], 1.4, rust, {}, 0.3);
      for (const s of [-1, 1]) {
        // A fluke: a spade on the arm's end, its point down toward the fist and a barb out to the side.
        const f: [number, number][] = [[5.3, 7.3], [6.8, 8.2], [9, 7.8], [7.8, 6.6], [6.6, 3.5]];
        k.plate(s > 0 ? f : f.map(([x, y]) => [-x, y] as [number, number]).reverse(), 0.9, dark, {}, 0.2);
      }
      // Weed hanging off the arms and wound round the shank.
      for (const [x, z] of [[2.6, 0.8], [-4.4, -0.75], [5.6, 0.6]]) {
        k.rod([[x, 9.2 - Math.abs(x) * 0.25, z], [x + 0.3, 7, z * 1.1], [x - 0.2, 5.2, z], [x + 0.2, 4, z * 0.9]], 0.18, weed, {}, 4);
      }
      k.rod([[0.95, 6, 0.7], [-0.95, 4.6, 0.7], [-0.95, 4, -0.7], [0.95, 2.6, -0.7], [0.95, 2, 0.7], [-0.6, 0.6, 0.75], [-0.3, -1.4, 0.8]], 0.2, weed, {}, 4);
    },
  },
  grimoire: {
    // A dark book, clasped, with a glowing sigil on the cover.
    spin: 0.55,
    tip: 0.25,
    lean: 0.12,
    build: (k) => {
      book(k, "#2e2440", "#3a2a4a", C.iron);
      k.ring(2.5, 0.35, { glow: k.a }, { at: [0.4, 0.6, 2.05] }, 4, 10);
      k.gem(0.9, 1.8, { glow: k.a }, { at: [0.4, 0.6, 2.2] });
      k.box(2.2, 2.4, 4.4, C.gold, { at: [5.3, 0, 0] }, 0.3);
    },
  },
  // ---- sea blades: built like the broadsword (the blade up from y = 3, the grip at the origin), a curved one
  // with its edge toward +x, so the picture shows the curve; in the hand it is turned edge on (see figures.ts).
  cutlass: {
    // A sailor's cutlass: a short, broad, curved blade with a clipped point, and a brass shell and bow round the hand.
    lean: DIAG,
    build: (k) => {
      k.plate(curvedBlade(12.5, 2.4, 2.2, 3.1, 0.3), 0.7, C.steel, {}, 0.25);
      k.box(0.5, 9, 0.2, C.shine, { at: [-0.9, 8, 0.4], rot: [0, 0, 0.14] });
      k.cyl(2.1, 1.7, 0.6, 10, C.gold, { at: [0.3, 2.7, 0] });
      k.rod([[2.0, 2.6, 0], [3.0, 0.9, 0], [2.6, -1.3, 0], [0.5, -2.1, 0]], 0.38, C.gold, {}, 5);
      k.cyl(0.62, 0.68, 3.8, 6, C.bark, { at: [0, 0.3, 0] });
      k.ball(1.1, k.a, { at: [0, -2.1, 0] });
    },
  },
  sabre: {
    // An officer's sabre: a long, slim blade with a deep curve, a slender guard and knuckle bow, a wired grip.
    lean: DIAG,
    build: (k) => {
      k.plate(curvedBlade(15.5, 3.6, 1.5, 1.7, 0.22), 0.55, C.steel, {}, 0.2);
      k.box(4.2, 0.6, 1.1, C.gold, { at: [0.2, 2.75, 0] }, 0.2);
      k.ball(0.5, C.gold, { at: [-2, 2.75, 0] });
      k.rod([[2.2, 2.7, 0], [2.9, 1.0, 0], [2.4, -1.3, 0], [0.4, -2.2, 0]], 0.26, C.gold, {}, 5);
      k.cyl(0.55, 0.6, 4, 6, C.dark, { at: [0, 0.3, 0] });
      for (const y of [-0.7, 0.3, 1.3]) k.cyl(0.66, 0.66, 0.22, 6, C.gold, { at: [0, y, 0] });
      k.ball(0.95, k.a, { at: [0, -2.2, 0] });
    },
  },
  rapier: {
    // A rapier: a long, narrow, straight blade for the point, behind a cup, a ring and long quillons, with a knuckle bow.
    lean: DIAG,
    build: (k) => {
      k.hull(bladePoints(16, 1.0, 0.7, 4, 3), C.steel);
      k.lathe([[0.5, 2.2], [1.7, 2.6], [2.2, 3.4], [2.3, 3.9]], 10, C.steel);
      k.box(7, 0.5, 0.6, C.gold, { at: [0, 2.3, 0] }, 0.15);
      for (const x of [-3.6, 3.6]) k.ball(0.5, C.gold, { at: [x, 2.3, 0] });
      k.rod([[2.0, 2.3, 0], [2.6, 0.7, 0], [2.1, -1.4, 0], [0.4, -2.2, 0]], 0.24, C.gold, {}, 5);
      k.cyl(0.5, 0.55, 3.8, 6, C.bark, { at: [0, 0.2, 0] });
      k.ball(0.95, k.a, { at: [0, -2.2, 0] });
    },
  },
  dirk: {
    // A midshipman's dirk: a short straight blade, a small brass cross, an ivory grip and a capped pommel.
    lean: DIAG,
    pad: 0.25,
    build: (k) => {
      k.hull(bladePoints(9, 1.7, 0.7, 3, 3), C.steel);
      k.box(4.4, 0.8, 1.3, C.gold, { at: [0, 2.7, 0] }, 0.25);
      for (const x of [-2.3, 2.3]) k.ball(0.55, C.gold, { at: [x, 2.7, 0] });
      k.cyl(0.55, 0.6, 3.4, 6, C.bone, { at: [0, 0.5, 0] });
      k.ball(0.95, k.a, { at: [0, -1.6, 0] });
    },
  },
  // ---- guns and the crossbow: the barrel up the model, muzzle at the top. A gun's grip and stock fall away
  // toward -x, so the picture shows it side on; the crossbow's top is toward +z, so the picture looks down on
  // its bow. In the hand they are turned to point ahead (see GUN and BOLT in figures.ts).
  pistol: {
    // A flintlock: an iron barrel on a walnut stock, a curved grip with a capped butt, a cock and a brass guard.
    lean: -0.7,
    spin: 0.25,
    build: (k) => {
      k.cyl(0.75, 0.9, 9.5, 8, C.iron, { at: [0, 3.2, 0] });
      k.cyl(1.0, 1.0, 0.6, 8, C.steel, { at: [0, 7.7, 0] });
      k.cyl(0.5, 0.5, 0.2, 8, C.dark, { at: [0, 8.02, 0] });
      k.box(1.6, 8, 1.5, C.wood, { at: [-0.95, 1.6, 0] }, 0.35);
      k.box(2.2, 2.6, 1.9, C.iron, { at: [-0.3, -2.4, 0] }, 0.35);
      k.rod([[-0.7, -3, 0], [-2.2, -4.8, 0], [-3.4, -7.2, 0]], 1.0, C.wood, {}, 6);
      k.ball(1.2, k.a, { at: [-3.6, -7.7, 0] });
      k.box(0.6, 1.9, 0.5, C.steel, { at: [1.0, -1.7, 0], rot: [0, 0, -0.55] });
      k.box(0.5, 0.7, 0.45, C.paper, { at: [1.5, -0.8, 0] });
      k.ring(1.0, 0.2, C.gold, { at: [-2.1, -3, 0] }, 4, 12);
      k.cyl(1.0, 1.0, 0.7, 8, k.a, { at: [0, 1.6, 0] });
    },
  },
  blunderbuss: {
    // A short, fat gun with a brass barrel belled out at the muzzle, a heavy stock and an iron butt plate.
    lean: DIAG,
    spin: 0.25,
    build: (k) => {
      const brass = "#c99a3a";
      k.lathe([[1.0, -4], [1.0, 4.5], [1.3, 7], [2.5, 9.6], [2.8, 10]], 10, brass);
      k.cyl(2.3, 2.3, 0.2, 10, C.dark, { at: [0, 9.6, 0] });
      k.cyl(1.15, 1.15, 0.7, 10, k.a, { at: [0, 0.5, 0] });
      k.cyl(1.2, 1.2, 0.6, 10, k.a, { at: [0, 4.4, 0] });
      k.box(1.9, 9.5, 1.8, C.wood, { at: [-1.0, -1.2, 0] }, 0.4);
      k.box(2.2, 2.8, 2.2, C.iron, { at: [-0.2, -4.8, 0] }, 0.35);
      k.box(0.6, 2, 0.5, C.steel, { at: [1.2, -4.1, 0], rot: [0, 0, -0.55] });
      // The stock: a narrow wrist where the hand closes, widening down and back to the shoulder.
      k.hull([[-0.2, -5.6, 0.85], [-0.2, -5.6, -0.85], [-2.0, -5.6, 0.85], [-2.0, -5.6, -0.85], [-1.5, -8, 0.8], [-1.5, -8, -0.8], [-3.0, -8, 0.8], [-3.0, -8, -0.8], [-2.2, -12.6, 1], [-2.2, -12.6, -1], [-5.6, -11.8, 1], [-5.6, -11.8, -1]], C.wood);
      k.box(3.9, 0.7, 2.2, C.iron, { at: [-3.9, -12.4, 0], rot: [0, 0, -0.24] }, 0.2);
      k.ring(1.1, 0.22, C.gold, { at: [-2.2, -6.4, 0] }, 4, 12);
    },
  },
  "harpoon-gun": {
    // A whaler's gun: a stout iron tube with a barbed harpoon standing out of it, a coil of line at its side,
    // a winding handle and a pistol grip.
    lean: DIAG,
    spin: 0.25,
    build: (k) => {
      const rope = "#c9b58a";
      k.cyl(1.15, 1.3, 9, 8, C.iron, { at: [0, 0, 0] });
      k.cyl(1.4, 1.4, 0.8, 8, k.a, { at: [0, 4.1, 0] });
      k.cyl(1.45, 1.45, 0.7, 8, k.a, { at: [0, -2.8, 0] });
      // The harpoon: a steel shaft, a broad head, and two barbs laid back from it.
      k.cyl(0.32, 0.32, 8, 5, C.steel, { at: [0, 8, 0] });
      k.hull(bladePoints(3.4, 2.2, 0.7, 2.4, 11.4), C.steel);
      for (const s of [-1, 1]) k.cone(0.45, 1.8, 4, C.steel, { at: [s * 1.0, 10.9, 0], rot: [0, 0, s * 2.55] });
      // The line: coiled at the side, and run up to the harpoon's shaft.
      for (const z of [-0.35, 0.35]) k.ring(1.9, 0.38, rope, { at: [2.6, -0.4, z] }, 5, 14);
      k.rod([[2.6, 1.5, 0], [1.4, 4.6, 0.5], [0.3, 7.2, 0.2]], 0.16, rope, {}, 4);
      k.box(1.9, 7, 1.8, C.wood, { at: [-1.1, -1.6, 0] }, 0.4);
      k.rod([[-1.0, -4.6, 0], [-2.6, -6.8, 0], [-3.6, -9.6, 0]], 1.05, C.wood, {}, 6);
      k.ball(1.2, C.iron, { at: [-3.8, -10.1, 0] });
      k.ring(1.0, 0.2, C.gold, { at: [-2.4, -4.8, 0] }, 4, 12);
      k.cyl(0.3, 0.3, 1.8, 5, C.steel, { at: [0, -3.9, 1.7], rot: [Math.PI / 2, 0, 0] });
      k.ball(0.5, C.gold, { at: [0, -3.9, 2.7] });
    },
  },
  "heavy-crossbow": {
    // A true crossbow, seen from above: a steel bow across a long tiller, the string drawn back to the nut,
    // a bolt in the groove, a stirrup at the nose and a long trigger under the stock.
    lean: DIAG,
    spin: 0.15,
    tip: 0.2,
    build: (k) => {
      k.box(1.9, 17, 1.6, C.wood, { at: [0, -1.5, 0] }, 0.4);
      k.hull([[-1.4, -8, 0.8], [1.4, -8, 0.8], [-1.4, -8, -0.8], [1.4, -8, -0.8], [-1.9, -11.6, 0.9], [1.9, -11.6, 0.9], [-1.9, -11.6, -0.9], [1.9, -11.6, -0.9]], C.wood);
      k.box(2.1, 1.6, 1.8, k.a, { at: [0, -6.4, 0] }, 0.3);
      // The bow, its tips swept back, lashed to the nose of the tiller.
      k.rod([[-7.4, 3.6, 0.2], [-4.6, 5.4, 0.2], [0, 6.2, 0.2], [4.6, 5.4, 0.2], [7.4, 3.6, 0.2]], 0.6, C.iron, {}, 6);
      for (const x of [-7.4, 7.4]) k.ball(0.7, C.steel, { at: [x, 3.6, 0.2] });
      k.box(2.3, 1.3, 2, C.leather, { at: [0, 6.2, 0.1] }, 0.3);
      // Drawn: the string back from each tip to the nut.
      k.rod([[-7.4, 3.6, 0.5], [0, -0.6, 0.9], [7.4, 3.6, 0.5]], 0.13, C.paper, {}, 4);
      k.cyl(0.55, 0.55, 0.6, 8, C.gold, { at: [0, -0.6, 0.9], rot: [0, 0, Math.PI / 2] });
      // The bolt in its groove, and the stirrup.
      k.cyl(0.22, 0.22, 7.6, 5, C.bark, { at: [0, 3.4, 1.0] });
      k.cone(0.55, 1.5, 4, C.steel, { at: [0, 7.9, 1.0] });
      for (const r of [0, Math.PI / 2]) k.box(1.3, 1.6, 0.1, k.a, { at: [0, 0.4, 1.0], rot: [0, r, 0] });
      k.ring(1.15, 0.22, C.iron, { at: [0, 8.2, 0], rot: [Math.PI / 2, 0, 0] }, 4, 12);
      k.box(0.4, 5, 0.4, C.steel, { at: [0, -4.4, -1.2], rot: [0.2, 0, 0] });
    },
  },
  "void-staff": {
    // A black staff with a hollow ring at the head and a spark inside it.
    lean: DIAG,
    build: (k) => {
      k.cyl(0.55, 0.7, 17, 6, C.dark, { at: [0, -1.5, 0] });
      for (const y of [-8.4, 0]) k.cyl(0.8, 0.8, 1, 6, "#4a3a6a", { at: [0, y, 0] });
      k.cyl(0.6, 1.1, 1.6, 6, C.dark, { at: [0, 7.4, 0] });
      k.ring(2.9, 0.6, C.dark, { at: [0, 10.6, 0] }, 5, 10);
      k.gem(1.15, 2.3, { glow: k.a }, { at: [0, 10.6, 0] });
      k.gem(0.5, 1, { glow: C.shine }, { at: [0, 10.6, 0.6], rot: [0, 0, Math.PI / 2] });
    },
  },

  // ---- signature weapons: each class's own, dropped by lairs and bosses ----
  "ballast-flail": {
    // A short haft, and on a chain from its head a spiked iron ballast ball banded in the trim.
    lean: -0.35,
    spin: 0.4,
    build: (k) => flail(k, false),
    // In hand the chain hangs straight from the ring, and swings.
    inHand: (k) => flail(k, true),
  },
  "barometer-rod": {
    // A staff with a barometer's dial set in it and a tube of glowing glass at its head.
    lean: DIAG,
    build: (k) => {
      k.cyl(0.55, 0.7, 17, 6, C.wood, { at: [0, -1.5, 0] });
      k.cyl(0.8, 0.8, 2.6, 6, C.leather, { at: [0, -1, 0] });
      k.cyl(0.78, 0.6, 0.9, 6, C.iron, { at: [0, -9.6, 0] });
      const face: Place["rot"] = [Math.PI / 2, 0, 0];
      k.cyl(2, 2, 0.7, 12, C.gold, { at: [0, 3.6, 0.5], rot: face });
      k.cyl(1.6, 1.6, 0.3, 12, C.paper, { at: [0, 3.6, 0.85], rot: face });
      k.box(0.25, 1.4, 0.12, C.dark, { at: [0.3, 4.1, 1.05], rot: [0, 0, -0.5] });
      k.ball(0.28, k.a, { at: [0, 3.6, 1.1] });
      for (const y of [7.4, 11.6]) k.cyl(1.2, 1.2, 0.7, 8, C.gold, { at: [0, y, 0] });
      k.cyl(0.8, 0.8, 3.6, 8, { glow: "#8fd3ff" }, { at: [0, 9.5, 0] });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        k.cyl(0.18, 0.18, 4.2, 4, C.gold, { at: [Math.cos(a) * 1.05, 9.5, Math.sin(a) * 1.05] });
      }
      k.cone(1.1, 1.6, 6, C.gold, { at: [0, 12.75, 0] });
      k.gem(0.9, 1.9, { glow: k.a }, { at: [0, 14.2, 0] });
    },
  },
  "gaff-hook": {
    // A pair of gaff hooks, crossed at the collars, their points curling outward.
    spin: 0.3,
    inHand: gaffHook,
    build: (k) => {
      k.within({ at: [0, 0, -0.5], rot: [0, 0, -0.6] }, () => gaffHook(k));
      k.within({ at: [0, 0, 0.5], rot: [0, Math.PI, -0.6] }, () => gaffHook(k));
    },
  },
  "coral-staff": {
    // Bleached driftwood, crowned with branching coral round a glowing pearl, barnacles on the shaft.
    lean: DIAG,
    build: (k) => {
      const drift = "#c2a785";
      k.rod([[0, -10, 0], [0.6, -5, 0.3], [-0.4, 0, 0], [0.5, 4, -0.2], [0, 7, 0]], 0.75, drift, {}, 6);
      k.ball(0.75, drift, { at: [0, -10, 0] });
      for (const [x, y, z, r] of [[0.75, -3.2, 0.3, -1.3], [-0.6, 1.8, 0.45, 1.2], [0.55, 2.6, -0.4, -1.4]] as const) k.cone(0.4, 0.5, 5, C.paper, { at: [x, y, z], rot: [0, 0, r] });
      const coral = "#ff8f7a";
      const tips = "#ffc0ad";
      const branches: V3[][] = [
        [[0, 6.6, 0], [-1.2, 8.5, 0.3], [-2.6, 10.4, 0], [-2.9, 12.1, 0.2]],
        [[0, 6.6, 0], [1.3, 8.8, -0.2], [2.7, 10.2, 0.1], [3.1, 12.3, 0]],
        [[-1.2, 8.5, 0.3], [-0.5, 10.6, 0.8], [-0.8, 12.8, 0.5]],
        [[1.3, 8.8, -0.2], [1.1, 11, -0.7], [1.7, 13, -0.5]],
        [[-2.6, 10.4, 0], [-3.9, 11.2, -0.2], [-4.4, 12.5, -0.1]],
      ];
      for (const b of branches) {
        k.rod(b, 0.58, coral, {}, 5);
        k.ball(0.68, tips, { at: b[b.length - 1] });
      }
      k.ball(1.55, { glow: k.a }, { at: [0, 10.3, 0.4] }, 1);
    },
  },
  "ships-bell": {
    // A hand bell: a flared brass bell banded at the lip, the clapper showing beneath, a turned wooden handle.
    spin: 0.4,
    tip: 0.2,
    build: (k) => {
      k.lathe([[0, -4.6], [3.4, -4.6], [3.6, -4.1], [3.2, -3.5], [2.6, -1], [2.2, 1.4], [1.6, 2.6], [0, 3]], 10, C.gold);
      k.cyl(3.15, 3.15, 0.1, 10, C.dark, { at: [0, -4.62, 0] });
      k.ring(3.35, 0.3, "#b8891f", { at: [0, -3.9, 0], rot: [Math.PI / 2, 0, 0] }, 4, 16);
      k.ring(2.35, 0.22, "#b8891f", { at: [0, 0.6, 0], rot: [Math.PI / 2, 0, 0] }, 4, 14);
      // The clapper hangs inside, and knocks about a little within the lip.
      k.dangle([0, -2.2, 0], [0, -5.6, 0], () => {
        k.cyl(0.22, 0.22, 3.4, 4, C.iron, { at: [0, -3.9, 0] });
        k.ball(0.9, k.a, { at: [0, -5.6, 0] });
      }, { limit: 0.35 });
      k.cyl(0.95, 0.95, 0.8, 8, C.gold, { at: [0, 3.3, 0] });
      k.cyl(0.6, 0.75, 4.2, 6, C.wood, { at: [0, 5.8, 0] });
      k.ball(0.95, C.wood, { at: [0, 8.2, 0] });
    },
  },
  astrolabe: {
    // A brass astrolabe on a short handle: the star plate, a rete, the sighting rule across it and a glowing pin.
    spin: 0.35,
    tip: 0.2,
    lean: -0.15,
    build: (k) => {
      const face: Place["rot"] = [Math.PI / 2, 0, 0];
      k.cyl(4.2, 4.2, 0.8, 16, C.gold, { at: [0, 3.6, 0], rot: face });
      k.cyl(3.5, 3.5, 0.3, 16, "#2d357a", { at: [0, 3.6, 0.45], rot: face });
      k.ring(4.15, 0.35, "#b8891f", { at: [0, 3.6, 0.45] }, 4, 20);
      for (const [x, y] of [[-2, 1.1], [1.7, 1.4], [-1.1, -1.9], [2.1, -1.3], [0.4, 2.4]] as const) k.ball(0.22, C.shine, { at: [x, 3.6 + y, 0.65] });
      k.ring(2.2, 0.18, C.gold, { at: [0.6, 4, 0.75] }, 4, 14);
      k.box(8.2, 0.5, 0.25, C.steel, { at: [0, 3.6, 0.95], rot: [0, 0, 0.7] });
      k.gem(0.6, 1.3, { glow: k.a }, { at: [0, 3.6, 1.15], rot: face });
      k.box(1.6, 1.2, 0.8, C.gold, { at: [0, 8.2, 0] }, 0.2);
      k.ring(0.9, 0.25, C.gold, { at: [0, 9.3, 0], rot: [0, Math.PI / 2, 0] }, 4, 10);
      k.cyl(1, 0.7, 1, 6, C.gold, { at: [0, -1, 0] });
      k.cyl(0.7, 0.8, 5.5, 6, C.wood, { at: [0, -4.2, 0] });
      k.ball(0.85, C.gold, { at: [0, -7.2, 0] });
    },
  },
  "boarding-pike": {
    // A long pole, an iron socket, a pair of lugs and a steel spearhead.
    lean: DIAG,
    spin: 0.4,
    build: (k) => {
      k.cyl(0.6, 0.7, 20, 6, C.wood, { at: [0, -2, 0] });
      for (const y of [-10, 2.4]) k.cyl(0.82, 0.82, 1.3, 6, k.a, { at: [0, y, 0] });
      k.cyl(0.75, 0.75, 1.4, 6, C.iron, { at: [0, 8.4, 0] });
      k.cyl(0.28, 0.28, 3.4, 5, C.iron, { at: [0, 9.2, 0], rot: [0, 0, Math.PI / 2] });
      k.cone(1.25, 5.6, 4, C.steel, { at: [0, 12.2, 0] });
      k.cone(0.45, 4.6, 4, C.shine, { at: [0, 12.4, 0.5] });
    },
  },
  "bilge-chalice": {
    // A gold chalice brimming with glowing bilge, bubbles rising and a drip running down its side.
    spin: 0.4,
    tip: 0.3,
    build: (k) => {
      const bilge = { glow: "#6dff9e" };
      k.lathe([[0, -6], [3, -6], [3.1, -5.5], [1.6, -5], [0.7, -4], [0.6, -1], [0.9, -0.4], [2.6, 0.6], [3.6, 2.5], [3.9, 5]], 12, C.gold);
      k.cyl(3.75, 3.75, 0.3, 12, bilge, { at: [0, 4.65, 0] });
      k.ring(3.9, 0.3, "#b8891f", { at: [0, 5, 0], rot: [Math.PI / 2, 0, 0] }, 4, 20);
      k.ball(1, k.a, { at: [0, -2.5, 0] });
      k.gem(0.6, 1.2, k.a, { at: [0, 2.4, 3.45], rot: [Math.PI / 2 - 0.4, 0, 0] });
      k.ball(0.55, bilge, { at: [1, 6.2, 0.6] });
      k.ball(0.4, bilge, { at: [-1.2, 7.4, -0.3] });
      k.ball(0.3, bilge, { at: [0.3, 8.5, 0.2] });
      k.rod([[2.8, 5.1, 2.7], [2.9, 4, 2.75], [2.6, 2.6, 2.6]], 0.3, bilge, {}, 4);
    },
  },

  // ---- armor ----
  "round-shield": {
    spin: 0.5,
    tip: 0.15,
    build: (k) => {
      const face: Place = { rot: [Math.PI / 2, 0, 0] };
      k.cyl(7, 7, 1.2, 12, C.iron, face);
      k.cyl(5.6, 5.8, 0.6, 12, k.a, { at: [0, 0, 0.8], ...face });
      k.dome(2, 8, C.gold, { at: [0, 0, 1], rot: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        k.ball(0.38, C.steel, { at: [Math.cos(a) * 6.3, Math.sin(a) * 6.3, 0.7] });
      }
    },
  },
  shield: {
    spin: 0.5,
    tip: 0.15,
    build: (k) => {
      k.plate([[-6, 7], [6, 7], [6, 1], [4.8, -3], [2.4, -6], [0, -8], [-2.4, -6], [-4.8, -3], [-6, 1]], 1, C.iron, {}, 0.5);
      k.box(1.8, 13, 0.6, k.a, { at: [0, -0.4, 0.9] });
      k.box(10.6, 1.8, 0.6, k.a, { at: [0, 3, 0.9] });
      k.ball(1.1, C.gold, { at: [0, 3, 1.3] });
    },
  },
  "chest-armor": {
    spin: 0.45,
    tip: 0.2,
    build: (k) => {
      const pts: V3[] = [];
      for (const [y, w, front, back] of [[6, 5, 2.4, 2.4], [3, 5.4, 3.4, 2.6], [-3, 4, 2.6, 2.3], [-6.2, 4.6, 2.7, 2.5]] as const) {
        pts.push([-w, y, 0], [w, y, 0], [0, y, front], [0, y, -back]);
        for (const sx of [-1, 1]) pts.push([sx * w * 0.72, y, front * 0.85], [sx * w * 0.72, y, -back * 0.9]);
      }
      k.hull(pts, C.iron);
      k.cyl(2, 2.4, 0.5, 8, C.dark, { at: [0, 6.05, 0] });
      for (const sx of [-1, 1]) k.dome(2.8, 6, C.steel, { at: [sx * 4.8, 5.4, 0], rot: [0, 0, -sx * 0.5] });
      k.plate([[0, 1.9], [1.4, 0], [0, -1.9], [-1.4, 0]], 0.4, k.a, { at: [0, 2, 3.25] }, 0.15);
      k.box(8.8, 1.3, 5.6, C.gold, { at: [0, -3.8, 0.1] }, 0.25);
      k.box(1.5, 1.5, 0.5, C.steel, { at: [0, -3.8, 3] }, 0.1);
    },
  },
  "heavy-helm": {
    spin: 0.55,
    tip: 0.2,
    build: (k) => {
      k.lathe([[4.6, -4.4], [4.9, -3], [5.1, 0], [5, 3], [4.2, 5.2], [2.4, 6.6], [0, 7]], 8, C.iron);
      k.cyl(5, 5, 0.9, 8, C.steel, { at: [0, -4.2, 0] });
      k.box(6.4, 0.9, 1.2, C.dark, { at: [0, 0.4, 4.5] });
      k.box(1.3, 6, 1, C.steel, { at: [0, -1, 4.7] }, 0.2);
      k.box(1.2, 2.6, 5.4, k.a, { at: [0, 7.6, -0.6] }, 0.5);
    },
  },
  "brutal-helm": {
    spin: 0.5,
    tip: 0.15,
    build: (k) => {
      k.lathe([[4.4, -4.6], [4.9, -2], [5, 1], [4.4, 4], [2.6, 5.8], [0, 6.2]], 8, C.iron);
      k.add(hornGeometry(1.15, 6.5, 2.4), C.bone, { at: [-3.8, 3, 0], rot: [0, 0, 1.15] });
      k.add(hornGeometry(1.15, 6.5, -2.4), C.bone, { at: [3.8, 3, 0], rot: [0, 0, -1.15] });
      k.box(7.6, 1, 1.2, C.steel, { at: [0, 2, 4.2] }, 0.25);
      for (const x of [-1.6, 1.6]) k.box(1.9, 0.9, 0.8, { glow: k.a }, { at: [x, 0.6, 4.6] });
      for (const sx of [-1, 1]) k.box(2.2, 3.6, 1, C.iron, { at: [sx * 3.1, -3.4, 3.3], rot: [0, -sx * 0.5, 0] }, 0.3);
      for (const x of [-0.9, 0.9]) k.box(0.5, 2.4, 0.6, C.dark, { at: [x, -2.8, 4.5] });
    },
  },
  hood: {
    // A peaked hood with a lined opening, two eyes in the shadow, and a mantle over the shoulders.
    spin: 0.35,
    tip: 0.15,
    build: (k) => {
      const cowl = new THREE.LatheGeometry([[0, 8.5], [1.2, 7.8], [3, 5.8], [4.4, 3], [4.9, 0], [4.8, -2.6], [4.4, -4]].reverse().map(([r, y]) => new THREE.Vector2(r, y)), 8);
      const p = cowl.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - Math.max(0, p.getY(i) - 2) * 0.35);
      k.add(cowl, C.leather);
      k.cyl(4.4, 6.4, 3, 8, C.hide, { at: [0, -5.4, 0] });
      k.cyl(2.8, 2.8, 1, 10, C.dark, { at: [0, 0.2, 4.2], rot: [Math.PI / 2, 0, 0], scale: [1, 1, 1.3] });
      k.ring(2.9, 0.55, k.a, { at: [0, 0.2, 4.6], scale: [1, 1.3, 1] }, 5, 12);
      for (const x of [-1, 1]) k.ball(0.4, { glow: C.shine }, { at: [x, 0.7, 4.8] });
      k.ball(0.75, C.gold, { at: [0, -4.1, 4.6] });
    },
  },
  "armored-pants": {
    spin: 0.45,
    tip: 0.15,
    build: (k) => {
      k.box(8.6, 2, 4.2, k.a, { at: [0, 6, 0] }, 0.4);
      k.box(1.4, 1.4, 0.5, C.gold, { at: [0, 6, 2.2] }, 0.1);
      k.box(8.2, 3, 4, C.iron, { at: [0, 3.8, 0] }, 0.5);
      for (const sx of [-1, 1]) {
        k.cyl(2, 1.7, 10, 6, C.iron, { at: [sx * 2.3, -2.6, 0], rot: [0, 0, sx * 0.05] });
        k.box(2.6, 2.2, 1, C.steel, { at: [sx * 2.4, -1.4, 1.8] }, 0.35);
        k.cyl(1.95, 1.95, 1.2, 6, C.hide, { at: [sx * 2.6, -7.6, 0] });
      }
    },
  },
  boots: {
    spin: 0,
    tip: 0.3,
    build: (k) => {
      k.within({ at: [-2.6, 0, -0.6], rot: [0, -0.45, 0] }, () => boot(k));
      k.within({ at: [2.6, 0, 0.4], rot: [0, -0.3, 0] }, () => boot(k));
    },
  },

  // ---- trinkets ----
  ring: {
    spin: 0.8,
    tip: 0.3,
    pad: 0.1,
    build: (k) => {
      k.ring(3.6, 0.9, C.gold, {}, 6, 14);
      k.cyl(1.2, 0.8, 1, 6, C.gold, { at: [0, 4.6, 0] });
      k.gem(1.5, 2.6, { glow: k.a }, { at: [0, 5.9, 0] });
    },
  },
  "linked-rings": {
    spin: 0.7,
    tip: 0.25,
    lean: 0.4,
    pad: 0.08,
    build: (k) => {
      k.ring(3.4, 0.75, C.gold, { at: [-1.7, 0, 0] }, 6, 14);
      k.ring(3.4, 0.75, k.a, { at: [1.7, 0, 0], rot: [Math.PI / 2, 0, 0] }, 6, 14);
    },
  },
  "gem-chain": {
    // A pendant on a chain.
    spin: 0.3,
    tip: 0.25,
    build: (k) => {
      for (const sx of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([v3([sx * 5.5, 7, -0.6]), v3([sx * 3.6, 2.6, 0.4]), v3([sx * 0.6, -0.9, 1])]);
        const links = 9;
        for (let i = 0; i <= links; i++) {
          const t = i / links;
          const at = curve.getPoint(t);
          const along = curve.getTangent(t);
          const link = k.ring(0.6, 0.2, C.gold, { at: [at.x, at.y, at.z], scale: [1.6, 1, 1] }, 4, 6);
          link.rotation.order = "ZYX";
          link.rotation.set(i % 2 ? Math.PI / 2 : 0, 0, Math.atan2(along.y, along.x));
        }
      }
      k.cyl(0.7, 1, 0.9, 6, C.gold, { at: [0, -1.7, 1] });
      k.add(new THREE.OctahedronGeometry(1), { glow: k.a }, { at: [0, -4.6, 1], scale: [2.2, 3.2, 1.2] });
    },
  },
  key: {
    lean: -0.6,
    spin: 0.35,
    build: (k) => {
      k.ring(2.6, 0.75, C.gold, { at: [0, 6, 0] }, 6, 10);
      k.gem(1.1, 2, { glow: k.a }, { at: [0, 6, 0] });
      k.cyl(0.65, 0.65, 10, 6, C.gold, { at: [0, -1.5, 0] });
      k.cyl(1, 1, 0.7, 6, "#b8891f", { at: [0, 3.2, 0] });
      k.box(2.6, 1, 0.9, C.gold, { at: [1.6, -4.6, 0] }, 0.15);
      k.box(1.8, 0.9, 0.9, C.gold, { at: [1.2, -6.1, 0] }, 0.15);
    },
  },
  "crowned-heart": {
    // The harbormaster's badge: a heart under a crown.
    spin: 0.45,
    tip: 0.15,
    build: (k) => {
      k.plate(heartOutline(13), 2, k.a, {}, 0.6);
      k.cyl(3.2, 3, 1.2, 8, C.gold, { at: [0, 5.6, 0] });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        k.cone(0.55, 1.7, 4, C.gold, { at: [Math.cos(a) * 2.8, 7, Math.sin(a) * 2.8] });
        k.ball(0.35, C.gold, { at: [Math.cos(a) * 2.8, 8, Math.sin(a) * 2.8] });
      }
    },
  },

  // ---- hut materials ----
  "res-wood": {
    // Three logs, two below and one on top, their cut ends toward you.
    spin: -0.75,
    tip: 0.3,
    build: (k) => {
      const end = "#d9b27c";
      const along: Place["rot"] = [0, 0, Math.PI / 2];
      for (const [y, z, len] of [[-1.9, -2.3, 11], [-1.9, 2.3, 10.4], [1.9, 0, 10.8]] as const) {
        k.cyl(2.2, 2.2, len, 8, [C.wood, end, end], { at: [0, y, z], rot: along });
        for (const sx of [-1, 1]) k.cyl(1.1, 1.1, 0.1, 8, C.leather, { at: [(sx * len) / 2, y, z], rot: along });
      }
    },
  },
  "res-stone": {
    spin: 0.4,
    tip: 0.2,
    build: (k) => {
      k.add(roughen(new THREE.IcosahedronGeometry(5, 0), 0.22, 1), C.iron, { scale: [1.1, 0.8, 1] });
      k.add(roughen(new THREE.IcosahedronGeometry(2.6, 0), 0.25, 2), "#a2abb8", { at: [4.6, -2.4, 2.6] });
    },
  },
  "res-iron": { spin: 0.6, tip: 0.45, build: (k) => ingots(k, "#aeb6c3") },
  "res-copper": { spin: 0.6, tip: 0.45, build: (k) => ingots(k, "#c8743a") },
  "res-gem": {
    // A cut gem, and a smaller one beside it.
    spin: 0.4,
    tip: 0.35,
    build: (k) => {
      const cut: [number, number][] = [[0, -4.4], [4, 0.6], [4, 1.2], [2.4, 2.8], [0, 2.8]];
      k.lathe(cut, 8, { glow: "#ff6fe0" });
      k.lathe(cut, 8, { glow: "#ff9be8" }, { at: [4.8, -3, 1.6], scale: 0.42, rot: [0.4, 0, -0.5] });
    },
  },
  "res-fur": {
    // A pelt stretched flat: four legs, a tail, darker along the spine.
    spin: 0.3,
    tip: 0.75,
    build: (k) => {
      const half: [number, number][] = [[0, 7.5], [1.2, 6.8], [1.6, 5.6], [4.6, 6.2], [5.4, 5.2], [2.9, 3.4], [3.3, 0], [2.9, -3], [5.4, -4.4], [4.8, -5.7], [2.2, -5], [0.9, -6], [0.6, -9], [0, -9.6]];
      const outline = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
      const pelt = k.plate(outline, 0.7, "#c08550", {}, 0.35);
      const p = pelt.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + 0.6 * Math.cos(p.getY(i) * 0.45) - 0.4 * Math.cos(p.getX(i) * 0.5));
      k.box(1.8, 12, 0.4, C.leather, { at: [0, -0.6, 1.05] }, 0.15);
      for (const sx of [-1, 1]) k.cone(0.6, 1.4, 4, C.hide, { at: [sx * 0.9, 7.6, 0.3], rot: [0, 0, -sx * 0.4] });
    },
  },
  "res-bone": {
    lean: DIAG,
    spin: 0.4,
    build: (k) => {
      k.cyl(1, 1, 10, 6, C.bone, {});
      for (const sy of [-1, 1]) for (const sx of [-1, 1]) k.ball(1.6, C.bone, { at: [sx * 1.1, sy * 5.6, 0] }, 1);
    },
  },
  "res-herbs": {
    // A tied bunch of leafy stems with a few small flowers.
    lean: -0.15,
    build: (k) => {
      for (const [x, z] of [[-2.6, 0], [-1.2, 1], [0, -0.6], [1.3, 0.9], [2.6, 0]] as const) k.rod([[0, -7, 0], [0, -3, 0], [x, 2.6, z]], 0.25, "#3d6b2c", {}, 4);
      k.cyl(1.1, 1.1, 1.4, 6, C.leather, { at: [0, -3, 0] });
      const leaves: [number, number, number, number, string][] = [
        [-3, 3.6, 0.5, 0.5, "#4f8a3a"], [-1.4, 4.8, 1.2, 0.2, "#6fae4a"], [0.2, 4, -0.8, -0.1, "#4f8a3a"], [1.6, 4.8, 1, -0.3, "#6fae4a"],
        [3, 3.4, 0.2, -0.6, "#4f8a3a"], [-0.6, 2.2, 1.6, 0.3, "#3d6b2c"], [1, 2.4, 1.6, -0.4, "#4f8a3a"],
      ];
      for (const [x, y, z, r, c] of leaves) k.add(new THREE.OctahedronGeometry(1), c, { at: [x, y, z], rot: [0.3, 0, r], scale: [1.3, 2.2, 0.4] });
      k.ball(0.75, "#c9a3e6", { at: [-2.2, 5.6, 1] });
      k.ball(0.75, "#c9a3e6", { at: [2.4, 6, 0.4] });
      k.ball(0.65, C.paper, { at: [0.3, 6.4, 0.6] });
    },
  },
  "res-mushrooms": {
    // Two caps on pale stems, the near one larger, on a little moss.
    spin: 0.4,
    tip: 0.35,
    build: (k) => {
      k.cyl(5.6, 5.9, 0.6, 8, "#4f8a3a", { at: [0, -0.3, 0] });
      mushroom(k, -1.6, 0.6, 1.25);
      mushroom(k, 3, -1.2, 0.85);
    },
  },
  "res-slime": {
    // A squat glob of cave slime with a smaller one beside it, a shine on each and a bubble caught inside.
    spin: 0.4,
    tip: 0.35,
    build: (k) => {
      k.ball(4.2, "#65a30d", { at: [-0.8, 1.6, 0], scale: [1.25, 0.62, 1.1] }, 1);
      k.ball(2, "#4d7c0f", { at: [3.6, 0.8, 1.6], scale: [1.2, 0.6, 1.1] }, 1);
      k.ball(1.2, "#a3e635", { at: [-2.2, 3.4, 1.2], scale: [1.4, 0.4, 1] });
      k.ball(0.6, "#a3e635", { at: [3.2, 1.8, 2.2], scale: [1.4, 0.4, 1] });
      k.ball(0.7, "#d9f99d", { at: [0.8, 2.2, 3.6] });
    },
  },

  // ---- gold ----
  cash: {
    // Two stacks of coins, one taller.
    spin: 0.4,
    tip: 0.45,
    build: (k) => {
      const edge = "#b8891f";
      const coin = (x: number, y: number, z: number) => k.cyl(3.2, 3.2, 0.8, 10, [edge, C.gold, C.gold], { at: [x, y, z] });
      for (const [i, x, z] of [[0, 0, 0], [1, 0.3, -0.2], [2, -0.2, 0.2], [3, 0.2, 0.1], [4, -0.1, -0.1]] as const) coin(x - 2, i * 0.85, z - 1);
      k.ring(2.3, 0.2, C.gold, { at: [-2.1, 3.85, -1.1], rot: [Math.PI / 2, 0, 0] }, 4, 10);
      for (const [i, x, z] of [[0, 0, 0], [1, -0.3, 0.2]] as const) coin(x + 3.4, i * 0.85, z + 2.4);
    },
  },
};

// ---------- building ----------

const materials = new Map<string, THREE.Material>();

function material(paint: Paint): THREE.Material {
  const glow = typeof paint !== "string";
  const color = glow ? paint.glow : paint;
  const key = `${color}|${glow}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...(glow ? { emissive: color, emissiveIntensity: 0.45 } : {}) });
    m.userData.glow = glow;
    materials.set(key, m);
  }
  return m;
}

/** Darken a #rrggbb colour by a share. */
function darken(hex: string, by = 0.35): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - by)).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function place(o: THREE.Object3D, p: Place = {}) {
  if (p.at) o.position.set(...p.at);
  if (p.rot) o.rotation.set(...p.rot);
  if (p.scale !== undefined) typeof p.scale === "number" ? o.scale.setScalar(p.scale) : o.scale.set(...p.scale);
}

/**
 * The model for an icon, in the accent colour, or null when the icon has none. `inHand` builds what one hand
 * holds of it instead (see LowPolyDef.inHand), where that differs.
 */
export function buildLowPoly(name: string, accent: string, inHand = false): { model: THREE.Object3D; def: LowPolyDef } | null {
  const def = LOW_POLY[name];
  if (!def) return null;
  const root = new THREE.Group();
  const parents: THREE.Object3D[] = [root];
  const top = () => parents[parents.length - 1];
  const add: Kit["add"] = (geo, paint, p) => {
    const mesh = new THREE.Mesh(geo, Array.isArray(paint) ? paint.map(material) : material(paint));
    place(mesh, p);
    top().add(mesh);
    return mesh;
  };
  const k: Kit = {
    a: accent,
    s: darken(accent),
    add,
    box: (w, h, d, paint, p, bevel = 0) =>
      add(bevel > 0 ? new ConvexGeometry(chamferPoints(w, h, d, Math.min(bevel, w / 2.2, h / 2.2, d / 2.2)).map(v3)) : new THREE.BoxGeometry(w, h, d), paint, p),
    cyl: (rt, rb, h, sides, paint, p) => add(new THREE.CylinderGeometry(rt, rb, h, sides), paint, p),
    cone: (r, h, sides, paint, p) => add(new THREE.ConeGeometry(r, h, sides), paint, p),
    ball: (r, paint, p, detail = 0) => add(new THREE.IcosahedronGeometry(r, detail), paint, p),
    gem: (r, h, paint, p) => {
      const g = new THREE.OctahedronGeometry(1);
      g.scale(r, h / 2, r);
      return add(g, paint, p);
    },
    dome: (r, sides, paint, p) => add(new THREE.SphereGeometry(r, sides, Math.max(2, Math.round(sides / 3)), 0, Math.PI * 2, 0, Math.PI / 2), paint, p),
    lathe: (profile, sides, paint, p) => add(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), sides), paint, p),
    plate: (outline, depth, paint, p, bevel = 0) => {
      const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
      g.translate(0, 0, -depth / 2);
      return add(g, paint, p);
    },
    rod: (points, r, paint, p, sides = 6) => add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(v3)), Math.max(6, points.length * 3), r, sides, false), paint, p),
    ring: (R, r, paint, p, radial = 6, tubular = 12) => add(new THREE.TorusGeometry(R, r, radial, tubular), paint, p),
    hull: (points, paint, p) => add(new ConvexGeometry(points.map(v3)), paint, p),
    within: (p, build) => {
      const g = new THREE.Group();
      place(g, p);
      top().add(g);
      parents.push(g);
      build();
      parents.pop();
    },
    dangle: (pivot, bob, build, opts) => {
      const g = new THREE.Group();
      g.userData.dangle = { pivot, bob, ...opts } satisfies Dangle;
      top().add(g);
      parents.push(g);
      build();
      parents.pop();
    },
  };
  (inHand && def.inHand ? def.inHand : def.build)(k);
  return { model: root, def };
}

/** Free a model's geometry (the materials are shared and kept). */
export function disposeLowPoly(model: THREE.Object3D) {
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
