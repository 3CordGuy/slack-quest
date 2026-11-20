// Shared by the zone tests: a flat board, units to stand on it, and stepping it. Each test file keeps a `board`
// and a `hero` of its own over these, because each wants different defaults.

import { STARTING_STATS, allHexesInGrid, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Biome, Tile } from "../map";
import { DEFAULT_ZONE_OPTIONS } from "../zone/gen";
import type { Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "../zone/types";
import { standInHero, stepZone } from "../zone/zone";

export const GRID: HexGrid = { cols: 16, rows: 12 };
/** Offset coordinates (column, row) to a hex, so tests can talk about a flat board. */
export const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });

/**
 * A flat, open board of plains with nothing on it. `rng` and `start` are the state's own; `options` go over the
 * zone's defaults; `flags` are the tests' switches; `edit` changes tiles; `gone` are hexes with no ground at all.
 */
export function flatBoard(o: {
  rng: number;
  start: HexPos;
  options?: Partial<ZoneState["options"]>;
  flags?: Pick<ZoneState, "aiOff" | "shareTurns">;
  edit?: (tile: Tile) => void;
  gone?: HexPos[];
}): ZoneState {
  const gone = o.gone ?? [];
  const tiles: Tile[] = allHexesInGrid(GRID).filter((p) => !gone.some((g) => g.q === p.q && g.r === p.r)).map((p) => ({ q: p.q, r: p.r, biome: "plains" as Biome, h: 0.3, elev: 0 }));
  if (o.edit) tiles.forEach(o.edit);
  return { v: 1, code: "TEST", seed: "test", rng: o.rng, options: { ...DEFAULT_ZONE_OPTIONS, ...o.options }, map: { grid: GRID, tiles, pois: [] }, start: o.start, units: [], groups: {}, surfaces: {}, encounter: null, seq: 100, ...o.flags };
}

/** Stand a hero on the board, unhurt: a player's own, or (`controller`) a stand-in that player plays. */
export function standHero(state: ZoneState, id: string, pos: HexPos, o: { classId: string; level: number; armor: number; power: number; abilities: string[]; items: Unit["items"]; controller?: string }): Unit {
  const sheet = standInHero(o.classId, id, o.level)!;
  const unit: Unit = {
    id, side: "hero", name: id, kind: o.classId, level: o.level, pos, hp: sheet.maxHp, maxHp: sheet.maxHp, focus: 2, maxFocus: 2,
    stats: STARTING_STATS[o.classId], armor: o.armor, power: o.power, abilities: o.abilities, conditions: [], down: false, cooldowns: {}, items: o.items,
    ...(o.controller ? { controller: o.controller } : {}),
  };
  state.units.push(unit);
  return unit;
}

/** Stand an enemy on the board, in a band (made, and not yet alerted, if it is new). `over`: whatever about it is not its kind's own. */
export function standEnemy(state: ZoneState, kind: string, pos: HexPos, group = "g1", over: Partial<Unit> = {}): Unit {
  state.groups[group] ??= { alerted: false };
  const unit: Unit = { id: `e${++state.seq}`, side: "enemy", name: ENEMIES[kind].name, kind, level: 1, pos, hp: ENEMIES[kind].hp, maxHp: ENEMIES[kind].hp, focus: 0, maxFocus: 0, armor: 0, power: 0, abilities: [], conditions: [], down: false, cooldowns: {}, items: {}, group, home: pos, ...over };
  state.units.push(unit);
  return unit;
}

/** Apply an action that must succeed; what happened is added to `sink`, and what was earned to `paid`. */
export function must(state: ZoneState, action: ZoneAction, sink: ZoneEvent[] = [], paid: ZoneEffect[] = []): ZoneState {
  const step = stepZone(state, action);
  if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
  sink.push(...step.events);
  paid.push(...step.effects);
  return step.state;
}
/** Apply an action that must be refused, and say why it was. */
export const fails = (state: ZoneState, action: ZoneAction): string => {
  const step = stepZone(state, action);
  if (step.ok) throw new Error(`${action.type} should have failed`);
  return step.error;
};
export const unit = (state: ZoneState, id: string) => state.units.find((u) => u.id === id)!;
export const has = (state: ZoneState, id: string, kind: string) => unit(state, id).conditions.some((c) => c.kind === kind);
