// The Harbor's places of trade: the pub, the market stall and the Lapidary (whose model is lapidary.ts).

import * as THREE from "three";
import { pixelTexture, stamp, type BuildingGlow } from "../ambience";
import { buildLapidary } from "../lapidary";
import { foldByLook, warmPane, type PlaceModel } from "./kit";

/** The pub's painted sign: a foaming tankard on an oxblood board with a gold edge. Made once and shared. */
let pubSignTexture: THREE.CanvasTexture | null = null;
function pubSign(): THREE.CanvasTexture {
  pubSignTexture ??= pixelTexture(16, 14, (ctx) => {
    ctx.fillStyle = "#6e2b26";
    ctx.fillRect(0, 0, 16, 14);
    stamp(ctx, [
      "BBBBBBBBBBBBBBBB",
      "B              B",
      "B    W  WW     B",
      "B   WWWWWWW    B",
      "B  WWWWWWWWW   B",
      "B   hhhhhhh    B",
      "B   YyYYyYYYY  B",
      "B   YyYYyYY  Y B",
      "B   hhhhhhh  Y B",
      "B   YyYYyYY  Y B",
      "B   YyYYyYYYY  B",
      "B   hhhhhhh    B",
      "B              B",
      "BBBBBBBBBBBBBBBB",
    ], { B: "#d9b45a", W: "#f4efe1", Y: "#d08a3a", y: "#a8662a", h: "#3a2c22" });
  });
  return pubSignTexture;
}

/** The pub. */
export const pub: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The pub: the warm heart of the town. A two-storey inn, bigger than any hut: a stone ground floor, a jettied
  // upper floor of cream plaster and dark timbers under a steep gabled roof, windows that warm and glow as the
  // light goes, a painted sign on a bracket, a lantern, and barrels and a bench out front.
  const timber = lambert("#4a2f22");
  const plaster = lambert("#e8d9b5");
  const stone = lambert("#a8977a");
  const roofMat = lambert("#7a3a2c");
  const glows: BuildingGlow[] = [];
  const panes: THREE.MeshBasicMaterial[] = [];
  /** A window's glass: dim amber by day, lamplit by night. */
  const pane = (unlit: string, lit: string) => {
    const m = warmPane(unlit, lit);
    panes.push(m);
    return m;
  };
  const lowerGlass = pane("#c99a52", "#ffd98a");
  const upperGlass = pane("#b98a4a", "#ffc870");
  /** A framed window on the front, with a cross of glazing bars. */
  const framed = (x: number, y: number, w: number, h: number, z: number, glass: THREE.Material) => {
    add(box(w + 0.05, h + 0.05, 0.012), timber, x, y, z);
    add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
    add(box(0.02, h, 0.012), timber, x, y, z + 0.014);
    add(box(w, 0.02, 0.012), timber, x, y, z + 0.014);
    glows.push({ pos: new THREE.Vector3(x, y, z + 0.18), size: w * 2.2 });
  };

  // The ground floor: a stone plinth and stone walls.
  add(box(1.6, 0.08, 1.0), lambert("#7b8494"), 0, 0.04, 0);
  add(box(1.5, 0.46, 0.92), stone, 0, 0.31, 0);
  for (const x of [-0.48, 0.48]) {
    framed(x, 0.31, 0.26, 0.2, 0.46, lowerGlass);
    add(box(0.32, 0.03, 0.06), timber, x, 0.19, 0.48);
  }
  // The door: a red door in a timber frame, a lit fanlight over it, a brass handle and a stone step.
  add(box(0.3, 0.42, 0.02), timber, 0, 0.29, 0.465);
  add(box(0.22, 0.35, 0.03), lambert("#7a3a24"), 0, 0.255, 0.47);
  add(box(0.2, 0.035, 0.02), lowerGlass, 0, 0.472, 0.475).userData.glow = true;
  add(box(0.03, 0.03, 0.02), lambert("#e0b12e"), 0.07, 0.25, 0.49);
  add(box(0.4, 0.04, 0.12), lambert("#8b8f96"), 0, 0.02, 0.56);
  // A little gabled hood over the door on two brackets.
  const hood = add(box(0.46, 0.035, 0.24), roofMat, 0, 0.53, 0.57);
  hood.rotation.x = 0.35;
  for (const x of [-0.19, 0.19]) add(box(0.03, 0.03, 0.16), timber, x, 0.47, 0.52).rotation.x = -0.75;

  // The jettied upper floor: a beam, cream plaster, and a frame of dark timbers.
  add(box(1.62, 0.07, 1.04), timber, 0, 0.575, 0);
  add(box(1.58, 0.38, 1.0), plaster, 0, 0.8, 0);
  add(box(1.64, 0.05, 1.04), timber, 0, 1.0, 0);
  for (const x of [-0.79, 0.79]) for (const z of [-0.5, 0.5]) add(box(0.06, 0.38, 0.06), timber, x, 0.8, z);
  for (const x of [-0.25, 0.25]) for (const z of [-0.505, 0.505]) add(box(0.05, 0.38, 0.02), timber, x, 0.8, z);
  for (const x of [-0.795, 0.795]) add(box(0.02, 0.38, 0.05), timber, x, 0.8, 0);
  // A cross brace in the middle bay, front and back.
  for (const z of [-0.507, 0.507]) for (const tilt of [-0.66, 0.66]) add(box(0.56, 0.04, 0.015), timber, 0, 0.8, z).rotation.z = tilt;
  // Two windows upstairs, each with a box of flowers under it.
  for (const [x, bloom] of [[-0.52, "#d0473a"], [0.52, "#e8c53a"]] as [number, string][]) {
    framed(x, 0.82, 0.22, 0.18, 0.5, upperGlass);
    add(box(0.28, 0.06, 0.08), lambert("#6b4a2b"), x, 0.68, 0.54);
    add(box(0.24, 0.04, 0.06), lambert("#4f8a3a"), x, 0.725, 0.54);
    for (const dx of [-0.08, 0, 0.08]) add(box(0.04, 0.04, 0.04), lambert(bloom), x + dx, 0.755, 0.55 + (dx === 0 ? 0.01 : 0));
  }

  // The roof: a long gabled roof with eaves that overhang all round, and a smaller gable over the door,
  // standing out of the front slab, with a lit window in it.
  const eaves = 1.02;
  /** A gabled roof: a plaster prism `len` long, `half` out to each eave and `rise` high, under two overhanging slabs. Its ridge runs along x, or along z with `alongZ`. */
  const gabled = (cx: number, cz: number, len: number, half: number, rise: number, alongZ: boolean) => {
    const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
    const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
    if (!alongZ) prism.rotateY(Math.PI / 2);
    add(prism, plaster, cx, eaves, cz);
    const pitch = Math.atan2(rise, half);
    const slope = Math.hypot(rise, half) * 1.18;
    for (const side of [1, -1]) {
      // Half way down the slope, lifted half a slab's thickness off the gable.
      const along = slope / 2;
      const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
      const y = eaves + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
      if (alongZ) add(box(slope, 0.06, len + 0.1), roofMat, cx + out, y, cz).rotation.z = -side * pitch;
      else add(box(len + 0.2, 0.06, slope), roofMat, cx, y, cz + out).rotation.x = side * pitch;
    }
    return pitch;
  };
  const rise = 0.44;
  const pitch = gabled(0, 0, 1.56, 0.5, rise, false);
  // A darker course of shingles part way down each slope, and a ridge cap.
  for (const side of [1, -1]) {
    const d = 0.24;
    add(box(1.77, 0.065, 0.06), lambert("#5d2a20"), 0, eaves + rise - d * Math.sin(pitch) + 0.035 * Math.cos(pitch), side * (d * Math.cos(pitch) + 0.035 * Math.sin(pitch))).rotation.x = side * pitch;
  }
  add(box(1.82, 0.07, 0.1), lambert("#4a2018"), 0, eaves + rise + 0.03, 0);
  gabled(0, 0.32, 0.48, 0.32, 0.34, true);
  add(box(0.08, 0.06, 0.58), lambert("#4a2018"), 0, eaves + 0.37, 0.32);
  framed(0, eaves + 0.13, 0.16, 0.13, 0.565, upperGlass);
  // A small window in each end gable, under the peak.
  for (const x of [-0.785, 0.785]) {
    add(box(0.015, 0.14, 0.14), timber, x, eaves + 0.15, 0);
    add(box(0.012, 0.1, 0.1), upperGlass, x + Math.sign(x) * 0.006, eaves + 0.15, 0).userData.glow = true;
  }

  // The chimney stands proud of the roof, with a pot on top; its smoke is drawn by the ambience.
  add(box(0.22, 0.92, 0.22), lambert("#8b8f96"), 0.52, 1.36, -0.24);
  add(box(0.28, 0.06, 0.28), lambert("#6f737a"), 0.52, 1.83, -0.24);
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 6), lambert("#b8643a"), 0.52, 1.9, -0.24);
  g.userData.smoke = new THREE.Vector3(0.52, 1.96, -0.24);

  // The sign: an iron bracket off the front corner, under the eaves, and a painted board hanging from it, face on to the street.
  const iron = lambert("#2b2a33");
  add(box(0.32, 0.03, 0.03), iron, 0.94, 0.6, 0.47);
  add(box(0.2, 0.025, 0.025), iron, 0.85, 0.54, 0.47).rotation.z = 0.6;
  for (const x of [0.84, 1.04]) add(box(0.012, 0.05, 0.012), iron, x, 0.565, 0.47);
  add(box(0.32, 0.28, 0.025), lambert("#3a2c22"), 0.94, 0.4, 0.47);
  const face = new THREE.MeshLambertMaterial({ map: pubSign() });
  add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.484);
  add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.456, Math.PI);

  // A lantern on a bracket by the door, lit at dusk.
  add(box(0.03, 0.03, 0.14), iron, -0.66, 0.5, 0.53);
  add(box(0.08, 0.02, 0.08), iron, -0.66, 0.485, 0.6);
  const flame = add(box(0.05, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.66, 0.44, 0.6);
  flame.userData.glow = true;
  for (const [dx, dz] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) add(box(0.012, 0.09, 0.012), iron, -0.66 + dx, 0.44, 0.6 + dz);
  add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, -0.66, 0.51, 0.6, Math.PI / 4);
  glows.push({ pos: new THREE.Vector3(-0.66, 0.44, 0.72), size: 0.42, light: "candle" });
  // The lamplight spilling out of the front, onto the street: held high and well out, so a hero at the door
  // is lit evenly rather than with a hot spot.
  glows.push({ pos: new THREE.Vector3(0, 1.1, 1.4), size: 0, light: "lamp" });

  // Barrels by the lantern, and a bench under the sign with a tankard left on it.
  for (const [x, z] of [[-0.62, 0.68], [-0.42, 0.74]]) {
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8), lambert("#7a5230"), x, 0.11, z);
    for (const y of [0.05, 0.17]) add(new THREE.CylinderGeometry(0.104, 0.104, 0.02, 8), timber, x, y, z);
  }
  add(box(0.4, 0.035, 0.11), lambert("#8a6a44"), 0.52, 0.15, 0.62);
  for (const x of [0.36, 0.68]) add(box(0.04, 0.13, 0.08), timber, x, 0.065, 0.62);
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 6), lambert("#d08a3a"), 0.6, 0.193, 0.62);
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 6), lambert("#f4efe1"), 0.6, 0.223, 0.62);
  g.userData.glows = glows;
  g.userData.panes = panes;
  foldByLook(g);
};

/** The market stall. */
export const shop: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The market stall: a plank platform, a counter with a cloth runner and the day's goods on it (a crate of apples,
  // a balance and a stack of coin, a sack of grain), a shelved back wall of jars and bolts of cloth, a striped
  // awning with a scalloped edge on four poles, lanterns, a coin sign, and crates and a barrel stacked at the sides.
  const timber = lambert("#4a2f22");
  const wood = lambert("#7a5230");
  const plank = lambert("#a07a4c");
  const brass = lambert("#e0b12e");
  const iron = lambert("#2b2a33");
  const red = lambert("#b9433d");
  const cream = lambert("#f4efe1");
  const glows: BuildingGlow[] = [];
  add(box(1.5, 0.04, 0.95), lambert("#6b5138"), 0, 0.02, 0.05);
  for (let i = -3; i <= 3; i++) add(box(0.012, 0.006, 0.95), timber, i * 0.2, 0.043, 0.05);
  // The counter: a plank front, a top slab, and a red cloth runner down the middle.
  add(box(1.0, 0.3, 0.36), wood, 0, 0.19, 0.18);
  for (let i = -4; i <= 4; i++) add(box(0.01, 0.28, 0.01), timber, i * 0.11, 0.19, 0.364);
  add(box(1.06, 0.04, 0.42), plank, 0, 0.36, 0.18);
  add(box(0.9, 0.01, 0.3), red, 0, 0.385, 0.18);
  add(box(0.9, 0.12, 0.012), red, 0, 0.27, 0.372);
  for (let i = 0; i < 9; i++) add(new THREE.ConeGeometry(0.05, 0.06, 4), red, -0.4 + i * 0.1, 0.18, 0.372, Math.PI / 4).rotation.x = Math.PI;
  // Four poles, the back two taller so the awning slopes down to the front.
  for (const x of [-0.52, 0.52]) {
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.96, 6), timber, x, 0.52, 0.38);
    add(new THREE.CylinderGeometry(0.03, 0.03, 1.12, 6), timber, x, 0.6, -0.2);
  }
  // The back wall and its two shelves.
  add(box(1.04, 0.6, 0.03), lambert("#5e4026"), 0, 0.72, -0.2);
  add(box(1.1, 0.04, 0.05), timber, 0, 1.1, -0.2);
  for (const y of [0.5, 0.78]) add(box(0.96, 0.025, 0.16), plank, 0, y, -0.12);
  const jar = (x: number, y: number, c: string) => {
    add(new THREE.CylinderGeometry(0.034, 0.034, 0.09, 6), lambert(c), x, y + 0.05, -0.12);
    add(new THREE.CylinderGeometry(0.036, 0.036, 0.016, 6), lambert("#c9a877"), x, y + 0.104, -0.12);
  };
  ["#c4473a", "#e0b12e", "#5f9e4a", "#3f7fb8", "#d9843a", "#8a5fb0", "#c4473a", "#5f9e4a"].forEach((c, i) => jar(-0.4 + i * 0.115, 0.5125, c));
  // Bolts of cloth lying on the top shelf, and a few more jars.
  [["#3f6fa8", -0.38], ["#b9433d", -0.2], ["#e8dcc0", -0.02]].forEach(([c, x], i) => add(box(0.16, 0.06 + (i % 2) * 0.02, 0.1), lambert(c as string), x as number, 0.8 + (0.06 + (i % 2) * 0.02) / 2, -0.12));
  for (let i = 0; i < 3; i++) jar(0.16 + i * 0.12, 0.7925, ["#e0b12e", "#5f9e4a", "#c4473a"][i]);
  // The striped awning, sloping forward, with a scalloped edge of diamonds along the front.
  const pitch = Math.atan2(0.14, 0.58);
  for (let i = 0; i < 6; i++) {
    const c = i % 2 ? cream : red;
    add(box(0.18, 0.04, 0.66), c, -0.45 + i * 0.18, 1.06, 0.09).rotation.x = pitch;
    add(box(0.12, 0.12, 0.02), c, -0.45 + i * 0.18, 0.94, 0.41).rotation.z = Math.PI / 4;
  }
  add(box(1.12, 0.025, 0.025), timber, 0, 0.98, 0.39);
  // The goods on the counter: a crate of apples, a balance and a stack of coin, and a sack of grain.
  add(box(0.28, 0.09, 0.2), wood, -0.32, 0.43, 0.2);
  add(box(0.24, 0.02, 0.16), lambert("#6b4a2b"), -0.32, 0.47, 0.2);
  for (const [dx, dz, c] of [[-0.07, -0.04, "#c4473a"], [0.0, 0.03, "#d9843a"], [0.07, -0.03, "#c4473a"], [-0.02, -0.07, "#7ab04a"], [0.08, 0.05, "#c4473a"], [-0.08, 0.05, "#d9b45a"]] as [number, number, string][]) add(new THREE.SphereGeometry(0.036, 6, 5), lambert(c), -0.32 + dx, 0.5, 0.2 + dz);
  add(box(0.1, 0.02, 0.07), brass, 0.0, 0.405, 0.2);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 5), brass, 0.0, 0.49, 0.2);
  add(box(0.22, 0.012, 0.012), brass, 0.0, 0.57, 0.2).rotation.z = 0.12;
  for (const [x, y] of [[-0.11, 0.55], [0.11, 0.59]]) {
    add(new THREE.CylinderGeometry(0.045, 0.04, 0.01, 7), brass, x, y - 0.06, 0.2);
    add(box(0.006, 0.06, 0.006), iron, x, y - 0.03, 0.2);
  }
  for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 7), brass, 0.2, 0.395 + i * 0.013, 0.28);
  add(new THREE.CylinderGeometry(0.1, 0.12, 0.17, 7), lambert("#d8c7a0"), 0.36, 0.47, 0.2);
  add(new THREE.CylinderGeometry(0.075, 0.1, 0.03, 7), lambert("#d9b45a"), 0.36, 0.565, 0.2);
  // Lanterns on the front poles, lit at dusk.
  for (const x of [-0.58, 0.58]) {
    add(box(0.07, 0.02, 0.02), iron, x * 0.95, 0.86, 0.38);
    add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, 0.78, 0.38).userData.glow = true;
    add(box(0.08, 0.015, 0.08), iron, x, 0.735, 0.38);
    add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, 0.84, 0.38, Math.PI / 4);
    glows.push({ pos: new THREE.Vector3(x, 0.78, 0.46), size: 0.4 });
  }
  // A coin sign on a post to the right, facing the lane.
  add(box(0.04, 0.9, 0.04), timber, 0.74, 0.47, 0.34);
  add(box(0.04, 0.3, 0.28), timber, 0.74, 0.8, 0.34);
  add(box(0.045, 0.25, 0.23), lambert("#2c3a4a"), 0.74, 0.8, 0.34);
  add(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 10), brass, 0.768, 0.8, 0.34).rotation.z = Math.PI / 2;
  // Crates stacked at the left, and a barrel and a leaning sack at the right.
  add(box(0.26, 0.2, 0.26), wood, -0.72, 0.14, 0.26);
  add(box(0.22, 0.16, 0.22), plank, -0.72, 0.32, 0.26, 0.4);
  add(box(0.2, 0.14, 0.2), wood, -0.7, 0.12, -0.06, 0.2);
  for (const [dx, dz] of [[-0.04, 0.02], [0.05, -0.03], [0.04, 0.05]]) add(new THREE.SphereGeometry(0.04, 6, 5), lambert("#7ab04a"), -0.7 + dx, 0.22, -0.06 + dz);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 8), wood, 0.72, 0.14, -0.02);
  for (const y of [0.08, 0.2]) add(new THREE.CylinderGeometry(0.094, 0.094, 0.02, 8), timber, 0.72, y, -0.02);
  add(box(0.12, 0.17, 0.1), lambert("#d8c7a0"), 0.68, 0.125, -0.22, 0.4);
  g.userData.glows = glows;
  foldByLook(g);
};

/** The Lapidary. */
export const lapidary: PlaceModel = (_poi, kit) => {
  const { g } = kit;
  // The Lapidary, where lodestones are cut and worked and gems are bought: a narrow shop with a bow window of
  // cut stones and a sign like a faceted gem (lapidary.ts).
  buildLapidary(g, warmPane);
  foldByLook(g);
};
