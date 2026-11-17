// Locked doors in a delve, and the keys to them. The caverns shut a dead-end
// room or two behind a heavy door (caverns.ts), with a strongbox inside, and
// leave a key to each on the near side: in a chest, or carried by one of the
// bands. Keys are the party's, kept on one ring: any key opens any door.
//
// A door is worked from beside it (it stands across the way, a wall until it
// opens): an Action in a fight, free out of one.
//
// - With a key on the ring, it is unlocked, quietly, and the key is used up.
// - Without one, it is forced: a Strength roll against FORCE_DC. It gives way
//   or it holds, and either way the crash is heard. The nearest band within
//   NOISE_RANGE that has not yet noticed anyone comes running (zone.ts sets
//   it on whoever made the noise). A key is worth looking for.

import { hexDistance, posKey } from "@gantt-quest/core";
import { BASE_HEIGHT, tileAt, type Poi } from "../map";
import { saveRoll, type Ctx } from "./engine";
import type { Unit, ZoneState } from "./types";

/** What forcing a door takes: a Strength roll at least this. */
export const FORCE_DC = 13;
/** How far the crash of a forced door carries, in hexes. */
export const NOISE_RANGE = 8;

/** Why `unit` cannot work this door, in words, or null if it can. */
export function checkUnlock(state: ZoneState, unit: Unit, door: Poi | undefined): string | null {
  if (!door) return "There is no door there.";
  if (door.cleared) return "It stands open already.";
  if (unit.side !== "hero") return "Only a hero can work a door.";
  if (unit.down) return "Not while you are down.";
  if (hexDistance(unit.pos, door.pos) > 1) return "Go up to it first.";
  return null;
}

/** Unlock a door with a key from the ring, or force it. Says whether it was forced (and so heard), and whether it opened. */
export function workDoor(ctx: Ctx, unit: Unit, door: Poi): { forced: boolean; opened: boolean } {
  const { state } = ctx;
  let how: "key" | "forced" | "held";
  if ((state.keys ?? 0) > 0) {
    state.keys! -= 1;
    how = "key";
  } else {
    how = saveRoll(ctx, unit, "str", FORCE_DC, "Force the door").ok ? "forced" : "held";
  }
  ctx.events.push({ t: "door", id: unit.id, poi: door.id, how });
  if (how !== "held") {
    door.cleared = true;
    const tile = tileAt(state.map, door.pos);
    if (tile) {
      tile.biome = "cave";
      tile.h = BASE_HEIGHT.cave;
    }
  }
  return { forced: how !== "key", opened: how !== "held" };
}

/** The band the crash of a forced door at `at` brings: the nearest within NOISE_RANGE that has not noticed anyone yet. */
export function heardBy(state: ZoneState, at: { q: number; r: number }): string | undefined {
  let best: { group: string; d: number } | undefined;
  for (const u of state.units) {
    if (u.side !== "enemy" || u.down || !u.group || state.groups[u.group]?.alerted) continue;
    const d = hexDistance(u.pos, at);
    if (d <= NOISE_RANGE && (!best || d < best.d)) best = { group: u.group, d };
  }
  return best?.group;
}

/** A band that carried a key is beaten (nobody of it left standing): the key goes on the party's ring. */
export function dropKeys(ctx: Ctx): void {
  const { state } = ctx;
  for (const group of [...(state.keyHolders ?? [])]) {
    if (state.units.some((u) => u.group === group && !u.down)) continue;
    state.keyHolders = state.keyHolders!.filter((g) => g !== group);
    state.keys = (state.keys ?? 0) + 1;
    ctx.events.push({ t: "key", keys: state.keys, from: "band" });
  }
}

/** The door on this hex, if there is one, shut or open. */
export const doorAt = (state: Pick<ZoneState, "map">, at: { q: number; r: number }): Poi | undefined =>
  state.map.pois.find((p) => p.kind === "gate" && posKey(p.pos) === posKey(at));
