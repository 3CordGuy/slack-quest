// A model ship in full sail, the centrepiece of the pub's Ship, Captain & Crew
// table. The room's table (WorldRenderer) and the first-person one
// (TableStage) both stand one in the middle: a dark hull with a gold rail, a
// mainmast and a foremast with cream sails, and a red pennant at the top.
//
// Built about its keel at the origin, bow toward -x, 0.42 long at scale 1.

import * as THREE from "three";

const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });

export function makeModelShip(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const hull = lambert("#4a2e1a");
  const rail = lambert("#c99a3a");
  const mast = lambert("#3a2414");
  const sail = lambert("#efe4c8");
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // A cradle, so it sits upright on the table.
  for (const x of [-0.1, 0.1]) add(new THREE.BoxGeometry(0.03, 0.03, 0.12), mast, x, 0.015, 0);
  // The hull: a deep box, a pointed bow, and a raised stern deck.
  add(new THREE.BoxGeometry(0.3, 0.08, 0.11), hull, 0.02, 0.07, 0);
  const bow = add(new THREE.ConeGeometry(0.056, 0.13, 4), hull, -0.19, 0.07, 0);
  bow.rotation.set(0, Math.PI / 4, Math.PI / 2);
  bow.scale.set(1, 1, 1.4);
  add(new THREE.BoxGeometry(0.08, 0.04, 0.11), hull, 0.13, 0.13, 0);
  add(new THREE.BoxGeometry(0.34, 0.012, 0.115), rail, 0.0, 0.112, 0);
  // Bowsprit.
  const sprit = add(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 5), mast, -0.25, 0.13, 0);
  sprit.rotation.z = Math.PI / 2 - 0.35;
  // Two masts with a square sail each, the main taller, and a pennant at its head.
  const rig = (x: number, h: number, w: number) => {
    add(new THREE.CylinderGeometry(0.008, 0.01, h, 5), mast, x, 0.11 + h / 2, 0);
    for (const [y, s] of [[0.11 + h * 0.62, 1], [0.11 + h * 0.32, 1.15]] as const) {
      const sh = h * 0.27;
      const sl = add(new THREE.BoxGeometry(0.012, sh, w * s), sail, x - 0.008, y, 0);
      sl.rotation.y = 0.12;
    }
  };
  rig(0.03, 0.3, 0.17);
  rig(-0.1, 0.22, 0.13);
  const flag = add(new THREE.BoxGeometry(0.06, 0.022, 0.004), lambert("#b9433d"), 0.06, 0.11 + 0.3 + 0.01, 0);
  flag.rotation.y = 0.2;
  g.scale.setScalar(scale);
  return g;
}
