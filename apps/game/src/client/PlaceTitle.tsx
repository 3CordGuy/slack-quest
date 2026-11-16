// The name of the place you are pointing at, hung over it on a strip of
// parchment in the menus' title face, like a window's name plate. Like
// TileAction and AttentionMark it follows the camera frame by frame.

import { useEffect, useRef, type RefObject } from "react";
import type { WorldRenderer } from "./render/WorldRenderer";
import { uiZoom } from "./uiScale";

export function PlaceTitle({ renderer, poiId, title }: {
  renderer: RefObject<WorldRenderer | null>;
  /** The place's id in the scene: the plate hangs over the top of its model. */
  poiId: string;
  title: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = wrap.current;
      if (!el) return;
      const at = renderer.current?.screenAbovePoi(poiId) ?? null;
      el.style.visibility = at ? "visible" : "hidden";
      const z = uiZoom();
      if (at) el.style.transform = `translate(${Math.round(at.x / z)}px, ${Math.round(at.y / z)}px)`;
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [renderer, poiId]);

  return (
    <div className="place-title" ref={wrap} role="tooltip">
      {/* Keyed by the place, so the plate drops in afresh as the pointer moves from one to the next. */}
      <span key={poiId}>{title}</span>
    </div>
  );
}
