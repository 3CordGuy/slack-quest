// Light and the dark. Underground (a caves zone) nothing is lit but what
// a torch or a fire lights: a lit torch held in a hero's off hand, one
// thrown down and still burning, and the ground on fire. A hero can only
// make out an enemy that stands in the light or right beside one of the
// party; one in the dark cannot be picked out to strike or shoot at, and a
// blow at one that is beside you but unlit is struck blind (disadvantage).
// The things of the caves see in the dark: the enemy is never hampered.
//
// Everywhere else it is light enough to see: all of this is a no-op.

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { adjacent, inFight, sees } from "./geometry";
import { FIRE_GLOW, LIGHT_RADIUS } from "./kit";
import type { Unit, ZoneState } from "./types";

/** Whether this zone is dark but where it is lit. */
export const isDark = (state: Pick<ZoneState, "options">): boolean => state.options.biome === "caves";

/** What gives light, and how far it reaches. */
export function lightSources(state: ZoneState): { at: HexPos; radius: number }[] {
  const out: { at: HexPos; radius: number }[] = [];
  for (const u of state.units) if ((u.torch ?? 0) > 0) out.push({ at: u.pos, radius: LIGHT_RADIUS });
  for (const key of Object.keys(state.lights ?? {})) {
    const [q, r] = key.split(",").map(Number);
    out.push({ at: { q, r }, radius: LIGHT_RADIUS });
  }
  for (const [key, s] of Object.entries(state.surfaces)) {
    if (s.kind !== "fire") continue;
    const [q, r] = key.split(",").map(Number);
    out.push({ at: { q, r }, radius: FIRE_GLOW });
  }
  return out;
}

/** Every lit hex, by key. Null where it is not dark at all. Light does not go round rock. */
export function litHexes(state: ZoneState): Set<string> | null {
  if (!isDark(state)) return null;
  const lit = new Set<string>();
  const sources = lightSources(state);
  if (sources.length === 0) return lit;
  for (const t of state.map.tiles) {
    for (const s of sources) {
      const d = hexDistance(s.at, t);
      if (d <= s.radius && (d <= 1 || sees(state.map, s.at, t))) {
        lit.add(posKey(t));
        break;
      }
    }
  }
  return lit;
}

/** Whether a hex lies in the dark. */
export const inDark = (state: ZoneState, pos: HexPos, lit: Set<string> | null = litHexes(state)): boolean => !!lit && !lit.has(posKey(pos));

/** Whether the party can make this unit out: it stands in the light, or right beside a hero. */
export function seenByHeroes(state: ZoneState, unit: Unit, lit: Set<string> | null = litHexes(state)): boolean {
  if (!lit || lit.has(posKey(unit.pos))) return true;
  return state.units.some((h) => h.side === "hero" && !h.down && adjacent(h.pos, unit.pos));
}

/** The enemies the dark hides from the party right now. */
export function hiddenEnemies(state: ZoneState): string[] {
  const lit = litHexes(state);
  if (!lit) return [];
  return state.units.filter((u) => u.side === "enemy" && !u.down && !seenByHeroes(state, u, lit)).map((u) => u.id);
}

/** Hidden enemies that are not in a fight are not sent to the client at all. */
export const sentToClient = (state: ZoneState, hidden: ReadonlySet<string>) => (u: Unit): boolean => !hidden.has(u.id) || inFight(state, u.id);
