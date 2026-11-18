// Creatures a hero calls into a fight (Summon Sea Turtle, Summon Sunken
// Sailors). Each is a unit on the hero's side, played by the hero's player
// on the hero's initiative: it stands right after them in the order, so it
// shares their turn. It is gone when it falls, when its caller calls again
// (everything they called before goes), or when the fight is over; it never
// walks the map out of a fight.

import { hexDistance, hexNeighbors, type HexPos } from "@gantt-quest/core";
import { tileAt } from "../map";
import type { Ctx } from "./engine";
import { blockerAt, sameHex, solid, unitAt } from "./geometry";
import { SUMMONS, SUMMON_CALLS, type SummonCall } from "./kit";
import { enterSurface } from "./surfaces";
import type { Unit, ZoneState } from "./types";
import { enterWeather } from "./weather";

/** The creatures `by` has called that are still about. */
export const summonsOf = (state: ZoneState, by: string): Unit[] => state.units.filter((u) => u.summon?.by === by);

/** Take a called creature off the map, and out of the fight's order and turn. */
export function dismiss(ctx: Ctx, unit: Unit): void {
  const { state } = ctx;
  state.units = state.units.filter((u) => u.id !== unit.id);
  const enc = state.encounter;
  if (enc) {
    enc.order = enc.order.filter((id) => id !== unit.id);
    enc.acting = enc.acting.filter((id) => id !== unit.id);
    enc.done = enc.done.filter((id) => id !== unit.id);
    enc.reacted = enc.reacted.filter((id) => id !== unit.id);
    delete enc.budgets[unit.id];
    delete enc.init[unit.id];
  }
  ctx.events.push({ t: "dismissed", id: unit.id });
}

/**
 * Where each creature of a call would stand, aimed at `at` by `caller`: the first on `at`, each one after on the open hex
 * beside it nearest the caller. What the caller called before is about to go, so the hexes it holds count as open.
 * Null if any of them has nowhere to stand.
 */
export function summonSpots(state: ZoneState, caller: Unit, call: SummonCall, at: HexPos): HexPos[] | null {
  const leaving = new Set(summonsOf(state, caller.id).map((u) => u.id));
  const open = (p: HexPos) => {
    const tile = tileAt(state.map, p);
    const there = unitAt(state, p);
    return !!tile && !solid(tile) && !blockerAt(state, p) && (!there || leaving.has(there.id));
  };
  const spots: HexPos[] = [];
  for (let i = 0; i < SUMMON_CALLS[call].length; i++) {
    const spot =
      i === 0
        ? open(at) ? at : undefined
        : hexNeighbors(at, state.map.grid)
            .filter((p) => open(p) && !spots.some((s) => sameHex(s, p)))
            .sort((a, b) => hexDistance(a, caller.pos) - hexDistance(b, caller.pos) || a.q - b.q || a.r - b.r)[0];
    if (!spot) return null;
    spots.push(spot);
  }
  return spots;
}

/**
 * The creatures of a call, for `caller`, aimed at `at` (checked already: summonSpots has room for them all). Whatever the caller
 * called before is sent away first. They go into the order just after the caller, on their initiative, in the order called,
 * and if the caller's turn is underway each has one too, starting now.
 */
export function summonCall(ctx: Ctx, caller: Unit, call: SummonCall, at: HexPos): Unit[] {
  const { state } = ctx;
  const spots = summonSpots(state, caller, call, at) ?? [];
  for (const old of summonsOf(state, caller.id)) dismiss(ctx, old);
  const called: Unit[] = [];
  SUMMON_CALLS[call].forEach((kind, i) => {
    const pos = spots[i];
    if (!pos) return;
    const def = SUMMONS[kind];
    const hp = def.hp(caller.level);
    const unit: Unit = {
      id: `t${++state.seq}`,
      side: caller.side,
      name: def.name,
      kind,
      level: caller.level,
      pos: { q: pos.q, r: pos.r },
      hp,
      maxHp: hp,
      focus: 0,
      maxFocus: 0,
      stats: { ...def.stats },
      armor: def.armor,
      power: 0,
      abilities: [...def.abilities],
      conditions: [],
      down: false,
      cooldowns: {},
      items: {},
      controller: caller.controller ?? caller.id,
      summon: { by: caller.id },
    };
    state.units.push(unit);
    ctx.events.push({ t: "summoned", id: unit.id, by: caller.id });
    const enc = state.encounter;
    if (enc && enc.order.includes(caller.id)) {
      enc.order.splice(enc.order.indexOf(caller.id) + 1 + called.length, 0, unit.id);
      enc.init[unit.id] = enc.init[caller.id];
      if (enc.acting.includes(caller.id)) {
        enc.acting.push(unit.id);
        enc.budgets[unit.id] = { action: true, bonus: true, move: def.move, moveMax: def.move, disengaged: false };
      }
    }
    called.push(unit);
  });
  for (const unit of called) if (!enterSurface(ctx, unit) && !unit.down) enterWeather(ctx, unit);
  return called;
}
