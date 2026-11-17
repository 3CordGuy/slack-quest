// What flies through the air and comes up out of the ground in a fight on
// the tiles: an arrow on a low arc, a bolt of light with a tail, a flask
// tumbling end over end, a rock falling out of the sky, a beam, forked
// lightning, spikes and vines breaking the ground, a ring rolling outward,
// motes rising off someone healed; and in a delve, glints spilling out of a
// chest thrown open, and splinters flying off a crate. Small low-poly pieces
// in flat colours, like the rest of the world, most alive for under a second.
//
// It draws through the renderer's public hooks and knows nothing of the
// rules: the view says what to play, where, and what to do when it lands.

import * as THREE from "three";
import type { WorldRenderer } from "./WorldRenderer";

/** Something that flies from one point to another. */
export type Missile = "arrow" | "bolt" | "flask" | "meteor";

interface Live {
  /** Advance by `dt` seconds. Returns false when it is over, and has taken its own pieces away. */
  step(dt: number): boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const sphere = new THREE.SphereGeometry(1, 8, 6);
const cone = new THREE.ConeGeometry(1, 1, 5);
const rock = new THREE.IcosahedronGeometry(1, 0);
const shaft = new THREE.BoxGeometry(1, 1, 1);
const ringShape = new THREE.RingGeometry(0.82, 1, 24);
const diamond = new THREE.OctahedronGeometry(1, 0);

const glow = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
const flat = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: true });

export class SpellFx {
  private group = new THREE.Group();
  private live: Live[] = [];
  private stop: () => void;

  constructor(private renderer: WorldRenderer) {
    renderer.addObject(this.group);
    this.stop = renderer.addTicker((dt) => {
      this.live = this.live.filter((fx) => fx.step(Math.min(dt, 0.05)));
    });
  }

  dispose() {
    this.stop();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    });
    this.renderer.removeObject(this.group);
  }

  private add<T extends THREE.Object3D>(obj: T): T {
    this.group.add(obj);
    return obj;
  }

  private drop(...objs: THREE.Object3D[]) {
    for (const o of objs) {
      this.group.remove(o);
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (mesh.material) (mesh.material as THREE.Material).dispose();
        // Shared shapes are kept; a line's own geometry goes with it.
        if (mesh.geometry && (c as THREE.Line).isLine) mesh.geometry.dispose();
      });
    }
  }

  /** How high the arc of a throw or a shot stands over the straight line between its ends. */
  static arcHeight(kind: Missile | "spell", distance: number): number {
    return kind === "flask" ? 1.3 + distance * 0.22 : kind === "arrow" ? 0.35 + distance * 0.09 : kind === "meteor" ? 0 : 0.25 + distance * 0.04;
  }

  /** A point `t` of the way along an arc from `from` to `to`. */
  static arcPoint(from: THREE.Vector3, to: THREE.Vector3, height: number, t: number): THREE.Vector3 {
    return from.clone().lerp(to, t).addScaledVector(UP, height * 4 * t * (1 - t));
  }

  /** Send something flying from `from` to `to`. `onLand` runs as it arrives; a burst of its colour marks the spot. Returns how long the flight takes, in seconds. */
  launch(kind: Missile, from: THREE.Vector3, to: THREE.Vector3, color: string, onLand?: () => void): number {
    // A meteor comes down out of the sky, wherever it was called from.
    const start = kind === "meteor" ? to.clone().add(new THREE.Vector3(-3.5, 9, -2)) : from.clone();
    const distance = start.distanceTo(to);
    const speed = kind === "arrow" ? 15 : kind === "bolt" ? 11 : kind === "flask" ? 7.5 : 19;
    const time = Math.max(0.22, Math.min(0.95, distance / speed));
    const height = SpellFx.arcHeight(kind, distance);
    const body =
      kind === "arrow" ? new THREE.Mesh(shaft, flat("#e8dcc0"))
        : kind === "flask" ? new THREE.Mesh(shaft, flat(color))
          : kind === "meteor" ? new THREE.Mesh(rock, flat("#5a544c"))
            : new THREE.Mesh(sphere, glow(color));
    if (kind === "arrow") body.scale.set(0.05, 0.05, 0.62);
    else if (kind === "flask") body.scale.set(0.16, 0.24, 0.16);
    else if (kind === "meteor") body.scale.setScalar(0.42);
    else body.scale.setScalar(0.17);
    this.add(body);
    // What it leaves behind it: light for a bolt, fire for a falling rock.
    const tail = kind === "bolt" || kind === "meteor" ? Array.from({ length: kind === "meteor" ? 9 : 6 }, (_, i) => {
      const dot = this.add(new THREE.Mesh(sphere, glow(kind === "meteor" ? (i % 2 ? "#ffd23f" : "#f08a24") : color, 0.7 - i * 0.07)));
      dot.scale.setScalar((kind === "meteor" ? 0.3 : 0.13) * (1 - i / 10));
      return dot;
    }) : [];
    const trail: THREE.Vector3[] = [];
    let t = 0;
    this.live.push({
      step: (dt) => {
        t += dt / time;
        const at = SpellFx.arcPoint(start, to, height, Math.min(1, t));
        const ahead = SpellFx.arcPoint(start, to, height, Math.min(1, t + 0.02));
        body.position.copy(at);
        if (kind === "arrow") body.lookAt(ahead);
        else if (kind === "flask") body.rotation.set(t * 14, t * 5, 0);
        else if (kind === "meteor") body.rotation.set(t * 6, t * 4, 0);
        trail.unshift(at);
        tail.forEach((dot, i) => dot.position.copy(trail[Math.min(trail.length - 1, (i + 1) * 2)]));
        if (t < 1) return true;
        this.drop(body, ...tail);
        this.burst(to, kind === "meteor" ? "#f08a24" : color, kind === "meteor" ? 16 : kind === "flask" ? 12 : 8);
        onLand?.();
        return false;
      },
    });
    return time;
  }

  /** A puff of bright fragments thrown out from a point, falling as they fade. */
  burst(at: THREE.Vector3, color: string, count = 8) {
    const bits = Array.from({ length: count }, () => {
      const bit = this.add(new THREE.Mesh(sphere, glow(color, 0.9)));
      bit.scale.setScalar(0.05 + Math.random() * 0.06);
      bit.position.copy(at);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(1.6 + Math.random() * 2.2);
      return { bit, dir };
    });
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        for (const { bit, dir } of bits) {
          dir.y -= 7 * dt;
          bit.position.addScaledVector(dir, dt);
          (bit.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - age / 0.5));
        }
        if (age < 0.5) return true;
        this.drop(...bits.map((b) => b.bit));
        return false;
      },
    });
  }

  /** A ring rolling out across the ground from a point to `radius` (in world units): a shockwave, a shout, a splash. */
  ring(at: THREE.Vector3, radius: number, color: string, time = 0.5) {
    const ring = this.add(new THREE.Mesh(ringShape, glow(color, 0.9)));
    (ring.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at).setY(at.y + 0.08);
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        const k = Math.min(1, age / time);
        ring.scale.setScalar(0.25 + (radius - 0.25) * (1 - (1 - k) ** 2));
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
        if (k < 1) return true;
        this.drop(ring);
        return false;
      },
    });
  }

  /** A beam of light from one point to another, struck all at once and fading. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: string, width = 0.28) {
    const length = from.distanceTo(to);
    const make = (w: number, c: string, o: number) => {
      const m = this.add(new THREE.Mesh(shaft, glow(c, o)));
      m.position.copy(from).lerp(to, 0.5);
      m.lookAt(to);
      m.scale.set(w, w, length);
      return m;
    };
    const parts = [make(width, color, 0.55), make(width * 0.4, "#ffffff", 0.9)];
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        const k = Math.min(1, age / 0.55);
        parts.forEach((m, i) => {
          (m.material as THREE.MeshBasicMaterial).opacity = (i ? 0.9 : 0.55) * (1 - k);
          m.scale.x = m.scale.y = (i ? width * 0.4 : width) * (1 + k * 0.8);
        });
        if (k < 1) return true;
        this.drop(...parts);
        return false;
      },
    });
  }

  /** Forked lightning through a run of points, flickering for a moment. */
  spark(points: THREE.Vector3[], color: string) {
    if (points.length < 2) return;
    const jagged = () => {
      const out: THREE.Vector3[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const steps = Math.max(3, Math.round(a.distanceTo(b) * 2.5));
        for (let s = 0; s < steps; s++) {
          const p = a.clone().lerp(b, s / steps);
          if (s > 0) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.45, (Math.random() - 0.5) * 0.45, (Math.random() - 0.5) * 0.45));
          out.push(p);
        }
      }
      out.push(points[points.length - 1].clone());
      return out;
    };
    const lines = [color, "#ffffff"].map((c) => this.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(jagged()), new THREE.LineBasicMaterial({ color: c, transparent: true, depthTest: false }))));
    for (const p of points.slice(1)) this.burst(p, color, 5);
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        for (const line of lines) {
          line.geometry.setFromPoints(jagged());
          (line.material as THREE.LineBasicMaterial).opacity = 1 - age / 0.38;
        }
        if (age < 0.38) return true;
        this.drop(...lines);
        return false;
      },
    });
  }

  /** Spikes (thorns, roots, shards) breaking up out of the ground at each point, standing a moment, and sinking back. */
  erupt(points: THREE.Vector3[], color: string) {
    const spikes = points.flatMap((at) =>
      [0, 1, 2].map((i) => {
        const spike = this.add(new THREE.Mesh(cone, flat(color)));
        const tall = 0.55 + Math.random() * 0.5;
        const angle = (i / 3) * Math.PI * 2 + Math.random();
        spike.scale.set(0.13, tall, 0.13);
        spike.position.set(at.x + Math.cos(angle) * 0.32, at.y, at.z + Math.sin(angle) * 0.32);
        spike.rotation.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
        return { spike, base: at.y, tall };
      }),
    );
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        // Up fast, hold, down slow.
        const up = age < 0.12 ? age / 0.12 : age < 0.55 ? 1 : Math.max(0, 1 - (age - 0.55) / 0.3);
        for (const { spike, base, tall } of spikes) {
          spike.position.y = base + tall * (up - 0.5);
          (spike.material as THREE.MeshLambertMaterial).opacity = age < 0.55 ? 1 : up;
        }
        if (age < 0.85) return true;
        this.drop(...spikes.map((s) => s.spike));
        return false;
      },
    });
  }

  /** Motes of light rising off someone: healing, a blessing. */
  motes(at: THREE.Vector3, color: string) {
    const motes = Array.from({ length: 9 }, (_, i) => {
      const mote = this.add(new THREE.Mesh(sphere, glow(color, 0.9)));
      const angle = (i / 9) * Math.PI * 2;
      mote.scale.setScalar(0.05 + Math.random() * 0.04);
      mote.position.set(at.x + Math.cos(angle) * 0.4, at.y + Math.random() * 0.3, at.z + Math.sin(angle) * 0.4);
      return { mote, speed: 0.9 + Math.random() * 0.9, angle };
    });
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        for (const { mote, speed, angle } of motes) {
          mote.position.y += speed * dt;
          mote.position.x += Math.cos(angle + age * 3) * 0.3 * dt;
          mote.position.z += Math.sin(angle + age * 3) * 0.3 * dt;
          (mote.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - age / 0.8);
        }
        if (age < 0.8) return true;
        this.drop(...motes.map((m) => m.mote));
        return false;
      },
    });
  }

  /**
   * A chest thrown open: a flash of light out of it, a fountain of glints thrown up and falling back about it, and
   * a few left hanging in the air over it, twinkling as they drift up and fade. `rich` is the hoard: more of
   * everything, and gems among the gold.
   */
  spill(at: THREE.Vector3, rich = false) {
    const flash = this.add(new THREE.Mesh(sphere, glow("#ffe6a0", 0.3)));
    flash.position.copy(at);
    const colors = rich ? ["#ffd45e", "#fff3c4", "#ffb347", "#7fe0ff", "#ff6fb5"] : ["#ffd45e", "#fff3c4", "#ffe08a"];
    const thrown = Array.from({ length: rich ? 38 : 22 }, () => {
      const bit = this.add(new THREE.Mesh(diamond, glow(colors[Math.floor(Math.random() * colors.length)], 1)));
      const size = 0.035 + Math.random() * 0.04;
      bit.scale.setScalar(size);
      bit.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.2));
      const a = Math.random() * Math.PI * 2;
      const out = 0.4 + Math.random() * (rich ? 1.5 : 1.1);
      const v = new THREE.Vector3(Math.cos(a) * out, 2.6 + Math.random() * (rich ? 2.8 : 2.2), Math.sin(a) * out);
      return { bit, v, size, life: 0.8 + Math.random() * 0.5, floor: at.y - 0.3, spin: Math.random() * 12 };
    });
    const hanging = Array.from({ length: rich ? 12 : 7 }, (_, i) => {
      const bit = this.add(new THREE.Mesh(diamond, glow(i % 3 ? "#fff3c4" : "#ffd45e", 0)));
      const size = 0.03 + Math.random() * 0.03;
      const a = Math.random() * Math.PI * 2;
      const r = 0.1 + Math.random() * 0.45;
      bit.position.copy(at).add(new THREE.Vector3(Math.cos(a) * r, 0.15 + Math.random() * 0.55, Math.sin(a) * r));
      return { bit, size, rise: 0.12 + Math.random() * 0.22, sway: Math.random() * 6, delay: 0.15 + Math.random() * 0.5, life: 2.2 + Math.random() * 1.4 };
    });
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        const f = Math.min(1, age / 0.3);
        flash.scale.setScalar(0.15 + f * (rich ? 0.6 : 0.4));
        (flash.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - f) ** 2;
        for (const g of thrown) {
          if (age > g.life) {
            g.bit.visible = false;
            continue;
          }
          g.v.y -= 7.5 * dt;
          g.bit.position.addScaledVector(g.v, dt);
          // They come to rest on the floor and wink out there.
          if (g.bit.position.y < g.floor) {
            g.bit.position.y = g.floor;
            g.v.set(g.v.x * 0.3, Math.abs(g.v.y) * 0.25, g.v.z * 0.3);
          }
          g.bit.rotation.y += g.spin * dt;
          const k = age / g.life;
          (g.bit.material as THREE.MeshBasicMaterial).opacity = k < 0.7 ? 1 : (1 - k) / 0.3;
          g.bit.scale.setScalar(g.size * (0.7 + 0.5 * Math.abs(Math.sin(age * 14 + g.spin))));
        }
        for (const h of hanging) {
          const t = age - h.delay;
          if (t < 0) continue;
          h.bit.position.y += h.rise * dt;
          h.bit.position.x += Math.cos(h.sway + t * 1.7) * 0.05 * dt;
          const k = t / h.life;
          const twinkle = Math.max(0, Math.sin(t * 5 + h.sway)) ** 3;
          (h.bit.material as THREE.MeshBasicMaterial).opacity = Math.min(1, t * 3) * (1 - Math.max(0, (k - 0.6) / 0.4)) * (0.35 + 0.65 * twinkle);
          h.bit.scale.setScalar(h.size * (0.6 + 0.9 * twinkle));
          h.bit.rotation.y = t * 2 + h.sway;
        }
        if (age < Math.max(...hanging.map((h) => h.delay + h.life))) return true;
        this.drop(flash, ...thrown.map((g) => g.bit), ...hanging.map((h) => h.bit));
        return false;
      },
    });
  }

  /**
   * Splinters knocked off a crate (`count` a few, from a blow), or the whole crate flying apart: boards and chips
   * thrown out and up, tumbling, bouncing once on the floor and lying a moment before they sink away. `burst`
   * adds a puff of dust and a ring across the floor.
   */
  splinters(at: THREE.Vector3, count: number, burst = false) {
    const woods = ["#a87b4a", "#8a6238", "#6b4a2a", "#c29464"];
    const floor = at.y - (burst ? 0.38 : 0.3);
    const bits = Array.from({ length: count }, (_, i) => {
      const bit = this.add(new THREE.Mesh(shaft, flat(woods[i % woods.length])));
      const long = burst && i % 2 === 0 ? 0.18 + Math.random() * 0.22 : 0.05 + Math.random() * 0.08;
      bit.scale.set(long, 0.025 + Math.random() * 0.015, 0.05 + Math.random() * 0.03);
      bit.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
      const a = Math.random() * Math.PI * 2;
      const out = (burst ? 1.4 : 0.8) + Math.random() * (burst ? 1.8 : 0.9);
      const v = new THREE.Vector3(Math.cos(a) * out, (burst ? 2.2 : 1.6) + Math.random() * 1.8, Math.sin(a) * out);
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(22);
      return { bit, v, spin, bounced: false, rest: false };
    });
    const dust = burst
      ? Array.from({ length: 7 }, (_, i) => {
          const puff = this.add(new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ color: "#8f7a62", transparent: true, opacity: 0.5, depthWrite: false })));
          const a = (i / 7) * Math.PI * 2;
          puff.position.copy(at).add(new THREE.Vector3(Math.cos(a) * 0.15, -0.15, Math.sin(a) * 0.15));
          return { puff, dir: new THREE.Vector3(Math.cos(a), 0.35, Math.sin(a)).multiplyScalar(0.7 + Math.random() * 0.4) };
        })
      : [];
    if (burst) this.ring(new THREE.Vector3(at.x, floor, at.z), 1.4, "#c9a46a", 0.45);
    const life = burst ? 1.6 : 0.9;
    let age = 0;
    this.live.push({
      step: (dt) => {
        age += dt;
        for (const b of bits) {
          if (!b.rest) {
            b.v.y -= 9 * dt;
            b.bit.position.addScaledVector(b.v, dt);
            b.bit.rotation.x += b.spin.x * dt;
            b.bit.rotation.y += b.spin.y * dt;
            b.bit.rotation.z += b.spin.z * dt;
            if (b.bit.position.y <= floor) {
              b.bit.position.y = floor;
              if (b.bounced) {
                b.rest = true;
                b.bit.rotation.x = b.bit.rotation.z = 0;
              } else {
                b.bounced = true;
                b.v.set(b.v.x * 0.35, Math.abs(b.v.y) * 0.3, b.v.z * 0.35);
                b.spin.multiplyScalar(0.4);
              }
            }
          }
          // Lying a moment, then sinking away.
          if (age > life * 0.65) {
            const k = (age - life * 0.65) / (life * 0.35);
            (b.bit.material as THREE.MeshLambertMaterial).opacity = Math.max(0, 1 - k);
            if (b.rest) b.bit.position.y = floor - k * 0.05;
          }
        }
        for (const d of dust) {
          d.puff.position.addScaledVector(d.dir, dt);
          d.dir.multiplyScalar(1 - 2.5 * dt);
          const k = Math.min(1, age / 0.9);
          d.puff.scale.setScalar(0.12 + k * 0.35);
          (d.puff.material as THREE.MeshLambertMaterial).opacity = 0.5 * (1 - k);
        }
        if (age < life) return true;
        this.drop(...bits.map((b) => b.bit), ...dust.map((d) => d.puff));
        return false;
      },
    });
  }
}
