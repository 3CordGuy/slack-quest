// What lies round and under a map that does not stand in the sea
// (RenderState.backdrop): a soft void. The land is a slab of rock floating
// over it (zoneScenery.ts faces its rim), and below are sheets of slow cloud
// at three depths, so the view has something to slide against as it moves,
// with the far distance lost in haze of the same colour. Far-off stacks of
// rock stand up out of the cloud as faint shapes, and the air has its own
// motes: dust in a dark place, embers over fire, snow over the frozen void.
//
// Each kind also leans on the day's light, after the sky has set it: a
// chasm is dim and blue whatever the hour, a lava field is lit red from
// underneath.
//
// One kind is not a void at all: `dark`, for a map under a roof or under
// ground. There is no cloud, no far rock and no sky there, only the dark
// past the walls, dust turning in the air, and a low cold light on the
// floor that the fires are seen by. The hour does not reach it.

import * as THREE from "three";
import { moteField, type Mote, type MoteField } from "./motes";

export type BackdropKind = "sea" | "mist" | "abyss" | "lava" | "frost" | "dusk" | "dark";
export type VoidKind = Exclude<BackdropKind, "sea">;

interface Look {
  /** The void's own colour, by day and at dead of night: the sky, and what the distance is lost in. */
  sky: [string, string];
  /** The cloud: where it is thick and lit, and its shadowed hollows. */
  cloud: [string, string];
  /** How much of the sheet is cloud, 0 to 1, and how solid the two upper sheets are. */
  cover: number;
  veil: [number, number];
  /** Where the haze begins and where it is whole, in world units past what the camera looks at. */
  haze: [number, number];
  /** The sun (or moon) as it reaches this place: how much of it, and its cast. */
  sun: [number, string];
  /** The light of the sky: how much, what it is pulled toward and how far; and the light that comes up from below. */
  fill: [number, string, number];
  under?: [string, number];
  /** How dim the place is kept whatever the hour, 0 to 1: fires glow by it. */
  gloom: number;
  /** Molten rock under everything, in place of the lowest cloud. */
  molten?: boolean;
  motes?: { count: number; colors: string[]; rise: number; sway: number; rate: number; size: number; additive: boolean; opacity?: number };
  /** The rock of the far stacks. */
  rock: string;
  /**
   * Under a roof: no cloud and no far rock, and the day's light is not leaned on but put out. In its place, the
   * low light the place is seen by: how much, its colour from above and from below.
   */
  roofed?: [number, string, string];
}

const LOOKS: Record<VoidKind, Look> = {
  mist: {
    sky: ["#aebfb5", "#131b1c"], cloud: ["#dfe9e0", "#7d948a"], cover: 0.46, veil: [0.5, 0.85], haze: [16, 92],
    sun: [0.8, "#f1f6ee"], fill: [0.95, "#c6d4ca", 0.35], gloom: 0.2,
    motes: { count: 70, colors: ["#f2f8f2", "#d8e6dc"], rise: 0.8, sway: 1.2, rate: 0.045, size: 0.1, additive: false, opacity: 0.5 },
    rock: "#58685f",
  },
  abyss: {
    sky: ["#060a16", "#03050c"], cloud: ["#1a3156", "#050912"], cover: 0.56, veil: [0.35, 0.7], haze: [13, 72],
    sun: [0.28, "#8fb6e6"], fill: [0.42, "#46689e", 0.6], under: ["#0a1224", 0.8], gloom: 0.8,
    motes: { count: 240, colors: ["#9fc8ff", "#d0e4ff", "#6f9fe8"], rise: 2.4, sway: 0.6, rate: 0.05, size: 0.1, additive: true },
    rock: "#18233a",
  },
  lava: {
    sky: ["#1e100c", "#140a08"], cloud: ["#4a2e26", "#190f0c"], cover: 0.58, veil: [0.4, 0.7], haze: [13, 78],
    sun: [0.42, "#ffb696"], fill: [0.6, "#9c5a42", 0.5], under: ["#ff5a1e", 0.9], gloom: 0.7, molten: true,
    motes: { count: 200, colors: ["#ff8a3a", "#ffd27a", "#ff5a1e"], rise: 6.5, sway: 0.7, rate: 0.085, size: 0.1, additive: true },
    rock: "#261714",
  },
  frost: {
    sky: ["#cde0f1", "#162236"], cloud: ["#f7fbff", "#a4c1dd"], cover: 0.42, veil: [0.55, 0.9], haze: [18, 104],
    sun: [1.0, "#f2f8ff"], fill: [1.05, "#cfe4f8", 0.4], under: ["#b6cfe8", 0.6], gloom: 0.05,
    motes: { count: 280, colors: ["#ffffff", "#e6f2ff"], rise: -7, sway: 0.9, rate: 0.065, size: 0.075, additive: false, opacity: 0.9 },
    rock: "#93aecb",
  },
  dusk: {
    sky: ["#dfb583", "#1e1515"], cloud: ["#f4d5a5", "#b57b52"], cover: 0.48, veil: [0.45, 0.8], haze: [16, 92],
    sun: [0.95, "#ffd2a2"], fill: [0.95, "#efc092", 0.45], under: ["#ae6e46", 0.5], gloom: 0.25,
    motes: { count: 110, colors: ["#ffe2b4", "#f6c88c"], rise: 1.2, sway: 1.4, rate: 0.04, size: 0.085, additive: true, opacity: 0.55 },
    rock: "#a6623a",
  },
  dark: {
    sky: ["#050509", "#050509"], cloud: ["#000000", "#000000"], cover: 0, veil: [0, 0], haze: [20, 62],
    sun: [0, "#000000"], fill: [0, "#000000", 0], gloom: 1,
    motes: { count: 150, colors: ["#c9b99a", "#a89c8c", "#8f98ad"], rise: 0.5, sway: 0.9, rate: 0.03, size: 0.06, additive: true, opacity: 0.3 },
    rock: "#000000",
    roofed: [0.58, "#8b9dc9", "#1b1723"],
  },
};

/** How far down each sheet of cloud lies. The lowest is whole; the two over it are torn, and thinner the higher. */
const DEPTHS = [-15, -7, -2.7];
/** How much of a sheet's colour is left at dead of night, and the cast it takes. */
const NIGHT_CAST = new THREE.Color(0.17, 0.2, 0.3);

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 at = modelMatrix * vec4(position, 1.0);
  vWorld = at.xyz;
  gl_Position = projectionMatrix * viewMatrix * at;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uLight;
uniform vec3 uDark;
uniform vec3 uHaze;
uniform vec3 uHot;
uniform float uScale;
uniform float uCover;
uniform float uOpacity;
uniform float uSolid;
uniform float uMolten;
uniform vec2 uDrift;
uniform vec2 uFade;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.9375;
}
void main() {
  vec2 p = vWorld.xz * uScale + uDrift * uTime;
  float n = fbm(p);
  float far = smoothstep(uFade.x, uFade.y, distance(vWorld, cameraPosition));
  vec3 c;
  float a = 1.0;
  if (uMolten > 0.5) {
    // A crust breaking up: bright seams where two plates meet, pools where it has gone through, all of it breathing.
    float seam = smoothstep(0.075, 0.0, abs(fbm(p * 1.9 + 3.1) - 0.5));
    float pool = smoothstep(0.64, 0.8, n);
    float breath = 0.7 + 0.3 * sin(uTime * 0.55 + n * 11.0);
    float heat = clamp(seam + pool, 0.0, 1.0) * breath;
    c = mix(uDark, uLight, fbm(p * 3.1 + 9.0));
    c = mix(c, uHot, heat) + uHot * heat * heat * 0.5;
  } else {
    float cloud = smoothstep(uCover - 0.2, uCover + 0.2, n);
    float shade = fbm(p * 2.4 + 7.0);
    c = mix(uDark, uLight, clamp(cloud * 0.5 + shade * 0.62, 0.0, 1.0));
    if (uSolid < 0.5) a = cloud * uOpacity * (1.0 - far);
  }
  c = mix(c, uHaze, far);
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const hash = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The far stacks: tall, broken columns of rock standing out of the cloud in a wide ring round the land. */
function stacks(land: { x: number; z: number; reach: number }, rock: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [];
  const colors: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const count = 13;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + hash(i, 1) * 0.4;
    const far = land.reach + 40 + hash(i, 2) * 50;
    const top = -10 + hash(i, 3) * 11;
    const wide = 2.2 + hash(i, 4) * 3.6;
    const [x, z] = [land.x + Math.cos(a) * far, land.z + Math.sin(a) * far];
    // Three lengths, each a little narrower and out of true with the one under it.
    let y = -22;
    const lengths = [0.5, 0.3, 0.2];
    lengths.forEach((share, j) => {
      const h = (top + 22) * share;
      const g = new THREE.CylinderGeometry(wide * (0.86 - j * 0.2), wide * (1 - j * 0.2), h, 6).toNonIndexed();
      e.set((hash(i, 10 + j) - 0.5) * 0.12, hash(i, 20 + j) * 6, (hash(i, 30 + j) - 0.5) * 0.12);
      m.compose(new THREE.Vector3(x + (hash(i, 40 + j) - 0.5) * wide * 0.3, y + h / 2, z + (hash(i, 50 + j) - 0.5) * wide * 0.3), q.setFromEuler(e), new THREE.Vector3(1, 1, 1));
      g.applyMatrix4(m);
      const p = g.getAttribute("position");
      for (let v = 0; v < p.count; v++) {
        pos.push(p.getX(v), p.getY(v), p.getZ(v));
        // Darker the further down, into the cloud.
        const k = THREE.MathUtils.clamp((p.getY(v) + 16) / 18, 0.12, 1) * (0.85 + hash(i * 7 + j, Math.floor(v / 3)) * 0.3);
        colors.push(rock.r * k, rock.g * k, rock.b * k);
      }
      g.dispose();
      y += h;
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A void for a map to float over. Add `group` to the scene and call `frame` once a frame, after the sky has
 * set its own colours and lights: it replaces the sky's colour and the haze's with its own and leans on the lights.
 */
export class VoidBackdrop {
  readonly group = new THREE.Group();
  /** How dim this place is kept whatever the hour, 0 to 1. */
  readonly gloom: number;
  /** Under a roof or under ground (the `dark` kind): nothing of the sky reaches the place. */
  readonly roofed: boolean;
  private look: Look;
  private sheets: THREE.ShaderMaterial[] = [];
  private motes: MoteField | null = null;
  private sun: THREE.DirectionalLight | null | undefined;
  private fill: THREE.HemisphereLight | null | undefined;
  private c = { sky: new THREE.Color(), day: new THREE.Color(), night: new THREE.Color(), light: new THREE.Color(), dark: new THREE.Color(), tint: new THREE.Color() };

  constructor(readonly kind: VoidKind, land: { x: number; z: number; reach: number }) {
    const look = (this.look = LOOKS[kind]);
    this.gloom = look.gloom;
    this.roofed = !!look.roofed;
    const plane = new THREE.PlaneGeometry(2600, 2600).rotateX(-Math.PI / 2);
    (this.roofed ? [] : DEPTHS).forEach((y, i) => {
      const solid = i === 0;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uLight: { value: new THREE.Color() }, uDark: { value: new THREE.Color() }, uHaze: { value: new THREE.Color() },
          uHot: { value: new THREE.Color(1.75, 0.4, 0.05) },
          uScale: { value: [0.045, 0.07, 0.11][i] }, uCover: { value: look.cover + i * 0.04 }, uOpacity: { value: solid ? 1 : look.veil[2 - i] },
          uSolid: { value: solid ? 1 : 0 }, uMolten: { value: solid && look.molten ? 1 : 0 },
          uDrift: { value: new THREE.Vector2([0.004, 0.011, 0.02][i], [0.002, -0.004, 0.009][i]) }, uFade: { value: new THREE.Vector2(40, 120) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: !solid,
        depthWrite: solid,
      });
      const sheet = new THREE.Mesh(plane, material);
      sheet.position.y = y;
      sheet.renderOrder = solid ? 0 : -8 + i;
      sheet.frustumCulled = false;
      sheet.userData.glow = true;
      this.sheets.push(material);
      this.group.add(sheet);
    });
    if (!this.roofed) this.group.add(new THREE.Mesh(stacks(land, new THREE.Color(look.rock)), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
    if (look.motes) {
      const d = look.motes;
      const span = 64;
      const list: Mote[] = [];
      for (let i = 0; i < d.count; i++) {
        list.push({
          // (Under a roof the dust hangs in the rooms, not under the floor.)
          x: hash(i, 61) * span, y: (this.roofed ? 0.6 + hash(i, 62) * 3.2 : -5 + hash(i, 62) * 15) - (d.rise < 0 ? d.rise * 0.2 : 0), z: hash(i, 63) * span,
          color: new THREE.Color(d.colors[i % d.colors.length]), rise: d.rise * (0.6 + hash(i, 64) * 0.8), sway: d.sway * (0.5 + hash(i, 65)),
          rate: d.rate * (0.6 + hash(i, 66) * 0.8), phase: hash(i, 67), size: 0.5 + hash(i, 68) * 0.9,
        });
      }
      this.motes = moteField(list, d.size, { wrap: span, additive: d.additive, opacity: d.opacity });
      this.group.add(this.motes.points);
    }
  }

  /**
   * Once a frame, after the sky's own update. `reach` is how far the camera stands from what it looks at;
   * `night` how dark the hour is, 0 to 1. `sky` (the scene's background) and `haze` (its fog, if it has one)
   * are given this void's colours. With `lit`, the sun and the sky's light (found in `scene`) are leaned on too:
   * not underground, where there is neither. (The `dark` kind puts them out and sets its own, lit or not.)
   */
  frame(clock: number, target: THREE.Vector3, reach: number, night: number, sky: THREE.Color, haze: THREE.Fog | null, scene: THREE.Scene, lit: boolean) {
    const look = this.look;
    const c = this.c;
    c.day.set(look.sky[0]);
    c.night.set(look.sky[1]);
    sky.copy(c.sky.copy(c.day).lerp(c.night, night));
    const [from, to] = [reach + look.haze[0], reach + look.haze[1]];
    if (haze) {
      haze.color.copy(sky);
      haze.near = from;
      haze.far = to;
    }
    // The cloud keeps its shape by night, in what light there is.
    c.light.set(look.cloud[0]);
    c.dark.set(look.cloud[1]);
    c.tint.copy(c.light).multiply(NIGHT_CAST);
    c.light.lerp(c.tint, night);
    c.tint.copy(c.dark).multiply(NIGHT_CAST);
    c.dark.lerp(c.tint, night);
    for (const m of this.sheets) {
      m.uniforms.uTime.value = clock;
      m.uniforms.uLight.value.copy(c.light);
      m.uniforms.uDark.value.copy(c.dark);
      m.uniforms.uHaze.value.copy(sky);
      m.uniforms.uFade.value.set(from + 6, to + 30);
    }
    for (const child of this.group.children) if ((child as THREE.Mesh).material instanceof THREE.ShaderMaterial) child.position.set(target.x, child.position.y, target.z);
    this.motes?.tick(clock, target);
    if (!lit && !look.roofed) return;
    if (this.sun === undefined) this.sun = (scene.children.find((o) => o instanceof THREE.DirectionalLight) as THREE.DirectionalLight | undefined) ?? null;
    if (this.fill === undefined) this.fill = (scene.children.find((o) => o instanceof THREE.HemisphereLight) as THREE.HemisphereLight | undefined) ?? null;
    if (look.roofed) {
      // No sun and no sky: whatever the hour made of them is put out, and the place has its own low light.
      if (this.sun) this.sun.intensity = 0;
      if (this.fill) {
        this.fill.intensity = look.roofed[0];
        this.fill.color.set(look.roofed[1]);
        this.fill.groundColor.set(look.roofed[2]);
      }
      return;
    }
    if (this.sun) {
      this.sun.intensity *= look.sun[0];
      this.sun.color.multiply(c.tint.set(look.sun[1]));
    }
    if (this.fill) {
      this.fill.intensity *= look.fill[0];
      this.fill.color.lerp(c.tint.set(look.fill[1]), look.fill[2]);
      if (look.under) this.fill.groundColor.lerp(c.tint.set(look.under[0]), look.under[1]);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    });
    this.motes?.dispose();
    this.group.clear();
  }
}
