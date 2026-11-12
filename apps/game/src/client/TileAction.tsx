// A place's main button, floated above the player's own character (clear of
// their name) while they stand on that place, so it is next to where they
// clicked to walk there. The bar at the bottom of
// the screen keeps the same button; this one is only the shortcut.

import { useEffect, useRef, type RefObject } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { WorldRenderer } from "./render/WorldRenderer";

export function TileAction({ renderer, pos, unitId, label, run }: {
  renderer: RefObject<WorldRenderer | null>;
  pos: HexPos;
  /** The player's own unit: the button waits until it has finished walking here. */
  unitId: string;
  label: string;
  run(): void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { q, r } = pos;

  // The camera belongs to the renderer and moves without React knowing, so follow it frame by frame, outside of state.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = wrap.current;
      if (!el) return;
      const world = renderer.current;
      // Over the character's own head (and name), falling back to the hex if they are not drawn yet.
      const at = world && !world.isWalking(unitId) ? (world.screenAboveUnit(unitId) ?? world.screenAbove({ q, r })) : null;
      el.style.visibility = at ? "visible" : "hidden";
      if (at) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [renderer, q, r, unitId]);

  return (
    <div className="tile-action" ref={wrap}>
      <button className="primary" onClick={run}>{label}</button>
    </div>
  );
}
