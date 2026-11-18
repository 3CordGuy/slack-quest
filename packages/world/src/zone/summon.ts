// Creatures a hero calls into a fight (Summon Sea Turtle). One is a unit on
// the hero's side, played by the hero's player on the hero's initiative: it
// stands right after them in the order, so it shares their turn. It is gone
// when it falls, when its caller calls another, or when the fight is over;
// it never walks the map out of a fight.

import type { HexPos } from "@gantt-quest/core";
import type { Ctx } from "./engine";
import { SEA_TURTLE } from "./kit";
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
 * A sea turtle on `at`, for `caller`: the one they called before is sent away first. It goes into the order just
 * after its caller, on their initiative, and if their turn is underway it has one too, starting now.
 */
export function summonTurtle(ctx: Ctx, caller: Unit, at: HexPos): Unit {
  const { state } = ctx;
  for (const old of summonsOf(state, caller.id)) dismiss(ctx, old);
  const hp = SEA_TURTLE.hp(caller.level);
  const turtle: Unit = {
    id: `t${++state.seq}`,
    side: caller.side,
    name: SEA_TURTLE.name,
    kind: "sea_turtle",
    level: caller.level,
    pos: { q: at.q, r: at.r },
    hp,
    maxHp: hp,
    focus: 0,
    maxFocus: 0,
    stats: { ...SEA_TURTLE.stats },
    armor: SEA_TURTLE.armor,
    power: 0,
    abilities: [...SEA_TURTLE.abilities],
    conditions: [],
    down: false,
    cooldowns: {},
    items: {},
    controller: caller.controller ?? caller.id,
    summon: { by: caller.id },
  };
  state.units.push(turtle);
  ctx.events.push({ t: "summoned", id: turtle.id, by: caller.id });
  const enc = state.encounter;
  if (enc && enc.order.includes(caller.id)) {
    enc.order.splice(enc.order.indexOf(caller.id) + 1, 0, turtle.id);
    enc.init[turtle.id] = enc.init[caller.id];
    if (enc.acting.includes(caller.id)) {
      enc.acting.push(turtle.id);
      enc.budgets[turtle.id] = { action: true, bonus: true, move: SEA_TURTLE.move, moveMax: SEA_TURTLE.move, disengaged: false };
    }
  }
  if (!enterSurface(ctx, turtle) && !turtle.down) enterWeather(ctx, turtle);
  return turtle;
}
