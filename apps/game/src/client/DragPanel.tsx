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
// The offset is applied with the CSS `translate` property, which stacks with
// whatever `transform` the panel's own styles use for centring.

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

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

const storageKey = (id: string) => `gq.panel.${id}`;

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
  /** Start folded on narrow screens. The player's own choice, once made, wins. */
  foldOnPhone?: boolean;
  children: ReactNode;
}

const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;

function loadFolded(id: string, foldOnPhone: boolean): boolean {
  try {
    const raw = localStorage.getItem(`${storageKey(id)}.folded`);
    if (raw !== null) return raw === "1";
  } catch {
    // Fall through to the default.
  }
  return foldOnPhone && isPhone();
}

export function DragPanel({ id, title, compact = false, foldOnPhone = false, className = "", children, style, ...rest }: Props) {
  const [folded, setFolded] = useState(() => loadFolded(id, foldOnPhone));
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
    return () => removeEventListener("resize", check);
  }, [reset]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !el.current) return;
    const target = e.target as HTMLElement;
    const onGrip = !!target.closest(".grip");
    if (!onGrip && (e.pointerType !== "mouse" || target.closest(INTERACTIVE))) return;

    const start = { x: e.clientX, y: e.clientY };
    const from = live.current;
    const rect = el.current.getBoundingClientRect();
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
      latest = { x: Math.round(from.x + dx), y: Math.round(from.y + dy) };
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
      className={`${className} draggable ${dragging ? "dragging" : ""} ${folded ? "folded" : ""}`}
      style={{ ...style, translate: `${offset.x}px ${offset.y}px` }}
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
      {children}
    </div>
  );
}
