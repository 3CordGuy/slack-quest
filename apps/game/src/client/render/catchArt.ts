// What a catch looks like: a small 3D model of each one, and a pixel sprite
// made from that same model, so the two always match.
//
// The hauls (and the crabs and the lobster) each have their own model here.
// Fish still share a stand-in body in their catalogue colours until the fish
// art; the sprite comes from whichever model a catch has.
//
// Models are built of a few primitives with their shading baked into vertex
// colours: no lights needed, so they look the same in the world, on the
// overlay layer (drawn after the finishing pass, where the scene's lights do
// not reach) and in the sprite renderer.

import * as THREE from "three";
import { FISH, type CaughtFish } from "@gantt-quest/world";
import { fishModel } from "./fishModels";
import { DARK, ball, box, cone, cyl, part, ring } from "./meshKit";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Each bespoke model, about a unit across at its longest, hung from the line at its top. */
const BUILD: Record<string, (p: string[]) => THREE.Mesh[]> = {
  kelp: ([body, light, dark]) => {
    const out = [part(ball(0.1), dark, { pos: [0, 0.38, 0], scale: [1.2, 0.8, 1] })];
    const fronds: [number, number, number, string][] = [[-0.16, 0.5, -0.3, body], [-0.05, 0.62, -0.08, light], [0.07, 0.55, 0.12, body], [0.17, 0.45, 0.32, light], [0, 0.4, 0.02, dark]];
    for (const [x, len, tilt, c] of fronds) out.push(part(box(0.07, len, 0.012), c, { rot: [0.25 * Math.sign(x || 1), 0, tilt], pos: [x, 0.36 - len / 2, (x * 3) % 0.1] }));
    for (let i = 0; i < 5; i++) out.push(part(ball(0.025, 6, 4), light, { pos: [-0.12 + i * 0.06, 0.1 - (i % 2) * 0.12, 0.03] }));
    return out;
  },
  boot: ([body, light, dark]) => [
    part(box(0.22, 0.36, 0.2), body, { pos: [-0.08, 0.14, 0] }),
    part(box(0.46, 0.13, 0.2), body, { pos: [0.04, -0.1, 0] }),
    part(cyl(0.1, 0.1, 0.2, 10), body, { rot: [Math.PI / 2, 0, 0], pos: [0.26, -0.1, 0] }),
    part(box(0.5, 0.04, 0.22), dark, { pos: [0.05, -0.18, 0] }),
    part(box(0.08, 0.05, 0.22), dark, { pos: [-0.14, -0.22, 0] }),
    part(box(0.25, 0.04, 0.22), light, { pos: [-0.08, 0.31, 0] }),
    ...[0.2, 0.12, 0.04].map((y) => part(box(0.02, 0.02, 0.21), light, { pos: [0.04, y, 0], rot: [0, 0, 0.5] })),
  ],
  driftwood: ([body, light, dark]) => [
    part(cyl(0.045, 0.06, 0.95, 7), body, { rot: [0, 0, 0.35] }),
    part(cyl(0.025, 0.035, 0.38, 6), body, { rot: [0, 0, -0.7], pos: [0.12, 0.12, 0] }),
    part(ball(0.06, 6, 4), light, { pos: [-0.16, 0.44, 0] }),
    part(ball(0.035, 6, 4), dark, { pos: [0.03, -0.08, 0.05] }),
    part(ball(0.03, 6, 4), dark, { pos: [-0.08, 0.2, 0.05] }),
  ],
  skeleton: ([body, light, dark]) => {
    const out = [
      part(cone(0.09, 0.2, 6), body, { pos: [0, 0.38, 0], rot: [0, 0, 0], scale: [1, 1, 0.45] }),
      part(ball(0.025, 6, 4), DARK, { pos: [0.03, 0.36, 0.035] }),
      part(cyl(0.012, 0.012, 0.6, 5), light, { pos: [0, -0.02, 0] }),
      part(cone(0.1, 0.14, 4), body, { rot: [Math.PI, 0, 0], pos: [0, -0.36, 0], scale: [1, 1, 0.2] }),
    ];
    for (let i = 0; i < 6; i++) {
      const y = 0.2 - i * 0.07;
      const len = 0.16 - i * 0.015;
      for (const s of [-1, 1]) out.push(part(box(0.012, len, 0.012), i % 2 ? body : light, { rot: [0, 0, s * 1.2], pos: [s * len * 0.42, y - 0.03, 0] }));
    }
    out.push(part(ball(0.02, 5, 4), dark, { pos: [0, 0.26, 0] }));
    return out;
  },
  whalebone: ([body, light, dark]) => [
    ...[-0.08, 0, 0.08].map((z, i) => part(ring(0.42, 0.035, 1.7), i === 1 ? light : body, { rot: [0, 0, 0.7], pos: [0.05 * i - 0.05, -0.3, z] })),
    part(cyl(0.07, 0.07, 0.09, 8), dark, { pos: [-0.05, 0.02, 0], rot: [0, 0, 0.3] }),
    part(cyl(0.075, 0.075, 0.02, 8), body, { pos: [-0.05, 0.05, 0], rot: [0, 0, 0.3] }),
  ],
  kettle: ([body, copper, dark]) => [
    part(ball(0.22, 12, 8), body, { scale: [1, 0.78, 1], pos: [0, -0.05, 0] }),
    part(cyl(0.16, 0.18, 0.04, 12), dark, { pos: [0, -0.22, 0] }),
    part(cyl(0.09, 0.11, 0.05, 10), copper, { pos: [0, 0.13, 0] }),
    part(ball(0.03, 6, 4), dark, { pos: [0, 0.18, 0] }),
    part(cyl(0.025, 0.04, 0.24, 6), copper, { rot: [0, 0, -0.9], pos: [0.27, 0.0, 0] }),
    part(ring(0.17, 0.015, Math.PI), dark, { pos: [0, 0.12, 0] }),
    part(ball(0.05, 6, 4), copper, { pos: [-0.12, 0.05, 0.16], scale: [1, 0.6, 0.4] }),
    part(ball(0.04, 6, 4), copper, { pos: [0.08, -0.12, 0.17], scale: [1, 0.6, 0.4] }),
  ],
  chain: ([body, light, dark]) => {
    const out: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      out.push(part(ring(0.075, 0.022), i % 2 ? body : dark, { scale: [1, 1.5, 1], rot: [0, (i % 2) * (Math.PI / 2), 0], pos: [0, 0.36 - i * 0.18, 0] }));
      if (i % 2 === 0) out.push(part(cone(0.035, 0.05, 5), light, { pos: [0.08, 0.32 - i * 0.18, 0.03], rot: [0, 0, -0.5] }));
    }
    return out;
  },
  bottle: ([glass, light, paper]) => [
    part(cyl(0.09, 0.09, 0.3, 10), glass, { pos: [0, -0.12, 0] }, { opacity: 0.6 }),
    part(ball(0.09, 10, 6), glass, { pos: [0, 0.03, 0], scale: [1, 0.6, 1] }, { opacity: 0.6 }),
    part(cyl(0.035, 0.04, 0.12, 8), glass, { pos: [0, 0.12, 0] }, { opacity: 0.6 }),
    part(cyl(0.032, 0.03, 0.06, 8), "#8a6040", { pos: [0, 0.2, 0] }),
    part(cyl(0.035, 0.035, 0.2, 8), paper, { pos: [0, -0.1, 0], rot: [0, 0, 0.1] }),
    part(box(0.02, 0.18, 0.004), "#a83a2a", { pos: [0.036, -0.1, 0.01], rot: [0, 0, 0.1] }),
    part(box(0.01, 0.2, 0.004), light, { pos: [-0.06, -0.12, 0.08] }),
  ],
  tin: ([body, light, red]) => [
    part(box(0.42, 0.12, 0.26), body, { pos: [0, -0.04, 0] }),
    part(box(0.44, 0.03, 0.28), light, { pos: [0, 0.035, 0] }),
    part(box(0.06, 0.03, 0.02), DARK, { pos: [0, 0, 0.14] }),
    part(ball(0.04, 8, 6), red, { pos: [0.08, 0.09, 0], scale: [1, 0.8, 1] }),
    part(ball(0.035, 8, 6), "#f4f1e8", { pos: [0.08, 0.06, 0], scale: [1, 0.6, 1] }),
    part(ring(0.035, 0.006, Math.PI * 1.5), light, { pos: [-0.1, 0.07, 0.05] }),
  ],
  crate: ([body, light, dark]) => {
    const out = [part(box(0.42, 0.42, 0.42), body)];
    for (const y of [-0.13, 0.0, 0.13]) out.push(part(box(0.43, 0.012, 0.43), dark, { pos: [0, y + 0.065, 0] }));
    for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) out.push(part(box(0.05, 0.44, 0.05), light, { pos: [x, 0, z] }));
    out.push(part(box(0.16, 0.08, 0.005), dark, { pos: [0, 0.04, 0.214] }));
    out.push(part(box(0.06, 0.06, 0.005), dark, { pos: [0, -0.06, 0.214], rot: [0, 0, Math.PI / 4] }));
    return out;
  },
  oyster: ([shell, nacre, pearl]) => [
    part(ball(0.2, 12, 6), shell, { scale: [1, 0.32, 0.85], pos: [0, -0.04, 0] }),
    part(ball(0.18, 12, 6), nacre, { scale: [1, 0.2, 0.8], pos: [0, -0.01, 0] }),
    part(ball(0.2, 12, 6), shell, { scale: [1, 0.3, 0.85], rot: [0, 0, -0.45], pos: [-0.03, 0.09, 0] }),
    part(ball(0.045, 10, 8), pearl, { pos: [0.06, 0.02, 0.02] }),
    ...[-0.1, -0.03, 0.04, 0.11].map((x) => part(box(0.012, 0.012, 0.32), DARK, { pos: [x, -0.1, 0] }, { opacity: 0.35 })),
  ],
  lockbox: ([wood, iron, gold]) => [
    part(box(0.38, 0.24, 0.26), wood),
    part(box(0.4, 0.07, 0.28), wood, { pos: [0, 0.14, 0] }),
    ...[-0.13, 0.13].map((x) => part(box(0.04, 0.33, 0.28), iron, { pos: [x, 0.03, 0] })),
    part(box(0.4, 0.03, 0.28), iron, { pos: [0, 0.1, 0] }),
    part(box(0.08, 0.1, 0.02), gold, { pos: [0, 0.06, 0.14] }),
    part(box(0.015, 0.035, 0.01), DARK, { pos: [0, 0.05, 0.152] }),
  ],
  bell: ([green, gold, dark]) => {
    const profile = [
      [0.0, 0.24], [0.11, 0.24], [0.15, 0.2], [0.16, 0.08], [0.18, -0.04], [0.23, -0.14], [0.31, -0.22], [0.33, -0.27], [0.27, -0.27], [0.0, -0.24],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    return [
      part(new THREE.LatheGeometry(profile, 16), green),
      part(cyl(0.3, 0.315, 0.04, 16), gold, { pos: [0, -0.23, 0] }),
      part(cyl(0.155, 0.16, 0.025, 16), gold, { pos: [0, 0.05, 0] }),
      part(ring(0.06, 0.018), dark, { pos: [0, 0.31, 0] }),
      part(ball(0.05, 8, 6), dark, { pos: [0, -0.3, 0] }),
    ];
  },
  comb: ([body, light, blue]) => {
    // A straight back with rounded ends, a row of teeth under it, and pearls set along the top.
    const out = [
      part(box(0.5, 0.08, 0.035), body, { pos: [0, 0.1, 0] }),
      part(cyl(0.04, 0.04, 0.035, 10), body, { rot: [Math.PI / 2, 0, 0], pos: [-0.25, 0.1, 0] }),
      part(cyl(0.04, 0.04, 0.035, 10), body, { rot: [Math.PI / 2, 0, 0], pos: [0.25, 0.1, 0] }),
      part(box(0.5, 0.015, 0.037), light, { pos: [0, 0.135, 0] }),
    ];
    for (let i = 0; i < 13; i++) out.push(part(box(0.018, 0.17, 0.02), i % 2 ? body : light, { pos: [-0.24 + i * 0.04, -0.02, 0] }));
    for (const [x, r] of [[0, 0.03], [-0.13, 0.02], [0.13, 0.02]] as const) out.push(part(ball(r, 8, 6), blue, { pos: [x, 0.12, 0.025] }));
    return out;
  },
  crab: ([shell, under, dark]) => crab(shell, under, dark, 0.2, 0.2),
  spider_crab: ([shell, under, dark]) => crab(shell, under, dark, 0.12, 0.42),
  lobster: ([shell, light, dark]) => {
    const out = [
      part(cyl(0.07, 0.08, 0.26, 8), shell, { pos: [0, 0.12, 0] }),
      part(cone(0.07, 0.1, 8), shell, { pos: [0, 0.3, 0] }),
    ];
    for (let i = 0; i < 5; i++) out.push(part(box(0.13 - i * 0.012, 0.06, 0.09 - i * 0.008), i % 2 ? shell : light, { pos: [0, -0.04 - i * 0.065, 0] }));
    out.push(part(cone(0.1, 0.1, 5), shell, { rot: [Math.PI, 0, 0], pos: [0, -0.39, 0], scale: [1, 1, 0.25] }));
    for (const s of [-1, 1]) {
      out.push(part(cyl(0.018, 0.022, 0.18, 5), shell, { rot: [0, 0, s * 0.6], pos: [s * 0.1, 0.3, 0] }));
      out.push(part(ball(0.07, 8, 6), shell, { scale: [0.8, 1.4, 0.6], pos: [s * 0.17, 0.43, 0] }));
      out.push(part(cone(0.03, 0.09, 5), dark, { pos: [s * 0.19, 0.55, 0] }));
      out.push(part(cyl(0.004, 0.004, 0.35, 3), dark, { rot: [0, 0, -s * 0.35], pos: [s * 0.06, 0.48, 0.03] }));
      for (let k = 0; k < 3; k++) out.push(part(cyl(0.008, 0.008, 0.12, 4), dark, { rot: [0, 0, s * 1.1], pos: [s * 0.09, 0.16 - k * 0.06, 0] }));
    }
    return out;
  },
};

/** A rod of radius `r` from point a to point b. */
function between(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const geo = cyl(r1, r0, d.length(), 5);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

/**
 * A crab: a shell (x across, z front to back), four legs a side that each start on the shell's rim and bend at the
 * knee down to the foot, two claws reaching forward from the front of the shell, and eyes on stalks.
 */
function crab(shell: string, under: string, dark: string, r: number, leg: number): THREE.Mesh[] {
  const rz = r * 0.8;
  const ry = r * 0.45;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // A point on the shell's rim at depth z (just inside it, so the leg is seated).
  const rimX = (z: number) => r * 0.92 * Math.sqrt(Math.max(0, 1 - (z / rz) ** 2));
  const out = [
    part(ball(r, 12, 8), shell, { scale: [1, 0.45, 0.8] }),
    part(ball(r * 0.95, 12, 8), under, { scale: [1, 0.3, 0.78], pos: [0, -r * 0.08, 0] }),
  ];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = (0.25 - k * 0.3) * rz;
      const hip = V(s * rimX(z), -ry * 0.15, z);
      // Out and a little up to the knee, then out and down to the foot, the back legs swept back.
      const sweep = (k - 1) * 0.12;
      const knee = hip.clone().add(V(s * leg * 0.5, leg * 0.18, sweep * leg * 0.5));
      const foot = knee.clone().add(V(s * leg * 0.35, -leg * 0.55, sweep * leg * 0.6));
      out.push(part(between(hip, knee, 0.016, 0.013), shell));
      out.push(part(between(knee, foot, 0.013, 0.006), shell));
    }
    // The claw arm from the front of the shell, and the claw at its end.
    const shoulder = V(s * r * 0.45, -ry * 0.1, rz * 0.85);
    const elbow = shoulder.clone().add(V(s * r * 0.45, ry * 0.3, r * 0.25));
    out.push(part(between(shoulder, elbow, 0.02, 0.018), shell));
    out.push(part(ball(r * 0.3, 8, 6), shell, { scale: [1.2, 0.8, 1.4], pos: [elbow.x, elbow.y, elbow.z + r * 0.25] }));
    out.push(part(cone(r * 0.09, r * 0.3, 4), dark, { rot: [Math.PI / 2, 0, 0], pos: [elbow.x + s * r * 0.08, elbow.y, elbow.z + r * 0.6] }));
    out.push(part(cone(r * 0.07, r * 0.24, 4), dark, { rot: [Math.PI / 2, 0, 0], pos: [elbow.x - s * r * 0.08, elbow.y, elbow.z + r * 0.56] }));
    // Eyes on stalks, at the front edge of the shell.
    const base = V(s * r * 0.22, ry * 0.6, rz * 0.8);
    const tip = base.clone().add(V(0, r * 0.25, r * 0.05));
    out.push(part(between(base, tip, 0.008), dark));
    out.push(part(ball(0.02, 6, 4), DARK, { pos: [tip.x, tip.y, tip.z] }));
  }
  return out;
}

/** Whether a catch has a model of its own (the rest share the fish stand-in). */
export const hasOwnModel = (species: string): boolean => !!BUILD[FISH[species]?.shape];

/**
 * A catch's model, about a unit at its longest. Posed to `hang` from the line (a fish head-up, by its mouth; a
 * haul as it was built, from its top) or side-on (a fish head to the right, as the sprites face).
 */
export function catchMesh(species: string, pose: "hang" | "side" = "hang"): THREE.Group {
  const def = FISH[species];
  const g = new THREE.Group();
  const inner = new THREE.Group();
  g.add(inner);
  if (BUILD[def.shape]) inner.add(...BUILD[def.shape](def.palette));
  else {
    inner.add(...fishModel(def));
    if (pose === "hang") inner.rotation.z = Math.PI / 2;
  }
  return g;
}

/**
 * A landed catch to hold up in front of the eye: its model inside a group
 * that can be posed, sized so a sprat is small in the hand and a shark fills
 * the view.
 */
export function catchModel(fish: Pick<CaughtFish, "species" | "mm">): THREE.Group {
  const outer = new THREE.Group();
  const inner = catchMesh(fish.species);
  const size = 0.07 + 0.25 * clamp01((Math.log10(Math.max(60, fish.mm)) - 2) / 1.6);
  // Hauls are drawn a little bigger than their length says: a boot's 30 cm is all boot.
  inner.scale.setScalar(size * (hasOwnModel(fish.species) ? 1.5 : 1.1));
  outer.add(inner);
  return outer;
}

// ---------- the sprites ----------

/** Which way a picture of a catch looks at it: the sprite's angle (a fish side-on, a haul from three-quarters), or straight side-on or from three-quarters. */
export type CatchView = "sprite" | "side" | "three";

/** Draw a catch's model, `px` square, framed to fit, onto the shared offscreen renderer's canvas, and return it. */
function renderCatch(species: string, px: number, view: CatchView): HTMLCanvasElement {
  if (!iconRenderer) {
    iconRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
    iconRenderer.setPixelRatio(1);
    iconRenderer.setClearColor(0x000000, 0);
  }
  iconRenderer.setSize(px, px, false);
  const scene = new THREE.Scene();
  const model = catchMesh(species, "side");
  // A crab is seen from above, shell up, as it would lie on the deck.
  if (["crab", "spider_crab"].includes(FISH[species].shape)) model.rotation.x = 1.15;
  scene.add(model);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 10);
  const fish = !hasOwnModel(species);
  const dir = view === "side" ? new THREE.Vector3(0, 0.08, 1) : view === "three" || !fish ? new THREE.Vector3(0.55, 0.45, 1) : new THREE.Vector3(0.12, 0.3, 1);
  cam.position.copy(centre).add(dir.normalize().multiplyScalar(radius * 4));
  cam.lookAt(centre);
  iconRenderer.render(scene, cam);
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  return iconRenderer.domElement;
}

/** A larger, plain picture of a catch's model (no pixelling or outline), for the admin gallery. */
export function catchPicture(species: string, px: number, view: CatchView): string {
  return renderCatch(species, px, view).toDataURL();
}

/** The sprite's size in pixels, before it is scaled up (pixelated) wherever it is shown. */
export const ICON_PX = 40;
const OUTLINE = [27, 24, 48];
const icons = new Map<string, string>();
let iconRenderer: THREE.WebGLRenderer | null = null;

/**
 * A catch's pixel sprite, rendered from its own model at a three-quarter
 * angle, small and unsmoothed, with a dark outline like the characters'.
 * A data URL, made once per kind.
 */
export function catchIcon(species: string): string {
  const hit = icons.get(species);
  if (hit) return hit;
  const shot = renderCatch(species, ICON_PX, "sprite");

  // Pixel it up: copy, then outline every empty pixel that touches a filled one.
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(shot, 0, 0);
  const img = ctx.getImageData(0, 0, ICON_PX, ICON_PX);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < ICON_PX && y < ICON_PX && img.data[(y * ICON_PX + x) * 4 + 3] > 96;
  const out = ctx.createImageData(ICON_PX, ICON_PX);
  for (let y = 0; y < ICON_PX; y++) {
    for (let x = 0; x < ICON_PX; x++) {
      const i = (y * ICON_PX + x) * 4;
      if (solid(x, y)) {
        out.data[i] = img.data[i];
        out.data[i + 1] = img.data[i + 1];
        out.data[i + 2] = img.data[i + 2];
        out.data[i + 3] = 255;
      } else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) {
        out.data[i] = OUTLINE[0];
        out.data[i + 1] = OUTLINE[1];
        out.data[i + 2] = OUTLINE[2];
        out.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  const url = canvas.toDataURL();
  icons.set(species, url);
  return url;
}


/** World units to a metre, indoors: a hero is a little under a unit tall. */
const WALL_M = 0.42;

/**
 * A catch mounted on a board for a wall, at its real size (up to what a wall will take): the board, the fish
 * side-on on it, and a brass plate. Built facing out of the wall (+z), its middle at the origin, like the wall pieces.
 */
export function fishMount(fish: { species: string; mm: number }): THREE.Group {
  const g = new THREE.Group();
  const len = Math.max(0.24, Math.min(1.3, (fish.mm / 1000) * WALL_M));
  const model = catchMesh(fish.species, "side");
  model.scale.setScalar(len);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const w = size.x + 0.12;
  const h = Math.max(0.2, size.y + 0.1);
  g.add(part(box(w, h, 0.04), "#4a3322", { pos: [0, 0, 0.02] }));
  g.add(part(box(w + 0.03, 0.025, 0.045), "#6b4a2a", { pos: [0, h / 2, 0.022] }));
  g.add(part(box(w + 0.03, 0.025, 0.045), "#6b4a2a", { pos: [0, -h / 2, 0.022] }));
  g.add(part(box(Math.min(0.14, w * 0.4), 0.035, 0.01), "#c8a040", { pos: [0, -h / 2 + 0.04, 0.045] }));
  model.position.set(-centre.x, -centre.y + 0.01, 0.05 + size.z / 2 - centre.z);
  g.add(model);
  return g;
}
