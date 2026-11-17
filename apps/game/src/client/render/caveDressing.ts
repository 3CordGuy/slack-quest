// The caverns dressed: what makes the rock read as a cave and not a dark
// floor. Moss grows in patches along the walls, puddles lie black and glossy
// (the torchlight catches them), loose rocks are scattered about, stalagmites
// rise at the edge of the floor against the rock, and stalactites hang from
// the rock's rim. All of it is set out from the tiles themselves (a hash of
// each hex), so every screen draws the same cave and nothing is saved. None
// of it stands where anyone walks: the middle of every hex is left clear.
//
// Also here: the rope at the cave mouth, tied round a rock out in the
// daylight and hanging down the shaft of light, its slack coiled on the floor;
// and the clusters of glowing mushrooms a delve grows (zone/forage.ts).

import * as THREE from "three";
import { posKey, type HexPos } from "@gantt-quest/core";
import type { Tile } from "@gantt-quest/world";

/** How tall the shaft of daylight at the cave mouth is drawn: the rope hangs down its height. */
export const SHAFT_HEIGHT = 3.6;

/** A steady pseudo-random number in [0, 1) for a hex and a salt: the same on every screen. */
const hash = (q: number, r: number, salt: number) => {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

type Place = { x: number; y: number; z: number };

/** The six ways out of a hex. */
const DIRS: readonly HexPos[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];

/**
 * Dress the caverns' floor and walls. `at` gives a hex's middle in the world and the height of its top, `centre`
 * any hex's middle. A `busy` hex (one with a place on it: the mouth, a chest, a door) gets only its moss: nothing
 * stands up through what is there, and no stalactite hangs over it.
 */
export function buildCaveDressing(tiles: readonly Tile[], at: (t: Tile) => Place, centre: (p: HexPos) => { x: number; z: number }, busy: (p: HexPos) => boolean): THREE.Group {
  const group = new THREE.Group();
  const byKey = new Map(tiles.map((t) => [posKey(t), t]));
  const isRock = (p: HexPos) => byKey.get(posKey(p))?.biome === "rock";
  const isFloor = (p: HexPos) => byKey.get(posKey(p))?.biome === "cave";

  const moss: THREE.Matrix4[] = [];
  const mossTint: THREE.Color[] = [];
  const puddles: THREE.Matrix4[] = [];
  const pebbles: THREE.Matrix4[] = [];
  const mites: THREE.Matrix4[] = [];
  const tites: THREE.Matrix4[] = [];
  const m = (x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rx = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(sx, sy, sz));
  /** The way from a hex's middle toward a neighbour's, flat, of unit length. */
  const toward = (from: HexPos, to: HexPos) => {
    const a = centre(from);
    const b = centre(to);
    return new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
  };

  for (const t of tiles) {
    const { x, y, z } = at(t);
    const near = DIRS.map((d) => ({ q: t.q + d.q, r: t.r + d.r }));
    const clear = !busy(t);
    if (t.biome === "cave") {
      const walls = near.filter(isRock);
      // Moss along the walls: a few flat patches toward the rock, now and then a little out on the floor.
      if (walls.length > 0 && hash(t.q, t.r, 1) < 0.55) {
        for (let k = 0; k < 1 + Math.floor(hash(t.q, t.r, 2) * 3); k++) {
          const w = toward(t, walls[k % walls.length]);
          const d = 0.5 + hash(t.q, t.r, 3 + k) * 0.32;
          const side = (hash(t.q, t.r, 6 + k) - 0.5) * 0.6;
          const s = 0.16 + hash(t.q, t.r, 9 + k) * 0.22;
          const px = x + w.x * d - w.y * side;
          const pz = z + w.y * d + w.x * side;
          // A patch is a few blobs run together, a shade apart, so it has a ragged edge and not a round one.
          for (let b = 0; b < 3; b++) {
            const a = hash(t.q, t.r, 120 + k * 3 + b) * Math.PI * 2;
            const off = b === 0 ? 0 : s * (0.45 + hash(t.q, t.r, 130 + k * 3 + b) * 0.35);
            const bs = s * (b === 0 ? 1 : 0.5 + hash(t.q, t.r, 140 + k * 3 + b) * 0.3);
            moss.push(m(px + Math.cos(a) * off, y + 0.012 + k * 0.002 + b * 0.001, pz + Math.sin(a) * off, bs, 1, bs * (0.7 + hash(t.q, t.r, 12 + k + b) * 0.5), hash(t.q, t.r, 15 + k + b) * 6));
            mossTint.push(new THREE.Color().setHSL(0.24 + hash(t.q, t.r, 18 + k + b) * 0.08, 0.42, 0.17 + hash(t.q, t.r, 21 + k + b) * 0.09));
          }
        }
      }
      // A puddle on open floor, off to one side of the hex.
      if (clear && walls.length <= 2 && hash(t.q, t.r, 30) < 0.13) {
        const a = hash(t.q, t.r, 31) * Math.PI * 2;
        const d = 0.3 + hash(t.q, t.r, 32) * 0.25;
        const s = 0.32 + hash(t.q, t.r, 33) * 0.2;
        puddles.push(m(x + Math.cos(a) * d, y + 0.01, z + Math.sin(a) * d, s, 1, s * (0.6 + hash(t.q, t.r, 34) * 0.35), hash(t.q, t.r, 35) * 6));
      }
      // Loose rocks: a few about the edge of the hex.
      if (clear && hash(t.q, t.r, 40) < 0.5) {
        for (let k = 0; k < 2 + Math.floor(hash(t.q, t.r, 41) * 4); k++) {
          const a = hash(t.q, t.r, 42 + k) * Math.PI * 2;
          const d = 0.45 + hash(t.q, t.r, 50 + k) * 0.4;
          const s = 0.03 + hash(t.q, t.r, 58 + k) * 0.06;
          pebbles.push(m(x + Math.cos(a) * d, y + s * 0.5, z + Math.sin(a) * d, s, s * 0.7, s * 1.1, hash(t.q, t.r, 66 + k) * 6));
        }
      }
      // Stalagmites at the foot of the wall: rising from the floor's edge against the rock.
      if (clear && walls.length >= 1 && hash(t.q, t.r, 70) < 0.42) {
        for (let k = 0; k < 1 + (hash(t.q, t.r, 71) < 0.4 ? 1 : 0); k++) {
          const w = toward(t, walls[Math.floor(hash(t.q, t.r, 72 + k) * walls.length)]);
          const side = (hash(t.q, t.r, 75 + k) - 0.5) * 0.7;
          const d = 0.66 + hash(t.q, t.r, 78 + k) * 0.12;
          const tall = 0.22 + hash(t.q, t.r, 81 + k) * 0.45;
          const wide = 0.07 + hash(t.q, t.r, 84 + k) * 0.07;
          mites.push(m(x + w.x * d - w.y * side, y + tall / 2, z + w.y * d + w.x * side, wide, tall, wide, hash(t.q, t.r, 87 + k) * 6));
        }
      }
    } else if (t.biome === "rock") {
      // Stalactites hanging off the rock's rim over the floor below.
      const floors = near.filter(isFloor);
      for (const [k, f] of floors.entries()) {
        if (busy(f) || hash(t.q, t.r, 90 + k) > 0.38) continue;
        const w = toward(t, f);
        const side = (hash(t.q, t.r, 96 + k) - 0.5) * 0.8;
        const long = 0.25 + hash(t.q, t.r, 102 + k) * 0.5;
        const wide = 0.06 + hash(t.q, t.r, 108 + k) * 0.06;
        // Upside down, its root just under the rim.
        tites.push(m(x + w.x * 0.86 - w.y * side, y - 0.04 - long / 2, z + w.y * 0.86 + w.x * side, wide, long, wide, hash(t.q, t.r, 114 + k) * 6, Math.PI));
      }
    }
  }

  const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, mats: THREE.Matrix4[], shadows: boolean, tints?: THREE.Color[]) => {
    if (mats.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, mats.length);
    mats.forEach((mat, i) => mesh.setMatrixAt(i, mat));
    tints?.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  // Flat patches and pools: seven-sided discs, laid on the floor.
  const disc = new THREE.CircleGeometry(1, 7).rotateX(-Math.PI / 2);
  instanced(disc, new THREE.MeshLambertMaterial({ color: "#ffffff" }), moss, false, mossTint);
  // Black water with a sheen: what little light there is shines off it.
  instanced(new THREE.CircleGeometry(1, 9).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#0e1a24", roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.9 }), puddles, false);
  instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: "#5e5b57", flatShading: true }), pebbles, true);
  // Stone spikes, wet and pale at the tip: a cone of six faces.
  const spike = new THREE.ConeGeometry(1, 1, 6);
  instanced(spike, new THREE.MeshLambertMaterial({ color: "#6d665d", flatShading: true }), mites, true);
  instanced(spike, new THREE.MeshLambertMaterial({ color: "#5d5850", flatShading: true }), tites, true);
  return group;
}

/** Where the rope at a cave mouth is made fast, in the mouth's own space: the edge of the nearest rock, on the
 * floor, where its face looks toward the mouth; the way from the mouth to it (flat, of unit length); and how high
 * the rock's top stands above the mouth's floor. */
export type RopeWall = { lip: THREE.Vector2; out: THREE.Vector2; top: number };

/**
 * The rope at the cave mouth: tied round a boulder up on top of the rock nearest the mouth (outside, on the
 * surface), over the edge, and slung down into the shaft of light, where it is staked to the floor and its slack
 * lies coiled. Knotted for climbing. With no rock near, it hangs from the top of the shaft, `shaft` high.
 */
export function caveRope(wall: RopeWall | null, shaft: number): THREE.Group {
  const g = new THREE.Group();
  const hemp = new THREE.MeshLambertMaterial({ color: "#c4a06a", flatShading: true });
  const knotty = new THREE.MeshLambertMaterial({ color: "#8a6a3c", flatShading: true });
  const iron = new THREE.MeshLambertMaterial({ color: "#3d4048", flatShading: true });
  const v = (p: THREE.Vector2, y: number) => new THREE.Vector3(p.x, y, p.y);
  let points: THREE.Vector3[];
  let foot: THREE.Vector2;
  let hangFrom = 0;
  if (wall) {
    const { lip, out, top } = wall;
    /** A point on the floor plan `d` out from the lip (negative: back toward the mouth), `s` to its side. */
    const along = (d: number, s = 0) => new THREE.Vector2(lip.x + out.x * d - out.y * s, lip.y + out.y * d + out.x * s);
    // The boulder, sitting on the rock a little back from the edge, and two turns of rope round it.
    const rockAt = along(0.55, 0.1);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), new THREE.MeshLambertMaterial({ color: "#8d9096", flatShading: true }));
    rock.position.copy(v(rockAt, top + 0.17));
    rock.scale.set(1.15, 0.78, 1.05);
    rock.rotation.set(0.3, 0.7, 0.1);
    g.add(rock);
    for (const [i, lift] of [0.08, 0.17].entries()) {
      const turn = new THREE.Mesh(new THREE.TorusGeometry(0.33 - i * 0.03, 0.04, 6, 20), hemp);
      turn.position.copy(v(rockAt, top + lift));
      turn.rotation.set(Math.PI / 2 + 0.1 * (i ? -1 : 1), 0.08, 0);
      g.add(turn);
    }
    // Made fast on the side toward the edge.
    const tied = along(0.22, 0.08);
    const knot = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08, 0), knotty);
    knot.position.copy(v(tied, top + 0.1));
    g.add(knot);
    // Down in the light, short of the middle of the mouth: an iron stake it is lashed to, the slack coiled beside.
    const span = lip.length();
    const stake = new THREE.Vector2().copy(out).multiplyScalar(Math.min(0.32, span * 0.3));
    foot = new THREE.Vector2(stake.x - out.y * 0.24, stake.y + out.x * 0.24);
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.32, 5), iron);
    peg.position.set(stake.x, 0.13, stake.y);
    peg.rotation.set(-out.y * 0.35, 0, out.x * 0.35);
    g.add(peg);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 5, 10), iron);
    ring.position.set(stake.x, 0.29, stake.y);
    g.add(ring);
    // Over the edge, then slung across and down, sagging, to the stake.
    points = [v(tied, top + 0.1), v(along(0.02, 0.06), top + 0.05), v(along(-0.1, 0.05), top - 0.16)];
    const from = along(-0.1, 0.05);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const p = new THREE.Vector2().lerpVectors(from, stake, k);
      points.push(v(p, THREE.MathUtils.lerp(top - 0.16, 0.27, k) - 0.35 * 4 * k * (1 - k)));
    }
    hangFrom = 0.18;
  } else {
    foot = new THREE.Vector2(-0.06, 0.12);
    points = [new THREE.Vector3(-0.12, shaft, -0.14), new THREE.Vector3(-0.09, shaft * 0.5, -0.06), new THREE.Vector3(-0.07, shaft * 0.2, 0), new THREE.Vector3(-0.06, 0.06, 0.08)];
  }
  const curve = new THREE.CatmullRomCurve3(points);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.036, 6, false), hemp));
  // Knots for the hands, a forearm apart, down its length.
  for (let t = hangFrom + 0.06; t < 0.94; t += 0.075) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.06, 7, 5), knotty);
    k.position.copy(curve.getPointAt(t));
    k.scale.set(1, 0.75, 1);
    g.add(k);
  }
  // The slack, coiled on the floor.
  for (let i = 0; i < 3; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.17 - i * 0.04, 0.032, 6, 18), hemp);
    coil.rotation.x = Math.PI / 2;
    coil.position.set(foot.x + i * 0.012, 0.035 + i * 0.045, foot.y);
    g.add(coil);
  }
  return g;
}

/**
 * A cluster of glowing mushrooms: pale stems and caps that glow sea-green (unlit, so they show in the dark), and
 * a soft pool of their light on the floor. Picked, only the cut stems are left, and no glow.
 */
export function glowcapCluster(seedQ: number, seedR: number, picked: boolean): THREE.Group {
  const g = new THREE.Group();
  // The stems catch the caps' glow: a little of it of their own, so they are not black against it. Cut, they are dull.
  const stem = new THREE.MeshLambertMaterial({ color: "#d9d2bf", emissive: picked ? "#000000" : "#2f6a5c", flatShading: true });
  const cap = new THREE.MeshBasicMaterial({ color: "#6ff5d0" });
  const heart = new THREE.MeshBasicMaterial({ color: "#c8fff0" });
  const n = 4 + Math.floor(hash(seedQ, seedR, 1) * 3);
  for (let i = 0; i < n; i++) {
    const a = hash(seedQ, seedR, 2 + i) * Math.PI * 2;
    const d = 0.08 + hash(seedQ, seedR, 10 + i) * 0.26;
    const tall = picked ? 0.04 + hash(seedQ, seedR, 18 + i) * 0.03 : 0.12 + hash(seedQ, seedR, 18 + i) * 0.22;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, tall, 5), stem);
    s.position.set(x, tall / 2, z);
    s.rotation.z = (hash(seedQ, seedR, 26 + i) - 0.5) * 0.4;
    g.add(s);
    if (picked) continue;
    const r = 0.05 + hash(seedQ, seedR, 34 + i) * 0.06;
    const c = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    c.position.set(x, tall, z);
    c.scale.set(1, 0.6, 1);
    c.userData.glow = true;
    g.add(c);
    const spot = new THREE.Mesh(new THREE.SphereGeometry(r * 0.35, 5, 3), heart);
    spot.position.set(x, tall + r * 0.4, z);
    spot.userData.glow = true;
    g.add(spot);
  }
  if (!picked) {
    // A soft pool of their light on the floor round them, brightest in the middle.
    const radius = 1.0;
    const geometry = new THREE.RingGeometry(0.001, radius, 24, 8).rotateX(-Math.PI / 2);
    const pos = geometry.getAttribute("position");
    const glowColor = new THREE.Color("#3fd6b0");
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const k = 0.32 * Math.pow(Math.max(0, 1 - Math.hypot(pos.getX(i), pos.getZ(i)) / radius), 2.2);
      colors.push(glowColor.r * k, glowColor.g * k, glowColor.b * k);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const pool = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.position.y = 0.02;
    pool.userData.glow = true;
    g.add(pool);
  }
  return g;
}
