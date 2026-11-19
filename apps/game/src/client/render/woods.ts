// The island's trees and its boulder outcrops.
//
// Trees come in two kinds, pines and broadleaves, each one tinted, sized and
// turned its own way. Ordinary forest hexes have a couple each, to walk
// between; a thicket (a hex that cannot be walked through) is a crowd of big
// old ones with brush at their feet. They all lean in the wind, and anyone
// walking among them pushes them aside: they bend away as you pass and spring
// back with a wobble after.
//
// Old oaks stand alone in the open grass: a stout trunk, a few heavy limbs and a
// broad crown of leafy lumps that shivers in the wind while the
// trunk barely moves. Where the grass has died the oaks have too: the same
// trees, bare, their limbs forking out to pointed twigs. They are too stout to
// be pushed aside, so they are stood at the corners of hexes, out of the way.
//
// Outcrops are heaps of lumpy, mossy boulders on the hills, too big to climb.
// The same boulders, shoulder to shoulder, are the line that bounds the Harbor.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HIDES } from "./silhouette";
import { addOakSway, addWindSway } from "./wind";

/** Every tree geometry is this tall, centred on y = 0 (as addWindSway expects); an instance scales it. */
const TREE_H = 1;
/** Within this far (world units) of a walker, a tree is pushed over. */
const BRUSH_REACH = 0.62;
/** How far over a tree goes when someone is right against it: the shear of its tip, per unit of height. */
const BRUSH_LEAN = 0.45;
/** The spring that stands it up again: stiffness and damping, per second. */
const SPRING_K = 70;
const SPRING_C = 5.5;

type Kind = "pine" | "broad" | "oak" | "snag";
/** How many different oaks there are, and as many bare ones (snags). */
export const OAK_SHAPES = 3;

export interface TreeSpot {
  x: number;
  /** The ground it stands on. */
  y: number;
  z: number;
  /** Height, world units. */
  size: number;
  kind: Kind;
  /** Turned about y. */
  yaw: number;
  /** Multiplies its colours: about 1, a little lighter or darker, warmer or cooler. */
  tint: THREE.Color;
  /** For an oak or a snag: which of the OAK_SHAPES it is. */
  shape?: number;
}

export interface BoulderSpot {
  x: number;
  y: number;
  z: number;
  /** Width and height. */
  size: number;
  tall: number;
  yaw: number;
  tilt: number;
  shape: number;
  tint: THREE.Color;
}

/** Paint every vertex of a (non-indexed) geometry one colour. */
function painted(geo: THREE.BufferGeometry, color: string | THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute("uv");
  return g;
}

/** A pine: a short trunk and three tiers of needles, each a shade lighter going up. */
function pineGeometry(sodden: boolean): THREE.BufferGeometry {
  const needles = new THREE.Color(sodden ? "#3a5d41" : "#2f7a3d");
  const tier = (r: number, h: number, base: number, shade: number, turn: number) => {
    const g = new THREE.ConeGeometry(r, h, 6, 1);
    g.rotateY(turn);
    g.translate(0, base + h / 2, 0);
    return painted(g, needles.clone().multiplyScalar(shade));
  };
  const trunk = new THREE.CylinderGeometry(0.035, 0.055, 0.26, 5);
  trunk.translate(0, 0.13, 0);
  const geo = mergeGeometries([
    painted(trunk, "#5e4330"),
    tier(0.36, 0.44, 0.17, 0.92, 0),
    tier(0.28, 0.38, 0.4, 1.0, 0.5),
    tier(0.19, 0.32, 0.66, 1.1, 1.0),
  ])!;
  geo.translate(0, -TREE_H / 2, 0);
  return geo;
}

/** A broadleaf: a taller trunk under a round crown of three lumps of leaves. */
function broadGeometry(sodden: boolean): THREE.BufferGeometry {
  const leaves = new THREE.Color(sodden ? "#4a6648" : "#4a8f3f");
  const lump = (r: number, x: number, y: number, z: number, shade: number) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, 0.85, 1);
    g.translate(x, y, z);
    return painted(g, leaves.clone().multiplyScalar(shade));
  };
  const trunk = new THREE.CylinderGeometry(0.04, 0.065, 0.48, 5);
  trunk.translate(0, 0.24, 0);
  const geo = mergeGeometries([
    painted(trunk, "#6b4a2f"),
    lump(0.3, 0, 0.68, 0, 1.05),
    lump(0.22, 0.2, 0.52, 0.06, 0.92),
    lump(0.2, -0.16, 0.54, -0.1, 0.96),
  ])!;
  geo.translate(0, -TREE_H / 2, 0);
  return geo;
}

/**
 * Mark every vertex for the oaks' wind (see addOakSway): a leaf carries the middle of its clump and a 1, so the
 * whole clump moves as one; wood carries nothing, and is left be.
 */
function leafy(geo: THREE.BufferGeometry, clump?: THREE.Vector3): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const mark = new Float32Array(n * 4);
  if (clump) for (let i = 0; i < n; i++) mark.set([clump.x, clump.y, clump.z, 1], i * 4);
  geo.setAttribute("aLeaf", new THREE.BufferAttribute(mark, 4));
  return geo;
}

/** A limb of wood from one point to another, `r0` thick where it starts and `r1` where it ends. */
function limb(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, color: THREE.Color, sides = 5): THREE.BufferGeometry {
  const along = to.clone().sub(from);
  const g = new THREE.CylinderGeometry(r1, r0, along.length(), sides, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.clone().normalize()));
  g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return leafy(painted(g, color));
}

/**
 * Leaves pinned to the outside of a clump's lump (a leafCore): one on most of the faces that look up or out,
 * hardly any underneath. Each is a pointed diamond (two triangles, both faces) with its stem in the middle of
 * its face, lying along the face and tipped out from it a little, pointing down the slope like a shingle, so
 * the tips stand past the lump's edges and break its outline. Dark at the stem, light at the tip. Each leaf
 * is marked with its own stem, so the wind turns every one of them separately while the lump stays put.
 */
function leafSkin(core: THREE.BufferGeometry, r: number, leaves: THREE.Color, salt: number): THREE.BufferGeometry {
  const rnd = (i: number) => lumpAt(salt * 1.3 + 0.7, i * 0.37, salt * 0.11, 17);
  const src = core.getAttribute("position") as THREE.BufferAttribute;
  const pos: number[] = [], col: number[] = [], mark: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3();
  const mid = new THREE.Vector3(), n = new THREE.Vector3(), down = new THREE.Vector3(), way = new THREE.Vector3(), side = new THREE.Vector3();
  const stem = leaves.clone().multiplyScalar(0.7), tip = leaves.clone().multiplyScalar(1.25);
  const c = new THREE.Color();
  for (let f = 0, i = 0; f < src.count; f += 3, i++) {
    a.fromBufferAttribute(src, f);
    b.fromBufferAttribute(src, f + 1);
    c3.fromBufferAttribute(src, f + 2);
    n.crossVectors(b.clone().sub(a), c3.clone().sub(a)).normalize();
    // Few underneath, where they would not be seen; a few gaps elsewhere, so the lump shows between them.
    if (n.y < -0.35 ? rnd(i * 5) < 0.8 : rnd(i * 5) < 0.12) continue;
    mid.copy(a).add(b).add(c3).multiplyScalar(1 / 3);
    // Down the face's slope (any way along it, for a face that looks straight up), turned a little either way.
    down.set(0, -1, 0).addScaledVector(n, n.y);
    if (down.lengthSq() < 0.04) down.set(Math.cos(i * 2.4), 0, Math.sin(i * 2.4)).addScaledVector(n, -n.x * Math.cos(i * 2.4) - n.z * Math.sin(i * 2.4));
    down.normalize().applyAxisAngle(n, (rnd(i * 5 + 1) - 0.5) * 1.4);
    // Tipped out from the face.
    const lift = 0.35 + rnd(i * 5 + 2) * 0.35;
    way.copy(down).multiplyScalar(Math.cos(lift)).addScaledVector(n, Math.sin(lift));
    side.crossVectors(way, n).normalize();
    const len = r * (0.62 + rnd(i * 5 + 3) * 0.3);
    const wide = len * (0.26 + rnd(i * 5 + 4) * 0.08);
    // Back up the slope a little, so the leaf covers its face rather than hanging off its lower edge.
    const root = mid.clone().addScaledVector(down, -len * 0.25).addScaledVector(n, r * 0.02);
    const at = (along: number, across: number) => root.clone().addScaledVector(way, len * along).addScaledVector(side, wide * across);
    const s = root, m0 = at(0.45, -1), m1 = at(0.45, 1), t = at(1, 0);
    const shade = 0.86 + rnd(i * 5 + 4) * 0.28;
    // One face, the outer one: the lump hides the back of every leaf.
    const outward = a.subVectors(m0, s).cross(b.subVectors(t, s)).dot(n) > 0;
    const tris: [THREE.Vector3, THREE.Color][][] = outward
      ? [[[s, stem], [m0, leaves], [t, tip]], [[s, stem], [t, tip], [m1, leaves]]]
      : [[[s, stem], [m1, leaves], [t, tip]], [[s, stem], [t, tip], [m0, leaves]]];
    for (const tri of tris)
      for (const [v, tone] of tri) {
        pos.push(v.x, v.y, v.z);
        c.copy(tone).multiplyScalar(shade);
        col.push(c.r, c.g, c.b);
        mark.push(root.x, root.y, root.z, 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aLeaf", new THREE.Float32BufferAttribute(mark, 4));
  g.computeVertexNormals();
  return g;
}

/**
 * A clump of oak leaves, about `r` across at `at`: a lump knocked out of round, so that the sky does not show
 * through the crown. It does not move, unless it `sways`: a plain oak's clump is the lump alone, and it heaves
 * in the wind as a whole.
 */
function leafCore(at: THREE.Vector3, r: number, leaves: THREE.Color, salt: number, sways = false): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(r * (0.82 + lumpAt(v.x, v.y, v.z, salt) * 0.36));
    pos.setXYZ(i, at.x + v.x, at.y + v.y * 0.8, at.z + v.z);
  }
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  const normal = g.getAttribute("normal") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    const up = (normal.getY(f) + normal.getY(f + 1) + normal.getY(f + 2)) / 3;
    const own = lumpAt(pos.getX(f) + pos.getX(f + 1), up, pos.getZ(f) + pos.getZ(f + 2), salt + 3);
    c.copy(leaves).multiplyScalar(0.8 + Math.max(0, up) * 0.34 + own * 0.14);
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (f + k) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return leafy(g, sways ? at : undefined);
}

/**
 * An old oak, one of OAK_SHAPES: a short stout trunk flaring into its roots, three or four heavy limbs thrown
 * out from its top and a leader going on up, and a broad crown: a clump of leaves on the end of each limb, a
 * big one on top, and smaller ones filling in between. The first is broad and low, the second taller, the
 * third leans, with its crown out to one side. `bare` is the same tree dead: no leaves, grey wood, and each
 * limb forking out into pointed twigs. Each clump of the crown is a faceted lump with a leaf pinned to most of
 * its faces; a `plain` oak (no "Fancy grass") has the lumps alone, like the broadleaves'.
 */
function oakGeometry(shape: number, bare: boolean, sodden: boolean, plain = false): THREE.BufferGeometry {
  const r = (i: number) => lumpAt(shape * 3.7 + 1, i * 0.61, bare ? 2.3 : 0.9, 5 + shape);
  const bark = new THREE.Color(bare ? "#7b6f60" : sodden ? "#4c3d2f" : "#5d4833");
  const pale = bark.clone().multiplyScalar(bare ? 1.14 : 1.08);
  const leaves = new THREE.Color(sodden ? "#4d8a45" : "#4a9a3c");
  /** A clump's own green: most the oak's, some yellower where the sun has got at them, some deeper. */
  const green = (i: number) => leaves.clone().offsetHSL((r(200 + i) - 0.6) * 0.05, 0.04, (r(210 + i) - 0.45) * 0.1);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = [0.3, 0.38, 0.33][shape];
  const spread = [0.36, 0.29, 0.33][shape];
  const lean = shape === 2 ? 0.1 : 0.02;
  const turn = r(0) * Math.PI * 2;
  const top = V(Math.sin(turn) * lean, trunkH, Math.cos(turn) * lean);
  // The trunk, and its flare into the roots.
  parts.push(limb(V(0, 0.03, 0), top, 0.1, 0.07, bark, 6));
  const flare = new THREE.CylinderGeometry(0.1, 0.17, 0.08, 6, 1);
  flare.translate(0, 0.04, 0);
  parts.push(leafy(painted(flare, bark.clone().multiplyScalar(0.9))));
  /** A dead limb's twigs: two or three from its end, forking on outward and up, to points. */
  const twigs = (from: THREE.Vector3, out: THREE.Vector3, salt: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const way = out.clone().applyAxisAngle(V(0, 1, 0), (i - (n - 1) / 2) * 0.9 + (r(salt + i) - 0.5) * 0.5).normalize();
      const end = from.clone().add(way.multiplyScalar(0.11 + r(salt + 10 + i) * 0.08)).add(V(0, 0.05 + r(salt + 20 + i) * 0.07, 0));
      parts.push(limb(from, end, 0.02, 0.004, pale, 4));
    }
  };
  // The limbs, round the top of the trunk; the leaning oak throws its longest out the way it leans.
  const limbs = shape === 1 ? 3 : 4;
  const ends: THREE.Vector3[] = [];
  for (let i = 0; i < limbs; i++) {
    const a = turn + (i / limbs) * Math.PI * 2 + (r(10 + i) - 0.5) * 0.7;
    const far = spread * (0.62 + r(20 + i) * 0.22) * (shape === 2 && i === 0 ? 1.25 : 1);
    const out = V(Math.sin(a), 0, Math.cos(a));
    const end = top.clone().add(out.clone().multiplyScalar(far)).add(V(0, 0.14 + r(30 + i) * 0.12, 0));
    // A bend in it: up first, then out.
    const elbow = top.clone().lerp(end, 0.45).add(V(0, 0.05, 0));
    parts.push(limb(top, elbow, 0.055, 0.04, bark), limb(elbow, end, 0.04, bare ? 0.018 : 0.026, bark));
    ends.push(end);
    if (bare) {
      twigs(end, out, 100 + i * 30, 2 + Math.floor(r(40 + i) * 1.99));
      twigs(elbow, out.clone().applyAxisAngle(V(0, 1, 0), r(50 + i) < 0.5 ? 1.1 : -1.1), 400 + i * 30, 1);
    }
  }
  const crown = top.clone().add(V(Math.sin(turn) * lean * 1.5, [0.27, 0.34, 0.28][shape], Math.cos(turn) * lean * 1.5));
  parts.push(limb(top, crown, 0.055, bare ? 0.016 : 0.03, bark));
  if (bare) {
    twigs(crown, V(Math.sin(turn + 1), 0, Math.cos(turn + 1)), 700, 3);
    // One limb broke off long ago: a stub.
    const a = turn + 2.6;
    parts.push(limb(top.clone().lerp(V(0, 0, 0), 0.25), top.clone().lerp(V(0, 0, 0), 0.25).add(V(Math.sin(a) * 0.12, 0.05, Math.cos(a) * 0.12)), 0.035, 0.024, pale));
  } else {
    // Leaves, in clumps: one on each limb's end, a big one on top, smaller ones between to fill the crown out,
    // and small ones standing proud of it round its sides and across its top, so its outline is broken. Each
    // clump is a faceted lump; in full leaf, a little darker, with leaves pinned all over the outside of it.
    const clump = (at: THREE.Vector3, size: number, tone: THREE.Color, salt: number) => {
      if (plain) {
        parts.push(leafCore(at, size * 0.95, tone, salt, true));
        return;
      }
      const core = leafCore(at, size * 0.88, tone.clone().multiplyScalar(0.78), salt);
      parts.push(core, leafSkin(core, size * 0.88, tone, salt + 100));
    };
    ends.forEach((end, i) => clump(end.clone().add(V(0, 0.04, 0)), 0.19 + r(60 + i) * 0.05, green(i), 10 + i + shape * 7));
    clump(crown.clone().add(V(0, 0.02, 0)), 0.24 + r(70) * 0.04, green(9), 31 + shape * 7);
    ends.forEach((end, i) => {
      const next = ends[(i + 1) % ends.length];
      const between = end.clone().lerp(next, 0.5).lerp(crown, 0.3 + r(80 + i) * 0.2);
      clump(between.add(V(0, 0.03 + r(90 + i) * 0.05, 0)), 0.16 + r(95 + i) * 0.05, green(10 + i), 40 + i + shape * 7);
    });
    const heart = ends.reduce((sum, end) => sum.add(end), crown.clone()).multiplyScalar(1 / (ends.length + 1));
    const sprigs = 11;
    for (let i = 0; i < sprigs; i++) {
      const a = turn + i * 2.4 + r(120 + i);
      const lift = 0.15 + (i / sprigs) * 0.85;
      const out = V(Math.sin(a) * Math.sqrt(1 - lift * lift * 0.8), lift * 0.62, Math.cos(a) * Math.sqrt(1 - lift * lift * 0.8));
      const at = heart.clone().add(out.multiplyScalar(spread * (0.9 + r(140 + i) * 0.2))).add(V(0, 0.04, 0));
      clump(at, 0.09 + r(160 + i) * 0.04, green(30 + i).multiplyScalar(1.08), 60 + i + shape * 7);
    }
  }
  const geo = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  geo.translate(0, -TREE_H / 2, 0);
  // The clumps' middles go down with the rest.
  const mark = geo.getAttribute("aLeaf") as THREE.BufferAttribute;
  for (let i = 0; i < mark.count; i++) if (mark.getW(i) > 0) mark.setY(i, mark.getY(i) - TREE_H / 2);
  return geo;
}

/** Hash a vertex's place, so the vertices a polyhedron's faces share move together and it stays closed. */
const lumpAt = (x: number, y: number, z: number, salt: number) => {
  const n = Math.sin(Math.round(x * 1000) * 12.9898 + Math.round(y * 1000) * 78.233 + Math.round(z * 1000) * 37.719 + salt * 4.11) * 43758.5453;
  return n - Math.floor(n);
};

/**
 * A boulder of radius about 1, knocked out of round, flat-ish underneath, with moss on the faces that look
 * up and lichen speckled on a few of the rest. `shape` picks one of a few.
 */
function boulderGeometry(shape: number): THREE.BufferGeometry {
  const g = (shape % 2 === 0 ? new THREE.IcosahedronGeometry(1, 1) : new THREE.DodecahedronGeometry(1, 0)).toNonIndexed();
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 0.78 + lumpAt(v.x, v.y, v.z, shape) * 0.4;
    v.multiplyScalar(k);
    // Settled into the ground: the underside pressed flatter.
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.35;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  const normal = g.getAttribute("normal") as THREE.BufferAttribute;
  const stone = new THREE.Color("#8a857a");
  const moss = new THREE.Color("#5f7a3e");
  const lichen = new THREE.Color("#b3ad8a");
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    // One colour a face (flat shading): its normal is the three vertices' together.
    const up = (normal.getY(f) + normal.getY(f + 1) + normal.getY(f + 2)) / 3;
    const cx = pos.getX(f) + pos.getX(f + 1), cz = pos.getZ(f) + pos.getZ(f + 1);
    const r = lumpAt(cx, up, cz, 9 + shape);
    if (up > 0.55 + r * 0.25) c.copy(stone).lerp(moss, 0.55 + r * 0.4);
    else if (r < 0.1) c.copy(lichen);
    else c.copy(stone).multiplyScalar(0.88 + r * 0.22);
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (f + k) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

interface Tree {
  mesh: THREE.InstancedMesh;
  index: number;
  /** Where it stands, and how it is turned and sized: all but the push (`base`), and that split into its move and the rest. */
  x: number;
  z: number;
  base: THREE.Matrix4;
  at: THREE.Matrix4;
  turn: THREE.Matrix4;
  size: number;
  /** The push: how far over the tip is (x, z) and how fast it is moving. */
  dx: number;
  dz: number;
  vx: number;
  vz: number;
  /** Taken out for a minigame's sake. */
  cleared: boolean;
}

export class Woods {
  readonly group = new THREE.Group();
  private trees: Tree[] = [];
  /** The boulders, each one instance; only kept so a minigame can take the ones in its way out for a while. */
  private rocks: { mesh: THREE.InstancedMesh; index: number; x: number; z: number; size: number; base: THREE.Matrix4; cleared: boolean }[] = [];
  /** The trees by the cell of a coarse grid they stand in, for finding the ones near a walker. */
  private cells = new Map<string, Tree[]>();
  /** Trees still swinging back upright. */
  private moving = new Set<Tree>();
  private meshes: THREE.InstancedMesh[] = [];
  private scratch = new THREE.Matrix4();
  private shear = new THREE.Matrix4();

  constructor(trees: TreeSpot[], boulders: BoulderSpot[], sodden: boolean, plain = false) {
    // Each kind of tree is one mesh; an oak or a snag, one for each of its shapes, made only where any stand.
    // Oaks are `stout`: the wind moves them their own way, and nobody walking by pushes them over.
    const shapeOf = (t: TreeSpot) => (((t.shape ?? 0) % OAK_SHAPES) + OAK_SHAPES) % OAK_SHAPES;
    const kinds: { of: (t: TreeSpot) => boolean; geometry: () => THREE.BufferGeometry; stout: boolean }[] = [
      { of: (t) => t.kind === "pine", geometry: () => pineGeometry(sodden), stout: false },
      { of: (t) => t.kind === "broad", geometry: () => broadGeometry(sodden), stout: false },
      ...Array.from({ length: OAK_SHAPES }, (_, shape) => ({ of: (t: TreeSpot) => t.kind === "oak" && shapeOf(t) === shape, geometry: () => oakGeometry(shape, false, sodden, plain), stout: true })),
      ...Array.from({ length: OAK_SHAPES }, (_, shape) => ({ of: (t: TreeSpot) => t.kind === "snag" && shapeOf(t) === shape, geometry: () => oakGeometry(shape, true, sodden), stout: true })),
    ];
    for (const kind of kinds) {
      const list = trees.filter(kind.of);
      if (kind.stout && list.length === 0) continue;
      const mesh = this.instanced(kind.geometry(), list.length);
      // Trees are drawn first, so whoever stands behind one can be shown through it (see silhouette.ts).
      mesh.renderOrder = HIDES;
      if (kind.stout) addOakSway(mesh.material as THREE.Material, TREE_H);
      else addWindSway(mesh.material as THREE.Material, TREE_H, true);
      list.forEach((spot, index) => {
        const base = new THREE.Matrix4().compose(
          new THREE.Vector3(spot.x, spot.y + (TREE_H / 2) * spot.size, spot.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw),
          new THREE.Vector3(spot.size, spot.size, spot.size),
        );
        mesh.setMatrixAt(index, base);
        mesh.setColorAt(index, spot.tint);
        const at = new THREE.Matrix4().copyPosition(base);
        const turn = base.clone().setPosition(0, 0, 0);
        const tree: Tree = { mesh, index, x: spot.x, z: spot.z, base, at, turn, size: spot.size, dx: 0, dz: 0, vx: 0, vz: 0, cleared: false };
        this.trees.push(tree);
        if (kind.stout) return;
        const cell = cellKey(spot.x, spot.z);
        const bucket = this.cells.get(cell);
        if (bucket) bucket.push(tree);
        else this.cells.set(cell, [tree]);
      });
    }
    const shapes = [0, 1, 2, 3].map(boulderGeometry);
    shapes.forEach((geometry, shape) => {
      const list = boulders.filter((b) => b.shape === shape);
      const mesh = this.instanced(geometry, list.length);
      list.forEach((b, i) => {
        const base = new THREE.Matrix4().compose(
          new THREE.Vector3(b.x, b.y + b.tall * 0.22, b.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(b.tilt, b.yaw, b.tilt * 0.6)),
          new THREE.Vector3(b.size, b.tall, b.size * (0.85 + (shape % 3) * 0.1)),
        );
        mesh.setMatrixAt(i, base);
        mesh.setColorAt(i, b.tint);
        this.rocks.push({ mesh, index: i, x: b.x, z: b.z, size: b.size, base, cleared: false });
      });
    });
  }

  private instanced(geometry: THREE.BufferGeometry, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), Math.max(1, count));
    mesh.count = count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A tree pushed over leans out of its bounding sphere a little; it is never worth culling a whole wood for.
    mesh.frustumCulled = false;
    this.meshes.push(mesh);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Once a frame. `walkers` are the feet of everyone on the map: a tree near one is pushed away from them,
   * and once they are past it springs back, overshooting a little.
   */
  update(dt: number, walkers: Iterable<THREE.Vector3>) {
    const step = Math.min(dt, 1 / 30);
    const pushed = new Map<Tree, { x: number; z: number }>();
    for (const w of walkers) {
      const cx = Math.floor(w.x / CELL), cz = Math.floor(w.z / CELL);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          for (const tree of this.cells.get(`${cx + i},${cz + j}`) ?? []) {
            if (tree.cleared) continue;
            const ox = tree.x - w.x, oz = tree.z - w.z;
            const reach = BRUSH_REACH * Math.max(0.8, tree.size);
            const d = Math.hypot(ox, oz);
            if (d > reach || d < 1e-4) continue;
            const k = (1 - d / reach) * BRUSH_LEAN;
            const goal = pushed.get(tree) ?? { x: 0, z: 0 };
            goal.x += (ox / d) * k;
            goal.z += (oz / d) * k;
            pushed.set(tree, goal);
          }
        }
    }
    for (const tree of pushed.keys()) this.moving.add(tree);
    if (this.moving.size === 0) return;
    const dirty = new Set<THREE.InstancedMesh>();
    for (const tree of this.moving) {
      const goal = pushed.get(tree) ?? { x: 0, z: 0 };
      tree.vx += (SPRING_K * (goal.x - tree.dx) - SPRING_C * tree.vx) * step;
      tree.vz += (SPRING_K * (goal.z - tree.dz) - SPRING_C * tree.vz) * step;
      tree.dx += tree.vx * step;
      tree.dz += tree.vz * step;
      const settled = !pushed.has(tree) && Math.abs(tree.dx) + Math.abs(tree.dz) < 1e-3 && Math.abs(tree.vx) + Math.abs(tree.vz) < 1e-2;
      if (settled) {
        tree.dx = tree.dz = tree.vx = tree.vz = 0;
        this.moving.delete(tree);
      }
      this.place(tree);
      dirty.add(tree.mesh);
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Set a tree's matrix: where it stands, bent over from its foot by its push. */
  private place(tree: Tree) {
    if (tree.cleared) return;
    // A shear in world space about the foot, which is half the tree's height under its middle.
    const h = (TREE_H / 2) * tree.size;
    // The push is a lean of the tip; spread it over the height, so it bends from the foot.
    const kx = tree.dx / (TREE_H * Math.max(0.6, tree.size)), kz = tree.dz / (TREE_H * Math.max(0.6, tree.size));
    this.shear.set(1, kx, 0, kx * h, 0, 1, 0, 0, 0, kz, 1, kz * h, 0, 0, 0, 1);
    // The base is T·R·S; the shear goes between T and the rest, so it bends in world directions.
    this.scratch.multiplyMatrices(tree.at, this.shear).multiply(tree.turn);
    tree.mesh.setMatrixAt(tree.index, this.scratch);
  }

  /** Take out the trees and boulders within `radius` of (x, z), so a minigame's things stand clear. Back with `restore`. */
  clear(x: number, z: number, radius: number) {
    this.clearWhere((px, pz, size) => Math.hypot(px - x, pz - z) <= radius + size * 0.5);
  }

  /**
   * Take out the trees and boulders within `radius` of the line from (ax, az) to (bx, bz): whatever would stand
   * between a minigame's eye and what it looks at. Back with `restore`.
   */
  clearAlong(ax: number, az: number, bx: number, bz: number, radius: number) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    this.clearWhere((px, pz, size) => {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
      return Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) <= radius + size * 0.5;
    });
  }

  private clearWhere(inside: (x: number, z: number, size: number) => boolean) {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const dirty = new Set<THREE.InstancedMesh>();
    for (const tree of this.trees) {
      if (tree.cleared || !inside(tree.x, tree.z, 0)) continue;
      tree.cleared = true;
      this.moving.delete(tree);
      tree.mesh.setMatrixAt(tree.index, hidden);
      dirty.add(tree.mesh);
    }
    for (const rock of this.rocks) {
      if (rock.cleared || !inside(rock.x, rock.z, rock.size)) continue;
      rock.cleared = true;
      rock.mesh.setMatrixAt(rock.index, hidden);
      dirty.add(rock.mesh);
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  restore() {
    const dirty = new Set<THREE.InstancedMesh>();
    for (const tree of this.trees) {
      if (!tree.cleared) continue;
      tree.cleared = false;
      tree.dx = tree.dz = tree.vx = tree.vz = 0;
      tree.mesh.setMatrixAt(tree.index, tree.base);
      dirty.add(tree.mesh);
    }
    for (const rock of this.rocks) {
      if (!rock.cleared) continue;
      rock.cleared = false;
      rock.mesh.setMatrixAt(rock.index, rock.base);
      dirty.add(rock.mesh);
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.clear();
  }
}

/** The coarse grid the trees are filed in: a cell is about a hex across. */
const CELL = 1.5;
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

/** A colour about 1 to multiply a tree's or rock's own by: `light` lifts or darkens it, `warm` pushes it toward yellow or blue. */
export function tintOf(light: number, warm: number): THREE.Color {
  const l = 0.84 + light * 0.32;
  const w = (warm - 0.5) * 0.16;
  return new THREE.Color(l * (1 + w), l * (1 + w * 0.4), l * (1 - w));
}
