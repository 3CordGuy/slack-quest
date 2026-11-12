// What a player's client is allowed to see. The full WorldState holds the
// hidden lair, NPC secrets and the RNG state; none of that leaves the server.
// Nor does anything under fog: the ground the party has not seen, the places
// on it, and the bands roaming out of sight.

import { demandMet } from "./story";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import { BASE_HEIGHT, tileAt } from "./map";
import { VISION, type WorldState } from "./world";

export interface PublicStory {
  title: string;
  premise: string;
  islandName: string;
  villainName: string;
  relicName: string;
  poiNames: Record<string, string>;
  npcs: { id: string; name: string; role: string; poi: string }[];
  objectives: { id: string; text: string; done: boolean }[];
  /** Story steps performed at a place. `ready` once everything it needs is done. */
  rites: { id: string; poi: string; label: string; ready: boolean; done: boolean }[];
  /** What the NPC has asked of the party; null until they have met. */
  demand: { npcName: string; text: string; done: boolean } | null;
}

export type ClientState = Omit<WorldState, "rng" | "seed" | "bible" | "seen" | "forest" | "roamerSeq"> & {
  story: PublicStory | null;
  /** The viewing player's hero id. */
  you: string;
};

export function clientView(state: WorldState, playerId: string): ClientState {
  const { rng: _rng, seed: _seed, bible, seen: _seen, forest: _forest, roamerSeq: _seq, ...rest } = state;
  // Fog: ground the party has not seen is sent as a blank, and the places and bands on it are not sent at all.
  const seen = state.seen ? new Set(state.seen) : null;
  const key = (p: HexPos) => `${p.q},${p.r}`;
  const inFog = (p: HexPos) => !!seen && !seen.has(key(p));
  const visible = state.map.pois.filter((p) => !p.hidden && !inFog(p.pos));
  const tiles = seen ? state.map.tiles.map((t) => (seen.has(key(t)) ? t : { q: t.q, r: t.r, biome: "fog" as const, h: BASE_HEIGHT.fog })) : state.map.tiles;
  // A band shows only while some hero can actually see it, not merely because its hex was once seen.
  const roamers = (state.roamers ?? []).filter((r) => state.heroes.some((h) => hexDistance(h.pos, r.pos) <= VISION + (tileAt(state.map, h.pos)?.biome === "hills" ? 1 : 0)));
  const visibleIds = new Set(visible.map((p) => p.id));
  const story: PublicStory | null = bible && {
    title: bible.title,
    premise: bible.premise,
    islandName: bible.islandName,
    villainName: bible.villain.name,
    relicName: bible.relicName,
    poiNames: Object.fromEntries(Object.entries(bible.poiNames).filter(([id]) => visibleIds.has(id))),
    npcs: bible.npcs.map((n) => ({ id: n.id, name: n.name, role: n.role, poi: n.poi })),
    objectives: bible.objectives.map((o) => ({ id: o.id, text: o.text, done: !!state.facts[o.fact] })),
    rites: bible.rites
      .filter((r) => visibleIds.has(r.poi))
      .map((r) => ({ id: r.id, poi: r.poi, label: r.label, ready: r.requires.every((f) => state.facts[f]), done: !!state.facts[r.sets] })),
    demand: bible.demand.text && state.facts[`met:${bible.npcs[0].id}`]
      ? { npcName: bible.npcs[0].name, text: bible.demand.text, done: demandMet(bible, state.facts, !!state.npcs[bible.npcs[0].id]?.persuaded) }
      : null,
  };
  return { ...rest, roamers, map: { ...state.map, tiles, pois: visible }, story, you: playerId };
}
