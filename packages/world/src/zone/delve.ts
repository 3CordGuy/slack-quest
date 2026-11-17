// A delve into the Haunted Caverns, as a zone: the caverns' own layout
// (caverns.ts: chambers scattered through the rock, joined by tunnels, a
// hoard in the deepest) made into a map a party walks and fights on.
//
// - The bands that lurk in chambers, and the hoard's guardians, become enemy
//   groups, sized for the party as every zone's are. A group keeps its
//   chamber's id ("band2", "lair"), so a chest knows who guards it.
// - Chests, strongboxes and the hoard stay on the map as caches to open
//   (zone.ts openChest). The mouth is the way in, and the way out.
// - No locked doors yet: each doorway stands open, and the room behind it
//   keeps its strongbox.

import { hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { CAVERN_LEADS, ENEMIES, cavernBand, type CavernLead } from "../content";
import { generateCaverns } from "../caverns";
import { BASE_HEIGHT, type Poi } from "../map";
import { makeRng, seedFromString } from "../rng";
import { threatExtras } from "./kit";
import type { ZoneOptions } from "./types";
import type { ZonePlan } from "./gen";

/** A delve's rock: roomier than the old caverns', so fights have space in the chambers and tunnels to retreat down. */
export const DELVE_GRID: HexGrid = { cols: 18, rows: 16 };

/** Who lurks in a chamber, for a party this size: the band's lead brings the rest (cavernBand); a troll keeps its chamber to itself. */
function bandFor(lurkers: string[], party: number): string[] {
  const lead = lurkers[0];
  if (lead === "troll") return ["troll"];
  return CAVERN_LEADS.includes(lead as CavernLead) ? cavernBand(lead as CavernLead, party) : [...lurkers];
}

/** The hoard's guardians: the haunt itself, and (for a party) what came down with it. */
function guardsFor(guards: string[], party: number): string[] {
  return party >= 2 ? [...guards] : guards.filter((k) => ENEMIES[k]?.boss);
}

export function generateDelve(seed: string, options: ZoneOptions): ZonePlan {
  const map = generateCaverns(seed, DELVE_GRID);
  const rng = makeRng(seedFromString(`delve|${seed}`));
  // Every doorway stands open (no locked doors yet).
  for (const t of map.tiles) {
    if (t.biome !== "gate") continue;
    t.biome = "cave";
    t.h = BASE_HEIGHT.cave;
  }
  const mouth = map.pois.find((p) => p.kind === "landing")!.pos;
  const open = (p: HexPos) => map.tiles.some((t) => t.q === p.q && t.r === p.r && t.biome === "cave");
  const caches = map.pois.filter((p) => p.kind === "cache");
  const taken = new Set([posKey(mouth), ...caches.map((c) => posKey(c.pos))]);

  const groups: ZonePlan["groups"] = [];
  for (const camp of map.pois.filter((p) => p.kind === "camp" || p.kind === "lair")) {
    const kinds = camp.kind === "lair" ? guardsFor(camp.enemies, options.party) : bandFor(camp.enemies, options.party);
    // A more dangerous cave puts more in each band (not round the haunt, nor with a troll that lives alone).
    if (camp.kind === "camp" && kinds[0] !== "troll") for (let n = 0; n < threatExtras(options.threat); n++) kinds.push(kinds[kinds.length - 1]);
    // They stand in their chamber: on its middle and the open floor nearest it.
    const posts = map.tiles
      .filter((t) => t.biome === "cave" && hexDistance(t, camp.pos) <= 3 && !taken.has(posKey(t)))
      .map((t) => ({ q: t.q, r: t.r }))
      .sort((a, b) => hexDistance(a, camp.pos) - hexDistance(b, camp.pos) || rng.next() - 0.5)
      .slice(0, kinds.length);
    for (const p of posts) taken.add(posKey(p));
    if (posts.length > 0) groups.push({ id: camp.id, kinds: kinds.slice(0, posts.length), posts });
  }

  // The map keeps the mouth and what can be opened; the bands are units now, and the scattered finds go.
  const kept: Poi[] = map.pois.filter((p) => p.kind === "landing" || (p.kind === "cache" && open(p.pos)));
  return { map: { ...map, pois: kept }, start: mouth, groups };
}
