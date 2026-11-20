// The Lapidary as it stands in the Harbor (packages/world/src/harbor.ts has
// where; WorldRenderer.poiModel calls this for its point of interest): the
// jeweller-and-stonecutter's shop where lodestones are cut and worked and
// gems are bought. Built from the same kit as the crew's workshops (dark
// timbers, plaster, dressed stone, glass that warms at dusk), but narrower
// and taller than they are, gable end to the lane:
//
//   - a slate-blue door with a brass knob and a diamond of glass in it;
//   - a bow window beside the door, cut stones laid out on dark cloth behind
//     its small panes, a few of them giving their own light;
//   - a sign hung from an iron bracket, cut like a faceted gem;
//   - a cutting wheel on a trestle by the wall, rough stone stacked by it;
//   - and upstairs a window that shows blue after dark: the lodestones.
//
// The model fits one hex, its front to +z, like every other place's; the
// renderer scales and stands it (see PLACE there).

import * as THREE from "three";
import type { BuildingGlow } from "./ambience";

/** Window glass that warms with the dusk (WorldRenderer's `warmPane`). */
type WarmPane = (unlit: string, lit: string) => THREE.MeshBasicMaterial;

/**
 * Build the Lapidary into `g`. Leaves on it what the renderer looks for on a building: its lit windows and
 * lanterns (`userData.glows`), the panes that warm at dusk (`userData.panes`) and its chimney top (`userData.smoke`).
 */
export function buildLapidary(g: THREE.Group, warmPane: WarmPane): void {
  const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    g.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  /** Something that gives its own light: drawn unlit, and left out of the shadows. */
  const lit = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rotY = 0) => {
    const mesh = add(geometry, new THREE.MeshBasicMaterial({ color }), x, y, z, rotY);
    mesh.userData.glow = true;
    return mesh;
  };

  const timber = lambert("#4a2f22");
  const plaster = lambert("#e2d8be");
  const stone = lambert("#a8977a");
  const footing = lambert("#7b8494");
  const iron = lambert("#2b2a33");
  const wood = lambert("#7a5230");
  const boards = lambert("#8a6a44");
  const brass = lambert("#d9a93a");
  const blue = lambert("#2f4660");
  const velvet = lambert("#221d36");
  const roofHex = "#3d5068";
  const roofMat = lambert(roofHex);
  const roofDark = lambert("#" + new THREE.Color(roofHex).multiplyScalar(0.72).getHexString());
  const glows: BuildingGlow[] = [];
  /** The shop's own glass, warm at dusk; and the upstairs window's, which shows the blue of the lodestones. */
  const glass = warmPane("#b9a064", "#ffd896");
  const lodeGlass = warmPane("#7f93a6", "#8fd4ff");
  /** The bow window's panes are seen through, to the stones laid out behind them. */
  const bowGlass = warmPane("#cfe0e6", "#ffe6b0");
  bowGlass.transparent = true;
  bowGlass.opacity = 0.16;
  bowGlass.depthWrite = false;

  /** A cut stone: two pyramids base to base. One that glows gives its own light. */
  const gem = (x: number, y: number, z: number, size: number, color: string, glowing = false, turn = 0) => {
    const mesh = glowing ? lit(new THREE.OctahedronGeometry(size, 0), color, x, y, z, turn) : add(new THREE.OctahedronGeometry(size, 0), lambert(color), x, y, z, turn);
    mesh.scale.y = 1.3;
    return mesh;
  };

  // The shop: a footing, a course of stone, a plastered ground floor, the jetty beam, an upper floor that overhangs
  // a little, and the eave beam. Timber posts at every corner, a stud up the middle of the upper front and a brace
  // either side of it.
  add(box(0.84, 0.08, 0.72), footing, 0, 0.04, 0);
  add(box(0.76, 0.1, 0.64), stone, 0, 0.13, 0);
  add(box(0.74, 0.3, 0.62), plaster, 0, 0.33, 0);
  add(box(0.8, 0.04, 0.68), timber, 0, 0.5, 0);
  add(box(0.78, 0.3, 0.66), plaster, 0, 0.67, 0);
  add(box(0.82, 0.04, 0.7), timber, 0, 0.84, 0);
  for (const x of [-0.37, 0.37]) for (const z of [-0.31, 0.31]) add(box(0.05, 0.3, 0.05), timber, x, 0.33, z);
  for (const x of [-0.39, 0.39]) for (const z of [-0.33, 0.33]) add(box(0.05, 0.3, 0.05), timber, x, 0.67, z);
  for (const x of [-0.24, 0.24]) add(box(0.035, 0.3, 0.015), timber, x, 0.67, 0.335);
  for (const s of [-1, 1]) add(box(0.015, 0.2, 0.012), timber, s * 0.315, 0.63, 0.336).rotation.z = s * 0.5;
  for (const x of [-0.395, 0.395]) for (const tilt of [-0.5, 0.5]) add(box(0.015, 0.04, 0.36), timber, x, 0.67, 0).rotation.x = tilt;

  // The roof: a steep gable, its end to the lane, of slate in courses with a ridge cap; the gable itself plastered,
  // with a timber collar across it.
  const [half, rise, len, eave] = [0.47, 0.44, 0.74, 0.86];
  const prism = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-half + 0.06, 0), new THREE.Vector2(half - 0.06, 0), new THREE.Vector2(0, rise - 0.06)]), { depth: len - 0.06, bevelEnabled: false }).translate(0, 0, -(len - 0.06) / 2);
  add(prism, plaster, 0, eave, 0);
  const pitch = Math.atan2(rise, half);
  const slope = Math.hypot(rise, half) * 1.08;
  for (const side of [1, -1]) {
    /** A slab `depth` long down the slope, its middle `along` from the ridge. */
    const slab = (along: number, depth: number, m: THREE.Material, thick: number) => {
      const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
      const y = eave + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
      add(box(depth, thick, len + 0.12), m, out, y, 0).rotation.z = -side * pitch;
    };
    slab(slope / 2, slope, roofMat, 0.06);
    for (const d of [0.2, 0.4, 0.58]) slab(d, 0.045, roofDark, 0.065);
    // The barge board up the gable's edge, at the front.
    add(box(slope, 0.05, 0.03), timber, side * (slope / 2) * Math.cos(pitch), eave + rise - (slope / 2) * Math.sin(pitch), len / 2 + 0.05).rotation.z = -side * pitch;
  }
  add(box(0.08, 0.06, len + 0.2), roofDark, 0, eave + rise + 0.03, 0);
  add(box(0.5, 0.035, 0.02), timber, 0, eave + 0.19, len / 2 - 0.025);
  // A brass ball on a spike at the gable's peak.
  add(box(0.02, 0.12, 0.02), iron, 0, eave + rise + 0.1, len / 2 + 0.05);
  add(new THREE.SphereGeometry(0.03, 6, 5), brass, 0, eave + rise + 0.18, len / 2 + 0.05);

  // The door, on the left: a timber frame, a slate-blue leaf on iron straps, a brass knob, a diamond of glass in it,
  // and a stone step.
  const dx = -0.2;
  add(box(0.22, 0.36, 0.03), timber, dx, 0.27, 0.315);
  add(box(0.16, 0.32, 0.03), blue, dx, 0.26, 0.325);
  for (const y of [0.37, 0.16]) add(box(0.16, 0.012, 0.012), iron, dx, y, 0.344);
  add(box(0.028, 0.028, 0.02), brass, dx + 0.055, 0.25, 0.346);
  add(box(0.05, 0.05, 0.012), glass, dx, 0.31, 0.342).rotation.z = Math.PI / 4;
  add(box(0.3, 0.06, 0.12), footing, dx, 0.03, 0.42);
  for (const [x, z, w] of [[-0.2, 0.58, 0.2], [-0.16, 0.72, 0.18]] as [number, number, number][]) add(box(w, 0.02, 0.1), footing, x, 0.01, z);

  // The bow window, beside the door: a bulkhead of boards, three faces of small panes standing out from the wall
  // under a little roof of slate, and behind the glass a step of dark cloth with cut stones laid out on it.
  const bx = 0.15;
  const bowZ = 0.31;
  add(box(0.34, 0.1, 0.1), boards, bx, 0.22, bowZ + 0.04);
  add(box(0.38, 0.025, 0.13), timber, bx, 0.28, bowZ + 0.045);
  add(box(0.3, 0.2, 0.012), lambert("#1c1a26"), bx, 0.39, bowZ + 0.008);
  add(box(0.3, 0.03, 0.07), velvet, bx, 0.305, bowZ + 0.045);
  add(box(0.3, 0.03, 0.035), velvet, bx, 0.335, bowZ + 0.027);
  const colours = ["#ff7ae0", "#4fd6c8", "#ffb84a", "#7fd0ff", "#b48cff"];
  colours.forEach((c, i) => gem(bx - 0.11 + i * 0.055, i % 2 ? 0.395 : 0.36, bowZ + (i % 2 ? 0.035 : 0.07), 0.027, c, true, i));
  // The three faces, and the bars between their panes.
  const faces: [number, number, number, number][] = [[bx, bowZ + 0.105, 0.2, 0], [bx - 0.135, bowZ + 0.075, 0.1, 0.72], [bx + 0.135, bowZ + 0.075, 0.1, -0.72]];
  for (const [x, z, w, turn] of faces) {
    add(box(w, 0.19, 0.008), bowGlass, x, 0.39, z, turn).userData.glow = true;
    for (const y of [0.295, 0.39, 0.485]) add(box(w + 0.01, 0.012, 0.014), timber, x, y, z, turn);
    if (!turn) for (const px of [-0.1, -0.033, 0.033, 0.1]) add(box(0.012, 0.19, 0.014), timber, x + px, 0.39, z);
    else add(box(0.012, 0.19, 0.014), timber, x, 0.39, z, turn);
  }
  for (const s of [-1, 1]) add(box(0.016, 0.2, 0.016), timber, bx + s * 0.172, 0.39, bowZ + 0.045);
  const cap = add(box(0.4, 0.02, 0.15), roofDark, bx, 0.505, bowZ + 0.06);
  cap.rotation.x = 0.22;
  glows.push({ pos: new THREE.Vector3(bx, 0.4, bowZ + 0.22), size: 0.62 });

  // Upstairs, a window in the gable: its glass shows the blue of the lodestones after dark. Shutters either side,
  // and under it a box with a few pale blooms.
  add(box(0.2, 0.18, 0.012), timber, 0, 0.68, 0.336);
  add(box(0.16, 0.14, 0.01), lodeGlass, 0, 0.68, 0.343).userData.glow = true;
  add(box(0.012, 0.14, 0.012), timber, 0, 0.68, 0.349);
  add(box(0.16, 0.012, 0.012), timber, 0, 0.68, 0.349);
  for (const s of [-1, 1]) add(box(0.04, 0.16, 0.014), blue, s * 0.125, 0.68, 0.343);
  add(box(0.22, 0.045, 0.06), wood, 0, 0.57, 0.37);
  for (let i = 0; i < 4; i++) add(box(0.035, 0.035 + (i % 2) * 0.02, 0.035), lambert(i % 2 ? "#f4efe1" : "#6aa34f"), -0.075 + i * 0.05, 0.61, 0.37);
  glows.push({ pos: new THREE.Vector3(0, 0.68, 0.46), size: 0.3 });
  // And a small round one up in the peak.
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 8), timber, 0, eave + 0.1, len / 2 - 0.02).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 8), lodeGlass, 0, eave + 0.1, len / 2 - 0.012).rotation.x = Math.PI / 2;

  // The sign: an iron bracket out of the wall over the door, and hanging from it by two links a gem cut in wood
  // and painted, its crown and its point, with a band of brass round its girdle. Its face is to the side, so it
  // reads from along the lane.
  const [sx, sy, sz] = [-0.3, 0.8, 0.34];
  add(box(0.03, 0.03, 0.3), iron, sx, sy, sz + 0.15);
  add(box(0.02, 0.1, 0.02), iron, sx, sy - 0.06, sz + 0.02).rotation.x = 0.7;
  for (const dz of [0.12, 0.24]) add(box(0.008, 0.06, 0.008), iron, sx, sy - 0.04, sz + dz);
  const crown = add(new THREE.CylinderGeometry(0.055, 0.105, 0.05, 6), lambert("#4f9fd0"), sx, sy - 0.095, sz + 0.18);
  const point = add(new THREE.ConeGeometry(0.105, 0.14, 6), lambert("#3878b0"), sx, sy - 0.19, sz + 0.18);
  point.rotation.x = Math.PI;
  const girdle = add(new THREE.CylinderGeometry(0.11, 0.11, 0.014, 6), brass, sx, sy - 0.12, sz + 0.18);
  for (const piece of [crown, point, girdle]) piece.scale.x = 0.32;
  // The table of the gem catches the light: a pale facet on each face of the sign.
  for (const s of [-1, 1]) add(box(0.004, 0.022, 0.07), lambert("#bfe6ff"), sx + s * 0.02, sy - 0.082, sz + 0.18);

  // A lantern on a bracket by the door, lit at dusk.
  const [lx, ly, lz] = [-0.37, 0.4, 0.38];
  add(box(0.03, 0.02, 0.08), iron, lx, ly + 0.07, lz - 0.04);
  lit(box(0.05, 0.065, 0.05), "#ffd77a", lx, ly, lz);
  for (const [ox, oz] of [[-0.03, -0.03], [0.03, -0.03], [-0.03, 0.03], [0.03, 0.03]]) add(box(0.01, 0.08, 0.01), iron, lx + ox, ly, lz + oz);
  add(box(0.08, 0.015, 0.08), iron, lx, ly - 0.045, lz);
  add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, lx, ly + 0.06, lz, Math.PI / 4);
  glows.push({ pos: new THREE.Vector3(lx, ly, lz + 0.1), size: 0.34 });

  // The cutting wheel, out by the east wall where the light is good: a stone wheel on a trestle over a trough of
  // water, a crank on its axle, and a stool to sit to it.
  const [wx, wz] = [0.58, 0.2];
  for (const z of [-0.08, 0.08]) for (const s of [-1, 1]) add(box(0.03, 0.3, 0.03), wood, wx + s * 0.07, 0.15, wz + z).rotation.z = -s * 0.2;
  add(box(0.22, 0.07, 0.2), boards, wx, 0.07, wz);
  add(box(0.18, 0.012, 0.16), lambert("#3f7fb8"), wx, 0.11, wz);
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.045, 12), lambert("#b8b0a0"), wx, 0.27, wz).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 6), iron, wx, 0.27, wz).rotation.x = Math.PI / 2;
  add(box(0.014, 0.08, 0.014), iron, wx, 0.235, wz + 0.12);
  add(box(0.014, 0.014, 0.05), wood, wx, 0.2, wz + 0.14);
  add(new THREE.CylinderGeometry(0.06, 0.05, 0.14, 7), wood, wx + 0.02, 0.07, wz + 0.3);

  // Rough stone by the west wall, as the cart left it: blocks stacked, one split to show a seam of colour, a crate
  // with straw in it and a lodestone not yet cut, and chippings on the ground.
  add(box(0.2, 0.15, 0.18), lambert("#7b8088"), -0.56, 0.075, 0.06, 0.3);
  add(box(0.17, 0.13, 0.16), lambert("#6c7079"), -0.57, 0.215, 0.05, -0.2);
  add(box(0.16, 0.13, 0.15), lambert("#9a9ea6"), -0.55, 0.065, -0.16, 0.8);
  gem(-0.5, 0.17, -0.13, 0.03, "#ff7ae0", true, 0.4);
  add(box(0.2, 0.12, 0.16), boards, -0.56, 0.06, 0.3, 0.15);
  add(box(0.17, 0.02, 0.13), lambert("#d8c38a"), -0.56, 0.125, 0.3, 0.15);
  gem(-0.55, 0.16, 0.3, 0.035, "#39445a", false, 0.9);
  for (let i = 0; i < 6; i++) add(new THREE.DodecahedronGeometry(0.014 + (i % 3) * 0.006, 0), lambert(i % 2 ? "#7b8088" : "#9a9ea6"), 0.42 + (i % 3) * 0.07, 0.01, 0.4 + Math.sin(i * 2.1) * 0.06, i);

  // The chimney, up through the east slope of the roof at the back; the ambience draws its smoke.
  add(box(0.13, 0.52, 0.13), stone, 0.24, 1.14, -0.2);
  add(box(0.18, 0.045, 0.18), footing, 0.24, 1.42, -0.2);
  add(new THREE.CylinderGeometry(0.03, 0.04, 0.07, 6), lambert("#b8643a"), 0.24, 1.48, -0.2);
  g.userData.smoke = new THREE.Vector3(0.24, 1.55, -0.2);

  g.userData.glows = glows;
  g.userData.panes = [glass, lodeGlass, bowGlass];
}
