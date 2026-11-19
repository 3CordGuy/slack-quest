// The scenery lab: a dev-only map for looking at what stands on a zone's
// hexes (render/zoneScenery.ts) and what lies round it (render/backdrop.ts).
// Opened at #lab/scenery on the dev server.
//
// One hand-laid map carries every kind of thing a hex can carry: a walled
// courtyard with towers and a gate, a pillared hall on a paved platform with
// a dais at its head, a palisaded camp, a waygate, a rib cage with its skull,
// crystals, terraces of high ground with ladders up them. Buttons switch its
// climate, its backdrop and the hour. Click a hex to walk the hero there, for
// a sense of scale.
//
// Nothing here touches the server or a game being played.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { BASE_HEIGHT, CLIMES, HERO_CLASSES, type Biome, type Clime, type Tile, type WorldMap } from "@gantt-quest/world";
import { devTools } from "./devTools";
import type { BackdropKind } from "./render/backdrop";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";

const COLS = 24;
const ROWS = 18;
const BACKDROPS: BackdropKind[] = ["sea", "mist", "abyss", "lava", "frost", "dusk"];
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

const START: HexPos = { q: 14 - Math.floor(14 / 2), r: 14 };

export default function SceneryLab() {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<WorldRenderer | null>(null);
  const [clime, setClime] = useState<Clime>("greenwood");
  const [backdrop, setBackdrop] = useState<BackdropKind>("mist");
  const [hour, setHour] = useState<number | undefined>(0.5);
  const [at, setAt] = useState<HexPos>(START);
  const map = useMemo(() => sampleMap(clime), [clime]);

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
      code: `lab:scenery:${clime}`,
      kind: "voyage",
      you: "lab",
      phase: "overworld",
      round: 0,
      map,
      heroes: [{ id: "lab", classId: HERO_CLASSES[0].id, pos: at, label: "Scale" }],
      turn: null,
      story: null,
      npcs: {},
      freeRoam: true,
      backdrop,
    };
    view.current?.setState(scene);
  }, [map, clime, backdrop, at]);

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
        {pick("Climate", CLIMES, clime, setClime, (v) => v)}
        {pick("Backdrop", BACKDROPS, backdrop, setBackdrop, (v) => v)}
        {pick("Hour", HOURS.map(([, v]) => v), hour, setHour, (v) => HOURS.find(([, h]) => h === v)![0])}
        <span style={{ opacity: 0.6 }}>Click a hex to walk there. Q/E turn, R/F tilt, wheel zooms.</span>
      </div>
    </div>
  );
}
