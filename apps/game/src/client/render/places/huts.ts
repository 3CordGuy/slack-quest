// A crew member's plot in the Harbor at each stage: staked out for sale, a building site with its bin of
// planks and stones, and the hut that goes up on it (a Shack, a Cottage or a Lodge, by its tier).

import * as THREE from "three";
import type { BuildingGlow } from "../ambience";
import { foldByLook, warmPane, type PlaceModel } from "./kit";

/** A plot for sale. */
export const lot: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // A plot for sale: four corner stakes, a line of twine, and a board on a post.
  const stake = lambert("#7a5230");
  for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
  add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
  add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
  add(box(0.05, 0.55, 0.05), stake, 0, 0.27, 0.0);
  add(box(0.42, 0.24, 0.04), lambert("#c9a877"), 0, 0.55, 0.0);
};

/** A plot bought and not yet built on. */
export const site: PlaceModel = (poi, kit) => {
  const { add, box, lambert } = kit;
  // A bought plot with no shack yet: the stakes and twine, and an open wooden bin that fills with planks and stones.
  const stake = lambert("#7a5230");
  for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
  add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
  add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
  const boards = lambert("#8a5f36");
  const W = 0.56, D = 0.4, H = 0.3, T = 0.04;
  add(box(W, 0.03, D), lambert("#5e4026"), 0, 0.015, 0.25);
  add(box(W, H, T), boards, 0, H / 2, 0.25 - D / 2);
  add(box(W, H, T), boards, 0, H / 2, 0.25 + D / 2);
  add(box(T, H, D), boards, -W / 2, H / 2, 0.25);
  add(box(T, H, D), boards, W / 2, H / 2, 0.25);
  // A darker band round the rim so the bin reads as a box, not a block.
  add(box(W + 0.02, 0.04, T + 0.01), lambert("#5e4026"), 0, H - 0.02, 0.25 + D / 2);
  const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
  // The shack itself rises behind the bin as it fills: a slab, then the frame, then walls, then rafters.
  if (fill >= 0.2) {
    const frame = lambert("#7a5230");
    const wall = lambert("#c9a877");
    const late = fill >= 0.8;
    const ph = late ? 0.62 : 0.4;
    const wh = late ? 0.52 : 0.3;
    add(box(0.8, 0.05, 0.4), lambert("#9a958a"), 0, 0.025, -0.1);
    const posts: [number, number][] = [[-0.38, -0.28], [0.38, -0.28], [-0.38, 0.08], [0.38, 0.08]];
    if (fill >= 0.4) for (const [x, z] of posts) add(box(0.06, ph, 0.06), frame, x, 0.05 + ph / 2, z);
    if (fill >= 0.6) {
      add(box(0.7, wh, 0.04), wall, 0, 0.05 + wh / 2, -0.28);
      for (const x of [-0.38, 0.38]) add(box(0.04, wh, 0.32), wall, x, 0.05 + wh / 2, -0.1);
    }
    if (late) for (const x of [-0.25, 0, 0.25]) {
      add(box(0.04, 0.04, 0.26), frame, x, 0.78, -0.2).rotation.x = -0.7;
      add(box(0.04, 0.04, 0.26), frame, x, 0.78, -0.02).rotation.x = 0.7;
    }
  }
  if (fill > 0) {
    // Planks on the left, stones on the right, rising together; full, they heap over the rim.
    const top = 0.03 + fill * (H + 0.06);
    const plank = lambert("#c9a877");
    const stone = lambert("#8b8f96");
    for (let i = 0; i < 3; i++) add(box(0.22, 0.04, 0.07), plank, -0.12, Math.max(0.05, top - 0.03 - i * 0.05), 0.15 + i * 0.09);
    for (const [x, z, s] of [[0.13, 0.17, 0.09], [0.18, 0.31, 0.08], [0.08, 0.33, 0.07]]) add(box(s, s * 0.8, s), stone, x, Math.max(0.05, top - s / 2), z, 0.5);
  }
};

/** A hut. */
export const plot: PlaceModel = (poi, kit) => {
  const { g, add, box, lambert } = kit;
  // Roof colour is picked from the owner's id so each hut is recognisable.
  const roofs = ["#8c3b2f", "#2f6f8c", "#6b8c2f", "#8c6a2f", "#6a2f8c", "#2f8c7a"];
  let hash = 0;
  for (const ch of poi.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  // Each tier is its own building, not a bigger copy: a Shack of rough planks under a shingled roof, a Cottage
  // of stone, plaster and timber with a chimney and flower boxes, a Lodge with a porch, dormers, a wing and a banner.
  const tier = Math.max(1, Math.min(3, poi.tier ?? 1));
  const roofHex = roofs[hash % roofs.length];
  const roofMat = lambert(roofHex);
  const roofDark = lambert("#" + new THREE.Color(roofHex).multiplyScalar(0.7).getHexString());
  const timber = lambert("#4a2f22");
  const plank = lambert("#a9835a");
  const plaster = lambert("#e8d9b5");
  const stone = lambert("#a8977a");
  const footing = lambert("#7b8494");
  const iron = lambert("#2b2a33");
  const wood = lambert("#7a5230");
  const doorMat = lambert("#5a3d22");
  const brass = lambert("#e0b12e");
  const glows: BuildingGlow[] = [];
  const panes: THREE.MeshBasicMaterial[] = [];
  const pane = (unlit: string, lit: string) => {
    const m = warmPane(unlit, lit);
    panes.push(m);
    return m;
  };
  const glass = pane("#c99a52", "#ffd98a");
  /** A framed window on a front wall at `z`, with glazing bars, optional shutters in the roof's colour, and a halo at dusk. */
  const framed = (x: number, y: number, w: number, h: number, z: number, shutters = false) => {
    add(box(w + 0.04, h + 0.04, 0.012), timber, x, y, z);
    add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
    add(box(0.015, h, 0.012), timber, x, y, z + 0.014);
    add(box(w, 0.015, 0.012), timber, x, y, z + 0.014);
    if (shutters) for (const s of [-1, 1]) add(box(0.045, h + 0.02, 0.014), roofMat, x + s * (w / 2 + 0.045), y, z + 0.008);
    glows.push({ pos: new THREE.Vector3(x, y, z + 0.14), size: w * 2.2 });
  };
  /** A gabled roof: a prism of `wall` `len` long, `half` out to each eave and `rise` high, under two overhanging slabs. The ridge runs along x, or along z with `alongZ`. */
  const gable = (cx: number, cy: number, cz: number, len: number, half: number, rise: number, alongZ: boolean, wall: THREE.Material) => {
    const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
    const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
    if (!alongZ) prism.rotateY(Math.PI / 2);
    add(prism, wall, cx, cy, cz);
    const pitch = Math.atan2(rise, half);
    const slope = Math.hypot(rise, half) * 1.08;
    for (const side of [1, -1]) {
      const along = slope / 2;
      const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
      const y = cy + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
      if (alongZ) add(box(slope, 0.06, len + 0.1), roofMat, cx + out, y, cz).rotation.z = -side * pitch;
      else add(box(len + 0.12, 0.06, slope), roofMat, cx, y, cz + out).rotation.x = side * pitch;
    }
    return pitch;
  };
  /** A darker course of shingles part way down each slope of a roof whose ridge runs along x, and a ridge cap. */
  const shingles = (cx: number, cy: number, len: number, half: number, rise: number, d: number) => {
    const pitch = Math.atan2(rise, half);
    for (const side of [1, -1]) {
      add(box(len + 0.16, 0.065, 0.05), roofDark, cx, cy + rise - d * Math.sin(pitch) + 0.035 * Math.cos(pitch), side * (d * Math.cos(pitch) + 0.035 * Math.sin(pitch))).rotation.x = side * pitch;
    }
    add(box(len + 0.2, 0.06, 0.08), roofDark, cx, cy + rise + 0.03, 0);
  };
  /** A chimney of stone with a cap and a pot; its smoke is drawn by the ambience. */
  const chimney = (x: number, z: number, from: number, top: number, w: number) => {
    add(box(w, top - from, w), stone, x, (from + top) / 2, z);
    add(box(w + 0.05, 0.05, w + 0.05), footing, x, top + 0.02, z);
    add(new THREE.CylinderGeometry(0.04, 0.05, 0.07, 6), lambert("#b8643a"), x, top + 0.075, z);
    g.userData.smoke = new THREE.Vector3(x, top + 0.14, z);
  };
  /** A lantern with its cage, cap and flame at (x, y, z), lit at dusk. */
  const lantern = (x: number, y: number, z: number) => {
    add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, y, z).userData.glow = true;
    for (const [dx, dz] of [[-0.03, -0.03], [0.03, -0.03], [-0.03, 0.03], [0.03, 0.03]]) add(box(0.01, 0.08, 0.01), iron, x + dx, y, z + dz);
    add(box(0.08, 0.015, 0.08), iron, x, y - 0.045, z);
    add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, y + 0.06, z, Math.PI / 4);
    glows.push({ pos: new THREE.Vector3(x, y, z + 0.1), size: 0.34 });
  };
  const barrel = (x: number, z: number, r = 0.08, h = 0.18) => {
    add(new THREE.CylinderGeometry(r, r, h, 8), wood, x, h / 2, z);
    for (const y of [h * 0.25, h * 0.75]) add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.02, 8), timber, x, y, z);
  };
  /** A stack of logs with their ends to the front, `rows` high, `rows` across at the bottom. */
  const logs = (x: number, z: number, rows: number) => {
    for (let r = 0; r < rows; r++) {
      const n = rows - r;
      for (let i = 0; i < n; i++) add(new THREE.CylinderGeometry(0.034, 0.034, 0.2, 6), lambert((i + r) % 2 ? "#8a5f36" : "#9a6a3c"), x + (i - (n - 1) / 2) * 0.072, 0.036 + r * 0.062, z).rotation.x = Math.PI / 2;
    }
  };
  const flowerBox = (x: number, y: number, z: number, w: number, bloom: string) => {
    add(box(w, 0.055, 0.075), wood, x, y, z);
    add(box(w - 0.04, 0.035, 0.055), lambert("#4f8a3a"), x, y + 0.04, z);
    for (let i = 0; i < 3; i++) add(box(0.04, 0.04, 0.04), lambert(bloom), x + (i - 1) * (w / 3.4), y + 0.07, z + 0.008);
  };

  if (tier === 1) {
    // The Shack: rough planks on a stone footing, a plank door, one shuttered window, a stovepipe through the roof,
    // a lantern by the door, a woodpile and a barrel.
    add(box(0.84, 0.07, 0.64), footing, 0, 0.035, 0);
    add(box(0.76, 0.44, 0.56), plank, 0, 0.29, 0);
    for (let i = -3; i <= 3; i++) add(box(0.012, 0.42, 0.01), timber, i * 0.11, 0.29, 0.282);
    for (const x of [-0.385, 0.385]) for (const z of [-0.285, 0.285]) add(box(0.05, 0.46, 0.05), timber, x, 0.3, z);
    add(box(0.8, 0.03, 0.6), timber, 0, 0.515, 0);
    gable(0, 0.51, 0, 0.76, 0.4, 0.26, false, plank);
    shingles(0, 0.51, 0.76, 0.4, 0.26, 0.15);
    add(box(0.2, 0.36, 0.02), timber, -0.16, 0.25, 0.288);
    add(box(0.16, 0.32, 0.02), doorMat, -0.16, 0.23, 0.298);
    add(box(0.14, 0.012, 0.01), iron, -0.16, 0.34, 0.31);
    add(box(0.14, 0.012, 0.01), iron, -0.16, 0.16, 0.31);
    add(box(0.03, 0.03, 0.02), brass, -0.1, 0.23, 0.312);
    add(box(0.26, 0.04, 0.1), footing, -0.16, 0.02, 0.35);
    framed(0.2, 0.34, 0.14, 0.14, 0.286, true);
    add(box(0.2, 0.025, 0.07), wood, 0.2, 0.25, 0.31);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 6), iron, 0.24, 0.76, -0.08);
    add(new THREE.ConeGeometry(0.05, 0.04, 6), iron, 0.24, 0.9, -0.08);
    g.userData.smoke = new THREE.Vector3(0.24, 0.96, -0.08);
    add(box(0.03, 0.02, 0.1), iron, -0.34, 0.42, 0.34);
    lantern(-0.34, 0.37, 0.38);
    logs(-0.56, 0.1, 3);
    barrel(0.54, 0.22);
  } else if (tier === 2) {
    // The Cottage: a stone ground course under plaster and dark timbers, a steep shingled roof with a dormer over
    // the door, a stone chimney, shuttered windows with flower boxes, a lantern, a path and a woodpile.
    add(box(1.06, 0.08, 0.78), footing, 0, 0.04, 0);
    add(box(1.0, 0.2, 0.72), stone, 0, 0.18, 0);
    add(box(1.02, 0.04, 0.74), timber, 0, 0.28, 0);
    add(box(0.98, 0.34, 0.7), plaster, 0, 0.47, 0);
    add(box(1.04, 0.04, 0.76), timber, 0, 0.65, 0);
    for (const x of [-0.49, 0.49]) for (const z of [-0.35, 0.35]) add(box(0.06, 0.58, 0.06), timber, x, 0.37, z);
    for (const x of [-0.16, 0.16]) for (const z of [-0.355, 0.355]) add(box(0.04, 0.34, 0.015), timber, x, 0.47, z);
    for (const x of [-0.505, 0.505]) for (const tilt of [-0.5, 0.5]) add(box(0.015, 0.04, 0.42), timber, x, 0.47, 0).rotation.x = tilt;
    // The door in a timber frame, a step, and a stepping-stone path.
    add(box(0.26, 0.5, 0.03), timber, 0, 0.33, 0.358);
    add(box(0.2, 0.44, 0.03), doorMat, 0, 0.3, 0.366);
    add(box(0.2, 0.012, 0.012), iron, 0, 0.44, 0.384);
    add(box(0.2, 0.012, 0.012), iron, 0, 0.2, 0.384);
    add(box(0.03, 0.03, 0.02), brass, 0.06, 0.3, 0.386);
    add(box(0.36, 0.04, 0.12), footing, 0, 0.02, 0.45);
    for (const [x, z, w] of [[0.02, 0.58, 0.2], [-0.03, 0.72, 0.18]] as [number, number, number][]) add(box(w, 0.02, 0.1), footing, x, 0.01, z);
    for (const x of [-0.32, 0.32]) {
      framed(x, 0.5, 0.2, 0.18, 0.355, true);
      flowerBox(x, 0.35, 0.39, 0.26, x < 0 ? "#d0473a" : "#e8c53a");
    }
    // The roof, with a gabled dormer standing out of the front slope and a window in it.
    gable(0, 0.65, 0, 0.98, 0.46, 0.32, false, plaster);
    shingles(0, 0.65, 0.98, 0.46, 0.32, 0.2);
    gable(0, 0.65, 0.24, 0.4, 0.17, 0.17, true, plaster);
    add(box(0.07, 0.06, 0.46), roofDark, 0, 0.65 + 0.19, 0.24);
    framed(0, 0.74, 0.1, 0.09, 0.446);
    for (const x of [-0.49, 0.49]) {
      add(box(0.014, 0.12, 0.12), timber, x * 1.02, 0.78, 0);
      add(box(0.012, 0.09, 0.09), glass, x * 1.02 + Math.sign(x) * 0.006, 0.78, 0).userData.glow = true;
    }
    chimney(0.33, -0.12, 0.6, 1.14, 0.17);
    lantern(0.47, 0.36, 0.43);
    add(box(0.03, 0.02, 0.08), iron, 0.47, 0.42, 0.4);
    logs(-0.66, 0.1, 3);
    barrel(0.66, 0.2);
    barrel(0.6, 0.34, 0.07, 0.15);
  } else {
    // The Lodge: a long hall of stone and timbered plaster under a tall roof, a gabled porch on posts, two dormers,
    // a big stone chimney, a lower wing to the west with a window in its gable, a picket fence, barrels, lanterns,
    // and a banner in the roof's colour flying from the ridge.
    const ox = 0.24;
    add(box(1.28, 0.08, 0.86), footing, ox, 0.04, 0);
    add(box(1.22, 0.26, 0.8), stone, ox, 0.21, 0);
    add(box(1.24, 0.04, 0.82), timber, ox, 0.34, 0);
    add(box(1.2, 0.32, 0.78), plaster, ox, 0.52, 0);
    add(box(1.26, 0.04, 0.84), timber, ox, 0.68, 0);
    for (const dx of [-0.6, 0.6]) for (const z of [-0.39, 0.39]) add(box(0.07, 0.6, 0.07), timber, ox + dx, 0.38, z);
    for (const dx of [-0.38, -0.12, 0.38]) for (const z of [-0.395, 0.395]) add(box(0.045, 0.32, 0.015), timber, ox + dx, 0.52, z);
    for (const tilt of [-0.55, 0.55]) add(box(0.015, 0.04, 0.44), timber, ox + 0.615, 0.52, 0).rotation.x = tilt;
    // The door under the porch, and a window either side of it, shuttered, with flower boxes.
    add(box(0.28, 0.46, 0.03), timber, ox, 0.31, 0.398);
    add(box(0.22, 0.4, 0.03), doorMat, ox, 0.28, 0.406);
    add(box(0.22, 0.012, 0.012), iron, ox, 0.4, 0.424);
    add(box(0.22, 0.012, 0.012), iron, ox, 0.18, 0.424);
    add(box(0.03, 0.03, 0.02), brass, ox + 0.07, 0.28, 0.426);
    for (const [dx, bloom] of [[-0.4, "#d0473a"], [0.4, "#e8c53a"]] as [number, string][]) {
      framed(ox + dx, 0.5, 0.2, 0.17, 0.395, true);
      flowerBox(ox + dx, 0.37, 0.43, 0.26, bloom);
    }
    // The porch: a plank floor, two posts, and a little gabled roof of its own, with a lantern under it.
    add(box(0.52, 0.03, 0.4), lambert("#8a6a44"), ox, 0.095, 0.6);
    for (const dx of [-0.21, 0.21]) add(box(0.05, 0.36, 0.05), timber, ox + dx, 0.28, 0.76);
    gable(ox, 0.46, 0.58, 0.4, 0.27, 0.15, true, plaster);
    add(box(0.06, 0.05, 0.42), roofDark, ox, 0.46 + 0.16, 0.58);
    add(box(0.46, 0.05, 0.06), timber, ox, 0.44, 0.77);
    add(box(0.03, 0.04, 0.1), iron, ox + 0.14, 0.4, 0.72);
    lantern(ox + 0.14, 0.34, 0.74);
    add(box(0.38, 0.04, 0.14), footing, ox, 0.03, 0.88);
    // The main roof, with two dormers.
    gable(ox, 0.68, 0, 1.2, 0.52, 0.46, false, plaster);
    shingles(ox, 0.68, 1.2, 0.52, 0.46, 0.26);
    for (const dx of [-0.34, 0.34]) {
      gable(ox + dx, 0.68, 0.28, 0.4, 0.18, 0.18, true, plaster);
      add(box(0.06, 0.05, 0.44), roofDark, ox + dx, 0.68 + 0.2, 0.28);
      framed(ox + dx, 0.76, 0.12, 0.1, 0.486);
    }
    add(box(0.014, 0.14, 0.14), timber, ox + 0.61, 0.82, 0);
    add(box(0.012, 0.1, 0.1), glass, ox + 0.616, 0.82, 0).userData.glow = true;
    glows.push({ pos: new THREE.Vector3(ox + 0.75, 0.82, 0), size: 0.34 });
    chimney(ox + 0.4, -0.16, 0.7, 1.46, 0.2);
    // The banner: a pole on the ridge's end and a pennant in the roof's colour.
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.4, 5), iron, ox + 0.5, 1.3, 0.02);
    add(box(0.22, 0.11, 0.012), roofMat, ox + 0.61, 1.4, 0.02);
    add(box(0.06, 0.11, 0.012), brass, ox + 0.73, 1.4, 0.02);
    // The wing: a lower, gabled hall to the west, end on to the front, with its own window.
    const wx = -0.62;
    add(box(0.56, 0.08, 0.66), footing, wx, 0.04, 0);
    add(box(0.5, 0.26, 0.6), stone, wx, 0.21, 0);
    add(box(0.52, 0.04, 0.62), timber, wx, 0.34, 0);
    add(box(0.48, 0.2, 0.58), plaster, wx, 0.45, 0);
    add(box(0.52, 0.04, 0.62), timber, wx, 0.56, 0);
    for (const x of [-0.25, 0.25]) for (const z of [-0.3, 0.3]) add(box(0.06, 0.48, 0.06), timber, wx + x, 0.32, z);
    framed(wx, 0.45, 0.2, 0.13, 0.292, true);
    gable(wx, 0.56, 0, 0.62, 0.27, 0.3, true, plaster);
    add(box(0.06, 0.05, 0.66), roofDark, wx, 0.56 + 0.31, 0);
    framed(wx, 0.7, 0.1, 0.1, 0.316);
    // A picket fence round a little garden in front of the wing.
    for (let i = 0; i < 6; i++) add(box(0.03, 0.12, 0.02), lambert("#e8dcc0"), wx - 0.25 + i * 0.1, 0.06, 0.6);
    add(box(0.56, 0.02, 0.015), lambert("#e8dcc0"), wx, 0.09, 0.6);
    for (const [dx, bloom] of [[-0.14, "#d0473a"], [0.0, "#e8c53a"], [0.14, "#c46bd0"]] as [number, string][]) {
      add(box(0.05, 0.05, 0.05), lambert("#4f8a3a"), wx + dx, 0.025, 0.46);
      add(box(0.04, 0.04, 0.04), lambert(bloom), wx + dx, 0.07, 0.46);
    }
    barrel(ox + 0.5, 0.58);
    barrel(ox + 0.64, 0.52, 0.07, 0.15);
    logs(wx - 0.02, -0.4, 3);
  }
  g.userData.glows = glows;
  g.userData.panes = panes;
  foldByLook(g);
};
