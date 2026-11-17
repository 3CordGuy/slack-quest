// What a fight on the tiles lays over the map: tinted, outlined regions of
// hexes (how far an ability reaches, the area it will cover, where an
// enemy group can see), and the surfaces on the ground (poison, fire, oil,
// water, ice). It draws through the renderer's public hooks and knows
// nothing of the rules: the view tells it which hexes and what colour.

import * as THREE from "three";
import { fireField, gooMaterial, tickGround } from "./groundFx";
import { posKey, type HexPos } from "@gantt-quest/core";
import { SURFACE_INFO, WEATHER_INFO, tileAt, type SurfaceKind, type WorldMap } from "@gantt-quest/world";
import { hexToWorld, tileTop, type WorldRenderer } from "./WorldRenderer";

/** A set of hexes to mark: filled faintly, outlined round its edge, or both. */
export interface Overlay {
  hexes: HexPos[];
  color: string;
  /** How solid the fill is, 0 to 1. Left out: no fill. */
  fill?: number;
  /** How solid the outline is, 0 to 1. Left out: no outline. */
  line?: number;
}

const SQRT3 = Math.sqrt(3);
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
  private stop: () => void;
  /** Surfaces breathe a little, so the ground looks alive. */
  private pulse: THREE.MeshBasicMaterial[] = [];
  /** And what lies on the ground moves (groundFx.ts): goo rolls and gleams, fire flickers and throws sparks. */
  private goo: THREE.ShaderMaterial[] = [];
  private flames: THREE.Object3D[] = [];
  private sparks: THREE.Points[] = [];
  /** Weather over the ground (zone/weather.ts): its drops or gusts, each with where it started and its kind. */
  private sky = new THREE.Group();
  private skySig = "";
  private drift: { points: THREE.Points; base: Float32Array; floor: Float32Array; kind: "rain" | "wind" }[] = [];

  constructor(private renderer: WorldRenderer) {
    this.group.add(this.ground, this.sky, this.overlays, this.path);
    renderer.addObject(this.group);
    this.stop = renderer.addTicker((_dt, _camera, clock) => {
      for (const [i, m] of this.pulse.entries()) m.opacity = (m.userData.base as number) * (0.82 + 0.18 * Math.sin(clock * 2.2 + i));
      tickGround(clock, this.goo, this.flames, this.sparks);
      this.tickSky(clock);
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
    this.clear(this.overlays);
    this.clear(this.ground);
    this.clear(this.sky);
    this.clear(this.path);
    this.setArc(null);
    this.setTurnMarkers([]);
    this.renderer.removeObject(this.group);
  }

  setMap(map: WorldMap) {
    if (this.map?.tiles === map.tiles) return;
    this.map = map;
    this.overlaySig = this.groundSig = this.skySig = "";
  }

  private clear(group: THREE.Group) {
    // Whatever is in it, however deep (a fire is a group of embers, flames and sparks).
    group.traverse((o) => {
      if (o === group || !(o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points)) return;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
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
    const sig = list.map((o) => `${o.color}:${o.fill ?? 0}:${o.line ?? 0}:${o.hexes.map(posKey).join(" ")}`).join("|");
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;
    this.clear(this.overlays);
    list.forEach((o, i) => {
      if (o.hexes.length === 0) return;
      if (o.fill) {
        const mesh = new THREE.Mesh(this.fill(o.hexes, 0.05 + i * 0.004, 0.94), new THREE.MeshBasicMaterial({ color: o.color, transparent: true, opacity: o.fill, depthWrite: false, side: THREE.DoubleSide }));
        mesh.renderOrder = 2;
        this.overlays.add(mesh);
      }
      if (o.line) {
        const lines = new THREE.LineSegments(this.outline(o.hexes, 0.07 + i * 0.004), new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: o.line, depthTest: false }));
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
    const byKind = new Map<SurfaceKind, HexPos[]>();
    for (const [key, s] of Object.entries(surfaces)) {
      const [q, r] = key.split(",").map(Number);
      byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), { q, r }]);
    }
    for (const [kind, hexes] of byKind) {
      let material: THREE.Material;
      if (kind === "oil" || kind === "slime") {
        // Goo: a gloss that rolls and gleams.
        const goo = gooMaterial(kind, SURFACE_INFO[kind].color);
        this.goo.push(goo);
        material = goo;
      } else {
        const base = kind === "ice" ? 0.75 : kind === "fire" ? 0.22 : 0.6;
        const flat = new THREE.MeshBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: base, depthWrite: false, side: THREE.DoubleSide });
        flat.userData.base = base;
        // Fire and poison stir; the rest lie still.
        if (kind === "fire" || kind === "poison") this.pulse.push(flat);
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
      const rim = new THREE.LineSegments(this.outline(hexes, 0.04), new THREE.LineBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: 0.9 }));
      rim.renderOrder = 1;
      this.ground.add(rim);
    }
  }

  /**
   * Draw the weather: a pale wash and an outline over its hexes, and rain falling on them or wind
   * streaming across them.
   */
  setWeather(list: { kind: "rain" | "wind"; hexes: HexPos[] }[]) {
    const sig = list.map((w) => `${w.kind}:${w.hexes.map(posKey).join(",")}`).join("|");
    if (sig === this.skySig) return;
    this.skySig = sig;
    this.clear(this.sky);
    this.drift = [];
    for (const w of list) {
      const color = WEATHER_INFO[w.kind].color;
      const wash = new THREE.Mesh(this.fill(w.hexes, 0.05, 0.95), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
      wash.renderOrder = 2;
      this.sky.add(wash);
      const rim = new THREE.LineSegments(this.outline(w.hexes, 0.06), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      rim.renderOrder = 2;
      this.sky.add(rim);
      // Motes scattered over each hex: drops that fall, or gusts that run along the wind.
      const per = w.kind === "rain" ? 26 : 14;
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
      const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: w.kind === "rain" ? 0.07 : 0.1, transparent: true, opacity: 0.8, depthWrite: false }));
      this.sky.add(points);
      this.drift.push({ points, base, floor, kind: w.kind });
    }
  }

  /** Rain falls and starts again at the top; wind blows its motes along and round again. */
  private tickSky(clock: number) {
    for (const { points, base, floor, kind } of this.drift) {
      const pos = points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3];
        const phase = base[i * 3 + 1];
        const bz = base[i * 3 + 2];
        if (kind === "rain") {
          // From 2.4 above the ground down to it, over and over.
          const fall = (clock * 1.6 + phase) % 1;
          pos.setXYZ(i, bx, floor[i] + 2.4 * (1 - fall), bz);
        } else {
          // Low over the ground, running along and round again.
          const run = ((clock * 0.5 + phase) % 1) - 0.5;
          pos.setXYZ(i, bx + run * 0.9, floor[i] + 0.2 + phase * 0.7 + Math.sin(clock * 2 + i) * 0.05, bz + Math.sin(clock + i) * 0.08);
        }
      }
      pos.needsUpdate = true;
    }
  }
}
