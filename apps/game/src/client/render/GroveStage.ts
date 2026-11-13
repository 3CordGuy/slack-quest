// The grove: a small three.js stage for felling, drawn inside the gather
// panel. Nine trees on a 3×3 grid (row 0 to the north, away from the camera),
// the creek along the north edge and the log pile off the south-east corner,
// as in packages/world/src/grove.ts.
//
// It only shows what the server sends (GatherView.grove) and plays out what
// happened. The swing's marker is drawn as an arc round the trunk, driven by
// the same `markerAt` the server judges the stop with.
//
// Same look as the world: unlit-ish flat-shaded primitives drawn at half
// resolution and scaled up pixelated. It has its own WebGL context, so
// `dispose` frees everything it made and drops the context.

import * as THREE from "three";
import { DIR_NAMES, GROVE_PILE, GROVE_SIDE, fallLine, fallOutcome, groundAt, markerAt, type Dir8, type Fall, type FallOutcome, type GatherView, type Motion, type Outfit, type TimingGrade } from "@gantt-quest/world";
import { audio } from "../audio/engine";
import { soundName } from "../audio/names";
import { Builder } from "./props";
import { SPRITE_ASPECT, fxTexture, spriteTexture, textTexture } from "./sprites";

type GroveView = NonNullable<GatherView["grove"]>;
type TreeKind = NonNullable<GroveView["trees"][number]["kind"]>;

/** World units between trees. */
const S = 1.7;
/** Drawn at 1/PIXEL resolution and scaled up, like the world. */
const PIXEL = 2;
const STEP: readonly [number, number][] = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];
/** How a fall is coloured on the ground and on its arrow. */
export const OUTCOME_COLOR: Record<FallOutcome, string> = { clear: "#7ad36b", hung: "#e8a23a", creek: "#5ab0ff", pile: "#e0503a" };
const KIND_LABEL: Record<TreeKind, [string, string]> = { sound: ["sound", "#bff0a8"], den: ["den", "#ffd27a"], rotten: ["rotten", "#ff8a7a"] };
/** The arc the axe swings along round the trunk: how far round it reaches, and its height. */
const ARC = (200 * Math.PI) / 180;
const ARC_R = 0.78;
const ARC_Y = 0.32;

const cellAt = (row: number, col: number) => new THREE.Vector3((col - 1) * S, 0, (row - 1) * S);
const cellPos = (cell: number) => cellAt(Math.floor(cell / GROVE_SIDE), cell % GROVE_SIDE);
/** A direction on the ground, unit length. */
const dirVec = (d: Dir8) => new THREE.Vector3(STEP[d][1], 0, STEP[d][0]).normalize();
const ease = (t: number) => t * t;

export interface GroveCallbacks {
  /** A standing tree was tapped. */
  onPickTree(cell: number): void;
  /** An arrow round the picked tree was tapped: notch it on that side. */
  onPickDir(dir: Dir8): void;
  /** The canvas was pressed while the axe is swinging. */
  onPress(): void;
  /** A fall has finished playing. */
  onFallDone(): void;
  /** Where the panel floating over the stage is, on screen, so the grove is framed in the space beside it. */
  obstruction?(): DOMRect | null;
}

interface TreeObj {
  cell: number;
  /** At the tree's base; turned as a whole to fell it. */
  root: THREE.Group;
  /** The part that falls (trunk and crown), pivoting at the base. */
  body: THREE.Group;
  crown: THREE.Group;
  stump: THREE.Group;
  notch: THREE.Mesh;
  label: THREE.Sprite | null;
  labelText: string;
  tall: boolean;
  /** Where it lies now, if it is down. */
  down: Fall | null;
}

interface Flying {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rest: number;
}

interface FallAnim {
  tree: TreeObj;
  fall: Fall;
  t: number;
  /** Rocking on the stump before it goes. */
  wobble: number;
  landed: boolean;
}

export class GroveStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private raf = 0;
  private last = performance.now();
  private resizeObserver: ResizeObserver;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  private trees: TreeObj[] = [];
  private pileLogs: { mesh: THREE.Mesh; home: THREE.Vector3; homeRot: THREE.Euler }[] = [];
  private pileScattered = false;
  private ribbon: THREE.Mesh;
  private hero: THREE.Sprite;
  private heroGoal = new THREE.Vector3(0, 0, 2.9);
  private leaves: THREE.Points;
  private leafVel: Float32Array;

  private picked: number | null = null;
  private ring: THREE.Mesh;
  private arrows: THREE.Mesh[] = [];
  private lineTiles: THREE.Mesh[] = [];
  private hoverDir: Dir8 | null = null;

  private swing: { cell: number; motion: Motion; dir: Dir8; startedAt: number; stoppedAt: number | null } | null = null;
  private arc: THREE.Group | null = null;
  private axe: THREE.Group;
  /** A bright bead on the arc where the marker is: the thing to watch. */
  private bead: THREE.Mesh;

  private fallAnim: FallAnim | null = null;
  private flying: Flying[] = [];
  private puffs: { sprite: THREE.Sprite; age: number; life: number; vel: THREE.Vector3 }[] = [];
  private shake = 0;

  private view: GroveView | null = null;
  private over = false;
  private bust = false;
  private yaw = 0.35;
  /** Where the camera looks and how far back it sits, eased toward the tree being felled. */
  private look = new THREE.Vector3(0.7, 0.6, 0.9);
  private dist = 11.5;
  /** How far back the whole grove fits in the space the panel leaves, and that space's middle on the canvas. */
  private fit = { dist: 11.5, x: 0.5, y: 0.5 };
  private frameNo = 0;
  private time = 0;
  private pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false, dragged: false, id: -1 };
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(private container: HTMLElement, private callbacks: GroveCallbacks, hero: { kind: string; outfit?: Outfit }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    if (import.meta.env.DEV) (globalThis as { __gqGrove?: GroveStage }).__gqGrove = this;
    const canvas = this.renderer.domElement;
    Object.assign(canvas.style, { width: "100%", height: "100%", display: "block", imageRendering: "pixelated", touchAction: "none" });
    container.appendChild(canvas);

    this.scene.background = new THREE.Color("#9cc7e0");
    this.scene.fog = new THREE.Fog("#9cc7e0", 18, 40);
    this.scene.add(new THREE.HemisphereLight("#dff1ff", "#4a5b2c", 1.4));
    const sun = new THREE.DirectionalLight("#fff2d6", 1.8);
    sun.position.set(-5, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 25 });
    sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);

    this.buildGround();
    this.ribbon = this.buildPile();
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffe27a", transparent: true, opacity: 0.85 }));
    this.ring.position.y = 0.03;
    this.ring.visible = false;
    this.scene.add(this.ring);
    for (let d = 0; d < 8; d += 2) {
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
      arrow.userData.dir = d;
      arrow.visible = false;
      this.arrows.push(arrow);
      this.scene.add(arrow);
    }
    for (let i = 0; i < 2; i++) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(S * 0.8, S * 0.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.45, depthWrite: false }));
      tile.position.y = 0.025;
      tile.visible = false;
      this.lineTiles.push(tile);
      this.scene.add(tile);
    }

    this.hero = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture(hero.kind, hero.outfit), transparent: true, alphaTest: 0.5 }));
    this.hero.scale.set(1.05 * SPRITE_ASPECT, 1.05, 1);
    this.hero.center.set(0.5, 0);
    this.hero.position.copy(this.heroGoal);
    this.scene.add(this.hero);
    this.axe = this.buildAxe();
    this.axe.visible = false;
    this.scene.add(this.axe);
    this.bead = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false, transparent: true }));
    // Transparent so it is drawn with the arc, and after it.
    this.bead.renderOrder = 12;
    this.bead.visible = false;
    this.scene.add(this.bead);

    const LEAVES = 60;
    const pos = new Float32Array(LEAVES * 3);
    const colors = new Float32Array(LEAVES * 3);
    this.leafVel = new Float32Array(LEAVES);
    const palette = ["#7fb04a", "#c9b23c", "#5d8f37", "#d88a2e"].map((c) => new THREE.Color(c));
    for (let i = 0; i < LEAVES; i++) {
      pos.set([(Math.random() - 0.5) * 9, 0.3 + Math.random() * 2.6, (Math.random() - 0.5) * 9], i * 3);
      palette[i % palette.length].toArray(colors, i * 3);
      this.leafVel[i] = 0.6 + Math.random() * 0.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.leaves = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.09, vertexColors: true }));
    this.scene.add(this.leaves);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- building ----------

  private buildGround() {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(90, 90).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#5b8a3c" }));
    grass.position.set(0.8, 0, 1.2);
    grass.receiveShadow = true;
    this.scene.add(grass);
    // Darker earth under the stand.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(S * 3.2, S * 3.2).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#4a6f2f" }));
    floor.position.y = 0.005;
    floor.receiveShadow = true;
    this.scene.add(floor);
    // The creek, a row beyond the north edge.
    const creek = new THREE.Mesh(new THREE.PlaneGeometry(90, S * 1.1).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#3f7fc2" }));
    creek.position.set(0.8, 0.012, -2 * S - 0.1);
    this.scene.add(creek);
    const bank = new THREE.Mesh(new THREE.PlaneGeometry(90, 0.16).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#8a7a52" }));
    bank.position.set(0.8, 0.014, -2 * S + S * 0.55 - 0.1);
    this.scene.add(bank);
    // The track the hero comes in along, south of the stand.
    const track = new THREE.Mesh(new THREE.PlaneGeometry(S * 2.4, 0.7).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#9a8257" }));
    track.position.set(-0.6, 0.008, 2 * S + 0.25);
    track.receiveShadow = true;
    this.scene.add(track);
    // The wood all round: one instanced cone, kept off the stand, the creek, the pile and the track.
    const spots: { x: number; z: number; h: number }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; spots.length < 170 && i < 3000; i++) {
      const x = -26 + rnd() * 54;
      const z = -26 + rnd() * 52;
      const inStand = x > -3.6 && x < 5 && z > -2.9 && z < 5.2;
      const inCreek = z > -4.4 && z < -2.6;
      const onTrack = z > 2.9 && z < 4.4 && x < 5;
      if (inStand || inCreek || onTrack) continue;
      spots.push({ x, z, h: 1.4 + rnd() * 1.4 });
    }
    const cone = new THREE.ConeGeometry(0.55, 1, 5).translate(0, 0.5, 0);
    const wood = new THREE.InstancedMesh(cone, new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true }), spots.length);
    const m = new THREE.Matrix4();
    const shades = ["#2f6a35", "#2a5f31", "#3a7a3e", "#356f37"].map((c) => new THREE.Color(c));
    spots.forEach((p, i) => {
      m.makeScale(0.8 + p.h * 0.25, p.h, 0.8 + p.h * 0.25).setPosition(p.x, 0, p.z);
      wood.setMatrixAt(i, m);
      wood.setColorAt(i, shades[i % shades.length]);
    });
    wood.castShadow = true;
    this.scene.add(wood);
  }

  /** The log pile and its cart on the three places of GROVE_PILE, and a post with a ribbon that shows the wind. */
  private buildPile(): THREE.Mesh {
    const b = new Builder();
    for (const [row, col] of GROVE_PILE) {
      const at = cellAt(row, col);
      if (row === 3 && col === 3) {
        // The cart.
        b.box("#7a5a36", 1.1, 0.12, 0.7, at.x, 0.3, at.z);
        b.box("#5a3d22", 1.1, 0.3, 0.06, at.x, 0.42, at.z - 0.33);
        b.box("#5a3d22", 1.1, 0.3, 0.06, at.x, 0.42, at.z + 0.33);
        b.ring("#4a3320", 0.26, 0.05, at.x - 0.25, 0.26, at.z + 0.4);
        b.ring("#4a3320", 0.26, 0.05, at.x - 0.25, 0.26, at.z - 0.4);
        continue;
      }
      // A stack of logs: three, two, one.
      let n = 0;
      for (let layer = 0; layer < 3; layer++) {
        for (let i = 0; i < 3 - layer; i++) {
          b.roll(n % 2 ? "#8a6a44" : "#7a5a36", 0.13, 0.95, at.x, 0.13 + layer * 0.23, at.z - 0.27 + i * 0.27 + layer * 0.135, 6);
          n++;
        }
      }
    }
    b.group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    for (const o of b.group.children) {
      if (o instanceof THREE.Mesh && o.geometry instanceof THREE.CylinderGeometry) this.pileLogs.push({ mesh: o, home: o.position.clone(), homeRot: o.rotation.clone() });
    }
    // The post and ribbon, at the corner of the stack nearest the stand.
    const post = cellAt(2, 3).add(new THREE.Vector3(-0.6, 0, 0.75));
    b.post("#6b4a2a", 0.04, 0.05, 1.4, post.x, 0, post.z, 5);
    this.scene.add(b.group);
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.12).translate(0.3, 0, 0), new THREE.MeshLambertMaterial({ color: "#d8423a", side: THREE.DoubleSide }));
    ribbon.position.set(post.x, 1.32, post.z);
    this.scene.add(ribbon);
    return ribbon;
  }

  private buildTree(cell: number, tall: boolean, fungus: boolean): TreeObj {
    const root = new THREE.Group();
    root.position.copy(cellPos(cell));
    // Small shifts so the stand does not look planted in rows.
    root.position.x += ((cell * 37) % 7) / 7 * 0.24 - 0.12;
    root.position.z += ((cell * 53) % 5) / 5 * 0.24 - 0.12;
    const body = new THREE.Group();
    const crown = new THREE.Group();
    const birch = cell % 3 === 1;
    const b = new Builder();
    const trunkH = tall ? 1.15 : 0.7;
    b.post(birch ? "#d9d3c3" : "#6e4b2a", 0.09, 0.14, trunkH, 0, 0, 0, 6);
    if (birch) for (let i = 0; i < 3; i++) b.box("#3a352c", 0.1, 0.03, 0.02, 0.03 * i - 0.03, 0.18 + i * 0.22, 0.12);
    if (fungus) {
      b.box("#d98a3a", 0.16, 0.04, 0.1, 0.1, 0.3, 0.06);
      b.box("#c8742c", 0.12, 0.04, 0.08, -0.09, 0.45, 0.07);
      b.box("#e0a050", 0.1, 0.035, 0.07, 0.04, 0.58, -0.1);
    }
    body.add(b.group);
    const c = new Builder();
    const green = birch ? "#8fbf4a" : cell % 2 ? "#2f7a3d" : "#3a8743";
    if (birch) {
      c.ball(green, tall ? 0.6 : 0.45, 0, trunkH + (tall ? 0.45 : 0.3), 0, 1);
      c.ball("#7fb048", tall ? 0.4 : 0.3, 0.2, trunkH + (tall ? 0.85 : 0.55), 0.1, 1);
    } else {
      const tiers = tall ? 3 : 2;
      for (let i = 0; i < tiers; i++) c.cone(green, 0.62 - i * 0.14, 0.8, 0, trunkH - 0.35 + i * 0.45, 0, 6);
    }
    crown.add(c.group);
    body.add(crown);
    root.add(body);
    const stumpB = new Builder();
    stumpB.post("#6e4b2a", 0.13, 0.15, 0.16, 0, 0, 0, 6);
    stumpB.post("#c9a56a", 0.12, 0.12, 0.01, 0, 0.16, 0, 6);
    const stump = stumpB.group;
    stump.visible = false;
    root.add(stump);
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.08), new THREE.MeshLambertMaterial({ color: "#e8c88a" }));
    notch.visible = false;
    body.add(notch);
    root.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData.cell = cell;
    });
    this.scene.add(root);
    return { cell, root, body, crown, stump, notch, label: null, labelText: "", tall, down: null };
  }

  private buildAxe(): THREE.Group {
    const b = new Builder();
    b.box("#8a6a44", 0.04, 0.42, 0.04, 0, -0.21, 0);
    b.box("#eef1f6", 0.2, 0.13, 0.04, 0.09, -0.03, 0);
    // Over the crown, like the arc it rides.
    b.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.material) return;
      (m.material as THREE.Material).depthTest = false;
      (m.material as THREE.Material).transparent = true;
      m.renderOrder = 11;
    });
    b.group.scale.setScalar(1.8);
    return b.group;
  }

  private buildArc(cell: number, motion: Motion): THREE.Group {
    const g = new THREE.Group();
    const at = this.trees[cell].root.position;
    g.position.set(at.x, ARC_Y, at.z);
    // Centred on the side facing the camera, so it reads left to right like the bar.
    const facing = Math.atan2(-Math.cos(this.yaw), Math.sin(this.yaw));
    const start = facing - ARC / 2;
    g.userData.start = start;
    const ring = (from: number, len: number, color: string, inner: number, outer: number, y: number, opacity = 1) => {
      // Drawn over everything: the crown would hide it otherwise.
      const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, Math.max(3, Math.ceil(len * 12)), 1, from, len).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      m.position.y = y;
      m.renderOrder = 5 + g.children.length;
      g.add(m);
    };
    // Laid flat, the ring's angle θ lies at (cos θ, -sin θ) on the ground, as the axe's does.
    // The same colours as the bar under the canvas: the track, the mark, and the middle of it.
    ring(start, ARC, "#f3ead2", ARC_R - 0.1, ARC_R + 0.1, 0, 0.55);
    ring(start + (motion.zone - motion.width / 2) * ARC, motion.width * ARC, "#6ee06e", ARC_R - 0.12, ARC_R + 0.12, 0.002);
    ring(start + (motion.zone - motion.width * 0.18) * ARC, motion.width * 0.36 * ARC, "#ffd23f", ARC_R - 0.13, ARC_R + 0.13, 0.004);
    this.scene.add(g);
    return g;
  }

  // ---------- what the panel calls ----------

  /** Show the grove as the server sees it. Trees whose fall is still playing are left to it. */
  setGrove(view: GroveView, status: GatherView["status"]) {
    // A new outing: a different stand, a tree standing again, or knocks given back.
    const shape = (v: GroveView) => v.trees.map((t) => `${+t.tall}${+t.fungus}`).join("");
    const fresh = !this.view || this.trees.length === 0 || shape(view) !== shape(this.view) || view.knocksLeft > this.view.knocksLeft || view.trees.some((t, i) => !t.picked && this.trees[i]?.down);
    if (fresh) this.rebuild(view);
    this.view = view;
    this.over = status !== "active";
    this.bust = status === "bust";
    view.trees.forEach((t, i) => {
      const tree = this.trees[i];
      if (t.fall && !tree.down && this.fallAnim?.tree !== tree) this.lay(tree, t.fall, false);
      this.setLabel(tree, t.kind ? KIND_LABEL[t.kind] : null);
    });
    if (this.bust && !this.pileScattered && !this.fallAnim) this.scatterPile(false);
    if (!this.bust && this.pileScattered) this.restorePile();
    if (this.over || (this.picked !== null && view.trees[this.picked]?.picked)) this.pick(null);
    else this.refreshArrows();
  }

  /** Highlight a tree and show the sides it can be notched on, coloured by where each would land. */
  pick(cell: number | null) {
    this.picked = cell;
    this.hoverDir = null;
    this.ring.visible = cell !== null;
    if (cell !== null) {
      const p = this.trees[cell].root.position;
      this.ring.position.set(p.x, 0.03, p.z);
      this.heroGoal.copy(p).add(new THREE.Vector3(0.15, 0, 0.75));
    }
    this.refreshArrows();
  }

  /** Set the axe swinging round the picked tree. */
  startSwing(cell: number, motion: Motion, dir: Dir8, startedAt = performance.now()) {
    this.pick(null);
    this.clearArc();
    this.swing = { cell, motion, dir, startedAt, stoppedAt: null };
    this.arc = this.buildArc(cell, motion);
    this.axe.visible = true;
    this.bead.visible = true;
    const p = this.trees[cell].root.position;
    // The hero stands on the far side from where it is meant to fall.
    this.heroGoal.copy(p).addScaledVector(dirVec(dir), -0.62);
    this.showLine(cell, dir);
  }

  /** The player stopped the axe: freeze it where it was and bite the trunk. */
  stopSwing(at: number, grade: TimingGrade) {
    if (!this.swing) return;
    this.swing.stoppedAt = at;
    audio.play(soundName.chop(grade));
    const tree = this.trees[this.swing.cell];
    const d = dirVec(this.swing.dir);
    tree.notch.visible = true;
    tree.notch.position.set(d.x * 0.1, 0.28, d.z * 0.1);
    tree.notch.rotation.y = Math.atan2(d.x, d.z);
    const hit = tree.root.position.clone().add(new THREE.Vector3(0, 0.35, 0)).addScaledVector(d, -0.15);
    const n = grade === "perfect" ? 10 : grade === "good" || grade === "close" ? 6 : 2;
    for (let i = 0; i < n; i++) this.puff("fleck", "#e8c88a", hit, new THREE.Vector3((Math.random() - 0.5) * 2.4, 1 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4), 0.5, 0.14);
    this.shake = this.still ? 0 : 0.04;
  }

  /** Knock on a tree: say what it is, and give it a little shiver. */
  knock(cell: number, kind: TreeKind) {
    audio.play(soundName.knock(kind));
    const tree = this.trees[cell];
    tree.root.userData.shiver = 0.35;
    this.heroGoal.copy(tree.root.position).add(new THREE.Vector3(0.15, 0, 0.6));
    if (kind === "den") for (let i = 0; i < 4; i++) this.puff("dust", "#b7a27a", tree.root.position.clone().add(new THREE.Vector3(0, 0.05, 0.2)), new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.3, 0.8), 0.6, 0.2);
  }

  /** Bring a tree down the way the server said it went. Calls onFallDone when it has. */
  playFall(cell: number, fall: Fall) {
    this.clearSwing();
    const tree = this.trees[cell];
    audio.play(soundName.fall("creak"));
    this.fallAnim = { tree, fall, t: 0, wobble: this.still ? 0 : 0.45, landed: false };
    tree.stump.visible = true;
    tree.body.position.y = 0.14;
  }

  /** Whether the axe is out (swinging, or stopped and waiting on the server). */
  get swinging(): boolean {
    return this.swing !== null;
  }

  /** Stop and drop the swing, for when the outing ends or the panel loses it. */
  clearSwing() {
    this.swing = null;
    this.axe.visible = false;
    this.bead.visible = false;
    this.clearArc();
    this.showLine(null, null);
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
    for (const t of this.trees) t.label?.material.map?.dispose();
    // Sprite and effect textures are shared caches (sprites.ts): free the materials, not their maps.
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) mat.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    if (import.meta.env.DEV && (globalThis as { __gqGrove?: GroveStage }).__gqGrove === this) delete (globalThis as { __gqGrove?: GroveStage }).__gqGrove;
  }

  /** Draw calls in the last frame, for the dev console. */
  get calls(): number {
    return this.renderer.info.render.calls;
  }

  // ---------- internals ----------

  private rebuild(view: GroveView) {
    for (const t of this.trees) {
      t.label?.material.map?.dispose();
      t.root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
      this.scene.remove(t.root);
    }
    this.fallAnim = null;
    this.clearSwing();
    this.trees = view.trees.map((t, i) => this.buildTree(i, t.tall, t.fungus));
    this.heroGoal.set(0, 0, 2.9);
    this.picked = null;
  }

  private setLabel(tree: TreeObj, label: [string, string] | null) {
    const text = label?.[0] ?? "";
    if (text === tree.labelText) return;
    if (tree.label) {
      tree.label.material.map?.dispose();
      tree.label.material.dispose();
      tree.root.remove(tree.label);
      tree.label = null;
    }
    tree.labelText = text;
    if (!label) return;
    const map = textTexture(label[0], label[1]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    const img = map.image as HTMLCanvasElement;
    sprite.scale.set((0.32 * img.width) / img.height, 0.32, 1);
    sprite.renderOrder = 10;
    sprite.position.y = tree.down ? 0.55 : tree.tall ? 2.6 : 1.95;
    tree.root.add(sprite);
    tree.label = sprite;
  }

  private lay(tree: TreeObj, fall: Fall, animated: boolean) {
    tree.down = fall;
    tree.stump.visible = true;
    tree.notch.visible = false;
    const angle = fall.outcome === "hung" ? 0.62 : Math.PI / 2 - 0.08;
    tree.body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0).cross(dirVec(fall.dir)).normalize(), angle);
    tree.body.position.y = 0.14;
    if (fall.outcome === "creek" && !animated) tree.body.visible = false;
    if (tree.label) tree.label.position.y = fall.outcome === "hung" ? 1.6 : 0.55;
  }

  private refreshArrows() {
    const cell = this.picked;
    const view = this.view;
    for (const arrow of this.arrows) {
      arrow.visible = cell !== null && !!view && !this.over;
      if (!arrow.visible || cell === null || !view) continue;
      const d = arrow.userData.dir as Dir8;
      const down = view.trees.flatMap((t, i) => (t.picked ? [i] : []));
      const outcome = fallOutcome(cell, d, view.trees[cell].tall ? 2 : 1, down);
      (arrow.material as THREE.MeshBasicMaterial).color.set(OUTCOME_COLOR[outcome]);
      const p = this.trees[cell].root.position;
      const v = dirVec(d);
      arrow.position.set(p.x + v.x * 0.85, 0.12, p.z + v.z * 0.85);
      arrow.rotation.y = Math.atan2(v.x, v.z);
      arrow.scale.setScalar(this.hoverDir === d ? 1.35 : 1);
    }
    // While the axe is out, light where it was notched to fall instead.
    if (this.swing) this.showLine(this.swing.cell, this.swing.dir);
    else this.showLine(cell, this.hoverDir);
  }

  /** Light the cells a fall would cross. */
  private showLine(cell: number | null, dir: Dir8 | null) {
    const view = this.view;
    const cells = cell === null || dir === null || !view ? [] : fallLine(cell, dir, view.trees[cell].tall ? 2 : 1);
    const down = view ? view.trees.flatMap((t, i) => (t.picked ? [i] : [])) : [];
    this.lineTiles.forEach((tile, i) => {
      const at = cells[i];
      tile.visible = !!at;
      if (!at) return;
      const ground = groundAt(at[0], at[1]);
      const color = ground === "pile" ? OUTCOME_COLOR.pile : ground === "creek" ? OUTCOME_COLOR.creek : typeof ground === "number" && !down.includes(ground) ? OUTCOME_COLOR.hung : OUTCOME_COLOR.clear;
      (tile.material as THREE.MeshBasicMaterial).color.set(color);
      tile.position.copy(cellAt(at[0], at[1])).setY(0.025);
    });
  }

  private clearArc() {
    if (!this.arc) return;
    this.arc.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.scene.remove(this.arc);
    this.arc = null;
  }

  private puff(kind: "dust" | "fleck", color: string, at: THREE.Vector3, vel: THREE.Vector3, life: number, size: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture(kind, color), transparent: true, depthWrite: false }));
    sprite.position.copy(at);
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    this.puffs.push({ sprite, age: 0, life, vel });
  }

  private scatterPile(animated: boolean) {
    this.pileScattered = true;
    for (const log of this.pileLogs) {
      if (!animated) {
        log.mesh.position.set(log.home.x + (Math.random() - 0.5) * 1.6, 0.12, log.home.z + (Math.random() - 0.5) * 1.6);
        log.mesh.rotation.set(0, Math.random() * Math.PI, Math.PI / 2);
        continue;
      }
      const out = log.mesh.position.clone().sub(cellAt(3, 3)).setY(0).normalize();
      this.flying.push({ obj: log.mesh, vel: new THREE.Vector3(out.x * 2 + (Math.random() - 0.5) * 2, 2.5 + Math.random() * 2, out.z * 2 + (Math.random() - 0.5) * 2), spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, 0), rest: 0.12 });
    }
  }

  private restorePile() {
    this.pileScattered = false;
    this.flying = [];
    for (const log of this.pileLogs) {
      log.mesh.position.copy(log.home);
      log.mesh.rotation.copy(log.homeRot);
    }
  }

  /**
   * Frame the grove in the part of the canvas the floating panel leaves free:
   * the widest strip beside it, above it or below it. The camera's middle is
   * moved there (a view offset) and it stands back far enough to fit the stand.
   */
  private reframe() {
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const W = canvas.width || 1;
    const H = canvas.height || 1;
    let free = { left: 0, top: 0, width: W, height: H };
    const panel = this.callbacks.obstruction?.();
    if (panel && panel.width > 0 && panel.right > canvas.left && panel.left < canvas.right && panel.bottom > canvas.top && panel.top < canvas.bottom) {
      const l = panel.left - canvas.left;
      const r = canvas.right - panel.right;
      const t = panel.top - canvas.top;
      const b = canvas.bottom - panel.bottom;
      const options = [
        { left: 0, top: 0, width: l, height: H },
        { left: W - r, top: 0, width: r, height: H },
        { left: 0, top: 0, width: W, height: t },
        { left: 0, top: H - b, width: W, height: b },
      ].filter((o) => o.width > 120 && o.height > 120);
      if (options.length) free = options.reduce((a, o) => (o.width * o.height > a.width * a.height ? o : a));
    }
    // World units of the stand that must fit across and down (with the creek, the pile and a margin).
    const span = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = (H / span) * Math.max(7.6 / free.height, 11 / free.width);
    this.fit = { dist: Math.max(8, Math.min(42, dist)), x: (free.left + free.width / 2) / W, y: (free.top + free.height / 2) / H };
    const cw = this.renderer.domElement.width;
    const ch = this.renderer.domElement.height;
    this.camera.setViewOffset(cw, ch, cw * (0.5 - this.fit.x), ch * (0.5 - this.fit.y), cw, ch);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(Math.ceil(w / PIXEL), Math.ceil(h / PIXEL), false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.reframe();
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    const wind = this.view?.wind ?? { dir: 2 as Dir8, strength: 1 as const };
    const wv = dirVec(wind.dir);

    // Camera: orbit about the stand, with a little shake on a hit or a landing.
    if (this.frameNo++ % 8 === 0) this.reframe();
    const focus = this.swing?.cell ?? this.fallAnim?.tree.cell;
    const wide = this.fit.dist;
    const goal = focus !== undefined ? this.trees[focus].root.position.clone().setY(0.5) : new THREE.Vector3(0.7, 0.6, 0.9);
    const k = this.still ? 1 : Math.min(1, dt * 3);
    this.look.lerp(goal, k);
    this.dist += ((focus !== undefined ? wide * 0.62 : wide) - this.dist) * k;
    const target = this.look;
    const dist = this.dist;
    const pitch = 0.82;
    this.camera.position.set(target.x + Math.sin(this.yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(this.yaw) * Math.cos(pitch) * dist);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 4;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 4;
      this.shake = Math.max(0, this.shake - dt * 0.35);
    }
    this.camera.lookAt(target);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = dist + 6;
    fog.far = dist + 26;

    // Wind: crowns lean and sway with it, the ribbon streams, leaves drift.
    const sway = this.still ? 0 : [0.01, 0.03, 0.06][wind.strength];
    for (const t of this.trees) {
      if (!t.down) {
        const s = sway * (1 + Math.sin(this.time * 2.2 + t.cell * 1.7));
        t.crown.rotation.set(wv.z * s, 0, -wv.x * s);
      }
      const shiver = t.root.userData.shiver as number | undefined;
      if (shiver && shiver > 0) {
        t.root.userData.shiver = shiver - dt;
        t.body.rotation.z = t.down ? t.body.rotation.z : Math.sin(this.time * 60) * 0.03 * shiver;
      }
    }
    this.ribbon.rotation.y = Math.atan2(-wv.z, wv.x);
    this.ribbon.rotation.x = this.still ? 0 : Math.sin(this.time * (4 + wind.strength * 4)) * 0.3;
    this.ribbon.rotation.z = wind.strength === 0 ? -1.2 : wind.strength === 1 ? -0.5 : -0.15;
    const pos = this.leaves.geometry.getAttribute("position") as THREE.BufferAttribute;
    const speed = [0.15, 0.9, 2][wind.strength];
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + wv.x * speed * this.leafVel[i] * dt + Math.sin(this.time * 3 + i) * 0.004;
      let y = pos.getY(i) - (0.25 + 0.15 * Math.sin(this.time + i)) * dt;
      let z = pos.getZ(i) + wv.z * speed * this.leafVel[i] * dt;
      if (y < 0.05 || Math.abs(x - 0.7) > 5 || Math.abs(z - 0.9) > 5) {
        x = 0.7 - wv.x * 4 + (Math.random() - 0.5) * 6;
        z = 0.9 - wv.z * 4 + (Math.random() - 0.5) * 6;
        y = 1.2 + Math.random() * 1.8;
      }
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;

    // The hero walks to where they are needed, with a hop.
    const toGoal = this.heroGoal.clone().sub(this.hero.position).setY(0);
    const walking = toGoal.length() > 0.02;
    if (walking) this.hero.position.addScaledVector(toGoal, Math.min(1, dt * 6));
    this.hero.position.y = walking ? Math.abs(Math.sin(this.time * 14)) * 0.08 : 0;

    // The axe along its arc: the same marker the server judges.
    const sw = this.swing;
    if (sw && this.arc) {
      const ms = sw.stoppedAt ?? now - sw.startedAt;
      const m = markerAt(sw.motion, ms);
      const theta = (this.arc.userData.start as number) + m * ARC;
      const c = this.arc.position;
      this.axe.position.set(c.x + Math.cos(theta) * ARC_R, ARC_Y + 0.25, c.z - Math.sin(theta) * ARC_R);
      this.bead.position.set(c.x + Math.cos(theta) * ARC_R, ARC_Y + 0.02, c.z - Math.sin(theta) * ARC_R);
      (this.bead.material as THREE.MeshBasicMaterial).color.set(sw.stoppedAt === null ? "#ffffff" : "#ffd23f");
      this.axe.rotation.set(0, theta + Math.PI / 2, sw.stoppedAt === null ? 0.25 : 0.9);
    }

    this.stepFall(dt);
    this.stepFlying(dt);
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      p.vel.y -= 5 * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      if (p.sprite.position.y < 0.05) p.sprite.position.y = 0.05;
      p.sprite.material.opacity = Math.max(0, 1 - p.age / p.life);
      if (p.age >= p.life) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  private stepFall(dt: number) {
    const a = this.fallAnim;
    if (!a) return;
    const axis = new THREE.Vector3(0, 1, 0).cross(dirVec(a.fall.dir)).normalize();
    if (a.wobble > 0) {
      a.wobble -= dt;
      a.tree.body.quaternion.setFromAxisAngle(axis, Math.sin(a.wobble * 30) * 0.03 + 0.02);
      return;
    }
    const T = this.still ? 0.35 : 0.95;
    a.t += dt;
    const end = a.fall.outcome === "hung" ? 0.62 : Math.PI / 2 - 0.08;
    const k = Math.min(1, a.t / T);
    let angle = end * ease(k);
    if (k >= 1 && !a.landed) {
      a.landed = true;
      this.land(a);
    }
    // A small bounce once it is down.
    if (a.landed && !this.still) {
      const after = a.t - T;
      angle = end - Math.abs(Math.sin(after * 14)) * 0.08 * Math.max(0, 1 - after * 3);
    }
    a.tree.body.quaternion.setFromAxisAngle(axis, angle);
    if (a.fall.outcome === "creek" && a.landed) {
      a.tree.body.position.y -= dt * 0.5;
      a.tree.body.position.x += dt * 0.8;
    }
    const doneAt = T + (this.still ? 0.1 : a.fall.outcome === "creek" ? 1.2 : 0.5);
    if (a.t >= doneAt) {
      this.lay(a.tree, a.fall, true);
      if (a.fall.outcome === "creek") a.tree.body.visible = false;
      this.fallAnim = null;
      this.callbacks.onFallDone();
    }
  }

  /** The moment it hits: the sound, dust, a jolt, and what it lands on. */
  private land(a: FallAnim) {
    const { tree, fall } = a;
    const reach = tree.tall ? 2 : 1;
    const tip = tree.root.position.clone().addScaledVector(dirVec(fall.dir), (fall.outcome === "hung" ? 0.9 : reach * S * 0.8));
    audio.play(soundName.fall(fall.outcome === "clear" ? "timber" : fall.outcome));
    if (fall.outcome !== "creek") for (let i = 0; i < (fall.outcome === "hung" ? 3 : 9); i++) this.puff("dust", "#c8b48a", tip.clone().setY(0.15), new THREE.Vector3((Math.random() - 0.5) * 2, 1.2 + Math.random(), (Math.random() - 0.5) * 2), 0.8, 0.35);
    else for (let i = 0; i < 8; i++) this.puff("dust", "#d8ecff", tip.clone().setY(0.1), new THREE.Vector3((Math.random() - 0.5) * 1.5, 2 + Math.random(), (Math.random() - 0.5) * 1.5), 0.7, 0.3);
    if (!this.still) this.shake = fall.outcome === "hung" ? 0.03 : 0.08;
    if (fall.outcome === "pile" && this.bust) this.scatterPile(true);
    if (fall.outcome === "pile" && !this.bust) for (const log of this.pileLogs) log.mesh.userData.rattle = 0.4;
  }

  private stepFlying(dt: number) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.vel.y -= 9.8 * dt;
      f.obj.position.addScaledVector(f.vel, dt);
      f.obj.rotation.x += f.spin.x * dt;
      f.obj.rotation.y += f.spin.y * dt;
      if (f.obj.position.y <= f.rest) {
        f.obj.position.y = f.rest;
        f.obj.rotation.set(0, f.obj.rotation.y, Math.PI / 2);
        this.flying.splice(i, 1);
      }
    }
    for (const log of this.pileLogs) {
      const r = log.mesh.userData.rattle as number | undefined;
      if (!r || r <= 0) continue;
      log.mesh.userData.rattle = r - dt;
      log.mesh.position.y = log.home.y + Math.abs(Math.sin(this.time * 40)) * 0.04 * r;
    }
  }

  // ---------- pointer ----------

  private onPointerDown = (e: PointerEvent) => {
    if (this.swing && this.swing.stoppedAt === null) {
      e.preventDefault();
      this.callbacks.onPress();
      return;
    }
    Object.assign(this.pointer, { downX: e.clientX, downY: e.clientY, x: e.clientX, down: true, dragged: false, id: e.pointerId });
    // Keep the drag ours until it ends, even if the pointer leaves the canvas.
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // Not every pointer can be captured (a synthetic one); the drag still works while it stays over the canvas.
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.pointer.down && e.pointerId === this.pointer.id) {
      const dx = e.clientX - this.pointer.x;
      this.pointer.x = e.clientX;
      if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 6) this.pointer.dragged = true;
      if (this.pointer.dragged && !this.swing) this.yaw = Math.max(-0.7, Math.min(1.2, this.yaw - dx * 0.008));
      return;
    }
    if (e.pointerType !== "mouse") return;
    const hit = this.hit(e);
    const dir = hit?.dir ?? null;
    if (dir !== this.hoverDir) {
      this.hoverDir = dir;
      this.refreshArrows();
    }
    this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointer.down || e.pointerId !== this.pointer.id) return;
    this.pointer.down = false;
    if (this.pointer.dragged || this.over || this.swing || this.fallAnim) return;
    const hit = this.hit(e);
    if (!hit) return;
    if (hit.dir !== undefined) this.callbacks.onPickDir(hit.dir);
    else if (hit.cell !== undefined) this.callbacks.onPickTree(hit.cell);
  };

  private onPointerLeave = () => {
    if (this.hoverDir !== null) {
      this.hoverDir = null;
      this.refreshArrows();
    }
  };

  /** What is under the pointer: an arrow round the picked tree first, then a standing tree. */
  private hit(e: PointerEvent): { dir?: Dir8; cell?: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const arrows = this.arrows.filter((a) => a.visible);
    // Arrows are small on a phone: pick the nearest within reach of the ray rather than needing a direct hit.
    if (arrows.length) {
      let best: THREE.Mesh | null = null;
      let bestD = 0.55;
      for (const a of arrows) {
        const d = this.raycaster.ray.distanceToPoint(a.position);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (best) return { dir: best.userData.dir as Dir8 };
    }
    const standing = this.trees.filter((t) => !t.down && !this.view?.trees[t.cell]?.picked).map((t) => t.root);
    const hit = this.raycaster.intersectObjects(standing, true)[0];
    if (hit) return { cell: hit.object.userData.cell as number };
    return null;
  }
}

/** "gusting to the east", for the panel. */
export function windText(wind: { dir: Dir8; strength: 0 | 1 | 2 }): string {
  return wind.strength === 0 ? "Calm" : `${wind.strength === 1 ? "A breeze" : "Gusting"} to the ${DIR_NAMES[wind.dir]}`;
}
