// What the renderer calls as things happen on screen, timed to the animation:
// a foot landing, a blow setting off and landing, someone going down. Each
// asks the engine for the names in names.ts, most specific first.

import type { WorldEvent } from "@gantt-quest/world";
import { audio, type SeaArea } from "./engine";
import { soundName, type AttackStyle, type Fighter } from "./names";

/** Where on the map it happens, for distance falloff. */
type At = { x: number; z: number } | undefined;

export const sounds = {
  /** Your own steps play as they are; anyone else's fall off with distance and sit a little lower. */
  footstep(biome: string, at: At, yours: boolean) {
    audio.play(soundName.footstep(biome), yours ? {} : { at, gainDb: -4 });
  },
  attack(ability: string, style: AttackStyle, actor: Fighter | undefined, at: At) {
    audio.play(soundName.attack(ability, style), { at });
    if (actor) audio.play(soundName.attackVoice(actor), { at });
  },
  impact(ability: string, style: AttackStyle, perfect: boolean, target: Fighter | undefined, at: At) {
    audio.play(soundName.impact(ability, style), { at });
    if (perfect) audio.play(soundName.crit(), { at });
    if (target) audio.play(soundName.hurt(target), { at, delay: 0.05 });
  },
  miss(ability: string, style: AttackStyle, at: At) {
    audio.play(soundName.miss(ability, style), { at });
  },
  heal(ability: string, at: At) {
    audio.play(soundName.heal(ability), { at });
  },
  healFailed(at: At) {
    audio.play(soundName.healFailed(), { at });
  },
  tick(effect: string, at: At) {
    audio.play(soundName.tick(effect), { at });
  },
  effect(effect: string, at: At) {
    audio.play(soundName.effect(effect), { at });
  },
  down(who: Fighter | undefined, at: At) {
    audio.play(who ? soundName.down(who) : ["down"], { at });
  },
  flee(ok: boolean, at: At) {
    audio.play(soundName.flee(ok), { at });
  },
  trait(name: string, at: At) {
    audio.play(soundName.trait(name), { at });
  },
  yourTurn() {
    audio.play(soundName.yourTurn());
  },
  /** A boss has turned up: heard as the battle's opening card goes up. */
  boss() {
    audio.play(soundName.boss());
  },
  levelUp() {
    audio.play(soundName.levelUp());
  },
  world(ev: WorldEvent, you: string) {
    const names = soundName.world(ev, you);
    if (names) audio.play(names);
  },
};

type Point = { x: number; z: number };
const LIGHT_KINDS = ["fire", "candle", "lamp"] as const;

/** Every map on screen, oldest first. Only the newest is heard from. */
const ears: object[] = [];
let heard: object | null = null;

/**
 * A map's place in the sound: where you stand on it, its sky, its fires and
 * its water. Each renderer opens one. When one map is drawn over another (the
 * crossing over the ship's deck), the one on top is heard, and the one under
 * it takes over again when that closes.
 */
export function openEar() {
  const me = {};
  ears.push(me);
  let lights: Record<(typeof LIGHT_KINDS)[number], Point[]> = { fire: [], candle: [], lamp: [] };
  const send = () => {
    for (const kind of LIGHT_KINDS) audio.setEmitters(kind, lights[kind]);
  };
  const top = () => {
    if (ears.at(-1) !== me) return false;
    // Newly on top: the engine still has the last map's fires.
    if (heard !== me) {
      heard = me;
      audio.clearWorld();
      send();
    }
    return true;
  };
  return {
    /** Where you stand and how the camera is turned, every frame. */
    listener(x: number, z: number, yaw: number) {
      if (top()) audio.setListener(x, z, yaw);
    },
    /** The sky outside, every frame: it drives whatever in the manifest follows "time", "night" or "rain". */
    sky(sky: { time: number; night: number; rain: number }) {
      if (!top()) return;
      audio.setParam("time", sky.time);
      audio.setParam("night", sky.night);
      audio.setParam("rain", sky.rain);
    },
    /** Every fire, candle and lamp on the map, whenever they change. */
    lights(all: { kind: string; x: number; z: number }[]) {
      lights = { fire: [], candle: [], lamp: [] };
      for (const l of all) if (l.kind in lights) lights[l.kind as keyof typeof lights].push({ x: l.x, z: l.z });
      if (top()) send();
    },
    /** The ground you stand on (a biome), a few times a second: it picks the reverb. */
    ground(biome: string | null) {
      if (top()) audio.setGround(biome);
    },
    /** Where the water is from where you stand (see nearWater), a few times a second. */
    sea(area: SeaArea | null) {
      if (top()) audio.setSea(area);
    },
    close() {
      const i = ears.indexOf(me);
      if (i >= 0) ears.splice(i, 1);
      if (heard === me) {
        heard = null;
        audio.clearWorld();
        audio.setGround(null);
      }
    },
  };
}

/**
 * The sea from where you stand: the nearest water, which way most of the
 * water within reach lies, and how much it surrounds you. Null with none in reach.
 */
export function nearWater(x: number, z: number, water: Point[], reach = 18): SeaArea | null {
  let nearest = Infinity;
  let sx = 0;
  let sz = 0;
  let total = 0;
  for (const w of water) {
    const dx = w.x - x;
    const dz = w.z - z;
    const d = Math.hypot(dx, dz);
    if (d > reach) continue;
    nearest = Math.min(nearest, d);
    // Nearer water counts for much more, so the shore you stand on outweighs a bay across the island.
    const weight = 1 / (1 + d) ** 2;
    total += weight;
    if (d > 1e-6) {
      sx += (weight * dx) / d;
      sz += (weight * dz) / d;
    }
  }
  if (total === 0) return null;
  const pull = Math.hypot(sx, sz) / total;
  return { distance: nearest, dx: sx / total, dz: sz / total, spread: 1 - Math.min(1, pull) };
}
