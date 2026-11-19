// What lies on the ground in a fight, drawn with some life in it (TacticsLayer
// lays the sheets; this makes them look like what they are):
//
// - Oil and slime are goo: a gloss shader with a slow-rolling surface, a
//   bright moving highlight and a sheen at a glancing angle. Oil wears a
//   thin-film rainbow over its black; slime is a pale, glassy, see-through
//   mint jelly, wobbly, with bubbles rising through it.
// - Water is wet: half see-through, so the ground under it darkens; small
//   waves, rings from drops landing, the sky caught at a glancing angle.
// - Poison is a murky green that churns in on itself, bubbles swelling and
//   popping, and fumes rising off it: nothing like slime.
// - Burning ground burns: a glowing bed of embers on every hex, flames
//   licking up off it (the torch's flame, torchFlame.ts, a few to a hex),
//   and sparks drifting up out of it.
//
// Everything here is animated by `tickGround` (and the fumes by `tickFumes`),
// called once a frame; all of it lies dimmer at night.

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
  uniform float uShade;
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
    col *= uShade;
    gl_FragColor = vec4(col, clamp(uOpacity + spec * 0.35 + rim * 0.15, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uShade;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Small waves running two ways across the water, so it never sits still.
  float waves(vec2 p) {
    float t = uTime;
    return noise(p * 2.2 + vec2(t * 0.35, t * 0.2)) * 0.6 + noise(p * 4.7 - vec2(t * 0.5, -t * 0.3)) * 0.4;
  }
  // Rings spreading from drops landing here and there: each cell of the water has its own drop, now and again.
  float rings(vec2 p) {
    vec2 cell = p * 1.4;
    vec2 id = floor(cell);
    vec2 f = fract(cell) - 0.5;
    vec2 c = (vec2(hash(id), hash(id + 3.7)) - 0.5) * 0.6;
    float period = 2.2 + hash(id + 1.9) * 1.6;
    float age = fract(uTime / period + hash(id + 5.1));
    float d = length(f - c);
    return smoothstep(0.035, 0.0, abs(d - age * 0.45)) * (1.0 - age);
  }
  float height(vec2 p) { return waves(p) * 0.6 + rings(p) * 0.5; }

  void main() {
    vec2 p = vWorld.xz;
    float e = 0.02;
    float hx = height(p + vec2(e, 0.0)) - height(p - vec2(e, 0.0));
    float hz = height(p + vec2(0.0, e)) - height(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx * 2.2, 1.0, -hz * 2.2));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 l = normalize(vec3(0.35, 1.0, 0.45));
    // The sky caught at a glancing angle, and the sun glinting off the little waves.
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float glint = pow(max(dot(n, normalize(l + v)), 0.0), 90.0);
    float sheen = pow(max(dot(n, normalize(l + v)), 0.0), 14.0);
    vec3 sky = vec3(0.78, 0.88, 0.98);
    float w = waves(p);
    vec3 base = uColor * (0.72 + 0.3 * w);
    // Light rippling on the bottom through the water.
    float caustic = pow(1.0 - abs(noise(p * 3.0 + vec2(uTime * 0.4, -uTime * 0.3)) * 2.0 - 1.0), 6.0);
    float ring = rings(p);
    vec3 col = mix(base, sky, fres * 0.55) + vec3(1.0) * (glint * 0.9 + sheen * 0.12 + caustic * 0.1 + ring * 0.3);
    col *= uShade;
    gl_FragColor = vec4(col, clamp(uOpacity + fres * 0.3 + glint * 0.5 + ring * 0.2, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Water lying on the ground: half see-through, so the ground under it looks darkened and wet rather than painted;
 * small waves running across it, rings spreading from drops landing, the sky caught at a glancing angle, the sun
 * glinting, and light rippling on the bottom. Animated by `tickGround` like the goo.
 */
export function waterMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.42 }, uShade: { value: 1 } },
    vertexShader: GOO_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const POISON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uShade;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // A slow churn: noise pushed about by noise, so the poison swirls in on itself.
  float churn(vec2 p) {
    float t = uTime * 0.25;
    vec2 q = vec2(noise(p * 1.4 + t), noise(p * 1.4 - t + 5.2));
    return noise(p * 2.0 + q * 1.8 + vec2(t * 0.6, -t * 0.4));
  }

  void main() {
    vec2 p = vWorld.xz;
    float c = churn(p);
    float e = 0.03;
    float hx = churn(p + vec2(e, 0.0)) - churn(p - vec2(e, 0.0));
    float hz = churn(p + vec2(0.0, e)) - churn(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx * 2.5, 1.0, -hz * 2.5));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 l = normalize(vec3(0.35, 1.0, 0.45));
    float spec = pow(max(dot(n, normalize(l + v)), 0.0), 30.0);
    // All greens: murky and dark in the troughs of the churn, sickly bright where it swells. (These are linear
    // colours, which the screen brightens a good deal: the darks have to be very dark to read as murk.)
    vec3 deep = uColor * vec3(0.05, 0.09, 0.04);
    vec3 bright = mix(uColor, vec3(0.7, 1.0, 0.3), 0.2) * 0.75;
    vec3 col = mix(deep, bright, smoothstep(0.35, 0.85, c));
    // Bubbles swelling up through it and popping: each cell of it has one now and again.
    vec2 cell = p * 2.3;
    vec2 id = floor(cell);
    vec2 f = fract(cell) - 0.5 - (vec2(hash(id), hash(id + 7.3)) - 0.5) * 0.5;
    float period = 1.6 + hash(id + 2.2) * 1.8;
    float age = fract(uTime / period + hash(id + 4.4));
    float r = 0.06 + 0.16 * age;
    float d = length(f);
    float swell = step(0.45, hash(id + floor(uTime / period + hash(id + 4.4)))) * smoothstep(0.92, 0.75, age);
    float bubble = swell * (smoothstep(r, r - 0.025, d) - smoothstep(r - 0.035, r - 0.07, d) * 0.6 + smoothstep(0.035, 0.0, length(f - vec2(-r * 0.4, r * 0.4))) * 0.9);
    // Just as it bursts, a ring of it thrown out.
    float burst = step(0.45, hash(id + floor(uTime / period + hash(id + 4.4)))) * smoothstep(0.88, 1.0, age) * smoothstep(0.03, 0.0, abs(d - 0.24));
    col += bright * (bubble * 0.55 + burst * 0.5) + vec3(1.0) * spec * 0.35;
    // A faint glow of its own: poison still shows a little in the dark.
    col *= mix(uShade, 1.0, 0.3);
    gl_FragColor = vec4(col, clamp(0.84 + spec * 0.2 + bubble * 0.2, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Poison lying on the ground: a murky green that churns in on itself, bubbles swelling and popping in it, and a faint glow of its own. All greens. */
export function poisonMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uShade: { value: 1 } },
    vertexShader: GOO_VERTEX,
    fragmentShader: POISON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A soft round puff, drawn once: what fumes are made of. Round, not a pixel square. */
let puffTex: THREE.Texture | null = null;
function puff(): THREE.Texture {
  if (puffTex) return puffTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  puffTex = new THREE.CanvasTexture(canvas);
  return puffTex;
}

/** Fumes off poison: a few soft green wisps to a hex, drifting up, swelling and thinning away, and rising again. */
export function poisonFumes(hexes: HexPos[], at: (p: HexPos) => { x: number; y: number; z: number }, color: string): THREE.Group {
  const group = new THREE.Group();
  const tint = new THREE.Color(color).lerp(new THREE.Color("#d9f7a8"), 0.3);
  for (const p of hexes) {
    const { x, y, z } = at(p);
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff(), color: tint, transparent: true, opacity: 0, depthWrite: false }));
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * 0.5;
      s.userData.fume = { x: x + Math.cos(a) * d, y, z: z + Math.sin(a) * d, seed: Math.random(), speed: 0.25 + Math.random() * 0.15 };
      group.add(s);
    }
  }
  group.userData.fumes = true;
  return group;
}

/** Drift each fume up off its poison, and round again. */
export function tickFumes(clock: number, groups: readonly THREE.Group[], shade = 1): void {
  for (const g of groups) {
    for (const o of g.children) {
      const s = o as THREE.Sprite;
      const f = s.userData.fume as { x: number; y: number; z: number; seed: number; speed: number };
      const t = (clock * f.speed + f.seed) % 1;
      s.position.set(f.x + Math.sin(clock * 0.9 + f.seed * 9) * 0.12 * t, f.y + 0.1 + t * 1.1, f.z + Math.cos(clock * 0.7 + f.seed * 7) * 0.12 * t);
      s.scale.setScalar(0.45 + t * 0.7);
      s.material.opacity = Math.sin(Math.PI * t) * 0.3 * fumeLight(shade);
    }
  }
}
/** Fumes dim at night, but less than the ground: they glow a little of their own. */
const fumeLight = (shade: number) => 0.4 + 0.6 * shade;

/** A gloss material for a sheet of goo: oil (black, a rainbow film) or slime (pale, bubbling). */
export function gooMaterial(kind: "oil" | "slime", color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      // Slime is a pale, glassy, cool mint jelly, see-through: nothing like poison's murky, fuming green.
      uColor: { value: new THREE.Color(kind === "oil" ? "#1f1b18" : "#a8f0dc") },
      uOpacity: { value: kind === "oil" ? 0.82 : 0.5 },
      uIrid: { value: kind === "oil" ? 1 : 0 },
      uBubbles: { value: kind === "slime" ? 1 : 0 },
      // Slime wobbles faster than oil rolls.
      uRoll: { value: kind === "slime" ? 1.6 : 0.7 },
      uShade: { value: 1 },
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
/** `shade` is how lit the ground is, 1 by day: goo and water lie dimmer at night, as the ground under them does. */
export function tickGround(clock: number, goo: readonly THREE.ShaderMaterial[], flames: readonly THREE.Object3D[], sparks: readonly THREE.Points[], shade = 1): void {
  for (const m of goo) {
    m.uniforms.uTime.value = clock;
    if (m.uniforms.uShade) m.uniforms.uShade.value = shade;
  }
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
