// The crossing: shown while the island's story is being written. The crew's
// ship makes its way over open water, hex by hex, past the odd rock, with
// the camera following. It is only a picture: nothing here is game state,
// and it ends when the voyage's phase changes.

import { useEffect, useMemo, useRef } from "react";
import { useAudioScene } from "./audio/useAudioScene";
import type { HexPos } from "@gantt-quest/core";
import type { Poi, Tile, WorldMap } from "@gantt-quest/world";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";

const COLS = 22;
const ROWS = 7;
/** The row the ship keeps to, and how long it spends on each hex. */
const LANE = 3;
const STEP_MS = 800;
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });
const poi = (id: string, kind: Poi["kind"], pos: HexPos): Poi => ({ id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [] });

/** Open sea with a scatter of rocks kept clear of the ship's lane. */
function sea(): WorldMap {
  const tiles: Tile[] = [];
  for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) tiles.push({ ...at(col, r), biome: "water", h: 0.05 });
  const rocks = [at(3, 1), at(8, 5), at(12, 0), at(15, 6), at(18, 1), at(5, 6)].map((pos, i) => poi(`rocks:${i}`, "rocks", pos));
  return { grid: { cols: COLS, rows: ROWS }, tiles, pois: rocks };
}

export function SailingView({ names }: { names: string[] }) {
  useAudioScene("sailing");
  const mount = useRef<HTMLDivElement>(null);
  const base = useMemo(sea, []);

  useEffect(() => {
    const renderer = new WorldRenderer(mount.current!, { onHexClick: () => undefined, onHover: () => undefined });
    let col = 2;
    const show = () => {
      const pos = at(col, LANE);
      const scene: RenderState = {
        code: "sailing",
        you: "",
        phase: "overworld",
        round: 0,
        // The ship's id changes with its place, so the renderer redraws it each step.
        map: { ...base, pois: [...base.pois, poi(`ship:${col}`, "ship", pos)] },
        heroes: [],
        turn: null,
        battle: null,
        story: null,
        npcs: {},
        freeRoam: true,
      };
      renderer.setState(scene);
      // Look a little ahead of the bow, so the sea opens in front of her.
      renderer.lookAt(at(Math.min(COLS - 1, col + 2), LANE));
    };
    show();
    const timer = setInterval(() => {
      // At the far edge she comes round again: the crossing takes as long as the story does.
      col = col >= COLS - 3 ? 2 : col + 1;
      show();
    }, STEP_MS);
    return () => {
      clearInterval(timer);
      renderer.dispose();
    };
  }, [base]);

  return (
    <div className="sailing">
      <div className="sailing-stage" ref={mount} />
      <div className="sailing-caption panel">
        <h2>Under sail…</h2>
        <p className="muted">{names.length > 0 ? `${names.join(", ")} ${names.length === 1 ? "watches" : "watch"} the horizon. ` : ""}The lookout is making out the shape of the island.</p>
      </div>
    </div>
  );
}
