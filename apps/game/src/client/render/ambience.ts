// The living parts of the map: a slow day and night with a moving sun and
// shadows, varied rocks on the hills, and three flat, pixel-art touches that
// move — wave crests on the water, grass tufts leaning in the wind, and wisps
// drifting through the air.
//
// Everything here is decoration. Nothing reads or changes game state, and the
// time of day comes from the wall clock, so everyone in a crew sees the same
// sky.

import * as THREE from "three";
import type { Tile } from "@gantt-quest/world";

/** One full day, in milliseconds. */
const DAY_MS = 10 * 60 * 1000;
/** Half-width of the area around the camera target that gets shadows. */
const SHADOW_REACH = 24;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (a: number, b: number, salt: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

function pixelTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fill single pixels from rows of text: any non-space character is a pixel, and letters pick the colour. */
function stamp(ctx: CanvasRenderingContext2D, rows: string[], colors: Record<string, string>) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === " ") return;
      ctx.fillStyle = colors[ch] ?? "#ffffff";
      ctx.fillRect(x, y, 1, 1);
    });
  });
}

const grassTexture = () =>
  pixelTexture(9, 6, (ctx) =>
    stamp(
      ctx,
      [
        "  a   b  ",
        "a a   b b",
        "a ab  b b",
        " aab ab b",
        " aabaabb ",
        "  abaab  ",
      ],
      { a: "#a6dd6f", b: "#5f9f45" },
    ),
  );

/** Two scallops of a cut-out wave: a white crest over a lighter blue body. */
const waveTexture = () =>
  pixelTexture(24, 6, (ctx) =>
    stamp(
      ctx,
      [
        "    wwww        wwww    ",
        "  wwbbbbww    wwbbbbww  ",
        " wbbbbbbbbw  wbbbbbbbbw ",
        "wbbbbbbbbbbwwbbbbbbbbbbw",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      { w: "#f2f9ff", b: "#4f95e4" },
    ),
  );

/** Width of a wave strip: short enough that two rows fit inside a hex at any angle. */
const WAVE_WIDTH = 1.3;
/** How far each row sits from the middle of its hex. */
const WAVE_ROW = 0.3;
/** Pixels in one wisp's trail. */
const TRAIL = 34;

interface Tuft {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
}
interface Crest {
  /** Centre of the water hex it belongs to. */
  x: number;
  y: number;
  z: number;
  phase: number;
}
interface Wisp {
  offset: number;
  speed: number;
}

export class Ambience {
  /** Everything built for the current map. */
  readonly group = new THREE.Group();
  private hemi = new THREE.HemisphereLight("#ffffff", "#5a6a8a", 1.5);
  private sun = new THREE.DirectionalLight("#fff3d6", 1.6);
  private background = new THREE.Color("#a9dcf7");
  /** How much of the day's light there is, 0 (night) to 1. */
  private daylight = 1;
  /** A room: steady lamplight, a dark backdrop and no wind. */
  private indoors = false;
  /** Direction to the sun (or the moon), for anything that must face it. */
  readonly sunDir = new THREE.Vector3(-0.4, 0.8, 0.4);

  private grass: THREE.InstancedMesh | null = null;
  private tufts: Tuft[] = [];
  private waves: THREE.InstancedMesh[] = [];
  private crests: Crest[] = [];
  private wisps: Wisp[] = [];
  /** The map's extent, which gusts are scattered over. */
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private wispPoints: THREE.Points | null = null;
  private flatTint = new THREE.Color();
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private m = new THREE.Matrix4();

  constructor(private scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    // Hard-edged shadows suit the flat, pixelated look.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    scene.background = this.background;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_REACH;
    cam.right = SHADOW_REACH;
    cam.top = SHADOW_REACH;
    cam.bottom = -SHADOW_REACH;
    cam.near = 1;
    cam.far = 120;
    this.sun.shadow.bias = -0.0015;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.hemi, this.sun, this.sun.target, this.group);
  }

  /** Lay out the decoration for a map. `skip` holds the hexes to leave clear. */
  build(tiles: Tile[], skip: (t: Tile) => boolean, place: (t: Tile) => { x: number; y: number; z: number }) {
    this.clear();

    // ---- rocks: one to three per hill, in three shapes and a few greys ----
    const shapes = [
      new THREE.DodecahedronGeometry(0.3, 0),
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.BoxGeometry(0.34, 0.5, 0.3),
      new THREE.TetrahedronGeometry(0.34, 0),
    ];
    const tones = ["#8d8674", "#7b786f", "#9c917b", "#6d6960", "#a39a86"];
    const rocks: { m: THREE.Matrix4; tone: string }[][] = shapes.map(() => []);
    const tufts: Tuft[] = [];
    const crests: Crest[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (const t of tiles) {
      const p = place(t);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      const n = (salt: number) => hash(t.q, t.r, salt);

      if (t.biome === "water") {
        crests.push({ x: p.x, y: p.y - 0.13, z: p.z, phase: p.x * 0.35 + n(21) * 1.5 });
        continue;
      }
      if (skip(t)) continue;

      if (t.biome === "hills") {
        const count = 1 + Math.floor(n(40) * 2.99);
        for (let i = 0; i < count; i++) {
          const shape = Math.floor(n(41 + i) * shapes.length);
          const s = (i === 0 ? 0.8 : 0.4) + n(44 + i) * 0.55;
          // Slabs and spires stand taller; boulders sit squat.
          const tall = shape === 2 ? 0.9 + n(47 + i) * 0.9 : shape === 3 ? 1.1 + n(47 + i) * 0.6 : 0.65 + n(47 + i) * 0.3;
          const angle = (i / count) * Math.PI * 2 + n(50) * 6;
          const spread = i === 0 ? 0.15 : 0.5;
          rocks[shape].push({
            m: new THREE.Matrix4().compose(
              new THREE.Vector3(p.x + Math.sin(angle) * spread, p.y + 0.1 * s * tall, p.z + Math.cos(angle) * spread * 0.9 - 0.12),
              new THREE.Quaternion().setFromEuler(new THREE.Euler((n(53 + i) - 0.5) * 0.5, n(56 + i) * 6, (n(59 + i) - 0.5) * 0.4)),
              new THREE.Vector3(s, s * tall, s),
            ),
            tone: tones[Math.floor(n(62 + i) * tones.length)],
          });
        }
        if (n(70) < 0.35) tufts.push({ x: p.x + (n(71) - 0.5) * 1.1, y: p.y, z: p.z + 0.45, size: 0.3, phase: n(72) * 6 });
      } else if (t.biome === "plains") {
        const count = Math.floor(n(80) * 2.7);
        for (let i = 0; i < count; i++) {
          const angle = n(81 + i) * Math.PI * 2;
          const spread = 0.25 + n(84 + i) * 0.5;
          tufts.push({
            x: p.x + Math.sin(angle) * spread,
            y: p.y,
            z: p.z + Math.cos(angle) * spread,
            size: 0.3 + n(87 + i) * 0.2,
            phase: p.x * 0.6 + p.z * 0.35 + n(90 + i),
          });
        }
      }
    }

    const tone = new THREE.Color();
    shapes.forEach((geometry, s) => {
      const list = rocks[s];
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), Math.max(1, list.length));
      mesh.count = list.length;
      list.forEach((rock, i) => {
        mesh.setMatrixAt(i, rock.m);
        mesh.setColorAt(i, tone.set(rock.tone));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    });

    // ---- grass: upright cut-outs that turn to the camera and lean with the wind ----
    this.tufts = tufts;
    const blade = new THREE.PlaneGeometry(1.5, 1);
    blade.translate(0, 0.5, 0);
    this.grass = new THREE.InstancedMesh(
      blade,
      new THREE.MeshBasicMaterial({ map: grassTexture(), alphaTest: 0.5, side: THREE.DoubleSide }),
      Math.max(1, tufts.length),
    );
    this.grass.count = tufts.length;
    this.grass.frustumCulled = false;
    this.group.add(this.grass);

    // ---- waves: two rows of upright paper cut-outs on each water hex ----
    // Each strip is short enough to stay inside its own hex however the view is turned.
    // The scallops scroll along it, the back row one way and the front row the other.
    this.crests = crests;
    this.waves = [0, 1].map(() => {
      const strip = new THREE.PlaneGeometry(WAVE_WIDTH, WAVE_WIDTH * (6 / 24) * 1.25);
      strip.translate(0, WAVE_WIDTH * (6 / 24) * 0.625, 0);
      const map = waveTexture();
      map.wrapS = THREE.RepeatWrapping;
      map.repeat.x = 0.8;
      const mesh = new THREE.InstancedMesh(strip, new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }), Math.max(1, crests.length));
      mesh.count = crests.length;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });

    this.bounds = { minX, maxX, minZ, maxZ };
    // ---- wisps: trails of single pixels that curl through a loop as they cross ----
    // No wind indoors.
    const indoors = (this.indoors = tiles.some((t) => (t.biome as string) === "floor"));
    const count = this.still || indoors ? 0 : Math.min(14, Math.max(7, Math.round(tiles.length / 30)));
    for (let i = 0; i < count; i++) {
      this.wisps.push({ offset: hash(i, 4, 100), speed: 0.1 + hash(i, 5, 100) * 0.07 });
    }
    if (count > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * TRAIL * 3), 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * TRAIL * 4), 4));
      this.wispPoints = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
      this.wispPoints.frustumCulled = false;
      this.group.add(this.wispPoints);
    }
  }

  private clear() {
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh | THREE.Points;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.Material & { map?: THREE.Texture | null };
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
    this.grass = null;
    this.waves = [];
    this.wispPoints = null;
    this.tufts = [];
    this.crests = [];
    this.wisps = [];
  }

  dispose() {
    this.clear();
    this.scene.remove(this.hemi, this.sun, this.sun.target, this.group);
    this.sun.shadow.map?.dispose();
  }

  /** Time of day from 0 to 1: 0 is midnight, 0.5 is noon. */
  private timeOfDay(): number {
    if (import.meta.env.DEV) {
      const forced = (globalThis as { __gqTime?: number }).__gqTime;
      if (typeof forced === "number") return forced;
    }
    return (Date.now() % DAY_MS) / DAY_MS;
  }

  /** Advance the sky and everything that sways. `yaw` is the camera's turn; `target` is what it looks at. */
  update(clock: number, yaw: number, target: THREE.Vector3) {
    this.light(target);
    const motion = this.still ? 0 : 1;

    if (this.grass) {
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      this.tufts.forEach((t, i) => {
        // A slow swell with a quicker flutter on top, rolling across the island.
        const lean = motion * (Math.sin(clock * 1.3 + t.phase) * 0.22 + Math.sin(clock * 3.1 + t.phase * 1.7) * 0.07 + 0.08);
        const w = t.size;
        // Columns: right, up (sheared toward the wind), and the facing normal.
        this.m.set(
          cos * w, cos * lean * w, sin, t.x,
          0, w, 0, t.y,
          -sin * w, -sin * lean * w, cos, t.z,
          0, 0, 0, 1,
        );
        this.grass!.setMatrixAt(i, this.m);
      });
      this.grass.instanceMatrix.needsUpdate = true;
      (this.grass.material as THREE.MeshBasicMaterial).color.copy(this.flatTint);
    }

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.waves.forEach((mesh, row) => {
      // Front row (toward the camera) is row 1.
      const off = row ? WAVE_ROW : -WAVE_ROW;
      this.crests.forEach((c, i) => {
        const bob = motion * Math.sin(clock * 1.8 + c.phase * 2 + row * 1.6) * 0.03;
        this.m.set(
          cos, 0, sin, c.x + sin * off,
          0, 1, 0, c.y + bob - (row ? 0.03 : 0),
          -sin, 0, cos, c.z + cos * off,
          0, 0, 0, 1,
        );
        mesh.setMatrixAt(i, this.m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(this.flatTint);
      material.map!.offset.x = motion * clock * (row ? 0.11 : -0.08) + row * 0.25;
    });

    if (this.wispPoints) {
      const pos = this.wispPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
      const col = this.wispPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
      const glow = 0.72 + 0.28 * this.daylight;
      const b = this.bounds;
      this.wisps.forEach((w, n) => {
        const t = clock * w.speed + w.offset;
        // Every crossing is a new gust: its own place, height, length, and its own curls.
        const gust = Math.floor(t);
        const r = (salt: number) => hash(n + 1, gust, 200 + salt);
        const head = t - gust;
        const x0 = b.minX + r(1) * (b.maxX - b.minX);
        const y0 = 1.2 + r(2) * 2.6;
        const z0 = b.minZ + r(3) * (b.maxZ - b.minZ);
        const reach = 4 + r(4) * 3;
        // One to three open curls, each somewhere different along the way and its own size.
        const curls = r(5) < 0.5 ? 1 : r(5) < 0.9 ? 2 : 3;
        const at1 = 0.18 + r(6) * 0.15;
        const at2 = at1 + 0.2 + r(7) * 0.1;
        const at3 = at2 + 0.18 + r(14) * 0.08;
        const size1 = 0.3 + r(8) * 0.25;
        const size2 = 0.24 + r(9) * 0.2;
        const size3 = 0.2 + r(15) * 0.15;
        // A slow, shallow ripple the whole way, so the line is never straight.
        const ripple = 0.1 + r(10) * 0.08;
        const beat = 14 + r(11) * 12;
        const drift = (r(12) - 0.5) * 0.8;
        for (let i = 0; i < TRAIL; i++) {
          // Each pixel follows the head a little further back along the same path.
          const s = head - i * 0.0095;
          let along = (s - 0.5) * reach;
          let up = Math.sin(s * beat + r(13) * 6) * ripple + (s - 0.5) * drift;
          if (curls >= 1) {
            const u = smooth(at1 - 0.08, at1 + 0.08, s) * Math.PI * 2;
            along -= Math.sin(u) * size1;
            up += (1 - Math.cos(u)) * size1;
          }
          if (curls >= 2) {
            const u = smooth(at2 - 0.07, at2 + 0.07, s) * Math.PI * 2;
            along -= Math.sin(u) * size2;
            up += (1 - Math.cos(u)) * size2;
          }
          if (curls >= 3) {
            const u = smooth(at3 - 0.06, at3 + 0.06, s) * Math.PI * 2;
            along -= Math.sin(u) * size3;
            up += (1 - Math.cos(u)) * size3;
          }
          const k = n * TRAIL + i;
          pos.setXYZ(k, x0 + cos * along, y0 + up, z0 - sin * along);
          // Fades toward the tail, and in and out at the ends of the crossing.
          const fade = s <= 0 ? 0 : Math.sin(Math.PI * Math.min(1, s)) ** 0.6 * (1 - i / TRAIL) ** 0.8;
          col.setXYZW(k, 1, 0.95 + 0.05 * this.daylight, glow, fade * (0.55 + 0.35 * this.daylight));
        }
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  private light(target: THREE.Vector3) {
    const t = this.indoors ? 0.42 : this.timeOfDay();
    const angle = (t - 0.25) * Math.PI * 2;
    // Nudged up so the day is a little longer than the night.
    const height = Math.sin(angle) + 0.2;
    const day = height >= 0;
    const daylight = smooth(-0.25, 0.3, height);
    const glow = 1 - smooth(0, 0.5, Math.abs(height));
    this.daylight = daylight;

    // By night the same light is the moon, on the other side of the sky.
    const side = day ? -Math.cos(angle) : Math.cos(angle);
    const dir = this.sunDir.set(side * 0.9, Math.max(Math.abs(height), 0.3) * 1.1, 0.42).normalize();
    this.sun.position.copy(target).addScaledVector(dir, 50);
    this.sun.target.position.copy(target);
    if (day) {
      this.sun.color.set("#ff8a4c").lerp(SUN_NOON, smooth(0.05, 0.6, height));
      this.sun.intensity = 1.6 * smooth(0, 0.35, height);
    } else {
      this.sun.color.set("#9db4ff");
      this.sun.intensity = 0.7 * smooth(0, 0.35, -height);
    }

    this.hemi.intensity = 1.0 + 0.5 * daylight;
    this.hemi.color.set("#7686c8").lerp(WHITE, daylight).lerp(DUSK, glow * 0.4);
    this.hemi.groundColor.set("#232a4d").lerp(GROUND_DAY, daylight);
    if (this.indoors) this.background.set("#1d1a2b");
    else this.background.set("#161c3c").lerp(SKY_DAY, daylight).lerp(DUSK, glow * 0.7);
    // Unlit cut-outs (grass, wave crests) are tinted by hand to match.
    this.flatTint.set("#56669c").lerp(WHITE, daylight).lerp(DUSK, glow * 0.2);
  }
}

const WHITE = new THREE.Color("#ffffff");
const SUN_NOON = new THREE.Color("#fff3d6");
const SKY_DAY = new THREE.Color("#a9dcf7");
const GROUND_DAY = new THREE.Color("#5a6a8a");
const DUSK = new THREE.Color("#f2a56b");
