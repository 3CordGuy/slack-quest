// A bouncing "!" floated over a place in the scene that has something new
// for you, such as the Harbor's notice board when a release has notes you
// have not read. Like TileAction it follows the camera frame by frame.

import { useEffect, useRef, type RefObject } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { WorldRenderer } from "./render/WorldRenderer";
import { uiZoom } from "./uiScale";

export function AttentionMark({ renderer, pos, lift = 1.7, label }: {
  renderer: RefObject<WorldRenderer | null>;
  pos: HexPos;
  /** How far above the ground the mark hangs, in world units: clear of the thing it marks. */
  lift?: number;
  /** What it is for, for screen readers. */
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { q, r } = pos;

  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = wrap.current;
      if (!el) return;
      const at = renderer.current?.screenAbove({ q, r }, lift) ?? null;
      el.style.visibility = at ? "visible" : "hidden";
      const z = uiZoom();
      if (at) el.style.transform = `translate(${Math.round(at.x / z)}px, ${Math.round(at.y / z)}px)`;
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [renderer, q, r, lift]);

  return (
    <div className="attention-mark" ref={wrap} role="status" aria-label={label}>
      <span aria-hidden="true">!</span>
    </div>
  );
}
