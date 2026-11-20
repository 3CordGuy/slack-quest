// What stands in the sea off the Harbor: the lighthouse on its rocks, from surveyed to built, the black rocks
// and the wreck on them.

import * as THREE from "three";
import { beaconShine, type BuildingGlow } from "../ambience";
import { foldByLook, warmPane, type PlaceModel } from "./kit";

/** Rocks standing out of the sea. */
export const rocks: PlaceModel = (_poi, kit) => {
  const { add, lambert } = kit;
  // Black rocks standing out of the sea, wet and sharp.
  const rock = lambert("#3d4048");
  const pale = lambert("#565a63");
  add(new THREE.ConeGeometry(0.42, 0.9, 5), rock, -0.15, 0.3, 0.05, 0.4);
  add(new THREE.ConeGeometry(0.3, 0.6, 4), pale, 0.4, 0.18, -0.2, 1.1);
  add(new THREE.DodecahedronGeometry(0.26, 0), rock, 0.15, 0.02, 0.45, 0.7);
  add(new THREE.ConeGeometry(0.18, 0.4, 4), pale, -0.55, 0.08, -0.3, 2);
};

/** The wreck. */
export const wreck: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // A ship that did not make the harbour: the hull broken-backed on the rocks, ribs showing, the mast gone over the side.
  const hull = lambert("#4a3526");
  const dark = lambert("#33241a");
  const stern = add(box(1.1, 0.5, 0.62), hull, -0.35, 0.16, 0.0);
  stern.rotation.set(0.1, 0.25, -0.32);
  const bow = add(box(0.9, 0.42, 0.56), hull, 0.75, 0.02, 0.22);
  bow.rotation.set(-0.12, -0.3, 0.38);
  const deck = add(box(1.0, 0.05, 0.5), lambert("#6b5138"), -0.36, 0.44, 0.0);
  deck.rotation.copy(stern.rotation);
  for (let i = 0; i < 4; i++) add(box(0.05, 0.42, 0.05), dark, 0.18 + i * 0.13, 0.18 + i * 0.02, -0.26 + (i % 2) * 0.5).rotation.z = 0.2 + i * 0.12;
  const mast = add(new THREE.CylinderGeometry(0.045, 0.06, 1.7, 5), dark, -0.5, 0.75, 0.05);
  mast.rotation.z = -0.95;
  const yard = add(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4), dark, -1.0, 1.02, 0.05);
  yard.rotation.x = Math.PI / 2;
  const rag = add(box(0.03, 0.4, 0.55), lambert("#b9b3a3"), -1.0, 0.82, 0.05);
  rag.rotation.z = 0.25;
  add(new THREE.ConeGeometry(0.34, 0.7, 5), lambert("#3d4048"), 0.25, 0.18, -0.55, 0.6);
  add(new THREE.DodecahedronGeometry(0.24, 0), lambert("#565a63"), -0.9, 0.0, 0.5, 0.3);
};

/** The lighthouse: a crew project until it is built. */
export const lighthouse: PlaceModel = (poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The lighthouse, on the rocks at the end of the east spit. Every stage stands on the same rocky base, with weed at
  // the waterline and a rowboat drawn up on the rocks: it is how the stone comes out, and how the keeper goes ashore.
  const rock = lambert("#5d6270");
  const pale = lambert("#7b8291");
  add(new THREE.DodecahedronGeometry(0.42, 0), rock, -0.05, 0.02, 0.02, 0.3).scale.y = 0.55;
  add(new THREE.DodecahedronGeometry(0.3, 0), pale, 0.36, 0.0, 0.22, 1.2).scale.y = 0.6;
  add(new THREE.DodecahedronGeometry(0.26, 0), rock, -0.42, -0.02, 0.3, 0.8).scale.y = 0.5;
  add(new THREE.DodecahedronGeometry(0.2, 0), pale, 0.3, 0.0, -0.36, 2.1).scale.y = 0.6;
  for (const [x, z, s] of [[-0.62, -0.12, 0.13], [0.12, 0.62, 0.1], [-0.2, -0.5, 0.12]] as [number, number, number][]) add(new THREE.DodecahedronGeometry(s, 0), x < 0 ? pale : rock, x, 0.0, z, x * 4).scale.y = 0.6;
  const weed = lambert("#3f5a3a");
  for (const [x, z, s] of [[-0.3, 0.5, 0.14], [0.6, 0.05, 0.12], [-0.62, 0.15, 0.1], [0.05, -0.55, 0.12]] as [number, number, number][]) add(new THREE.DodecahedronGeometry(s, 0), weed, x, 0.0, z, z * 5).scale.y = 0.2;
  const base = 0.2;
  const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
  const white = lambert("#f1ece0");
  const red = lambert("#b9433d");
  const masonry = lambert("#9a958a");
  const block = lambert("#a3acba");
  const iron = lambert("#2b2a33");
  const timber = lambert("#4a2f22");
  const wood = lambert("#7a5230");
  const plank = lambert("#8a6a44");
  const rope = lambert("#c9a877");
  const brass = lambert("#e0b12e");
  const glows: BuildingGlow[] = [];
  const panes: THREE.MeshBasicMaterial[] = [];
  /** The tower is octagonal, turned so a flat face looks down the spit. */
  const TURN = Math.PI / 8;
  /** One band of the striped tower: radius at the bottom and top, height, and the course it starts on. */
  const course = (r0: number, r1: number, h: number, y: number, m: THREE.Material) => add(new THREE.CylinderGeometry(r1, r0, h, 8), m, 0, y + h / 2, 0, TURN);
  // The tower in four bands, tapering, alternately white and red.
  const BANDS = [0.34, 0.31, 0.28, 0.25, 0.22];
  const BAND_H = 0.36;
  const TOWER_FOOT = base + 0.14;
  /** How far out the tower's flat face is at height `y`. */
  const faceAt = (y: number) => (BANDS[0] - ((y - TOWER_FOOT) / (BAND_H * 4)) * (BANDS[0] - BANDS[4])) * Math.cos(Math.PI / 8);
  /** Something standing at a distance `d` from the tower's axis at angle `a` (0 is the front), turned to face out. */
  const onFace = (geo: THREE.BufferGeometry, m: THREE.Material, a: number, d: number, y: number) => add(geo, m, Math.sin(a) * d, y, Math.cos(a) * d, a);
  /** A ring of `n` straight pieces at radius `r`, height `y`, like a rail or a builder's line round the tower. */
  const ring = (r: number, y: number, n: number, m: THREE.Material, thick: number, phase = 0, glow = false) => {
    const side = 2 * r * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const b = phase + ((i + 0.5) / n) * Math.PI * 2;
      const length = add(box(side, thick, thick), m, Math.cos(b) * r * Math.cos(Math.PI / n), y, Math.sin(b) * r * Math.cos(Math.PI / n), -b - Math.PI / 2);
      if (glow) length.userData.glow = true;
    }
  };
  const plinth = () => {
    add(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), masonry, 0, base + 0.07, 0, TURN);
    add(new THREE.CylinderGeometry(0.41, 0.41, 0.025, 8), lambert("#7d786e"), 0, base + 0.14, 0, TURN);
  };
  const blocks = (spots: [number, number][]) => {
    for (const [x, z] of spots) add(box(0.14, 0.12, 0.14), block, x, base + 0.06, z, 0.4 + x);
  };
  // The rowboat, drawn up on the rocks with its oars across it.
  {
    const bx = 0.6, bz = 0.42, turn = 1.1;
    const part = (geo: THREE.BufferGeometry, m: THREE.Material, lx: number, y: number, lz: number) =>
      add(geo, m, bx + lx * Math.cos(turn) + lz * Math.sin(turn), y, bz - lx * Math.sin(turn) + lz * Math.cos(turn), turn);
    part(box(0.2, 0.08, 0.42), lambert("#6b4a2b"), 0, 0.08, 0);
    part(new THREE.ConeGeometry(0.1, 0.12, 4), lambert("#6b4a2b"), 0, 0.08, 0.26).rotation.set(Math.PI / 2, turn, 0, "YXZ");
    part(box(0.16, 0.02, 0.38), plank, 0, 0.115, 0);
    part(box(0.2, 0.02, 0.04), wood, 0, 0.13, 0.04);
    for (const s of [-1, 1]) part(box(0.02, 0.015, 0.5), lambert("#c9a877"), s * 0.04, 0.145, -0.02).rotation.y = turn + s * 0.15;
  }
  /** The scaffold round the tower: corner poles, ledgers and planks on every side at each lift, a brace across the front, and a ladder up to the first lift. */
  const scaffold = (height: number) => {
    for (const [x, z] of [[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36]]) add(new THREE.CylinderGeometry(0.03, 0.03, height, 5), wood, x, base + height / 2, z);
    for (let y = base + 0.35; y < base + height - 0.05; y += 0.4) {
      for (const z of [-0.36, 0.36]) {
        add(box(0.88, 0.035, 0.05), plank, 0, y, z);
        add(box(0.88, 0.02, 0.02), wood, 0, y - 0.03, z + Math.sign(z) * 0.03);
      }
      for (const x of [-0.42, 0.42]) add(box(0.05, 0.035, 0.76), plank, x, y, 0);
    }
    const rise = Math.min(height - 0.1, 0.8);
    add(box(Math.hypot(0.84, rise), 0.02, 0.02), wood, 0, base + rise / 2, 0.4).rotation.z = Math.atan2(rise, 0.84);
    const lean = 0.2;
    for (const x of [-0.3, -0.2]) add(box(0.02, 0.44, 0.02), wood, x, base + 0.2, 0.46).rotation.x = -lean;
    for (let i = 0; i < 3; i++) {
      const y = base + 0.06 + i * 0.12;
      add(box(0.1, 0.015, 0.015), wood, -0.25, y, 0.46 - (y - base - 0.2) * Math.tan(lean));
    }
  };
  /** A windlass on the rocks: two A-frames and a drum wound with rope. */
  const windlass = (x: number, z: number) => {
    for (const dz of [-0.1, 0.1]) for (const s of [-1, 1]) add(box(0.025, 0.24, 0.025), wood, x + s * 0.04, base + 0.1, z + dz).rotation.z = s * 0.3;
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 7), wood, x, base + 0.2, z).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.054, 0.054, 0.12, 7), rope, x, base + 0.2, z).rotation.x = Math.PI / 2;
    add(box(0.12, 0.02, 0.02), iron, x + 0.06, base + 0.2, z + 0.11);
  };
  if (poi.cleared) {
    // Built: a striped stone tower on a plinth with a coping, picked out at each course; a door up a flight of steps
    // with a lantern by it; windows that glow at dusk climbing the tower; the gallery on its corbels with a double rail;
    // the lantern room of glass on a red parapet, and a red cap with a vane. A keeper's cottage leans on the rocks
    // beside it with its chimney smoking, a fog bell hangs on a frame, and oil stands by the cottage door. The
    // ambience turns the beam and lights the glow.
    plinth();
    let y = TOWER_FOOT;
    for (let i = 0; i < 4; i++) {
      course(BANDS[i], BANDS[i + 1], BAND_H, y, i % 2 ? red : white);
      y += BAND_H;
      if (i < 3) add(new THREE.CylinderGeometry(BANDS[i + 1] + 0.012, BANDS[i + 1] + 0.012, 0.025, 8), i % 2 ? lambert("#8c3b2f") : lambert("#d9d1bf"), 0, y, 0, TURN);
    }
    // The door, framed in stone, up three steps; a lantern beside it.
    const d0 = faceAt(TOWER_FOOT + 0.14);
    onFace(box(0.17, 0.3, 0.03), masonry, 0, d0 + 0.005, TOWER_FOOT + 0.15);
    onFace(box(0.12, 0.25, 0.03), lambert("#4a3a2a"), 0, d0 + 0.015, TOWER_FOOT + 0.125);
    for (const dy of [0.06, 0.18]) onFace(box(0.12, 0.012, 0.012), iron, 0, d0 + 0.033, TOWER_FOOT + dy);
    onFace(box(0.025, 0.025, 0.02), brass, 0, d0 + 0.035, TOWER_FOOT + 0.12).position.x += 0.04;
    for (let i = 0; i < 3; i++) {
      const top = TOWER_FOOT - 0.05 * (i + 1);
      add(box(0.26, top - 0.02, 0.1), masonry, 0, (top + 0.02) / 2, 0.47 + i * 0.09);
    }
    add(box(0.02, 0.02, 0.07), iron, 0.13, TOWER_FOOT + 0.3, d0 + 0.035);
    add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), 0.13, TOWER_FOOT + 0.24, d0 + 0.07).userData.glow = true;
    add(new THREE.ConeGeometry(0.05, 0.04, 4), iron, 0.13, TOWER_FOOT + 0.29, d0 + 0.07, Math.PI / 4);
    add(box(0.06, 0.012, 0.06), iron, 0.13, TOWER_FOOT + 0.205, d0 + 0.07);
    glows.push({ pos: new THREE.Vector3(0.13, TOWER_FOOT + 0.24, d0 + 0.16), size: 0.3 });
    // Windows climbing the tower, each in a stone frame with a sill, glowing at dusk.
    const glass = warmPane("#c99a52", "#ffd98a");
    panes.push(glass);
    for (const [a, wy] of [[0, TOWER_FOOT + 0.62], [-Math.PI / 4, TOWER_FOOT + 0.98], [Math.PI / 4, TOWER_FOOT + 1.3]]) {
      const d = faceAt(wy);
      onFace(box(0.1, 0.14, 0.02), masonry, a, d + 0.004, wy);
      onFace(box(0.064, 0.1, 0.02), glass, a, d + 0.01, wy).userData.glow = true;
      onFace(box(0.12, 0.02, 0.04), masonry, a, d + 0.01, wy - 0.08);
      glows.push({ pos: new THREE.Vector3(Math.sin(a) * (d + 0.12), wy, Math.cos(a) * (d + 0.12)), size: 0.22 });
    }
    // The gallery: corbels under a broad slab, eight posts, and a top rail and a middle rail round it.
    const gy = y;
    for (let i = 0; i < 8; i++) onFace(box(0.05, 0.08, 0.08), masonry, (i / 8) * Math.PI * 2, 0.24, gy - 0.03);
    add(new THREE.CylinderGeometry(0.33, 0.27, 0.07, 8), lambert("#4a4458"), 0, gy + 0.035, 0, TURN);
    /**
     * Ironwork the lamp shines on as its beam comes round: a thin skin of light over each bar, post and rail,
     * dark until a beam points its way. All of it is one material, which lights each part by where it lies
     * round the lamp, so the shine runs along a rail rather than switching on a length at a time (the
     * ambience turns it with the beam; see `setBeacon`).
     */
    const shine = beaconShine();
    const glint = (w: number, h: number, r: number, y: number, a: number) => (add(box(w, h, w), shine, Math.cos(a) * r, y, Math.sin(a) * r).userData.glow = true);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      add(box(0.02, 0.14, 0.02), iron, Math.cos(a) * 0.3, gy + 0.14, Math.sin(a) * 0.3);
      glint(0.028, 0.15, 0.3, gy + 0.14, a);
    }
    ring(0.31, gy + 0.21, 8, iron, 0.022, Math.PI / 8);
    ring(0.31, gy + 0.14, 8, iron, 0.014, Math.PI / 8);
    // The same two rails again, a little fatter, as their skin of light.
    ring(0.31, gy + 0.21, 8, shine, 0.03, Math.PI / 8, true);
    ring(0.31, gy + 0.14, 8, shine, 0.022, Math.PI / 8, true);
    // The lantern room: a red parapet, a warm core behind glass, and eight dark glazing bars.
    const ly = gy + 0.07;
    add(new THREE.CylinderGeometry(0.19, 0.2, 0.08, 8), lambert("#8c3b2f"), 0, ly + 0.04, 0, TURN);
    add(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 6), new THREE.MeshBasicMaterial({ color: "#ffe9a8" }), 0, ly + 0.17, 0).userData.glow = true;
    add(new THREE.CylinderGeometry(0.17, 0.17, 0.22, 8), new THREE.MeshBasicMaterial({ color: "#ffd77a", transparent: true, opacity: 0.45, depthWrite: false }), 0, ly + 0.19, 0).userData.glow = true;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(box(0.018, 0.22, 0.018), iron, Math.cos(a) * 0.17, ly + 0.19, Math.sin(a) * 0.17);
      glint(0.026, 0.22, 0.17, ly + 0.19, a);
    }
    g.userData.shine = shine;
    // The cap: a dark red cone on a ring, a ball, a rod and a vane with an arrow.
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8), iron, 0, ly + 0.315, 0);
    add(new THREE.ConeGeometry(0.21, 0.2, 8), lambert("#8c3b2f"), 0, ly + 0.43, 0, TURN);
    add(new THREE.SphereGeometry(0.035, 6, 4), iron, 0, ly + 0.54, 0);
    add(box(0.012, 0.14, 0.012), iron, 0, ly + 0.61, 0);
    add(box(0.12, 0.012, 0.008), iron, 0.03, ly + 0.63, 0);
    add(new THREE.ConeGeometry(0.02, 0.04, 4), iron, 0.1, ly + 0.63, 0).rotation.z = -Math.PI / 2;
    add(box(0.04, 0.04, 0.008), iron, -0.04, ly + 0.63, 0, Math.PI / 4);
    // Where the beam turns from: the middle of the lantern.
    g.userData.beacon = new THREE.Vector3(0, ly + 0.17, 0);
    // The keeper's cottage on the rocks to the west: whitewashed, under a red roof, its window lit and its chimney smoking.
    const kx = -0.58, kz = 0.06, kb = 0.16;
    add(box(0.32, 0.04, 0.38), masonry, kx, kb - 0.02, kz);
    add(box(0.3, 0.22, 0.34), white, kx, kb + 0.11, kz);
    for (const x of [-0.15, 0.15]) for (const z of [-0.17, 0.17]) add(box(0.03, 0.22, 0.03), timber, kx + x, kb + 0.11, kz + z);
    const half = 0.19, rise = 0.14, len = 0.4;
    add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]), { depth: len - 0.04, bevelEnabled: false }).translate(0, 0, -(len - 0.04) / 2), white, kx, kb + 0.22, kz);
    const pitch = Math.atan2(rise, half), slope = Math.hypot(rise, half) * 1.1;
    for (const side of [1, -1]) {
      const along = slope / 2;
      add(box(slope, 0.04, len + 0.04), lambert("#8c3b2f"), kx + side * (along * Math.cos(pitch) + 0.02 * Math.sin(pitch)), kb + 0.22 + rise - along * Math.sin(pitch) + 0.02 * Math.cos(pitch), kz).rotation.z = -side * pitch;
    }
    add(box(0.06, 0.04, len + 0.08), lambert("#6e2e25"), kx, kb + 0.22 + rise + 0.02, kz);
    add(box(0.09, 0.15, 0.02), lambert("#4a3a2a"), kx - 0.06, kb + 0.075, kz + 0.175);
    add(box(0.09, 0.09, 0.012), timber, kx + 0.08, kb + 0.13, kz + 0.172);
    add(box(0.065, 0.065, 0.01), glass, kx + 0.08, kb + 0.13, kz + 0.178).userData.glow = true;
    glows.push({ pos: new THREE.Vector3(kx + 0.08, kb + 0.13, kz + 0.3), size: 0.22 });
    add(box(0.08, 0.24, 0.08), masonry, kx + 0.06, kb + 0.36, kz - 0.08);
    add(box(0.1, 0.03, 0.1), lambert("#7d786e"), kx + 0.06, kb + 0.49, kz - 0.08);
    g.userData.smoke = new THREE.Vector3(kx + 0.06, kb + 0.55, kz - 0.08);
    for (const [x, z, r] of [[kx + 0.2, kz + 0.28, 0.06], [kx + 0.08, kz + 0.33, 0.05]]) {
      add(new THREE.CylinderGeometry(r, r, 0.13, 7), wood, x, kb + 0.065, z);
      add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.015, 7), iron, x, kb + 0.1, z);
    }
    // The fog bell on its frame, on the rocks to the east.
    for (const x of [0.36, 0.56]) add(box(0.03, 0.38, 0.03), timber, x, 0.29, -0.3);
    add(box(0.26, 0.035, 0.04), timber, 0.46, 0.48, -0.3);
    add(new THREE.CylinderGeometry(0.035, 0.07, 0.11, 8), brass, 0.46, 0.4, -0.3);
    add(box(0.008, 0.08, 0.008), rope, 0.46, 0.3, -0.3);
    // A coil of rope by the boat.
    add(new THREE.TorusGeometry(0.06, 0.02, 4, 10), rope, 0.3, 0.22, 0.56).rotation.x = Math.PI / 2;
  } else if (fill >= 0.5) {
    // More than half paid for: the lower half of the tower is up inside its scaffold, the next course going on, a hoist
    // lifting a bucket of mortar, a windlass on the rocks, and a canvas lean-to where the masons shelter.
    plinth();
    course(BANDS[0], BANDS[1], BAND_H, TOWER_FOOT, white);
    course(BANDS[1], BANDS[2], BAND_H * 0.6, TOWER_FOOT + BAND_H, lambert("#c9c3b5"));
    for (let i = 0; i < 3; i++) onFace(box(0.12, 0.1, 0.1), lambert("#c9c3b5"), (i / 8) * Math.PI * 2 + 0.6, faceAt(TOWER_FOOT + BAND_H * 1.6) - 0.04, TOWER_FOOT + BAND_H * 1.6 + 0.05);
    scaffold(1.1);
    add(box(0.04, 0.04, 0.5), wood, 0.42, base + 1.12, 0.12);
    add(box(0.008, 0.5, 0.008), rope, 0.42, base + 0.86, 0.34);
    add(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 6), lambert("#5a3d22"), 0.42, base + 0.6, 0.34);
    blocks([[-0.5, 0.42], [-0.34, 0.5]]);
    windlass(0.56, -0.12);
    for (const z of [-0.12, 0.24]) add(box(0.03, 0.34, 0.03), wood, -0.66, base + 0.17, z);
    add(box(0.24, 0.015, 0.44), lambert("#e8dcc0"), -0.58, base + 0.28, 0.06).rotation.z = 0.5;
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 7), wood, -0.6, base + 0.06, 0.06);
  } else if (fill > 0) {
    // Begun: the plinth and the first course inside the scaffold's lower lift, stone stacked ready, planks, a tub of
    // mortar with a trowel, and a windlass to haul with.
    plinth();
    course(BANDS[0], 0.33, 0.12, TOWER_FOOT, lambert("#c9c3b5"));
    scaffold(0.7);
    blocks([[-0.5, 0.42], [-0.34, 0.5], [-0.46, 0.56]]);
    for (let i = 0; i < 3; i++) add(box(0.46, 0.04, 0.1), lambert(i % 2 ? "#c9a877" : "#8a6a44"), 0.12, base + 0.02 + i * 0.04, 0.6, 0.1 * i);
    add(box(0.18, 0.07, 0.13), wood, 0.58, base + 0.035, -0.2);
    add(box(0.15, 0.012, 0.1), lambert("#cfc8b8"), 0.58, base + 0.072, -0.2);
    add(box(0.07, 0.008, 0.035), iron, 0.6, base + 0.082, -0.18, 0.5);
    windlass(-0.6, -0.18);
  } else {
    // Not begun: the point is only surveyed. A ring of stakes marks where the tower will stand, strung with a line,
    // with a flag on one; the first stones and a crate of tools have come out by boat.
    const stake = lambert("#a07a4c");
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(box(0.035, 0.22, 0.035), stake, Math.cos(a) * 0.34, base + 0.08, Math.sin(a) * 0.34);
    }
    ring(0.34, base + 0.16, 6, lambert("#efe6cf"), 0.008);
    add(box(0.025, 0.5, 0.025), stake, 0.34, base + 0.22, 0);
    add(box(0.012, 0.12, 0.16), lambert("#b9433d"), 0.34, base + 0.4, 0.08);
    add(box(0.32, 0.03, 0.24), wood, -0.46, base + 0.015, 0.46);
    blocks([[-0.53, 0.42], [-0.39, 0.5]]);
    add(box(0.16, 0.12, 0.12), plank, -0.12, base + 0.06, 0.56, 0.3);
    add(box(0.17, 0.02, 0.13), wood, -0.12, base + 0.13, 0.56, 0.3);
  }
  g.userData.glows = glows;
  if (panes.length) g.userData.panes = panes;
  foldByLook(g);
};
