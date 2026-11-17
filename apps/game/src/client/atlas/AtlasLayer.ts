// What the atlas stands on its world: the places themselves, and the routes
// between them.
//
// A place is a thing on its own hex, not a marker floating over the map: a
// dais of dark stone with a ring of light let into it and a cut stone
// turning above, in a pool of its own light. Blue is somewhere still to be
// cleared, and it breathes, with a beam standing up out of it so it can be
// found from a long way off (taller the more dangerous it is, and gold while
// some of the crew are there). What is odd about it circles its stone as
// motes: teal for the ground, red for the enemy, gold for a boon. Green is somewhere the crew
// has cleared: its stone has settled onto the dais and burns low and steady.
// A lookout has three pale spires standing round its dais, and a lair a ring
// of short dark thorns, so each can be told from a landfall at a glance.
// The Harbor has a ring of gold round the foot of its lighthouse. Somewhere
// nothing is known of is a dark ring lying on top of the cloud.
//
// A route is a line of small dashes laid on the ground (or on the cloud, where
// that is all there is), following its rise and fall, and bent a little,
// each its own way: nobody sails or walks dead straight. Each dash lies on a
// darker one a little bigger, so the line shows on pale sand as well as it
// does on dark water. A route on to somewhere open runs with light, from the
// place the crew holds toward the one it does not; and the way from the
// Harbor to the place picked is laid over in gold.
//
// It draws through the renderer's public hooks (addObject, addTicker) and
// knows nothing of the rules: the view tells it what stands where, how it
// looks and how high. Everything is instanced, so a crowded atlas is still a
// handful of draws.

import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";
import { hexToWorld, type WorldRenderer } from "../render/WorldRenderer";

export type AtlasLook = "harbor" | "open" | "cleared" | "fogged";
export interface AtlasMark {
  id: string;
  hex: HexPos;
  look: AtlasLook;
  /** What is odd about it, for somewhere open: a mote each, circling its stone. */
  motes?: ("map" | "enemy" | "boon")[];
  /** Some of the crew are there now. */
  busy?: boolean;
  /** How much taller than the least its beam stands, from 0: the more dangerous, the taller. */
  danger?: number;
  /** What stands round its dais, for a place that is more than a landfall. */
  crown?: "lookout" | "lair";
}
export interface AtlasRoute {
  key: string;
  /** For a route on to somewhere open, `a` is the end the crew holds. */
  a: HexPos;
  b: HexPos;
  /** Between places both reached; on to somewhere open; or off into the unknown. */
  kind: "sailed" | "open" | "fog";
}
/** How high something stands at a spot of the world, and whether that is on the cloud (where that is all there is) and not on the ground. */
export type Rise = (x: number, z: number) => { y: number; aloft: boolean };

/** How each look is lit: the ring and pool's colour, the stone's (paler, so it glows), and how strong the pool and the halo are. */
const LOOKS: Record<AtlasLook, { ring: string; stone: string; pool: number; halo: number; size: number }> = {
  open: { ring: "#3fa9ff", stone: "#c9ecff", pool: 0.62, halo: 0.46, size: 1 },
  cleared: { ring: "#4fd47a", stone: "#b9f5c6", pool: 0.3, halo: 0.26, size: 1 },
  harbor: { ring: "#ffcf5a", stone: "#fff1c9", pool: 0.5, halo: 0, size: 1.95 },
  fogged: { ring: "#3a445e", stone: "#3a445e", pool: 0, halo: 0, size: 0.74 },
};
const ROUTE_COLOR: Record<AtlasRoute["kind"], string> = { sailed: "#fff3d0", open: "#8fd0ff", fog: "#465070" };
const MOTE_COLOR = { map: "#5fe6e0", enemy: "#ff6a5c", boon: "#ffd24a" };
const GOLD = new THREE.Color("#ffd772");
const WHITE = new THREE.Color("#ffffff");
/** How far apart a route's dashes are laid, in world units, and how far short of a place they stop. */
const DASH_GAP: Record<AtlasRoute["kind"], number> = { sailed: 0.46, open: 0.46, fog: 0.74 };
const DASH_CLEAR = 0.95;
/** How far a route bows off the straight line, as a share of its length. */
const BOW = 0.2;

/** A number from 0 to 1 out of a string, the same every time. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** A soft round glow, white in the middle and gone at the edge: for the pools of light and the halos. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const fade = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  fade.addColorStop(0, "rgba(255,255,255,1)");
  fade.addColorStop(0.22, "rgba(255,255,255,0.62)");
  fade.addColorStop(0.55, "rgba(255,255,255,0.18)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A beam's fade: bright at its foot, gone at its top. */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 64;
  const g = c.getContext("2d")!;
  const fade = g.createLinearGradient(0, 0, 0, 64);
  fade.addColorStop(0, "rgba(255,255,255,0)");
  fade.addColorStop(0.55, "rgba(255,255,255,0.3)");
  fade.addColorStop(1, "rgba(255,255,255,0.95)");
  g.fillStyle = fade;
  g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
}

/** A cut stone: eight faces, each its own shade, so it reads as a gem though nothing lights it. */
function stoneGeometry(): THREE.BufferGeometry {
  const geo = new THREE.OctahedronGeometry(0.24, 0).toNonIndexed();
  geo.scale(1, 1.4, 1);
  const shades = [1, 0.74, 0.9, 0.62, 0.82, 0.58, 0.96, 0.68];
  const colors: number[] = [];
  for (let face = 0; face < 8; face++) for (let v = 0; v < 3; v++) colors.push(shades[face], shades[face], shades[face]);
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

interface Placed {
  mark: AtlasMark;
  x: number;
  y: number;
  z: number;
  /** On the cloud, not the ground. */
  aloft: boolean;
  /** Where it is among the instances of each part it has (-1: it has none). */
  ring: number;
  pool: number;
  stone: number;
  halo: number;
  beam: number;
  /** Where its first mote is among the motes. */
  mote: number;
  phase: number;
}
/** One dash of a route: where it lies, how it is turned, and how far along the route it is, in world units. */
interface Dash {
  x: number;
  y: number;
  z: number;
  yaw: number;
  along: number;
}

/** The beam's own height, before a place's danger stretches it. */
const BEAM = 3.4;
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
// The cloud is drawn over everything under it. What lies on top of it (a ring, a dash) is drawn after it: its own part.
type Part = "dais" | "ring" | "ringAloft" | "pool" | "stone" | "halo" | "beam" | "mote" | "spike" | "dash" | "dashAloft" | "shade" | "flow" | "trail";
/** What stands round a dais: how many, how far out, how tall and thick, how far they lean outward, and their colour. */
const CROWN = {
  lookout: { count: 3, out: 0.6, tall: 0.95, thick: 1, lean: 0.06, color: "#e9dcae" },
  lair: { count: 6, out: 0.63, tall: 0.42, thick: 1.5, lean: 0.42, color: "#7d2230" },
};
/** Drawn after the cloud. */
const ALOFT = 6;

const light = (map?: THREE.Texture, side: THREE.Side = THREE.FrontSide) =>
  new THREE.MeshBasicMaterial({ color: "#ffffff", map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side, fog: false });
const solid = (extra: THREE.MeshBasicMaterialParameters = {}) => new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, ...extra });

export class AtlasLayer {
  private group = new THREE.Group();
  private glow = glowTexture();
  private fade = beamTexture();
  private geo: Record<Part | "band", THREE.BufferGeometry> = {
    // Six-sided, its corners where the hex's are.
    dais: new THREE.CylinderGeometry(0.56, 0.66, 0.14, 6),
    ring: new THREE.TorusGeometry(0.44, 0.065, 8, 30).rotateX(Math.PI / 2),
    ringAloft: new THREE.TorusGeometry(0.44, 0.065, 8, 30).rotateX(Math.PI / 2),
    pool: new THREE.CircleGeometry(2.5, 28).rotateX(-Math.PI / 2),
    stone: stoneGeometry(),
    halo: new THREE.PlaneGeometry(1, 1),
    // Its foot at its own origin, so it can be stretched upward.
    beam: new THREE.CylinderGeometry(0.04, 0.17, BEAM, 10, 1, true).translate(0, BEAM / 2, 0),
    mote: new THREE.OctahedronGeometry(0.075, 0),
    // A unit tall, its foot at its own origin.
    spike: new THREE.ConeGeometry(0.06, 1, 5).translate(0, 0.5, 0),
    dash: new THREE.PlaneGeometry(0.3, 0.11).rotateX(-Math.PI / 2),
    dashAloft: new THREE.PlaneGeometry(0.3, 0.11).rotateX(-Math.PI / 2),
    shade: new THREE.PlaneGeometry(0.4, 0.21).rotateX(-Math.PI / 2),
    flow: new THREE.PlaneGeometry(0.32, 0.13).rotateX(-Math.PI / 2),
    trail: new THREE.PlaneGeometry(0.36, 0.17).rotateX(-Math.PI / 2),
    band: new THREE.TorusGeometry(0.82, 0.04, 6, 40).rotateX(Math.PI / 2),
  };
  private mat: Record<Part | "picked" | "hovered", THREE.Material> = {
    dais: new THREE.MeshLambertMaterial({ color: "#39404f" }),
    ring: solid(),
    ringAloft: solid({ transparent: true, depthWrite: false }),
    pool: light(this.glow),
    stone: solid({ vertexColors: true }),
    halo: light(this.glow),
    beam: light(this.fade, THREE.DoubleSide),
    mote: solid(),
    spike: new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true }),
    dash: solid(),
    dashAloft: solid({ transparent: true, depthWrite: false }),
    shade: new THREE.MeshBasicMaterial({ color: "#10131f", transparent: true, opacity: 0.42, depthWrite: false }),
    flow: solid(),
    trail: solid(),
    picked: solid(),
    hovered: solid({ transparent: true, opacity: 0.7 }),
  };
  /** The instanced parts, made anew whenever what stands on the atlas changes. */
  private parts: Partial<Record<Part, THREE.InstancedMesh>> = {};
  private placed: Placed[] = [];
  private byId = new Map<string, Placed>();
  /** Every route's dashes, by the route's key: for laying the way to a place over them. */
  private dashes = new Map<string, Dash[]>();
  /** The dashes that run with light: the routes on to somewhere open, then (from `trailFrom`) the way to the place picked. */
  private flowing: Dash[] = [];
  private trailing: Dash[] = [];
  private path: { key: string; back: boolean }[] = [];
  private pickedBand = new THREE.Mesh(this.geo.band, this.mat.picked);
  private hoverBand = new THREE.Mesh(this.geo.band, this.mat.hovered);
  private picked: string | null = null;
  private hovered: string | null = null;
  private stop: () => void;
  // Scratch, so a frame makes no garbage.
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private c = new THREE.Color();
  private at = new THREE.Vector3();
  private size = new THREE.Vector3();

  constructor(private renderer: WorldRenderer) {
    this.pickedBand.visible = this.hoverBand.visible = false;
    this.hoverBand.scale.setScalar(0.86);
    this.group.add(this.pickedBand, this.hoverBand);
    renderer.addObject(this.group);
    this.stop = renderer.addTicker((_dt, camera, clock) => this.tick(camera, clock));
  }

  dispose() {
    this.stop();
    this.clear();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.glow.dispose();
    this.fade.dispose();
    this.renderer.removeObject(this.group);
  }

  private drop(name: Part) {
    const mesh = this.parts[name];
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.dispose();
    delete this.parts[name];
  }

  private clear() {
    for (const name of Object.keys(this.parts) as Part[]) this.drop(name);
    this.placed = [];
    this.byId.clear();
    this.dashes.clear();
    this.flowing = [];
    this.trailing = [];
  }

  private make(name: Part, n: number, order = 0): THREE.InstancedMesh {
    this.drop(name);
    const mesh = new THREE.InstancedMesh(this.geo[name], this.mat[name], Math.max(1, n));
    mesh.count = n;
    // Spread all over the map: never worth culling as one.
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    this.parts[name] = mesh;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Stand these places and lay these routes, in place of whatever was there. `rise` says how high each stands:
   * call after the renderer has been given the ground, as it is most likely asking the renderer.
   */
  set(marks: readonly AtlasMark[], routes: readonly AtlasRoute[], rise: Rise) {
    this.clear();
    const { m, q, c } = this;
    const count = { dais: 0, ring: 0, ringAloft: 0, pool: 0, stone: 0, halo: 0, beam: 0, mote: 0 };
    for (const mark of marks) {
      const { x, z } = hexToWorld(mark.hex);
      const known = mark.look === "open" || mark.look === "cleared";
      const motes = mark.look === "open" ? (mark.motes?.length ?? 0) : 0;
      const { y, aloft } = rise(x, z);
      const p: Placed = {
        mark, x, y, z, aloft,
        ring: aloft ? count.ringAloft++ : count.ring++,
        pool: mark.look === "fogged" ? -1 : count.pool++,
        stone: known ? count.stone++ : -1,
        halo: known ? count.halo++ : -1,
        beam: mark.look === "open" ? count.beam++ : -1,
        mote: motes > 0 ? count.mote : -1,
        phase: hashOf(mark.id) * Math.PI * 2,
      };
      count.mote += motes;
      if (known) count.dais++;
      this.placed.push(p);
      this.byId.set(mark.id, p);
    }

    const dais = this.make("dais", count.dais);
    dais.receiveShadow = true;
    dais.castShadow = true;
    const ring = this.make("ring", count.ring);
    const ringAloft = this.make("ringAloft", count.ringAloft, ALOFT);
    const pool = this.make("pool", count.pool, 3);
    this.make("stone", count.stone);
    this.make("halo", count.halo, 4);
    // After the cloud: a beam stands up through it.
    const beam = this.make("beam", count.beam, 7);
    const mote = this.make("mote", count.mote);
    const crowned = this.placed.filter((p) => p.mark.crown && p.stone >= 0);
    const spike = this.make("spike", crowned.reduce((n, p) => n + CROWN[p.mark.crown!].count, 0));
    spike.castShadow = true;
    let s = 0;
    for (const p of crowned) {
      const crown = CROWN[p.mark.crown!];
      for (let i = 0; i < crown.count; i++) {
        const a = p.phase + (i / crown.count) * Math.PI * 2;
        // Leaning outward, away from the middle.
        q.setFromAxisAngle(this.at.set(Math.cos(a), 0, -Math.sin(a)), crown.lean);
        spike.setMatrixAt(s, m.compose(this.at.set(p.x + Math.sin(a) * crown.out, p.y + 0.02, p.z + Math.cos(a) * crown.out), q, this.size.set(crown.thick, crown.tall, crown.thick)));
        spike.setColorAt(s++, c.set(crown.color));
      }
    }

    let d = 0;
    q.identity();
    for (const p of this.placed) {
      const look = LOOKS[p.mark.look];
      const known = p.stone >= 0;
      // The Harbor's ring lies on the grass round its lighthouse; a place's own is let into the top of its dais.
      const lift = known ? 0.15 : 0.05;
      if (known) dais.setMatrixAt(d++, m.compose(this.at.set(p.x, p.y + 0.07, p.z), q, ONE));
      const band = p.aloft ? ringAloft : ring;
      band.setMatrixAt(p.ring, m.compose(this.at.set(p.x, p.y + lift, p.z), q, this.size.set(look.size, 1, look.size)));
      band.setColorAt(p.ring, c.set(look.ring));
      if (p.pool >= 0) {
        pool.setMatrixAt(p.pool, m.compose(this.at.set(p.x, p.y + 0.1, p.z), q, this.size.set(look.size, 1, look.size)));
        pool.setColorAt(p.pool, c.set(look.ring).multiplyScalar(look.pool));
      }
      if (p.beam >= 0) {
        beam.setMatrixAt(p.beam, m.compose(this.at.set(p.x, p.y + 0.2, p.z), q, this.size.set(1, 1 + (p.mark.danger ?? 0), 1)));
        beam.setColorAt(p.beam, c.set(look.ring).multiplyScalar(0.5));
      }
      p.mark.motes?.forEach((kind, i) => p.mote >= 0 && mote.setColorAt(p.mote + i, c.set(MOTE_COLOR[kind])));
    }

    // ---- routes: dashes laid along a bowed line, on the ground or the cloud ----
    const still: { s: Dash; kind: AtlasRoute["kind"] }[] = [];
    const aloft: { s: Dash; kind: AtlasRoute["kind"] }[] = [];
    for (const r of routes) {
      const a = hexToWorld(r.a);
      const b = hexToWorld(r.b);
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < DASH_CLEAR * 2 + 0.2) continue;
      // Bowed to one side or the other, never quite straight; a quadratic curve through a point off the middle.
      const bow = (hashOf(r.key) < 0.5 ? -1 : 1) * (0.35 + 0.65 * hashOf(r.key + "~")) * BOW * length;
      const mx = (a.x + b.x) / 2 + (-dz / length) * bow, mz = (a.z + b.z) / 2 + (dx / length) * bow;
      const steps = Math.max(2, Math.round((length * (1 + 0.6 * BOW * BOW)) / DASH_GAP[r.kind]));
      const own: Dash[] = [];
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const x = u * u * a.x + 2 * u * t * mx + t * t * b.x;
        const z = u * u * a.z + 2 * u * t * mz + t * t * b.z;
        if (Math.hypot(x - a.x, z - a.z) < DASH_CLEAR || Math.hypot(x - b.x, z - b.z) < DASH_CLEAR) continue;
        const tx = 2 * u * (mx - a.x) + 2 * t * (b.x - mx), tz = 2 * u * (mz - a.z) + 2 * t * (b.z - mz);
        const at = rise(x, z);
        const s: Dash = { x, y: at.y + 0.045, z, yaw: Math.atan2(-tz, tx), along: t * length };
        own.push(s);
        if (r.kind === "open") this.flowing.push(s);
        else (at.aloft ? aloft : still).push({ s, kind: r.kind });
      }
      this.dashes.set(r.key, own);
    }
    // The dark under each dash on the ground. (On the cloud a dash is dark itself, and needs none.)
    const all = [...still.map((e) => e.s), ...this.flowing];
    const shade = this.make("shade", all.length, 1);
    all.forEach((s, i) => shade.setMatrixAt(i, m.compose(this.at.set(s.x, s.y - 0.012, s.z), q.setFromAxisAngle(UP, s.yaw), ONE)));
    const dash = this.make("dash", still.length);
    still.forEach(({ s, kind }, i) => {
      dash.setMatrixAt(i, m.compose(this.at.set(s.x, s.y, s.z), q.setFromAxisAngle(UP, s.yaw), ONE));
      dash.setColorAt(i, c.set(ROUTE_COLOR[kind]));
    });
    const dashAloft = this.make("dashAloft", aloft.length, ALOFT);
    aloft.forEach(({ s, kind }, i) => {
      dashAloft.setMatrixAt(i, m.compose(this.at.set(s.x, s.y, s.z), q.setFromAxisAngle(UP, s.yaw), ONE));
      dashAloft.setColorAt(i, c.set(ROUTE_COLOR[kind]));
    });
    const flow = this.make("flow", this.flowing.length);
    this.flowing.forEach((s, i) => flow.setMatrixAt(i, m.compose(this.at.set(s.x, s.y + 0.004, s.z), q.setFromAxisAngle(UP, s.yaw), ONE)));

    for (const mesh of Object.values(this.parts)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.band(this.pickedBand, this.picked);
    this.band(this.hoverBand, this.hovered);
    this.setPath(this.path);
  }

  /** Put a band round a place (or away, for none, or for one that is not on the map). */
  private band(band: THREE.Mesh, id: string | null) {
    const p = id ? this.byId.get(id) : undefined;
    band.visible = !!p;
    if (p) band.position.set(p.x, p.y + (p.stone >= 0 ? 0.17 : 0.08), p.z);
  }

  /** The place picked wears a bright band, slowly breathing; the one pointed at, a fainter one. */
  setPicked(id: string | null) {
    this.picked = id;
    this.band(this.pickedBand, id);
  }

  setHovered(id: string | null) {
    this.hovered = id;
    this.band(this.hoverBand, id);
  }

  /**
   * Lay the way to a place over its routes in gold: the routes to follow, in order from the Harbor, each
   * marked `back` if it is to be followed from its `b` end to its `a`. An empty list takes it away.
   */
  setPath(path: { key: string; back: boolean }[]) {
    this.path = path;
    this.trailing = [];
    let gone = 0;
    for (const step of path) {
      const own = this.dashes.get(step.key);
      if (!own || own.length === 0) continue;
      const span = own[own.length - 1].along + own[0].along;
      // How far along the whole way each dash is, whichever way its own route was laid.
      for (const s of step.back ? [...own].reverse() : own) this.trailing.push({ ...s, along: gone + (step.back ? span - s.along : s.along) });
      gone += span;
    }
    const trail = this.make("trail", this.trailing.length);
    const { m, q } = this;
    this.trailing.forEach((s, i) => trail.setMatrixAt(i, m.compose(this.at.set(s.x, s.y + 0.012, s.z), q.setFromAxisAngle(UP, s.yaw), ONE)));
    trail.instanceMatrix.needsUpdate = true;
  }

  private tick(camera: THREE.PerspectiveCamera, clock: number) {
    const { ring, pool, stone, halo, beam, mote, flow, trail } = this.parts;
    if (!stone || !halo || !ring || !pool) return;
    const { m, q, c, at, size } = this;
    for (const p of this.placed) {
      if (p.stone < 0) continue;
      const look = LOOKS[p.mark.look];
      const open = p.mark.look === "open";
      const lively = p.mark.id === this.picked || p.mark.id === this.hovered;
      // Somewhere to go breathes, and its stone rides the air and turns; somewhere cleared has settled.
      const breath = open ? 0.5 + 0.5 * Math.sin(clock * 1.9 + p.phase) : 0.5;
      const rise = open ? 0.66 + 0.07 * Math.sin(clock * 1.3 + p.phase) : 0.4;
      const big = (open ? 1 : 0.72) * (lively ? 1.18 : 1);
      stone.setMatrixAt(p.stone, m.compose(at.set(p.x, p.y + rise, p.z), q.setFromAxisAngle(UP, open ? clock * 0.9 + p.phase : p.phase), size.setScalar(big)));
      stone.setColorAt(p.stone, c.set(look.stone).multiplyScalar(open ? 0.92 + 0.16 * breath : 0.8));
      const glow = (open ? 1.9 + 0.5 * breath : 1.25) * (lively ? 1.25 : 1);
      halo.setMatrixAt(p.halo, m.compose(at.set(p.x, p.y + rise, p.z), camera.quaternion, size.setScalar(glow)));
      halo.setColorAt(p.halo, c.set(look.ring).multiplyScalar(look.halo * (open ? 0.75 + 0.5 * breath : 1) * (lively ? 1.4 : 1)));
      if (!open) continue;
      if (!p.aloft) ring.setColorAt(p.ring, c.set(look.ring).lerp(WHITE, 0.12 + 0.2 * breath));
      pool.setColorAt(p.pool, c.set(look.ring).multiplyScalar(look.pool * (0.78 + 0.44 * breath)));
      // Gold while some of the crew are there.
      if (beam && p.beam >= 0) beam.setColorAt(p.beam, (p.mark.busy ? c.copy(GOLD) : c.set(look.ring)).multiplyScalar((p.mark.busy ? 0.6 : 0.34) + 0.26 * breath));
      const motes = p.mark.motes?.length ?? 0;
      if (mote && p.mote >= 0) {
        for (let i = 0; i < motes; i++) {
          const a = clock * 1.25 + p.phase + (i / motes) * Math.PI * 2;
          at.set(p.x + Math.sin(a) * 0.5, p.y + rise + 0.1 * Math.sin(clock * 2.1 + i * 1.7 + p.phase), p.z + Math.cos(a) * 0.5);
          mote.setMatrixAt(p.mote + i, m.compose(at, q.setFromAxisAngle(UP, -a * 2), ONE));
        }
      }
    }
    // Light runs out along the routes on to somewhere open, and brighter along the way to the place picked.
    const run = (mesh: THREE.InstancedMesh | undefined, list: Dash[], from: THREE.ColorRepresentation, to: THREE.Color, speed: number, floor: number) => {
      if (!mesh || list.length === 0) return;
      list.forEach((s, i) => {
        const wave = Math.max(0, Math.sin(s.along * 0.85 - clock * speed));
        mesh.setColorAt(i, c.set(from).lerp(to, wave * wave).multiplyScalar(floor + (1 - floor) * (0.5 + 0.5 * wave)));
      });
      mesh.instanceColor!.needsUpdate = true;
    };
    run(flow, this.flowing, ROUTE_COLOR.open, WHITE, 3.1, 0.62);
    run(trail, this.trailing, "#ffc94a", WHITE, 4.2, 0.8);
    for (const mesh of [stone, halo, ring, pool, beam, mote]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.pickedBand.visible) this.pickedBand.scale.setScalar(1 + 0.06 * Math.sin(clock * 3.1));
  }
}
