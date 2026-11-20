// The waygate: the way out to the atlas and back, in town and on every map.
//
// It is not built on the ground: it hangs over it. At its heart is a lens of
// slow light, frayed at the edge, that always faces whoever looks at it; round
// that turn the three broken rings of a navigator's armillary, one of old
// stone cut with signs that burn cold, two of brass, each on its own axis and
// every piece of each bobbing in its own time. Splinters of stone and of
// light circle the whole, three keystones hover at its feet, a compass sign
// burns on the ground under it, a faint column of light stands in it and motes
// rise through it. All of it moves, so it is made as a thing of its own
// (`makeWaygate`) and not laid into anything's merged meshes.
//
// That is a gate open. Closed (`setOpen(false)`: no map is open through it) it
// is the same thing asleep: the three rings folded down flat into one tight
// knot of stone and brass just over the sign, the keystones settled on the
// ground and leaning, no lens, no column, no splinters, and the sign and the
// marks cut in the stone at an ember's glow, breathing slowly. Opening, it
// bursts: a flash at its heart, a ring of light racing out over the ground,
// sparks thrown every way, the pieces flung out past where they belong and
// settling back into their turning, the keystones leaping up, the lens lit
// from a point. Closing, it draws in and folds down, quicker and quieter.

import * as THREE from "three";
import { moteField, type Mote } from "./motes";

/** A waygate, made by `makeWaygate`. */
export interface Waygate {
  /** Add this to the scene. Its origin is the ground under the gate's middle; its stone ring faces along its z, both ways. */
  readonly object: THREE.Group;
  /**
   * What a pointer hits: an unseen column the height and width of the whole gate (nothing else of the gate
   * answers a ray), so a click anywhere on it can be read as a click on the hex it hangs over.
   */
  readonly pick: THREE.Mesh;
  /**
   * Once a frame. `time` is a clock in seconds that only runs forward (the renderer's own will do); `dark` is how
   * dark it is round the gate, 0 in broad day to 1 at night: its light lies heavier on the ground as the day goes.
   */
  update(time: number, dark?: number): void;
  /**
   * Open it (a map is open through it) or close it. It bursts open over about a second and a half and folds shut
   * in under a second; `instant` sets it with nothing played (as it is first shown, or for anyone who asked for
   * less motion, for whom it is always instant). Asking for the state it is already in or on its way to does nothing.
   */
  setOpen(open: boolean, instant?: boolean): void;
  /** Open, or on its way to it. */
  readonly open: boolean;
  dispose(): void;
}

export interface WaygateOptions {
  /** The light of it, and the deeper colour in its folds. */
  color?: THREE.ColorRepresentation;
  deep?: THREE.ColorRepresentation;
  /** The stone of its outer ring, and the metal of its inner two. */
  stone?: THREE.ColorRepresentation;
  brass?: THREE.ColorRepresentation;
  /** Give it a light of its own (one point light). Off by default: on a map, the scenery's lights carry it. */
  light?: boolean;
  /** How far above its origin the sign on the ground lies, for a gate that hangs over a plinth. */
  lift?: number;
  /** All of it this many times the size: 1 hangs about 3.5 tall over a hex a unit to the corner. */
  scale?: number;
  /** How it starts: open (the default) or closed and asleep. */
  open?: boolean;
  /** Called the moment it starts to burst open (not when it is set open instantly): the place to hang a sound on. */
  onBurst?: () => void;
}

/** How tall and how wide a gate is at scale 1: what its unseen column covers. */
export const WAYGATE_SIZE = { tall: 3.5, wide: 1.5 };

/** Where the gate's middle hangs, and how wide its lens of light is. */
const MID = 1.98;
const VEIL = 0.95;

interface RingDef {
  /** How far out, how thick across, and how deep along its axis. */
  r: number;
  thick: number;
  deep: number;
  /** Each piece's sweep, in degrees: what is missing between them is as much the look of it as what is left. */
  arcs: number[];
  /** How fast it turns in its own plane, radians a second. */
  spin: number;
  metal: boolean;
  /** How its plane lies at a moment: turned about the upright (y), then tipped (x), then rolled (z). */
  lie(t: number): [x: number, y: number, z: number];
}
const RINGS: RingDef[] = [
  // The gate itself: old stone, upright, leaning back a little as if it looked at the sky, rocking slowly.
  { r: 1.3, thick: 0.27, deep: 0.2, arcs: [52, 32, 60, 38, 30], spin: 0.09, metal: false, lie: (t) => [-0.26 + Math.sin(t * 0.31) * 0.06, Math.sin(t * 0.23) * 0.26, 0] },
  // A band of brass tipped nearly flat, wheeling round the upright.
  { r: 1.07, thick: 0.05, deep: 0.15, arcs: [104, 62, 80], spin: -0.21, metal: true, lie: (t) => [1.12 + Math.sin(t * 0.19) * 0.12, t * 0.17, 0.2] },
  // And a thin hoop inside both, tumbling the other way.
  { r: 0.9, thick: 0.045, deep: 0.045, arcs: [142, 94], spin: 0.36, metal: true, lie: (t) => [-0.78 + Math.sin(t * 0.27) * 0.2, 1 - t * 0.26, 0.6] },
];

/** A fixed 0..1 value for a pair of numbers: the same gate every time. */
const hash = (a: number, b: number, salt: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Several shapes' triangles as one, faceted. */
function mergedFacets(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const g of parts) {
    const flat = g.index ? g.toNonIndexed() : g;
    const at = flat.getAttribute("position");
    for (let i = 0; i < at.count; i++) pos.push(at.getX(i), at.getY(i), at.getZ(i));
    if (flat !== g) flat.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/**
 * A piece of a broken ring: an arc from `a0` to `a1` in the plane of x and y, its ends snapped off askew, made
 * about its own middle (`at`) so it can bob and tilt where it hangs. `signs`: marks cut into both its faces.
 */
function arcPiece(def: RingDef, a0: number, a1: number, seed: number): { body: THREE.BufferGeometry; signs: THREE.BufferGeometry | null; at: THREE.Vector2 } {
  const n = (k: number) => hash(seed, k, 14);
  const { r, thick, deep } = def;
  const [r0, r1] = [r - thick / 2, r + thick / 2];
  const mid = (a0 + a1) / 2;
  const at = new THREE.Vector2(Math.cos(mid) * r, Math.sin(mid) * r);
  // The breaks: each end is cut on a slant, so no two pieces would fit back together. (Metal snaps cleaner than stone.)
  const slant = def.metal ? 0.05 : 0.16;
  const [b0, b1] = [(n(1) - 0.5) * slant, (n(2) - 0.5) * slant];
  const steps = Math.max(2, Math.round((a1 - a0) / 0.2));
  const shape = new THREE.Shape();
  for (let i = 0; i <= steps; i++) {
    const a = a0 - b0 + ((a1 + b1 - (a0 - b0)) * i) / steps;
    const rr = r1 * (1 + (def.metal ? 0 : (n(10 + i) - 0.5) * 0.03));
    if (i === 0) shape.moveTo(Math.cos(a) * rr - at.x, Math.sin(a) * rr - at.y);
    else shape.lineTo(Math.cos(a) * rr - at.x, Math.sin(a) * rr - at.y);
  }
  for (let i = steps; i >= 0; i--) {
    const a = a0 + b0 + ((a1 - b1 - (a0 + b0)) * i) / steps;
    shape.lineTo(Math.cos(a) * r0 - at.x, Math.sin(a) * r0 - at.y);
  }
  const body = mergedFacets([new THREE.ExtrudeGeometry(shape, { depth: deep, bevelEnabled: false }).translate(0, 0, -deep / 2)]);
  const marks: THREE.BufferGeometry[] = [];
  const put = (w: number, h: number, a: number, out: number, turn: number, face: number) => {
    const g = new THREE.BoxGeometry(w, h, 0.012);
    g.rotateZ(a - Math.PI / 2 + turn);
    g.translate(Math.cos(a) * (r + out) - at.x, Math.sin(a) * (r + out) - at.y, face * (deep / 2 + 0.005));
    marks.push(g);
  };
  if (def.metal) {
    // A band of brass is marked off in degrees along its edge: every few, a tick that holds the gate's light.
    if (deep > 0.1) {
      const count = Math.max(2, Math.round((a1 - a0) / 0.2));
      for (let i = 0; i < count; i++) {
        const a = a0 + ((i + 0.5) / count) * (a1 - a0);
        const g = new THREE.BoxGeometry(0.012, 0.02, deep * (i % 3 === 0 ? 0.8 : 0.4));
        g.rotateZ(a - Math.PI / 2);
        g.translate(Math.cos(a) * (r1 + 0.004) - at.x, Math.sin(a) * (r1 + 0.004) - at.y, 0);
        marks.push(g);
      }
    }
  } else {
    const count = Math.max(1, Math.round((a1 - a0) / 0.32));
    for (let i = 0; i < count; i++) {
      const a = a0 + ((i + 0.5) / count) * (a1 - a0);
      const kind = Math.floor(n(30 + i) * 3.99);
      for (const face of [-1, 1]) {
        if (kind === 0) {
          put(thick * 0.2, thick * 0.62, a, 0, 0, face);
          put(thick * 0.56, thick * 0.16, a, thick * 0.14, 0, face);
        } else if (kind === 1) put(thick * 0.4, thick * 0.4, a, 0, Math.PI / 4, face);
        else if (kind === 2) {
          put(thick * 0.18, thick * 0.66, a, 0, 0.5, face);
          put(thick * 0.18, thick * 0.66, a, 0, -0.5, face);
        } else {
          put(thick * 0.6, thick * 0.14, a, -thick * 0.18, 0, face);
          put(thick * 0.6, thick * 0.14, a, thick * 0.18, 0, face);
          put(thick * 0.14, thick * 0.5, a, 0, 0, face);
        }
      }
    }
  }
  return { body, signs: marks.length > 0 ? mergedFacets(marks) : null, at };
}

let haloDot: THREE.CanvasTexture | null = null;
/** A soft round of light, for the glow at a gate's heart and the pool it throws on the ground. Made once and shared. */
function haloTexture(): THREE.CanvasTexture {
  if (haloDot) return haloDot;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.52)");
  g.addColorStop(0.5, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloDot = new THREE.CanvasTexture(canvas);
  haloDot.colorSpace = THREE.SRGBColorSpace;
  return haloDot;
}

const NOISE = /* glsl */ `
  uniform float uTime;
  uniform float uOpen;
  uniform vec3 uColor;
  uniform vec3 uDeep;
  varying vec2 vAt;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // 1 inside w of where x is 0, falling away to nothing at w.
  float within(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(x)); }`;

/**
 * The lens stands square to whoever looks at it, wherever they look from: it is drawn about the gate's middle in
 * the view's own frame. (And it comes up with its hex when a place rises round you: see rise.ts.)
 */
const VEIL_VERT = /* glsl */ `
  uniform vec4 gqRise;
  uniform float uSize;
  varying vec2 vAt;
  void main() {
    vAt = position.xy;
    vec4 mid = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mid.xy += position.xy * uSize * length(modelMatrix[0].xyz);
    gl_Position = projectionMatrix * mid;
    if (gqRise.w > 0.5 && distance(modelMatrix[3].xz, gqRise.xy) > gqRise.z - 2.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`;
const VEIL_FRAG = /* glsl */ `${NOISE}
  void main() {
    float r = length(vAt);
    float a = atan(vAt.y, vAt.x);
    vec2 round = vec2(cos(a), sin(a));
    // The edge frays in slow tongues, and never holds the same shape.
    float fray = noise(round * 1.6 + vec2(uTime * 0.22, -uTime * 0.17)) * 0.22 + noise(round * 4.5 - vec2(uTime * 0.4, uTime * 0.31)) * 0.1;
    float edge = 1.0 - smoothstep(0.58 - fray, 0.98 - fray, r);
    // Arms winding slowly in, a shimmer across them, and light running upward through it all like rain the wrong way.
    float arms = 0.5 + 0.5 * sin(a * 3.0 + r * 7.5 - uTime * 0.9 + noise(vAt * 2.2 + uTime * 0.12) * 3.2);
    float shimmer = noise(vec2(vAt.x * 9.0, vAt.y * 4.0 - uTime * 1.5));
    float streams = smoothstep(0.6, 0.95, noise(vec2(vAt.x * 15.0, vAt.y * 2.4 - uTime * 0.85)));
    // Far places, glimpsed: slow shapes that drift across the deep of it and never come clear.
    float far = smoothstep(0.52, 0.78, noise(vAt * 1.7 + vec2(uTime * 0.07, uTime * 0.05) + 9.0)) * (1.0 - smoothstep(0.2, 0.75, r));
    float heart = exp(-r * r * 5.2);
    float rim = smoothstep(0.42, 0.88, r) * edge;
    float glow = 0.22 + 0.5 * arms * (0.45 + 0.55 * shimmer) + 0.34 * streams + 0.55 * heart + 0.42 * rim + 0.22 * far;
    vec3 c = mix(uDeep, uColor, clamp(0.2 + arms * 0.45 + heart * 0.55 + streams * 0.3, 0.0, 1.0)) * glow;
    c = mix(c, vec3(0.8, 0.62, 1.0) * glow, far * 0.5);
    c += vec3(1.0) * pow(heart, 4.0) * 0.28;
    gl_FragColor = vec4(c, edge * clamp(0.4 + 0.3 * arms + 0.25 * streams + 0.65 * heart, 0.0, 1.0) * uOpen);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const SIGN_VERT = /* glsl */ `
  #include <common>
  varying vec2 vAt;
  void main() {
    vAt = uv * 2.0 - 1.0;
    vec3 transformed = position;
    #include <project_vertex>
  }`;
/** The sign on the ground under it: a compass of eight points inside two rings, marks turning between the rings. */
const SIGN_FRAG = /* glsl */ `${NOISE}
  void main() {
    float r = length(vAt);
    float a = atan(vAt.y, vAt.x);
    float outer = within(r - 0.9, 0.03);
    float inner = within(r - 0.63, 0.022);
    float turn = (a + uTime * 0.1) / 6.2832 * 16.0;
    float mark = step(0.28, fract(turn)) * step(fract(turn), 0.72) * step(0.4, hash(vec2(floor(turn), 3.0))) * smoothstep(0.66, 0.7, r) * (1.0 - smoothstep(0.83, 0.87, r));
    // The compass: four long points and four short between them, each a thin blade narrowing to its tip.
    float long_ = within(sin(a * 2.0), 0.3 * max(0.0, 1.0 - r / 0.6)) * step(r, 0.6);
    float short_ = within(cos(a * 2.0), 0.24 * max(0.0, 1.0 - r / 0.4)) * step(r, 0.4);
    float rose = max(long_, short_ * 0.8) * smoothstep(0.05, 0.12, r);
    // A slow pulse runs outward through all of it.
    float pulse = 0.7 + 0.3 * sin(uTime * 1.3 - r * 7.0);
    float pool = exp(-r * r * 2.4) * 0.32;
    float v = (outer + inner * 0.75 + mark * 0.85 + rose * 0.7) * pulse + pool;
    // Asleep, the sign is an ember: a fifth as bright, breathing slowly.
    v *= mix(0.2 + 0.08 * sin(uTime * 0.9), 1.0, uOpen);
    gl_FragColor = vec4(mix(uDeep, uColor, clamp(v, 0.0, 1.0)) * (0.7 + v), clamp(v, 0.0, 1.0) * (1.0 - smoothstep(0.93, 1.0, r)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function gateMaterial(vertex: string, fragment: string, color: THREE.Color, deep: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 1 }, uSize: { value: VEIL }, uColor: { value: color }, uDeep: { value: deep }, gqRise: { value: (globalThis as { __gqRise?: Float32Array }).__gqRise ?? new Float32Array(4) } },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Nothing of a gate answers a ray but its unseen column (see `Waygate.pick`). */
const noRay = () => {};

/**
 * A waygate. Nothing of it rests on the ground. Add `object` to the scene where it should hang (its origin is
 * the ground under its middle), call `update` once a frame, and `dispose` when it is done with.
 */
export function makeWaygate(opts: WaygateOptions = {}): Waygate {
  const color = new THREE.Color(opts.color ?? "#7fe4ff");
  const deep = new THREE.Color(opts.deep ?? "#3a6fe8");
  const rock = new THREE.Color(opts.stone ?? "#8a8f99");
  const brassTone = new THREE.Color(opts.brass ?? "#c79a3e");
  const lift = opts.lift ?? 0;
  const object = new THREE.Group();
  object.scale.setScalar(opts.scale ?? 1);
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(thing: T): T => {
    owned.push(thing);
    return thing;
  };
  const stoneOf = (shade: number) => keep(new THREE.MeshLambertMaterial({ color: rock.clone().multiplyScalar(shade), flatShading: true }));
  const stones = [stoneOf(1), stoneOf(0.78), stoneOf(1.16)];
  // Brass keeps a little of its shine after dark: it is lit from within the gate.
  const brass = keep(new THREE.MeshLambertMaterial({ color: brassTone, emissive: brassTone.clone().multiplyScalar(0.22), flatShading: true }));
  const lit = keep(new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.25) }));
  /** A piece of the gate: it floats, so it throws no shadow and takes none (`glow`), and no ray stops on it. */
  const piece = <T extends THREE.Object3D>(o: T): T => {
    o.userData.glow = true;
    o.raycast = noRay;
    return o;
  };
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => piece(new THREE.Mesh(keep(geometry), material));

  // ---- on the ground: the pool of light the gate throws, and the sign under it ----
  const poolMat = keep(new THREE.MeshBasicMaterial({ map: haloTexture(), color, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pool = mesh(new THREE.PlaneGeometry(6.4, 6.4).rotateX(-Math.PI / 2), poolMat);
  pool.position.y = 0.035;
  pool.renderOrder = 1;
  object.add(pool);
  const signMat = keep(gateMaterial(SIGN_VERT, SIGN_FRAG, color, deep));
  const sign = mesh(new THREE.PlaneGeometry(2.3, 2.3).rotateX(-Math.PI / 2), signMat);
  sign.position.y = lift + 0.045;
  sign.renderOrder = 1;
  object.add(sign);

  // ---- a column of faint light standing in it, brightest at the ground ----
  const shaftGeo = new THREE.CylinderGeometry(0.2, 0.62, MID - lift + 0.5, 20, 6, true);
  {
    const at = shaftGeo.getAttribute("position");
    const tall = MID - lift + 0.5;
    const tones: number[] = [];
    for (let i = 0; i < at.count; i++) {
      const v = Math.pow(1 - (at.getY(i) + tall / 2) / tall, 1.7);
      tones.push(color.r * v, color.g * v, color.b * v);
    }
    shaftGeo.setAttribute("color", new THREE.Float32BufferAttribute(tones, 3));
  }
  const shaftMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const shaft = mesh(shaftGeo, shaftMat);
  shaft.position.y = lift + (MID - lift + 0.5) / 2;
  object.add(shaft);

  // ---- everything that hangs: the lens, its heart, the rings ----
  const hung = new THREE.Group();
  object.add(hung);
  const veilMat = keep(gateMaterial(VEIL_VERT, VEIL_FRAG, color, deep));
  const veil = mesh(new THREE.PlaneGeometry(2.2, 2.2, 1, 1), veilMat);
  veil.renderOrder = 2;
  hung.add(veil);
  const halo = (size: number, opacity: number) => {
    const material = keep(new THREE.SpriteMaterial({ map: haloTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    const sprite = piece(new THREE.Sprite(material));
    sprite.scale.setScalar(size);
    sprite.renderOrder = 3;
    hung.add(sprite);
    return { sprite, material, size, opacity };
  };
  const halos = [halo(4.2, 0.22), halo(1.2, 0.26)];

  interface Piece { root: THREE.Group; at: number; r: number; phase: number }
  const rings = RINGS.map((def, k) => {
    const axis = new THREE.Group();
    axis.rotation.order = "YXZ";
    const spin = new THREE.Group();
    axis.add(spin);
    hung.add(axis);
    const pieces: Piece[] = [];
    const total = def.arcs.reduce((n, a) => n + a, 0);
    const gap = (360 - total) / def.arcs.length;
    let from = [100, 20, 200][k] ?? 0;
    def.arcs.forEach((sweep, i) => {
      const [a0, a1] = [(from * Math.PI) / 180, ((from + sweep) * Math.PI) / 180];
      from += sweep + gap * (0.7 + hash(k, i, 141) * 0.6);
      const made = arcPiece(def, a0, a1, k * 10 + i);
      const root = new THREE.Group();
      root.add(mesh(made.body, def.metal ? brass : stones[(i + k) % 3]));
      if (made.signs) root.add(mesh(made.signs, lit));
      spin.add(root);
      pieces.push({ root, at: (a0 + a1) / 2, r: def.r, phase: hash(k, i, 142) * Math.PI * 2 });
    });
    return { def, axis, spin, pieces };
  });

  // ---- splinters circling the whole: some of stone, some of brass, some of light ----
  interface Splinter { mesh: THREE.Mesh; r: number; y: number; speed: number; phase: number; tilt: number }
  const splinters: Splinter[] = [];
  const shardGeo = keep(mergedFacets([new THREE.OctahedronGeometry(1, 0)]));
  for (let i = 0; i < 11; i++) {
    const light = i % 3 === 2;
    const shard = piece(new THREE.Mesh(shardGeo, light ? lit : i % 4 === 1 ? brass : stones[i % 3]));
    const s = 0.05 + hash(i, 1, 150) * (light ? 0.035 : 0.08);
    shard.scale.set(s, s * (light ? 4.2 : 2.2 + hash(i, 2, 150) * 1.6), s * 0.8);
    object.add(shard);
    splinters.push({ mesh: shard, r: 1.55 + hash(i, 3, 150) * 0.4, y: lift + 0.55 + hash(i, 4, 150) * 2.9, speed: (0.14 + hash(i, 5, 150) * 0.2) * (i % 2 ? 1 : -1), phase: hash(i, 6, 150) * Math.PI * 2, tilt: (hash(i, 7, 150) - 0.5) * 0.9 });
  }

  // ---- the three keystones that hover at its feet: a wedge pointing up, a smaller one under it pointing down ----
  const keyGeo = keep(mergedFacets([
    new THREE.CylinderGeometry(0.06, 0.17, 0.62, 4).translate(0, 0.36, 0),
    new THREE.ConeGeometry(0.17, 0.3, 4).rotateX(Math.PI).translate(0, -0.1, 0),
  ]));
  const keySign = keep(mergedFacets([new THREE.CylinderGeometry(0.177, 0.177, 0.04, 4).translate(0, 0.065, 0), new THREE.CylinderGeometry(0.115, 0.128, 0.028, 4).translate(0, 0.38, 0)]));
  const keys = [0, 1, 2].map((i) => {
    const root = new THREE.Group();
    root.add(piece(new THREE.Mesh(keyGeo, stones[i])), piece(new THREE.Mesh(keySign, lit)));
    object.add(root);
    return { root, at: (i / 3) * Math.PI * 2 + 0.5 };
  });

  // ---- motes: rising through the lens, and off the sign on the ground ----
  const dust: Mote[] = [];
  const white = new THREE.Color("#ffffff");
  const violet = new THREE.Color("#c9a4ff");
  for (let i = 0; i < 54; i++) {
    const low = i % 3 === 0;
    const a = hash(i, 1, 160) * Math.PI * 2;
    const d = low ? 0.25 + hash(i, 2, 160) * 0.8 : hash(i, 2, 160) * 0.85;
    dust.push({
      x: Math.cos(a) * d, y: low ? lift + 0.08 : MID - 0.9 + hash(i, 3, 160) * 1.2, z: Math.sin(a) * d * (low ? 1 : 0.7),
      color: i % 5 === 0 ? white : i % 7 === 3 ? violet : color, rise: low ? 1.2 + hash(i, 5, 160) * 1.3 : 0.9 + hash(i, 5, 160) * 1.4, sway: 0.1 + hash(i, 6, 160) * 0.16,
      rate: 0.13 + hash(i, 7, 160) * 0.2, phase: hash(i, 8, 160), size: 0.5 + hash(i, 9, 160) * 0.7,
    });
  }
  const motes = moteField(dust, 0.11);
  motes.points.raycast = noRay;
  object.add(motes.points);

  const lamp = opts.light ? new THREE.PointLight(color, 0, 9, 1.5) : null;
  if (lamp) {
    lamp.position.set(0, MID - 0.3, 0);
    object.add(lamp);
  }

  // ---- what a pointer hits: one unseen column, the height of the whole thing ----
  const pick = new THREE.Mesh(keep(new THREE.CylinderGeometry(WAYGATE_SIZE.wide * 0.62, WAYGATE_SIZE.wide * 0.62, WAYGATE_SIZE.tall, 10).translate(0, WAYGATE_SIZE.tall / 2, 0)), keep(new THREE.MeshBasicMaterial({ visible: false })));
  pick.userData.glow = true;
  object.add(pick);

  // ---- what only shows as it bursts open: a flash at its heart, a ring of light over the ground, sparks ----
  const flashMat = keep(new THREE.SpriteMaterial({ map: haloTexture(), color: new THREE.Color("#ffffff"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const flashSprite = piece(new THREE.Sprite(flashMat));
  flashSprite.renderOrder = 4;
  flashSprite.visible = false;
  object.add(flashSprite);
  const shockMat = keep(new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const shock = mesh(new THREE.RingGeometry(0.86, 1.0, 56).rotateX(-Math.PI / 2), shockMat);
  shock.position.y = lift + 0.07;
  shock.renderOrder = 2;
  shock.visible = false;
  object.add(shock);
  const SPARKS = 56;
  const sparkAt = new Float32Array(SPARKS * 3);
  const sparkGeo = keep(new THREE.BufferGeometry());
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkAt, 3));
  const sparkMat = keep(new THREE.PointsMaterial({ size: 0.16, map: haloTexture(), color: color.clone().lerp(new THREE.Color("#ffffff"), 0.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  const sparks = piece(new THREE.Points(sparkGeo, sparkMat));
  sparks.frustumCulled = false;
  sparks.visible = false;
  object.add(sparks);
  /** Which way each spark is thrown, and how hard. */
  const thrown = Array.from({ length: SPARKS }, (_, i) => {
    const a = hash(i, 1, 170) * Math.PI * 2;
    const up = hash(i, 2, 170) * 1.6 - 0.5;
    const flat = Math.sqrt(Math.max(0.05, 1 - Math.min(1, up * up * 0.4)));
    return { x: Math.cos(a) * flat, y: up, z: Math.sin(a) * flat, speed: 1.6 + hash(i, 3, 170) * 3.2 };
  });

  // ---- open and shut ----
  const OPENING = 1.45;
  const CLOSING = 0.8;
  const litBase = lit.color.clone();
  const sizes = splinters.map((s) => s.mesh.scale.clone());
  const moteMat = motes.points.material as THREE.PointsMaterial;
  let wantOpen = opts.open ?? true;
  /** How open it is drawn: 0 folded down asleep, 1 hanging open, a little past 1 for a moment as it bursts. */
  let openness = wantOpen ? 1 : 0;
  /** A change under way: where it started from, how far through it is (0 to 1), and which way it goes. */
  let change: { from: number; k: number; opening: boolean } | null = null;
  let last = Number.NaN;
  /** How long the rings have been turning, in seconds: they only turn while it is open. */
  let turned = 0;
  const setOpen = (open: boolean, instant = false) => {
    if (instant || still) {
      wantOpen = open;
      change = null;
      openness = open ? 1 : 0;
      return;
    }
    if (open === wantOpen) return;
    wantOpen = open;
    change = { from: Math.max(0, Math.min(1, openness)), k: 0, opening: open };
    if (open) opts.onBurst?.();
  };

  const update = (time: number, dark = 0) => {
    const dt = Number.isNaN(last) ? 0 : Math.min(0.1, Math.max(0, time - last));
    last = time;
    /** The flash at its heart, and how far the burst has got: both nothing unless it is opening. */
    let flash = 0;
    let burst = -1;
    if (change) {
      change.k = Math.min(1, change.k + dt / (change.opening ? OPENING : CLOSING));
      const k = change.k;
      if (change.opening) {
        // A held breath while the heart flashes, then everything is flung: out past where it belongs, and back.
        const g = Math.max(0, (k - 0.06) / 0.94);
        const flung = 1 + 3.5 * (g - 1) ** 3 + 2.5 * (g - 1) ** 2;
        openness = change.from + (1 - change.from) * flung;
        flash = k < 0.07 ? k / 0.07 : Math.max(0, 1 - (k - 0.07) / 0.5);
        burst = k;
      } else {
        const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
        openness = change.from * (1 - eased);
      }
      if (k >= 1) {
        openness = change.opening ? 1 : 0;
        change = null;
      }
    }
    const o = openness;
    const oc = Math.max(0, Math.min(1, o));
    const fold = 1 - oc;
    // (For anyone who asked for less motion: the same thing, at a crawl.)
    const slow = still ? 0.12 : 1;
    const t = time * slow;
    turned += dt * oc * slow;
    signMat.uniforms.uTime.value = t;
    veilMat.uniforms.uTime.value = t;
    signMat.uniforms.uOpen.value = Math.min(1, oc + flash);
    veilMat.uniforms.uOpen.value = oc;
    motes.tick(t);
    motes.points.visible = oc > 0.02;
    moteMat.opacity = oc;
    // Open it hangs at head height and over; asleep its knot rests a hand above the sign.
    const heart = (lift + 0.4) * fold + (MID + Math.sin(t * 0.8) * 0.07) * oc + (o - oc) * 0.6;
    hung.position.y = heart;
    veil.visible = oc > 0.01;
    veilMat.uniforms.uSize.value = VEIL * (1 + Math.sin(t * 1.1) * 0.03) * (0.04 + 0.96 * Math.min(o, 1.12));
    // By day its light is one more bright thing; after dark it is the brightest thing there is.
    const night = 0.45 + 0.55 * dark;
    halos.forEach((h, i) => {
      h.material.opacity = h.opacity * night * (0.85 + 0.15 * Math.sin(t * 1.7 + i * 2)) * oc;
      h.sprite.scale.setScalar(h.size * (1 + 0.05 * Math.sin(t * 1.3 + i)) * (0.3 + 0.7 * oc));
    });
    poolMat.opacity = Math.min(1, (0.1 + 0.42 * dark) * (0.9 + 0.1 * Math.sin(t * 1.3)) * (0.14 + 0.86 * oc) + flash * 0.5);
    shaft.visible = oc > 0.01;
    shaftMat.opacity = (0.1 + 0.2 * dark) * (0.85 + 0.15 * Math.sin(t * 0.9 + 1)) * oc + flash * 0.3;
    // The marks cut in the stone: alight when it is open, an ember asleep.
    lit.color.copy(litBase).multiplyScalar((0.2 + 0.07 * Math.sin(t * 0.9)) * fold + oc + flash * 0.8);
    rings.forEach((ring, i) => {
      // Open, each lies and turns its own way; asleep they lie flat, one on another, drawn in to a knot.
      const [x, y, z] = ring.def.lie(t);
      ring.axis.rotation.set((Math.PI / 2) * fold + x * oc, i * 0.7 * fold + y * oc, z * oc);
      ring.axis.position.y = (i - 1) * 0.1 * fold;
      ring.spin.rotation.z = turned * ring.def.spin;
      const reach = 0.46 + 0.54 * o;
      for (const p of ring.pieces) {
        // In and out a little as if the ring breathed, to and fro across it, and never quite level.
        const r = p.r * reach * (1 + Math.sin(t * 0.7 + p.phase) * 0.035 * oc);
        p.root.position.set(Math.cos(p.at) * r, Math.sin(p.at) * r, Math.sin(t * 0.9 + p.phase * 1.7) * 0.07 * oc);
        p.root.rotation.set(Math.sin(t * 0.5 + p.phase) * 0.13 * oc, Math.sin(t * 0.43 + p.phase * 2.3) * 0.13 * oc, Math.sin(t * 0.6 + p.phase * 0.7) * 0.05 * oc);
      }
    });
    splinters.forEach((s, i) => {
      s.mesh.visible = oc > 0.02;
      const a = s.phase + turned * s.speed;
      const r = s.r * (0.2 + 0.8 * o);
      s.mesh.position.set(Math.cos(a) * r, heart + (s.y - MID) * oc + Math.sin(t * 0.6 + s.phase) * 0.16 * oc, Math.sin(a) * r);
      s.mesh.rotation.set(s.tilt, -a + t * 0.3, s.tilt * 0.6 + Math.sin(t * 0.4 + s.phase) * 0.2);
      s.mesh.scale.copy(sizes[i]).multiplyScalar(oc);
    });
    // The keystones: hovering and turning round its feet when it is open; asleep, set down on the ground and
    // leaning in. As it bursts they leap.
    const leap = burst >= 0 ? Math.sin(Math.PI * Math.min(1, burst * 1.25)) * 0.55 : 0;
    for (const k of keys) {
      const a = k.at + turned * 0.12;
      const r = 0.9 * fold + 1.12 * oc + (o - oc) * 0.5;
      k.root.position.set(Math.cos(a) * r, (lift + 0.25) * fold + (lift + 0.42 + Math.sin(t * 1.1 + k.at * 2) * 0.08) * oc + leap, Math.sin(a) * r);
      k.root.rotation.set(0, -a + turned * 0.25, 0.32 * fold);
    }
    // The burst itself: the flash, the ring racing out over the ground, the sparks thrown and falling.
    flashSprite.visible = flash > 0.01;
    flashSprite.position.y = heart;
    flashSprite.scale.setScalar(1.4 + 5.2 * flash);
    flashMat.opacity = Math.min(1, flash * 0.95);
    shock.visible = burst >= 0 && burst < 0.75;
    if (shock.visible) {
      const out = 1 - (1 - burst / 0.75) ** 2.4;
      shock.scale.setScalar(0.3 + 6.2 * out);
      shockMat.opacity = 0.9 * (1 - burst / 0.75) ** 1.6;
    }
    sparks.visible = burst >= 0.04 && burst < 1;
    if (sparks.visible) {
      const k = (burst - 0.04) / 0.96;
      const far = 1 - (1 - k) ** 2.2;
      for (let i = 0; i < SPARKS; i++) {
        const d = thrown[i];
        sparkAt[i * 3] = d.x * d.speed * far;
        sparkAt[i * 3 + 1] = Math.max(lift + 0.05, MID * 0.75 + d.y * d.speed * far * 0.7 - 2.2 * k * k);
        sparkAt[i * 3 + 2] = d.z * d.speed * far;
      }
      sparkGeo.getAttribute("position").needsUpdate = true;
      sparkMat.opacity = (1 - k) ** 1.3;
    }
    if (lamp) lamp.intensity = (2.2 + 5.5 * dark) * (1 + Math.sin(t * 1.3) * 0.1) * (0.08 + 0.92 * oc) + flash * 10;
  };
  update(0);
  return {
    object,
    pick,
    update,
    setOpen,
    get open() {
      return wantOpen;
    },
    dispose() {
      for (const thing of owned) thing.dispose();
      motes.dispose();
      object.clear();
    },
  };
}
