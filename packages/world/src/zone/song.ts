// The Bard's shanties. A shanty is a condition on the Bard (one at a time:
// striking up another ends the first), and it reaches everyone on the Bard's
// side within its radius, the Bard among them. What it gives is worked out
// from where everyone stands right now, so walking into it or out of it
// counts at once. An ally standing in it can join it, once a shanty, as a
// Bonus action (combat.ts): the shanty reaches a hex further for as long as it
// is sung, the one who joined gets a lift of their own, and everyone in it a
// little more of what it gives until the Bard's next turn. The Bard cannot join their own.
//
// Only queries here: what changes a unit is in engine.ts and combat.ts.

import { hexDistance } from "@gantt-quest/core";
import { SHANTY } from "./kit";
import type { ShantyKind, Unit, UnitCondition, ZoneState } from "./types";

export const SHANTIES: readonly ShantyKind[] = ["lively_shanty", "dour_shanty", "windgod_shanty"];

export const isShanty = (kind: string): kind is ShantyKind => (SHANTIES as readonly string[]).includes(kind);

/** The shanty a unit is singing, if it is singing one. */
export const shantyOf = (unit: Pick<Unit, "conditions">): (UnitCondition & { kind: ShantyKind }) | undefined =>
  unit.conditions.find((c): c is UnitCondition & { kind: ShantyKind } => isShanty(c.kind));

/** How far a shanty reaches: a hex further for each who has joined it. */
export const shantyRadius = (song: UnitCondition): number => SHANTY.radius + (song.joined?.length ?? 0);

export interface Song {
  bard: Unit;
  song: UnitCondition & { kind: ShantyKind };
}

/** Every shanty reaching `unit`: sung by someone of its side, still standing, near enough. A Bard is in their own. */
export function songsOn(state: Pick<ZoneState, "units">, unit: Unit): Song[] {
  if (unit.down) return [];
  const out: Song[] = [];
  for (const bard of state.units) {
    if (bard.side !== unit.side || bard.down) continue;
    const song = shantyOf(bard);
    if (song && hexDistance(bard.pos, unit.pos) <= shantyRadius(song)) out.push({ bard, song });
  }
  return out;
}

/** The best of one kind of shanty reaching a unit, by what `worth` makes of it: two of a kind do not add up. */
function best(state: Pick<ZoneState, "units">, unit: Unit, kind: ShantyKind, worth: (s: Song) => number): number {
  return Math.max(0, ...songsOn(state, unit).filter((s) => s.song.kind === kind).map(worth));
}

/** Added to a unit's rolls to hit: a Lively Shanty, and its lift from those who joined since the Bard's turn. */
export const songHit = (state: Pick<ZoneState, "units">, unit: Unit): number =>
  best(state, unit, "lively_shanty", (s) => SHANTY.lively.hit + SHANTY.lively.surge * (s.song.surge ?? 0));

/** Added to a unit's damage: a Lively Shanty, by the Bard's level. */
export const songDamage = (state: Pick<ZoneState, "units">, unit: Unit): number => best(state, unit, "lively_shanty", (s) => SHANTY.lively.damage(s.bard.level));

/** Added to a unit's Defence: a Dour Shanty, and its lift from those who joined since the Bard's turn. */
export const songDefence = (state: Pick<ZoneState, "units">, unit: Unit): number =>
  best(state, unit, "dour_shanty", (s) => SHANTY.dour.defence + SHANTY.dour.perJoin * (s.song.surge ?? 0));

/** Added to a unit's movement: a Wind-god's Shanty, and its lift from those who joined since the Bard's turn. */
export const songMove = (state: Pick<ZoneState, "units">, unit: Unit): number =>
  best(state, unit, "windgod_shanty", (s) => SHANTY.windgod.move + SHANTY.windgod.perJoin * (s.song.surge ?? 0));

/** In a Wind-god's Shanty: it cannot be Slowed. */
export const windward = (state: Pick<ZoneState, "units">, unit: Unit): boolean => songsOn(state, unit).some((s) => s.song.kind === "windgod_shanty");

/** The shanties a unit could join now: ones it stands in, not its own, that it has not joined already. */
export const joinable = (state: Pick<ZoneState, "units">, unit: Unit): Song[] =>
  songsOn(state, unit).filter((s) => s.bard.id !== unit.id && !s.song.joined?.includes(unit.id));
