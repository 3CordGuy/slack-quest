// A torch's flame, made as the pub's great fire is (props.ts softFlame): soft
// teardrops of light, brightest at the root and fading to nothing at the tip,
// added over whatever is behind them. Each frame flickerFlame swells, thins
// and sways every tongue on its own restless rhythm, so no two lick together.
//
// The group is marked (userData.torchFlame), so whatever builds a figure or a
// prop with one in it can find it again and flicker it.

import * as THREE from "three";

/** The tongues: colour, radius, height, and where each stands, from the broad orange body in to the pale heart. */
const TONGUES: [string, number, number, number, number][] = [
  ["#ff5a14", 0.62, 2.7, 0, 0],
  ["#ff7a24", 0.5, 2.2, 0.16, 0.1],
  ["#ff9a32", 0.42, 1.9, -0.14, -0.06],
  ["#ffb84a", 0.32, 1.5, 0.04, 0.12],
  ["#ffe08a", 0.22, 1.05, 0, 0.04],
  ["#fff3c8", 0.13, 0.6, 0, 0.02],
];

/** One soft tongue, standing on its root. */
function tongue(color: string, radius: number, height: number): THREE.Mesh {
  const STEPS = 12;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const w = t < 0.28 ? Math.sin((t / 0.28) * (Math.PI / 2)) : Math.pow(1 - (t - 0.28) / 0.72, 1.4);
    profile.push(new THREE.Vector2(Math.max(1e-3, radius * w), height * t));
  }
  const geometry = new THREE.LatheGeometry(profile, 10);
  const base = new THREE.Color(color);
  const colors: number[] = [];
  const pos = geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / height;
    const k = Math.min(1, t / 0.12) * Math.pow(1 - t, 1.3);
    colors.push(base.r * k, base.g * k, base.b * k);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  // It gives light: it never casts a shadow, and an outline pass leaves it alone.
  mesh.castShadow = false;
  mesh.userData.selfLit = true;
  return mesh;
}

/** A flame `size` times the figure's units (about 2.7 tall at 1), its root at the group's origin. */
export function torchFlame(size = 1): THREE.Group {
  const group = new THREE.Group();
  group.userData.torchFlame = true;
  for (const [color, radius, height, x, z] of TONGUES) {
    const t = tongue(color, radius * size, height * size);
    t.position.set(x * size, 0, z * size);
    // Light, not a solid: it neither casts nor takes a shadow, wherever it is set.
    t.userData.glow = true;
    group.add(t);
  }
  return group;
}

const hash = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
/** Value noise along `t`, 0 to 1. */
const drift = (t: number, b: number) => {
  const i = Math.floor(t);
  const f = t - i;
  const e = f * f * (3 - 2 * f);
  return hash(i, b) * (1 - e) + hash(i + 1, b) * e;
};

/** Flicker every tongue of a flame: a smooth restless swell, a little thinning, and a lean as if in a draught. */
export function flickerFlame(flame: THREE.Object3D, clock: number): void {
  const seed = (flame.id % 97) * 1.37;
  flame.children.forEach((t, k) => {
    const s = seed + k * 1.7;
    const time = clock * 7 + s;
    t.scale.y = 1 + Math.sin(clock * 6.3 + s) * 0.16 + (drift(time, k) - 0.5) * 0.5;
    t.scale.x = t.scale.z = 1 + (drift(time * 0.8, k + 10) - 0.5) * 0.26;
    t.rotation.z = (drift(time * 0.5, k + 20) - 0.5) * 0.35;
    t.rotation.x = (drift(time * 0.45, k + 30) - 0.5) * 0.25;
  });
}

/** Every flame in this object, to flicker. */
export function flamesIn(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.torchFlame) out.push(o);
  });
  return out;
}
