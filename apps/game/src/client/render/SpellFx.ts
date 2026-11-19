// What flies through the air and comes up out of the ground in a fight on
// the tiles, and how it lands. It is made of three kinds of piece, each
// matching something the world already draws:
//
// - Light (a bolt's glow, a beam, lightning, a shockwave, the column over a
//   heal) is soft: gradients that fade to nothing at their edges and add to
//   whatever is behind them, as the torch flames do, so the finishing pass
//   blooms them when Fancy graphics is on.
// - Specks (what a bolt sheds, what flies off a hit, a splash's drops, motes
//   rising off someone helped) are pixel motes and sparkles, the same as an XP
//   burst and a blow's slash (sprites.ts fxTexture).
// - Things (an arrow, a flask, a falling rock, thorns, coral, stone, chips of
//   earth and glass) are small low-poly models in flat colours, like the rest
//   of the world, shaded dark at the root and bright at the tip.
//
// And in a delve, glints spilling out of a chest thrown open, and splinters
// flying off a crate. Most of it is alive for under a second.
//
// It draws through the renderer's public hooks and knows nothing of the
// rules: the view says what to play, where, and what to do when it lands.

import * as THREE from "three";
import { OUTLINE } from "./figures";
import { fxTexture, type FxKind } from "./sprites";
import { flickerFlame, torchFlame } from "./torchFlame";
import type { WorldRenderer } from "./WorldRenderer";

/** Something that flies from one point to another. */
export type Missile = "arrow" | "bolt" | "flask" | "meteor";

/**
 * What comes up out of the ground over the hexes a spell covers: thorns or kelp winding up round whoever stands there,
 * coral, stone pillars, a spout of water, a shaft of light falling on each, or rust spreading over them.
 */
export type EruptStyle = "thorn" | "kelp" | "coral" | "stone" | "water" | "shine" | "rust";

/**
 * Seconds a lasting effect (a song, the Black Spot) waits before asking whether it still holds: the condition it
 * shows comes up in the fight's playback a beat or two after the cast that put it on.
 */
const GRACE = 2.5;

/** How a song moves its notes: a lively shanty's bob up, a dour one's rise slowly and sink back, the wind-god's swirl. */
export type SongMood = "lively" | "dour" | "wind";

/** A blow of sound (see SpellFx.sound): plain, heavy (Lead by Example), ringing like a bell (Peal), or out of tune (Dissonance). */
export type SoundKind = "plain" | "heavy" | "bell" | "discord";

/** Vines caught round someone (see SpellFx.wrap): where their feet are now (null once they are gone), and whether they are still caught. */
export interface Binding {
  /** Who is caught: vines caught round them again send the old ones withering. */
  key: string;
  follow: () => THREE.Vector3 | null;
  holding: () => boolean;
}

interface Live {
  /** Advance by `dt` seconds. Returns false when it is over, and has taken its own pieces away. */
  step(dt: number): boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color("#ffffff");
const sphere = new THREE.SphereGeometry(1, 8, 6);
const rock = new THREE.IcosahedronGeometry(1, 0);
const shaft = new THREE.BoxGeometry(1, 1, 1);
const diamond = new THREE.OctahedronGeometry(1, 0);
const plane = new THREE.PlaneGeometry(1, 1);
const tube = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
const arrowhead = new THREE.ConeGeometry(1, 1, 4);
/** A hex standing up off the ground, open at both ends, its corners on the tile's own (the map's hexes are pointy at ±z, as a six-sided cylinder is). */
const hexWall = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const hexRim = new THREE.RingGeometry(0.9, 1, 6, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2);

/**
 * A shape made to stand on the ground, its foot at 0 and its top at 1, shaded from dark at the root to bright at the
 * tip (the vertex colours multiply the material's own), so what grows out of the ground reads as grown, not cut out.
 */
function standing(geometry: THREE.BufferGeometry, root = 0.42, tip = 1.25): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeBoundingBox();
  const box = g.boundingBox!;
  g.translate(0, -box.min.y, 0);
  g.scale(1, 1 / (box.max.y - box.min.y), 1);
  const pos = g.getAttribute("position");
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = root + (tip - root) * pos.getY(i);
    colors.push(k, k, k);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

const THORN = standing(new THREE.ConeGeometry(1, 1, 5));
const CORAL = standing(new THREE.CylinderGeometry(0.5, 1, 1, 5), 0.5, 1.2);
const KNOB = standing(new THREE.IcosahedronGeometry(1, 0), 0.9, 1.35);
const PILLAR = standing(new THREE.CylinderGeometry(0.82, 1, 1, 6), 0.45, 1.1);
const SPOUT = standing(new THREE.CylinderGeometry(0.25, 1, 1, 9, 1, true), 1.2, 0.35);
/**
 * A breaking wave, side on: a long back rising to a crest that curls forward over a steep face. Drawn along x (the
 * way it rolls) and up y, a hex wide in z, shaded from dark water at its foot to white foam at its crest.
 */
const WAVE = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(-1.1, 0);
  shape.bezierCurveTo(-0.6, 0.15, -0.25, 0.55, 0.05, 0.95);
  shape.bezierCurveTo(0.2, 1.05, 0.45, 0.98, 0.52, 0.8);
  shape.bezierCurveTo(0.38, 0.84, 0.3, 0.7, 0.32, 0.5);
  shape.lineTo(0.3, 0);
  shape.lineTo(-1.1, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 5 }).translate(0, 0, -0.5);
  return standing(g, 0.55, 1.9);
})();
/** Lightning's light, beat by beat (each 0.05s): on, off, on, stuttering as it dies. */
const LIGHTNING_FLICKER = [1, 0.4, 1, 0.85, 0.3, 0.8, 0.45, 0.2];
/** Seconds from a thunderclap's bolt coming down on the caster's hand to its crescents setting off. */
const THUNDER_LEAD = 0.12;
/** Seconds a wave takes to roll one world unit. */
export const WAVE_PACE = 1 / 4.4;

/** A flask: a round belly, a neck, and a cork in it, standing about its middle so it tumbles about it. */
const BOTTLE = new THREE.LatheGeometry(
  [[0, 0], [0.55, 0.04], [0.82, 0.3], [0.8, 0.62], [0.45, 0.86], [0.26, 0.96], [0.26, 1.2], [0, 1.2]].map(([x, y]) => new THREE.Vector2(x, y)),
  7,
).translate(0, -0.6, 0);
const CORK = new THREE.CylinderGeometry(0.2, 0.18, 0.28, 6).translate(0, 0.72, 0);

/** A greyscale canvas texture, drawn the first time it is wanted and kept: the soft shapes the light is cut from. */
function painted(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): () => THREE.Texture {
  let made: THREE.Texture | null = null;
  return () => {
    if (made) return made;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    paint(canvas.getContext("2d")!);
    made = new THREE.CanvasTexture(canvas);
    return made;
  };
}
const radial = (ctx: CanvasRenderingContext2D, size: number, stops: [number, number][]) => {
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
};
const linear = (ctx: CanvasRenderingContext2D, w: number, h: number, stops: [number, number][]) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
};
/** A soft round glow: bright in the middle, gone at the edge. */
const softTex = painted(64, 64, (ctx) => radial(ctx, 64, [[0, 1], [0.18, 0.75], [0.45, 0.22], [1, 0]]));
/** A shockwave: a bright band just inside its edge, a faint wash inside that, nothing outside. */
const ringTex = painted(128, 128, (ctx) => radial(ctx, 128, [[0, 0.04], [0.6, 0.1], [0.8, 0.5], [0.9, 1], [0.95, 0.4], [1, 0]]));
/** Across a streak of light (a beam, a bolt's tail, lightning): nothing at the edges, white down the middle. */
const streakTex = painted(4, 32, (ctx) => linear(ctx, 4, 32, [[0, 0], [0.28, 0.25], [0.5, 1], [0.72, 0.25], [1, 0]]));
/** Up a column of light: strong at its foot, gone at its head. */
const columnTex = painted(4, 64, (ctx) => linear(ctx, 4, 64, [[0, 0], [0.55, 0.25], [0.92, 0.85], [1, 0.5]]));

/** What a flung speck is: one of the pixel effects (sprites.ts), or a drop of water. */
type Speck = FxKind | "drop";

/**
 * A drop of water in `color`: round and soft-edged, not a pixel square, darker at its rim and with a white glint
 * high on one side, so a splash reads as water. Drawn once for each colour and kept.
 */
const drops = new Map<string, THREE.Texture>();
function dropTexture(color: string): THREE.Texture {
  const made = drops.get(color);
  if (made) return made;
  const N = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const rim = `#${new THREE.Color(color).multiplyScalar(0.7).getHexString()}`;
  // About as wide as a pixel mote is in its tile, so a splash keeps the size of the motes round it.
  const body = ctx.createRadialGradient(N * 0.45, N * 0.45, 0, N / 2, N / 2, N * 0.17);
  body.addColorStop(0, paler(color, 0.35));
  body.addColorStop(0.75, color);
  body.addColorStop(1, rim);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(N / 2, N / 2, N * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(N * 0.45, N * 0.43, N * 0.05, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  drops.set(color, tex);
  return tex;
}

/**
 * The mark a Hex leaves on the ground: a spiral winding in (a slow curse), framed by a hexagon the shape of the map's
 * own tiles, with a dot at each corner. White, to be tinted.
 */
const sigilTex = painted(128, 128, (ctx) => {
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  // The frame: a pointy-topped hexagon, as the tiles are.
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const [x, y] = [64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56];
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  // The spiral: three turns winding in to the middle, thinning as it goes.
  const turns = 3;
  let last: [number, number] | null = null;
  for (let i = 0; i <= 180; i++) {
    const t = i / 180;
    const a = t * turns * Math.PI * 2;
    const r = 42 * (1 - t) + 3;
    const p: [number, number] = [64 + Math.cos(a) * r, 64 + Math.sin(a) * r];
    if (last) {
      ctx.lineWidth = 5 - 3 * t;
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    last = p;
  }
});
/** The Black Spot: a ragged black blot on a scrap of old paper, splattered at its edge. */
const blotTex = painted(64, 64, (ctx) => {
  ctx.fillStyle = "#e8dcc0";
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 27 + (i % 3) * 2;
    if (i === 0) ctx.moveTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    else ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  ctx.fill();
  ctx.strokeStyle = "#1b1830";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#14101c";
  ctx.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = 15 + ((i * 7) % 5) - 1;
    if (i === 0) ctx.moveTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    else ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  ctx.fill();
  for (const [x, y, r] of [[52, 20, 3], [14, 44, 2.5], [46, 50, 2], [18, 16, 2]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
});

/** Light: added over whatever is behind it, and never hiding anything. */
const light = (color: string, opacity = 1, map?: THREE.Texture) =>
  new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
/** Colour laid over what is behind it, soft-edged by its texture: a light's body, which still shows on bright ground. */
const tinted = (color: string, opacity = 1, map?: THREE.Texture) => new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
const glow = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
const flat = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: true });
/** Something grown out of the ground (see `standing`); `shine` gives it a little light of its own. */
const grown = (color: string, shine = 0) =>
  new THREE.MeshLambertMaterial({ color, vertexColors: true, flatShading: true, transparent: true, emissive: new THREE.Color(color).multiplyScalar(shine) });
/** How thick the ink round vines is, in world units: about a figure's line, seen from the fight's camera. */
const INK_EDGE = 0.022;
/** Three hard bands of light, for cel shading (MeshToonMaterial's gradientMap): shade, lit, and a highlight. */
let ramp: THREE.DataTexture | null = null;
export const toonRamp = () => {
  if (ramp) return ramp;
  ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
};
/** A colour taken `k` of the way to another. */
const mix = (color: string, to: string, k: number) => `#${new THREE.Color(color).lerp(new THREE.Color(to), k).getHexString()}`;
/** A colour taken `k` of the way to white. */
const paler = (color: string, k: number) => `#${new THREE.Color(color).lerp(WHITE, k).getHexString()}`;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
/** Overshoots a little and settles: what springs up out of the ground. */
const springOut = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

/**
 * A flat strip of light along a run of points, turned each time it is laid to face the eye: a beam, a bolt's tail,
 * a stroke of lightning. Its texture runs across it, so it is soft at both edges.
 */
class Ribbon {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private pos: Float32Array;
  private attr: THREE.BufferAttribute;

  constructor(
    readonly n: number,
    material: THREE.MeshBasicMaterial,
  ) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 6);
    const uv = new Float32Array(n * 4);
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      uv.set([u, 0, u, 1], i * 4);
      if (i < n - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    g.setAttribute("position", this.attr);
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.userData.ownGeometry = true;
  }

  get material() {
    return this.mesh.material;
  }

  /** Lay it along `points` (the last repeated if there are fewer than it has), `width(t)` across at `t` of the way along. */
  lay(points: THREE.Vector3[], width: (t: number) => number, eye: THREE.Vector3) {
    const along = new THREE.Vector3();
    const toEye = new THREE.Vector3();
    const side = new THREE.Vector3();
    const last = points.length - 1;
    for (let i = 0; i < this.n; i++) {
      const j = Math.min(i, last);
      const p = points[j];
      along.subVectors(points[Math.min(last, j + 1)], points[Math.max(0, j - 1)]);
      if (along.lengthSq() < 1e-10) along.set(1, 0, 0);
      side.crossVectors(along, toEye.subVectors(eye, p));
      if (side.lengthSq() < 1e-10) side.set(0, 1, 0);
      side.normalize().multiplyScalar(width(i / (this.n - 1)) / 2);
      this.pos.set([p.x - side.x, p.y - side.y, p.z - side.z, p.x + side.x, p.y + side.y, p.z + side.z], i * 6);
    }
    this.attr.needsUpdate = true;
  }
}

/** `n` points back along `trail` (newest first), spread evenly over `length` of it. */
function behind(trail: THREE.Vector3[], length: number, n: number): THREE.Vector3[] {
  const out = [trail[0]];
  let walked = 0;
  let i = 0;
  for (let k = 1; k < n; k++) {
    const want = (length * k) / (n - 1);
    while (i < trail.length - 1 && walked + trail[i].distanceTo(trail[i + 1]) < want) walked += trail[i].distanceTo(trail[i + 1]), i++;
    if (i >= trail.length - 1) {
      out.push(trail[trail.length - 1]);
      continue;
    }
    const seg = trail[i].distanceTo(trail[i + 1]);
    out.push(trail[i].clone().lerp(trail[i + 1], seg > 0 ? (want - walked) / seg : 0));
  }
  return out;
}

export class SpellFx {
  /** Dev server only: how fast the effects run (0.1 to watch one in slow motion), set from the console as `__gqZone.fx.speed`. */
  speed = 1;
  private group = new THREE.Group();
  private live: Live[] = [];
  private stop: () => void;
  /** Where the camera is, so a streak of light can be turned to face it. */
  private eye = new THREE.Vector3(0, 20, 20);
  /** Seconds of effects run, for flickering a meteor's flame. */
  private clock = 0;
  /**
   * Real light thrown on the ground and whoever stands near by a lightning strike, a meteor, a bolt going past, a
   * beam or a heal. A few lights always in the scene, dark until one is borrowed (see `lamp`), so lighting one up
   * never changes the number of lights and recompiles every material, just as the caverns' torches do.
   */
  private lights = Array.from({ length: 3 }, () => ({ light: new THREE.PointLight("#ffffff", 0, 7, 1.5), held: 0, since: 0 }));
  private lent = 0;
  /** The vines round each one caught (see wrap), by Binding key: how to send them withering. */
  private bound = new Map<string, () => void>();

  constructor(private renderer: WorldRenderer) {
    renderer.addObject(this.group);
    for (const { light } of this.lights) this.group.add(light);
    this.stop = renderer.addTicker((dt, camera) => {
      this.eye.copy(camera.position);
      const step = Math.min(dt, 0.05) * this.speed;
      this.clock += step;
      // An effect may start others as it steps (a bolt landing throws sparks and a ring): those go on the fresh list,
      // and are kept with whatever is still running. Filtering the list in place would lose them, left in the scene for good.
      const stepping = this.live;
      this.live = [];
      const going = stepping.filter((fx) => fx.step(step));
      this.live = [...going, ...this.live];
    });
  }

  dispose() {
    this.stop();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.material) (mesh.material as THREE.Material).dispose();
      if (o.userData.ownGeometry) mesh.geometry?.dispose();
    });
    this.renderer.removeObject(this.group);
  }

  private add<T extends THREE.Object3D>(obj: T): T {
    this.group.add(obj);
    return obj;
  }

  private drop(...objs: (THREE.Object3D | null)[]) {
    for (const o of objs) {
      if (!o) continue;
      this.group.remove(o);
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (mesh.material) (mesh.material as THREE.Material).dispose();
        // Shared shapes are kept; one made for this piece alone (a ribbon, a flame's tongues) goes with it.
        if (c.userData.ownGeometry) mesh.geometry?.dispose();
      });
    }
  }

  /** Step `step` every frame, with the seconds since it began, until it returns false; then take `parts` away. */
  private run(parts: (THREE.Object3D | null)[], step: (age: number, dt: number) => boolean) {
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        if (step(age, dt)) return true;
        this.drop(...parts);
        return false;
      },
    });
  }

  /**
   * Borrow one of the lights (a free one, or else the one lent longest ago, taken back from whatever had it). Returns
   * how to place it and set how bright it is; setting it to 0 hands it back.
   */
  private lamp(color: string, reach: number): (at: THREE.Vector3, intensity: number) => void {
    const slot = this.lights.find((s) => !s.held) ?? this.lights.reduce((a, b) => (a.since <= b.since ? a : b));
    const id = ++this.lent;
    Object.assign(slot, { held: id, since: this.clock });
    slot.light.color.set(color);
    slot.light.distance = reach;
    return (at, intensity) => {
      if (slot.held !== id) return;
      slot.light.position.copy(at);
      slot.light.intensity = Math.max(0, intensity);
      if (intensity <= 0) slot.held = 0;
    };
  }

  /** A light at a point for a moment: up at once to `peak`, then dying away over `life` seconds; `flicker` stutters it, as lightning does. */
  private lightUp(at: THREE.Vector3, color: string, peak: number, reach: number, life: number, flicker?: number[]) {
    const set = this.lamp(color, reach);
    const where = at.clone().setY(at.y + 0.8);
    this.run([], (age) => {
      const k = Math.min(1, age / life);
      const beat = flicker ? (flicker[Math.floor(age / 0.05)] ?? 0.3) : 1;
      set(where, k < 1 ? peak * beat * (1 - k) ** 2 : 0);
      return k < 1;
    });
  }

  /** Run `go` once, `seconds` of effect time from now. */
  private later(seconds: number, go: () => void) {
    this.run([], (age) => (age < seconds ? true : (go(), false)));
  }

  /** A soft round glow, always facing the eye. */
  private halo(at: THREE.Vector3, color: string, size: number, opacity = 1): THREE.Sprite {
    const s = this.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending })));
    s.position.copy(at);
    s.scale.setScalar(size);
    return s;
  }

  /** One speck, `size` across its whole tile: a pixel mote, a cluster of pixel sparkles, or a round drop of water. */
  private speck(kind: Speck, color: string, at: THREE.Vector3, size: number): THREE.Sprite {
    const map = kind === "drop" ? dropTexture(color) : fxTexture(kind, color);
    const s = this.add(new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false })));
    s.position.copy(at);
    s.scale.setScalar(size);
    s.renderOrder = 6;
    return s;
  }

  /** A sheet of light lying flat on the ground. */
  private sheet(at: THREE.Vector3, color: string, map: THREE.Texture, opacity: number) {
    const m = this.add(new THREE.Mesh(plane, light(color, opacity, map)));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(at);
    m.renderOrder = 3;
    return m;
  }

  /** How long a hurled pike takes to fly `distance`, in seconds. */
  static pikeTime(distance: number): number {
    return Math.max(0.2, Math.min(0.6, distance / 14));
  }

  /** How long a thunderclap takes to reach what is `distance` off, in seconds: the bolt on the hand, then the crossing. */
  static thunderTime(distance: number): number {
    return THUNDER_LEAD + Math.max(0.18, Math.min(0.45, distance / 16));
  }

  /** How high the arc of a throw or a shot stands over the straight line between its ends. */
  static arcHeight(kind: Missile | "spell", distance: number): number {
    return kind === "flask" ? 1.3 + distance * 0.22 : kind === "arrow" ? 0.35 + distance * 0.09 : kind === "meteor" ? 0 : 0.25 + distance * 0.04;
  }

  /** A point `t` of the way along an arc from `from` to `to`. */
  static arcPoint(from: THREE.Vector3, to: THREE.Vector3, height: number, t: number): THREE.Vector3 {
    return from.clone().lerp(to, t).addScaledVector(UP, height * 4 * t * (1 - t));
  }

  /**
   * Send something flying from `from` to `to`: an arrow with a faint streak of air behind it, a bolt of light with a
   * tail shedding motes, a flask tumbling and dripping, or a burning rock out of the sky trailing fire and smoke.
   * `onLand` runs as it arrives, as it breaks or bursts there. Returns how long the flight takes, in seconds.
   */
  launch(kind: Missile, from: THREE.Vector3, to: THREE.Vector3, color: string, onLand?: () => void): number {
    // A meteor comes down out of the sky, wherever it was called from.
    const start = kind === "meteor" ? to.clone().add(new THREE.Vector3(-3.5, 9, -2)) : from.clone();
    const distance = start.distanceTo(to);
    const speed = kind === "arrow" ? 15 : kind === "bolt" ? 11 : kind === "flask" ? 7.5 : 19;
    const time = Math.max(0.22, Math.min(0.95, distance / speed));
    const height = SpellFx.arcHeight(kind, distance);
    const body = kind === "arrow" ? this.arrow(color) : kind === "flask" ? this.flask(color) : kind === "meteor" ? this.meteor() : this.orb(color);
    body.position.copy(start);
    // What it leaves behind it: a streak of air, a tail of light, a trail of fire.
    const tail =
      kind === "flask"
        ? null
        : new Ribbon(kind === "arrow" ? 6 : 14, kind === "bolt" ? tinted(color, 0.9, streakTex()) : light(kind === "meteor" ? "#f08a24" : "#ffffff", kind === "arrow" ? 0.35 : 0.85, streakTex()));
    if (tail) this.add(tail.mesh);
    const reach = kind === "arrow" ? 0.9 : kind === "meteor" ? 2.4 : 1.3;
    const width = kind === "arrow" ? (t: number) => 0.06 * (1 - t) : kind === "meteor" ? (t: number) => 0.75 * (1 - t) ** 1.2 : (t: number) => 0.5 * (1 - t) ** 1.3 + 0.02;
    const flame = kind === "meteor" ? this.add(torchFlame(0.36)) : null;
    // A bolt or a burning rock lights the ground under it as it goes.
    const carried = kind === "bolt" || kind === "meteor" ? this.lamp(kind === "meteor" ? "#ff9a3a" : color, kind === "meteor" ? 7 : 4) : null;
    flame?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.ownGeometry = true;
    });
    const trail: THREE.Vector3[] = [start.clone()];
    let shed = 0;
    let t = 0;
    this.live.push({
      step: (dt) => {
        t += dt / time;
        const at = SpellFx.arcPoint(start, to, height, Math.min(1, t));
        const ahead = SpellFx.arcPoint(start, to, height, Math.min(1, t) + 0.02);
        body.position.copy(at);
        if (kind === "arrow") body.lookAt(ahead);
        else if (kind === "flask") body.rotation.set(t * 14, t * 5, 0);
        else if (kind === "meteor") body.rotation.set(t * 6, t * 4, 0);
        else body.children[3].rotation.set(t * 9, t * 13, 0);
        trail.unshift(at);
        if (trail.length > 120) trail.pop();
        // The tail grows out of it as it leaves the hand, rather than being there at once.
        tail?.lay(behind(trail, reach * Math.min(1, t * 3), tail.n), width, this.eye);
        carried?.(at, kind === "meteor" ? 14 : 5);
        if (flame) {
          // The flame streams out behind it.
          const back = at.clone().sub(ahead);
          if (back.lengthSq() > 1e-8) flame.quaternion.setFromUnitVectors(UP, back.normalize());
          flame.position.copy(at);
          flickerFlame(flame, this.clock);
        }
        shed -= dt;
        if (shed <= 0 && t < 1) {
          if (kind === "bolt") {
            this.fling(at, color, 1, { out: 0.35, up: 0.35, fall: 0, life: 0.4, size: 0.42 });
            shed = 0.03;
          } else if (kind === "meteor") {
            this.smoke(at, "#5f5852", 0.7);
            this.fling(at, "#ffb347", 1, { out: 0.7, up: 0.8, fall: 2, life: 0.5 });
            shed = 0.035;
          } else if (kind === "flask") {
            this.fling(at, color, 1, { out: 0.2, up: 0, fall: 5, life: 0.35, size: 0.34 , kind: "drop" });
            shed = 0.07;
          } else shed = Infinity;
        }
        if (t < 1) return true;
        this.drop(body, tail?.mesh ?? null, flame);
        carried?.(at, 0);
        if (kind === "arrow") {
          this.flash(to, "#fff1c9", 0.55);
          this.fling(to, color, 5, { out: 1.4, up: 1.6 });
        } else if (kind === "bolt") this.burst(to, color, 10);
        else if (kind === "flask") this.shatter(to, color);
        else this.crash(to);
        onLand?.();
        return false;
      },
    });
    return time;
  }

  /**
   * A thunderclap from `from` at `to`: a flash at the hands, three crescents of sound and light racing out one after
   * another and swelling as they go, and where they land a clap of light, sparks, dust thrown up and a ring rolling
   * across the ground. `onLand` runs as the first crescent arrives. Returns how long it takes to get there.
   */
  thunder(from: THREE.Vector3, to: THREE.Vector3, color: string, onLand?: () => void): number {
    const dir = to.clone().sub(from).setY(0);
    const distance = dir.length();
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const time = SpellFx.thunderTime(distance);
    // The sky answers: a bolt down onto the hand that calls it, the thunder heard and the sky lit with it, and the
    // ground shaken; a blinding flash there, and a wave of dust rolling out from the caster's feet.
    this.spark([from.clone().add(new THREE.Vector3(rand(0.3, 0.6), 8, rand(-0.5, -0.2))), from], paler(color, 0.5), 1.6);
    this.flash(from, paler(color, 0.4), 3);
    this.lightUp(from, paler(color, 0.6), 45, 8, 0.6, LIGHTNING_FLICKER);
    this.renderer.thunderclap();
    this.renderer.shake(0.3, 0.5);
    const feet = from.clone().setY(from.y - 0.85);
    this.ring(feet, 3.2, paler(color, 0.3), 0.6);
    this.ring(feet, 2.2, "#c9b994", 0.5);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.smoke(feet.clone().add(new THREE.Vector3(Math.cos(a) * 0.6, 0.15, Math.sin(a) * 0.6)), "#c9bfa8", 0.9, 0.6);
    }
    // Lightning crackling along the way the clap goes.
    this.later(THUNDER_LEAD, () => this.spark([from, to], color, 1.3));
    const N = 14;
    // Inked, as the vines are: a dark edge, the colour, and a white-hot heart.
    const waves = [0, 1, 2, 3].map((i) => {
      const edge = new Ribbon(N, tinted(OUTLINE, 0.55, streakTex()));
      const glow = new Ribbon(N, tinted(color, 1, streakTex()));
      const core = new Ribbon(N, light("#ffffff", 1, streakTex()));
      edge.mesh.renderOrder = 4;
      glow.mesh.renderOrder = 5;
      core.mesh.renderOrder = 6;
      for (const r of [edge, glow, core]) this.add(r.mesh);
      return { edge, glow, core, late: THUNDER_LEAD + i * 0.06 };
    });
    const cross = time - THUNDER_LEAD;
    let landed = false;
    this.run(
      waves.flatMap((w) => [w.edge.mesh, w.glow.mesh, w.core.mesh]),
      (age) => {
        let alive = false;
        for (const w of waves) {
          const k = (age - w.late) / cross;
          if (k <= 0 || k >= 1.25) {
            w.edge.material.opacity = w.glow.material.opacity = w.core.material.opacity = 0;
            if (k <= 0) alive = true;
            continue;
          }
          alive = true;
          // A ")" facing the way it goes, swelling as it travels, gone just past the mark.
          const at = from.clone().addScaledVector(dir, distance * Math.min(1.1, k));
          const r = 0.5 + 0.9 * Math.min(1, k);
          const arc = Array.from({ length: N }, (_, j) => {
            const a = -1.15 + (2.3 * j) / (N - 1);
            return at.clone().addScaledVector(dir, Math.cos(a) * r * 0.55 - r * 0.4).addScaledVector(side, Math.sin(a) * r);
          });
          const o = k < 1 ? 1 : 1 - (k - 1) / 0.25;
          w.edge.material.opacity = 0.55 * o;
          w.glow.material.opacity = o;
          w.core.material.opacity = o;
          w.edge.lay(arc, (t) => 0.75 * Math.sin(Math.PI * t), this.eye);
          w.glow.lay(arc, (t) => 0.55 * Math.sin(Math.PI * t), this.eye);
          w.core.lay(arc, (t) => 0.18 * Math.sin(Math.PI * t), this.eye);
        }
        if (!landed && age >= time) {
          landed = true;
          const ground = to.clone().setY(to.y - 0.75);
          this.flash(to, color, 3);
          this.lightUp(to, paler(color, 0.5), 50, 8, 0.55, LIGHTNING_FLICKER);
          this.renderer.shake(0.18, 0.3);
          this.fling(to, color, 16, { out: 3, up: 3 });
          this.fling(to, "#ffffff", 6, { out: 2.2, up: 2.4, size: 0.4, life: 0.45 });
          this.ring(ground, 2.2, paler(color, 0.3), 0.45);
          this.chips(ground, "#7d756a", 6, 0.08);
          for (let i = 0; i < 4; i++) this.smoke(ground.clone().add(new THREE.Vector3(rand(-0.3, 0.3), 0.15, rand(-0.3, 0.3))), "#b8ae9c", 0.8, 0.55);
          onLand?.();
        }
        return alive || !landed;
      },
    );
    return time;
  }

  /**
   * A blade of wind from `from` at `to`: a pale crescent skimming low, wind lines streaming off it, and as it leaves
   * a gust swirling up round the feet of whoever sent it; where it lands it cuts across in a spray of pale specks and
   * a puff of air. `onLand` runs as it arrives. Returns how long it takes to get there.
   */
  blade(from: THREE.Vector3, to: THREE.Vector3, color: string, onLand?: () => void): number {
    const distance = from.distanceTo(to);
    const time = Math.max(0.2, Math.min(0.7, distance / 13));
    const height = SpellFx.arcHeight("spell", distance);
    // The gust that carries its sender.
    const feet = from.clone().setY(from.y - 0.85);
    this.ring(feet, 1.1, color, 0.4);
    for (let i = 0; i < 4; i++) this.smoke(feet.clone().add(new THREE.Vector3(rand(-0.35, 0.35), 0.15, rand(-0.35, 0.35))), "#eef7ff", 0.7, 0.55);
    const N = 14;
    const edge = new Ribbon(N, tinted(OUTLINE, 0.35, streakTex()));
    const body = new Ribbon(N, tinted(color, 0.95, streakTex()));
    const core = new Ribbon(N, light("#ffffff", 1, streakTex()));
    edge.mesh.renderOrder = 4;
    body.mesh.renderOrder = 5;
    core.mesh.renderOrder = 6;
    this.add(edge.mesh);
    const offsets = [-0.32, -0.1, 0.12, 0.3];
    const lines = offsets.map(() => new Ribbon(6, light("#ffffff", 0.5, streakTex())));
    for (const r of [body, core, ...lines]) this.add(r.mesh);
    const trail: THREE.Vector3[] = [from.clone()];
    let shed = 0;
    let t = 0;
    this.live.push({
      step: (dt) => {
        t += dt / time;
        const at = SpellFx.arcPoint(from, to, height, Math.min(1, t));
        const ahead = SpellFx.arcPoint(from, to, height, Math.min(1, t) + 0.02);
        const dir = ahead.clone().sub(at).setY(0);
        if (dir.lengthSq() < 1e-8) dir.copy(to).sub(from).setY(0);
        dir.normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        // A crescent bowed forward, horns trailing, a little tilted as it skims.
        const arc = Array.from({ length: N }, (_, j) => {
          const a = -1.25 + (2.5 * j) / (N - 1);
          return at.clone().addScaledVector(dir, (Math.cos(a) - 1) * 0.32).addScaledVector(side, Math.sin(a) * 0.55).addScaledVector(UP, Math.sin(a) * 0.12);
        });
        edge.lay(arc, (u) => 0.3 * Math.sin(Math.PI * u) ** 0.8, this.eye);
        body.lay(arc, (u) => 0.2 * Math.sin(Math.PI * u) ** 0.8, this.eye);
        core.lay(arc, (u) => 0.06 * Math.sin(Math.PI * u), this.eye);
        trail.unshift(at);
        if (trail.length > 120) trail.pop();
        const back = behind(trail, 1.1 * Math.min(1, t * 3), 6);
        lines.forEach((l, i) => l.lay(back.map((p, j) => p.clone().addScaledVector(side, offsets[i] * (1 - j * 0.08)).addScaledVector(UP, (i % 2 ? 0.06 : -0.04))), (u) => 0.045 * (1 - u), this.eye));
        shed -= dt;
        if (shed <= 0 && t < 1) {
          this.fling(at, "#ffffff", 1, { out: 0.5, up: 0.3, fall: 0, life: 0.35, size: 0.36 });
          shed = 0.04;
        }
        if (t < 1) return true;
        this.drop(edge.mesh, body.mesh, core.mesh, ...lines.map((l) => l.mesh));
        this.flash(to, color, 1.1);
        this.fling(to, color, 9, { out: 2.4, up: 1.6, fall: 4 });
        this.fling(to, "#ffffff", 4, { out: 1.8, up: 1.2, fall: 4, size: 0.4, life: 0.4 });
        for (let i = 0; i < 2; i++) this.smoke(to.clone().add(new THREE.Vector3(rand(-0.2, 0.2), 0, rand(-0.2, 0.2))), "#eef7ff", 0.8, 0.6);
        onLand?.();
        return false;
      },
    });
    return time;
  }

  /** An arrow: a wooden shaft, a steel head and fletching in its colour, pointing along +z (as lookAt aims it). */
  private arrow(color: string): THREE.Group {
    const g = this.add(new THREE.Group());
    const stick = new THREE.Mesh(shaft, flat("#8a6238"));
    stick.scale.set(0.035, 0.035, 0.6);
    const head = new THREE.Mesh(arrowhead, flat("#dfe5ec"));
    head.scale.set(0.055, 0.16, 0.055);
    head.rotation.x = Math.PI / 2;
    head.position.z = 0.36;
    g.add(stick, head);
    for (const r of [0, Math.PI / 2]) {
      const vane = new THREE.Mesh(shaft, flat(color));
      vane.scale.set(0.012, 0.1, 0.15);
      vane.rotation.z = r;
      vane.position.z = -0.23;
      g.add(vane);
    }
    g.scale.setScalar(1.5);
    return g;
  }

  /** A flask: the colour of what is in it, glowing a little, with a cork in its neck. */
  private flask(color: string): THREE.Group {
    const g = this.add(new THREE.Group());
    const body = new THREE.Mesh(BOTTLE, new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: new THREE.Color(color).multiplyScalar(0.35) }));
    const cork = new THREE.Mesh(CORK, flat("#9a7046"));
    g.add(body, cork);
    g.scale.setScalar(0.32);
    return g;
  }

  /** A bolt of light: a soft glow round a white heart, and a little spinning crystal of light at its middle. */
  private orb(color: string): THREE.Group {
    const g = this.add(new THREE.Group());
    // Its colour first, laid over the ground so it shows on bright grass, then light on top of that.
    for (const [c, size, add] of [[color, 0.7, false], [color, 1.3, true], ["#ffffff", 0.4, true]] as const) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex(), color: c, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending }));
      s.scale.setScalar(size);
      g.add(s);
    }
    const heart = new THREE.Mesh(diamond, glow(paler(color, 0.6), 1));
    heart.scale.setScalar(0.1);
    g.add(heart);
    return g;
  }

  /** A rock out of the sky: dark stone in a hot glow. Its fire is a torch flame, set streaming behind it as it flies. */
  private meteor(): THREE.Group {
    const g = this.add(new THREE.Group());
    const stone = new THREE.Mesh(rock, flat("#4a443d"));
    stone.scale.setScalar(0.4);
    const heat = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex(), color: "#ff8a2a", transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    heat.scale.setScalar(1.7);
    g.add(heat, stone);
    return g;
  }

  /** A puff of smoke, drifting up and spreading as it thins. */
  private smoke(at: THREE.Vector3, color: string, size: number, thick = 0.45) {
    const puff = this.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex(), color, transparent: true, opacity: thick, depthWrite: false })));
    puff.position.copy(at).add(new THREE.Vector3(rand(-0.1, 0.1), 0, rand(-0.1, 0.1)));
    const drift = new THREE.Vector3(rand(-0.15, 0.15), rand(0.4, 0.8), rand(-0.15, 0.15));
    this.run([puff], (age, dt) => {
      const k = Math.min(1, age / 0.8);
      puff.position.addScaledVector(drift, dt);
      puff.scale.setScalar(size * (0.6 + k * 1.4));
      puff.material.opacity = thick * (1 - k);
      return k < 1;
    });
  }

  /**
   * Pixel specks thrown out from a point, pulled down as they fade (or, with `fall` below 0, drifting up): what
   * flies off a hit, a splash's drops, embers, rust flakes.
   */
  private fling(at: THREE.Vector3, color: string, count: number, o: { out?: number; up?: number; fall?: number; life?: number; size?: number; kind?: Speck } = {}) {
    const { out = 2.2, up = 2.2, fall = 7, life = 0.55, size = 0.48, kind = "mote" } = o;
    const bits = Array.from({ length: count }, () => {
      const s = this.speck(kind, color, at, size * rand(0.7, 1.3));
      const a = Math.random() * Math.PI * 2;
      const r = out * rand(0.35, 1);
      return { s, v: new THREE.Vector3(Math.cos(a) * r, up * rand(0.3, 1), Math.sin(a) * r), life: life * rand(0.7, 1.2), size: s.scale.x };
    });
    this.run(
      bits.map((b) => b.s),
      (age, dt) => {
        for (const b of bits) {
          b.v.y -= fall * dt;
          b.s.position.addScaledVector(b.v, dt);
          const k = Math.min(1, age / b.life);
          b.s.material.opacity = 1 - k * k;
          b.s.scale.setScalar(b.size * (1 - k * 0.5));
        }
        return age < life * 1.2;
      },
    );
  }

  /** Chips of something (earth, stone, glass) thrown up from a point, tumbling, bouncing where they come down, and fading. */
  private chips(at: THREE.Vector3, color: string, count: number, size = 0.09, shape: THREE.BufferGeometry = rock) {
    const floor = at.y;
    const bits = Array.from({ length: count }, () => {
      const m = this.add(new THREE.Mesh(shape, flat(color)));
      m.scale.setScalar(size * rand(0.6, 1.4));
      m.position.copy(at).setY(at.y + 0.05);
      const a = Math.random() * Math.PI * 2;
      const out = rand(0.8, 2.4);
      return { m, v: new THREE.Vector3(Math.cos(a) * out, rand(2.2, 4.2), Math.sin(a) * out), spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(14), rest: false };
    });
    this.run(
      bits.map((b) => b.m),
      (age, dt) => {
        for (const b of bits) {
          if (!b.rest) {
            b.v.y -= 10 * dt;
            b.m.position.addScaledVector(b.v, dt);
            b.m.rotation.x += b.spin.x * dt;
            b.m.rotation.y += b.spin.y * dt;
            b.m.rotation.z += b.spin.z * dt;
            if (b.m.position.y < floor) {
              b.m.position.y = floor;
              if (Math.abs(b.v.y) < 1.5) b.rest = true;
              else b.v.set(b.v.x * 0.35, -b.v.y * 0.3, b.v.z * 0.35);
            }
          }
          if (age > 0.55) b.m.material.opacity = Math.max(0, 1 - (age - 0.55) / 0.35);
        }
        return age < 0.9;
      },
    );
  }

  /** A flash of light at a point, swelling and gone in a blink: where something lands, or lightning strikes. */
  flash(at: THREE.Vector3, color: string, size = 1) {
    const outer = this.halo(at, color, size * 0.4);
    const core = this.halo(at, "#ffffff", size * 0.2);
    this.run([outer, core], (age) => {
      const k = Math.min(1, age / 0.24);
      const swell = 1 - (1 - k) ** 3;
      outer.scale.setScalar(size * (0.4 + 0.9 * swell));
      core.scale.setScalar(size * (0.2 + 0.35 * swell));
      outer.material.opacity = (1 - k) ** 1.5;
      core.material.opacity = (1 - k) ** 2;
      return k < 1;
    });
  }

  /** Where something bright lands: a flash, and pixel motes of its colour (and a few white) thrown out and falling. */
  burst(at: THREE.Vector3, color: string, count = 8) {
    this.flash(at, color, 0.6 + count * 0.05);
    this.fling(at, color, count, { out: 2, up: 2.4 });
    this.fling(at, "#ffffff", Math.ceil(count / 4), { out: 1.4, up: 1.8, size: 0.36, life: 0.35 });
  }

  /** A flask breaking: a flash of what was in it, glass flying, and its drops thrown wide. */
  private shatter(at: THREE.Vector3, color: string) {
    this.flash(at.clone().setY(at.y + 0.2), color, 1.4);
    this.chips(at, "#dff1f5", 6, 0.06, diamond);
    this.fling(at, color, 16, { out: 2.6, up: 3.2, fall: 9, life: 0.6 , kind: "drop" });
  }

  /** A meteor striking: a blast of light, rock and embers thrown out of the crater, and smoke left hanging. */
  private crash(at: THREE.Vector3) {
    this.lightUp(at, "#ffa040", 40, 9, 0.9);
    this.flash(at.clone().setY(at.y + 0.35), "#ffb347", 2.6);
    this.fling(at, "#f08a24", 14, { out: 3, up: 3.5 });
    this.fling(at, "#ffd23f", 8, { out: 1.2, up: 4, fall: 5, life: 0.85 });
    this.chips(at, "#4a443d", 7, 0.13);
    for (let i = 0; i < 5; i++) this.smoke(at.clone().add(new THREE.Vector3(rand(-0.5, 0.5), 0.2, rand(-0.5, 0.5))), "#7a6f63", 1);
    this.ring(at, 1.4, "#ffb347", 0.35);
  }

  /**
   * A shockwave rolling out across the ground from a point to `radius` (in world units): a bright band with a fainter
   * echo behind it, a wash of light where it started, and pixel motes riding its edge. A blast, a song, a splash.
   */
  ring(at: THREE.Vector3, radius: number, color: string, time = 0.5) {
    const y = at.y + 0.07;
    const base = at.clone().setY(y);
    const band = this.sheet(base, color, ringTex(), 1);
    const echo = this.sheet(base.clone().setY(y + 0.004), color, ringTex(), 0);
    const wash = this.sheet(base, color, softTex(), 0.5);
    const count = Math.round(6 + radius * 4);
    const rim = Array.from({ length: count }, (_, i) => ({ s: this.speck("mote", color, base, 0.45), a: (i / count) * Math.PI * 2 + rand(0, 0.5), lift: rand(0.2, 0.6) }));
    const across = (k: number, to: number) => 0.2 + (to - 0.2) * (1 - (1 - k) ** 2.2);
    this.run([band, echo, wash, ...rim.map((r) => r.s)], (age) => {
      const k = Math.min(1, age / time);
      const r = across(k, radius);
      band.scale.set(r * 2, r * 2, 1);
      band.material.opacity = (1 - k) ** 1.2;
      const late = Math.max(0, Math.min(1, (age - time * 0.18) / time));
      const e = across(late, radius * 0.8);
      echo.scale.set(e * 2, e * 2, 1);
      echo.material.opacity = late > 0 ? 0.5 * (1 - late) : 0;
      const w = Math.min(1, age / (time * 0.5));
      wash.scale.setScalar(radius * 1.8 * (0.5 + 0.5 * w));
      wash.material.opacity = 0.5 * (1 - w);
      for (const m of rim) {
        m.s.position.set(at.x + Math.cos(m.a) * r * 0.95, y + m.lift * k, at.z + Math.sin(m.a) * r * 0.95);
        m.s.material.opacity = (1 - k) ** 0.8;
      }
      return late < 1;
    });
  }

  /**
   * A beam of light from one point to another, struck all at once: it swells in, ripples run down it from the one
   * who cast it, motes stream along it, it flares at both ends, and it thins away.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: string, width = 0.28) {
    const N = 12;
    const line = Array.from({ length: N }, (_, i) => from.clone().lerp(to, i / (N - 1)));
    const outer = new Ribbon(N, light(color, 0.9, streakTex()));
    const inner = new Ribbon(N, light("#ffffff", 1, streakTex()));
    this.add(outer.mesh);
    this.add(inner.mesh);
    const start = this.halo(from, color, width * 4);
    const end = this.halo(to, color, width * 6);
    const dir = to.clone().sub(from).normalize();
    const motes = Array.from({ length: Math.round(4 + from.distanceTo(to) * 2) }, () => ({
      s: this.speck("mote", color, from.clone().lerp(to, Math.random()), 0.45),
      v: dir.clone().multiplyScalar(rand(1.5, 4)).add(new THREE.Vector3(rand(-0.5, 0.5), rand(0, 0.8), rand(-0.5, 0.5))),
    }));
    const life = 0.6;
    this.lightUp(from.clone().lerp(to, 0.5).setY(Math.min(from.y, to.y) - 0.6), color, 18, 6, life);
    this.run([outer.mesh, inner.mesh, start, end, ...motes.map((m) => m.s)], (age, dt) => {
      const k = Math.min(1, age / life);
      const e = k < 0.12 ? k / 0.12 : (1 - (k - 0.12) / 0.88) ** 1.6;
      outer.lay(line, (t) => width * 2.4 * e * (0.85 + 0.15 * Math.sin(t * 18 - age * 50)), this.eye);
      inner.lay(line, () => width * 0.6 * e, this.eye);
      start.scale.setScalar(width * 4 * (0.6 + e));
      start.material.opacity = e;
      end.scale.setScalar(width * 6 * (0.6 + e) * (1 + 0.1 * Math.sin(age * 40)));
      end.material.opacity = e;
      for (const m of motes) {
        m.s.position.addScaledVector(m.v, dt);
        m.s.material.opacity = 1 - k;
      }
      return k < 1;
    });
  }

  /**
   * A bolt of lightning out of the sky onto a point on the ground: a thick white-hot stroke in a wide glow of its
   * colour, forking as it flickers, a flash high up where it comes from and a blinding one where it lands, and the
   * ground scorched in a ring, with sparks thrown and smoke left hanging.
   */
  strike(at: THREE.Vector3, color: string) {
    const top = at.clone().add(new THREE.Vector3(rand(0.4, 0.9), 9, rand(-0.6, -0.2)));
    this.spark([top, at], color, 2.4);
    // Everything near it lit up white for a moment, stuttering as the stroke does.
    this.lightUp(at, paler(color, 0.6), 60, 10, 0.5, LIGHTNING_FLICKER);
    this.flash(top, color, 2.5);
    this.flash(at.clone().setY(at.y + 0.4), color, 3);
    this.ring(at, 1.6, color, 0.35);
    this.fling(at, paler(color, 0.4), 12, { out: 2.6, up: 3.4 });
    this.fling(at, "#ffffff", 5, { out: 1.6, up: 2.6, size: 0.4, life: 0.4 });
    const scorch = this.add(new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: "#2a2420", map: softTex(), transparent: true, opacity: 0.7, depthWrite: false })));
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.copy(at).setY(at.y + 0.055);
    scorch.scale.setScalar(1.1);
    this.run([scorch], (age) => {
      scorch.material.opacity = 0.7 * Math.max(0, 1 - Math.max(0, age - 0.6) / 0.6);
      return age < 1.2;
    });
    for (let i = 0; i < 3; i++) this.smoke(at.clone().add(new THREE.Vector3(rand(-0.3, 0.3), 0.15, rand(-0.3, 0.3))), "#8a8478", 0.8);
  }

  /**
   * Forked lightning through a run of points: a white-hot stroke in a glow of its colour, re-forking as it flickers,
   * flashing where it strikes. `size` thickens it (a bolt from the sky is 2 or more).
   */
  spark(points: THREE.Vector3[], color: string, size = 1) {
    if (points.length < 2) return;
    const jagged = () => {
      const out: THREE.Vector3[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const steps = Math.max(3, Math.round(a.distanceTo(b) * 2.5));
        for (let s = 0; s < steps; s++) {
          const p = a.clone().lerp(b, s / steps);
          const j = 0.22 * Math.sqrt(size);
          if (s > 0) p.add(new THREE.Vector3(rand(-j, j), rand(-j, j) * 0.4, rand(-j, j)));
          out.push(p);
        }
      }
      out.push(points[points.length - 1].clone());
      return out;
    };
    // A fork: a short crooked branch off somewhere along the stroke, thinning to nothing.
    const fork = (path: THREE.Vector3[]) => {
      const from = path[1 + Math.floor(Math.random() * Math.max(1, path.length - 2))];
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.6, 0.6), rand(-1, 1)).normalize().multiplyScalar(0.24 * size);
      return Array.from({ length: 5 }, (_, j) => from.clone().addScaledVector(dir, j).add(new THREE.Vector3(rand(-0.08, 0.08), rand(-0.08, 0.08), rand(-0.08, 0.08))));
    };
    let path = jagged();
    const haze = new Ribbon(path.length, light(color, 0.9, streakTex()));
    const core = new Ribbon(path.length, light("#ffffff", 1, streakTex()));
    const forks = Array.from({ length: size > 1 ? 5 : 3 }, () => new Ribbon(5, light(color, 0.85, streakTex())));
    for (const r of [haze, core, ...forks]) this.add(r.mesh);
    let branches = forks.map(() => fork(path));
    let next = 0;
    if (size <= 1) {
      this.flash(points[0], color, 0.7);
      for (const p of points.slice(1)) {
        this.flash(p, color, 1.5);
        this.fling(p, color, 6, { out: 2, up: 2.2 });
      }
    }
    // On, off, on: a stroke that stutters as it dies.
    const FLICKER = [1, 0.35, 1, 0.8, 0.25, 0.85, 0.4, 0.15];
    this.run([haze.mesh, core.mesh, ...forks.map((f) => f.mesh)], (age) => {
      if (age >= next) {
        path = jagged();
        branches = forks.map(() => fork(path));
        next = age + 0.05;
      }
      const o = FLICKER[Math.floor(age / 0.05)] ?? 0;
      haze.material.opacity = 0.9 * o;
      core.material.opacity = o;
      haze.lay(path, () => 0.34 * size, this.eye);
      core.lay(path, () => 0.075 * size, this.eye);
      forks.forEach((f, i) => {
        f.material.opacity = 0.85 * o;
        f.lay(branches[i], (t) => 0.13 * size * (1 - t), this.eye);
      });
      return age < 0.4;
    });
  }

  /**
   * Something breaking up out of the ground over each of `points` (see EruptStyle), rippling out across them in turn,
   * standing a moment, and sinking back: earth thrown up and a glow of its colour on the ground where each comes up.
   */
  erupt(points: THREE.Vector3[], color: string, style: EruptStyle = "thorn", bind?: Binding) {
    const stagger = Math.min(0.035, 0.3 / Math.max(1, points.length));
    if (style === "thorn" || style === "kelp") {
      points.forEach((at, n) => this.wrap(at, color, style === "kelp", n * stagger, points.length === 1 ? bind : undefined));
      return;
    }
    // A little light of their own, so they still read at dusk and in a cave.
    const material = style === "water" ? null : grown(color, style === "coral" ? 0.22 : 0.15);
    const tips = style === "coral" ? grown(paler(color, 0.45), 0.2) : null;
    const water = style === "water" ? new THREE.MeshLambertMaterial({ color, vertexColors: true, transparent: true, opacity: 0.75, emissive: new THREE.Color(color).multiplyScalar(0.3), depthWrite: false }) : null;
    const grow: { holder: THREE.Group; delay: number; wide: number }[] = [];
    const parts: THREE.Object3D[] = [];
    points.forEach((at, n) => {
      const delay = n * stagger;
      const later = (run: () => void) => (delay > 0 ? this.run([], (age) => (age < delay ? true : (run(), false))) : run());
      later(() => {
        const ground = this.sheet(at.clone().setY(at.y + 0.05), color, softTex(), 0.6);
        ground.scale.setScalar(style === "shine" ? 1.6 : 1.3);
        this.run([ground], (age) => {
          ground.material.opacity = 0.6 * Math.max(0, 1 - age / 0.9);
          return age < 0.9;
        });
        if (style === "coral" || style === "stone") {
          this.chips(at, style === "stone" ? "#7d756a" : "#6b5a45", 3, 0.08);
          this.smoke(at.clone().setY(at.y + 0.1), "#a89a84", 0.8);
        }
        if (style === "water") {
          this.fling(at.clone().setY(at.y + 0.2), color, 10, { out: 1, up: 5, fall: 10, life: 0.8 , kind: "drop" });
          this.ring(at, 0.9, color, 0.45);
        } else if (style === "shine") {
          this.fling(at.clone().setY(at.y + 2), paler(color, 0.5), 5, { out: 0.4, up: 0, fall: 2.5, life: 0.8, kind: "spark", size: 0.6 });
        } else if (style === "rust") {
          this.fling(at.clone().setY(at.y + 0.1), color, 4, { out: 0.6, up: 1.3, fall: -0.4, life: 0.85 });
          this.fling(at.clone().setY(at.y + 0.1), "#7a3e1c", 4, { out: 0.6, up: 1.1, fall: -0.4, life: 0.85 });
        }
      });
      const stand = (geometry: THREE.BufferGeometry, mat: THREE.Material, r: number, h: number, x: number, z: number, lean: number, wide = 0.6) => {
        const holder = this.add(new THREE.Group());
        const a = Math.atan2(z, x);
        holder.position.set(at.x + x, at.y, at.z + z);
        // Leaning out, away from the middle of the hex.
        holder.rotation.set(Math.sin(a) * lean, Math.random() * Math.PI, -Math.cos(a) * lean);
        holder.scale.setScalar(0);
        const m = new THREE.Mesh(geometry, mat);
        m.scale.set(r, h, r);
        holder.add(m);
        grow.push({ holder, delay: delay + rand(0, 0.06), wide });
        parts.push(holder);
        return holder;
      };
      const around = (i: number, of: number, r0: number, r1: number) => {
        const a = (i / of) * Math.PI * 2 + rand(-0.4, 0.4);
        const r = rand(r0, r1);
        return [Math.cos(a) * r, Math.sin(a) * r] as const;
      };
      if (style === "coral") {
        for (let i = 0; i < 3; i++) {
          const h = rand(0.4, 0.7);
          const branch = stand(CORAL, material!, rand(0.07, 0.1), h, ...around(i, 3, 0.1, 0.34), rand(0.1, 0.3));
          // Two arms off the trunk, and a pale knob at the end of each, and of the trunk.
          for (const side of [-1, 1]) {
            const arm = new THREE.Group();
            arm.position.y = h * rand(0.35, 0.6);
            arm.rotation.z = side * rand(0.6, 0.9);
            const limb = new THREE.Mesh(CORAL, material!);
            const long = h * rand(0.4, 0.6);
            limb.scale.set(0.05, long, 0.05);
            const knob = new THREE.Mesh(KNOB, tips!);
            knob.scale.setScalar(0.06);
            knob.position.y = long;
            arm.add(limb, knob);
            branch.add(arm);
          }
          const top = new THREE.Mesh(KNOB, tips!);
          top.scale.setScalar(0.075);
          top.position.y = h;
          branch.add(top);
        }
      } else if (style === "stone") {
        for (let i = 0; i < 3; i++) stand(PILLAR, material!, rand(0.14, 0.22), rand(0.4, 0.8), ...around(i, 3, 0.05, 0.28), rand(0, 0.12), 0.9);
      } else if (style === "water") {
        stand(SPOUT, water!, 0.32, 1.25, 0, 0, 0, 0.85);
      } else if (style === "shine") {
        // A shaft of light falling on the hex.
        const column = this.add(new THREE.Mesh(tube, light(color, 0, columnTex())));
        column.position.copy(at).setY(at.y + 1.6);
        column.scale.set(0.5, 3.2, 0.5);
        this.run([column], (age) => {
          const k = Math.min(1, Math.max(0, (age - delay) / 0.9));
          column.material.opacity = 0.75 * (k < 0.15 ? k / 0.15 : (1 - k) / 0.85);
          column.scale.x = column.scale.z = 0.5 * (1 - 0.4 * k);
          return k < 1;
        });
      } else {
        // Rust: a stain spreading over the ground.
        const stain = this.add(new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color, map: softTex(), transparent: true, opacity: 0, depthWrite: false })));
        stain.rotation.x = -Math.PI / 2;
        stain.position.copy(at).setY(at.y + 0.06);
        this.run([stain], (age) => {
          const k = Math.min(1, Math.max(0, (age - delay) / 1));
          stain.scale.setScalar(0.4 + 1.2 * Math.min(1, k * 2.5));
          stain.material.opacity = 0.75 * (k < 0.6 ? 1 : (1 - k) / 0.4) * (k > 0 ? 1 : 0);
          return k < 1;
        });
      }
    });
    if (grow.length === 0) return;
    const hold = 0.62;
    const last = Math.max(...grow.map((g) => g.delay));
    this.run(parts, (age) => {
      for (const g of grow) {
        const t = age - g.delay;
        // Up fast with a spring in it, stand, and sink back slower.
        const up = t <= 0 ? 0 : t < 0.16 ? springOut(t / 0.16) : t < hold ? 1 : Math.max(0, 1 - (t - hold) / 0.3);
        const across = g.wide + (1 - g.wide) * Math.min(1, up);
        g.holder.scale.set(across, up, across);
      }
      const fade = Math.max(0, Math.min(1, (age - last - hold) / 0.3));
      for (const m of [material, tips, water]) if (m) m.opacity = (m === water ? 0.75 : 1) * (1 - fade);
      return age < last + hold + 0.3;
    });
  }

  /**
   * A wave rolling out from `from` over each of `points` (the hexes of its line, nearest first) at WAVE_PACE: a wall of
   * water rising as it leaves, foam blown off its crest, a splash on every hex it crosses, lighting the ground under it,
   * and breaking in a burst of spray at the end.
   */
  wave(from: THREE.Vector3, points: THREE.Vector3[], color: string) {
    if (points.length === 0) return;
    const ground = points[0].y;
    const start = from.clone().setY(ground);
    const end = points[points.length - 1];
    const dir = end.clone().sub(start).setY(0);
    const length = dir.length() + 0.6;
    dir.normalize();
    const body = this.add(new THREE.Mesh(WAVE, new THREE.MeshLambertMaterial({ color, vertexColors: true, flatShading: true, transparent: true, opacity: 0.92, emissive: new THREE.Color(color).multiplyScalar(0.25) })));
    body.rotation.y = Math.atan2(-dir.z, dir.x);
    const glow = this.halo(start, paler(color, 0.3), 1.6, 0);
    const lit = this.lamp(color, 5);
    const splashed = points.map(() => false);
    const time = length * WAVE_PACE;
    let spray = 0;
    this.run([body, glow], (age, dt) => {
      const k = Math.min(1, age / time);
      const along = 0.3 + (length - 0.3) * k;
      const at = start.clone().addScaledVector(dir, along);
      // It rises as it leaves the caster, rolls at its full height, and falls as it breaks.
      const rise = Math.min(1, k / 0.15);
      const fall = k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1;
      const tall = 1.25 * springOut(rise) * fall;
      body.position.copy(at);
      body.scale.set(1.1, Math.max(0.01, tall + Math.sin(age * 9) * 0.05), 1.75);
      const crest = at.clone().addScaledVector(dir, 0.25).setY(ground + tall * 0.95);
      glow.position.copy(crest);
      glow.material.opacity = 0.5 * fall;
      lit(crest, 10 * fall);
      // Foam and spray blown up and forward off the crest.
      spray -= dt;
      if (spray <= 0 && k < 1) {
        spray = 0.035;
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(rand(-0.8, 0.8));
        const off = crest.clone().add(side);
        this.fling(off, Math.random() < 0.5 ? "#ffffff" : paler(color, 0.5), 2, { out: 0.9, up: 2.6, fall: 8, life: 0.5 , kind: "drop" });
        if (Math.random() < 0.4) this.smoke(off, "#e8f6ff", 0.7, 0.5);
      }
      // A splash on each hex as the wave front reaches it.
      points.forEach((p, i) => {
        if (splashed[i] || p.clone().sub(start).setY(0).dot(dir) > along) return;
        splashed[i] = true;
        this.fling(p.clone().setY(p.y + 0.2), color, 9, { out: 1.4, up: 3.4, fall: 9, life: 0.6 , kind: "drop" });
        this.fling(p.clone().setY(p.y + 0.2), "#ffffff", 4, { out: 1.1, up: 2.6, fall: 9, life: 0.45 , kind: "drop" });
        this.ring(p, 1.1, color, 0.45);
      });
      if (k < 1) return true;
      lit(crest, 0);
      // It breaks: a burst of spray, a ring of it, and mist hanging.
      this.fling(end.clone().setY(ground + 0.4), color, 18, { out: 2.6, up: 4.2, fall: 9, life: 0.75 , kind: "drop" });
      this.fling(end.clone().setY(ground + 0.4), "#ffffff", 8, { out: 2, up: 3.4, fall: 9, life: 0.55 , kind: "drop" });
      this.ring(end, 1.8, color, 0.55);
      for (let i = 0; i < 4; i++) this.smoke(end.clone().add(new THREE.Vector3(rand(-0.5, 0.5), 0.3, rand(-0.5, 0.5))), "#e8f6ff", 1.1, 0.6);
      return false;
    });
  }

  /**
   * Vines (thorns, or kelp) breaking out of the ground at the edges of a hex and winding up round whoever stands on
   * it, closing in as they climb, thorns standing out along them as they reach each. Then they tear loose of the
   * ground, leaving a coil round the one they caught that goes where they go: it slows them, it does not hold them.
   * With `bind`, the coil follows `bind.follow` (their feet, or null once they are gone) and stays while
   * `bind.holding()` says so (they are still Slowed); otherwise it stays a moment. Then it withers away, tip first.
   */
  private wrap(at: THREE.Vector3, color: string, kelp: boolean, delay: number, bind?: Binding) {
    // Built round the one caught, at their feet: everyone stands a quarter hex toward the camera from the middle of
    // their hex (WorldRenderer syncUnits), so the hex's edges are measured from a quarter hex behind them.
    const anchor = this.add(new THREE.Group());
    anchor.position.copy(bind?.follow() ?? at.clone().add(new THREE.Vector3(0, 0, 0.25)));
    const middle = new THREE.Vector3(0, 0, -0.25);
    const SEG = 40;
    const RAD = kelp ? 4 : 5;
    const stem = kelp ? color : mix(color, "#7a5530", 0.4);
    // Cel-shaded and inked, as the figures are, so they read against grass and leaves.
    const material = new THREE.MeshToonMaterial({ color: stem, vertexColors: true, gradientMap: toonRamp(), transparent: true, emissive: new THREE.Color(stem).multiplyScalar(0.18) });
    const prickle = new THREE.MeshToonMaterial({ color: paler(stem, 0.55), gradientMap: toonRamp(), transparent: true, emissive: new THREE.Color(paler(stem, 0.55)).multiplyScalar(0.2) });
    const ink = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide, transparent: true });
    /** Seconds to wind up round them; to tear loose of the ground; the least they stay; and to wither. */
    const GROW = 0.6;
    const LOOSE = 0.4;
    const STAY = bind ? 1 : 1.5;
    const WITHER = 0.55;
    /** How far along each vine it tears from the ground: what is left is the coil round them. */
    const TORN = 0.4;
    const spin = Math.random() < 0.5 ? 1 : -1;
    const base = Math.random() * Math.PI * 2;
    // Torn earth where they come up: dark, so they stand out on grass. It stays where it was torn.
    const soil = this.add(new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: "#2e2116", map: softTex(), transparent: true, opacity: 0, depthWrite: false })));
    soil.rotation.x = -Math.PI / 2;
    soil.position.copy(anchor.position).add(middle).setY(anchor.position.y + 0.05);
    soil.scale.setScalar(2);
    const parts: THREE.Object3D[] = [anchor, soil];
    const count = kelp ? 4 : 3;
    const vines = Array.from({ length: count }, (_, i) => {
      const a0 = base + (i / count) * Math.PI * 2 + rand(-0.25, 0.25);
      const turn = spin * rand(1.2, 1.6) * Math.PI;
      const tall = rand(1.15, 1.5);
      const path = Array.from({ length: 16 }, (_, j) => {
        const t = j / 15;
        const a = a0 + turn * t;
        // From the edge of the hex in to a little way round them, and up them.
        const r = 0.86 - 0.5 * t ** 0.7;
        const c = middle.clone().lerp(new THREE.Vector3(), Math.min(1, t * 1.6));
        return new THREE.Vector3(c.x + Math.cos(a) * r, 0.02 + tall * t ** 1.15, c.z + Math.sin(a) * r);
      });
      const curve = new THREE.CatmullRomCurve3(path);
      // A tube along the path, thinned toward its tip and shaded dark at the root to light at the tip; and its ink, a
      // shell a little fatter round it.
      const tube = (fat: number) => {
        const g = new THREE.TubeGeometry(curve, SEG, 1, RAD, false);
        const pos = g.getAttribute("position");
        const v = new THREE.Vector3();
        const colors: number[] = [];
        for (let ring = 0; ring <= SEG; ring++) {
          const t = ring / SEG;
          const p = curve.getPointAt(t);
          const w = (kelp ? 0.12 : 0.1) * (1 - 0.7 * t) + fat;
          for (let k = 0; k <= RAD; k++) {
            const idx = ring * (RAD + 1) + k;
            v.fromBufferAttribute(pos, idx).sub(p).multiplyScalar(w).add(p);
            pos.setXYZ(idx, v.x, v.y, v.z);
            const shade = 0.75 + 0.5 * t;
            colors.push(shade, shade, shade);
          }
        }
        g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        g.computeVertexNormals();
        g.setDrawRange(0, 0);
        return g;
      };
      const g = tube(0);
      const line = tube(INK_EDGE);
      for (const [geometry, mat] of [[g, material], [line, ink]] as const) {
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.userData.ownGeometry = true;
        anchor.add(mesh);
      }
      // Thorns standing out from it, away from the one it holds and back along it.
      const thorns = kelp
        ? []
        : Array.from({ length: 7 }, (_, j) => {
            const t = 0.1 + j * 0.12 + rand(-0.03, 0.03);
            const p = curve.getPointAt(t);
            const out = p.clone().setY(0).normalize().addScaledVector(UP, 0.35).addScaledVector(curve.getTangentAt(t), -0.45).normalize();
            const m = new THREE.Mesh(THORN, prickle);
            // Its ink: the same thorn a little larger, set a touch down so the line runs round its tip too.
            const edge = new THREE.Mesh(THORN, ink);
            edge.scale.set(1.6, 1.15, 1.6);
            edge.position.y = -0.06;
            m.add(edge);
            m.position.copy(p);
            m.quaternion.setFromUnitVectors(UP, out);
            m.scale.setScalar(0);
            anchor.add(m);
            return { m, t, size: rand(0.17, 0.25) * (1 - t * 0.35), at: -1 };
          });
      return { g, line, thorns, late: delay + i * 0.08, root: path[0], broke: false, tore: false };
    });
    const last = delay + (count - 1) * 0.08;
    /** When it began to wither, once it has. */
    let gone = -1;
    // Caught again: the old vines round them wither, and these take their place.
    let released = false;
    const release = () => {
      released = true;
    };
    if (bind) {
      this.bound.get(bind.key)?.();
      this.bound.set(bind.key, release);
    }
    this.run(parts, (age) => {
      const where = bind?.follow();
      if (where) anchor.position.copy(where);
      // It withers once they are free of it (or gone), and not before it has had its moment.
      const settled = age > last + GROW + LOOSE + STAY;
      if (gone < 0 && ((released && age > last + GROW) || (settled && (!bind || !where || !bind.holding() || age > 600)))) gone = age;
      const k = gone < 0 ? 0 : Math.min(1, (age - gone) / WITHER);
      for (const vine of vines) {
        const t = age - vine.late;
        if (t > 0 && !vine.broke) {
          vine.broke = true;
          const root = vine.root.clone().add(anchor.position);
          this.chips(root, kelp ? "#3d6b4f" : "#6b5a45", 2, 0.06);
          this.smoke(root.clone().setY(root.y + 0.1), kelp ? "#cfeee0" : "#a89a84", 0.5, 0.5);
          if (kelp) this.fling(root.clone().setY(root.y + 0.1), paler(color, 0.4), 3, { out: 0.6, up: 1.8, fall: 8, life: 0.4 , kind: "drop" });
        }
        // Out along the path as it grows; torn from the ground up to TORN once it has wound round them; and back
        // from the tip to where it tore as it withers.
        const tip = t <= 0 ? 0 : t < GROW ? 1 - (1 - t / GROW) ** 2.2 : 1 - (1 - TORN) * k;
        const loose = t < GROW ? 0 : TORN * (1 - (1 - Math.min(1, (t - GROW) / LOOSE)) ** 2);
        if (loose > 0.05 && !vine.tore) {
          vine.tore = true;
          const root = vine.root.clone().add(soil.position).sub(middle).setY(soil.position.y);
          this.chips(root, kelp ? "#3d6b4f" : "#6b5a45", 2, 0.05);
        }
        const from = Math.floor(loose * SEG) * RAD * 6;
        for (const geometry of [vine.g, vine.line]) geometry.setDrawRange(from, Math.max(0, Math.floor(tip * SEG) * RAD * 6 - from));
        for (const th of vine.thorns) {
          if (tip >= th.t && th.at < 0) th.at = age;
          if (tip < th.t || th.t < loose) {
            th.m.scale.setScalar(0);
            continue;
          }
          const s = springOut(Math.min(1, (age - th.at) / 0.12));
          th.m.scale.set(0.05 * s, th.size * s, 0.05 * s);
        }
      }
      material.opacity = prickle.opacity = ink.opacity = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      if (k >= 1 && bind && this.bound.get(bind.key) === release) this.bound.delete(bind.key);
      const open = Math.min(1, Math.max(0, age - delay) / 0.2);
      const tear = Math.max(0, Math.min(1, (age - last - GROW) / (LOOSE + 0.5)));
      soil.material.opacity = 0.55 * open * (1 - tear);
      return k < 1;
    });
  }

  /**
   * Inked crescents of sound racing from `from` to `to`, one after another `stagger` seconds apart, each taking
   * `time` to cross and swelling as it goes; music notes shed behind the first. `wobble` sends them out of tune.
   */
  private crescents(from: THREE.Vector3, to: THREE.Vector3, color: string, o: { count: number; stagger: number; time: number; size: number; wobble?: boolean; notes?: boolean }) {
    const dir = to.clone().sub(from).setY(0);
    const distance = dir.length();
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const N = 14;
    const waves = Array.from({ length: o.count }, (_, i) => {
      const edge = new Ribbon(N, tinted(OUTLINE, 0.5, streakTex()));
      const glow = new Ribbon(N, tinted(color, 1, streakTex()));
      const core = new Ribbon(N, light("#ffffff", 1, streakTex()));
      edge.mesh.renderOrder = 4;
      glow.mesh.renderOrder = 5;
      core.mesh.renderOrder = 6;
      for (const r of [edge, glow, core]) this.add(r.mesh);
      return { edge, glow, core, late: i * o.stagger };
    });
    let shed = 0;
    const last = (o.count - 1) * o.stagger + o.time * 1.25;
    this.run(
      waves.flatMap((w) => [w.edge.mesh, w.glow.mesh, w.core.mesh]),
      (age, dt) => {
        waves.forEach((w, i) => {
          const k = (age - w.late) / o.time;
          if (k <= 0 || k >= 1.25) {
            w.edge.material.opacity = w.glow.material.opacity = w.core.material.opacity = 0;
            return;
          }
          const at = from.clone().addScaledVector(dir, distance * Math.min(1.1, k));
          const r = o.size * (0.45 + 0.6 * Math.min(1, k));
          const arc = Array.from({ length: N }, (_, j) => {
            const a = -1.15 + (2.3 * j) / (N - 1);
            const shake = o.wobble ? Math.sin(age * 38 + j * 1.7 + i) * 0.09 * o.size : 0;
            return at.clone().addScaledVector(dir, Math.cos(a) * r * 0.55 - r * 0.4 + shake).addScaledVector(side, Math.sin(a) * r).addScaledVector(UP, shake * 0.6);
          });
          const fade = k < 1 ? 1 : 1 - (k - 1) / 0.25;
          w.edge.material.opacity = 0.5 * fade;
          w.glow.material.opacity = fade * (o.wobble ? 0.6 + 0.4 * Math.abs(Math.sin(age * 23 + i)) : 1);
          w.core.material.opacity = fade;
          w.edge.lay(arc, (t) => 0.42 * o.size * Math.sin(Math.PI * t), this.eye);
          w.glow.lay(arc, (t) => 0.3 * o.size * Math.sin(Math.PI * t), this.eye);
          w.core.lay(arc, (t) => 0.1 * o.size * Math.sin(Math.PI * t), this.eye);
          if (i === 0 && o.notes && k < 1) {
            shed -= dt;
            if (shed <= 0) {
              shed = 0.06;
              this.note(at, color, "lively", Math.random() * Math.PI * 2, 0.3, 0, 0.6, 0.6);
            }
          }
        });
        return age < last;
      },
    );
  }

  /**
   * A blow of sound from `from` at `to` (see SoundKind): crescents of it racing out with notes in their wake, and where
   * they land a flash and a scatter of notes; a heavy blow lands harder and shakes the ground, a bell's rings out round
   * its mark, and a discord wobbles out of tune all the way. `onLand` runs as it arrives. Returns how long that takes.
   */
  sound(from: THREE.Vector3, to: THREE.Vector3, color: string, kind: SoundKind = "plain", onLand?: () => void): number {
    const time = Math.max(0.18, Math.min(0.5, from.distanceTo(to) / 14));
    const heavy = kind === "heavy";
    this.crescents(from, to, color, { count: heavy ? 4 : 3, stagger: 0.07, time, size: heavy ? 1.35 : 1, wobble: kind === "discord", notes: true });
    this.later(time, () => {
      this.flash(to, color, heavy ? 2.4 : 1.4);
      this.lightUp(to, paler(color, 0.4), heavy ? 22 : 10, 5, 0.4);
      for (let i = 0; i < (heavy ? 8 : 5); i++) this.note(to, color, "lively", Math.random() * Math.PI * 2, rand(0.8, 1.6), 0, 0.8);
      this.ring(to.clone().setY(to.y - 0.75), heavy ? 1.8 : 1.1, color, 0.4);
      if (heavy) this.renderer.shake(0.1, 0.25);
      if (kind === "bell") this.toll(to, color);
      onLand?.();
    });
    return time;
  }

  /** A bell's ring round something struck: circles of sound swelling out round it, upright to the eye, one after another. */
  private toll(at: THREE.Vector3, color: string) {
    const N = 28;
    const rings = [0, 1, 2].map((i) => ({ r: new Ribbon(N, tinted(paler(color, 0.3), 0.9, streakTex())), late: i * 0.12 }));
    for (const { r } of rings) this.add(r.mesh);
    this.run(
      rings.map((x) => x.r.mesh),
      (age) => {
        const look = at.clone().sub(this.eye).normalize();
        const right = new THREE.Vector3().crossVectors(look, UP).normalize();
        const up = new THREE.Vector3().crossVectors(right, look).normalize();
        for (const { r, late } of rings) {
          const k = Math.max(0, Math.min(1, (age - late) / 0.5));
          const radius = 0.3 + 1.1 * (1 - (1 - k) ** 2);
          const circle = Array.from({ length: N }, (_, j) => {
            const a = (j / (N - 1)) * Math.PI * 2;
            return at.clone().addScaledVector(right, Math.cos(a) * radius).addScaledVector(up, Math.sin(a) * radius);
          });
          r.material.opacity = k > 0 ? 0.9 * (1 - k) : 0;
          r.lay(circle, () => 0.12, this.eye);
        }
        return age < 0.24 + 0.5;
      },
    );
  }

  /** A blast of sound down a line (Blasting Tone): a rush of crescents one on another, notes streaming, and a burst at its end. */
  blast(from: THREE.Vector3, to: THREE.Vector3, color: string) {
    const time = Math.max(0.25, Math.min(0.55, from.distanceTo(to) / 12));
    this.crescents(from, to, color, { count: 7, stagger: 0.045, time, size: 0.9, notes: true });
    this.flash(from, color, 1.2);
    this.later(time, () => {
      this.flash(to, color, 1.8);
      this.ring(to.clone().setY(to.y - 0.75), 1.4, color, 0.4);
      for (let i = 0; i < 6; i++) this.note(to, color, "lively", Math.random() * Math.PI * 2, rand(0.8, 1.6), 0, 0.8);
    });
  }

  /** A roar of voices over a spot (Chorus): crescents of sound converging on it, then a burst of notes and a ring out over all it covers. */
  chorus(from: THREE.Vector3, at: THREE.Vector3, color: string) {
    const time = Math.max(0.25, Math.min(0.55, from.distanceTo(at) / 12));
    this.crescents(from, at.clone().setY(at.y + 0.8), color, { count: 4, stagger: 0.06, time, size: 1.1, notes: true });
    this.later(time, () => {
      this.flash(at.clone().setY(at.y + 0.8), color, 2.2);
      this.lightUp(at, color, 16, 6, 0.6);
      this.ring(at, 2.8, color, 0.55);
      for (let i = 0; i < 14; i++) this.note(at.clone().setY(at.y + 0.6), color, "lively", (i / 14) * Math.PI * 2, rand(1.6, 2.6), i * 0.015, 1);
    });
  }

  /**
   * A shanty struck up round `feet`: a ring rolling out over everyone the song reaches (`reach`, world units), a warm
   * flash, and notes thrown up and out all round the singer, moving as the mood moves (SongMood).
   */
  song(feet: THREE.Vector3, color: string, mood: SongMood, reach = 3.4) {
    this.ring(feet, reach, color, 0.7);
    this.flash(feet.clone().setY(feet.y + 1), color, 1.6);
    this.lightUp(feet, color, 10, 5, 0.8);
    for (let i = 0; i < 14; i++) this.note(feet.clone().setY(feet.y + rand(0.6, 1.2)), color, mood, (i / 14) * Math.PI * 2 + rand(-0.2, 0.2), rand(1.2, 2.2), i * 0.02);
  }

  /**
   * A song going on (a shanty while it lasts): notes drifting up off the singer now and again, moving as its mood
   * moves, and a soft glow of its colour under their feet, following them; until `bind.holding()` says it has ended.
   */
  serenade(bind: Binding, color: string, mood: SongMood) {
    let released = false;
    const release = () => {
      released = true;
    };
    this.bound.get(bind.key)?.();
    this.bound.set(bind.key, release);
    const glow = this.sheet(bind.follow() ?? new THREE.Vector3(), color, softTex(), 0);
    glow.scale.setScalar(1.6);
    let next = 0.3;
    let gone = -1;
    this.run([glow], (age) => {
      const feet = bind.follow();
      if (gone < 0 && (released || !feet || (age > GRACE && !bind.holding()) || age > 600)) gone = age;
      const k = gone < 0 ? Math.min(1, age / 0.4) : Math.max(0, 1 - (age - gone) / 0.5);
      if (feet) glow.position.copy(feet).setY(feet.y + 0.05);
      glow.material.opacity = 0.28 * k * (0.8 + 0.2 * Math.sin(age * 3));
      if (feet && gone < 0 && age >= next) {
        next = age + rand(0.3, 0.5);
        const a = Math.random() * Math.PI * 2;
        this.note(feet.clone().add(new THREE.Vector3(Math.cos(a) * 0.35, rand(0.6, 1.3), Math.sin(a) * 0.35)), color, mood, a, 0.25, 0, 1.5, 0.6);
      }
      if (gone >= 0 && k <= 0 && this.bound.get(bind.key) === release) this.bound.delete(bind.key);
      return gone < 0 || k > 0;
    });
  }

  /**
   * A soul drained (Soul Drain): life pulled out of `from` and back along an arc into `to`, a red stream of it pulsing
   * and motes of it running down it, and a flash where it comes home.
   */
  siphon(from: THREE.Vector3, to: THREE.Vector3, color: string) {
    const life = mix(color, "#ff3b5c", 0.55);
    const N = 18;
    const height = 0.9 + from.distanceTo(to) * 0.12;
    const path = Array.from({ length: N }, (_, i) => SpellFx.arcPoint(from, to, height, i / (N - 1)));
    const stream = new Ribbon(N, tinted(life, 0.8, streakTex()));
    const core = new Ribbon(N, light("#ffd0dc", 1, streakTex()));
    this.add(stream.mesh);
    this.add(core.mesh);
    this.flash(from, life, 1.2);
    const motes = Array.from({ length: 9 }, (_, i) => ({ s: this.halo(from, life, 0.55), late: i * 0.06 }));
    const T = 0.75;
    let home = false;
    this.run([stream.mesh, core.mesh, ...motes.map((m) => m.s)], (age) => {
      const k = Math.min(1, age / 1.1);
      const e = k < 0.15 ? k / 0.15 : (1 - k) / 0.85;
      stream.lay(path, (t) => 0.32 * e * (0.7 + 0.3 * Math.sin(t * 20 - age * 22)), this.eye);
      core.lay(path, () => 0.09 * e, this.eye);
      for (const m of motes) {
        const t = Math.max(0, Math.min(1, (age - m.late) / T));
        m.s.position.copy(SpellFx.arcPoint(from, to, height, t));
        m.s.material.opacity = t > 0 && t < 1 ? 1 : 0;
      }
      if (!home && age > T) {
        home = true;
        this.flash(to, life, 1.6);
        this.lightUp(to, life, 10, 4, 0.5);
      }
      return k < 1;
    });
  }

  /** A Hex taking hold: a curse's spiral flaring up on the ground under whoever it struck, turning slowly, and wisps of it rising. */
  sigil(at: THREE.Vector3, color: string) {
    const mark = this.sheet(at.clone().setY(at.y + 0.07), color, sigilTex(), 0);
    const ground = at.clone().setY(at.y + 0.05);
    this.flash(at.clone().setY(at.y + 0.6), color, 1.6);
    this.lightUp(at, color, 10, 4, 1);
    for (let i = 0; i < 5; i++) this.smoke(ground.clone().add(new THREE.Vector3(rand(-0.5, 0.5), 0.1, rand(-0.5, 0.5))), paler(color, 0.2), 0.7, 0.45);
    this.run([mark], (age) => {
      const k = Math.min(1, age / 1.4);
      mark.scale.setScalar(1.9 * springOut(Math.min(1, age / 0.25)));
      mark.rotation.z = age * 1.2;
      mark.material.opacity = k < 0.6 ? 1 : (1 - k) / 0.4;
      return k < 1;
    });
  }

  /**
   * A weight of black water on someone (Sink): a dark, inked mass of it dropping out of the air onto `at`, squashing as
   * it lands and bursting in a dark splash. `onLand` runs as it hits. Returns how long it takes to fall.
   */
  sink(at: THREE.Vector3, color: string, onLand?: () => void): number {
    const dark = mix(color, "#0b1a24", 0.78);
    const blob = this.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshToonMaterial({ color: dark, gradientMap: toonRamp(), emissive: new THREE.Color(color).multiplyScalar(0.15) })));
    blob.userData.ownGeometry = true;
    const edge = new THREE.Mesh(blob.geometry, new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide }));
    edge.scale.setScalar(1.08);
    blob.add(edge);
    const top = at.clone().setY(at.y + 2.6);
    const fall = 0.42;
    let landed = false;
    this.run([blob], (age) => {
      const k = Math.min(1, age / fall);
      // Falling faster as it goes, wobbling, and squashed flat on landing.
      blob.position.copy(top).lerp(at, k * k);
      const wobble = 1 + Math.sin(age * 30) * 0.06;
      blob.scale.set(0.42 * wobble, 0.48 / wobble, 0.42 * wobble);
      if (k >= 1 && !landed) {
        landed = true;
        this.fling(at, dark, 14, { out: 2.4, up: 3, fall: 9, life: 0.6, kind: "drop" });
        this.fling(at, paler(color, 0.3), 6, { out: 1.8, up: 2.4, fall: 9, life: 0.5, kind: "drop" });
        this.ring(at.clone().setY(at.y - 0.75), 1.4, color, 0.45);
        this.renderer.shake(0.06, 0.2);
        onLand?.();
      }
      return age < fall + 0.08;
    });
    return fall;
  }

  /** A curse of drowning taking hold: bubbles rising off whoever it struck, and a spiral of water winding up round them. */
  drown(at: THREE.Vector3, color: string) {
    const figure = at.clone().add(new THREE.Vector3(0, 0, 0.25));
    const N = 30;
    const spiral = new Ribbon(N, tinted(paler(color, 0.2), 0.8, streakTex()));
    this.add(spiral.mesh);
    this.run([spiral.mesh], (age) => {
      const k = Math.min(1, age / 1.2);
      const path = Array.from({ length: N }, (_, i) => {
        const t = i / (N - 1);
        const a = t * Math.PI * 5 + age * 5;
        return figure.clone().add(new THREE.Vector3(Math.cos(a) * 0.45, 0.1 + t * 1.5 * Math.min(1, age / 0.4), Math.sin(a) * 0.45));
      });
      spiral.material.opacity = 0.8 * (k < 0.7 ? 1 : (1 - k) / 0.3);
      spiral.lay(path, (t) => 0.1 * Math.sin(Math.PI * t), this.eye);
      return k < 1;
    });
    for (let i = 0; i < 12; i++) {
      this.later(i * 0.07, () => this.fling(figure.clone().add(new THREE.Vector3(rand(-0.35, 0.35), rand(0.1, 0.8), rand(-0.35, 0.35))), paler(color, 0.5), 1, { out: 0.1, up: 1.2, fall: -1, life: 0.7, size: 0.4, kind: "drop" }));
    }
  }

  /**
   * The Black Spot pressed on someone: the blot slammed onto their chest with a splatter of ink, and then held there,
   * wherever they go, for as long as `bind.holding()` says they carry it. (`bind.follow` gives the top of their head:
   * over it the name plate and badges would hide it.)
   */
  spot(bind: Binding, color: string) {
    let released = false;
    const release = () => {
      released = true;
    };
    this.bound.get(bind.key)?.();
    this.bound.set(bind.key, release);
    const where = () => bind.follow()?.add(new THREE.Vector3(0, -0.8, 0.12)) ?? null;
    const start = where();
    if (!start) return;
    // Drawn in real colours (paper and ink), unlike the white shapes the light is cut from.
    const map = blotTex();
    map.colorSpace = THREE.SRGBColorSpace;
    const blot = this.add(new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false })));
    blot.renderOrder = 8;
    blot.position.copy(start);
    this.flash(start, color, 1.2);
    this.fling(start, "#14101c", 10, { out: 1.8, up: 1.2, fall: 6, life: 0.5, size: 0.4, kind: "drop" });
    this.renderer.shake(0.05, 0.15);
    let gone = -1;
    this.run([blot], (age) => {
      const at = where();
      if (gone < 0 && (released || !at || (age > GRACE && !bind.holding()) || age > 600)) gone = age;
      if (at) blot.position.copy(at).add(new THREE.Vector3(0, Math.sin(age * 2.2) * 0.03, 0));
      // Slammed on: big and falling into place, then held; withering away once it is lifted.
      const slam = Math.min(1, age / 0.18);
      const size = 0.55 * (1 + 2.2 * (1 - slam) ** 2);
      const fade = gone < 0 ? 1 : Math.max(0, 1 - (age - gone) / 0.4);
      blot.scale.setScalar(size * (gone < 0 ? 1 : 0.6 + 0.4 * fade));
      blot.material.opacity = Math.min(1, slam * 1.5) * fade;
      if (fade <= 0 && this.bound.get(bind.key) === release) this.bound.delete(bind.key);
      return fade > 0;
    });
  }

  /**
   * The sea dragging at everything round someone (Pull of the Deep): a dark whirlpool, spiral arms winding in, a band of
   * water closing in from `radius`, and drops pulled in off the edge toward the middle, then a gulp of bubbles there.
   */
  whirl(at: THREE.Vector3, color: string, radius = 2.2) {
    const dark = mix(color, "#08141c", 0.6);
    const base = at.clone().setY(at.y + 0.07);
    const pool = this.add(new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: dark, map: softTex(), transparent: true, opacity: 0, depthWrite: false })));
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(base);
    const band = this.sheet(base.clone().setY(base.y + 0.004), color, ringTex(), 0);
    const N = 22;
    // Each arm inked, as the vines and the sound are, so the swirl reads against any ground.
    const arms = [0, 1, 2].map(() => ({ edge: new Ribbon(N, tinted(OUTLINE, 0.55, streakTex())), body: new Ribbon(N, tinted(paler(color, 0.3), 1, streakTex())) }));
    for (const a of arms) {
      a.edge.mesh.renderOrder = 4;
      a.body.mesh.renderOrder = 5;
      this.add(a.edge.mesh);
      this.add(a.body.mesh);
    }
    const life = 1.1;
    let pulled = 0;
    this.run([pool, band, ...arms.flatMap((a) => [a.edge.mesh, a.body.mesh])], (age, dt) => {
      const k = Math.min(1, age / life);
      const e = k < 0.15 ? k / 0.15 : (1 - k) / 0.85;
      pool.scale.setScalar(radius * 2.2);
      pool.material.opacity = 0.8 * e;
      const r = radius * (1 - k * 0.85);
      band.scale.set(r * 2, r * 2, 1);
      band.material.opacity = e;
      arms.forEach((arm, j) => {
        const path = Array.from({ length: N }, (_, i) => {
          const t = i / (N - 1);
          const a = j * ((Math.PI * 2) / 3) + age * 4 + t * 3.2;
          const rr = radius * (1 - t) * (1 - k * 0.5) + 0.1;
          return base.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0.06 + t * 0.15, Math.sin(a) * rr));
        });
        arm.edge.material.opacity = 0.55 * e;
        arm.body.material.opacity = e;
        arm.edge.lay(path, (t) => 0.36 * Math.sin(Math.PI * t), this.eye);
        arm.body.lay(path, (t) => 0.24 * Math.sin(Math.PI * t), this.eye);
      });
      // Drops dragged in off the edge, spiralling toward the middle.
      pulled -= dt;
      if (pulled <= 0 && k < 0.8) {
        pulled = 0.04;
        const a = Math.random() * Math.PI * 2;
        const from = base.clone().add(new THREE.Vector3(Math.cos(a) * radius, 0.2, Math.sin(a) * radius));
        const drop = this.speck("drop", paler(color, 0.35), from, 0.42);
        this.run([drop], (t) => {
          const q = Math.min(1, t / 0.5);
          const turn = a + q * 2;
          const rr = radius * (1 - q);
          drop.position.set(base.x + Math.cos(turn) * rr, base.y + 0.2 + Math.sin(q * Math.PI) * 0.3, base.z + Math.sin(turn) * rr);
          drop.material.opacity = 1 - q * q;
          return q < 1;
        });
      }
      return k < 1;
    });
    this.later(life * 0.8, () => this.fling(base.clone().setY(base.y + 0.1), paler(color, 0.5), 10, { out: 0.6, up: 2.2, fall: 4, life: 0.6, kind: "drop" }));
  }

  /**
   * An omen in the sky (Red Sky at Morning): everything under it washed red, a red light over it, and red embers
   * drifting down out of the sky onto it.
   */
  omen(at: THREE.Vector3, color: string, radius = 3.6) {
    const wash = this.sheet(at.clone().setY(at.y + 0.08), color, softTex(), 0);
    wash.scale.setScalar(radius * 2.4);
    const set = this.lamp(color, radius * 2.2);
    const high = at.clone().setY(at.y + 1.5);
    let ember = 0;
    const life = 2.2;
    this.run([wash], (age, dt) => {
      const k = Math.min(1, age / life);
      const e = k < 0.25 ? k / 0.25 : (1 - k) / 0.75;
      wash.material.opacity = 0.6 * e;
      set(high, 18 * e);
      ember -= dt;
      if (ember <= 0 && k < 0.8) {
        ember = 0.05;
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * radius;
        this.fling(at.clone().add(new THREE.Vector3(Math.cos(a) * d, rand(3, 4), Math.sin(a) * d)), paler(color, 0.25), 1, { out: 0.2, up: 0, fall: 1.5, life: 1.4 });
      }
      if (k >= 1) set(high, 0);
      return k < 1;
    });
  }

  /**
   * A pike hurled from `from` at `to`: a long wooden shaft with a steel head, inked as the figures are, flying flat and
   * true. `onLand` runs as it strikes. With `drag` (it took), a rope is left strung from the thrower's hand to whoever
   * it struck, following them as they are hauled in, and then slack and gone. With `stuck` (it missed, and `to` is the
   * ground beyond them), it is left standing in the ground a moment, quivering, and then fades. Returns how long the
   * flight takes.
   */
  pike(from: THREE.Vector3, to: THREE.Vector3, onLand?: () => void, drag?: { hand: () => THREE.Vector3 | null; caught: () => THREE.Vector3 | null }, stuck = false): number {
    const time = SpellFx.pikeTime(from.distanceTo(to));
    const g = this.add(new THREE.Group());
    const ink = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide, transparent: true });
    // Each piece with its ink: a shell a little larger round it, as the figures are drawn.
    const piece = (geometry: THREE.BufferGeometry, color: string, scale: [number, number, number], at: [number, number, number], turn = 0) => {
      const m = new THREE.Mesh(geometry, flat(color));
      m.scale.set(...scale);
      m.position.set(...at);
      m.rotation.x = turn;
      const edge = new THREE.Mesh(geometry, ink);
      edge.scale.set(1 + 0.03 / scale[0], 1 + 0.03 / scale[1], 1 + 0.03 / scale[2]);
      m.add(edge);
      g.add(m);
      return m;
    };
    piece(shaft, "#8a6238", [0.08, 0.08, 1.5], [0, 0, 0]);
    piece(arrowhead, "#e6ebf1", [0.13, 0.38, 0.13], [0, 0, 0.92], Math.PI / 2);
    piece(shaft, "#c9d0d8", [0.05, 0.2, 0.05], [0, 0.09, 0.66]);
    const height = SpellFx.arcHeight("arrow", from.distanceTo(to)) * 0.5;
    let t = 0;
    this.live.push({
      step: (dt) => {
        t += dt / time;
        const at = SpellFx.arcPoint(from, to, height, Math.min(1, t));
        g.position.copy(at);
        g.lookAt(SpellFx.arcPoint(from, to, height, Math.min(1, t) + 0.02));
        if (t < 1) return true;
        onLand?.();
        if (stuck) {
          // Standing in the ground where it came down, head buried, quivering, then gone.
          this.chips(to, "#8f7a62", 3, 0.06);
          const lean = g.quaternion.clone();
          this.run([g], (age) => {
            g.quaternion.copy(lean).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(age * 40) * 0.08 * Math.max(0, 1 - age / 0.5)));
            const fade = Math.max(0, Math.min(1, (age - 0.9) / 0.4));
            g.traverse((o) => {
              const m = (o as THREE.Mesh).material as THREE.Material | undefined;
              if (m) m.opacity = 1 - fade;
            });
            return fade < 1;
          });
          return false;
        }
        this.drop(g);
        this.flash(to, "#fff1c9", 0.9);
        this.fling(to, "#e8e4da", 6, { out: 1.4, up: 1.4 });
        if (drag) this.tether(drag.hand, drag.caught);
        return false;
      },
    });
    return time;
  }

  /** A rope strung between two moving points (a thrower's hand and what their pike caught), taut a while, then sagging and gone. */
  private tether(hand: () => THREE.Vector3 | null, caught: () => THREE.Vector3 | null) {
    const N = 12;
    const edge = new Ribbon(N, tinted(OUTLINE, 0.8, streakTex()));
    const rope = new Ribbon(N, tinted("#b48a55", 1, streakTex()));
    edge.mesh.renderOrder = 4;
    rope.mesh.renderOrder = 5;
    this.add(edge.mesh);
    this.add(rope.mesh);
    let a = hand();
    let b = caught();
    this.run([edge.mesh, rope.mesh], (age) => {
      a = hand() ?? a;
      b = caught() ?? b;
      if (!a || !b) return false;
      const k = Math.min(1, age / 1.4);
      const sag = k < 0.6 ? 0.05 : 0.05 + (k - 0.6) * 1.2;
      const line = Array.from({ length: N }, (_, i) => {
        const t = i / (N - 1);
        return a!.clone().lerp(b!, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0));
      });
      const o = k < 0.75 ? 1 : (1 - k) / 0.25;
      edge.material.opacity = 0.8 * o;
      rope.material.opacity = o;
      edge.lay(line, () => 0.15, this.eye);
      rope.lay(line, () => 0.1, this.eye);
      return k < 1;
    });
  }

  /**
   * A bellowed challenge (Taunt): jagged red crescents of it bursting out every way from the one who roars, a ring
   * across the ground, and the ground jolted.
   */
  shout(feet: THREE.Vector3, color: string) {
    const mouth = feet.clone().setY(feet.y + 1.1);
    this.flash(mouth, color, 1.6);
    this.ring(feet, 2.4, color, 0.45);
    this.renderer.shake(0.08, 0.25);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const to = mouth.clone().add(new THREE.Vector3(Math.cos(a) * 2.2, -0.2, Math.sin(a) * 2.2));
      this.crescents(mouth, to, color, { count: 2, stagger: 0.06, time: 0.3, size: 0.7, wobble: true });
    }
  }

  /** A pixel "!" popping up beside someone's head: a challenge taken up (Taunted). `head` is the top of their head. */
  exclaim(head: THREE.Vector3, color: string) {
    // To one side of the name plate over them, not under it.
    const at = head.clone().add(new THREE.Vector3(0.5, 0.15, 0.1));
    const s = this.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture("bang", color), transparent: true, depthTest: false })));
    s.renderOrder = 9;
    s.position.copy(at);
    this.run([s], (age) => {
      const k = Math.min(1, age / 1.4);
      s.scale.setScalar(0.85 * springOut(Math.min(1, age / 0.18)));
      s.position.y = at.y + Math.min(1, age / 0.18) * 0.15 + Math.sin(age * 9) * 0.02;
      s.material.opacity = k < 0.75 ? 1 : (1 - k) / 0.25;
      return k < 1;
    });
  }

  /** Steel sparks struck off something (Disarming Chop): a spray of white and steel specks, and a flash. */
  sparks(at: THREE.Vector3) {
    this.flash(at, "#e8f0ff", 0.9);
    this.fling(at, "#dfe5ec", 10, { out: 2.6, up: 2.2, fall: 8, life: 0.4, size: 0.4 });
    this.fling(at, "#ffe9a8", 5, { out: 2.2, up: 2, fall: 8, life: 0.35, size: 0.36 });
  }

  /** Someone thrown bodily at another (Overwhelm): a slam of dust and chips round the one struck, and the ground jolted. */
  slam(at: THREE.Vector3, color: string) {
    const feet = at.clone().setY(at.y - 0.75);
    this.flash(at, paler(color, 0.4), 1.4);
    this.ring(feet, 1.8, "#c9b994", 0.4);
    this.chips(feet, "#8f7a62", 6, 0.08);
    for (let i = 0; i < 4; i++) this.smoke(feet.clone().add(new THREE.Vector3(rand(-0.4, 0.4), 0.1, rand(-0.4, 0.4))), "#c9bfa8", 0.9, 0.6);
    this.renderer.shake(0.12, 0.3);
  }

  /** The sea breaking on someone braced against it (Against the Waves): spray thrown up against them from one side, and a ring of water. */
  breaker(at: THREE.Vector3, color: string) {
    const side = new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).normalize();
    const hit = at.clone().add(side.clone().multiplyScalar(0.45)).setY(at.y + 0.5);
    this.fling(hit, color, 16, { out: 1.6, up: 3.4, fall: 9, life: 0.7, kind: "drop" });
    this.fling(hit, "#ffffff", 8, { out: 1.2, up: 3, fall: 9, life: 0.55, kind: "drop" });
    this.ring(at.clone().setY(at.y - 0.2), 1.6, color, 0.5);
    for (let i = 0; i < 3; i++) this.smoke(hit.clone().add(new THREE.Vector3(rand(-0.2, 0.2), rand(0, 0.4), rand(-0.2, 0.2))), "#e8f6ff", 0.8, 0.55);
  }

  /** One music note floating off `at`: out along `angle` at `speed`, bobbing, sinking or swirling as the mood has it, and fading over `life`. */
  private note(at: THREE.Vector3, color: string, mood: SongMood, angle: number, speed: number, delay = 0, life = 1.1, size = 0.75) {
    const s = this.speck(Math.random() < 0.5 ? "note" : "notes", color, at, 0);
    const wiggle = rand(0, Math.PI * 2);
    this.run([s], (age) => {
      const t = age - delay;
      if (t < 0) return true;
      const k = Math.min(1, t / life);
      const slow = mood === "dour" ? 0.6 : 1;
      const a = mood === "wind" ? angle + t * 2.6 : angle;
      const out = speed * slow * t * (1 - k * 0.5);
      const rise = mood === "lively" ? t * 1.2 + Math.abs(Math.sin(t * 9)) * 0.15 : mood === "dour" ? t * 0.55 - k * k * 0.4 : t * 0.9;
      s.position.set(at.x + Math.cos(a) * out, at.y + rise, at.z + Math.sin(a) * out);
      s.scale.setScalar(size * Math.min(1, k / 0.12));
      s.material.opacity = 1 - k * k;
      s.material.rotation = Math.sin(t * 6 + wiggle) * 0.3;
      return k < 1;
    });
  }

  /**
   * A guard going up round someone: a wall of light in the shape of their hex rising up off the ground and fading as
   * it goes, a bright rim riding its top, a flash on the ground, and sparkles caught in it.
   */
  ward(at: THREE.Vector3, color: string) {
    const foot = at.y - 0.27;
    const wall = this.add(new THREE.Mesh(hexWall, light(color, 0, columnTex())));
    const tint = this.add(new THREE.Mesh(hexWall, tinted(color, 0, columnTex())));
    const rim = this.add(new THREE.Mesh(hexRim, light(paler(color, 0.4), 0)));
    const base = this.sheet(at.clone().setY(foot + 0.02), color, softTex(), 0);
    base.scale.setScalar(1.6);
    const glints = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      return { s: this.speck("spark", paler(color, 0.3), new THREE.Vector3(at.x + Math.sin(a) * 0.6, foot + rand(0.3, 1.1), at.z + Math.cos(a) * 0.6), 0), phase: rand(0, Math.PI * 2) };
    });
    this.lightUp(at.clone().setY(foot), color, 8, 3.5, 0.7);
    const life = 0.85;
    this.run([wall, tint, rim, base, ...glints.map((g) => g.s)], (age) => {
      const k = Math.min(1, age / life);
      const e = k < 0.12 ? k / 0.12 : (1 - k) / 0.88;
      // Snaps up to full height, then narrows in a touch as it fades.
      const h = 1.3 * springOut(Math.min(1, age / 0.18));
      const r = 0.68 * (1 - 0.12 * k);
      for (const m of [wall, tint]) {
        m.scale.set(r, Math.max(0.01, h), r);
        m.position.set(at.x, foot + h / 2, at.z);
      }
      wall.material.opacity = 0.9 * e;
      tint.material.opacity = 0.35 * e;
      rim.position.set(at.x, foot + h, at.z);
      rim.scale.setScalar(r);
      rim.material.opacity = e;
      base.material.opacity = 0.7 * e;
      for (const g of glints) g.s.scale.setScalar(0.6 * Math.abs(Math.sin(age * 10 + g.phase)) * e);
      return k < 1;
    });
  }

  /** A rain cloud gathering over a spot: mist drawn together high over it, a soft flash in it, and the first drops. */
  gather(at: THREE.Vector3, color: string) {
    const high = at.clone().setY(at.y + 3);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      this.smoke(high.clone().add(new THREE.Vector3(Math.cos(a) * 0.9, rand(-0.2, 0.2), Math.sin(a) * 0.9)), "#e4ecf6", rand(1.2, 1.7), 0.7);
    }
    this.flash(high, paler(color, 0.5), 1.6);
    this.lightUp(high, paler(color, 0.5), 8, 5, 0.6);
    this.fling(high.clone().setY(high.y - 0.3), paler(color, 0.4), 10, { out: 0.9, up: 0, fall: 12, life: 0.55 , kind: "drop" });
  }

  /**
   * Acid splashed over the ground, `radius` across: a dark stain etched into it, a bright sheet of acid fizzing on it,
   * little bubbles popping up all over it, and pale fumes hissing up off it as it eats in, and then it is spent.
   */
  fizz(at: THREE.Vector3, color: string, radius = 1.7) {
    const ground = at.clone().setY(at.y + 0.06);
    const stain = this.add(new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: "#2b2a12", map: softTex(), transparent: true, opacity: 0, depthWrite: false })));
    stain.rotation.x = -Math.PI / 2;
    stain.position.copy(ground);
    stain.scale.setScalar(radius * 2.2);
    const sheet = this.sheet(ground.clone().setY(ground.y + 0.004), color, softTex(), 0);
    sheet.scale.setScalar(radius * 2);
    this.lightUp(at, color, 5, 3, 1.2);
    let bubbled = 0;
    let fumed = 0;
    const life = 2.6;
    this.run([stain, sheet], (age, dt) => {
      // The stain comes in at once and lingers; the acid on it fizzes, then thins away.
      stain.material.opacity = 0.55 * Math.min(1, age / 0.15) * (age < 1.6 ? 1 : 1 - (age - 1.6) / (life - 1.6));
      sheet.material.opacity = 0.45 * Math.min(1, age / 0.1) * Math.max(0, 1 - age / 1.6) * (0.8 + 0.2 * Math.sin(age * 30));
      bubbled -= dt;
      if (bubbled <= 0 && age < 1.6) {
        bubbled = 0.03;
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * radius * 0.9;
        this.pop(ground.clone().add(new THREE.Vector3(Math.cos(a) * d, 0.02, Math.sin(a) * d)), paler(color, 0.25));
      }
      fumed -= dt;
      if (fumed <= 0 && age < 1.8) {
        fumed = 0.12;
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * radius * 0.8;
        this.smoke(ground.clone().add(new THREE.Vector3(Math.cos(a) * d, 0.1, Math.sin(a) * d)), "#eef5c8", rand(0.6, 1), 0.5);
      }
      return age < life;
    });
  }

  /** A bubble swelling up out of something and popping: a round drop that grows, and a few white flecks as it bursts. */
  private pop(at: THREE.Vector3, color: string) {
    const bubble = this.speck("drop", color, at, 0);
    const size = rand(0.35, 0.6);
    const grow = rand(0.15, 0.3);
    let burst = false;
    this.run([bubble], (age) => {
      const k = Math.min(1, age / grow);
      bubble.scale.setScalar(size * k);
      bubble.position.y = at.y + 0.04 * k;
      if (k >= 1 && !burst) {
        burst = true;
        this.fling(at.clone().setY(at.y + 0.05), "#ffffff", 2, { out: 0.6, up: 0.9, fall: 4, life: 0.25, size: 0.3, kind: "drop" });
      }
      return k < 1;
    });
  }

  /** A puff of smoke round someone, as they slip out of sight or away. */
  puff(at: THREE.Vector3, color = "#d8d2c8") {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      this.smoke(at.clone().add(new THREE.Vector3(Math.cos(a) * 0.3, rand(0, 0.8), Math.sin(a) * 0.3)), color, rand(1.3, 1.8), 0.85);
    }
    this.fling(at.clone().setY(at.y + 0.4), "#cfc8bd", 5, { out: 1.2, up: 1, fall: 1, life: 0.6 });
  }

  /**
   * Someone healed or blessed: a glow on the ground under them, a soft column of light standing up off it, pixel motes
   * spiralling up through it, and sparkles twinkling in it.
   */
  motes(at: THREE.Vector3, color: string, notes = false) {
    const foot = at.y - 0.27;
    const disc = this.sheet(at.clone().setY(foot), color, softTex(), 0);
    const pool = this.add(new THREE.Mesh(plane, tinted(color, 0, softTex())));
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(at).setY(foot - 0.005);
    const column = this.add(new THREE.Mesh(tube, light(color, 0, columnTex())));
    column.position.copy(at).setY(foot + 0.8);
    column.scale.set(0.42, 1.6, 0.42);
    // Its colour under the light, so the column still shows against bright ground.
    const body = this.add(new THREE.Mesh(tube, tinted(color, 0, columnTex())));
    body.scale.copy(column.scale);
    // A song's healing (the Bard's) rises in music notes rather than motes.
    const rising = Array.from({ length: 10 }, (_, i) => ({
      s: notes ? this.speck(i % 2 ? "note" : "notes", color, at, rand(0.65, 0.8)) : this.speck("mote", i % 3 ? color : paler(color, 0.5), at, rand(0.4, 0.55)),
      a: (i / 10) * Math.PI * 2,
      r: rand(0.25, 0.42),
      y: rand(0, 0.3),
      speed: rand(0.8, 1.6),
    }));
    const glints = Array.from({ length: 4 }, () => ({
      s: this.speck("spark", paler(color, 0.3), at.clone().add(new THREE.Vector3(rand(-0.3, 0.3), rand(0.2, 1.3), rand(-0.3, 0.3))), 0),
      phase: rand(0, Math.PI * 2),
      late: rand(0.05, 0.4),
    }));
    const life = 1;
    this.lightUp(at.clone().setY(foot), color, 6, 3.5, life);
    this.run([disc, pool, column, body, ...rising.map((m) => m.s), ...glints.map((g) => g.s)], (age, dt) => {
      const k = Math.min(1, age / life);
      const e = k < 0.15 ? k / 0.15 : (1 - k) / 0.85;
      disc.material.opacity = 0.8 * e;
      disc.scale.setScalar(1.4 * (0.8 + 0.2 * e));
      pool.material.opacity = 0.45 * e;
      pool.scale.setScalar(1.2 * (0.8 + 0.2 * e));
      column.material.opacity = 0.7 * e;
      column.scale.y = 1.6 * (0.7 + 0.5 * k);
      column.position.y = foot + column.scale.y / 2;
      body.position.copy(column.position);
      body.scale.copy(column.scale);
      body.material.opacity = 0.32 * e;
      for (const m of rising) {
        m.y += m.speed * dt;
        const a = m.a + age * 3;
        const r = m.r * (1 - 0.35 * k);
        m.s.position.set(at.x + Math.cos(a) * r, at.y + m.y, at.z + Math.sin(a) * r);
        m.s.material.opacity = 1 - k;
      }
      for (const g of glints) {
        const on = age > g.late ? Math.abs(Math.sin((age - g.late) * 9 + g.phase)) : 0;
        g.s.scale.setScalar(0.65 * on * (1 - k));
      }
      return k < 1;
    });
  }

  /**
   * A chest thrown open: a flash of light out of it, a fountain of glints thrown up and falling back about it, and
   * a few left hanging in the air over it, twinkling as they drift up and fade. `rich` is the hoard: more of
   * everything, and gems among the gold.
   */
  spill(at: THREE.Vector3, rich = false) {
    const flash = this.add(new THREE.Mesh(sphere, glow("#ffe6a0", 0.3)));
    flash.position.copy(at);
    const colors = rich ? ["#ffd45e", "#fff3c4", "#ffb347", "#7fe0ff", "#ff6fb5"] : ["#ffd45e", "#fff3c4", "#ffe08a"];
    const thrown = Array.from({ length: rich ? 38 : 22 }, () => {
      const bit = this.add(new THREE.Mesh(diamond, glow(colors[Math.floor(Math.random() * colors.length)], 1)));
      const size = 0.035 + Math.random() * 0.04;
      bit.scale.setScalar(size);
      bit.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.2));
      const a = Math.random() * Math.PI * 2;
      const out = 0.4 + Math.random() * (rich ? 1.5 : 1.1);
      const v = new THREE.Vector3(Math.cos(a) * out, 2.6 + Math.random() * (rich ? 2.8 : 2.2), Math.sin(a) * out);
      return { bit, v, size, life: 0.8 + Math.random() * 0.5, floor: at.y - 0.3, spin: Math.random() * 12 };
    });
    const hanging = Array.from({ length: rich ? 12 : 7 }, (_, i) => {
      const bit = this.add(new THREE.Mesh(diamond, glow(i % 3 ? "#fff3c4" : "#ffd45e", 0)));
      const size = 0.03 + Math.random() * 0.03;
      const a = Math.random() * Math.PI * 2;
      const r = 0.1 + Math.random() * 0.45;
      bit.position.copy(at).add(new THREE.Vector3(Math.cos(a) * r, 0.15 + Math.random() * 0.55, Math.sin(a) * r));
      return { bit, size, rise: 0.12 + Math.random() * 0.22, sway: Math.random() * 6, delay: 0.15 + Math.random() * 0.5, life: 2.2 + Math.random() * 1.4 };
    });
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        const f = Math.min(1, age / 0.3);
        flash.scale.setScalar(0.15 + f * (rich ? 0.6 : 0.4));
        (flash.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - f) ** 2;
        for (const g of thrown) {
          if (age > g.life) {
            g.bit.visible = false;
            continue;
          }
          g.v.y -= 7.5 * dt;
          g.bit.position.addScaledVector(g.v, dt);
          // They come to rest on the floor and wink out there.
          if (g.bit.position.y < g.floor) {
            g.bit.position.y = g.floor;
            g.v.set(g.v.x * 0.3, Math.abs(g.v.y) * 0.25, g.v.z * 0.3);
          }
          g.bit.rotation.y += g.spin * dt;
          const k = age / g.life;
          (g.bit.material as THREE.MeshBasicMaterial).opacity = k < 0.7 ? 1 : (1 - k) / 0.3;
          g.bit.scale.setScalar(g.size * (0.7 + 0.5 * Math.abs(Math.sin(age * 14 + g.spin))));
        }
        for (const h of hanging) {
          const t = age - h.delay;
          if (t < 0) continue;
          h.bit.position.y += h.rise * dt;
          h.bit.position.x += Math.cos(h.sway + t * 1.7) * 0.05 * dt;
          const k = t / h.life;
          const twinkle = Math.max(0, Math.sin(t * 5 + h.sway)) ** 3;
          (h.bit.material as THREE.MeshBasicMaterial).opacity = Math.min(1, t * 3) * (1 - Math.max(0, (k - 0.6) / 0.4)) * (0.35 + 0.65 * twinkle);
          h.bit.scale.setScalar(h.size * (0.6 + 0.9 * twinkle));
          h.bit.rotation.y = t * 2 + h.sway;
        }
        if (age < Math.max(...hanging.map((h) => h.delay + h.life))) return true;
        this.drop(flash, ...thrown.map((g) => g.bit), ...hanging.map((h) => h.bit));
        return false;
      },
    });
  }

  /**
   * Splinters knocked off a crate (`count` a few, from a blow), or the whole crate flying apart: boards and chips
   * thrown out and up, tumbling, bouncing once on the floor and lying a moment before they sink away. `burst`
   * adds a puff of dust and a ring across the floor.
   */
  splinters(at: THREE.Vector3, count: number, burst = false) {
    const woods = ["#a87b4a", "#8a6238", "#6b4a2a", "#c29464"];
    const floor = at.y - (burst ? 0.38 : 0.3);
    const bits = Array.from({ length: count }, (_, i) => {
      const bit = this.add(new THREE.Mesh(shaft, flat(woods[i % woods.length])));
      const long = burst && i % 2 === 0 ? 0.18 + Math.random() * 0.22 : 0.05 + Math.random() * 0.08;
      bit.scale.set(long, 0.025 + Math.random() * 0.015, 0.05 + Math.random() * 0.03);
      bit.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
      const a = Math.random() * Math.PI * 2;
      const out = (burst ? 1.4 : 0.8) + Math.random() * (burst ? 1.8 : 0.9);
      const v = new THREE.Vector3(Math.cos(a) * out, (burst ? 2.2 : 1.6) + Math.random() * 1.8, Math.sin(a) * out);
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(22);
      return { bit, v, spin, bounced: false, rest: false };
    });
    const dust = burst
      ? Array.from({ length: 7 }, (_, i) => {
          const puff = this.add(new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ color: "#8f7a62", transparent: true, opacity: 0.5, depthWrite: false })));
          const a = (i / 7) * Math.PI * 2;
          puff.position.copy(at).add(new THREE.Vector3(Math.cos(a) * 0.15, -0.15, Math.sin(a) * 0.15));
          return { puff, dir: new THREE.Vector3(Math.cos(a), 0.35, Math.sin(a)).multiplyScalar(0.7 + Math.random() * 0.4) };
        })
      : [];
    if (burst) this.ring(new THREE.Vector3(at.x, floor, at.z), 1.4, "#c9a46a", 0.45);
    const life = burst ? 1.6 : 0.9;
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        for (const b of bits) {
          if (!b.rest) {
            b.v.y -= 9 * dt;
            b.bit.position.addScaledVector(b.v, dt);
            b.bit.rotation.x += b.spin.x * dt;
            b.bit.rotation.y += b.spin.y * dt;
            b.bit.rotation.z += b.spin.z * dt;
            if (b.bit.position.y <= floor) {
              b.bit.position.y = floor;
              if (b.bounced) {
                b.rest = true;
                b.bit.rotation.x = b.bit.rotation.z = 0;
              } else {
                b.bounced = true;
                b.v.set(b.v.x * 0.35, Math.abs(b.v.y) * 0.3, b.v.z * 0.35);
                b.spin.multiplyScalar(0.4);
              }
            }
          }
          // Lying a moment, then sinking away.
          if (age > life * 0.65) {
            const k = (age - life * 0.65) / (life * 0.35);
            (b.bit.material as THREE.MeshLambertMaterial).opacity = Math.max(0, 1 - k);
            if (b.rest) b.bit.position.y = floor - k * 0.05;
          }
        }
        for (const d of dust) {
          d.puff.position.addScaledVector(d.dir, dt);
          d.dir.multiplyScalar(1 - 2.5 * dt);
          const k = Math.min(1, age / 0.9);
          d.puff.scale.setScalar(0.12 + k * 0.35);
          (d.puff.material as THREE.MeshLambertMaterial).opacity = 0.5 * (1 - k);
        }
        if (age < life) return true;
        this.drop(...bits.map((b) => b.bit), ...dust.map((d) => d.puff));
        return false;
      },
    });
  }
}
