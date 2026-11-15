// Tattoo stamps for the paper doll (InkEditor.tsx): ready-made designs dropped onto the body to slide into
// place. Classic sailors' motifs (an anchor, a swallow, the nautical star, a ship's wheel, a compass rose, a
// sea turtle, a fish hook, a whale's tail, a heart) and bands in the island manner (shark teeth, waves, a
// braided rope). Each is a little grid of cells: "#" is inked in the chosen ink, "+" in the same ink fainter
// (the light half of a two-tone star), "." bare. Drawn for this game; the motifs are the old common stock.

export interface Stamp {
  id: string;
  label: string;
  rows: string[];
}

/** A grid `w` by `h` filled where `ink` says, by each cell's middle (x, y from the top left, in cells). */
function raster(w: number, h: number, ink: (x: number, y: number) => "#" | "+" | "."): string[] {
  return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => ink(c + 0.5, r + 0.5)).join(""));
}

/** Whether a point is inside a polygon (even-odd). */
function inside(px: number, py: number, poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A star of `points` points about (cx, cy), out to `outer` and in to `inner`, its first point straight up. */
function star(cx: number, cy: number, points: number, outer: number, inner: number, turn = 0): [number, number][] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = turn - Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : outer;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

/** Which half of its point a cell is in, for two-tone stars: the half clockwise of each point's ridge is faint. */
function faintHalf(x: number, y: number, cx: number, cy: number, points: number, turn = 0): boolean {
  const a = Math.atan2(y - cy, x - cx) - turn + Math.PI / 2;
  const sector = (((a / (Math.PI / points)) % (2 * points)) + 2 * points) % (2 * points);
  return Math.floor(sector) % 2 === 1;
}

const NAUTICAL_STAR = (() => {
  const c = 7.5;
  const poly = star(c, c + 0.5, 5, 7.8, 3.2);
  return raster(15, 15, (x, y) => (inside(x, y, poly) ? (faintHalf(x, y, c, c + 0.5, 5) ? "+" : "#") : "."));
})();

const COMPASS = (() => {
  const c = 7.5;
  const long = star(c, c, 4, 7.5, 2.1);
  const short = star(c, c, 4, 5, 1.8, Math.PI / 4);
  return raster(15, 15, (x, y) => {
    if (Math.hypot(x - c, y - c) < 1.1) return "#";
    if (inside(x, y, long)) return faintHalf(x, y, c, c, 4) ? "+" : "#";
    if (inside(x, y, short)) return faintHalf(x, y, c, c, 4, Math.PI / 4) ? "+" : "#";
    return ".";
  });
})();

const WHEEL = (() => {
  const c = 7.5;
  return raster(15, 15, (x, y) => {
    const r = Math.hypot(x - c, y - c);
    const a = Math.atan2(y - c, x - c);
    // How far the cell is from the nearest of the eight spokes, across it.
    const off = Math.abs(Math.sin(4 * a)) * r * 0.5;
    if (r < 1.5) return "#";
    if (r > 3.6 && r < 4.9) return "#";
    // Spokes, thicker where they stand out past the rim as handles.
    if (r < 7.6 && off < (r > 5.4 ? 0.8 : 0.55)) return "#";
    return ".";
  });
})();

/** Shark teeth: a rule along the top and the bottom, and a row of teeth pointing in from each, offset by half a tooth. */
const SHARK_TEETH = raster(18, 7, (x, y) => {
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (r === 0 || r === 6) return "#";
  if (r === 1) return c % 4 === 3 ? "." : "#";
  if (r === 2) return c % 4 === 1 ? "#" : ".";
  if (r === 4) return (c + 2) % 4 === 1 ? "#" : ".";
  if (r === 5) return (c + 2) % 4 === 3 ? "." : "#";
  return ".";
});

/** Waves: a rolling line over a rule. */
const WAVES = raster(18, 6, (x, y) => {
  if (y > 5) return "#";
  const crest = 2.2 + 1.5 * Math.sin((x / 6) * Math.PI * 2);
  return Math.abs(y - crest) < 0.75 ? "#" : ".";
});

/** A twisted rope: strands leaning across it between two rules. */
const ROPE = raster(18, 6, (x, y) => {
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (r === 0 || r === 5) return "#";
  return (c + r) % 4 < 2 ? "#" : ".";
});

export const STAMPS: Stamp[] = [
  {
    id: "anchor",
    label: "Anchor",
    rows: [
      ".....###.....",
      "....#...#....",
      "....#...#....",
      ".....###.....",
      "..#########..",
      "......#......",
      "......#......",
      "......#......",
      "......#......",
      "......#......",
      ".#....#....#.",
      "###...#...###",
      ".##...#...##.",
      "..##..#..##..",
      "...#######...",
      ".....###.....",
    ],
  },
  {
    id: "swallow",
    label: "Swallow",
    rows: [
      "##.............##",
      ".###....#....###.",
      "..####.###.####..",
      "...###########...",
      "....#########....",
      ".....#######.....",
      "......#####......",
      "......##.##......",
      ".....##...##.....",
      "....##.....##....",
    ],
  },
  { id: "star", label: "Nautical star", rows: NAUTICAL_STAR },
  { id: "wheel", label: "Ship's wheel", rows: WHEEL },
  { id: "compass", label: "Compass rose", rows: COMPASS },
  {
    id: "turtle",
    label: "Sea turtle",
    rows: [
      ".....###.....",
      ".....###.....",
      "..##.###.##..",
      ".###########.",
      "...#+#+#+#...",
      "..##+#+#+##..",
      "..#+#+#+#+#..",
      "..##+#+#+##..",
      "...#######...",
      ".###.###.###.",
      ".##...#...##.",
      "......#......",
    ],
  },
  {
    id: "hook",
    label: "Fish hook",
    rows: [
      "....###.",
      "....#.#.",
      "....###.",
      ".....#..",
      ".....#..",
      ".....#..",
      ".....#..",
      ".....#..",
      "#....#..",
      "##...#..",
      "###..#..",
      ".##.##..",
      "..###...",
    ],
  },
  {
    id: "tail",
    label: "Whale tail",
    rows: [
      "##...........##",
      "###.........###",
      ".####.....####.",
      "..####...####..",
      "...#########...",
      ".....#####.....",
      "......###......",
      "......###......",
      "......###......",
    ],
  },
  {
    id: "heart",
    label: "Heart",
    rows: [
      ".###...###.",
      "#####.#####",
      "##+######+#",
      "###########",
      ".#########.",
      "..#######..",
      "...#####...",
      "....###....",
      ".....#.....",
    ],
  },
  { id: "teeth", label: "Shark teeth", rows: SHARK_TEETH },
  { id: "waves", label: "Waves", rows: WAVES },
  { id: "rope", label: "Rope", rows: ROPE },
];
