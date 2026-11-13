// A HUD panel the player can drag out of the way.
//
// With a mouse, drag from any part of the panel that is not a control. On
// touch, drag from the grip in the corner, so swiping inside a panel still
// scrolls it. Double-click (or double-tap) the grip to put the panel back.
// Each panel remembers where it was left, per browser.
//
// Every panel also has a minimize button that folds it down to its title.
// The larger ones start folded on a phone so they do not cover the map.
//
// A `resizable` panel also has a handle in each corner. Dragging one changes
// the panel's size while the opposite corner stays put; double-click a
// handle to go back to the default size.
//
// The title and tools sit outside `.panel-body`. A panel whose content can
// run long scrolls only its body (see styles.css), so they stay at the top.
//
// The offset is applied with the CSS `translate` property, which stacks with
// whatever `transform` the panel's own styles use for centring. The view the
// panel sits in may be zoomed (the UI scale in Options), so pointer movement,
// which is in screen pixels, is divided by that zoom before it is applied.
//
// Options can also put every panel back as it started: `resetPanels()`.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { onUiScaleChange, uiZoom } from "./uiScale";

interface Offset {
  x: number;
  y: number;
}

const ZERO: Offset = { x: 0, y: 0 };
const INTERACTIVE = "button, input, select, textarea, a, label, [data-nodrag]";
/** Pixels of movement before a press becomes a drag. */
const THRESHOLD = 5;
/** How much of a panel must stay on screen. */
const KEEP = 48;

const PREFIX = "gq.panel.";
const storageKey = (id: string) => `${PREFIX}${id}`;

const resetListeners = new Set<() => void>();

/**
 * Forget where every panel was left, its size and whether it was minimized,
 * and put the open ones back as they start. Panels not on screen pick up
 * their defaults the next time they are shown.
 */
export function resetPanels() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // Nothing remembered to forget.
  }
  for (const fn of resetListeners) fn();
}

interface Size {
  w: number;
  h: number;
}

/** Smallest a panel may be resized to. */
const MIN_SIZE: Size = { w: 300, h: 240 };
const CORNERS = [
  { name: "nw", sx: -1, sy: -1 },
  { name: "ne", sx: 1, sy: -1 },
  { name: "sw", sx: -1, sy: 1 },
  { name: "se", sx: 1, sy: 1 },
] as const;

function loadSize(id: string): Size | null {
  try {
    const raw = JSON.parse(localStorage.getItem(`${storageKey(id)}.size`) ?? "null") as Size | null;
    if (!raw || !Number.isFinite(raw.w) || !Number.isFinite(raw.h)) return null;
    // A size saved on a bigger screen (or at a smaller UI scale) is trimmed to fit this one.
    const z = uiZoom();
    return { w: Math.min(raw.w, innerWidth / z), h: Math.min(raw.h, innerHeight / z) };
  } catch {
    return null;
  }
}

function saveSize(id: string, size: Size | null) {
  try {
    if (size) localStorage.setItem(`${storageKey(id)}.size`, JSON.stringify(size));
    else localStorage.removeItem(`${storageKey(id)}.size`);
  } catch {
    // Not remembered.
  }
}

function load(id: string): Offset {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null") as Offset | null;
    return raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : ZERO;
  } catch {
    return ZERO;
  }
}

function save(id: string, offset: Offset) {
  try {
    if (offset.x === 0 && offset.y === 0) localStorage.removeItem(storageKey(id));
    else localStorage.setItem(storageKey(id), JSON.stringify(offset));
  } catch {
    // Storage unavailable (private mode): the panel just will not remember.
  }
}

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** Stable name used to remember this panel's position. */
  id: string;
  /** Names the panel. Shown when it is minimized, and as its header unless `compact`. */
  title: string;
  /** A slim bar with no room for a header: the title only appears once minimized. */
  compact?: boolean;
  /** Give the panel a resize handle in each corner. */
  resizable?: boolean;
  /** Start folded on narrow screens. The player's own choice, once made, wins. */
  foldOnPhone?: boolean;
  /** Start folded everywhere, until the player unfolds it once. */
  startFolded?: boolean;
  /** Change this number to unfold the panel from outside (it does not change the remembered choice). */
  unfold?: number;
  children: ReactNode;
}

const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;

function loadFolded(id: string, foldOnPhone: boolean, startFolded = false): boolean {
  try {
    const raw = localStorage.getItem(`${storageKey(id)}.folded`);
    if (raw !== null) return raw === "1";
  } catch {
    // Fall through to the default.
  }
  return startFolded || (foldOnPhone && isPhone());
}

export function DragPanel({ id, title, compact = false, resizable = false, foldOnPhone = false, startFolded = false, unfold = 0, className = "", children, style, ...rest }: Props) {
  const [size, setSize] = useState<Size | null>(() => (resizable ? loadSize(id) : null));
  /** While a corner is being dragged: where the opposite corner must stay. */
  const pin = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const [folded, setFolded] = useState(() => loadFolded(id, foldOnPhone, startFolded));
  const toggle = () => {
    setFolded((f) => {
      try {
        localStorage.setItem(`${storageKey(id)}.folded`, f ? "0" : "1");
      } catch {
        // Not remembered, but still toggles.
      }
      return !f;
    });
  };
  useEffect(() => {
    if (unfold) setFolded(false);
  }, [unfold]);
  const el = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Offset>(() => load(id));
  const [dragging, setDragging] = useState(false);
  const live = useRef(offset);
  live.current = offset;

  const reset = useCallback(() => {
    setOffset(ZERO);
    save(id, ZERO);
  }, [id]);

  // A position saved on a bigger screen can leave the panel out of reach on a smaller one.
  useEffect(() => {
    const check = () => {
      const r = el.current?.getBoundingClientRect();
      if (!r || (live.current.x === 0 && live.current.y === 0)) return;
      if (r.right < KEEP || r.left > innerWidth - KEEP || r.bottom < KEEP || r.top > innerHeight - KEEP) reset();
    };
    check();
    addEventListener("resize", check);
    const stop = onUiScaleChange(() => requestAnimationFrame(check));
    return () => {
      removeEventListener("resize", check);
      stop();
    };
  }, [reset]);

  // Options asked for every panel to go back as it started.
  useEffect(() => {
    const back = () => {
      pin.current = null;
      setOffset(ZERO);
      setSize(null);
      setFolded(loadFolded(id, foldOnPhone, startFolded));
    };
    resetListeners.add(back);
    return () => {
      resetListeners.delete(back);
    };
  }, [id, foldOnPhone, startFolded]);

  // The panel may be centred by its parent, so growing it would move both edges.
  // After each size change, shift the panel so the pinned corner is back where it was.
  useLayoutEffect(() => {
    const p = pin.current;
    const r = el.current?.getBoundingClientRect();
    if (!p || !r) return;
    const z = uiZoom();
    const dx = (p.x - (p.sx > 0 ? r.left : r.right)) / z;
    const dy = (p.y - (p.sy > 0 ? r.top : r.bottom)) / z;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setOffset((o) => ({ x: Math.round(o.x + dx), y: Math.round(o.y + dy) }));
  });

  const startResize = (sx: number, sy: number) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || !el.current) return;
    e.stopPropagation();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const rect = el.current.getBoundingClientRect();
    pin.current = { sx, sy, x: sx > 0 ? rect.left : rect.right, y: sy > 0 ? rect.top : rect.bottom };
    // Measured on screen, applied in the panel's own (zoomed) pixels.
    const z = uiZoom();
    let latest: Size = { w: rect.width / z, h: rect.height / z };
    setDragging(true);

    const move = (ev: PointerEvent) => {
      // The dragged corner cannot pass the pinned one, nor leave the screen.
      const maxW = (sx > 0 ? innerWidth - rect.left : rect.right) / z;
      const maxH = (sy > 0 ? innerHeight - rect.top : rect.bottom) / z;
      latest = {
        w: Math.round(Math.max(Math.min(MIN_SIZE.w, maxW), Math.min(maxW, (rect.width + sx * (ev.clientX - start.x)) / z))),
        h: Math.round(Math.max(Math.min(MIN_SIZE.h, maxH), Math.min(maxH, (rect.height + sy * (ev.clientY - start.y)) / z))),
      };
      setSize(latest);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      setDragging(false);
      saveSize(id, latest);
      // Let the last corner correction land before saving where the panel ended up.
      setTimeout(() => {
        pin.current = null;
        save(id, live.current);
      }, 60);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const resetSize = () => {
    pin.current = null;
    setSize(null);
    saveSize(id, null);
    reset();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !el.current) return;
    const target = e.target as HTMLElement;
    if (target.closest(".resize")) return;
    const onGrip = !!target.closest(".grip");
    if (!onGrip && (e.pointerType !== "mouse" || target.closest(INTERACTIVE))) return;

    const start = { x: e.clientX, y: e.clientY };
    const from = live.current;
    const rect = el.current.getBoundingClientRect();
    const z = uiZoom();
    let moved = false;
    // Tracked here as well as in state, so the release saves the final position even if React has not re-rendered yet.
    let latest = from;

    const move = (ev: PointerEvent) => {
      let dx = ev.clientX - start.x;
      let dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < THRESHOLD) return;
      moved = true;
      setDragging(true);
      // Keep a strip of the panel on screen so it can always be grabbed again.
      dx = Math.max(KEEP - rect.right, Math.min(innerWidth - KEEP - rect.left, dx));
      dy = Math.max(-rect.top, Math.min(innerHeight - KEEP - rect.top, dy));
      latest = { x: Math.round(from.x + dx / z), y: Math.round(from.y + dy / z) };
      setOffset(latest);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      if (!moved) return;
      setDragging(false);
      save(id, latest);
      // The release would otherwise count as a click on whatever is under it.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={el}
      {...rest}
      className={`${className} draggable ${dragging ? "dragging" : ""} ${folded ? "folded" : ""} ${resizable ? "resizable" : ""}`}
      style={{
        ...style,
        translate: `${offset.x}px ${offset.y}px`,
        // A minimized panel shrinks to its title whatever size it was given.
        ...(size && !folded ? { width: size.w, height: size.h, maxWidth: "none", maxHeight: "none" } : {}),
      }}
      onPointerDown={onPointerDown}
    >
      <span className="panel-tools">
        <button className="min-btn" aria-expanded={!folded} aria-label={folded ? `Show ${title}` : `Minimize ${title}`} title={folded ? "Show" : "Minimize"} onClick={toggle}>
          {folded ? "+" : "–"}
        </button>
        <span className="grip" title="Drag to move. Double-click to put it back." onDoubleClick={reset} aria-hidden>
          ⠿
        </span>
      </span>
      {(folded || !compact) && (
        <button className="panel-title" tabIndex={-1} onClick={toggle}>
          {title}
        </button>
      )}
      {/* The panel's own content. Long panels scroll this, not the whole frame, so the title and tools stay put. */}
      <div className="panel-body">{children}</div>
      {resizable &&
        !folded &&
        CORNERS.map((c) => (
          <span
            key={c.name}
            className={`resize ${c.name}`}
            title="Drag to resize. Double-click for the default size."
            onPointerDown={startResize(c.sx, c.sy)}
            onDoubleClick={resetSize}
            aria-hidden
          />
        ))}
    </div>
  );
}
