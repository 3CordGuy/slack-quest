// The caverns dressed: what makes the rock read as a cave and not a dark
// floor. Moss grows in patches along the walls, puddles lie black and glossy
// (the torchlight catches them), loose rocks are scattered about, stalagmites
// rise at the edge of the floor against the rock, and stalactites hang from
// the rock's rim. All of it is set out from the tiles themselves (a hash of
// each hex), so every screen draws the same cave and nothing is saved. None
// of it stands where anyone walks: the middle of every hex is left clear.
//
// Also here: the rope at the cave mouth, let down from a rock up on the
// surface and hanging down the shaft of light, its slack coiled on the floor;
// the same rope seen from outside, in the Harbor, tied round a boulder and
// running into the dark of the entrance, between two burning torches; and the
// clusters of glowing mushrooms a delve grows (zone/forage.ts).

import * as THREE from "three";
import { torchFlame } from "./torchFlame";
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

/**
 * The rope at the cave mouth: let down from above, where it is tied off round a rock up on the surface, out of
 * sight. It hangs straight down the shaft of daylight (`shaft` high), knotted for climbing, fading into the light
 * as it goes up, and its slack lies coiled on the floor.
 */
export function caveRope(shaft: number): THREE.Group {
  const g = new THREE.Group();
  const hemp = new THREE.Color("#c4a06a");
  const sky = new THREE.Color("#eef6ff");
  // It stands in daylight, so it is shaded as the daylight would shade it (from above, a little to the front) and not
  // by the cave's dark: hemp low down, paling as it rises into the light, and gone into it at the top.
  const sun = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  const pale = (y: number) => THREE.MathUtils.smoothstep(y, shaft * 0.25, shaft * 0.9);
  const gone = (y: number) => THREE.MathUtils.smoothstep(y, shaft * 0.7, shaft + 0.3);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true });
  const tint = (geometry: THREE.BufferGeometry, base: THREE.Color, lift = 0) => {
    const pos = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const n = new THREE.Vector3();
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + lift;
      n.fromBufferAttribute(normal, i);
      const c = base.clone().multiplyScalar(0.45 + 0.6 * Math.max(0, n.dot(sun))).lerp(sky, pale(y));
      colors.push(c.r, c.g, c.b, 1 - gone(y));
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
    return geometry;
  };
  // From the coil on the floor, up off-centre in the shaft, hanging true, and on up out of the top of it.
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.1, 0.08, 0.16),
    new THREE.Vector3(-0.04, 0.22, 0.04),
    new THREE.Vector3(-0.1, 0.7, -0.02),
    new THREE.Vector3(-0.11, shaft * 0.5, -0.05),
    new THREE.Vector3(-0.12, shaft + 0.6, -0.08),
  ]);
  // Drawn before the shaft of light (which is added on top), so the daylight falls over it and not behind it.
  const rope = new THREE.Mesh(tint(new THREE.TubeGeometry(curve, 72, 0.036, 6, false), hemp), material);
  rope.renderOrder = -1;
  g.add(rope);
  // Knots for the hands, a forearm apart, up the hanging length (fading with it).
  const knotColor = new THREE.Color("#8a6a3c");
  for (let t = 0.2; t < 0.9; t += 0.06) {
    const at = curve.getPointAt(t);
    const k = new THREE.Mesh(tint(new THREE.SphereGeometry(0.06, 7, 5), knotColor, at.y), material);
    k.position.copy(at);
    k.scale.set(1, 0.75, 1);
    k.renderOrder = -1;
    g.add(k);
  }
  // The slack, coiled on the floor at its foot.
  for (let i = 0; i < 3; i++) {
    // Laid flat before it is shaded, so the light falls on its top.
    const coil = new THREE.Mesh(tint(new THREE.TorusGeometry(0.17 - i * 0.04, 0.032, 6, 18).rotateX(Math.PI / 2), hemp), material);
    coil.position.set(0.12 + i * 0.012, 0.035 + i * 0.045, 0.2);
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

/** Where the face of the Harbor's cave entrance stands, in its model's space: the front of the tunnel into the rock. */
export const MOUTH_FACE = 0.36;

/**
 * The Harbor's way into the caverns: an arched tunnel going back into the rock from `face`, seen from inside only
 * (its walls are drawn from within), so it is a hole and not a panel. Very dark at the mouth and black at the back,
 * unlit by the day. The rock round it is the model's; it must cover the tunnel's outside.
 */
export function caveMouth(face: number): THREE.Mesh {
  const half = 0.23;
  const side = 0.29;
  const depth = 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0);
  shape.lineTo(half, 0);
  shape.lineTo(half, side);
  shape.absarc(0, side, half, 0, Math.PI, false);
  shape.lineTo(-half, 0);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 10 });
  const pos = geometry.getAttribute("position");
  const mouth = new THREE.Color("#0d0c10");
  const back = new THREE.Color("#000000");
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    // Extruded from z = 0 (the back) to `depth` (the mouth): lighter toward the daylight, and the floor a shade lighter still.
    const c = back.clone().lerp(mouth, Math.pow(pos.getZ(i) / depth, 1.6) * (pos.getY(i) < 0.01 ? 1 : 0.8));
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const tunnel = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  tunnel.position.z = face - depth;
  tunnel.userData.glow = true;
  return tunnel;
}

/**
 * The Harbor's way into the caverns, from outside: the far end of the rope that hangs down inside. Tied round a
 * boulder out front, it runs over the ground and in through the black of the arch, knotted for climbing. In the
 * entrance model's own space: the arch's face at z = `face`, its middle at x = 0.
 */
export function mouthRope(face: number): THREE.Group {
  const g = new THREE.Group();
  const hemp = new THREE.MeshLambertMaterial({ color: "#c4a06a", flatShading: true });
  const knotty = new THREE.MeshLambertMaterial({ color: "#8a6a3c", flatShading: true });
  // The boulder, out front to the right of the arch, and two turns of rope round it.
  const rockAt = new THREE.Vector3(0.6, 0.08, face + 0.4);
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13, 0), new THREE.MeshLambertMaterial({ color: "#6a6e76", flatShading: true }));
  rock.position.copy(rockAt);
  rock.scale.set(1.25, 0.8, 1.05);
  rock.rotation.set(0.3, 0.9, 0.1);
  g.add(rock);
  for (const [i, lift] of [0.03, 0.07].entries()) {
    const turn = new THREE.Mesh(new THREE.TorusGeometry(0.15 - i * 0.012, 0.016, 6, 18), hemp);
    turn.position.set(rockAt.x, lift, rockAt.z);
    turn.rotation.set(Math.PI / 2 + 0.08 * (i ? -1 : 1), 0, 0);
    g.add(turn);
  }
  const knot = new THREE.Mesh(new THREE.DodecahedronGeometry(0.03, 0), knotty);
  knot.position.set(rockAt.x - 0.15, 0.06, rockAt.z - 0.03);
  g.add(knot);
  // Over the ground and in through the arch, dropping out of sight into the dark behind its face.
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(rockAt.x - 0.15, 0.05, rockAt.z - 0.03),
    new THREE.Vector3(0.32, 0.025, face + 0.3),
    new THREE.Vector3(0.12, 0.022, face + 0.16),
    new THREE.Vector3(0.02, 0.03, face + 0.05),
    new THREE.Vector3(0, 0.02, face - 0.06),
    new THREE.Vector3(0, -0.06, face - 0.18),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.016, 6, false), hemp));
  for (let t = 0.12; t < 0.8; t += 0.13) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 4), knotty);
    k.position.copy(curve.getPointAt(t));
    k.scale.set(1, 0.7, 1);
    g.add(k);
  }
  return g;
}

/**
 * A torch on a stake by the entrance: a pole driven into the ground, an iron cup with a pitch-soaked rag in it, and
 * a real flame on top (torchFlame), which the renderer flickers. Its root at the group's origin, in the entrance
 * model's space.
 */
export function mouthTorch(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.5, 6), new THREE.MeshLambertMaterial({ color: "#5a3d22", flatShading: true }));
  pole.position.y = 0.25;
  g.add(pole);
  const iron = new THREE.MeshLambertMaterial({ color: "#2f2d33", flatShading: true });
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.028, 0.06, 7, 1, true), iron);
  cup.position.y = 0.52;
  g.add(cup);
  const rag = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.05, 7), new THREE.MeshLambertMaterial({ color: "#3a2a1e", flatShading: true }));
  rag.position.y = 0.54;
  g.add(rag);
  const flame = torchFlame(0.075);
  flame.position.y = 0.56;
  g.add(flame);
  return g;
}
