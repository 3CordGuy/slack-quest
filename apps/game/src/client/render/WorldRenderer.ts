// Three.js view of an island: low-poly hex terrain with pixel sprites
// standing on it. Imperative on purpose. React owns the HUD; this class owns
// the canvas and is told about state (setState) and things that just
// happened (playEvents).
//
// The same scene shows the overworld and battles: a battle pushes the camera
// in on the fight and lines the two sides up facing each other.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Ambience, CARD_LAYER, SHADOW_SLOTS, SLOT_LAYER, pixelTexture, stamp, type BuildingGlow } from "./ambience";
import "./camera.css";
import { PINCH_PAN_SLACK, followIconSvg, readFollow, writeFollow } from "./cameraFollow";
import type { HexPos } from "@gantt-quest/core";
import { hexDistance } from "@gantt-quest/core";
import { BASE_HEIGHT, BATTLE_JOIN_RANGE, BIG_REACH, ENEMIES, HEX_DIRS, TRAIT_BY_ID, MOVE_COST, WALL_FACE_HALF, WALL_ITEM_BOTTOM, WALL_ITEM_TOP, findPath, hexAt, xpProgress, reachable, tileAt, wallFace, wallFaces, type ClientState, type Outfit, type Phase, type Poi, type Tile, type WorldEvent, type WorldMap } from "@gantt-quest/world";
import { fancy } from "./fancy";
import { NightLife } from "./nightlife";
import { Storm } from "./storm";
import { addWindSway, updateWind } from "./wind";
import { LIT, OVERLAY_LAYER, PostFx, addSpriteRim, type Air, type SpriteRim } from "./post";
import { standUpright } from "./upright";
import { GROUND_KIND, addFancyWater, addWaterRipple, setGroundWet, setWaterNight, setWaterStanding, shoreSide, updateWater, waterAttribute, type Standing } from "./water";
import { ghostModel, propModel, tintGhost, type LightKind } from "./props";
import { nearWater, openEar, sounds } from "../audio/gameSounds";
import type { AttackStyle, Fighter } from "../audio/names";
import { PUFFS, footfalls, stepGround, worldToHex } from "./footsteps";
import { SPRITE_ASPECT, bubbleTexture, fxTexture, labelTexture, plateKey, sleepZTexture, spriteKey, spriteTexture, textTexture, type FxKind, type PlateStats } from "./sprites";

/** Spells fly as a coloured bolt; these are their colours, by ability name. */
const SPELL_COLOR: Record<string, string> = {
  Firebolt: "#ff9a3c",
  "Chain Spark": "#7fe3ff",
  "Hex Bolt": "#c084fc",
  "Dark Bolt": "#b06cff",
  Immolate: "#ff6a3c",
};
const ARROW_ABILITIES = new Set(["Aimed Shot", "Pin Down", "Volley", "Barbed Arrow"]);
/** How an attack travels, for its sound: the same split the effects above are drawn by. */
const attackStyle = (ability: string): AttackStyle => (SPELL_COLOR[ability] ? "magic" : ARROW_ABILITIES.has(ability) ? "ranged" : "melee");
const isBoss = (kind: string) => !!ENEMIES[kind]?.boss;
/** Rank-and-file drawn a size up: the heavy hitters. */
const isBig = (kind: string) => kind === "brute" || kind === "bear";

/**
 * What the renderer needs to draw a scene. An island's ClientState satisfies
 * this as it is; the Harbor builds one by hand with `freeRoam` set.
 */
export interface RenderState {
  /** Identifies the map; the terrain is rebuilt when it changes. */
  code: string;
  /** A voyage's island, or the Haunted Caverns: the caverns' mouth shows no moored ship, and its heroes carry torches. */
  kind?: "voyage" | "caverns";
  you: string;
  phase: Phase;
  round: number;
  map: WorldMap;
  /** `asleep`: lying down with eyes shut, z's rising, as on a bedroll in the Harbor. */
  heroes: RenderHero[];
  turn: { heroId: string; mp: number } | null;
  battle: ClientState["battle"];
  story: { npcs: { id: string; poi: string }[] } | null;
  npcs: Record<string, { hostile: boolean }>;
  /** Enemy bands in sight on the map. */
  roamers?: { id: string; kinds: string[]; pos: HexPos }[];
  /** No turns or movement points: the viewer may walk anywhere reachable, and tiles are not lit. */
  freeRoam?: boolean;
  /** Furniture standing on hexes (a hut's room). Each blocks the hex it is on. */
  props?: SceneProp[];
  /** Inside a building: no sea or sky around the map, and the camera starts closer. */
  indoors?: boolean;
  /** Inside a hut with its hanging lamp put out: the room is lit by its own candles, lanterns and fires. */
  lampOff?: boolean;
  /** Your gathering outings, shown as lightning bolts on your own plate. */
  stamina?: { left: number; max: number };
  /** A piece being carried: a ghost of it follows the pointer, and a click sets it down (RendererCallbacks.onPlace). */
  holding?: Holding | null;
}

/**
 * Someone drawn standing on the map. A player's hero carries `level` (and,
 * on a voyage, `hp`), which puts a plate over their head: the level, the
 * name, an HP bar and an XP bar. Without `level` it is a plain name tag.
 */
export interface RenderHero {
  id: string;
  classId: string;
  pos: HexPos;
  /** The name tag. A voyage's heroes have none set, so their `name` is used once they have a plate. */
  label?: string;
  name?: string;
  outfit?: Outfit;
  /** `asleep`: lying down with eyes shut, z's rising, as on a bedroll in the Harbor. */
  asleep?: boolean;
  /** Drawn at this point of its hex instead of the middle, `y` above the floor: lying on a bed in a hut. */
  at?: { x: number; z: number; y: number };
  level?: number;
  /** XP into the current level. */
  xp?: number;
  /** Absent off a voyage, where every hero is at full health. */
  hp?: number;
  maxHp?: number;
}

/** The first word of a name, for a plate: "Ewan Driftwood" is "Ewan". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** A hero's plate stats, or nothing for someone who is not a player's hero. */
export function plateOf(h: RenderHero): PlateStats | undefined {
  if (h.level === undefined) return undefined;
  const hp = h.hp !== undefined && h.maxHp ? h.hp / h.maxHp : 1;
  return { level: h.level, hp, xp: xpProgress(h.level, h.xp ?? 0) };
}

export interface SceneProp {
  id: string | number;
  /** Which model to draw; see render/props.ts. */
  model: string;
  pos: HexPos;
  /** 0 to 5, in sixths of a turn. A wall piece: which side of its wall hex it hangs on. */
  facing: number;
  /** Ringed, to show it is the one being handled. */
  selected?: boolean;
  /** A small thing: stepped over, not walked around. */
  small?: boolean;
  /** Hung on a wall: `pos` is the wall hex, `facing` the side, `x` along it and `y` up from the floor. */
  mount?: boolean;
  /** Offset from the middle of its hex (or of its support's top), and its turn in radians on top of `facing`. */
  x?: number;
  z?: number;
  y?: number;
  angle?: number;
  /** How far out its selection ring goes. */
  ring?: number;
  /** The hexes it covers, when that is more than its own (see hutroom.ts, coveredHexes): kept clear of people unless it is `flat`, and outlined when selected. Small things and wall pieces cover none. */
  covers?: HexPos[];
  /** Floor decor (a rug): walked over, and other pieces stand on it. */
  flat?: boolean;
  /** The prop it stands on; then x/z/angle are in that prop's own frame. */
  on?: string | number;
  /** Its flat top, in its own frame, for small things to stand on. */
  surface?: { y: number; w: number; d: number; x?: number; z?: number };
}

/** Where something carried would be set down: a hex, an offset in it, and (for a small thing on a top) the prop it stands on. */
export interface PlaceTarget {
  pos: HexPos;
  x: number;
  z: number;
  on?: string | number;
  /** On a wall: `pos` is the wall hex, `x` how far along this side of it, `y` how high. */
  wall?: { side: number; y: number };
}

/** Something being carried, to be set down where the pointer is. */
export interface Holding {
  model: string;
  small: boolean;
  /** A wall piece's face, w wide and h tall: it is aimed at the walls, not the floor. */
  mount?: { w: number; h: number };
  /**
   * A floor piece's footprint, in its own frame (see hut.ts, Footprint): drawn
   * under the ghost, and for a long piece reaching across hexes, held by its
   * middle rather than by the hex it is anchored on.
   */
  footprint?: { w: number; d: number; x?: number; z?: number; round?: boolean };
  /** Its turn: `facing` sixths plus `angle` radians. */
  facing: number;
  angle: number;
}

/** Furthest a free-roaming walk may be previewed; matches the Harbor's server-side limit. */
const FREE_ROAM_REACH = 60;

const SQRT3 = Math.sqrt(3);
/** Render at 1/PIXEL resolution and scale up unsmoothed for a chunky look. */
const PIXEL = 2;
/** Nearest and farthest the camera may sit from what it looks at. */
const MIN_ZOOM = 7;
const MAX_ZOOM = 40;
/** Below 1 makes a pinch zoom less than the fingers move. */
const PINCH_DAMPING = 0.55;
/** The angle equal to `to` (mod a full turn) that is closest to `from`, so easing takes the short way round. */
function nearestTurn(from: number, to: number): number {
  const full = Math.PI * 2;
  return to + Math.round((from - to) / full) * full;
}
/** Keys that slide the view, as [right, forward]. */
/** A backdrop's place in the sound: none. It hears nothing and is not heard. */
const DEAF: ReturnType<typeof openEar> = { listener() {}, sky() {}, lights() {}, ground() {}, sea() {}, close() {} };
/** How many windows wide the view through a room's windows is: they show one picture between them, side by side. */
const OUTLOOK_PANES = 4;
/** A window's size on the wall, and how far up the wall its middle is. */
const PANE = { w: 0.78, h: 0.62, y: 1.12 };

const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0],
  arrowup: [0, 1], arrowdown: [0, -1], arrowleft: [-1, 0], arrowright: [1, 0],
};
/** A unit square standing on its bottom edge, like a sprite. */
const CASTER_PLANE = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
/** The camera's usual tilt (about 47° above the horizon) and how far it may be tipped. */
const DEFAULT_PITCH = Math.atan2(0.78, 0.72);
const MIN_PITCH = 0.42;
const MAX_PITCH = 1.25;
/** Camera distance per unit of zoom, kept from when the tilt was fixed. */
const CAMERA_REACH = Math.hypot(0.72, 0.78);
const PLAYER_COLORS = ["#ffd23f", "#5ce1e6", "#ff7ab6", "#9dff6b"];
const BIOME_COLOR: Record<string, string> = { plains: "#7cb856", forest: "#4c9a52", hills: "#a39672", water: "#3f86dc", dock: "#9a7748", cobble: "#6f7279", mud: "#5f5140", rampart: "#62656d", floor: "#b08a5c", wall: "#6e5a48", cave: "#4a4552", rock: "#2a2730", gate: "#4a4552", fog: "#2b3140" };
/** What grass and trees are pulled toward under the Harbor's low cloud. */
const DRAB = new THREE.Color("#5d6a5c");
/** The pub's painted sign: a foaming tankard on an oxblood board with a gold edge. Made once and shared. */
let pubSignTexture: THREE.CanvasTexture | null = null;
function pubSign(): THREE.CanvasTexture {
  pubSignTexture ??= pixelTexture(16, 14, (ctx) => {
    ctx.fillStyle = "#6e2b26";
    ctx.fillRect(0, 0, 16, 14);
    stamp(ctx, [
      "BBBBBBBBBBBBBBBB",
      "B              B",
      "B    W  WW     B",
      "B   WWWWWWW    B",
      "B  WWWWWWWWW   B",
      "B   hhhhhhh    B",
      "B   YyYYyYYYY  B",
      "B   YyYYyYY  Y B",
      "B   hhhhhhh  Y B",
      "B   YyYYyYY  Y B",
      "B   YyYYyYYYY  B",
      "B   hhhhhhh    B",
      "B              B",
      "BBBBBBBBBBBBBBBB",
    ], { B: "#d9b45a", W: "#f4efe1", Y: "#d08a3a", y: "#a8662a", h: "#3a2c22" });
  });
  return pubSignTexture;
}
/**
 * Fold a model's pieces that share a look into one mesh each, so a detailed building costs a handful of draw calls
 * rather than one a piece. Plain lambert pieces of the same colour fold together; a piece with any other material
 * (a pane the ambience warms, the painted sign) folds only with pieces using that very material. Glows stay apart.
 */
function foldByLook(g: THREE.Group) {
  const sets = new Map<string, THREE.Mesh[]>();
  for (const o of g.children) {
    if (!(o instanceof THREE.Mesh)) continue;
    const m = o.material as THREE.Material;
    const key = (m instanceof THREE.MeshLambertMaterial && !m.map ? `lambert:${m.color.getHexString()}` : m.uuid) + (o.userData.glow ? ":glow" : "");
    const set = sets.get(key);
    if (set) set.push(o);
    else sets.set(key, [o]);
  }
  for (const meshes of sets.values()) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      mesh.updateMatrix();
      const geo = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
      geo.clearGroups();
      return geo;
    });
    const folded = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!folded) continue;
    const mesh = new THREE.Mesh(folded, meshes[0].material);
    mesh.userData.glow = meshes[0].userData.glow;
    for (const m of meshes) {
      g.remove(m);
      m.geometry.dispose();
    }
    g.add(mesh);
  }
}
/** Window glass that warms with the dusk: `unlit` by day, `lit` by night (the ambience moves it between the two; see `setGlows`). */
function warmPane(unlit: string, lit: string): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: lit });
  m.userData = { unlit, lit };
  return m;
}
/** The open sea at the dead of night, and the fog by day and by night. */
const NIGHT_SEA = new THREE.Color("#0f1a33");
const FOG_DAY = new THREE.Color("#3a4358");
const FOG_NIGHT = new THREE.Color("#141824");
/** And the sea there: cold and grey-green. */
const GREY_SEA = new THREE.Color("#2f4a5f");

export function hexToWorld(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

const tileTop = (t: Tile | undefined) => (!t ? 0.2 : t.biome === "water" ? 0.14 : 0.35 + t.h * 1.1);
/** A room's floor, which wall pieces' heights are measured from. */
const FLOOR_TOP = tileTop({ q: 0, r: 0, biome: "floor", h: BASE_HEIGHT.floor });
/** A turn in sixths plus radians, as Three.js turns a model about y. */
const yawOf = (facing: number, angle = 0) => -((facing * Math.PI) / 3 + angle);
const key = (p: HexPos) => `${p.q},${p.r}`;
/** To the nearest thousandth, so offsets sent to the server stay short. */
const round = (n: number) => Math.round(n * 1000) / 1000;
/** Small deterministic hash for per-tile variation. */
const noise = (q: number, r: number, salt: number) => {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

interface Unit {
  sprite: THREE.Sprite;
  /**
   * Unseen cut-outs of the sprite that throw its shadow, each turned to face one light: the first for the sun
   * (or a hut's hanging lamp), then one per shadow slot indoors. Each sits on its own layer, which only its
   * light's shadow camera looks at, so every light sees the hero face on and none sees another light's card.
   */
  casters: THREE.Mesh[];
  /** Where its shadow was last drawn from, and whether it threw one: a change asks the lights near it to redraw. */
  shadowAt: THREE.Vector3;
  shadowShown: boolean;
  shadowSize: number;
  ring: THREE.Mesh | null;
  hpBack: THREE.Sprite | null;
  hpFill: THREE.Sprite | null;
  label: THREE.Sprite | null;
  labelText: string;
  goal: THREE.Vector3;
  /** Waypoints still to walk before settling on `goal`. */
  path: THREE.Vector3[];
  /** Brief attack lunge, decays to zero. */
  kick: THREE.Vector3;
  /** Lean into an attack, in radians; decays to zero. */
  lean: number;
  /** Resting rotation: upright, or on their side when down. */
  baseRot: number;
  /** Distance walked, which drives the hop, and the current hop height. */
  stride: number;
  bob: number;
  kind: string;
  /** What its tag should show, kept so the XP glow can redraw it between updates. */
  labelWant?: { label?: string; plate?: PlateStats; size: number; asleep?: boolean; stack?: number };
  /** The XP bar glows until this time on the render clock; `glowing` is whether it is drawn so now. */
  glowUntil: number;
  glowing: boolean;
  /** Lying down asleep; `nextZ` is when its next z rises, on the render clock. */
  asleep: boolean;
  nextZ: number;
  zCount: number;
  /** Arrows that hit it and stayed in, until it goes down or the fight ends. */
  arrows?: StuckArrow[];
  /** How far above its feet the head is, in world units: where its tag and speech hang from. */
  head: number;
  /** Which of the heroes on its hex it is, so its speech clears every plate stacked there. */
  stack: number;
  /** Where its feet are this frame, the hop left out. */
  feet: THREE.Vector3;
}

/** Something a unit just said, hanging over its head for a few seconds. */
interface Bubble {
  sprite: THREE.Sprite;
  width: number;
  rows: number;
  age: number;
  life: number;
  /** Pixels it has been lifted (and, at the top of the view, moved aside) to clear other bubbles and tags; eased. */
  raise: number;
  shift: number;
}

/** Seconds a bubble stays up: a little longer for a longer line. */
const bubbleLife = (text: string) => Math.min(7, 4 + text.length / 40);
const BUBBLE_FADE = 0.6;

/** An arrow left standing in a combatant: where on the sprite it sits, and its tilt. */
interface StuckArrow {
  sprite: THREE.Sprite;
  /** Offset from the unit's feet, in world units. */
  off: THREE.Vector3;
  rot: number;
}

/** No more than this many arrows stay in one combatant; the oldest falls out. */
const MAX_STUCK_ARROWS = 6;

interface Want {
  kind: string;
  /** Draw the unit wearing this instead of its kind's stock look. */
  outfit?: Outfit;
  pos: THREE.Vector3;
  size: number;
  label?: string;
  /** Level, HP and XP drawn under the name. */
  plate?: PlateStats;
  /** Heroes sharing a hex: which of them this is, so their plates are stacked instead of overlapping. */
  stack?: number;
  ring?: string;
  pulse?: boolean;
  hp?: number;
  down?: boolean;
  asleep?: boolean;
}

interface Floater {
  sprite: THREE.Sprite;
  age: number;
  /** Seconds before it has faded out; 1 unless set. */
  life?: number;
  /** World units it rises per second; 1.4 unless set. */
  rise?: number;
}

/** XP motes: gold and pale blue, like the XP bar lighting up. */
const XP_MOTES = ["#ffd23f", "#ffe98a", "#bfe6ff", "#8fd3ff"];

/** A z rising from a sleeper: drifts up and sideways, grows, and fades. */
interface SleepZ {
  sprite: THREE.Sprite;
  age: number;
  x: number;
  z: number;
  y: number;
  size: number;
  sway: number;
}

const Z_LIFE = 2.6;

/** A puff kicked up by a footfall: drifts out and up a little and fades. Pooled, so walking makes no garbage. */
interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

/** No more puffs than this are ever out at once; past it the oldest is reused. */
const PUFF_POOL = 36;

/** A short-lived effect sprite: a swipe, a projectile in flight, a burst. */
interface Fx {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Start and end size, in world units. */
  size: [number, number];
  /** Total rotation over its life, in radians. */
  spin: number;
  fade: boolean;
  onEnd?: () => void;
}

/**
 * A small game played in the world, seen through its own eyes (felling in the
 * tree line). While it runs it has the view and the input: each frame it says
 * where the eye is, what it looks at and how far over to that view the camera
 * has gone, and the renderer swings there from its usual view; presses on the
 * canvas and keys go to it instead of moving the camera.
 */
export interface WorldMinigame {
  frame(dt: number, now: number, aspect: number): { eye: THREE.Vector3; look: THREE.Vector3; blend: number; fov?: number };
  /** A press on the canvas, in normalized device coordinates, and the camera it was seen through. */
  press?(ndc: THREE.Vector2, camera: THREE.Camera): void;
  /** A key pressed; true if the game used it. */
  key?(e: KeyboardEvent): boolean;
}

export interface RendererCallbacks {
  onHexClick(pos: HexPos): void;
  onHover(pos: HexPos | null): void;
  /** A click on a prop. Return true if it was handled; otherwise the click falls through to its hex. */
  onPropClick?(id: string | number): boolean;
  /** The prop under the pointer changed. */
  onPropHover?(id: string | number | null): void;
  /** While carrying something: a click on a spot to set it down. */
  onPlace?(target: PlaceTarget): void;
  /** While carrying something: whether it may go at that spot (the ghost turns red if not). */
  canPlace?(target: PlaceTarget): boolean;
  /**
   * Shift and the wheel, while carrying something: turn it (+1 clockwise).
   * `amount` is how far the wheel moved, from 0 to 1 (a trackpad sends many
   * small ones), and `alt` whether Alt was held, which flips snapping.
   */
  onTurnHeld?(dir: 1 | -1, amount: number, alt: boolean): void;
}

/** A small thing on the floor keeps this close to the middle of its hex. */
const SMALL_REACH = 0.7;

export class WorldRenderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  private renderer: THREE.WebGLRenderer;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private raf = 0;
  /** The finishing pass (bloom, tilt-shift, grade), there while "Fancy graphics" is on. On the dev server P switches it alone, to compare. */
  post: PostFx | null = null;
  /** Character sprites take the light where they stand, with a highlight on the lit edge. Also "Fancy graphics"; L on the dev server. */
  private litSprites = fancy.get();
  private unwatchFancy: () => void;
  /** The lit sprites' knobs, for tuning from the console. */
  readonly lit = LIT;
  /** A backdrop's fixed point of view (see setVantage), and the lightning it is lent by the view showing it. */
  private vantage: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  /** A game being played in the world, the group its things stand in, and how your own hero looked before it hid them. */
  /** Units a minigame is drawing for itself. */
  private stageHidden: string[] = [];
  private minigame: { game: WorldMinigame; group: THREE.Group; hidden: { obj: THREE.Object3D; was: boolean }[]; felled: { i: number; m: THREE.Matrix4 }[] } | null = null;
  /** The trees on forest hexes, one instanced mesh; a minigame may clear some for room. */
  private forest: THREE.InstancedMesh | null = null;
  /** The camera's normal field of view, which a minigame may widen. */
  private baseFov = 35;
  private lentFlash = 0;
  /** A room's windows: the backdrop seen through them, its picture as a texture, and the panes on the wall. */
  private outlook: WorldRenderer | null = null;
  private outlookMap: THREE.CanvasTexture | null = null;
  private panes = new THREE.Group();
  /** Fireflies and moths, out at night with "Fancy graphics". */
  private nightLife = new NightLife();
  /** Lightning in a storm. On the dev server, `__gqWorld.strike()` sets one off. */
  private storm = new Storm();
  /** How wet the ground is, 0 to 1: it follows the rain up quickly and down slowly. */
  private wet = 0;
  /** The middle of this map's land and how far it reaches, for placing the moon's reflection off its shore. */
  private land = { x: 0, z: 0, reach: 6 };
  /** The sky as the finishing pass is told of it each frame. */
  private air: Air = { outdoors: true, clock: 0, sunDir: new THREE.Vector3(0, 1, 0), sun: new THREE.Color(), sky: new THREE.Color(), overcast: 0, sunHeight: 9, flash: 0 };
  private litTint = new THREE.Color();
  private litRim = new THREE.Color();
  private litToward = new THREE.Vector3();
  private litAxis = new THREE.Vector3();
  private last = performance.now();
  private clock = 0;

  private terrain: THREE.InstancedMesh | null = null;
  private tiles: Tile[] = [];
  /** This map's place in the sound: where you stand, its sky, its fires and its water. */
  private ear: ReturnType<typeof openEar>;
  /** The middle of every water hex, for hearing where the sea is. */
  private water: { x: number; z: number }[] = [];
  private frames = 0;
  private mapCode = "";
  private ambience: Ambience;
  private decor = new THREE.Group();
  private poiGroup = new THREE.Group();
  private poiSig = "";
  private propGroup = new THREE.Group();
  private propSig = "";
  /** Each prop's model, by id, and the unseen sheets over the tops small things can stand on. */
  private propModels = new Map<string | number, THREE.Group>();
  private surfaces: THREE.Mesh[] = [];
  private ghost: THREE.Group | null = null;
  private ghostSig = "";
  /** Where the carried piece would go if the pointer clicked now. */
  private aimedAt: PlaceTarget | null = null;
  /** The prop under the pointer, for its tooltip. */
  private hoverProp: string | number | null = null;
  private sea: THREE.Mesh;
  private unitGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  /** Red outlines around the hexes close enough to join a fight at each camp or lair. */
  private rangeGroup = new THREE.Group();
  private rangeSig = "";
  private hoverRing: THREE.Mesh;
  private arena = new THREE.Group();
  private arenaGround: THREE.Mesh;
  private arenaDecor = new THREE.Group();
  /** What the battleground was last dressed for, so it is only rebuilt when the fight moves. */
  private arenaSig = "";
  private units = new Map<string, Unit>();
  /** The sea's daytime colour for this map; night deepens it toward navy. */
  private seaBase = new THREE.Color("#3577cf");
  /** How dark the tiles were last painted for, in steps, so they are only repainted when night moves on. */
  private paintedNight = -1;
  private pulsing = new Set<string>();
  private floaters: Floater[] = [];
  private sleepZs: SleepZ[] = [];
  /** Footfall puffs, made as needed up to PUFF_POOL and then reused; `nextPuff` is the one to reuse next. */
  private puffs: Puff[] = [];
  private nextPuff = 0;
  /** The player asked for less motion: footsteps are still heard, but kick up no puffs. */
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private fx: Fx[] = [];
  /** Speech over units' heads, by unit id; kept apart from the unit so a change of gear does not cut it short. */
  private bubbles = new Map<string, Bubble>();
  private pending: { at: number; run: () => void }[] = [];

  private state: RenderState | null = null;
  private reach = new Map<string, { cost: number }>();
  private hovered: HexPos | null = null;
  private turnKey = "";

  private target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private dist = 24;
  private userDist = 24;
  /** Active pointers on the canvas, by id. Two of them make a pinch. */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; x: number; y: number; zoom: number; angle: number } | null = null;
  /**
   * Which way the camera looks from, as a turn about the vertical axis. 0 is
   * the default view from the south. `yaw` eases toward `yawGoal`; `userYaw`
   * is what the player chose, kept while a battle forces the view back to 0.
   */
  private yaw = 0;
  private yawGoal = 0;
  private userYaw = 0;
  /** The current drag turns the camera instead of panning it. */
  private rotating = false;
  /** How steeply the camera looks down, in radians above the horizon. Eases toward `pitchGoal`; `userPitch` is the player's choice. */
  private pitch = DEFAULT_PITCH;
  private pitchGoal = DEFAULT_PITCH;
  private userPitch = DEFAULT_PITCH;
  /** Movement keys held down right now (W A S D and the arrows), for sliding the view. */
  private heldKeys = new Set<string>();
  /** The map is a wet, walled port (it has streets): greens are drawn drab. */
  private sodden = false;
  /** How many hexes were out of the fog when the ground was last drawn. */
  private lifted = -1;
  /** Water hexes far enough from land that they are not drawn: the open sea shows instead. */
  private deep = new Set<string>();
  /** The camera turn the indoor walls were last cut for. */
  private wallTurn = NaN;
  /** The middle of the map's ground. Indoors the walls are cut about it, wherever the camera has gone (following a hero, or panned). */
  private middle = new THREE.Vector3();
  /** Indoors, the walls cut down to a kerb so the camera can see in, by hex key. Things hung on them are hidden. */
  private lowered = new Set<string>();
  /** Indoors, the wall sides things can hang on, by hex key: which sides of that hex. */
  private hangable = new Map<string, number[]>();
  /** How high the last wall piece was aimed, for when the pointer is on top of a wall. */
  private wallY = 1.1;
  private rotateButtons: HTMLDivElement;
  /** The camera buttons in that column, hidden in a fight. */
  private turnButtons: HTMLButtonElement[] = [];
  /**
   * The camera keeps your own hero centred as they walk (see cameraFollow.ts). Panning the map turns it off;
   * the button turns it back on. A fight's framing wins while it lasts.
   */
  private follow = readFollow();
  /** Following is paused because the view was sent somewhere else (lookAt); it picks up when your hero next walks. */
  private followHeld = false;
  private followButton: HTMLButtonElement;
  /**
   * While following, where a pinch started (its midpoint), or where the finger left down after one is: touches
   * near it only zoom and turn. Once they wander PINCH_PAN_SLACK away it is a pan, and following stops.
   */
  private panFrom: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false, dragged: false, dirty: false, inside: false };
  /** Called every frame before drawing, after the camera is placed, by things a view has added to the scene (see addTicker). */
  private tickers = new Set<(dt: number, camera: THREE.PerspectiveCamera, clock: number) => void>();

  /**
   * `backdrop`: a second view drawn off screen for another to show (the Harbor seen through the pub's
   * windows). It makes no sound, takes no keys, and draws only when the view showing it asks (see `step`).
   */
  constructor(private container: HTMLElement, private callbacks: RendererCallbacks, private opts: { backdrop?: boolean } = {}) {
    this.ear = opts.backdrop ? DEAF : openEar();
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(1);
    // Dev server only: the latest view, for reading draw calls (`__gqWorld.renderer.info.render.calls`) from the console.
    if (import.meta.env.DEV && !this.opts.backdrop) (globalThis as { __gqWorld?: WorldRenderer }).__gqWorld = this;
    const canvas = this.renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.imageRendering = "pixelated";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);

    // Sky, sun and moon, shadows, and the moving decoration.
    this.ambience = new Ambience(this.scene, this.renderer);
    this.scene.add(this.nightLife.group, this.storm.bolt, this.panes);

    const sea = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: "#3577cf" }));
    addFancyWater(sea.material);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.1;
    sea.receiveShadow = true;
    this.scene.add(sea);
    this.sea = sea;

    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 0.95, 6),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.rotation.z = Math.PI / 6;
    this.hoverRing.visible = false;

    // The battleground: one great hex of whatever ground the fight broke out on, dressed to match (see dressArena).
    this.arenaGround = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 1.6, 6), new THREE.MeshLambertMaterial({ color: "#7cb856", flatShading: true }));
    this.arenaGround.receiveShadow = true;
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 3.9, 1.1, 6), new THREE.MeshLambertMaterial({ color: "#4a3f35", flatShading: true }));
    skirt.position.y = -1.35;
    this.arena.add(this.arenaGround, skirt, this.arenaDecor);
    this.arena.visible = false;

    this.scene.add(this.decor, this.poiGroup, this.propGroup, this.rangeGroup, this.pathGroup, this.hoverRing, this.arena, this.unitGroup, this.fxGroup);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    if (!opts.backdrop) {
      addEventListener("keydown", this.onKeyDown);
      addEventListener("keyup", this.onKeyUp);
      addEventListener("blur", this.onBlur);
    }

    // Two small buttons at the right edge, for those without a right mouse button or a keyboard.
    this.rotateButtons = document.createElement("div");
    this.rotateButtons.className = "camera-rotate";
    this.followButton = document.createElement("button");
    this.followButton.type = "button";
    this.followButton.className = "camera-follow";
    this.followButton.appendChild(followIconSvg());
    this.followButton.addEventListener("click", () => this.setFollow(!this.follow || this.followHeld));
    this.rotateButtons.appendChild(this.followButton);
    this.turnButtons.push(this.followButton);
    this.showFollow();
    const buttons: [string, string, () => void][] = [
      ["⟲", "Turn the view left (Q)", () => this.rotateBy(-1)],
      ["⟳", "Turn the view right (E)", () => this.rotateBy(1)],
      ["▲", "Tip the view toward overhead (R)", () => this.tiltBy(0.18, true)],
      ["▼", "Tip the view toward the horizon (F)", () => this.tiltBy(-0.18, true)],
    ];
    for (const [label, title, run] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", run);
      this.rotateButtons.appendChild(b);
      this.turnButtons.push(b);
    }
    container.appendChild(this.rotateButtons);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    // Name plates, speech bubbles and health bars sit on their own layer, so the finishing pass can leave them alone.
    this.camera.layers.enable(OVERLAY_LAYER);
    this.raycaster.layers.enable(OVERLAY_LAYER);
    if (fancy.get()) this.post = new PostFx(this.renderer);
    this.unwatchFancy = fancy.subscribe(() => {
      this.setPost(fancy.get());
      this.setLit(fancy.get());
    });
    this.resize();
    if (!opts.backdrop) this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ear.close();
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("blur", this.onBlur);
    this.rotateButtons.remove();
    this.unwatchFancy();
    this.nightLife.dispose();
    this.storm.dispose();
    this.outlookMap?.dispose();
    this.ambience.dispose();
    this.endMinigame();
    this.post?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  // ---------- state ----------

  setState(state: RenderState) {
    // Dev server only: the view being fed state is the live one (a view torn down after it was made would otherwise be left in the hook).
    if (import.meta.env.DEV && !this.opts.backdrop) (globalThis as { __gqWorld?: WorldRenderer }).__gqWorld = this;
    const first = this.mapCode !== state.code;
    // The ground is redrawn for a new map, and whenever fog lifts off more of this one.
    const lifted = state.map.tiles.reduce((n, t) => n + (t.biome === "fog" ? 0 : 1), 0);
    if (first || lifted !== this.lifted) this.buildTerrain(state, first);
    if (first) this.buildPanes(state);
    this.lifted = lifted;
    this.state = state;
    this.ambience.setLampOn(!state.lampOff);
    this.buildPois(state);
    this.buildProps(state);
    this.updateGhost();
    this.buildJoinRanges(state);
    if (first) {
      // No sea under a hut's floor, nor in the caverns.
      this.sea.visible = !state.indoors && state.kind !== "caverns";
      (this.scene.background as THREE.Color).set(state.indoors ? "#1d1a2b" : "#a9dcf7");
      // A room is framed whole: closer for a hut, further back for the pub.
      if (state.indoors) this.userDist = this.camDist = state.map.grid.cols > 10 ? 21 : 15;
    }

    const me = state.heroes.find((h) => h.id === state.you);
    const myTurn = !!me && (state.freeRoam || (state.phase === "overworld" && state.turn?.heroId === state.you));
    this.reach = myTurn ? reachable(state.map, me!.pos, state.freeRoam ? FREE_ROAM_REACH : state.turn!.mp, this.stepCost(state)) : new Map();
    this.paintTiles();
    this.syncUnits(state);
    this.updatePath();

    if (state.battle) {
      this.targetGoal.copy(this.battleCentre(state));
      this.dist = 12;
      // The line-up is laid out for the default view, so a fight always faces the same way.
      this.yawGoal = nearestTurn(this.yaw, 0);
      this.pitchGoal = DEFAULT_PITCH;
      for (const b of this.turnButtons) b.hidden = true;
    } else {
      this.dist = this.userDist;
      this.yawGoal = nearestTurn(this.yaw, this.userYaw);
      this.pitchGoal = this.userPitch;
      for (const b of this.turnButtons) b.hidden = false;
      const turnKey = `${state.phase}:${state.round}:${state.turn?.heroId ?? ""}`;
      // A room is small enough to see whole, so indoors the camera stays on its middle.
      // Following, the camera starts on your hero indoors too.
      if (first && me && (this.follow || !state.indoors)) this.target.copy(this.standAt(me.pos));
      if ((first || turnKey !== this.turnKey) && me && (myTurn || first) && !state.indoors) this.targetGoal.copy(this.standAt(me.pos));
      this.turnKey = turnKey;
    }
  }

  /** Animate things that just happened. Call after setState for the same update. */
  /** Animate what just happened. `startBeat` holds the first blow back, for a fight's opening card. */
  playEvents(events: WorldEvent[], startBeat = 0) {
    let beat = startBeat;
    // XP comes in one award at a time (each foe, each rite); one sparkle per hero per update, for the sum.
    const xp = new Map<string, { amount: number; levelUp: boolean }>();
    for (const ev of events) {
      if (ev.t !== "xp" && ev.t !== "level_up") continue;
      const got = xp.get(ev.heroId) ?? { amount: 0, levelUp: false };
      if (ev.t === "xp") got.amount += ev.amount;
      else got.levelUp = true;
      xp.set(ev.heroId, got);
    }
    const ending = events.find((e) => e.t === "battle_end");
    // Your turn coming round gets a soft tick, once, and not as the fight ends.
    let myTurnAt: number | null = null;
    for (const ev of events) {
      if (ev.t === "battle_start") {
        // A boss's first appearance: a low swell as the opening card goes up.
        if (this.state?.battle?.combatants.some((c) => c.side === "enemy" && isBoss(c.kind))) this.later(0, () => sounds.boss(), 0.15);
      } else if (ev.t === "moved") {
        const unit = this.units.get(ev.heroId);
        if (unit) unit.path = ev.path.map((p) => this.standAt(p));
      } else if (ev.t === "chat") {
        const line = ev.line;
        if (line.who === "npc") this.say(`npc:${line.npcId}`, line.text);
        else if (line.who === "hero") {
          const id = line.heroId ?? this.state?.heroes.find((h) => h.name === line.name)?.id;
          if (id) this.say(id, line.text);
        }
      } else if (ev.t === "battle") {
        const b = ev.ev;
        // Sounds are asked for inside each beat, so they land with the picture, not when the message arrived.
        if (b.t === "hit") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, b.perfect, () => { sounds.impact(b.ability, attackStyle(b.ability), b.perfect, this.fighter(b.target), this.spot(b.target)); this.float(b.target, `-${b.amount}`, b.perfect ? "#ffd23f" : "#ff6b6b"); }, true));
        else if (b.t === "miss" && b.heal) this.later(beat++, () => { sounds.healFailed(this.spot(b.actor)); this.float(b.actor, "fails", "#c9d1e0"); });
        else if (b.t === "miss") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, false, () => { sounds.miss(b.ability, attackStyle(b.ability), this.spot(b.target)); this.float(b.target, "miss", "#c9d1e0"); }));
        else if (b.t === "heal") this.later(beat++, () => { sounds.heal(b.ability, this.spot(b.target)); this.sparkle(b.target, "#7dff9a"); this.float(b.target, `+${b.amount}`, "#7dff9a"); });
        else if (b.t === "tick") this.later(beat++, () => { sounds.tick(b.effect, this.spot(b.target)); this.float(b.target, `-${b.amount}`, "#ffa94d"); });
        else if (b.t === "turn" && b.id === this.state?.you) myTurnAt = beat;
        // A class trait kicking in gets its name over the hero.
        else if (b.t === "trait") this.later(beat++, () => { const name = TRAIT_BY_ID[b.trait]?.name ?? b.trait; sounds.trait(name, this.spot(b.id)); this.float(b.id, name, "#facc15"); });
        // These ride on the blow before them rather than taking a beat of their own.
        else if (b.t === "effect") { this.later(Math.max(startBeat, beat - 1) + 0.4, () => sounds.effect(b.effect, this.spot(b.target))); }
        else if (b.t === "down") { const who = this.fighter(b.id); this.later(Math.max(startBeat, beat - 1) + 0.6, () => sounds.down(who, this.spot(b.id))); }
        else if (b.t === "flee") this.later(beat, () => sounds.flee(b.ok, this.spot(b.actor)));
      } else if (this.state) {
        // After the blows queued so far, so a fight's closing sting does not cut across its last hit.
        const you = this.state.you;
        this.later(beat, () => sounds.world(ev, you));
      }
    }
    // After the last blow has landed.
    for (const [heroId, got] of xp) this.later(beat, () => this.xpGain(heroId, got.amount, got.levelUp));
    // Your turn coming round in a fight gets a soft tick (the closing sting comes from the battle's end event).
    if (!ending && myTurnAt !== null) this.later(myTurnAt, () => sounds.yourTurn(), 0.1);
  }

  /**
   * Show a line of chat in a speech bubble over a unit (a hero's id, or `npc:<id>`)
   * for a few seconds. A new line from the same unit replaces the last. Text only.
   */
  say(unitId: string, text: string) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || !this.units.has(unitId)) return;
    this.dropBubble(unitId);
    const { texture, width, rows } = bubbleTexture(clean);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false, opacity: 0 }));
    sprite.renderOrder = 8;
    sprite.visible = false;
    sprite.layers.set(OVERLAY_LAYER);
    this.unitGroup.add(sprite);
    this.bubbles.set(unitId, { sprite, width, rows, age: 0, life: bubbleLife(clean), raise: 0, shift: 0 });
  }

  private dropBubble(unitId: string) {
    const b = this.bubbles.get(unitId);
    if (!b) return;
    this.unitGroup.remove(b.sprite);
    b.sprite.material.map?.dispose();
    b.sprite.material.dispose();
    this.bubbles.delete(unitId);
  }

  /**
   * Hang each bubble over its speaker's head, above their tag, and lift any that
   * would cover another bubble or a tag, lowest on screen first. Worked in view
   * pixels, so a bubble's pixels stay on the view's.
   */
  private placeBubbles(dt: number, labelRow: number) {
    if (this.bubbles.size === 0) return;
    const W = this.renderer.domElement.width;
    const H = this.renderer.domElement.height;
    const v = new THREE.Vector3();
    const screen = (unit: Unit) => {
      v.set(unit.feet.x, unit.feet.y + unit.head, unit.feet.z).project(this.camera);
      return { x: ((v.x + 1) / 2) * W, y: ((v.y + 1) / 2) * H, behind: v.z > 1 };
    };
    type Box = { l: number; r: number; b: number; t: number };
    const taken: Box[] = [];
    // Tags, where each one sits (see the label's centre in syncUnits).
    const tagTop = new Map<Unit, number>();
    for (const unit of this.units.values()) {
      if (!unit.label) continue;
      const at = screen(unit);
      const rows = unit.label.userData.rows as number;
      const w = rows * (unit.label.userData.aspect as number);
      const bottom = at.y + 5 + unit.stack * (rows + 2);
      tagTop.set(unit, 5 + unit.stack * (rows + 2) + rows);
      taken.push({ l: at.x - w / 2, r: at.x + w / 2, b: bottom, t: bottom + rows });
    }
    const placing: { id: string; b: Bubble; unit: Unit; x: number; y: number; base: number }[] = [];
    for (const [id, b] of this.bubbles) {
      b.age += dt;
      const unit = this.units.get(id);
      if (b.age >= b.life) {
        this.dropBubble(id);
        continue;
      }
      if (!unit) {
        b.sprite.visible = false;
        continue;
      }
      const at = screen(unit);
      if (at.behind) {
        b.sprite.visible = false;
        continue;
      }
      placing.push({ id, b, unit, x: at.x, y: at.y, base: (tagTop.get(unit) ?? 3) + 2 });
    }
    placing.sort((p, q) => p.y + p.base - (q.y + q.base));
    const overlaps = (l: number, r: number, bottom: number, rows: number) => taken.find((o) => o.l < r && o.r > l && o.b < bottom + rows && o.t > bottom);
    for (const p of placing) {
      const { b, unit } = p;
      const half = b.width / 2;
      let bottom = p.y + p.base;
      let shift = 0;
      for (let pass = 0; pass < 24; pass++) {
        const hit = overlaps(p.x - half, p.x + half, bottom, b.rows);
        if (!hit) break;
        bottom = hit.t + 1;
      }
      // Lifted off the top of the view: stay on screen, and step aside instead.
      const ceiling = H - 2 - b.rows;
      if (bottom > ceiling && ceiling > p.y + p.base) {
        bottom = ceiling;
        let side = 0;
        for (let pass = 0; pass < 24; pass++) {
          const hit = overlaps(p.x + shift - half, p.x + shift + half, bottom, b.rows);
          if (!hit) break;
          const right = hit.r + 1 - (p.x + shift - half);
          const left = hit.l - 1 - (p.x + shift + half);
          // Pick a side once, the nearer one, so it does not bounce between two neighbours.
          if (!side) side = right <= -left ? 1 : -1;
          shift += side > 0 ? right : left;
        }
      }
      // Kept inside the view sideways too.
      shift = Math.max(2 + half - p.x, Math.min(W - 2 - half - p.x, shift));
      taken.push({ l: p.x + shift - half, r: p.x + shift + half, b: bottom, t: bottom + b.rows });
      const want = bottom - (p.y + p.base);
      // Eased so a bubble slides out of the way instead of jumping, but snapped to whole pixels.
      const k = 1 - Math.exp(-dt * 14);
      b.raise += (want - b.raise) * k;
      b.shift += (shift - b.shift) * k;
      if (Math.abs(want - b.raise) < 0.5) b.raise = want;
      if (Math.abs(shift - b.shift) < 0.5) b.shift = shift;
      const s = b.sprite;
      s.visible = true;
      s.position.set(unit.feet.x, unit.feet.y + unit.head, unit.feet.z);
      s.center.set(0.5 - Math.round(b.shift) / b.width, -(p.base + Math.round(b.raise)) / b.rows);
      const tall = b.rows * labelRow;
      s.scale.set(tall * (b.width / b.rows), tall, 1);
      s.material.opacity = Math.min(1, b.age / 0.15, (b.life - b.age) / BUBBLE_FADE);
    }
  }

  /** Run `run` on beat `beat` of what is being played out, `extra` seconds after it. */
  private later(beat: number, run: () => void, extra = 0) {
    this.pending.push({ at: this.clock + beat * 0.38 + extra, run });
  }

  private lunge(actorId: string, targetId: string) {
    const a = this.units.get(actorId);
    const t = this.units.get(targetId);
    if (a && t && a !== t) a.kick.copy(t.goal).sub(a.goal).setLength(0.7);
  }

  /** Who a unit is in the fight, for its voice: looked up when asked, as the fight's line-up can change. */
  private fighter(id: string): Fighter | undefined {
    const c = this.state?.battle?.combatants.find((x) => x.id === id);
    if (c) return { side: c.side, kind: c.kind };
    const h = this.state?.heroes.find((x) => x.id === id);
    return h ? { side: "hero", kind: h.classId } : undefined;
  }

  /** Where a unit stands on the map, for a sound's distance. */
  private spot(id: string): { x: number; z: number } | undefined {
    const p = this.units.get(id)?.sprite.position;
    return p ? { x: p.x, z: p.z } : undefined;
  }

  /**
   * Play one attack: the attacker leans in, then either a melee swipe lands
   * on the target at once, or a bolt or arrow flies across first. `onImpact`
   * runs when it lands.
   */
  private attack(actorId: string, targetId: string, ability: string, perfect: boolean, onImpact: () => void, landed = false) {
    const a = this.units.get(actorId);
    const t = this.units.get(targetId);
    if (!a || !t || a === t) return onImpact();
    sounds.attack(ability, attackStyle(ability), this.fighter(actorId), this.spot(actorId));
    const dir = t.goal.x >= a.goal.x ? 1 : -1;
    const flip = dir < 0;
    a.lean = -dir * 0.5;
    const hitAt = t.goal.clone().add(new THREE.Vector3(0, t.sprite.scale.y * 0.5, 0.05));
    const spell = SPELL_COLOR[ability];

    if (spell || ARROW_ABILITIES.has(ability)) {
      const kind: FxKind = spell ? "bolt" : "arrow";
      const color = spell ?? "#e8dcc0";
      const from = a.goal.clone().add(new THREE.Vector3(dir * 0.5, a.sprite.scale.y * 0.6, 0.05));
      this.spawnFx(kind, color, flip, { from, to: hitAt, life: 0.24, size: [1.0, 1.0], spin: 0, fade: false, onEnd: () => {
        this.spawnFx("burst", perfect ? "#ffd23f" : color, false, { from: hitAt, to: hitAt, life: 0.22, size: [0.7, 1.7], spin: 0.5, fade: true });
        // An arrow that lands stays in: point first, the shaft toward whoever shot it.
        if (kind === "arrow" && landed) this.stickArrow(t, dir);
        onImpact();
      } });
      return;
    }
    // Melee: step in and swipe across the target.
    this.lunge(actorId, targetId);
    this.spawnFx("slash", perfect ? "#ffd23f" : "#dfe9ff", flip, { from: hitAt, to: hitAt, life: 0.26, size: [1.3, 2.3], spin: -dir * 0.9, fade: true });
    onImpact();
  }

  /** Leave an arrow standing in `unit`, shot from the `dir` side (1: from the left). */
  private stickArrow(unit: Unit, dir: number) {
    const arrows = (unit.arrows ??= []);
    if (arrows.length >= MAX_STUCK_ARROWS) this.dropArrow(arrows.shift()!);
    const size = 0.6;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture("arrow", "#e8dcc0", dir < 0), transparent: true, depthTest: false }));
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 5;
    const h = unit.sprite.scale.y;
    const w = unit.sprite.scale.x;
    // Somewhere on the body, the point a little inside it, the shaft drooping a touch.
    // Spread over the body: each new one avoids the height of the last so they don't bunch up.
    const last = arrows.at(-1)?.off.y ?? -1;
    let y = h * (0.25 + Math.random() * 0.5);
    if (Math.abs(y - last) < h * 0.12) y = h * 0.25 + ((y - h * 0.25 + h * 0.2) % (h * 0.5));
    const off = new THREE.Vector3(-dir * (size * 0.3) + (Math.random() - 0.5) * w * 0.3, y, 0.06);
    const rot = dir * (-0.05 - Math.random() * 0.35);
    this.fxGroup.add(sprite);
    arrows.push({ sprite, off, rot });
  }

  private dropArrow(a: StuckArrow) {
    this.fxGroup.remove(a.sprite);
    a.sprite.material.dispose();
  }

  private clearArrows(unit: Unit) {
    for (const a of unit.arrows ?? []) this.dropArrow(a);
    unit.arrows = [];
  }

  private sparkle(unitId: string, color: string) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const from = unit.goal.clone().add(new THREE.Vector3(0, unit.sprite.scale.y * 0.4, 0.05));
    this.spawnFx("spark", color, false, { from, to: from.clone().add(new THREE.Vector3(0, 0.9, 0)), life: 0.6, size: [1.2, 1.5], spin: 0, fade: true });
  }

  private spawnFx(kind: FxKind, color: string, flip: boolean, opts: Omit<Fx, "sprite" | "age">) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture(kind, color, flip), transparent: true, depthTest: false }));
    sprite.renderOrder = 4;
    sprite.position.copy(opts.from);
    sprite.scale.set(opts.size[0], opts.size[0], 1);
    sprite.renderOrder = 9;
    this.fxGroup.add(sprite);
    this.fx.push({ sprite, age: 0, ...opts });
  }

  private float(unitId: string, text: string, color: string, opts: { life?: number; rise?: number; height?: number; lift?: number; at?: THREE.Vector3 } = {}) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const map = textTexture(text, color);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    const height = opts.height ?? 0.45;
    // The texture is 24 rows tall and as wide as the text needs: keep its pixels square.
    sprite.scale.set((height * map.image.width) / 24, height, 1);
    sprite.position.copy(opts.at ?? unit.sprite.position.clone().add(new THREE.Vector3(0, unit.sprite.scale.y + 0.5, 0))).add(new THREE.Vector3(0, opts.lift ?? 0, 0));
    sprite.renderOrder = 10;
    this.fxGroup.add(sprite);
    this.floaters.push({ sprite, age: 0, life: opts.life, rise: opts.rise });
  }

  /**
   * A hero earned XP: a short burst of gold and pale-blue pixel motes rising
   * off their head and fading, a crisp "+N XP", and their plate's XP bar lit
   * up for a moment. `levelUp` adds a bigger flourish: more motes, a gold
   * burst, a ring of motes thrown outward and "LEVEL UP" over the top.
   */
  /**
   * A walking hero's hop has just touched the ground: a step sounds, by what they stepped on, and a little
   * puff is kicked up at their feet. Only heroes out of a fight, awake, and in view.
   */
  private footfall(id: string, unit: Unit) {
    const state = this.state;
    if (!state || state.battle || unit.asleep || !unit.sprite.visible) return;
    const hero = state.heroes.find((h) => h.id === id);
    if (!hero || hero.asleep) return;
    const feet = unit.feet;
    // Nothing off screen is heard or drawn.
    const seen = feet.clone().project(this.camera);
    if (seen.z > 1 || Math.abs(seen.x) > 1.05 || Math.abs(seen.y) > 1.05) return;
    // Heroes stand a quarter hex toward the camera from the middle of their hex (see syncUnits).
    const under = worldToHex(feet.x, feet.z - 0.25);
    const biome = tileAt(state.map, under)?.biome;
    // At the water's edge the step sets a ring going on the sea beside it.
    if (fancy.get() && biome && biome !== "water") {
      const here = hexToWorld(under);
      let nearest: { x: number; z: number } | null = null;
      let best = Infinity;
      for (const dir of HEX_DIRS) {
        const next = { q: under.q + dir.q, r: under.r + dir.r };
        if (tileAt(state.map, next)?.biome !== "water") continue;
        const there = hexToWorld(next);
        const d = Math.hypot(there.x - feet.x, there.z - feet.z);
        if (d < best) {
          best = d;
          nearest = there;
        }
      }
      // Just over the shared edge, a little along it either way so the rings are not all in one spot.
      if (nearest) {
        const along = (Math.random() - 0.5) * 0.5;
        const dx = nearest.x - here.x;
        const dz = nearest.z - here.z;
        addWaterRipple(here.x + dx * 0.6 - dz * along * 0.5, here.z + dz * 0.6 + dx * along * 0.5);
      }
    }
    const ground = stepGround(biome);
    if (!ground || !biome) return;
    // The audio engine plays it, placed where the foot lands and falling off with distance from you.
    sounds.footstep(biome, { x: feet.x, z: feet.z }, id === state.you);
    if (!this.still) this.puff(ground, feet);
  }

  private puff(ground: keyof typeof PUFFS, at: THREE.Vector3) {
    const look = PUFFS[ground];
    for (let i = 0; i < look.count; i++) {
      let puff = this.puffs.find((p) => !p.sprite.visible);
      if (!puff && this.puffs.length < PUFF_POOL) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
        // Drawn before the hero cards (renderOrder 2), so a hero is always in front of the dust at their feet.
        sprite.renderOrder = 1;
        this.fxGroup.add(sprite);
        puff = { sprite, age: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, size: 0, alpha: 0 };
        this.puffs.push(puff);
      }
      if (!puff) puff = this.puffs[(this.nextPuff = (this.nextPuff + 1) % this.puffs.length)];
      // Kicked out to either side of the foot, the second the other way.
      const side = (i % 2 ? 1 : -1) * (0.5 + Math.random() * 0.5);
      const color = look.colors[(Math.random() * look.colors.length) | 0];
      puff.sprite.material.map = fxTexture(look.kind, color, side > 0);
      puff.sprite.material.needsUpdate = true;
      puff.sprite.visible = true;
      puff.age = 0;
      puff.life = 0.32 + Math.random() * 0.14;
      puff.x = at.x + side * 0.22;
      puff.z = at.z + 0.06;
      // The shapes are drawn low in their tile (rows 4 to 11 of 16): lift it so the lowest row rests on the ground.
      puff.y = at.y + look.size * 0.26;
      puff.vx = side * 0.9;
      puff.vy = look.kind === "splash" ? 0.6 : 0.3;
      puff.size = look.size * (0.85 + Math.random() * 0.3);
      puff.alpha = look.alpha;
      puff.sprite.position.set(puff.x, puff.y, puff.z);
      puff.sprite.scale.set(puff.size * 0.8, puff.size * 0.8, 1);
      puff.sprite.material.opacity = puff.alpha;
    }
  }

  xpGain(unitId: string, amount: number, levelUp = false) {
    const unit = this.units.get(unitId);
    if (!unit || !(amount > 0 || levelUp)) return;
    if (levelUp && unitId === this.state?.you) sounds.levelUp();
    const head = unit.goal.clone().add(new THREE.Vector3(0, unit.sprite.scale.y * 0.85, 0.05));
    // Everything rises clear of the plate, which floats a fixed number of screen pixels over the head.
    const top = Math.max(head.y + 0.4, this.plateTop(unit) ?? 0);
    const above = (y: number) => new THREE.Vector3(head.x, y, head.z);
    const count = levelUp ? 22 : 10;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      const spread = levelUp ? 0.55 : 0.35;
      const from = head.clone().add(new THREE.Vector3(Math.cos(a) * spread * Math.random(), Math.random() * 0.25, Math.sin(a) * 0.1));
      const to = new THREE.Vector3(from.x + Math.cos(a) * (levelUp ? 0.45 : 0.15), top + 0.15 + Math.random() * (levelUp ? 0.9 : 0.45), from.z);
      const life = 0.7 + Math.random() * 0.4;
      // The mote is 4 of its tile's 16 pixels: about two of a hero sprite's pixels across.
      const size = 0.4 + Math.random() * 0.25;
      // Each mote starts a little late, so the burst ripples rather than pops.
      const delay = Math.random() * 0.18;
      this.pending.push({ at: this.clock + delay, run: () => this.spawnFx("mote", XP_MOTES[i % XP_MOTES.length], false, { from, to, life, size: [size, size * 0.5], spin: 0, fade: true }) });
    }
    if (amount > 0) this.float(unitId, `+${amount} XP`, "#ffe27a", { life: 1.1, rise: 0.6, height: 0.4, at: above(top + 0.3) });
    unit.glowUntil = this.clock + (levelUp ? 1.2 : 0.7);
    this.applyLabel(unit);
    if (levelUp) {
      this.spawnFx("burst", "#ffd23f", false, { from: head, to: head, life: 0.45, size: [0.8, 2.4], spin: 0.6, fade: true });
      this.pending.push({ at: this.clock + 0.25, run: () => this.float(unitId, "LEVEL UP", "#ffd23f", { life: 1.6, rise: 0.5, height: 0.5, at: above(top + 0.8) }) });
    }
  }

  // ---------- terrain ----------

  private buildTerrain(state: RenderState, recentre = true) {
    this.mapCode = state.code;
    this.sodden = state.map.tiles.some((t) => t.biome === "cobble");
    this.seaBase.set(this.sodden ? "#2b4558" : "#3577cf");
    (this.sea.material as THREE.MeshLambertMaterial).color.copy(this.seaBase);
    this.wallTurn = NaN;
    this.lowered.clear();
    this.hangable.clear();
    if (state.indoors) for (const f of wallFaces(state.map)) this.hangable.set(key(f.pos), [...(this.hangable.get(key(f.pos)) ?? []), f.side]);
    this.tiles = state.map.tiles;
    this.water = state.map.tiles.filter((t) => t.biome === "water").map(hexToWorld);
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
    }
    this.decor.clear();
    this.poiSig = "";

    const geo = new THREE.CylinderGeometry(0.985, 0.985, 1, 6);
    geo.translate(0, 0.5, 0);
    const terrain = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), this.tiles.length);
    const m = new THREE.Matrix4();
    // Open sea is left to the sea itself: only water within a couple of hexes of land is drawn as hexes,
    // with a ragged edge, so the map does not end in a straight-sided block of water.
    const land = this.tiles.filter((t) => t.biome !== "water");
    // For the night life: where the grass is, and where the land lies.
    this.nightLife.setGrass(
      this.tiles.filter((t) => t.biome === "plains" || t.biome === "forest").map((t) => {
        const { x, z } = hexToWorld(t);
        return new THREE.Vector3(x, tileTop(t), z);
      }),
    );
    const spots = (land.length > 0 ? land : this.tiles).map(hexToWorld);
    this.land.x = spots.reduce((n, s) => n + s.x, 0) / Math.max(1, spots.length);
    this.land.z = spots.reduce((n, s) => n + s.z, 0) / Math.max(1, spots.length);
    this.land.reach = Math.max(2, ...spots.map((s) => Math.hypot(s.x - this.land.x, s.z - this.land.z)));
    this.deep = new Set(
      this.tiles
        .filter((t) => {
          // Water with something standing in it (rocks, a wreck) stays, so it can still be pointed at.
          if (t.biome !== "water" || state.map.pois.some((p) => p.pos.q === t.q && p.pos.r === t.r)) return false;
          // A map that is all sea (the crossing to an island) is drawn whole.
          if (land.length === 0) return false;
          const near = Math.min(...land.map((l) => hexDistance(l, t)));
          return near > 2 || (near === 2 && noise(t.q, t.r, 31) < 0.45);
        })
        .map(key),
    );
    // For the fancy water: which hexes are water, how near the shore, and which of their sides touch land.
    addFancyWater(terrain.material as THREE.MeshLambertMaterial, true);
    const water = waterAttribute(this.tiles.length);
    const byKey = new Map(this.tiles.map((t) => [key(t), t]));
    const isLand = (t: Tile | undefined) => !!t && t.biome !== "water" && t.biome !== "fog";
    this.tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t);
      const shown = this.deep.has(key(t)) ? 0 : 1;
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(shown, tileTop(t) * shown, shown));
      terrain.setMatrixAt(i, m);
      if (t.biome !== "water") {
        water.setXYZ(i, 0, 0, GROUND_KIND[t.biome] ?? 0);
        return;
      }
      let sides = 0;
      for (const dir of HEX_DIRS) {
        const next = { q: t.q + dir.q, r: t.r + dir.r };
        if (!isLand(byKey.get(key(next)))) continue;
        const to = hexToWorld(next);
        sides |= 1 << shoreSide(to.x - x, to.z - z);
      }
      water.setXYZ(i, 1, sides, 0);
    });
    geo.setAttribute("aWater", water);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.terrain = terrain;
    this.scene.add(terrain);

    // Trees on forest. POI hexes stay clear. Rocks, grass and waves come from the ambience.
    const poiKeys = new Set(state.map.pois.map((p) => key(p.pos)));
    const trees: THREE.Matrix4[] = [];
    for (const t of this.tiles) {
      if (poiKeys.has(key(t)) || t.biome !== "forest") continue;
      const { x, z } = hexToWorld(t);
      const top = tileTop(t);
      for (let i = 0; i < 2; i++) {
        const s = 0.8 + noise(t.q, t.r, i) * 0.5;
        trees.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x + (noise(t.q, t.r, i + 3) - 0.5) * 0.9, top + 0.45 * s, z + (noise(t.q, t.r, i + 7) - 0.5) * 0.8 - 0.1),
            new THREE.Quaternion(),
            new THREE.Vector3(s, s, s),
          ),
        );
      }
    }
    // The rampart's broken teeth: a merlon or two left standing on each length of wall.
    const merlons: THREE.Matrix4[] = [];
    for (const t of this.tiles) {
      if (t.biome !== "rampart") continue;
      const { x, z } = hexToWorld(t);
      const top = tileTop(t);
      for (let i = 0; i < 3; i++) {
        if (noise(t.q, t.r, 20 + i) < 0.35) continue;
        const a = (i / 3) * Math.PI * 2 + noise(t.q, t.r, 23) * 2;
        const tall = 0.18 + noise(t.q, t.r, 26 + i) * 0.2;
        merlons.push(new THREE.Matrix4().compose(new THREE.Vector3(x + Math.sin(a) * 0.55, top + tall / 2, z + Math.cos(a) * 0.55), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0)), new THREE.Vector3(0.36, tall, 0.3)));
      }
    }
    this.ambience.build(
      this.tiles.filter((t) => !this.deep.has(key(t))),
      (t) => poiKeys.has(key(t)),
      (t) => ({ ...hexToWorld(t), y: tileTop(t) }),
    );
    const instanced = (geometry: THREE.BufferGeometry, color: string, mats: THREE.Matrix4[]) => {
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }), Math.max(1, mats.length));
      mesh.count = mats.length;
      mats.forEach((mat, i) => mesh.setMatrixAt(i, mat));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.decor.add(mesh);
      return mesh;
    };
    // The trees bend in the wind (fancy graphics): 0.9 is the cone's height.
    this.forest = instanced(new THREE.ConeGeometry(0.34, 0.9, 5), this.sodden ? "#3a5d41" : "#2f7a3d", trees);
    addWindSway(this.forest.material as THREE.Material, 0.9);
    if (merlons.length > 0) instanced(new THREE.BoxGeometry(1, 1, 1), "#6a6d75", merlons);

    // Start centred on the island. Fog lifting redraws the ground but leaves the camera where the player put it.
    if (!recentre) return;
    const xs = this.tiles.map((t) => hexToWorld(t).x);
    const zs = this.tiles.map((t) => hexToWorld(t).z);
    this.middle.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
    this.target.copy(this.middle);
    this.targetGoal.copy(this.target);
  }

  /**
   * Indoors, the walls between the camera and the room are cut down to a
   * kerb, like a doll's house, so the room can be seen from any side.
   */
  private lowerNearWalls() {
    const turn = Math.round(this.yaw * 20);
    if (!this.terrain || turn === this.wallTurn) return;
    this.wallTurn = turn;
    const m = new THREE.Matrix4();
    const upright = new THREE.Quaternion();
    const kerb = tileTop({ q: 0, r: 0, biome: "wall", h: 0.22 } as Tile);
    // A wall away from the camera stands its full height; the low front wall, seen from behind, comes up a little.
    const raised = tileTop({ q: 0, r: 0, biome: "wall", h: 0.9 } as Tile);
    const was = [...this.lowered].join("|");
    this.lowered.clear();
    this.tiles.forEach((t, i) => {
      if ((t.biome as string) !== "wall") return;
      const { x, z } = hexToWorld(t);
      const toward = (x - this.middle.x) * Math.sin(this.yaw) + (z - this.middle.z) * Math.cos(this.yaw);
      if (toward > 0.6) this.lowered.add(key(t));
      m.compose(new THREE.Vector3(x, 0, z), upright, new THREE.Vector3(1, toward > 0.6 ? kerb : Math.max(raised, tileTop(t)), 1));
      this.terrain!.setMatrixAt(i, m);
    });
    this.terrain.instanceMatrix.needsUpdate = true;
    this.hideLoweredWallProps();
    // A wall cut down (or stood back up) and the pieces hung on it change every light's shadows.
    if ([...this.lowered].join("|") !== was) this.ambience.stirAll();
  }

  /** Things hung on a wall that has been cut down for the camera would float in the air: hide them until it stands again. */
  private hideLoweredWallProps() {
    for (const g of this.propModels.values()) {
      const wall = g.userData.wallKey as string | undefined;
      if (wall) g.visible = !this.lowered.has(wall);
    }
    for (const pane of this.panes.children) pane.visible = !this.lowered.has(pane.userData.wallKey as string);
  }

  // ---------- windows ----------

  /** The picture this view is drawn into, for another view to show. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** For a backdrop: where it is seen from and what it looks at, and how wide a view that is (degrees, top to bottom). */
  setVantage(from: THREE.Vector3, to: THREE.Vector3, fov: number) {
    this.vantage = { from, to };
    this.baseFov = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** For a backdrop: draw one frame now. The view showing it calls this, so the picture is fresh when it is copied. */
  step(now: number, flash: number) {
    this.lentFlash = flash;
    this.frame(now);
  }

  /**
   * Gives a room windows onto another view: `outside` is a backdrop (the Harbor), drawn off screen and
   * shown through panes set into the back wall. Null takes them away.
   */
  setOutlook(outside: WorldRenderer | null) {
    this.outlook = outside;
    this.outlookMap?.dispose();
    this.outlookMap = null;
    if (outside) {
      const map = new THREE.CanvasTexture(outside.canvas);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      map.colorSpace = THREE.SRGBColorSpace;
      this.outlookMap = map;
    }
    this.buildPanes(this.state);
  }

  /** The windows themselves: a few panes along the back wall, each showing its own slice of the one picture. */
  private buildPanes(state: RenderState | null) {
    for (const pane of this.panes.children) {
      pane.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.panes.clear();
    if (!this.outlookMap || !state?.indoors) return;
    // The back wall is the row furthest from the door. Its faces, left to right as seen from the room.
    const back = wallFaces(state.map)
      .filter((f) => f.pos.r === 0)
      .map((f) => ({ ...f, at: wallFace(f.pos, f.side) }))
      .sort((a, b) => a.at.x - b.at.x);
    if (back.length === 0) return;
    const count = Math.min(OUTLOOK_PANES, back.length);
    const frame = new THREE.MeshLambertMaterial({ color: "#4a3520", flatShading: true });
    for (let i = 0; i < count; i++) {
      // Spread evenly along the wall, leaving its ends clear.
      const face = back[Math.round(((i + 0.5) / count) * (back.length - 1))];
      const spot = this.wallSpot(face.pos, face.side, 0, PANE.y);
      const pane = new THREE.Group();
      pane.position.copy(spot.at).addScaledVector(new THREE.Vector3(face.at.nx, 0, face.at.nz), 0.03);
      pane.rotation.y = spot.yaw;
      pane.userData.wallKey = key(face.pos);
      // The glass: this pane's slice of the picture, lit from outside and not by the room.
      const glass = new THREE.PlaneGeometry(PANE.w, PANE.h);
      const uv = glass.getAttribute("uv") as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v++) uv.setX(v, (i + uv.getX(v)) / count);
      const view = new THREE.Mesh(glass, new THREE.MeshBasicMaterial({ map: this.outlookMap, toneMapped: false }));
      view.userData.glow = true;
      pane.add(view);
      // A wooden frame round it, and a bar down and across the middle.
      const bar = (w: number, h: number, x: number, y: number) => {
        const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frame);
        piece.position.set(x, y, 0.01);
        pane.add(piece);
      };
      bar(PANE.w + 0.1, 0.06, 0, PANE.h / 2 + 0.02);
      bar(PANE.w + 0.1, 0.06, 0, -PANE.h / 2 - 0.02);
      bar(0.06, PANE.h + 0.1, -PANE.w / 2 - 0.02, 0);
      bar(0.06, PANE.h + 0.1, PANE.w / 2 + 0.02, 0);
      bar(0.03, PANE.h, 0, 0);
      bar(PANE.w, 0.03, 0, 0);
      this.panes.add(pane);
    }
    this.hideLoweredWallProps();
  }

  /** Once a frame: has the backdrop draw itself, every other frame, and takes its new picture. */
  private showOutlook() {
    if (!this.outlook || !this.outlookMap || this.panes.children.length === 0) return;
    if (this.frames % 2 !== 0) return;
    this.outlook.step(this.last, this.storm.flash);
    this.outlookMap.needsUpdate = true;
  }

  /** Where a wall piece hangs: on side `side` of wall hex `pos`, `x` along it and `y` up from the floor; and which way it faces. */
  private wallSpot(pos: HexPos, side: number, x: number, y: number): { at: THREE.Vector3; yaw: number } {
    const f = wallFace(pos, side);
    return { at: new THREE.Vector3(f.x + f.tx * x, FLOOR_TOP + y, f.z + f.tz * x), yaw: Math.atan2(f.nx, f.nz) };
  }

  private paintTiles() {
    if (!this.terrain) return;
    const c = new THREE.Color();
    const white = new THREE.Color("#ffffff");
    this.tiles.forEach((t, i) => {
      c.set(BIOME_COLOR[t.biome]);
      // Fog is a pale mist by day and all but black by night.
      if (t.biome === "fog") c.set(FOG_DAY).lerp(FOG_NIGHT, Math.max(0, this.paintedNight) / 10);
      // In a wet, walled port the green is tired.
      if (this.sodden && (t.biome === "plains" || t.biome === "forest")) c.lerp(DRAB, 0.5);
      if (this.sodden && t.biome === "water") c.lerp(GREY_SEA, 0.65);
      if (t.biome === "water") c.lerp(NIGHT_SEA, (Math.max(0, this.paintedNight) / 10) * 0.7);
      c.offsetHSL(0, 0, (noise(t.q, t.r, 9) - 0.5) * (t.biome === "rampart" ? 0.1 : 0.06));
      const r = this.reach.get(key(t));
      if (r && r.cost > 0 && !this.state?.freeRoam) c.lerp(white, 0.3);
      this.terrain!.setColorAt(i, c);
    });
    if (this.terrain.instanceColor) this.terrain.instanceColor.needsUpdate = true;
  }

  /** World position for something standing on a hex. */
  private standAt(pos: HexPos): THREE.Vector3 {
    const { x, z } = hexToWorld(pos);
    return new THREE.Vector3(x, tileTop(this.state ? tileAt(this.state.map, pos) : undefined), z);
  }

  /**
   * Where a point above a hex sits on screen, in CSS pixels from the container's top left corner.
   * `lift` is how far above the ground to aim; the default is where a hero's name label hangs.
   * Null when the point is behind the camera or outside the view.
   */
  /**
   * Just above the top of a prop, in container pixels, wherever it stands
   * (on the floor or on another piece's top). Null when it is not drawn or not on screen.
   */
  screenAboveProp(id: string | number, lift = 0.15): { x: number; y: number } | null {
    const g = this.propModels.get(id);
    if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return null;
    const v = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + lift, (box.min.z + box.max.z) / 2);
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  screenAbove(pos: HexPos, lift = 1.8): { x: number; y: number } | null {
    if (!this.state) return null;
    const v = this.standAt(pos);
    v.y += lift;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    // The canvas is drawn at 1/PIXEL size and stretched; the container's own size is what the HUD is laid out in.
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /**
   * Where a unit's name label sits, in container pixels: just above its head,
   * wherever the unit is drawn (which is not always the middle of its hex).
   * Null when the unit is not on screen.
   */
  screenAboveUnit(id: string): { x: number; y: number } | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    const v = unit.sprite.position.clone();
    v.y += unit.sprite.scale.y + 0.3 - unit.bob;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /** Ease the camera over to a hex. Following your hero pauses there until they next walk. */
  lookAt(pos: HexPos) {
    this.targetGoal.copy(this.standAt(pos));
    if (this.follow && !this.followHeld) {
      this.followHeld = true;
      this.showFollow();
    }
  }

  /** Keep your hero centred (or stop). Turning it on brings the camera back to them, easing there. */
  setFollow(on: boolean) {
    this.follow = on;
    this.followHeld = false;
    writeFollow(on);
    this.showFollow();
  }

  /** The follow button lit (and pressed) while following. */
  private showFollow() {
    const b = this.followButton;
    const on = this.follow && !this.followHeld;
    const title = on ? "Following your hero; drag the map to look around (C)" : "Follow your hero (C)";
    b.setAttribute("aria-pressed", String(on));
    b.title = title;
    b.setAttribute("aria-label", "Follow your hero");
  }

  /** Centre the camera over a point on the map, in world units; `snap` puts it there at once instead of easing. */
  focusAt(x: number, z: number, snap = false) {
    this.targetGoal.set(x, 0.14, z);
    if (snap) this.target.copy(this.targetGoal);
  }

  /**
   * Hand the view to a game played on a hex: `make` gets a group standing on
   * that hex to build in, and the camera and input until `endMinigame`. Your hero
   * is hidden meanwhile (you are seeing through their eyes), as are the
   * point of interest on the hex (the game brings its own) and the camera
   * buttons.
   */
  startMinigame<T extends WorldMinigame>(make: (group: THREE.Group) => T, at: HexPos, hidePoi?: string): T {
    this.endMinigame();
    const group = new THREE.Group();
    group.position.copy(this.standAt(at));
    this.scene.add(group);
    const game = make(group);
    const hidden: { obj: THREE.Object3D; was: boolean }[] = [];
    const hide = (obj: THREE.Object3D | null | undefined) => {
      if (!obj) return;
      hidden.push({ obj, was: obj.visible });
      obj.visible = false;
    };
    hide(hidePoi ? this.poiObject(hidePoi) : undefined);
    this.minigame = { game, group, hidden, felled: [] };
    this.hideOwnHero();
    for (const b of [this.followButton, ...this.turnButtons]) b.style.visibility = "hidden";
    // Bring the usual view over the hex first, so the swing in starts from somewhere near.
    const { x, z } = hexToWorld(at);
    this.targetGoal.set(x, 0.14, z);
    this.heldKeys.clear();
    return game;
  }

  /** Give the view back: the game's group is taken down and everything it hid is shown again. */
  endMinigame() {
    const m = this.minigame;
    if (!m) return;
    this.minigame = null;
    this.scene.remove(m.group);
    m.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      // Sprite and effect textures are shared caches: free the materials, not their maps.
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) mat.dispose();
    });
    for (const h of m.hidden) h.obj.visible = h.was;
    if (this.forest && m.felled.length) {
      for (const { i, m: mat } of m.felled) this.forest.setMatrixAt(i, mat);
      this.forest.instanceMatrix.needsUpdate = true;
    }
    const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) for (const obj of [mine.sprite, mine.label, mine.ring]) if (obj) obj.visible = true;
    for (const id of this.stageHidden) this.showUnit(id);
    this.stageHidden = [];
    for (const b of [this.followButton, ...this.turnButtons]) b.style.visibility = "";
    if (this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * What is under a point of the map, in world units: the ground there, how
   * high its top stands, and whether a point of interest (a building, a spot)
   * is on that hex. Null off the map.
   */
  groundAt(x: number, z: number): { biome: string; top: number; poi: boolean } | null {
    if (!this.state) return null;
    const pos = worldToHex(x, z);
    const tile = tileAt(this.state.map, pos);
    if (!tile) return null;
    return { biome: tile.biome, top: tileTop(tile), poi: this.state.map.pois.some((p) => p.pos.q === pos.q && p.pos.r === pos.r) };
  }

  /** For the minigame under way: take the forest's own trees out of a circle (world units) so its things stand clear. Put back when it ends. */
  clearTrees(x: number, z: number, radius: number) {
    const m = this.minigame;
    const forest = this.forest;
    if (!m || !forest) return;
    const mat = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (let i = 0; i < forest.count; i++) {
      forest.getMatrixAt(i, mat);
      at.setFromMatrixPosition(mat);
      if (Math.hypot(at.x - x, at.z - z) > radius || mat.elements[0] === 0) continue;
      m.felled.push({ i, m: mat.clone() });
      forest.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    }
    forest.instanceMatrix.needsUpdate = true;
  }

  /** While a minigame runs you see through your hero's eyes: their sprite, tag and ring are not drawn. So are the units a game draws itself (a table's players, who all stand on its one hex). */
  private hideOwnHero() {
    const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) for (const obj of [mine.sprite, mine.label, mine.ring]) if (obj) obj.visible = false;
    for (const id of this.stageHidden) {
      const u = this.units.get(id);
      if (!u) continue;
      for (const obj of [u.sprite, u.label, u.ring, ...u.casters]) if (obj) obj.visible = false;
    }
  }

  /** Units a minigame draws for itself: hidden while it runs (see hideOwnHero), shown again by the next list or when it ends. */
  setStageHidden(ids: string[]) {
    const gone = this.stageHidden.filter((id) => !ids.includes(id));
    this.stageHidden = ids;
    for (const id of gone) this.showUnit(id);
    if (this.minigame) this.hideOwnHero();
  }

  private showUnit(id: string) {
    const u = this.units.get(id);
    if (!u) return;
    for (const obj of [u.sprite, u.label, u.ring]) if (obj) obj.visible = true;
    for (const c of u.casters) c.visible = !u.asleep;
  }

  /** A point of interest's model, by id, for a scene that moves one about itself (the crew's ship at sea). */
  poiObject(id: string): THREE.Object3D | undefined {
    return this.poiGroup.children.find((g) => g.userData.poiId === id);
  }

  /** Whether a unit is still on its way along a walked path. */
  isWalking(id: string): boolean {
    return (this.units.get(id)?.path.length ?? 0) > 0;
  }

  // ---------- for a minigame's own things ----------

  /** The minigame being played, if any. */
  get playing(): WorldMinigame | null {
    return this.minigame?.game ?? null;
  }

  /** How dark it is outdoors, 0 (day) to 1 (dead of night). */
  get night(): number {
    return this.ambience.night;
  }

  /** Whether the finishing pass (glow and the rest) is on in this view. */
  get glowing(): boolean {
    return !!this.post;
  }

  /** Add something to the scene outside the minigame's own group (a pick held in front of the camera), or take it away. */
  addObject(obj: THREE.Object3D) {
    this.scene.add(obj);
  }

  removeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
  }

  /** Run `fn` every frame before drawing, with the frame's time step, the camera and the render clock. Returns the way to stop. */
  addTicker(fn: (dt: number, camera: THREE.PerspectiveCamera, clock: number) => void): () => void {
    this.tickers.add(fn);
    return () => this.tickers.delete(fn);
  }

  /** The nearest of `objects` (and their children) under a point on screen, in client pixels. */
  pickAt(objects: THREE.Object3D[], clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  // ---------- points of interest ----------

  private buildPois(state: RenderState) {
    const sig = state.map.pois.map((p) => `${p.id}:${p.cleared}:${p.tier ?? ""}:${p.fill ?? ""}`).join("|");
    if (sig === this.poiSig) return;
    this.poiSig = sig;
    this.poiGroup.clear();
    // What stands in the water, for the fancy sea to foam round. Each model sits a little back from its hex's middle.
    const standing: Standing[] = [];
    for (const poi of state.map.pois) {
      const { x, z } = hexToWorld(poi.pos);
      if (poi.kind === "rocks") standing.push({ x: x - 0.05, z: z - 0.2, half: 0.25, radius: 0.5 });
      else if (poi.kind === "wreck") standing.push({ x: x + 0.2, z: z - 0.2, half: 0.75, radius: 0.45 });
      // A moored ship lies off the end of its pier.
      else if (poi.kind === "pier") standing.push({ x, z: z + 1.47, half: 0.72, radius: 0.36 });
    }
    setWaterStanding(standing);
    /** Chimney tops, which the ambience draws smoke from. */
    const stacks: THREE.Vector3[] = [];
    /** A lighthouse's lantern, which the ambience turns a beam from. */
    let beacon: THREE.Vector3 | null = null;
    /** Buildings' lit windows and lanterns, and the panes that warm at dusk. */
    const glows: BuildingGlow[] = [];
    const panes: THREE.MeshBasicMaterial[] = [];
    for (const poi of state.map.pois) {
      const g = this.poiModel(poi);
      g.userData.poiId = poi.id;
      const at = this.standAt(poi.pos);
      g.position.set(at.x, at.y, at.z - 0.28);
      g.traverse((o) => {
        // A glow is light, not a solid: it neither casts nor takes a shadow.
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = !o.userData.glow;
      });
      this.poiGroup.add(g);
      if (g.userData.smoke) stacks.push((g.userData.smoke as THREE.Vector3).clone().add(g.position));
      if (g.userData.beacon) beacon = (g.userData.beacon as THREE.Vector3).clone().add(g.position);
      for (const glow of (g.userData.glows as BuildingGlow[] | undefined) ?? []) glows.push({ ...glow, pos: glow.pos.clone().add(g.position) });
      panes.push(...((g.userData.panes as THREE.MeshBasicMaterial[] | undefined) ?? []));
    }
    this.ambience.setSmoke(stacks);
    this.ambience.setBeacon(beacon);
    this.ambience.setGlows(glows, panes);
    // The sea breaks around rocks standing out of it, and the wreck on them.
    this.ambience.setSeaRocks(state.map.pois.filter((p) => p.kind === "rocks" || p.kind === "wreck").map((p) => this.standAt(p.pos)));
  }

  /** Furniture: rebuilt whenever a piece is added, moved, turned or selected. */
  private buildProps(state: RenderState) {
    const props = state.props ?? [];
    const sig = props.map((p) => `${p.id}:${p.model}:${key(p.pos)}:${p.facing}:${p.selected ? 1 : 0}:${p.x ?? 0}:${p.z ?? 0}:${p.y ?? 0}:${p.angle ?? 0}:${p.on ?? ""}`).join("|");
    if (sig === this.propSig) return;
    this.propSig = sig;
    this.propGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.propGroup.clear();
    this.propModels.clear();
    this.surfaces = [];
    /** The flames the ambience flickers. */
    const flames: THREE.Mesh[] = [];
    // Pieces on the floor first, then the small things standing on them, which are hung on their support so they turn and move with it.
    const ordered = [...props.filter((p) => p.on === undefined), ...props.filter((p) => p.on !== undefined)];
    for (const prop of ordered) {
      const g = propModel(prop.model);
      const base = prop.on !== undefined ? this.propModels.get(prop.on) : undefined;
      if (prop.on !== undefined && !base) continue;
      if (base) {
        const top = (base.userData.surface as SceneProp["surface"]) ?? { y: 0, w: 0, d: 0 };
        g.position.set(prop.x ?? 0, top.y, prop.z ?? 0);
        g.rotation.y = -(prop.angle ?? 0);
        base.add(g);
      } else if (prop.mount) {
        const { at, yaw } = this.wallSpot(prop.pos, prop.facing, prop.x ?? 0, prop.y ?? 0);
        g.position.copy(at);
        g.rotation.y = yaw;
        g.userData.wallKey = key(prop.pos);
        this.propGroup.add(g);
      } else {
        const at = this.standAt(prop.pos);
        g.position.set(at.x + (prop.x ?? 0), at.y, at.z + (prop.z ?? 0));
        g.rotation.y = yawOf(prop.facing, prop.angle);
        this.propGroup.add(g);
      }
      g.userData.surface = prop.surface;
      this.propModels.set(prop.id, g);
      // A lamp or candle holds its light inside its own frame (a lantern's cage, a candle's wick),
      // so its parts would shadow their own light: it casts none. A fire's light sits in front of
      // the hearth, so a hearth or fireplace still casts shadows from the other lights in the room.
      let lamplike = false;
      g.traverse((o) => {
        if (o.userData.light && o.userData.light !== "fire") lamplike = true;
      });
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.userData.propId = prop.id;
        // Flames and glowing panes give light rather than block it; glass lets it through.
        if (o.userData.flame !== undefined) flames.push(o);
        else if (o.userData.selfLit || o.userData.glass) return;
        else {
          o.castShadow = !lamplike;
          o.receiveShadow = true;
        }
      });
      if (prop.surface) {
        // An unseen sheet over its top, which a carried small thing is aimed at.
        const t = prop.surface;
        const sheet = new THREE.Mesh(new THREE.PlaneGeometry(t.w, t.d), new THREE.MeshBasicMaterial({ visible: false }));
        sheet.rotation.x = -Math.PI / 2;
        sheet.position.set(t.x ?? 0, t.y + 0.002, t.z ?? 0);
        sheet.userData.sheetOf = prop.id;
        g.add(sheet);
        this.surfaces.push(sheet);
      }
    }
    this.propGroup.updateMatrixWorld(true);
    // Rings for the piece being handled, and lights wherever a model asks for one.
    const lights: { pos: THREE.Vector3; kind: LightKind }[] = [];
    for (const prop of ordered) {
      const g = this.propModels.get(prop.id);
      if (!g) continue;
      g.traverse((o) => {
        if (o.userData.light) lights.push({ pos: o.getWorldPosition(new THREE.Vector3()), kind: o.userData.light as LightKind });
      });
      if (prop.selected && !prop.mount && (prop.covers?.length ?? 0) > 1) {
        // A piece reaching across hexes: outline every hex it covers, as one shape.
        this.propGroup.add(this.coverOutline(prop.covers!));
      } else if (prop.selected) {
        const outer = prop.small ? 0.24 : prop.ring ?? 0.95;
        const inner = prop.small ? 0.18 : outer - 0.13;
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, prop.mount ? 16 : 6), new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide, depthTest: !prop.small && !prop.mount }));
        if (prop.mount) {
          // Flat on the wall, just in front of the piece, and hidden with it.
          ring.position.set(0, 0, 0.02);
          g.add(ring);
        } else {
          ring.rotation.x = -Math.PI / 2;
          ring.rotation.z = Math.PI / 6;
          ring.position.copy(g.getWorldPosition(new THREE.Vector3())).setY(g.getWorldPosition(new THREE.Vector3()).y + 0.03);
          this.propGroup.add(ring);
        }
        ring.renderOrder = 2;
      }
    }
    this.hideLoweredWallProps();
    this.ambience.setLights(lights, flames);
    this.ear.lights(lights.map((l) => ({ kind: l.kind, x: l.pos.x, z: l.pos.z })));
  }

  /** A flat gold band just inside the outer edges of a group of hexes, on the floor: the selection ring of a piece covering more than one. */
  private coverOutline(hexes: HexPos[]): THREE.Mesh {
    const inside = new Set(hexes.map(key));
    const points: number[] = [];
    const y = FLOOR_TOP + 0.03;
    for (const h of hexes) {
      const { x, z } = hexToWorld(h);
      for (let i = 0; i < 6; i++) {
        // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector (as in buildJoinRanges).
        const [a, b] = [(i * Math.PI) / 3, ((i + 1) * Math.PI) / 3];
        const mid = (a + b) / 2;
        const nr = Math.round((z + Math.cos(mid) * SQRT3) / 1.5);
        const nq = Math.round((x + Math.sin(mid) * SQRT3) / SQRT3 - nr / 2);
        if (inside.has(key({ q: nq, r: nr }))) continue;
        const corner = (t: number, k: number) => [x + Math.sin(t) * k, y, z + Math.cos(t) * k];
        const [ao, bo, bi, ai] = [corner(a, 0.97), corner(b, 0.97), corner(b, 0.84), corner(a, 0.84)];
        points.push(...ao, ...bo, ...bi, ...ao, ...bi, ...ai);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const band = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide }));
    band.renderOrder = 2;
    return band;
  }

  // ---------- carrying a piece: the ghost that follows the pointer ----------

  /** The ghost of whatever is being carried, rebuilt when that changes. */
  private updateGhost() {
    const holding = this.state?.holding ?? null;
    const sig = holding ? `${holding.model}:${JSON.stringify(holding.footprint ?? null)}` : "";
    if (sig !== this.ghostSig) {
      this.ghostSig = sig;
      if (this.ghost) {
        this.scene.remove(this.ghost);
        this.ghost.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose();
          (mesh.material as THREE.Material | undefined)?.dispose();
        });
        this.ghost = null;
      }
      if (holding) {
        this.ghost = ghostModel(holding.model);
        const fp = holding.footprint;
        if (fp) {
          // What it will cover, laid on the floor under it: tinted with the ghost, red where it does not fit.
          const plate = new THREE.Mesh(
            fp.round ? new THREE.CircleGeometry(fp.w / 2, 32) : new THREE.PlaneGeometry(fp.w, fp.d),
            new THREE.MeshBasicMaterial({ color: "#bfe8ff", transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
          );
          plate.rotation.x = -Math.PI / 2;
          plate.position.set(fp.x ?? 0, 0.015, fp.z ?? 0);
          this.ghost.add(plate);
        }
        this.ghost.visible = false;
        this.scene.add(this.ghost);
      }
    }
    this.placeGhost();
  }

  /** Where the pointer would set the carried piece down, or null if it is off the room. */
  private aim(): PlaceTarget | null {
    const holding = this.state?.holding;
    if (!holding || !this.terrain || !this.pointer.inside) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (holding.mount) return this.aimAtWall(holding.mount);
    if (holding.small) {
      // A top first: aimed at, the thing stands on it, kept inside its edges. Not one hidden with its wall.
      const top = this.raycaster.intersectObjects(this.surfaces, false).find((h) => this.propModels.get(h.object.userData.sheetOf as string | number)?.visible !== false);
      if (top) {
        const id = top.object.userData.sheetOf as string | number;
        const base = this.propModels.get(id)!;
        const t = base.userData.surface as NonNullable<SceneProp["surface"]>;
        const local = base.worldToLocal(top.point.clone());
        const x = Math.max((t.x ?? 0) - t.w / 2, Math.min((t.x ?? 0) + t.w / 2, local.x));
        const z = Math.max((t.z ?? 0) - t.d / 2, Math.min((t.z ?? 0) + t.d / 2, local.z));
        const prop = this.state?.props?.find((p) => p.id === id);
        return { pos: prop?.pos ?? { q: 0, r: 0 }, x: round(x), z: round(z), on: id };
      }
    }
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    let pos = { q: t.q, r: t.r };
    let [px, pz] = [hit.point.x, hit.point.z];
    const fp = holding.footprint;
    if (!holding.small && fp && Math.hypot(fp.x ?? 0, fp.z ?? 0) > 0.3) {
      // A long piece is held by its middle: the hex it is anchored on is back along it from the pointer.
      const turn = -yawOf(holding.facing, holding.angle);
      const [c, s] = [Math.cos(turn), Math.sin(turn)];
      const [fx, fz] = [fp.x ?? 0, fp.z ?? 0];
      [px, pz] = [px - (fx * c - fz * s), pz - (fx * s + fz * c)];
      pos = hexAt(px, pz);
    }
    const mid = hexToWorld(pos);
    let x = px - mid.x;
    let z = pz - mid.z;
    const d = Math.hypot(x, z);
    // Furniture goes anywhere in its hex too, but settles in the middle when brought near it, the way it always stood.
    if (!holding.small && d < 0.15) return { pos, x: 0, z: 0 };
    const reach = holding.small ? SMALL_REACH : BIG_REACH;
    if (d > reach) [x, z] = [(x / d) * reach, (z / d) * reach];
    return { pos, x: round(x), z: round(z) };
  }

  /**
   * Where the pointer would hang a wall piece `mount` big: on the side of a
   * back or side wall it is over (or, over the floor, the nearest such side
   * beside it), as far along and as high as it points, kept on that side.
   */
  private aimAtWall(mount: { w: number; h: number }): PlaceTarget | null {
    const hit = this.raycaster.intersectObject(this.terrain!)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    const point = hit.point;
    let pos: HexPos;
    let side: number;
    let y = this.wallY;
    if (t.biome === "wall") {
      if (this.lowered.has(key(t))) return null;
      pos = { q: t.q, r: t.r };
      const mid = hexToWorld(pos);
      const sides = this.hangable.get(key(t));
      if (!sides?.length) return null;
      // The side the pointer is nearest, of those that face the room.
      const score = (s: number) => {
        const f = wallFace(pos, s);
        return f.nx * (point.x - mid.x) + f.nz * (point.z - mid.z);
      };
      side = sides.reduce((a, b) => (score(b) > score(a) ? b : a));
      // On the face of the wall (not its top), the height is where the pointer is.
      if (hit.face && Math.abs(hit.face.normal.y) < 0.5) y = point.y - FLOOR_TOP;
    } else if (t.biome === "floor") {
      // Over the floor beside a wall: the nearest side facing it, at the last height used.
      let best: { pos: HexPos; side: number; d: number } | null = null;
      HEX_DIRS.forEach((dir) => {
        const w = { q: t.q + dir.q, r: t.r + dir.r };
        if (this.lowered.has(key(w))) return;
        const back = HEX_DIRS.findIndex((o) => o.q === -dir.q && o.r === -dir.r);
        if (!this.hangable.get(key(w))?.includes(back)) return;
        const f = wallFace(w, back);
        const d = Math.hypot(point.x - f.x, point.z - f.z);
        if (d < 0.6 && (!best || d < best.d)) best = { pos: w, side: back, d };
      });
      if (!best) return null;
      ({ pos, side } = best);
    } else return null;
    const f = wallFace(pos, side);
    const along = Math.max(0, WALL_FACE_HALF - mount.w / 2);
    const x = Math.max(-along, Math.min(along, (point.x - f.x) * f.tx + (point.z - f.z) * f.tz));
    y = Math.max(WALL_ITEM_BOTTOM + mount.h / 2, Math.min(WALL_ITEM_TOP - mount.h / 2, y));
    this.wallY = y;
    return { pos, x: round(x), z: 0, wall: { side, y: round(y) } };
  }

  private placeGhost() {
    const ghost = this.ghost;
    const holding = this.state?.holding;
    if (!ghost || !holding) return;
    const target = this.aim();
    this.aimedAt = target;
    ghost.visible = !!target;
    if (!target) return;
    const base = target.on !== undefined ? this.propModels.get(target.on) : undefined;
    if (target.wall) {
      const { at, yaw } = this.wallSpot(target.pos, target.wall.side, target.x, target.wall.y);
      ghost.position.copy(at);
      ghost.rotation.y = yaw;
    } else if (base) {
      const t = base.userData.surface as NonNullable<SceneProp["surface"]>;
      ghost.position.copy(base.localToWorld(new THREE.Vector3(target.x, t.y + 0.004, target.z)));
      // Props only ever turn about the vertical, so the support's yaw is all there is to add.
      ghost.rotation.y = new THREE.Euler().setFromQuaternion(base.getWorldQuaternion(new THREE.Quaternion()), "YXZ").y - holding.angle;
    } else {
      const at = this.standAt(target.pos);
      // Anchored off the floor (a long piece held near a wall): drawn at floor height all the same, and red.
      const y = this.state && tileAt(this.state.map, target.pos)?.biome === "floor" ? at.y : FLOOR_TOP;
      ghost.position.set(at.x + target.x, y + 0.004, at.z + target.z);
      ghost.rotation.y = yawOf(holding.facing, holding.angle);
    }
    tintGhost(ghost, this.callbacks.canPlace?.(target) ?? true);
  }

  /** The prop under the pointer, if any. */
  private pickProp(): string | number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.propGroup, true).find((h) => h.object.userData.propId !== undefined && !h.object.userData.sheetOf);
    return hit ? (hit.object.userData.propId as string | number) : null;
  }

  /** Cost of stepping onto a tile: the terrain's, except that furniture cannot be walked through. */
  private stepCost(state: RenderState): ((t: Tile) => number) | undefined {
    if (!state.props?.length) return undefined;
    // Small things are stepped over, and so are rugs.
    const blocked = new Set(state.props.filter((p) => !p.small && !p.mount && !p.flat && p.on === undefined).flatMap((p) => (p.covers ?? [p.pos]).map(key)));
    return (t) => (blocked.has(key(t)) ? Infinity : MOVE_COST[t.biome]);
  }

  /**
   * Outline, in red, the area around a place with enemies still in it: a
   * hero standing inside the line when a fight starts there is pulled in.
   * Shown only when it matters: while the pointer is over the place or its
   * surroundings, or while a hero is standing inside the area.
   */
  private buildJoinRanges(state: RenderState) {
    const near = (p: HexPos, poi: Poi) => hexDistance(p, poi.pos) <= BATTLE_JOIN_RANGE;
    const hostile = state.battle
      ? []
      : state.map.pois.filter(
          (poi) => !poi.cleared && poi.enemies.length > 0 && ((this.hovered && near(this.hovered, poi)) || state.heroes.some((h) => near(h.pos, poi))),
        );
    const sig = `${state.code}|${hostile.map((p) => p.id).join(",")}`;
    if (sig === this.rangeSig) return;
    this.rangeSig = sig;
    for (const child of this.rangeGroup.children) (child as THREE.LineSegments).geometry.dispose();
    this.rangeGroup.clear();

    const points: number[] = [];
    for (const poi of hostile) {
      const inside = (p: HexPos) => hexDistance(p, poi.pos) <= BATTLE_JOIN_RANGE;
      for (const t of this.tiles) {
        if (!inside(t)) continue;
        const { x, z } = hexToWorld(t);
        const y = tileTop(t) + 0.05;
        for (let i = 0; i < 6; i++) {
          // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector.
          const a = (i * Math.PI) / 3;
          const b = ((i + 1) * Math.PI) / 3;
          const mid = (a + b) / 2;
          const nx = x + Math.sin(mid) * SQRT3;
          const nz = z + Math.cos(mid) * SQRT3;
          const nr = Math.round(nz / 1.5);
          const nq = Math.round(nx / SQRT3 - nr / 2);
          const neighbour = { q: nq, r: nr };
          // Draw only the edges on the boundary; the map's own edge counts as boundary.
          if (inside(neighbour) && tileAt(state.map, neighbour)) continue;
          points.push(x + Math.sin(a), y, z + Math.cos(a), x + Math.sin(b), y, z + Math.cos(b));
        }
      }
    }
    if (points.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: "#ff3b3b", transparent: true, opacity: 0.9, depthTest: false }));
    lines.renderOrder = 2;
    this.rangeGroup.add(lines);
  }

  private poiModel(poi: Poi): THREE.Group {
    const g = new THREE.Group();
    const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      g.add(mesh);
      return mesh;
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    switch (poi.kind) {
      case "landing": {
        if (this.state?.kind === "caverns") {
          // The way back out of the caverns: a rope down the rock and a lantern on a spike.
          add(box(0.04, 0.9, 0.04), lambert("#c9a877"), -0.35, 0.45, -0.3);
          add(box(0.05, 0.5, 0.05), lambert("#3d4048"), 0.35, 0.25, -0.2);
          add(box(0.16, 0.18, 0.16), new THREE.MeshBasicMaterial({ color: "#ffd98a" }), 0.35, 0.58, -0.2).userData.glow = true;
          break;
        }
        add(box(1.0, 0.08, 0.5), lambert("#8a6a44"), 0, 0.05, 0.1);
        // The party's ship, moored just offshore to the west. Named, so the landfall can hide it while she is still coming in.
        add(box(1.1, 0.32, 0.5), lambert("#6b4a2b"), -1.5, -0.05, 0.3).name = "moored";
        add(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 5), lambert("#4a3520"), -1.5, 0.6, 0.3).name = "moored";
        add(box(0.05, 0.6, 0.55), lambert("#f4efe1"), -1.42, 0.75, 0.3).name = "moored";
        break;
      }
      case "hut":
        add(box(0.75, 0.45, 0.6), lambert("#b98b5a"), 0, 0.225, 0);
        add(new THREE.ConeGeometry(0.66, 0.42, 4), lambert("#8c3b2f"), 0, 0.66, 0, Math.PI / 4);
        break;
      case "lair":
        add(new THREE.ConeGeometry(0.6, 1.0, 5), lambert("#3a3340"), -0.1, 0.5, 0);
        add(new THREE.ConeGeometry(0.38, 0.65, 5), lambert("#2a2430"), 0.45, 0.32, 0.1);
        add(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: poi.cleared ? "#6a6a6a" : "#e04fd0" }), 0.1, 1.15, 0.15);
        break;
      case "shrine":
        add(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 6), lambert("#d8d8d8"), 0, 0.06, 0);
        add(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 6), lambert("#efefef"), 0, 0.45, 0);
        add(new THREE.OctahedronGeometry(0.15), new THREE.MeshBasicMaterial({ color: "#ffd23f" }), 0, 0.98, 0);
        break;
      case "pickup": {
        // Taken: nothing left to draw.
        if (poi.cleared) break;
        // Drawn at 1.7x into its own group, and lit a little from within so it still reads at night and under trees.
        const pile = new THREE.Group();
        pile.scale.setScalar(1.7);
        g.add(pile);
        const lit = (color: string, glow = 0.35) =>
          new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: new THREE.Color(color).multiplyScalar(glow) });
        const put = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(x, y, z);
          mesh.rotation.y = rotY;
          pile.add(mesh);
          return mesh;
        };
        // A soft pale disc on the ground marks it as something to pick up.
        const halo = new THREE.Mesh(
          new THREE.CircleGeometry(0.3, 16),
          new THREE.MeshBasicMaterial({ color: "#fff4c2", transparent: true, opacity: 0.18, depthWrite: false }),
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(0, 0.01, 0.08);
        pile.add(halo);
        if (poi.find === "herbs") {
          for (const [x, z, k] of [[-0.14, 0.1, 1], [0.04, 0.2, 0.85], [0.16, 0.05, 0.95], [-0.02, -0.03, 0.75]]) {
            put(new THREE.ConeGeometry(0.08 * k, 0.26 * k, 5), lit("#6fc24a"), x, 0.13 * k, z);
            put(new THREE.ConeGeometry(0.06 * k, 0.2 * k, 5), lit("#9be06a"), x + 0.05, 0.1 * k, z + 0.03, 0.6);
          }
          for (const [x, z] of [[-0.14, 0.1], [0.16, 0.05], [0.04, 0.2], [-0.02, -0.03]]) put(new THREE.BoxGeometry(0.06, 0.06, 0.06), lit("#e2b8ff", 0.6), x, 0.28, z);
        } else if (poi.find === "mushrooms") {
          for (const [x, z, k] of [[-0.12, 0.12, 1], [0.12, 0.18, 0.8], [0.06, -0.02, 0.65]]) {
            put(new THREE.CylinderGeometry(0.035 * k, 0.045 * k, 0.16 * k, 6), lit("#fbf3e2", 0.4), x, 0.08 * k, z);
            put(new THREE.SphereGeometry(0.11 * k, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), lit("#e2412a", 0.45), x, 0.15 * k, z);
            for (const [dx, dz] of [[0.04, 0.04], [-0.04, 0.03], [0.0, -0.05]]) put(new THREE.BoxGeometry(0.025, 0.02, 0.025), lit("#ffffff", 0.8), x + dx * k, 0.15 * k + 0.085 * k, z + dz * k);
          }
        } else if (poi.find === "wood") {
          // A small stack of cut logs, pale cut ends toward the camera.
          const log = new THREE.CylinderGeometry(0.07, 0.07, 0.42, 7);
          const end = new THREE.CircleGeometry(0.06, 7);
          for (const [x, y] of [[-0.15, 0.07], [0, 0.07], [0.15, 0.07], [-0.075, 0.2], [0.075, 0.2]]) {
            put(log, lit("#a8713a", 0.3), x, y, 0.08).rotation.x = Math.PI / 2;
            put(end, lit("#e8c890", 0.4), x, y, 0.295);
          }
        } else {
          for (const [x, z, k, y] of [[-0.12, 0.1, 1, 0], [0.13, 0.15, 0.8, 0], [0.02, -0.05, 0.7, 0], [0.0, 0.12, 0.6, 0.12]]) {
            put(new THREE.DodecahedronGeometry(0.11 * k), lit(k > 0.75 ? "#b4bcc8" : "#d0d6de", 0.3), x, 0.09 * k + y, z);
          }
        }
        break;
      }
      case "cache": {
        if (this.state?.kind === "caverns" && poi.loot) {
          // An old chest, an iron-bound strongbox, or the hoard: bigger, and banded, and (until it is opened) glinting.
          const k = poi.loot === "hoard" ? 1.45 : poi.loot === "vault" ? 1.2 : 1;
          const wood = lambert(poi.cleared ? "#5b4a3a" : poi.loot === "chest" ? "#8a5a2b" : "#6b3f22");
          const iron = lambert(poi.loot === "chest" ? "#6e6250" : "#3f4248");
          add(box(0.44 * k, 0.24 * k, 0.3 * k), wood, 0, 0.12 * k, 0.2);
          for (const x of [-0.15 * k, 0.15 * k]) add(box(0.04 * k, 0.25 * k, 0.31 * k), iron, x, 0.125 * k, 0.2);
          if (poi.cleared) {
            // Thrown open: the lid stands up at the back, and nothing glints.
            const lid = add(box(0.44 * k, 0.04 * k, 0.3 * k), wood, 0, 0.3 * k, 0.05);
            lid.rotation.x = -1.2;
          } else {
            add(box(0.46 * k, 0.07 * k, 0.32 * k), wood, 0, 0.27 * k, 0.2);
            add(box(0.06, 0.07, 0.02), lambert("#d8b45a"), 0, 0.2 * k, 0.2 + 0.155 * k);
            if (poi.loot !== "chest") {
              // Coin spilling out at its foot, lit so it catches the torchlight from across a chamber.
              const coin = new THREE.MeshBasicMaterial({ color: "#ffd45e" });
              for (const [x, z] of [[-0.3, 0.42], [-0.18, 0.5], [0.26, 0.46], [0.34, 0.36], [0.05, 0.52]]) add(box(0.07, 0.025, 0.07), coin, x * k, 0.015, z).userData.glow = true;
            }
          }
          break;
        }
        add(box(0.38, 0.24, 0.26), lambert(poi.cleared ? "#6b6b6b" : "#9a6b2f"), 0, 0.12, 0.2);
        if (!poi.cleared) add(box(0.4, 0.05, 0.28), lambert("#e0b12e"), 0, 0.26, 0.2);
        break;
      }
      case "gate": {
        // A heavy timber door across a cave tunnel, in a frame of old beams. Swung back against the rock once it is open.
        const frame = new THREE.Group();
        // Centred on its hex (places are drawn a little toward the camera), and turned to stand across the passage.
        frame.position.z = 0.28;
        if (poi.into) {
          const a = hexToWorld(poi.pos);
          const b = hexToWorld({ q: poi.pos.q + poi.into.q, r: poi.pos.r + poi.into.r });
          frame.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        }
        g.add(frame);
        const beam = lambert("#4a3420");
        const put = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(x, y, z);
          frame.add(mesh);
          return mesh;
        };
        for (const x of [-0.72, 0.72]) put(box(0.18, 1.25, 0.2), beam, x, 0.62, 0);
        put(box(1.66, 0.18, 0.24), beam, 0, 1.3, 0);
        // The door hangs from its left post.
        const hinge = new THREE.Group();
        hinge.position.set(-0.62, 0, 0);
        hinge.rotation.y = poi.cleared ? -1.45 : 0;
        frame.add(hinge);
        const plank = lambert(poi.cleared ? "#5b4632" : "#6b4a2b");
        const band = lambert("#30333a");
        for (let i = 0; i < 4; i++) {
          const m = new THREE.Mesh(box(0.3, 1.1, 0.1), plank);
          m.position.set(0.16 + i * 0.31, 0.56, 0);
          hinge.add(m);
        }
        for (const y of [0.25, 0.85]) {
          const m = new THREE.Mesh(box(1.26, 0.07, 0.13), band);
          m.position.set(0.62, y, 0);
          hinge.add(m);
        }
        if (!poi.cleared) {
          // A brass lock plate that catches the torchlight.
          const lock = new THREE.Mesh(box(0.12, 0.16, 0.04), new THREE.MeshBasicMaterial({ color: "#d8b45a" }));
          lock.position.set(1.05, 0.56, 0.07);
          lock.userData.glow = true;
          hinge.add(lock);
        }
        break;
      }
      case "pier": {
        // A crew ship moored off the end of the pier, toward the open sea.
        add(box(1.5, 0.4, 0.62), lambert("#6b4a2b"), 0, -0.02, 1.75);
        add(box(0.5, 0.22, 0.5), lambert("#5a3d22"), 0.5, 0.28, 1.75);
        add(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 5), lambert("#4a3520"), -0.1, 0.9, 1.75);
        add(box(0.75, 0.75, 0.05), lambert("#f4efe1"), -0.1, 1.15, 1.7);
        add(box(0.3, 0.06, 0.9), lambert("#8a6a44"), 0, 0.02, 0.95);
        break;
      }
      case "ship": {
        // The crew's ship under sail, seen from the beam: hull, deckhouse, a mast with a full square sail, and a white curl at the bow.
        add(box(1.6, 0.42, 0.66), lambert("#6b4a2b"), 0, 0.02, 0.28);
        add(box(1.7, 0.06, 0.72), lambert("#4a3520"), 0, 0.25, 0.28);
        add(box(0.5, 0.24, 0.5), lambert("#5a3d22"), -0.5, 0.4, 0.28);
        add(new THREE.CylinderGeometry(0.05, 0.06, 1.7, 5), lambert("#4a3520"), 0.1, 1.1, 0.28);
        // The sail is drawn side on, like the hull, so it shows its face while she runs left to right.
        add(box(0.95, 0.95, 0.06), lambert("#f4efe1"), 0.22, 1.25, 0.28);
        add(box(1.05, 0.07, 0.07), lambert("#4a3520"), 0.22, 1.74, 0.28);
        add(box(0.3, 0.16, 0.03), lambert("#b9433d"), 0.1, 2.0, 0.28);
        add(box(0.3, 0.06, 0.8), new THREE.MeshBasicMaterial({ color: "#f2f9ff" }), 0.95, -0.12, 0.28);
        add(box(0.6, 0.04, 0.5), new THREE.MeshBasicMaterial({ color: "#cfe6fb" }), -1.1, -0.14, 0.28);
        break;
      }
      case "lot": {
        // A plot for sale: four corner stakes, a line of twine, and a board on a post.
        const stake = lambert("#7a5230");
        for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
        add(box(0.05, 0.55, 0.05), stake, 0, 0.27, 0.0);
        add(box(0.42, 0.24, 0.04), lambert("#c9a877"), 0, 0.55, 0.0);
        break;
      }
      case "site": {
        // A bought plot with no shack yet: the stakes and twine, and an open wooden bin that fills with planks and stones.
        const stake = lambert("#7a5230");
        for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
        const boards = lambert("#8a5f36");
        const W = 0.56, D = 0.4, H = 0.3, T = 0.04;
        add(box(W, 0.03, D), lambert("#5e4026"), 0, 0.015, 0.25);
        add(box(W, H, T), boards, 0, H / 2, 0.25 - D / 2);
        add(box(W, H, T), boards, 0, H / 2, 0.25 + D / 2);
        add(box(T, H, D), boards, -W / 2, H / 2, 0.25);
        add(box(T, H, D), boards, W / 2, H / 2, 0.25);
        // A darker band round the rim so the bin reads as a box, not a block.
        add(box(W + 0.02, 0.04, T + 0.01), lambert("#5e4026"), 0, H - 0.02, 0.25 + D / 2);
        const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
        if (fill > 0) {
          // Planks on the left, stones on the right, rising together; full, they heap over the rim.
          const top = 0.03 + fill * (H + 0.06);
          const plank = lambert("#c9a877");
          const stone = lambert("#8b8f96");
          for (let i = 0; i < 3; i++) add(box(0.22, 0.04, 0.07), plank, -0.12, Math.max(0.05, top - 0.03 - i * 0.05), 0.15 + i * 0.09);
          for (const [x, z, s] of [[0.13, 0.17, 0.09], [0.18, 0.31, 0.08], [0.08, 0.33, 0.07]]) add(box(s, s * 0.8, s), stone, x, Math.max(0.05, top - s / 2), z, 0.5);
        }
        break;
      }
      case "plot": {
        // Roof colour is picked from the owner's id so each hut is recognisable.
        const roofs = ["#8c3b2f", "#2f6f8c", "#6b8c2f", "#8c6a2f", "#6a2f8c", "#2f8c7a"];
        let hash = 0;
        for (const ch of poi.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        // A bigger hut is a wider, taller building: a Cottage gains a chimney, a Lodge a second wing.
        const tier = Math.max(1, Math.min(3, poi.tier ?? 1));
        const k = 1 + (tier - 1) * 0.22;
        const roof = lambert(roofs[hash % roofs.length]);
        add(box(0.8 * k, 0.5 * k, 0.65 * k), lambert("#c9a877"), 0, 0.25 * k, 0);
        add(new THREE.ConeGeometry(0.72 * k, 0.45 * k, 4), roof, 0, 0.72 * k, 0, Math.PI / 4);
        add(box(0.18, 0.3, 0.04), lambert("#5a3d22"), 0, 0.15, 0.325 * k + 0.005);
        if (tier >= 2) add(box(0.14, 0.42, 0.14), lambert("#8b8f96"), 0.26 * k, 0.86 * k, -0.1);
        if (tier >= 3) {
          add(box(0.5, 0.42, 0.5), lambert("#c9a877"), -0.72, 0.21, 0.08);
          add(new THREE.ConeGeometry(0.46, 0.3, 4), roof, -0.72, 0.57, 0.08, Math.PI / 4);
        }
        break;
      }
      case "pub": {
        // The pub: the warm heart of the town. A two-storey inn, bigger than any hut: a stone ground floor, a jettied
        // upper floor of cream plaster and dark timbers under a steep gabled roof, windows that warm and glow as the
        // light goes, a painted sign on a bracket, a lantern, and barrels and a bench out front.
        const timber = lambert("#4a2f22");
        const plaster = lambert("#e8d9b5");
        const stone = lambert("#a8977a");
        const roofMat = lambert("#7a3a2c");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        /** A window's glass: dim amber by day, lamplit by night. */
        const pane = (unlit: string, lit: string) => {
          const m = warmPane(unlit, lit);
          panes.push(m);
          return m;
        };
        const lowerGlass = pane("#c99a52", "#ffd98a");
        const upperGlass = pane("#b98a4a", "#ffc870");
        /** A framed window on the front, with a cross of glazing bars. */
        const framed = (x: number, y: number, w: number, h: number, z: number, glass: THREE.Material) => {
          add(box(w + 0.05, h + 0.05, 0.012), timber, x, y, z);
          add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
          add(box(0.02, h, 0.012), timber, x, y, z + 0.014);
          add(box(w, 0.02, 0.012), timber, x, y, z + 0.014);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.18), size: w * 2.2 });
        };

        // The ground floor: a stone plinth and stone walls.
        add(box(1.6, 0.08, 1.0), lambert("#7b8494"), 0, 0.04, 0);
        add(box(1.5, 0.46, 0.92), stone, 0, 0.31, 0);
        for (const x of [-0.48, 0.48]) {
          framed(x, 0.31, 0.26, 0.2, 0.46, lowerGlass);
          add(box(0.32, 0.03, 0.06), timber, x, 0.19, 0.48);
        }
        // The door: a red door in a timber frame, a lit fanlight over it, a brass handle and a stone step.
        add(box(0.3, 0.42, 0.02), timber, 0, 0.29, 0.465);
        add(box(0.22, 0.35, 0.03), lambert("#7a3a24"), 0, 0.255, 0.47);
        add(box(0.2, 0.035, 0.02), lowerGlass, 0, 0.472, 0.475).userData.glow = true;
        add(box(0.03, 0.03, 0.02), lambert("#e0b12e"), 0.07, 0.25, 0.49);
        add(box(0.4, 0.04, 0.12), lambert("#8b8f96"), 0, 0.02, 0.56);
        // A little gabled hood over the door on two brackets.
        const hood = add(box(0.46, 0.035, 0.24), roofMat, 0, 0.53, 0.57);
        hood.rotation.x = 0.35;
        for (const x of [-0.19, 0.19]) add(box(0.03, 0.03, 0.16), timber, x, 0.47, 0.52).rotation.x = -0.75;

        // The jettied upper floor: a beam, cream plaster, and a frame of dark timbers.
        add(box(1.62, 0.07, 1.04), timber, 0, 0.575, 0);
        add(box(1.58, 0.38, 1.0), plaster, 0, 0.8, 0);
        add(box(1.64, 0.05, 1.04), timber, 0, 1.0, 0);
        for (const x of [-0.79, 0.79]) for (const z of [-0.5, 0.5]) add(box(0.06, 0.38, 0.06), timber, x, 0.8, z);
        for (const x of [-0.25, 0.25]) for (const z of [-0.505, 0.505]) add(box(0.05, 0.38, 0.02), timber, x, 0.8, z);
        for (const x of [-0.795, 0.795]) add(box(0.02, 0.38, 0.05), timber, x, 0.8, 0);
        // A cross brace in the middle bay, front and back.
        for (const z of [-0.507, 0.507]) for (const tilt of [-0.66, 0.66]) add(box(0.56, 0.04, 0.015), timber, 0, 0.8, z).rotation.z = tilt;
        // Two windows upstairs, each with a box of flowers under it.
        for (const [x, bloom] of [[-0.52, "#d0473a"], [0.52, "#e8c53a"]] as [number, string][]) {
          framed(x, 0.82, 0.22, 0.18, 0.5, upperGlass);
          add(box(0.28, 0.06, 0.08), lambert("#6b4a2b"), x, 0.68, 0.54);
          add(box(0.24, 0.04, 0.06), lambert("#4f8a3a"), x, 0.725, 0.54);
          for (const dx of [-0.08, 0, 0.08]) add(box(0.04, 0.04, 0.04), lambert(bloom), x + dx, 0.755, 0.55 + (dx === 0 ? 0.01 : 0));
        }

        // The roof: a long gabled roof with eaves that overhang all round, and a smaller gable over the door,
        // standing out of the front slab, with a lit window in it.
        const eaves = 1.02;
        /** A gabled roof: a plaster prism `len` long, `half` out to each eave and `rise` high, under two overhanging slabs. Its ridge runs along x, or along z with `alongZ`. */
        const gabled = (cx: number, cz: number, len: number, half: number, rise: number, alongZ: boolean) => {
          const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
          const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
          if (!alongZ) prism.rotateY(Math.PI / 2);
          add(prism, plaster, cx, eaves, cz);
          const pitch = Math.atan2(rise, half);
          const slope = Math.hypot(rise, half) * 1.18;
          for (const side of [1, -1]) {
            // Half way down the slope, lifted half a slab's thickness off the gable.
            const along = slope / 2;
            const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
            const y = eaves + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
            if (alongZ) add(box(slope, 0.06, len + 0.1), roofMat, cx + out, y, cz).rotation.z = -side * pitch;
            else add(box(len + 0.2, 0.06, slope), roofMat, cx, y, cz + out).rotation.x = side * pitch;
          }
          return pitch;
        };
        const rise = 0.44;
        const pitch = gabled(0, 0, 1.56, 0.5, rise, false);
        // A darker course of shingles part way down each slope, and a ridge cap.
        for (const side of [1, -1]) {
          const d = 0.24;
          add(box(1.77, 0.065, 0.06), lambert("#5d2a20"), 0, eaves + rise - d * Math.sin(pitch) + 0.035 * Math.cos(pitch), side * (d * Math.cos(pitch) + 0.035 * Math.sin(pitch))).rotation.x = side * pitch;
        }
        add(box(1.82, 0.07, 0.1), lambert("#4a2018"), 0, eaves + rise + 0.03, 0);
        gabled(0, 0.32, 0.48, 0.32, 0.34, true);
        add(box(0.08, 0.06, 0.58), lambert("#4a2018"), 0, eaves + 0.37, 0.32);
        framed(0, eaves + 0.13, 0.16, 0.13, 0.565, upperGlass);
        // A small window in each end gable, under the peak.
        for (const x of [-0.785, 0.785]) {
          add(box(0.015, 0.14, 0.14), timber, x, eaves + 0.15, 0);
          add(box(0.012, 0.1, 0.1), upperGlass, x + Math.sign(x) * 0.006, eaves + 0.15, 0).userData.glow = true;
        }

        // The chimney stands proud of the roof, with a pot on top; its smoke is drawn by the ambience.
        add(box(0.22, 0.92, 0.22), lambert("#8b8f96"), 0.52, 1.36, -0.24);
        add(box(0.28, 0.06, 0.28), lambert("#6f737a"), 0.52, 1.83, -0.24);
        add(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 6), lambert("#b8643a"), 0.52, 1.9, -0.24);
        g.userData.smoke = new THREE.Vector3(0.52, 1.96, -0.24);

        // The sign: an iron bracket off the front corner, under the eaves, and a painted board hanging from it, face on to the street.
        const iron = lambert("#2b2a33");
        add(box(0.32, 0.03, 0.03), iron, 0.94, 0.6, 0.47);
        add(box(0.2, 0.025, 0.025), iron, 0.85, 0.54, 0.47).rotation.z = 0.6;
        for (const x of [0.84, 1.04]) add(box(0.012, 0.05, 0.012), iron, x, 0.565, 0.47);
        add(box(0.32, 0.28, 0.025), lambert("#3a2c22"), 0.94, 0.4, 0.47);
        const face = new THREE.MeshLambertMaterial({ map: pubSign() });
        add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.484);
        add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.456, Math.PI);

        // A lantern on a bracket by the door, lit at dusk.
        add(box(0.03, 0.03, 0.14), iron, -0.66, 0.5, 0.53);
        add(box(0.08, 0.02, 0.08), iron, -0.66, 0.485, 0.6);
        const flame = add(box(0.05, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.66, 0.44, 0.6);
        flame.userData.glow = true;
        for (const [dx, dz] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) add(box(0.012, 0.09, 0.012), iron, -0.66 + dx, 0.44, 0.6 + dz);
        add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, -0.66, 0.51, 0.6, Math.PI / 4);
        glows.push({ pos: new THREE.Vector3(-0.66, 0.44, 0.72), size: 0.42, light: "candle" });
        // The lamplight spilling out of the front, onto the street: held high and well out, so a hero at the door
        // is lit evenly rather than with a hot spot.
        glows.push({ pos: new THREE.Vector3(0, 1.1, 1.4), size: 0, light: "lamp" });

        // Barrels by the lantern, and a bench under the sign with a tankard left on it.
        for (const [x, z] of [[-0.62, 0.68], [-0.42, 0.74]]) {
          add(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8), lambert("#7a5230"), x, 0.11, z);
          for (const y of [0.05, 0.17]) add(new THREE.CylinderGeometry(0.104, 0.104, 0.02, 8), timber, x, y, z);
        }
        add(box(0.4, 0.035, 0.11), lambert("#8a6a44"), 0.52, 0.15, 0.62);
        for (const x of [0.36, 0.68]) add(box(0.04, 0.13, 0.08), timber, x, 0.065, 0.62);
        add(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 6), lambert("#d08a3a"), 0.6, 0.193, 0.62);
        add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 6), lambert("#f4efe1"), 0.6, 0.223, 0.62);
        g.userData.glows = glows;
        g.userData.panes = panes;
        foldByLook(g);
        break;
      }
      case "shoals": {
        // The Shoals table: a low square table under a sea-blue cloth, with a few markers on it and a stool either side.
        add(box(0.7, 0.36, 0.7), lambert("#6b4a2b"), 0, 0.18, -0.3, Math.PI / 4);
        add(box(0.82, 0.05, 0.82), lambert("#2f6f8c"), 0, 0.385, -0.3, Math.PI / 4);
        for (const x of [-0.74, 0.74]) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, -0.15);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#7db6f2"), -0.16, 0.43, -0.28);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#d9b45a"), 0.14, 0.43, -0.4);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), lambert("#6b4a2b"), 0.04, 0.45, -0.16);
        break;
      }
      case "cave": {
        // The Haunted Caverns' mouth in the back wall: a heap of dark rock with a black arch in it, and a torch either side.
        const rock = lambert("#3d4048");
        const pale = lambert("#565a63");
        add(new THREE.DodecahedronGeometry(0.62, 0), rock, 0, 0.42, -0.25, 0.3);
        add(new THREE.ConeGeometry(0.42, 1.1, 5), pale, -0.55, 0.45, -0.15, 0.8);
        add(new THREE.ConeGeometry(0.36, 0.95, 5), rock, 0.55, 0.38, -0.2, 1.7);
        // The arch: a black opening at the foot of the rock.
        add(box(0.46, 0.5, 0.06), new THREE.MeshBasicMaterial({ color: "#050409" }), 0, 0.25, 0.32).userData.glow = true;
        add(new THREE.CylinderGeometry(0.23, 0.23, 0.06, 8, 1, false, 0, Math.PI), new THREE.MeshBasicMaterial({ color: "#050409" }), 0, 0.5, 0.32).rotation.set(Math.PI / 2, 0, Math.PI / 2);
        for (const x of [-0.34, 0.34]) {
          add(box(0.04, 0.42, 0.04), lambert("#5a3d22"), x, 0.21, 0.4);
          add(box(0.08, 0.1, 0.08), new THREE.MeshBasicMaterial({ color: "#ffb347" }), x, 0.46, 0.4).userData.glow = true;
        }
        break;
      }
      case "rocks": {
        // Black rocks standing out of the sea, wet and sharp.
        const rock = lambert("#3d4048");
        const pale = lambert("#565a63");
        add(new THREE.ConeGeometry(0.42, 0.9, 5), rock, -0.15, 0.3, 0.05, 0.4);
        add(new THREE.ConeGeometry(0.3, 0.6, 4), pale, 0.4, 0.18, -0.2, 1.1);
        add(new THREE.DodecahedronGeometry(0.26, 0), rock, 0.15, 0.02, 0.45, 0.7);
        add(new THREE.ConeGeometry(0.18, 0.4, 4), pale, -0.55, 0.08, -0.3, 2);
        break;
      }
      case "wreck": {
        // A ship that did not make the harbour: the hull broken-backed on the rocks, ribs showing, the mast gone over the side.
        const hull = lambert("#4a3526");
        const dark = lambert("#33241a");
        const stern = add(box(1.1, 0.5, 0.62), hull, -0.35, 0.16, 0.0);
        stern.rotation.set(0.1, 0.25, -0.32);
        const bow = add(box(0.9, 0.42, 0.56), hull, 0.75, 0.02, 0.22);
        bow.rotation.set(-0.12, -0.3, 0.38);
        const deck = add(box(1.0, 0.05, 0.5), lambert("#6b5138"), -0.36, 0.44, 0.0);
        deck.rotation.copy(stern.rotation);
        for (let i = 0; i < 4; i++) add(box(0.05, 0.42, 0.05), dark, 0.18 + i * 0.13, 0.18 + i * 0.02, -0.26 + (i % 2) * 0.5).rotation.z = 0.2 + i * 0.12;
        const mast = add(new THREE.CylinderGeometry(0.045, 0.06, 1.7, 5), dark, -0.5, 0.75, 0.05);
        mast.rotation.z = -0.95;
        const yard = add(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4), dark, -1.0, 1.02, 0.05);
        yard.rotation.x = Math.PI / 2;
        const rag = add(box(0.03, 0.4, 0.55), lambert("#b9b3a3"), -1.0, 0.82, 0.05);
        rag.rotation.z = 0.25;
        add(new THREE.ConeGeometry(0.34, 0.7, 5), lambert("#3d4048"), 0.25, 0.18, -0.55, 0.6);
        add(new THREE.DodecahedronGeometry(0.24, 0), lambert("#565a63"), -0.9, 0.0, 0.5, 0.3);
        break;
      }
      case "trader": {
        // Where a customer stands to trade with a traveling salesman: a mat of wares laid out toward the corner.
        add(box(0.34, 0.03, 0.62), lambert("#7a3a5a"), 0.52, 0.015, 0);
        add(box(0.34, 0.01, 0.06), lambert("#e0b12e"), 0.52, 0.035, 0.26);
        add(box(0.1, 0.1, 0.1), lambert("#b98b5a"), 0.48, 0.08, -0.16, 0.5);
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), lambert("#3f7fb8"), 0.58, 0.1, 0.08);
        add(box(0.12, 0.03, 0.08), lambert("#e8dcc0"), 0.46, 0.05, 0.14, 0.3);
        break;
      }
      case "counter": {
        // The menu board, on a post where customers stand to order.
        add(box(0.05, 0.7, 0.05), lambert("#5a3d22"), 0.55, 0.35, -0.1);
        add(box(0.5, 0.36, 0.04), lambert("#2c2a3a"), 0.55, 0.78, -0.1);
        for (let i = 0; i < 4; i++) add(box(0.34, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: "#e8dcc0" }), 0.55, 0.9 - i * 0.08, -0.075);
        break;
      }
      case "shop": {
        // Market stall: a counter under a striped awning.
        add(box(0.9, 0.3, 0.45), lambert("#8a6a44"), 0, 0.15, 0);
        for (const x of [-0.42, 0.42]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 5), lambert("#5a3d22"), x, 0.47, 0.2);
        for (let i = 0; i < 4; i++) add(box(0.26, 0.06, 0.62), lambert(i % 2 ? "#f4efe1" : "#b9433d"), -0.39 + i * 0.26, 0.97, 0.05);
        add(box(0.16, 0.14, 0.16), lambert("#e0b12e"), -0.22, 0.37, 0);
        add(box(0.14, 0.18, 0.14), lambert("#3b82f6"), 0.2, 0.39, 0);
        break;
      }
      case "ring": {
        // Sparring ring: four posts, a rope, and a straw dummy.
        for (const [x, z] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.6], [0.55, 0.6]]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 5), lambert("#5a3d22"), x, 0.27, z);
        add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, -0.2);
        add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, 0.6);
        add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), -0.55, 0.45, 0.2);
        add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), 0.55, 0.45, 0.2);
        add(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 6), lambert("#d9b45a"), 0.2, 0.3, 0.1);
        add(new THREE.SphereGeometry(0.13, 6, 5), lambert("#d9b45a"), 0.2, 0.66, 0.1);
        add(box(0.5, 0.06, 0.06), lambert("#7a5230"), 0.2, 0.45, 0.1);
        break;
      }
      case "fishing": {
        // A plank out over the water, a rod propped on it with its line in the sea, and a bucket.
        add(box(0.5, 0.06, 1.0), lambert("#8a6a44"), 0, 0.03, 0.75);
        for (const x of [-0.2, 0.2]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 5), lambert("#5a3d22"), x, -0.2, 1.15);
        add(new THREE.CylinderGeometry(0.02, 0.03, 1.2, 5), lambert("#c9a877"), 0.1, 0.5, 1.3).rotation.x = Math.PI / 4;
        add(box(0.015, 0.95, 0.015), lambert("#f4efe1"), 0.1, 0.44, 1.72);
        add(new THREE.OctahedronGeometry(0.06), lambert("#b9433d"), 0.1, -0.02, 1.72);
        add(new THREE.CylinderGeometry(0.11, 0.09, 0.18, 6), lambert("#6f7f95"), -0.12, 0.15, 0.6);
        break;
      }
      case "felling": {
        // A stump with an axe in it, and a stack of cut logs.
        add(new THREE.CylinderGeometry(0.2, 0.24, 0.24, 7), lambert("#7a5230"), -0.3, 0.12, 0.35);
        add(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 7), lambert("#d9b45a"), -0.3, 0.25, 0.35);
        add(box(0.04, 0.42, 0.04), lambert("#5a3d22"), -0.3, 0.46, 0.35).rotation.z = -0.5;
        add(box(0.16, 0.12, 0.03), lambert("#c9d1dc"), -0.36, 0.33, 0.35).rotation.z = -0.5;
        for (const [x, y] of [[0.2, 0.08], [0.38, 0.08], [0.56, 0.08], [0.29, 0.23], [0.47, 0.23]]) {
          add(new THREE.CylinderGeometry(0.085, 0.085, 0.6, 6), lambert("#8a5a2b"), x, y, 0.4).rotation.x = Math.PI / 2;
          add(new THREE.CylinderGeometry(0.06, 0.06, 0.61, 6), lambert("#d9b45a"), x, y, 0.4).rotation.x = Math.PI / 2;
        }
        break;
      }
      case "quarry": {
        // A cut rock face with squared blocks at its foot and a pick leaning on them.
        add(box(0.95, 0.6, 0.3), lambert("#8b95a5"), 0, 0.3, -0.05);
        add(box(0.5, 0.3, 0.28), lambert("#7b8494"), -0.2, 0.75, -0.05);
        add(box(0.14, 0.1, 0.02), lambert("#c8743a"), 0.25, 0.4, 0.11);
        add(box(0.1, 0.08, 0.02), lambert("#c9d1dc"), -0.25, 0.3, 0.11);
        add(box(0.28, 0.2, 0.24), lambert("#a3acba"), -0.3, 0.1, 0.45);
        add(box(0.22, 0.16, 0.2), lambert("#959eac"), 0.0, 0.08, 0.55);
        add(box(0.04, 0.5, 0.04), lambert("#5a3d22"), 0.35, 0.25, 0.4).rotation.z = 0.35;
        add(box(0.34, 0.05, 0.05), lambert("#4a4f5a"), 0.27, 0.49, 0.4).rotation.z = 0.35;
        break;
      }
      case "dice": {
        // Dice table: a round top on a barrel, a stool either side, and a pair of dice. Set back so whoever stands here is seen to sit at it.
        add(new THREE.CylinderGeometry(0.18, 0.22, 0.4, 7), lambert("#6b4a2b"), 0, 0.2, -0.3);
        add(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 8), lambert("#a07a4c"), 0, 0.43, -0.3);
        for (const x of [-0.72, 0.72]) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, -0.15);
        add(box(0.13, 0.13, 0.13), lambert("#f4efe1"), -0.12, 0.53, -0.25, 0.4);
        add(box(0.13, 0.13, 0.13), lambert("#b9433d"), 0.14, 0.53, -0.38, 1.1);
        break;
      }
      case "works": {
        // The works: the builders' yard where the crew's projects are paid for. Kept low, as it stands in the plaza:
        // a trestle table with the plans weighted down on it, a slate of pledges, and timber and stone waiting to go.
        const wood = lambert("#7a5230");
        for (const x of [-0.32, 0.32]) {
          for (const z of [-0.14, 0.14]) add(box(0.05, 0.36, 0.05), wood, x, 0.18, z - 0.12).rotation.z = x < 0 ? 0.12 : -0.12;
        }
        add(box(0.84, 0.05, 0.44), lambert("#a07a4c"), 0, 0.38, -0.12);
        // The plans: a sheet of blue paper with white lines, a rolled plan, and a stone on the corner.
        add(box(0.42, 0.012, 0.3), lambert("#3f6fa8"), -0.08, 0.41, -0.1, 0.12);
        for (const dz of [-0.06, 0.0, 0.06]) add(box(0.3, 0.014, 0.012), lambert("#dce8f5"), -0.08, 0.416, -0.1 + dz, 0.12);
        add(box(0.06, 0.014, 0.2), lambert("#dce8f5"), -0.02, 0.416, -0.1, 0.12);
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.36, 6), lambert("#e8dcc0"), 0.28, 0.44, -0.16).rotation.x = Math.PI / 2;
        add(new THREE.DodecahedronGeometry(0.05), lambert("#8b95a5"), -0.26, 0.44, -0.2);
        // A slate on an easel, chalked with the tally.
        add(box(0.04, 0.6, 0.04), wood, 0.58, 0.3, -0.28).rotation.z = 0.15;
        add(box(0.3, 0.24, 0.03), lambert("#2e3138"), 0.54, 0.44, -0.24, -0.3);
        for (const dy of [-0.05, 0.0, 0.05]) add(box(0.18, 0.015, 0.032), lambert("#e8e4da"), 0.54, 0.44 + dy, -0.236, -0.3);
        // Squared stone and planks, stacked by the table.
        for (const [x, z] of [[-0.6, 0.3], [-0.42, 0.42], [-0.58, 0.5]]) add(box(0.16, 0.14, 0.16), lambert("#a3acba"), x, 0.07, z, 0.3);
        for (let i = 0; i < 3; i++) add(box(0.5, 0.05, 0.12), lambert(i % 2 ? "#c9a877" : "#8a6a44"), 0.32, 0.03 + i * 0.05, 0.38, 0.2 + 0.08 * i);
        break;
      }
      case "lighthouse": {
        // The lighthouse, on the rocks at the end of the east spit. Every stage stands on the same rocky base.
        const rock = lambert("#5d6270");
        const pale = lambert("#7b8291");
        add(new THREE.DodecahedronGeometry(0.42, 0), rock, -0.05, 0.02, 0.02, 0.3).scale.y = 0.55;
        add(new THREE.DodecahedronGeometry(0.3, 0), pale, 0.36, 0.0, 0.22, 1.2).scale.y = 0.6;
        add(new THREE.DodecahedronGeometry(0.26, 0), rock, -0.42, -0.02, 0.3, 0.8).scale.y = 0.5;
        add(new THREE.DodecahedronGeometry(0.2, 0), pale, 0.3, 0.0, -0.36, 2.1).scale.y = 0.6;
        const base = 0.2;
        const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
        const white = lambert("#f1ece0");
        const red = lambert("#b9433d");
        /** One band of the striped tower: radius at the bottom and top, height, and the course it starts on. */
        const course = (r0: number, r1: number, h: number, y: number, m: THREE.Material) => add(new THREE.CylinderGeometry(r1, r0, h, 8), m, 0, y + h / 2, 0);
        // The tower in four bands, tapering, alternately white and red.
        const BANDS = [0.34, 0.31, 0.28, 0.25, 0.22];
        const BAND_H = 0.36;
        const scaffold = (height: number) => {
          const pole = lambert("#7a5230");
          const plank = lambert("#8a6a44");
          for (const [x, z] of [[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36]]) add(new THREE.CylinderGeometry(0.03, 0.03, height, 5), pole, x, base + height / 2, z);
          for (let y = base + 0.35; y < base + height - 0.05; y += 0.4) {
            add(box(0.88, 0.035, 0.05), plank, 0, y, -0.36);
            add(box(0.88, 0.035, 0.05), plank, 0, y, 0.36);
            add(box(0.05, 0.035, 0.76), plank, 0.42, y, 0);
          }
        };
        if (poi.cleared) {
          // Built: a striped stone tower on a plinth, a door and two small windows, a gallery with its rail,
          // the lantern room of glass, and a red cap with a vane. The ambience turns the beam and lights the glow.
          add(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), lambert("#9a958a"), 0, base + 0.07, 0);
          let y = base + 0.14;
          for (let i = 0; i < 4; i++) {
            course(BANDS[i], BANDS[i + 1], BAND_H, y, i % 2 ? red : white);
            y += BAND_H;
          }
          add(box(0.14, 0.24, 0.04), lambert("#4a3a2a"), 0, base + 0.26, 0.37);
          add(box(0.18, 0.04, 0.05), lambert("#9a958a"), 0, base + 0.4, 0.37);
          for (const [wy, wr] of [[base + 0.75, 0.31], [base + 1.2, 0.27]]) add(box(0.07, 0.1, 0.03), lambert("#2b2f3d"), 0, wy, wr);
          // The gallery: a broad slab, eight posts and a rail round it.
          const gy = y;
          add(new THREE.CylinderGeometry(0.33, 0.27, 0.07, 8), lambert("#4a4458"), 0, gy + 0.035, 0);
          const iron = lambert("#2b2a33");
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            add(box(0.02, 0.14, 0.02), iron, Math.cos(a) * 0.3, gy + 0.14, Math.sin(a) * 0.3);
          }
          add(new THREE.CylinderGeometry(0.31, 0.31, 0.025, 8, 1, true), new THREE.MeshLambertMaterial({ color: "#2b2a33", flatShading: true, side: THREE.DoubleSide }), 0, gy + 0.21, 0);
          // The lantern room: a warm core behind glass, with dark glazing bars.
          const ly = gy + 0.07;
          const core = add(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 6), new THREE.MeshBasicMaterial({ color: "#ffe9a8" }), 0, ly + 0.13, 0);
          core.userData.glow = true;
          const glass = add(new THREE.CylinderGeometry(0.17, 0.17, 0.26, 8), new THREE.MeshBasicMaterial({ color: "#ffd77a", transparent: true, opacity: 0.45, depthWrite: false }), 0, ly + 0.13, 0);
          glass.userData.glow = true;
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            add(box(0.025, 0.26, 0.025), iron, Math.cos(a) * 0.17, ly + 0.13, Math.sin(a) * 0.17);
          }
          // The cap: a dark red dome-ish cone, a ball and a little vane.
          add(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8), iron, 0, ly + 0.275, 0);
          add(new THREE.ConeGeometry(0.21, 0.2, 8), lambert("#8c3b2f"), 0, ly + 0.39, 0);
          add(new THREE.SphereGeometry(0.035, 6, 4), iron, 0, ly + 0.5, 0);
          add(box(0.012, 0.1, 0.012), iron, 0, ly + 0.56, 0);
          add(box(0.08, 0.03, 0.008), iron, 0.03, ly + 0.59, 0);
          // Where the beam turns from: the middle of the lantern.
          g.userData.beacon = new THREE.Vector3(0, ly + 0.13, 0);
        } else if (fill >= 0.5) {
          // More than half paid for: the lower half of the tower is up, inside its scaffold, with a hoist and a bucket of mortar.
          add(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), lambert("#9a958a"), 0, base + 0.07, 0);
          course(BANDS[0], BANDS[1], BAND_H, base + 0.14, white);
          course(BANDS[1], BANDS[2], BAND_H * 0.6, base + 0.14 + BAND_H, lambert("#c9c3b5"));
          scaffold(1.1);
          add(box(0.04, 0.04, 0.5), lambert("#7a5230"), 0.42, base + 1.12, 0.12);
          add(box(0.008, 0.5, 0.008), lambert("#d9c9a0"), 0.42, base + 0.86, 0.34);
          add(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 6), lambert("#5a3d22"), 0.42, base + 0.6, 0.34);
          for (const [x, z] of [[-0.5, 0.42], [-0.34, 0.5]]) add(box(0.14, 0.12, 0.14), lambert("#a3acba"), x, base + 0.06, z, 0.4);
        } else if (fill > 0) {
          // Begun: the plinth and the first course, the scaffold's corner poles, and stone stacked ready.
          add(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), lambert("#9a958a"), 0, base + 0.07, 0);
          course(BANDS[0], 0.33, 0.12, base + 0.14, lambert("#c9c3b5"));
          scaffold(0.7);
          for (const [x, z] of [[-0.5, 0.42], [-0.34, 0.5], [-0.46, 0.56]]) add(box(0.14, 0.12, 0.14), lambert("#a3acba"), x, base + 0.06, z, 0.4);
          for (let i = 0; i < 3; i++) add(box(0.46, 0.04, 0.1), lambert(i % 2 ? "#c9a877" : "#8a6a44"), 0.36, base + 0.02 + i * 0.04, 0.48, 0.5 + 0.1 * i);
        } else {
          // Not begun: the point is only surveyed. A ring of stakes marks where the tower will stand, with a flag on one.
          const stake = lambert("#a07a4c");
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            add(box(0.035, 0.22, 0.035), stake, Math.cos(a) * 0.34, base + 0.08, Math.sin(a) * 0.34);
          }
          add(box(0.025, 0.5, 0.025), stake, 0.34, base + 0.22, 0);
          add(box(0.012, 0.12, 0.16), lambert("#b9433d"), 0.34, base + 0.4, 0.08);
        }
        break;
      }
      case "apothecary":
      case "smithy":
      case "galley": {
        if (!poi.cleared) {
          // Still a crew project: a fenced building site with the materials stacked inside it.
          const post = lambert("#7a5230");
          const rail = lambert("#a07a4c");
          for (const [x, z] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.55], [0.55, 0.55], [0, -0.3]]) add(box(0.06, 0.4, 0.06), post, x, 0.2, z);
          for (const y of [0.16, 0.32]) {
            add(box(1.1, 0.04, 0.03), rail, 0, y, -0.3);
            add(box(0.03, 0.04, 0.85), rail, -0.55, y, 0.125);
            add(box(0.03, 0.04, 0.85), rail, 0.55, y, 0.125);
          }
          // The front is left open, with a little board saying what is coming.
          add(box(0.04, 0.5, 0.04), post, 0.4, 0.25, 0.62);
          add(box(0.3, 0.18, 0.03), lambert(poi.kind === "apothecary" ? "#4f8a4a" : poi.kind === "galley" ? "#a0522d" : "#4a4f5a"), 0.4, 0.46, 0.64);
          // A pile of planks, squared stones, and the trade's own makings: sacks of herbs, or iron bars.
          for (let i = 0; i < 3; i++) add(box(0.5, 0.05, 0.12), lambert(i % 2 ? "#c9a877" : "#8a6a44"), -0.2, 0.03 + i * 0.05, -0.05 + i * 0.02, 0.15 * i);
          for (const [x, y, z] of [[0.25, 0.08, -0.05], [0.38, 0.08, 0.1], [0.3, 0.22, 0.02]]) add(box(0.16, 0.14, 0.16), lambert("#959eac"), x, y, z, 0.3);
          if (poi.kind === "galley") {
            // Bundles of furs and a heap of bones, waiting to be built into a cookhouse.
            for (const [x, z, c] of [[-0.28, 0.3, "#7a5a3a"], [-0.05, 0.36, "#9a7a55"]] as [number, number, string][]) add(box(0.22, 0.12, 0.16), lambert(c), x, 0.06, z, 0.3);
            for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 4), lambert("#ece4cf"), 0.15 + (i % 2) * 0.06, 0.04 + Math.floor(i / 2) * 0.04, 0.35).rotation.z = Math.PI / 2 + i * 0.5;
          } else if (poi.kind === "apothecary") {
            for (const [x, z] of [[-0.25, 0.3], [0.05, 0.35]]) add(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 6), lambert("#c9b37a"), x, 0.11, z);
            for (const [x, z] of [[-0.25, 0.3], [0.05, 0.35]]) add(new THREE.SphereGeometry(0.09, 5, 4), lambert("#5f9e4a"), x, 0.25, z);
          } else {
            for (let i = 0; i < 4; i++) add(box(0.32, 0.05, 0.07), lambert(i < 2 ? "#6f737a" : "#c8743a"), -0.1 + (i % 2) * 0.08, 0.03 + Math.floor(i / 2) * 0.05, 0.32, 0.2);
          }
          break;
        }
        if (poi.kind === "galley") {
          // The galley: a low timber cookhouse under a russet roof, a broad stone chimney smoking at one end,
          // a cauldron on a fire by the door, barrels of provisions, and fish hung to dry under the eaves.
          add(box(1.0, 0.56, 0.66), lambert("#8a6a44"), 0, 0.28, -0.04);
          for (const x of [-0.48, 0.48]) add(box(0.06, 0.58, 0.7), lambert("#5a3d22"), x, 0.29, -0.04);
          add(box(1.08, 0.05, 0.74), lambert("#4a3a2a"), 0, 0.58, -0.04);
          const roof = add(new THREE.ConeGeometry(0.7, 0.42, 4), lambert("#a0522d"), 0, 0.8, -0.04, Math.PI / 4);
          roof.scale.z = 0.75;
          add(box(0.22, 0.34, 0.04), lambert("#3a2c22"), 0.12, 0.17, 0.3);
          // The window warms at dusk, with a soft glow over it.
          const glass = warmPane("#c99a52", "#ffd08a");
          add(box(0.2, 0.14, 0.03), glass, -0.24, 0.36, 0.3).userData.glow = true;
          g.userData.panes = [glass];
          // The chimney: broad and stone, up the west end. The ambience draws its smoke.
          add(box(0.26, 1.15, 0.26), lambert("#8b95a5"), -0.38, 0.58, -0.22);
          add(box(0.32, 0.06, 0.32), lambert("#6f7f95"), -0.38, 1.17, -0.22);
          g.userData.smoke = new THREE.Vector3(-0.38, 1.24, -0.22);
          // A cauldron over a small fire by the door.
          add(new THREE.ConeGeometry(0.1, 0.12, 5), new THREE.MeshBasicMaterial({ color: "#ff9a3c" }), 0.5, 0.06, 0.42);
          add(new THREE.SphereGeometry(0.14, 7, 5), lambert("#2e2a2a"), 0.5, 0.2, 0.42);
          add(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 7), lambert("#d9b45a"), 0.5, 0.3, 0.42);
          // After dark the fire glows and throws flickering firelight over the quay; the window glows too.
          g.userData.glows = [
            { pos: new THREE.Vector3(-0.24, 0.36, 0.48), size: 0.44 },
            { pos: new THREE.Vector3(0.5, 0.12, 0.6), size: 0.36, light: "fire" },
          ] satisfies BuildingGlow[];
          // Barrels of provisions, ready to go aboard.
          for (const [x, z] of [[-0.62, 0.3], [-0.5, 0.48]]) add(new THREE.CylinderGeometry(0.1, 0.1, 0.24, 7), lambert("#7a5230"), x, 0.12, z);
          // Fish hung to dry from the eaves.
          for (const x of [-0.05, 0.3, 0.42]) {
            add(box(0.012, 0.08, 0.012), lambert("#5a3d22"), x, 0.52, 0.36);
            add(new THREE.ConeGeometry(0.035, 0.14, 4), lambert("#9fb3c2"), x, 0.42, 0.36).rotation.x = Math.PI;
          }
          break;
        }
        if (poi.kind === "apothecary") {
          // The apothecary: a narrow plastered shop under a dark green roof, a green sign, and bunches of herbs hung from the eaves.
          const wall = lambert("#d9ccb0");
          add(box(0.9, 0.62, 0.7), wall, 0, 0.31, 0);
          add(box(0.98, 0.06, 0.78), lambert("#4a3a2a"), 0, 0.64, 0);
          const roof = add(new THREE.ConeGeometry(0.62, 0.5, 4), lambert("#2f5a3a"), 0, 0.92, 0, Math.PI / 4);
          roof.scale.z = 0.85;
          add(box(0.2, 0.34, 0.04), lambert("#3e5a3a"), -0.18, 0.17, 0.36);
          add(box(0.24, 0.2, 0.03), new THREE.MeshBasicMaterial({ color: "#ffe2a0" }), 0.2, 0.38, 0.36);
          // A swinging green sign on a bracket, with a pale leaf on it.
          add(box(0.04, 0.04, 0.32), lambert("#3a2c22"), 0.42, 0.58, 0.5);
          add(box(0.03, 0.22, 0.26), lambert("#3f8a46"), 0.42, 0.44, 0.58);
          add(box(0.035, 0.1, 0.06), lambert("#cfe8a0"), 0.42, 0.45, 0.58);
          // Bunches of herbs drying under the eaves: stems up, leaves hanging.
          for (const [x, c] of [[-0.36, "#6aa34f"], [-0.12, "#8fb84f"], [0.08, "#5f8f3f"]] as [number, string][]) {
            add(box(0.015, 0.1, 0.015), lambert("#5a3d22"), x, 0.57, 0.42);
            add(new THREE.ConeGeometry(0.06, 0.16, 5), lambert(c), x, 0.46, 0.42, 0).rotation.x = Math.PI;
          }
          // A little copper still by the door, for show.
          add(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 7), lambert("#c8743a"), -0.58, 0.1, 0.3);
          add(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 4), lambert("#c8743a"), -0.58, 0.28, 0.3);
          break;
        }
        // The smithy: an open-fronted shed with a stone forge glowing at the back, a chimney, and an anvil on a block out front.
        const timber = lambert("#5a3d22");
        for (const [x, z] of [[-0.5, -0.32], [0.5, -0.32], [-0.5, 0.32], [0.5, 0.32]]) add(box(0.08, 0.7, 0.08), timber, x, 0.35, z);
        add(box(1.0, 0.5, 0.05), lambert("#8a6a44"), 0, 0.25, -0.34);
        const roof = add(box(1.18, 0.07, 0.86), lambert("#4a4f5a"), 0, 0.74, 0);
        roof.rotation.x = -0.18;
        // The forge: a stone hearth with coals in it, and their glow.
        add(box(0.46, 0.3, 0.34), lambert("#7b8494"), -0.2, 0.15, -0.14);
        add(box(0.3, 0.05, 0.2), new THREE.MeshBasicMaterial({ color: "#ff7a2a" }), -0.2, 0.31, -0.12);
        add(new THREE.ConeGeometry(0.08, 0.16, 5), new THREE.MeshBasicMaterial({ color: "#ffc04a" }), -0.2, 0.39, -0.12);
        const glow = add(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshBasicMaterial({ color: "#ff8a3a", transparent: true, opacity: 0.22, depthWrite: false }), -0.2, 0.36, -0.1);
        glow.userData.glow = true;
        // After dark the coals glow out of the open front and their firelight fills the shed.
        g.userData.glows = [{ pos: new THREE.Vector3(-0.2, 0.42, 0.14), size: 0.62, light: "fire" }] satisfies BuildingGlow[];
        // The chimney rises from the back of the forge; the ambience draws its smoke.
        add(box(0.2, 1.05, 0.2), lambert("#6f737a"), -0.2, 0.75, -0.26);
        add(box(0.26, 0.06, 0.26), lambert("#5d6168"), -0.2, 1.28, -0.26);
        g.userData.smoke = new THREE.Vector3(-0.2, 1.35, -0.26);
        // The anvil on its block, a hammer on top, and a water trough.
        add(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 7), lambert("#6b4a2b"), 0.25, 0.11, 0.2);
        add(box(0.3, 0.08, 0.12), lambert("#3a3d44"), 0.25, 0.26, 0.2);
        add(box(0.16, 0.06, 0.08), lambert("#3a3d44"), 0.25, 0.32, 0.2);
        add(new THREE.ConeGeometry(0.05, 0.12, 4), lambert("#3a3d44"), 0.45, 0.31, 0.2).rotation.z = Math.PI / 2;
        add(box(0.03, 0.03, 0.2), lambert("#7a5230"), 0.22, 0.37, 0.22, 0.4);
        add(box(0.3, 0.12, 0.16), lambert("#6b4a2b"), 0.62, 0.06, -0.05);
        add(box(0.26, 0.02, 0.12), lambert("#3f7fb8"), 0.62, 0.12, -0.05);
        break;
      }
      case "door":
        // A doormat in the gap, and a post either side of it.
        add(box(0.9, 0.04, 0.5), lambert("#8c3b2f"), 0, 0.02, 0.28);
        for (const x of [-0.8, 0.8]) add(box(0.14, 0.9, 0.14), lambert("#5a3d22"), x, 0.45, 0.28);
        break;
      case "board":
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 5), lambert("#5a3d22"), -0.3, 0.45, 0);
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 5), lambert("#5a3d22"), 0.3, 0.45, 0);
        add(box(0.8, 0.5, 0.06), lambert("#e8dcc0"), 0, 0.7, 0);
        break;
      case "camp":
        if (this.state?.kind === "caverns") {
          // What lurks in a cave chamber: a heap of old bones and rubble, and (until it is beaten) eyes in the dark.
          const lead = poi.enemies[0];
          for (const [x, z, s] of [[-0.25, 0.05, 0.3], [0.2, 0.15, 0.24], [0.02, -0.12, 0.2]]) add(new THREE.DodecahedronGeometry(s, 0), lambert("#3a3640"), x, s * 0.6, z, x * 5);
          for (const [x, z, r] of [[-0.05, 0.38, 0.4], [0.28, 0.42, -0.7], [-0.32, 0.4, 1.2]]) add(box(0.3, 0.04, 0.05), lambert("#d6cfbd"), x, 0.03, z, r);
          if (lead === "slime" && !poi.cleared) add(new THREE.SphereGeometry(0.26, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), lambert("#5fbf4a"), 0.05, 0.02, 0.3);
          if (lead === "bat" && !poi.cleared) for (const x of [-0.2, 0.2]) add(new THREE.ConeGeometry(0.12, 0.28, 3), lambert("#2a2430"), x, 0.95, -0.1, Math.PI);
          if (!poi.cleared) {
            const eye = new THREE.MeshBasicMaterial({ color: { bat: "#ff4d3a", skeleton: "#9fd8ff", slime: "#b8ff6a", shade: "#c79bff" }[lead] ?? "#ff4d3a" });
            for (const x of [-0.07, 0.07]) add(box(0.05, 0.04, 0.02), eye, x, lead === "bat" ? 0.82 : 0.42, 0.12).userData.glow = true;
          }
          break;
        }
        add(new THREE.ConeGeometry(0.48, 0.6, 4), lambert(poi.cleared ? "#777777" : "#b9433d"), -0.2, 0.3, 0, Math.PI / 4);
        if (!poi.cleared) add(new THREE.ConeGeometry(0.1, 0.22, 4), new THREE.MeshBasicMaterial({ color: "#ff9a3c" }), 0.4, 0.11, 0.25);
        break;
    }
    return g;
  }

  // ---------- units ----------

  /**
   * Make the battleground look like where the fight is: the colour of that
   * hex's ground, with a scatter of what grows or lies there, kept to the back
   * and the sides so the two lines of fighters stand in the clear. A fight at
   * a camp or a lair gets that place's own dressing.
   */
  private dressArena(state: RenderState) {
    const battle = state.battle!;
    const poi = state.map.pois.find((p) => p.id === (battle.poiId ?? state.story?.npcs.find((n) => n.id === battle.npcId)?.poi));
    const at = poi?.pos ?? state.heroes[0].pos;
    const found = tileAt(state.map, at)?.biome ?? "plains";
    const biome = found === "fog" || found === "water" ? "plains" : found;
    const sig = `${state.code}|${at.q},${at.r}|${biome}|${poi?.kind ?? ""}`;
    if (sig === this.arenaSig) return;
    this.arenaSig = sig;
    this.arenaDecor.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.arenaDecor.clear();
    (this.arenaGround.material as THREE.MeshLambertMaterial).color.set(BIOME_COLOR[biome] ?? BIOME_COLOR.plains);
    if (this.sodden && (biome === "plains" || biome === "forest")) (this.arenaGround.material as THREE.MeshLambertMaterial).color.lerp(DRAB, 0.5);

    const TOP = 0.8;
    const rnd = (i: number, salt: number) => noise(at.q * 3 + i, at.r * 5 - i, 40 + salt);
    const put = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rotY = 0, scale = 1) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }));
      mesh.position.set(x, TOP + y, z);
      mesh.rotation.y = rotY;
      mesh.scale.setScalar(scale);
      mesh.castShadow = mesh.receiveShadow = true;
      this.arenaDecor.add(mesh);
      return mesh;
    };
    /** A spot off the fighting line: along the back, or out at either side. Kept inside the hex. */
    const spot = (i: number): [number, number] => {
      if (i % 3 === 2) {
        const side = i % 2 ? 1 : -1;
        return [side * (2.9 + rnd(i, 1) * 0.5), -0.6 + rnd(i, 2) * 2.2];
      }
      return [(rnd(i, 3) - 0.5) * 5.2, -3.1 + rnd(i, 4) * 1.5];
    };
    const tree = (x: number, z: number, s: number, dark = false) => {
      put(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 5), "#5a3d22", x, 0.15 * s, z, 0, s);
      put(new THREE.ConeGeometry(0.42, 1.1, 5), dark ? "#2a5f38" : "#2f7a3d", x, 0.8 * s, z, rnd(x * 7, 5) * 3, s);
    };
    const rock = (x: number, z: number, s: number, tone = "#8d8674") => put(new THREE.DodecahedronGeometry(0.36, 0), tone, x, 0.2 * s, z, rnd(x * 5, 6) * 6, s);
    const tuft = (x: number, z: number, s: number) => {
      for (const [dx, lean] of [[-0.08, -0.25], [0, 0], [0.08, 0.25]]) put(new THREE.ConeGeometry(0.05, 0.34, 3), "#a6dd6f", x + dx, 0.17 * s, z, 0, s).rotation.z = -lean;
    };

    if (state.kind === "caverns") {
      // Under the rocks: stalagmites crowding the back and sides, rubble, and the bones of whoever came down before.
      for (let i = 0; i < 9; i++) {
        const [x, z] = spot(i);
        const h = 0.9 + rnd(i, 30) * 1.6;
        put(new THREE.ConeGeometry(0.22 + rnd(i, 31) * 0.2, h, 5), i % 2 ? "#3d3946" : "#4a4552", x, h / 2, z, rnd(i, 32) * 3);
      }
      for (let i = 0; i < 5; i++) rock(spot(i + 10)[0], spot(i + 10)[1], 0.4 + rnd(i, 33) * 0.5, "#35323c");
      for (let i = 0; i < 5; i++) put(new THREE.BoxGeometry(0.4, 0.05, 0.06), "#d6cfbd", (rnd(i, 34) - 0.5) * 5, 0.03, -2.4 + rnd(i, 35) * 1.2, rnd(i, 36) * 3);
      put(new THREE.DodecahedronGeometry(0.16, 0), "#e8e2d2", -2.6, 0.14, -2.0);
    } else if (poi?.kind === "camp") {
      // A raiders' camp: two tents, a fire ringed with stones, crates.
      for (const [x, z, r] of [[-2.0, -2.6, 0.3], [1.7, -2.9, -0.4]]) put(new THREE.ConeGeometry(0.85, 1.1, 4), "#8a7a5a", x, 0.55, z, Math.PI / 4 + r);
      put(new THREE.ConeGeometry(0.22, 0.5, 5), "#ff9b3d", 0, 0.25, -2.4);
      for (let i = 0; i < 6; i++) put(new THREE.DodecahedronGeometry(0.11, 0), "#6d6960", Math.sin(i) * 0.42, 0.06, -2.4 + Math.cos(i) * 0.42);
      put(new THREE.BoxGeometry(0.5, 0.42, 0.5), "#9a6b2f", 3.0, 0.21, -0.9, 0.4);
      put(new THREE.BoxGeometry(0.36, 0.3, 0.36), "#8a6a44", -3.1, 0.15, 0.2, 0.9);
    }
    if (poi?.kind === "lair") {
      // The lair: leaning standing stones and old bones.
      for (let i = 0; i < 6; i++) {
        const a = Math.PI + ((i - 2.5) / 6) * Math.PI * 1.1;
        const stone = put(new THREE.BoxGeometry(0.5, 1.5 + rnd(i, 7) * 0.9, 0.36), "#4a4458", Math.sin(a) * 3.3, 0.8, Math.cos(a) * 3.0 - 0.3, a);
        stone.rotation.z = (rnd(i, 8) - 0.5) * 0.35;
      }
      for (let i = 0; i < 4; i++) put(new THREE.BoxGeometry(0.4, 0.05, 0.06), "#d8d2c0", (rnd(i, 9) - 0.5) * 4.6, 0.03, -2.2 - rnd(i, 10), rnd(i, 11) * 3);
    }

    if (biome === "forest") {
      for (let i = 0; i < 9; i++) {
        const [x, z] = spot(i);
        tree(x, z, 0.9 + rnd(i, 12) * 0.8, i % 2 === 0);
      }
      const log = put(new THREE.CylinderGeometry(0.16, 0.16, 1.3, 6), "#6b4a2b", -2.6, 0.16, 1.7, 0.5);
      log.rotation.z = Math.PI / 2;
      for (let i = 0; i < 5; i++) tuft((rnd(i, 13) - 0.5) * 6, 1.8 + rnd(i, 14) * 1.2, 1);
    } else if (biome === "hills") {
      for (let i = 0; i < 8; i++) {
        const [x, z] = spot(i);
        rock(x, z, 0.8 + rnd(i, 15) * 1.3, ["#8d8674", "#7b786f", "#9c917b"][i % 3]);
      }
      put(new THREE.ConeGeometry(0.5, 1.6, 4), "#7b786f", -3.2, 0.8, -2.2, 0.6);
      for (let i = 0; i < 5; i++) rock((rnd(i, 16) - 0.5) * 6.4, 2.0 + rnd(i, 17), 0.35, "#a39a86");
    } else if (biome === "plains") {
      for (let i = 0; i < 18; i++) {
        const [x, z] = i < 12 ? spot(i) : [(rnd(i, 18) - 0.5) * 6.6, 1.7 + rnd(i, 19) * 1.5];
        tuft(x, z, 0.9 + rnd(i, 20) * 0.7);
      }
      for (let i = 0; i < 3; i++) rock(spot(i + 20)[0], spot(i + 20)[1], 0.5 + rnd(i, 21) * 0.4);
      for (let i = 0; i < 4; i++) put(new THREE.BoxGeometry(0.09, 0.09, 0.09), i % 2 ? "#ffd23f" : "#f4efe1", (rnd(i, 22) - 0.5) * 5.5, 0.22, -2.6 + rnd(i, 23) * 0.9);
      tree(3.2, -2.5, 1.2);
    } else if (state.kind !== "caverns") {
      // Bare ground (mud, boards, stone): a few rocks and a broken crate.
      for (let i = 0; i < 5; i++) rock(spot(i)[0], spot(i)[1], 0.6 + rnd(i, 24) * 0.6, "#6d6960");
      put(new THREE.BoxGeometry(0.5, 0.4, 0.5), "#8a6a44", -2.9, 0.2, -2.3, 0.5);
    }
  }

  private battleCentre(state: RenderState): THREE.Vector3 {
    const battle = state.battle!;
    const poiId = battle.poiId ?? state.story?.npcs.find((n) => n.id === battle.npcId)?.poi;
    const poi = state.map.pois.find((p) => p.id === poiId);
    const centre = this.standAt(poi?.pos ?? state.heroes[0].pos);
    // The arena is a raised stage, clear of the tallest nearby tile and its trees.
    let top = centre.y;
    for (const t of this.tiles) {
      const w = hexToWorld(t);
      if (Math.hypot(w.x - centre.x, w.z - centre.z) < 4.2) top = Math.max(top, tileTop(t));
    }
    centre.y = top + 1.2;
    return centre;
  }

  private syncUnits(state: RenderState) {
    const want = new Map<string, Want>();
    const colorOf = (heroId: string) => PLAYER_COLORS[state.heroes.findIndex((h) => h.id === heroId) % PLAYER_COLORS.length];

    if (state.battle) {
      const centre = this.battleCentre(state);
      this.arena.visible = true;
      this.poiGroup.visible = false;
      this.arena.position.set(centre.x, centre.y - 0.8, centre.z);
      this.dressArena(state);
      const actor = state.battle.actor;
      for (const side of ["hero", "enemy"] as const) {
        const line = state.battle.combatants.filter((c) => c.side === side);
        line.forEach((c, i) => {
          const dir = side === "hero" ? -1 : 1;
          want.set(c.id, {
            kind: c.kind,
            outfit: c.outfit,
            // Staggered diagonally so the tall sprites do not hide each other.
            pos: new THREE.Vector3(centre.x + dir * (1.2 + i * 1.05), centre.y, centre.z + (i - (line.length - 1) / 2) * 1.25),
            size: isBoss(c.kind) ? 2.5 : isBig(c.kind) ? 2.2 : 1.9,
            ring: side === "hero" ? colorOf(c.id) : "#e23b3b",
            pulse: c.id === actor,
            hp: c.hp / c.maxHp,
            down: c.down,
          });
        });
      }
    } else {
      this.arena.visible = false;
      this.poiGroup.visible = true;
      const stacks = new Map<string, number>();
      for (const h of state.heroes) stacks.set(key(h.pos), (stacks.get(key(h.pos)) ?? 0) + 1);
      const seen = new Map<string, number>();
      for (const h of state.heroes) {
        const n = stacks.get(key(h.pos))!;
        const i = seen.get(key(h.pos)) ?? 0;
        seen.set(key(h.pos), i + 1);
        const pos = this.standAt(h.pos);
        if (h.at) pos.add(new THREE.Vector3(h.at.x, h.at.y, h.at.z));
        else {
          pos.x += (i - (n - 1) / 2) * 0.6;
          pos.z += 0.25;
        }
        const base = plateOf(h);
        const plate = base && h.id === state.you && state.stamina ? { ...base, bolts: state.stamina } : base;
        // A plate shows a first name only: full names run long over a crowd.
        const full = h.label ?? (plate ? h.name : undefined);
        const label = plate && full ? firstName(full) : full;
        want.set(h.id, { kind: h.classId, outfit: h.outfit, pos, size: 1.5, label, plate: label ? plate : undefined, stack: i, ring: colorOf(h.id), pulse: state.turn?.heroId === h.id, asleep: h.asleep });
      }
      for (const npc of state.story?.npcs ?? []) {
        const poi = state.map.pois.find((p) => p.id === npc.poi);
        if (!poi || state.npcs[npc.id]?.hostile) continue;
        const pos = this.standAt(poi.pos);
        pos.x += 0.62;
        want.set(`npc:${npc.id}`, { kind: "npc", pos, size: 1.4 });
      }
      // Bands loose on the island, drawn where they stand while a hero can see them.
      for (const band of state.roamers ?? []) {
        band.kinds.forEach((kind, i) => {
          const pos = this.standAt(band.pos);
          pos.x += (i - (band.kinds.length - 1) / 2) * 0.55;
          pos.z += 0.15;
          want.set(`roam:${band.id}:${i}`, { kind, pos, size: isBig(kind) ? 1.5 : 1.3, ring: i === 0 ? "#ff3b3b" : undefined, pulse: i === 0 });
        });
      }
      for (const poi of state.map.pois) {
        if (poi.cleared || poi.enemies.length === 0) continue;
        poi.enemies.forEach((kind, i) => {
          const pos = this.standAt(poi.pos);
          pos.x += (i - (poi.enemies.length - 1) / 2) * 0.6 + 0.2;
          pos.z += 0.05;
          want.set(`poi:${poi.id}:${i}`, { kind, pos, size: isBoss(kind) ? 1.7 : isBig(kind) ? 1.5 : 1.3 });
        });
      }
    }

    for (const [id, unit] of this.units) {
      const w = want.get(id);
      // A change of gear is a different sprite, so the unit is rebuilt.
      if (w && spriteKey(w.kind, w.outfit, w.asleep) === unit.kind) continue;
      this.unitGroup.remove(unit.sprite, ...unit.casters);
      // The cards share one set of materials.
      const card = unit.casters[0];
      card.material instanceof THREE.Material && card.material.dispose();
      card.customDepthMaterial?.dispose();
      card.customDistanceMaterial?.dispose();
      if (unit.shadowShown) this.ambience.stir(unit.shadowAt);
      if (unit.ring) this.unitGroup.remove(unit.ring);
      if (unit.hpBack) this.unitGroup.remove(unit.hpBack);
      if (unit.hpFill) this.unitGroup.remove(unit.hpFill);
      this.clearArrows(unit);
      this.dropLabel(unit);
      this.units.delete(id);
    }
    this.pulsing.clear();
    for (const [id, w] of want) {
      let unit = this.units.get(id);
      if (!unit) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture(w.kind, w.outfit, w.asleep), transparent: true, alphaTest: 0.5 }));
        // Depth-tested as an upright card at their feet, so a building in front hides them and one behind does not.
        sprite.renderOrder = 2;
        sprite.center.set(0.5, 0);
        sprite.position.copy(w.pos);
        addSpriteRim(sprite.material);
        standUpright(sprite.material);
        const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, map: sprite.material.map, alphaTest: 0.5 });
        const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sprite.material.map, alphaTest: 0.5, side: THREE.DoubleSide });
        // Point lights (a hut's lamp, its fires and candles) draw shadows with a distance pass, which needs its own cut-out.
        const distance = new THREE.MeshDistanceMaterial({ map: sprite.material.map, alphaTest: 0.5, side: THREE.DoubleSide });
        const casters = Array.from({ length: 1 + SHADOW_SLOTS }, (_, i) => {
          const caster = new THREE.Mesh(CASTER_PLANE, material);
          caster.customDepthMaterial = depth;
          caster.customDistanceMaterial = distance;
          caster.castShadow = true;
          caster.layers.set(i === 0 ? CARD_LAYER : SLOT_LAYER + i - 1);
          return caster;
        });
        this.unitGroup.add(sprite, ...casters);
        unit = { sprite, casters, shadowAt: w.pos.clone(), shadowShown: false, shadowSize: 0, ring: null, hpBack: null, hpFill: null, label: null, labelText: "", goal: w.pos.clone(), path: [], kick: new THREE.Vector3(), lean: 0, baseRot: 0, stride: 0, bob: 0, kind: spriteKey(w.kind, w.outfit, w.asleep), asleep: false, nextZ: 0, zCount: 0, glowUntil: 0, glowing: false, head: w.size + 0.3, stack: 0, feet: w.pos.clone() };
        this.units.set(id, unit);
      }
      unit.goal.copy(w.pos);
      // Asleep: on their side across the bedroll, low to the ground, the head toward the left.
      if (w.asleep) unit.goal.y += (w.size * SPRITE_ASPECT) / 2 - 0.05;
      if (w.asleep && !unit.asleep) unit.nextZ = this.clock + 0.4;
      unit.asleep = !!w.asleep;
      unit.head = w.asleep ? w.size * SPRITE_ASPECT + 0.3 : w.size + 0.3;
      unit.stack = w.stack ?? 0;
      unit.sprite.scale.set(w.size * SPRITE_ASPECT, w.size, 1);
      for (const caster of unit.casters) {
        caster.scale.copy(unit.sprite.scale);
        caster.visible = !w.down && !w.asleep;
      }
      const mat = unit.sprite.material;
      unit.baseRot = w.down ? Math.PI / 2 : w.asleep ? Math.PI / 2 : 0;
      mat.opacity = w.down ? 0.55 : 1;
      unit.sprite.center.set(0.5, w.down || w.asleep ? 0.5 : 0);
      // Arrows stay in until the one they hit goes down, or the fight is over.
      if (w.down || !state.battle) this.clearArrows(unit);

      if (w.ring && !unit.ring) {
        unit.ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.44, 6), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        unit.ring.rotation.x = -Math.PI / 2;
        this.unitGroup.add(unit.ring);
      }
      if (unit.ring) {
        unit.ring.visible = !!w.ring;
        if (w.ring) (unit.ring.material as THREE.MeshBasicMaterial).color.set(w.ring);
      }
      if (w.pulse) this.pulsing.add(id);

      unit.labelWant = { label: w.label, plate: w.plate, size: w.size, asleep: w.asleep, stack: w.stack };
      this.applyLabel(unit);

      if (w.hp !== undefined && !unit.hpBack) {
        unit.hpBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#1b1830", depthTest: false }));
        unit.hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#6ee06e", depthTest: false }));
        unit.hpBack.center.set(0, 0.5);
        unit.hpFill.center.set(0, 0.5);
        unit.hpBack.renderOrder = 5;
        unit.hpFill.renderOrder = 6;
        unit.hpBack.layers.set(OVERLAY_LAYER);
        unit.hpFill.layers.set(OVERLAY_LAYER);
        this.unitGroup.add(unit.hpBack, unit.hpFill);
      }
      if (unit.hpBack && unit.hpFill) {
        const show = w.hp !== undefined && !w.down;
        unit.hpBack.visible = unit.hpFill.visible = show;
        if (show) {
          unit.hpBack.scale.set(1.2, 0.16, 1);
          unit.hpFill.scale.set(Math.max(0.001, 1.14 * w.hp!), 0.1, 1);
          unit.hpFill.material.color.set(w.hp! > 0.5 ? "#6ee06e" : w.hp! > 0.25 ? "#ffd23f" : "#ff6b6b");
          unit.hpBack.userData.lift = unit.hpFill.userData.lift = w.size + 0.25;
        }
      }
    }
  }

  /** Where the top of a unit's plate is, in world height, as it is drawn now. Null without a plate. */
  private plateTop(unit: Unit): number | null {
    const label = unit.label;
    if (!label) return null;
    const rows = label.userData.rows as number;
    const stack = unit.labelWant?.stack ?? 0;
    // An unattenuated sprite's size scales with its distance in front of the camera.
    const depth = -label.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    const row = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.height;
    if (!(depth > 0) || !(rows > 0)) return null;
    // The plate is offset straight up the screen; a world-height rise looks shorter by the camera's tilt.
    const tilt = Math.max(0.3, Math.cos(this.pitch));
    return label.position.y + ((5 + stack * (rows + 2) + rows) * row * depth) / tilt;
  }

  /** Draw (or redraw) a unit's name tag or plate: on a change, and as an XP glow on its bar starts and ends. */
  private applyLabel(unit: Unit) {
    const lw = unit.labelWant;
    if (!lw) return;
    unit.glowing = this.clock < unit.glowUntil;
    const plate = lw.plate && unit.glowing ? { ...lw.plate, glow: true } : lw.plate;
    const labelKey = lw.label ? plateKey(lw.label, plate) : "";
    if (labelKey !== unit.labelText) {
      this.dropLabel(unit);
      unit.labelText = labelKey;
      if (lw.label) {
        const { texture, aspect } = labelTexture(lw.label, plate);
        // A fixed size on screen, whatever the zoom: each pixel of the label lands on exactly one pixel of the view.
        unit.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
        unit.label.layers.set(OVERLAY_LAYER);
        unit.label.userData.aspect = aspect;
        unit.label.userData.rows = texture.image.height;
        unit.label.userData.lift = lw.asleep ? lw.size * SPRITE_ASPECT + 0.3 : lw.size + 0.3;
        unit.label.renderOrder = 7;
        this.unitGroup.add(unit.label);
      }
    }
    if (unit.label) {
      // Held five of its own pixels clear of the head, at any zoom, however tall the plate;
      // a second hero on the same hex has theirs a plate higher, so neither hides the other.
      const rows = unit.label.userData.rows as number;
      unit.label.center.set(0.5, -(5 + (lw.stack ?? 0) * (rows + 2)) / rows);
    }
  }

  private dropLabel(unit: Unit) {
    if (!unit.label) return;
    this.unitGroup.remove(unit.label);
    unit.label.material.map?.dispose();
    unit.label.material.dispose();
    unit.label = null;
  }

  // ---------- hover and path ----------

  private updatePath() {
    this.pathGroup.clear();
    const state = this.state;
    const hovered = this.hovered;
    this.hoverRing.visible = false;
    // While carrying a piece the ghost shows where it would go; no walking route.
    if (!state || !hovered || state.battle || state.holding) return;
    const at = this.standAt(hovered);
    this.hoverRing.position.set(at.x, at.y + 0.04, at.z);
    this.hoverRing.visible = true;
    const reach = this.reach.get(key(hovered));
    const me = state.heroes.find((h) => h.id === state.you);
    (this.hoverRing.material as THREE.MeshBasicMaterial).color.set(reach && reach.cost > 0 ? "#ffffff" : "#35405a");
    const budget = state.freeRoam ? FREE_ROAM_REACH : state.turn?.mp;
    if (!reach || reach.cost === 0 || !me || budget === undefined) return;
    const route = findPath(state.map, me.pos, hovered, budget, this.stepCost(state));
    for (const step of route?.path ?? []) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 4), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
      const p = this.standAt(step);
      dot.position.set(p.x, p.y + 0.2, p.z);
      this.pathGroup.add(dot);
    }
  }

  private pick(): HexPos | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // A figure stands up out of its hex, so a click on it (or on the plate over its head) would
    // otherwise land on the ground behind. Clicking someone (other than yourself) means the hex they stand on.
    if (!this.state?.battle) {
      const others = [...this.units.entries()].filter(([id, u]) => id !== this.state?.you && u.sprite.visible).map(([, u]) => u);
      const onFigure = this.raycaster.intersectObjects(others.flatMap((u) => (u.label ? [u.sprite, u.label] : [u.sprite])), false)[0];
      const unit = onFigure && others.find((u) => u.sprite === onFigure.object || u.label === onFigure.object);
      if (unit) {
        let best: Tile | null = null;
        let bestD = Infinity;
        for (const t of this.tiles) {
          const w = hexToWorld(t);
          const d = (w.x - unit.goal.x) ** 2 + (w.z - unit.goal.z) ** 2;
          if (d < bestD) [best, bestD] = [t, d];
        }
        if (best) return { q: best.q, r: best.r };
      }
    }
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    return { q: t.q, r: t.r };
  }

  // Pointer handling covers mouse and touch. One pointer pans (or taps a
  // hex if it barely moves); two pointers pinch to zoom and pan together.

  private onPointerDown = (e: PointerEvent) => {
    const canvas = this.renderer.domElement;
    if (this.minigame) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.minigame.game.press?.(ndc, this.camera);
      return;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety (keeps a drag alive off the canvas); carry on without it.
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A tap on a touch screen comes with no move before it, so the press itself says the pointer is over the canvas.
    // Without this, placing a carried piece by tapping (aim() needs it) did nothing on a phone.
    this.pointer.inside = true;
    if (this.touches.size === 1) {
      // Right button, or Shift or Alt with the left, turns the view instead of sliding it.
      this.rotating = e.button === 2 || e.shiftKey || e.altKey;
      this.pointer.down = true;
      this.pointer.dragged = false;
      this.pointer.downX = this.pointer.x = e.clientX;
      this.pointer.downY = this.pointer.y = e.clientY;
    } else if (this.touches.size === 2) {
      // A second finger: this is a pinch, never a tap.
      this.pointer.dragged = true;
      this.rotating = false;
      this.pinch = { ...this.pinchState(), zoom: this.userDist };
      this.panFrom = { x: this.pinch.x, y: this.pinch.y };
    }
  };

  /** Distance between the two touches and their midpoint. */
  /** Distance between the two touches, their midpoint, and the angle of the line between them. */
  private pinchState(): { dist: number; x: number; y: number; angle: number } {
    const [a, b] = [...this.touches.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** Turn the view freely by an angle. No effect during a battle. */
  private turn(radians: number) {
    if (this.state?.battle) return;
    this.userYaw += radians;
    this.yaw = this.yawGoal = this.userYaw;
  }

  /** Tip the view up or down by an angle; `ease` glides there instead of jumping. No effect during a battle. */
  tiltBy(radians: number, ease = false) {
    if (this.state?.battle) return;
    this.userPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.userPitch + radians));
    this.pitchGoal = this.userPitch;
    if (!ease) this.pitch = this.userPitch;
  }

  /** Turn the view by whole hex sides (60°), easing there. */
  rotateBy(steps: number) {
    if (this.state?.battle) return;
    const step = Math.PI / 3;
    // Snap to the nearest side first, so repeated presses land on clean angles.
    this.userYaw = (Math.round(this.userYaw / step) + steps) * step;
    this.yawGoal = this.userYaw;
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
    if (this.minigame) {
      if (this.minigame.game.key?.(e)) e.preventDefault();
      return;
    }
    if (e.key === "q" || e.key === "Q") this.rotateBy(-1);
    else if (e.key === "e" || e.key === "E") this.rotateBy(1);
    else if (e.key === "r" || e.key === "R") this.tiltBy(0.18, true);
    else if (e.key === "f" || e.key === "F") this.tiltBy(-0.18, true);
    else if (e.key === "c" || e.key === "C") this.setFollow(!this.follow || this.followHeld);
    else if (import.meta.env.DEV && (e.key === "p" || e.key === "P")) this.setPost(!this.post);
    else if (import.meta.env.DEV && (e.key === "l" || e.key === "L")) this.setLit(!this.litSprites);
    else if (PAN_KEYS[e.key.toLowerCase()]) {
      this.heldKeys.add(e.key.toLowerCase());
      // Arrow keys would otherwise scroll whatever panel has focus.
      if (e.key.startsWith("Arrow")) e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.heldKeys.delete(e.key.toLowerCase());
  };

  /** A key released while the window is elsewhere never sends keyup; do not keep sliding. */
  private onBlur = () => this.heldKeys.clear();

  /** True while a touch is still within the slack of where a pinch began (see `panFrom`): it does not pan. */
  private holdPan(x: number, y: number): boolean {
    if (!this.panFrom) return false;
    if (this.follow && !this.followHeld && Math.hypot(x - this.panFrom.x, y - this.panFrom.y) < PINCH_PAN_SLACK) return true;
    this.panFrom = null;
    return false;
  }

  private panBy(dx: number, dy: number) {
    if (this.state?.battle) return;
    if (dx === 0 && dy === 0) return;
    // Looking around is the player taking the camera: stop following until they ask again.
    if (this.follow) this.setFollow(false);
    const k = (this.dist / this.container.clientHeight) * 0.75;
    // Slide along the screen's own right and up, whichever way the camera is turned.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    // The ground is foreshortened by the tilt, so a drag up or down covers more of it the lower the camera is.
    const deep = Math.min(2.4, 0.96 / Math.sin(this.pitch));
    this.targetGoal.x -= dx * k * cos + dy * k * deep * sin;
    this.targetGoal.z -= -dx * k * sin + dy * k * deep * cos;
    this.target.copy(this.targetGoal);
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.minigame) return;
    const touch = this.touches.get(e.pointerId);
    if (touch) {
      touch.x = e.clientX;
      touch.y = e.clientY;
    }
    if (this.pinch && this.touches.size >= 2) {
      const now = this.pinchState();
      // Fingers apart zooms in: the camera distance shrinks as the spread grows.
      // Damped: doubling the spread zooms by about a half, not by two.
      this.userDist = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.pinch.zoom * Math.pow(this.pinch.dist / now.dist, PINCH_DAMPING)));
      if (!this.state?.battle) this.dist = this.userDist;
      // While following, a pinch only zooms: the little drift of spreading fingers is not a pan.
      if (!this.holdPan(now.x, now.y)) this.panBy(now.x - this.pinch.x, now.y - this.pinch.y);
      // Twisting the two fingers turns the view with them.
      let twist = now.angle - this.pinch.angle;
      if (twist > Math.PI) twist -= 2 * Math.PI;
      if (twist < -Math.PI) twist += 2 * Math.PI;
      this.turn(-twist);
      this.pinch.x = now.x;
      this.pinch.y = now.y;
      this.pinch.angle = now.angle;
      return;
    }
    const dx = e.clientX - this.pointer.x;
    const dy = e.clientY - this.pointer.y;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;
    if (this.pointer.down) {
      if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 6) this.pointer.dragged = true;
      if (this.pointer.dragged) {
        if (this.rotating) {
          this.turn(-dx * 0.008);
          // Dragging down lifts the camera to look more steeply; up drops it toward the horizon.
          this.tiltBy(dy * 0.006);
        }
        else if (!this.holdPan(e.clientX, e.clientY)) this.panBy(dx, dy);
      }
    } else {
      this.pointer.dirty = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (this.minigame) {
      this.touches.delete(e.pointerId);
      return;
    }
    this.touches.delete(e.pointerId);
    if (this.touches.size >= 1) {
      // One finger of a pinch lifted: carry on panning with the other, without a jump.
      this.pinch = null;
      const [rest] = [...this.touches.values()];
      this.pointer.x = rest.x;
      this.pointer.y = rest.y;
      if (this.panFrom) this.panFrom = { x: rest.x, y: rest.y };
      return;
    }
    this.pinch = null;
    this.panFrom = null;
    // A right-click, or a Shift/Alt click, is the start of a turn, not an order to walk.
    const wasClick = this.pointer.down && !this.pointer.dragged && !this.rotating && e.type === "pointerup";
    this.pointer.down = false;
    if (!wasClick) return;
    if (this.state?.holding && this.callbacks.onPlace) {
      const target = this.aim();
      if (target) this.callbacks.onPlace(target);
      return;
    }
    if (this.callbacks.onPropClick && !this.state?.battle) {
      const prop = this.pickProp();
      if (prop !== null && this.callbacks.onPropClick(prop)) return;
    }
    const pos = this.pick();
    // Nobody walks during a fight, and a practice bout borrows the Harbor's view.
    if (pos && !this.state?.battle) this.callbacks.onHexClick(pos);
  };

  private onPointerLeave = () => {
    if (this.touches.size > 0) return;
    this.pointer.inside = false;
    this.setHovered(null);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.minigame) return;
    // Shift and the wheel turn whatever is being carried: a notch at a time, or (snapping off) as far as the wheel moves.
    if (e.shiftKey && this.state?.holding && this.callbacks.onTurnHeld) {
      const delta = e.deltaY || e.deltaX;
      if (delta !== 0) this.callbacks.onTurnHeld(delta > 0 ? 1 : -1, Math.min(1, Math.abs(delta) / 100), e.altKey);
      return;
    }
    // Proportional to how far the wheel moved, capped so one notch is about 6%.
    // A trackpad sends many small deltas and a mouse wheel a few big ones; both end up gentle.
    const step = Math.max(-50, Math.min(50, e.deltaY)) * 0.0012;
    this.userDist = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.userDist * Math.exp(step)));
    if (!this.state?.battle) this.dist = this.userDist;
  };

  private setHovered(pos: HexPos | null) {
    if ((pos && this.hovered && key(pos) === key(this.hovered)) || (!pos && !this.hovered)) return;
    this.hovered = pos;
    this.updatePath();
    if (this.state) this.buildJoinRanges(this.state);
    this.callbacks.onHover(pos);
  }

  // ---------- frame loop ----------

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(Math.ceil(w / PIXEL), Math.ceil(h / PIXEL), false);
    this.post?.setSize(Math.ceil(w / PIXEL), Math.ceil(h / PIXEL));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Dev server only: a lightning strike now, whatever the weather, for trying thunder takes against the flash. */
  strike() {
    if (import.meta.env.DEV) this.storm.strikeNow(this.camera, this.target);
  }

  /** Turns the lit sprites on or off in this view. The setting players keep is "Fancy graphics" (fancy.ts). */
  setLit(on: boolean) {
    this.litSprites = on;
  }

  /** Tints a character by the light at their feet and aims their edge highlight at the strongest light. */
  private lightSprite(sprite: THREE.Sprite, feet: THREE.Vector3) {
    const rim = sprite.material.userData.rim as SpriteRim | undefined;
    if (!rim) return;
    if (!this.litSprites) {
      sprite.material.color.setRGB(1, 1, 1);
      rim.color.setRGB(0, 0, 0);
      return;
    }
    const k = this.lit;
    const tint = this.litTint;
    this.ambience.lightAt(feet, tint, this.litRim, this.litToward);
    // Keep the light's colour but hold its brightness within bounds, so nobody is lost in the dark.
    const peak = Math.max(tint.r, tint.g, tint.b, 1e-4);
    tint.multiplyScalar(Math.min(k.ceiling, Math.max(k.floor, peak)) / peak);
    sprite.material.color.setRGB(1, 1, 1).lerp(tint, k.strength);

    // The way to the light as the camera sees it, turned with the sprite if it leans or lies down.
    const e = this.camera.matrixWorld.elements;
    const x = this.litToward.dot(this.litAxis.set(e[0], e[1], e[2]));
    const y = this.litToward.dot(this.litAxis.set(e[4], e[5], e[6]));
    const len = Math.hypot(x, y);
    const rot = -sprite.material.rotation;
    const ux = len < 0.15 ? 0 : (x * Math.cos(rot) - y * Math.sin(rot)) / len;
    const uy = len < 0.15 ? 1 : (x * Math.sin(rot) + y * Math.cos(rot)) / len;
    rim.step.set(Math.round(ux * 1.3), Math.round(uy * 1.3));
    const image = sprite.material.map?.image as { width: number; height: number } | undefined;
    if (image) rim.texel.set(1 / image.width, 1 / image.height);
    const glow = Math.min(1, Math.max(this.litRim.r, this.litRim.g, this.litRim.b) * 2.5);
    const top = Math.max(this.litRim.r, this.litRim.g, this.litRim.b, 1e-4);
    rim.color.copy(this.litRim).multiplyScalar((glow * k.rim) / top);
  }

  /** Turns the finishing pass on or off in this view. The setting players keep is "Fancy graphics" (fancy.ts). */
  setPost(on: boolean) {
    if (on === !!this.post) return;
    if (on) {
      this.post = new PostFx(this.renderer);
      this.resize();
    } else {
      this.post!.dispose();
      this.post = null;
      this.renderer.setRenderTarget(null);
    }
  }

  private camDist = 24;

  private frame = (now: number) => {
    if (!this.opts.backdrop) this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    const ease = 1 - Math.exp(-dt * 6);

    if (this.pointer.dirty && this.pointer.inside && !this.minigame) {
      this.pointer.dirty = false;
      this.setHovered(this.pick());
      if (this.state?.holding) this.placeGhost();
      if (this.callbacks.onPropHover) {
        const prop = this.state?.battle ? null : this.pickProp();
        if (prop !== this.hoverProp) this.callbacks.onPropHover((this.hoverProp = prop));
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.clock) this.pending.splice(i, 1)[0].run();
    }

    // Held movement keys slide the view, at a speed that covers the screen in about a second and a half.
    if (this.heldKeys.size > 0 && !this.state?.battle) {
      let x = 0;
      let y = 0;
      for (const key of this.heldKeys) {
        x += PAN_KEYS[key]?.[0] ?? 0;
        y += PAN_KEYS[key]?.[1] ?? 0;
      }
      const speed = this.container.clientHeight * 0.7 * dt;
      // panBy takes a drag: dragging left moves the view right, so the signs are flipped.
      if (x || y) this.panBy(-x * speed, y * speed);
    }

    // Following: the camera's goal is your hero's feet (the middle of the hex they stand on), wherever they have got to.
    const mine = this.follow && !this.state?.battle && this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) {
      if (this.followHeld && mine.path.length > 0) {
        this.followHeld = false;
        this.showFollow();
      }
      if (!this.followHeld) this.targetGoal.set(mine.feet.x, mine.feet.y, mine.feet.z - 0.25);
    }

    this.target.lerp(this.targetGoal, ease);
    this.camDist += (this.dist - this.camDist) * ease;
    this.yaw += (this.yawGoal - this.yaw) * ease;
    this.pitch += (this.pitchGoal - this.pitch) * ease;
    const reach = this.camDist * CAMERA_REACH;
    const flat = reach * Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * flat,
      this.target.y + reach * Math.sin(this.pitch),
      this.target.z + Math.cos(this.yaw) * flat,
    );
    this.camera.lookAt(this.target);
    // A backdrop is seen from one fixed spot, as through a window, not from the roving camera.
    if (this.vantage) {
      this.camera.position.copy(this.vantage.from);
      this.camera.lookAt(this.vantage.to);
      this.target.copy(this.vantage.to);
    }
    // A game in the world swings the camera from the usual view round and down into its own: the bearing, distance
    // and height about the game's look point all ease over together, so it orbits in rather than sliding.
    let focus = this.camera.position.distanceTo(this.target);
    if (this.minigame) {
      const v = this.minigame.game.frame(dt, now, this.camera.aspect);
      const b = Math.max(0, Math.min(1, v.blend));
      if (b > 0) {
        const rel0 = this.camera.position.clone().sub(v.look);
        const rel1 = v.eye.clone().sub(v.look);
        const a0 = Math.atan2(rel0.x, rel0.z);
        let turn = Math.atan2(rel1.x, rel1.z) - a0;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        const bearing = a0 + turn * b;
        const flat = THREE.MathUtils.lerp(Math.hypot(rel0.x, rel0.z), Math.hypot(rel1.x, rel1.z), b);
        const look = this.target.clone().lerp(v.look, b);
        this.camera.position.set(v.look.x + Math.sin(bearing) * flat, v.look.y + THREE.MathUtils.lerp(rel0.y, rel1.y, b), v.look.z + Math.cos(bearing) * flat);
        this.camera.lookAt(look);
        focus = this.camera.position.distanceTo(look);
      }
      const fov = THREE.MathUtils.lerp(this.baseFov, v.fov ?? this.baseFov, b);
      if (Math.abs(fov - this.camera.fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      this.hideOwnHero();
    }
    this.ambience.update(this.clock, this.yaw, this.target, this.state?.you ? this.units.get(this.state.you)?.sprite.position : undefined);
    // Sounds are heard from where your hero stands, or from the middle of the view without one.
    const ear = (this.state?.you ? this.units.get(this.state.you)?.sprite.position : undefined) ?? this.target;
    this.ear.listener(ear.x, ear.z, this.yaw);
    this.ear.sky(this.ambience.sky());
    // Where the sea lies changes slowly: work it out a few times a second.
    if (this.frames++ % 8 === 0) {
      this.ear.sea(nearWater(ear.x, ear.z, this.water));
      this.ear.ground(this.state ? (tileAt(this.state.map, worldToHex(ear.x, ear.z - 0.25))?.biome ?? null) : null);
    }
    // In the caverns every hero carries a torch: the lights follow them as they walk.
    if (this.state?.kind === "caverns") {
      const torches: THREE.Vector3[] = [];
      for (const h of this.state.heroes) {
        const unit = this.units.get(h.id);
        if (unit) torches.push(unit.sprite.position);
      }
      this.ambience.setTorches(torches);
    }
    // Night reaches the open sea and the fog too, not just the lit ground.
    const night = this.ambience.night;
    (this.sea.material as THREE.MeshLambertMaterial).color.copy(this.seaBase).lerp(NIGHT_SEA, night * 0.8);
    // Night life and the night sky on the water: out under an open sky as the light goes, and hidden by cloud.
    // Rain on the land: the ground wets in a few seconds and takes most of a minute to dry.
    const raining = this.ambience.openSky ? this.ambience.raining : 0;
    // Wind: a breeze on a clear day, stronger in rain, and a gale in a storm. None indoors or underground.
    updateWind(this.clock, fancy.get() && this.ambience.openSky ? 0.35 + 0.45 * raining + 0.6 * this.ambience.storming : 0);
    this.wet += (raining - this.wet) * Math.min(1, dt * (raining > this.wet ? 0.3 : 0.04));
    setGroundWet(this.wet);
    // And lightning, in a storm only: a downpour has none. The thunder is heard either way; the flash and
    // the bolt are fancy graphics.
    // Indoors the storm is still going on outside: the thunder comes through the walls and the flash
    // through the windows. Underground there is neither.
    const inRoom = !this.ambience.openSky && !this.ambience.underground;
    // A backdrop has no storm of its own (the thunder would be heard twice): it is lent the flash of the view showing it.
    if (!this.opts.backdrop) this.storm.update(dt, this.ambience.underground ? 0 : this.ambience.sky().storm, this.camera, this.target, inRoom);
    this.showOutlook();
    this.storm.bolt.visible &&= fancy.get();
    const lively = fancy.get() && this.ambience.openSky ? night : 0;
    this.nightLife.setLamps(this.ambience.lampSpots());
    this.nightLife.update(this.clock, lively);
    const clearSky = lively * (1 - this.ambience.overcast);
    // The moon's reflection lies on the sea off the island's shore, on the side the moon is on.
    const moon = this.ambience.sunDir;
    const across = Math.hypot(moon.x, moon.z) || 1;
    const offshore = this.land.reach + 4;
    setWaterNight(clearSky, this.land.x + (moon.x / across) * offshore, this.land.z + (moon.z / across) * offshore, Math.max(0, (clearSky - 0.55) / 0.45));
    this.ambience.smoothSea = fancy.get();
    updateWater(fancy.get(), this.clock, this.ambience.sunDir, this.ambience.sunGlint(this.litRim), (this.sea.material as THREE.MeshLambertMaterial).color, this.scene.background as THREE.Color, this.ambience.raining);
    const step = Math.round(night * 10);
    if (step !== this.paintedNight) {
      this.paintedNight = step;
      this.paintTiles();
    }
    if (this.state?.indoors) this.lowerNearWalls();

    // The height of one view pixel, in the units an unattenuated sprite is sized in.
    const labelRow = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.height;
    for (const [id, unit] of this.units) {
      const p = unit.sprite.position;
      // The hop is drawn on top of where the unit really is; take it off before moving.
      p.y -= unit.bob;
      let landed = 0;
      if (unit.path.length > 0) {
        const next = unit.path[0].clone();
        next.z += 0.25;
        const step = 4.2 * dt;
        landed = footfalls(unit.stride, unit.stride + step);
        unit.stride += step;
        if (p.distanceTo(next) <= step) {
          p.copy(next);
          unit.path.shift();
        } else {
          p.add(next.sub(p).setLength(step));
        }
        // Two hops per hex, landing as each hex is reached.
        unit.bob = Math.abs(Math.sin(unit.stride * 3.6)) * 0.2;
      } else {
        unit.bob *= Math.exp(-dt * 18);
        unit.stride = 0;
        const goal = unit.goal.clone().add(unit.kick);
        p.lerp(goal, 1 - Math.exp(-dt * 14));
        unit.kick.multiplyScalar(Math.exp(-dt * 9));
      }
      unit.lean *= Math.exp(-dt * 8);
      unit.sprite.material.rotation = unit.baseRot + unit.lean;
      const ground = p.y;
      unit.feet.set(p.x, ground, p.z);
      if (landed) this.footfall(id, unit);
      this.lightSprite(unit.sprite, unit.feet);
      p.y += unit.bob;
      unit.casters.forEach((caster, i) => {
        caster.position.copy(p);
        caster.rotation.y = i === 0 ? this.ambience.towardLight(p.x, p.z) : this.ambience.slotFacing(i - 1, p.x, p.z);
      });
      // Indoors the shadow maps are drawn only when something changes: a hero that moved (or lay down, or stood up)
      // asks the lights in reach of where it was and where it is now to redraw.
      const shown = unit.casters[0].visible;
      if (shown !== unit.shadowShown || (shown && (unit.shadowAt.distanceToSquared(p) > 1e-6 || unit.shadowSize !== unit.sprite.scale.y))) {
        if (unit.shadowShown) this.ambience.stir(unit.shadowAt);
        if (shown) this.ambience.stir(p);
        unit.shadowAt.copy(p);
        unit.shadowShown = shown;
        unit.shadowSize = unit.sprite.scale.y;
      }
      if (unit.ring) {
        unit.ring.position.set(p.x, ground + 0.04, p.z);
        const s = this.pulsing.has(id) ? 1.25 + Math.sin(this.clock * 6) * 0.2 : 1;
        unit.ring.scale.set(s, s, 1);
      }
      if (unit.label) {
        unit.label.position.set(p.x, ground + unit.label.userData.lift, p.z);
        const tall = unit.label.userData.rows * labelRow;
        unit.label.scale.set(tall * unit.label.userData.aspect, tall, 1);
      }
      for (const a of unit.arrows ?? []) {
        a.sprite.position.set(p.x + a.off.x, ground + a.off.y, p.z + a.off.z);
        a.sprite.material.rotation = a.rot + unit.lean;
      }
      if (unit.hpBack && unit.hpFill) {
        const lift = unit.hpBack.userData.lift ?? 2;
        unit.hpBack.position.set(p.x - 0.6, ground + lift, p.z);
        unit.hpFill.position.set(p.x - 0.57, ground + lift, p.z);
      }
    }

    this.placeBubbles(dt, labelRow);

    // An XP glow on a plate has run its course: draw the bar plain again.
    for (const unit of this.units.values()) if (unit.glowing && this.clock >= unit.glowUntil) this.applyLabel(unit);

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      f.sprite.position.lerpVectors(f.from, f.to, t);
      const size = f.size[0] + (f.size[1] - f.size[0]) * t;
      f.sprite.scale.set(size, size, 1);
      f.sprite.material.rotation = f.spin * t;
      if (f.fade) f.sprite.material.opacity = 1 - t * t;
      if (t >= 1) {
        this.fxGroup.remove(f.sprite);
        f.sprite.material.dispose();
        this.fx.splice(i, 1);
        f.onEnd?.();
      }
    }

    for (const puff of this.puffs) {
      if (!puff.sprite.visible) continue;
      puff.age += dt;
      const t = puff.age / puff.life;
      if (t >= 1) {
        puff.sprite.visible = false;
        continue;
      }
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      puff.vx *= Math.exp(-dt * 5);
      puff.vy *= Math.exp(-dt * 4);
      puff.sprite.position.set(puff.x, puff.y, puff.z);
      const s = puff.size * (0.8 + t * 0.45);
      puff.sprite.scale.set(s, s, 1);
      puff.sprite.material.opacity = puff.alpha * (1 - t * t);
    }

    // Sleepers breathe out a z now and then: small, small, then a big one.
    for (const unit of this.units.values()) {
      if (!unit.asleep || this.clock < unit.nextZ) continue;
      unit.nextZ = this.clock + 0.85;
      unit.zCount += 1;
      const big = unit.zCount % 3 === 0;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sleepZTexture(), transparent: true, depthTest: false }));
      sprite.renderOrder = 10;
      const p = unit.sprite.position;
      this.fxGroup.add(sprite);
      this.sleepZs.push({ sprite, age: 0, x: p.x - 0.35, z: p.z, y: p.y + 0.25, size: big ? 0.42 : 0.26, sway: unit.zCount * 1.7 });
    }
    for (let i = this.sleepZs.length - 1; i >= 0; i--) {
      const z = this.sleepZs[i];
      z.age += dt;
      const t = z.age / Z_LIFE;
      z.sprite.position.set(z.x + t * 0.5 + Math.sin(z.sway + z.age * 2.4) * 0.12, z.y + t * 1.3, z.z);
      const s = z.size * (0.7 + t * 0.6);
      z.sprite.scale.set(s, s, 1);
      z.sprite.material.opacity = Math.min(1, z.age / 0.25) * (1 - Math.max(0, (t - 0.6) / 0.4));
      if (t >= 1) {
        this.fxGroup.remove(z.sprite);
        z.sprite.material.dispose();
        this.sleepZs.splice(i, 1);
      }
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      const life = f.life ?? 1.0;
      f.sprite.position.y += dt * (f.rise ?? 1.4);
      // Holds solid for the first part of its life, then fades.
      f.sprite.material.opacity = Math.max(0, Math.min(1, (1 - f.age / life) * 1.6));
      if (f.age >= life) {
        this.fxGroup.remove(f.sprite);
        f.sprite.material.map?.dispose();
        f.sprite.material.dispose();
        this.floaters.splice(i, 1);
      }
    }

    for (const tick of this.tickers) tick(dt, this.camera, this.clock);
    this.ambience.settleShadows();
    if (this.post) {
      this.air.outdoors = this.ambience.openSky;
      this.air.clock = this.clock;
      this.air.sunDir = this.ambience.sunDir;
      this.ambience.sunGlint(this.air.sun);
      this.air.sky = this.scene.background as THREE.Color;
      this.air.overcast = this.ambience.overcast;
      this.air.sunHeight = this.ambience.sunHeight;
      // In a room the flash is only what comes in at the windows.
      this.air.flash = this.opts.backdrop ? this.lentFlash : this.storm.flash * (this.ambience.openSky ? 1 : 0.4);
      this.post.render(this.scene, this.camera, focus, this.ambience.night, this.air);
    }
    else this.renderer.render(this.scene, this.camera);
  };
}
