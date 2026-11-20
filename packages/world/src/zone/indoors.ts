// Laying out a map under a roof or under ground: the sites that are
// `inside` (sites.ts). lay.ts hands the job here for those. Like every map,
// the same seed and options always lay the same one.
//
// There is no land with a sky over it here. The map is rooms cut out of
// nothing: beyond the walls there is no ground at all, only the dark.
//
//   halls   (a citadel, a crypt) rooms on a lattice, each walled in dressed
//           stone one hex thick, the wall between two neighbours shared and
//           a doorway cut through it. One room is where the party comes in;
//           the far end is a great hall two rooms long, pillared, with a
//           dais and a high seat, where the place's chief band stands (and
//           the boss, if there is one). The rooms between are guardrooms,
//           a library, a chapel, stores, tombs, and rooms with a gallery
//           two levels up along one side, for those who shoot.
//
//   caves   (a cavern, a hollow) chambers of living rock on the same
//           lattice, ragged, joined by tunnels a hex or two wide. Some have
//           a shelf two levels up with a ladder, some a pool, some a hole in
//           the floor that goes down for ever. The far end is the biggest
//           chamber, and whatever rules the place is in it.
//
// A doorway or a tunnel is a place two can hold against many, a gallery or
// a shelf is height worth taking, and a hole in the floor is somewhere to be
// shoved. A fight is not heard through walls: only the bands near it come
// (zone.ts: rouse does nothing under a roof).

import { hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Clime, Poi, Tile } from "../map";
import { makeRng, seedFromString, type Rng } from "../rng";
import { HEX_DIRS, MAX_ELEV } from "./geometry";
import { threatExtras } from "./kit";
import type { Laid, LaidGroup } from "./lay";
import { modsOf } from "./mods";
import { propOf } from "./props";
import { SITES, backdropOf, bandOf, factionsOf, type SiteDef, type SiteId } from "./sites";
import type { GroundSurface, ZoneOptions } from "./types";

const LASTING_ROUNDS = 99;
const HAZARD_PATCHES = 4;

type Role = "front" | "shot" | "heavy";
interface Post {
  pos: HexPos;
  role: Role;
}
/** One room or chamber: its floor, where it opens onto its neighbours, and where a band and its chests would be. */
interface Room {
  cell: number;
  centre: HexPos;
  floor: HexPos[];
  /** The doorways (or tunnel mouths) into it. */
  doors: HexPos[];
  /** How many rooms it opens onto. */
  links: number;
  /** How many rooms lie between it and the way in. */
  depth: number;
  posts: Post[];
  chests: HexPos[];
  start?: boolean;
  hall?: boolean;
}

const add = (p: HexPos, d: HexPos, k = 1): HexPos => ({ q: p.q + d.q * k, r: p.r + d.r * k });
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const page = (p: HexPos) => ({ x: p.q + p.r / 2, y: p.r * 0.866 });

function disk(c: HexPos, r: number): HexPos[] {
  const out: HexPos[] = [];
  for (let dq = -r; dq <= r; dq++) for (let dr = Math.max(-r, -dq - r); dr <= Math.min(r, -dq + r); dr++) out.push({ q: c.q + dq, r: c.r + dr });
  return out.sort((a, b) => hexDistance(a, c) - hexDistance(b, c));
}

/** The hex nearest a point given in fractions of a hex. */
function roundHex(q: number, r: number): HexPos {
  const s = -q - r;
  let [rq, rr] = [Math.round(q), Math.round(r)];
  const rs = Math.round(s);
  const [dq, dr, ds] = [Math.abs(rq - q), Math.abs(rr - r), Math.abs(rs - s)];
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function layInside(seed: string, options: ZoneOptions, siteId: SiteId, grid: HexGrid): Laid {
  const site: SiteDef = SITES[siteId];
  const halls = site.inside === "halls";
  const mods = modsOf(options);
  const rng = makeRng(seedFromString(`inside|${seed}`));
  const clime: Clime | undefined = options.clime;
  const { cols, rows } = grid;
  const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);
  /** The hex at a column and a row. */
  const H = (c: number, r: number): HexPos => ({ q: c - Math.floor(r / 2), r });
  /** The last column every row has. */
  const maxCol = cols - 3;
  const onGrid = (p: HexPos) => p.r >= 1 && p.r <= rows - 2 && colOf(p) >= 1 && colOf(p) <= maxCol;

  const tiles = new Map<string, Tile>();
  const at = (p: HexPos) => tiles.get(posKey(p));
  const elev = (p: HexPos) => at(p)?.elev ?? 0;
  const lay = (p: HexPos, change: Partial<Tile>): Tile | null => {
    if (!onGrid(p)) return null;
    let t = at(p);
    if (!t) tiles.set(posKey(p), (t = { q: p.q, r: p.r, biome: "paved", h: 0, elev: 0 }));
    delete t.prop;
    delete t.ladder;
    Object.assign(t, change);
    return t;
  };
  const around = (p: HexPos) => HEX_DIRS.map((d) => add(p, d));
  const ladder = (low: HexPos, high: HexPos) => {
    const t = at(low);
    const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
    if (t && side >= 0) t.ladder = (t.ladder ?? 0) | (1 << side);
  };
  const laddered = (a: HexPos, b: HexPos): boolean => {
    const [low, high] = elev(a) < elev(b) ? [a, b] : [b, a];
    const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
    return side >= 0 && ((at(low)?.ladder ?? 0) & (1 << side)) !== 0;
  };
  /** Ground somebody could stand on. */
  const walk = (p: HexPos) => {
    const t = at(p);
    return !!t && t.biome !== "water" && t.biome !== "rock" && !propOf(t)?.blocks;
  };
  /** Whether a hex can be shut (something stood on it, flooded, or taken away) without parting the ground round it: what can be walked beside it is all one run. */
  const spare = (p: HexPos) => {
    const ring = around(p);
    const ok = ring.map(walk);
    let runs = 0;
    for (let i = 0; i < 6; i++) {
      const before = (i + 5) % 6;
      if (ok[i] && !(ok[before] && Math.abs(elev(ring[i]) - elev(ring[before])) <= 1)) runs++;
    }
    return runs <= 1;
  };
  /** Hexes nothing is ever stood on: doorways and tunnels and the ground before them, and where the party comes in. */
  const reserved = new Set<string>();
  /** Stand something on a hex: what bars the way only where that parts nothing. True if it stands. */
  const stand = (p: HexPos, prop: string): boolean => {
    const t = at(p);
    if (!t || !walk(p) || t.prop || t.ladder) return false;
    if (propOf({ prop })?.blocks && (reserved.has(posKey(p)) || !spare(p))) return false;
    t.prop = prop;
    return true;
  };

  // ---------- the lattice of rooms ----------

  const nx = Math.max(3, Math.round((cols - 2) / 9));
  const ny = Math.max(2, Math.round((rows - 2) / 8));
  /** The lines between the rooms: columns `bx`, rows `by`. A room's floor lies strictly between its four. */
  const lines = (n: number, from: number, to: number): number[] => {
    const gap = (to - from) / n;
    return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? from : i === n ? to : Math.round(from + gap * i) + (gap >= 7.5 ? rng.int(-1, 1) : 0)));
  };
  const bx = lines(nx, 1, maxCol);
  const by = lines(ny, 1, rows - 2);
  const cellOf = (i: number, j: number) => j * nx + i;
  const ij = (cell: number) => ({ i: cell % nx, j: Math.floor(cell / nx) });
  const beside = (cell: number): number[] => {
    const { i, j } = ij(cell);
    return [i > 0 ? cellOf(i - 1, j) : -1, i < nx - 1 ? cellOf(i + 1, j) : -1, j > 0 ? cellOf(i, j - 1) : -1, j < ny - 1 ? cellOf(i, j + 1) : -1].filter((c) => c >= 0);
  };
  const startCell = cellOf(0, Math.floor(ny / 2));
  // The great hall: the last two rooms of a row, made one. Not the row the party comes in by, where that would put it next door.
  const hallRow = rng.pick(Array.from({ length: ny }, (_, j) => j).filter((j) => nx > 3 || ny === 1 || j !== Math.floor(ny / 2)));
  const [hallA, hallB] = [cellOf(nx - 2, hallRow), cellOf(nx - 1, hallRow)];
  // A tree over every room, grown from the way in; then the dead ends are pruned back until the place is the size wanted.
  const linked: [number, number][] = [];
  {
    const inTree = new Set([startCell]);
    while (inTree.size < nx * ny) {
      const edges: [number, number][] = [];
      for (const a of inTree) for (const b of beside(a)) if (!inTree.has(b)) edges.push([a, b]);
      const [a, b] = rng.pick(edges);
      inTree.add(b);
      linked.push([a, b]);
    }
  }
  const isLink = (a: number, b: number) => linked.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (!isLink(hallA, hallB)) linked.push([hallA, hallB]);
  const kept = new Set(Array.from({ length: nx * ny }, (_, c) => c));
  const want = Math.max(4, Math.min(nx * ny, Math.max(options.groups + 2, Math.round(nx * ny * 0.75))));
  const degree = (c: number) => linked.filter(([a, b]) => a === c || b === c).length;
  for (let tries = 0; kept.size > want && tries < 60; tries++) {
    const leaves = [...kept].filter((c) => c !== startCell && c !== hallA && c !== hallB && degree(c) === 1);
    if (leaves.length === 0) break;
    const gone = rng.pick(leaves);
    kept.delete(gone);
    linked.splice(linked.findIndex(([a, b]) => a === gone || b === gone), 1);
  }
  // A second way round, here and there: somewhere to come at a held doorway from behind.
  {
    const loops: [number, number][] = [];
    for (const a of kept) for (const b of beside(a)) if (a < b && kept.has(b) && !isLink(a, b) && a !== startCell && b !== startCell) loops.push([a, b]);
    for (let i = 0; i < (nx >= 4 ? 2 : 1) && loops.length > 0; i++) linked.push(loops.splice(rng.int(0, loops.length - 1), 1)[0]);
  }
  // The hall's two cells are one room from here on: the second goes by the first's name.
  const roomOf = (cell: number) => (cell === hallB ? hallA : cell);
  const depth = new Map<number, number>([[startCell, 0]]);
  {
    const queue = [startCell];
    for (let k = 0; k < queue.length; k++) {
      for (const [a, b] of linked) {
        const next = a === queue[k] ? b : b === queue[k] ? a : -1;
        if (next < 0 || depth.has(next)) continue;
        depth.set(next, depth.get(queue[k])! + (roomOf(next) === roomOf(queue[k]) ? 0 : 1));
        queue.push(next);
      }
    }
  }
  const rooms = new Map<number, Room>();
  for (const cell of kept) {
    if (cell === hallB) continue;
    rooms.set(cell, { cell, centre: { q: 0, r: 0 }, floor: [], doors: [], links: 0, depth: depth.get(cell) ?? 0, posts: [], chests: [], ...(cell === startCell ? { start: true } : {}), ...(cell === hallA ? { hall: true } : {}) });
  }
  const doorways = linked.filter(([a, b]) => roomOf(a) !== roomOf(b));
  for (const [a, b] of doorways) {
    rooms.get(roomOf(a))!.links++;
    rooms.get(roomOf(b))!.links++;
  }
  /** The floor of a cell, in columns and rows. */
  const bounds = (cell: number) => {
    const { i, j } = ij(cell);
    return { x0: bx[i] + 1, x1: bx[i + 1] - 1, y0: by[j] + 1, y1: by[j + 1] - 1 };
  };
  const hallBounds = { ...bounds(hallA), x1: bounds(hallB).x1 };
  const boundsOf = (room: Room) => (room.hall ? hallBounds : bounds(room.cell));
  const nearest = (list: HexPos[], to: HexPos) => [...list].sort((a, b) => hexDistance(a, to) - hexDistance(b, to))[0];
  let start: HexPos = { q: 0, r: 0 };
  /** Holes in a cave's floor: no ground, and no wall grown over them. */
  const holes = new Set<string>();

  if (halls) {
    // ---------- halls: floors, walls, doorways ----------

    for (const room of rooms.values()) {
      const { x0, x1, y0, y1 } = boundsOf(room);
      for (let r = y0 - 1; r <= y1 + 1; r++) {
        for (let c = x0 - 1; c <= x1 + 1; c++) {
          const edge = r < y0 || r > y1 || c < x0 || c > x1;
          const p = H(c, r);
          if (edge) {
            if (!at(p)) lay(p, { prop: "wall" });
          } else if (lay(p, {})) room.floor.push(p);
        }
      }
      room.centre = nearest(room.floor, H(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)));
    }
    // A doorway through the wall two rooms share; into the great hall, two hexes wide.
    for (const [a, b] of doorways) {
      const [A, B] = [ij(a), ij(b)];
      const wide = roomOf(a) === hallA || roomOf(b) === hallA;
      const through: HexPos[] = [];
      if (A.j === B.j) {
        const x = bx[Math.max(A.i, B.i)];
        const { y0, y1 } = bounds(a);
        const r = Math.max(y0, Math.min(y1 - (wide ? 1 : 0), Math.round((y0 + y1) / 2) + rng.int(-1, 1)));
        through.push(H(x, r), ...(wide ? [H(x, r + 1)] : []));
      } else {
        const y = by[Math.max(A.j, B.j)];
        const { x0, x1 } = bounds(a);
        const c = Math.max(x0 + 1, Math.min(x1 - 1 - (wide ? 1 : 0), Math.round((x0 + x1) / 2) + rng.int(-2, 2)));
        through.push(H(c, y), ...(wide ? [H(c + 1, y)] : []));
      }
      for (const p of through) {
        lay(p, { prop: "arch" });
        rooms.get(roomOf(a))!.doors.push(p);
        rooms.get(roomOf(b))!.doors.push(p);
        reserved.add(posKey(p));
        for (const n of around(p)) reserved.add(posKey(n));
      }
    }
    const isWall = (p: HexPos) => at(p)?.prop === "wall";
    const wallside = (room: Room) => room.floor.filter((p) => around(p).some(isWall));
    const inner = (room: Room) => room.floor.filter((p) => !around(p).some(isWall));
    const some = (list: HexPos[], n: number, prop: string) => {
      const pool = [...list];
      for (let k = 0; k < n && pool.length > 0; ) if (stand(pool.splice(rng.int(0, pool.length - 1), 1)[0], prop)) k++;
    };

    // Where the party comes in: the ring against the near wall, and open floor before it.
    {
      const room = rooms.get(startCell)!;
      const { x0, y0, y1 } = bounds(startCell);
      const cy = Math.round((y0 + y1) / 2);
      start = H(x0 + 1, cy);
      for (const p of disk(start, 2)) reserved.add(posKey(p));
      const gate = at(H(x0, cy));
      if (gate) gate.prop = "waygate";
      some(wallside(room).filter((p) => hexDistance(p, start) > 3), 2, "barrels");
      some(wallside(room).filter((p) => hexDistance(p, start) > 2), 2, "banner");
    }

    // The great hall: pillars down both sides, a rug up the middle, and at the far end a dais with the high seat.
    {
      const room = rooms.get(hallA)!;
      const { x0, x1, y0, y1 } = hallBounds;
      const cy = Math.round((y0 + y1) / 2);
      for (let c = x1 - 2; c <= x1; c++) for (let r = y0; r <= y1; r++) lay(H(c, r), { elev: 1 });
      stand(H(x1, cy), siteId === "crypt" ? "sarcophagus" : "throne");
      stand(H(x1, y0), "banner");
      stand(H(x1, y1), "banner");
      stand(H(x1 - 2, y0), "brazier");
      stand(H(x1 - 2, y1), "brazier");
      const sides = y1 - y0 >= 4 ? [y0 + 1, y1 - 1] : [y0, y1];
      for (let c = x0 + 1; c <= x1 - 4; c += 3) for (const r of sides) stand(H(c, r), siteId === "crypt" && rng.chance(0.3) ? "pillar_broken" : "pillar");
      for (let c = x0; c <= x1 - 3; c++) stand(H(c, cy), "rug");
      room.posts.push({ pos: H(x1 - 1, cy), role: "heavy" });
      for (const [dc, dr] of [[-3, 0], [-3, -1], [-3, 1], [-4, 0], [-5, -1], [-5, 1], [-4, -1], [-4, 1]]) room.posts.push({ pos: H(x1 + dc, cy + dr), role: "front" });
      for (const [dc, r] of [[-1, y0 + 1], [-1, y1 - 1], [-2, y0 + 1], [-2, y1 - 1]]) room.posts.push({ pos: H(x1 + dc, r), role: "shot" });
      room.chests.push(H(x1, cy + 1 <= y1 ? cy + 1 : cy - 1));
      // What the chief band guards is counted from the dais, not the middle of the floor.
      room.centre = H(x1 - 3, cy);
    }

    // The rooms between, each to its use.
    const uses = siteId === "crypt" ? ["tombs", "tombs", "chapel", "gallery", "tombs", "store"] : ["guard", "library", "gallery", "chapel", "store", "guard", "gallery"];
    // High, broken ground, under a roof: more of the rooms have a gallery.
    if (options.elevation >= 3) uses.splice(1, 0, "gallery", "gallery");
    let turn = rng.int(0, uses.length - 1);
    for (const room of [...rooms.values()].sort((a, b) => a.cell - b.cell)) {
      if (room.start || room.hall) continue;
      const { x0, x1, y0, y1 } = bounds(room.cell);
      const [cx, cy] = [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)];
      let use = uses[turn++ % uses.length];
      if (use === "gallery") {
        // A gallery two levels up along a side with no doorway in it, steps up to it, and a ladder at its other end.
        const { i, j } = ij(room.cell);
        const doorOn = (line: "x0" | "x1" | "y0" | "y1") => room.doors.some((d) => (line === "x0" ? colOf(d) === bx[i] : line === "x1" ? colOf(d) === bx[i + 1] : line === "y0" ? d.r === by[j] : d.r === by[j + 1]));
        const strip = (s: "x0" | "x1" | "y0" | "y1") => room.floor.filter((p) => (s === "x1" ? colOf(p) >= x1 - 1 : s === "x0" ? colOf(p) <= x0 + 1 : s === "y0" ? p.r <= y0 + 1 : p.r >= y1 - 1));
        // (Nor one a doorway in another wall opens right beside: it would open onto the foot of a cliff.)
        const side = (["x1", "x0", "y0", "y1"] as const).find((s) => !doorOn(s) && (s === "x0" || s === "x1" ? x1 - x0 >= 5 : y1 - y0 >= 4) && !strip(s).some((u) => room.doors.some((d) => hexDistance(u, d) <= 1)));
        if (!side) use = "guard";
        else {
          const up = strip(side);
          for (const p of up) lay(p, { elev: 2 });
          const front = room.floor.filter((p) => elev(p) === 0 && around(p).some((n) => elev(n) === 2 && at(n)?.prop !== "wall"));
          const steps = nearest(front, room.centre);
          if (steps) {
            lay(steps, { elev: 1, prop: "stairs" });
            reserved.add(posKey(steps));
            for (const n of around(steps)) reserved.add(posKey(n));
            const foot = [...front].filter((p) => !same(p, steps)).sort((a, b) => hexDistance(b, steps) - hexDistance(a, steps))[0];
            const top = foot ? around(foot).find((n) => elev(n) === 2 && walk(n)) : undefined;
            if (foot && top) ladder(foot, top);
          }
          for (const p of up) room.posts.push({ pos: p, role: "shot" });
          some(up.filter((p) => around(p).some(isWall)), 2, "banner");
          some(wallside(room).filter((p) => elev(p) === 0), 2, "weapon_rack");
          some(inner(room).filter((p) => elev(p) === 0), 1, "brazier");
        }
      }
      if (use === "guard") {
        // Tables down the middle, arms racked along the walls, a fire.
        for (const c of [cx - 1, cx, cx + 2]) stand(H(c, cy), "table");
        some(wallside(room), 3, "weapon_rack");
        some(wallside(room), 2, "barrels");
        some(inner(room), 1, "brazier");
      } else if (use === "library") {
        // Shelves in rows, an aisle across the middle.
        for (let c = x0 + 1; c <= x1 - 1; c += 2) for (let r = y0; r <= y1; r++) if (r !== cy) stand(H(c, r), "bookshelf");
        for (let c = x0; c <= x1; c++) stand(H(c, cy), "rug");
        some(wallside(room), 1, "table");
      } else if (use === "chapel") {
        // An altar against the far wall between two statues, fires before it, a pillar toward each corner.
        stand(H(x1, cy), "altar");
        stand(H(x1, y0), "statue");
        stand(H(x1, y1), "statue");
        stand(H(x1 - 1, cy - 1), "brazier");
        stand(H(x1 - 1, cy + 1), "brazier");
        for (const [c, r] of [[x0 + 1, y0 + 1], [x0 + 1, y1 - 1], [x1 - 2, y0 + 1], [x1 - 2, y1 - 1]]) stand(H(c, r), "pillar");
        for (let c = x0; c <= x1 - 2; c++) stand(H(c, cy), "rug");
      } else if (use === "store") {
        some(wallside(room), 5, "barrels");
        some(wallside(room), 2, "cage");
        some(inner(room), 1, "table");
      } else if (use === "tombs") {
        // The dead in two rows, a figure watching over them, and what the rats left.
        const ranks = y1 - y0 >= 4 ? [y0 + 1, y1 - 1] : [y0, y1];
        for (let c = x0 + 1; c <= x1 - 1; c += 2) for (const r of ranks) stand(H(c, r), "sarcophagus");
        stand(H(x1, cy), "statue");
        some(room.floor, 4, "bones");
        some(inner(room), 1, "brazier");
      }
      // And whatever else the place has lying about.
      for (let k = 0; k < 1 + options.obstacles; k++) some(rng.chance(0.5) ? wallside(room) : inner(room), 1, rng.pick(site.scatter));
      // A dead end keeps something worth the walk, against its far wall.
      if (room.links === 1 && room.doors.length > 0) {
        const spot = wallside(room).filter((p) => walk(p) && !reserved.has(posKey(p)) && spare(p)).sort((a, b) => hexDistance(b, room.doors[0]) - hexDistance(a, room.doors[0]))[0];
        if (spot) room.chests.push(spot);
      }
    }
    // Torches in brackets along the walls, where a wall has floor to light: one to every four hexes of a run, never
    // on a corner (where a wall along a row meets one down a column) and never right beside a doorway.
    const walled = (p: HexPos) => at(p)?.prop === "wall" || at(p)?.prop === "wall_torch" || at(p)?.prop === "arch";
    for (const t of tiles.values()) {
      if (t.prop !== "wall" || !around(t).some(walk)) continue;
      const along = walled(H(colOf(t) - 1, t.r)) || walled(H(colOf(t) + 1, t.r));
      const down = around(t).some((n) => n.r !== t.r && walled(n));
      if ((along && down) || around(t).some((n) => at(n)?.prop === "arch")) continue;
      if ((along ? colOf(t) + t.r : t.r + colOf(t) * 3) % 4 === 0) t.prop = "wall_torch";
    }
  } else {
    // ---------- caves: chambers, tunnels, and what the water did ----------

    const wavy = (() => {
      const salt = seedFromString(`cave|${seed}`);
      return (p: HexPos) => {
        let n = Math.imul(p.q, 374761393) ^ Math.imul(p.r, 668265263) ^ Math.imul(salt | 0, 1442695041);
        n = Math.imul(n ^ (n >>> 13), 1274126177);
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
      };
    })();
    /** Room for floor: two hexes of rock fit between it and the edge of the grid. */
    const roomFor = (p: HexPos) => p.r >= 3 && p.r <= rows - 4 && colOf(p) >= 3 && colOf(p) <= maxCol - 2;
    const floor = (p: HexPos): boolean => {
      if (!roomFor(p)) return false;
      if (!at(p)) lay(p, { biome: "cave" });
      return true;
    };
    const tunnels = new Set<string>();
    const radius = new Map<number, number>();
    for (const room of rooms.values()) {
      const { x0, x1, y0, y1 } = boundsOf(room);
      const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
      const r = room.hall ? Math.min(5.4, h / 2 + 1.2) : Math.min(Math.min(w, h) / 2 + 0.4, 2.5 + rng.next() * 1.3);
      // The biggest chamber sits toward the far end of its two cells; the rest wander a little in theirs.
      const cx = room.hall ? x1 - r - 0.5 : (x0 + x1) / 2 + (rng.next() - 0.5) * Math.max(0, w - 2 * r);
      const cy = (y0 + y1) / 2 + (rng.next() - 0.5) * Math.max(0, h - 2 * r);
      const c = H(Math.round(cx), Math.round(cy));
      radius.set(room.cell, r);
      const [px, py] = [page(c).x, page(c).y];
      for (const p of disk(c, Math.ceil(r) + 1)) {
        const d = Math.hypot(page(p).x - px, page(p).y - py);
        // (Where two chambers run together, the ground is the first one's.)
        if ((d <= 1 || d < r * (0.78 + 0.4 * wavy(p))) && !at(p) && floor(p)) room.floor.push(p);
      }
      room.centre = nearest(room.floor, c) ?? c;
      floor(room.centre);
    }
    // A tunnel from the middle of one chamber to the middle of the next, wandering, a hex wide and sometimes two.
    for (const [a, b] of doorways) {
      const [A, B] = [rooms.get(roomOf(a))!, rooms.get(roomOf(b))!];
      const n = hexDistance(A.centre, B.centre) * 2;
      const bend = (rng.next() - 0.5) * 3;
      const between: HexPos[] = [];
      let last: HexPos | null = null;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const sway = Math.sin(t * Math.PI) * bend;
        const straight = roundHex(A.centre.q + (B.centre.q - A.centre.q) * t, A.centre.r + (B.centre.r - A.centre.r) * t);
        const bent = roundHex(A.centre.q + (B.centre.q - A.centre.q) * t - sway / 2, A.centre.r + (B.centre.r - A.centre.r) * t + sway);
        // Where the bend would leave the rock (or skip a hex), the straight way is taken.
        const p: HexPos = roomFor(bent) && (!last || hexDistance(last, bent) <= 1) ? bent : straight;
        if (last && hexDistance(last, p) > 1) for (const mid of around(last)) if (hexDistance(mid, p) <= 1 && floor(mid)) { tunnels.add(posKey(mid)); break; }
        if (!floor(p)) continue;
        // The whole of the way, from the middle of one chamber to the middle of the next, is kept clear and level.
        tunnels.add(posKey(p));
        if (!A.floor.some((f) => same(f, p)) && !B.floor.some((f) => same(f, p))) {
          between.push(p);
          if (rng.chance(0.4)) {
            const wide = rng.pick(around(p));
            if (floor(wide)) tunnels.add(posKey(wide));
          }
        }
        last = p;
      }
      // Its two mouths: the first and last of it that are in neither chamber.
      A.doors.push(between[0] ?? B.centre);
      B.doors.push(between[between.length - 1] ?? A.centre);
    }
    for (const key of tunnels) reserved.add(key);
    for (const room of rooms.values()) for (const d of room.doors) for (const p of [d, ...around(d)]) reserved.add(posKey(p));

    // Where the party comes in: the ring at the near side of the first chamber.
    {
      const room = rooms.get(startCell)!;
      start = room.centre;
      for (const p of disk(start, 2)) reserved.add(posKey(p));
      const gate = around(start).filter((p) => walk(p) && !tunnels.has(posKey(p)) && spare(p)).sort((a, b) => page(a).x - page(b).x)[0] ?? around(start).filter((p) => walk(p) && spare(p))[0];
      if (gate) at(gate)!.prop = "waygate";
    }

    const free = (room: Room) => room.floor.filter((p) => walk(p) && !reserved.has(posKey(p)) && !at(p)!.prop && !at(p)!.ladder);
    for (const room of [...rooms.values()].sort((a, b) => a.cell - b.cell)) {
      const r = radius.get(room.cell) ?? 3;
      const [px, py] = [page(room.centre).x, page(room.centre).y];
      if (!room.start) {
        // A shelf two levels up at the back of it, away from the way in, with a ladder (two, on a long one).
        if (r >= 3 && (room.hall || rng.chance(0.25 + 0.15 * options.elevation))) {
          const door = room.doors[0] ?? start;
          const [dx, dy] = [px - page(door).x, py - page(door).y];
          const len = Math.hypot(dx, dy) || 1;
          const up = room.floor.filter((p) => at(p) && !reserved.has(posKey(p)) && ((page(p).x - px) * dx + (page(p).y - py) * dy) / len > r * (room.hall ? 0.45 : 0.3));
          for (const p of up) at(p)!.elev = 2;
          const feet = room.floor.filter((p) => elev(p) === 0 && walk(p) && around(p).some((n) => elev(n) === 2 && at(n)?.biome === "cave"));
          const first = nearest(feet, room.centre);
          const foots = first ? [first, ...(up.length >= 10 ? [[...feet].sort((a, b) => hexDistance(b, first) - hexDistance(a, first))[0]] : [])] : [];
          for (const foot of foots) {
            const top = around(foot).find((n) => elev(n) === 2 && at(n)?.biome === "cave");
            if (top) {
              ladder(foot, top);
              reserved.add(posKey(foot));
              reserved.add(posKey(top));
            }
          }
          // A shelf nothing climbs to is no shelf.
          if (foots.length === 0) for (const p of up) at(p)!.elev = 0;
          else for (const p of up) room.posts.push({ pos: p, role: "shot" });
        }
        // A hole in the floor, off to one side: nothing under it.
        if (r >= 3 && rng.chance(room.hall ? 0.8 : 0.4)) {
          const from = free(room).filter((p) => elev(p) === 0 && hexDistance(p, room.centre) >= 2);
          let p: HexPos | undefined = from.length > 0 ? rng.pick(from) : undefined;
          for (let k = 0; p && k < rng.int(3, 6); k++) {
            if (walk(p) && !reserved.has(posKey(p)) && elev(p) === 0 && spare(p)) {
              tiles.delete(posKey(p));
              holes.add(posKey(p));
            }
            const next: HexPos[] = around(p).filter((n) => walk(n) && !reserved.has(posKey(n)) && room.floor.some((f) => same(f, n)));
            p = next.length > 0 ? rng.pick(next) : undefined;
          }
        }
        // Standing water (in the ashlands, something hotter).
        if (rng.chance(site.water * 0.8)) {
          const from = free(room).filter((p) => elev(p) === 0);
          let p: HexPos | undefined = from.length > 0 ? rng.pick(from) : undefined;
          for (let k = 0; p && k < rng.int(3, 5); k++) {
            if (walk(p) && !reserved.has(posKey(p)) && !at(p)!.prop && spare(p)) lay(p, { biome: "water" });
            const next: HexPos[] = around(p).filter((n) => walk(n) && elev(n) === 0 && !reserved.has(posKey(n)) && room.floor.some((f) => same(f, n)));
            p = next.length > 0 ? rng.pick(next) : undefined;
          }
        }
      }
      // What stands about: rock grown up from the floor, and the place's own.
      const things = Math.round(1 + room.floor.length / 14) + options.obstacles;
      for (let k = 0; k < things; k++) {
        const pool = free(room);
        if (pool.length === 0) break;
        const prop = rng.pick(site.scatter);
        let p: HexPos | undefined = rng.pick(pool);
        for (let m = 0; p && m < (prop === "stalagmite" || prop === "boulder" || prop === "mushrooms" || prop === "bones" ? rng.int(1, 3) : 1); m++) {
          stand(p, prop);
          const next: HexPos[] = around(p).filter((n) => free(room).some((f) => same(f, n)));
          p = next.length > 0 ? rng.pick(next) : undefined;
        }
      }
      // Cold light in every one of them: a chamber with none is black.
      if (!room.start) {
        const pool = free(room);
        if (pool.length > 0) stand(rng.pick(pool), "crystal");
      }
      if (room.hall) {
        // The end of it. In a hollow: the skull and ribs of what was eaten here, and bones everywhere.
        const back = [...free(room)].sort((a, b) => page(b).x - page(a).x)[0];
        if (siteId === "hollow") {
          if (back) stand(back, "skull");
          const pool = free(room).filter((p) => hexDistance(p, room.centre) >= 2);
          for (let k = 0; k < 4 && pool.length > 0; k++) stand(pool.splice(rng.int(0, pool.length - 1), 1)[0], "ribs");
          for (let k = 0; k < 8; k++) {
            const lie = free(room);
            if (lie.length > 0) stand(rng.pick(lie), "bones");
          }
        } else {
          const pool = free(room).filter((p) => hexDistance(p, room.centre) >= 3);
          for (let k = 0; k < 3 && pool.length > 0; k++) stand(pool.splice(rng.int(0, pool.length - 1), 1)[0], "crystal");
        }
        room.posts.unshift({ pos: room.centre, role: "heavy" });
        for (const p of around(room.centre)) room.posts.push({ pos: p, role: "front" });
        // The hoard at the back of it, on whatever lies there that can be walked over.
        const hoard = room.floor.filter((p) => walk(p) && !reserved.has(posKey(p)) && !at(p)!.ladder && !room.posts.some((o) => same(o.pos, p)) && spare(p)).sort((a, b) => page(b).x - page(a).x)[0];
        if (hoard) {
          delete at(hoard)!.prop;
          room.chests.push(hoard);
        }
      } else if (!room.start && room.links === 1) {
        const door = room.doors[0] ?? room.centre;
        const spot = free(room).filter((p) => spare(p)).sort((a, b) => hexDistance(b, door) - hexDistance(a, door))[0];
        if (spot) room.chests.push(spot);
      }
    }
    // The rock round it all, two hexes thick.
    for (const t of [...tiles.values()]) {
      if (t.biome === "rock") continue;
      for (const p of disk(t, 2)) if (!at(p) && !holes.has(posKey(p)) && onGrid(p)) tiles.set(posKey(p), { q: p.q, r: p.r, biome: "rock", h: 0, elev: MAX_ELEV });
    }
  }

  // ---------- who holds it ----------

  const far = (p: HexPos) => hexDistance(p, start);
  const taken = new Set<string>();
  const chestKeys = new Set<string>();
  for (const room of rooms.values()) {
    room.chests = room.chests.filter((p) => walk(p) && !chestKeys.has(posKey(p)) && !at(p)!.prop && !at(p)!.ladder);
    for (const p of room.chests) chestKeys.add(posKey(p));
  }
  const standable = (p: HexPos) => walk(p) && at(p)!.prop !== "arch" && at(p)!.prop !== "stairs" && !at(p)!.ladder && !chestKeys.has(posKey(p)) && !taken.has(posKey(p)) && far(p) > Math.max(3, options.clear + 1);
  const size = Math.max(2, Math.min(8, options.party + threatExtras(options.threat) + mods.extras + (options.party >= 3 ? 1 : 0)));
  const factions = factionsOf(siteId, clime);
  const groups: (LaidGroup & { room: number })[] = [];
  const bandFor = (i: number): { kind: string; role: Role }[] => {
    const lead = options.kinds.length > 0 ? options.kinds[i % options.kinds.length] : null;
    const faction = factions[i % factions.length];
    if (!lead) return bandOf(faction, size, rng.pick);
    if (lead === "dummy") return [{ kind: "dummy", role: "front" }];
    if (ENEMIES[lead]?.boss) {
      if (groups.some((g) => g.kinds.includes(lead))) return bandOf(faction, size, rng.pick);
      return [{ kind: lead, role: "heavy" }, ...bandOf(faction, Math.max(1, size - 1), rng.pick).filter((m) => m.role !== "heavy")];
    }
    return Array.from({ length: size }, (_, k) => ({ kind: lead, role: (k > 0 && k % 3 === 2 ? "shot" : "front") as Role }));
  };
  // The chief band in the great hall; then a band to a room, the deepest first, and a second to the biggest once every room has one.
  const others = [...rooms.values()].filter((room) => !room.start && !room.hall).sort((a, b) => b.depth - a.depth || a.cell - b.cell);
  const order = [rooms.get(hallA)!, ...others, ...[...others].sort((a, b) => b.floor.length - a.floor.length)];
  for (let i = 0; i < options.groups && i < order.length; i++) {
    const room = order[i];
    const near = [...room.floor].sort((a, b) => hexDistance(a, room.centre) - hexDistance(b, room.centre));
    const kinds: string[] = [];
    const posts: HexPos[] = [];
    for (const member of bandFor(i)) {
      const mine = room.posts.find((o) => o.role === member.role && standable(o.pos));
      const spot = mine?.pos ?? (member.role === "shot" ? near.filter(standable).sort((a, b) => elev(b) - elev(a) || hexDistance(a, room.centre) - hexDistance(b, room.centre))[0] : near.find(standable));
      if (!spot) continue;
      taken.add(posKey(spot));
      kinds.push(member.kind);
      posts.push({ q: spot.q, r: spot.r });
    }
    if (kinds.length > 0) groups.push({ id: `band${i + 1}`, kinds, posts, room: room.cell });
  }

  // ---------- chests ----------

  const pois: Poi[] = [];
  for (const room of [rooms.get(hallA)!, ...others]) {
    const guard = groups.find((g) => g.room === room.cell)?.id;
    for (const p of room.chests) {
      if (taken.has(posKey(p))) continue;
      pois.push({ id: `chest${pois.length + 1}`, kind: "cache", pos: { q: p.q, r: p.r }, hidden: false, cleared: false, usedBy: [], enemies: [], loot: room.hall ? "vault" : "chest", ...(guard ? { guard } : {}) });
    }
  }

  // ---------- ways ----------

  // Everything was laid so it can be walked to. What still cannot (a shelf whose ladder was lost to a pool) is nobody's post.
  {
    const open = (p: HexPos) => walk(p) && !chestKeys.has(posKey(p));
    const seen = new Set([posKey(start)]);
    const queue = [start];
    for (let k = 0; k < queue.length; k++) {
      for (const n of around(queue[k])) {
        if (seen.has(posKey(n)) || !open(n) || (Math.abs(elev(queue[k]) - elev(n)) > 1 && !laddered(queue[k], n))) continue;
        seen.add(posKey(n));
        queue.push(n);
      }
    }
    for (const g of groups) {
      const keep = g.posts.map((p) => seen.has(posKey(p)));
      g.kinds = g.kinds.filter((_, i) => keep[i]);
      g.posts = g.posts.filter((_, i) => keep[i]);
    }
    for (let i = pois.length - 1; i >= 0; i--) if (!around(pois[i].pos).some((n) => seen.has(posKey(n)))) pois.splice(i, 1);
    // The place always has its hoard: where the far end had no room for one, it stands as deep in as anything can be walked to.
    if (!pois.some((p) => p.loot === "vault")) {
      const hall = rooms.get(hallA)!;
      const spot = [...hall.floor, ...others.flatMap((room) => room.floor)]
        .filter((p) => seen.has(posKey(p)) && !taken.has(posKey(p)) && !chestKeys.has(posKey(p)) && !reserved.has(posKey(p)) && !propOf(at(p))?.blocks && at(p)!.prop !== "arch" && at(p)!.prop !== "stairs" && !at(p)!.ladder && spare(p))
        .sort((a, b) => Number(hall.floor.includes(b)) - Number(hall.floor.includes(a)) || far(b) - far(a))[0];
      const guard = groups.find((g) => g.room === hallA && g.kinds.length > 0)?.id;
      if (spot) {
        delete at(spot)!.prop;
        pois.push({ id: `chest${pois.length + 1}`, kind: "cache", pos: { q: spot.q, r: spot.r }, hidden: false, cleared: false, usedBy: [], enemies: [], loot: "vault", ...(guard ? { guard } : {}) });
      }
    }
  }

  // ---------- the finish ----------

  for (const t of tiles.values()) {
    t.elev = Math.max(0, Math.min(MAX_ELEV, t.elev ?? 0));
    // Rock on the near side of a floor (the side the view looks in from) stands lower, so it does not hide the floor behind it.
    const near = t.biome === "rock" && [H(colOf(t), t.r - 1), H(colOf(t) + (t.r % 2 === 0 ? -1 : 1), t.r - 1)].some((n) => !!at(n) && at(n)!.biome !== "rock");
    t.h = t.biome === "water" ? 0.05 : t.biome === "rock" ? (near ? 1.5 + rng.next() * 0.3 : 2.2 + rng.next() * 0.7) : 0.3 + t.elev * 0.42 + rng.next() * (t.biome === "cave" ? 0.05 : 0.01);
    if (clime) t.clime = clime;
    if (!t.ladder) delete t.ladder;
  }
  let surfaces: Record<string, GroundSurface> | undefined;
  if (mods.hazard) {
    const dice = makeRng(seedFromString(`ground|${seed}`));
    const posts = groups.flatMap((g) => g.posts);
    const fits = (p: HexPos) => walk(p) && !at(p)!.prop && far(p) > 3 && !posts.some((o) => hexDistance(o, p) <= 1);
    const pool = [...rooms.values()].filter((room) => !room.start).flatMap((room) => room.floor);
    surfaces = {};
    for (let i = 0; i < HAZARD_PATCHES * mods.patches && pool.length > 0; i++) {
      const c = dice.pick(pool);
      for (const p of disk(c, 1)) if (fits(p) && dice.chance(0.8)) surfaces[posKey(p)] = { kind: mods.hazard, rounds: LASTING_ROUNDS, by: null, lasting: true };
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
