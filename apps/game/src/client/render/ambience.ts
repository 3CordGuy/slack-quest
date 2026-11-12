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
import type { LightKind } from "./props";

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
/** Droplets in one splash against the rocks. */
const SPLASH_DROPS = 6;
/** How long one spell of weather lasts before the sky starts turning to the next. */
const WEATHER_SPELL_MS = 7 * 60 * 1000;
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

/**
 * A puddle: a blocky pixel blob of dark water, stepped at the ends rather than
 * round, with a pale glint along its far edge.
 */
const puddleTexture = () =>
  pixelTexture(12, 8, (ctx) => {
    const water: [number, number, number][] = [[0, 3, 8], [1, 1, 10], [2, 0, 11], [3, 0, 11], [4, 0, 10], [5, 1, 10], [6, 2, 8], [7, 4, 6]];
    ctx.fillStyle = "#3b4a63";
    for (const [y, a, b] of water) ctx.fillRect(a, y, b - a + 1, 1);
    ctx.fillStyle = "#33405a";
    ctx.fillRect(2, 5, 6, 1);
    ctx.fillStyle = "#6f86a8";
    ctx.fillRect(4, 1, 3, 1);
    ctx.fillRect(8, 2, 1, 1);
  });

/**
 * Which way the wind blows across the map, as a unit vector on the ground:
 * mostly along +x, a little toward +z. Wisps travel this way and rain slants
 * with it, fixed in the world so turning the camera never turns the weather.
 */
const WIND = (() => {
  const a = 0.35;
  return { x: Math.cos(a), z: Math.sin(a) };
})();

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

/** How many plain lights candles and lanterns share. Fixed, so adding a candle never recompiles a material. */
const GLOW_LIGHTS = 4;

/**
 * How many of a hut's candles, lanterns and fires throw shadows at once: the
 * ones nearest your hero. Fixed, so walking past a candle never changes the
 * number of shadow-casting lights (and recompiles every material); lights are
 * moved between pieces instead.
 */
export const SHADOW_SLOTS = 6;
/**
 * The layer heroes' shadow cards for the sun and the hanging lamp sit on. Not
 * layer 0, so the main view never draws them; each light's shadow camera looks
 * at layer 0 (the room) plus the layer of the cards turned toward it.
 */
export const CARD_LAYER = 9;
/** Shadow slot `i` sees the cards on layer `SLOT_LAYER + i`, each turned to face it. */
export const SLOT_LAYER = 10;
/** Shadow maps a moving hero may redraw in one frame. Others wait their turn (a frame or two), oldest first. */
const MOVE_REDRAWS = 2;
/** How far past a light's reach a hero can stand and still throw a shadow it draws: about a hero's height. */
const STIR_MARGIN = 1.6;
/** How much nearer (in world units) another piece must be before a shadow slot is handed to it from the one it lights. */
const SLOT_HOLD = 1;
/** How much nearer a fire counts as when the slots are handed out. */
const FIRE_PULL = 3;

/** How each kind of small light looks outdoors, and indoors under the lamp. Outdoor fires past the first use these too. */
const GLOW: Record<LightKind, { color: string; power: number; range: number; flicker: boolean }> = {
  candle: { color: "#ffb35c", power: 0.9, range: 3.2, flicker: true },
  lamp: { color: "#ffd08a", power: 1.5, range: 4.5, flicker: false },
  fire: { color: "#ff9548", power: 2.2, range: 5, flicker: true },
};

export class Ambience {
  /** Everything built for the current map. */
  readonly group = new THREE.Group();
  private hemi = new THREE.HemisphereLight("#ffffff", "#5a6a8a", 1.5);
  private sun = new THREE.DirectionalLight("#fff3d6", 1.6);
  private background = new THREE.Color("#a9dcf7");
  /** How much of the day's light there is, 0 (night) to 1. */
  private daylight = 1;
  /** How dark it is outdoors, 0 (full day) to 1 (deep night). Always 0 indoors. */
  get night(): number {
    return this.indoors ? 0 : 1 - this.daylight;
  }
  /** A room: steady lamplight, a dark backdrop and no wind. */
  private indoors = false;
  /** Direction to the sun (or the moon), for anything that must face it. */
  readonly sunDir = new THREE.Vector3(-0.4, 0.8, 0.4);
  /** A hut's hanging lamp over the middle of the room, which its owner can put out. */
  private lamp = new THREE.PointLight("#ffd7a1", 0, 0, 0);
  /** Whether the hut's hanging lamp is lit. Off, the room is lit only by its candles, lanterns and fires. */
  private lampOn = true;
  /** The lamp's glowing lantern, dimmed when the lamp is put out. */
  private lanternMat: THREE.MeshBasicMaterial | null = null;
  /**
   * Firelight outdoors: one warm light for the campfire nearest the camera's
   * target, no shadows, showing only once the light starts to go. Always in the
   * scene outdoors, so adding a fire never changes the number of lights (and
   * recompiles every material). Hidden indoors, where the shadow slots light the fires.
   */
  private fireLight = new THREE.PointLight("#ff9548", 0, 6, 2);
  /**
   * Indoors, the candles, lanterns and fires nearest your hero each get one of
   * these: a light with its own shadow map, so every one of them throws the
   * hero's and the furniture's shadows. The maps are drawn only when something
   * in reach changes (see stir), not every frame. Hidden outdoors.
   */
  private slots = Array.from({ length: SHADOW_SLOTS }, () => new THREE.PointLight("#ffb35c", 0, 6, 1));
  /** The piece each slot is lighting, or null while it has none. */
  private slotOf: ({ pos: THREE.Vector3; kind: LightKind } | null)[] = Array(SHADOW_SLOTS).fill(null);
  /** Slots a moving hero has asked to redraw, waiting for their turn. */
  private stirred = new Set<number>();
  /** The frame each slot's map was last drawn on, so the longest-waiting go first. */
  private drawnAt: number[] = Array(SHADOW_SLOTS).fill(0);
  private frameNo = 0;
  /** Where your hero stands, for picking the slot to redraw first. */
  private focus = new THREE.Vector3();
  /**
   * Candles, lanterns and fires past those: a few plain lights (no shadows)
   * handed to the ones nearest each frame. Also always in the scene, for the same reason.
   */
  private glows = Array.from({ length: GLOW_LIGHTS }, () => new THREE.PointLight("#ffb35c", 0, 4, 2));
  private lights: { pos: THREE.Vector3; kind: LightKind }[] = [];
  private flames: THREE.Mesh[] = [];

  private grass: THREE.InstancedMesh | null = null;
  private tufts: Tuft[] = [];
  private waves: THREE.InstancedMesh[] = [];
  private crests: Crest[] = [];
  private wisps: Wisp[] = [];
  /** The map's extent, which gusts are scattered over. */
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private wispPoints: THREE.Points | null = null;
  /** Low cloud and rain: set for a map with streets. */
  /** The map is the Harbor (it has streets): its weather runs wetter. */
  private wetPort = false;
  private outdoors = true;
  /** How cloudy and how rainy it is right now, 0 to 1 each. */
  private cloud = 0;
  private rainfall = 0;
  private rain: THREE.Points | null = null;
  /** Where the sea breaks on rock: a point on the shared edge, the way out to sea, and its own rhythm. */
  private splashes: { x: number; y: number; z: number; nx: number; nz: number; phase: number; period: number }[] = [];
  private splashPoints: THREE.Points | null = null;
  private shoreSplashes: typeof this.splashes = [];
  private rockSplashes: typeof this.splashes = [];
  /** Chimney smoke: a column of pixel puffs over each stack. Outlives a map rebuild, so it is kept out of `group`. */
  private smoke: THREE.Points | null = null;
  private stacks: THREE.Vector3[] = [];
  /**
   * A lighthouse's lamp: two soft beams turning slowly round it and a glow on the lantern. Additive meshes and a
   * sprite, no light of its own, so the light count never changes. Kept out of `group`, like the smoke.
   */
  private beacon: { root: THREE.Group; spin: THREE.Group; beams: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial; halo: THREE.Sprite } | null = null;
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
    // The sun and the lamp see the room and the heroes' cards turned toward them.
    this.sun.shadow.camera.layers.enable(CARD_LAYER);
    this.lamp.shadow.mapSize.set(512, 512);
    this.lamp.shadow.camera.near = 0.2;
    this.lamp.shadow.camera.far = 30;
    this.lamp.shadow.bias = -0.004;
    this.lamp.shadow.camera.layers.enable(CARD_LAYER);
    // A room stands still: the lamp's shadows are redrawn only when something changes (see stir).
    this.lamp.shadow.autoUpdate = false;
    this.lamp.visible = false;
    this.slots.forEach((s, i) => {
      // 256 a face: six of them, so a phone keeps its memory, and the coarse edge suits the pixels.
      s.shadow.mapSize.set(256, 256);
      s.shadow.camera.near = 0.1;
      s.shadow.bias = -0.004;
      s.shadow.autoUpdate = false;
      s.shadow.camera.layers.enable(SLOT_LAYER + i);
      // Always casting while indoors: only the light's place and strength change, so no material ever recompiles.
      s.castShadow = true;
      s.visible = false;
    });
    scene.add(this.hemi, this.sun, this.sun.target, this.lamp, this.fireLight, ...this.slots, ...this.glows, this.group);
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
    this.lamp.visible = inside;
    // Casting even while it is out (at no strength, its map not redrawn), so putting it out never recompiles a material.
    this.lamp.castShadow = inside;
    this.sun.castShadow = !inside;
    this.fireLight.visible = !inside;
    for (const s of this.slots) s.visible = inside;
    this.slotOf.fill(null);
    this.stirAll();
    if (inside) {
      this.lamp.position.set((minX + maxX) / 2, 2.7, (minZ + maxZ) / 2);
      this.lanternMat = new THREE.MeshBasicMaterial({ color: this.lampOn ? "#ffe2a8" : "#4a3f30" });
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), this.lanternMat);
      lantern.position.copy(this.lamp.position);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.28), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      cap.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.16);
      const chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.04), new THREE.MeshBasicMaterial({ color: "#3a2c22" }));
      chain.position.copy(this.lamp.position).setY(this.lamp.position.y + 0.99);
      this.group.add(lantern, cap, chain);
    }

    // ---- floorboards and cobbles: laid as one sheet each, so the pattern runs across hexes ----
    const lay = (biome: string, map: THREE.CanvasTexture, span: number, material?: THREE.Material) => {
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
      const mesh = new THREE.Mesh(sheet, material ?? new THREE.MeshLambertMaterial({ map }));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    // The Harbor's grass is drabbed by the wet, as the renderer does for every grass tile in a port.
    const wet = tiles.some((t) => (t.biome as string) === "cobble");
    const grassTint = new THREE.Color("#7cb856");
    if (wet) grassTint.lerp(new THREE.Color("#5d6a5c"), 0.5);
    lay("floor", floorTexture(), BOARD_SPAN);
    lay("cobble", cobbleTexture(), BOARD_SPAN);
    lay("mud", mudTexture(), BOARD_SPAN);
    lay("dock", pierTexture(), BOARD_SPAN);
    // ---- grass edges: where a dirt path meets grass, the grass breaks up into tiny hexes across the dirt ----
    // The tiny hexes sit on one lattice for the whole map, so they line up across tile borders, and thin out
    // the further they are from the grass: about half the edge row, a few just beyond it, then bare dirt.
    const byKey = new Map(tiles.map((t) => [`${t.q},${t.r}`, t]));
    const MINI = 0.13;
    const stepX = Math.sqrt(3) * MINI;
    const stepZ = 1.5 * MINI;
    const APOTHEM = 0.985 * Math.cos(Math.PI / 6);
    const bits: { m: THREE.Matrix4; tone: number }[] = [];
    for (const t of tiles) {
      if ((t.biome as string) !== "mud" || skip(t)) continue;
      const p = place(t);
      // The sides of this hex that face grass, as their two corners.
      const edges: { ax: number; az: number; bx: number; bz: number; y: number }[] = [];
      for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
        const nb = byKey.get(`${t.q + dq},${t.r + dr}`);
        if (!nb || (nb.biome as string) !== "plains") continue;
        const o = place(nb);
        const side = (((Math.round(Math.atan2(o.x - p.x, o.z - p.z) / (Math.PI / 3) - 0.5) % 6) + 6) % 6);
        const a = (side * Math.PI) / 3;
        const b = ((side + 1) * Math.PI) / 3;
        edges.push({ ax: p.x + Math.sin(a) * 0.985, az: p.z + Math.cos(a) * 0.985, bx: p.x + Math.sin(b) * 0.985, bz: p.z + Math.cos(b) * 0.985, y: o.y });
      }
      if (edges.length === 0) continue;
      const toEdge = (x: number, z: number, e: (typeof edges)[number]) => {
        const dx = e.bx - e.ax, dz = e.bz - e.az;
        const f = Math.max(0, Math.min(1, ((x - e.ax) * dx + (z - e.az) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(x - (e.ax + dx * f), z - (e.az + dz * f));
      };
      for (let row = Math.floor((p.z - 1) / stepZ); row <= Math.ceil((p.z + 1) / stepZ); row++) {
        const z = row * stepZ;
        const shift = row % 2 === 0 ? 0 : stepX / 2;
        for (let col = Math.floor((p.x - 1) / stepX) - 1; col <= Math.ceil((p.x + 1) / stepX) + 1; col++) {
          const x = col * stepX + shift;
          // Only whole tiny hexes, inside this tile.
          const vx = x - p.x, vz = z - p.z;
          let inside = true;
          for (let k = 0; k < 6; k++) {
            const n = Math.PI / 6 + (k * Math.PI) / 3;
            if (vx * Math.sin(n) + vz * Math.cos(n) > APOTHEM - MINI * 0.9) inside = false;
          }
          if (!inside) continue;
          let near = Infinity;
          let y = p.y;
          for (const e of edges) {
            const d = toEdge(x, z, e);
            if (d < near) {
              near = d;
              y = e.y;
            }
          }
          const roll = hash(col, row, 660);
          const keep = near < MINI * 1.2 ? 0.5 : near < MINI * 2.6 ? 0.15 : 0;
          if (roll >= keep) continue;
          // The first row stands at the grass's height; the scattered ones further out sit lower, on the dirt.
          const top = near < MINI * 1.2 ? y : p.y + 0.02;
          bits.push({
            m: new THREE.Matrix4().compose(new THREE.Vector3(x, (top + p.y) / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, Math.max(0.02, top - p.y + 0.012), 1)),
            tone: hash(col, row, 661),
          });
        }
      }
    }
    if (bits.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(MINI * 0.96, MINI * 0.96, 1, 6), new THREE.MeshLambertMaterial({ flatShading: true }), bits.length);
      const c = new THREE.Color();
      bits.forEach((bit, i) => {
        mesh.setMatrixAt(i, bit.m);
        // Mostly the grass's own green, with the odd lighter or darker one.
        mesh.setColorAt(i, c.copy(grassTint).offsetHSL(0, 0, bit.tone < 0.15 ? -0.04 : bit.tone > 0.85 ? 0.04 : 0));
      });
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.group.add(mesh);
    }

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
          // Square to the ground's pixels, never turned, so the blocky edge stays crisp; some are flipped for variety.
          new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
          new THREE.Vector3(size * (hash(t.q, t.r, 404) < 0.5 ? -1 : 1), size, 1),
        ),
      );
    }
    if (pools.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 1), new THREE.MeshLambertMaterial({ map: puddleTexture(), alphaTest: 0.5, side: THREE.DoubleSide }), pools.length);
      pools.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // ---- splashes: where the sea meets rock (hills, the rampart), it breaks in little pixel bursts ----
    {
      const byKey = new Map(tiles.map((t) => [`${t.q},${t.r}`, t]));
      const rocky = new Set(["hills", "rampart"]);
      const splashes: typeof this.splashes = [];
      for (const t of tiles) {
        if (!rocky.has(t.biome as string) || skip(t)) continue;
        const p = place(t);
        for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const nb = byKey.get(`${t.q + dq},${t.r + dr}`);
          if (!nb || (nb.biome as string) !== "water") continue;
          const o = place(nb);
          const dx = o.x - p.x, dz = o.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          // One or two spots along each wet edge, a little apart, so a long shore does not pulse in step.
          const count = 1 + (hash(t.q * 3 + dq, t.r * 5 + dr, 700) < 0.4 ? 1 : 0);
          for (let i = 0; i < count; i++) {
            const along = (hash(t.q + i, t.r + dq * 7 + dr, 701) - 0.5) * 0.9;
            splashes.push({
              x: (p.x + o.x) / 2 - (dz / len) * along,
              z: (p.z + o.z) / 2 + (dx / len) * along,
              y: o.y + 0.02,
              nx: dx / len,
              nz: dz / len,
              phase: hash(t.q, t.r, 702 + i * 3 + dq) * 10,
              period: 2.2 + hash(t.q, t.r, 703 + i + dr) * 2.6,
            });
          }
        }
      }
      this.shoreSplashes = splashes;
      this.rockSplashes = [];
      this.layOutSplashes();
    }

    // ---- weather: outdoors the sky changes with the clock (see weather()); a port with streets is wetter than an island ----
    this.wetPort = tiles.some((t) => (t.biome as string) === "cobble");
    this.outdoors = !tiles.some((t) => (t.biome as string) === "floor");
    if (this.outdoors && !this.still) {
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
    this.splashPoints = null;
    this.splashes = [];
    this.shoreSplashes = [];
    this.rockSplashes = [];
    this.tufts = [];
    this.crests = [];
    this.wisps = [];
  }

  dispose() {
    this.clear();
    this.setSmoke([]);
    this.setBeacon(null);
    this.scene.remove(this.hemi, this.sun, this.sun.target, this.lamp, this.fireLight, ...this.slots, ...this.glows, this.group);
    this.lamp.shadow.map?.dispose();
    this.fireLight.shadow.map?.dispose();
    for (const s of this.slots) s.shadow.map?.dispose();
    this.sun.shadow.map?.dispose();
  }

  /** Time of day from 0 to 1: 0 is midnight, 0.5 is noon. */
  /**
   * The weather, 0 (clear) to 1 (heavy rain), from the wall clock like the time of day, so a crew shares one sky.
   * A new spell starts every few minutes and the sky eases from one to the next. The Harbor runs wetter than an island.
   */
  private weather(): number {
    if (import.meta.env.DEV) {
      const forced = (globalThis as { __gqWeather?: number }).__gqWeather;
      if (typeof forced === "number") return forced;
    }
    const at = Date.now() / WEATHER_SPELL_MS;
    const spell = Math.floor(at);
    const bias = this.wetPort ? 0.12 : -0.08;
    const of = (k: number) => Math.max(0, Math.min(1, hash(k, 7, 700) + bias));
    // Hold each spell for most of its length, then ease into the next.
    const blend = smooth(0.7, 1, at - spell);
    return of(spell) * (1 - blend) + of(spell + 1) * blend;
  }

  private timeOfDay(): number {
    if (import.meta.env.DEV) {
      const forced = (globalThis as { __gqTime?: number }).__gqTime;
      if (typeof forced === "number") return forced;
    }
    return (Date.now() % DAY_MS) / DAY_MS;
  }

  /** Advance the sky and everything that sways. `yaw` is the camera's turn; `target` is what it looks at. */
  /** `focus`, if given, is where your own hero stands: the lights near you are the ones that matter. */
  update(clock: number, yaw: number, target: THREE.Vector3, focus?: THREE.Vector3) {
    this.light(target, clock);
    this.fall(clock, target);
    this.puff(clock);
    this.sweep(clock);
    this.splash(clock);
    this.flicker(clock, focus ?? target);
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
          pos.setXYZ(k, x0 + WIND.x * along, y0 + up, z0 + WIND.z * along);
          // Fades toward the tail, and the whole trail fades in at the start of a crossing and out over its last third.
          const fade = s <= 0 ? 0 : life * (1 - i / TRAIL) ** 0.8;
          col.setXYZW(k, 1, 0.95 + 0.05 * this.daylight, glow, fade * (0.55 + 0.35 * this.daylight));
        }
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  /** Rain: each drop is two pixels, one above the other, falling on a slant with the wind around wherever the camera looks. */
  private fall(clock: number, target: THREE.Vector3) {
    if (!this.rain) return;
    const pos = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    // Only as many drops fall as the weather calls for; the rest wait out of sight.
    const falling = Math.round(DROPS * this.rainfall);
    (this.rain.material as THREE.PointsMaterial).opacity = 0.2 + 0.25 * this.rainfall;
    this.rain.visible = falling > 0;
    for (let i = 0; i < DROPS; i++) {
      if (i >= falling) {
        pos.setXYZ(i * 2, 0, -100, 0);
        pos.setXYZ(i * 2 + 1, 0, -100, 0);
        continue;
      }
      const life = (clock * (0.9 + hash(i, 1, 500) * 0.5) + hash(i, 2, 500)) % 1;
      const y = 8 * (1 - life);
      // Drops are spread around wherever the camera looks, and blown downwind as they fall.
      const x = target.x + (hash(i, 3, 500) - 0.5) * 30 + life * 2.2 * WIND.x;
      const z = target.z + (hash(i, 4, 500) - 0.5) * 30 + life * 2.2 * WIND.z;
      pos.setXYZ(i * 2, x, y, z);
      pos.setXYZ(i * 2 + 1, x - 0.07 * WIND.x, y + 0.24, z - 0.07 * WIND.z);
    }
    pos.needsUpdate = true;
  }

  /** Draw smoke rising from these points (chimney tops). An empty list clears it. */
  /** Light or put out a hut's hanging lamp. */
  setLampOn(on: boolean) {
    if (on === this.lampOn) return;
    this.lampOn = on;
    this.lanternMat?.color.set(on ? "#ffe2a8" : "#4a3f30");
    // The lamp's map has been left alone while it was out, and the small lights change their reach with it (see flicker).
    this.stirAll();
  }

  /** The lights the props ask for (hearths, campfires, candles, lanterns) and the flames to flicker. The meshes belong to the caller. */
  setLights(lights: { pos: THREE.Vector3; kind: LightKind }[], flames: THREE.Mesh[]) {
    this.lights = lights;
    this.flames = flames;
    // Called whenever a piece is placed, moved, turned or taken away: every shadow in the room may have changed.
    this.stirAll();
  }

  /** Redraw every indoor shadow map on the next frame: the room itself changed (a piece, a wall, the lamp). */
  stirAll() {
    this.lamp.shadow.needsUpdate = true;
    this.slots.forEach((s, i) => {
      s.shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
    });
    this.stirred.clear();
  }

  /**
   * Something that throws a shadow (a hero) moved at `at`, or appeared or went
   * away there. Call it for where it was as well as where it is, so a shadow
   * left behind is cleared. The maps of the lights within reach are redrawn:
   * the lamp's straight away, the others a few a frame (see settleShadows).
   */
  stir(at: THREE.Vector3) {
    if (!this.indoors) return;
    if (this.lampOn) this.lamp.shadow.needsUpdate = true;
    this.slots.forEach((s, i) => {
      if (!this.slotOf[i] || s.shadow.needsUpdate) return;
      const reach = s.distance + STIR_MARGIN;
      if (s.position.distanceToSquared(at) <= reach * reach) this.stirred.add(i);
    });
  }

  /**
   * Hand out this frame's redraws, just before drawing: the slot nearest your
   * hero every frame (its shadow is the one you look at), then the ones that
   * have waited longest. Standing still, nothing is redrawn.
   */
  settleShadows() {
    this.frameNo++;
    if (this.stirred.size === 0) return;
    const waiting = [...this.stirred];
    let first = waiting[0];
    for (const i of waiting) if (this.slots[i].position.distanceToSquared(this.focus) < this.slots[first].position.distanceToSquared(this.focus)) first = i;
    const order = [first, ...waiting.filter((i) => i !== first).sort((a, b) => this.drawnAt[a] - this.drawnAt[b])];
    for (const i of order.slice(0, MOVE_REDRAWS)) {
      this.slots[i].shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
      this.stirred.delete(i);
    }
  }

  /** The turn, about the vertical, that faces something at (x, z) toward shadow slot `i`'s light. */
  slotFacing(i: number, x: number, z: number): number {
    const p = this.slots[i].position;
    return Math.atan2(p.x - x, p.z - z);
  }

  /**
   * Give the slots to these lights (the nearest few). A slot keeps its light
   * while that light is still wanted, so walking hands over only the slot whose
   * light fell out, and only that one is redrawn.
   */
  private assignSlots(want: { pos: THREE.Vector3; kind: LightKind }[]) {
    const same = (a: { pos: THREE.Vector3; kind: LightKind }, b: { pos: THREE.Vector3; kind: LightKind }) => a.kind === b.kind && a.pos.distanceToSquared(b.pos) < 1e-6;
    const left = [...want];
    const free: number[] = [];
    this.slotOf.forEach((cur, i) => {
      const k = cur ? left.findIndex((l) => same(l, cur)) : -1;
      if (k < 0) {
        free.push(i);
        return;
      }
      this.slotOf[i] = left[k];
      left.splice(k, 1);
    });
    for (const i of free) {
      const next = left.shift() ?? null;
      this.slotOf[i] = next;
      if (!next) continue;
      this.slots[i].position.copy(next.pos);
      this.slots[i].shadow.needsUpdate = true;
      this.drawnAt[i] = this.frameNo;
      this.stirred.delete(i);
    }
  }

  /** Lick the flames up and down, and let the lights breathe with them. */
  private flicker(clock: number, target: THREE.Vector3) {
    const motion = this.still ? 0 : 1;
    for (const f of this.flames) {
      const k = f.userData.flame as number;
      const seed = k * 1.7 + f.position.x * 9.1 + f.position.z * 5.3;
      // Steps rather than a smooth swell, so it reads as pixel fire.
      const step = Math.floor(clock * 9 + seed);
      const jitter = hash(step, k, 900);
      f.scale.y = 1 + motion * (Math.sin(clock * 6.3 + seed) * 0.18 + (jitter - 0.5) * 0.45);
      f.scale.x = f.scale.z = 1 + motion * (hash(step, k, 901) - 0.5) * 0.25;
    }
    // Indoors the lights are part of the room; outdoors they show only as the day goes.
    const dusk = this.indoors ? 1 : 1 - this.daylight;
    const near = (a: { pos: THREE.Vector3 }, b: { pos: THREE.Vector3 }) => a.pos.distanceToSquared(target) - b.pos.distanceToSquared(target);
    const sorted = [...this.lights].sort(near);
    this.focus.copy(target);

    if (this.indoors) {
      // Indoors the nearest few each throw shadows. A piece already holding a slot keeps it until another is
      // clearly nearer (SLOT_HOLD), so walking along the edge between two never hands a slot back and forth.
      // Matched by place, since setLights hands over new objects for the same pieces.
      const slotted = (l: { pos: THREE.Vector3; kind: LightKind }) => this.slotOf.some((o) => o && o.kind === l.kind && o.pos.distanceToSquared(l.pos) < 1e-6);
      // A fire is the brightest thing in the room and throws the longest shadows, so it counts as a little nearer.
      const keyed = sorted.map((l) => ({ l, d: l.pos.distanceTo(target) - (slotted(l) ? SLOT_HOLD : 0) - (l.kind === "fire" ? FIRE_PULL : 0) }));
      keyed.sort((a, b) => a.d - b.d);
      this.assignSlots(keyed.slice(0, SHADOW_SLOTS).map((k) => k.l));
      // Only their strength changes from frame to frame (the flicker), which needs no redraw of their maps;
      // their place and reach change only when a slot is handed to another piece.
      this.slots.forEach((s, i) => {
        const l = this.slotOf[i];
        if (!l) {
          // Kept in the scene (at no strength) rather than hidden, so the light count stays fixed.
          s.intensity = 0;
          return;
        }
        const look = this.roomLook(l, clock, motion);
        this.reach(s, look.distance, look.decay);
        s.color.set(look.color);
        s.intensity = look.intensity;
      });
      // The rest look exactly as they would holding a slot, only without a shadow: a piece handed between a slot
      // and a plain light keeps its brightness, so nothing seems to switch on or off as you walk.
      const rest = keyed.slice(SHADOW_SLOTS).map((k) => k.l);
      this.glows.forEach((g, i) => {
        const l = rest[i];
        if (!l) {
          g.intensity = 0;
          return;
        }
        const look = this.roomLook(l, clock, motion);
        g.position.copy(l.pos);
        g.color.set(look.color);
        g.distance = look.distance;
        g.decay = look.decay;
        g.intensity = look.intensity;
      });
      return;
    }

    // Outdoors the nearest campfire glows once the light starts to go; nothing but the sun throws shadows.
    const fire = sorted.find((l) => l.kind === "fire");
    const light = this.fireLight;
    light.castShadow = false;
    if (fire) {
      light.position.copy(fire.pos);
      light.color.set("#ff9548");
      light.distance = 6;
      light.decay = 2;
      light.intensity = 3.2 * dusk * this.waver(clock, 0, motion);
    } else {
      // Kept in the scene (at no strength) rather than hidden, so the light count stays fixed.
      light.intensity = 0;
    }
    const rest = sorted.filter((l) => l !== fire);

    // Everything else, nearest first, shares the plain lights.
    this.glows.forEach((g, i) => {
      const l = rest[i];
      if (!l) {
        g.intensity = 0;
        return;
      }
      const look = GLOW[l.kind];
      g.position.copy(l.pos);
      g.color.set(look.color);
      g.distance = look.range;
      g.decay = 2;
      g.intensity = look.power * dusk * (look.flicker ? this.waver(clock, i + 1, motion) : 1);
    });
  }

  /**
   * How a candle, lantern or fire lights a room, the same whether it holds a shadow slot or a plain light.
   * Its flicker is keyed to the piece's place, not to the light carrying it, so it never jumps on a hand-over.
   */
  private roomLook(l: { pos: THREE.Vector3; kind: LightKind }, clock: number, motion: number): { color: string; distance: number; decay: number; intensity: number } {
    const wave = this.waver(clock, Math.abs(Math.floor(l.pos.x * 13 + l.pos.z * 7)) % 7, motion);
    if (l.kind === "fire") return { color: "#ff9548", distance: 6, decay: 2, intensity: 3.2 * wave };
    const look = GLOW[l.kind];
    const flick = look.flicker ? wave : 1;
    // Under the lamp a small light is only a warm spot, as it always was; its shadow is a faint one close by.
    if (this.lampOn) return { color: look.color, distance: look.range, decay: 2, intensity: look.power * flick };
    // With the lamp out the small lights carry the room: more reach, fading gently (decay 1), so a hero a hex or
    // two away still throws a shadow you can see. Several share the room, so each is softer than the one shadow
    // light there used to be.
    return { color: look.color, distance: Math.max(look.range * 2, 6), decay: 1, intensity: look.power * 2.6 * flick };
  }

  /** Set a slot's reach and falloff. A new reach moves its shadow camera's far plane, so its map is redrawn. */
  private reach(s: THREE.PointLight, distance: number, decay: number) {
    s.decay = decay;
    if (s.distance === distance) return;
    s.distance = distance;
    s.shadow.needsUpdate = true;
  }

  /** A gentle unsteadiness for a flame's light, different for each `n`. */
  private waver(clock: number, n: number, motion: number): number {
    return 1 + motion * (Math.sin(clock * (8.1 + n * 0.7) + n) * 0.07 + Math.sin(clock * 13.7 + 1.3 + n * 2.1) * 0.05 + (hash(Math.floor(clock * 9), 3 + n, 902) - 0.5) * 0.1);
  }

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

  /**
   * Put a lighthouse's turning beam at `at` (the middle of its lantern), or take it away with null.
   * Each beam is an open cone lying on its side, apex in the lantern, coloured by a ramp that fades to black
   * along its length: drawn additively, black adds nothing, so it thins out to nothing with no hard end.
   */
  setBeacon(at: THREE.Vector3 | null) {
    if (this.beacon) {
      this.scene.remove(this.beacon.root);
      this.beacon.root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) o.geometry.dispose();
      });
      this.beacon.beams.map?.dispose();
      this.beacon.beams.dispose();
      this.beacon.glow.map?.dispose();
      this.beacon.glow.dispose();
      this.beacon = null;
    }
    if (!at) return;
    const ramp = (stops: [number, string][], w: number, h: number, radial: boolean) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      const grad = radial ? ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2) : ctx.createLinearGradient(0, 0, 0, h);
      for (const [o, c] of stops) grad.addColorStop(o, c);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    // A cone's apex is the top of the texture (the canvas's first row), its open end the bottom.
    const beams = new THREE.MeshBasicMaterial({
      map: ramp([[0, "#fff1c0"], [0.1, "#c9a650"], [0.45, "#3a2f14"], [1, "#000000"]], 2, 64, false),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const root = new THREE.Group();
    root.position.copy(at);
    const spin = new THREE.Group();
    root.add(spin);
    const LENGTH = 3.4;
    for (const side of [1, -1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, LENGTH, 14, 1, true), beams);
      // Lay it on its side with the apex at the lantern, pointing out along x (and back, for the second beam).
      cone.rotation.z = (side * Math.PI) / 2;
      cone.position.x = (side * LENGTH) / 2;
      // A touch below the lamp, so the beam reads as sweeping the water rather than the sky.
      cone.position.y = -0.12;
      cone.renderOrder = 2;
      spin.add(cone);
    }
    const glow = new THREE.SpriteMaterial({
      map: ramp([[0, "#fff4cc"], [0.25, "#ffd77a"], [0.6, "#5a3f10"], [1, "#000000"]], 64, 64, true),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const halo = new THREE.Sprite(glow);
    halo.renderOrder = 2;
    root.add(halo);
    root.traverse((o) => (o.frustumCulled = false));
    this.scene.add(root);
    this.beacon = { root, spin, beams, glow, halo };
  }

  /** The lighthouse's beam turns slowly; faint by day, plain at dusk and night. */
  private sweep(clock: number) {
    const b = this.beacon;
    if (!b) return;
    const dark = this.night;
    // A full turn every 24 seconds or so: slow enough to be calm, never a strobe. Held still when motion is reduced.
    b.spin.rotation.y = this.still ? 0.6 : clock * 0.26;
    b.beams.opacity = 0.06 + 0.5 * dark;
    // The glow breathes very gently, and is barely there at noon.
    const breathe = this.still ? 1 : 0.92 + 0.08 * Math.sin(clock * 1.3);
    b.glow.opacity = (0.18 + 0.72 * dark) * breathe;
    const size = 0.8 + 0.5 * dark;
    b.halo.scale.set(size, size, 1);
  }

  /** Puffs leave the stack one after another, drift with the wind as they climb, and thin out. */
  /**
   * Rocks standing out of the sea (and the wreck on them): the water breaks
   * around each one too. `rocks` are their bases at the water line.
   */
  setSeaRocks(rocks: THREE.Vector3[]) {
    const out: typeof this.splashes = [];
    rocks.forEach((r, n) => {
      // Three spots around each rock, never in step.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + hash(n, i, 720) * 1.2;
        const nx = Math.cos(a), nz = Math.sin(a);
        out.push({ x: r.x + nx * 0.42, y: r.y + 0.02, z: r.z + nz * 0.42, nx, nz, phase: hash(n, i, 721) * 10, period: 1.8 + hash(n, i, 722) * 2.4 });
      }
    });
    this.rockSplashes = out;
    this.layOutSplashes();
  }

  /** (Re)build the splash points for the shore and the rocks together. */
  private layOutSplashes() {
    if (this.splashPoints) {
      this.group.remove(this.splashPoints);
      this.splashPoints.geometry.dispose();
      (this.splashPoints.material as THREE.Material).dispose();
      this.splashPoints = null;
    }
    this.splashes = [...this.shoreSplashes, ...this.rockSplashes];
    if (this.splashes.length === 0 || this.still) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.splashes.length * SPLASH_DROPS * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.splashes.length * SPLASH_DROPS * 4), 4));
    this.splashPoints = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    this.splashPoints.frustumCulled = false;
    this.group.add(this.splashPoints);
  }

  /**
   * The sea breaking on rock: every few seconds each spot throws up a handful
   * of white pixels that arc out over the water and drop back, quick and small.
   */
  private splash(clock: number) {
    if (!this.splashPoints) return;
    const pos = this.splashPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.splashPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
    const glow = 0.75 + 0.25 * this.daylight;
    this.splashes.forEach((s, n) => {
      const cycle = (clock + s.phase) / s.period;
      const burst = Math.floor(cycle);
      // The burst lasts the first fifth of each cycle; the rest of the time the water is calm.
      const t = (cycle - burst) / 0.2;
      for (let i = 0; i < SPLASH_DROPS; i++) {
        const k = n * SPLASH_DROPS + i;
        if (t >= 1) {
          col.setXYZW(k, 1, 1, 1, 0);
          continue;
        }
        const r = (salt: number) => hash(n + i * 13, burst, 710 + salt);
        // Thrown out to sea and to either side, up, then falling back.
        const out = (0.1 + r(1) * 0.25) * t;
        const side = (r(2) - 0.5) * 0.5 * t;
        const up = (0.25 + r(3) * 0.35) * (4 * t * (1 - t));
        pos.setXYZ(k, s.x + s.nx * out - s.nz * side, s.y + up, s.z + s.nz * out + s.nx * side);
        // Whiter at the top of the throw, fading as it falls.
        col.setXYZW(k, glow, glow, glow + 0.05, (1 - t) * 0.9);
      }
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

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

  /**
   * The turn, about the vertical, that faces something at (x, z) toward the sun or, indoors, the hanging lamp:
   * for the shadow card the sun and the lamp see (CARD_LAYER). Each shadow slot has a card of its own (slotFacing).
   */
  towardLight(x: number, z: number): number {
    if (!this.indoors) return Math.atan2(this.sunDir.x, this.sunDir.z);
    return Math.atan2(this.lamp.position.x - x, this.lamp.position.z - z);
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
      // With a fire going, the lamp and fill step back so the room is not overlit.
      const fire = this.lights.some((l) => l.kind === "fire");
      if (this.lampOn) {
        this.lamp.intensity = (fire ? 1.15 : 1.5) * (this.still ? 1 : 1 + Math.sin(clock * 7) * 0.035 + Math.sin(clock * 13.3) * 0.02);
        this.hemi.intensity = fire ? 0.8 : 0.95;
      } else {
        // Lamp out: a faint fill so the room never goes black, and the candles, lanterns and fires do the rest.
        this.lamp.intensity = 0;
        this.hemi.intensity = 0.15;
      }
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
    // Cloud comes in before the rain does; indoors there is no sky.
    const wet = this.outdoors ? this.weather() : 0;
    this.cloud = smooth(0.3, 0.6, wet);
    this.rainfall = smooth(0.6, 0.9, wet);
    if (this.cloud > 0) {
      // Low cloud: a weaker, greyer sun, a slate sky, and everything a shade cooler.
      const c = this.cloud;
      this.sun.intensity *= 1 - 0.45 * c;
      this.hemi.intensity *= 1 - 0.08 * c;
      this.hemi.color.lerp(SLATE, 0.45 * c);
      this.background.lerp(SLATE, 0.8 * c).multiplyScalar(1 - c * (0.25 - 0.2 * daylight));
    }
    // Unlit cut-outs (grass, wave crests) are tinted by hand to match.
    this.flatTint.set("#56669c").lerp(WHITE, daylight).lerp(DUSK, glow * 0.2);
    if (this.cloud > 0) this.flatTint.lerp(SLATE, 0.35 * this.cloud).multiplyScalar(1 - 0.18 * this.cloud);
  }
}

const WHITE = new THREE.Color("#ffffff");
const SLATE = new THREE.Color("#7f8b98");
const SUN_NOON = new THREE.Color("#fff3d6");
const SKY_DAY = new THREE.Color("#a9dcf7");
const GROUND_DAY = new THREE.Color("#5a6a8a");
const DUSK = new THREE.Color("#f2a56b");
