// The crew's ship at sea, drawn on the voyage's own view. While the crew is
// aboard in the lobby she runs easy before the wind; once the captain sets
// sail she makes way while the island's story is written; and when the story
// is in she makes landfall at the island's landing, where play goes ashore.
// It is only a picture: nothing here is game state, and the voyage decides
// which part of it shows (see RunView).

import { useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { ClientState, Poi, Tile, WorldMap } from "@gantt-quest/world";
import { hexToWorld, type RenderState, type WorldRenderer } from "./render/WorldRenderer";

/** Aboard in the lobby, under way while the story is written, or coming in to the island. */
export type SeaMode = "moored" | "crossing" | "landfall";

const COLS = 44;
const ROWS = 9;
/** The row the ship keeps to. */
const LANE = 4;
/**
 * The open sea repeats every PERIOD columns (its rocks are laid out that way),
 * so when the ship has run one period she and the camera are carried back
 * one, and nobody sees the join: she can sail as long as the crew talks.
 */
const PERIOD = 12;
const FROM = 14;
/** How fast she goes, in world units a second: easy in the lobby, making way once she has sailed. */
const SPEED = { moored: 0.8, crossing: 2.6 };
/** How far ahead of the bow the camera looks: in the lobby enough to keep her clear of the panel. */
const AHEAD = { moored: 7.5, crossing: 3 };
/** The landfall: how far out she starts, and how long she takes to come in. */
const LANDFALL_RUN = 10;
const LANDFALL_MS = 3800;
/** How long the veil takes to close or open, a little under its CSS transition. */
const VEIL_MS = 240;
/** Water level, where the hull sits. */
const SEA_Y = 0.14;
const HEX_W = hexToWorld({ q: 1, r: 0 }).x;

const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });
const poi = (id: string, kind: Poi["kind"], pos: HexPos): Poi => ({ id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [] });
/** The ship is a point of interest kept off the map, so no hex loses its waves to her; she is moved by hand. */
const ship = () => poi("ship", "ship", at(-60, LANE));

/** Open sea with a scatter of rocks, the same in every period and clear of the ship's lane. */
function openSea(): WorldMap {
  const tiles: Tile[] = [];
  for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) tiles.push({ ...at(col, r), biome: "water", h: 0.05 });
  const pattern: [number, number][] = [[3, 1], [8, 7], [11, 0], [6, 8], [0, 2]];
  const pois: Poi[] = [];
  for (let k = 0; k * PERIOD < COLS; k++) {
    for (const [col, r] of pattern) if (col + k * PERIOD < COLS) pois.push(poi(`rocks:${k}:${col}`, "rocks", at(col + k * PERIOD, r)));
  }
  return { grid: { cols: COLS, rows: ROWS }, tiles, pois: [...pois, ship()] };
}

const SEA: RenderState = {
  code: "open-sea",
  you: "",
  phase: "overworld",
  round: 0,
  map: openSea(),
  heroes: [],
  turn: null,
  battle: null,
  story: null,
  npcs: {},
  freeRoam: true,
};

/** Look-ahead shrinks on a tall, narrow screen (a phone), where the same distance would put her off the left edge. */
const narrow = () => Math.max(0.4, Math.min(1, innerWidth / Math.max(1, innerHeight)));

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A gentle roll, pitch and heave, so she rides the swell. */
function ride(hull: { position: { y: number }; rotation: { x: number; z: number } }, t: number) {
  hull.rotation.x = Math.sin(t * 1.4) * 0.045 + Math.sin(t * 0.63) * 0.02;
  hull.rotation.z = Math.sin(t * 1.05 + 1) * 0.03;
  hull.position.y = SEA_Y + Math.sin(t * 1.7) * 0.035;
}

export function SailingView({ view, mode, island, names, onLanded }: { view: WorldRenderer | null; mode: SeaMode | null; island: ClientState | null; names: string[]; onLanded(): void }) {
  const [veil, setVeil] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const islandRef = useRef(island);
  islandRef.current = island;
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;
  /** Cut the landfall short: draw the veil and go ashore. Set while one is playing. */
  const skip = useRef<(() => void) | null>(null);

  const openWater = mode === "moored" || mode === "crossing";
  const landfall = mode === "landfall";

  // Open water: one scene for the lobby and the crossing, so setting sail is the same ship picking up speed.
  useEffect(() => {
    if (!view || !openWater) return;
    view.setState(SEA);
    const hull = view.poiObject("ship");
    const lane = hexToWorld(at(FROM, LANE));
    const quiet = still();
    let x = lane.x;
    const m = modeRef.current === "crossing" ? "crossing" : "moored";
    let speed = quiet ? 0 : SPEED[m];
    let ahead = AHEAD[m];
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const goal = modeRef.current === "crossing" ? "crossing" : "moored";
      const ease = 1 - Math.exp(-dt * 1.2);
      if (!quiet) speed += (SPEED[goal] - speed) * ease;
      ahead += (AHEAD[goal] - ahead) * ease;
      x += speed * dt;
      // A period run: carry her and the camera back one, onto water that looks the same.
      if (x > lane.x + PERIOD * HEX_W) x -= PERIOD * HEX_W;
      if (hull) {
        hull.position.x = x;
        hull.position.z = lane.z - 0.28;
        if (quiet) hull.position.y = SEA_Y;
        else ride(hull, now / 1000);
      }
      view.focusAt(x + ahead * narrow(), lane.z, true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view, openWater]);

  // Landfall: the island comes up ahead and she runs in to the landing. A click or a key goes straight ashore.
  useEffect(() => {
    if (!view || !landfall) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;
    let done = false;
    const ashore = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      setVeil(true);
      timers.push(setTimeout(() => landedRef.current(), VEIL_MS));
    };
    skip.current = ashore;
    const s = islandRef.current;
    const landing = s?.map.pois.find((p) => p.id === "landing");
    if (!s || !landing || still()) {
      // Nothing to sail to, or the player would rather not watch things move: a plain fade ashore.
      ashore();
      return () => timers.forEach(clearTimeout);
    }
    // Under the veil, change the open sea for the island: as it is from the sea, fog and all, with the crew still aboard.
    setVeil(true);
    timers.push(
      setTimeout(() => {
        if (done) return;
        view.setState({
          code: s.code,
          you: "",
          phase: s.phase,
          round: s.round,
          map: { ...s.map, pois: [...s.map.pois, ship()] },
          heroes: [],
          turn: null,
          battle: null,
          story: s.story,
          npcs: s.npcs,
          roamers: s.roamers,
          freeRoam: true,
        });
        // The landing's own ship is the one coming in, so it is not there yet.
        view.poiObject("landing")?.traverse((o) => {
          if (o.name === "moored") o.visible = false;
        });
        const hull = view.poiObject("ship");
        const dock = hexToWorld(landing.pos);
        const endX = dock.x - 1.5;
        const z = dock.z + 0.02;
        const startX = endX - LANDFALL_RUN;
        const t0 = performance.now();
        const tick = (now: number) => {
          const u = Math.min(1, (now - t0) / LANDFALL_MS);
          // Running in fast and easing off as she comes alongside.
          const x = startX + LANDFALL_RUN * (1 - (1 - u) * (1 - u));
          if (hull) {
            hull.position.x = x;
            hull.position.z = z - 0.28;
            ride(hull, now / 1000);
          }
          // The camera starts well ahead, so the island is in sight from the first moment, and settles on the landing.
          view.focusAt(x + (5 - 3.5 * u) * narrow(), z, true);
          if (u >= 1) ashore();
          else raf = requestAnimationFrame(tick);
        };
        tick(t0);
        setVeil(false);
      }, VEIL_MS),
    );
    return () => {
      done = true;
      skip.current = null;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [view, landfall]);

  // Ashore: the veil lifts on the island as it is, crew and all.
  useEffect(() => {
    if (mode === null) setVeil(false);
  }, [mode]);

  useEffect(() => {
    if (!landfall) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      skip.current?.();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [landfall]);

  return (
    <>
      {mode === "crossing" && (
        <div className="sailing-caption panel">
          <h2>Under sail…</h2>
          <p className="muted">{names.length > 0 ? `${names.join(", ")} ${names.length === 1 ? "watches" : "watch"} the horizon. ` : ""}The lookout is making out the shape of the island.</p>
        </div>
      )}
      {landfall && (
        <div className="landfall" onClick={() => skip.current?.()} role="button" aria-label="Go ashore">
          <div className="sailing-caption panel">
            <h2>Land ho!</h2>
            <p className="muted">{island?.story?.islandName ? `${island.story.islandName}, dead ahead. ` : "The island, dead ahead. "}Click or press a key to go ashore.</p>
          </div>
        </div>
      )}
      <div className={`sea-veil ${veil ? "on" : ""}`} aria-hidden="true" />
    </>
  );
}
