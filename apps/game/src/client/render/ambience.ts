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

const waveTexture = () =>
  pixelTexture(14, 4, (ctx) =>
    stamp(
      ctx,
      [
        "    aaaa      ",
        "  aa    aa    ",
        "aa        aaaa",
        "              ",
      ],
      { a: "#ffffff" },
    ),
  );

const wispTexture = () =>
  pixelTexture(20, 5, (ctx) =>
    stamp(
      ctx,
      [
        "              aa    ",
        "            aa  a   ",
        "aaaaaaaaaaaa    a   ",
        "               a    ",
        "                    ",
      ],
      { a: "#ffffff" },
    ),
  );

interface Tuft {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
}
interface Crest {
  x: number;
  y: number;
  z: number;
  size: number;
  offset: number;
  speed: number;
}
interface Wisp {
  sprite: THREE.Sprite;
  x: number;
  y: number;
  z: number;
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

  private grass: THREE.InstancedMesh | null = null;
  private tufts: Tuft[] = [];
  private waves: THREE.InstancedMesh | null = null;
  private crests: Crest[] = [];
  private wisps: Wisp[] = [];
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
        const count = n(20) < 0.55 ? 1 : n(20) < 0.85 ? 2 : 0;
        for (let i = 0; i < count; i++) {
          crests.push({
            x: p.x + (n(21 + i) - 0.5) * 1.1,
            y: p.y + 0.012,
            z: p.z + (n(24 + i) - 0.5) * 1.0,
            size: 0.55 + n(27 + i) * 0.35,
            offset: n(30 + i),
            speed: 0.16 + n(33 + i) * 0.12,
          });
        }
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

    // ---- waves: flat crests that swell, slide and sink back ----
    this.crests = crests;
    const crest = new THREE.PlaneGeometry(1, 4 / 14);
    crest.rotateX(-Math.PI / 2);
    this.waves = new THREE.InstancedMesh(
      crest,
      new THREE.MeshBasicMaterial({ map: waveTexture(), transparent: true, opacity: 0.55, depthWrite: false }),
      Math.max(1, crests.length),
    );
    this.waves.count = crests.length;
    this.waves.frustumCulled = false;
    this.group.add(this.waves);

    // ---- wisps: a few curls of wind over the island ----
    const wisp = wispTexture();
    const count = this.still ? 0 : Math.min(18, Math.max(6, Math.round(tiles.length / 28)));
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: wisp, transparent: true, opacity: 0, depthWrite: false }));
      this.group.add(sprite);
      this.wisps.push({
        sprite,
        x: minX + hash(i, 1, 100) * (maxX - minX),
        y: 1.6 + hash(i, 2, 100) * 2.6,
        z: minZ + hash(i, 3, 100) * (maxZ - minZ),
        offset: hash(i, 4, 100),
        speed: 0.07 + hash(i, 5, 100) * 0.06,
      });
    }
  }

  private clear() {
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh | THREE.Sprite;
      if (!(mesh instanceof THREE.Sprite)) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material & { map?: THREE.Texture | null };
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
    this.grass = null;
    this.waves = null;
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

    if (this.waves) {
      this.crests.forEach((c, i) => {
        const life = motion ? (clock * c.speed + c.offset) % 1 : 0.5;
        const swell = Math.sin(Math.PI * life);
        const width = c.size * (0.25 + 0.75 * swell);
        this.m.set(
          width, 0, 0, c.x + (life - 0.5) * 0.7,
          0, 1, 0, c.y,
          0, 0, c.size * swell, c.z + (life - 0.5) * 0.25,
          0, 0, 0, 1,
        );
        this.waves!.setMatrixAt(i, this.m);
      });
      this.waves.instanceMatrix.needsUpdate = true;
      (this.waves.material as THREE.MeshBasicMaterial).color.copy(this.flatTint);
    }

    for (const w of this.wisps) {
      const life = (clock * w.speed + w.offset) % 1;
      w.sprite.position.set(w.x + (life - 0.5) * 7, w.y + Math.sin(life * Math.PI * 2 + w.offset * 6) * 0.35, w.z + (life - 0.5) * 2);
      const length = 1.1 + Math.sin(Math.PI * life) * 0.7;
      w.sprite.scale.set(length, length * 0.25, 1);
      w.sprite.material.opacity = Math.sin(Math.PI * life) ** 2 * (0.25 + 0.3 * this.daylight);
      // Pale by day; a faint warm glow after dark.
      w.sprite.material.color.setRGB(1, 0.94 + 0.06 * this.daylight, 0.72 + 0.28 * this.daylight);
    }
  }

  private light(target: THREE.Vector3) {
    const t = this.timeOfDay();
    const angle = (t - 0.25) * Math.PI * 2;
    // Nudged up so the day is a little longer than the night.
    const height = Math.sin(angle) + 0.2;
    const day = height >= 0;
    const daylight = smooth(-0.25, 0.3, height);
    const glow = 1 - smooth(0, 0.5, Math.abs(height));
    this.daylight = daylight;

    // By night the same light is the moon, on the other side of the sky.
    const side = day ? -Math.cos(angle) : Math.cos(angle);
    const dir = new THREE.Vector3(side * 0.9, Math.max(Math.abs(height), 0.3) * 1.1, 0.42).normalize();
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
    this.background.set("#161c3c").lerp(SKY_DAY, daylight).lerp(DUSK, glow * 0.7);
    // Unlit cut-outs (grass, wave crests) are tinted by hand to match.
    this.flatTint.set("#56669c").lerp(WHITE, daylight).lerp(DUSK, glow * 0.2);
  }
}

const WHITE = new THREE.Color("#ffffff");
const SUN_NOON = new THREE.Color("#fff3d6");
const SKY_DAY = new THREE.Color("#a9dcf7");
const GROUND_DAY = new THREE.Color("#5a6a8a");
const DUSK = new THREE.Color("#f2a56b");
