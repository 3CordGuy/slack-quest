// A small pixel icon drawn from a grid of strings: each string is a row, "#" a
// filled cell. Drawn in the current text colour with crisp edges, so it sits in
// a button like a letter would.

import type { ReactNode } from "react";

export function PixelIcon({ rows, size = 16 }: { rows: string[]; size?: number }) {
  const cells: ReactNode[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && cells.push(<rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />)));
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  return (
    <svg className="pixel-glyph" viewBox={`0 0 ${w} ${h}`} width={size} height={Math.round((size * h) / w)} shapeRendering="crispEdges" aria-hidden fill="currentColor">
      {cells}
    </svg>
  );
}
