// Three.js view of an island: low-poly hex terrain with pixel sprites
// standing on it. Imperative on purpose. React owns the HUD; this class owns
// the canvas and is told about state (setState) and things that just
// happened (playEvents).
//
// The same scene shows the overworld and battles: a battle pushes the camera
// in on the fight and lines the two sides up facing each other.

import * as THREE from "three";
import { Ambience } from "./ambience";
import "./camera.css";
import type { HexPos } from "@gantt-quest/core";
import { hexDistance } from "@gantt-quest/core";
import { BATTLE_JOIN_RANGE, ENEMIES, MOVE_COST, findPath, xpProgress, reachable, tileAt, type ClientState, type Outfit, type Phase, type Poi, type Tile, type WorldEvent, type WorldMap } from "@gantt-quest/world";
import { ghostModel, propModel, tintGhost, type LightKind } from "./props";
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
const isBoss = (kind: string) => !!ENEMIES[kind]?.boss;

/**
 * What the renderer needs to draw a scene. An island's ClientState satisfies
 * this as it is; the Harbor builds one by hand with `freeRoam` set.
 */
export interface RenderState {
  /** Identifies the map; the terrain is rebuilt when it changes. */
  code: string;
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
  level?: number;
  /** XP into the current level. */
  xp?: number;
  /** Absent off a voyage, where every hero is at full health. */
  hp?: number;
  maxHp?: number;
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
  /** 0 to 5, in sixths of a turn. */
  facing: number;
  /** Ringed, to show it is the one being handled. */
  selected?: boolean;
  /** A small thing: stepped over, not walked around. */
  small?: boolean;
  /** A small thing's offset from the middle of its hex (or of its support's top), and its turn in radians. */
  x?: number;
  z?: number;
  angle?: number;
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
}

/** Something being carried, to be set down where the pointer is. */
export interface Holding {
  model: string;
  small: boolean;
  /** Furniture's turn, in sixths; a small thing's, in radians. */
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
const BIOME_COLOR: Record<string, string> = { plains: "#7cb856", forest: "#4c9a52", hills: "#a39672", water: "#3f86dc", dock: "#9a7748", cobble: "#6f7279", mud: "#5f5140", rampart: "#62656d", floor: "#b08a5c", wall: "#6e5a48", fog: "#2b3140" };
/** What grass and trees are pulled toward under the Harbor's low cloud. */
const DRAB = new THREE.Color("#5d6a5c");
/** And the sea there: cold and grey-green. */
const GREY_SEA = new THREE.Color("#2f4a5f");

export function hexToWorld(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

const tileTop = (t: Tile | undefined) => (!t ? 0.2 : t.biome === "water" ? 0.14 : 0.35 + t.h * 1.1);
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
  /** Unseen cut-out of the sprite, turned to the sun, that throws its shadow. */
  caster: THREE.Mesh;
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

export interface RendererCallbacks {
  onHexClick(pos: HexPos): void;
  onHover(pos: HexPos | null): void;
  /** A click on a prop. Return true if it was handled; otherwise the click falls through to its hex. */
  onPropClick?(id: string | number): boolean;
  /** The prop under the pointer changed. */
  onPropHover?(id: string | number | null): void;
  /** A click on a hero standing on the map (yourself included). Return true if it was handled; otherwise it falls through to their hex. */
  onHeroClick?(id: string): boolean;
  /** The hero under the pointer changed. Never yourself. */
  onHeroHover?(id: string | null): void;
  /** While carrying something: a click on a spot to set it down. */
  onPlace?(target: PlaceTarget): void;
  /** While carrying something: whether it may go at that spot (the ghost turns red if not). */
  canPlace?(target: PlaceTarget): boolean;
  /** Shift and the wheel, while carrying something: turn it one step (+1 clockwise). */
  onTurnHeld?(dir: 1 | -1): void;
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
  private last = performance.now();
  private clock = 0;

  private terrain: THREE.InstancedMesh | null = null;
  private tiles: Tile[] = [];
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
  /** The hero under the pointer, for their sheet. */
  private hoverHero: string | null = null;
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
  private pulsing = new Set<string>();
  private floaters: Floater[] = [];
  private sleepZs: SleepZ[] = [];
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
  private rotateButtons: HTMLDivElement;
  private pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false, dragged: false, dirty: false, inside: false };

  constructor(private container: HTMLElement, private callbacks: RendererCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(1);
    const canvas = this.renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.imageRendering = "pixelated";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);

    // Sky, sun and moon, shadows, and the moving decoration.
    this.ambience = new Ambience(this.scene, this.renderer);

    const sea = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: "#3577cf" }));
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
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
    addEventListener("blur", this.onBlur);

    // Two small buttons at the right edge, for those without a right mouse button or a keyboard.
    this.rotateButtons = document.createElement("div");
    this.rotateButtons.className = "camera-rotate";
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
    }
    container.appendChild(this.rotateButtons);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
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
    this.ambience.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  // ---------- state ----------

  setState(state: RenderState) {
    const first = this.mapCode !== state.code;
    // The ground is redrawn for a new map, and whenever fog lifts off more of this one.
    const lifted = state.map.tiles.reduce((n, t) => n + (t.biome === "fog" ? 0 : 1), 0);
    if (first || lifted !== this.lifted) this.buildTerrain(state, first);
    this.lifted = lifted;
    this.state = state;
    this.buildPois(state);
    this.buildProps(state);
    this.updateGhost();
    this.buildJoinRanges(state);
    if (first) {
      this.sea.visible = !state.indoors;
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
      this.rotateButtons.hidden = true;
    } else {
      this.dist = this.userDist;
      this.yawGoal = nearestTurn(this.yaw, this.userYaw);
      this.pitchGoal = this.userPitch;
      this.rotateButtons.hidden = false;
      const turnKey = `${state.phase}:${state.round}:${state.turn?.heroId ?? ""}`;
      // A room is small enough to see whole, so indoors the camera stays on its middle.
      if (first && me && !state.indoors) this.target.copy(this.standAt(me.pos));
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
    for (const ev of events) {
      if (ev.t === "moved") {
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
        if (b.t === "hit") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, b.perfect, () => this.float(b.target, `-${b.amount}`, b.perfect ? "#ffd23f" : "#ff6b6b"), true));
        else if (b.t === "miss") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, false, () => this.float(b.target, "miss", "#c9d1e0")));
        else if (b.t === "heal") this.later(beat++, () => { this.sparkle(b.target, "#7dff9a"); this.float(b.target, `+${b.amount}`, "#7dff9a"); });
        else if (b.t === "tick") this.later(beat++, () => this.float(b.target, `-${b.amount}`, "#ffa94d"));
      }
    }
    // After the last blow has landed.
    for (const [heroId, got] of xp) this.later(beat, () => this.xpGain(heroId, got.amount, got.levelUp));
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

  private later(beat: number, run: () => void) {
    this.pending.push({ at: this.clock + beat * 0.38, run });
  }

  private lunge(actorId: string, targetId: string) {
    const a = this.units.get(actorId);
    const t = this.units.get(targetId);
    if (a && t && a !== t) a.kick.copy(t.goal).sub(a.goal).setLength(0.7);
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
  xpGain(unitId: string, amount: number, levelUp = false) {
    const unit = this.units.get(unitId);
    if (!unit || !(amount > 0 || levelUp)) return;
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
    (this.sea.material as THREE.MeshLambertMaterial).color.set(this.sodden ? "#2b4558" : "#3577cf");
    this.wallTurn = NaN;
    this.tiles = state.map.tiles;
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
    this.tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t);
      const shown = this.deep.has(key(t)) ? 0 : 1;
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(shown, tileTop(t) * shown, shown));
      terrain.setMatrixAt(i, m);
    });
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
    };
    instanced(new THREE.ConeGeometry(0.34, 0.9, 5), this.sodden ? "#3a5d41" : "#2f7a3d", trees);
    if (merlons.length > 0) instanced(new THREE.BoxGeometry(1, 1, 1), "#6a6d75", merlons);

    // Start centred on the island. Fog lifting redraws the ground but leaves the camera where the player put it.
    if (!recentre) return;
    const xs = this.tiles.map((t) => hexToWorld(t).x);
    const zs = this.tiles.map((t) => hexToWorld(t).z);
    this.target.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
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
    this.tiles.forEach((t, i) => {
      if ((t.biome as string) !== "wall") return;
      const { x, z } = hexToWorld(t);
      const toward = (x - this.target.x) * Math.sin(this.yaw) + (z - this.target.z) * Math.cos(this.yaw);
      m.compose(new THREE.Vector3(x, 0, z), upright, new THREE.Vector3(1, toward > 0.6 ? kerb : Math.max(kerb, tileTop({ ...t, h: 0.9 })), 1));
      this.terrain!.setMatrixAt(i, m);
    });
    this.terrain.instanceMatrix.needsUpdate = true;
  }

  private paintTiles() {
    if (!this.terrain) return;
    const c = new THREE.Color();
    const white = new THREE.Color("#ffffff");
    this.tiles.forEach((t, i) => {
      c.set(BIOME_COLOR[t.biome]);
      // In a wet, walled port the green is tired.
      if (this.sodden && (t.biome === "plains" || t.biome === "forest")) c.lerp(DRAB, 0.5);
      if (this.sodden && t.biome === "water") c.lerp(GREY_SEA, 0.65);
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

  /** Ease the camera over to a hex. */
  lookAt(pos: HexPos) {
    this.targetGoal.copy(this.standAt(pos));
  }

  /** Whether a unit is still on its way along a walked path. */
  isWalking(id: string): boolean {
    return (this.units.get(id)?.path.length ?? 0) > 0;
  }

  // ---------- points of interest ----------

  private buildPois(state: RenderState) {
    const sig = state.map.pois.map((p) => `${p.id}:${p.cleared}:${p.tier ?? ""}`).join("|");
    if (sig === this.poiSig) return;
    this.poiSig = sig;
    this.poiGroup.clear();
    /** Chimney tops, which the ambience draws smoke from. */
    const stacks: THREE.Vector3[] = [];
    for (const poi of state.map.pois) {
      const g = this.poiModel(poi);
      const at = this.standAt(poi.pos);
      g.position.set(at.x, at.y, at.z - 0.28);
      g.traverse((o) => {
        // A glow is light, not a solid: it neither casts nor takes a shadow.
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = !o.userData.glow;
      });
      this.poiGroup.add(g);
      if (g.userData.smoke) stacks.push((g.userData.smoke as THREE.Vector3).clone().add(g.position));
    }
    this.ambience.setSmoke(stacks);
    // The sea breaks around rocks standing out of it, and the wreck on them.
    this.ambience.setSeaRocks(state.map.pois.filter((p) => p.kind === "rocks" || p.kind === "wreck").map((p) => this.standAt(p.pos)));
  }

  /** Furniture: rebuilt whenever a piece is added, moved, turned or selected. */
  private buildProps(state: RenderState) {
    const props = state.props ?? [];
    const sig = props.map((p) => `${p.id}:${p.model}:${key(p.pos)}:${p.facing}:${p.selected ? 1 : 0}:${p.x ?? 0}:${p.z ?? 0}:${p.angle ?? 0}:${p.on ?? ""}`).join("|");
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
      } else {
        const at = this.standAt(prop.pos);
        g.position.set(at.x + (prop.x ?? 0), at.y, at.z + (prop.z ?? 0));
        g.rotation.y = prop.small ? -(prop.angle ?? 0) : -(prop.facing * Math.PI) / 3;
        this.propGroup.add(g);
      }
      g.userData.surface = prop.surface;
      this.propModels.set(prop.id, g);
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.userData.propId = prop.id;
        // Flames give light rather than block it; glass lets it through.
        if (o.userData.flame !== undefined) flames.push(o);
        else if (!o.userData.glass) o.castShadow = o.receiveShadow = true;
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
      if (prop.selected) {
        const [inner, outer] = prop.small ? [0.18, 0.24] : [0.8, 0.95];
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 6), new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide, depthTest: !prop.small }));
        ring.rotation.x = -Math.PI / 2;
        ring.rotation.z = Math.PI / 6;
        ring.position.copy(g.getWorldPosition(new THREE.Vector3())).setY(g.getWorldPosition(new THREE.Vector3()).y + 0.03);
        ring.renderOrder = 2;
        this.propGroup.add(ring);
      }
    }
    this.ambience.setLights(lights, flames);
  }

  // ---------- carrying a piece: the ghost that follows the pointer ----------

  /** The ghost of whatever is being carried, rebuilt when that changes. */
  private updateGhost() {
    const holding = this.state?.holding ?? null;
    const sig = holding ? holding.model : "";
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
    if (holding.small) {
      // A top first: aimed at, the thing stands on it, kept inside its edges.
      const top = this.raycaster.intersectObjects(this.surfaces, false)[0];
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
    const pos = { q: t.q, r: t.r };
    if (!holding.small) return { pos, x: 0, z: 0 };
    const mid = hexToWorld(pos);
    let x = hit.point.x - mid.x;
    let z = hit.point.z - mid.z;
    const d = Math.hypot(x, z);
    if (d > SMALL_REACH) [x, z] = [(x / d) * SMALL_REACH, (z / d) * SMALL_REACH];
    return { pos, x: round(x), z: round(z) };
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
    if (base) {
      const t = base.userData.surface as NonNullable<SceneProp["surface"]>;
      ghost.position.copy(base.localToWorld(new THREE.Vector3(target.x, t.y + 0.004, target.z)));
      // Props only ever turn about the vertical, so the support's yaw is all there is to add.
      ghost.rotation.y = new THREE.Euler().setFromQuaternion(base.getWorldQuaternion(new THREE.Quaternion()), "YXZ").y - holding.angle;
    } else {
      const at = this.standAt(target.pos);
      ghost.position.set(at.x + target.x, at.y + 0.004, at.z + target.z);
      ghost.rotation.y = holding.small ? -holding.angle : -(holding.facing * Math.PI) / 3;
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
    // Small things are stepped over.
    const blocked = new Set(state.props.filter((p) => !p.small && p.on === undefined).map((p) => key(p.pos)));
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
        add(box(1.0, 0.08, 0.5), lambert("#8a6a44"), 0, 0.05, 0.1);
        // The party's ship, moored just offshore to the west.
        add(box(1.1, 0.32, 0.5), lambert("#6b4a2b"), -1.5, -0.05, 0.3);
        add(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 5), lambert("#4a3520"), -1.5, 0.6, 0.3);
        add(box(0.05, 0.6, 0.55), lambert("#f4efe1"), -1.42, 0.75, 0.3);
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
      case "cache":
        add(box(0.38, 0.24, 0.26), lambert(poi.cleared ? "#6b6b6b" : "#9a6b2f"), 0, 0.12, 0.2);
        if (!poi.cleared) add(box(0.4, 0.05, 0.28), lambert("#e0b12e"), 0, 0.26, 0.2);
        break;
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
        // The pub: a long hall, wider and taller than any hut, with lit windows, a sign and a stone chimney.
        const wall = lambert("#b89668");
        const roof = lambert("#5d3a2a");
        add(box(1.5, 0.72, 0.95), wall, 0, 0.36, 0);
        add(box(1.62, 0.08, 1.07), lambert("#4a2f22"), 0, 0.76, 0);
        const ridge = add(new THREE.ConeGeometry(0.78, 0.6, 4), roof, 0, 1.1, 0, Math.PI / 4);
        ridge.scale.x = 1.5;
        add(box(0.22, 0.36, 0.04), lambert("#4a2f22"), 0, 0.18, 0.48);
        for (const x of [-0.48, 0.48]) add(box(0.2, 0.2, 0.03), new THREE.MeshBasicMaterial({ color: "#ffd98a" }), x, 0.42, 0.48);
        // A sign on a bracket by the door.
        add(box(0.04, 0.04, 0.3), lambert("#3a2c22"), 0.26, 0.62, 0.62);
        add(box(0.03, 0.2, 0.26), lambert("#d9b45a"), 0.26, 0.48, 0.66);
        // The chimney stands proud of the roof; its smoke is drawn by the ambience.
        add(box(0.24, 1.3, 0.24), lambert("#8b8f96"), 0.5, 0.65, -0.22);
        add(box(0.3, 0.07, 0.3), lambert("#6f737a"), 0.5, 1.33, -0.22);
        g.userData.smoke = new THREE.Vector3(0.5, 1.4, -0.22);
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
        const stone = lambert("#b9b4a8");
        if (poi.cleared) {
          // The lighthouse: a tapering white tower with a red band, a gallery and a lit lamp.
          add(new THREE.CylinderGeometry(0.5, 0.56, 0.22, 8), stone, 0, 0.11, 0);
          add(new THREE.CylinderGeometry(0.3, 0.42, 0.7, 8), lambert("#f4efe1"), 0, 0.57, 0);
          add(new THREE.CylinderGeometry(0.25, 0.3, 0.35, 8), lambert("#b9433d"), 0, 1.095, 0);
          add(new THREE.CylinderGeometry(0.21, 0.25, 0.4, 8), lambert("#f4efe1"), 0, 1.47, 0);
          add(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 8), lambert("#4a4458"), 0, 1.7, 0);
          add(new THREE.CylinderGeometry(0.15, 0.15, 0.24, 6), new THREE.MeshBasicMaterial({ color: "#ffd23f" }), 0, 1.85, 0);
          add(new THREE.ConeGeometry(0.26, 0.24, 8), lambert("#8c3b2f"), 0, 2.09, 0);
          add(box(0.16, 0.28, 0.04), lambert("#5a3d22"), 0, 0.36, 0.41);
          // Tall enough to stand over the huts when seen from the tilted camera.
          g.scale.y = 1.3;
        } else {
          // A building site: the first course of the foundation, scaffold poles, planks and a crate.
          add(new THREE.CylinderGeometry(0.5, 0.56, 0.16, 8), stone, 0, 0.08, 0);
          for (const [x, z] of [[-0.42, -0.3], [0.42, -0.3], [-0.42, 0.34], [0.42, 0.34]]) add(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 5), lambert("#7a5230"), x, 0.47, z);
          add(box(0.9, 0.04, 0.05), lambert("#8a6a44"), 0, 0.62, -0.3);
          add(box(0.9, 0.04, 0.05), lambert("#8a6a44"), 0, 0.62, 0.34);
          add(box(0.05, 0.04, 0.68), lambert("#8a6a44"), -0.42, 0.9, 0.02);
          add(box(0.05, 0.04, 0.68), lambert("#8a6a44"), 0.42, 0.9, 0.02);
          add(box(0.34, 0.14, 0.26), stone, -0.08, 0.23, 0.05, 0.3);
          for (let i = 0; i < 3; i++) add(box(0.6, 0.05, 0.14), lambert(i % 2 ? "#a07a4c" : "#8a6a44"), 0.72, 0.03 + i * 0.05, 0.3, 0.25 * i);
          add(box(0.24, 0.22, 0.24), lambert("#9a6b2f"), -0.72, 0.11, 0.35, 0.4);
        }
        break;
      }
      case "apothecary":
      case "smithy": {
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
          add(box(0.3, 0.18, 0.03), lambert(poi.kind === "apothecary" ? "#4f8a4a" : "#4a4f5a"), 0.4, 0.46, 0.64);
          // A pile of planks, squared stones, and the trade's own makings: sacks of herbs, or iron bars.
          for (let i = 0; i < 3; i++) add(box(0.5, 0.05, 0.12), lambert(i % 2 ? "#c9a877" : "#8a6a44"), -0.2, 0.03 + i * 0.05, -0.05 + i * 0.02, 0.15 * i);
          for (const [x, y, z] of [[0.25, 0.08, -0.05], [0.38, 0.08, 0.1], [0.3, 0.22, 0.02]]) add(box(0.16, 0.14, 0.16), lambert("#959eac"), x, y, z, 0.3);
          if (poi.kind === "apothecary") {
            for (const [x, z] of [[-0.25, 0.3], [0.05, 0.35]]) add(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 6), lambert("#c9b37a"), x, 0.11, z);
            for (const [x, z] of [[-0.25, 0.3], [0.05, 0.35]]) add(new THREE.SphereGeometry(0.09, 5, 4), lambert("#5f9e4a"), x, 0.25, z);
          } else {
            for (let i = 0; i < 4; i++) add(box(0.32, 0.05, 0.07), lambert(i < 2 ? "#6f737a" : "#c8743a"), -0.1 + (i % 2) * 0.08, 0.03 + Math.floor(i / 2) * 0.05, 0.32, 0.2);
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

    if (poi?.kind === "camp") {
      // A raiders' camp: two tents, a fire ringed with stones, crates.
      for (const [x, z, r] of [[-2.0, -2.6, 0.3], [1.7, -2.9, -0.4]]) put(new THREE.ConeGeometry(0.85, 1.1, 4), "#8a7a5a", x, 0.55, z, Math.PI / 4 + r);
      put(new THREE.ConeGeometry(0.22, 0.5, 5), "#ff9b3d", 0, 0.25, -2.4);
      for (let i = 0; i < 6; i++) put(new THREE.DodecahedronGeometry(0.11, 0), "#6d6960", Math.sin(i) * 0.42, 0.06, -2.4 + Math.cos(i) * 0.42);
      put(new THREE.BoxGeometry(0.5, 0.42, 0.5), "#9a6b2f", 3.0, 0.21, -0.9, 0.4);
      put(new THREE.BoxGeometry(0.36, 0.3, 0.36), "#8a6a44", -3.1, 0.15, 0.2, 0.9);
    } else if (poi?.kind === "lair") {
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
    } else {
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
            size: isBoss(c.kind) ? 2.5 : c.kind === "brute" ? 2.2 : 1.9,
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
        pos.x += (i - (n - 1) / 2) * 0.6;
        pos.z += 0.25;
        const plate = plateOf(h);
        const label = h.label ?? (plate ? h.name : undefined);
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
          want.set(`roam:${band.id}:${i}`, { kind, pos, size: 1.3, ring: i === 0 ? "#ff3b3b" : undefined, pulse: i === 0 });
        });
      }
      for (const poi of state.map.pois) {
        if (poi.cleared || poi.enemies.length === 0) continue;
        poi.enemies.forEach((kind, i) => {
          const pos = this.standAt(poi.pos);
          pos.x += (i - (poi.enemies.length - 1) / 2) * 0.6 + 0.2;
          pos.z += 0.05;
          want.set(`poi:${poi.id}:${i}`, { kind, pos, size: isBoss(kind) ? 1.7 : kind === "brute" ? 1.5 : 1.3 });
        });
      }
    }

    for (const [id, unit] of this.units) {
      const w = want.get(id);
      // A change of gear is a different sprite, so the unit is rebuilt.
      if (w && spriteKey(w.kind, w.outfit, w.asleep) === unit.kind) continue;
      this.unitGroup.remove(unit.sprite, unit.caster);
      unit.caster.material instanceof THREE.Material && unit.caster.material.dispose();
      unit.caster.customDepthMaterial?.dispose();
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
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture(w.kind, w.outfit, w.asleep), transparent: true, alphaTest: 0.5, depthTest: false }));
        // Drawn over the scenery, so nobody is lost inside a building or behind a tree.
        sprite.renderOrder = 2;
        sprite.center.set(0.5, 0);
        sprite.position.copy(w.pos);
        const caster = new THREE.Mesh(CASTER_PLANE, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, map: sprite.material.map, alphaTest: 0.5 }));
        caster.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sprite.material.map, alphaTest: 0.5, side: THREE.DoubleSide });
        caster.castShadow = true;
        this.unitGroup.add(sprite, caster);
        unit = { sprite, caster, ring: null, hpBack: null, hpFill: null, label: null, labelText: "", goal: w.pos.clone(), path: [], kick: new THREE.Vector3(), lean: 0, baseRot: 0, stride: 0, bob: 0, kind: spriteKey(w.kind, w.outfit, w.asleep), asleep: false, nextZ: 0, zCount: 0, glowUntil: 0, glowing: false, head: w.size + 0.3, stack: 0, feet: w.pos.clone() };
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
      unit.caster.scale.copy(unit.sprite.scale);
      unit.caster.visible = !w.down && !w.asleep;
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

  /** The hero (a figure in `state.heroes`, yourself included) under the pointer, by their figure or their plate. Never in a fight. */
  private pickHero(): string | null {
    const state = this.state;
    if (!state || state.battle || state.holding) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    const owner = new Map<THREE.Object3D, string>();
    for (const h of state.heroes) {
      const u = this.units.get(h.id);
      if (!u || !u.sprite.visible) continue;
      for (const o of [u.sprite, u.label]) {
        if (!o) continue;
        targets.push(o);
        owner.set(o, h.id);
      }
    }
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? (owner.get(hit.object) ?? null) : null;
  }

  private pick(): HexPos | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // A figure stands up out of its hex, so a click on it would otherwise land on the ground behind.
    // Clicking someone (other than yourself) means the hex they stand on.
    if (!this.state?.battle) {
      const others = [...this.units.entries()].filter(([id, u]) => id !== this.state?.you && u.sprite.visible);
      const onFigure = this.raycaster.intersectObjects(others.map(([, u]) => u.sprite), false)[0];
      const unit = onFigure && others.find(([, u]) => u.sprite === onFigure.object)?.[1];
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
    if (e.key === "q" || e.key === "Q") this.rotateBy(-1);
    else if (e.key === "e" || e.key === "E") this.rotateBy(1);
    else if (e.key === "r" || e.key === "R") this.tiltBy(0.18, true);
    else if (e.key === "f" || e.key === "F") this.tiltBy(-0.18, true);
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

  private panBy(dx: number, dy: number) {
    if (this.state?.battle) return;
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
      this.panBy(now.x - this.pinch.x, now.y - this.pinch.y);
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
        else this.panBy(dx, dy);
      }
    } else {
      this.pointer.dirty = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    this.touches.delete(e.pointerId);
    if (this.touches.size >= 1) {
      // One finger of a pinch lifted: carry on panning with the other, without a jump.
      this.pinch = null;
      const [rest] = [...this.touches.values()];
      this.pointer.x = rest.x;
      this.pointer.y = rest.y;
      return;
    }
    this.pinch = null;
    // A right-click, or a Shift/Alt click, is the start of a turn, not an order to walk.
    const wasClick = this.pointer.down && !this.pointer.dragged && !this.rotating && e.type === "pointerup";
    this.pointer.down = false;
    if (!wasClick) return;
    if (this.state?.holding && this.callbacks.onPlace) {
      const target = this.aim();
      if (target) this.callbacks.onPlace(target);
      return;
    }
    if (this.callbacks.onHeroClick) {
      const hero = this.pickHero();
      // Opening someone's sheet is all a click on them does: nobody walks off as well.
      if (hero !== null && this.callbacks.onHeroClick(hero)) return;
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
    if (this.hoverHero !== null) this.callbacks.onHeroHover?.((this.hoverHero = null));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Shift and the wheel turn whatever is being carried, a notch at a time.
    if (e.shiftKey && this.state?.holding && this.callbacks.onTurnHeld) {
      const now = performance.now();
      if (now - this.lastTurn > 90 && Math.abs(e.deltaY || e.deltaX) > 0) {
        this.lastTurn = now;
        this.callbacks.onTurnHeld((e.deltaY || e.deltaX) > 0 ? 1 : -1);
      }
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private camDist = 24;
  private lastTurn = 0;

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    const ease = 1 - Math.exp(-dt * 6);

    if (this.pointer.dirty && this.pointer.inside) {
      this.pointer.dirty = false;
      this.setHovered(this.pick());
      if (this.state?.holding) this.placeGhost();
      if (this.callbacks.onHeroHover) {
        // Your own figure walks to wherever the pointer clicked, so it is not hovered: a click opens your sheet instead.
        const picked = this.pickHero();
        const hero = picked === this.state?.you ? null : picked;
        if (hero !== this.hoverHero) this.callbacks.onHeroHover((this.hoverHero = hero));
      }
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
    this.ambience.update(this.clock, this.yaw, this.target);
    if (this.state?.indoors) this.lowerNearWalls();

    // The height of one view pixel, in the units an unattenuated sprite is sized in.
    const labelRow = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.height;
    for (const [id, unit] of this.units) {
      const p = unit.sprite.position;
      // The hop is drawn on top of where the unit really is; take it off before moving.
      p.y -= unit.bob;
      if (unit.path.length > 0) {
        const next = unit.path[0].clone();
        next.z += 0.25;
        const step = 4.2 * dt;
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
      p.y += unit.bob;
      unit.caster.position.copy(p);
      unit.caster.rotation.y = this.ambience.towardLight(p.x, p.z);
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

    this.renderer.render(this.scene, this.camera);
  };
}
