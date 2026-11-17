// Making a zone's map from a seed and a handful of options: its size, what
// grows there, how craggy and how cluttered it is, how many enemy groups
// stand on it, and how much open ground the party gets to walk before the
// first fight. The same seed and options always make the same map. One day
// the atlas hands these out; for now the dev toolbox does.

import { allHexesInGrid, hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES, bandKinds, cavernBand, type CavernLead, type RoamerLead } from "../content";
import { BASE_HEIGHT, type Biome, type Tile, type WorldMap } from "../map";
import { makeRng, seedFromString } from "../rng";
import { hexesBetween, solid } from "./geometry";
import { threatExtras } from "./kit";
import { cleanMods } from "./mods";
import type { ZoneBiome, ZoneOptions, ZoneSize } from "./types";

export const ZONE_GRIDS: Record<ZoneSize, HexGrid> = {
  small: { cols: 16, rows: 14 },
  medium: { cols: 22, rows: 18 },
  large: { cols: 30, rows: 24 },
};

/**
 * How near a hero has to come, in plain sight, for an enemy group to turn on them: right up to one of
 * them. A fight is something you start, by running up to an enemy or by hitting one from afar; walking
 * past at a distance starts nothing.
 */
export const ALERT_RANGE = 1;
/** How near a fight a hero has to be to be drawn into it. */
export const JOIN_RANGE = 6;

export const DEFAULT_ZONE_OPTIONS: ZoneOptions = { size: "medium", biome: "meadow", groups: 2, kinds: [], elevation: 1, obstacles: 1, clear: 4, party: 2, level: 1, threat: 2 };

/** What tends to lead a group in each kind of place. */
export const BIOME_LEADS: Record<ZoneBiome, string[]> = {
  meadow: ["wolf", "bandit", "bear"],
  woods: ["wolf", "bear", "bandit"],
  caves: ["shade", "skeleton", "bat", "slime"],
  shore: ["bandit", "brute", "cultist"],
};

/** The furthest ring a map's `tier` is counted to. */
const ATLAS_TIERS = 500;
const SIZES: ZoneSize[] = ["small", "medium", "large"];
const BIOMES: ZoneBiome[] = ["meadow", "woods", "caves", "shore"];
const whole = (v: unknown, lo: number, hi: number, otherwise: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : otherwise);

/** Options as they came off the wire, made safe: anything missing or out of range falls back to the default. */
export function zoneOptions(raw: unknown): ZoneOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ZONE_OPTIONS;
  return {
    size: SIZES.includes(o.size as ZoneSize) ? (o.size as ZoneSize) : d.size,
    biome: BIOMES.includes(o.biome as ZoneBiome) ? (o.biome as ZoneBiome) : d.biome,
    groups: whole(o.groups, 0, 6, d.groups),
    kinds: Array.isArray(o.kinds) ? o.kinds.filter((k): k is string => typeof k === "string" && !!ENEMIES[k]).slice(0, 6) : [],
    elevation: whole(o.elevation, 0, 3, d.elevation),
    obstacles: whole(o.obstacles, 0, 3, d.obstacles),
    clear: whole(o.clear, 2, 8, d.clear),
    party: whole(o.party, 1, 4, d.party),
    level: whole(o.level, 1, 40, d.level),
    threat: whole(o.threat, 1, 3, d.threat ?? 2),
    ...(o.delve === true ? { delve: true } : {}),
    ...(cleanMods(o.mods).length > 0 ? { mods: cleanMods(o.mods) } : {}),
    ...(typeof o.tier === "number" && Number.isFinite(o.tier) && o.tier >= 1 ? { tier: Math.min(ATLAS_TIERS, Math.round(o.tier)) } : {}),
  };
}

/** Who stands with a group's leader, for a party of this size: one enemy for a lone hero, a pair for two, a third for a full party. */
export function groupKinds(lead: string, party: number): string[] {
  if (lead === "wolf" || lead === "bandit" || lead === "bear") return bandKinds(lead as RoamerLead, party);
  if (lead === "shade" || lead === "bat" || lead === "skeleton" || lead === "slime") return cavernBand(lead as CavernLead, party);
  // A boss stands alone. Anything else brings its own kind, or a bandit to hold the line for one that shoots.
  if (ENEMIES[lead]?.boss) return [lead];
  const second = lead === "archer" ? "bandit" : lead === "brute" ? "bandit" : lead;
  return [lead, ...(party >= 2 ? [second] : []), ...(party >= 4 ? [lead] : [])];
}

export interface ZonePlan {
  map: WorldMap;
  start: HexPos;
  /** `id`: what the group is called on the map (a delve keeps its chamber's), else one is made up. */
  groups: { id?: string; kinds: string[]; posts: HexPos[] }[];
  /** The groups that carry a key to a locked door (a delve's). */
  keys?: string[];
}

/** Everything that can be walked to from `from`: open ground, no step of two levels. */
function walkable(tiles: Map<string, Tile>, grid: HexGrid, from: HexPos): Set<string> {
  const seen = new Set([posKey(from)]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const here = tiles.get(posKey(queue[i]))!;
    for (const n of hexNeighbors(queue[i], grid)) {
      const key = posKey(n);
      const t = tiles.get(key);
      if (seen.has(key) || solid(t) || Math.abs((t!.elev ?? 0) - (here.elev ?? 0)) >= 2) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen;
}

export function generateZone(seed: string, options: ZoneOptions): ZonePlan {
  const grid = ZONE_GRIDS[options.size];
  const rng = makeRng(seedFromString(`zone|${seed}`));
  const caves = options.biome === "caves";
  const ground: Biome = caves ? "cave" : "plains";
  const all = allHexesInGrid(grid);
  const col = (p: HexPos) => p.q + Math.floor(p.r / 2);
  const rim = (p: HexPos) => p.r === 0 || p.r === grid.rows - 1 || col(p) === 0 || col(p) === grid.cols - (p.r % 2 === 0 ? 1 : 2);
  const tiles = new Map<string, Tile>(all.map((p) => [posKey(p), { q: p.q, r: p.r, biome: rim(p) ? (caves ? "rock" : "water") : ground, h: 0, elev: 0 }]));
  const inner = all.filter((p) => !rim(p));
  const startRow = Math.floor(grid.rows / 2);
  const start: HexPos = { q: 2 - Math.floor(startRow / 2), r: startRow };
  // Bigger maps get more of everything.
  const scale = (grid.cols * grid.rows) / (22 * 18);
  const count = (n: number) => Math.round(n * scale);

  /** A clump of `size` hexes grown outward from `from`. */
  const clump = (from: HexPos, size: number): HexPos[] => {
    const out = [from];
    const have = new Set([posKey(from)]);
    for (let tries = 0; out.length < size && tries < size * 8; tries++) {
      const next = rng.pick(hexNeighbors(rng.pick(out), grid));
      if (rim(next) || have.has(posKey(next))) continue;
      have.add(posKey(next));
      out.push(next);
    }
    return out;
  };
  const at = (p: HexPos) => tiles.get(posKey(p))!;

  // High ground: hills a level up, some with a crown two levels up in their middle.
  for (let i = 0; i < count([0, 2, 4, 7][options.elevation]); i++) {
    const hill = clump(rng.pick(inner), rng.int(8, 16));
    for (const p of hill) at(p).elev = 1;
    if (rng.chance(0.5 + options.elevation * 0.1)) {
      for (const p of clump(hill[0], rng.int(2, 5))) {
        // Only where the hill is all around it, so the crown is reached from the hill and is a cliff nowhere but at its own edge.
        if (hexNeighbors(p, grid).every((n) => (at(n).elev ?? 0) >= 1)) at(p).elev = 2;
      }
    }
  }
  // Rock: outcrops (or, underground, pillars and walls) that bar the way and block sight.
  for (let i = 0; i < count([0, 3, 6, 10][options.obstacles] + (caves ? 4 : 0)); i++) for (const p of clump(rng.pick(inner), rng.int(2, 5))) at(p).biome = "rock";
  // Trees: slow going, and cover from a shot.
  const woods = options.biome === "woods" ? 8 + options.obstacles * 3 : options.biome === "meadow" ? 3 + options.obstacles * 2 : options.biome === "shore" ? 2 : 0;
  for (let i = 0; i < count(woods); i++) for (const p of clump(rng.pick(inner), rng.int(4, 10))) if (at(p).biome === ground) at(p).biome = "forest";
  // Open water: inlets on a shore, a pond or a pool elsewhere.
  for (let i = 0; i < count(options.biome === "shore" ? 4 : 1); i++) {
    for (const p of clump(rng.pick(inner), rng.int(5, 12))) {
      at(p).biome = "water";
      at(p).elev = 0;
    }
  }
  // The start: open, level ground, so there is room to walk before anything happens.
  for (const p of inner) {
    if (hexDistance(p, start) > options.clear) continue;
    at(p).biome = ground;
    at(p).elev = 0;
  }

  // Where the groups stand: far enough that the open ground is safe, and apart from each other.
  const safe = options.clear + ALERT_RANGE + 3;
  const centres: HexPos[] = [];
  for (let spacing = 8; spacing >= 3 && centres.length < options.groups; spacing--) {
    for (let tries = 0; tries < 200 && centres.length < options.groups; tries++) {
      const p = rng.pick(inner);
      if (solid(at(p)) || hexDistance(p, start) < safe || centres.some((c) => hexDistance(c, p) < spacing)) continue;
      centres.push(p);
    }
  }
  // Anything cut off gets a way cut to it: a level path from the start, straight through whatever was there.
  let open = walkable(tiles, grid, start);
  for (const c of centres) {
    if (open.has(posKey(c))) continue;
    for (const p of [...hexesBetween(start, c), c]) {
      if (rim(p)) continue;
      at(p).biome = ground;
      at(p).elev = 0;
    }
    open = walkable(tiles, grid, start);
  }
  const leads = options.kinds.length > 0 ? options.kinds : BIOME_LEADS[options.biome];
  const taken = new Set<string>();
  const groups = centres.map((c, i) => {
    const kinds = groupKinds(options.kinds.length > 0 ? leads[i % leads.length] : rng.pick(leads), options.party);
    // A more dangerous zone has more of them in each group: another of whoever came with the leader. A boss still stands alone.
    if (!ENEMIES[kinds[0]]?.boss && kinds[0] !== "dummy") for (let n = 0; n < threatExtras(options.threat); n++) kinds.push(kinds[kinds.length - 1]);
    const posts = inner
      .filter((p) => hexDistance(p, c) <= 3 && open.has(posKey(p)) && !taken.has(posKey(p)))
      .sort((a, b) => hexDistance(a, c) - hexDistance(b, c) || a.q - b.q || a.r - b.r)
      .slice(0, kinds.length);
    for (const p of posts) taken.add(posKey(p));
    return { kinds: kinds.slice(0, posts.length), posts };
  });

  // Heights for the eye: a level is a clear step up.
  for (const t of tiles.values()) t.h = t.biome === "water" ? BASE_HEIGHT.water : BASE_HEIGHT[t.biome] + (t.elev ?? 0) * 0.42 + rng.next() * 0.05;
  return { map: { grid, tiles: [...tiles.values()], pois: [] }, start, groups: groups.filter((g) => g.kinds.length > 0) };
}

/** A free hex to stand on at or near `near`: the nearest one nobody is on. */
export function freeHexNear(map: WorldMap, near: HexPos, taken: (pos: HexPos) => boolean, tileOf: (pos: HexPos) => Tile | undefined): HexPos | null {
  const seen = new Set([posKey(near)]);
  const queue = [near];
  for (let i = 0; i < queue.length && i < 200; i++) {
    const p = queue[i];
    if (!solid(tileOf(p)) && !taken(p)) return p;
    for (const n of hexNeighbors(p, map.grid)) {
      if (seen.has(posKey(n))) continue;
      seen.add(posKey(n));
      queue.push(n);
    }
  }
  return null;
}
