// Where the crew goes to work in the Harbor: the fish shack and its jetty, the felling stump, the quarry face
// and the sparring ring.

import * as THREE from "three";
import type { BuildingGlow } from "../ambience";
import { foldByLook, warmPane, type PlaceModel } from "./kit";

/** The sparring ring. */
export const ring: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // Sparring ring: four posts, a rope, and a straw dummy.
  for (const [x, z] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.6], [0.55, 0.6]]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 5), lambert("#5a3d22"), x, 0.27, z);
  add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, -0.2);
  add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, 0.6);
  add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), -0.55, 0.45, 0.2);
  add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), 0.55, 0.45, 0.2);
  add(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 6), lambert("#d9b45a"), 0.2, 0.3, 0.1);
  add(new THREE.SphereGeometry(0.13, 6, 5), lambert("#d9b45a"), 0.2, 0.66, 0.1);
  add(box(0.5, 0.06, 0.06), lambert("#7a5230"), 0.2, 0.45, 0.1);
};

/** The fish shack. */
export const fishing: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The fish shack by the shore, kept to its own hex. A seafoam plank shack on a stone footing under a cedar-shingle roof, with a
  // carved fish for a sign on the ridge, a gull beside it and a smoking stovepipe. Its front is a serving hatch:
  // a counter of ice with the day's catch laid out, a striped awning on poles, a lantern, and the board where the
  // day's prices are chalked up. Fish dry on a line at one side over a brine barrel; crab pots under a net sit at the other, and buoys hang by the hatch.
  // A boardwalk runs from the hatch out to a jetty over the water, with a rod propped on it and a bucket.
  const timber = lambert("#4a2f22");
  const wood = lambert("#7a5230");
  const plank = lambert("#8a6a44");
  const deck = lambert("#9a7a52");
  const wall = lambert("#86a89d");
  const seam = lambert("#6a8b82");
  const trim = lambert("#f4efe1");
  const roofA = lambert("#7a4f3a");
  const roofB = lambert("#8f5f44");
  const stone = lambert("#8b95a5");
  const iron = lambert("#2b2a33");
  const rope = lambert("#c9a877");
  const blue = lambert("#3f6fa8");
  const red = lambert("#b9433d");
  const glows: BuildingGlow[] = [];
  const panes: THREE.MeshBasicMaterial[] = [];
  /** A fish lying along x: a flattened body, a tail fin and an eye-side belly stripe. */
  const fish = (x: number, y: number, z: number, c: string, len = 0.16, turn = 0) => {
    const body = add(new THREE.SphereGeometry(len / 2, 7, 5), lambert(c), x, y, z, turn);
    body.scale.set(1, 0.34, 0.42);
    const tail = add(new THREE.ConeGeometry(len * 0.2, len * 0.3, 4), lambert(c), x - Math.cos(turn) * len * 0.56, y, z + Math.sin(turn) * len * 0.56, turn);
    tail.rotation.z = -Math.PI / 2;
    tail.scale.set(1, 1, 0.3);
  };
  /** A fish hung by its tail from a line at `y`. */
  const hung = (x: number, y: number, z: number, c: string, len = 0.15) => {
    add(box(0.006, 0.04, 0.006), rope, x, y - 0.02, z);
    add(new THREE.ConeGeometry(len * 0.2, len * 0.28, 4), lambert(c), x, y - 0.06, z).scale.set(1, 1, 0.3);
    add(new THREE.SphereGeometry(len / 2, 6, 5), lambert(c), x, y - 0.06 - len * 0.55, z).scale.set(0.4, 1, 0.3);
  };

  // The shack: footing, plank walls with seams and corner posts, a cream trim board under the eaves.
  const sx = 0, sz = -0.4, sw = 0.9, sd = 0.44, top = 0.72;
  const front = sz + sd / 2;
  add(box(sw + 0.08, 0.1, sd + 0.08), stone, sx, 0.05, sz);
  add(box(sw, top - 0.1, sd), wall, sx, 0.1 + (top - 0.1) / 2, sz);
  for (let i = 0; i <= 10; i++) {
    const x = sx - sw / 2 + 0.04 + i * 0.082;
    // No seams across the hatch.
    if (Math.abs(x - sx) > 0.27) add(box(0.012, top - 0.12, 0.01), seam, x, 0.1 + (top - 0.1) / 2, front + 0.002);
  }
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) add(box(0.01, top - 0.12, 0.012), seam, sx + s * (sw / 2 + 0.002), 0.1 + (top - 0.1) / 2, sz - 0.16 + i * 0.08);
  for (const x of [-1, 1]) for (const z of [-1, 1]) add(box(0.05, top - 0.08, 0.05), trim, sx + x * (sw / 2), 0.1 + (top - 0.1) / 2, sz + z * (sd / 2));
  add(box(sw + 0.06, 0.04, sd + 0.06), trim, sx, top, sz);
  // The gabled roof, its ridge running along the front: plank gable ends, rows of shingles, a ridge board.
  const rise = 0.28, half = sd / 2 + 0.1;
  const gableShape = new THREE.Shape([new THREE.Vector2(-sd / 2, 0), new THREE.Vector2(sd / 2, 0), new THREE.Vector2(0, rise * (sd / 2) / half)]);
  const gable = add(new THREE.ExtrudeGeometry(gableShape, { depth: sw, bevelEnabled: false }), wall, sx - sw / 2, top + 0.02, sz, Math.PI / 2);
  gable.position.x = sx - sw / 2;
  const slope = Math.atan2(rise, half);
  const run = Math.hypot(rise, half);
  for (const s of [-1, 1]) {
    for (let row = 0; row < 4; row++) {
      const t = (row + 0.5) / 4;
      add(box(sw + 0.16, 0.035, run / 4 + 0.03), row % 2 ? roofA : roofB, sx, top + 0.04 + rise * (1 - t) + row * 0.004, sz + s * half * t).rotation.x = s * slope;
    }
  }
  add(box(sw + 0.18, 0.04, 0.06), timber, sx, top + 0.06 + rise, sz);
  // The stovepipe of the smoker, at the back.
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 6), iron, sx + 0.3, top + 0.32, sz - 0.12);
  add(new THREE.ConeGeometry(0.06, 0.05, 6), iron, sx + 0.3, top + 0.5, sz - 0.12);
  g.userData.smoke = new THREE.Vector3(sx + 0.3, top + 0.56, sz - 0.12);
  // The sign on the ridge: a carved fish on two iron stays.
  for (const x of [-0.34, -0.1]) add(box(0.015, 0.1, 0.015), iron, sx + x, top + rise + 0.12, sz);
  const signFish = add(new THREE.SphereGeometry(0.2, 8, 6), lambert("#e08a3c"), sx - 0.22, top + rise + 0.25, sz);
  signFish.scale.set(1, 0.42, 0.16);
  const signTail = add(new THREE.ConeGeometry(0.1, 0.14, 4), lambert("#e08a3c"), sx - 0.46, top + rise + 0.25, sz);
  signTail.rotation.z = -Math.PI / 2;
  signTail.scale.set(1, 1, 0.16);
  add(box(0.1, 0.012, 0.07), lambert("#f2c14e"), sx - 0.2, top + rise + 0.25, sz).rotation.z = 0.1;
  add(new THREE.SphereGeometry(0.018, 5, 4), iron, sx - 0.09, top + rise + 0.275, sz + 0.03);
  // A gull on the ridge.
  add(new THREE.SphereGeometry(0.05, 6, 5), trim, sx + 0.14, top + rise + 0.13, sz).scale.set(1.3, 0.8, 0.8);
  add(new THREE.SphereGeometry(0.03, 6, 5), trim, sx + 0.2, top + rise + 0.18, sz);
  add(box(0.08, 0.02, 0.085), lambert("#a9b4ba"), sx + 0.11, top + rise + 0.145, sz);
  add(new THREE.ConeGeometry(0.01, 0.035, 4), lambert("#e0b12e"), sx + 0.24, top + rise + 0.175, sz).rotation.z = -Math.PI / 2;
  for (const z of [-0.015, 0.015]) add(box(0.006, 0.05, 0.006), lambert("#e0b12e"), sx + 0.14, top + rise + 0.09, sz + z);

  // The serving hatch: a dark opening that glows with lamplight at dusk, a cream frame, shelves of jars inside.
  const hx = sx, hw = 0.46;
  const inside = warmPane("#2a211c", "#f0b866");
  panes.push(inside);
  add(box(hw, 0.34, 0.012), inside, hx, 0.5, front + 0.002).userData.glow = true;
  add(box(hw + 0.06, 0.03, 0.03), trim, hx, 0.685, front + 0.01);
  for (const s of [-1, 1]) add(box(0.03, 0.36, 0.03), trim, hx + s * (hw / 2 + 0.015), 0.5, front + 0.01);
  add(box(hw - 0.06, 0.015, 0.02), timber, hx, 0.56, front + 0.012);
  ["#c4473a", "#e0b12e", "#dfeef2", "#5f9e4a", "#d9843a"].forEach((c, i) => add(new THREE.CylinderGeometry(0.022, 0.022, 0.06, 6), lambert(c), hx - 0.16 + i * 0.08, 0.6, front + 0.014));
  glows.push({ pos: new THREE.Vector3(hx, 0.5, front + 0.16), size: 0.7 });
  // The counter under it: a plank front, a top, a bed of ice, and the catch laid out with a crab among it.
  const cz = front + 0.11;
  add(box(hw + 0.12, 0.3, 0.2), wood, hx, 0.17, cz);
  for (let i = -3; i <= 3; i++) add(box(0.01, 0.28, 0.01), timber, hx + i * 0.085, 0.17, cz + 0.102);
  add(box(hw + 0.18, 0.035, 0.25), deck, hx, 0.335, cz);
  add(box(hw + 0.06, 0.03, 0.19), lambert("#dfeef2"), hx, 0.365, cz);
  for (const [dx, dz] of [[-0.2, 0.06], [-0.05, -0.06], [0.13, 0.07], [0.22, -0.05]]) add(new THREE.OctahedronGeometry(0.03), lambert("#f3fbfd"), hx + dx, 0.385, cz + dz, dx * 5);
  fish(hx - 0.16, 0.395, cz - 0.03, "#9fb3c4", 0.16, 0.25);
  fish(hx - 0.01, 0.395, cz + 0.04, "#c4473a", 0.15, -0.3);
  fish(hx + 0.12, 0.395, cz - 0.04, "#3d7a7a", 0.16, 0.15);
  fish(hx - 0.15, 0.395, cz + 0.06, "#d9b45a", 0.11, -0.1);
  add(new THREE.SphereGeometry(0.035, 6, 4), lambert("#d9643a"), hx + 0.21, 0.395, cz + 0.03).scale.set(1.2, 0.5, 1);
  for (const s of [-1, 1]) add(box(0.03, 0.012, 0.012), lambert("#d9643a"), hx + 0.21 + s * 0.05, 0.395, cz + 0.06, s * 0.6);
  // The awning: blue and cream stripes sloping out over the counter on two poles, with a scalloped edge.
  const pitch = Math.atan2(0.12, 0.32);
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.02, 0.02, 0.74, 5), timber, hx + s * (hw / 2 + 0.07), 0.37, front + 0.29);
  for (let i = 0; i < 6; i++) {
    const c = i % 2 ? trim : blue;
    const x = hx - 0.25 + i * 0.1;
    add(box(0.1, 0.025, 0.34), c, x, 0.8, front + 0.15).rotation.x = pitch;
    add(box(0.07, 0.07, 0.015), c, x, 0.725, front + 0.31).rotation.z = Math.PI / 4;
  }
  add(box(hw + 0.2, 0.02, 0.02), timber, hx, 0.75, front + 0.3);
  // A lantern hung from the awning's corner.
  const lx = hx + hw / 2 + 0.07, lz = front + 0.33;
  add(box(0.006, 0.07, 0.006), iron, lx, 0.69, lz);
  add(new THREE.ConeGeometry(0.045, 0.04, 4), iron, lx, 0.655, lz, Math.PI / 4);
  add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), lx, 0.605, lz).userData.glow = true;
  add(box(0.06, 0.012, 0.06), iron, lx, 0.57, lz);
  glows.push({ pos: new THREE.Vector3(lx, 0.605, lz + 0.08), size: 0.4 });
  // The price board on the wall beside the hatch: slate in a frame, three chalked lines and a chalked fish.
  const bx = sx + 0.355;
  add(box(0.17, 0.34, 0.02), timber, bx, 0.46, front + 0.012);
  add(box(0.14, 0.3, 0.02), lambert("#22302a"), bx, 0.46, front + 0.018);
  for (let i = 0; i < 3; i++) add(box(0.1 - i * 0.02, 0.016, 0.01), lambert("#e8e4d8"), bx - 0.01 * i, 0.47 - i * 0.055, front + 0.03);
  add(new THREE.SphereGeometry(0.03, 6, 4), lambert("#e8e4d8"), bx + 0.01, 0.56, front + 0.026).scale.set(1, 0.45, 0.1);
  add(box(0.03, 0.03, 0.006), lambert("#e8e4d8"), bx - 0.03, 0.56, front + 0.03).rotation.z = Math.PI / 4;

  // The drying line at the east end: two posts, a rope, and the catch hung up by the tail.
  const dx0 = sx + sw / 2 + 0.07, dx1 = dx0 + 0.3, dz = sz + 0.18;
  for (const x of [dx0, dx1]) add(new THREE.CylinderGeometry(0.022, 0.028, 0.7, 5), timber, x, 0.35, dz);
  add(box(dx1 - dx0, 0.01, 0.01), rope, (dx0 + dx1) / 2, 0.66, dz);
  hung(dx0 + 0.05, 0.66, dz, "#9fb3c4", 0.16);
  hung(dx0 + 0.12, 0.66, dz, "#c98a5a", 0.13);
  hung(dx0 + 0.19, 0.66, dz, "#a9b4ba", 0.17);
  hung(dx0 + 0.25, 0.66, dz, "#c98a5a", 0.12);
  // A brine barrel and a coil of rope beneath it.
  add(new THREE.CylinderGeometry(0.1, 0.09, 0.24, 8), wood, dx0 + 0.13, 0.12, dz + 0.24);
  for (const y of [0.06, 0.19]) add(new THREE.CylinderGeometry(0.104, 0.104, 0.02, 8), iron, dx0 + 0.13, y, dz + 0.24);
  add(new THREE.CylinderGeometry(0.085, 0.085, 0.01, 8), lambert("#4f7f8c"), dx0 + 0.13, 0.243, dz + 0.24);
  for (const [r, y] of [[0.085, 0.02], [0.075, 0.05]]) add(new THREE.TorusGeometry(r, 0.02, 4, 10), rope, dx0 + 0.22, y, dz + 0.46).rotation.x = Math.PI / 2;

  // The west end: crab pots stacked with a net thrown over them and its cork floats, and buoys hung on the front
  // wall beside the hatch.
  const px = sx - sw / 2 - 0.17;
  const pot = (x: number, y: number, z: number, turn: number) => {
    add(box(0.22, 0.14, 0.18), lambert("#5e4630"), x, y, z, turn);
    add(box(0.23, 0.02, 0.19), rope, x, y + 0.07, z, turn);
    add(box(0.23, 0.02, 0.19), rope, x, y - 0.06, z, turn);
    for (const s of [-1, 0, 1]) add(box(0.015, 0.14, 0.185), plank, x + s * 0.085 * Math.cos(turn), y, z - s * 0.085 * Math.sin(turn), turn);
  };
  pot(px, 0.08, sz + 0.26, 0.15);
  pot(px + 0.02, 0.23, sz + 0.26, -0.2);
  pot(px - 0.01, 0.08, sz + 0.04, -0.1);
  const net = lambert("#4f6b62");
  add(box(0.2, 0.012, 0.2), net, px - 0.01, 0.158, sz + 0.04, 0.5);
  add(box(0.012, 0.15, 0.2), net, px - 0.125, 0.085, sz + 0.04, -0.1).rotation.z = -0.12;
  for (let i = 0; i < 4; i++) add(new THREE.SphereGeometry(0.02, 5, 4), lambert("#d9a066"), px - 0.1 + i * 0.06, 0.17, sz + 0.13 - i * 0.02);
  [["#c4473a", 0.5], ["#f2c14e", 0.4], ["#3f6fa8", 0.47]].forEach(([c, y], i) => {
    const x = sx - 0.4 + i * 0.065;
    add(box(0.006, 0.64 - (y as number), 0.006), rope, x, (0.64 + (y as number)) / 2, front + 0.02);
    add(new THREE.SphereGeometry(0.036, 6, 5), lambert(c as string), x, (y as number) - 0.03, front + 0.035).scale.set(0.8, 1.3, 0.8);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.018, 6), trim, x, (y as number) - 0.03, front + 0.035);
  });
  add(box(0.2, 0.02, 0.02), timber, sx - 0.335, 0.65, front + 0.02);

  // The boardwalk from the hatch to the jetty, and the jetty out over the water on four posts with rope collars.
  add(box(0.66, 0.03, 0.46), plank, 0, 0.015, 0.04);
  for (let i = 0; i < 5; i++) add(box(0.66, 0.006, 0.012), timber, 0, 0.032, -0.14 + i * 0.09);
  add(box(0.56, 0.06, 1.04), plank, 0, 0.03, 0.77);
  for (let i = 0; i < 10; i++) add(box(0.56, 0.006, 0.012), timber, 0, 0.062, 0.3 + i * 0.1);
  for (const z of [0.75, 1.24]) for (const x of [-0.26, 0.26]) {
    add(new THREE.CylinderGeometry(0.045, 0.045, 0.72, 6), timber, x, -0.14, z);
    add(new THREE.CylinderGeometry(0.052, 0.052, 0.04, 6), rope, x, 0.13, z);
    add(new THREE.CylinderGeometry(0.03, 0.045, 0.03, 6), lambert("#6b5138"), x, 0.235, z);
  }
  // A lantern on the far post, to fish by after dark.
  add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.26, 0.285, 1.24).userData.glow = true;
  add(new THREE.ConeGeometry(0.045, 0.035, 4), iron, -0.26, 0.332, 1.24, Math.PI / 4);
  glows.push({ pos: new THREE.Vector3(-0.26, 0.285, 1.3), size: 0.4 });
  // The rod propped on a forked rest with its line in the sea and a red float, a bucket with a fish in it, and a tackle box.
  add(box(0.02, 0.2, 0.02), timber, 0.1, 0.16, 1.02);
  add(new THREE.CylinderGeometry(0.02, 0.03, 1.2, 5), rope, 0.1, 0.5, 1.3).rotation.x = Math.PI / 4;
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6), lambert("#e0b12e"), 0.13, 0.25, 1.02).rotation.z = Math.PI / 2;
  add(box(0.012, 0.95, 0.012), trim, 0.1, 0.44, 1.72);
  add(new THREE.OctahedronGeometry(0.06), red, 0.1, -0.02, 1.72);
  add(new THREE.CylinderGeometry(0.11, 0.09, 0.18, 7), lambert("#6f7f95"), -0.14, 0.15, 0.62);
  add(new THREE.TorusGeometry(0.1, 0.008, 4, 10, Math.PI), iron, -0.14, 0.24, 0.62);
  add(new THREE.CylinderGeometry(0.095, 0.095, 0.01, 7), lambert("#4f7f8c"), -0.14, 0.225, 0.62);
  add(new THREE.ConeGeometry(0.03, 0.05, 4), lambert("#9fb3c4"), -0.12, 0.25, 0.63).scale.set(1, 1, 0.3);
  add(box(0.16, 0.08, 0.1), lambert("#3d7a5a"), 0.16, 0.1, 0.5, 0.3);
  add(box(0.165, 0.015, 0.105), iron, 0.16, 0.145, 0.5, 0.3);
  add(box(0.05, 0.02, 0.012), lambert("#e0b12e"), 0.16, 0.165, 0.5, 0.3);
  g.userData.glows = glows;
  g.userData.panes = panes;
  foldByLook(g);
};

/** The felling stump. */
export const felling: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // A stump with an axe in it, and a stack of cut logs.
  add(new THREE.CylinderGeometry(0.2, 0.24, 0.24, 7), lambert("#7a5230"), -0.3, 0.12, 0.35);
  add(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 7), lambert("#d9b45a"), -0.3, 0.25, 0.35);
  add(box(0.04, 0.42, 0.04), lambert("#5a3d22"), -0.3, 0.46, 0.35).rotation.z = -0.5;
  add(box(0.16, 0.12, 0.03), lambert("#c9d1dc"), -0.36, 0.33, 0.35).rotation.z = -0.5;
  for (const [x, y] of [[0.2, 0.08], [0.38, 0.08], [0.56, 0.08], [0.29, 0.23], [0.47, 0.23]]) {
    add(new THREE.CylinderGeometry(0.085, 0.085, 0.6, 6), lambert("#8a5a2b"), x, y, 0.4).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.61, 6), lambert("#d9b45a"), x, y, 0.4).rotation.x = Math.PI / 2;
  }
};

/** The quarry. */
export const quarry: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // A cut rock face with squared blocks at its foot and a pick leaning on them.
  add(box(0.95, 0.6, 0.3), lambert("#8b95a5"), 0, 0.3, -0.05);
  add(box(0.5, 0.3, 0.28), lambert("#7b8494"), -0.2, 0.75, -0.05);
  add(box(0.14, 0.1, 0.02), lambert("#c8743a"), 0.25, 0.4, 0.11);
  add(box(0.1, 0.08, 0.02), lambert("#c9d1dc"), -0.25, 0.3, 0.11);
  add(box(0.28, 0.2, 0.24), lambert("#a3acba"), -0.3, 0.1, 0.45);
  add(box(0.22, 0.16, 0.2), lambert("#959eac"), 0.0, 0.08, 0.55);
  add(box(0.04, 0.5, 0.04), lambert("#5a3d22"), 0.35, 0.25, 0.4).rotation.z = 0.35;
  add(box(0.34, 0.05, 0.05), lambert("#4a4f5a"), 0.27, 0.49, 0.4).rotation.z = 0.35;
};
