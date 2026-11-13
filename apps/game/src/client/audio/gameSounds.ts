// What the renderer calls as things happen on screen, timed to the animation:
// a foot landing, a blow setting off and landing, someone going down. Each
// asks the engine for the names in names.ts, most specific first.

import type { WorldEvent } from "@gantt-quest/world";
import { audio } from "./engine";
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
  levelUp() {
    audio.play(soundName.levelUp());
  },
  world(ev: WorldEvent, you: string) {
    const names = soundName.world(ev, you);
    if (names) audio.play(names);
  },
  /** Where you stand, every frame. */
  listener(x: number, z: number) {
    audio.setListener(x, z);
  },
};
