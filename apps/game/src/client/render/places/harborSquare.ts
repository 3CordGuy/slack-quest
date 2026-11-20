// What stands out in the open in the Harbor: the builders' yard where the crew's projects are paid for, the
// notice board, the town chest on its dais and the waygate over its plinth.

import * as THREE from "three";
import type { BuildingGlow } from "../ambience";
import { pennantTexture } from "../flag";
import { makeWaygate } from "../waygate";
import { foldByLook, type PlaceModel } from "./kit";
import { PLACE, UP, yawOf } from "./placing";

/** The works. */
export const works: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The works: the builders' yard where the crew's projects are paid for. Kept low, as it stands in the plaza: a
  // trestle table with the plans weighted down on it, an inkpot and quill, a mug and a candle lantern; a stool; a
  // slate of pledges on an easel; a sawhorse with a plank half sawn; stone on a pallet; strapped planks; a wheelbarrow
  // of stone; a toolbox; a bucket of nails; and a coil of rope.
  const wood = lambert("#7a5230");
  const timber = lambert("#4a2f22");
  const plank = lambert("#a07a4c");
  const boards = lambert("#8a6a44");
  const iron = lambert("#2b2a33");
  const steel = lambert("#8b95a5");
  const stone = lambert("#a3acba");
  const glows: BuildingGlow[] = [];
  for (const x of [-0.32, 0.32]) {
    for (const z of [-0.14, 0.14]) add(box(0.05, 0.36, 0.05), wood, x, 0.18, z - 0.12).rotation.z = x < 0 ? 0.12 : -0.12;
    add(box(0.05, 0.03, 0.34), wood, x, 0.1, -0.12);
  }
  add(box(0.84, 0.05, 0.44), plank, 0, 0.38, -0.12);
  add(box(0.86, 0.012, 0.46), boards, 0, 0.352, -0.12);
  // The plans: a sheet of blue paper with white lines, a rolled plan, and a stone on the corner.
  add(box(0.42, 0.012, 0.3), lambert("#3f6fa8"), -0.08, 0.41, -0.1, 0.12);
  for (const dz of [-0.06, 0.0, 0.06]) add(box(0.3, 0.014, 0.012), lambert("#dce8f5"), -0.08, 0.416, -0.1 + dz, 0.12);
  add(box(0.06, 0.014, 0.2), lambert("#dce8f5"), -0.02, 0.416, -0.1, 0.12);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.36, 6), lambert("#e8dcc0"), 0.28, 0.44, -0.16).rotation.x = Math.PI / 2;
  add(new THREE.DodecahedronGeometry(0.05), stone, -0.26, 0.44, -0.2);
  // An inkpot with a quill in it, a mug, and a candle lantern that glows at dusk.
  add(new THREE.CylinderGeometry(0.022, 0.026, 0.035, 6), lambert("#22232b"), 0.16, 0.423, -0.02);
  add(box(0.006, 0.11, 0.006), lambert("#f4efe1"), 0.18, 0.47, -0.02).rotation.z = -0.3;
  add(box(0.02, 0.05, 0.004), lambert("#f4efe1"), 0.195, 0.5, -0.02).rotation.z = -0.3;
  add(new THREE.CylinderGeometry(0.03, 0.028, 0.06, 7), lambert("#8a5a3a"), -0.33, 0.435, 0.0);
  add(box(0.01, 0.035, 0.02), lambert("#8a5a3a"), -0.3, 0.435, 0.0);
  add(box(0.07, 0.012, 0.07), iron, -0.33, 0.411, -0.27);
  add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.33, 0.447, -0.27).userData.glow = true;
  for (const [dx, dz] of [[-0.028, -0.028], [0.028, -0.028], [-0.028, 0.028], [0.028, 0.028]]) add(box(0.008, 0.07, 0.008), iron, -0.33 + dx, 0.447, -0.27 + dz);
  add(new THREE.ConeGeometry(0.05, 0.04, 4), iron, -0.33, 0.5, -0.27, Math.PI / 4);
  glows.push({ pos: new THREE.Vector3(-0.33, 0.45, -0.15), size: 0.32 });
  // A stool pulled up to the table.
  add(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 8), plank, -0.05, 0.22, 0.2);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    add(box(0.02, 0.21, 0.02), wood, -0.05 + Math.cos(a) * 0.05, 0.1, 0.2 + Math.sin(a) * 0.05);
  }
  // A slate on an easel, chalked with the tally.
  add(box(0.04, 0.6, 0.04), wood, 0.58, 0.3, -0.28).rotation.z = 0.15;
  for (const s of [-1, 1]) add(box(0.03, 0.5, 0.03), wood, 0.54 + s * 0.12, 0.24, -0.2, -0.3).rotation.x = -0.12;
  add(box(0.3, 0.24, 0.03), lambert("#2e3138"), 0.54, 0.44, -0.24, -0.3);
  add(box(0.33, 0.27, 0.02), timber, 0.54, 0.44, -0.255, -0.3);
  for (const dy of [-0.05, 0.0, 0.05]) add(box(0.18, 0.015, 0.032), lambert("#e8e4da"), 0.54, 0.44 + dy, -0.236, -0.3);
  add(box(0.36, 0.025, 0.04), timber, 0.54, 0.3, -0.23, -0.3);
  // A sawhorse with a plank across it, half sawn, the saw left in the cut and sawdust underneath.
  const sx = 0.42, sz = 0.26;
  add(box(0.4, 0.04, 0.05), wood, sx, 0.26, sz);
  for (const dx of [-0.15, 0.15]) for (const s of [-1, 1]) add(box(0.03, 0.28, 0.03), wood, sx + dx, 0.13, sz + s * 0.05).rotation.x = s * 0.3;
  add(box(0.14, 0.03, 0.62), plank, sx + 0.02, 0.295, sz + 0.06, 0.1);
  add(box(0.006, 0.07, 0.2), steel, sx + 0.04, 0.33, sz + 0.28, 0.1);
  add(box(0.025, 0.05, 0.07), wood, sx + 0.05, 0.36, sz + 0.41, 0.1);
  add(box(0.24, 0.006, 0.18), lambert("#e0cfa0"), sx + 0.04, 0.003, sz + 0.24);
  // Squared stone on a pallet, and a wheelbarrow with two more in it.
  add(box(0.4, 0.04, 0.32), boards, -0.56, 0.02, 0.36, 0.3);
  for (const [x, y, z] of [[-0.64, 0.11, 0.3], [-0.5, 0.11, 0.26], [-0.62, 0.11, 0.46], [-0.48, 0.11, 0.42], [-0.56, 0.25, 0.36]]) add(box(0.14, 0.14, 0.14), stone, x, y, z, 0.3 + x);
  const wx = -0.2, wz = 0.56;
  add(box(0.22, 0.08, 0.16), wood, wx, 0.15, wz).rotation.x = 0.1;
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.025, 8), iron, wx, 0.05, wz + 0.12).rotation.z = Math.PI / 2;
  for (const dx of [-0.08, 0.08]) {
    add(box(0.02, 0.02, 0.26), wood, wx + dx, 0.13, wz - 0.12).rotation.x = -0.25;
    add(box(0.02, 0.08, 0.02), wood, wx + dx, 0.04, wz - 0.04);
  }
  for (const [dx, dz] of [[-0.04, 0.02], [0.05, -0.02]]) add(box(0.09, 0.07, 0.09), stone, wx + dx, 0.22, wz + dz, dx * 8);
  // Planks strapped in a stack.
  for (let i = 0; i < 3; i++) add(box(0.5, 0.05, 0.12), i % 2 ? lambert("#c9a877") : boards, 0.3, 0.03 + i * 0.05, 0.62, 0.2 + 0.04 * i);
  for (const d of [-0.15, 0.15]) add(box(0.02, 0.17, 0.13), iron, 0.3 + d * Math.cos(0.24), 0.08, 0.62 - d * Math.sin(0.24), 0.24);
  // A toolbox with a mallet and a square in it, a bucket of nails, and a coil of rope.
  add(box(0.24, 0.08, 0.13), wood, -0.62, 0.04, -0.24, 0.2);
  add(box(0.025, 0.1, 0.025), timber, -0.62, 0.12, -0.24, 0.2);
  add(box(0.22, 0.02, 0.02), timber, -0.62, 0.17, -0.24, 0.2);
  add(box(0.06, 0.05, 0.05), lambert("#8a5a3a"), -0.7, 0.12, -0.22, 0.2);
  add(box(0.012, 0.12, 0.012), wood, -0.7, 0.1, -0.22);
  add(box(0.1, 0.012, 0.03), steel, -0.54, 0.105, -0.27, 0.2);
  add(box(0.012, 0.08, 0.03), steel, -0.5, 0.11, -0.28, 0.2);
  add(new THREE.CylinderGeometry(0.06, 0.05, 0.11, 7), steel, -0.36, 0.055, 0.14);
  add(new THREE.CylinderGeometry(0.052, 0.052, 0.01, 7), lambert("#5d6168"), -0.36, 0.105, 0.14);
  add(new THREE.TorusGeometry(0.07, 0.022, 4, 10), lambert("#c9a877"), 0.66, 0.025, 0.02).rotation.x = Math.PI / 2;
  g.userData.glows = glows;
  foldByLook(g);
};

/** The waygate. */
export const waygate: PlaceModel = (poi, kit) => {
  const { g, add, lambert } = kit;
  // The Harbor's waygate (waygate.ts), the crew's way out to the atlas and back: it hangs over a round
  // plinth of three shallow steps in the middle of its court, a ring of brass let into the top step.
  const stone = ["#6f747e", "#858a94", "#757a84"];
  [[1.0, 0.1], [0.86, 0.1], [0.72, 0.08]].reduce((y, [r, h], i) => {
    add(new THREE.CylinderGeometry(r - 0.025, r, h, 28), lambert(stone[i]), 0, y + h / 2, 0);
    return y + h;
  }, 0);
  add(new THREE.TorusGeometry(0.64, 0.02, 5, 40).rotateX(Math.PI / 2), lambert("#c79a3e"), 0, 0.282, 0);
  // (It is made as it stands now, with nothing played: asleep until a map is open through it. See setWaygateOpen.)
  const gate = makeWaygate({ light: true, lift: 0.28, open: kit.gateOpen, onBurst: () => kit.onWaygateBurst() });
  // A place's model is turned about the hex it is used from; the gate is turned back, to face the south, where the view opens from.
  gate.object.rotation.y = -yawOf((poi.facing ?? 0) + (PLACE.waygate?.turn ?? 0));
  g.add(gate.object);
  kit.gates.push(gate);
  // Pointing anywhere on it, however high, is pointing at the gate.
  g.userData.door = poi.pos;
};

/** The town chest. */
export const townchest: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The town chest, the crew's shared store, out in the open on a round dais of its own: a great sea chest
  // of oak with a barrelled lid, strapped with iron, its corners and feet turned brass, a rope becket at each
  // end and a brass lock with its hasp on the front. Its lid is shut until someone opens it (setChestOpen
  // swings it back), and then what is in it shows over the rim, gold and the blue of lodestones, and lights
  // the air over it. A lantern on a crook stands by it to find it by after dark, a coil of rope lies on the
  // dais, and the crew's pennant flies from a pole behind.
  const oak = new THREE.MeshLambertMaterial({ color: "#75502c" });
  const oakFlat = lambert("#6b4a2a");
  const darkOak = lambert("#4a3320");
  const iron = lambert("#33363c");
  const brass = new THREE.MeshLambertMaterial({ color: "#d0a445", emissive: "#2a1c05" });
  const rope = lambert("#c4a06a");
  // The dais: two rounds of stone, a ring of brass let into the upper one.
  add(new THREE.CylinderGeometry(0.84, 0.88, 0.1, 24), lambert("#8b8f96"), 0, 0.05, 0);
  add(new THREE.CylinderGeometry(0.7, 0.72, 0.07, 24), lambert("#7b7f87"), 0, 0.135, 0);
  add(new THREE.TorusGeometry(0.62, 0.016, 5, 36).rotateX(Math.PI / 2), brass, 0, 0.172, 0);
  // Four turned feet, and the body on them: planks with a moulding at foot and rim, its upright corners rounded.
  for (const x of [-0.37, 0.37]) for (const z of [-0.2, 0.2]) add(new THREE.SphereGeometry(0.065, 10, 8), brass, x, 0.215, z).scale.y = 0.85;
  add(box(0.82, 0.36, 0.57), oakFlat, 0, 0.45, 0);
  add(box(0.91, 0.36, 0.48), oakFlat, 0, 0.45, 0);
  for (const x of [-0.41, 0.41]) for (const z of [-0.24, 0.24]) add(new THREE.CylinderGeometry(0.045, 0.045, 0.36, 10), oak, x, 0.45, z);
  for (const y of [0.285, 0.615]) {
    add(box(0.84, 0.035, 0.6), darkOak, 0, y, 0);
    add(box(0.94, 0.035, 0.5), darkOak, 0, y, 0);
    for (const x of [-0.43, 0.43]) for (const z of [-0.26, 0.26]) add(new THREE.SphereGeometry(0.055, 10, 8), brass, x, y, z);
  }
  // Iron straps round it, studded; the lock, a round brass plate with its keyhole; a rope becket at each end.
  for (const x of [-0.24, 0.24]) {
    add(box(0.055, 0.33, 0.585), iron, x, 0.45, 0);
    for (const y of [0.36, 0.54]) add(new THREE.SphereGeometry(0.016, 6, 5), brass, x, y, 0.296);
  }
  add(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 14).rotateX(Math.PI / 2), brass, 0, 0.47, 0.293);
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.035, 8).rotateX(Math.PI / 2), iron, 0, 0.485, 0.296);
  add(box(0.016, 0.05, 0.035), iron, 0, 0.455, 0.296);
  for (const x of [-0.47, 0.47]) add(new THREE.TorusGeometry(0.075, 0.018, 6, 14), rope, x, 0.44, 0, Math.PI / 2).scale.y = 1.2;
  // What is in it, showing over the rim: a heap of coin, and stones cut and uncut. And the light of it, which
  // comes up as the lid goes back.
  add(box(0.74, 0.03, 0.42), lambert("#2a2118"), 0, 0.6, 0);
  for (let i = 0; i < 10; i++) add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 10), brass, -0.28 + (i % 5) * 0.085, 0.625 + Math.floor(i / 5) * 0.022 + (i % 2) * 0.008, -0.1 + ((i * 37) % 5) * 0.045, i).rotation.x = (i % 3) * 0.12;
  for (const [x, z, lit] of [[0.16, 0.02, true], [0.27, -0.1, false], [0.3, 0.1, true]] as const) {
    const gem = add(new THREE.OctahedronGeometry(0.06, 0), lit ? new THREE.MeshBasicMaterial({ color: "#7fd0ff" }) : lambert("#39445a"), x, 0.665, z, x * 9);
    gem.scale.y = 1.3;
    if (lit) gem.userData.glow = true;
  }
  const shine = new THREE.MeshBasicMaterial({ color: "#ffdf9a", transparent: true, opacity: 0.5 * kit.townLidAt, blending: THREE.AdditiveBlending, depthWrite: false });
  add(new THREE.SphereGeometry(0.34, 12, 8), shine, 0, 0.72, 0).userData.glow = true;
  g.userData.townShine = shine;
  // The lid, on its hinges along the back: a half barrel of oak on a flat rim, strapped like the body, a brass
  // edge along its front with the hasp hanging from it, and a grip on its crown. movePois swings it.
  const lid = new THREE.Group();
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    lid.add(m);
    return m;
  };
  const barrel = (r: number, long: number) => new THREE.CylinderGeometry(r, r, long, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2);
  part(box(0.94, 0.035, 0.6), darkOak, 0, 0.0175, 0.3);
  part(barrel(0.29, 0.9), oak, 0, 0.035, 0.3).scale.y = 0.72;
  for (const x of [-0.24, 0.24]) part(barrel(0.298, 0.055), iron, x, 0.035, 0.3).scale.y = 0.72;
  for (const x of [-0.452, 0.452]) part(barrel(0.3, 0.02), brass, x, 0.035, 0.3).scale.y = 0.72;
  part(box(0.9, 0.03, 0.03), brass, 0, 0.02, 0.6);
  part(box(0.07, 0.13, 0.022), brass, 0, -0.05, 0.612);
  part(new THREE.TorusGeometry(0.06, 0.014, 6, 12, Math.PI), brass, 0, 0.24, 0.3);
  lid.position.set(0, 0.632, -0.3);
  lid.rotation.x = kit.townLidThrown * kit.townLidAt;
  g.add(lid);
  g.userData.townLid = lid;
  // A coil of rope on the dais, and the lantern on its crook.
  for (let i = 0; i < 3; i++) add(new THREE.TorusGeometry(0.11 - i * 0.012, 0.02, 5, 12).rotateX(Math.PI / 2), rope, 0.56, 0.19 + i * 0.034, 0.34);
  add(box(0.035, 1.06, 0.035), iron, -0.64, 0.7, -0.26);
  add(box(0.2, 0.03, 0.03), iron, -0.56, 1.22, -0.26);
  add(box(0.012, 0.08, 0.012), iron, -0.47, 1.17, -0.26);
  add(box(0.085, 0.11, 0.085), new THREE.MeshBasicMaterial({ color: "#ffd98a" }), -0.47, 1.075, -0.26).userData.glow = true;
  add(new THREE.ConeGeometry(0.075, 0.055, 4), iron, -0.47, 1.155, -0.26, Math.PI / 4);
  add(box(0.1, 0.016, 0.1), iron, -0.47, 1.015, -0.26);
  g.userData.glows = [{ pos: new THREE.Vector3(-0.47, 1.08, -0.2), size: 0.9, light: "lamp" }] satisfies BuildingGlow[];
  // The pole behind, with the crew's pennant.
  add(box(0.05, 2.3, 0.05), darkOak, 0.62, 1.3, -0.4);
  add(new THREE.SphereGeometry(0.045, 8, 6), brass, 0.62, 2.47, -0.4);
  // The pennant: a sheet of cloth off the pole, a gold stripe along it. It hangs from the middle of the pole
  // so movePois can turn it about the pole to stream downwind, and waveFlag ripples it each frame.
  const cloth = new THREE.PlaneGeometry(0.5, 0.26, 12, 3);
  cloth.translate(-0.28, 0, 0);
  cloth.userData.rest = Float32Array.from(cloth.getAttribute("position").array);
  const flag = add(cloth, new THREE.MeshLambertMaterial({ map: pennantTexture(), side: THREE.DoubleSide, flatShading: true }), 0.62, 2.26, -0.4);
  g.userData.flag = flag;
};

/** The notice board. */
export const board: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // The notice board: a framed back of planks between two squared posts on stone feet, under a little
  // shingled roof to keep the rain off the paper. Notices are pinned all over it, no two alike or quite
  // straight: lines of writing, a wax seal and its ribbon, a wanted sheet, one hanging by a corner. A lantern
  // on a bracket lights it after dark, and a pail of rolled notices stands at its foot.
  const timber = lambert("#5a3d22");
  const dark = lambert("#46301c");
  const stone = lambert("#8b8f96");
  const iron = lambert("#2e2a28");
  const ink = lambert("#4a3a2a");
  const glows: BuildingGlow[] = [];
  // Posts on their feet, capped, braced to the ground behind.
  for (const x of [-0.46, 0.46]) {
    add(box(0.16, 0.07, 0.16), stone, x, 0.035, 0, x * 0.4);
    add(box(0.085, 1.0, 0.085), timber, x, 0.55, 0);
    add(box(0.12, 0.03, 0.12), dark, x, 1.06, 0);
    add(box(0.04, 0.42, 0.04), dark, x, 0.2, -0.13).rotation.x = -0.62;
  }
  // The back: five planks, no two the same brown, in a frame of darker timber.
  const planks = ["#8a6a44", "#7d5f3c", "#927048", "#80623f", "#8c6c46"];
  planks.forEach((tone, i) => add(box(0.158, 0.54, 0.035), lambert(tone), -0.316 + i * 0.158, 0.68, 0));
  for (const y of [0.4, 0.96]) add(box(0.9, 0.05, 0.06), dark, 0, y, 0.005);
  for (const x of [-0.42, 0.42]) add(box(0.05, 0.6, 0.06), dark, x, 0.68, 0.005);
  // The roof: two pitches of shingles in courses, and a ridge board.
  for (const side of [1, -1]) {
    for (let course = 0; course < 2; course++) {
      const out = 0.055 + course * 0.1;
      add(box(1.14 - course * 0.02, 0.022, 0.115), lambert(course ? "#7a4a36" : "#8a5540"), 0, 1.2 - out * 0.62, side * out * 0.86).rotation.x = side * 0.62;
    }
  }
  add(box(1.18, 0.035, 0.05), lambert("#5c3626"), 0, 1.215, 0);
  // The notices: where each is pinned, how big, how far askew, and its paper.
  const front = 0.022;
  const sheet = (x: number, y: number, w: number, h: number, turn: number, paper: string, pin = "#b0392b") => {
    const page = add(box(w, h, 0.006), lambert(paper), x, y, front);
    page.rotation.z = turn;
    // Its pin, at the top; a sheet askew hangs from it.
    add(box(0.022, 0.022, 0.014), lambert(pin), x - Math.sin(turn) * (h / 2 - 0.025), y + Math.cos(turn) * (h / 2 - 0.025), front + 0.008);
    return page;
  };
  /** Lines of writing down a sheet, each a little shorter or longer than the last. */
  const written = (x: number, y: number, w: number, lines: number, turn: number) => {
    for (let i = 0; i < lines; i++) {
      const dy = -i * 0.034;
      add(box(w * (0.72 + ((i * 7) % 3) * 0.1), 0.01, 0.004), ink, x - Math.sin(turn) * dy, y + Math.cos(turn) * dy, front + 0.005).rotation.z = turn;
    }
  };
  sheet(-0.24, 0.76, 0.2, 0.26, 0.05, "#efe4c4");
  written(-0.24, 0.8, 0.15, 4, 0.05);
  // A proclamation, with a red seal and the tail of its ribbon.
  sheet(0.02, 0.74, 0.18, 0.3, -0.03, "#f4efe1", "#c9a227");
  written(0.02, 0.83, 0.13, 3, -0.03);
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 7), lambert("#a02c22"), 0.03, 0.66, front + 0.008).rotation.x = Math.PI / 2;
  add(box(0.018, 0.07, 0.004), lambert("#8c2a22"), 0.045, 0.615, front + 0.006).rotation.z = -0.2;
  // Wanted: a face in a box, a price under it.
  sheet(0.26, 0.79, 0.17, 0.22, 0.08, "#e2d3a8");
  add(box(0.09, 0.09, 0.004), ink, 0.257, 0.815, front + 0.005).rotation.z = 0.08;
  add(box(0.11, 0.012, 0.004), ink, 0.268, 0.725, front + 0.005).rotation.z = 0.08;
  // Small ones crowded in under them, one come loose and hanging by a corner.
  sheet(-0.3, 0.52, 0.12, 0.13, -0.1, "#e8dcc0", "#3f6f8f");
  written(-0.3, 0.545, 0.08, 2, -0.1);
  sheet(0.27, 0.535, 0.13, 0.14, 0.42, "#efe4c4");
  sheet(-0.1, 0.5, 0.1, 0.1, 0.12, "#d9c99a", "#c9a227");
  // The lantern, hung from a bracket off the east post.
  add(box(0.2, 0.022, 0.022), iron, 0.6, 1.0, 0.02);
  add(box(0.012, 0.06, 0.012), iron, 0.68, 0.965, 0.02);
  add(box(0.06, 0.075, 0.06), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), 0.68, 0.895, 0.02).userData.glow = true;
  for (const [dx, dz] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) add(box(0.012, 0.09, 0.012), iron, 0.68 + dx, 0.895, 0.02 + dz);
  add(box(0.095, 0.016, 0.095), iron, 0.68, 0.845, 0.02);
  add(new THREE.ConeGeometry(0.07, 0.05, 4), iron, 0.68, 0.96, 0.02, Math.PI / 4);
  glows.push({ pos: new THREE.Vector3(0.68, 0.895, 0.12), size: 0.4 });
  // The pail of rolled notices, and one dropped beside it.
  add(new THREE.CylinderGeometry(0.075, 0.06, 0.13, 8), lambert("#6b4a2b"), -0.5, 0.065, 0.2);
  add(new THREE.CylinderGeometry(0.078, 0.078, 0.016, 8), iron, -0.5, 0.11, 0.2);
  for (const [dx, dz, lean, turn] of [[-0.02, 0.0, 0.2, 0.4], [0.025, 0.015, -0.16, 2.2], [0.0, -0.025, 0.1, 4.0]]) {
    const roll = add(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 6), lambert("#efe4c4"), -0.5 + dx, 0.2, 0.2 + dz, turn);
    roll.rotation.z = lean;
  }
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 6), lambert("#e2d3a8"), -0.3, 0.02, 0.26, 0.5).rotation.z = Math.PI / 2;
  // It stands beside the pub, turned the way the pub is turned (toward the middle of the island), not square
  // to the hex it is read from: a thing on one hex is set half a sixth round toward whoever uses it (PLACE),
  // and the board is turned that half sixth back.
  {
    const turned = new THREE.Group();
    turned.add(...g.children);
    turned.rotation.y = Math.PI / 6;
    g.add(turned);
    for (const glow of glows) glow.pos.applyAxisAngle(UP, Math.PI / 6);
  }
  g.userData.glows = glows;
};
