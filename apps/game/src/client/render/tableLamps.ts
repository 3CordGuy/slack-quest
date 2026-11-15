// A lantern hung low over each of the pub's game tables, throwing a warm,
// flickering pool of light on the cloth. It burns low over an empty table and
// comes up when someone stands at it, and flares when the table asks it to:
// dice landing, a hand taken, a game won (see TableStage).
//
// No light of its own: its light is one the room already has (see
// Ambience.setTableLamps), so hanging lanterns never changes how many lights
// the scene draws, and none of them throws a shadow.

import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";

/** The pub's game tables, by the id of their point of interest. */
export const LAMP_TABLES = new Set(["dice", "shoals", "crew", "tide"]);

/**
 * How high a lantern hangs over the floor, and how big it is drawn: low and large over the room's table, so it reads
 * from up in the usual view; drawn up over the seated table, just over the heads across it, clear of their faces.
 */
const ROOM_Y = 1.3;
const ROOM_SIZE = 1.6;
const SEAT_Y = 1.9;
/**
 * Where its light comes from: well under the lantern, close over the cloth (the room's tables are about 0.47 high,
 * the seated one 0.62), so the light falls off fast across the table and leaves a pool on it rather than a wash.
 */
const ROOM_LIGHT_Y = 1.05;
const SEAT_LIGHT_Y = 1.1;
/** How far behind the hex's middle the room's table stands (the model sits 0.28 back, its table 0.3 further). The seated table is on the middle. */
const ROOM_TABLE_Z = -0.58;
/** How bright a lantern burns over an empty table, and over one in use. */
const BANKED = 0.45;
const LIT = 1;
/** The light it gives at full: what the room's light is given (see Ambience.setTableLamps). */
const POWER = 1.1;
/** How much brighter it burns over the seated table: up close the dark cloth fills the view, and needs more to show its pool. */
const SEAT_BOOST = 2.9;

/** One lantern's light, as the room's lights are handed it. `power` is its strength this frame, `flare` how far it is flared (0 to about 1.5). */
export interface LampLight {
  pos: THREE.Vector3;
  power: number;
  flare: number;
}

interface Lamp {
  hex: HexPos;
  root: THREE.Group;
  core: THREE.MeshBasicMaterial;
  halo: THREE.SpriteMaterial;
  /** Over the room's table, and over the seated table that takes its place. */
  home: THREE.Vector3;
  seat: THREE.Vector3;
  /** How far it has moved over to the seated table, 0 to 1 (set by the table while you sit at it). */
  slide: number;
  level: number;
  flare: number;
  /** Seconds the flare takes to settle by about two thirds. */
  fade: number;
  seed: number;
  light: LampLight;
}

const CORE = new THREE.Color("#ffc46b");
const HOT = new THREE.Color("#fff1cf");

/** A soft round glow, white in the middle, for the halo sprite. Made once. */
let haloMap: THREE.Texture | null = null;
function halo(): THREE.Texture {
  if (haloMap) return haloMap;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  haloMap = new THREE.CanvasTexture(c);
  haloMap.colorSpace = THREE.SRGBColorSpace;
  return haloMap;
}

/** The lantern: an iron cage round a glowing core, a peaked cap, and the chain it hangs by. */
function lanternModel(core: THREE.MeshBasicMaterial, haloMat: THREE.SpriteMaterial): THREE.Group {
  const g = new THREE.Group();
  const iron = new THREE.MeshBasicMaterial({ color: "#2b211a" });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.1, 0.13, 0.1), core, 0, 0, 0);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(new THREE.BoxGeometry(0.018, 0.15, 0.018), iron, x * 0.056, 0, z * 0.056);
  add(new THREE.BoxGeometry(0.14, 0.02, 0.14), iron, 0, -0.075, 0);
  add(new THREE.ConeGeometry(0.1, 0.07, 4), iron, 0, 0.1, 0).rotation.y = Math.PI / 4;
  add(new THREE.TorusGeometry(0.022, 0.007, 4, 8), iron, 0, 0.15, 0);
  // Up to the beams: about as long, in the room, as it is drawn up over the seated table.
  add(new THREE.BoxGeometry(0.012, 1.1, 0.012), iron, 0, 0.16 + 0.55, 0);
  const glow = new THREE.Sprite(haloMat);
  glow.scale.setScalar(0.62);
  glow.renderOrder = 3;
  g.add(glow);
  return g;
}

export class TableLamps {
  readonly group = new THREE.Group();
  private lamps = new Map<string, Lamp>();
  private clock = 0;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Take every lantern down. */
  clear() {
    for (const l of this.lamps.values()) {
      l.root.traverse((o) => {
        // Not the sprite: its geometry is three's own, shared by every sprite.
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      });
      l.halo.dispose();
    }
    this.lamps.clear();
    this.group.clear();
  }

  /** Hang one over the table `id` at `hex`, whose middle stands at `at`. */
  hang(id: string, hex: HexPos, at: THREE.Vector3) {
    const core = new THREE.MeshBasicMaterial({ color: CORE.clone() });
    const haloMat = new THREE.SpriteMaterial({ map: halo(), color: "#ffb35c", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const root = lanternModel(core, haloMat);
    const home = new THREE.Vector3(at.x, at.y + ROOM_Y, at.z + ROOM_TABLE_Z);
    const seat = new THREE.Vector3(at.x, at.y + SEAT_Y, at.z);
    root.position.copy(home);
    this.group.add(root);
    const seed = this.lamps.size * 2.3 + 0.7;
    this.lamps.set(id, { hex, root, core, halo: haloMat, home, seat, slide: 0, level: BANKED, flare: 0, fade: 1, seed, light: { pos: home.clone(), power: 0, flare: 0 } });
  }

  /** The lights, for the room to light them by. The same objects every frame. */
  lights(): LampLight[] {
    return [...this.lamps.values()].map((l) => l.light);
  }

  /** Move a lantern from over the room's table (0) to over the seated one (1). */
  slide(id: string, k: number) {
    const l = this.lamps.get(id);
    if (l) l.slide = k;
  }

  /** Flare a lantern up by `amount` (0.3 a small lift, 1 or more a blaze), settling over about `fade` seconds. */
  flare(id: string, amount: number, fade: number) {
    const l = this.lamps.get(id);
    if (!l || amount <= l.flare) return;
    l.flare = amount;
    l.fade = fade;
  }

  /** Step every lantern: `busy` says whether anyone stands at a table's hex. */
  update(dt: number, busy: (hex: HexPos) => boolean) {
    this.clock += dt;
    const t = this.clock;
    const motion = this.still ? 0 : 1;
    for (const l of this.lamps.values()) {
      const want = busy(l.hex) ? LIT : BANKED;
      l.level += (want - l.level) * (1 - Math.exp(-dt * 1.6));
      l.flare *= Math.exp(-dt / l.fade);
      if (l.flare < 0.005) l.flare = 0;
      // A flame's unsteadiness: two slow swells and a quicker catch, its own for each lantern.
      const s = l.seed;
      const wave = 1 + motion * (Math.sin(t * 7.3 + s) * 0.06 + Math.sin(t * 12.9 + s * 3.1) * 0.04 + Math.sin(t * 2.1 + s * 1.7) * 0.05);
      const power = POWER * (1 + (SEAT_BOOST - 1) * l.slide) * l.level * wave * (1 + l.flare);
      l.light.power = power;
      l.light.flare = l.flare;
      // A lantern hangs from a chain: it sways a touch, and swings a little more when it flares.
      const sway = motion * (0.012 + 0.02 * Math.min(1, l.flare));
      l.root.position.lerpVectors(l.home, l.seat, l.slide);
      l.root.scale.setScalar(ROOM_SIZE + (1 - ROOM_SIZE) * l.slide);
      l.root.rotation.z = Math.sin(t * 1.3 + s) * sway;
      l.root.rotation.x = Math.sin(t * 0.9 + s * 2) * sway * 0.7;
      l.light.pos.copy(l.root.position).setY(l.home.y - ROOM_Y + ROOM_LIGHT_Y + (SEAT_LIGHT_Y - ROOM_LIGHT_Y) * l.slide);
      const bright = l.level * wave * (1 + l.flare);
      l.core.color.copy(CORE).lerp(HOT, Math.min(1, l.flare * 0.7)).multiplyScalar(0.55 + 0.45 * Math.min(1.4, bright));
      l.halo.opacity = Math.min(1, 0.25 + 0.45 * bright);
    }
  }
}
