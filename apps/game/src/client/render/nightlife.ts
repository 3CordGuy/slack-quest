// Night life, part of "Fancy graphics": fireflies drifting and blinking over
// the grass, and moths circling the lanterns and lit windows. Both are single
// chunky pixels of light, bright enough for the finishing pass to make glow.
// They come out as the light goes and are gone by day.

import * as THREE from "three";

const FIREFLIES = 70;
const MOTHS_PER_LAMP = 3;
const MAX_LAMPS = 10;

type Fly = { home: THREE.Vector3; phase: number; pace: number };

function points(count: number, size: number): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  // One flat square a couple of picture-pixels across, whatever the distance: a pixel of light, not a blob.
  // Marked transparent so they are drawn after the ground: they write no depth, and the ground would paint over them.
  const material = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Points(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/** A fixed 0..1 number for the nth thing, so the same map has the same fireflies every time. */
const pick = (n: number, salt: number) => {
  const v = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

export class NightLife {
  readonly group = new THREE.Group();
  private fireflies = points(FIREFLIES, 2);
  private moths = points(MAX_LAMPS * MOTHS_PER_LAMP, 2);
  private flies: Fly[] = [];
  private lamps: THREE.Vector3[] = [];

  constructor() {
    this.group.add(this.fireflies, this.moths);
  }

  /** `grass` is the top of every grassy or wooded hex on the map: the fireflies make their homes over some of them. */
  setGrass(grass: THREE.Vector3[]) {
    this.flies = [];
    if (grass.length === 0) return;
    for (let i = 0; i < FIREFLIES; i++) {
      const hex = grass[Math.floor(pick(i, 1) * grass.length)];
      this.flies.push({
        home: new THREE.Vector3(hex.x + (pick(i, 2) - 0.5) * 1.4, hex.y + 0.25 + pick(i, 3) * 0.5, hex.z + (pick(i, 4) - 0.5) * 1.4),
        phase: pick(i, 5) * 40,
        pace: 0.5 + pick(i, 6) * 0.7,
      });
    }
  }

  /**
   * Where the lanterns, lit windows and fires are: the first few get moths. Cheap to call every frame: it
   * only takes the list in when the number of lights or the first one's place has changed.
   */
  setLamps(lamps: THREE.Vector3[]) {
    const sig = `${lamps.length}:${lamps[0] ? `${lamps[0].x},${lamps[0].z}` : ""}`;
    if (sig === this.lampSig) return;
    this.lampSig = sig;
    this.lamps = lamps.slice(0, MAX_LAMPS).map((l) => l.clone());
  }
  private lampSig = "";

  /** `amount` is how much of the night life is out, 0 (day, indoors, or fancy graphics off) to 1 (deep night). */
  update(clock: number, amount: number) {
    const out = amount > 0.04;
    this.fireflies.visible = out && this.flies.length > 0;
    this.moths.visible = out && this.lamps.length > 0;
    if (!out) return;

    if (this.fireflies.visible) {
      const at = this.fireflies.geometry.getAttribute("position") as THREE.BufferAttribute;
      const tint = this.fireflies.geometry.getAttribute("color") as THREE.BufferAttribute;
      this.flies.forEach((f, i) => {
        const t = clock * f.pace + f.phase;
        // A slow wander round its home, never quite the same loop twice.
        at.setXYZ(i, f.home.x + Math.sin(t * 0.7) * 0.5 + Math.sin(t * 0.23) * 0.3, f.home.y + Math.sin(t * 0.9) * 0.18, f.home.z + Math.cos(t * 0.6) * 0.5 + Math.cos(t * 0.31) * 0.3);
        // Dark most of the time, then a slow pulse of yellow-green.
        const glow = Math.pow(Math.max(0, Math.sin(t * 1.1)), 4) * amount * 2.2;
        tint.setXYZ(i, 0.75 * glow, 1.0 * glow, 0.3 * glow);
      });
      at.needsUpdate = true;
      tint.needsUpdate = true;
    }

    if (this.moths.visible) {
      const at = this.moths.geometry.getAttribute("position") as THREE.BufferAttribute;
      const tint = this.moths.geometry.getAttribute("color") as THREE.BufferAttribute;
      for (let i = 0; i < MAX_LAMPS * MOTHS_PER_LAMP; i++) {
        const lamp = this.lamps[Math.floor(i / MOTHS_PER_LAMP)];
        if (!lamp) {
          tint.setXYZ(i, 0, 0, 0);
          continue;
        }
        // Quick, jittery circles close round the light, each moth at its own speed and height.
        const t = clock * (2.2 + pick(i, 7) * 1.8) + pick(i, 8) * 40;
        const r = 0.22 + 0.12 * Math.sin(t * 1.7) + pick(i, 9) * 0.12;
        at.setXYZ(i, lamp.x + Math.sin(t) * r, lamp.y + 0.05 + Math.sin(t * 2.3) * 0.12, lamp.z + Math.cos(t) * r);
        // They catch the light as they turn.
        const glow = (0.45 + 0.4 * Math.sin(t * 3.1)) * amount;
        tint.setXYZ(i, 1.0 * glow, 0.9 * glow, 0.7 * glow);
      }
      at.needsUpdate = true;
      tint.needsUpdate = true;
    }
  }

  dispose() {
    for (const p of [this.fireflies, this.moths]) {
      p.geometry.dispose();
      (p.material as THREE.Material).dispose();
    }
  }
}
