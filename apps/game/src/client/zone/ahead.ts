// What a zone shows before the server has answered.
//
// The server decides everything that happens on a map (server/zone-room.ts),
// and its answer takes a round trip to arrive. Waiting for it with nothing on
// screen is what makes a click feel slow, so the client shows at once the
// part of an action it can already know, from the same rules the server will
// use (packages/world/src/zone):
//
// - A walk: the way there is the way the server will find (zoneReach and
//   pathIn), so the hero sets off at the click. Only as far as can be
//   foreseen: the walk shown stops short of a step that would draw a blow,
//   and at the first hex where the ground or an enemy's notice may stop it.
// - Anything with dice (a blow, a shove, a flask): nothing of the result is
//   shown. What it costs is: the Action or Bonus action is taken off the bar.
// - Disengage and ending the turn: what they do to the turn is known.
//
// Each action sent carries a number, and the server's answer to it carries
// the number back (an update, or an error). Until then the action is "ahead":
// kept in a list, in the order sent. `believe` lays the list over the
// server's state for the bar and the lit tiles to read. `settle` takes an
// answer and says what of the list stood: a walk the server made shorter, or
// differently, or refused, is cut back to what really happened, and every
// later walk shown for that hero (it set off from the wrong place) is called
// off and left for the server's own account of it.
//
// Nothing here can make the server do anything: a prediction only changes
// what is drawn while the answer is on its way.

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ALERT_RANGE, FLEE_RANGE, FREE_WALK, JOIN_RANGE, courseFor, hasCondition, leavesReach, moveLeft, pathIn, payMove, sameHex, sees, zoneReach, type Budget, type Unit, type ZoneEvent, type ZoneState, type ZoneView } from "@gantt-quest/world";

/** A walk shown before the server has made it. */
export interface WalkAhead {
  n: number;
  kind: "walk";
  unit: string;
  /** Where the hero stood when it was shown. */
  from: HexPos;
  /** The hexes shown walked, in order. */
  path: HexPos[];
  /** The movement it costs, in a fight. */
  cost: number;
  /** When it was shown (performance.now()), so the picture knows how much of it has already played. */
  at: number;
  /** An earlier walk of this hero's did not go as shown, so this one set off from the wrong place: it is no longer believed. */
  off?: boolean;
}

/** Something done whose result is the server's to say: only what it costs, and what is known of it, is shown. */
export interface ActAhead {
  n: number;
  kind: "act";
  unit: string;
  /** The AP it takes from the turn, in a fight. */
  cost: number | null;
  /** Disengage changes the turn in a way that is known at once. */
  gain?: "disengage";
  /** The bar slot it was done from, shown taken until the answer comes. */
  slot?: string;
  /** Its name was put up over the hero at the click, so it is not put up again when the answer says it was used. */
  named?: boolean;
}

/** The turn ended. */
export interface EndAhead {
  n: number;
  kind: "end";
  unit: string;
}

export type Ahead = WalkAhead | ActAhead | EndAhead;

const asState = (view: ZoneView) => view as unknown as ZoneState;

/** What `unit` has left this turn: null out of a fight, undefined if it is in one and it is not its turn. */
function budgetOf(view: ZoneView, unit: Unit): Budget | null | undefined {
  const enc = view.encounter;
  if (!enc || !enc.order.includes(unit.id)) return null;
  if (!enc.acting.includes(unit.id) || enc.done.includes(unit.id)) return undefined;
  return enc.budgets[unit.id];
}

/**
 * Whether a hero who has just stepped onto `pos` may be stopped there by something the client can see: the
 * ground (a surface acts on whoever enters it), a band that has not noticed anyone and now can, or a fight
 * near enough to be drawn into. The server stops the walk for the same reasons (zone.ts onStep, surfaces.ts).
 */
function mayStopAt(view: ZoneView, unit: Unit, pos: HexPos): boolean {
  if (view.surfaces[posKey(pos)]) return true;
  const enc = view.encounter;
  for (const other of view.units) {
    if (other.side !== "enemy" || other.down) continue;
    const quiet = !!other.group && !view.groups[other.group]?.alerted;
    if (quiet && hexDistance(other.pos, pos) <= ALERT_RANGE && sees(view.map, other.pos, pos)) return true;
  }
  if (enc && !enc.order.includes(unit.id)) {
    const fled = !!enc.fled?.includes(unit.id);
    for (const other of view.units) {
      if (!enc.order.includes(other.id) || other.down) continue;
      if (fled ? other.side !== unit.side && hexDistance(other.pos, pos) <= FLEE_RANGE : hexDistance(other.pos, pos) <= JOIN_RANGE) return true;
    }
  }
  return false;
}

/** Whether stepping from `from` to `next` leaves the reach of an enemy that could strike as the hero goes (combat.ts provoke). */
function drawsBlow(view: ZoneView, unit: Unit, from: HexPos, next: HexPos, budget: Budget | null): boolean {
  const enc = view.encounter;
  if (!enc || !enc.order.includes(unit.id) || budget?.disengaged) return false;
  return view.units.some(
    (foe) =>
      foe.side !== unit.side && !foe.down && enc.order.includes(foe.id) && leavesReach(view, foe.pos, from, next) &&
      !enc.reacted.includes(foe.id) && !hasCondition(foe, "stunned") && !hasCondition(foe, "prone"),
  );
}

/**
 * The walk a click on `to` would make, as far as the client can foresee it: the hexes, and the movement they
 * cost. Null if the server would refuse it (not yours, not your turn, out of reach, someone standing there) or
 * if nothing of it can be shown yet (the very first step would draw a blow). The way is found exactly as the
 * server finds it, so what is returned is always the start of the walk the server makes, unless the map holds
 * something this client has not been told of (an enemy the dark hides, a crewmate who moved a moment ago).
 */
export function foreseeWalk(view: ZoneView, unitId: string, to: HexPos): { path: HexPos[]; cost: number } | null {
  const unit = view.units.find((u) => u.id === unitId);
  if (!unit || unit.side !== "hero" || unit.down || (unit.id !== view.you && unit.controller !== view.you)) return null;
  const budget = budgetOf(view, unit);
  if (budget === undefined || sameHex(to, unit.pos)) return null;
  const reach = zoneReach(asState(view), unit, budget ? moveLeft(budget) : FREE_WALK, undefined, courseFor(asState(view), unit, budget));
  const end = reach.get(posKey(to));
  if (!end || !end.stop) return null;
  const path: HexPos[] = [];
  let at = unit.pos;
  for (const next of pathIn(reach, to) ?? []) {
    if (drawsBlow(view, unit, at, next, budget)) break;
    path.push(next);
    at = next;
    if (mayStopAt(view, unit, next)) break;
  }
  if (path.length === 0) return null;
  return { path, cost: reach.get(posKey(at))?.cost ?? 0 };
}

/**
 * The server's state with everything still ahead laid over it: heroes stand where their walks were shown
 * ending, with the movement (and the AP it bought) those cost gone; AP spent are spent; a turn ended is ended.
 * The same object comes back when nothing is ahead.
 */
export function believe(view: ZoneView, ahead: readonly Ahead[]): ZoneView {
  const live = ahead.filter((a) => !(a.kind === "walk" && a.off));
  if (live.length === 0) return view;
  const units = view.units.map((u) => (live.some((a) => a.unit === u.id) ? { ...u } : u));
  const enc = view.encounter ? { ...view.encounter, budgets: { ...view.encounter.budgets }, done: [...view.encounter.done] } : null;
  for (const a of live) {
    const unit = units.find((u) => u.id === a.unit);
    if (!unit) continue;
    const mine = enc && enc.order.includes(a.unit) && enc.acting.includes(a.unit) && !enc.done.includes(a.unit) ? enc.budgets[a.unit] : undefined;
    const budget = mine ? (enc!.budgets[a.unit] = { ...mine }) : undefined;
    if (a.kind === "walk") {
      unit.pos = a.path[a.path.length - 1];
      if (budget) payMove(budget, a.cost);
    } else if (a.kind === "act") {
      if (budget && a.cost) budget.ap = Math.max(0, budget.ap - a.cost);
      if (budget && a.gain === "disengage") budget.disengaged = true;
    } else if (enc && enc.acting.includes(a.unit) && !enc.done.includes(a.unit)) {
      enc.done.push(a.unit);
    }
  }
  return { ...view, units, encounter: enc };
}

/** Where each hero with a walk still believed is shown standing: the end of the last one. */
export function standing(ahead: readonly Ahead[]): Map<string, HexPos> {
  const out = new Map<string, HexPos>();
  for (const a of ahead) if (a.kind === "walk" && !a.off) out.set(a.unit, a.path[a.path.length - 1]);
  return out;
}

/** What became of a walk that was shown ahead, once the server answered it. */
export interface WalkSettled {
  unit: string;
  /** How many of the hexes shown the server really walked, from the start. */
  kept: number;
  /** Set when the walk shown went further than, or differently from, the real one: the hex to cut the picture's walk back to. */
  back: HexPos | null;
  /** For each `moved` event of this walk in the answer, by its index: how many of its first hexes are already on screen. */
  shown: Map<number, number>;
  /** When the walk was first shown. */
  at: number;
}

export interface Settled {
  /** What is still ahead. */
  ahead: Ahead[];
  /** The entry this answer was for, if it was still being waited on. */
  entry: Ahead | null;
  /** How a walk shown ahead stood up, if the answer was for one that was still believed. */
  walk: WalkSettled | null;
  /** Heroes whose shown walks no longer stand at all, each with the hex they really stand on as far as is known: put them back. */
  recall: { unit: string; to: HexPos }[];
}

/**
 * The server has answered action `n`: with an update (`ok`, and the events it carried) or by refusing it.
 * Answers come in the order the actions were sent, so anything sent before `n` and never answered is given up
 * as lost, and whatever it showed is taken back.
 */
export function settle(ahead: readonly Ahead[], n: number, ok: boolean, events: readonly ZoneEvent[]): Settled {
  const entry = ahead.find((a) => a.n === n) ?? null;
  const lost = ahead.filter((a) => a.n < n);
  let rest = ahead.filter((a) => a.n > n);
  const recall: Settled["recall"] = [];
  /** A walk of `unit`'s did not go as shown: every later one of theirs set off from the wrong place. */
  const callOff = (unit: string) => {
    rest = rest.map((a) => (a.kind === "walk" && a.unit === unit && !a.off ? { ...a, off: true } : a));
  };
  // A walk whose answer never came: back to where it set off (the first lost one of each hero's is the furthest back).
  for (const a of lost) {
    if (a.kind !== "walk" || a.off || recall.some((r) => r.unit === a.unit)) continue;
    recall.push({ unit: a.unit, to: a.from });
    callOff(a.unit);
  }
  let walk: WalkSettled | null = null;
  if (entry?.kind === "walk" && !entry.off && !recall.some((r) => r.unit === entry.unit)) {
    const shown = new Map<number, number>();
    let kept = 0;
    let same = ok;
    events.forEach((ev, i) => {
      if (ev.t !== "moved" || ev.id !== entry.unit) return;
      let here = 0;
      for (const step of ev.path) {
        if (!same || kept >= entry.path.length || !sameHex(step, entry.path[kept])) {
          same = false;
          break;
        }
        kept += 1;
        here += 1;
      }
      if (here > 0) shown.set(i, here);
    });
    const back = kept < entry.path.length ? (kept > 0 ? entry.path[kept - 1] : entry.from) : null;
    if (back) callOff(entry.unit);
    walk = { unit: entry.unit, kept, back, shown, at: entry.at };
  }
  return { ahead: rest, entry, walk, recall };
}

/** Nothing ahead is believed any longer (the connection dropped, or an answer never came): where to put each hero shown walking. */
export function giveUp(ahead: readonly Ahead[]): { unit: string; to: HexPos }[] {
  const out: { unit: string; to: HexPos }[] = [];
  for (const a of ahead) if (a.kind === "walk" && !a.off && !out.some((r) => r.unit === a.unit)) out.push({ unit: a.unit, to: a.from });
  return out;
}
