// Fishing, played in the Harbor itself: the camera orbits down to the end of
// a pier and looks out to sea through the hero's eyes, with a rod in their
// hands. One button does everything:
//
//   - hold to wind up a cast, let go to throw it (longer is further out);
//   - press when the float goes under to set the hook (not on a nibble);
//   - then fight: tap while the fish runs, hold while it rests to reel.
//
// The fight runs here as it will on the server (fishfight.ts, 50 ms a tick),
// from the presses as they happen; when it ends they are reported whole and
// the server plays them again. The rod bends with the tension on the line,
// the line runs out to where the fish is, and the fish can be seen running
// (a wake), resting (a shadow under the surface) and jumping.

import * as THREE from "three";
import {
  FIGHT_MAX_EDGES,
  FIGHT_TICK_MS,
  FISH_SPOTS,
  LINE_M,
  castMetres,
  fightTick,
  pressureAt,
  startFight,
  type CaughtFish,
  type FightEase,
  type FightMode,
  type FightOutcome,
  type FightScript,
  type FightState,
  type FishSpot,
  type Vessel,
} from "@gantt-quest/world";
import { audio } from "../audio/engine";
import { soundName } from "../audio/names";
import { OVERLAY_LAYER } from "./post";
import { catchModel } from "./catchArt";
import { addWaterRipple } from "./water";
import type { WorldMinigame, WorldRenderer } from "./WorldRenderer";

export type FishPhase = "arrive" | "idle" | "charging" | "casting" | "waiting" | "fighting" | "landing" | "landed" | "leaving";

/** What the HUD shows, every frame. */
export interface FishHud {
  phase: FishPhase;
  /** How far the cast is wound up, 0 to 1. */
  charge: number;
  /** Line tension, 1 is breaking; the fish's strength, 1 fresh; how much line is out, 1 is all of it. */
  tension: number;
  strength: number;
  lineOut: number;
  mode: FightMode | null;
  /** The button is down, and the pressure it is putting on. */
  held: boolean;
  pressure: number;
}

export interface FishHooks {
  /** The phase changed (the HUD's panels follow it). */
  phase(p: FishPhase): void;
  hud(h: FishHud): void;
  /** The cast was let go: ask the server for what is down there. */
  cast(power: number): void;
  /** A press while the float was out, `at` ms after the cast landed (as the server's reply arrived). */
  strike(at: number, hooked: boolean): void;
  /** The fight is over here: report its presses. */
  fought(edges: number[], outcome: FightOutcome): void;
  /** The bite came and went with no press. */
  missed(): void;
  /** The camera is back over the map: the stage can come down. */
  left(): void;
}

export interface CastInfo {
  power: number;
  metres: number;
  biteMs: number;
  nibbles: number[];
  windowMs: number;
  script: FightScript;
}

/** World units to a metre of line. A cast of 35 m lands a little over two hexes out. */
const M = 0.15;
const EYE = 0.62;
/** The open sea's surface, beyond the map's own water hexes (which stand a little higher). */
const SEA_Y = 0.1;
const FOV = 55;
/** Seconds to orbit down to the pier and back up. */
const IN_S = 1.6;
const OUT_S = 1.2;
/** A full wind-up for a cast. */
const CHARGE_MS = 1200;
/** The cast's flight. */
const FLIGHT_S = 0.75;
/** The rod: segments from the grip to the tip, and its length in the view. */
const SEGMENTS = 9;
const ROD_LEN = 1.25;
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const UP = new THREE.Vector3(0, 1, 0);

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  size: number;
}

export class FishingStage implements WorldMinigame {
  private inT = 0;
  private close = 0;
  private leaving = false;
  private disposed = false;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private stopTick: () => void;
  private clock = 0;

  private phase: FishPhase = "arrive";
  private held = false;
  private chargeAt = 0;
  private charge = 0;
  /** The cast in flight: from the rod tip out to where it lands. */
  private flight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private castPower = 0;
  /** The line in the water: when the server's reply came, and what it said. */
  private wait: { at: number; info: CastInfo; struck: boolean } | null = null;
  /** The fight under way, timed from the hook. */
  private fight: { at: number; state: FightState; prev: FightState; edges: number[]; script: FightScript; ease: FightEase; reported: boolean } | null = null;
  /** Where the fish is, across the line of the cast (world units), and which way it is heading. */
  private lateral = 0;
  private drift = 1;
  private lastRipple = 0;

  // The view.
  private readonly pierEnd: THREE.Vector3;
  private readonly fwd: THREE.Vector3;
  private readonly right: THREE.Vector3;
  private readonly look = new THREE.Vector3();
  private shake = 0;

  // The rod, held in front of the eye on the overlay layer.
  private readonly rod = new THREE.Group();
  private readonly joints: THREE.Group[] = [];
  private readonly tip = new THREE.Object3D();
  private readonly reelHandle = new THREE.Group();
  private bend = 0;
  private bendSide = 0;
  private whip = 0;

  // In the world.
  private readonly line: THREE.Line;
  private readonly linePos: Float32Array;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly float: THREE.Group;
  private readonly shadow: THREE.Mesh;
  private readonly rings: Ring[] = [];
  private jumper: THREE.Group | null = null;
  /** A landed catch, held up in front of the eye. */
  private shown: { obj: THREE.Group; t: number; species: string; going: "keep" | "release" | null } | null = null;

  constructor(
    private world: WorldRenderer,
    private group: THREE.Group,
    private spot: FishSpot,
    seaward: THREE.Vector3,
    private hooks: FishHooks,
    /** Afloat in this boat; null on a pier or the shore. */
    private boat: Vessel | null = null,
  ) {
    this.fwd = seaward.clone().setY(0).normalize();
    this.right = new THREE.Vector3().crossVectors(this.fwd, UP).normalize();
    // Stand at the very end of the pier.
    // Stand at the very end of the pier; afloat, sit in the middle of the boat.
    this.pierEnd = boat ? group.position.clone() : group.position.clone().addScaledVector(this.fwd, 0.45);
    this.look.copy(this.pierEnd).addScaledVector(this.fwd, 6).setY(SEA_Y + 0.2);

    this.buildRod();
    world.addObject(this.rod);

    const N = 32;
    this.linePos = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3));
    this.lineMat = new THREE.LineBasicMaterial({ color: "#e8eef2", transparent: true, opacity: 0.85 });
    this.line = new THREE.Line(geo, this.lineMat);
    this.line.frustumCulled = false;
    this.line.visible = false;
    // The line and the float are small and far off: with fancy graphics the finishing pass would blur and haze
    // them away. On the overlay layer they are drawn after it, crisp, as name plates are (and the same without it).
    this.line.layers.set(OVERLAY_LAYER);
    this.line.renderOrder = 998;
    this.lineMat.depthTest = false;
    world.addObject(this.line);

    this.float = new THREE.Group();
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#d8352a" }));
    const bottom = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#f4f1e8" }));
    const quill = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.05, 4), new THREE.MeshBasicMaterial({ color: "#2a2018" }));
    quill.position.y = 0.05;
    this.float.add(top, bottom, quill);
    for (const m of [top, bottom, quill]) {
      m.layers.set(OVERLAY_LAYER);
      m.renderOrder = 999;
      (m.material as THREE.Material).depthTest = false;
    }
    this.float.visible = false;
    world.addObject(this.float);

    this.shadow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: "#0b1820", transparent: true, opacity: 0.55, depthWrite: false }));
    this.shadow.scale.set(0.12, 0.02, 0.05);
    this.shadow.visible = false;
    world.addObject(this.shadow);

    this.stopTick = world.addTicker((dt, camera, clock) => this.tick(dt, camera, clock));
  }

  // ---------- the rod ----------

  /** A tapered rod in segments, each a joint the next hangs from, so it can bend along its length; a reel and two hands at the grip. */
  private buildRod() {
    const cork = new THREE.MeshBasicMaterial({ color: "#b8875a" });
    const blank = new THREE.MeshBasicMaterial({ color: "#3a2a1c" });
    const wrap = new THREE.MeshBasicMaterial({ color: "#8a2a24" });
    const metal = new THREE.MeshBasicMaterial({ color: "#9aa4ae" });
    const skin = new THREE.MeshBasicMaterial({ color: "#d9a27a" });
    const sleeve = new THREE.MeshBasicMaterial({ color: "#4a5a6a" });
    const seg = ROD_LEN / SEGMENTS;
    let parent: THREE.Object3D = this.rod;
    for (let i = 0; i < SEGMENTS; i++) {
      const joint = new THREE.Group();
      if (i > 0) joint.position.y = seg;
      const r0 = 0.018 * (1 - i / SEGMENTS) + 0.003;
      const r1 = 0.018 * (1 - (i + 1) / SEGMENTS) + 0.003;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, seg, 6), i === 0 ? cork : blank);
      mesh.position.y = seg / 2;
      joint.add(mesh);
      if (i > 1 && i % 2 === 0) {
        const guide = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.003, 4, 8), wrap);
        // Stood up off the rod, the ring square to it, so the line runs through.
        guide.rotation.x = Math.PI / 2;
        guide.position.set(0, seg * 0.5, -r0 - 0.012);
        joint.add(guide);
      }
      parent.add(joint);
      this.joints.push(joint);
      parent = joint;
    }
    this.tip.position.y = seg;
    parent.add(this.tip);

    // The reel under the grip, and its handle that spins as line comes in.
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), metal);
    reel.rotation.z = Math.PI / 2;
    reel.position.set(0, 0.16, 0.055);
    this.reelHandle.position.set(0.025, 0.16, 0.055);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.05, 0.006), metal);
    arm.position.y = 0.025;
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.02, 6), cork);
    knob.rotation.z = Math.PI / 2;
    knob.position.set(0.012, 0.05, 0);
    this.reelHandle.add(arm, knob);
    this.joints[0].add(reel, this.reelHandle);

    // One hand, round the grip.
    const hand = (x: number, y: number, z: number) => {
      const g = new THREE.Group();
      const fist = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.055, 0.045), skin);
      const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.1, 0.055), sleeve);
      cuff.position.set(0.015, -0.07, 0.035);
      g.add(fist, cuff);
      g.position.set(x, y, z);
      return g;
    };
    this.joints[0].add(hand(0, 0.06, 0));

    this.rod.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.layers.set(OVERLAY_LAYER);
        o.renderOrder = 1000;
        o.frustumCulled = false;
        (o.material as THREE.Material).depthTest = false;
      }
    });
    this.rod.visible = false;
  }

  /** Hold the rod at the bottom right of the view, bent by the line. */
  private poseRod(camera: THREE.PerspectiveCamera, dt: number) {
    this.rod.visible = this.close > 0.85 && !this.leaving;
    if (!this.rod.visible) return;
    this.rod.position.copy(camera.position);
    this.rod.quaternion.copy(camera.quaternion);
    const arrive = clamp01((this.close - 0.85) / 0.15);
    const base = this.rod.children[0] as THREE.Group;
    // Wound back over the shoulder while charging; whipped forward on the throw.
    const windup = this.phase === "charging" ? this.charge : 0;
    this.whip = Math.max(0, this.whip - dt * 2.6);
    const lift = this.fight ? 0.15 * (this.held ? 1 : 0.4) : 0;
    // Over to the right, but on screen however narrow it is (a phone held upright).
    const halfWide = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * 0.55;
    base.position.set(Math.min(0.3, halfWide * 0.75), -0.33 - 0.25 * (1 - arrive) + lift * 0.1, -0.55);
    base.rotation.set(-1.22 + 0.95 * windup - 0.5 * this.whip + lift, 0.1, 0.26);
    base.scale.setScalar(0.72);
    // The bend: most of it near the tip, toward the fish.
    const goal = this.fight ? Math.min(1.25, this.fight.state.T) : this.wait ? 0.06 : 0;
    this.bend += (goal - this.bend) * Math.min(1, dt * 12);
    const sideGoal = this.fight ? Math.max(-1, Math.min(1, this.lateral / Math.max(0.5, this.fight.state.D * M * 0.6))) : 0;
    this.bendSide += (sideGoal - this.bendSide) * Math.min(1, dt * 4);
    const tremble = this.fight && this.fight.state.T > 0.85 ? (Math.random() - 0.5) * 0.02 : 0;
    for (let i = 1; i < SEGMENTS; i++) {
      const k = (i / SEGMENTS) ** 1.6;
      this.joints[i].rotation.set(-(this.bend * 0.55 + this.whip * 0.2) * k + tremble, 0, -this.bendSide * this.bend * 0.25 * k);
    }
    // Line coming in turns the handle.
    if (this.fight && this.fight.state.D < this.fight.prev.D) this.reelHandle.rotation.x -= dt * 18 * this.fight.state.T + dt * 10;
    this.rod.updateMatrixWorld(true);
  }

  // ---------- the boat ----------

  /** The boat's edge along the bottom of the view: a barrel's rim, or a rowboat's gunwales and bow. */
  private hull: THREE.Group | null = null;

  private buildHull(): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshBasicMaterial({ color: "#7a5a3a" });
    const dark = new THREE.MeshBasicMaterial({ color: "#4a3322" });
    const iron = new THREE.MeshBasicMaterial({ color: "#5a5e66" });
    if (this.boat === "barrel") {
      // The rim of the barrel, round in front of the eye, with an iron hoop.
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 5, 24, Math.PI), wood);
      rim.rotation.x = Math.PI / 2;
      rim.rotation.z = Math.PI;
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.012, 4, 24, Math.PI), iron);
      hoop.rotation.x = Math.PI / 2;
      hoop.rotation.z = Math.PI;
      hoop.position.y = -0.04;
      g.add(rim, hoop);
      g.position.set(0, -0.3, -0.05);
    } else {
      // The two gunwales running forward to the bow, with a thwart across.
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 1.3), wood);
        side.position.set(s * 0.42, 0, -0.5);
        side.rotation.y = -s * 0.32;
        g.add(side);
      }
      const bow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), dark);
      bow.position.set(0, 0.02, -1.12);
      const thwart = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.12), dark);
      thwart.position.set(0, -0.05, -0.35);
      g.add(bow, thwart);
      g.position.set(0, -0.36, 0);
    }
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.layers.set(OVERLAY_LAYER);
        o.renderOrder = 995;
        o.frustumCulled = false;
        (o.material as THREE.Material).depthTest = false;
      }
    });
    const outer = new THREE.Group();
    outer.add(g);
    this.world.addObject(outer);
    return outer;
  }

  private poseHull(camera: THREE.PerspectiveCamera) {
    if (!this.boat) return;
    this.hull ??= this.buildHull();
    this.hull.visible = this.close > 0.85 && !this.leaving;
    this.hull.position.copy(camera.position);
    this.hull.quaternion.copy(camera.quaternion);
  }

  // ---------- input ----------

  pressDown() {
    if (this.held) return;
    this.held = true;
    const now = performance.now();
    if (this.phase === "idle") {
      this.chargeAt = now;
      this.charge = 0;
      this.setPhase("charging");
    } else if (this.phase === "waiting" && this.wait && !this.wait.struck) {
      const at = Math.round(now - this.wait.at);
      const info = this.wait.info;
      const hooked = at >= info.biteMs && at <= info.biteMs + info.windowMs;
      this.wait.struck = true;
      this.hooks.strike(at, hooked);
      if (hooked) this.startFight(now, info);
      else {
        // Struck at nothing: wind in and start again.
        this.reelIn();
      }
    } else if (this.fight) this.edge(now);
  }

  pressUp() {
    if (!this.held) return;
    this.held = false;
    const now = performance.now();
    if (this.phase === "charging") {
      this.castPower = clamp01((now - this.chargeAt) / CHARGE_MS);
      this.throwCast();
    } else if (this.fight) this.edge(now);
  }

  /** A press or release in the fight, timed from the hook. Rounded up, so it can never fall on a tick already played. */
  private edge(now: number) {
    const f = this.fight!;
    if (f.state.outcome || f.edges.length >= FIGHT_MAX_EDGES) return;
    const ms = Math.max(f.edges.at(-1) ?? 0, Math.ceil(now - f.at));
    f.edges.push(ms);
  }

  // ---------- the cast ----------

  private throwCast() {
    this.setPhase("casting");
    this.whip = 1;
    const reach = this.castPower * FISH_SPOTS[this.spot].maxCast;
    const to = this.onWater(this.pierEnd.clone().addScaledVector(this.fwd, castMetres(reach) * M));
    this.flight = { from: this.tipWorld(), to, t: 0 };
    this.float.scale.setScalar(1);
    this.float.visible = true;
    audio.play(soundName.fishing("cast"));
    this.hooks.cast(this.castPower);
  }

  /** The server has said what is down there: the clock to the bite starts now. */
  beginWait(info: CastInfo) {
    if (this.phase !== "casting" && this.phase !== "waiting") return;
    this.wait = { at: performance.now(), info, struck: false };
    const at = this.onWater(this.pierEnd.clone().addScaledVector(this.fwd, info.metres * M));
    if (!this.flight) this.float.position.copy(at);
    else this.flight.to.copy(at);
    this.setPhase("waiting");
  }

  private startFight(now: number, info: CastInfo) {
    const state = startFight(info.script);
    this.fight = { at: now, state, prev: state, edges: this.held ? [0] : [], script: info.script, ease: this.ease, reported: false };
    this.lateral = 0;
    this.drift = Math.random() < 0.5 ? -1 : 1;
    this.float.visible = false;
    this.ring(this.float.position, 0.25, 0.9);
    this.shake = 1;
    audio.play(soundName.fishing("bite"));
    this.setPhase("fighting");
  }

  /** The hero's Strength and Dexterity, as the fight uses them. Set by the HUD from the sitting. */
  ease: FightEase = { str: 0.5, dex: 0.5 };

  /** Give up whatever is on the go (the server refused it) and go back to holding the rod. */
  reset() {
    this.flight = null;
    this.wait = null;
    this.fight = null;
    this.float.visible = false;
    this.shadow.visible = false;
    this.line.visible = false;
    this.dropJumper();
    if (this.phase !== "leaving" && this.phase !== "arrive") this.setPhase(this.shown ? "landed" : "idle");
  }

  private reelIn() {
    this.wait = null;
    this.float.visible = false;
    this.line.visible = false;
    this.setPhase("idle");
  }

  // ---------- landing ----------

  /** The server has it landed: swing it up and hold it in front of the eye. */
  land(fish: CaughtFish) {
    this.fight = null;
    this.shadow.visible = false;
    this.dropJumper();
    this.line.visible = false;
    if (this.shown) this.disposeShown();
    const obj = catchModel(fish);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.layers.set(OVERLAY_LAYER);
        o.renderOrder = 1005;
        o.frustumCulled = false;
        (o.material as THREE.Material).depthTest = false;
      }
    });
    this.world.addObject(obj);
    this.shown = { obj, t: 0, species: fish.species, going: null };
    this.ring(this.onWater(this.pierEnd.clone().addScaledVector(this.fwd, 0.6)), 0.2, 0.7);
    audio.play(soundName.fishing("land"));
    this.setPhase("landed");
  }

  /** Put the landed catch away: into the creel, or back over the side. */
  stow(how: "keep" | "release") {
    if (!this.shown) return;
    this.shown.going = how;
    this.shown.t = 0;
    if (how === "release") audio.play(soundName.fishing("plop"));
  }

  // ---------- the camera ----------

  frame(dt: number, _now: number): { eye: THREE.Vector3; look: THREE.Vector3; blend: number; fov: number } {
    const inS = this.still ? 0.2 : IN_S;
    const outS = this.still ? 0.2 : OUT_S;
    this.inT = this.leaving ? Math.max(0, this.inT - dt / outS) : Math.min(1, this.inT + dt / inS);
    this.close = smoother(this.inT);
    if (this.leaving && this.inT <= 0) setTimeout(() => this.finish(), 0);
    if (!this.leaving && this.phase === "arrive" && this.inT >= 1) this.setPhase(this.shown ? "landed" : "idle");
    const eye = this.pierEnd.clone().setY(this.group.position.y + (this.boat === "barrel" ? 0.34 : this.boat ? 0.4 : EYE));
    // During a fight the eye follows the fish a little.
    const goal = this.pierEnd.clone().addScaledVector(this.fwd, 6).setY(SEA_Y + 0.25);
    if (this.fight) goal.lerp(this.fishAt(), 0.35);
    this.look.lerp(goal, Math.min(1, dt * 3));
    return { eye, look: this.look.clone(), blend: this.close, fov: FOV };
  }

  /** Fly back out to the map, then take the stage down and give the view back. */
  leave() {
    if (this.leaving) return;
    this.leaving = true;
    this.setPhase("leaving");
  }

  private finish() {
    if (this.disposed) return;
    this.dispose();
    this.hooks.left();
    if (this.world.playing === this) this.world.endMinigame();
  }

  private setPhase(p: FishPhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.hooks.phase(p);
  }

  get current(): FishPhase {
    return this.phase;
  }

  // ---------- each frame ----------

  /** The water's surface at a point: a water hex's top, or the open sea's. */
  private surfaceAt(x: number, z: number): number {
    const g = this.world.groundAt(x, z);
    return g && g.biome === "water" ? g.top : SEA_Y;
  }

  /** `p` set down on the water. */
  private onWater(p: THREE.Vector3, lift = 0): THREE.Vector3 {
    return p.setY(this.surfaceAt(p.x, p.z) + lift);
  }

  private tipWorld(): THREE.Vector3 {
    return this.tip.getWorldPosition(new THREE.Vector3());
  }

  /** Where the fish is in the water: out along the cast by the line it has taken, and off to the side it ran. */
  private fishAt(): THREE.Vector3 {
    const D = this.fight ? this.fight.state.D : 0;
    return this.onWater(this.pierEnd.clone().addScaledVector(this.fwd, D * M).addScaledVector(this.right, this.lateral));
  }

  private tick(dt: number, camera: THREE.PerspectiveCamera, clock: number) {
    if (this.disposed) return;
    this.clock = clock;
    const now = performance.now();
    if (this.phase === "charging") this.charge = clamp01((now - this.chargeAt) / CHARGE_MS);

    // The cast in the air.
    if (this.flight) {
      this.flight.t += dt / FLIGHT_S;
      const t = Math.min(1, this.flight.t);
      const p = this.flight.from.clone().lerp(this.flight.to, t);
      p.y += Math.sin(Math.PI * t) * 0.9 * this.flight.from.distanceTo(this.flight.to) * 0.25;
      this.float.position.copy(p);
      if (t >= 1) {
        this.flight = null;
        this.ring(this.float.position, 0.12, 0.8);
        addWaterRipple(this.float.position.x, this.float.position.z);
        audio.play(soundName.fishing("plop"));
      }
    }

    // The float, bobbing; dipping on a nibble, going under on the bite.
    if (this.wait && !this.flight) {
      const ms = now - this.wait.at;
      const info = this.wait.info;
      let dip = Math.sin(clock * 2.1) * 0.006;
      for (const n of info.nibbles) {
        const d = ms - n;
        if (d >= 0 && d < 260) dip -= Math.sin((d / 260) * Math.PI) * 0.03;
        if (d >= 0 && d < 30 && !this.nibbled.has(n)) {
          this.nibbled.add(n);
          this.ring(this.float.position, 0.06, 0.5);
          audio.play(soundName.fishing("nibble"));
        }
      }
      const bite = ms - info.biteMs;
      if (bite >= 0) {
        if (!this.bitten) {
          this.bitten = true;
          this.ring(this.float.position, 0.18, 0.7);
          addWaterRipple(this.float.position.x, this.float.position.z);
          audio.play(soundName.fishing("plunge"));
        }
        dip -= Math.min(0.09, bite / 120 * 0.09);
      }
      this.float.position.y = this.surfaceAt(this.float.position.x, this.float.position.z) + 0.01 + dip;
      // Drawn over the water (see the constructor), so going under is shown by shrinking out of sight.
      this.float.scale.setScalar(bite >= 0 ? Math.max(0.3, 1 - bite / 220) : 1);
      this.float.visible = bite < info.windowMs + 400;
      if (!this.wait.struck && bite > info.windowMs + 250) {
        this.wait = null;
        this.hooks.missed();
        this.reelIn();
      }
    } else {
      this.nibbled.clear();
      this.bitten = false;
    }

    // The fight: play every tick that has passed, as the server will.
    const f = this.fight;
    if (f && !f.state.outcome) {
      const elapsed = now - f.at;
      while (!f.state.outcome && elapsed > f.state.t) {
        f.prev = f.state;
        f.state = fightTick(f.state, f.script, f.ease, pressureAt(f.edges, f.state.t));
        this.moveFish(f.state, f.prev);
      }
      if (f.state.outcome && !f.reported) {
        f.reported = true;
        const landed = f.state.outcome === "landed";
        audio.play(soundName.fishing(landed ? "reel" : "snap"));
        if (!landed) {
          this.line.visible = false;
          this.shadow.visible = false;
          this.dropJumper();
          if (f.state.outcome === "snapped") this.shake = 1.4;
        }
        this.setPhase(landed ? "landing" : "idle");
        this.hooks.fought(f.edges.slice(), f.state.outcome);
        if (!landed) this.fight = null;
      }
    }
    this.drawFish(dt);

    // The eye: a slow sway, and a jolt on the strike or a snap.
    if (this.close > 0.98) {
      this.shake = Math.max(0, this.shake - dt * 3);
      const tense = this.fight ? Math.max(0, this.fight.state.T - 0.8) * 0.01 : 0;
      camera.position.x += Math.sin(clock * 0.7) * 0.004 + (Math.random() - 0.5) * (this.shake * 0.01 + tense);
      camera.position.y += Math.sin(clock * 1.3) * 0.003 + (Math.random() - 0.5) * (this.shake * 0.01 + tense);
      // Afloat, the swell lifts and rolls the boat (a barrel more than a rowboat).
      if (this.boat && !this.still) {
        const k = this.boat === "barrel" ? 1.6 : 1;
        camera.position.y += Math.sin(clock * 0.9) * 0.02 * k;
        camera.rotateZ(Math.sin(clock * 0.75) * 0.03 * k);
        camera.rotateX(Math.sin(clock * 0.55 + 1) * 0.015 * k);
      }
      camera.updateMatrixWorld();
    }
    this.poseHull(camera);

    this.poseRod(camera, dt);
    this.drawLine();
    this.poseShown(camera, dt);
    this.stepRings(dt);

    const s = this.fight?.state;
    this.hooks.hud({
      phase: this.phase,
      charge: this.charge,
      tension: s?.T ?? 0,
      strength: s?.S ?? 0,
      lineOut: s ? s.D / LINE_M : 0,
      mode: s?.mode ?? null,
      held: this.held,
      pressure: this.fight ? pressureAt(this.fight.edges, now - this.fight.at) : 0,
    });
  }

  private nibbled = new Set<number>();
  private bitten = false;

  /** Steer the fish across the water as it runs, and leave a wake. */
  private moveFish(s: FightState, prev: FightState) {
    const dt = FIGHT_TICK_MS / 1000;
    if (s.mode === "run" || s.mode === "shake") {
      // A run heads off to one side; now and then it turns.
      if (s.seg !== prev.seg && Math.random() < 0.4) this.drift = -this.drift;
      const reach = Math.max(0.6, s.D * M * 0.5);
      this.lateral = Math.max(-reach, Math.min(reach, this.lateral + this.drift * dt * 0.35 * (0.4 + s.S)));
    } else {
      this.lateral *= 1 - dt * 0.15;
    }
    if (s.mode === "jump" && prev.mode !== "jump") this.jump();
  }

  private drawFish(dt: number) {
    const f = this.fight;
    if (!f || f.state.outcome && f.state.outcome !== "landed") {
      this.shadow.visible = false;
      return;
    }
    const at = this.fishAt();
    const s = f.state;
    const running = s.mode === "run" || s.mode === "shake";
    // A wake behind a running fish; a shadow under a resting one, plainer the nearer it is.
    if (running && this.clock - this.lastRipple > 0.18) {
      this.lastRipple = this.clock;
      addWaterRipple(at.x, at.z);
      this.ring(at, 0.08 + 0.1 * s.T, 0.6);
    }
    const near = clamp01(1 - s.D / 25);
    this.shadow.visible = !this.jumper && (!running || near > 0.5);
    this.shadow.position.copy(at).setY(at.y + 0.004);
    const len = 0.1 + 0.25 * near;
    this.shadow.scale.set(len, 0.02, len * 0.4);
    const heading = running ? this.fwd.clone().multiplyScalar(1).addScaledVector(this.right, this.drift * 0.6) : this.fwd.clone().negate();
    this.shadow.rotation.y = Math.atan2(heading.x, heading.z) + Math.PI / 2;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.4 * near;
    if (this.jumper) {
      const j = this.jumper.userData as { t: number };
      j.t += dt / 0.8;
      const t = Math.min(1, j.t);
      this.jumper.position.copy(at).setY(at.y + Math.sin(Math.PI * t) * 0.45);
      this.jumper.rotation.set(0, Math.atan2(this.right.x, this.right.z) * this.drift, (0.5 - t) * 1.8 * this.drift);
      if (t >= 1) {
        this.ring(at, 0.25, 0.8);
        audio.play(soundName.fishing("plop"));
        this.dropJumper();
      }
    }
  }

  /** It throws itself out of the water: a dark fish shape, no colours until it is landed. */
  private jump() {
    if (this.jumper || !this.fight) return;
    const at = this.fishAt();
    this.ring(at, 0.22, 0.8);
    audio.play(soundName.fishing("splash"));
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: "#1c2a33" }));
    body.scale.set(0.22, 0.07, 0.05);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 4), body.material);
    tail.rotation.z = Math.PI / 2;
    tail.position.x = -0.14;
    g.add(body, tail);
    g.userData = { t: 0 };
    this.jumper = g;
    this.world.addObject(g);
  }

  private dropJumper() {
    if (!this.jumper) return;
    this.world.removeObject(this.jumper);
    disposeTree(this.jumper);
    this.jumper = null;
  }

  /** The line, from the rod tip to the float or the fish: slack sags, tight runs straight. */
  private drawLine() {
    const target = this.fight && (!this.fight.state.outcome || this.fight.state.outcome === "landed") ? (this.jumper ? this.jumper.position : this.fishAt()) : this.float.visible ? this.float.position : null;
    this.line.visible = !!target && this.rod.visible;
    if (!target || !this.line.visible) return;
    const a = this.tipWorld();
    const b = target;
    const tension = this.fight ? Math.min(1, this.fight.state.T) : 0.15;
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= (1 - tension) * Math.min(0.6, a.distanceTo(b) * 0.12);
    const n = this.linePos.length / 3;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const u = 1 - t;
      this.linePos[i * 3] = u * u * a.x + 2 * u * t * mid.x + t * t * b.x;
      this.linePos[i * 3 + 1] = u * u * a.y + 2 * u * t * mid.y + t * t * b.y;
      this.linePos[i * 3 + 2] = u * u * a.z + 2 * u * t * mid.z + t * t * b.z;
    }
    (this.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    // White, warming to red as it nears breaking.
    const hot = clamp01((tension - 0.7) / 0.3);
    this.lineMat.color.setRGB(0.91 + 0.09 * hot, 0.93 - 0.6 * hot, 0.95 - 0.65 * hot);
  }

  /** A landed catch held up in front of the eye, swinging; then lowered into the creel or tossed back. */
  private poseShown(camera: THREE.PerspectiveCamera, dt: number) {
    const sh = this.shown;
    if (!sh) return;
    sh.t += dt;
    sh.obj.visible = this.close > 0.85 && !this.leaving;
    sh.obj.position.copy(camera.position);
    sh.obj.quaternion.copy(camera.quaternion);
    const inner = sh.obj.children[0];
    const up = Math.min(1, sh.t / 0.5);
    let y = -0.45 + 0.45 * smoother(up);
    let x = 0;
    if (sh.going) {
      const g = Math.min(1, sh.t / 0.45);
      if (sh.going === "keep") y -= 0.6 * g * g;
      else {
        y += 0.15 * Math.sin(Math.PI * g) - 0.5 * g * g;
        x = -0.1 * g;
      }
      if (g >= 1) {
        this.disposeShown();
        if (this.phase === "landed") this.setPhase("idle");
        return;
      }
    }
    inner.position.set(x, y + 0.02, -0.7);
    inner.rotation.set(0, Math.sin(sh.t * 1.7) * 0.25, Math.sin(sh.t * 2.3) * 0.12);
  }

  private disposeShown() {
    if (!this.shown) return;
    this.world.removeObject(this.shown.obj);
    disposeTree(this.shown.obj);
    this.shown = null;
  }

  /** A ring opening on the water. */
  private ring(at: THREE.Vector3, size: number, life: number) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 24), new THREE.MeshBasicMaterial({ color: "#e6f2f6", transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(at).setY(this.surfaceAt(at.x, at.z) + 0.012);
    mesh.scale.setScalar(size * 0.3);
    this.world.addObject(mesh);
    this.rings.push({ mesh, t: 0, life, size });
  }

  private stepRings(dt: number) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt / r.life;
      r.mesh.scale.setScalar(r.size * (0.3 + 0.9 * r.t));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - r.t);
      if (r.t >= 1) {
        this.world.removeObject(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    for (const obj of [this.rod, this.line, this.float, this.shadow, ...(this.hull ? [this.hull] : [])]) {
      this.world.removeObject(obj);
      disposeTree(obj);
    }
    this.dropJumper();
    this.disposeShown();
    for (const r of this.rings) {
      this.world.removeObject(r.mesh);
      disposeTree(r.mesh);
    }
    this.rings.length = 0;
  }
}

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) m.dispose();
  });
}
