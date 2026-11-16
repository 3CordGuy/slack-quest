// Gulls. A few of them come in off the sea by day, glide down and land on
// open ground (the quay and the piers for choice), and potter there: pecking
// at the ground, looking about, hopping a few steps. When their time is up, or
// the light goes or a storm comes on, they fly off again; and if anyone walks
// too close, they are up and away at once.
//
// They are decoration only: nothing reads or changes game state, each player's
// gulls are their own, and they come and go by chance.

import * as THREE from "three";

/** A place a gull may land: a point on open ground. */
export interface GullSpot {
  x: number;
  y: number;
  z: number;
}

/** A gull is this many times its modelled size (which stands about 0.26 tall). */
const SIZE = 1.3;
/** Anyone on foot within this far (world units) of a gull on the ground puts it up. */
const SCARE = 1.9;
/** A gull will not choose to land within this far of anyone. */
const WARY = 4;
/** How far a gull wanders from where it landed, hopping. */
const ROAM = 0.75;
/** Wing beats a second, flying. */
const BEAT = 3.4;

type Mode = "away" | "arriving" | "idle" | "pecking" | "looking" | "hopping" | "leaving";

interface Gull {
  root: THREE.Group;
  /** Tips the whole bird forward (to peck) or back (to brake as it lands). */
  tilt: THREE.Group;
  head: THREE.Group;
  legs: THREE.Group;
  /** The wings as worn on the ground, and as spread to fly: one or the other is shown. */
  folded: THREE.Group;
  wings: [THREE.Group, THREE.Group];
  tips: [THREE.Group, THREE.Group];
  mode: Mode;
  /** Time in this mode, and how long it lasts. */
  t: number;
  dur: number;
  /** While away: how long until it comes back. */
  wait: number;
  /** On the ground: how much longer it means to stay. */
  stay: number;
  /** Where it landed (it keeps near), and its flight's path: from, by way of, to. */
  home: THREE.Vector3;
  from: THREE.Vector3;
  via: THREE.Vector3;
  to: THREE.Vector3;
  yaw: number;
  yawGoal: number;
  /** Where in its wing beat it is. */
  beat: number;
  /** Pecks or hops still to do in this bout, and which way its head is turning to look. */
  left: number;
  look: number;
  /** The way it is leaving, and how fast it is going. */
  awayX: number;
  awayZ: number;
  speed: number;
}

const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** A gull, standing, its beak toward +z: white, grey-backed, black at the wingtips and tail, yellow beak and legs. */
function gullModel(): Pick<Gull, "root" | "tilt" | "head" | "legs" | "folded" | "wings" | "tips"> {
  const white = lambert("#f4f2ea");
  const grey = lambert("#a9b2bb");
  const black = lambert("#33363c");
  const yellow = lambert("#e8b534");
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  // It tips about its hips, so a peck brings the head down to the ground in front of its feet.
  tilt.position.set(0, 0.11, -0.02);
  root.add(tilt);
  const add = (to: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    to.add(mesh);
    return mesh;
  };
  const lump = (rx: number, ry: number, rz: number) => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    g.scale(rx, ry, rz);
    return g;
  };
  // Body, breast forward and a little up; tail behind, black at the end.
  add(tilt, lump(0.07, 0.062, 0.135), white, 0, 0.035, 0.02).rotation.x = -0.18;
  add(tilt, new THREE.BoxGeometry(0.07, 0.014, 0.08), grey, 0, 0.045, -0.13);
  add(tilt, new THREE.BoxGeometry(0.06, 0.013, 0.045), black, 0, 0.047, -0.185);
  // Head on its neck, turning and nodding about the neck's foot.
  const head = new THREE.Group();
  head.position.set(0, 0.075, 0.12);
  tilt.add(head);
  add(head, lump(0.035, 0.05, 0.035), white, 0, 0.02, 0.005);
  add(head, lump(0.045, 0.042, 0.05), white, 0, 0.075, 0.015);
  const beak = add(head, new THREE.ConeGeometry(0.016, 0.07, 4), yellow, 0, 0.068, 0.085);
  beak.rotation.x = Math.PI / 2 + 0.12;
  for (const x of [-0.036, 0.036]) add(head, new THREE.BoxGeometry(0.012, 0.014, 0.014), black, x, 0.085, 0.04);
  // Wings folded along its back: grey, crossing to black tips over the tail.
  const folded = new THREE.Group();
  tilt.add(folded);
  for (const side of [-1, 1]) {
    add(folded, lump(0.022, 0.045, 0.115), grey, side * 0.058, 0.055, -0.01).rotation.x = -0.12;
    add(folded, new THREE.BoxGeometry(0.02, 0.016, 0.07), black, side * 0.03, 0.068, -0.15).rotation.y = side * -0.25;
  }
  // Wings spread: an arm out from each shoulder and a hand beyond it, hinged, so the wing bends as it beats.
  const wing = (side: number): [THREE.Group, THREE.Group] => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.05, 0.07, 0.03);
    tilt.add(arm);
    add(arm, new THREE.BoxGeometry(0.2, 0.014, 0.115), grey, side * 0.1, 0, 0);
    const hand = new THREE.Group();
    hand.position.set(side * 0.2, 0, 0);
    arm.add(hand);
    add(hand, new THREE.BoxGeometry(0.13, 0.012, 0.095), grey, side * 0.065, 0, -0.008);
    const tip = add(hand, new THREE.ConeGeometry(0.046, 0.12, 4), black, side * 0.185, 0, -0.012);
    tip.rotation.z = side * -Math.PI / 2;
    tip.scale.set(1, 1, 0.16);
    arm.visible = false;
    return [arm, hand];
  };
  const [leftArm, leftHand] = wing(1);
  const [rightArm, rightHand] = wing(-1);
  // Legs and feet, under the hips; tucked away in flight.
  const legs = new THREE.Group();
  root.add(legs);
  for (const x of [-0.028, 0.028]) {
    add(legs, new THREE.BoxGeometry(0.01, 0.1, 0.01), yellow, x, 0.05, -0.01);
    add(legs, new THREE.BoxGeometry(0.03, 0.006, 0.045), yellow, x, 0.003, 0.008);
  }
  root.scale.setScalar(SIZE);
  return { root, tilt, head, legs, folded, wings: [leftArm, rightArm], tips: [leftHand, rightHand] };
}

const ease = (t: number) => t * t * (3 - 2 * t);
/** The shortest way round from one heading to another. */
const turnTo = (from: number, to: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from));

export class Gulls {
  readonly group = new THREE.Group();
  private gulls: Gull[] = [];
  private spots: GullSpot[] = [];
  /** The middle of the land, which gulls come in toward and leave away from. */
  private middle = { x: 0, z: 0 };
  private scratch = new THREE.Vector3();

  /**
   * Tell them the lie of the land: where they may come down (none, and there are no gulls), and where its
   * middle is. On a `fresh` map any that are about are gone at once, as the map they were on is; when the same
   * map has only been redrawn (fog lifting off more of it), those about carry on as they were.
   */
  setGround(spots: GullSpot[], middle: { x: number; z: number }, count: number, fresh: boolean) {
    this.spots = spots;
    this.middle = middle;
    const want = spots.length > 0 ? count : 0;
    if (!fresh && want === this.gulls.length) return;
    while (this.gulls.length > want) this.group.remove(this.gulls.pop()!.root);
    while (this.gulls.length < want) {
      const model = gullModel();
      this.group.add(model.root);
      const v = () => new THREE.Vector3();
      this.gulls.push({ ...model, mode: "away", t: 0, dur: 0, wait: 0, stay: 0, home: v(), from: v(), via: v(), to: v(), yaw: 0, yawGoal: 0, beat: 0, left: 0, look: 0, awayX: 0, awayZ: 1, speed: 0 });
    }
    // The first is not long coming; the rest drift in over the next while.
    this.gulls.forEach((g, i) => {
      g.mode = "away";
      g.root.visible = false;
      g.wait = 1.5 + i * (3 + Math.random() * 5);
    });
  }

  /**
   * Once a frame. `walkers` are the feet of everyone on the map; `fair` is how good a time it is to be out, 0
   * (night, or a storm) to 1 (a clear day): gulls only come in fair weather and leave when it turns.
   */
  update(dt: number, walkers: readonly THREE.Vector3[], fair: number) {
    const step = Math.min(dt, 1 / 20);
    for (const g of this.gulls) {
      g.t += step;
      switch (g.mode) {
        case "away":
          g.wait -= step;
          if (g.wait <= 0 && fair > 0.4) this.arrive(g, walkers);
          break;
        case "arriving":
          this.fly(g, step, walkers);
          break;
        case "leaving":
          this.leave(g, step);
          break;
        default:
          this.potter(g, step, walkers, fair);
      }
    }
  }

  /** Pick somewhere quiet to come down, and set off for it from out over the sea. */
  private arrive(g: Gull, walkers: readonly THREE.Vector3[]) {
    for (let tries = 0; tries < 8; tries++) {
      const spot = this.spots[(Math.random() * this.spots.length) | 0];
      const x = spot.x + (Math.random() - 0.5) * 0.7, z = spot.z + (Math.random() - 0.5) * 0.7;
      if (walkers.some((w) => Math.hypot(w.x - x, w.z - z) < WARY)) continue;
      if (this.gulls.some((o) => o !== g && o.mode !== "away" && Math.hypot(o.to.x - x, o.to.z - z) < 1.1)) continue;
      // In from the seaward side of the spot, give or take, high and far enough to be seen coming.
      const out = Math.atan2(x - this.middle.x, z - this.middle.z) + (Math.random() - 0.5) * 1.8;
      const far = 11 + Math.random() * 5;
      g.to.set(x, spot.y, z);
      g.home.copy(g.to);
      g.from.set(x + Math.sin(out) * far, spot.y + 5 + Math.random() * 2.5, z + Math.cos(out) * far);
      // By way of a point a little out and above: it comes down in a curve and levels off to land.
      const swing = out + (Math.random() - 0.5) * 1.2;
      g.via.set(x + Math.sin(swing) * 3.2, spot.y + 1.1, z + Math.cos(swing) * 3.2);
      g.mode = "arriving";
      g.t = 0;
      g.dur = 3.4 + Math.random() * 1.2;
      g.beat = Math.random() * 6;
      g.root.visible = true;
      this.spread(g, true);
      g.root.position.copy(g.from);
      return;
    }
    // Nowhere quiet just now: try again shortly.
    g.wait = 2 + Math.random() * 3;
  }

  /** Wings out to fly (legs tucked), or folded to stand. */
  private spread(g: Gull, flying: boolean) {
    for (const w of g.wings) w.visible = flying;
    g.folded.visible = !flying;
    g.legs.visible = !flying;
  }

  /** Set the wings at their place in the beat: `reach` is how hard it is flapping (0: held out, gliding). */
  private flap(g: Gull, reach: number, held = 0.14) {
    const a = held + reach * Math.sin(g.beat);
    // The hand follows the arm a little late, so the wing bends on the way up and whips on the way down.
    const b = reach * 0.55 * Math.sin(g.beat - 0.9) - 0.12;
    g.wings[0].rotation.z = a;
    g.wings[1].rotation.z = -a;
    g.tips[0].rotation.z = b;
    g.tips[1].rotation.z = -b;
  }

  /** Coming in: along its curve, flapping, then gliding, then braking hard as its feet come down. */
  private fly(g: Gull, dt: number, walkers: readonly THREE.Vector3[]) {
    const k = Math.min(1, g.t / g.dur);
    // Someone has walked onto its landing: it thinks better of it and goes round.
    if (k > 0.45 && walkers.some((w) => Math.hypot(w.x - g.to.x, w.z - g.to.z) < SCARE)) return this.takeOff(g, walkers);
    // Quick at first, slowing all the way in.
    const u = 1 - (1 - k) * (1 - k);
    const p = this.scratch;
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    p.set(a * g.from.x + b * g.via.x + c * g.to.x, a * g.from.y + b * g.via.y + c * g.to.y, a * g.from.z + b * g.via.z + c * g.to.z);
    const dx = p.x - g.root.position.x, dz = p.z - g.root.position.z;
    if (Math.hypot(dx, dz) > 1e-4) g.yaw = turnTo(g.yaw, Math.atan2(dx, dz));
    g.root.position.copy(p);
    g.root.rotation.y = g.yaw;
    const braking = ease(Math.max(0, (k - 0.8) / 0.2));
    const gliding = k > 0.55 && k < 0.8;
    g.beat += dt * Math.PI * 2 * (braking > 0 ? BEAT * 1.7 : BEAT);
    this.flap(g, gliding ? 0.04 : 0.62 + braking * 0.3, gliding ? 0.2 : 0.14);
    // Banking down the curve, then rearing back with its legs out to land.
    g.tilt.rotation.x = 0.22 * (1 - braking) - 0.6 * braking;
    g.legs.visible = k > 0.78;
    g.head.rotation.set(0.25 * braking, 0, 0);
    if (k >= 1) {
      this.spread(g, false);
      g.tilt.rotation.x = 0;
      g.root.position.copy(g.to);
      g.stay = 14 + Math.random() * 26;
      this.rest(g, 0.5 + Math.random() * 0.8);
    }
  }

  /** Stand a moment before the next thing. */
  private rest(g: Gull, time: number) {
    g.mode = "idle";
    g.t = 0;
    g.dur = time;
  }

  /** On the ground: watching for anyone coming, and otherwise pecking, looking about and hopping by turns. */
  private potter(g: Gull, dt: number, walkers: readonly THREE.Vector3[], fair: number) {
    const at = g.root.position;
    if (walkers.some((w) => Math.hypot(w.x - at.x, w.z - at.z) < SCARE)) return this.takeOff(g, walkers);
    g.stay -= dt;
    g.yaw += (g.yawGoal - g.yaw) * Math.min(1, dt * 10);
    g.root.rotation.y = g.yaw;
    const k = Math.min(1, g.t / g.dur);
    switch (g.mode) {
      case "idle":
        g.tilt.rotation.x *= Math.exp(-dt * 12);
        g.head.rotation.x *= Math.exp(-dt * 12);
        g.head.rotation.y *= Math.exp(-dt * 6);
        at.y = g.home.y;
        if (k < 1) break;
        // Time to go: only from standing, so it never leaves mid-peck.
        if (g.stay <= 0 || fair < 0.25) return this.takeOff(g, walkers);
        this.next(g);
        break;
      case "pecking": {
        // Down sharply, a jab at the ground, and up: once for each peck.
        const down = Math.sin(k * Math.PI) ** 0.6;
        g.tilt.rotation.x = down * 0.95;
        g.head.rotation.x = down * 0.55;
        if (k >= 1) {
          if (--g.left > 0) g.t = 0;
          else this.rest(g, 0.4 + Math.random() * 1.6);
        }
        break;
      }
      case "looking": {
        // A quick turn of the head, held, and back.
        const turned = k < 0.15 ? k / 0.15 : k > 0.85 ? (1 - k) / 0.15 : 1;
        g.head.rotation.y = g.look * ease(turned);
        if (k >= 1) this.rest(g, 0.3 + Math.random() * 1.2);
        break;
      }
      case "hopping": {
        // Both feet together, a little arc forward.
        at.x = g.from.x + (g.to.x - g.from.x) * k;
        at.z = g.from.z + (g.to.z - g.from.z) * k;
        at.y = g.home.y + Math.sin(k * Math.PI) * 0.09;
        g.tilt.rotation.x = -0.12 * Math.sin(k * Math.PI);
        if (k >= 1) {
          at.y = g.home.y;
          if (--g.left > 0) this.hop(g);
          else this.rest(g, 0.4 + Math.random() * 1.4);
        }
        break;
      }
    }
  }

  /** What a standing gull does next: mostly peck, sometimes look about, sometimes hop on a little way. */
  private next(g: Gull) {
    const roll = Math.random();
    g.t = 0;
    if (roll < 0.45) {
      g.mode = "pecking";
      g.left = 1 + ((Math.random() * 3.99) | 0);
      g.dur = 0.36 + Math.random() * 0.1;
    } else if (roll < 0.7) {
      g.mode = "looking";
      g.look = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.5);
      g.dur = 0.9 + Math.random() * 1.2;
    } else {
      // Turn to face somewhere new, back toward where it landed if it has wandered, and hop that way.
      const at = g.root.position;
      const strayed = Math.hypot(at.x - g.home.x, at.z - g.home.z) > ROAM * 0.6;
      const way = strayed ? Math.atan2(g.home.x - at.x, g.home.z - at.z) + (Math.random() - 0.5) * 0.8 : Math.random() * Math.PI * 2;
      g.yawGoal = turnTo(g.yaw, way);
      g.left = 1 + ((Math.random() * 2.99) | 0);
      this.hop(g);
    }
  }

  private hop(g: Gull) {
    const at = g.root.position;
    const far = 0.16 + Math.random() * 0.1;
    g.mode = "hopping";
    g.t = 0;
    g.dur = 0.22 + Math.random() * 0.05;
    g.from.copy(at);
    g.to.set(at.x + Math.sin(g.yawGoal) * far, g.home.y, at.z + Math.cos(g.yawGoal) * far);
  }

  /** Up and away: from whoever is nearest if anyone is near, else out to sea. */
  private takeOff(g: Gull, walkers: readonly THREE.Vector3[]) {
    const at = g.root.position;
    let from: THREE.Vector3 | null = null;
    let near = SCARE * 1.6;
    for (const w of walkers) {
      const d = Math.hypot(w.x - at.x, w.z - at.z);
      if (d < near) {
        near = d;
        from = w;
      }
    }
    let way = from ? Math.atan2(at.x - from.x, at.z - from.z) : Math.atan2(at.x - this.middle.x, at.z - this.middle.z);
    way += (Math.random() - 0.5) * (from ? 0.7 : 1.6);
    g.awayX = Math.sin(way);
    g.awayZ = Math.cos(way);
    g.yawGoal = turnTo(g.yaw, way);
    // Startled, it is off at once; leaving of its own accord, it gathers way.
    g.speed = from ? 2.4 : 1.2;
    g.mode = "leaving";
    g.t = 0;
    g.dur = 3.6;
    this.spread(g, true);
    g.head.rotation.set(0, 0, 0);
  }

  /** Climbing away, faster and higher, until it is out of sight. */
  private leave(g: Gull, dt: number) {
    const k = g.t / g.dur;
    g.speed = Math.min(7, g.speed + dt * 4.5);
    const at = g.root.position;
    at.x += g.awayX * g.speed * dt;
    at.z += g.awayZ * g.speed * dt;
    at.y += (0.9 + k * 2.6) * dt * Math.min(1, g.t * 4 + 0.3);
    g.yaw += (g.yawGoal - g.yaw) * Math.min(1, dt * 8);
    g.root.rotation.y = g.yaw;
    g.beat += dt * Math.PI * 2 * BEAT * (k < 0.3 ? 1.8 : 1.2);
    this.flap(g, 0.8 - k * 0.2);
    // Nose up as it climbs out, levelling as it goes.
    g.tilt.rotation.x = -0.45 * (1 - ease(Math.min(1, k * 1.6)));
    if (k >= 1) {
      g.mode = "away";
      g.root.visible = false;
      g.wait = 7 + Math.random() * 18;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.group.clear();
    this.gulls = [];
  }
}
