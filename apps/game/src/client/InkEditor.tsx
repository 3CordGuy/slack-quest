// The tattoo editor in the look builder: a paper doll of the hero in their undergarments, front and back,
// to draw tattoos on cell by cell in a few greys. A selection can be lifted and slid about the body, and
// the hero beside it shows the ink as it goes. Ink comes in greys and a few muted colours, laid on as
// strongly or as faintly as the opacity says; (render/figures.ts lays each cell on the body where it is
// seen to be on the doll). The ink is kept as world's `Ink`: the regions of the body that can be drawn
// on (INK_REGIONS), each a grid seen from the front and from the back.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  INK_COLORS,
  INK_LEVELS,
  INK_REGIONS,
  INK_SIDES,
  MAX_INK_CELLS,
  decodeInk,
  encodeInk,
  inkCell,
  type Appearance,
  type Ink,
  type InkRegion,
  type InkSide,
  type InkView,
} from "@gantt-quest/world";
import { inkAcross, inkGuides, inkOver, inkSurface } from "./render/figures";

/** One view of the doll, in cells, and the gap between the two. */
const COLS = 46;
const ROWS = 74;
const GAP = 3;
/** Canvas pixels to a cell (it is drawn larger or smaller to fit; see builder.css). */
const PX = 6;
const VIEWS: InkView[] = ["f", "b"];

/** Where each region's grid sits on the doll, by its top-left cell. Seen from the back, left and right swap. */
const PLACES: Record<InkView, { region: InkRegion; col: number; row: number }[]> = {
  f: [
    { region: "head", col: 9, row: 0 },
    { region: "armR", col: 0, row: 34 },
    { region: "armL", col: 36, row: 34 },
    { region: "thighR", col: 10, row: 59 },
    { region: "thighL", col: 24, row: 59 },
    { region: "shinR", col: 11, row: 63 },
    { region: "shinL", col: 25, row: 63 },
  ],
  b: [
    { region: "head", col: 9, row: 0 },
    { region: "armL", col: 0, row: 34 },
    { region: "armR", col: 36, row: 34 },
    { region: "thighL", col: 10, row: 59 },
    { region: "thighR", col: 24, row: 59 },
    { region: "shinL", col: 11, row: 63 },
    { region: "shinR", col: 25, row: 63 },
  ],
};

/** A doll cell that ink can go in: the side and index it is in `Ink`, whether it is on the body, and how high up its part it is. */
interface Spot {
  side: InkSide;
  at: number;
  on: boolean;
  region: InkRegion;
  y: number;
}
type Grid = (Spot | null)[][];

/** Each view's cells, for a hero of this look (the head's outline is its shape's). */
function layout(look: Appearance): Record<InkView, Grid> {
  const out = {} as Record<InkView, Grid>;
  for (const view of VIEWS) {
    const grid: Grid = Array.from({ length: ROWS }, () => Array<Spot | null>(COLS).fill(null));
    for (const { region, col, row } of PLACES[view]) {
      const surface = inkSurface(region, look);
      const { cols, rows } = INK_REGIONS[region];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = -surface.half + (c + 0.5) * surface.cell;
          const y = surface.top - (r + 0.5) * surface.cell;
          grid[row + r][col + c] = { side: `${region}.${view}`, at: r * cols + c, on: Math.abs(x) < inkAcross(surface, y), region, y };
        }
      }
    }
    out[view] = grid;
  }
  return out;
}

/** The ink being drawn: each side's cells, index to cell (colour and level; see inkCell). */
type Cells = Map<InkSide, Map<number, number>>;

function fromInk(ink: Ink | undefined): Cells {
  const out: Cells = new Map();
  for (const side of INK_SIDES) {
    const cells = decodeInk(ink?.[side]);
    if (cells.size) out.set(side, cells);
  }
  return out;
}

function toInk(cells: Cells): Ink | undefined {
  const out: Ink = {};
  for (const [side, map] of cells) if (map.size) out[side] = encodeInk(map);
  return Object.keys(out).length ? out : undefined;
}

function countCells(cells: Cells): number {
  let n = 0;
  for (const map of cells.values()) n += map.size;
  return n;
}

/**
 * A selection: a box of cells on one view, at (col, row) and `w` by `h`. Once lifted it carries the ink that
 * was in it, off the body, until it is put down; moved, (dx, dy) is how far it has gone.
 */
interface Selection {
  view: InkView;
  col: number;
  row: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  lifted: { c: number; r: number; cell: number }[] | null;
}

/** The ink with a lifted selection put down where it is now; what lands off the body is lost. */
function composite(base: Cells, sel: Selection | null, grids: Record<InkView, Grid>): Cells {
  if (!sel?.lifted) return base;
  const out: Cells = new Map([...base].map(([side, map]) => [side, new Map(map)]));
  for (const { c, r, cell } of sel.lifted) {
    const spot = grids[sel.view][sel.row + sel.dy + r]?.[sel.col + sel.dx + c];
    if (!spot?.on) continue;
    if (!out.has(spot.side)) out.set(spot.side, new Map());
    out.get(spot.side)!.set(spot.at, cell);
  }
  return out;
}

type Tool = "brush" | "erase" | "select";

export function InkEditor({ look, onChange, onView }: { look: Appearance; onChange(ink: Ink | undefined): void; onView?(view: InkView): void }) {
  const grids = useMemo(() => layout(look), [look.headShape]);
  const mask = useMemo(() => bodyMask(grids, look), [grids, look.headShape]);
  const [base, setBase] = useState<Cells>(() => fromInk(look.ink));
  const [sel, setSel] = useState<Selection | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState(1);
  const [level, setLevel] = useState(INK_LEVELS);
  const brush = inkCell(color, level);
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<string[]>([]);
  const shown = useMemo(() => composite(base, sel, grids), [base, sel, grids]);
  const used = countCells(shown);

  // Hand the ink up as it changes, a few times a second at most while a stroke or a slide is under way.
  const report = useRef(onChange);
  report.current = onChange;
  const pending = useRef<{ timer: number; ink: Ink | undefined } | null>(null);
  const flush = () => {
    if (!pending.current) return;
    window.clearTimeout(pending.current.timer);
    const { ink } = pending.current;
    pending.current = null;
    report.current(ink);
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const ink = toInk(shown);
    if (pending.current) pending.current.ink = ink;
    else pending.current = { ink, timer: window.setTimeout(flush, 90) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  useEffect(() => () => flush(), []);

  /** Remember the ink as it is, to undo back to. */
  const remember = () => {
    history.current.push(JSON.stringify(toInk(shown) ?? {}));
    if (history.current.length > 60) history.current.shift();
  };
  const undo = () => {
    const last = history.current.pop();
    if (last === undefined) return;
    setSel(null);
    setBase(fromInk(JSON.parse(last) as Ink));
  };
  /** Put a lifted selection down, and let it go. */
  const commit = () => {
    if (sel?.lifted) setBase(composite(base, sel, grids));
    setSel(null);
  };
  const clear = () => {
    if (!used) return;
    remember();
    setSel(null);
    setBase(new Map());
  };
  /** Lift what is in the selection off the body, to move it. */
  const lift = (s: Selection): Selection => {
    if (s.lifted) return s;
    const lifted: Selection["lifted"] = [];
    const next: Cells = new Map([...base].map(([side, map]) => [side, new Map(map)]));
    for (let r = 0; r < s.h; r++) {
      for (let c = 0; c < s.w; c++) {
        const spot = grids[s.view][s.row + r]?.[s.col + c];
        const ink = spot && next.get(spot.side)?.get(spot.at);
        if (!spot || !ink) continue;
        lifted.push({ c, r, cell: ink });
        next.get(spot.side)!.delete(spot.at);
      }
    }
    setBase(next);
    return { ...s, lifted };
  };
  const removeSelected = () => {
    if (!sel) return;
    remember();
    lift(sel);
    setSel(null);
  };
  const nudge = (dx: number, dy: number) => {
    if (!sel) return;
    if (!sel.lifted) remember();
    const s = lift(sel);
    setSel({ ...s, dx: s.dx + dx, dy: s.dy + dy });
  };

  // ---- pointer ----
  const drag = useRef<{ mode: "paint" | "box" | "move"; view: InkView; col: number; row: number; startDx: number; startDy: number } | null>(null);
  const cellAt = (e: React.PointerEvent): { view: InkView; col: number; row: number } | null => {
    const el = canvas.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * el.width;
    const y = ((e.clientY - rect.top) / rect.height) * el.height;
    const all = Math.floor(x / PX);
    const row = Math.floor(y / PX);
    if (row < 0 || row >= ROWS) return null;
    if (all >= 0 && all < COLS) return { view: "f", col: all, row };
    if (all >= COLS + GAP && all < COLS * 2 + GAP) return { view: "b", col: all - COLS - GAP, row };
    return null;
  };
  /** Ink (or wipe) the cells from one to another, so a quick stroke leaves no gaps. */
  const stroke = (view: InkView, from: { col: number; row: number }, to: { col: number; row: number }) => {
    setBase((prev) => {
      let next = prev;
      let total = countCells(prev);
      const steps = Math.max(Math.abs(to.col - from.col), Math.abs(to.row - from.row), 1);
      for (let i = 0; i <= steps; i++) {
        const col = Math.round(from.col + ((to.col - from.col) * i) / steps);
        const row = Math.round(from.row + ((to.row - from.row) * i) / steps);
        const spot = grids[view][row]?.[col];
        if (!spot?.on) continue;
        const now = next.get(spot.side)?.get(spot.at);
        if (tool === "erase" ? !now : now === brush) continue;
        if (tool !== "erase" && !now && total >= MAX_INK_CELLS) continue;
        if (next === prev) next = new Map(prev);
        const map = new Map(next.get(spot.side) ?? []);
        if (tool === "erase") {
          map.delete(spot.at);
          total--;
        } else {
          if (!now) total++;
          map.set(spot.at, brush);
        }
        next.set(spot.side, map);
      }
      return next;
    });
  };
  const inside = (s: Selection, at: { view: InkView; col: number; row: number }) =>
    s.view === at.view && at.col >= s.col + s.dx && at.col < s.col + s.dx + s.w && at.row >= s.row + s.dy && at.row < s.row + s.dy + s.h;

  const down = (e: React.PointerEvent) => {
    const at = cellAt(e);
    if (!at) return;
    canvas.current?.setPointerCapture(e.pointerId);
    canvas.current?.focus({ preventScroll: true });
    onView?.(at.view);
    if (tool === "select") {
      if (sel && inside(sel, at)) {
        if (!sel.lifted) remember();
        const s = lift(sel);
        setSel(s);
        drag.current = { mode: "move", ...at, startDx: s.dx, startDy: s.dy };
        return;
      }
      commit();
      drag.current = { mode: "box", ...at, startDx: 0, startDy: 0 };
      setSel({ view: at.view, col: at.col, row: at.row, w: 1, h: 1, dx: 0, dy: 0, lifted: null });
      return;
    }
    commit();
    remember();
    drag.current = { mode: "paint", ...at, startDx: 0, startDy: 0 };
    stroke(at.view, at, at);
  };
  const [overInk, setOverInk] = useState(false);
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const at = cellAt(e);
    const inkable = !!at && !!grids[at.view][at.row]?.[at.col]?.on;
    if (inkable !== overInk) setOverInk(inkable);
    if (!d) return;
    if (d.mode === "paint") {
      if (!at || at.view !== d.view) return;
      stroke(d.view, d, at);
      drag.current = { ...d, col: at.col, row: at.row };
      return;
    }
    // Selecting and sliding go on past the edge of the view.
    const el = canvas.current!;
    const rect = el.getBoundingClientRect();
    const col = Math.floor((((e.clientX - rect.left) / rect.width) * el.width) / PX) - (d.view === "b" ? COLS + GAP : 0);
    const row = Math.floor((((e.clientY - rect.top) / rect.height) * el.height) / PX);
    if (d.mode === "box") {
      const c0 = Math.max(0, Math.min(d.col, col));
      const c1 = Math.min(COLS - 1, Math.max(d.col, col));
      const r0 = Math.max(0, Math.min(d.row, row));
      const r1 = Math.min(ROWS - 1, Math.max(d.row, row));
      setSel({ view: d.view, col: c0, row: r0, w: c1 - c0 + 1, h: r1 - r0 + 1, dx: 0, dy: 0, lifted: null });
    } else {
      setSel((s) => (s ? { ...s, dx: d.startDx + col - d.col, dy: d.startDy + row - d.row } : s));
    }
  };
  const up = () => {
    drag.current = null;
    flush();
  };
  const key = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if (sel && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      removeSelected();
    } else if (sel && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      commit();
    } else if (sel && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
      nudge(dx, dy);
    }
  };
  const pick = (t: Tool) => {
    if (t !== "select") commit();
    setTool(t);
  };

  // ---- drawing ----
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    drawDoll(ctx, grids, mask, shown, sel, look);
  }, [grids, mask, shown, sel, look]);

  return (
    <div className="ink-editor">
      <div className="ink-tools" role="toolbar" aria-label="Tattoo tools">
        <span className="ink-tool-group">
          {(
            [
              ["brush", "✎ Draw"],
              ["erase", "⌫ Erase"],
              ["select", "⬚ Select & move"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} type="button" className={`look-chip ${tool === t ? "selected" : ""}`} aria-pressed={tool === t} onClick={() => pick(t)}>
              {label}
            </button>
          ))}
        </span>
        <span className="ink-tool-group ink-colors" role="radiogroup" aria-label="Ink colour">
          {INK_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === i + 1}
              aria-label={i < 4 ? `Grey ${i + 1}` : `Colour ${i - 3}`}
              className={`look-swatch ${color === i + 1 ? "selected" : ""}`}
              style={{ background: inkOver(look.skin, inkCell(i + 1, level)) }}
              onClick={() => {
                setColor(i + 1);
                if (tool !== "brush") pick("brush");
              }}
            />
          ))}
        </span>
        <label className="ink-tool-group ink-opacity">
          <span className="look-label">Opacity</span>
          <input type="range" min={1} max={INK_LEVELS} step={1} value={level} onChange={(e) => setLevel(Number(e.target.value))} aria-valuetext={`${Math.round((level / INK_LEVELS) * 100)}%`} />
          <span className="ink-percent">{Math.round((level / INK_LEVELS) * 100)}%</span>
        </label>
        <span className="ink-tool-group">
          <button type="button" className="look-chip" onClick={undo}>
            ↶ Undo
          </button>
          <button type="button" className="look-chip" onClick={clear} disabled={!used}>
            Clear
          </button>
        </span>
      </div>
      <div className="ink-views" aria-hidden>
        <span>Front</span>
        <span>Back</span>
      </div>
      <canvas
        ref={canvas}
        className={`ink-doll tool-${tool} ${overInk ? "over-ink" : ""}`}
        width={(COLS * 2 + GAP) * PX}
        height={ROWS * PX}
        tabIndex={0}
        aria-label="Paper doll of your hero, front and back, to draw tattoos on"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      />
      <p className="muted hint">
        {tool === "select" ? "Drag a box round some ink, then drag inside it to slide it about. Arrow keys nudge it; Delete wipes it." : "Draw on the head, forearms and legs. Hair and clothes cover what is under them."}{" "}
        <span className="ink-count">
          {used} / {MAX_INK_CELLS}
        </span>
      </p>
    </div>
  );
}

/**
 * The rest of the body, around the parts that can be inked, as boxes of cells (col, row, width, height) on
 * either view: the neck, shoulders and chest, the upper arms, the hips, the hands and the feet. Drawn as
 * skin like the rest, so the doll is one figure; only the inkable parts take ink.
 */
const BODY: [number, number, number, number][] = [
  [19, 20, 8, 10], // neck
  [4, 29, 38, 3], // across the shoulders
  [3, 30, 40, 2],
  [1, 31, 8, 4], // upper arms
  [37, 31, 8, 4],
  [11, 29, 24, 26], // chest and belly
  [10, 55, 26, 4], // hips
  [10, 58, 12, 2], // tops of the thighs
  [24, 58, 12, 2],
  [2, 47, 6, 1], // hands, rounded
  [1, 48, 8, 2],
  [2, 50, 6, 1],
  [38, 47, 6, 1],
  [37, 48, 8, 2],
  [38, 50, 6, 1],
  [12, 71, 8, 1], // feet
  [11, 72, 10, 2],
  [26, 71, 8, 1],
  [25, 72, 10, 2],
];

/** Which cells of each view are the body: the inkable skin, the rest of the body, and the ears. */
function bodyMask(grids: Record<InkView, Grid>, look: Appearance): Record<InkView, boolean[][]> {
  const guides = inkGuides(look);
  const head = inkSurface("head", look);
  const out = {} as Record<InkView, boolean[][]>;
  for (const view of VIEWS) {
    const mask = grids[view].map((row) => row.map((spot) => !!spot?.on));
    const fill = (c0: number, r0: number, w: number, h: number) => {
      for (let r = Math.max(0, r0); r < Math.min(ROWS, r0 + h); r++) for (let c = Math.max(0, c0); c < Math.min(COLS, c0 + w); c++) mask[r][c] = true;
    };
    for (const box of BODY) fill(...box);
    // The ears, just out past the head's outline at the sides.
    const earRow = Math.round((head.top - guides.earY) / head.cell);
    for (const s of [-1, 1]) {
      const edge = 9 + (s * guides.earX + head.half) / head.cell;
      const c0 = Math.round(s < 0 ? edge - 2 : edge);
      fill(c0, earRow - 2, 2, 4);
    }
    out[view] = mask;
  }
  return out;
}

/** The doll: the hero's body as a plain figure in their skin, the ink on it, and any selection. */
function drawDoll(ctx: CanvasRenderingContext2D, grids: Record<InkView, Grid>, mask: Record<InkView, boolean[][]>, cells: Cells, sel: Selection | null, look: Appearance) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const edge = shade(look.skin, -0.32);
  const lit = shade(look.skin, 0.06);
  for (const view of VIEWS) {
    const ox = view === "f" ? 0 : (COLS + GAP) * PX;
    const body = mask[view];
    const grid = grids[view];
    const isBody = (r: number, c: number) => !!body[r]?.[c];
    // The skin, with the ink on it.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!isBody(r, c)) continue;
        const spot = grid[r][c];
        const ink = spot?.on ? cells.get(spot.side)?.get(spot.at) : undefined;
        // A touch lighter toward the top-left of each limb, for a little roundness.
        ctx.fillStyle = ink ? inkOver(look.skin, ink) : !isBody(r - 1, c) || !isBody(r, c - 1) ? lit : look.skin;
        ctx.fillRect(ox + c * PX, r * PX, PX, PX);
      }
    }
    // Faint dots where the eyes and mouth are, to place a face tattoo by.
    if (view === "f") {
      const guides = inkGuides(look);
      const head = inkSurface("head", look);
      const at = (x: number, y: number): [number, number] => [ox + (9 + (x + head.half) / head.cell) * PX, ((head.top - y) / head.cell) * PX];
      ctx.fillStyle = hexAlpha("#1b1830", 0.22);
      for (const [x, y] of [[-guides.eyeX, guides.eyeY], [guides.eyeX, guides.eyeY], [0, guides.mouthY]]) {
        const [px, py] = at(x, y);
        ctx.beginPath();
        ctx.arc(px, py, PX * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // An outline wherever the body meets the background.
    ctx.fillStyle = edge;
    const line = Math.max(1, Math.round(PX / 4));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!isBody(r, c)) continue;
        const x = ox + c * PX;
        const y = r * PX;
        if (!isBody(r - 1, c)) ctx.fillRect(x, y, PX, line);
        if (!isBody(r + 1, c)) ctx.fillRect(x, y + PX - line, PX, line);
        if (!isBody(r, c - 1)) ctx.fillRect(x, y, line, PX);
        if (!isBody(r, c + 1)) ctx.fillRect(x + PX - line, y, line, PX);
      }
    }

    // The selection, and what it carries.
    if (sel?.view === view) {
      const x = ox + (sel.col + sel.dx) * PX;
      const y = (sel.row + sel.dy) * PX;
      if (sel.lifted) {
        for (const { c, r, cell } of sel.lifted) {
          const spot = grid[sel.row + sel.dy + r]?.[sel.col + sel.dx + c];
          // Off the inkable skin, ink is shown faintly: it is lost if put down there.
          const shown = inkOver(look.skin, cell);
          ctx.fillStyle = spot?.on ? shown : hexAlpha(shown, 0.35);
          ctx.fillRect(x + c * PX, y + r * PX, PX, PX);
        }
      }
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffd23f";
      ctx.strokeRect(x + 0.75, y + 0.75, sel.w * PX - 1.5, sel.h * PX - 1.5);
      ctx.restore();
    }
  }
}

/** A colour made lighter (k > 0) or darker (k < 0). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
