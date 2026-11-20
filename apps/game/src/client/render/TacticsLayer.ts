// What a fight on the tiles lays over the map: tinted, outlined regions of
// hexes (how far an ability reaches, the area it will cover, where an
// enemy group can see), and the surfaces on the ground (poison, fire, oil,
// water, ice). It draws through the renderer's public hooks and knows
// nothing of the rules: the view tells it which hexes and what colour.

import * as THREE from "three";
import { fireField, gooMaterial, poisonFumes, poisonMaterial, tickFumes, tickGround, waterMaterial } from "./groundFx";
import { posKey, type HexPos } from "@gantt-quest/core";
import { SURFACE_INFO, WEATHER_INFO, tileAt, type SurfaceKind, type WeatherKind, type WorldMap } from "@gantt-quest/world";
import { OUTLINE } from "./figures";
import { toonRamp } from "./SpellFx";
import { setSqualls } from "./wind";
import { hexToWorld, tileTop, type WorldRenderer } from "./WorldRenderer";

/**
 * A compass rose, drawn once: an inked ring with a tick for each point, four long points and four short ones between,
 * the north point red and the rest brass and parchment. Real colours, not a shape to be tinted.
 */
let roseTex: THREE.CanvasTexture | null = null;
function compassRose(): THREE.CanvasTexture {
  if (roseTex) return roseTex;
  const N = 256;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d")!;
  const mid = N / 2;
  const ink = "#1b1830";
  ctx.lineJoin = "round";
  // The ring, with a tick at each of the sixteen points.
  ctx.strokeStyle = ink;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(mid, mid, 112, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#e8c66a";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(mid, mid, 112, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r0 = i % 2 ? 100 : 94;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(mid + Math.cos(a) * r0, mid + Math.sin(a) * r0);
    ctx.lineTo(mid + Math.cos(a) * 112, mid + Math.sin(a) * 112);
    ctx.stroke();
  }
  // A point: a long thin diamond from the middle out along `a`, halved light and dark so it reads as raised.
  const point = (a: number, long: number, wide: number, light: string, dark: string) => {
    const tip = [mid + Math.cos(a) * long, mid + Math.sin(a) * long];
    const l = [mid + Math.cos(a - Math.PI / 2) * wide, mid + Math.sin(a - Math.PI / 2) * wide];
    const r = [mid + Math.cos(a + Math.PI / 2) * wide, mid + Math.sin(a + Math.PI / 2) * wide];
    for (const [side, fill] of [[l, light], [r, dark]] as const) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(mid, mid);
      ctx.lineTo(side[0], side[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(l[0], l[1]);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(r[0], r[1]);
    ctx.stroke();
  };
  for (let i = 0; i < 4; i++) point(Math.PI / 4 + (i * Math.PI) / 2, 70, 14, "#f3e7c8", "#c9b48a");
  for (let i = 0; i < 4; i++) {
    const north = i === 0;
    point(-Math.PI / 2 + (i * Math.PI) / 2, 106, 20, north ? "#ff5a4a" : "#f3e7c8", north ? "#b8231a" : "#c9b48a");
  }
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(mid, mid, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8c66a";
  ctx.beginPath();
  ctx.arc(mid, mid, 7, 0, Math.PI * 2);
  ctx.fill();
  roseTex = new THREE.CanvasTexture(c);
  roseTex.colorSpace = THREE.SRGBColorSpace;
  return roseTex;
}

/** A soft round glow, drawn once, to be tinted: what the compass rose's glow is cut from. */
let glowCanvas: THREE.CanvasTexture | null = null;
function glowTex(): THREE.CanvasTexture {
  if (glowCanvas) return glowCanvas;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowCanvas = new THREE.CanvasTexture(c);
  return glowCanvas;
}

/** How high over the ground a rain cloud hangs: clear over the heads of whoever stands in its rain. */
const CLOUD_HEIGHT = 3.1;

/** A set of hexes to mark: filled faintly, outlined round its edge, or both. */
export interface Overlay {
  hexes: HexPos[];
  color: string;
  /** How solid the fill is, 0 to 1. Left out: no fill. */
  fill?: number;
  /** How solid the outline is, 0 to 1. Left out: no outline. */
  line?: number;
  /** The outline dashed, not solid: what lasts on the ground (an aura's reach), told apart from what is being aimed. */
  dashed?: boolean;
}

/** A signature no list of marks has: set after the map changes, so the next list is drawn whatever it is. */
const STALE = "\u0000stale";
const SQRT3 = Math.sqrt(3);
/** What tickSky works in each frame, and how a streak of wind is tipped: made once, not every frame. */
const SKY_M = new THREE.Matrix4();
const SKY_AT = new THREE.Vector3();
const SKY_SIZE = new THREE.Vector3();
const WIND_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0));
/** Corner `i` of a hex of this size around the origin (pointy end up the map). */
const corner = (i: number, size: number): [number, number] => [Math.sin((i * Math.PI) / 3) * size, Math.cos((i * Math.PI) / 3) * size];

export class TacticsLayer {
  private group = new THREE.Group();
  private overlays = new THREE.Group();
  private ground = new THREE.Group();
  private map: WorldMap | null = null;
  private arc: THREE.Line | null = null;
  private arcSig = "";
  private path = new THREE.Group();
  private pathSig = "";
  /** Markers bobbing over whoever's turn it is: each follows its unit about. */
  private marks: { id: string; mesh: THREE.Mesh }[] = [];
  private markSig = "";
  private overlaySig = "";
  private groundSig = "";
  /** Courses charted (Chart a Course): a red X on each hex marked. */
  private charts = new THREE.Group();
  /** A compass rose glowing on the ground under where a course is being charted to (see setCompass). */
  private compass: { rose: THREE.Mesh; glow: THREE.Mesh; turn: number; wrong: boolean } | null = null;
  private chartSig = "";
  private stop: () => void;
  /** Surfaces breathe a little, so the ground looks alive. */
  private pulse: THREE.MeshBasicMaterial[] = [];
  /** And what lies on the ground moves (groundFx.ts): goo rolls and gleams, fire flickers and throws sparks. */
  private goo: THREE.ShaderMaterial[] = [];
  private flames: THREE.Object3D[] = [];
  private sparks: THREE.Points[] = [];
  /** Fumes rising off poison (groundFx.ts). */
  private fumes: THREE.Group[] = [];
  /** Weather over the ground (zone/weather.ts): its drops or gusts, each with where it started and its kind. */
  private sky = new THREE.Group();
  private skySig = "";
  private drift: { points: THREE.Points; base: Float32Array; floor: Float32Array }[] = [];
  /** Streaks of wind over the hexes Trade Winds blows across (see streaks). */
  private winds: THREE.InstancedMesh[] = [];
  /** Each rain cloud over the ground, its drops, and when it was first drawn (it grows in from nothing). */
  private clouds: { cloud: THREE.Group; drops: THREE.InstancedMesh; base: Float32Array; floor: Float32Array; born: number; veil: { material: THREE.Material; full: number }[] }[] = [];
  /**
   * Materials kept from one drawing to the next, so their shaders are compiled once and not again each time the
   * ground or the marks change: the moving sheet of each kind of surface, and the marks' fills and outlines by
   * colour and solidity (none is changed once made, so marks alike share one). `clear` leaves them be; freed in dispose.
   */
  private sheets = new Map<SurfaceKind, THREE.ShaderMaterial>();
  private inks = new Map<string, THREE.Material>();
  private kept = new Set<THREE.Material>();

  constructor(private renderer: WorldRenderer) {
    this.group.add(this.ground, this.sky, this.overlays, this.charts, this.path);
    renderer.addObject(this.group);
    this.stop = renderer.addTicker((_dt, _camera, clock) => {
      for (const [i, m] of this.pulse.entries()) m.opacity = (m.userData.base as number) * (0.82 + 0.18 * Math.sin(clock * 2.2 + i));
      tickGround(clock, this.goo, this.flames, this.sparks, 1 - 0.7 * renderer.night);
      tickFumes(clock, this.fumes, 1 - 0.7 * renderer.night);
      this.tickSky(clock);
      if (this.compass) {
        // Breathing a little, and its glow pulsing; turned to point its north along the course.
        const { rose, glow, turn, wrong } = this.compass;
        rose.rotation.z = turn;
        const s = 2.1 * (1 + Math.sin(clock * 3) * 0.03);
        rose.scale.set(s, s, 1);
        (glow.material as THREE.MeshBasicMaterial).opacity = (wrong ? 0.25 : 0.5) * (0.75 + 0.25 * Math.sin(clock * 3));
        (rose.material as THREE.MeshBasicMaterial).opacity = wrong ? 0.45 : 0.95;
      }
      for (const { id, mesh } of this.marks) {
        const head = renderer.unitHead(id);
        mesh.visible = !!head;
        if (!head) continue;
        // Clear of the name plate that sits over the head.
        mesh.position.set(head.x, head.y + 1.05 + Math.sin(clock * 3.2) * 0.09, head.z);
        mesh.rotation.y = clock * 1.6;
      }
    });
  }

  dispose() {
    this.stop();
    setSqualls([]);
    this.clear(this.overlays);
    this.clear(this.ground);
    this.clear(this.sky);
    this.clear(this.path);
    this.clear(this.charts);
    this.setArc(null);
    this.setTurnMarkers([]);
    for (const m of this.kept) m.dispose();
    this.kept.clear();
    this.sheets.clear();
    this.inks.clear();
    this.renderer.removeObject(this.group);
  }

  /** The material kept under `key` in `store`, made the first time it is asked for. */
  private keep<K, M extends THREE.Material>(store: Map<K, M>, key: K, make: () => M): M {
    let m = store.get(key);
    if (!m) {
      m = make();
      store.set(key, m);
      this.kept.add(m);
    }
    return m;
  }

  setMap(map: WorldMap) {
    if (this.map?.tiles === map.tiles) return;
    this.map = map;
    // Whatever comes next is drawn afresh, nothing included: "" is what an empty list's signature is, so it would match
    // and leave the old marks standing.
    this.overlaySig = this.groundSig = this.skySig = this.chartSig = STALE;
  }

  private clear(group: THREE.Group) {
    // Whatever is in it, however deep (a fire is a group of embers, flames and sparks).
    group.traverse((o) => {
      // A sprite's shape is shared by every sprite: only its material is its own.
      if (o instanceof THREE.Sprite) return o.material.dispose();
      if (o === group || !(o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points)) return;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!this.kept.has(m)) m.dispose();
    });
    group.clear();
  }

  private top(pos: HexPos): number {
    return tileTop(this.map ? tileAt(this.map, pos) : undefined);
  }

  /** One flat mesh covering every hex in `hexes`, a little above the ground and a little inside each hex's edge. */
  private fill(hexes: HexPos[], lift: number, size: number): THREE.BufferGeometry {
    const positions: number[] = [];
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p) + lift;
      for (let i = 0; i < 6; i++) {
        const [ax, az] = corner(i, size);
        const [bx, bz] = corner(i + 1, size);
        positions.push(x, y, z, x + ax, y, z + az, x + bx, y, z + bz);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /** The edges of `hexes` that have nothing of the set on their other side. */
  private outline(hexes: HexPos[], lift: number): THREE.BufferGeometry {
    const inside = new Set(hexes.map(posKey));
    const points: number[] = [];
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p) + lift;
      for (let i = 0; i < 6; i++) {
        // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector.
        const mid = ((i + 0.5) * Math.PI) / 3;
        const nr = Math.round((z + Math.cos(mid) * SQRT3) / 1.5);
        const nq = Math.round((x + Math.sin(mid) * SQRT3) / SQRT3 - nr / 2);
        if (inside.has(posKey({ q: nq, r: nr }))) continue;
        const [ax, az] = corner(i, 1);
        const [bx, bz] = corner(i + 1, 1);
        points.push(x + ax, y, z + az, x + bx, y, z + bz);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }

  /** Mark these regions, replacing whatever was marked before. Later ones are drawn over earlier ones. */
  setOverlays(list: Overlay[]) {
    const sig = list.map((o) => `${o.color}:${o.fill ?? 0}:${o.line ?? 0}:${o.dashed ? "d" : ""}:${o.hexes.map(posKey).join(" ")}`).join("|");
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;
    this.clear(this.overlays);
    list.forEach((o, i) => {
      if (o.hexes.length === 0) return;
      if (o.fill) {
        const { color, fill } = o;
        const material = this.keep(this.inks, `fill|${color}|${fill}`, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fill, depthWrite: false, side: THREE.DoubleSide }));
        const mesh = new THREE.Mesh(this.fill(o.hexes, 0.05 + i * 0.004, 0.94), material);
        mesh.renderOrder = 2;
        this.overlays.add(mesh);
      }
      if (o.line) {
        const { color, line } = o;
        // Each edge of the outline is its own segment, a hex side long: dashes measured along it start afresh at each corner.
        const material = o.dashed
          ? this.keep(this.inks, `dashed|${color}|${line}`, () => new THREE.LineDashedMaterial({ color, transparent: true, opacity: line, depthTest: false, dashSize: 0.22, gapSize: 0.16 }))
          : this.keep(this.inks, `line|${color}|${line}`, () => new THREE.LineBasicMaterial({ color, transparent: true, opacity: line, depthTest: false }));
        const lines = new THREE.LineSegments(this.outline(o.hexes, 0.07 + i * 0.004), material);
        if (o.dashed) lines.computeLineDistances();
        lines.renderOrder = 3;
        this.overlays.add(lines);
      }
    });
  }

  /**
   * The line a shot, a spell or a throw would take: a dashed arc from the one aiming to what is aimed at,
   * `height` over the straight line at its top. Null takes it away.
   */
  setArc(arc: { from: THREE.Vector3; to: THREE.Vector3; height: number; color: string } | null) {
    const sig = arc ? `${arc.from.toArray().map((n) => n.toFixed(2))}|${arc.to.toArray().map((n) => n.toFixed(2))}|${arc.height.toFixed(2)}|${arc.color}` : "";
    if (sig === this.arcSig) return;
    this.arcSig = sig;
    if (this.arc) {
      this.group.remove(this.arc);
      this.arc.geometry.dispose();
      (this.arc.material as THREE.Material).dispose();
      this.arc = null;
    }
    if (!arc) return;
    const points = Array.from({ length: 25 }, (_, i) => {
      const t = i / 24;
      return arc.from.clone().lerp(arc.to, t).add(new THREE.Vector3(0, arc.height * 4 * t * (1 - t), 0));
    });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: arc.color, dashSize: 0.22, gapSize: 0.14, transparent: true, opacity: 0.95, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 4;
    this.arc = line;
    this.group.add(line);
  }

  /**
   * The way to somewhere that cannot be reached this turn, step by step: pale as far as the movement
   * left will carry, red from there on. Empty takes it away.
   */
  setPath(steps: { pos: HexPos; ok: boolean }[]) {
    const sig = steps.map((s) => `${posKey(s.pos)}${s.ok ? "" : "!"}`).join(" ");
    if (sig === this.pathSig) return;
    this.pathSig = sig;
    this.clear(this.path);
    for (const ok of [true, false]) {
      const points = steps.filter((s) => s.ok === ok);
      if (points.length === 0) continue;
      const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(ok ? 0.09 : 0.11, 8, 6), new THREE.MeshBasicMaterial({ color: ok ? "#eaf6ff" : "#ff4d4d", transparent: true, opacity: 0.9, depthWrite: false }), points.length);
      const at = new THREE.Matrix4();
      points.forEach((s, i) => {
        const { x, z } = hexToWorld(s.pos);
        dots.setMatrixAt(i, at.makeTranslation(x, this.top(s.pos) + 0.2, z + 0.25));
      });
      dots.renderOrder = 3;
      this.path.add(dots);
    }
  }

  /**
   * A compass rose glowing on the ground over `at` while a course is being charted there (Chart a Course), its north
   * pointing on along the course from `from`; dimmed when the mark cannot go there. Null takes it away.
   */
  setCompass(aim: { from: HexPos; at: HexPos; wrong: boolean } | null) {
    if (!aim) {
      if (this.compass) {
        this.group.remove(this.compass.rose, this.compass.glow);
        (this.compass.rose.material as THREE.Material).dispose();
        (this.compass.glow.material as THREE.Material).dispose();
        this.compass.rose.geometry.dispose();
      }
      this.compass = null;
      return;
    }
    if (!this.compass) {
      const plane = new THREE.PlaneGeometry(1, 1);
      const rose = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: compassRose(), transparent: true, depthWrite: false }));
      rose.rotation.x = -Math.PI / 2;
      rose.renderOrder = 5;
      const glow = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: "#ffd98a", map: glowTex(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.rotation.x = -Math.PI / 2;
      glow.scale.set(3.2, 3.2, 1);
      glow.renderOrder = 4;
      this.group.add(glow, rose);
      this.compass = { rose, glow, turn: 0, wrong: false };
    }
    const { x, z } = hexToWorld(aim.at);
    const y = this.top(aim.at);
    const o = hexToWorld(aim.from);
    // Laid just over the tops of the grass, so it is not lost in it.
    this.compass.rose.position.set(x, y + 0.34, z);
    this.compass.glow.position.set(x, y + 0.335, z);
    // North (up the texture, -y, which lying flat is -z) turned to point from the Sage on past the mark.
    this.compass.turn = Math.atan2(-(x - o.x), -(z - o.z));
    this.compass.wrong = aim.wrong;
  }

  /** The hexes courses are charted to (Chart a Course): a red X painted across each, a little above the ground. */
  setCharts(marks: HexPos[]) {
    const sig = marks.map(posKey).join(" ");
    if (sig === this.chartSig) return;
    this.chartSig = sig;
    this.clear(this.charts);
    for (const pos of marks) {
      const { x, z } = hexToWorld(pos);
      for (const turn of [Math.PI / 4, -Math.PI / 4]) {
        const stroke = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.03, 0.2), new THREE.MeshBasicMaterial({ color: "#ff3030", transparent: true, opacity: 0.92, depthWrite: false }));
        stroke.position.set(x, this.top(pos) + 0.09, z);
        stroke.rotation.y = turn;
        stroke.renderOrder = 4;
        this.charts.add(stroke);
      }
    }
  }

  /** A marker over the head of everyone whose turn it is, in the colour given: it follows them as they move. */
  setTurnMarkers(marks: { id: string; color: string }[]) {
    const sig = marks.map((m) => `${m.id}:${m.color}`).join("|");
    if (sig === this.markSig) return;
    this.markSig = sig;
    for (const { mesh } of this.marks) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.marks = marks.map(({ id, color }) => {
      // A little four-sided arrowhead, point down.
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.42, 4), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      mesh.rotation.x = Math.PI;
      mesh.renderOrder = 6;
      mesh.visible = false;
      this.group.add(mesh);
      return { id, mesh };
    });
  }

  /** Draw the ground as it now is: one sheet per kind of surface. */
  setSurfaces(surfaces: Record<string, { kind: SurfaceKind }>) {
    const sig = Object.entries(surfaces).map(([key, s]) => `${key}:${s.kind}`).sort().join("|");
    if (sig === this.groundSig) return;
    this.groundSig = sig;
    this.clear(this.ground);
    this.pulse = [];
    this.goo = [];
    this.flames = [];
    this.sparks = [];
    this.fumes = [];
    const byKind = new Map<SurfaceKind, HexPos[]>();
    for (const [key, s] of Object.entries(surfaces)) {
      const [q, r] = key.split(",").map(Number);
      byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), { q, r }]);
    }
    for (const [kind, hexes] of byKind) {
      let material: THREE.Material;
      if (kind === "oil" || kind === "slime") {
        // Goo: a gloss that rolls and gleams.
        const goo = this.keep(this.sheets, kind, () => gooMaterial(kind, SURFACE_INFO[kind].color));
        this.goo.push(goo);
        material = goo;
      } else if (kind === "poison") {
        // Poison: churning, bubbling and fuming (groundFx.ts).
        const poison = this.keep(this.sheets, kind, () => poisonMaterial(SURFACE_INFO.poison.color));
        this.goo.push(poison);
        material = poison;
        const fumes = poisonFumes(hexes, (p) => ({ ...hexToWorld(p), y: this.top(p) }), SURFACE_INFO.poison.color);
        this.ground.add(fumes);
        this.fumes.push(fumes);
      } else if (kind === "water") {
        // Water: wet, rippling, catching the sky (groundFx.ts).
        const water = this.keep(this.sheets, kind, () => waterMaterial(SURFACE_INFO.water.color));
        this.goo.push(water);
        material = water;
      } else {
        const base = kind === "ice" ? 0.75 : kind === "fire" ? 0.22 : 0.6;
        const flat = new THREE.MeshBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: base, depthWrite: false, side: THREE.DoubleSide });
        flat.userData.base = base;
        // Fire stirs; the rest lie still.
        if (kind === "fire") this.pulse.push(flat);
        material = flat;
      }
      if (kind === "fire") {
        // Burning ground: embers, flames and sparks on every hex of it.
        const fire = fireField(hexes, (p) => ({ ...hexToWorld(p), y: this.top(p) }));
        this.ground.add(fire.group);
        this.flames.push(...fire.flames);
        this.sparks.push(fire.sparks);
      }
      const mesh = new THREE.Mesh(this.fill(hexes, 0.03, 0.9), material);
      mesh.renderOrder = 1;
      this.ground.add(mesh);
      // Water's edge is soft: its rim only just shows.
      const rim = new THREE.LineSegments(this.outline(hexes, 0.04), new THREE.LineBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: kind === "water" ? 0.45 : 0.9 }));
      rim.renderOrder = 1;
      this.ground.add(rim);
    }
  }

  /**
   * Draw the weather: a pale wash and an outline over its hexes, and rain falling on them or wind
   * streaming across them, or (a Coral Field) branches of coral standing up out of them, or (Fortify) a wall of stone on them.
   */
  setWeather(list: { kind: WeatherKind; hexes: HexPos[] }[]) {
    const sig = list.map((w) => `${w.kind}:${w.hexes.map(posKey).join(",")}`).join("|");
    if (sig === this.skySig) return;
    this.skySig = sig;
    this.clear(this.sky);
    // Each wind called up blows hard over its own hexes: the grass and trees there lash about (wind.ts).
    setSqualls(
      list
        .filter((w) => w.kind === "wind" && w.hexes.length > 0)
        .map((w) => {
          const pts = w.hexes.map((p) => hexToWorld(p));
          const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
          const z = pts.reduce((a, p) => a + p.z, 0) / pts.length;
          return { x, z, radius: Math.max(...pts.map((p) => Math.hypot(p.x - x, p.z - z))) + 1.2, power: 1.4 };
        }),
    );
    this.drift = [];
    this.clouds = [];
    this.winds = [];
    for (const w of list) {
      const color = WEATHER_INFO[w.kind].color;
      const wash = new THREE.Mesh(this.fill(w.hexes, 0.05, 0.95), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
      wash.renderOrder = 2;
      this.sky.add(wash);
      const rim = new THREE.LineSegments(this.outline(w.hexes, 0.06), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      rim.renderOrder = 2;
      this.sky.add(rim);
      if (w.kind === "coral") {
        this.sky.add(this.coral(w.hexes, color));
        continue;
      }
      if (w.kind === "wall") {
        this.sky.add(this.stones(w.hexes, color));
        continue;
      }
      if (w.kind === "rain") {
        // The ground in the cloud's shade, the cloud, and its rain.
        const shade = new THREE.Mesh(this.fill(w.hexes, 0.055, 0.95), new THREE.MeshBasicMaterial({ color: "#1b2a3a", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
        shade.renderOrder = 2;
        this.sky.add(shade);
        this.rain(w.hexes);
        continue;
      }
      // Streaks of air running along the wind over each hex, and motes tumbling in them.
      this.sky.add(this.streaks(w.hexes, color));
      const per = 8;
      const base = new Float32Array(w.hexes.length * per * 3);
      const floor = new Float32Array(w.hexes.length * per);
      let k = 0;
      let f = 0;
      for (const p of w.hexes) {
        const { x, z } = hexToWorld(p);
        const y = this.top(p);
        for (let i = 0; i < per; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * 0.85;
          floor[f++] = y;
          base[k++] = x + Math.cos(a) * d;
          base[k++] = Math.random();
          base[k++] = z + Math.sin(a) * d;
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(base.slice(), 3));
      const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: 0.1, transparent: true, opacity: 0.8, depthWrite: false }));
      this.sky.add(points);
      this.drift.push({ points, base, floor });
    }
  }

  /**
   * A rain cloud over `hexes` (Soothing Rain): low-poly puffs, pale on top and heavy and grey underneath, cel-shaded
   * and inked as the figures are, half see-through so whoever stands under it can still be seen; and pale streaks
   * of rain falling from its belly to the ground.
   */
  private rain(hexes: HexPos[]) {
    const cloud = new THREE.Group();
    const puff = new THREE.IcosahedronGeometry(1, 1);
    // Cool greys with a little cool light of their own, so the cloud stays a rain cloud in warm afternoon sun.
    // See-through, so whoever stands in the rain and the ground under it show; writing depth all the same, so only the
    // cloud's near side is seen and not every puff and outline behind it muddled through it.
    const top = new THREE.MeshToonMaterial({ color: "#c9d4e4", emissive: "#1f2b40", gradientMap: toonRamp(), transparent: true, opacity: 0.55 });
    const belly = new THREE.MeshToonMaterial({ color: "#76869f", emissive: "#141c2c", gradientMap: toonRamp(), transparent: true, opacity: 0.6 });
    const ink = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide, transparent: true, opacity: 0.45 });
    const lay = (x: number, y: number, z: number, r: number, flat: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(puff, mat);
      m.position.set(x, y, z);
      m.scale.set(r, r * flat, r);
      const edge = new THREE.Mesh(puff, ink);
      edge.scale.setScalar(1.07);
      m.add(edge);
      m.userData.breath = Math.random() * Math.PI * 2;
      cloud.add(m);
    };
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p) + CLOUD_HEIGHT;
      lay(x, y + 0.15, z, 0.6, 0.75, top);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.random();
        lay(x + Math.cos(a) * 0.55, y + Math.random() * 0.15, z + Math.sin(a) * 0.55, 0.38 + Math.random() * 0.15, 0.8, top);
      }
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2;
        lay(x + Math.cos(a) * 0.3, y - 0.22, z + Math.sin(a) * 0.3, 0.55, 0.42, belly);
      }
    }
    cloud.renderOrder = 3;
    // Its middle, which it grows in from.
    const middle = new THREE.Vector3();
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      middle.add(new THREE.Vector3(x, this.top(p) + CLOUD_HEIGHT, z));
    }
    cloud.userData.middle = middle.divideScalar(Math.max(1, hexes.length));
    this.sky.add(cloud);
    // Streaks of rain: each drop a thin pale line, falling from the belly to the ground and starting again.
    const per = 30;
    const drops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), new THREE.MeshBasicMaterial({ color: "#d6ecff", transparent: true, opacity: 0.85, depthWrite: false }), hexes.length * per);
    const base = new Float32Array(hexes.length * per * 3);
    const floor = new Float32Array(hexes.length * per);
    let k = 0;
    let f = 0;
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p);
      for (let i = 0; i < per; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * 0.85;
        floor[f++] = y;
        base[k++] = x + Math.cos(a) * d;
        base[k++] = Math.random();
        base[k++] = z + Math.sin(a) * d;
      }
    }
    drops.frustumCulled = false;
    this.sky.add(drops);
    // (How see-through each part is at its fullest: the combat view thins the cloud further, see tickSky.)
    this.clouds.push({ cloud, drops, base, floor, born: -1, veil: [top, belly, ink, drops.material as THREE.Material].map((material) => ({ material, full: material.opacity })) });
  }

  /**
   * Streaks of wind over `hexes` (Trade Winds): thin pale strokes at a few heights, each running along the wind across
   * its hex, stretching out as it goes and thinning away, and round again (see tickSky).
   */
  private streaks(hexes: HexPos[], color: string): THREE.InstancedMesh {
    const per = 6;
    const geometry = new THREE.PlaneGeometry(1, 0.035);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.3), transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }), hexes.length * per);
    const base: number[] = [];
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p);
      for (let i = 0; i < per; i++) base.push(x + (Math.random() - 0.5) * 0.6, y + 0.2 + Math.random() * 0.9, z + (Math.random() - 0.5) * 1.2, Math.random());
    }
    mesh.userData.wind = base;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.winds.push(mesh);
    return mesh;
  }

  /** Branches of coral standing up off each hex, leaning every which way, in a few shades of the colour. */
  private coral(hexes: HexPos[], color: string): THREE.InstancedMesh {
    const per = 7;
    const geometry = new THREE.ConeGeometry(0.06, 1, 5);
    geometry.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), hexes.length * per);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const tint = new THREE.Color();
    const base = new THREE.Color(color);
    let i = 0;
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p);
      for (let k = 0; k < per; k++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * 0.7;
        const tall = 0.18 + Math.random() * 0.28;
        q.setFromEuler(e.set((Math.random() - 0.5) * 0.9, Math.random() * Math.PI, (Math.random() - 0.5) * 0.9));
        m.compose(new THREE.Vector3(x + Math.cos(a) * d, y, z + Math.sin(a) * d), q, new THREE.Vector3(1 + Math.random(), tall, 1 + Math.random()));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tint.copy(base).offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.2));
        i++;
      }
    }
    mesh.renderOrder = 2;
    return mesh;
  }

  /** A wall (Fortify): courses of rough stone blocks stacked up off each hex, each a little off true, in shades of the colour. */
  private stones(hexes: HexPos[], color: string): THREE.InstancedMesh {
    const courses = 3;
    const per = 2;
    const geometry = new THREE.BoxGeometry(0.62, 0.3, 0.62);
    geometry.translate(0, 0.15, 0);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), hexes.length * courses * per);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const tint = new THREE.Color();
    const base = new THREE.Color(color);
    let i = 0;
    for (const p of hexes) {
      const { x, z } = hexToWorld(p);
      const y = this.top(p);
      for (let c = 0; c < courses; c++) {
        // Each course turned a little against the one under it, so the joints do not line up.
        const turn = c * 0.7 + Math.random() * 0.2;
        for (let k = 0; k < per; k++) {
          const a = turn + k * Math.PI;
          q.setFromEuler(e.set((Math.random() - 0.5) * 0.08, turn, (Math.random() - 0.5) * 0.08));
          m.compose(new THREE.Vector3(x + Math.cos(a) * 0.2, y + c * 0.3, z + Math.sin(a) * 0.2), q, new THREE.Vector3(1, 0.9 + Math.random() * 0.2, 1));
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, tint.copy(base).offsetHSL(0, -0.1, (Math.random() - 0.5) * 0.18));
          i++;
        }
      }
    }
    mesh.renderOrder = 2;
    return mesh;
  }

  /** Rain clouds grow in and bob, and their rain falls and starts again at the top; wind blows its motes along and round again. */
  private tickSky(clock: number) {
    const m = SKY_M;
    for (const c of this.clouds) {
      if (c.born < 0) c.born = clock;
      // Growing in from nothing as the rain begins, then bobbing, each puff swelling and settling on its own.
      const grow = Math.min(1, (clock - c.born) / 0.7);
      const s = 1 - (1 - grow) ** 3;
      c.cloud.scale.set(s, s, s);
      // While the combat view is on the cloud is thinner still: it is there to be read, and whoever stands under it is seen.
      for (const v of c.veil) v.material.opacity = v.full * (1 - 0.6 * this.renderer.cutaway);
      c.cloud.position.y = Math.sin(clock * 0.8) * 0.05;
      for (const puff of c.cloud.children) puff.rotation.y = Math.sin(clock * 0.5 + (puff.userData.breath as number)) * 0.15;
      // The cloud grows from its own middle, not the map's.
      const middle = c.cloud.userData.middle as THREE.Vector3;
      c.cloud.position.x = middle.x * (1 - s);
      c.cloud.position.z = middle.z * (1 - s);
      c.cloud.position.y += middle.y * (1 - s);
      for (let i = 0; i < c.drops.count; i++) {
        const fall = (clock * 1.6 + c.base[i * 3 + 1]) % 1;
        const y = c.floor[i] + 0.13 + (CLOUD_HEIGHT - 0.55) * (1 - fall);
        m.makeTranslation(c.base[i * 3], grow < 1 ? -1000 : y, c.base[i * 3 + 2]);
        c.drops.setMatrixAt(i, m);
      }
      c.drops.instanceMatrix.needsUpdate = true;
    }
    // Each streak runs along the wind over its hex, swelling in and thinning away, and round again.
    const q = WIND_TILT;
    const at = SKY_AT;
    const size = SKY_SIZE;
    for (const mesh of this.winds) {
      const base = mesh.userData.wind as number[];
      for (let i = 0; i < mesh.count; i++) {
        const x = base[i * 4];
        const y = base[i * 4 + 1];
        const z = base[i * 4 + 2];
        const phase = base[i * 4 + 3];
        const t = (clock * 0.7 + phase) % 1;
        const swell = Math.sin(Math.PI * t);
        at.set(x - 0.6 + 1.2 * t, y + Math.sin(clock * 2 + phase * 9) * 0.05, z);
        size.set(0.2 + 0.6 * swell, Math.max(0.01, swell), 1);
        m.compose(at, q, size);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const { points, base, floor } of this.drift) {
      const pos = points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3];
        const phase = base[i * 3 + 1];
        const bz = base[i * 3 + 2];
        // Low over the ground, running along and round again.
        const run = ((clock * 0.5 + phase) % 1) - 0.5;
        pos.setXYZ(i, bx + run * 0.9, floor[i] + 0.2 + phase * 0.7 + Math.sin(clock * 2 + i) * 0.05, bz + Math.sin(clock + i) * 0.08);
      }
      pos.needsUpdate = true;
    }
  }
}
