// What stands on a map out in the atlas, and in the caverns: the chests and crates of a delve, a locked door
// across a tunnel, glowing mushrooms, the rope up out of a cave, and the mouth of the caverns (which the Harbor
// has too, grander). Most are models kept elsewhere (caveProps.ts, caveDressing.ts), stood here.

import * as THREE from "three";
import { HEX_DIRS, tileAt } from "@gantt-quest/world";
import type { BuildingGlow } from "../ambience";
import { MOUTH_FACE, SHAFT_HEIGHT, caveMouth, caveRope, glowcapCluster, mouthRope, mouthTorch } from "../caveDressing";
import { chestModel, crateModel } from "../caveProps";
import { grandCaveFront } from "../townDressing";
import type { PlaceModel } from "./kit";
import { hexToWorld } from "./placing";

/** Where a map is come into. Only under ground is anything drawn there: the rope out, in a shaft of daylight. */
export const landing: PlaceModel = (_poi, kit) => {
  const { g, add } = kit;
  if (kit.sceneKind === "caverns") {
    // The way back out of the caverns: a rope let down into the light from above (see caveRope).
    g.add(caveRope(SHAFT_HEIGHT));
    // And daylight falling in through it from above: a pale shaft, brightest at the floor and fading as it
    // rises, a pool of light where it lands, and real light round it, so the way out shows from across the dark.
    const sky = new THREE.Color("#d8ecff");
    const glowing = (geometry: THREE.BufferGeometry, k: (x: number, y: number, z: number) => number) => {
      const pos = geometry.getAttribute("position");
      const colors: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const v = k(pos.getX(i), pos.getY(i), pos.getZ(i));
        colors.push(sky.r * v, sky.g * v, sky.b * v);
      }
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const mesh = add(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0);
      mesh.userData.glow = true;
      return mesh;
    };
    const SHAFT = SHAFT_HEIGHT;
    const shaft = glowing(new THREE.CylinderGeometry(0.42, 0.78, SHAFT, 18, 6, true), (_x, y) => 0.32 * Math.pow(1 - (y + SHAFT / 2) / SHAFT, 1.6));
    shaft.position.y = SHAFT / 2;
    const pool = glowing(new THREE.CircleGeometry(0.95, 24).rotateX(-Math.PI / 2), (x, _y, z) => 0.55 * Math.pow(Math.max(0, 1 - Math.hypot(x, z) / 0.95), 1.3));
    pool.position.y = 0.02;
    const daylight = new THREE.PointLight("#d8e8ff", 2.6, 4.5, 1.4);
    daylight.position.set(0, 1.6, 0);
    g.add(daylight);
  }
  // (Only a cave has a way out marked on its map: see the world's ensureMouth.)
};

/** A chest. */
export const cache: PlaceModel = (poi, kit) => {
  const { g } = kit;
  // Every chest on a map says what it is (Poi.loot): an old chest, an iron-bound strongbox, or the hoard
  // (caveProps.ts). Its lid may be swinging open right now.
  if (poi.loot) {
    const model = chestModel(poi, kit.lidNow(poi));
    g.add(model);
    g.userData.lid = model.userData.lid;
    // Pointing anywhere on it means its hex, not the ground behind it.
    g.userData.door = poi.pos;
  }
};

/** A locked door across a tunnel. */
export const gate: PlaceModel = (poi, kit) => {
  const { g, box, lambert } = kit;
  // A heavy timber door across a cave tunnel, in a frame of old beams. Swung back against the rock once it is open.
  const frame = new THREE.Group();
  // Centred on its hex (places are drawn a little toward the camera), and turned to stand across the passage.
  frame.position.z = 0.28;
  if (poi.into) {
    const a = hexToWorld(poi.pos);
    const b = hexToWorld({ q: poi.pos.q + poi.into.q, r: poi.pos.r + poi.into.r });
    frame.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  }
  g.add(frame);
  const beam = lambert("#4a3420");
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    frame.add(mesh);
    return mesh;
  };
  for (const x of [-0.72, 0.72]) put(box(0.18, 1.25, 0.2), beam, x, 0.62, 0);
  put(box(1.66, 0.18, 0.24), beam, 0, 1.3, 0);
  // The door hangs from its left post.
  const hinge = new THREE.Group();
  hinge.position.set(-0.62, 0, 0);
  hinge.rotation.y = poi.cleared ? -1.45 : 0;
  frame.add(hinge);
  const plank = lambert(poi.cleared ? "#5b4632" : "#6b4a2b");
  const band = lambert("#30333a");
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(box(0.3, 1.1, 0.1), plank);
    m.position.set(0.16 + i * 0.31, 0.56, 0);
    hinge.add(m);
  }
  for (const y of [0.25, 0.85]) {
    const m = new THREE.Mesh(box(1.26, 0.07, 0.13), band);
    m.position.set(0.62, y, 0);
    hinge.add(m);
  }
  if (!poi.cleared) {
    // A brass lock plate that catches the torchlight.
    const lock = new THREE.Mesh(box(0.12, 0.16, 0.04), new THREE.MeshBasicMaterial({ color: "#d8b45a" }));
    lock.position.set(1.05, 0.56, 0.07);
    lock.userData.glow = true;
    hinge.add(lock);
  }
};

/** The mouth of the caverns. */
export const cave: PlaceModel = (_poi, kit) => {
  const { g, add, lambert } = kit;
  // The Haunted Caverns' mouth in the back wall: a heap of dark rock with a way in cut into it, framed in stone,
  // and a torch burning either side.
  if (kit.mapCode === "harbor") {
    // In the Harbor it is the grandest thing on the north shore (townDressing.ts): a crag over the wall, and
    // a doorway of dressed stone cut into its foot, with the same dark way in and the same rope out of it.
    const front = grandCaveFront(MOUTH_FACE);
    g.add(caveMouth(MOUTH_FACE), front.group, mouthRope(MOUTH_FACE));
    g.userData.glows = front.glows;
    return;
  }
  const rock = lambert("#3d4048");
  const pale = lambert("#565a63");
  const stone = lambert("#4a4d55");
  // The heap, set back behind the entrance so none of it stands in the way in.
  add(new THREE.DodecahedronGeometry(0.74, 0), rock, 0, 0.46, -1.0, 0.3);
  add(new THREE.ConeGeometry(0.44, 1.15, 5), pale, -0.76, 0.5, -0.42, 0.8);
  add(new THREE.ConeGeometry(0.38, 1.0, 5), rock, 0.76, 0.44, -0.46, 1.7);
  // The way in (caveDressing.ts): an arched tunnel going back into the rock, dark, darkest at its back.
  g.add(caveMouth(MOUTH_FACE));
  // Framed in the stone, so it is a hole in the rock from any side: rough jambs either side, a lintel over it.
  for (const side of [-1, 1]) {
    // Stood square to the face (turned, a long stone would swing across the way in).
    const jamb = add(new THREE.DodecahedronGeometry(0.24, 0), side < 0 ? stone : rock, side * 0.45, 0.3, 0.08, side * 0.12);
    jamb.scale.set(0.8, 1.55, 1.3);
    // And a stone at each foot, half sunk.
    add(new THREE.DodecahedronGeometry(0.1, 0), pale, side * 0.48, 0.03, 0.38, side * 1.3).scale.set(1.2, 0.7, 1);
  }
  const lintel = add(new THREE.DodecahedronGeometry(0.26, 0), stone, 0, 0.7, 0.06, 0.08);
  lintel.scale.set(1.85, 0.7, 1.3);
  // A torch burning on a stake either side, clear of the frame (real flames, flickered with the others), and a
  // halo and warm light round each at dusk.
  const glows: BuildingGlow[] = [];
  for (const x of [-0.6, 0.6]) {
    const torch = mouthTorch();
    torch.position.set(x, 0, MOUTH_FACE + 0.12);
    g.add(torch);
    glows.push({ pos: new THREE.Vector3(x, 0.66, MOUTH_FACE + 0.12), size: 0.3, light: "candle" });
  }
  g.userData.glows = glows;
  // And the rope out of the dark: the far end of the one that hangs down inside, tied round a boulder out front.
  g.add(mouthRope(MOUTH_FACE));
};

/** A crate. */
export const crate: PlaceModel = (poi, kit) => {
  const { g } = kit;
  // A crate in a delve (caveProps.ts): whole, knocked about, or splinters.
  const model = crateModel(poi);
  g.add(model);
  g.userData.body = model.userData.body;
  if (!poi.cleared) g.userData.door = poi.pos;
};

/** Glowing mushrooms. */
export const glowcap: PlaceModel = (poi, kit) => {
  const { g } = kit;
  // Glowing mushrooms (caveDressing.ts), grown at the foot of the rock: set over toward the wall, off the
  // middle of the hex where a hero stands to pick them.
  const cluster = glowcapCluster(poi.pos.q, poi.pos.r, !!poi.cleared);
  const map = kit.map;
  const at = hexToWorld(poi.pos);
  const toward = new THREE.Vector2();
  for (const dir of HEX_DIRS) {
    if (map && tileAt(map, { q: poi.pos.q + dir.q, r: poi.pos.r + dir.r })?.biome !== "rock") continue;
    const w = hexToWorld({ q: poi.pos.q + dir.q, r: poi.pos.r + dir.r });
    toward.add(new THREE.Vector2(w.x - at.x, w.z - at.z));
  }
  if (toward.lengthSq() > 0) toward.normalize().multiplyScalar(0.42);
  const spot = kit.inModel(poi, at.x + toward.x, at.z + toward.y);
  cluster.position.set(spot.x, 0, spot.y);
  g.add(cluster);
  // Their light (the ambience's): a little over the caps.
  g.userData.glowAt = new THREE.Vector3(spot.x, 0.45, spot.y);
  // Pointing anywhere on them means their hex.
  g.userData.door = poi.pos;
};
