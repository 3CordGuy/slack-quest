// The cloud over the atlas: everything the crew does not know.
//
// The world has no edge, and neither has this: it is one flat sheet that
// goes with the camera, painted by a shader that works the cloud out at
// every spot from where that spot is in the world. So there is always more
// of it, in every direction, out to where the distance is lost in mist, and
// nothing of it is stored or built.
//
// It is a layer of weather, not part of the ground: it has nothing to do
// with the hexes under it. It is drawn over everything that lies beneath,
// however tall (a hill does not cut through it), and it parts in soft rounds
// with ragged edges over what the crew can see. Where that is comes as a
// list of rounds (packages/world/src/atlasMap.ts decides); here they are
// turned into a small picture of how thick the cloud lies at each spot:
// none inside a round, thickening over the few hexes past its edge, whole
// beyond. The shader reads the picture at the spot of ground the eye is
// looking at through the cloud (not at the cloud itself, which floats
// above), a little astray and blurred, so the gap sits over the lit ground
// from whatever angle it is seen and has no straight side to it.
//
// When the atlas opens the cloud is closed, and parts outward from the
// Harbor (see `open`).

import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";
import { FAR_MIST, hexToWorld, type WorldRenderer } from "../render/WorldRenderer";

/** How high the cloud floats, in world units: over the trees and the lower hills. */
export const CLOUD_TOP = 1.55;
/** The height the gap in it is measured at: about where open ground lies. */
const GROUND = 0.62;
/** A hex across its flats is this many world units wide, corner to corner down the map this many apart: a round of n hexes reaches at least n times the lesser. */
const HEX_REACH = 1.5;
/** How much further than its hexes a round is clear (so a place's stone, standing up into the cloud, is clear of it too), and over how far past that the cloud thickens to whole. Both in world units. */
const CLEAR_MORE = 0.8;
const FADE = 3.2;

const VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vec4 at = modelMatrix * vec4(position, 1.0);
  vPos = at.xyz;
  gl_Position = projectionMatrix * viewMatrix * at;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uOrigin;
uniform float uSize;
uniform float uTime;
uniform float uGround;
uniform vec3 uSun;
uniform vec3 uShade;
uniform vec3 uBody;
uniform vec3 uCrest;
uniform vec3 uMist;
uniform vec2 uMistRange;
// Where the cloud is parting from, and how far it has got: past that it is still whole.
uniform vec3 uOpen;
varying vec3 vPos;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float billow(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += noise(p) * amp;
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / 0.9375;
}
// The cloud's height at a spot: slow rolling banks with smaller billows on them, drifting two ways at once.
float heap(vec2 p) {
  vec2 drift = uTime * vec2(0.021, 0.012);
  return billow(p * 0.055 + drift) * 0.62 + billow(p * 0.17 - drift * 1.7 + 31.0) * 0.38;
}

void main() {
  vec3 eye = normalize(vPos - cameraPosition);
  // The ground this spot of cloud hides, along the eye's line.
  vec2 ground = vPos.xz + eye.xz * ((uGround - vPos.y) / min(eye.y, -0.08));
  float r = ground.y / 1.5;
  float q = ground.x / 1.7320508 - r * 0.5;
  vec2 uv = (vec2(q, r) - uOrigin + 0.5) / uSize;
  float thick = 1.0;
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
    // Read a little astray, and at a few spots round about: the cloud's edge wanders, and has no corners.
    vec2 stray = (vec2(noise(ground * 0.19 + 3.1), noise(ground * 0.19 + 40.7)) - 0.5) * 2.6;
    vec2 at = uv + stray / uSize;
    vec2 step = vec2(0.75) / uSize;
    thick = (texture2D(uMask, at).r * 2.0 + texture2D(uMask, at + vec2(step.x, 0.0)).r + texture2D(uMask, at - vec2(step.x, 0.0)).r + texture2D(uMask, at + vec2(0.0, step.y)).r + texture2D(uMask, at - vec2(0.0, step.y)).r) / 6.0;
  }
  // Not yet parted this far out.
  float reach = distance(ground, uOpen.xy);
  thick = max(thick, smoothstep(uOpen.z - 7.0, uOpen.z, reach));

  float h = heap(vPos.xz);
  // Ragged at its edge: the billows reach in over the lit ground and the gaps between them reach out.
  float alpha = smoothstep(0.26, 0.66, thick + (h - 0.5) * 0.56);
  if (alpha < 0.004) discard;

  // Lit from the sun's side: a bank's near face is bright and its far face in shade.
  float ahead = heap(vPos.xz + normalize(uSun.xz + 0.0001) * 1.6);
  float lit = clamp(0.5 + (h - ahead) * 5.0, 0.0, 1.0);
  vec3 c = mix(uShade, uBody, smoothstep(0.25, 0.7, h));
  c = mix(c, uCrest, lit * (0.35 + 0.5 * h));
  // Thin at its edge, it glows a little with the light coming through.
  c = mix(uCrest, c, smoothstep(0.0, 0.75, alpha));
  // The edge of the part, as it opens, is lit from within.
  float rim = smoothstep(uOpen.z - 16.0, uOpen.z - 4.0, reach) * (1.0 - smoothstep(uOpen.z - 4.0, uOpen.z + 6.0, reach));
  c += vec3(0.25, 0.42, 0.6) * rim * 0.6;

  float far = smoothstep(uMistRange.x, uMistRange.y, distance(vPos, cameraPosition));
  c = mix(c, uMist, far);
  gl_FragColor = vec4(c, alpha);
  #include <colorspace_fragment>
}`;

export class AtlasCloud {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private mask: THREE.DataTexture;
  private size: number;
  /** How thick the cloud lies on each hex the picture covers, 0 to 1, row by row as the picture has them. */
  private thick: Float32Array;
  /** The hex of the world in the picture's first corner. */
  private origin: HexPos = { q: 0, r: 0 };
  /** The opening: where it parts from, when it began (on the renderer's clock; null before the first frame), and how long it takes. */
  private parting: { x: number; z: number; from: number | null; seconds: number; wait: number } | null = null;
  private stop: () => void;

  /** `reach` is how far the lit ground it is told of can lie from the middle it is given, in hexes. */
  constructor(private renderer: WorldRenderer, reach: number) {
    this.size = reach * 2 + 5;
    const data = new Uint8Array(this.size * this.size).fill(255);
    this.thick = new Float32Array(this.size * this.size).fill(1);
    this.mask = new THREE.DataTexture(data, this.size, this.size, THREE.RedFormat);
    this.mask.magFilter = this.mask.minFilter = THREE.LinearFilter;
    this.mask.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Over everything under it, however tall: a hill does not cut through the cloud.
      depthTest: false,
      uniforms: {
        uMask: { value: this.mask },
        uOrigin: { value: new THREE.Vector2() },
        uSize: { value: this.size },
        uTime: { value: 0 },
        uGround: { value: GROUND },
        uSun: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
        uShade: { value: new THREE.Color("#4c5873") },
        uBody: { value: new THREE.Color("#8d9ab6") },
        uCrest: { value: new THREE.Color("#eef2fa") },
        uMist: { value: FAR_MIST.clone() },
        uMistRange: { value: new THREE.Vector2(80, 120) },
        uOpen: { value: new THREE.Vector3(0, 0, 1e6) },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(3200, 3200).rotateX(-Math.PI / 2), this.material);
    this.mesh.position.y = CLOUD_TOP;
    this.mesh.frustumCulled = false;
    // After the ground and what lies on it, before what stands up out of the cloud.
    this.mesh.renderOrder = 5;
    renderer.addObject(this.mesh);
    this.stop = renderer.addTicker((_dt, _camera, clock) => this.tick(clock));
  }

  dispose() {
    this.stop();
    this.renderer.removeObject(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mask.dispose();
  }

  /** Part the cloud in a round over each of these (as far as `reach` hexes from its hex), which lie round `centre`, and close it everywhere else. */
  set(clear: readonly { hex: HexPos; reach: number }[], centre: HexPos) {
    const half = (this.size - 1) / 2;
    const origin = (this.origin = { q: centre.q - half, r: centre.r - half });
    this.thick.fill(1);
    for (const c of clear) {
      const mid = hexToWorld(c.hex);
      const open = c.reach * HEX_REACH + CLEAR_MORE;
      // Only the hexes near enough to be thinned by it.
      const span = Math.ceil((open + FADE) / HEX_REACH) + 1;
      for (let dr = -span; dr <= span; dr++) {
        for (let dq = -span; dq <= span; dq++) {
          const i = c.hex.q + dq - origin.q, j = c.hex.r + dr - origin.r;
          if (i < 0 || j < 0 || i >= this.size || j >= this.size) continue;
          const at = hexToWorld({ q: c.hex.q + dq, r: c.hex.r + dr });
          const thick = Math.min(1, Math.max(0, (Math.hypot(at.x - mid.x, at.z - mid.z) - open) / FADE));
          const k = j * this.size + i;
          if (thick < this.thick[k]) this.thick[k] = thick;
        }
      }
    }
    const data = this.mask.image.data as Uint8Array;
    for (let k = 0; k < data.length; k++) data[k] = Math.round(this.thick[k] * 255);
    this.mask.needsUpdate = true;
    (this.material.uniforms.uOrigin.value as THREE.Vector2).set(origin.q, origin.r);
  }

  /** How thick the cloud lies over a hex, 0 (clear) to 1. */
  over(hex: HexPos): number {
    const i = hex.q - this.origin.q, j = hex.r - this.origin.r;
    return i < 0 || j < 0 || i >= this.size || j >= this.size ? 1 : this.thick[j * this.size + i];
  }

  /** Close the cloud everywhere and part it outward from a hex, over `seconds`, after `wait`. */
  open(from: HexPos, seconds: number, wait = 0) {
    const { x, z } = hexToWorld(from);
    this.parting = { x, z, from: null, seconds, wait };
    (this.material.uniforms.uOpen.value as THREE.Vector3).set(x, z, 0);
  }

  private tick(clock: number) {
    const u = this.material.uniforms;
    u.uTime.value = clock;
    // It goes with the camera: the shader paints by where each spot is in the world, so nothing is seen to move.
    const at = this.renderer.focus();
    const { x, z } = hexToWorld(at);
    this.mesh.position.set(x, CLOUD_TOP, z);
    (u.uSun.value as THREE.Vector3).copy(this.renderer.sun);
    const mist = this.renderer.mist;
    if (mist) {
      (u.uMist.value as THREE.Color).copy(mist.color);
      (u.uMistRange.value as THREE.Vector2).set(mist.near, mist.far);
    }
    // It does not begin to part until the map is there to be seen.
    const p = this.parting;
    if (!p || !this.renderer.revealed) return;
    p.from ??= clock;
    const t = Math.min(1, Math.max(0, (clock - p.from - p.wait) / p.seconds));
    // Slow to start, then running out ahead: far enough that everything a window can hold is uncovered.
    const eased = t * t * (3 - 2 * t);
    (u.uOpen.value as THREE.Vector3).set(p.x, p.z, t >= 1 ? 1e6 : eased * eased * 260);
    if (t >= 1) this.parting = null;
  }
}
