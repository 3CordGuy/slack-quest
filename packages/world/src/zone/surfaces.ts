// The ground. A hex holds at most one surface; it acts on whoever walks
// onto it or starts a turn standing on it, friend and foe alike, and it
// lasts a set number of rounds of a fight. Laying one surface on another
// combines them: fire runs through oil and sets off poison, water puts
// fire out, cold turns water to ice.

import { hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { tileAt } from "../map";
import { addCondition, saveRoll, tick, type Ctx } from "./engine";
import { flies, solid } from "./geometry";
import type { GroundSurface, SurfaceKind, Unit } from "./types";

export const SURFACE_INFO: Record<SurfaceKind, { name: string; blurb: string; color: string }> = {
  poison: { name: "Poison", blurb: "Hurts and Poisons whoever enters it or starts a turn in it. Fire sets it off.", color: "#84cc16" },
  fire: { name: "Fire", blurb: "Burns whoever enters it or starts a turn in it. Water puts it out.", color: "#f97316" },
  oil: { name: "Oil", blurb: "Slick: costs one more to cross. A spark turns every hex of it to fire.", color: "#57534e" },
  water: { name: "Water", blurb: "Leaves whoever crosses it Wet. Cold freezes it.", color: "#38bdf8" },
  ice: { name: "Ice", blurb: "Save or fall Prone and stop. Fire melts it.", color: "#bae6fd" },
};

/** Surfaces a creature would rather not walk through. The enemy looks for a way round these. */
export const HARMFUL: ReadonlySet<SurfaceKind> = new Set(["poison", "fire"]);

/** What a fire burning through oil or poison lasts. */
const SPREAD_FIRE_ROUNDS = 2;
const ICE_SAVE = 12;

const d = (ctx: Ctx, sides: number) => ctx.rng.int(1, sides);

/**
 * What a surface does to a unit standing on it. `moving` is true as it walks on, false when its turn
 * starts there. Returns true if it must stop where it is (it slipped on ice).
 */
function act(ctx: Ctx, unit: Unit, kind: SurfaceKind, moving: boolean): boolean {
  if (unit.down || flies(unit)) return false;
  if (kind === "poison") {
    tick(ctx, unit, "poison", d(ctx, 4));
    addCondition(ctx, unit, "poisoned", 2);
  } else if (kind === "fire") {
    tick(ctx, unit, "fire", d(ctx, 6));
    addCondition(ctx, unit, "burning", 2);
  } else if (kind === "water") {
    addCondition(ctx, unit, "wet", 2);
  } else if (kind === "ice" && moving) {
    if (!saveRoll(ctx, unit, "agi", ICE_SAVE, "Keep your feet").ok) {
      addCondition(ctx, unit, "prone", 1);
      return true;
    }
  }
  return false;
}

/** A unit has just stepped onto a hex: whatever is on it acts. Returns true if the unit must stop there. */
export function enterSurface(ctx: Ctx, unit: Unit, flush?: () => void): boolean {
  const surface = ctx.state.surfaces[posKey(unit.pos)];
  if (!surface) return false;
  flush?.();
  return act(ctx, unit, surface.kind, true);
}

/** A unit's turn starts: whatever it is standing in acts again. */
export function standInSurface(ctx: Ctx, unit: Unit): void {
  const surface = ctx.state.surfaces[posKey(unit.pos)];
  if (surface) act(ctx, unit, surface.kind, false);
}

/** Every hex of the same kind joined to `from`, itself included. */
function joined(surfaces: Record<string, GroundSurface>, grid: Ctx["state"]["map"]["grid"], from: HexPos, kind: SurfaceKind): HexPos[] {
  const seen = new Set([posKey(from)]);
  const out = [from];
  for (let i = 0; i < out.length; i++) {
    for (const n of hexNeighbors(out[i], grid)) {
      const key = posKey(n);
      if (seen.has(key) || surfaces[key]?.kind !== kind) continue;
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

/**
 * Lay a surface on some hexes, combining it with what is there:
 *
 * - fire on oil or poison: every joined hex of it goes up (poison bursts, hurting whoever stands in it);
 *   fire on water: both are gone; fire on ice: water.
 * - water on fire: both are gone. Poison on fire: it bursts, and the fire stays. Oil on fire feeds it.
 * - ice on water: ice; ice on fire: water.
 *
 * Whoever is standing on a hex that changed is acted on by what it now holds.
 */
export function placeSurface(ctx: Ctx, hexes: HexPos[], kind: SurfaceKind, rounds: number, by: string | null): void {
  const { surfaces, map } = ctx.state;
  /** What each touched hex ends up holding. */
  const changed = new Map<string, { pos: HexPos; kind: SurfaceKind | null }>();
  const burst = new Map<string, HexPos>();
  const set = (pos: HexPos, to: SurfaceKind | null, life = rounds) => {
    const key = posKey(pos);
    if (to) surfaces[key] = { kind: to, rounds: life, by };
    else delete surfaces[key];
    changed.set(key, { pos, kind: to });
  };
  for (const pos of hexes) {
    if (solid(tileAt(map, pos))) continue;
    const there = surfaces[posKey(pos)]?.kind;
    if (kind === "fire") {
      if (there === "oil" || there === "poison") {
        for (const p of joined(surfaces, map.grid, pos, there)) {
          if (there === "poison") burst.set(posKey(p), p);
          set(p, "fire", Math.max(rounds, SPREAD_FIRE_ROUNDS));
        }
      } else if (there === "water") set(pos, null);
      else if (there === "ice") set(pos, "water", 2);
      else set(pos, "fire");
    } else if (kind === "water") {
      if (there === "fire") set(pos, null);
      else if (there !== "ice") set(pos, "water");
    } else if (kind === "poison") {
      if (there === "fire") burst.set(posKey(pos), pos);
      else if (there !== "water") set(pos, "poison");
    } else if (kind === "oil") {
      if (there === "fire") set(pos, "fire", Math.max(rounds, surfaces[posKey(pos)]!.rounds + 1));
      else set(pos, "oil");
    } else if (kind === "ice") {
      if (there === "fire") set(pos, "water", 2);
      else set(pos, "ice");
    }
  }
  // Told one kind at a time, so the client can draw and sound each change once.
  for (const to of [null, "poison", "fire", "oil", "water", "ice"] as const) {
    const group = [...changed.values()].filter((c) => c.kind === to).map((c) => c.pos);
    if (group.length > 0) ctx.events.push({ t: "surface", kind: to, hexes: group });
  }
  if (burst.size > 0) ctx.events.push({ t: "burst", hexes: [...burst.values()] });
  for (const unit of ctx.state.units) {
    const key = posKey(unit.pos);
    if (burst.has(key) && !unit.down && !flies(unit)) tick(ctx, unit, "fire", d(ctx, 6));
    const now = changed.get(key);
    if (now?.kind) act(ctx, unit, now.kind, false);
  }
}

/** Take surfaces off some hexes. */
export function clearSurfaces(ctx: Ctx, hexes: HexPos[]): void {
  const gone = hexes.filter((p) => ctx.state.surfaces[posKey(p)]);
  for (const p of gone) delete ctx.state.surfaces[posKey(p)];
  if (gone.length > 0) ctx.events.push({ t: "surface", kind: null, hexes: gone });
}

/** A flame touches a hex: oil or poison on it catches. */
export function ignite(ctx: Ctx, pos: HexPos, by: string | null): void {
  const there = ctx.state.surfaces[posKey(pos)]?.kind;
  if (there === "oil" || there === "poison") placeSurface(ctx, [pos], "fire", SPREAD_FIRE_ROUNDS, by);
}

/** Cold touches a hex: water on it freezes. */
export function chill(ctx: Ctx, pos: HexPos, by: string | null): void {
  if (ctx.state.surfaces[posKey(pos)]?.kind === "water") placeSurface(ctx, [pos], "ice", 3, by);
}

/** A round of the fight has passed: every surface has one less to go, and the spent ones are gone. */
export function tickSurfaces(ctx: Ctx): void {
  const gone: HexPos[] = [];
  for (const [key, surface] of Object.entries(ctx.state.surfaces)) {
    surface.rounds -= 1;
    if (surface.rounds > 0) continue;
    delete ctx.state.surfaces[key];
    const [q, r] = key.split(",").map(Number);
    gone.push({ q, r });
  }
  if (gone.length > 0) ctx.events.push({ t: "surface", kind: null, hexes: gone });
}
