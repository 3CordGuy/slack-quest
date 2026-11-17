// The ground. A hex holds at most one surface; it acts on whoever walks
// onto it or starts a turn standing on it, friend and foe alike, and it
// lasts a set number of rounds of a fight. Laying one surface on another
// combines them: fire runs through oil and sets off poison, water puts
// fire out, cold turns water to ice, fire burns slime off and water washes
// it away. Fire burns a crate standing in it, too: when it takes hold under
// it, and again every round it is still burning, in a fight or out of one.

import { hexDistance, hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { tileAt } from "../map";
import { cratesOn, hurtCrate } from "./crates";
import { addCondition, saveRoll, tick, type Ctx } from "./engine";
import { flies, solid } from "./geometry";
import type { GroundSurface, SurfaceKind, Unit } from "./types";
import { TORCH_HELD_ROUNDS } from "./kit";

export const SURFACE_INFO: Record<SurfaceKind, { name: string; blurb: string; color: string }> = {
  poison: { name: "Poison", blurb: "Hurts and Poisons whoever enters it or starts a turn in it. Fire sets it off.", color: "#84cc16" },
  fire: { name: "Fire", blurb: "Burns whoever enters it or starts a turn in it. Water puts it out.", color: "#f97316" },
  oil: { name: "Oil", blurb: "Slick: costs one more to cross. A spark turns every hex of it to fire.", color: "#57534e" },
  water: { name: "Water", blurb: "Leaves whoever crosses it Wet. Cold freezes it.", color: "#38bdf8" },
  ice: { name: "Ice", blurb: "Save or fall Prone and stop. Fire melts it.", color: "#bae6fd" },
  slime: { name: "Slime", blurb: "Sticky: costs one more to cross, and Slows whoever walks into it. Fire burns it off; water washes it away.", color: "#c9f5b8" },
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
  } else if (kind === "slime" && moving) {
    addCondition(ctx, unit, "slowed", 1);
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

const fromKey = (key: string): HexPos => {
  const [q, r] = key.split(",").map(Number);
  return { q, r };
};

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
      // Slime burns off: the hex burns for a moment and is clean after.
      else if (there === "slime") set(pos, "fire", 1);
      else set(pos, "fire");
    } else if (kind === "water") {
      douse(ctx, [pos]);
      if (there === "fire" || there === "slime") set(pos, null);
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
    } else if (kind === "slime") {
      // Slime smothers a fire and sticks over anything else.
      if (there === "fire") set(pos, null);
      else set(pos, "slime");
    }
  }
  // Told one kind at a time, so the client can draw and sound each change once.
  for (const to of [null, "poison", "fire", "oil", "water", "ice", "slime"] as const) {
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
  const burning = [...changed.values()].filter((c) => c.kind === "fire").map((c) => c.pos);
  for (const crate of cratesOn(ctx.state, [...burning, ...burst.values()])) hurtCrate(ctx, crate, d(ctx, 6), { actor: by, what: "fire" });
}

/** Take surfaces off some hexes. */
export function clearSurfaces(ctx: Ctx, hexes: HexPos[]): void {
  const gone = hexes.filter((p) => ctx.state.surfaces[posKey(p)]);
  for (const p of gone) delete ctx.state.surfaces[posKey(p)];
  if (gone.length > 0) ctx.events.push({ t: "surface", kind: null, hexes: gone });
}

/** A flame touches a hex: oil or poison on it catches, and slime burns off. */
export function ignite(ctx: Ctx, pos: HexPos, by: string | null): void {
  const there = ctx.state.surfaces[posKey(pos)]?.kind;
  if (there === "oil" || there === "poison" || there === "slime") placeSurface(ctx, [pos], "fire", SPREAD_FIRE_ROUNDS, by);
}

/**
 * A lit torch lands on a hex: it lies there burning for `rounds`, lighting the dark, and sets alight what
 * will catch. Into water or onto ice it goes out at once.
 */
export function dropTorch(ctx: Ctx, at: HexPos, rounds: number, by: string | null): void {
  const key = posKey(at);
  const there = ctx.state.surfaces[key]?.kind;
  if (there === "water" || there === "ice") return;
  ignite(ctx, at, by);
  ctx.state.lights = { ...(ctx.state.lights ?? {}), [key]: { rounds, by } };
  ctx.events.push({ t: "light", at, on: true });
}

/** Put out a torch lying on these hexes (water thrown on it). */
function douse(ctx: Ctx, hexes: HexPos[]): void {
  for (const p of hexes) {
    const key = posKey(p);
    if (!ctx.state.lights?.[key]) continue;
    delete ctx.state.lights[key];
    ctx.events.push({ t: "light", at: p, on: false });
  }
}

/** A round of the fight has passed: every torch, held or lying, burns a round down, and the spent ones go out. */
export function tickLights(ctx: Ctx): void {
  for (const u of ctx.state.units) {
    if (!u.torch) continue;
    u.torch -= 1;
    if (u.torch <= 0) {
      letGoTorch(u);
      ctx.events.push({ t: "torch_out", id: u.id });
    }
  }
  for (const [key, light] of Object.entries(ctx.state.lights ?? {})) {
    light.rounds -= 1;
    if (light.rounds > 0) continue;
    delete ctx.state.lights![key];
    const [q, r] = key.split(",").map(Number);
    ctx.events.push({ t: "light", at: { q, r }, on: false });
  }
}

/** Why `unit` cannot pick up a torch lying at `at`, or null if it can. */
export function checkPickup(state: Ctx["state"], unit: Unit, at: HexPos): string | null {
  if (!state.lights?.[posKey(at)]) return "There is no torch burning there.";
  if (unit.side !== "hero") return "Only a hero can take it.";
  if (unit.down) return "Not while you are down.";
  if (hexDistance(unit.pos, at) > 1) return "Go up to it first.";
  return null;
}

/**
 * Pick up a torch burning on the ground: into the hand still lit, with what it has left to burn, or, with a
 * torch already in hand, put out and stowed in the pack (as good as new: it is only rag and a stick).
 */
export function pickUpTorch(ctx: Ctx, unit: Unit, at: HexPos): void {
  const key = posKey(at);
  const light = ctx.state.lights![key];
  delete ctx.state.lights![key];
  ctx.events.push({ t: "light", at, on: false });
  const stowed = (unit.torch ?? 0) > 0;
  if (stowed) unit.items.torch = (unit.items.torch ?? 0) + 1;
  else unit.torch = light.rounds;
  ctx.events.push({ t: "took_torch", id: unit.id, at, stowed });
}

/** Light a torch to hold, from the pack. In the main hand the weapon is put away and the torch is swung instead. */
export function lightTorch(ctx: Ctx, unit: Unit, hand?: "main"): void {
  unit.items.torch = (unit.items.torch ?? 0) - 1;
  unit.torch = TORCH_HELD_ROUNDS;
  if (hand === "main") {
    unit.torchHand = "main";
    unit.stowed = unit.abilities;
    unit.abilities = ["torch_swing"];
  }
  ctx.events.push({ t: "lit", id: unit.id });
}

/** The torch in a hand is gone (burnt out, or thrown): a weapon put away for it is taken up again. */
export function letGoTorch(unit: Unit): void {
  delete unit.torch;
  if (unit.torchHand === "main") unit.abilities = unit.stowed ?? unit.abilities;
  delete unit.torchHand;
  delete unit.stowed;
}

/** Cold touches a hex: water on it freezes. */
export function chill(ctx: Ctx, pos: HexPos, by: string | null): void {
  if (ctx.state.surfaces[posKey(pos)]?.kind === "water") placeSurface(ctx, [pos], "ice", 3, by);
}

/** A round of the fight has passed: every surface has one less to go, and the spent ones are gone. */
export function tickSurfaces(ctx: Ctx): void {
  // A crate standing in a fire burns on.
  for (const crate of cratesOn(ctx.state, Object.keys(ctx.state.surfaces).filter((k) => ctx.state.surfaces[k].kind === "fire").map(fromKey))) {
    hurtCrate(ctx, crate, d(ctx, 6), { actor: ctx.state.surfaces[posKey(crate.pos)].by, what: "fire" });
  }
  const gone: HexPos[] = [];
  for (const [key, surface] of Object.entries(ctx.state.surfaces)) {
    // What a map's modifier put there stays.
    if (surface.lasting) continue;
    surface.rounds -= 1;
    if (surface.rounds > 0) continue;
    delete ctx.state.surfaces[key];
    const [q, r] = key.split(",").map(Number);
    gone.push({ q, r });
  }
  if (gone.length > 0) ctx.events.push({ t: "surface", kind: null, hexes: gone });
}
