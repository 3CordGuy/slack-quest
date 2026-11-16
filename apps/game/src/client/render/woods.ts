// The island's trees and its boulder outcrops.
//
// Trees come in two kinds, pines and broadleaves, each one tinted, sized and
// turned its own way. Ordinary forest hexes have a couple each, to walk
// between; a thicket (a hex that cannot be walked through) is a crowd of big
// old ones with brush at their feet. They all lean in the wind, and anyone
// walking among them pushes them aside: they bend away as you pass and spring
// back with a wobble after.
//
// Outcrops are heaps of lumpy, mossy boulders on the hills, too big to climb.
// The same boulders, shoulder to shoulder, are the line that bounds the Harbor.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { addWindSway } from "./wind";

/** Every tree geometry is this tall, centred on y = 0 (as addWindSway expects); an instance scales it. */
const TREE_H = 1;
/** Within this far (world units) of a walker, a tree is pushed over. */
const BRUSH_REACH = 0.62;
/** How far over a tree goes when someone is right against it: the shear of its tip, per unit of height. */
const BRUSH_LEAN = 0.45;
/** The spring that stands it up again: stiffness and damping, per second. */
const SPRING_K = 70;
const SPRING_C = 5.5;

type Kind = "pine" | "broad";

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
  /** The trees by the cell of a coarse grid they stand in, for finding the ones near a walker. */
  private cells = new Map<string, Tree[]>();
  /** Trees still swinging back upright. */
  private moving = new Set<Tree>();
  private meshes: THREE.InstancedMesh[] = [];
  private scratch = new THREE.Matrix4();
  private shear = new THREE.Matrix4();

  constructor(trees: TreeSpot[], boulders: BoulderSpot[], sodden: boolean) {
    const kinds: Record<Kind, THREE.BufferGeometry> = { pine: pineGeometry(sodden), broad: broadGeometry(sodden) };
    for (const kind of ["pine", "broad"] as Kind[]) {
      const list = trees.filter((t) => t.kind === kind);
      const mesh = this.instanced(kinds[kind], list.length);
      addWindSway(mesh.material as THREE.Material, TREE_H, true);
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
        mesh.setMatrixAt(
          i,
          new THREE.Matrix4().compose(
            new THREE.Vector3(b.x, b.y + b.tall * 0.22, b.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(b.tilt, b.yaw, b.tilt * 0.6)),
            new THREE.Vector3(b.size, b.tall, b.size * (0.85 + (shape % 3) * 0.1)),
          ),
        );
        mesh.setColorAt(i, b.tint);
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

  /** Take out the trees within `radius` of (x, z), so a minigame's things stand clear. Back with `restore`. */
  clear(x: number, z: number, radius: number) {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const dirty = new Set<THREE.InstancedMesh>();
    for (const tree of this.trees) {
      if (tree.cleared || Math.hypot(tree.x - x, tree.z - z) > radius) continue;
      tree.cleared = true;
      this.moving.delete(tree);
      tree.mesh.setMatrixAt(tree.index, hidden);
      dirty.add(tree.mesh);
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
