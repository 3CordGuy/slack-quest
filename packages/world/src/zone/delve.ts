// A delve into the Haunted Caverns, as a zone: the caverns' own layout
// (caverns.ts: chambers scattered through the rock, joined by tunnels, a
// hoard in the deepest) made into a map a party walks and fights on.
//
// - The bands that lurk in chambers, and the hoard's guardians, become enemy
//   groups, sized for the party as every zone's are. A group keeps its
//   chamber's id ("band2", "lair"), so a chest knows who guards it.
// - Chests, strongboxes and the hoard stay on the map as caches to open
//   (zone.ts openChest). The mouth is the way in, and the way out.
// - Crates are stacked against the rock here and there, in the chambers and
//   in the nooks off the tunnels, to be broken open (crates.ts). None is put
//   where it would shut off any of the floor, or crowd a chest or the mouth.
// - No locked doors yet: each doorway stands open, and the room behind it
//   keeps its strongbox.

import { hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { CAVERN_LEADS, ENEMIES, cavernBand, type CavernLead } from "../content";
import { generateCaverns } from "../caverns";
import { BASE_HEIGHT, type Poi, type WorldMap } from "../map";
import { makeRng, seedFromString, type Rng } from "../rng";
import { CRATE_HP } from "./crates";
import { threatExtras } from "./kit";
import type { ZoneOptions } from "./types";
import type { ZonePlan } from "./gen";

/** A delve's rock: roomier than the old caverns', so fights have space in the chambers and tunnels to retreat down. */
export const DELVE_GRID: HexGrid = { cols: 18, rows: 16 };

/** How many places in a delve have crates, fewest to most; and the chance a place has two side by side. */
export const DELVE_CRATES: [number, number] = [4, 6];
export const CRATE_PAIR = 0.45;

/**
 * Crates to stack about the floor. Each goes on open floor against the rock, nowhere anyone stands, two or more
 * hexes from any chest and the mouth (so they can always be got to), and only where every hex that could be walked
 * to before can still be walked to. Places are kept three hexes apart; a place may have a second crate beside it.
 */
function placeCrates(rng: Rng, map: WorldMap, mouth: HexPos, taken: ReadonlySet<string>, chests: readonly HexPos[]): Poi[] {
  const { grid } = map;
  const floor = new Set(map.tiles.filter((t) => t.biome === "cave").map(posKey));
  const blocked = new Set(chests.map(posKey));
  /** The floor that can be walked to from the mouth, round whatever is `blocked` (and `also`, if given). */
  const walkable = (also?: string): Set<string> => {
    const seen = new Set([posKey(mouth)]);
    const queue = [mouth];
    for (let i = 0; i < queue.length; i++) {
      for (const n of hexNeighbors(queue[i], grid)) {
        const key = posKey(n);
        if (seen.has(key) || !floor.has(key) || blocked.has(key) || key === also) continue;
        seen.add(key);
        queue.push(n);
      }
    }
    return seen;
  };
  const before = walkable();
  const rockBeside = (p: HexPos) => 6 - hexNeighbors(p, grid).filter((n) => floor.has(posKey(n))).length;
  const fits = (p: HexPos): boolean => {
    const key = posKey(p);
    if (!before.has(key) || blocked.has(key) || taken.has(key) || hexDistance(p, mouth) <= 2 || chests.some((c) => hexDistance(c, p) <= 2)) return false;
    // Nothing that was in reach is cut off by it.
    const after = walkable(key);
    return [...before].every((k) => k === key || blocked.has(k) || after.has(k));
  };
  // Against the rock first: snug in a corner or a nook, then along a wall.
  const spots = map.tiles
    .filter((t) => floor.has(posKey(t)) && rockBeside(t) >= 2)
    .map((t) => ({ pos: { q: t.q, r: t.r }, snug: rockBeside(t) + rng.next() * 2.5 }))
    .sort((a, b) => b.snug - a.snug);
  const want = rng.int(DELVE_CRATES[0], DELVE_CRATES[1]);
  const places: HexPos[] = [];
  const crates: Poi[] = [];
  const put = (pos: HexPos) => {
    blocked.add(posKey(pos));
    crates.push({ id: `crate${crates.length + 1}`, kind: "crate", pos, hidden: false, cleared: false, usedBy: [], enemies: [], hp: CRATE_HP, maxHp: CRATE_HP });
  };
  for (const { pos } of spots) {
    if (places.length >= want) break;
    if (places.some((p) => hexDistance(p, pos) < 3) || !fits(pos)) continue;
    places.push(pos);
    put(pos);
    if (!rng.chance(CRATE_PAIR)) continue;
    const buddy = hexNeighbors(pos, grid).filter((n) => floor.has(posKey(n)) && rockBeside(n) >= 2 && fits(n));
    if (buddy.length > 0) put(rng.pick(buddy));
  }
  return crates;
}

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
  const crates = placeCrates(rng, map, mouth, taken, kept.filter((p) => p.kind === "cache").map((p) => p.pos));
  return { map: { ...map, pois: [...kept, ...crates] }, start: mouth, groups };
}
