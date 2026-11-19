// Laying out a map: the land, what stands on it and who holds it, from a
// seed and the map's options. The same seed and options always lay the same
// map. (gen.ts hands the job here for every map that is not a cave.)
//
// A map is no square island. Its land is a ragged run of ground from where
// the party arrives to the far end of it, with nothing at all beyond its
// edge (or, at a cove, the sea), and it is built in this order:
//
//   the land     blobs strung along a wandering line, and the necks between
//   a chasm      at some sites: a crack through it, with a bridge or two
//   relief       low hills to walk over, and plateaus two levels up, some
//                with a crown two more above that. A step of two levels is
//                a cliff: a ramp runs up some, a ladder up others, and the
//                rest are ledges to be jumped (or held by whoever can)
//   water        pools (lava, in the ashlands) on the low ground
//   set pieces   what the site is made of (sites.ts): a keep, a pillared
//                hall, a camp, a henge. Each flattens the ground it stands
//                on and says where a band would post itself there
//   scatter      trees, boulders and whatever else the site strews about
//   bands        one to each set piece, and the rest out in the wilds: the
//                front rank on the ground, those that shoot on the highest
//                ground the place has
//   chests       in the set pieces, guarded by the band that holds them
//   ways         everything a band or a chest stands on can be walked to
//                from the start: where it could not, a ladder is stood, a
//                bridge is thrown or a way is cleared
//
// Height is worth having and worth taking away: a shot from above reaches
// further and lands better, a blow by hand does not reach up a cliff at
// all, and anyone standing at an edge can be shoved off it.

import { hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Biome, Clime, Poi, Tile } from "../map";
import { makeRng, seedFromString, type Rng } from "../rng";
import { HEX_DIRS, MAX_ELEV } from "./geometry";
import { threatExtras } from "./kit";
import { modsOf } from "./mods";
import { propOf } from "./props";
import { SITES, backdropOf, bandOf, factionsOf, siteFor, type Backdrop, type PieceKind, type SiteDef, type SiteId } from "./sites";
import type { GroundSurface, ZoneOptions, ZoneSize } from "./types";

/** How big a map of each size is, in hexes: the land takes up rather more than half of it. */
export const LAY_GRIDS: Record<ZoneSize, HexGrid> = {
  small: { cols: 28, rows: 22 },
  medium: { cols: 36, rows: 26 },
  large: { cols: 46, rows: 32 },
};

/** How near a hero has to come, in plain sight, for an enemy group to turn on them (as gen.ts has it). */
const ALERT = 1;
/** Rounds written on ground that stays: it is never counted down. */
const LASTING_ROUNDS = 99;
const HAZARD_PATCHES = 6;
const HAZARD_SIZE: [number, number] = [3, 7];

export interface LaidGroup {
  id: string;
  kinds: string[];
  posts: HexPos[];
}

export interface Laid {
  map: { grid: HexGrid; tiles: Tile[]; pois: Poi[] };
  start: HexPos;
  groups: LaidGroup[];
  surfaces?: Record<string, GroundSurface>;
  scene: { site: SiteId; backdrop: Backdrop };
}

type Role = "front" | "shot" | "heavy";
interface Post {
  pos: HexPos;
  role: Role;
}
interface Piece {
  kind: PieceKind;
  centre: HexPos;
  radius: number;
  posts: Post[];
  chests: HexPos[];
}

/** How far out each set piece reaches from its middle: nothing else is built that near it. */
const PIECE_RADIUS: Record<PieceKind, number> = { keep: 5, hall: 6, camp: 4, henge: 4, ribcage: 6, stilts: 5, forge: 5, watch: 3, crag: 7, den: 5 };

const add = (p: HexPos, d: HexPos, k = 1): HexPos => ({ q: p.q + d.q * k, r: p.r + d.r * k });
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;

/** Every hex within `r` of `c`, the middle first, then outward. */
function disk(c: HexPos, r: number): HexPos[] {
  const out: HexPos[] = [];
  for (let dq = -r; dq <= r; dq++) for (let dr = Math.max(-r, -dq - r); dr <= Math.min(r, -dq + r); dr++) out.push({ q: c.q + dq, r: c.r + dr });
  return out.sort((a, b) => hexDistance(a, c) - hexDistance(b, c));
}

/**
 * The hexes exactly `r` from `c`, in order round it: six sides of `r` hexes each, side i starting at index i * r
 * (its corner), in the direction of HEX_DIRS[(4 + i) % 6] from the middle.
 */
function ring(c: HexPos, r: number): HexPos[] {
  if (r === 0) return [c];
  const out: HexPos[] = [];
  let cur = add(c, HEX_DIRS[4], r);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < r; j++) {
      out.push(cur);
      cur = add(cur, HEX_DIRS[i]);
    }
  }
  return out;
}

/** Where a hex lies on the page: across and down, in hex widths. */
const page = (p: HexPos) => ({ x: p.q + p.r / 2, y: p.r * 0.866 });

/** Smooth noise, 0 to 1, from a seed: a hashed value at each corner of a unit grid, blended between them. */
function noiseOf(salt: number) {
  const corner = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt | 0, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const [x0, y0] = [Math.floor(x), Math.floor(y)];
    const ease = (t: number) => t * t * (3 - 2 * t);
    const [tx, ty] = [ease(x - x0), ease(y - y0)];
    const top = corner(x0, y0) * (1 - tx) + corner(x0 + 1, y0) * tx;
    const bottom = corner(x0, y0 + 1) * (1 - tx) + corner(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/** How high each kind of ground stands for the eye at level 0 (a level is 0.42 more). A bridge lies level with the ground it joins. */
const GROUND_H: Partial<Record<Biome, number>> = { plains: 0.3, forest: 0.33, sand: 0.26, paved: 0.31, dock: 0.27, rock: 1.3 };

export function layZone(seed: string, asked: ZoneOptions): Laid {
  const mods = modsOf(asked);
  const options: ZoneOptions = {
    ...asked,
    size: mods.size ?? asked.size,
    groups: Math.min(8, asked.groups + mods.groups),
    obstacles: Math.min(3, asked.obstacles + mods.obstacles),
    elevation: Math.min(3, asked.elevation + mods.elevation),
  };
  const grid = LAY_GRIDS[options.size];
  const rng = makeRng(seedFromString(`lay|${seed}`));
  const clime: Clime | undefined = options.clime;
  const siteId: SiteId = options.site && options.site in SITES ? (options.site as SiteId) : siteFor(options.biome, clime, "landfall", makeRng(seedFromString(`site|${seed}`)).next());
  const site: SiteDef = SITES[siteId];
  const sea = backdropOf(siteId, clime) === "sea";
  const wavy = noiseOf(seedFromString(`shape|${seed}`));
  const { cols, rows } = grid;
  const col = (p: HexPos) => p.q + Math.floor(p.r / 2);
  /** On the grid, and a hex clear of its edge. */
  const inside = (p: HexPos) => p.r >= 1 && p.r <= rows - 2 && col(p) >= 1 && col(p) <= cols - 2 - (p.r % 2 === 0 ? 0 : 1);
  const all: HexPos[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols - (r % 2 === 0 ? 0 : 1); c++) all.push({ q: c - Math.floor(r / 2), r });
  const scale = (cols * rows) / (36 * 26);
  const count = (n: number) => Math.max(0, Math.round(n * scale));

  const tiles = new Map<string, Tile>();
  const at = (p: HexPos) => tiles.get(posKey(p));
  const elev = (p: HexPos) => at(p)?.elev ?? 0;
  /** Lay ground on a hex (making the hex, if there was none there), with nothing standing on it unless `change` says so. */
  const lay = (p: HexPos, change: Partial<Tile>): Tile | null => {
    if (!inside(p)) return null;
    let t = at(p);
    if (!t) tiles.set(posKey(p), (t = { q: p.q, r: p.r, biome: "plains", h: 0, elev: 0 }));
    delete t.prop;
    delete t.ladder;
    Object.assign(t, change);
    return t;
  };
  /** Stand something on a hex that has ground. */
  const stand = (p: HexPos, prop: string) => {
    const t = at(p);
    if (t && t.biome !== "water") t.prop = prop;
  };
  /** Stand a ladder on `low`, against the cliff of `high` beside it. */
  const ladder = (low: HexPos | undefined, high: HexPos | undefined) => {
    if (!low || !high) return;
    const t = at(low);
    const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
    if (t && side >= 0) t.ladder = (t.ladder ?? 0) | (1 << side);
  };
  const laddered = (a: HexPos, b: HexPos): boolean => {
    const [low, high] = elev(a) < elev(b) ? [a, b] : [b, a];
    const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
    return side >= 0 && ((at(low)?.ladder ?? 0) & (1 << side)) !== 0;
  };
  const around = (p: HexPos) => HEX_DIRS.map((d) => add(p, d));
  /** A clump of `size` hexes of land grown outward from `from`. */
  const clump = (from: HexPos, size: number, ok: (p: HexPos) => boolean = () => true, dice: Rng = rng): HexPos[] => {
    const out = [from];
    const have = new Set([posKey(from)]);
    for (let tries = 0; out.length < size && tries < size * 8; tries++) {
      const next = dice.pick(around(dice.pick(out)));
      if (have.has(posKey(next)) || !at(next) || !ok(next)) continue;
      have.add(posKey(next));
      out.push(next);
    }
    return out;
  };

  // ---------- the land ----------

  const tall = rows * 0.866;
  const spine: { x: number; y: number; r: number }[] = [];
  const knots = options.size === "small" ? 4 : options.size === "medium" ? 5 : 6;
  const from = { x: cols * 0.15, y: tall * (0.38 + rng.next() * 0.24) };
  const to = { x: cols * 0.85, y: tall * (0.28 + rng.next() * 0.44) };
  for (let i = 0; i < knots; i++) {
    const t = i / (knots - 1);
    const swing = i === 0 || i === knots - 1 ? 0 : (rng.next() - 0.5) * tall * 0.42;
    spine.push({ x: from.x + (to.x - from.x) * t, y: Math.max(tall * 0.2, Math.min(tall * 0.8, from.y + (to.y - from.y) * t + swing)), r: tall * (0.2 + rng.next() * 0.09) });
  }
  // Arms off the line: somewhere to go that is not on the way.
  const arms = knots - 2 + (options.size === "large" ? 1 : 0);
  for (let i = 0; i < arms; i++) {
    const k = spine[rng.int(1, knots - 1)];
    const side = rng.chance(0.5) ? 1 : -1;
    const reach = k.r * (0.9 + rng.next() * 0.5);
    spine.push({ x: k.x + (rng.next() - 0.5) * k.r, y: Math.max(tall * 0.14, Math.min(tall * 0.86, k.y + side * reach)), r: tall * (0.13 + rng.next() * 0.08) });
  }
  // Every blob keeps clear of the grid's edge, ragged rim and all: the land never ends in a straight cut.
  for (const b of spine) {
    b.x = Math.max(b.r * 1.3 + 1.5, Math.min(cols - b.r * 1.3 - 2.5, b.x));
    b.y = Math.max(b.r * 1.3 + 1, Math.min(tall - b.r * 1.3 - 1, b.y));
  }
  // The party arrives toward the near side of the first blob, with land at their backs.
  from.x = spine[0].x - spine[0].r * 0.45;
  from.y = spine[0].y;
  const necks = spine.slice(0, knots);
  const onLand =(p: HexPos): boolean => {
    const { x, y } = page(p);
    const rag = 0.8 + 0.4 * wavy(x * 0.31, y * 0.31) + 0.12 * (wavy(x * 0.9 + 40, y * 0.9) - 0.5);
    if (spine.some((b) => Math.hypot(x - b.x, y - b.y) < b.r * rag)) return true;
    for (let i = 0; i + 1 < necks.length; i++) {
      const [a, b] = [necks[i], necks[i + 1]];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (len * len)));
      if (Math.hypot(x - (a.x + (b.x - a.x) * t), y - (a.y + (b.y - a.y) * t)) < Math.min(a.r, b.r) * 0.62 * rag) return true;
    }
    return false;
  };
  for (const p of all) if (inside(p) && onLand(p)) tiles.set(posKey(p), { q: p.q, r: p.r, biome: "plains", h: 0, elev: 0 });
  // Where the party arrives: the land nearest the near end of the line.
  const land = () => [...tiles.values()].filter((t) => t.biome !== "water");
  const start: HexPos = (() => {
    const t = land().sort((a, b) => Math.hypot(page(a).x - from.x, page(a).y - from.y) - Math.hypot(page(b).x - from.x, page(b).y - from.y))[0];
    return { q: t.q, r: t.r };
  })();
  // Only the land the start is on: a scrap cut off from it by the ragged edge is not part of the map.
  {
    const seen = new Set([posKey(start)]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) for (const n of around(queue[i])) if (at(n) && !seen.has(posKey(n))) (seen.add(posKey(n)), queue.push(n));
    for (const key of [...tiles.keys()]) if (!seen.has(key)) tiles.delete(key);
  }
  const far = (p: HexPos) => hexDistance(p, start);
  const clear = options.clear;
  /** Hexes nothing is strewn on: the start's open ground, and each set piece's own. */
  const kept = new Set<string>();
  for (const p of disk(start, clear)) kept.add(posKey(p));

  // ---------- a chasm ----------

  if (site.chasm && knots >= 4) {
    // Across the land between two knots of the line, well clear of the start: a crack a hex or two wide, with two ways over.
    const i = rng.int(1, knots - 3);
    const [a, b] = [necks[i], necks[i + 1]];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const across = { x: -along.y, y: along.x };
    const cut: { p: HexPos; side: number }[] = [];
    for (const t of [...tiles.values()]) {
      const { x, y } = page(t);
      const u = (x - mid.x) * along.x + (y - mid.y) * along.y;
      const v = (x - mid.x) * across.x + (y - mid.y) * across.y;
      const wobble = (wavy(v * 0.35 + 9, 3.3) - 0.5) * 2.4;
      if (Math.abs(u - wobble) < 0.85 && far(t) > clear + 4) cut.push({ p: { q: t.q, r: t.r }, side: v });
    }
    if (cut.length >= 4) {
      const lo = Math.min(...cut.map((c) => c.side));
      const hi = Math.max(...cut.map((c) => c.side));
      const span = hi - lo;
      // Two bridges, a third of the way in from either end; a narrow crack has one, in the middle.
      const bridges = span > 7 ? [lo + span * 0.28, lo + span * 0.72] : [lo + span * 0.5];
      for (const c of cut) {
        if (bridges.some((v) => Math.abs(c.side - v) < 0.55)) {
          at(c.p)!.biome = "dock";
          kept.add(posKey(c.p));
        } else tiles.delete(posKey(c.p));
      }
    }
  }

  // ---------- relief ----------

  const open = (p: HexPos) => !!at(p) && !kept.has(posKey(p));
  const somewhere = (ok: (p: HexPos) => boolean = () => true): HexPos | null => {
    const pool = land();
    for (let tries = 0; tries < 60; tries++) {
      const t = rng.pick(pool);
      if (open(t) && ok(t)) return { q: t.q, r: t.r };
    }
    return null;
  };
  // Low hills: a level up, walked over like any slope.
  for (let i = 0; i < count([1, 3, 4, 5][options.elevation]); i++) {
    const c = somewhere();
    if (c) for (const p of clump(c, rng.int(6, 14), open)) at(p)!.elev = 1;
  }
  // Plateaus: two levels up, a cliff all round. Some have a ramp up one side; some a crown two levels higher still.
  for (let i = 0; i < count([1, 2, 4, 6][options.elevation]); i++) {
    const c = somewhere((p) => far(p) > clear + 3);
    if (!c) continue;
    const top = clump(c, rng.int(9, 22), open);
    if (top.length < 5) continue;
    for (const p of top) at(p)!.elev = 2;
    const keys = new Set(top.map(posKey));
    if (rng.chance(0.55)) {
      // A ramp: one hex at its foot raised a level, so the way up is two steps of one.
      const feet = top.flatMap((p) => around(p).filter((n) => open(n) && !keys.has(posKey(n)) && elev(n) === 0));
      if (feet.length > 0) at(rng.pick(feet))!.elev = 1;
    }
    if (rng.chance(0.3 + options.elevation * 0.12)) {
      const inner = top.filter((p) => around(p).every((n) => keys.has(posKey(n))));
      if (inner.length > 0) for (const p of clump(rng.pick(inner), rng.int(2, 5), (n) => keys.has(posKey(n)))) at(p)!.elev = Math.min(MAX_ELEV, 4);
    }
  }

  // ---------- water ----------

  if (sea) {
    // The sea round a cove: two hexes of it drawn out from the shore, and sand where the land meets it.
    const shore = new Set<string>();
    for (const t of [...tiles.values()]) for (const n of disk(t, 2)) if (!at(n) && inside(n)) shore.add(posKey(n));
    for (const key of shore) {
      const [q, r] = key.split(",").map(Number);
      tiles.set(key, { q, r, biome: "water", h: 0, elev: 0 });
    }
    for (const t of tiles.values()) if (t.biome === "plains" && (t.elev ?? 0) === 0 && around(t).some((n) => at(n)?.biome === "water")) t.biome = "sand";
  }
  // Pools on the low ground (lava, in the ashlands): never where the party arrives.
  const lowland = (p: HexPos) => open(p) && elev(p) === 0 && at(p)!.biome === "plains" && far(p) > clear + 1 && around(p).every((n) => elev(n) <= 1);
  for (let i = 0; i < count(site.water * 5); i++) {
    const c = somewhere(lowland);
    if (c) for (const p of clump(c, rng.int(3, siteId === "fen" ? 12 : 8), lowland)) at(p)!.biome = "water";
  }

  // ---------- woods ----------

  const grows = (p: HexPos) => open(p) && at(p)!.biome === "plains";
  for (let i = 0; i < count(site.woods * (8 + options.obstacles * 3) * (options.biome === "woods" ? 1.5 : 1)); i++) {
    const c = somewhere(grows);
    if (c) for (const p of clump(c, rng.int(4, 10), grows)) at(p)!.biome = "forest";
  }

  // The start: open, level ground, so there is room to walk before anything happens.
  for (const p of disk(start, clear)) if (at(p)) lay(p, { biome: at(p)!.biome === "dock" ? "dock" : sea && at(p)!.biome === "sand" ? "sand" : "plains", elev: 0 });

  // ---------- set pieces ----------

  const pieces: Piece[] = [];
  const fits = (c: HexPos, radius: number): boolean => {
    if (far(c) < radius + clear + 3) return false;
    if (pieces.some((o) => hexDistance(o.centre, c) < radius + o.radius + 1)) return false;
    const reach = disk(c, radius);
    if (!reach.every(inside)) return false;
    return reach.filter((p) => at(p) && at(p)!.biome !== "water").length >= reach.length * 0.72;
  };
  /** The side of a ring round `c` that faces the start: 0 to 5, as ring() numbers them. */
  const facing = (c: HexPos, r: number): number => {
    const hexes = ring(c, r);
    let best = 0;
    for (let s = 1; s < 6; s++) if (far(hexes[s * r + Math.floor(r / 2)]) < far(hexes[best * r + Math.floor(r / 2)])) best = s;
    return best;
  };
  const wrap = <T,>(list: T[], i: number): T => list[((i % list.length) + list.length) % list.length];
  /** A hex's place across and along an axis through `c`, in hex widths: `axis` 0 to 2 picks which of the three ways the hexes run. */
  const along = (c: HexPos, axis: number) => {
    const d = page(HEX_DIRS[axis]);
    const len = Math.hypot(d.x, d.y);
    return (p: HexPos) => {
      const [dx, dy] = [page(p).x - page(c).x, page(p).y - page(c).y];
      return { u: (dx * d.x + dy * d.y) / len, v: (-dx * d.y + dy * d.x) / len };
    };
  };
  /** The axis (0 to 2) that points most nearly from `c` at the start, and whether the start lies toward its far end. */
  const axisToStart = (c: HexPos): { axis: number; flip: boolean } => {
    let best = { axis: 0, flip: false, d: -1 };
    for (let axis = 0; axis < 3; axis++) {
      const u = along(c, axis)(start).u;
      if (Math.abs(u) > best.d) best = { axis, flip: u > 0, d: Math.abs(u) };
    }
    return best;
  };

  const build: Record<PieceKind, (c: HexPos) => Piece> = {
    // A curtain wall three levels high with a walk along its top, towers, a gatehouse facing the way in, and two
    // ways up from the yard: a ladder at the back, and a scaffold landing by the gate.
    keep: (c) => {
      const R = 4;
      const piece: Piece = { kind: "keep", centre: c, radius: PIECE_RADIUS.keep, posts: [], chests: [] };
      for (const p of disk(c, R + 1)) lay(p, { biome: "plains", elev: 0 });
      for (const p of disk(c, R - 1)) lay(p, { biome: "paved", elev: 0 });
      const wall = ring(c, R);
      for (const p of wall) lay(p, { biome: "paved", elev: 3 });
      const s = facing(c, R);
      const gate = s * R + 2;
      lay(wrap(wall, gate), { biome: "paved", elev: 0, prop: "arch" });
      for (const i of [gate - 1, gate + 1, (s + 2) * R, (s + 4) * R]) stand(wrap(wall, i), "tower");
      const inner = (p: HexPos) => around(p).filter((n) => hexDistance(n, c) === R - 1);
      // The back wall: a ladder straight up from the yard.
      const back = wrap(wall, (s + 3) * R + 1);
      ladder(inner(back)[0], back);
      // Each wing by the gate: a scaffold two levels up, a ladder to it, and a step from it onto the wall.
      for (const i of [(s + 1) * R + 1, (s + 5) * R + 2]) {
        const landing = inner(wrap(wall, i))[0];
        lay(landing, { biome: "dock", elev: 2 });
        const foot = around(landing).find((n) => hexDistance(n, c) === R - 2);
        if (foot) ladder(foot, landing);
      }
      const two = ring(c, 2);
      stand(c, "brazier");
      stand(wrap(two, (s + 2) * 2), "tent");
      stand(wrap(two, (s + 4) * 2), "tent");
      stand(wrap(two, (s + 3) * 2 + 1), "barrels");
      stand(wrap(wall, (s + 3) * R), "banner");
      piece.chests.push(wrap(two, (s + 3) * 2));
      for (const i of [(s + 1) * R, s * R, (s + 1) * R + 2, (s + 5) * R + 3, (s + 3) * R + 2]) piece.posts.push({ pos: wrap(wall, i), role: "shot" });
      const three = ring(c, R - 1);
      for (const i of [s * 3 + 1, s * 3 + 2, s * 3]) piece.posts.push({ pos: wrap(three, i), role: "front" });
      for (const i of [s * 2 + 1, s * 2, s * 2 + 2, (s + 1) * 2 + 1, (s + 5) * 2 + 1]) piece.posts.push({ pos: wrap(two, i), role: "front" });
      piece.posts.push({ pos: wrap(ring(c, 1), s), role: "heavy" });
      return piece;
    },
    // The floor of a ruin, long and narrow: walls still standing along some of it, two rows of pillars, and at the
    // far end a dais up two steps, with an altar, statues and braziers.
    hall: (c) => {
      const piece: Piece = { kind: "hall", centre: c, radius: PIECE_RADIUS.hall, posts: [], chests: [] };
      const { axis, flip } = axisToStart(c);
      const where = along(c, axis);
      // `u` runs from the way in (negative) to the dais (positive).
      const uv = (p: HexPos) => {
        const { u, v } = where(p);
        return flip ? { u: -u, v: -v } : { u, v };
      };
      const floor = disk(c, 6).filter((p) => Math.abs(uv(p).u) <= 5 && Math.abs(uv(p).v) <= 2.5 && inside(p));
      const keys = new Set(floor.map(posKey));
      for (const p of floor) lay(p, { biome: "paved", elev: uv(p).u > 4 ? 2 : uv(p).u > 2.7 ? 1 : 0 });
      const edge = floor.filter((p) => around(p).some((n) => !keys.has(posKey(n))));
      const edgeKeys = new Set(edge.map(posKey));
      for (const p of edge) {
        const { u, v } = uv(p);
        // The way in stays open, and so do the corners by it; the wall behind the dais still stands.
        if (u < -4.2 && Math.abs(v) < 1.2) {
          if (Math.abs(v) < 0.5) stand(p, "arch");
          continue;
        }
        const roll = rng.next();
        if (u > 3.6 || roll < 0.5) stand(p, "wall");
        else if (roll < 0.72) stand(p, "wall_broken");
      }
      const nearest = (u: number, v: number, ok: (p: HexPos) => boolean = () => true) =>
        floor.filter((p) => !edgeKeys.has(posKey(p)) && ok(p)).sort((a, b) => Math.hypot(uv(a).u - u, uv(a).v - v) - Math.hypot(uv(b).u - u, uv(b).v - v))[0];
      const free = (p: HexPos) => !at(p)?.prop;
      for (const u of [-3, -1, 1]) {
        for (const side of [-1, 1]) {
          const p = nearest(u, side * 1.7, free);
          if (p) stand(p, rng.chance(0.28) ? "pillar_broken" : "pillar");
        }
      }
      const altar = nearest(4.4, 0, free);
      if (altar) stand(altar, "altar");
      for (const side of [-1, 1]) {
        const statue = nearest(3.4, side * 1.7, free);
        if (statue) stand(statue, "statue");
        const fire = nearest(2.2, side * 1.7, free);
        if (fire) stand(fire, "brazier");
      }
      for (const v of [-0.6, 0.6]) {
        const step = nearest(2.8, v, free);
        if (step && elev(step) === 1) stand(step, "stairs");
      }
      const chest = nearest(3.6, 0.9, free);
      if (chest) piece.chests.push(chest);
      const aisle = floor.filter((p) => !edgeKeys.has(posKey(p)) && free(p) && !piece.chests.some((x) => same(x, p)));
      for (const p of aisle.filter((p) => uv(p).u > 2.9).sort((a, b) => uv(b).u - uv(a).u)) piece.posts.push({ pos: p, role: "shot" });
      for (const p of aisle.filter((p) => uv(p).u <= 2.4 && uv(p).u > -3.5).sort((a, b) => Math.abs(uv(a).u) - Math.abs(uv(b).u))) piece.posts.push({ pos: p, role: Math.abs(uv(p).u) < 0.6 && Math.abs(uv(p).v) < 0.6 ? "heavy" : "front" });
      return piece;
    },
    // Tents and a fire behind a ring of stakes, with a way in toward the start and another at the back, and a
    // watch platform on legs.
    camp: (c) => {
      const R = 3;
      const piece: Piece = { kind: "camp", centre: c, radius: PIECE_RADIUS.camp, posts: [], chests: [] };
      for (const p of disk(c, R + 1)) if (at(p)) lay(p, { biome: at(p)!.biome === "water" || at(p)!.biome === "dock" ? "plains" : at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: 0 });
      const fence = ring(c, R);
      const s = facing(c, R);
      const gaps = new Set([s * R + 1, (s + 3) * R + 1].map((i) => posKey(wrap(fence, i))));
      for (const p of fence) if (at(p) && !gaps.has(posKey(p)) && !rng.chance(0.14)) stand(p, "palisade");
      const [one, two] = [ring(c, 1), ring(c, 2)];
      stand(c, "campfire");
      for (const i of [(s + 1) * 2, (s + 2) * 2 + 1, (s + 4) * 2 + 1]) stand(wrap(two, i), "tent");
      stand(wrap(two, (s + 5) * 2), rng.chance(0.5) ? "cart" : "barrels");
      stand(wrap(one, s), "banner");
      piece.chests.push(wrap(one, s + 3));
      // The watch platform: three levels up on its legs, a ladder up from beside the fire.
      const perch = wrap(two, (s + 5) * 2 + 1);
      if (lay(perch, { biome: "dock", elev: 3 })) {
        const foot = around(perch).find((n) => hexDistance(n, c) === 1 && !at(n)?.prop && !piece.chests.some((x) => same(x, n)));
        if (foot) ladder(foot, perch);
        piece.posts.push({ pos: perch, role: "shot" });
      }
      for (const p of [...two, ...one]) if (at(p) && !at(p)!.prop && !same(p, perch) && !piece.chests.some((x) => same(x, p))) piece.posts.push({ pos: p, role: hexDistance(p, c) === 1 ? "heavy" : "front" });
      return piece;
    },
    // Standing stones in a ring on a low mound, round an altar (a statue, in the frost; an obelisk, where the bones lie).
    henge: (c) => {
      const piece: Piece = { kind: "henge", centre: c, radius: PIECE_RADIUS.henge, posts: [], chests: [] };
      for (const p of disk(c, 4)) if (at(p)) lay(p, { biome: at(p)!.biome === "water" ? "plains" : at(p)!.biome, elev: 0 });
      for (const p of disk(c, 3)) lay(p, { biome: "plains", elev: 1 });
      for (const p of disk(c, 1)) lay(p, { biome: "paved", elev: 1 });
      const [one, two, three] = [ring(c, 1), ring(c, 2), ring(c, 3)];
      two.forEach((p, i) => i % 2 === 0 && stand(p, "standing_stone"));
      stand(c, clime === "frost" ? "statue" : siteId === "boneyard" || clime === "ash" ? "obelisk" : "altar");
      const s = facing(c, 3);
      for (const i of clime === "frost" ? [1, 4, 7, 10] : [(s + 2) * 3 + 1, (s + 5) * 3 + 1]) stand(wrap(three, i), "brazier");
      piece.chests.push(wrap(one, s + 3));
      for (const p of one) if (!piece.chests.some((x) => same(x, p))) piece.posts.push({ pos: p, role: "front" });
      two.forEach((p, i) => i % 2 === 1 && piece.posts.push({ pos: p, role: i % 4 === 1 ? "shot" : "front" }));
      piece.posts.push({ pos: wrap(one, s), role: "heavy" });
      return piece;
    },
    // The ribs of something vast in two rows, and its skull at the far end.
    ribcage: (c) => {
      const piece: Piece = { kind: "ribcage", centre: c, radius: PIECE_RADIUS.ribcage, posts: [], chests: [] };
      const { axis, flip } = axisToStart(c);
      const where = along(c, axis);
      const uv = (p: HexPos) => {
        const { u, v } = where(p);
        return flip ? { u: -u, v: -v } : { u, v };
      };
      const body = disk(c, 6).filter((p) => at(p) && Math.abs(uv(p).u) <= 5.6 && Math.abs(uv(p).v) <= 3.2);
      for (const p of body) lay(p, { biome: at(p)!.biome === "water" ? "plains" : at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: Math.min(1, elev(p)) });
      const nearest = (u: number, v: number) => body.filter((p) => !at(p)?.prop).sort((a, b) => Math.hypot(uv(a).u - u, uv(a).v - v) - Math.hypot(uv(b).u - u, uv(b).v - v))[0];
      for (let i = -3; i <= 3; i++) for (const side of [-1, 1]) {
        if (rng.chance(0.12)) continue;
        const rib = nearest(i * 1.25, side * (2.2 - Math.abs(i) * 0.12));
        if (rib) stand(rib, "ribs");
      }
      const skull = nearest(5, 0);
      if (skull) stand(skull, "skull");
      const chest = nearest(3.4, 0);
      if (chest) piece.chests.push(chest);
      for (const p of body.filter((p) => !at(p)?.prop && Math.abs(uv(p).v) < 1.4 && Math.abs(uv(p).u) < 3 && !piece.chests.some((x) => same(x, p))).sort((a, b) => Math.abs(uv(a).u) - Math.abs(uv(b).u))) piece.posts.push({ pos: p, role: Math.abs(uv(p).u) < 0.6 ? "heavy" : uv(p).u > 1.8 ? "shot" : "front" });
      return piece;
    },
    // Huts on legs over a pool, joined to the shore and each other by boardwalks a hex wide.
    stilts: (c) => {
      const piece: Piece = { kind: "stilts", centre: c, radius: PIECE_RADIUS.stilts, posts: [], chests: [] };
      for (const p of disk(c, 5)) if (at(p)) lay(p, { biome: at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: 0 });
      for (const p of disk(c, 4)) lay(p, { biome: "water", elev: 0 });
      for (const p of disk(c, 1)) lay(p, { biome: "dock", elev: 0 });
      const s = facing(c, 4);
      for (const k of [0, 2, 4]) {
        const d = HEX_DIRS[(4 + s + k) % 6];
        for (let r = 2; r <= 4; r++) lay(add(c, d, r), { biome: "dock", elev: 0 });
        lay(add(c, d, 5), { biome: "plains", elev: 0 });
        // A hut off the walk, on its own little landing.
        const beside = add(add(c, d, 3), HEX_DIRS[(4 + s + k + 1) % 6]);
        if (lay(beside, { biome: "dock", elev: 0 })) stand(beside, "stilt_hut");
        piece.posts.push({ pos: add(c, d, 2), role: "front" }, { pos: add(c, d, 3), role: k === 0 ? "front" : "shot" });
      }
      const one = ring(c, 1);
      stand(wrap(one, s + 3), "brazier");
      piece.chests.push(wrap(one, s + 2));
      piece.posts.push({ pos: c, role: "heavy" }, { pos: wrap(one, s), role: "front" }, { pos: wrap(one, s + 5), role: "shot" });
      return piece;
    },
    // A paved island in a pool of lava (water, anywhere but the ashlands), a level above it, reached by two causeways.
    forge: (c) => {
      const piece: Piece = { kind: "forge", centre: c, radius: PIECE_RADIUS.forge, posts: [], chests: [] };
      for (const p of disk(c, 5)) if (at(p)) lay(p, { biome: at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: 0 });
      for (const p of disk(c, 4)) lay(p, { biome: "water", elev: 0 });
      for (const p of disk(c, 2)) lay(p, { biome: "paved", elev: 1 });
      const s = facing(c, 4);
      for (const k of [0, 3]) {
        const d = HEX_DIRS[(4 + s + k) % 6];
        for (let r = 3; r <= 4; r++) lay(add(c, d, r), { biome: "paved", elev: 1 });
        lay(add(c, d, 5), { biome: "plains", elev: 0 });
      }
      const [one, two] = [ring(c, 1), ring(c, 2)];
      stand(c, clime === "ash" ? "obelisk" : "altar");
      for (const i of [(s + 1) * 2, (s + 2) * 2 + 1, (s + 4) * 2, (s + 5) * 2 + 1]) stand(wrap(two, i), "brazier");
      for (const p of ring(c, 5)) if (at(p) && at(p)!.biome === "plains" && rng.chance(0.3) && !HEX_DIRS.some((d, i) => (i === (4 + s) % 6 || i === (4 + s + 3) % 6) && same(add(c, d, 5), p))) stand(p, "basalt");
      piece.chests.push(wrap(one, s + 2));
      for (const p of [...one, ...two]) if (!at(p)?.prop && !piece.chests.some((x) => same(x, p))) piece.posts.push({ pos: p, role: hexDistance(p, c) === 1 ? "shot" : "front" });
      return piece;
    },
    // A ruined tower on a knoll two levels up: a ramp up the side that faces the start, a ladder round the back.
    watch: (c) => {
      const piece: Piece = { kind: "watch", centre: c, radius: PIECE_RADIUS.watch, posts: [], chests: [] };
      for (const p of disk(c, 3)) if (at(p)) lay(p, { biome: at(p)!.biome === "water" || at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: 0 });
      for (const p of disk(c, 2)) lay(p, { biome: "paved", elev: 2 });
      const [one, two, three] = [ring(c, 1), ring(c, 2), ring(c, 3)];
      const s = facing(c, 3);
      const ramp = wrap(three, s * 3 + 1);
      if (at(ramp)) at(ramp)!.elev = 1;
      const foot = wrap(three, (s + 3) * 3 + 1);
      const up = around(foot).find((n) => hexDistance(n, c) === 2);
      if (at(foot) && up) ladder(foot, up);
      stand(c, "tower");
      stand(wrap(one, s + 1), "wall_broken");
      stand(wrap(one, s + 4), "wall_broken");
      stand(wrap(one, s + 2), "brazier");
      piece.chests.push(wrap(one, s + 3));
      for (const i of [s * 2 + 1, s * 2, s * 2 + 2, (s + 1) * 2 + 1, (s + 5) * 2 + 1]) piece.posts.push({ pos: wrap(two, i), role: "shot" });
      for (const p of [wrap(one, s), wrap(one, s + 5), ...three.filter((p) => at(p) && !same(p, ramp) && !same(p, foot))]) piece.posts.push({ pos: p, role: "front" });
      return piece;
    },
    // A hill in steps: a broad shoulder two levels up, a cliff of two more to the top terrace (a ramp round one
    // side of it, ladders up two others), and a beacon on the summit.
    crag: (c) => {
      const piece: Piece = { kind: "crag", centre: c, radius: PIECE_RADIUS.crag, posts: [], chests: [] };
      for (const p of disk(c, 7)) if (at(p)) lay(p, { biome: at(p)!.biome === "water" ? "plains" : at(p)!.biome, elev: Math.min(1, Math.max(elev(p), hexDistance(p, c) <= 6 ? 1 : 0)) });
      for (const p of disk(c, 5)) lay(p, { biome: "plains", elev: 2 });
      for (const p of disk(c, 3)) lay(p, { biome: "plains", elev: 4 });
      for (const p of disk(c, 1)) lay(p, { biome: "paved", elev: 5 });
      const s = facing(c, 4);
      const four = ring(c, 4);
      // The ramp: a hex of the shoulder raised a level, a step up from it to the terrace.
      lay(wrap(four, (s + 1) * 4 + 2), { biome: "plains", elev: 3 });
      for (const i of [(s + 3) * 4 + 1, (s + 5) * 4 + 2]) {
        const foot = wrap(four, i);
        const up = around(foot).find((n) => hexDistance(n, c) === 3);
        if (up) ladder(foot, up);
      }
      const [one, two, three, five] = [ring(c, 1), ring(c, 2), ring(c, 3), ring(c, 5)];
      stand(c, "brazier");
      stand(wrap(one, s + 3), "banner");
      stand(wrap(two, (s + 3) * 2), "wall_broken");
      stand(wrap(two, (s + 3) * 2 + 2), "tower");
      piece.chests.push(wrap(one, s + 2));
      for (const i of [s * 3 + 1, s * 3, s * 3 + 2, (s + 1) * 3 + 1, (s + 5) * 3 + 1]) piece.posts.push({ pos: wrap(three, i), role: "shot" });
      for (const i of [s * 5 + 2, s * 5 + 1, s * 5 + 3, (s + 1) * 5 + 2, (s + 5) * 5 + 2, s * 5 + 4]) piece.posts.push({ pos: wrap(five, i), role: "front" });
      piece.posts.push({ pos: wrap(two, s * 2 + 1), role: "heavy" });
      return piece;
    },
    // A hollow ringed with boulders and old bones, two ways in, and whatever sleeps there in the middle of it.
    den: (c) => {
      const piece: Piece = { kind: "den", centre: c, radius: PIECE_RADIUS.den, posts: [], chests: [] };
      for (const p of disk(c, 4)) if (at(p)) lay(p, { biome: at(p)!.biome === "water" || at(p)!.biome === "forest" ? "plains" : at(p)!.biome, elev: 0 });
      const s = facing(c, 4);
      const rim = ring(c, 4);
      const ways = new Set([s * 4 + 1, s * 4 + 2, (s + 3) * 4 + 2].map((i) => posKey(wrap(rim, i))));
      rim.forEach((p, i) => at(p) && !ways.has(posKey(p)) && stand(p, i % 3 === 0 ? "ribs" : "boulder"));
      const [one, two, three] = [ring(c, 1), ring(c, 2), ring(c, 3)];
      stand(wrap(three, (s + 3) * 3), "skull");
      stand(wrap(two, (s + 2) * 2), "ribs");
      stand(wrap(two, (s + 4) * 2 + 1), "ribs");
      piece.chests.push(wrap(two, (s + 3) * 2));
      piece.posts.push({ pos: c, role: "heavy" });
      for (const p of [...one, ...two]) if (!at(p)?.prop && !piece.chests.some((x) => same(x, p))) piece.posts.push({ pos: p, role: "front" });
      return piece;
    },
  };

  // The first piece is what the place is: it goes as far from the start as it will fit. The rest go where there is room.
  const want = options.size === "small" ? 2 : options.size === "medium" ? 3 : 4;
  for (const [n, kind] of (site.pieces as PieceKind[]).slice(0, want).entries()) {
    const radius = PIECE_RADIUS[kind];
    const spots = land().map((t) => ({ pos: { q: t.q, r: t.r }, order: rng.next() + (n === 0 ? -far(t) * 0.5 : 0) })).sort((a, b) => a.order - b.order);
    const centre = spots.find((sp) => fits(sp.pos, radius))?.pos;
    if (!centre) continue;
    const piece = build[kind](centre);
    pieces.push(piece);
    for (const p of disk(centre, radius)) kept.add(posKey(p));
  }

  // ---------- scatter ----------

  const strewn = (p: HexPos) => open(p) && at(p)!.biome !== "water" && at(p)!.biome !== "dock" && !at(p)!.prop && !at(p)!.ladder;
  const things: string[] = site.scatter;
  for (let i = 0; i < count(8 + options.obstacles * 7); i++) {
    const c = somewhere(strewn);
    if (!c) continue;
    const prop = rng.pick(things);
    // One thing alone, or (boulders, spires, columns) two or three together.
    const many = ["boulder", "ice_spire", "basalt", "mushrooms", "ribs"].includes(prop) ? rng.int(1, 3) : 1;
    for (const p of clump(c, many, strewn)) {
      at(p)!.biome = at(p)!.biome === "forest" ? "plains" : at(p)!.biome;
      stand(p, prop);
    }
  }
  // A light here and there in the wilds, so the place is not all one tone: a lone brazier, or a glowing crystal.
  for (let i = 0; i < count(2); i++) {
    const c = somewhere(strewn);
    if (c) stand(c, clime === "frost" || rng.chance(0.3) ? "crystal" : "brazier");
  }

  // ---------- who holds it ----------

  const solidAt = (p: HexPos) => {
    const t = at(p);
    return !t || t.biome === "water" || t.biome === "rock" || !!propOf(t)?.blocks;
  };
  const taken = new Set<string>();
  const chestKeys = new Set<string>();
  for (const piece of pieces) {
    piece.chests = piece.chests.filter((p) => at(p) && !solidAt(p) && !chestKeys.has(posKey(p)));
    for (const p of piece.chests) chestKeys.add(posKey(p));
  }
  const standable = (p: HexPos) => !solidAt(p) && !chestKeys.has(posKey(p)) && !taken.has(posKey(p)) && far(p) > clear + ALERT + 1;
  const size = Math.max(2, Math.min(8, options.party + 1 + threatExtras(options.threat) + mods.extras));
  const factions = factionsOf(siteId, clime);
  const groups: (LaidGroup & { centre: HexPos })[] = [];
  /** Post a band of `kinds` (each with its part) at a place: its own posts by part first, then whatever open ground is nearest. */
  const post = (id: string, centre: HexPos, band: { kind: string; role: Role }[], own: Post[]) => {
    const near = disk(centre, 5).filter(standable);
    const kinds: string[] = [];
    const posts: HexPos[] = [];
    for (const member of band) {
      const mine = own.find((o) => o.role === member.role && standable(o.pos));
      // No post of its own left: one that shoots takes the highest ground near, anyone else the nearest.
      const spot = mine?.pos ?? (member.role === "shot" ? [...near].filter(standable).sort((a, b) => elev(b) - elev(a) || hexDistance(a, centre) - hexDistance(b, centre))[0] : near.find(standable));
      if (!spot) continue;
      taken.add(posKey(spot));
      kinds.push(member.kind);
      posts.push({ q: spot.q, r: spot.r });
    }
    if (kinds.length > 0) groups.push({ id, kinds, posts, centre });
  };
  const bandFor = (i: number): { kind: string; role: Role }[] => {
    const lead = options.kinds.length > 0 ? options.kinds[i % options.kinds.length] : null;
    const faction = factions[i % factions.length];
    if (!lead) return bandOf(faction, size, rng.pick);
    // A named leader: a boss with a band of the place's own behind it (once: there is one of it, and the other
    // bands are the place's own); a training dummy alone; anything else with its own kind.
    if (lead === "dummy") return [{ kind: "dummy", role: "front" }];
    if (ENEMIES[lead]?.boss) {
      if (groups.some((g) => g.kinds.includes(lead))) return bandOf(faction, size, rng.pick);
      return [{ kind: lead, role: "heavy" }, ...bandOf(faction, Math.max(1, size - 1), rng.pick).filter((m) => m.role !== "heavy")];
    }
    return Array.from({ length: size }, (_, k) => ({ kind: lead, role: (k > 0 && k % 3 === 2 ? "shot" : "front") as Role }));
  };
  // A band to each set piece (as many as there are bands for), the rest out in the wilds, well apart.
  for (let i = 0; i < options.groups; i++) {
    const piece = pieces[i];
    if (piece) {
      post(`band${i + 1}`, piece.centre, bandFor(i), piece.posts);
      continue;
    }
    let centre: HexPos | null = null;
    for (let apart = 9; apart >= 4 && !centre; apart--) {
      centre = somewhere((p) => standable(p) && far(p) > clear + ALERT + 4 && !groups.some((g) => hexDistance(g.centre, p) < apart) && !pieces.some((o) => hexDistance(o.centre, p) < o.radius + 3));
    }
    if (centre) post(`band${i + 1}`, centre, bandFor(i), []);
  }

  // ---------- chests ----------

  const pois: Poi[] = [];
  pieces.forEach((piece, i) => {
    const guard = groups.find((g) => g.id === `band${i + 1}`)?.id;
    for (const p of piece.chests) {
      if (taken.has(posKey(p))) continue;
      pois.push({ id: `chest${pois.length + 1}`, kind: "cache", pos: { q: p.q, r: p.r }, hidden: false, cleared: false, usedBy: [], enemies: [], loot: i === 0 && piece.kind !== "camp" ? "vault" : "chest", ...(guard ? { guard } : {}) });
    }
  });

  // ---------- ways ----------

  /** Whether a step can be walked: open ground at both ends, and a level's difference at most, or a ladder. */
  const steps = (a: HexPos, b: HexPos) => !solidAt(b) && !chestKeys.has(posKey(b)) && (Math.abs(elev(a) - elev(b)) <= 1 || laddered(a, b));
  const walked = (): Set<string> => {
    const seen = new Set([posKey(start)]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) for (const n of around(queue[i])) if (!seen.has(posKey(n)) && steps(queue[i], n)) (seen.add(posKey(n)), queue.push(n));
    return seen;
  };
  /**
   * Make a way from the ground already walked to `target`: the cheapest there is, where standing a ladder against
   * a cliff costs a little, throwing a bridge over a gap more, and clearing what stands in the way most of all.
   */
  const connect = (target: HexPos, reach: Set<string>): boolean => {
    if (reach.has(posKey(target))) return false;
    const cost = new Map<string, number>([[posKey(target), 0]]);
    const prev = new Map<string, HexPos>();
    const frontier: HexPos[] = [target];
    let found: HexPos | null = null;
    while (frontier.length > 0 && !found) {
      let best = 0;
      for (let i = 1; i < frontier.length; i++) if (cost.get(posKey(frontier[i]))! < cost.get(posKey(frontier[best]))!) best = i;
      const cur = frontier.splice(best, 1)[0];
      if (reach.has(posKey(cur))) {
        found = cur;
        break;
      }
      for (const n of around(cur)) {
        if (!inside(n) || chestKeys.has(posKey(n))) continue;
        const t = at(n);
        let step = 1;
        if (!t) step += sea ? 40 : 7;
        else if (t.biome === "water") step += 5;
        else if (propOf(t)?.blocks) step += t.prop === "wall" || t.prop === "tower" || t.prop === "palisade" ? 14 : 6;
        if (t && at(cur) && !solidAt(n) && !solidAt(cur) && Math.abs(elev(n) - elev(cur)) >= 2 && !laddered(n, cur)) step += 2 + Math.abs(elev(n) - elev(cur));
        const total = cost.get(posKey(cur))! + step;
        if (total >= (cost.get(posKey(n)) ?? Infinity)) continue;
        cost.set(posKey(n), total);
        prev.set(posKey(n), cur);
        frontier.push(n);
      }
    }
    if (!found) return false;
    // Along the way from the walked ground to the target: whatever is in the way goes, and every cliff gets a ladder.
    let a = found;
    for (let b = prev.get(posKey(a)); b; a = b, b = prev.get(posKey(a))) {
      const t = at(b);
      if (!t) lay(b, { biome: "dock", elev: elev(a) });
      else if (t.biome === "water") lay(b, { biome: "dock", elev: 0 });
      else if (propOf(t)?.blocks) delete t.prop;
      if (Math.abs(elev(a) - elev(b)) >= 2 && !laddered(a, b)) ladder(elev(a) < elev(b) ? a : b, elev(a) < elev(b) ? b : a);
    }
    return true;
  };
  {
    let reach = walked();
    const targets = [...groups.flatMap((g) => g.posts), ...pois.map((p) => around(p.pos).filter((n) => !solidAt(n) && !chestKeys.has(posKey(n))).sort((a, b) => far(a) - far(b))[0]).filter((p): p is HexPos => !!p)];
    for (const target of targets) if (connect(target, reach)) reach = walked();
    // A post that still cannot be walked to is nobody's post: its fighter is left out.
    for (const g of groups) {
      const keep = g.posts.map((p) => reach.has(posKey(p)));
      g.kinds = g.kinds.filter((_, i) => keep[i]);
      g.posts = g.posts.filter((_, i) => keep[i]);
    }
  }

  // The ring the party arrives by, behind where they stand: the hex beside the start that is furthest from everything else.
  {
    const behind = around(start).filter((p) => at(p) && !solidAt(p) && !taken.has(posKey(p))).sort((a, b) => Math.hypot(page(a).x - to.x, page(a).y - to.y) - Math.hypot(page(b).x - to.x, page(b).y - to.y)).pop();
    if (behind && around(start).filter((p) => at(p) && !solidAt(p)).length >= 3) stand(behind, "waygate");
  }

  // ---------- the finish ----------

  for (const t of tiles.values()) {
    t.elev = Math.max(0, Math.min(MAX_ELEV, t.elev ?? 0));
    t.h = t.biome === "water" ? 0.05 : (GROUND_H[t.biome] ?? 0.3) + t.elev * 0.42 + rng.next() * 0.04;
    if (clime) t.clime = clime;
    if (!t.ladder) delete t.ladder;
  }
  let surfaces: Record<string, GroundSurface> | undefined;
  const patches: { kind: GroundSurface["kind"]; many: number }[] = [];
  if (mods.hazard) patches.push({ kind: mods.hazard, many: HAZARD_PATCHES * mods.patches });
  // The frost's own: sheets of ice on the open ground, that will not melt.
  if (clime === "frost" && mods.hazard !== "ice") patches.push({ kind: "ice", many: 2 });
  if (patches.length > 0) {
    const dice = makeRng(seedFromString(`ground|${seed}`));
    const posts = groups.flatMap((g) => g.posts);
    const fitsGround = (p: HexPos) => !solidAt(p) && at(p)!.biome !== "dock" && far(p) > clear + 1 && !posts.some((o) => hexDistance(o, p) <= 1);
    const pool = land();
    surfaces = {};
    for (const patch of patches) {
      for (let i = 0; i < count(patch.many); i++) {
        const c = dice.pick(pool);
        for (const p of clump(c, dice.int(HAZARD_SIZE[0], HAZARD_SIZE[1]), () => true, dice)) if (fitsGround(p)) surfaces[posKey(p)] = { kind: patch.kind, rounds: LASTING_ROUNDS, by: null, lasting: true };
      }
    }
  }
  const laid = [...tiles.values()].sort((a, b) => a.r - b.r || a.q - b.q);
  return {
    map: { grid, tiles: laid, pois },
    start,
    groups: groups.filter((g) => g.kinds.length > 0).map(({ id, kinds, posts }) => ({ id, kinds, posts })),
    ...(surfaces && Object.keys(surfaces).length > 0 ? { surfaces } : {}),
    scene: { site: siteId, backdrop: backdropOf(siteId, clime) },
  };
}
