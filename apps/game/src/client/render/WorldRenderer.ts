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
import { BATTLE_JOIN_RANGE, ENEMIES, MOVE_COST, findPath, reachable, tileAt, type ClientState, type Outfit, type Phase, type Poi, type Tile, type WorldEvent, type WorldMap } from "@gantt-quest/world";
import { propModel } from "./props";
import { SPRITE_ASPECT, fxTexture, labelTexture, spriteKey, spriteTexture, textTexture, type FxKind } from "./sprites";

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
  heroes: { id: string; classId: string; pos: HexPos; label?: string; outfit?: Outfit }[];
  turn: { heroId: string; mp: number } | null;
  battle: ClientState["battle"];
  story: { npcs: { id: string; poi: string }[] } | null;
  npcs: Record<string, { hostile: boolean }>;
  /** No turns or movement points: the viewer may walk anywhere reachable, and tiles are not lit. */
  freeRoam?: boolean;
  /** Furniture standing on hexes (a hut's room). Each blocks the hex it is on. */
  props?: SceneProp[];
  /** Inside a building: no sea or sky around the map, and the camera starts closer. */
  indoors?: boolean;
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
const BIOME_COLOR: Record<string, string> = { plains: "#7cb856", forest: "#4c9a52", hills: "#a39672", water: "#3f86dc", dock: "#9a7748", floor: "#b08a5c", wall: "#6e5a48" };

export function hexToWorld(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

const tileTop = (t: Tile | undefined) => (!t ? 0.2 : t.biome === "water" ? 0.14 : 0.35 + t.h * 1.1);
const key = (p: HexPos) => `${p.q},${p.r}`;
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
}

interface Want {
  kind: string;
  /** Draw the unit wearing this instead of its kind's stock look. */
  outfit?: Outfit;
  pos: THREE.Vector3;
  size: number;
  label?: string;
  ring?: string;
  pulse?: boolean;
  hp?: number;
  down?: boolean;
}

interface Floater {
  sprite: THREE.Sprite;
  age: number;
}

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
}

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
  private sea: THREE.Mesh;
  private unitGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  /** Red outlines around the hexes close enough to join a fight at each camp or lair. */
  private rangeGroup = new THREE.Group();
  private rangeSig = "";
  private hoverRing: THREE.Mesh;
  private arena: THREE.Mesh;
  private units = new Map<string, Unit>();
  private pulsing = new Set<string>();
  private floaters: Floater[] = [];
  private fx: Fx[] = [];
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

    this.arena = new THREE.Mesh(
      new THREE.CylinderGeometry(3.8, 4.1, 1.6, 24),
      new THREE.MeshLambertMaterial({ color: "#3b3550", flatShading: true }),
    );
    this.arena.visible = false;
    this.arena.receiveShadow = true;

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
    if (first) this.buildTerrain(state);
    this.state = state;
    this.buildPois(state);
    this.buildProps(state);
    this.buildJoinRanges(state);
    if (first) {
      this.sea.visible = !state.indoors;
      (this.scene.background as THREE.Color).set(state.indoors ? "#1d1a2b" : "#a9dcf7");
      if (state.indoors) this.userDist = this.camDist = 15;
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
  playEvents(events: WorldEvent[]) {
    let beat = 0;
    for (const ev of events) {
      if (ev.t === "moved") {
        const unit = this.units.get(ev.heroId);
        if (unit) unit.path = ev.path.map((p) => this.standAt(p));
      } else if (ev.t === "battle") {
        const b = ev.ev;
        if (b.t === "hit") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, b.perfect, () => this.float(b.target, `-${b.amount}`, b.perfect ? "#ffd23f" : "#ff6b6b")));
        else if (b.t === "miss") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, false, () => this.float(b.target, "miss", "#c9d1e0")));
        else if (b.t === "heal") this.later(beat++, () => { this.sparkle(b.target, "#7dff9a"); this.float(b.target, `+${b.amount}`, "#7dff9a"); });
        else if (b.t === "tick") this.later(beat++, () => this.float(b.target, `-${b.amount}`, "#ffa94d"));
      }
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
  private attack(actorId: string, targetId: string, ability: string, perfect: boolean, onImpact: () => void) {
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
        onImpact();
      } });
      return;
    }
    // Melee: step in and swipe across the target.
    this.lunge(actorId, targetId);
    this.spawnFx("slash", perfect ? "#ffd23f" : "#dfe9ff", flip, { from: hitAt, to: hitAt, life: 0.26, size: [1.3, 2.3], spin: -dir * 0.9, fade: true });
    onImpact();
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

  private float(unitId: string, text: string, color: string) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(text, color), transparent: true, depthTest: false }));
    sprite.renderOrder = 8;
    sprite.scale.set(1.2, 0.45, 1);
    sprite.position.copy(unit.sprite.position).add(new THREE.Vector3(0, unit.sprite.scale.y + 0.5, 0));
    sprite.renderOrder = 10;
    this.fxGroup.add(sprite);
    this.floaters.push({ sprite, age: 0 });
  }

  // ---------- terrain ----------

  private buildTerrain(state: RenderState) {
    this.mapCode = state.code;
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
    this.tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t);
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(1, tileTop(t), 1));
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
    this.ambience.build(
      this.tiles,
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
    instanced(new THREE.ConeGeometry(0.34, 0.9, 5), "#2f7a3d", trees);

    // Start centred on the island.
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
      c.offsetHSL(0, 0, (noise(t.q, t.r, 9) - 0.5) * 0.06);
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

  // ---------- points of interest ----------

  private buildPois(state: RenderState) {
    const sig = state.map.pois.map((p) => `${p.id}:${p.cleared}:${p.tier ?? ""}`).join("|");
    if (sig === this.poiSig) return;
    this.poiSig = sig;
    this.poiGroup.clear();
    for (const poi of state.map.pois) {
      const g = this.poiModel(poi);
      const at = this.standAt(poi.pos);
      g.position.set(at.x, at.y, at.z - 0.28);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
      });
      this.poiGroup.add(g);
    }
  }

  /** Furniture: rebuilt whenever a piece is added, moved, turned or selected. */
  private buildProps(state: RenderState) {
    const props = state.props ?? [];
    const sig = props.map((p) => `${p.id}:${p.model}:${key(p.pos)}:${p.facing}:${p.selected ? 1 : 0}`).join("|");
    if (sig === this.propSig) return;
    this.propSig = sig;
    this.propGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.propGroup.clear();
    for (const prop of props) {
      const g = propModel(prop.model);
      const at = this.standAt(prop.pos);
      g.position.copy(at);
      g.rotation.y = -(prop.facing * Math.PI) / 3;
      this.propGroup.add(g);
      if (prop.selected) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 6), new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.rotation.z = Math.PI / 6;
        ring.position.set(at.x, at.y + 0.03, at.z);
        this.propGroup.add(ring);
      }
    }
  }

  /** Cost of stepping onto a tile: the terrain's, except that furniture cannot be walked through. */
  private stepCost(state: RenderState): ((t: Tile) => number) | undefined {
    if (!state.props?.length) return undefined;
    const blocked = new Set(state.props.map((p) => key(p.pos)));
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
      const actor = state.battle.order[state.battle.turn];
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
        want.set(h.id, { kind: h.classId, outfit: h.outfit, pos, size: 1.5, label: h.label, ring: colorOf(h.id), pulse: state.turn?.heroId === h.id });
      }
      for (const npc of state.story?.npcs ?? []) {
        const poi = state.map.pois.find((p) => p.id === npc.poi);
        if (!poi || state.npcs[npc.id]?.hostile) continue;
        const pos = this.standAt(poi.pos);
        pos.x += 0.62;
        want.set(`npc:${npc.id}`, { kind: "npc", pos, size: 1.4 });
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
      if (w && spriteKey(w.kind, w.outfit) === unit.kind) continue;
      this.unitGroup.remove(unit.sprite, unit.caster);
      unit.caster.material instanceof THREE.Material && unit.caster.material.dispose();
      unit.caster.customDepthMaterial?.dispose();
      if (unit.ring) this.unitGroup.remove(unit.ring);
      if (unit.hpBack) this.unitGroup.remove(unit.hpBack);
      if (unit.hpFill) this.unitGroup.remove(unit.hpFill);
      this.dropLabel(unit);
      this.units.delete(id);
    }
    this.pulsing.clear();
    for (const [id, w] of want) {
      let unit = this.units.get(id);
      if (!unit) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture(w.kind, w.outfit), transparent: true, alphaTest: 0.5, depthTest: false }));
        // Drawn over the scenery, so nobody is lost inside a building or behind a tree.
        sprite.renderOrder = 2;
        sprite.center.set(0.5, 0);
        sprite.position.copy(w.pos);
        const caster = new THREE.Mesh(CASTER_PLANE, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, map: sprite.material.map, alphaTest: 0.5 }));
        caster.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sprite.material.map, alphaTest: 0.5, side: THREE.DoubleSide });
        caster.castShadow = true;
        this.unitGroup.add(sprite, caster);
        unit = { sprite, caster, ring: null, hpBack: null, hpFill: null, label: null, labelText: "", goal: w.pos.clone(), path: [], kick: new THREE.Vector3(), lean: 0, baseRot: 0, stride: 0, bob: 0, kind: spriteKey(w.kind, w.outfit) };
        this.units.set(id, unit);
      }
      unit.goal.copy(w.pos);
      unit.sprite.scale.set(w.size * SPRITE_ASPECT, w.size, 1);
      unit.caster.scale.copy(unit.sprite.scale);
      unit.caster.visible = !w.down;
      const mat = unit.sprite.material;
      unit.baseRot = w.down ? Math.PI / 2 : 0;
      mat.opacity = w.down ? 0.55 : 1;
      unit.sprite.center.set(0.5, w.down ? 0.5 : 0);

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

      if ((w.label ?? "") !== unit.labelText) {
        this.dropLabel(unit);
        unit.labelText = w.label ?? "";
        if (w.label) {
          const { texture, aspect } = labelTexture(w.label);
          // A fixed size on screen, whatever the zoom: each pixel of the label lands on exactly one pixel of the view.
          unit.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
          // Held a third of its own height clear of the head, at any zoom.
          unit.label.center.set(0.5, -0.35);
          unit.label.userData.aspect = aspect;
          unit.label.userData.rows = texture.image.height;
          unit.label.userData.lift = w.size + 0.3;
          unit.label.renderOrder = 7;
          this.unitGroup.add(unit.label);
        }
      }

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
    if (!state || !hovered || state.battle) return;
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

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    const ease = 1 - Math.exp(-dt * 6);

    if (this.pointer.dirty && this.pointer.inside) {
      this.pointer.dirty = false;
      this.setHovered(this.pick());
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
    const sunTurn = Math.atan2(this.ambience.sunDir.x, this.ambience.sunDir.z);
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
      p.y += unit.bob;
      unit.caster.position.copy(p);
      unit.caster.rotation.y = sunTurn;
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
      if (unit.hpBack && unit.hpFill) {
        const lift = unit.hpBack.userData.lift ?? 2;
        unit.hpBack.position.set(p.x - 0.6, ground + lift, p.z);
        unit.hpFill.position.set(p.x - 0.57, ground + lift, p.z);
      }
    }

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

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      f.sprite.position.y += dt * 1.4;
      f.sprite.material.opacity = Math.max(0, 1 - f.age / 1.0);
      if (f.age >= 1.0) {
        this.fxGroup.remove(f.sprite);
        f.sprite.material.map?.dispose();
        f.sprite.material.dispose();
        this.floaters.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  };
}
