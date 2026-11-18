// The Sage's stars. Guiding Light is a condition on an enemy: whoever
// attacks it has advantage (engine.ts attackContext). Falling Star,
// Constellation and North Star leave it; New Moon puts every one of them
// out at once, for a heavy blow each. North Star is a condition on an ally:
// the blows they land set fires (engine.ts damage). A course charted is a
// condition on the Sage that holds the hex marked: the Sage's side moves
// further on steps that bring them nearer it (Budget.course, spent in
// combat.ts walk, and reckoned in geometry.ts zoneReach).
//
// Only queries here: what changes a unit is in engine.ts and combat.ts.

import { hexDistance, hexSegment, posKey, type HexPos } from "@gantt-quest/core";
import { sameHex, sees } from "./geometry";
import { CONSTELLATION } from "./kit";
import type { Unit, ZoneState } from "./types";

/** The enemies of `unit` lit with Guiding Light, still standing: what New Moon strikes. */
export const litFoes = (state: Pick<ZoneState, "units">, unit: Unit): Unit[] =>
  state.units.filter((u) => u.side !== unit.side && !u.down && u.conditions.some((c) => c.kind === "guiding_light"));

/**
 * Constellation's links, in the order they are drawn: from the Sage to the nearest ally of theirs within reach and in
 * clear sight, from that ally to the nearest not yet linked, and so on until none is left in reach of the last.
 */
export function constellationLinks(state: Pick<ZoneState, "units" | "map">, unit: Unit): { from: Unit; to: Unit }[] {
  const out: { from: Unit; to: Unit }[] = [];
  const linked = new Set([unit.id]);
  let last = unit;
  for (;;) {
    const next = state.units
      .filter((u) => u.side === unit.side && !u.down && !linked.has(u.id) && hexDistance(u.pos, last.pos) <= CONSTELLATION.link && sees(state.map, last.pos, u.pos))
      .sort((a, b) => hexDistance(a.pos, last.pos) - hexDistance(b.pos, last.pos) || a.id.localeCompare(b.id))[0];
    if (!next) return out;
    out.push({ from: last, to: next });
    linked.add(next.id);
    last = next;
  }
}

/** The hexes Constellation's links cross, each once, bar those the linked stand on. */
export function constellationHexes(state: Pick<ZoneState, "units" | "map">, unit: Unit): HexPos[] {
  const links = constellationLinks(state, unit);
  const ends = new Set([unit, ...links.map((l) => l.to)].map((u) => posKey(u.pos)));
  const seen = new Set<string>();
  const out: HexPos[] = [];
  for (const { from, to } of links) {
    for (const p of hexSegment(from.pos, to.pos)) {
      const key = posKey(p);
      if (ends.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** The hex a unit has charted a course to, if it has one charted. */
export const chartOf = (unit: Pick<Unit, "conditions">): HexPos | undefined => unit.conditions.find((c) => c.kind === "charted")?.at;

/** The marks `unit` moves faster toward: those charted by anyone of its side still standing, itself included. */
export function courseMarks(state: Pick<ZoneState, "units">, unit: Unit): HexPos[] {
  const out: HexPos[] = [];
  for (const u of state.units) {
    const at = u.side === unit.side && !u.down ? chartOf(u) : undefined;
    if (at && !out.some((p) => sameHex(p, at))) out.push(at);
  }
  return out;
}
