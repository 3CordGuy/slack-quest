// The scenery lab: a dev-only map for looking at what stands on a zone's
// hexes (render/zoneScenery.ts) and what lies round it (render/backdrop.ts).
// Opened at #lab/scenery on the dev server.
//
// One hand-laid map carries every kind of thing a hex can carry: a walled
// courtyard with towers and a gate, a pillared hall on a paved platform with
// a dais at its head, a palisaded camp, a waygate, a rib cage with its skull,
// crystals, terraces of high ground with ladders up them. Buttons switch its
// climate, its backdrop and the hour. Two more maps are places under a roof
// and under ground, as the `dark` backdrop draws them: a hall (walled rooms
// with doorways, torches on the walls, a pillared great hall with a throne
// on its dais, a gallery, a library and a crypt) and a cave (chambers of
// living rock joined by a tunnel, a pit with a bridge over it, a pool, a
// ledge, a den full of bones). Click a hex to walk the hero there, for
// a sense of scale.
//
// Nothing here touches the server or a game being played.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { BASE_HEIGHT, CLIMES, HERO_CLASSES, type Biome, type Clime, type Tile, type WorldMap } from "@gantt-quest/world";
import { devTools } from "./devTools";
import type { BackdropKind } from "./render/backdrop";
import { fancy } from "./render/fancy";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";

const COLS = 24;
const ROWS = 18;
const BACKDROPS: BackdropKind[] = ["sea", "mist", "abyss", "lava", "frost", "dusk", "dark"];
type Place = "outdoors" | "hall" | "cave";
const PLACES: Place[] = ["outdoors", "hall", "cave"];
const KEPT = "gq:lab:scenery";
const HOURS: [string, number | undefined][] = [["Clock", undefined], ["Noon", 0.5], ["Dusk", 0.74], ["Night", 0.02]];

const hash = (q: number, r: number, salt: number) => {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The sample map, laid by column and row (odd rows stand half a hex to the right). */
function sampleMap(clime: Clime): WorldMap {
  type Cell = { biome: Biome; elev: number; prop?: string; ladder?: number; keep?: boolean };
  const cells = new Map<string, Cell>();
  const id = (c: number, r: number) => `${c},${r}`;
  const inside = (c: number, r: number) => r >= 0 && r < ROWS && c >= 0 && c < (r % 2 ? COLS - 1 : COLS);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (inside(c, r)) cells.set(id(c, r), { biome: hash(c, r, 5) < 0.16 ? "forest" : "plains", elev: 0 });
  const fill = (c0: number, r0: number, c1: number, r1: number, biome: Biome, elev: number) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (inside(c, r)) cells.set(id(c, r), { biome, elev, keep: true });
  };
  const put = (c: number, r: number, prop: string) => {
    const cell = cells.get(id(c, r));
    if (cell) Object.assign(cell, { prop, keep: true, ...(cell.biome === "forest" ? { biome: "plains" as Biome } : {}) });
  };
  const row = (c0: number, c1: number, r: number, prop: string) => {
    for (let c = c0; c <= c1; c++) put(c, r, prop);
  };
  /** The six neighbours of a cell, in the world's HEX_DIRS order: up-right, right, down-right, down-left, left, up-left. */
  const beside = (c: number, r: number) => (r % 2 ? [[c + 1, r - 1], [c + 1, r], [c + 1, r + 1], [c, r + 1], [c - 1, r], [c, r - 1]] : [[c, r - 1], [c + 1, r], [c, r + 1], [c - 1, r + 1], [c - 1, r], [c - 1, r - 1]]);
  /** A ladder on (c, r) up to the neighbour (tc, tr). */
  const ladder = (c: number, r: number, tc: number, tr: number) => {
    const side = beside(c, r).findIndex(([nc, nr]) => nc === tc && nr === tr);
    const cell = cells.get(id(c, r));
    if (cell && side >= 0) Object.assign(cell, { ladder: (cell.ladder ?? 0) | (1 << side), keep: true, biome: cell.biome === "forest" ? "plains" : cell.biome });
  };

  // ---- a walled courtyard: towers at the corners, a gate in the south wall ----
  fill(1, 1, 8, 7, "paved", 0);
  row(1, 8, 1, "wall");
  row(1, 8, 7, "wall");
  for (let r = 2; r <= 6; r++) {
    put(1, r, "wall");
    put(8, r, r === 4 ? "wall_broken" : r === 5 ? "wall_broken" : "wall");
  }
  for (const [c, r] of [[1, 1], [8, 1], [1, 7], [8, 7]]) put(c, r, "tower");
  put(4, 7, "arch");
  put(6, 1, "wall_broken");
  put(4, 3, "well");
  put(6, 3, "statue");
  put(2, 5, "barrels");
  put(6, 5, "cart");
  put(3, 6, "banner");
  put(5, 6, "banner");
  put(2, 2, "brazier");

  // ---- a pillared hall on a platform two levels up, a dais two more at its head ----
  fill(11, 1, 17, 6, "paved", 2);
  fill(13, 1, 15, 2, "paved", 4);
  put(14, 1, "altar");
  put(13, 1, "brazier");
  put(15, 1, "brazier");
  put(11, 1, "statue");
  put(17, 1, "statue");
  put(14, 3, "stairs");
  for (const r of [2, 4, 6]) {
    put(12, r, "pillar");
    put(16, r, r === 4 ? "pillar_broken" : "pillar");
  }
  put(13, 5, "brazier");
  put(15, 5, "brazier");
  put(11, 5, "obelisk");
  put(14, 7, "stairs");
  put(12, 7, "statue");
  put(16, 7, "statue");
  ladder(10, 3, 11, 3);
  ladder(18, 4, 17, 4);
  put(11, 8, "pillar_broken");
  put(17, 8, "wall_broken");
  put(18, 8, "wall_broken");

  // ---- high ground: two terraces of rock and grass, ladders up each ----
  fill(19, 0, 23, 7, "plains", 2);
  fill(20, 1, 23, 4, "hills", 4);
  fill(21, 1, 22, 3, "plains", 4);
  put(21, 2, "great_tree");
  put(23, 3, "standing_stone");
  put(20, 6, "standing_stone");
  put(22, 6, "standing_stone");
  put(21, 7, "boulder");
  put(19, 1, "dead_tree");
  put(23, 6, "mushrooms");
  ladder(18, 6, 19, 6);
  ladder(20, 5, 20, 4);
  ladder(19, 3, 20, 3);
  cells.set(id(18, 2), { biome: "plains", elev: 1, keep: true });
  cells.set(id(18, 3), { biome: "plains", elev: 1, keep: true });

  // ---- a camp inside a palisade, its gate of timber; a pond beside it with a hut on stilts ----
  row(1, 7, 10, "palisade");
  row(1, 7, 15, "palisade");
  for (let r = 11; r <= 14; r++) {
    put(1, r, "palisade");
    put(7, r, "palisade");
  }
  put(4, 15, "arch");
  put(3, 11, "tent");
  put(5, 12, "tent");
  put(4, 13, "campfire");
  put(2, 13, "barrels");
  put(6, 14, "cart");
  put(3, 14, "banner");
  put(2, 11, "tent");
  fill(9, 12, 10, 14, "water", 0);
  cells.set(id(11, 13), { biome: "water", elev: 0, keep: true });
  put(9, 11, "stilt_hut");
  put(8, 13, "mushrooms");
  put(10, 15, "dead_tree");
  put(9, 9, "boulder");
  put(10, 9, "obelisk");

  // ---- the way in: a waygate on a round of paving, a brazier either side ----
  fill(13, 11, 15, 13, "paved", 0);
  put(14, 12, "waygate");
  put(13, 11, "brazier");
  put(15, 11, "brazier");
  put(13, 15, "banner");
  put(15, 15, "campfire");

  // ---- the wild: a rib cage and its skull on sand, crystals, basalt, ice, mushrooms ----
  fill(16, 12, 23, 14, "sand", 0);
  row(17, 21, 13, "ribs");
  put(22, 13, "skull");
  put(19, 15, "ribs");
  put(18, 10, "crystal");
  put(19, 10, "crystal");
  put(19, 9, "crystal");
  put(22, 9, "basalt");
  put(22, 10, "basalt");
  put(21, 10, "basalt");
  put(17, 16, "ice_spire");
  put(18, 16, "ice_spire");
  put(18, 15, "ice_spire");
  put(21, 16, "mushrooms");
  put(22, 16, "great_tree");
  put(12, 16, "standing_stone");
  put(7, 16, "skull");
  put(6, 8, "tower");
  put(3, 8, "pillar");

  // ---- a ragged outline: the corners and a bite out of each side are simply not there ----
  const tiles: Tile[] = [];
  for (const [at, cell] of cells) {
    const [c, r] = at.split(",").map(Number);
    const edge = Math.pow(Math.abs((c - 11.5) / 12.4), 4) + Math.pow(Math.abs((r - 8.5) / 9.3), 4) + (hash(c, r, 9) - 0.5) * 0.3;
    if (!cell.keep && edge > 0.86) continue;
    const q = c - Math.floor(r / 2);
    tiles.push({
      q, r, biome: cell.biome,
      h: cell.biome === "water" ? BASE_HEIGHT.water : BASE_HEIGHT[cell.biome] + cell.elev * 0.42 + hash(q, r, 11) * 0.05,
      elev: cell.elev,
      ...(clime !== "greenwood" ? { clime } : {}),
      ...(cell.prop ? { prop: cell.prop } : {}),
      ...(cell.ladder ? { ladder: cell.ladder } : {}),
    });
  }
  return { grid: { cols: COLS, rows: ROWS }, tiles, pois: [] };
}

type Cell = { biome: Biome; elev: number; prop?: string; ladder?: number; h?: number };
/** The six neighbours of a cell, in the world's HEX_DIRS order: up-right, right, down-right, down-left, left, up-left. */
const beside = (c: number, r: number) => (r % 2 ? [[c + 1, r - 1], [c + 1, r], [c + 1, r + 1], [c, r + 1], [c - 1, r], [c, r - 1]] : [[c, r - 1], [c + 1, r], [c, r + 1], [c - 1, r + 1], [c - 1, r], [c - 1, r - 1]]);
const cellId = (c: number, r: number) => `${c},${r}`;

/** A map from its cells (by column and row): only the cells given are there at all. */
function mapOf(cells: Map<string, Cell>, clime: Clime): WorldMap {
  const tiles: Tile[] = [];
  for (const [at, cell] of cells) {
    const [c, r] = at.split(",").map(Number);
    const q = c - Math.floor(r / 2);
    tiles.push({
      q, r, biome: cell.biome,
      h: cell.h ?? (cell.biome === "water" ? BASE_HEIGHT.water : BASE_HEIGHT[cell.biome] + cell.elev * 0.42 + hash(q, r, 11) * 0.03),
      elev: cell.elev,
      ...(clime !== "greenwood" ? { clime } : {}),
      ...(cell.prop ? { prop: cell.prop } : {}),
      ...(cell.ladder ? { ladder: cell.ladder } : {}),
    });
  }
  return { grid: { cols: COLS, rows: ROWS }, tiles, pois: [] };
}

/** A ladder on (c, r) up to the neighbour (tc, tr). */
function ladderUp(cells: Map<string, Cell>, c: number, r: number, tc: number, tr: number) {
  const side = beside(c, r).findIndex(([nc, nr]) => nc === tc && nr === tr);
  const cell = cells.get(cellId(c, r));
  if (cell && side >= 0) cell.ladder = (cell.ladder ?? 0) | (1 << side);
}

/**
 * A mock hall, as the rules will lay one: paved floors, walls one hex thick in straight runs along rows and down
 * (zigzag) columns, shared between the rooms either side, doorways in them, and nothing past the outer walls.
 */
function hallMap(clime: Clime): WorldMap {
  const cells = new Map<string, Cell>();
  const fill = (c0: number, r0: number, c1: number, r1: number, elev = 0) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.set(cellId(c, r), { biome: "paved", elev });
  };
  const put = (c: number, r: number, prop: string) => {
    const cell = cells.get(cellId(c, r));
    if (cell) cell.prop = prop;
  };
  fill(2, 1, 21, 15);
  // The outer walls, the wall between the great hall and the rooms east of it, and the wall between those two.
  for (let c = 2; c <= 21; c++) for (const r of [1, 15]) put(c, r, c % 4 === 0 ? "wall_torch" : "wall");
  for (let r = 2; r <= 14; r++) for (const c of [2, 13, 21]) put(c, r, r % 4 === 0 ? "wall_torch" : "wall");
  for (let c = 14; c <= 20; c++) put(c, 8, c === 15 || c === 19 ? "wall_torch" : "wall");
  put(13, 5, "arch");
  put(13, 11, "arch");
  put(17, 8, "arch");
  // ---- the great hall: two rows of pillars, a runner up the middle to a dais and its throne ----
  fill(6, 2, 8, 3, 1);
  put(7, 2, "throne");
  put(6, 2, "brazier");
  put(8, 2, "brazier");
  for (const r of [5, 7, 9, 11, 13]) {
    put(5, r, "pillar");
    put(10, r, r === 11 ? "pillar_broken" : "pillar");
  }
  for (let r = 4; r <= 12; r++) put(7, r, "rug");
  put(8, 13, "waygate");
  put(11, 3, "weapon_rack");
  put(12, 7, "statue");
  put(11, 9, "table");
  put(9, 14, "barrels");
  put(11, 13, "banner");
  put(8, 6, "bones");
  // A gallery along its west side, two levels up: steps to it, and a ladder at the far end.
  fill(3, 9, 4, 13, 2);
  cells.set(cellId(3, 8), { biome: "paved", elev: 1, prop: "stairs" });
  ladderUp(cells, 5, 12, 4, 12);
  put(3, 11, "bookshelf");
  put(3, 13, "weapon_rack");
  put(3, 3, "barrels");
  put(4, 5, "statue");
  // ---- north-east: a library and guardroom ----
  for (const c of [15, 16, 19]) put(c, 2, "bookshelf");
  put(17, 4, "table");
  for (let c = 15; c <= 19; c++) put(c, 6, "rug");
  put(20, 3, "cage");
  put(20, 6, "weapon_rack");
  put(14, 3, "barrels");
  put(18, 2, "brazier");
  // ---- south-east: a crypt ----
  for (const c of [15, 17, 19]) put(c, 11, "sarcophagus");
  put(17, 13, "altar");
  put(15, 13, "statue");
  put(19, 13, "statue");
  put(16, 10, "bones");
  put(20, 9, "pillar_broken");
  put(14, 14, "sarcophagus");
  put(18, 14, "brazier");
  return mapOf(cells, clime);
}

/**
 * A mock cave, as the rules will lay one: `cave` floor, walls of `rock` two hexes thick and far taller than a
 * hero round every chamber and tunnel, and nothing past them; a pit with a bridge of `dock` over it, a pool, a ledge.
 */
function caveMap(clime: Clime): WorldMap {
  const cells = new Map<string, Cell>();
  const flat = (c: number, r: number) => ({ x: c + (r % 2) * 0.5, y: r * 0.866 });
  const inside = (c: number, r: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const blob = (cc: number, cr: number, rad: number, salt: number) => {
    const m = flat(cc, cr);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const p = flat(c, r);
      if (Math.hypot(p.x - m.x, p.y - m.y) < rad + (hash(c, r, salt) - 0.5) * 1.1) cells.set(cellId(c, r), { biome: "cave", elev: 0 });
    }
  };
  blob(7, 8, 4.4, 21);
  blob(17, 6, 3.3, 22);
  blob(16, 13, 2.5, 23);
  // Tunnels: one between the two great chambers, one down to the den.
  for (let c = 10; c <= 14; c++) for (const r of [7, 8]) cells.set(cellId(c, r), { biome: "cave", elev: 0 });
  for (let r = 9; r <= 11; r++) cells.set(cellId(17, r), { biome: "cave", elev: 0 });
  const put = (c: number, r: number, prop: string) => {
    const cell = cells.get(cellId(c, r));
    if (cell && cell.biome === "cave") cell.prop = prop;
  };
  // A ledge across the north of the first chamber, two levels up, with a ladder; a pool in the second.
  for (const [at, cell] of cells) {
    const [c, r] = at.split(",").map(Number);
    if (c <= 11 && r <= 5) cell.elev = 2;
  }
  ladderUp(cells, 7, 6, 7, 5);
  for (const [c, r] of [[17, 5], [18, 5], [18, 6], [17, 4]]) if (cells.has(cellId(c, r))) cells.set(cellId(c, r), { biome: "water", elev: 0 });
  // A hole in the floor of the first chamber, and a bridge over it.
  for (const [c, r] of [[4, 9], [5, 9], [6, 9], [7, 9], [4, 10], [5, 10], [6, 10], [7, 10], [5, 11], [6, 11]]) cells.delete(cellId(c, r));
  for (const [c, r] of [[5, 9], [5, 10], [5, 11]]) cells.set(cellId(c, r), { biome: "dock", elev: 0 });
  // The rock: everything within two hexes of the floor that is not floor (or the pit).
  const pit = new Set(["4,9", "6,9", "7,9", "4,10", "6,10", "7,10", "6,11"]);
  let rim = [...cells.keys()];
  for (let ring = 0; ring < 2; ring++) {
    const next: string[] = [];
    for (const at of rim) {
      const [c, r] = at.split(",").map(Number);
      for (const [nc, nr] of beside(c, r)) {
        const id = cellId(nc, nr);
        if (cells.has(id) || pit.has(id) || !inside(nc, nr)) continue;
        cells.set(id, { biome: "rock", elev: 5, h: 2.2 + hash(nc, nr, 31) * 0.7 });
        next.push(id);
      }
    }
    rim = next;
  }
  put(8, 12, "waygate");
  put(9, 7, "stalagmite");
  put(4, 7, "stalagmite");
  put(9, 10, "stalagmite");
  put(8, 4, "crystal");
  put(5, 4, "mushrooms");
  put(3, 8, "boulder");
  put(8, 7, "campfire");
  put(10, 9, "bones");
  put(15, 7, "stalagmite");
  put(19, 7, "crystal");
  put(16, 4, "mushrooms");
  put(19, 5, "bones");
  // The den: bones thick on the floor, the ribs and skull of what was eaten, a cage, a brazier.
  put(15, 13, "ribs");
  put(14, 13, "skull");
  put(17, 12, "bones");
  put(16, 14, "bones");
  put(17, 14, "cage");
  put(18, 13, "brazier");
  put(15, 12, "bones");
  return mapOf(cells, clime);
}

const hexOf = (c: number, r: number): HexPos => ({ q: c - Math.floor(r / 2), r });
const STARTS: Record<Place, HexPos> = { outdoors: hexOf(14, 14), hall: hexOf(8, 10), cave: hexOf(8, 10) };

export default function SceneryLab() {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<WorldRenderer | null>(null);
  // What was being looked at is kept for the tab, so a reload (the dev server's, when a file is saved) comes back to it.
  const kept = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEPT) ?? "{}") as { clime?: Clime; place?: Place; backdrop?: BackdropKind };
    } catch {
      return {};
    }
  }, []);
  const [clime, setClime] = useState<Clime>(kept.clime && CLIMES.includes(kept.clime) ? kept.clime : "greenwood");
  const [place, setPlace] = useState<Place>(kept.place && PLACES.includes(kept.place) ? kept.place : "outdoors");
  const [backdrop, setBackdrop] = useState<BackdropKind>(kept.backdrop && BACKDROPS.includes(kept.backdrop) ? kept.backdrop : "mist");
  const [hour, setHour] = useState<number | undefined>(0.5);
  const [at, setAt] = useState<HexPos>(STARTS[place]);
  useEffect(() => sessionStorage.setItem(KEPT, JSON.stringify({ clime, place, backdrop })), [clime, place, backdrop]);
  // "Fancy graphics" is the player's own setting (the glow, the painted ground): the lab only flips it.
  const [fine, setFine] = useState(fancy.get);
  useEffect(() => fancy.subscribe(() => setFine(fancy.get())), []);
  const map = useMemo(() => (place === "hall" ? hallMap(clime) : place === "cave" ? caveMap(clime) : sampleMap(clime)), [place, clime]);
  // A hall and a cave are seen as they will be: in the dark.
  const go = (next: Place) => {
    setPlace(next);
    setAt(STARTS[next]);
    setBackdrop(next === "outdoors" ? "mist" : "dark");
  };

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (pos) => setAt(pos), onHover() {} });
    view.current = r;
    return () => {
      r.dispose();
      view.current = null;
    };
  }, []);

  // The hour is held through the dev tools' own hook (see the ambience's timeOfDay), which the lab turns on for itself.
  useEffect(() => {
    devTools.set(true);
    const sky = globalThis as { __gqTime?: number; __gqWeather?: number };
    if (hour === undefined) delete sky.__gqTime;
    else sky.__gqTime = hour;
    sky.__gqWeather = 0;
    return () => {
      delete sky.__gqTime;
      delete sky.__gqWeather;
    };
  }, [hour]);

  useEffect(() => {
    const scene: RenderState = {
      code: `lab:scenery:${place}:${clime}`,
      you: "lab",
      map,
      heroes: [{ id: "lab", classId: HERO_CLASSES[0].id, pos: at, label: "Scale" }],
      freeRoam: true,
      backdrop,
    };
    view.current?.setState(scene);
  }, [map, place, clime, backdrop, at]);

  const pick = <T,>(label: string, options: readonly T[], value: T, set: (v: T) => void, name: (v: T) => string) => (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
      {options.map((o) => (
        <button key={name(o)} type="button" onClick={() => set(o)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #5a6072", background: o === value ? "#e9c46a" : "#1c2030", color: o === value ? "#1c2030" : "#e6e9f2", cursor: "pointer", font: "inherit" }}>
          {name(o)}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0d0f18" }}>
      <div ref={mount} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", left: 10, top: 10, display: "grid", gap: 6, padding: 10, borderRadius: 8, background: "rgba(14,16,26,0.82)", color: "#e6e9f2", font: "12px/1.3 system-ui, sans-serif", zIndex: 5 }}>
        <strong>Scenery lab</strong>
        {pick("Place", PLACES, place, go, (v) => v)}
        {pick("Climate", CLIMES, clime, setClime, (v) => v)}
        {pick("Backdrop", BACKDROPS, backdrop, setBackdrop, (v) => v)}
        {pick("Hour", HOURS.map(([, v]) => v), hour, setHour, (v) => HOURS.find(([, h]) => h === v)![0])}
        {pick("Graphics", [false, true], fine, (v) => fancy.set(v), (v) => (v ? "fancy" : "plain"))}
        <span style={{ opacity: 0.6 }}>Click a hex to walk there. Q/E turn, R/F tilt, wheel zooms.</span>
      </div>
    </div>
  );
}
