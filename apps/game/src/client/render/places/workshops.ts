// The crew's three workshops in the Harbor: the apothecary, the smithy and the galley. One model for the
// three, as they share their kit and the stages they are built in (a fenced site, then three stages of
// building as the crew pays in), and differ in their walls, roof and trim and in what stands round them.

import * as THREE from "three";
import type { BuildingGlow } from "../ambience";
import { foldByLook, warmPane, type PlaceModel } from "./kit";

/** The apothecary, the smithy or the galley (by `poi.kind`): a crew project until it is built. */
export const workshop: PlaceModel = (poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The crew's three workshops share a kit with the huts and the pub: dark timbers, dressed stone, ironwork, glass
  // that warms at dusk, and gabled roofs with darker courses of shingle. Each trade has its own roof and trim colour.
  const kind = poi.kind;
  const timber = lambert("#4a2f22");
  const plaster = lambert("#e6dcc0");
  const stone = lambert("#a8977a");
  const footing = lambert("#7b8494");
  const iron = lambert("#2b2a33");
  const wood = lambert("#7a5230");
  const plank = lambert("#a07a4c");
  const boards = lambert("#8a6a44");
  const brass = lambert("#e0b12e");
  const copper = lambert("#c8743a");
  const steel = lambert("#3a3d44");
  const sacking = lambert("#d8c7a0");
  const roofHex = kind === "apothecary" ? "#2f5a3a" : kind === "galley" ? "#a0522d" : "#4a4f5a";
  const roofMat = lambert(roofHex);
  const roofDark = lambert("#" + new THREE.Color(roofHex).multiplyScalar(0.72).getHexString());
  const trim = lambert(kind === "apothecary" ? "#3e6a44" : kind === "galley" ? "#7a3a22" : "#3a3d44");
  /** What the trade's walls are made of: plaster for the apothecary, dressed stone for the smithy, planks for the galley. */
  const wallMat = kind === "apothecary" ? plaster : kind === "galley" ? boards : lambert("#9a958a");
  const glows: BuildingGlow[] = [];
  const panes: THREE.MeshBasicMaterial[] = [];
  const glass = warmPane(kind === "apothecary" ? "#b9a064" : "#c99a52", kind === "apothecary" ? "#ffe2a0" : "#ffd08a");
  const finish = () => {
    g.userData.glows = glows;
    if (panes.length) g.userData.panes = panes;
    foldByLook(g);
  };
  /** A framed window on a front wall at `z`, with glazing bars, shutters in the trade's colour, and a halo at dusk. */
  const framed = (x: number, y: number, w: number, h: number, z: number, shutters = true) => {
    if (!panes.length) panes.push(glass);
    add(box(w + 0.04, h + 0.04, 0.012), timber, x, y, z);
    add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
    add(box(0.015, h, 0.012), timber, x, y, z + 0.014);
    add(box(w, 0.015, 0.012), timber, x, y, z + 0.014);
    if (shutters) for (const s of [-1, 1]) add(box(0.045, h + 0.02, 0.014), trim, x + s * (w / 2 + 0.045), y, z + 0.008);
    glows.push({ pos: new THREE.Vector3(x, y, z + 0.14), size: w * 2.2 });
  };
  /** A gabled roof with its ridge along x (or along z with `alongZ`): a prism of `end` under two overhanging slabs, darker shingle courses `bands` down from the ridge, and a ridge cap. */
  const roof = (cx: number, cy: number, cz: number, len: number, half: number, rise: number, end: THREE.Material, bands: number[], alongZ = false) => {
    const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
    const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
    add(alongZ ? prism : prism.rotateY(Math.PI / 2), end, cx, cy, cz);
    const pitch = Math.atan2(rise, half);
    const slope = Math.hypot(rise, half) * 1.08;
    for (const side of [1, -1]) {
      /** A slab `depth` long down the slope, its middle `along` from the ridge. */
      const slab = (along: number, depth: number, m: THREE.Material, thick: number) => {
        const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
        const y = cy + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
        if (alongZ) add(box(depth, thick, len + 0.12), m, cx + out, y, cz).rotation.z = -side * pitch;
        else add(box(len + 0.12, thick, depth), m, cx, y, cz + out).rotation.x = side * pitch;
      };
      slab(slope / 2, slope, roofMat, 0.06);
      for (const d of bands) slab(d, 0.05, roofDark, 0.065);
    }
    add(alongZ ? box(0.08, 0.06, len + 0.2) : box(len + 0.2, 0.06, 0.08), roofDark, cx, cy + rise + 0.03, cz);
  };
  /** A lantern on a bracket from the wall behind it, lit at dusk. */
  const lantern = (x: number, y: number, z: number) => {
    add(box(0.03, 0.02, 0.08), iron, x, y + 0.07, z - 0.04);
    add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, y, z).userData.glow = true;
    for (const [dx, dz] of [[-0.03, -0.03], [0.03, -0.03], [-0.03, 0.03], [0.03, 0.03]]) add(box(0.01, 0.08, 0.01), iron, x + dx, y, z + dz);
    add(box(0.08, 0.015, 0.08), iron, x, y - 0.045, z);
    add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, y + 0.06, z, Math.PI / 4);
    glows.push({ pos: new THREE.Vector3(x, y, z + 0.1), size: 0.34 });
  };
  const barrel = (x: number, z: number, r = 0.08, h = 0.18, y = 0) => {
    add(new THREE.CylinderGeometry(r, r, h, 8), wood, x, y + h / 2, z);
    for (const t of [0.25, 0.75]) add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.02, 8), timber, x, y + h * t, z);
  };
  const sack = (x: number, z: number, turn: number, y = 0) => {
    add(box(0.12, 0.14, 0.1), sacking, x, y + 0.07, z, turn);
    add(box(0.06, 0.03, 0.05), boards, x, y + 0.155, z, turn);
  };
  /** The trade's mark, in pale relief on a board: a cross for the apothecary, an anvil for the smithy, a fish for the galley. Faces ±x with `faceX`, else ±z. */
  const emblem = (x: number, y: number, z: number, faceX: boolean) => {
    const mark = lambert(kind === "apothecary" ? "#f0ead0" : "#d6dce4");
    const at = (u: number, v: number, w: number, h: number) => add(faceX ? box(0.054, h, w) : box(w, h, 0.04), mark, faceX ? x : x + u, y + v, faceX ? z + u : z);
    if (kind === "apothecary") {
      at(0, 0, 0.034, 0.1);
      at(0, 0, 0.1, 0.034);
    } else if (kind === "smithy") {
      at(0.01, 0.035, 0.12, 0.03);
      at(-0.07, 0.04, 0.04, 0.018);
      at(0.01, 0, 0.05, 0.04);
      at(0.01, -0.04, 0.1, 0.03);
    } else {
      at(-0.015, 0, 0.11, 0.05);
      at(0.06, 0, 0.03, 0.075);
    }
  };
  /** A sign swinging from an iron bracket out of the wall at `zWall`, its face to the side so it reads from the lane. */
  const sign = (x: number, y: number, zWall: number) => {
    add(box(0.03, 0.03, 0.28), iron, x, y, zWall + 0.14);
    for (const dz of [0.09, 0.25]) add(box(0.008, 0.07, 0.008), iron, x, y - 0.035, zWall + dz);
    add(box(0.04, 0.24, 0.24), timber, x, y - 0.16, zWall + 0.17);
    add(box(0.046, 0.2, 0.2), kind === "apothecary" ? lambert("#3f8a46") : kind === "galley" ? lambert("#7a3a22") : lambert("#2c2a2e"), x, y - 0.16, zWall + 0.17);
    emblem(x, y - 0.16, zWall + 0.17, true);
  };
  const planks = (x: number, z: number, n: number) => {
    for (let i = 0; i < n; i++) add(box(0.5, 0.05, 0.12), i % 2 ? plank : boards, x, 0.03 + i * 0.05, z + i * 0.01, 0.15 * i);
    if (n > 1) for (const dx of [-0.14, 0.14]) add(box(0.02, n * 0.05 + 0.01, 0.13), iron, x + dx, 0.005 + n * 0.025, z + 0.01 * (n - 1) / 2, 0.15 * (n - 1) / 2);
  };
  const stones = (spots: [number, number, number][]) => {
    for (const [x, y, z] of spots) add(box(0.14, 0.12, 0.14), lambert("#959eac"), x, y, z, 0.3 + x);
  };
  /** The trade's own makings, waiting to go in: sacks of herbs, iron bars, or furs and bones. */
  const makings = (x: number, z: number) => {
    if (kind === "galley") {
      for (const [dx, dz, c] of [[-0.12, -0.03, "#7a5a3a"], [0.1, 0.03, "#9a7a55"]] as [number, number, string][]) add(box(0.22, 0.12, 0.16), lambert(c), x + dx, 0.06, z + dz, 0.3);
      for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 4), lambert("#ece4cf"), x + 0.3 + (i % 2) * 0.06, 0.04 + Math.floor(i / 2) * 0.04, z + 0.02).rotation.z = Math.PI / 2 + i * 0.5;
    } else if (kind === "apothecary") {
      for (const [dx, dz] of [[-0.15, 0], [0.15, 0.05]]) {
        add(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 6), lambert("#c9b37a"), x + dx, 0.11, z + dz);
        add(new THREE.SphereGeometry(0.09, 5, 4), lambert("#5f9e4a"), x + dx, 0.25, z + dz);
      }
    } else {
      for (let i = 0; i < 4; i++) add(box(0.32, 0.05, 0.07), lambert(i < 2 ? "#6f737a" : "#c8743a"), x + (i % 2) * 0.08, 0.03 + Math.floor(i / 2) * 0.05, z, 0.2);
    }
  };

  const siteFill = Math.max(0, Math.min(1, poi.fill ?? 0));
  if (!poi.cleared && siteFill > 0) {
    // Under construction: the building rises as the crew pays in, in the trade's own walls and roof. First the
    // footing is laid out with stakes and a builder's line and the first stones go down; then the frame goes up with
    // the walls half built and a scaffold behind; then the walls reach the eaves with the window holes left open,
    // the rafters are on, the back slope is part covered, and a hoist lifts the rest of the roof up.
    const stage = siteFill >= 0.67 ? 3 : siteFill >= 0.34 ? 2 : 1;
    add(box(1.04, 0.08, 0.76), footing, 0, 0.04, 0);
    const corners: [number, number][] = [[-0.46, -0.32], [0.46, -0.32], [-0.46, 0.32], [0.46, 0.32]];
    const plate = () => {
      for (const z of [-0.32, 0.32]) add(box(0.98, 0.05, 0.06), timber, 0, 0.68, z);
      for (const x of [-0.46, 0.46]) add(box(0.06, 0.05, 0.7), timber, x, 0.68, 0);
    };
    if (stage === 1) {
      // The first course of stone: the back and the west side, the east side begun.
      add(box(0.94, 0.1, 0.08), stone, 0, 0.13, -0.32);
      add(box(0.08, 0.1, 0.6), stone, -0.46, 0.13, 0);
      add(box(0.08, 0.1, 0.3), stone, 0.46, 0.13, -0.17);
      add(box(0.4, 0.08, 0.08), stone, -0.24, 0.22, -0.32);
      // Stakes at the corners with a builder's line strung round them.
      for (const [x, z] of corners) add(box(0.04, 0.34, 0.04), timber, x, 0.25, z);
      const line = lambert("#efe6cf");
      for (const z of [-0.32, 0.32]) add(box(0.92, 0.008, 0.008), line, 0, 0.36, z);
      for (const x of [-0.46, 0.46]) add(box(0.008, 0.008, 0.64), line, x, 0.36, 0);
      // A tub of mortar with a trowel in it.
      add(box(0.2, 0.07, 0.14), wood, 0.22, 0.115, 0.06);
      add(box(0.17, 0.012, 0.11), lambert("#cfc8b8"), 0.22, 0.152, 0.06);
      add(box(0.08, 0.008, 0.04), iron, 0.24, 0.165, 0.08, 0.5);
      add(box(0.015, 0.015, 0.07), wood, 0.19, 0.17, 0.1, 0.5);
    } else {
      // The stone course all round, leaving the doorway; corner posts to full height, braced, under a wall plate.
      add(box(0.94, 0.14, 0.08), stone, 0, 0.15, -0.32);
      for (const x of [-0.46, 0.46]) add(box(0.08, 0.14, 0.6), stone, x, 0.15, 0);
      for (const x of [-0.31, 0.31]) add(box(0.32, 0.14, 0.08), stone, x, 0.15, 0.32);
      for (const [x, z] of [...corners, [0, -0.32] as [number, number]]) add(box(0.06, 0.6, 0.06), timber, x, 0.38, z);
      plate();
      for (const x of [-0.475, 0.475]) for (const s of [-1, 1]) add(box(0.025, 0.03, 0.36), timber, x, 0.48, s * 0.15).rotation.x = s * 0.75;
    }
    if (stage === 2) {
      // The walls half up, and a scaffold behind the back wall with a plank walk on it, and a ladder at the front.
      add(box(0.9, 0.22, 0.05), wallMat, 0, 0.33, -0.32);
      for (const x of [-0.46, 0.46]) add(box(0.05, 0.22, 0.6), wallMat, x, 0.33, 0);
      for (const x of [-0.42, 0.42]) add(box(0.03, 0.8, 0.03), timber, x, 0.4, -0.5);
      add(box(0.9, 0.025, 0.025), timber, 0, 0.4, -0.52);
      add(box(0.9, 0.02, 0.12), plank, 0, 0.42, -0.46);
      const lean = 0.25;
      for (const x of [0.53, 0.63]) add(box(0.02, 0.66, 0.02), wood, x, 0.33, 0.44).rotation.x = -lean;
      for (let i = 0; i < 4; i++) {
        const y = 0.12 + i * 0.15;
        add(box(0.1, 0.015, 0.015), wood, 0.58, y, 0.44 - (y - 0.33) * Math.tan(lean));
      }
    }
    if (stage === 3) {
      // Walls to the eaves, the doorway framed with a lintel, and the window holes left open with their sills in.
      add(box(0.9, 0.46, 0.05), wallMat, 0, 0.45, -0.32);
      for (const x of [-0.46, 0.46]) add(box(0.05, 0.46, 0.6), wallMat, x, 0.45, 0);
      for (const x of [-0.31, 0.31]) {
        add(box(0.3, 0.46, 0.05), wallMat, x, 0.45, 0.32);
        add(box(0.14, 0.12, 0.01), lambert("#2a221c"), x, 0.47, 0.346);
        add(box(0.18, 0.02, 0.04), timber, x, 0.4, 0.35);
      }
      add(box(0.34, 0.06, 0.06), timber, 0, 0.62, 0.32);
      // Rafters and a ridge beam, with the top of the back slope already slabbed in the trade's roof.
      const half = 0.42, rise = 0.3, pitch = Math.atan2(rise, half), raft = Math.hypot(rise, half);
      for (let i = 0; i < 5; i++) for (const s of [-1, 1]) add(box(0.035, 0.035, raft), timber, -0.4 + i * 0.2, 0.7 + rise / 2, s * half / 2).rotation.x = s * pitch;
      add(box(0.98, 0.04, 0.04), timber, 0, 0.7 + rise, 0);
      for (const d of [0.11, 0.31]) add(box(0.98, 0.04, 0.2), roofMat, 0, 0.7 + rise - d * Math.sin(pitch) + 0.03 * Math.cos(pitch), -(d * Math.cos(pitch) + 0.03 * Math.sin(pitch))).rotation.x = -pitch;
      // A scaffold up the west wall, and a hoist on the east side lifting a bucket, with roof slabs stacked ready.
      for (const z of [-0.26, 0.26]) add(box(0.03, 0.72, 0.03), timber, -0.62, 0.36, z);
      add(box(0.025, 0.025, 0.6), timber, -0.64, 0.48, 0);
      add(box(0.12, 0.02, 0.6), plank, -0.58, 0.5, 0);
      add(box(0.035, 1.1, 0.035), timber, 0.64, 0.55, -0.12);
      add(box(0.03, 0.03, 0.3), timber, 0.64, 1.08, 0.0);
      add(box(0.006, 0.52, 0.006), lambert("#efe6cf"), 0.64, 0.82, 0.13);
      add(new THREE.CylinderGeometry(0.05, 0.04, 0.08, 7), wood, 0.64, 0.54, 0.13);
      for (let i = 0; i < 3; i++) add(box(0.3, 0.03, 0.14), roofMat, 0.38, 0.015 + i * 0.03, 0.56, 0.1 * i);
    }
    // Materials waiting by the door: planks and squared stone, thinner the nearer it is to done.
    planks(-0.28, 0.5, stage === 3 ? 1 : 3);
    stones(stage === 3 ? [[0.62, 0.06, 0.5]] : [[0.3, 0.06, 0.5], [0.44, 0.06, 0.55], [0.37, 0.18, 0.52]]);
    finish();
    return;
  }
  if (!poi.cleared) {
    // Still a crew project: a fenced building site with the materials stacked inside it.
    const post = lambert("#7a5230");
    const rail = lambert("#a07a4c");
    for (const [x, z] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.55], [0.55, 0.55], [0, -0.3]]) add(box(0.06, 0.4, 0.06), post, x, 0.2, z);
    for (const y of [0.16, 0.32]) {
      add(box(1.1, 0.04, 0.03), rail, 0, y, -0.3);
      add(box(0.03, 0.04, 0.85), rail, -0.55, y, 0.125);
      add(box(0.03, 0.04, 0.85), rail, 0.55, y, 0.125);
    }
    // The front is left open, with a board on a post saying what is coming: the trade's colour and its mark.
    add(box(0.04, 0.5, 0.04), post, 0.4, 0.25, 0.62);
    add(box(0.34, 0.22, 0.025), timber, 0.4, 0.46, 0.64);
    add(box(0.3, 0.18, 0.03), roofMat, 0.4, 0.46, 0.645);
    emblem(0.4, 0.46, 0.65, false);
    // A pile of planks, squared stones, the trade's own makings, and a wheelbarrow.
    planks(-0.2, -0.05, 3);
    stones([[0.25, 0.08, -0.05], [0.38, 0.08, 0.1], [0.3, 0.22, 0.02]]);
    makings(-0.1, 0.32);
    add(box(0.2, 0.07, 0.15), wood, 0.32, 0.13, 0.36).rotation.x = 0.12;
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.025, 8), iron, 0.32, 0.05, 0.47).rotation.z = Math.PI / 2;
    for (const x of [0.25, 0.39]) {
      add(box(0.02, 0.02, 0.24), wood, x, 0.12, 0.26).rotation.x = -0.25;
      add(box(0.02, 0.08, 0.02), wood, x, 0.04, 0.3);
    }
    finish();
    return;
  }
  if (kind === "galley") {
    // The galley: a low cookhouse of planks on a stone course under a russet roof, a broad stone chimney stack up the
    // west end, a plank door and a shuttered window, and a serving hatch with its flap propped up over a shelf of
    // bowls. Outside, a cauldron hangs from a tripod over a fire, fish dry on a rack, and provisions stand ready.
    add(box(1.06, 0.08, 0.78), footing, 0, 0.04, 0);
    add(box(1.0, 0.14, 0.72), stone, 0, 0.15, 0);
    add(box(1.02, 0.03, 0.74), timber, 0, 0.235, 0);
    add(box(0.98, 0.34, 0.7), boards, 0, 0.42, 0);
    for (let i = -4; i <= 4; i++) add(box(0.012, 0.34, 0.01), timber, i * 0.11, 0.42, 0.352);
    for (const x of [-0.49, 0.49]) for (const z of [-0.35, 0.35]) add(box(0.06, 0.36, 0.06), timber, x, 0.42, z);
    add(box(1.04, 0.04, 0.76), timber, 0, 0.61, 0);
    roof(0, 0.63, 0, 1.0, 0.48, 0.3, boards, [0.18, 0.36]);
    // The door, and a step.
    add(box(0.24, 0.44, 0.03), timber, 0, 0.3, 0.36);
    add(box(0.18, 0.4, 0.03), trim, 0, 0.28, 0.368);
    for (const y of [0.42, 0.16]) add(box(0.18, 0.012, 0.012), iron, 0, y, 0.387);
    add(box(0.03, 0.03, 0.02), brass, 0.06, 0.28, 0.389);
    add(box(0.3, 0.05, 0.12), footing, 0, 0.025, 0.45);
    framed(-0.32, 0.43, 0.14, 0.14, 0.352);
    // The serving hatch: a warm opening, a shelf of bowls and a loaf under it, and the flap propped open above.
    add(box(0.3, 0.2, 0.012), timber, 0.3, 0.42, 0.352);
    add(box(0.26, 0.16, 0.01), glass, 0.3, 0.42, 0.36).userData.glow = true;
    glows.push({ pos: new THREE.Vector3(0.3, 0.42, 0.5), size: 0.5 });
    add(box(0.34, 0.03, 0.1), wood, 0.3, 0.315, 0.4);
    for (const [x, c] of [[0.2, "#efe6cf"], [0.3, "#b98b5a"]] as [number, string][]) add(new THREE.CylinderGeometry(0.035, 0.025, 0.03, 7), lambert(c), x, 0.345, 0.405);
    add(new THREE.SphereGeometry(0.04, 6, 4), lambert("#c9934a"), 0.4, 0.345, 0.405).scale.set(1.3, 0.7, 1);
    add(box(0.32, 0.02, 0.18), plank, 0.3, 0.54, 0.43).rotation.x = -0.5;
    for (const x of [0.16, 0.44]) add(box(0.012, 0.2, 0.012), wood, x, 0.43, 0.44);
    // The chimney stack, broad and stepped, up the west end; the ambience draws its smoke.
    add(box(0.26, 1.0, 0.32), stone, -0.6, 0.5, -0.05);
    add(box(0.2, 0.42, 0.24), stone, -0.6, 1.2, -0.05);
    add(box(0.26, 0.05, 0.3), footing, -0.6, 1.43, -0.05);
    for (const z of [-0.1, 0.0]) add(new THREE.CylinderGeometry(0.035, 0.045, 0.08, 6), lambert("#b8643a"), -0.6, 1.49, z);
    g.userData.smoke = new THREE.Vector3(-0.6, 1.56, -0.05);
    lantern(-0.55, 0.47, 0.43);
    // The cauldron, hung from a tripod over a fire of crossed logs; its fire throws flickering light over the quay.
    const cx = 0.7, cz = 0.52;
    for (const a of [0.3, 2.4, 4.5]) {
      const dx = Math.cos(a), dz = Math.sin(a);
      const leg = add(new THREE.CylinderGeometry(0.012, 0.014, 0.56, 4), wood, cx + dx * 0.13, 0.26, cz + dz * 0.13);
      leg.rotation.set(-dz * 0.45, 0, dx * 0.45);
    }
    add(box(0.008, 0.12, 0.008), iron, cx, 0.43, cz);
    add(new THREE.SphereGeometry(0.1, 8, 6), lambert("#2e2a2a"), cx, 0.26, cz).scale.y = 0.85;
    add(new THREE.CylinderGeometry(0.085, 0.085, 0.015, 8), lambert("#b98b3a"), cx, 0.32, cz);
    for (const r of [0.5, -0.5]) add(box(0.24, 0.04, 0.04), boards, cx, 0.03, cz, r);
    add(new THREE.ConeGeometry(0.07, 0.12, 5), new THREE.MeshBasicMaterial({ color: "#ff9a3c" }), cx, 0.1, cz).userData.glow = true;
    glows.push({ pos: new THREE.Vector3(cx, 0.12, cz + 0.18), size: 0.36, light: "fire" });
    // A chopping block with a cleaver in it.
    add(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 7), lambert("#6b4a2b"), 0.4, 0.07, 0.62);
    add(box(0.1, 0.06, 0.012), steel, 0.4, 0.17, 0.62, 0.6);
    add(box(0.02, 0.02, 0.08), wood, 0.37, 0.19, 0.66, 0.6);
    // Fish hung to dry on a rack out front.
    for (const x of [-0.44, -0.12]) add(box(0.03, 0.42, 0.03), timber, x, 0.21, 0.6);
    add(box(0.36, 0.025, 0.025), timber, -0.28, 0.41, 0.6);
    for (const [x, c] of [[-0.37, "#9fb3c2"], [-0.28, "#a9b4ba"], [-0.19, "#c4a07a"]] as [number, string][]) {
      add(box(0.008, 0.05, 0.008), lambert("#efe6cf"), x, 0.38, 0.6);
      add(new THREE.ConeGeometry(0.035, 0.15, 4), lambert(c), x, 0.28, 0.6).rotation.x = Math.PI;
      add(box(0.06, 0.03, 0.012), lambert(c), x, 0.36, 0.6);
    }
    // Provisions: barrels and a crate along the east wall, and sacks and crates by the chimney.
    barrel(0.64, -0.06);
    barrel(0.62, -0.26, 0.07, 0.15);
    add(box(0.16, 0.12, 0.16), boards, 0.64, 0.06, 0.16, 0.3);
    add(box(0.22, 0.16, 0.2), boards, -0.62, 0.08, 0.36, 0.2);
    add(box(0.18, 0.12, 0.16), plank, -0.62, 0.22, 0.36, -0.2);
    sack(-0.42, 0.42, 0.4);
    finish();
    return;
  }
  if (kind === "apothecary") {
    // The apothecary: a plastered two-storey shop with a jettied upper floor, dark timbers and a green door and shutters,
    // under a steep green roof with a stone chimney. Bottles glow in the shop window, a green sign swings from a bracket,
    // herbs dry on a rack, a copper still bubbles by the wall, and a little herb bed sits at the door.
    const bottle = (x: number, y: number, z: number, c: string, lit = false) => {
      const m = lit ? new THREE.MeshBasicMaterial({ color: c }) : lambert(c);
      const body = add(new THREE.CylinderGeometry(0.024, 0.026, 0.06, 6), m, x, y + 0.03, z);
      add(new THREE.CylinderGeometry(0.01, 0.012, 0.03, 5), m, x, y + 0.075, z);
      if (lit) body.userData.glow = true;
    };
    const herbs = (x: number, y: number, z: number, c: string) => {
      add(box(0.012, 0.07, 0.012), wood, x, y + 0.035, z);
      add(new THREE.ConeGeometry(0.045, 0.13, 5), lambert(c), x, y - 0.05, z).rotation.x = Math.PI;
    };
    // Footing, stone course, plaster ground floor, the jetty beam, the overhanging upper floor, and the eave beam.
    add(box(1.04, 0.08, 0.78), footing, 0, 0.04, 0);
    add(box(0.96, 0.1, 0.7), stone, 0, 0.13, 0);
    add(box(0.94, 0.28, 0.68), plaster, 0, 0.32, 0);
    add(box(1.0, 0.04, 0.74), timber, 0, 0.47, 0);
    add(box(0.98, 0.3, 0.72), plaster, 0, 0.64, 0);
    add(box(1.02, 0.04, 0.76), timber, 0, 0.81, 0);
    for (const x of [-0.47, 0.47]) for (const z of [-0.34, 0.34]) add(box(0.05, 0.28, 0.05), timber, x, 0.32, z);
    for (const x of [-0.49, 0.49]) for (const z of [-0.36, 0.36]) add(box(0.05, 0.3, 0.05), timber, x, 0.64, z);
    add(box(0.04, 0.3, 0.015), timber, 0, 0.64, 0.37);
    for (const x of [-0.505, 0.505]) for (const tilt of [-0.5, 0.5]) add(box(0.015, 0.04, 0.4), timber, x, 0.64, 0).rotation.x = tilt;
    // The door in a timber frame, a step and stepping stones; the shop window beside it, with a shelf of bottles.
    add(box(0.24, 0.36, 0.03), timber, -0.24, 0.26, 0.345);
    add(box(0.18, 0.32, 0.03), trim, -0.24, 0.25, 0.355);
    add(box(0.18, 0.012, 0.012), iron, -0.24, 0.35, 0.374);
    add(box(0.18, 0.012, 0.012), iron, -0.24, 0.16, 0.374);
    add(box(0.03, 0.03, 0.02), brass, -0.18, 0.25, 0.376);
    add(box(0.3, 0.06, 0.12), footing, -0.24, 0.03, 0.45);
    for (const [x, z, w] of [[-0.24, 0.62, 0.2], [-0.2, 0.76, 0.18]] as [number, number, number][]) add(box(w, 0.02, 0.1), footing, x, 0.01, z);
    framed(0.2, 0.31, 0.3, 0.2, 0.343);
    add(box(0.4, 0.03, 0.09), timber, 0.2, 0.19, 0.385);
    ["#5f9e4a", "#c4473a", "#3f7fb8", "#d9b45a", "#8a5fb0"].forEach((c, i) => bottle(0.06 + i * 0.07, 0.205, 0.385, c, i === 0));
    // Two upper windows, one with a planter of herbs and one of white blooms.
    for (const x of [-0.22, 0.22]) {
      framed(x, 0.65, 0.18, 0.16, 0.362);
      add(box(0.26, 0.055, 0.075), wood, x, 0.53, 0.4);
      add(box(0.22, 0.035, 0.055), lambert("#4f8a3a"), x, 0.57, 0.4);
      for (let i = 0; i < 3; i++) add(box(0.04, x < 0 ? 0.04 : 0.07, 0.04), lambert(x < 0 ? "#f4efe1" : "#6aa34f"), x + (i - 1) * 0.07, x < 0 ? 0.605 : 0.62, 0.4);
    }
    // The roof: a steep gable of plaster under two slabs of green, with darker courses of shingle and a ridge cap.
    roof(0, 0.83, 0, 1.04, 0.46, 0.36, plaster, [0.22, 0.44]);
    // A round window in each gable end, glowing at dusk.
    for (const x of [-0.5, 0.5]) {
      add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 8), timber, x * 1.03, 0.96, 0).rotation.z = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), glass, x * 1.04, 0.96, 0).rotation.z = Math.PI / 2;
    }
    // The chimney, up the back; the ambience draws its smoke.
    add(box(0.15, 0.5, 0.15), stone, 0.3, 1.05, -0.14);
    add(box(0.2, 0.05, 0.2), footing, 0.3, 1.32, -0.14);
    add(new THREE.CylinderGeometry(0.035, 0.045, 0.07, 6), lambert("#b8643a"), 0.3, 1.385, -0.14);
    g.userData.smoke = new THREE.Vector3(0.3, 1.46, -0.14);
    sign(0.47, 0.76, 0.36);
    lantern(-0.43, 0.37, 0.4);
    // The herb bed in front: a low wooden frame of soil, leafy plants and a few blooms.
    add(box(0.42, 0.07, 0.17), wood, 0.2, 0.035, 0.6);
    add(box(0.38, 0.03, 0.13), lambert("#4a3a2a"), 0.2, 0.075, 0.6);
    for (let i = 0; i < 5; i++) add(box(0.05, 0.05 + (i % 2) * 0.03, 0.05), lambert(["#6aa34f", "#8fb84f", "#5f8f3f"][i % 3]), 0.06 + i * 0.07, 0.1 + (i % 2) * 0.015, 0.6);
    for (const [x, c] of [[0.1, "#c46bd0"], [0.24, "#f4efe1"], [0.31, "#e8c53a"]] as [number, string][]) add(box(0.035, 0.035, 0.035), lambert(c), x, 0.17, 0.6);
    // The drying rack along the west wall, its bundles of herbs hanging from the rail.
    for (const z of [0.22, -0.28]) add(box(0.04, 0.5, 0.04), timber, -0.66, 0.25, z);
    add(box(0.04, 0.04, 0.54), timber, -0.66, 0.5, -0.03);
    for (const [c, z] of [["#6aa34f", 0.16], ["#8fb84f", 0.04], ["#5f8f3f", -0.08], ["#a8b84f", -0.2]] as [string, number][]) herbs(-0.66, 0.44, z, c);
    // A copper still on a stone stand at the front corner: a pot, a dome, a neck to a collecting bottle.
    add(box(0.2, 0.08, 0.2), footing, -0.6, 0.04, 0.5);
    add(new THREE.CylinderGeometry(0.09, 0.1, 0.16, 8), copper, -0.6, 0.16, 0.5);
    add(new THREE.SphereGeometry(0.07, 7, 5), copper, -0.6, 0.27, 0.5);
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 5), copper, -0.5, 0.31, 0.5).rotation.z = Math.PI / 2 - 0.5;
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 5), copper, -0.43, 0.23, 0.5);
    bottle(-0.43, 0.08, 0.5, "#5f9e4a", true);
    add(new THREE.CylinderGeometry(0.095, 0.105, 0.015, 8), brass, -0.6, 0.245, 0.5);
    // A barrel and a sack of ingredients by the east wall.
    barrel(0.64, 0.05, 0.08, 0.18, 0.04);
    sack(0.62, 0.24, 0.3, 0.04);
    finish();
    return;
  }
  // The smithy: an open-fronted forge on a flagged floor, a stone wall on the forge side and a plank half wall on the
  // other, under a slate roof. A stone hearth glows at the back under a hood and a tall chimney, with bellows beside
  // it and tools on the wall; out front an anvil on its block with a glowing bar on it, a quench trough, a
  // grindstone, iron stock, a coal bin, a lantern and a sign with an anvil on it.
  add(box(1.16, 0.06, 0.86), footing, 0, 0.03, 0);
  for (const [x, z, w, d] of [[-0.2, 0.2, 0.3, 0.22], [0.25, -0.05, 0.26, 0.3], [-0.05, 0.3, 0.2, 0.18]] as [number, number, number, number][]) add(box(w, 0.006, d), lambert("#6f7a88"), x, 0.062, z);
  add(box(1.08, 0.3, 0.08), stone, 0, 0.21, -0.36);
  add(box(1.06, 0.34, 0.06), boards, 0, 0.53, -0.36);
  for (let i = -4; i <= 4; i++) add(box(0.012, 0.34, 0.01), timber, i * 0.12, 0.53, -0.326);
  add(box(0.08, 0.64, 0.8), stone, -0.54, 0.38, -0.02);
  add(box(0.05, 0.26, 0.62), plank, 0.54, 0.19, -0.06);
  for (const x of [-0.54, 0.54]) add(box(0.08, 0.66, 0.08), timber, x, 0.39, 0.38);
  add(box(0.08, 0.66, 0.08), timber, 0.54, 0.39, -0.36);
  for (const z of [0.38, -0.36]) add(box(1.16, 0.06, 0.07), timber, 0, 0.72, z);
  for (const s of [-1, 1]) add(box(0.22, 0.04, 0.04), timber, s * 0.44, 0.63, 0.38).rotation.z = s * 0.8;
  roof(0, 0.75, 0.01, 0.86, 0.64, 0.36, boards, [0.2, 0.42], true);
  // The forge: a stone hearth with a lip, coals and flames, a glow, a hood over it, and the chimney up through the roof.
  add(box(0.46, 0.32, 0.4), stone, -0.26, 0.22, -0.14);
  add(box(0.5, 0.04, 0.44), footing, -0.26, 0.4, -0.14);
  add(box(0.3, 0.03, 0.24), new THREE.MeshBasicMaterial({ color: "#ff7a2a" }), -0.26, 0.425, -0.1);
  add(new THREE.ConeGeometry(0.07, 0.14, 5), new THREE.MeshBasicMaterial({ color: "#ffc04a" }), -0.3, 0.5, -0.1);
  add(new THREE.ConeGeometry(0.05, 0.1, 5), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.19, 0.48, -0.06);
  add(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: "#ff8a3a", transparent: true, opacity: 0.22, depthWrite: false }), -0.26, 0.48, -0.08).userData.glow = true;
  // After dark the coals glow out of the open front and their firelight fills the shed.
  glows.push({ pos: new THREE.Vector3(-0.26, 0.5, 0.14), size: 0.62, light: "fire" });
  add(new THREE.CylinderGeometry(0.1, 0.26, 0.3, 4), stone, -0.26, 0.66, -0.18, Math.PI / 4);
  add(box(0.2, 0.62, 0.2), stone, -0.26, 1.11, -0.22);
  add(box(0.26, 0.06, 0.26), footing, -0.26, 1.45, -0.22);
  g.userData.smoke = new THREE.Vector3(-0.26, 1.54, -0.22);
  // The bellows beside the hearth, its nozzle in the fire.
  add(box(0.04, 0.28, 0.04), timber, 0.14, 0.2, -0.2);
  add(box(0.24, 0.08, 0.18), lambert("#5a3a26"), 0.04, 0.36, -0.2).rotation.z = 0.2;
  for (const dy of [0.05, -0.05]) add(box(0.26, 0.015, 0.2), wood, 0.04, 0.36 + dy, -0.2).rotation.z = 0.2 + dy;
  add(box(0.12, 0.025, 0.025), iron, -0.07, 0.34, -0.2);
  // Tools on the back wall: tongs and hammers on a rail, and horseshoes on pegs.
  add(box(0.34, 0.03, 0.03), timber, 0.3, 0.6, -0.31);
  for (let i = 0; i < 5; i++) {
    add(box(0.015, 0.18, 0.015), steel, 0.18 + i * 0.06, 0.5, -0.3);
    if (i % 2) add(box(0.05, 0.03, 0.03), steel, 0.18 + i * 0.06, 0.42, -0.3);
  }
  for (const x of [0.22, 0.32, 0.42]) add(new THREE.TorusGeometry(0.03, 0.009, 4, 8, Math.PI * 1.4), steel, x, 0.7, -0.31).rotation.z = -Math.PI * 0.2;
  // A bin of coal by the hearth.
  add(box(0.22, 0.1, 0.18), wood, -0.38, 0.11, 0.26);
  for (const [dx, dz, s] of [[-0.04, 0, 0.05], [0.04, 0.03, 0.045], [0.02, -0.04, 0.04], [-0.05, 0.05, 0.035]]) add(new THREE.DodecahedronGeometry(s, 0), lambert("#26242a"), -0.38 + dx, 0.17, 0.26 + dz, dx * 9);
  // The anvil on its block, a hammer on it and a glowing bar.
  add(new THREE.CylinderGeometry(0.11, 0.13, 0.2, 7), lambert("#6b4a2b"), 0.18, 0.16, 0.18);
  add(box(0.14, 0.05, 0.1), steel, 0.18, 0.285, 0.18);
  add(box(0.08, 0.06, 0.07), steel, 0.18, 0.34, 0.18);
  add(box(0.28, 0.06, 0.11), steel, 0.18, 0.4, 0.18);
  add(new THREE.ConeGeometry(0.05, 0.13, 6), steel, 0.385, 0.41, 0.18).rotation.z = -Math.PI / 2;
  add(box(0.1, 0.015, 0.022), new THREE.MeshBasicMaterial({ color: "#ff8a3a" }), 0.22, 0.44, 0.16).userData.glow = true;
  add(box(0.02, 0.02, 0.16), wood, 0.1, 0.44, 0.24, 0.4);
  add(box(0.05, 0.045, 0.045), steel, 0.07, 0.445, 0.17, 0.4);
  // The quench trough and the grindstone on the open side, and iron bars leaning on the half wall.
  add(box(0.3, 0.13, 0.16), boards, 0.74, 0.065, 0.22);
  add(box(0.26, 0.02, 0.12), lambert("#3f7fb8"), 0.74, 0.125, 0.22);
  for (const x of [0.69, 0.79]) add(box(0.03, 0.2, 0.03), wood, x, 0.1, -0.16);
  add(new THREE.CylinderGeometry(0.11, 0.11, 0.045, 10), lambert("#b8b0a0"), 0.74, 0.21, -0.16).rotation.z = Math.PI / 2;
  add(box(0.16, 0.02, 0.02), iron, 0.74, 0.21, -0.16);
  add(box(0.02, 0.08, 0.02), iron, 0.83, 0.17, -0.16);
  for (const [z, c] of [[-0.3, "#6f737a"], [-0.26, "#c8743a"], [-0.22, "#6f737a"]] as [number, string][]) add(box(0.025, 0.42, 0.025), lambert(c), 0.6, 0.24, z).rotation.z = -0.22;
  sign(0.54, 0.66, 0.38);
  lantern(-0.48, 0.5, 0.44);
  finish();
};
