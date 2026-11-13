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

const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface At {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

/** One part of a model: `geo` moved into place, its faces shaded by how they face the light. */
function part(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, at: At = {}, material: { opacity?: number } = {}): THREE.Mesh {
  if (at.scale) geo.scale(...at.scale);
  if (at.rot) {
    geo.rotateX(at.rot[0]);
    geo.rotateY(at.rot[1]);
    geo.rotateZ(at.rot[2]);
  }
  if (at.pos) geo.translate(...at.pos);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const base = new THREE.Color(color);
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const lit = Math.max(0, n.getX(i) * LIGHT.x + n.getY(i) * LIGHT.y + n.getZ(i) * LIGHT.z);
    const k = 0.5 + 0.55 * lit;
    colors[i * 3] = base.r * k;
    colors[i * 3 + 1] = base.g * k;
    colors[i * 3 + 2] = base.b * k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const opacity = material.opacity ?? 1;
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0: number, r1: number, h: number, sides = 8) => new THREE.CylinderGeometry(r0, r1, h, sides);
const ball = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const ring = (r: number, tube: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, tube, 5, 12, arc);
const cone = (r: number, h: number, sides = 6) => new THREE.ConeGeometry(r, h, sides);

const DARK = "#1b1830";

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

/** A crab, hung by a leg: a shell, eight legs, two claws, eyes on stalks. */
function crab(shell: string, under: string, dark: string, r: number, leg: number): THREE.Mesh[] {
  const out = [
    part(ball(r, 12, 8), shell, { scale: [1, 0.45, 0.8] }),
    part(ball(r * 0.95, 12, 8), under, { scale: [1, 0.3, 0.78], pos: [0, -r * 0.08, 0] }),
  ];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = (k - 1.5) * r * 0.42;
      out.push(part(cyl(0.012, 0.016, leg, 4), shell, { rot: [0, 0, s * (1.0 + k * 0.12)], pos: [s * (r + leg * 0.4), -leg * 0.15, z] }));
    }
    out.push(part(cyl(0.018, 0.02, r * 0.8, 5), shell, { rot: [0, 0, -s * 0.9], pos: [s * r * 0.9, r * 0.35, r * 0.5] }));
    out.push(part(ball(r * 0.32, 8, 6), shell, { scale: [1.3, 0.8, 0.8], pos: [s * r * 1.25, r * 0.7, r * 0.6] }));
    out.push(part(cone(r * 0.1, r * 0.35, 4), dark, { rot: [0, 0, -s * 0.4], pos: [s * r * 1.45, r * 0.95, r * 0.6] }));
    out.push(part(cyl(0.008, 0.008, r * 0.3, 4), dark, { pos: [s * r * 0.25, r * 0.5, r * 0.55] }));
    out.push(part(ball(0.018, 6, 4), DARK, { pos: [s * r * 0.25, r * 0.66, r * 0.55] }));
  }
  return out;
}

/**
 * The stand-in for a fish, hung by the mouth with the head up: a body, a belly, an eye, and fins that sweep
 * back toward the tail. The tail is a fan, narrow where it meets the body and widest at its end. Fins are flat
 * plates in the plane of the flank, so they read from the side.
 */
function fishParts(shape: string, [body, belly, accent]: string[]): THREE.Mesh[] {
  const slim = ["eel", "ribbon", "gar", "pike", "sword", "sail"].includes(shape);
  const flat = ["flat", "ray"].includes(shape);
  const deep = ["deep", "moon", "sunfish"].includes(shape);
  const h = slim ? 0.14 : deep ? 0.5 : flat ? 0.4 : 0.26;
  const w = flat ? 0.06 : slim ? 0.08 : 0.14;
  // A cone's point is +y; turned by `a` about z it points along (-sin a, cos a). Down and back is a little past half a turn.
  const fin = (r: number, len: number, a: number, x: number, y: number, z = 0) => part(cone(r, len, 4), accent, { scale: [1, 1, 0.22], rot: [0, 0, a], pos: [x, y, z] });
  return [
    part(ball(0.5, 14, 10), body, { scale: [h, 1, w] }),
    part(ball(0.5, 14, 10), belly, { scale: [h * 0.8, 0.85, w * 1.02], pos: [h * 0.12, 0, 0] }),
    // The tail: point into the body, wide end out.
    part(cone(h * 0.75, 0.26, 4), accent, { scale: [1, 1, 0.22], pos: [0, -0.6, 0] }),
    // Dorsal fin along the back, raked toward the tail.
    fin(0.08, 0.2, Math.PI - 0.7, -h * 0.5 - 0.04, 0.06),
    // A pectoral fin behind the gill on each flank, lying back along the body.
    fin(0.045, 0.13, Math.PI - 0.25, h * 0.08, 0.2, w * 0.5),
    fin(0.045, 0.13, Math.PI - 0.25, h * 0.08, 0.2, -w * 0.5),
    // The anal fin, under toward the tail.
    fin(0.04, 0.1, Math.PI + 0.6, h * 0.42, -0.25),
    part(ball(0.035, 6, 4), DARK, { pos: [h * 0.2, 0.36, w * 0.5] }),
  ];
}

/** Whether a catch has a model of its own (the rest share the fish stand-in). */
export const hasOwnModel = (species: string): boolean => !!BUILD[FISH[species]?.shape];

/** A catch's model, about a unit at its longest, centred, hung from its top. */
export function catchMesh(species: string): THREE.Group {
  const def = FISH[species];
  const g = new THREE.Group();
  const parts = BUILD[def.shape] ? BUILD[def.shape](def.palette) : fishParts(def.shape, def.palette);
  g.add(...parts);
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
  inner.scale.setScalar(size * (hasOwnModel(fish.species) ? 1.5 : 1));
  outer.add(inner);
  return outer;
}

// ---------- the sprites ----------

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
  if (!iconRenderer) {
    iconRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
    iconRenderer.setPixelRatio(1);
    iconRenderer.setSize(ICON_PX, ICON_PX, false);
    iconRenderer.setClearColor(0x000000, 0);
  }
  const scene = new THREE.Scene();
  const model = catchMesh(species);
  // Lie a fish along the picture, head to the right, as the character sprites face; hauls as they hang.
  if (!hasOwnModel(species)) model.rotation.z = -Math.PI / 2;
  // A crab is seen from above, shell up, as it would lie on the deck.
  if (["crab", "spider_crab"].includes(FISH[species].shape)) model.rotation.x = 1.15;
  scene.add(model);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 10);
  cam.position.copy(centre).add(new THREE.Vector3(0.55, 0.45, 1).normalize().multiplyScalar(radius * 4));
  cam.lookAt(centre);
  iconRenderer.render(scene, cam);

  // Pixel it up: copy, then outline every empty pixel that touches a filled one.
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(iconRenderer.domElement, 0, 0);
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
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  const url = canvas.toDataURL();
  icons.set(species, url);
  return url;
}
