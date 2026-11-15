// What a fight on the tiles lays over the map: tinted, outlined regions of
// hexes (how far an ability reaches, the area it will cover, where an
// enemy group can see), and the surfaces on the ground (poison, fire, oil,
// water, ice). It draws through the renderer's public hooks and knows
// nothing of the rules: the view tells it which hexes and what colour.

import * as THREE from "three";
import { posKey, type HexPos } from "@gantt-quest/core";
import { SURFACE_INFO, tileAt, type SurfaceKind, type WorldMap } from "@gantt-quest/world";
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
  private overlaySig = "";
  private groundSig = "";
  private stop: () => void;
  /** Surfaces breathe a little, so the ground looks alive. */
  private pulse: THREE.MeshBasicMaterial[] = [];

  constructor(private renderer: WorldRenderer) {
    this.group.add(this.ground, this.overlays);
    renderer.addObject(this.group);
    this.stop = renderer.addTicker((_dt, _camera, clock) => {
      for (const [i, m] of this.pulse.entries()) m.opacity = (m.userData.base as number) * (0.82 + 0.18 * Math.sin(clock * 2.2 + i));
    });
  }

  dispose() {
    this.stop();
    this.clear(this.overlays);
    this.clear(this.ground);
    this.renderer.removeObject(this.group);
  }

  setMap(map: WorldMap) {
    if (this.map?.tiles === map.tiles) return;
    this.map = map;
    this.overlaySig = this.groundSig = "";
  }

  private clear(group: THREE.Group) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
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

  /** Draw the ground as it now is: one sheet per kind of surface. */
  setSurfaces(surfaces: Record<string, { kind: SurfaceKind }>) {
    const sig = Object.entries(surfaces).map(([key, s]) => `${key}:${s.kind}`).sort().join("|");
    if (sig === this.groundSig) return;
    this.groundSig = sig;
    this.clear(this.ground);
    this.pulse = [];
    const byKind = new Map<SurfaceKind, HexPos[]>();
    for (const [key, s] of Object.entries(surfaces)) {
      const [q, r] = key.split(",").map(Number);
      byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), { q, r }]);
    }
    for (const [kind, hexes] of byKind) {
      const base = kind === "ice" ? 0.75 : kind === "oil" ? 0.7 : 0.6;
      const material = new THREE.MeshBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: base, depthWrite: false, side: THREE.DoubleSide });
      material.userData.base = base;
      // Fire and poison stir; the rest lie still.
      if (kind === "fire" || kind === "poison") this.pulse.push(material);
      const mesh = new THREE.Mesh(this.fill(hexes, 0.03, 0.9), material);
      mesh.renderOrder = 1;
      this.ground.add(mesh);
      const rim = new THREE.LineSegments(this.outline(hexes, 0.04), new THREE.LineBasicMaterial({ color: SURFACE_INFO[kind].color, transparent: true, opacity: 0.9 }));
      rim.renderOrder = 1;
      this.ground.add(rim);
    }
  }
}
