// Lightning. A storm is its own kind of weather (see Ambience.storming): heavy
// rain with thunder, where a downpour is heavy rain without. In a storm a strike comes every so often: the audio engine picks
// a thunder take (never the one before; every take once before any repeats),
// and the flash on screen follows that recording's own loudness, so the light
// cracks when the sound cracks and flickers again if the take has a second
// crack in it. A bolt is drawn out over the sea for as long as the flash is bright.
//
// With no thunder recording yet (or the sound switched off) a strike still
// flashes, on a plain flicker of its own.

import * as THREE from "three";
import type { StartedTake } from "../audio/engine";
import { sounds } from "../audio/gameSounds";

/** How far a storm must have come in (0 to 1) before there is lightning at all. */
const STORM_FROM = 0.5;
/** Seconds between strikes: the longest wait as a storm comes in or passes, the shortest at its height. */
const WAIT_LIGHT: [number, number] = [22, 50];
const WAIT_HEAVY: [number, number] = [9, 24];
/** How long one slice of a take's loudness is, in samples. About 11 ms at 48 kHz: fast enough to catch a crack. */
const SLICE = 512;

/** The loudness of each take over time, 0 to 1 against its own loudest moment. Kept, since takes come round again. */
const envelopes = new WeakMap<AudioBuffer, Float32Array>();
function envelopeOf(buffer: AudioBuffer): Float32Array {
  const known = envelopes.get(buffer);
  if (known) return known;
  const out = new Float32Array(Math.ceil(buffer.length / SLICE));
  let top = 1e-6;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      const slot = (i / SLICE) | 0;
      if (v > out[slot]) out[slot] = v;
      if (v > top) top = v;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= top;
  envelopes.set(buffer, out);
  return out;
}

const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const between = ([low, high]: [number, number]) => low + Math.random() * (high - low);

export class Storm {
  /** The bolt: a jagged line from the cloud down to the sea, redrawn for each strike. */
  readonly bolt: THREE.LineSegments;
  /** How bright the lightning is right now, 0 to 1. */
  flash = 0;
  private wait = between(WAIT_LIGHT);
  /** The take the current strike is following, once the engine has scheduled it. */
  private take: StartedTake | null = null;
  /** Seconds since the current strike began, or -1 with none under way. */
  private since = -1;
  /** When, on the take's clock, its first crack came: the light dies away from then, whatever the rumble does. */
  private crackAt = -1;
  /** How loud the loudest crack so far in this take was, 0 to 1. */
  private loudest = 0;
  private indoors = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(40 * 2 * 3), 3));
    this.bolt = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: "#dfe8ff", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
  }

  /** For trying it out: strike now, whatever the weather. */
  strikeNow(camera: THREE.Camera, target: THREE.Vector3) {
    this.strike(camera, target);
  }

  /**
   * Once a frame.
   * @param storm how much of a storm it is, 0 to 1 (0 in any other weather, and underground)
   * @param target what the camera is looking at
   * @param indoors in a room: the thunder comes through the walls, and there is no bolt to see
   */
  update(dt: number, storm: number, camera: THREE.Camera, target: THREE.Vector3, indoors = false) {
    this.indoors = indoors;
    if (storm >= STORM_FROM) {
      this.wait -= dt;
      if (this.wait <= 0 && this.since < 0) {
        this.strike(camera, target);
        const heavy = (storm - STORM_FROM) / (1 - STORM_FROM);
        this.wait = between(WAIT_LIGHT) + (between(WAIT_HEAVY) - between(WAIT_LIGHT)) * heavy;
      }
    } else if (this.wait < 6) this.wait = between(WAIT_LIGHT);

    let want = 0;
    if (this.since >= 0) {
      this.since += dt;
      if (this.take) {
        // Follow the recording: bright where it is loud, dark where it is not.
        const t = this.take.elapsed();
        const env = envelopeOf(this.take.buffer);
        const slot = Math.floor((t * this.take.rate * this.take.buffer.sampleRate) / SLICE);
        if (slot >= env.length) this.since = -1;
        else if (slot >= 0) {
          const loud = Math.max(env[slot], env[Math.min(env.length - 1, slot + 1)]);
          const crack = Math.pow(Math.min(1, Math.max(0, (loud - 0.28) / 0.6)), 1.3);
          // The light fades from the first crack, and starts afresh from any later one that is clearly
          // louder: a take that opens with a crackle and lands its boom two seconds in is brightest at the boom.
          if (crack > 0.2 && (this.crackAt < 0 || crack > this.loudest + 0.15)) {
            this.crackAt = t;
            this.loudest = crack;
          }
          // A long loud rumble does not hold the sky lit: the light fades over a couple of seconds from the first crack.
          want = this.crackAt < 0 ? 0 : crack * Math.exp(-(t - this.crackAt) * 0.9);
        }
      } else {
        // No recording to follow: a plain double flicker, and done.
        const t = this.since;
        want = Math.max(Math.exp(-t * 14), t > 0.12 ? 0.8 * Math.exp(-(t - 0.12) * 10) : 0, t > 0.3 ? 0.5 * Math.exp(-(t - 0.3) * 6) : 0);
        if (t > 1.6) this.since = -1;
      }
    }
    // Reduced motion: the storm still lights up, but far more gently.
    if (calm) want *= 0.3;
    // Up at once, down a little slower: a single loud slice still reads as a flash, and the many quick
    // peaks in a crack run together into a flicker instead of a strobe.
    this.flash = want > this.flash ? want : Math.max(want, this.flash * Math.exp(-dt * 9));
    if (this.since < 0 && this.flash < 0.01) this.flash = 0;
    this.bolt.visible = this.flash > 0.12 && !this.indoors;
    (this.bolt.material as THREE.LineBasicMaterial).opacity = Math.min(1, this.flash * 1.4);
  }

  private strike(camera: THREE.Camera, target: THREE.Vector3) {
    this.since = 0;
    this.take = null;
    this.crackAt = -1;
    this.loudest = 0;
    // Asked for now; the engine answers when the take is scheduled (at once if it is loaded). If it never
    // answers, `take` stays empty and the plain flicker runs.
    // From indoors it is heard as from somewhere outside, a good way off in some direction: the engine
    // turns that distance into a quieter, duller sound, a little to one side.
    const from = Math.random() * Math.PI * 2;
    const outside = this.indoors ? { x: target.x + Math.sin(from) * 13, z: target.z + Math.cos(from) * 13 } : undefined;
    sounds.thunder((take) => {
      this.take = take;
      this.since = 0;
    }, outside);
    if (!this.indoors) this.draw(camera, target);
  }

  /** A new bolt, out over the sea beyond what the camera is looking at, a little to one side or the other. */
  private draw(camera: THREE.Camera, target: THREE.Vector3) {
    const away = new THREE.Vector3(target.x - camera.position.x, 0, target.z - camera.position.z).normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const foot = target.clone().addScaledVector(away, 16 + Math.random() * 14).addScaledVector(side, (Math.random() - 0.5) * 30);
    foot.y = 0.2;
    const at = this.bolt.geometry.getAttribute("position") as THREE.BufferAttribute;
    let n = 0;
    const limb = (from: THREE.Vector3, to: THREE.Vector3, steps: number, wander: number) => {
      let last = from.clone();
      for (let i = 1; i <= steps && n < at.count - 1; i++) {
        const next = from.clone().lerp(to, i / steps);
        if (i < steps) {
          next.addScaledVector(side, (Math.random() - 0.5) * wander);
          next.addScaledVector(away, (Math.random() - 0.5) * wander * 0.4);
        }
        at.setXYZ(n++, last.x, last.y, last.z);
        at.setXYZ(n++, next.x, next.y, next.z);
        last = next;
      }
      return last;
    };
    const top = foot.clone().addScaledVector(side, (Math.random() - 0.5) * 8);
    top.y = 26;
    limb(top, foot, 14, 2.2);
    // One fork, leaving the main stroke partway down and dying out before the water.
    const forkFrom = top.clone().lerp(foot, 0.3 + Math.random() * 0.3);
    const forkTo = forkFrom.clone().addScaledVector(side, (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 4));
    forkTo.y = forkFrom.y * 0.45;
    limb(forkFrom, forkTo, 6, 1.4);
    for (let i = n; i < at.count; i++) at.setXYZ(i, foot.x, foot.y, foot.z);
    at.needsUpdate = true;
  }

  dispose() {
    this.bolt.geometry.dispose();
    (this.bolt.material as THREE.Material).dispose();
  }
}
