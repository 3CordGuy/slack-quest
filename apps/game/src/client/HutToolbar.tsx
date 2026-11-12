// The controls for the piece selected in a hut, floated just above it in the
// scene and following the camera, the way TileAction floats a button over a
// hex. Each action is a small pixel icon with a tooltip.

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { WorldRenderer } from "./render/WorldRenderer";

/** A pixel icon on an 8 by 8 grid: each string is a row, "#" a filled cell. */
function PixelIcon({ rows }: { rows: string[] }) {
  const cells: ReactNode[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && cells.push(<rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />)));
  return (
    <svg className="pixel-glyph" viewBox="0 0 8 8" width={16} height={16} shapeRendering="crispEdges" aria-hidden fill="currentColor">
      {cells}
    </svg>
  );
}

const ICON = {
  move: ["...#....", "..###...", ".#.#.#..", "#######.", ".#.#.#..", "..###...", "...#....", "........"],
  left: ["..#.....", ".##.....", "#######.", ".##....#", "..#....#", ".......#", "..#####.", "........"],
  right: [".....#..", ".....##.", ".#######", "#....##.", "#....#..", "#.......", ".#####..", "........"],
  fineLeft: ["........", "....#...", "...##...", "..###...", "...##...", "....#...", "........", "........"],
  fineRight: ["........", "...#....", "...##...", "...###..", "...##...", "...#....", "........", "........"],
  open: ["........", ".######.", "#......#", "########", "#..##..#", "#......#", "########", "........"],
  away: ["...##...", "...##...", ".######.", "..####..", "...##...", "#......#", "#......#", "########"],
};

export interface ToolAction {
  key: string;
  icon: keyof typeof ICON;
  /** Shown as the tooltip, and read out by screen readers. */
  title: string;
  run(): void;
  active?: boolean;
}

export function HutToolbar({ renderer, propId, name, tags, actions }: {
  renderer: RefObject<WorldRenderer | null>;
  propId: number;
  name: string;
  tags: string[];
  actions: ToolAction[];
}) {
  const wrap = useRef<HTMLDivElement>(null);

  // The camera belongs to the renderer and moves without React knowing, so follow it frame by frame, outside of state.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = wrap.current;
      if (!el) return;
      const at = renderer.current?.screenAboveProp(propId) ?? null;
      el.style.visibility = at ? "visible" : "hidden";
      if (!at) return;
      // Kept inside the view (a phone is narrow), with its little pointer still aimed at the piece.
      const half = (el.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
      const room = el.parentElement?.clientWidth ?? Infinity;
      const x = Math.max(half / 2 + 6, Math.min(room - half / 2 - 6, at.x));
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(at.y)}px)`;
      el.style.setProperty("--aim", `${Math.round(at.x - x)}px`);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [renderer, propId]);

  return (
    <div className="hut-toolbar" ref={wrap}>
      <div className="hut-toolbar-box" role="toolbar" aria-label={`${name} controls`}>
        <div className="hut-toolbar-name">
          <strong>{name}</strong>
          {tags.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>
        <div className="hut-toolbar-buttons">
          {actions.map((a) => (
            <button key={a.key} className={`icon-btn ${a.active ? "selected" : ""}`} title={a.title} aria-label={a.title} onClick={a.run}>
              <PixelIcon rows={ICON[a.icon]} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
