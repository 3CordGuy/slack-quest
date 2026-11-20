// What a room is fitted with: the pub's game tables (Shoals, Cargo and Krakens, Turn the Tide, dice), its
// menu board and the salesman's mat, and the doormat and posts of a room's door.

import * as THREE from "three";
import { makeModelShip } from "../modelShip";
import type { PlaceModel } from "./kit";

/** Where the stools stand round a game table in the pub (its middle is at z = -0.3): four, as many as can play, clear of whoever stands at the front. */
const GAME_STOOLS = [[-0.54, 0.24], [0.54, 0.24], [-0.54, -0.84], [0.54, -0.84]];

/** The Shoals table. */
export const shoals: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // The Shoals table: a low square table under a sea-blue cloth, with a few markers on it and a stool for each of the four who can play.
  add(box(0.7, 0.36, 0.7), lambert("#6b4a2b"), 0, 0.18, -0.3, Math.PI / 4);
  add(box(0.82, 0.05, 0.82), lambert("#2f6f8c"), 0, 0.385, -0.3, Math.PI / 4);
  for (const [x, z] of GAME_STOOLS) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, z);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#7db6f2"), -0.16, 0.43, -0.28);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#d9b45a"), 0.14, 0.43, -0.4);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), lambert("#6b4a2b"), 0.04, 0.45, -0.16);
};

/** The traveling salesman's mat. */
export const trader: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // Where a customer stands to trade with a traveling salesman: a mat of wares laid out toward the corner.
  add(box(0.34, 0.03, 0.62), lambert("#7a3a5a"), 0.52, 0.015, 0);
  add(box(0.34, 0.01, 0.06), lambert("#e0b12e"), 0.52, 0.035, 0.26);
  add(box(0.1, 0.1, 0.1), lambert("#b98b5a"), 0.48, 0.08, -0.16, 0.5);
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), lambert("#3f7fb8"), 0.58, 0.1, 0.08);
  add(box(0.12, 0.03, 0.08), lambert("#e8dcc0"), 0.46, 0.05, 0.14, 0.3);
};

/** The menu board. */
export const counter: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // The menu board, on a post where customers stand to order.
  add(box(0.05, 0.7, 0.05), lambert("#5a3d22"), 0.55, 0.35, -0.1);
  add(box(0.5, 0.36, 0.04), lambert("#2c2a3a"), 0.55, 0.78, -0.1);
  for (let i = 0; i < 4; i++) add(box(0.34, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: "#e8dcc0" }), 0.55, 0.9 - i * 0.08, -0.075);
};

/** The Cargo and Krakens table. */
export const crew: PlaceModel = (_poi, kit) => {
  const { g, add, box, lambert } = kit;
  // Cargo and Krakens: a broad round table under a tarred-rope rim, a stool for each of the six who can play,
  // a model ship in full sail in the middle, and the dice cup beside it with a die spilled out.
  add(new THREE.CylinderGeometry(0.2, 0.26, 0.4, 8), lambert("#5a3d22"), 0, 0.2, -0.3);
  add(new THREE.CylinderGeometry(0.56, 0.56, 0.07, 10), lambert("#8a6a44"), 0, 0.43, -0.3);
  add(new THREE.TorusGeometry(0.55, 0.025, 4, 20), lambert("#3a2a1a"), 0, 0.465, -0.3).rotation.x = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    add(new THREE.CylinderGeometry(0.13, 0.11, 0.24, 6), lambert("#5a3d22"), Math.cos(a) * 0.74, 0.12, -0.3 + Math.sin(a) * 0.62);
  }
  const ship = makeModelShip(1.15);
  ship.position.set(-0.02, 0.465, -0.36);
  ship.rotation.y = 0.5;
  g.add(ship);
  add(new THREE.CylinderGeometry(0.07, 0.06, 0.13, 8), lambert("#3a2414"), 0.32, 0.53, -0.18);
  add(box(0.08, 0.08, 0.08), lambert("#f4efe1"), 0.2, 0.505, -0.06, 0.6);
};

/** The Turn the Tide table. */
export const tide: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // Turn the Tide: a round card table under an indigo cloth, a stool for each of the five who can play, the deck
  // with a card turned up beside it, and a candle to read them by.
  add(new THREE.CylinderGeometry(0.16, 0.22, 0.4, 8), lambert("#5a3d22"), 0, 0.2, -0.3);
  add(new THREE.CylinderGeometry(0.54, 0.54, 0.06, 10), lambert("#8a6a44"), 0, 0.43, -0.3);
  add(new THREE.CylinderGeometry(0.47, 0.47, 0.012, 10), lambert("#3a3570"), 0, 0.466, -0.3);
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 5;
    add(new THREE.CylinderGeometry(0.13, 0.11, 0.24, 6), lambert("#5a3d22"), Math.cos(a) * 0.74, 0.12, -0.3 + Math.sin(a) * 0.62);
  }
  add(box(0.13, 0.05, 0.18), lambert("#22304f"), -0.12, 0.497, -0.32, 0.2);
  add(box(0.13, 0.008, 0.18), lambert("#f4efe1"), 0.08, 0.476, -0.36, -0.5);
  add(box(0.13, 0.008, 0.18), lambert("#f4efe1"), 0.18, 0.48, -0.26, 0.3);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6), lambert("#f4efe1"), -0.02, 0.52, -0.12);
  add(box(0.03, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: "#ffb347" }), -0.02, 0.595, -0.12).userData.glow = true;
};

/** The dice table. */
export const dice: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // Dice table: a round top on a barrel, a stool for each of the four who can play, and a pair of dice. Set back so whoever stands here is seen to sit at it.
  add(new THREE.CylinderGeometry(0.18, 0.22, 0.4, 7), lambert("#6b4a2b"), 0, 0.2, -0.3);
  add(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 8), lambert("#a07a4c"), 0, 0.43, -0.3);
  for (const [x, z] of GAME_STOOLS) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, z);
  add(box(0.13, 0.13, 0.13), lambert("#f4efe1"), -0.12, 0.53, -0.25, 0.4);
  add(box(0.13, 0.13, 0.13), lambert("#b9433d"), 0.14, 0.53, -0.38, 1.1);
};

/** A room's door. */
export const door: PlaceModel = (_poi, kit) => {
  const { add, box, lambert } = kit;
  // A doormat in the gap, and a post either side of it.
  add(box(0.9, 0.04, 0.5), lambert("#8c3b2f"), 0, 0.02, 0.28);
  for (const x of [-0.8, 0.8]) add(box(0.14, 0.9, 0.14), lambert("#5a3d22"), x, 0.45, 0.28);
};
