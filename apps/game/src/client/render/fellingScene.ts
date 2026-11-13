// Felling, played in the Harbor through the hero's eyes (rules in
// packages/world/src/felling.ts). A WorldMinigame: the world renderer swings
// its camera down into this one's and hands it the presses and keys.
//
// Two rounds of thirty seconds. Chopping faces three trees, small to large,
// left to right, stood on open land round the felling spot (the scene reads
// the map to find where: along the tree line if it can, never over the water
// or into a building). Splitting turns to a chopping block, facing the town
// if there is room. Everything a round does is
// timed from its start and kept, to report to the server when it ends; the
// same rules the server replays it by (swing speed, regrowth, the marker over
// each log) are applied here first, so what you see is what is paid.

import * as THREE from "three";
import { FELL_ROUND_MS, GATHER_MAX_UNITS, NEXT_LOG_MS, REGROW_MS, SWING_MS, TREES, TREE_SLOTS, markerAt, splitGrade, splitWood, type Chop, type Motion, type SplitGrade } from "@gantt-quest/world";
import { audio } from "../audio/engine";
import { soundName } from "../audio/names";
import type { WorldMinigame } from "./WorldRenderer";
import { fxTexture, type FxKind } from "./sprites";

export type FellingMode = "arrive" | "intro-chop" | "chop" | "chop-over" | "intro-split" | "split" | "split-over" | "leaving";

/** What the panel shows over the view. */
export interface FellingHud {
  mode: FellingMode;
  /** Time left in the round under way. */
  leftMs: number;
  /** The tree a space or Enter chops. */
  current: number;
  trees: { done: number; need: number; growing: boolean }[];
  felled: number;
  logsLeft: number;
  struck: Record<SplitGrade, number>;
  /** Wood on the pile so far this round, of at most `pileMax`. */
  pile: number;
  pileMax: number;
  /** The last strike, for the pop over the view: `n` counts strikes, so each is a new pop. */
  pop: { n: number; grade: SplitGrade; wood: number } | null;
  /** The marker over the log on the block, for the bar under the view: its motion and when it started (performance.now). */
  marker: { motion: Motion; startedAt: number } | null;
}

/** What is under a point of the map (world units): its biome, the height of its top, and whether something stands on that hex. */
export type GroundAt = (x: number, z: number) => { biome: string; top: number; poi: boolean } | null;

export interface FellingHooks {
  hud(h: FellingHud): void;
  /** A round has run its time (or every log is split): what it did, to report. */
  chopped(chops: Chop[]): void;
  split(strikes: number[]): void;
  /** The camera is back in the usual view: the game can be taken down. */
  left(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 0.64;
/** How far in front the trees stand, and how far apart. */
const TREE_DIST = 1.9;
const TREE_GAP = 0.62;
/** How far off the chopping block stands, and how far you step toward it to split. */
const BLOCK_DIST = 1.15;
const BLOCK_STEP = 0.45;
/** How far off the line of the split the axe's handle comes in, from the right (radians). */
const SPLIT_YAW = 0.35;
/** The log on the block: its radius, and how far across its face the marker sweeps (end to end). */
const LOG_R = 0.11;
const SWEEP = 0.19;
/** Half the view's width, at least, whatever the shape of the window: the three trees always fit across it. */
const HALF_WIDTH = THREE.MathUtils.degToRad(26);
/** How long the camera takes to swing in, turn round to the block, and swing back out. */
const ARRIVE_S = 1.9;
const TURN_S = 1.1;
const LEAVE_S = 1.4;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** The axe, from the grip: the handle's length, where the head sits up it, how far out the edge is, and its size in the view. */
const AXE_LEN = 0.38;
const AXE_HEAD = 0.345;
const AXE_EDGE = 0.1;
const AXE_SCALE = 0.85;
/** How long a swing takes, and how much of it is the blow (the rest is bringing the axe back). */
const SWING_S = 0.3;
const STRIKE_PART = 0.35;
/** How a swing goes, 0 at rest to 1 at the blow: quick down, slower back. */
function swingCurve(t: number): number {
  if (t < 0) return 0;
  const u = t / SWING_S;
  if (u < STRIKE_PART) return (u / STRIKE_PART) ** 2;
  return 1 - easeInOut((u - STRIKE_PART) / (1 - STRIKE_PART));
}

interface TreeObj {
  root: THREE.Group;
  body: THREE.Group;
  trunk: Trunk;
  ring: THREE.Mesh;
  bar: THREE.Mesh;
  done: number;
  /** performance.now() when it came down; it stands again REGROW_MS later. */
  fellAt: number;
  shake: number;
}

interface Bit {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  floor: number;
}

const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** Where the axe bites, up the trunk, and the pale wood a cut shows. */
const CUT_Y = 0.12;
const HEARTWOOD = new THREE.Color("#ecd096");
/** The cut's upper face, in its own shadow. */
const HEARTWOOD_SHADE = new THREE.Color("#a07a45");

/**
 * A trunk that takes a felling cut: a many-sided column, tapering, whose ring
 * of corners at the height of the cut is pulled in on the side facing you, so
 * the chops open a V into it, pale wood inside, deeper with every chop.
 */
class Trunk {
  readonly mesh: THREE.Mesh;
  private rows: { y: number; r: number }[];
  private bark: THREE.Color;
  private frontAngle: number;
  private depth = -1;

  constructor(rBottom: number, rTop: number, height: number, private sides: number, bark: string, front: THREE.Vector3) {
    const half = rBottom * 0.7;
    this.rows = [0, CUT_Y - half, CUT_Y, CUT_Y + half, height].map((y) => ({ y, r: THREE.MathUtils.lerp(rBottom, rTop, y / height) }));
    this.bark = new THREE.Color(bark);
    this.frontAngle = Math.atan2(front.z, front.x);
    const tris = (this.rows.length - 1) * sides * 2 * 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(tris * 3), 3));
    this.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.mesh.castShadow = true;
    this.cut(0);
  }

  /** How far through the cut is, 0 (none) to 1 (the most a felling notch goes). */
  cut(frac: number) {
    const depth = Math.max(0, Math.min(1, frac));
    if (depth === this.depth) return;
    this.depth = depth;
    const n = this.sides;
    // How much each corner of the cut ring faces you: 1 straight on, 0 from the sides round the back, so the cut is
    // a notch in the front and not a band round the trunk.
    const facing = Array.from({ length: n }, (_, j) => Math.max(0, (Math.cos((j / n) * Math.PI * 2 - this.frontAngle) - 0.3) / 0.7));
    const at = (i: number, j: number) => {
      const row = this.rows[i];
      const a = ((j % n) / n) * Math.PI * 2;
      const r = i === 2 ? row.r * (1 - 0.85 * depth * facing[j % n]) : row.r;
      return [Math.cos(a) * r, row.y, Math.sin(a) * r];
    };
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    let v = 0;
    const tri = (corners: [number, number][], c: THREE.Color) => {
      for (const [i, j] of corners) {
        pos.setXYZ(v, ...(at(i, j) as [number, number, number]));
        col.setXYZ(v, c.r, c.g, c.b);
        v++;
      }
    };
    for (let i = 0; i < this.rows.length - 1; i++) {
      for (let j = 0; j < n; j++) {
        // Either face of the V, where its corner on the cut ring has been pulled in.
        const open = depth > 0 && (i === 1 || i === 2) && (facing[j] > 0 || facing[(j + 1) % n] > 0);
        const c = !open ? this.bark : i === 1 ? HEARTWOOD : HEARTWOOD_SHADE;
        tri([[i, j], [i + 1, j], [i, j + 1]], c);
        tri([[i, j + 1], [i + 1, j], [i + 1, j + 1]], c);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

/** A tree for a slot, its trunk facing `front` (the way you look at it from, in its own space). */
function treeModel(size: (typeof TREE_SLOTS)[number], front: THREE.Vector3): { body: THREE.Group; height: number; trunk: Trunk } {
  const body = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: string, y: number) => {
    const m = new THREE.Mesh(geo, lambert(color));
    m.position.y = y;
    m.castShadow = true;
    body.add(m);
    return m;
  };
  const trunk = (rTop: number, rBottom: number, height: number, sides: number, bark: string) => {
    const t = new Trunk(rBottom, rTop, height, sides, bark, front);
    body.add(t.mesh);
    return t;
  };
  if (size === "small") {
    const t = trunk(0.03, 0.04, 0.3, 6, "#7a5230");
    add(new THREE.ConeGeometry(0.17, 0.32, 6), "#4f9a46", 0.42);
    add(new THREE.ConeGeometry(0.12, 0.24, 6), "#5cad4f", 0.58);
    return { body, height: 0.72, trunk: t };
  }
  if (size === "medium") {
    const t = trunk(0.045, 0.06, 0.5, 6, "#d6cfbf");
    add(new THREE.IcosahedronGeometry(0.26, 1), "#86b84a", 0.66);
    add(new THREE.IcosahedronGeometry(0.18, 1), "#9cc957", 0.9);
    return { body, height: 1.08, trunk: t };
  }
  const t = trunk(0.075, 0.1, 0.7, 7, "#5e3f22");
  add(new THREE.IcosahedronGeometry(0.4, 1), "#2f7a3d", 0.95);
  add(new THREE.IcosahedronGeometry(0.28, 1), "#3a8743", 1.2).position.x = 0.15;
  add(new THREE.IcosahedronGeometry(0.26, 1), "#2a6e36", 1.05).position.x = -0.22;
  return { body, height: 1.45, trunk: t };
}

export class FellingScene implements WorldMinigame {
  private mode: FellingMode = "arrive";
  /** 0 the usual view, 1 all the way into this one. */
  private blend = 0;
  /** 0 facing the trees, 1 facing the block. */
  private turn = 0;
  private turnGoal = 0;
  /** Where things stand, in the group's own space (its origin is the middle of the felling hex, on the ground). */
  /** Along the tree line, the way you face to chop; across it to the right; and in toward the town. */
  private out: THREE.Vector3;
  private right: THREE.Vector3;
  private inland: THREE.Vector3;
  private eye: THREE.Vector3;
  private treeLook: THREE.Vector3;
  /** Where the eye is looking while chopping: eased round to the tree being swung at. */
  private aim: THREE.Vector3;
  private blockAt: THREE.Vector3;
  private blockLook: THREE.Vector3;

  private trees: TreeObj[] = [];
  private current = 2;
  private axe: THREE.Group;
  /** Where the split axe's edge comes down: on the marker, or where it last was. */
  private axeOver = new THREE.Vector3();
  /** Seconds into the axe's swing, or -1 at rest. */
  private swingT = -1;
  private bits: Bit[] = [];
  private shake = 0;

  private roundStart = 0;
  private lastSwing = -Infinity;
  private chops: Chop[] = [];
  private felled = 0;

  private block: THREE.Group;
  private pile: THREE.Group;
  private log: THREE.Group | null = null;
  private zone: THREE.Group | null = null;
  private bead: THREE.Mesh;
  private motions: Motion[] = [];
  private logs = 0;
  private logIndex = 0;
  /** When the log on the block was set there, ms into the round; its marker starts then. */
  private logAt = 0;
  private strikes: number[] = [];
  private struck: Record<SplitGrade, number> = { perfect: 0, good: 0, miss: 0 };
  /** Wood on the pile (the server works out the same from the strikes reported). */
  private piled = 0;
  private pop: FellingHud["pop"] = null;
  private hudAt = 0;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private raycaster = new THREE.Raycaster();

  /**
   * `group` stands on the felling hex; `seaward` is the way out of the tree
   * line, away from the town (world space, on the ground); `groundAt` reads
   * the map, so the trees and the block are only ever put on open land.
   */
  constructor(private group: THREE.Group, seaward: THREE.Vector3, private ground: GroundAt, private hooks: FellingHooks) {
    const sea = seaward.clone().setY(0).normalize();
    this.inland = sea.clone().negate();
    this.out = this.chooseFacing(sea);
    this.right = new THREE.Vector3(-this.out.z, 0, this.out.x);
    this.eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
    const origin = new THREE.Vector3();
    this.treeLook = origin.clone().addScaledVector(this.out, TREE_DIST);
    this.treeLook.y = this.heightAt(this.treeLook) + 0.62;
    this.aim = this.treeLook.clone();
    const toBlock = this.chooseBlock();
    this.blockAt = origin.clone().addScaledVector(toBlock, BLOCK_DIST);
    this.blockAt.y = this.heightAt(this.blockAt);
    this.blockLook = this.blockAt.clone().setY(this.blockAt.y + 0.5);
    this.axeOver.copy(this.blockAt).setY(this.blockAt.y + 0.43);
    this.inland = toBlock;

    TREE_SLOTS.forEach((size, slot) => {
      const root = new THREE.Group();
      root.position.copy(this.treeSpot(this.out, slot));
      root.position.y = this.heightAt(root.position);
      const { body, height, trunk } = treeModel(size, this.out.clone().negate());
      root.add(body);
      body.userData.slot = slot;
      body.traverse((o) => (o.userData.slot = slot));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.16 + slot * 0.03, 0.2 + slot * 0.03, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffe27a", transparent: true, opacity: 0.85, depthWrite: false }));
      ring.position.y = 0.02;
      root.add(ring);
      // How far the chopping has got, as a bar over the tree, turned to face you.
      const back = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.035), new THREE.MeshBasicMaterial({ color: "#1d1a14", transparent: true, opacity: 0.7, depthWrite: false }));
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.035).translate(0.16, 0, 0), new THREE.MeshBasicMaterial({ color: "#ffd23f", depthWrite: false }));
      const barAt = new THREE.Group();
      barAt.position.y = height + 0.12;
      barAt.lookAt(barAt.position.clone().sub(this.out));
      bar.position.set(-0.16, 0, 0.001);
      bar.scale.x = 0.001;
      barAt.add(back, bar);
      root.add(barAt);
      group.add(root);
      this.trees.push({ root, body, trunk, ring, bar, done: 0, fellAt: -Infinity, shake: 0 });
    });

    // The chopping block, and the logs waiting beside it.
    this.block = new THREE.Group();
    const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.2, 9), lambert("#6e4b2a"));
    stump.position.y = 0.1;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.01, 9), lambert("#c9a56a"));
    top.position.y = 0.205;
    this.block.add(stump, top);
    this.block.position.copy(this.blockAt);
    this.block.traverse((o) => (o.castShadow = true));
    group.add(this.block);
    this.pile = new THREE.Group();
    const across = new THREE.Vector3(-this.inland.z, 0, this.inland.x);
    this.pile.position.copy(this.blockAt).addScaledVector(across, 0.42).addScaledVector(this.inland, 0.1);
    this.pile.position.y = this.heightAt(this.pile.position);
    group.add(this.pile);
    this.bead = new THREE.Mesh(new THREE.IcosahedronGeometry(0.014, 1), new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false, transparent: true }));
    this.bead.renderOrder = 12;
    this.bead.visible = false;
    group.add(this.bead);

    // Held at the grip (the group's origin): the handle runs up its +Y to the head, and the blade points along +X, so
    // a pose is a basis of (the way the edge faces, the way the handle runs) about the hands.
    this.axe = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.025, AXE_LEN, 0.025), lambert("#8a6a44"));
    handle.position.y = AXE_LEN / 2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.02), lambert("#d9dee6"));
    head.position.set(0.04, AXE_HEAD, 0);
    const poll = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.03), lambert("#9aa1ad"));
    poll.position.set(-0.02, AXE_HEAD, 0);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.085, 0.022), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    edge.position.set(AXE_EDGE, AXE_HEAD, 0);
    this.axe.add(handle, head, poll, edge);
    this.axe.traverse((o) => (o.renderOrder = 11));
    group.add(this.axe);
    this.emit(true);
  }

  // ---------- where things stand ----------

  /** A tree's place, in the group's space, for a facing. */
  private treeSpot(facing: THREE.Vector3, slot: number): THREE.Vector3 {
    const right = new THREE.Vector3(-facing.z, 0, facing.x);
    return new THREE.Vector3().addScaledVector(facing, TREE_DIST + (slot === 1 ? 0.15 : 0)).addScaledVector(right, (slot - 1) * TREE_GAP);
  }

  /** The map under a point in the group's space. */
  private under(p: THREE.Vector3) {
    return this.ground(this.group.position.x + p.x, this.group.position.z + p.z);
  }

  /** Open ground: on the map, not water or a jetty, and no building or spot on that hex (bar this one). */
  private open(p: THREE.Vector3): boolean {
    const g = this.under(p);
    if (!g || g.biome === "water" || g.biome === "dock" || g.biome === "rampart" || g.biome === "rock") return false;
    return !g.poi || Math.hypot(p.x, p.z) < 0.8;
  }

  /** The ground's height at a point, in the group's space (its origin is the felling hex's top). */
  private heightAt(p: THREE.Vector3): number {
    const g = this.under(p);
    return g ? g.top - this.group.position.y : 0;
  }

  /**
   * Which way to face to chop: round the compass in steps, keeping only ways
   * where all three trees, and the ground between, are open; of those, the
   * one with the most forest under the trees, level with this hex, nearest to
   * looking along the tree line rather than out to sea.
   */
  private chooseFacing(sea: THREE.Vector3): THREE.Vector3 {
    let best: { dir: THREE.Vector3; score: number } | null = null;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const spots = [0, 1, 2].map((slot) => this.treeSpot(dir, slot));
      const between = spots.map((p) => p.clone().multiplyScalar(0.5));
      // Room round each trunk too, so no tree hangs over the edge of its hex into the water.
      const round = spots.flatMap((p) => [0, 1, 2, 3, 4, 5].map((k) => p.clone().add(new THREE.Vector3(Math.sin(k * 1.05) * 0.35, 0, Math.cos(k * 1.05) * 0.35))));
      if (![...spots, ...between, ...round].every((p) => this.open(p))) continue;
      let score = 0;
      for (const p of spots) {
        const g = this.under(p)!;
        if (g.biome === "forest") score += 2;
        score -= Math.abs(g.top - this.group.position.y) * 4;
      }
      // Along the coast beats out to sea or in to town.
      score -= Math.abs(dir.dot(sea)) * 1.5;
      if (!best || score > best.score) best = { dir, score };
    }
    return best?.dir ?? sea.clone().negate();
  }

  /** Which way the chopping block lies: open ground, preferably toward the town and not where the trees are. */
  private chooseBlock(): THREE.Vector3 {
    let best: { dir: THREE.Vector3; score: number } | null = null;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      if (!this.open(dir.clone().multiplyScalar(BLOCK_DIST)) || !this.open(dir.clone().multiplyScalar(BLOCK_DIST + 0.5))) continue;
      const score = dir.dot(this.inland) * 2 - Math.max(0, dir.dot(this.out)) * 3;
      if (!best || score > best.score) best = { dir, score };
    }
    return best?.dir ?? this.out.clone().negate();
  }

  // ---------- what the panel calls ----------

  /** Where the game's own trees stand, in world space, and how far round them the wood should be cleared. */
  clearing(): { x: number; z: number; radius: number } {
    const c = this.group.localToWorld(new THREE.Vector3().addScaledVector(this.out, 1.3));
    return { x: c.x, z: c.z, radius: 1.9 };
  }

  /** The camera has swung in (or is swinging in): show the chopping round's instructions. */
  get arrived(): boolean {
    return this.blend >= 1;
  }

  /** Start the chopping round now. */
  startChop() {
    this.mode = "chop";
    this.roundStart = performance.now();
    this.lastSwing = -Infinity;
    this.chops = [];
    this.felled = 0;
    this.emit(true);
  }

  /** Turn round to the block with `logs` logs to split, their markers in order. */
  toSplit(logs: number, motions: Motion[]) {
    this.logs = logs;
    this.motions = motions;
    this.logIndex = 0;
    this.struck = { perfect: 0, good: 0, miss: 0 };
    this.piled = 0;
    this.pop = null;
    this.turnGoal = 1;
    this.mode = "intro-split";
    this.fillPile(logs);
    this.placeLog(false);
    this.emit(true);
  }

  /** Start the splitting round now. */
  startSplit() {
    this.mode = "split";
    this.roundStart = performance.now();
    this.lastSwing = -Infinity;
    this.strikes = [];
    this.logAt = 0;
    this.emit(true);
  }

  /** A button for a tree: chop it. */
  chopAt(slot: number) {
    this.chop(slot);
  }

  /** The Split! button. */
  strikeNow() {
    this.strike();
  }

  /** Another outing: a fresh stand, facing the trees again. */
  reset() {
    this.turnGoal = 0;
    this.mode = "intro-chop";
    this.aim.copy(this.treeLook);
    this.logs = 0;
    this.logIndex = 0;
    this.motions = [];
    this.pendingLog = 0;
    this.placeLog(false);
    this.fillPile(0);
    for (const t of this.trees) {
      t.done = 0;
      t.fellAt = -Infinity;
      t.trunk.cut(0);
    }
    this.current = 2;
    this.emit(true);
  }

  /** Go back to the chopping instructions (a reopened outing that is ready to chop). */
  readyChop() {
    this.mode = "intro-chop";
    this.emit(true);
  }

  /** Done: swing back out to the usual view, then tell the panel. */
  leave() {
    if (this.mode === "leaving") return;
    this.mode = "leaving";
    this.bead.visible = false;
    this.emit(true);
  }

  /** The panel is showing the results. */
  finished() {
    this.mode = "split-over";
    this.bead.visible = false;
    this.emit(true);
  }

  // ---------- the minigame ----------

  frame(dt: number, now: number, aspect: number) {
    if (this.mode === "leaving") {
      this.blend = Math.max(0, this.blend - dt / (this.still ? 0.2 : LEAVE_S));
      if (this.blend === 0) {
        this.mode = "arrive";
        this.hooks.left();
      }
    } else if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / (this.still ? 0.2 : ARRIVE_S));
      if (this.blend === 1 && this.mode === "arrive") {
        this.mode = "intro-chop";
        this.emit(true);
      }
    }
    this.turn += Math.sign(this.turnGoal - this.turn) * Math.min(Math.abs(this.turnGoal - this.turn), dt / (this.still ? 0.2 : TURN_S));

    // The round's clock.
    const ms = now - this.roundStart;
    if (this.mode === "chop" && ms >= FELL_ROUND_MS) {
      this.mode = "chop-over";
      this.emit(true);
      this.hooks.chopped(this.chops);
    }
    if (this.mode === "split" && (ms >= FELL_ROUND_MS || this.logIndex >= this.logs)) {
      this.mode = "split-over";
      this.bead.visible = false;
      this.emit(true);
      this.hooks.split(this.strikes);
    }

    // Swinging at a tree turns your head to it; before the round, and after, you take in all three.
    const current = this.trees[this.current].root.position;
    const facing = this.mode === "chop" ? current.clone().setY(current.y + 0.62).lerp(this.treeLook, 0.15) : this.treeLook;
    this.aim.lerp(facing, this.still ? 1 : 1 - Math.exp(-dt * 7));

    this.stepTrees(dt, now);
    this.stepSplit(now);
    this.stepBits(dt);
    const view = this.view();
    this.stepAxe(dt, view);
    if (now - this.hudAt > 100) this.emit(false, now);

    const eye = this.group.localToWorld(view.eye.clone());
    if (this.shake > 0 && !this.still) {
      eye.x += (Math.random() - 0.5) * this.shake;
      eye.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 0.12);
    }
    // Tall enough to take in the old oak, and wide enough for all three trees however narrow the window.
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(HALF_WIDTH) / Math.max(0.3, aspect))), 50, 92);
    return { eye, look: this.group.localToWorld(view.look.clone()), blend: easeInOut(this.blend), fov };
  }

  press(ndc: THREE.Vector2, camera: THREE.Camera) {
    if (this.mode === "chop") {
      this.raycaster.setFromCamera(ndc, camera);
      const hit = this.raycaster.intersectObjects(this.trees.map((t) => t.body), true)[0];
      this.chop(hit ? (hit.object.userData.slot as number) : this.current);
    } else if (this.mode === "split") this.strike();
  }

  key(e: KeyboardEvent): boolean {
    if (e.repeat) return e.key === " ";
    if (this.mode === "chop") {
      if (e.key === "1" || e.key === "2" || e.key === "3") return this.chop(Number(e.key) - 1), true;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") return this.pick(this.current - 1), true;
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") return this.pick(this.current + 1), true;
      if (e.key === " " || e.key === "Enter") return this.chop(this.current), true;
    }
    if (this.mode === "split" && (e.key === " " || e.key === "Enter")) return this.strike(), true;
    // Keep the camera keys from moving the view behind the game.
    return e.key === " ";
  }

  // ---------- chopping ----------

  private pick(slot: number) {
    this.current = Math.max(0, Math.min(TREE_SLOTS.length - 1, slot));
    this.emit(true);
  }

  /** Swing at a tree. The same limits the server replays by: no quicker than a swing, and not at a tree still growing back. */
  private chop(slot: number) {
    if (this.mode !== "chop") return;
    const now = performance.now();
    const at = Math.round(now - this.roundStart);
    const tree = this.trees[slot];
    this.current = slot;
    if (at - this.lastSwing < SWING_MS || now < tree.fellAt + REGROW_MS || at > FELL_ROUND_MS) {
      this.emit(true);
      return;
    }
    this.lastSwing = at;
    this.chops.push({ slot, at });
    this.swingT = 0;
    tree.done++;
    tree.shake = 0.25;
    const need = TREES[TREE_SLOTS[slot]].chops;
    tree.trunk.cut(tree.done / need);
    for (let i = 0; i < 4; i++) this.bit("fleck", "#e8c88a", tree.root.position.clone().setY(tree.root.position.y + CUT_Y).addScaledVector(this.out, -0.06), new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.8 + Math.random(), (Math.random() - 0.5) * 1.2).addScaledVector(this.out, -0.6), 0.45, 0.05);
    audio.play(soundName.chop("good"));
    if (tree.done >= need) {
      tree.done = 0;
      tree.fellAt = now;
      this.felled++;
      audio.play(soundName.fall("timber"), { delay: 0.25 });
    }
    this.emit(true);
  }

  private stepTrees(dt: number, now: number) {
    const fallAxis = new THREE.Vector3().crossVectors(UP, this.out).normalize();
    this.trees.forEach((t, slot) => {
      const since = now - t.fellAt;
      const growing = since < REGROW_MS;
      if (growing) {
        const fall = Math.min(1, since / 550);
        if (fall < 1) {
          t.body.quaternion.setFromAxisAngle(fallAxis, (Math.PI / 2) * fall * fall);
          t.body.scale.setScalar(1);
        } else {
          // Gone, and a new one rising in its place.
          const rise = Math.min(1, (since - 550) / Math.max(1, REGROW_MS - 550));
          t.body.quaternion.identity();
          t.body.scale.setScalar(Math.max(0.001, rise * rise));
          t.trunk.cut(0);
        }
      } else {
        t.body.scale.setScalar(1);
        t.shake = Math.max(0, t.shake - dt);
        t.body.quaternion.setFromAxisAngle(fallAxis, Math.sin(now / 18) * 0.06 * t.shake);
      }
      const need = TREES[TREE_SLOTS[slot]].chops;
      t.bar.scale.x = Math.max(0.001, growing ? 0 : t.done / need);
      t.ring.visible = this.mode === "chop" || this.mode === "intro-chop" ? slot === this.current : false;
      t.bar.parent!.visible = this.turn < 0.5 && !growing && t.done > 0;
    });
  }

  // ---------- splitting ----------

  private fillPile(n: number) {
    for (const c of [...this.pile.children]) this.pile.remove(c);
    const shown = Math.min(n, 12);
    for (let i = 0; i < shown; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.26, 7), lambert(i % 2 ? "#8a6a44" : "#7a5a36"));
      const layer = Math.floor(i / 4);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = Math.atan2(this.inland.x, this.inland.z);
      log.position.copy(this.inland.clone().multiplyScalar((i % 4) * 0.1 - 0.15 + layer * 0.05)).setY(0.05 + layer * 0.09);
      log.castShadow = true;
      this.pile.add(log);
    }
  }

  /** Stand the next log on the block, with the split marked on its top; `drop` brings it down from above. */
  private placeLog(drop: boolean) {
    if (this.log) this.group.remove(this.log);
    if (this.zone) this.group.remove(this.zone);
    this.log = null;
    this.zone = null;
    if (this.logIndex >= this.logs) return;
    const log = new THREE.Group();
    const wood = new THREE.Mesh(new THREE.CylinderGeometry(LOG_R, LOG_R + 0.005, 0.2, 10), lambert("#8a5a2b"));
    wood.position.y = 0.1;
    const face = new THREE.Mesh(new THREE.CylinderGeometry(LOG_R - 0.004, LOG_R - 0.004, 0.006, 10), lambert("#d9b45a"));
    face.position.y = 0.2;
    log.add(wood, face);
    log.position.copy(this.blockAt).setY(this.blockAt.y + 0.21 + (drop && !this.still ? 0.5 : 0));
    log.traverse((o) => (o.castShadow = true));
    this.group.add(log);
    this.log = log;
    // The mark across the log's face: where the split runs, and its sweet middle.
    const m = this.motions[this.logIndex];
    const zone = new THREE.Group();
    const across = (x: number) => this.blockAt.clone().addScaledVector(this.splitRight(), (x - 0.5) * SWEEP);
    const band = (width: number, color: string, y: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * SWEEP, LOG_R * 1.7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }));
      mesh.position.copy(across(m.zone)).setY(this.blockAt.y + 0.414 + y);
      mesh.rotation.y = Math.atan2(this.splitRight().x, this.splitRight().z) - Math.PI / 2;
      mesh.renderOrder = 10;
      zone.add(mesh);
    };
    band(m.width, "#6ee06e", 0);
    band(m.width * 0.36, "#ffd23f", 0.001);
    zone.visible = !drop;
    this.group.add(zone);
    this.zone = zone;
  }

  /** Across the log, as you face the block: the way the marker sweeps. */
  private splitRight(): THREE.Vector3 {
    return new THREE.Vector3(-this.inland.z, 0, this.inland.x);
  }

  private strike() {
    if (this.mode !== "split" || this.logIndex >= this.logs) return;
    const now = performance.now();
    const at = Math.round(now - this.roundStart);
    if (at - this.lastSwing < SWING_MS || at < this.logAt || at > FELL_ROUND_MS) return;
    this.lastSwing = at;
    this.strikes.push(at);
    this.swingT = 0;
    const grade = splitGrade(this.motions[this.logIndex], at - this.logAt);
    this.struck[grade]++;
    const wood = splitWood(grade, this.piled, GATHER_MAX_UNITS);
    this.piled += wood;
    this.pop = { n: (this.pop?.n ?? 0) + 1, grade, wood };
    audio.play(soundName.chop(grade));
    const topAt = this.blockAt.clone().setY(this.blockAt.y + 0.42);
    if (grade === "miss") {
      this.shake = 0.02;
      for (let i = 0; i < 3; i++) this.bit("spark", "#fff2b0", topAt.clone(), new THREE.Vector3((Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5), 0.3, 0.035);
    } else {
      // It splits: two halves fall away either side.
      this.shake = grade === "perfect" ? 0.03 : 0.015;
      const side = this.splitRight();
      for (const s of [-1, 1]) {
        const half = new THREE.Mesh(new THREE.CylinderGeometry(LOG_R, LOG_R + 0.005, 0.2, 10, 1, false, 0, Math.PI), lambert("#8a5a2b"));
        half.position.copy(topAt).setY(0.31).addScaledVector(side, s * 0.03);
        half.rotation.y = Math.atan2(side.x, side.z) + (s > 0 ? Math.PI / 2 : -Math.PI / 2);
        half.castShadow = true;
        this.group.add(half);
        this.bits.push({ obj: half, vel: side.clone().multiplyScalar(s * (0.9 + Math.random() * 0.4)).setY(0.9), spin: new THREE.Vector3(0, 0, s * 4), age: 0, life: 1.6, floor: this.blockAt.y + 0.06 });
      }
      for (let i = 0; i < (grade === "perfect" ? 6 : 3); i++) this.bit("fleck", "#e8c88a", topAt.clone(), new THREE.Vector3((Math.random() - 0.5) * 1.4, 1 + Math.random(), (Math.random() - 0.5) * 1.4), 0.5, 0.04);
      this.logIndex++;
      this.logAt = at + NEXT_LOG_MS;
      if (this.log) this.group.remove(this.log);
      if (this.zone) this.group.remove(this.zone);
      this.log = null;
      this.zone = null;
      this.fillPile(this.logs - this.logIndex);
      this.pendingLog = now + NEXT_LOG_MS * 0.4;
    }
    this.emit(true);
  }

  private pendingLog = 0;

  private stepSplit(now: number) {
    if (this.pendingLog && now >= this.pendingLog) {
      this.pendingLog = 0;
      this.placeLog(true);
    }
    // A new log drops onto the block, and its mark shows once it has landed.
    const rest = this.blockAt.y + 0.21;
    if (this.log && this.log.position.y > rest) {
      this.log.position.y = Math.max(rest, this.log.position.y - 0.03);
      if (this.log.position.y === rest && this.zone) this.zone.visible = true;
    }
    const running = this.mode === "split" || this.mode === "intro-split";
    this.bead.visible = running && !!this.log && !!this.zone?.visible;
    if (!this.bead.visible) return;
    const m = this.motions[this.logIndex];
    const ms = this.mode === "split" ? Math.max(0, now - this.roundStart - this.logAt) : 0;
    const x = markerAt(m, ms);
    this.bead.position.copy(this.blockAt).addScaledVector(this.splitRight(), (x - 0.5) * SWEEP).setY(this.blockAt.y + 0.43);
  }

  // ---------- the view, the axe and the bits flying ----------

  private view(): { eye: THREE.Vector3; look: THREE.Vector3 } {
    const t = easeInOut(this.turn);
    // Turning to the block is also stepping up to it, close enough to bring the axe down on the log.
    const eye = this.eye.clone().addScaledVector(this.inland, BLOCK_STEP * t).setY(EYE_HEIGHT + 0.06 * t);
    const a = this.aim.clone().sub(this.eye);
    const b = this.blockLook.clone().sub(this.eye.clone().addScaledVector(this.inland, BLOCK_STEP));
    // Turn the short way round.
    const from = Math.atan2(a.x, a.z);
    let to = Math.atan2(b.x, b.z);
    while (to - from > Math.PI) to -= 2 * Math.PI;
    while (to - from < -Math.PI) to += 2 * Math.PI;
    const ang = from + (to - from) * t;
    const flat = THREE.MathUtils.lerp(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z), t);
    const look = eye.clone().add(new THREE.Vector3(Math.sin(ang) * flat, THREE.MathUtils.lerp(a.y, b.y, t), Math.cos(ang) * flat));
    return { eye, look };
  }

  private stepAxe(dt: number, view: { eye: THREE.Vector3; look: THREE.Vector3 }) {
    this.axe.visible = this.blend > 0.85 && this.mode !== "leaving";
    if (this.swingT >= 0) {
      this.swingT += dt;
      if (this.swingT > SWING_S) this.swingT = -1;
    }
    const k = swingCurve(this.swingT);
    const splitting = this.turn > 0.5 && this.mode !== "chop" && this.mode !== "intro-chop";
    this.axe.scale.setScalar(AXE_SCALE);
    if (splitting) {
      // Between logs it waits, raised, where the marker last was.
      if (this.bead.visible) this.axeOver.copy(this.bead.position);
      // In the right hand, raised over the log with the edge down, riding the marker across; a strike brings it
      // down about the hand until the edge meets the log's face where the marker is. The handle comes in from the
      // lower right, a little off the line of the split, so it never hides the mark.
      const h = this.inland.clone().multiplyScalar(Math.cos(SPLIT_YAW)).addScaledVector(this.splitRight(), -Math.sin(SPLIT_YAW));
      const pose = (lift: number) => {
        const along = h.clone().multiplyScalar(Math.cos(lift)).addScaledVector(UP, Math.sin(lift));
        const blade = h.clone().multiplyScalar(Math.sin(lift)).addScaledVector(UP, -Math.cos(lift));
        return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(blade, along, new THREE.Vector3().crossVectors(blade, along)));
      };
      // Where the hand is at the blow: the edge on the marker, the handle rising a little to it.
      const blow = pose(0.3);
      const grip = this.axeOver.clone().sub(new THREE.Vector3(AXE_EDGE, AXE_HEAD, 0).multiplyScalar(AXE_SCALE).applyQuaternion(blow));
      this.axe.quaternion.copy(pose(0.3 + 0.65 * (1 - k)));
      this.axe.position.copy(grip).addScaledVector(UP, 0.04 * (1 - k));
      return;
    }
    // In the right hand, low in the view, the blade toward the trees; a chop brings the head across and down into
    // the middle of the view, edge first.
    const fwd = view.look.clone().sub(view.eye).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    this.axe.position.copy(view.eye).addScaledVector(fwd, 0.55 + k * 0.1).addScaledVector(right, 0.3 - k * 0.1).addScaledVector(up, -0.38 + k * 0.03);
    // Blade to the left (toward the middle), handle up, the head's flat face to you.
    this.axe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right.clone().negate(), up, fwd));
    // Leaning in at rest; the blow swings the top over to the left and down, and away from you.
    this.axe.rotateZ(-0.25 - k * 0.85);
    this.axe.rotateX(-0.2 + k * 0.5);
  }

  private bit(kind: FxKind, color: string, at: THREE.Vector3, vel: THREE.Vector3, life: number, size: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture(kind, color), transparent: true, depthWrite: false }));
    sprite.position.copy(at);
    sprite.scale.setScalar(size);
    this.group.add(sprite);
    this.bits.push({ obj: sprite, vel, spin: new THREE.Vector3(), age: 0, life, floor: 0.01 });
  }

  private stepBits(dt: number) {
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i];
      b.age += dt;
      b.vel.y -= 4 * dt;
      b.obj.position.addScaledVector(b.vel, dt);
      if (b.obj.position.y <= b.floor) {
        b.obj.position.y = b.floor;
        b.vel.set(0, 0, 0);
        b.spin.set(0, 0, 0);
      }
      b.obj.rotation.x += b.spin.x * dt;
      b.obj.rotation.z += b.spin.z * dt;
      const fade = b.obj as THREE.Sprite;
      if (fade.isSprite) fade.material.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) {
        this.group.remove(b.obj);
        const mesh = b.obj as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose();
        this.bits.splice(i, 1);
      }
    }
  }

  private emit(force: boolean, now = performance.now()) {
    if (!force && now - this.hudAt < 100) return;
    this.hudAt = now;
    const running = this.mode === "chop" || this.mode === "split";
    this.hooks.hud({
      mode: this.mode,
      leftMs: running ? Math.max(0, FELL_ROUND_MS - (now - this.roundStart)) : FELL_ROUND_MS,
      current: this.current,
      trees: this.trees.map((t, slot) => ({ done: t.done, need: TREES[TREE_SLOTS[slot]].chops, growing: now < t.fellAt + REGROW_MS })),
      felled: this.felled,
      logsLeft: Math.max(0, this.logs - this.logIndex),
      struck: { ...this.struck },
      pile: this.piled,
      pileMax: GATHER_MAX_UNITS,
      pop: this.pop,
      marker: this.logIndex < this.logs && this.motions[this.logIndex] ? { motion: this.motions[this.logIndex], startedAt: this.mode === "split" ? this.roundStart + this.logAt : performance.now() } : null,
    });
  }
}
