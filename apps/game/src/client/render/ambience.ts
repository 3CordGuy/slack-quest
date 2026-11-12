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
/** World units covered by one repeat of the floorboard texture: about one hex across. */
const BOARD_SPAN = 1.76;

/**
 * Floorboards for a hut: four rows of planks with staggered ends, a dark seam
 * between rows, and a few streaks of grain. Flat colours only, so it sits with
 * the rest of the scenery.
 */
const floorTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const boards = ["#b58d5e", "#a98253", "#bd9566", "#b08a5c"];
    const seam = "#7f5f3c";
    const grain = "#9c7749";
    const light = "#c9a274";
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      // Each row is two planks, with the joint somewhere different every row.
      const joint = [11, 25, 5, 19][row];
      for (let x = 0; x < 32; x++) {
        const plank = x < joint ? row : row + 2;
        ctx.fillStyle = boards[plank % boards.length];
        ctx.fillRect(x, y, 1, 7);
      }
      ctx.fillStyle = seam;
      ctx.fillRect(0, y + 7, 32, 1);
      ctx.fillRect(joint, y, 1, 7);
      // Short streaks along the plank, darker and lighter.
      for (let i = 0; i < 5; i++) {
        const gx = Math.floor(hash(row, i, 300) * 28);
        const gy = y + 1 + Math.floor(hash(row, i, 301) * 5);
        const len = 2 + Math.floor(hash(row, i, 302) * 4);
        ctx.fillStyle = i % 3 === 2 ? light : grain;
        ctx.fillRect(gx, gy, len, 1);
      }
    }
    // One knot.
    ctx.fillStyle = seam;
    ctx.fillRect(21, 11, 2, 2);
  });

/** Raindrops in the air at once. */
const DROPS = 150;
/** Puffs of smoke in the air over one chimney at a time. */
const PUFFS = 12;
/**
 * Cobbles for the Harbor's streets, as quiet as the floorboards: irregular
 * rounded stones of uneven size in four near-identical greys, with joints
 * only a shade darker and now and then a faintly mossy stone. Each pixel
 * belongs to the nearest of a scatter of stone centres, and the pixels where
 * two stones meet are the joint. The scatter wraps, so the sheet tiles.
 */
const cobbleTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const SIZE = 32;
    const CELLS = 5;
    const step = SIZE / CELLS;
    const stones = ["#72757c", "#6d7077", "#75787f", "#6f7279"];
    // One centre per cell of a coarse grid, pushed well off the middle so no rows or columns show.
    const centres: { x: number; y: number; tone: string }[] = [];
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        centres.push({
          x: (cx + 0.15 + hash(cx, cy, 610) * 0.7) * step,
          y: (cy + 0.15 + hash(cx, cy, 611) * 0.7) * step,
          tone: hash(cx, cy, 612) < 0.07 ? "#6b746c" : stones[Math.floor(hash(cx, cy, 613) * stones.length)],
        });
      }
    }
    const wrap = (d: number) => Math.min(Math.abs(d), SIZE - Math.abs(d));
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let best = Infinity;
        let second = Infinity;
        let tone = stones[0];
        for (const c of centres) {
          const d = Math.hypot(wrap(x + 0.5 - c.x), wrap(y + 0.5 - c.y));
          if (d < best) {
            second = best;
            best = d;
            tone = c.tone;
          } else if (d < second) second = d;
        }
        ctx.fillStyle = second - best < 1.1 ? "#63666d" : tone;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });

/**
 * Planks for the piers: long weathered boards running out to sea, in close
 * browns with thin dark gaps and the odd nail. Quieter than the hut floor.
 */
const pierTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    const boards = ["#9a7748", "#927044", "#a07d4e", "#967446"];
    for (let col = 0; col < 4; col++) {
      const x = col * 8;
      // Each run is two boards end to end, the joint somewhere different every run.
      const joint = [9, 22, 15, 4][col];
      for (let y = 0; y < 32; y++) {
        ctx.fillStyle = boards[(y < joint ? col : col + 2) % boards.length];
        ctx.fillRect(x, y, 7, 1);
      }
      ctx.fillStyle = "#7a5c38";
      ctx.fillRect(x + 7, 0, 1, 32);
      ctx.fillRect(x, joint, 7, 1);
      ctx.fillStyle = "#6b5234";
      ctx.fillRect(x + 3, (joint + 2) % 32, 1, 1);
      // A streak or two of pale, salt-bleached grain.
      ctx.fillStyle = "#a98658";
      for (let i = 0; i < 2; i++) ctx.fillRect(x + 1 + Math.floor(hash(col, i, 630) * 5), Math.floor(hash(col, i, 631) * 28), 1, 2 + Math.floor(hash(col, i, 632) * 3));
    }
  });

/**
 * Mud for the Harbor's unpaved ground: one brown with a faint scatter of
 * darker wet patches, paler grit and a few short ruts. Barely there.
 */
const mudTexture = () =>
  pixelTexture(32, 32, (ctx) => {
    ctx.fillStyle = "#5f5140";
    ctx.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(hash(i, 1, 620) * 32);
      const y = Math.floor(hash(i, 2, 620) * 32);
      const kind = hash(i, 3, 620);
      ctx.fillStyle = kind < 0.5 ? "#574a3a" : kind < 0.85 ? "#665846" : "#52463a";
      // Mostly single pixels; some smears two or three long, and a few ruts.
      const len = kind < 0.5 ? 1 + Math.floor(hash(i, 4, 620) * 3) : kind < 0.85 ? 1 : 4 + Math.floor(hash(i, 4, 620) * 3);
      for (let dx = 0; dx < len; dx++) ctx.fillRect((x + dx) % 32, y, 1, 1);
    }
  });

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
  /** A hut's hanging lamp: the one light indoors, and what the furniture's shadows fall away from. */
  private lamp = new THREE.PointLight("#ffd7a1", 0, 0, 0);

  private grass: THREE.InstancedMesh | null = null;
  private tufts: Tuft[] = [];
  private waves: THREE.InstancedMesh[] = [];
  private crests: Crest[] = [];
  private wisps: Wisp[] = [];
  /** The map's extent, which gusts are scattered over. */
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private wispPoints: THREE.Points | null = null;
  /** Low cloud and rain: set for a map with streets. */
  private overcast = false;
  private rain: THREE.Points | null = null;
  /** Chimney smoke: a column of pixel puffs over each stack. Outlives a map rebuild, so it is kept out of `group`. */
  private smoke: THREE.Points | null = null;
  private stacks: THREE.Vector3[] = [];
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
    this.lamp.shadow.mapSize.set(512, 512);
    this.lamp.shadow.camera.near = 0.2;
    this.lamp.shadow.camera.far = 30;
    this.lamp.shadow.bias = -0.004;
    this.lamp.visible = false;
    scene.add(this.hemi, this.sun, this.sun.target, this.lamp, this.group);
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
        const count = 1 + Math.floor(n(80) * 3.99);
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

    // ---- a hut is lit by a lamp hung over the middle of the room, not by the sky ----
    const inside = tiles.some((t) => (t.biome as string) === "floor");
    this.lamp.visible = this.lamp.castShadow = inside;
    this.sun.castShadow = !inside;
    if (inside) {
      this.lamp.position.set((minX + maxX) / 2, 2.7, (minZ + maxZ) / 2);
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), new THREE.MeshBasicMaterial({ color: "#ffe2a8" }));
      lantern.position.copy(this.lamp.position);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.28), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      cap.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.16);
      const chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.04), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      chain.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.99);
      this.group.add(lantern, cap, chain);
    }

    // ---- floorboards and cobbles: laid as one sheet each, so the pattern runs across hexes ----
    const lay = (biome: string, map: THREE.CanvasTexture, span: number) => {
      const under = tiles.filter((t) => (t.biome as string) === biome);
      if (under.length === 0) return;
      const positions: number[] = [];
      const uvs: number[] = [];
      for (const t of under) {
        const p = place(t);
        const y = p.y + 0.006;
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          const b = ((i + 1) * Math.PI) / 3;
          for (const [x, z] of [[p.x, p.z], [p.x + Math.sin(a) * 0.985, p.z + Math.cos(a) * 0.985], [p.x + Math.sin(b) * 0.985, p.z + Math.cos(b) * 0.985]]) {
            positions.push(x, y, z);
            uvs.push(x / span, z / span);
          }
        }
      }
      const sheet = new THREE.BufferGeometry();
      sheet.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      sheet.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      sheet.computeVertexNormals();
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      const mesh = new THREE.Mesh(sheet, new THREE.MeshLambertMaterial({ map }));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    lay("floor", floorTexture(), BOARD_SPAN);
    lay("cobble", cobbleTexture(), BOARD_SPAN);
    lay("mud", mudTexture(), BOARD_SPAN);
    lay("dock", pierTexture(), BOARD_SPAN);

    // ---- puddles: standing water on the mud and in the dips of the street ----
    const pools: THREE.Matrix4[] = [];
    for (const t of tiles) {
      const wet = (t.biome as string) === "mud" ? 0.45 : (t.biome as string) === "cobble" ? 0.22 : 0;
      if (wet === 0 || skip(t) || hash(t.q, t.r, 400) > wet) continue;
      const p = place(t);
      const size = 0.28 + hash(t.q, t.r, 401) * 0.3;
      pools.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(p.x + (hash(t.q, t.r, 402) - 0.5) * 0.7, p.y + 0.014, p.z + (hash(t.q, t.r, 403) - 0.5) * 0.7),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, hash(t.q, t.r, 404) * 6)),
          new THREE.Vector3(size * 1.5, size, 1),
        ),
      );
    }
    if (pools.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 7), new THREE.MeshLambertMaterial({ color: "#3b4a63" }), pools.length);
      pools.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // ---- weather: a place with streets (the Harbor) sits under low cloud and steady rain ----
    this.overcast = tiles.some((t) => (t.biome as string) === "cobble");
    if (this.overcast && !this.still) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DROPS * 2 * 3), 3));
      this.rain = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, color: "#b9c7dc", transparent: true, opacity: 0.42, depthWrite: false }));
      this.rain.frustumCulled = false;
      this.group.add(this.rain);
    }

    // ---- wisps: trails of single pixels that sway gently as they cross ----
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
    this.rain = null;
    this.tufts = [];
    this.crests = [];
    this.wisps = [];
  }

  dispose() {
    this.clear();
    this.setSmoke([]);
    this.scene.remove(this.hemi, this.sun, this.sun.target, this.lamp, this.group);
    this.lamp.shadow.map?.dispose();
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
    this.light(target, clock);
    this.fall(clock, target);
    this.puff(clock);
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
        // Every crossing is a new gust: its own place, height, length and sway.
        const gust = Math.floor(t);
        const r = (salt: number) => hash(n + 1, gust, 200 + salt);
        const head = t - gust;
        const x0 = b.minX + r(1) * (b.maxX - b.minX);
        const y0 = 1.2 + r(2) * 2.6;
        const z0 = b.minZ + r(3) * (b.maxZ - b.minZ);
        const reach = 4 + r(4) * 3;
        // A long, soft wave with a fainter, slower one under it, so no two gusts sway alike.
        const swell = 0.12 + r(10) * 0.1;
        const beat = 7 + r(11) * 6;
        const under = 0.06 + r(8) * 0.06;
        const underBeat = 3 + r(9) * 3;
        const drift = (r(12) - 0.5) * 0.8;
        const life = smooth(0, 0.12, head) * (1 - smooth(0.66, 1, head));
        for (let i = 0; i < TRAIL; i++) {
          // Each pixel follows the head a little further back along the same path.
          const s = head - i * 0.0095;
          const along = (s - 0.5) * reach;
          const up = Math.sin(s * beat + r(13) * 6) * swell + Math.sin(s * underBeat + r(6) * 6) * under + (s - 0.5) * drift;
          const k = n * TRAIL + i;
          pos.setXYZ(k, x0 + cos * along, y0 + up, z0 - sin * along);
          // Fades toward the tail, and the whole trail fades in at the start of a crossing and out over its last third.
          const fade = s <= 0 ? 0 : life * (1 - i / TRAIL) ** 0.8;
          col.setXYZW(k, 1, 0.95 + 0.05 * this.daylight, glow, fade * (0.55 + 0.35 * this.daylight));
        }
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  /** Rain: each drop is two pixels, one above the other, falling on a slant around wherever the camera looks. */
  private fall(clock: number, target: THREE.Vector3) {
    if (!this.rain) return;
    const pos = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < DROPS; i++) {
      const life = (clock * (0.9 + hash(i, 1, 500) * 0.5) + hash(i, 2, 500)) % 1;
      const y = 8 * (1 - life);
      const x = target.x + (hash(i, 3, 500) - 0.5) * 30 + life * 2.2;
      const z = target.z + (hash(i, 4, 500) - 0.5) * 24;
      pos.setXYZ(i * 2, x, y, z);
      pos.setXYZ(i * 2 + 1, x - 0.07, y + 0.24, z);
    }
    pos.needsUpdate = true;
  }

  /** Draw smoke rising from these points (chimney tops). An empty list clears it. */
  setSmoke(stacks: THREE.Vector3[]) {
    if (this.smoke) {
      this.scene.remove(this.smoke);
      this.smoke.geometry.dispose();
      (this.smoke.material as THREE.Material).dispose();
      this.smoke = null;
    }
    this.stacks = stacks;
    if (stacks.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(stacks.length * PUFFS * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(stacks.length * PUFFS * 4), 4));
    this.smoke = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    this.smoke.frustumCulled = false;
    this.scene.add(this.smoke);
  }

  /** Puffs leave the stack one after another, drift with the wind as they climb, and thin out. */
  private puff(clock: number) {
    if (!this.smoke) return;
    const pos = this.smoke.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.smoke.geometry.getAttribute("color") as THREE.BufferAttribute;
    const shade = 0.55 + 0.4 * this.daylight;
    this.stacks.forEach((stack, n) => {
      for (let i = 0; i < PUFFS; i++) {
        const life = this.still ? i / PUFFS : (clock * 0.16 + i / PUFFS + n * 0.37) % 1;
        const sway = Math.sin(life * 5 + i * 1.7 + n) * 0.1 * life;
        const k = n * PUFFS + i;
        pos.setXYZ(k, stack.x + life * life * 0.55 + sway, stack.y + life * 1.5, stack.z + Math.cos(i * 2.3) * 0.05 * life);
        col.setXYZW(k, shade, shade, shade * 1.03, Math.sin(Math.PI * Math.min(1, life * 1.15)) * 0.6 * (1 - life * 0.5));
      }
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** The turn, about the vertical, that faces something at (x, z) toward whatever lights it. */
  towardLight(x: number, z: number): number {
    return this.indoors ? Math.atan2(this.lamp.position.x - x, this.lamp.position.z - z) : Math.atan2(this.sunDir.x, this.sunDir.z);
  }

  private light(target: THREE.Vector3, clock: number) {
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

    if (this.indoors) {
      // The lamp does the work; a low fill keeps the corners readable. It wavers a little, like a flame.
      this.sun.intensity = 0;
      this.lamp.intensity = 1.5 * (this.still ? 1 : 1 + Math.sin(clock * 7) * 0.035 + Math.sin(clock * 13.3) * 0.02);
      this.hemi.intensity = 0.95;
      this.hemi.color.set("#ffe9c9");
      this.hemi.groundColor.set("#3b2f2a");
      this.background.set("#1d1a2b");
      return;
    }
    this.hemi.intensity = 1.0 + 0.5 * daylight;
    this.hemi.color.set("#7686c8").lerp(WHITE, daylight).lerp(DUSK, glow * 0.4);
    this.hemi.groundColor.set("#232a4d").lerp(GROUND_DAY, daylight);
    if (this.indoors) this.background.set("#1d1a2b");
    else this.background.set("#161c3c").lerp(SKY_DAY, daylight).lerp(DUSK, glow * 0.7);
    if (this.overcast) {
      // Low cloud: a weaker, greyer sun, a slate sky, and everything a shade cooler.
      this.sun.intensity *= 0.55;
      this.hemi.intensity *= 0.92;
      this.hemi.color.lerp(SLATE, 0.45);
      this.background.lerp(SLATE, 0.8).multiplyScalar(0.75 + 0.2 * daylight);
    }
    // Unlit cut-outs (grass, wave crests) are tinted by hand to match.
    this.flatTint.set("#56669c").lerp(WHITE, daylight).lerp(DUSK, glow * 0.2);
    if (this.overcast) this.flatTint.lerp(SLATE, 0.35).multiplyScalar(0.82);
  }
}

const WHITE = new THREE.Color("#ffffff");
const SLATE = new THREE.Color("#7f8b98");
const SUN_NOON = new THREE.Color("#fff3d6");
const SKY_DAY = new THREE.Color("#a9dcf7");
const GROUND_DAY = new THREE.Color("#5a6a8a");
const DUSK = new THREE.Color("#f2a56b");
