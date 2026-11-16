// The rowboat a hero takes out on the water: a small clinker-ish dinghy, drawn
// low-poly. Its hull is lofted from a few cross-sections, pointed at the bow
// and square at the transom, painted in two strakes, with a gunwale rail,
// thwarts to sit on, and oarlocks on raised posts. The oars are loose: the
// renderer puts each one's handle in the rower's fist and lays it through its
// oarlock every frame (see aimOar), so the blades swing and dip as the arms
// pull and push.
//
// The boat's bow is toward +z and its middle on its own origin at the waterline. It is modelled in its own
// units and drawn BOAT_SCALE times as big: the places below are in its own units.

import * as THREE from "three";

/** How much bigger than modelled the boat is drawn, to seat a hero with room round them. */
export const BOAT_SCALE = 1.2;
/** Where the rower sits: the top of the middle thwart, in the boat's frame. */
export const ROWER_SEAT = new THREE.Vector3(0, 0.1, -0.08);
/** Where each oar is held (the pin of its oarlock), left then right. A figure faces +z, so its left hand is at +x. */
export const OARLOCKS: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.47, 0.3, 0.06), new THREE.Vector3(-0.47, 0.3, 0.06)];
/** An oar's length, handle to blade tip. */
const OAR = 1.0;

/** The hull's lines: at each station along it (z), how wide it is at the gunwale, how high the gunwale is, and how deep the keel. */
const STATIONS: { z: number; half: number; top: number; keel: number }[] = [
  { z: -0.62, half: 0.27, top: 0.25, keel: -0.04 },
  { z: -0.42, half: 0.36, top: 0.23, keel: -0.08 },
  { z: -0.12, half: 0.4, top: 0.22, keel: -0.09 },
  { z: 0.2, half: 0.37, top: 0.23, keel: -0.09 },
  { z: 0.46, half: 0.27, top: 0.26, keel: -0.07 },
  { z: 0.66, half: 0.13, top: 0.3, keel: -0.03 },
  { z: 0.8, half: 0, top: 0.35, keel: 0.04 },
];

const TOPSIDE = new THREE.Color("#3b6e8c");
const STRIPE = new THREE.Color("#e9e0c8");
const BOTTOM = new THREE.Color("#5a3d2a");
const INSIDE = new THREE.Color("#b08452");
const TIMBER = "#7a5634";
const OARWOOD = "#c99b62";

/**
 * A cross-section at a station, from the port gunwale down to the keel and up to the starboard gunwale: the
 * gunwale, a stripe just below it, the turn of the bilge, and the keel. `inset` shrinks it toward the inside.
 */
function section(s: (typeof STATIONS)[number], inset = 0): number[][] {
  const w = Math.max(0, s.half - inset);
  const top = s.top - inset * 0.3;
  const keel = s.keel + inset * 1.2;
  const stripe = top - 0.045;
  const bilge = keel + (top - keel) * 0.35;
  return [
    [w, top, s.z],
    [w * 0.98, stripe, s.z],
    [w * 0.84, bilge, s.z],
    [0, keel, s.z],
    [-w * 0.84, bilge, s.z],
    [-w * 0.98, stripe, s.z],
    [-w, top, s.z],
  ];
}

/** Which colour each band of a section is painted, outside: the stripe under the gunwale, the topsides, the bottom. */
const BANDS = [STRIPE, TOPSIDE, BOTTOM, BOTTOM, TOPSIDE, STRIPE];

/** The hull's skin, lofted between the stations: outside (faces out, painted) or inside (faces in, bare wood). */
function hullSkin(inside: boolean): THREE.BufferGeometry {
  const inset = inside ? 0.025 : 0;
  const rings = STATIONS.map((s) => section(s, inset));
  const pos: number[] = [];
  const col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], color: THREE.Color) => {
    for (const v of inside ? [a, c, b] : [a, b, c]) {
      pos.push(v[0], v[1], v[2]);
      col.push(color.r, color.g, color.b);
    }
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < a.length - 1; j++) {
      const color = inside ? INSIDE.clone().multiplyScalar(0.92 + (j % 2) * 0.1) : BANDS[j];
      tri(a[j], b[j], b[j + 1], color);
      tri(a[j], b[j + 1], a[j + 1], color);
    }
  }
  // The transom: the stern closed off flat.
  const stern = rings[0];
  for (let j = 1; j < stern.length - 1; j++) {
    const color = inside ? INSIDE : j === 1 || j === stern.length - 2 ? STRIPE : TOPSIDE;
    tri(stern[0], stern[j + 1], stern[j], color);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A length of timber from one point to another, `w` wide and `h` deep. */
function beam(from: THREE.Vector3, to: THREE.Vector3, w: number, h: number, material: THREE.Material): THREE.Mesh {
  const along = to.clone().sub(from);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, along.length()), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along.normalize());
  return mesh;
}

/** An oar, its handle on its origin and its shaft along +x to the blade. */
function oarModel(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: OARWOOD, flatShading: true });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 6), new THREE.MeshLambertMaterial({ color: "#8a6440", flatShading: true }));
  grip.rotation.z = Math.PI / 2;
  grip.position.x = 0.04;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, OAR - 0.3, 6), wood);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = 0.09 + (OAR - 0.3) / 2;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.075, 0.016), wood);
  blade.position.x = OAR - 0.12;
  // The blade's tip, painted like the topsides.
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.077, 0.018), new THREE.MeshLambertMaterial({ color: TOPSIDE, flatShading: true }));
  tip.position.x = OAR - 0.025;
  for (const part of [grip, shaft, blade, tip]) {
    part.castShadow = true;
    g.add(part);
  }
  return g;
}

export interface Rowboat {
  group: THREE.Group;
  /** The oars, left then right, each to be laid with aimOar. */
  oars: [THREE.Group, THREE.Group];
}

export function rowboatModel(): Rowboat {
  const group = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const outside = new THREE.Mesh(hullSkin(false), skin);
  const inside = new THREE.Mesh(hullSkin(true), skin);
  outside.castShadow = true;
  group.add(outside, inside);
  const timber = new THREE.MeshLambertMaterial({ color: TIMBER, flatShading: true });
  const iron = new THREE.MeshLambertMaterial({ color: "#3d3a38", flatShading: true });
  // Floorboards down the middle.
  for (const x of [-0.09, 0, 0.09]) group.add(beam(new THREE.Vector3(x, -0.035, -0.5), new THREE.Vector3(x, -0.035, 0.5), 0.08, 0.015, new THREE.MeshLambertMaterial({ color: x === 0 ? "#c19463" : "#b5895a", flatShading: true })));
  // The gunwale rail, capping the sides from the transom round to the stem.
  for (const side of [1, -1]) {
    for (let i = 0; i < STATIONS.length - 1; i++) {
      const a = STATIONS[i], b = STATIONS[i + 1];
      group.add(beam(new THREE.Vector3(side * a.half, a.top + 0.01, a.z), new THREE.Vector3(side * b.half, b.top + 0.01, b.z), 0.035, 0.03, timber));
    }
  }
  group.add(beam(new THREE.Vector3(-0.27, 0.26, -0.625), new THREE.Vector3(0.27, 0.26, -0.625), 0.035, 0.03, timber));
  // The stem post, standing a little proud of the bow.
  group.add(beam(new THREE.Vector3(0, -0.03, 0.78), new THREE.Vector3(0, 0.4, 0.82), 0.04, 0.04, timber));
  // Thwarts: the rower's in the middle, one in the bow, and a stern seat.
  const thwart = (z: number, half: number, y: number) => group.add(beam(new THREE.Vector3(-half, y, z), new THREE.Vector3(half, y, z), 0.13, 0.025, timber));
  thwart(ROWER_SEAT.z, 0.36, ROWER_SEAT.y - 0.012);
  thwart(0.42, 0.28, 0.13);
  group.add(beam(new THREE.Vector3(-0.24, 0.14, -0.56), new THREE.Vector3(0.24, 0.14, -0.56), 0.12, 0.025, timber));
  // The oarlocks: a block on the gunwale, raised, and a pair of iron pins the oar lies between.
  for (const lock of OARLOCKS) {
    const s = Math.sign(lock.x);
    group.add(beam(new THREE.Vector3(s * 0.41, 0.235, lock.z), new THREE.Vector3(s * 0.45, lock.y - 0.025, lock.z), 0.06, 0.06, timber));
    for (const dz of [-0.03, 0.03]) {
      const pin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.012), iron);
      pin.position.set(lock.x, lock.y + 0.01, lock.z + dz);
      group.add(pin);
    }
  }
  // A coil of rope and a bailing tin in the bilge, aft.
  const rope = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 4, 9), new THREE.MeshLambertMaterial({ color: "#c9b383", flatShading: true }));
  rope.rotation.x = Math.PI / 2;
  rope.position.set(0.12, -0.01, -0.42);
  const tin = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.05, 7), iron);
  tin.position.set(-0.14, -0.005, -0.38);
  group.add(rope, tin);
  const oars: [THREE.Group, THREE.Group] = [oarModel(), oarModel()];
  group.add(...oars);
  group.scale.setScalar(BOAT_SCALE);
  return { group, oars };
}

const along = new THREE.Vector3(1, 0, 0);
const scratch = new THREE.Vector3();

/**
 * Lay an oar with its handle at `hand` and its shaft through `lock` (both in the boat's own units), so the blade
 * goes out the far side: down into the water as the hand comes up, and out of it as the hand goes down.
 */
export function aimOar(oar: THREE.Group, hand: THREE.Vector3, lock: THREE.Vector3) {
  scratch.copy(lock).sub(hand);
  if (scratch.lengthSq() < 1e-6) return;
  oar.position.copy(hand);
  oar.quaternion.setFromUnitVectors(along, scratch.normalize());
}

/** With nobody at the oars (fishing, say): each laid in along its gunwale, handle forward, blade over the stern. */
export function shipOar(oar: THREE.Group, lock: THREE.Vector3) {
  const s = Math.sign(lock.x);
  oar.position.set(lock.x - s * 0.06, lock.y + 0.02, lock.z + 0.32);
  oar.quaternion.setFromUnitVectors(along, scratch.set(s * 0.03, -0.02, -1).normalize());
}
