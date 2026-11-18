// Time out of a fight, the way Divinity keeps it: everyone walks freely and
// at once, but time still passes. Every EXPLORE_ROUND_MS of real time is a
// round, as a turn is in a fight: burning and bleeding tick, the ground acts
// on whoever stands in it, conditions run down a round, and the ground's
// surfaces wear a round. Torches, held or lying on the ground, burn on a far
// kinder clock out there (TORCH_ROUND_MS), so a torch lasts for a good long
// look round.
//
// Nothing runs on a timer. The room tells the reducer the time with each
// action (a `time` action first), and whatever time has gone by since is
// counted then, a few rounds at most: a map left alone for an hour has long
// since burnt out, and saying so round by round would tell nobody anything.
// In a fight, rounds are the fight's own, and the clock only keeps up.

import { DRUID_REGEN, EFFECT_TICK, ENEMIES } from "../content";
import { burnOf, has, heal, regrow, removeCondition, tick, type Ctx } from "./engine";
import { EXPLORE_ROUND_MS, TORCH_ROUND_MS } from "./kit";
import { tickWeather } from "./weather";
import { standInSurface, tickLights, tickSurfaces } from "./surfaces";
import type { Unit } from "./types";

/** The most rounds counted at once, out of a fight; anything longer has run its course all the same. */
export const MAX_CATCHUP_ROUNDS = 10;
/** The most torch rounds counted at once: no torch burns longer than this. */
const MAX_TORCH_CATCHUP = 12;

/**
 * A round out of a fight, for one unit: what the start and end of a turn do in a fight. Counted by the clock while
 * no fight is on, and by the fight's own rounds, for everyone not in it, while one is (zone.ts, advance).
 */
export function exploreRound(ctx: Ctx, unit: Unit): void {
  if (unit.down) return;
  removeCondition(unit, "guarded");
  removeCondition(unit, "taunting");
  removeCondition(unit, "stunned");
  for (const kind of ["bleeding", "burning"] as const) if (has(unit, kind)) tick(ctx, unit, kind, kind === "burning" ? burnOf(unit) : (EFFECT_TICK[kind] ?? 0));
  if (unit.down) return;
  if (unit.kind === "backend_druid" && unit.hp < unit.maxHp) heal(ctx, unit, DRUID_REGEN, { actor: unit.id, what: "regen" });
  regrow(ctx, unit);
  const grows = unit.side === "enemy" ? ENEMIES[unit.kind]?.regen : undefined;
  if (grows && unit.hp < unit.maxHp && !has(unit, grows.unless)) heal(ctx, unit, grows.amount, { actor: unit.id, what: grows.name });
  standInSurface(ctx, unit);
  for (const c of unit.conditions) {
    if (c.fresh) c.fresh = false;
    else c.rounds -= 1;
  }
  unit.conditions = unit.conditions.filter((c) => c.rounds > 0);
}

/** The room says it is now `now`: count the rounds that have gone by out of a fight. */
export function passTime(ctx: Ctx, now: number): void {
  const { state } = ctx;
  // First told the time, or a fight is on (its own rounds keep time): the clock just keeps up.
  if (!state.clock || state.encounter) {
    state.clock = { at: now, torchAt: now };
    return;
  }
  const rounds = Math.floor((now - state.clock.at) / EXPLORE_ROUND_MS);
  if (rounds > 0) {
    state.clock.at += rounds * EXPLORE_ROUND_MS;
    for (let n = 0; n < Math.min(rounds, MAX_CATCHUP_ROUNDS); n++) {
      for (const unit of state.units) exploreRound(ctx, unit);
      tickSurfaces(ctx);
      tickWeather(ctx);
    }
  }
  const burns = Math.floor((now - state.clock.torchAt) / TORCH_ROUND_MS);
  if (burns > 0) {
    state.clock.torchAt += burns * TORCH_ROUND_MS;
    for (let n = 0; n < Math.min(burns, MAX_TORCH_CATCHUP); n++) tickLights(ctx);
  }
}
