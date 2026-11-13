// The quarry's rock face, seen first person. Not a scene of its own: a
// minigame played in the Harbor's renderer (WorldRenderer.startMinigame),
// built at the quarry, which the camera orbits down into and back out of.
//
// It shows what the server sends (MineView) and plays the swings. The swings
// are timed here, by the same rules the server replays them with (landBlows
// from packages/world/src/mine.ts), so a blow cracks and breaks rocks at once
// and the server's answer only adds what was inside.
//
// The rocks have their own shader. They carry their own light (a lantern by
// the player's feet and a soft key from above), so the face reads by day and
// by night alike, and they glisten: tiny flecks catch the lantern as the
// player's head sways. How many flecks a rock has is its glint, the hint the
// player hunts the seam by. Gems are brighter still, with star sparkles on top;
// with "Fancy graphics" on, the finishing pass blooms all of it.
//
// Break a rock and what is above it comes down (the rules do it; this plays it
// out), and a rock the fall smashes takes what was in it to the floor. The
// rocks that would fall are tinted red while the pick hovers under them.

import * as THREE from "three";
import { MINE_COLS, MINE_ROWS, MINE_RARITY, landBlows, mineGrid, powerFor, type BlowPower, type MineState, type MineView, type ResourceKind, type Resources, type RockKind } from "@gantt-quest/world";
import { audio } from "../audio/engine";
import { soundName } from "../audio/names";
import { OVERLAY_LAYER } from "./post";
import { textTexture } from "./sprites";
import type { WorldMinigame, WorldRenderer } from "./WorldRenderer";

/** World units per rock in the face. */
const CELL = 0.2;
/** How far the face stands back from the middle of the quarry's hex (to the north, away from the usual view). */
const FACE_Z = -0.5;
/** Height of the bottom row's foot above the ground. */
const FACE_FOOT = 0.06;
const VFOV = 52;
/** Seconds to fly down into the face, and back out of it. */
const IN_S = 1.6;
const OUT_S = 1.2;
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** How each hardness looks: rock colour by how many blows it takes. */
const LOOK_COLOR: Record<number, string> = { 1: "#a39684", 2: "#8d857b", 3: "#6e7380", 4: "#565c6a" };
/** Fleck colour: plain mica, the seam's ore once it shows, and a geode's crystal. */
const MICA = new THREE.Color(1.0, 0.95, 0.78);
const ORE = new THREE.Color(1.0, 0.72, 0.32);
const CRYSTAL = new THREE.Color(1.0, 0.45, 0.95);
const LANTERN = new THREE.Color(1.0, 0.72, 0.42);

const RES_COLOR: Partial<Record<ResourceKind, string>> = { stone: "#9aa3b2", iron: "#b9cbe6", copper: "#e0884a", gem: "#ff6fe0" };

// ---------- the rock shader ----------

const ROCK_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vObj = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const ROCK_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uFleck;
uniform float uGlint;
uniform float uFleckScale;
uniform float uCrack;
uniform float uFlash;
uniform float uHover;
uniform float uWarn;
uniform float uTime;
uniform float uSeed;
uniform vec3 uKeyDir;
uniform vec3 uKey;
uniform vec3 uAmbient;
uniform vec3 uLampPos;
uniform vec3 uLamp;
varying vec3 vObj;
varying vec3 vWorld;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
vec3 hash3(vec3 p) {
  return vec3(hash(p), hash(p + 19.19), hash(p + 47.47));
}
// Distance to the nearest and second-nearest cell point: their difference is small along the cracks between cells.
vec2 cells(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash3(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(d1, d2);
}

void main() {
  // Flat facets, like everything else in the world.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;

  float facet = hash(floor(n * 7.0) + uSeed);
  float grain = hash(floor(vObj * 38.0) + uSeed);
  vec3 col = uBase * (0.82 + 0.32 * facet) * (0.93 + 0.14 * grain);

  vec3 toLamp = uLampPos - vWorld;
  float lampDist = length(toLamp);
  vec3 l = toLamp / lampDist;
  float lampFall = 1.0 / (1.0 + lampDist * lampDist * 0.35);
  float lamp = max(dot(n, l), 0.0) * lampFall;
  float key = max(dot(n, uKeyDir), 0.0);
  vec3 lit = col * (uAmbient + uKey * key + uLamp * lamp);

  // A damp sheen off the lantern.
  vec3 h = normalize(l + v);
  lit += uLamp * pow(max(dot(n, h), 0.0), 36.0) * 0.18 * lampFall;

  // Flecks: a few cells of a fine grid hold a crystal face. Each catches the light when its face lies between
  // the lantern and the eye, and the faces turn a little with time, so they wink on and off.
  vec3 fp = vObj * uFleckScale + uSeed;
  vec3 cell = floor(fp);
  float r = hash(cell);
  float density = uGlint > 0.0 ? 0.06 + 0.11 * uGlint : 0.025;
  if (r > 1.0 - density) {
    vec3 jit = hash3(cell * 1.7) * 2.0 - 1.0;
    vec3 fn = normalize(jit + n * 1.1 + 0.55 * vec3(sin(uTime * (1.3 + r * 2.0) + r * 40.0), cos(uTime * (1.1 + r * 1.7) + r * 23.0), 0.0));
    float wink = pow(max(dot(fn, h), 0.0), 24.0);
    float pulse = 0.5 + 0.5 * sin(uTime * (2.0 + r * 4.0) + r * 61.0);
    vec3 f = fract(fp) - 0.5;
    float dotMask = smoothstep(0.42, 0.05, length(f));
    float strength = uGlint > 0.0 ? (0.45 + 0.55 * uGlint) : 0.25;
    lit += uFleck * dotMask * strength * (wink * 3.0 + pulse * 0.35 * uGlint);
  }

  // Cracks spread as the rock takes blows.
  if (uCrack > 0.0) {
    vec2 c = cells(vObj * 7.0 + uSeed);
    float edge = c.y - c.x;
    float crack = 1.0 - smoothstep(0.0, 0.03 + 0.09 * uCrack, edge);
    lit = mix(lit, lit * 0.12, crack * min(1.0, 0.35 + uCrack));
  }

  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.0);
  lit += vec3(1.0, 0.85, 0.55) * (rim * 0.5 + 0.08) * uHover;
  // Would come down if the rock under the pick goes.
  lit = mix(lit, lit * vec3(1.25, 0.55, 0.45) + vec3(0.25, 0.02, 0.0) * rim, uWarn);
  lit += vec3(1.0, 0.95, 0.85) * uFlash;
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The light the whole set shares, updated each frame from the hour. */
interface SetLight {
  uKeyDir: THREE.IUniform<THREE.Vector3>;
  uKey: THREE.IUniform<THREE.Color>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uLampPos: THREE.IUniform<THREE.Vector3>;
  uLamp: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
}

function rockMaterial(light: SetLight, base: string, seed: number, opts: { glint?: number; fleck?: THREE.Color; fleckScale?: number; overlay?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ROCK_VERT,
    fragmentShader: ROCK_FRAG,
    uniforms: {
      ...light,
      uBase: { value: new THREE.Color(base) },
      uFleck: { value: (opts.fleck ?? MICA).clone() },
      uGlint: { value: opts.glint ?? 0 },
      uFleckScale: { value: opts.fleckScale ?? 70 },
      uCrack: { value: 0 },
      uFlash: { value: 0 },
      uHover: { value: 0 },
      uWarn: { value: 0 },
      uSeed: { value: seed },
    },
    depthTest: !opts.overlay,
  });
}

/** A lumpy rock: an icosahedron pushed in and out by a fixed noise, so every one is different. */
function rockGeometry(seed: number, sx: number, sy: number, sz: number, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed * 13.1) * 43758.5453;
    const bump = 0.82 + 0.3 * (n - Math.floor(n));
    pos.setXYZ(i, v.x * sx * bump, v.y * sy * bump, v.z * sz * bump);
  }
  g.computeVertexNormals();
  return g;
}

/** A four-pointed star with a soft glow, for sparkles. */
let starTex: THREE.CanvasTexture | null = null;
function starTexture(): THREE.CanvasTexture {
  if (starTex) return starTex;
  const N = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const glow = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.18, "rgba(255,255,255,0.55)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  const c = N / 2;
  ctx.moveTo(c, 0);
  ctx.quadraticCurveTo(c, c, N, c);
  ctx.quadraticCurveTo(c, c, c, N);
  ctx.quadraticCurveTo(c, c, 0, c);
  ctx.quadraticCurveTo(c, c, c, 0);
  ctx.fill();
  starTex = new THREE.CanvasTexture(canvas);
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}

/** A soft round puff, for dust. */
let puffTex: THREE.CanvasTexture | null = null;
function puffTexture(): THREE.CanvasTexture {
  if (puffTex) return puffTex;
  const N = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  puffTex = new THREE.CanvasTexture(canvas);
  return puffTex;
}

// ---------- the set ----------

interface RockObj {
  /** Its id, which it keeps as it falls, and where it is in the face now. */
  id: number;
  cell: number;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  home: THREE.Vector3;
  shake: number;
  flash: number;
  /** The face as this client has played it: what the server has said, plus the blows not yet answered. */
  hp: number;
  dmg: number;
  broken: boolean;
  kind: RockKind | null;
  glint: number;
  /** Star sparkles on a gem-bearing rock, and on the brightest glints. */
  stars: THREE.Sprite[];
  /** What it gave (or that it was lost) has been shown. */
  told: boolean;
  /** Coming down into a gap: from where, how far through, how long it takes, and whether it smashes on landing. */
  drop: { from: THREE.Vector3; t: number; dur: number; lost: boolean } | null;
  lost: boolean;
}

interface Bit {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  kind: "debris" | "dust" | "spark" | "loot";
  size: number;
}

export interface MineCallbacks {
  /** A blow landed. `broken` is every rock (by id) it broke: the struck one, any its knock-on broke, and any a fall smashed. */
  onBlow(blow: { cell: number; power: BlowPower; at: number }, broken: number[]): void;
  /** The clock has run out. */
  onTimeUp(): void;
  /** How charged the swing being held is, 0 to 1, and whether the pick is free, for the HUD. */
  onCharge?(charge: number, ready: boolean): void;
}

export class MineStage implements WorldMinigame {
  private face = new THREE.Group();
  private surround = new THREE.Group();
  private fx = new THREE.Group();
  /** The pick, drawn in front of the camera. */
  private pick = new THREE.Group();
  private pickPivot = new THREE.Group();
  private rocks: RockObj[] = [];
  /** An unseen sheet across the face: a press between two rocks lands on it and goes to the nearer. */
  private sheet: THREE.Mesh;
  private bits: Bit[] = [];
  private light: SetLight;
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private stopTick: () => void;
  private laidOut = false;
  private lampLocal = new THREE.Vector3(-0.55, 0.22, 0.35);

  /** The clock: performance.now() when it started (null before), and how long it runs. */
  private origin: number | null = null;
  private ms = 30_000;
  private chargeMs = 900;
  private recoverMs = 450;
  private lastAt: number | null = null;
  /** The face as the rules see it, for replaying blows here the way the server will. */
  private local: MineState;
  private running = false;
  private timeUp = false;
  /** A swing being held: on which rock it started and when (ms on the clock). */
  private held: { downAt: number } | null = null;
  /** A tap made while the pick was still coming back: it lands as soon as the pick is free. */
  private buffered: number | null = null;
  private hovered: number | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  /** The pick's swing: when the last blow landed (render clock) and how hard. */
  private strikeAt = -10;
  private strikePower: BlowPower = 1;
  private strikeDir = new THREE.Vector3();
  private charge = 0;
  private shake = 0;
  private clock = 0;
  private disposed = false;

  /** How far the camera has come down into the face, 0 to 1 (before easing), and whether it is on its way back out. */
  private inT = 0;
  private leaving = false;
  /** That, eased: what the renderer is told, and what the pick and hover follow. */
  private close = 0;

  /** Built by WorldRenderer.startMinigame, in the group it stands on the quarry's hex. */
  constructor(private world: WorldRenderer, private group: THREE.Group, view: MineView, private cb: MineCallbacks) {
    this.light = {
      uKeyDir: { value: new THREE.Vector3(-0.35, 0.8, 0.5).normalize() },
      uKey: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() },
      uLampPos: { value: new THREE.Vector3() },
      uLamp: { value: new THREE.Color() },
      uTime: { value: 0 },
    };
    this.local = { rocks: view.rocks.map((r) => ({ kind: r.kind ?? "rubble", cell: r.cell, hp: r.hp, dmg: r.dmg, broken: r.broken, glint: r.glint, fell: r.fell, lost: r.lost })), chargeMs: view.chargeMs, startedAt: 0, lastAt: view.lastAt };
    this.chargeMs = view.chargeMs;
    this.recoverMs = view.recoverMs;
    this.ms = view.ms;
    this.lastAt = view.lastAt;
    this.buildRocks(view);
    this.buildPick();
    this.sheet = new THREE.Mesh(new THREE.PlaneGeometry(MINE_COLS * CELL + CELL, MINE_ROWS * CELL + CELL), new THREE.MeshBasicMaterial());
    this.sheet.visible = false;
    this.sheet.position.set(0, FACE_FOOT + (MINE_ROWS * CELL) / 2, FACE_Z + CELL * 0.2);
    this.group.add(this.face, this.surround, this.fx, this.sheet);
    // The pick is placed in front of the camera each frame, in world space, so it stands outside the group.
    world.addObject(this.pick);
    this.stopTick = world.addTicker((dt, camera, clock) => this.tick(dt, camera, clock));
  }

  // ---------- building ----------

  private track<T extends THREE.Material | THREE.BufferGeometry>(x: T): T {
    if (x instanceof THREE.Material) this.materials.push(x);
    else this.geometries.push(x);
    return x;
  }

  private buildRocks(view: MineView) {
    view.rocks.forEach((r) => {
      const id = r.id;
      const size = 0.86 + 0.06 * r.hp;
      const geo = this.track(rockGeometry(id + 1, CELL * 0.5 * size, CELL * 0.48 * size, CELL * (0.38 + 0.05 * r.hp)));
      const mat = this.track(rockMaterial(this.light, LOOK_COLOR[r.hp] ?? LOOK_COLOR[2], id * 1.37 + 0.5, { glint: r.glint }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.id = id;
      mesh.rotation.set((id * 0.37) % 0.4, (id * 0.71) % 0.6, (id * 1.13) % Math.PI);
      this.face.add(mesh);
      const rock: RockObj = { id, cell: r.cell, mesh, mat, home: new THREE.Vector3(), shake: 0, flash: 0, hp: r.hp, dmg: r.dmg, broken: r.broken, kind: r.kind, glint: r.glint, stars: [], told: !!r.got || r.lost, drop: null, lost: r.lost };
      this.rocks.push(rock);
      this.dress(rock);
    });
  }

  /** Where a place in the face is, in the set's own space. Row 0 is the top: rocks fall toward the last row. */
  private placeOf(cell: number, id: number, out = new THREE.Vector3()): THREE.Vector3 {
    const row = Math.floor(cell / MINE_COLS);
    const col = cell % MINE_COLS;
    const jitter = Math.sin(id * 91.7) * 0.012;
    return out.set((col - (MINE_COLS - 1) / 2) * CELL + jitter, FACE_FOOT + (MINE_ROWS - 1 - row) * CELL + CELL / 2 + jitter * 0.5, FACE_Z + Math.sin(id * 12.3) * 0.02);
  }

  /** Put every rock in its place and build the rock round the face. Gravity points down the screen, so the face is never turned. */
  private layout() {
    this.laidOut = true;
    for (const rock of this.rocks) {
      this.placeOf(rock.cell, rock.id, rock.home);
      rock.mesh.position.copy(rock.home);
    }
    this.buildFrame(MINE_COLS * CELL, MINE_ROWS * CELL);
  }

  /** The rock round the face, the dark behind it, the floor and a lantern. */
  private buildFrame(w: number, h: number) {
    for (const o of this.surround.children) {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    this.surround.clear();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.surround.add(m);
      return m;
    };
    // The dark beyond the face, seen where rocks have come away.
    const back = add(new THREE.PlaneGeometry(w + 0.3, h + 0.3), rockMaterial(this.light, "#2a2630", 3.3, { fleckScale: 40 }), 0, FACE_FOOT + h / 2, FACE_Z - 0.13);
    back.renderOrder = -1;
    // The floor running back to the camera.
    const floor = add(new THREE.PlaneGeometry(w + 1.6, 2.4, 8, 8), rockMaterial(this.light, "#4a3f36", 7.7, { fleckScale: 30 }), 0, 0.005, FACE_Z + 1.0);
    floor.rotation.x = -Math.PI / 2;
    // Boulders framing the face: down both sides, along the top, and an overhang leaning out over it.
    let seed = 1;
    const boulder = (x: number, y: number, z: number, r: number, color = "#5c5a62") => {
      seed++;
      const m = add(rockGeometry(seed * 7.1, r, r * 0.9, r * 0.8, 1), rockMaterial(this.light, color, seed * 2.3, { glint: 0.2 }), x, y, z);
      m.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
    };
    const left = -w / 2 - 0.1;
    const right = w / 2 + 0.1;
    for (let y = 0.05; y < h + 0.25; y += 0.2) {
      boulder(left - Math.sin(y * 9) * 0.05, y, FACE_Z + 0.02, 0.16 + 0.05 * Math.abs(Math.sin(y * 5)));
      boulder(right + Math.sin(y * 7) * 0.05, y, FACE_Z + 0.02, 0.16 + 0.05 * Math.abs(Math.cos(y * 5)));
    }
    for (let x = left; x <= right + 0.01; x += 0.22) boulder(x, FACE_FOOT + h + 0.1 + Math.sin(x * 11) * 0.03, FACE_Z + 0.04, 0.17, "#55535c");
    for (let x = left + 0.1; x <= right; x += 0.3) boulder(x, FACE_FOOT + h + 0.28, FACE_Z + 0.22, 0.24, "#4c4a54");
    // Rubble along the foot of the face.
    for (let x = -w / 2; x <= w / 2; x += 0.13) {
      seed++;
      const m = add(rockGeometry(seed * 3.3, 0.05, 0.035, 0.05, 0), rockMaterial(this.light, "#6a6460", seed, { glint: 0.1 }), x + Math.sin(seed) * 0.04, 0.02, FACE_Z + 0.16 + Math.cos(seed * 2.1) * 0.06);
      m.rotation.y = seed;
    }
    // The lantern, set down on the floor to one side: a frame, and a flame bright enough to glow.
    const lx = left + 0.12;
    this.lampLocal.set(lx, 0.2, FACE_Z + 0.55);
    add(new THREE.BoxGeometry(0.07, 0.11, 0.07), new THREE.MeshBasicMaterial({ color: "#2b2118" }), lx, 0.055, FACE_Z + 0.55);
    add(new THREE.BoxGeometry(0.05, 0.06, 0.05), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.5, 0.7) }), lx, 0.06, FACE_Z + 0.55);
  }

  /** The pick: a haft and a double-ended iron head, pivoting about the grip. Drawn on the overlay layer, over everything. */
  private buildPick() {
    const wood = this.track(rockMaterial(this.light, "#7a5230", 11, { fleckScale: 120, overlay: true }));
    const iron = this.track(rockMaterial(this.light, "#8a93a3", 13, { glint: 0.6, fleckScale: 160, overlay: true }));
    const haft = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03, 0.46, 0.03)), wood);
    haft.position.y = 0.23;
    // The head is built along x, then turned a quarter about the haft so it lies along the line of sight:
    // the long point (+x) aims forward into the face, the short one back over the hand.
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.45;
    headGroup.rotation.y = Math.PI / 2;
    const head = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.34, 0.045, 0.045)), iron);
    const tipA = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.024, 0.09, 4)), iron);
    tipA.rotation.z = -Math.PI / 2;
    tipA.position.set(0.21, -0.01, 0);
    const tipB = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.024, 0.07, 4)), iron);
    tipB.rotation.z = Math.PI / 2;
    tipB.position.set(-0.2, -0.01, 0);
    headGroup.add(tipA, head, tipB);
    this.pickPivot.add(haft, headGroup);
    // Drawn over everything without a depth test, so drawn back to front: the haft, the far point, the head, the near point.
    for (const [i, m] of [haft, tipA, head, tipB].entries()) {
      m.layers.set(OVERLAY_LAYER);
      m.renderOrder = 1000 + i;
      m.frustumCulled = false;
    }
    this.pickPivot.scale.setScalar(0.55);
    this.pick.add(this.pickPivot);
  }

  /** Colour a rock by what is known of it: a seam once seen shows its ore, a geode its crystal and stars. */
  private dress(rock: RockObj) {
    const u = rock.mat.uniforms;
    // A rock the fall will smash stays in sight until it lands.
    rock.mesh.visible = !rock.broken || !!rock.drop;
    u.uCrack.value = rock.broken ? 0 : rock.dmg / rock.hp;
    const glint = rock.kind === "seam" ? Math.max(rock.glint, 2.5) : rock.kind === "geode" ? 3.4 : rock.glint;
    u.uGlint.value = glint;
    (u.uFleck.value as THREE.Color).copy(rock.kind === "geode" ? CRYSTAL : rock.kind === "seam" ? ORE : MICA);
    if (rock.kind === "geode") (u.uBase.value as THREE.Color).set("#5b4a70");
    else if (rock.kind === "seam") (u.uBase.value as THREE.Color).set("#6b5a4a");
    const starsWanted = rock.broken ? 0 : rock.kind === "geode" ? 4 : rock.glint >= 3 ? 1 : 0;
    while (rock.stars.length < starsWanted) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color: rock.kind === "geode" ? CRYSTAL.clone().multiplyScalar(1.4) : MICA.clone().multiplyScalar(1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.userData.phase = Math.random() * Math.PI * 2;
      s.userData.offset = new THREE.Vector3((Math.random() - 0.5) * CELL * 0.6, (Math.random() - 0.5) * CELL * 0.55, CELL * 0.25);
      rock.stars.push(s);
      this.fx.add(s);
    }
    while (rock.stars.length > starsWanted) {
      const s = rock.stars.pop()!;
      this.fx.remove(s);
      s.material.dispose();
    }
  }

  // ---------- what the server says ----------

  /**
   * Take the server's face. What it knows of each rock (its kind, what it gave) is laid over the face as
   * played here; blows the server has not had yet are left standing. With `reset` the server's face replaces
   * this one outright, as after a refused report.
   */
  sync(view: MineView, reset = false) {
    for (const r of view.rocks) {
      const rock = this.rocks[r.id];
      if (!rock) continue;
      if (reset) {
        rock.dmg = r.dmg;
        rock.broken = r.broken;
        rock.lost = r.lost;
        rock.cell = r.cell;
        rock.drop = null;
        this.placeOf(r.cell, r.id, rock.home);
        this.local.rocks[r.id] = { ...this.local.rocks[r.id], cell: r.cell, dmg: r.dmg, broken: r.broken, lost: r.lost, fell: r.fell };
      } else if (r.broken && !rock.broken) {
        // Broken by the server but not here (it can only be something we missed): bring it down.
        rock.broken = true;
        this.local.rocks[r.id] = { ...this.local.rocks[r.id], dmg: r.hp, broken: true, lost: r.lost };
        this.shatter(rock, 1);
      }
      rock.kind = r.kind;
      if (!rock.told && r.broken) {
        if (r.got) {
          rock.told = true;
          this.showLoot(rock, r.got);
        } else if (r.lost) {
          rock.told = true;
          // Only worth saying for what was worth having.
          if (r.kind === "seam" || r.kind === "geode") this.showLost(rock, r.kind === "geode" ? "Gems lost!" : "Ore lost!");
        }
      }
      this.dress(rock);
    }
    if (reset) {
      this.lastAt = view.lastAt;
      this.local = { ...this.local, lastAt: view.lastAt };
    }
  }

  /** Start the clock: `elapsedMs` of it have already gone (a reload part way through). */
  start(elapsedMs = 0) {
    this.origin = performance.now() - elapsedMs;
    this.running = elapsedMs < this.ms;
    this.timeUp = !this.running;
  }

  /** Milliseconds on the clock, or null before it starts. */
  now(): number | null {
    return this.origin === null ? null : Math.min(this.ms, performance.now() - this.origin);
  }

  get leftMs(): number | null {
    const now = this.now();
    return now === null ? null : Math.max(0, this.ms - now);
  }

  /** Stop taking swings (the outing is being hauled out). */
  stop() {
    this.running = false;
    this.held = null;
    this.buffered = null;
  }

  // ---------- input ----------

  /** Where the pointer is, in client pixels; it aims the swing and lights the rock under it. */
  pointerMove(x: number, y: number) {
    this.pointer = { x, y, inside: true };
  }

  pointerLeave() {
    this.pointer.inside = false;
  }

  /** The rock under a point on screen, if it is still standing. */
  private rockAt(x: number, y: number): number | null {
    const standing = this.rocks.filter((r) => !r.broken);
    const hit = this.world.pickAt(standing.map((r) => r.mesh), x, y);
    if (hit) return hit.object.userData.id as number;
    // Between rocks: the nearest one standing, if the press is near enough to it.
    const onSheet = this.world.pickAt([this.sheet], x, y);
    if (!onSheet) return null;
    const at = this.group.worldToLocal(onSheet.point.clone());
    let best: RockObj | null = null;
    let bestD = CELL * 0.85;
    for (const r of standing) {
      const d = Math.hypot(r.home.x - at.x, r.home.y - at.y);
      if (d < bestD) (best = r), (bestD = d);
    }
    return best?.id ?? null;
  }

  /** The swing is pressed: start charging (once the pick is free). */
  pressDown(x: number, y: number) {
    this.pointerMove(x, y);
    const now = this.now();
    if (!this.running || now === null) return;
    this.held = { downAt: now };
  }

  /** The swing is let go: it lands on the rock under the pointer, as hard as it was charged. */
  pressUp(x: number, y: number) {
    this.pointerMove(x, y);
    const held = this.held;
    this.held = null;
    const now = this.now();
    if (!held || !this.running || now === null) return;
    const id = this.rockAt(x, y);
    const free = this.freeAt();
    if (now < free) {
      // Still recovering from the last blow: a quick tap waits for the pick and lands then.
      if (id !== null) this.buffered = id;
      return;
    }
    const power = powerFor(now - Math.max(held.downAt, free), this.chargeMs);
    if (id === null) {
      this.whiff(power);
      return;
    }
    this.blow(id, power, now);
  }

  private freeAt(): number {
    return this.lastAt === null ? 0 : this.lastAt + this.recoverMs;
  }

  private whiff(power: BlowPower) {
    this.strikeAt = this.clock;
    this.strikePower = power;
    this.strikeDir.set(0, 0, -1);
  }

  /**
   * Land a blow on a rock (by id), here first: cracks, breaks, the pick's swing, and whatever comes down into
   * the gaps. Then tell the HUD, which reports it by the place the rock stands in.
   */
  private blow(id: number, power: BlowPower, at: number) {
    const struck = this.rocks[id];
    if (!struck || struck.broken) return;
    const cell = struck.cell;
    const before = this.local.rocks;
    const landed = landBlows(this.local, [{ cell, power, at }], Infinity);
    if (typeof landed === "string") return;
    this.local = landed.mine;
    this.lastAt = at;
    this.strikeAt = this.clock;
    this.strikePower = power;
    this.strikeDir.copy(struck.mesh.getWorldPosition(new THREE.Vector3()));
    audio.play(soundName.pick(power === 3));
    this.shake = Math.max(this.shake, power === 3 ? 1 : power === 2 ? 0.5 : 0.25);
    this.sparks(struck.mesh.getWorldPosition(new THREE.Vector3()), power);
    const fell = new Set(landed.falls.map((f) => f.id));
    this.local.rocks.forEach((now, rid) => {
      const was = before[rid];
      const rock = this.rocks[rid];
      if (now === was || (now.dmg === was.dmg && now.cell === was.cell && now.broken === was.broken)) return;
      rock.dmg = now.dmg;
      rock.lost = !!now.lost;
      if (fell.has(rid)) {
        // Down into the gap: it lands, and if the fall breaks it, it smashes there.
        const from = rock.mesh.position.clone();
        rock.cell = now.cell;
        this.placeOf(now.cell, rid, rock.home);
        const rows = Math.max(1, Math.round((from.y - rock.home.y) / CELL));
        rock.drop = { from, t: 0, dur: 0.16 * Math.sqrt(rows) + 0.06, lost: !!now.lost };
        if (now.lost) rock.broken = true;
        // The damage shows when it lands.
        rock.dmg = was.dmg;
        rock.mat.uniforms.uCrack.value = was.dmg / rock.hp;
        return;
      }
      rock.shake = rid === id ? 1 : 0.5;
      rock.flash = rid === id ? 0.7 : 0.3;
      if (now.broken && !rock.broken) {
        rock.broken = true;
        this.shatter(rock, rid === id ? power : 1);
      }
      this.dress(rock);
    });
    this.cb.onBlow({ cell, power, at }, landed.broken);
  }

  /** A falling rock reaches the floor of its gap: a thud, and its cracks, or it smashes and what was in it is gone. */
  private land(rock: RockObj) {
    const drop = rock.drop!;
    rock.drop = null;
    rock.mesh.position.copy(rock.home);
    rock.dmg = this.local.rocks[rock.id].dmg;
    this.puff(rock.home.clone().add(new THREE.Vector3(0, -CELL * 0.45, 0.05)), 2);
    if (drop.lost) {
      this.shatter(rock, 1);
      const precious = rock.kind === "seam" || rock.kind === "geode";
      this.showLost(rock, rock.kind === "seam" ? "Ore lost!" : rock.kind === "geode" ? "Gems lost!" : "Smashed");
      if (precious) rock.told = true;
      return;
    }
    rock.shake = 0.8;
    this.shake = Math.max(this.shake, 0.3);
    this.dress(rock);
  }

  // ---------- effects ----------

  private shatter(rock: RockObj, power: number) {
    audio.play(soundName.rockBreak());
    const at = rock.mesh.position.clone();
    const n = 6 + power * 2;
    for (let i = 0; i < n; i++) {
      const geo = this.track(rockGeometry(rock.id * 31 + i, 0.03 + Math.random() * 0.025, 0.025, 0.03, 0));
      const m = new THREE.Mesh(geo, rock.mat);
      m.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 0.04));
      this.fx.add(m);
      this.bits.push({ obj: m, vel: new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.4 + Math.random() * 0.9, 0.5 + Math.random() * 0.9), spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9), age: 0, life: 1.1 + Math.random() * 0.5, kind: "debris", size: 1 });
    }
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color: "#b8ab98", transparent: true, depthWrite: false, opacity: 0.6 }));
      s.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, 0.06));
      this.fx.add(s);
      this.bits.push({ obj: s, vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.15 + Math.random() * 0.2, 0.2), spin: new THREE.Vector3(), age: 0, life: 0.9 + Math.random() * 0.4, kind: "dust", size: 0.1 + Math.random() * 0.06 });
    }
    for (const s of rock.stars) {
      this.fx.remove(s);
      s.material.dispose();
    }
    rock.stars = [];
    rock.mesh.visible = false;
  }

  /** Dust kicked up at a point in the set. */
  private puff(at: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color: "#b8ab98", transparent: true, depthWrite: false, opacity: 0.6 }));
      s.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, 0, 0.02));
      this.fx.add(s);
      this.bits.push({ obj: s, vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.1, 0.15), spin: new THREE.Vector3(), age: 0, life: 0.7, kind: "dust", size: 0.08 });
    }
  }

  /** A word in red over a rock a fall smashed. */
  private showLost(rock: RockObj, text: string) {
    if (rock.told && text === "Smashed") return;
    const precious = text !== "Smashed";
    const tex = textTexture(text, precious ? "#ff5a4a" : "#a89f94");
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    const img = tex.image as HTMLCanvasElement;
    const h = precious ? 0.08 : 0.05;
    label.scale.set((h * img.width) / img.height, h, 1);
    label.renderOrder = 20;
    label.position.copy(rock.home).add(new THREE.Vector3(0, 0.05, 0.12));
    this.fx.add(label);
    this.bits.push({ obj: label, vel: new THREE.Vector3(0, 0.18, 0.04), spin: new THREE.Vector3(), age: 0, life: precious ? 1.6 : 0.8, kind: "loot", size: 0 });
  }

  /** Sparks off the pick's point. A full swing throws more. */
  private sparks(worldAt: THREE.Vector3, power: BlowPower) {
    const at = this.group.worldToLocal(worldAt.clone()).add(new THREE.Vector3(0, 0, CELL * 0.35));
    for (let i = 0; i < 3 + power * 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), color: new THREE.Color(1.6, 1.2, 0.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      s.position.copy(at);
      this.fx.add(s);
      this.bits.push({ obj: s, vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, Math.random() * 1.8, 0.3 + Math.random()), spin: new THREE.Vector3(), age: 0, life: 0.25 + Math.random() * 0.25, kind: "spark", size: 0.035 + power * 0.01 });
    }
  }

  /** What a broken rock gave: a lump of it flying up toward the eye, and its name in its rarity's colour. */
  private showLoot(rock: RockObj, got: Resources) {
    const kinds = Object.entries(got).filter(([, n]) => (n ?? 0) > 0) as [ResourceKind, number][];
    if (kinds.length === 0) return;
    const at = rock.home.clone().add(new THREE.Vector3(0, 0, 0.12));
    for (const [i, [kind, n]] of kinds.entries()) {
      const gem = kind === "gem";
      audio.play(soundName.find(gem ? "gem" : "ore"));
      const rarity = MINE_RARITY[kind as keyof typeof MINE_RARITY];
      const color = rarity?.color ?? RES_COLOR[kind] ?? "#ffffff";
      const tex = textTexture(`+${n} ${kind === "gem" ? (n === 1 ? "Gem" : "Gems") : kind[0].toUpperCase() + kind.slice(1)}`, color);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      const img = tex.image as HTMLCanvasElement;
      label.scale.set((0.08 * img.width) / img.height, 0.08, 1);
      label.renderOrder = 20;
      label.position.copy(at).add(new THREE.Vector3(0, 0.08 + i * 0.09, 0));
      this.fx.add(label);
      this.bits.push({ obj: label, vel: new THREE.Vector3(0, 0.22, 0.05), spin: new THREE.Vector3(), age: 0, life: 1.6, kind: "loot", size: 0 });
      // The lump itself: a cut gem glowing past white, or a nugget of ore.
      const lumpMat = this.track(new THREE.MeshBasicMaterial({ color: gem ? new THREE.Color(2.4, 0.9, 2.2) : new THREE.Color(RES_COLOR[kind] ?? "#ccc").multiplyScalar(1.3) }));
      const lump = new THREE.Mesh(this.track(gem ? new THREE.OctahedronGeometry(0.03) : new THREE.DodecahedronGeometry(0.025)), lumpMat);
      lump.position.copy(at);
      this.fx.add(lump);
      this.bits.push({ obj: lump, vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.9, 0.7), spin: new THREE.Vector3(3, 5, 2), age: 0, life: 1.2, kind: "loot", size: 1 });
      if (gem) this.sparks(this.group.localToWorld(at.clone()), 3);
    }
  }

  // ---------- the camera ----------

  /** WorldMinigame: where the eye is this frame, and how far over to it the camera has come. */
  frame(dt: number, _now: number, aspect: number): { eye: THREE.Vector3; look: THREE.Vector3; blend: number; fov: number } {
    this.inT = this.leaving ? Math.max(0, this.inT - dt / OUT_S) : Math.min(1, this.inT + dt / IN_S);
    this.close = smoother(this.inT);
    if (this.leaving && this.inT <= 0) setTimeout(() => this.finish(), 0);
    return { ...this.shot(aspect), blend: this.close };
  }

  /** Fly back out to the map, then take the set down and give the view back. */
  leave() {
    this.stop();
    this.leaving = true;
  }

  private finish() {
    if (this.disposed) return;
    this.dispose();
    // Only if the view is still ours: another game may have taken it over meanwhile.
    if (this.world.playing === this) this.world.endMinigame();
  }

  /** Where the eye stands to see the whole face, and what it looks at, in world units. */
  private shot(aspect: number): { eye: THREE.Vector3; look: THREE.Vector3; fov: number } {
    if (!this.laidOut) this.layout();
    const w = MINE_COLS * CELL;
    const h = MINE_ROWS * CELL;
    const t = Math.tan(THREE.MathUtils.degToRad(VFOV / 2));
    const halfW = w / 2 + 0.14;
    // A little more room below than above, for the buttons along the bottom of the screen.
    const halfH = h / 2 + 0.16;
    const d = Math.max(halfH / t, halfW / (t * aspect));
    const mid = FACE_FOOT + h / 2 - 0.04;
    const look = this.group.localToWorld(new THREE.Vector3(0, mid, FACE_Z));
    const eye = this.group.localToWorld(new THREE.Vector3(0, mid + 0.05 + d * 0.06, FACE_Z + d));
    return { eye, look, fov: VFOV };
  }

  // ---------- each frame ----------

  private tick(dt: number, camera: THREE.PerspectiveCamera, clock: number) {
    if (this.disposed) return;
    // Replaced by another game (or a second mount of this one): the renderer has taken our group down; free the rest.
    if (this.world.playing !== this) {
      this.dispose();
      return;
    }
    this.clock = clock;
    if (!this.laidOut) this.layout();
    const close = this.close;
    const night = this.world.night;
    // The light: a soft key from the sky that fades at night, and the lantern, which carries the face after dark.
    const L = this.light;
    L.uTime.value = clock;
    L.uKey.value.setRGB(0.75, 0.72, 0.66).multiplyScalar(1 - 0.75 * night);
    L.uAmbient.value.setRGB(0.32, 0.33, 0.4).multiplyScalar(1 - 0.55 * night);
    const flicker = 1 + 0.06 * Math.sin(clock * 13.1) + 0.04 * Math.sin(clock * 7.3);
    L.uLamp.value.copy(LANTERN).multiplyScalar((0.55 + 0.9 * night) * flicker);
    L.uLampPos.value.copy(this.group.localToWorld(this.lampLocal.clone()));

    // The clock, and a buffered tap landing as the pick comes free.
    const now = this.now();
    if (this.running && now !== null) {
      if (now >= this.ms) {
        this.running = false;
        this.timeUp = true;
        this.held = null;
        this.buffered = null;
        this.cb.onTimeUp();
      } else if (this.buffered !== null && now >= this.freeAt()) {
        const id = this.buffered;
        this.buffered = null;
        this.blow(id, 1, now);
      }
    }
    const free = now !== null && now >= this.freeAt();
    this.charge = this.held && now !== null ? Math.min(1, Math.max(0, now - Math.max(this.held.downAt, this.freeAt())) / this.chargeMs) : 0;
    this.cb.onCharge?.(this.charge, free);

    // The rock under the pointer lights up, more as the swing charges.
    const hovered = this.pointer.inside && close > 0.95 && this.running ? this.rockAt(this.pointer.x, this.pointer.y) : null;
    this.hovered = hovered;
    // Everything above the rock under the pick, in its column, would come down if it went: tint it.
    const above = new Set<number>();
    if (hovered !== null) {
      const grid = mineGrid(this.local.rocks);
      const cell = this.rocks[hovered].cell;
      for (let c = cell - MINE_COLS; c >= 0; c -= MINE_COLS) if (grid[c] !== -1) above.add(grid[c]);
    }
    const warn = 0.35 + 0.35 * Math.sin(clock * 6) ** 2;
    for (const rock of this.rocks) {
      const u = rock.mat.uniforms;
      u.uHover.value = rock.id === hovered ? 0.6 + this.charge * 1.4 : 0;
      u.uWarn.value = above.has(rock.id) ? warn : 0;
      rock.flash = Math.max(0, rock.flash - dt * 4);
      u.uFlash.value = rock.flash;
      if (rock.drop) {
        const d = rock.drop;
        d.t += dt;
        const p = Math.min(1, d.t / d.dur);
        rock.mesh.position.lerpVectors(d.from, rock.home, p * p);
        for (const st of rock.stars) st.position.copy(rock.mesh.position).add(st.userData.offset as THREE.Vector3);
        if (p >= 1) this.land(rock);
        continue;
      }
      rock.shake = Math.max(0, rock.shake - dt * 6);
      const j = rock.shake * 0.012;
      rock.mesh.position.set(rock.home.x + (Math.random() - 0.5) * j, rock.home.y + (Math.random() - 0.5) * j, rock.home.z);
      for (const s of rock.stars) {
        const ph = s.userData.phase as number;
        const twinkle = Math.max(0, Math.sin(clock * 3.1 + ph)) ** 6;
        const size = (rock.kind === "geode" ? 0.07 : 0.05) * (0.25 + twinkle);
        s.scale.set(size, size, 1);
        s.material.rotation = clock * 0.8 + ph;
        s.position.copy(rock.mesh.position).add(s.userData.offset as THREE.Vector3);
      }
    }

    // Debris falls and bounces, dust spreads, sparks fly, finds float up toward the eye.
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i];
      b.age += dt;
      const t = b.age / b.life;
      if (b.kind === "debris") {
        b.vel.y -= 3.2 * dt;
        b.obj.position.addScaledVector(b.vel, dt);
        if (b.obj.position.y < 0.02) {
          b.obj.position.y = 0.02;
          b.vel.y *= -0.3;
          b.vel.x *= 0.6;
          b.vel.z *= 0.6;
        }
        b.obj.rotation.x += b.spin.x * dt;
        b.obj.rotation.y += b.spin.y * dt;
        b.obj.scale.setScalar(Math.max(0.01, 1 - Math.max(0, t - 0.7) / 0.3));
      } else if (b.kind === "dust" || b.kind === "spark") {
        b.vel.multiplyScalar(1 - dt * (b.kind === "dust" ? 1.5 : 3));
        if (b.kind === "spark") b.vel.y -= 2.5 * dt;
        b.obj.position.addScaledVector(b.vel, dt);
        const sprite = b.obj as THREE.Sprite;
        const size = b.kind === "dust" ? b.size * (1 + t * 2.5) : b.size * (1 - t);
        sprite.scale.set(size, size, 1);
        sprite.material.opacity = b.kind === "dust" ? 0.55 * (1 - t) : 1;
      } else {
        b.obj.position.addScaledVector(b.vel, dt);
        b.vel.multiplyScalar(1 - dt * 1.2);
        b.obj.rotation.x += b.spin.x * dt;
        b.obj.rotation.y += b.spin.y * dt;
        if (b.obj instanceof THREE.Sprite) b.obj.material.opacity = Math.min(1, (1 - t) * 2.5);
        else b.obj.scale.setScalar(Math.max(0.01, 1 - t * t));
      }
      if (b.age >= b.life) {
        this.fx.remove(b.obj);
        if (b.obj instanceof THREE.Sprite) {
          if (b.kind === "loot") b.obj.material.map?.dispose();
          b.obj.material.dispose();
        }
        this.bits.splice(i, 1);
      }
    }

    // The eye: a slow sway as the player breathes (it is what makes the flecks wink), and a jolt on each blow.
    if (close > 0.98) {
      this.shake = Math.max(0, this.shake - dt * 5);
      const sway = 0.006;
      camera.position.x += Math.sin(clock * 0.9) * sway + (Math.random() - 0.5) * this.shake * 0.012;
      camera.position.y += Math.sin(clock * 1.7) * sway * 0.6 + (Math.random() - 0.5) * this.shake * 0.012;
      camera.updateMatrixWorld();
    }

    this.posePick(camera, close);
  }

  /** The pick, held at the bottom right of the view: raised back as the swing charges, snapping down on a blow. */
  private posePick(camera: THREE.PerspectiveCamera, close: number) {
    this.pick.visible = close > 0.85 && !this.timeUp && !this.leaving;
    if (!this.pick.visible) return;
    this.pick.position.copy(camera.position);
    this.pick.quaternion.copy(camera.quaternion);
    const since = this.clock - this.strikeAt;
    const recover = this.recoverMs / 1000;
    // Strike: 0 at rest, 1 at the bottom of the swing.
    const strike = since < 0.07 ? since / 0.07 : since < recover ? 1 - (since - 0.07) / (recover - 0.07) : 0;
    const s = Math.max(0, strike);
    const raise = this.charge;
    // Ease in from below the screen as the camera arrives.
    const arrive = Math.min(1, (close - 0.85) / 0.15);
    const p = this.pickPivot;
    p.position.set(0.24 - 0.06 * s, -0.3 - 0.2 * (1 - arrive) + 0.04 * raise - 0.04 * s, -0.6);
    p.rotation.set(-0.35 + 0.6 * raise - 1.2 * s * (this.strikePower === 3 ? 1.15 : 1), 0.2 - 0.15 * s, 0.5 - 0.15 * raise + 0.25 * s);
    // A charged pick trembles.
    if (raise > 0.98) p.rotation.z += (Math.random() - 0.5) * 0.03;
  }

  /** Free what this set made. The group itself is the renderer's, taken down by endMinigame. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    this.world.removeObject(this.pick);
    for (const b of this.bits) if (b.obj instanceof THREE.Sprite) b.obj.material.dispose();
    for (const rock of this.rocks) for (const s of rock.stars) s.material.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
  }
}
