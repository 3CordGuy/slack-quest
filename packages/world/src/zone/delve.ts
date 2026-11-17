// A delve into the Haunted Caverns, as a zone: the caverns' own layout
// (caverns.ts: chambers scattered through the rock, joined by tunnels, a
// hoard in the deepest) made into a map a party walks and fights on.
//
// - The bands that lurk in chambers, and the hoard's guardians, become enemy
//   groups, sized for the party as every zone's are. A group keeps its
//   chamber's id ("band2", "lair"), so a chest knows who guards it.
// - Chests, strongboxes and the hoard stay on the map as caches to open
//   (zone.ts openChest). The mouth is the way in, and the way out. A chest
//   stands in the way, so one the caverns put in the only way through (where
//   a tunnel leaves its chamber) is set aside, to the nearest spot round its
//   chamber where it shuts nothing off.
// - A dead-end room or two is shut behind a locked door, with a strongbox
//   inside, and the key to each lies on the near side, in a chest or carried
//   by a band (zone/doors.ts says how doors are opened). A door counts as a
//   way through when chests and crates are set out, so nothing ever blocks
//   the way up to one.
// - Glowing mushrooms grow in a few nooks against the rock: they light the
//   dark round them and can be picked for mushrooms (forage.ts).
// - Crates are stacked against the rock here and there, in the chambers and
//   in the nooks off the tunnels, to be broken open (crates.ts). None is put
//   where it would shut off any of the floor, or crowd a chest or the mouth.

import { hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { CAVERN_LEADS, ENEMIES, cavernBand, type CavernLead } from "../content";
import { generateCaverns } from "../caverns";
import type { Poi, WorldMap } from "../map";
import { makeRng, seedFromString, type Rng } from "../rng";
import { CRATE_HP } from "./crates";
import { threatExtras } from "./kit";
import type { ZoneOptions } from "./types";
import type { ZonePlan } from "./gen";

/** A delve's rock: roomier than the old caverns', so fights have space in the chambers and tunnels to retreat down. */
export const DELVE_GRID: HexGrid = { cols: 18, rows: 16 };

/** Open floor, or a locked door: either is a way through, the door once it is opened. */
const passable = (t: { biome: string }): boolean => t.biome === "cave" || t.biome === "gate";

/** The floor that can be walked to from `from`, round whatever stands on the hexes in `blocked`. */
function walkable(map: WorldMap, floor: ReadonlySet<string>, from: HexPos, blocked: ReadonlySet<string>): Set<string> {
  const seen = new Set([posKey(from)]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const n of hexNeighbors(queue[i], map.grid)) {
      const key = posKey(n);
      if (seen.has(key) || !floor.has(key) || blocked.has(key)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen;
}

/**
 * Move any chest that stands in the only way through to somewhere in its chamber where it does not: the nearest
 * open floor within two hexes of where it was (snug against the rock if there is a choice), off the mouth and
 * clear of the other chests, where every hex that could be walked to can still be walked to.
 */
function clearTheWay(map: WorldMap, mouth: HexPos, chests: readonly Poi[]): void {
  // A locked door is a way through (it can be opened), so the room behind it counts, and so does the way up to it.
  const floor = new Set(map.tiles.filter(passable).map(posKey));
  const all = walkable(map, floor, mouth, new Set());
  const blocked = new Set<string>();
  const shuts = (at: HexPos): boolean => {
    const round = new Set([...blocked, posKey(at)]);
    const reach = walkable(map, floor, mouth, round);
    return [...all].some((k) => !round.has(k) && !reach.has(k));
  };
  const rockBeside = (p: HexPos) => 6 - hexNeighbors(p, map.grid).filter((n) => floor.has(posKey(n))).length;
  for (const chest of chests) {
    if (shuts(chest.pos)) {
      const aside = map.tiles
        .filter((t) => t.biome === "cave" && all.has(posKey(t)) && !blocked.has(posKey(t)) && hexDistance(t, chest.pos) <= 2 && hexDistance(t, mouth) > 1)
        .sort((a, b) => hexDistance(a, chest.pos) - hexDistance(b, chest.pos) || rockBeside(b) - rockBeside(a) || a.q - b.q || a.r - b.r)
        .find((t) => !shuts(t));
      if (aside) chest.pos = { q: aside.q, r: aside.r };
    }
    blocked.add(posKey(chest.pos));
  }
}

/** How many places in a delve have crates, fewest to most; and the chance a place has two side by side. */
export const DELVE_CRATES: [number, number] = [4, 6];
export const CRATE_PAIR = 0.45;

/**
 * Crates to stack about the floor. Each goes on open floor against the rock, nowhere anyone stands, not beside a
 * chest and not within two of the mouth (so both can always be got to), and only where every hex that could be
 * walked to before can still be walked to. Places are kept apart; a place may have a second crate beside it.
 */
function placeCrates(rng: Rng, map: WorldMap, mouth: HexPos, taken: ReadonlySet<string>, chests: readonly HexPos[]): Poi[] {
  const { grid } = map;
  // As for chests: a locked door is a way through, never a place to stack anything.
  const floor = new Set(map.tiles.filter(passable).map(posKey));
  const blocked = new Set(chests.map(posKey));
  const doors = new Set(map.tiles.filter((t) => t.biome === "gate").map(posKey));
  const before = walkable(map, floor, mouth, blocked);
  const crates: Poi[] = [];
  const rockBeside = (p: HexPos) => 6 - hexNeighbors(p, grid).filter((n) => floor.has(posKey(n))).length;
  const fits = (p: HexPos): boolean => {
    const key = posKey(p);
    if (!before.has(key) || doors.has(key) || blocked.has(key) || taken.has(key) || hexDistance(p, mouth) <= 2 || chests.some((c) => hexDistance(c, p) <= 1)) return false;
    // Nothing that was in reach is cut off by it, and every crate already down can still be walked up to.
    const after = walkable(map, floor, mouth, new Set([...blocked, key]));
    if (![...before].every((k) => k === key || blocked.has(k) || after.has(k))) return false;
    return crates.every((c) => hexNeighbors(c.pos, grid).some((n) => after.has(posKey(n))));
  };
  // Against the rock first: snug in a corner or a nook, then along a wall.
  const spots = map.tiles
    .filter((t) => floor.has(posKey(t)) && rockBeside(t) >= 1)
    .map((t) => ({ pos: { q: t.q, r: t.r }, snug: rockBeside(t) + rng.next() * 2.5 }))
    .sort((a, b) => b.snug - a.snug);
  const want = rng.int(DELVE_CRATES[0], DELVE_CRATES[1]);
  const places: HexPos[] = [];
  const put = (pos: HexPos) => {
    blocked.add(posKey(pos));
    crates.push({ id: `crate${crates.length + 1}`, kind: "crate", pos, hidden: false, cleared: false, usedBy: [], enemies: [], hp: CRATE_HP, maxHp: CRATE_HP });
  };
  // Places three apart, against at least two sides of rock; and in a small or crowded delve, where that leaves too
  // few, again with places two apart along any wall.
  for (const [apart, snug] of [[3, 2], [2, 1]] as const) {
    for (const { pos } of spots) {
      if (places.length >= want) break;
      if (rockBeside(pos) < snug || places.some((p) => hexDistance(p, pos) < apart) || !fits(pos)) continue;
      places.push(pos);
      put(pos);
      if (!rng.chance(CRATE_PAIR)) continue;
      const buddy = hexNeighbors(pos, grid).filter((n) => floor.has(posKey(n)) && rockBeside(n) >= 2 && fits(n));
      if (buddy.length > 0) put(rng.pick(buddy));
    }
  }
  return crates;
}

/** How many clusters of glowing mushrooms grow in a delve, fewest to most. */
export const DELVE_GLOWCAPS: [number, number] = [2, 4];

/**
 * Glowing mushrooms, growing in nooks against the rock: on open floor with rock on at least two sides, well apart,
 * away from the mouth, and on no hex anything else stands on. They are in nobody's way.
 */
function placeGlowcaps(rng: Rng, map: WorldMap, mouth: HexPos, taken: ReadonlySet<string>): Poi[] {
  const floor = new Set(map.tiles.filter((t) => t.biome === "cave").map(posKey));
  const rockBeside = (p: HexPos) => 6 - hexNeighbors(p, map.grid).filter((n) => floor.has(posKey(n)) || map.tiles.some((t) => t.q === n.q && t.r === n.r && t.biome === "gate")).length;
  const spots = map.tiles
    .filter((t) => floor.has(posKey(t)) && !taken.has(posKey(t)) && hexDistance(t, mouth) > 2 && rockBeside(t) >= 2)
    .map((t) => ({ pos: { q: t.q, r: t.r }, order: rng.next() }))
    .sort((a, b) => a.order - b.order);
  const want = rng.int(DELVE_GLOWCAPS[0], DELVE_GLOWCAPS[1]);
  const out: Poi[] = [];
  for (const { pos } of spots) {
    if (out.length >= want) break;
    if (out.some((g) => hexDistance(g.pos, pos) < 4)) continue;
    out.push({ id: `glowcap${out.length + 1}`, kind: "glowcap", pos, hidden: false, cleared: false, usedBy: [], enemies: [] });
  }
  return out;
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
  const mouth = map.pois.find((p) => p.kind === "landing")!.pos;
  const open = (p: HexPos) => map.tiles.some((t) => t.q === p.q && t.r === p.r && t.biome === "cave");
  const keys: string[] = [];
  const caches = map.pois.filter((p) => p.kind === "cache");
  clearTheWay(map, mouth, caches.filter((c) => open(c.pos)));
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
    if (posts.length > 0) {
      groups.push({ id: camp.id, kinds: kinds.slice(0, posts.length), posts });
      if (camp.key) keys.push(camp.id);
    }
  }

  // The map keeps the mouth, what can be opened and the locked doors; the bands are units now, and the scattered finds go.
  const kept: Poi[] = map.pois.filter((p) => p.kind === "landing" || p.kind === "gate" || (p.kind === "cache" && open(p.pos)));
  const crates = placeCrates(rng, map, mouth, taken, kept.filter((p) => p.kind === "cache").map((p) => p.pos));
  const glowcaps = placeGlowcaps(rng, map, mouth, new Set([...taken, ...[...kept, ...crates].map((p) => posKey(p.pos))]));
  return { map: { ...map, pois: [...kept, ...crates, ...glowcaps] }, start: mouth, groups, ...(keys.length > 0 ? { keys } : {}) };
}
