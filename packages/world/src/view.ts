// What a player's client is allowed to see. The full WorldState holds the
// hidden lair, NPC secrets and the RNG state; none of that leaves the server.

import { demandMet } from "./story";
import type { WorldState } from "./world";

export interface PublicStory {
  title: string;
  premise: string;
  islandName: string;
  villainName: string;
  relicName: string;
  poiNames: Record<string, string>;
  npcs: { id: string; name: string; role: string; poi: string }[];
  objectives: { id: string; text: string; done: boolean }[];
  /** What the NPC has asked of the party; null until they have met. */
  demand: { npcName: string; text: string; done: boolean } | null;
}

export type ClientState = Omit<WorldState, "rng" | "seed" | "bible"> & {
  story: PublicStory | null;
  /** The viewing player's hero id. */
  you: string;
};

export function clientView(state: WorldState, playerId: string): ClientState {
  const { rng: _rng, seed: _seed, bible, ...rest } = state;
  const visible = state.map.pois.filter((p) => !p.hidden);
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
    demand: bible.demand.text && state.facts[`met:${bible.npcs[0].id}`]
      ? { npcName: bible.npcs[0].name, text: bible.demand.text, done: demandMet(bible, state.facts, !!state.npcs[bible.npcs[0].id]?.persuaded) }
      : null,
  };
  return { ...rest, map: { ...state.map, pois: visible }, story, you: playerId };
}
