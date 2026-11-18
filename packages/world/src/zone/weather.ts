// Weather: an area a spell leaves over some hexes for a few rounds of a
// fight, acting on whoever is in it. Soothing Rain heals the caster's side
// and keeps its hexes under water; Trade Winds speed the caster's side and
// slow the other; a Coral Field cuts and slows the other side, and lets the
// caster's walk through untouched. What is laid on the ground (surfaces.ts) is the ground's
// business; weather hangs over it, and puts water down where it rains.
//
// It acts on a unit as the weather is made, as the unit's turn starts in it,
// and as the unit steps (or is pushed) into it on its own turn. Rain heals a
// unit, and coral cuts one, at most once a turn, however often it goes in and out.

import { hexDistance, hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { addCondition, damage, heal, type Ctx } from "./engine";
import { flies, inFight } from "./geometry";
import { WEATHER } from "./kit";
import { rollDice } from "./rules";
import { placeSurface } from "./surfaces";
import type { Unit, Weather, WeatherKind, ZoneState } from "./types";

/** Each weather as the player sees it. */
export const WEATHER_INFO: Record<WeatherKind, { name: string; blurb: string; color: string }> = {
  rain: { name: "Soothing Rain", blurb: "Lays water, and heals the caster's side as each starts a turn in it or first walks in on a turn.", color: "#8fd3ff" },
  wind: { name: "Trade Winds", blurb: "The caster's side is Hasted in it, the other side Slowed.", color: "#d9f2e6" },
  coral: { name: "Coral Field", blurb: "Harmless to the caster's side. The other side is cut and Slowed, once a turn, as each starts a turn in it or walks into it.", color: "#ff7f6e" },
};

/**
 * `n` hexes in a clump: the one aimed at, the one beside it nearest `from`, and then, nearest `from` first, those
 * beside the one aimed at that touch one already taken. Fewer at the edge of the map.
 */
export function clusterHexes(state: Pick<ZoneState, "map">, from: HexPos, at: HexPos, n: number): HexPos[] {
  const near = hexNeighbors(at, state.map.grid).sort((a, b) => hexDistance(a, from) - hexDistance(b, from) || a.q - b.q || a.r - b.r);
  const out = [at];
  const taken: HexPos[] = [];
  while (out.length < n) {
    const next = near.find((p) => !taken.includes(p) && (taken.length === 0 || taken.some((t) => hexDistance(t, p) === 1)));
    if (!next) break;
    taken.push(next);
    out.push(next);
  }
  return out;
}

/** The three hexes a rain cloud covers: the one aimed at and the two beside it nearest the caster. */
export const rainHexes = (state: Pick<ZoneState, "map">, from: HexPos, at: HexPos): HexPos[] => clusterHexes(state, from, at, 3);

const inside = (w: Weather, pos: HexPos) => w.hexes.some((p) => p.q === pos.q && p.r === pos.r);

/** Whether it is this unit's own turn just now. */
function ownTurn(state: ZoneState, unit: Unit): boolean {
  const enc = state.encounter;
  return !!enc && enc.acting.includes(unit.id) && !enc.done.includes(unit.id);
}

/** Put water down under the rain wherever there is none. */
function wetGround(ctx: Ctx, w: Weather): void {
  const dry = w.hexes.filter((p) => ctx.state.surfaces[posKey(p)]?.kind !== "water");
  if (dry.length > 0) placeSurface(ctx, dry, "water", WEATHER.rain.water, w.by);
}

/** What a weather does to one unit in it. `turn`: the turn it counts against, for rain's once-a-turn heal and coral's once-a-turn cut. */
function weatherOn(ctx: Ctx, w: Weather, unit: Unit, turn: number): void {
  if (unit.down) return;
  const friend = unit.side === w.side;
  if (w.kind === "rain") {
    if (!friend || w.touched[unit.id] === turn) return;
    w.touched[unit.id] = turn;
    if (unit.hp < unit.maxHp) heal(ctx, unit, rollDice(ctx.rng, WEATHER.rain.heal), { actor: w.by, what: "soothing_rain" });
    return;
  }
  if (w.kind === "coral") {
    // It grows on the ground: what flies is over it.
    if (friend || flies(unit) || w.touched[unit.id] === turn) return;
    w.touched[unit.id] = turn;
    damage(ctx, unit, rollDice(ctx.rng, WEATHER.coral.damage), { actor: w.by, what: "coral_field" });
    addCondition(ctx, unit, "slowed", 1);
    return;
  }
  // The winds last as long as the turn they are felt in: out of them, a unit is back to its own pace.
  const kind = friend ? "hasted" : "slowed";
  const had = unit.conditions.some((c) => c.kind === kind);
  addCondition(ctx, unit, kind, 1);
  const c = unit.conditions.find((x) => x.kind === kind);
  if (!had && c) delete c.fresh;
}

/** The turn a unit's rain heal counts against: its turn in a fight, or once for good out of one. */
const turnOf = (state: ZoneState, unit: Unit) => (state.encounter && inFight(state, unit.id) ? state.encounter.turnNo : -1);

/** Make a weather over some hexes, and have it act on everyone already under it. */
export function makeWeather(ctx: Ctx, kind: WeatherKind, hexes: HexPos[], by: Unit): void {
  const state = ctx.state;
  const w: Weather = { kind, hexes, rounds: WEATHER[kind].rounds, fresh: true, by: by.id, side: by.side, touched: {} };
  state.weather = [...(state.weather ?? []), w];
  ctx.events.push({ t: "weather", kind, hexes, by: by.id });
  if (kind === "rain") wetGround(ctx, w);
  for (const unit of state.units) if (inside(w, unit.pos)) weatherOn(ctx, w, unit, turnOf(state, unit));
}

/** A unit's turn starts: the rain comes down again, and whatever weather it stands in acts on it. */
export function weatherAtTurn(ctx: Ctx, unit: Unit): void {
  for (const w of ctx.state.weather ?? []) {
    if (w.kind === "rain") wetGround(ctx, w);
    if (inside(w, unit.pos)) weatherOn(ctx, w, unit, turnOf(ctx.state, unit));
  }
}

/** A unit has come onto a hex: weather there acts on it, if it is the unit's own turn (or no fight is on). */
export function enterWeather(ctx: Ctx, unit: Unit): void {
  if (unit.down) return;
  const fighting = !!ctx.state.encounter && inFight(ctx.state, unit.id);
  if (fighting && !ownTurn(ctx.state, unit)) return;
  for (const w of ctx.state.weather ?? []) {
    if (!inside(w, unit.pos)) continue;
    // The winds do nothing out of a fight: there is no pace to change. Nor does coral: it is for a fight.
    if ((w.kind === "wind" || w.kind === "coral") && !fighting) continue;
    weatherOn(ctx, w, unit, turnOf(ctx.state, unit));
  }
}

/** A round has passed: every weather has one less to go (bar one made this round), and the spent ones clear. */
export function tickWeather(ctx: Ctx): void {
  const list = ctx.state.weather;
  if (!list || list.length === 0) return;
  for (const w of list) {
    if (w.fresh) delete w.fresh;
    else w.rounds -= 1;
  }
  const gone = list.filter((w) => w.rounds <= 0);
  ctx.state.weather = list.filter((w) => w.rounds > 0);
  for (const w of gone) ctx.events.push({ t: "weather", kind: null, hexes: w.hexes, by: w.by });
}
