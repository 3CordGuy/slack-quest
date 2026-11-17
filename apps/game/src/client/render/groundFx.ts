// What lies on the ground in a fight, drawn with some life in it (TacticsLayer
// lays the sheets; this makes them look like what they are):
//
// - Oil and slime are goo: a gloss shader with a slow-rolling surface, a
//   bright moving highlight and a sheen at a glancing angle. Oil wears a
//   thin-film rainbow over its black; slime is pale and wobbly, with bubbles
//   rising through it.
// - Burning ground burns: a glowing bed of embers on every hex, flames
//   licking up off it (the torch's flame, torchFlame.ts, a few to a hex),
//   and sparks drifting up out of it.
//
// Everything here is animated by `tickGround`, called once a frame.

import * as THREE from "three";
import { type HexPos } from "@gantt-quest/core";
import { flickerFlame, torchFlame } from "./torchFlame";

const GOO_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GOO_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uIrid;
  uniform float uBubbles;
  uniform float uRoll;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // The goo's surface: two layers of slow noise drifting different ways, so it rolls and never repeats.
  float surface(vec2 p) {
    float t = uTime * uRoll;
    return noise(p * 1.3 + vec2(t * 0.22, t * 0.15)) * 0.68 + noise(p * 2.9 - vec2(t * 0.3, -t * 0.24)) * 0.32;
  }

  void main() {
    vec2 p = vWorld.xz;
    float e = 0.03;
    float hx = surface(p + vec2(e, 0.0)) - surface(p - vec2(e, 0.0));
    float hz = surface(p + vec2(0.0, e)) - surface(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx * 3.2, 1.0, -hz * 3.2));
    vec3 v = normalize(cameraPosition - vWorld);
    // A light from up and over the shoulder, whatever lights the scene: goo always catches a gleam.
    vec3 l = normalize(vec3(0.35, 1.0, 0.45));
    float spec = pow(max(dot(n, normalize(l + v)), 0.0), 40.0);
    float broad = pow(max(dot(n, normalize(l + v)), 0.0), 8.0);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
    float h = surface(p);
    vec3 base = uColor * (0.78 + 0.3 * h);
    // Oil: a thin film over black that runs through the rainbow as the surface tilts.
    float film = h * 6.2831 + dot(n.xz, vec2(5.0, 3.0)) + uTime * 0.2;
    vec3 rainbow = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + film);
    // Only where the surface swells highest, so it reads as black oil with a sheen on it, not a rainbow.
    base = mix(base, base + rainbow * 0.22, uIrid * smoothstep(0.55, 0.85, h));
    // Slime: bubbles rising slowly through it, each a pale ring with a bright fleck.
    float bubbles = 0.0;
    if (uBubbles > 0.0) {
      vec2 cell = p * 1.9 + vec2(0.0, uTime * 0.05);
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5 - (vec2(hash(id), hash(id + 7.3)) - 0.5) * 0.5;
      float r = 0.1 + 0.14 * hash(id + 3.1);
      float d = length(f);
      float pop = step(0.62, hash(id + floor(uTime * 0.25 + hash(id) * 4.0)));
      bubbles = pop * (smoothstep(r, r - 0.03, d) - smoothstep(r - 0.04, r - 0.08, d) * 0.7 + smoothstep(0.05, 0.0, length(f - vec2(-r * 0.35, r * 0.35))) * 0.8);
    }
    vec3 col = base + vec3(1.0) * (spec * 0.85 + broad * 0.14) + rim * mix(uColor, vec3(1.0), 0.5) * 0.3 + bubbles * uBubbles * 0.5;
    gl_FragColor = vec4(col, clamp(uOpacity + spec * 0.35 + rim * 0.15, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A gloss material for a sheet of goo: oil (black, a rainbow film) or slime (pale, bubbling). */
export function gooMaterial(kind: "oil" | "slime", color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(kind === "oil" ? "#1f1b18" : "#9be58a") },
      uOpacity: { value: kind === "oil" ? 0.82 : 0.68 },
      uIrid: { value: kind === "oil" ? 1 : 0 },
      uBubbles: { value: kind === "slime" ? 1 : 0 },
      // Slime wobbles faster than oil rolls.
      uRoll: { value: kind === "slime" ? 1.6 : 0.7 },
    },
    vertexShader: GOO_VERTEX,
    fragmentShader: GOO_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A soft round glow lying on the ground, brightest in the middle: the embers under a fire. */
function emberBed(radius: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(radius, 18);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute("position");
  const colors: number[] = [];
  const hot = new THREE.Color("#ff6a1c");
  for (let i = 0; i < pos.count; i++) {
    const k = Math.pow(1 - Math.min(1, Math.hypot(pos.getX(i), pos.getZ(i)) / radius), 1.4);
    colors.push(hot.r * k, hot.g * k, hot.b * k);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  mesh.userData.selfLit = true;
  return mesh;
}

/** Fire on the ground: per hex a glowing bed of embers, three flames licking up off it, and sparks rising. */
export function fireField(hexes: HexPos[], at: (p: HexPos) => { x: number; y: number; z: number }): { group: THREE.Group; flames: THREE.Object3D[]; sparks: THREE.Points } {
  const group = new THREE.Group();
  const flames: THREE.Object3D[] = [];
  const sparkAt: number[] = [];
  const sparkSeed: number[] = [];
  hexes.forEach((p, i) => {
    const { x, y, z } = at(p);
    const bed = emberBed(0.78);
    bed.position.set(x, y + 0.035, z);
    group.add(bed);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + i * 1.3;
      const d = k === 0 ? 0.05 : 0.3;
      const flame = torchFlame(k === 0 ? 0.42 : 0.3);
      flame.position.set(x + Math.cos(a) * d, y + 0.04, z + Math.sin(a) * d);
      group.add(flame);
      flames.push(flame);
    }
    for (let k = 0; k < 6; k++) {
      sparkAt.push(x + (Math.sin(i * 12.9 + k * 4.1) * 0.5), y, z + (Math.cos(i * 7.3 + k * 2.7) * 0.5));
      sparkSeed.push((i * 0.37 + k * 0.173) % 1);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(sparkAt, 3));
  geometry.userData = { base: sparkAt.slice(), seed: sparkSeed };
  const sparks = new THREE.Points(geometry, new THREE.PointsMaterial({ color: "#ffb84a", size: 0.07, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  sparks.userData.selfLit = true;
  group.add(sparks);
  return { group, flames, sparks };
}

/** One frame of life for the ground: the goo rolls, the flames flicker, the sparks rise. */
export function tickGround(clock: number, goo: readonly THREE.ShaderMaterial[], flames: readonly THREE.Object3D[], sparks: readonly THREE.Points[]): void {
  for (const m of goo) m.uniforms.uTime.value = clock;
  for (const f of flames) flickerFlame(f, clock);
  for (const s of sparks) {
    const pos = s.geometry.getAttribute("position") as THREE.BufferAttribute;
    const { base, seed } = s.geometry.userData as { base: number[]; seed: number[] };
    for (let i = 0; i < pos.count; i++) {
      // Each spark rises a little over a second, drifting, then starts again from the embers.
      const t = (clock * 0.8 + seed[i]) % 1;
      pos.setXYZ(i, base[i * 3] + Math.sin(clock * 3 + i) * 0.06 * t, base[i * 3 + 1] + 0.1 + t * 1.1, base[i * 3 + 2] + Math.cos(clock * 2.6 + i) * 0.06 * t);
    }
    pos.needsUpdate = true;
  }
}
