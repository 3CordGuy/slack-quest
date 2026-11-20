// The turn order: a board hung from the top of the view with a face for
// every fighter, left to right in the order they act. Nobody shares a turn,
// so there is one face to a place.
//
//   [Round] [face][face][FACE][face][face] ...
//   [  2  ]  hp    hp   [ hp ]  hp    hp
//                         ^
//                     Dire Wolf
//
// Whose turn it is hangs lower and larger out of the board, lit in its
// side's colour, with a pointer and its name under it. Your own heroes are
// ringed in gold, the rest of the crew framed in sea-green, enemies in red.
// Those who have acted this round are faded; the fallen are grey and struck
// through. Each has its health under it (a shield after it, pale). Pointing
// at a face says who it is, what they have left and what they rolled for the
// order (and the roll that broke a tie, if one did).
//
// The faces shrink as the fight grows. Past the point where they would be
// too small to read, the row runs off the board's ends instead: it keeps
// whoever's turn it is in the middle, and the wheel moves it along.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "./fight.css";

export interface InitiativeUnit {
  id: string;
  name: string;
  side: "hero" | "enemy";
  /** The face: an image URL (render/sprites spriteDataUrl). */
  portrait: string;
  hp: number;
  maxHp: number;
  shield?: number;
  /** What they rolled for the order, and the roll that broke a tie, if one did. */
  init: number;
  tie?: number;
  /** Whose turn it is now. */
  turn: boolean;
  /** Has acted this round. */
  spent: boolean;
  down: boolean;
  /** One of this player's own. */
  mine: boolean;
  /** In the order but not seen: no face, no health. */
  hidden?: boolean;
}

export interface InitiativeStripProps {
  round: number;
  units: InitiativeUnit[];
  /** A face was clicked: look at them on the map. */
  onPick?: (id: string) => void;
}

export function InitiativeStrip({ round, units, onPick }: InitiativeStripProps) {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  /** How far the row is run along under the board, and how far it can be. */
  const [slide, setSlide] = useState({ at: 0, max: 0 });
  const slideNow = useRef(slide);
  slideNow.current = slide;
  /** Where along the board the middle of whoever's turn it is lies: their name hangs there, under the pointer. */
  const [nowX, setNowX] = useState<number | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number } | null>(null);

  const now = units.find((u) => u.turn);
  const current = now?.id ?? null;
  const order = units.map((u) => u.id).join(",");

  /** Measure the row against the board, and (with `follow`) bring whoever's turn it is to the middle. */
  const settle = useCallback((follow: boolean) => {
    const v = view.current;
    const t = track.current;
    if (!v || !t) return;
    const max = Math.max(0, t.scrollWidth - v.clientWidth);
    const face = current !== null ? t.querySelector<HTMLElement>(`[data-id="${CSS.escape(current)}"]`) : null;
    const mid = face ? face.offsetLeft + face.offsetWidth / 2 : null;
    const was = slideNow.current;
    const want = follow && mid !== null ? mid - v.clientWidth / 2 : was.at;
    const at = Math.round(Math.max(0, Math.min(max, want)));
    if (at !== was.at || max !== was.max) setSlide({ at, max });
    setNowX(mid === null ? null : Math.round(v.offsetLeft + mid - at));
  }, [current]);

  useLayoutEffect(() => settle(true), [settle, order]);
  useEffect(() => {
    const v = view.current;
    if (!v || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => settle(true));
    watch.observe(v);
    return () => watch.disconnect();
  }, [settle]);

  const point = (id: string, el: HTMLElement) => {
    const board = root.current;
    const base = board?.getBoundingClientRect();
    if (!board || !base || base.width <= 0) return;
    const r = el.getBoundingClientRect();
    // The view is zoomed by the UI scale: screen pixels are turned back into the board's own.
    setTip({ id, x: (r.left + r.width / 2 - base.left) * (board.offsetWidth / base.width) });
  };
  const shown = tip ? units.find((u) => u.id === tip.id) : undefined;

  return (
    <div ref={root} className="fight-ui fight-order" style={{ "--n": Math.max(1, units.length) } as CSSProperties}>
      <div className="fo-board" role="group" aria-label={`Turn order, round ${round}`}>
        <div className="fo-round"><span>Round</span><strong key={round}>{round}</strong></div>
        <div
          ref={view}
          className={`fo-view ${slide.at > 0 ? "more-left" : ""} ${slide.at < slide.max ? "more-right" : ""}`}
          onWheel={(e) => {
            if (slide.max <= 0) return;
            const by = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            const at = Math.max(0, Math.min(slide.max, slide.at + by));
            setSlide({ ...slide, at });
            setNowX((x) => (x === null ? null : x + slide.at - at));
            setTip(null);
          }}
        >
          <div ref={track} className="fo-track" style={{ translate: `${-slide.at}px 0` }}>
            {units.map((u) => {
              const whole = Math.max(u.maxHp, u.hp + (u.shield ?? 0), 1);
              return (
                <button
                  key={u.id}
                  type="button"
                  data-id={u.id}
                  className={`fo-face ${u.side} ${u.mine ? "mine" : ""} ${u.turn ? "turn" : ""} ${u.spent && !u.turn ? "spent" : ""} ${u.down ? "down" : ""} ${u.hidden ? "unseen" : ""}`}
                  aria-label={`${u.name}${u.turn ? ", their turn now" : ""}${u.down ? ", down" : ""}`}
                  aria-current={u.turn ? "true" : undefined}
                  onClick={() => onPick?.(u.id)}
                  onPointerEnter={(e) => point(u.id, e.currentTarget)}
                  onPointerLeave={() => setTip(null)}
                  onFocus={(e) => point(u.id, e.currentTarget)}
                  onBlur={() => setTip(null)}
                >
                  <span className="fo-pic">
                    {u.hidden ? <span className="fo-unseen" aria-hidden>?</span> : <img src={u.portrait} alt="" draggable={false} />}
                  </span>
                  <span className="fo-hp" aria-hidden>
                    {!u.hidden && <i style={{ width: `${(100 * Math.max(0, u.hp)) / whole}%` }} />}
                    {!u.hidden && !!u.shield && <b style={{ width: `${(100 * u.shield) / whole}%` }} />}
                  </span>
                  {u.turn && <span className="fo-point" aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {/* The name of whoever's turn it is, under their pointer: outside the row, so the board's ends do not cut it off. */}
      {now && nowX !== null && <div key={now.id} className={`fo-now ${now.side} ${now.mine ? "mine" : ""}`} style={{ left: `clamp(48px, ${nowX}px, calc(100% - 48px))` }} aria-hidden>{now.name}</div>}
      {shown && tip && (
        <div className={`fo-tip ${shown.side} ${shown.mine ? "mine" : ""} ${shown.turn ? "low" : ""}`} style={{ left: tip.x }} role="tooltip">
          <b>{shown.name}</b>
          {shown.hidden
            ? <span>Not in sight.</span>
            : <span><em>{Math.max(0, shown.hp)}</em> / {shown.maxHp} HP{shown.shield ? <> · <em>{shown.shield}</em> shield</> : null}</span>}
          <span>Initiative <em>{shown.init}</em>{shown.tie !== undefined ? <> · tie broken on a <em>{shown.tie}</em></> : null}</span>
          <span>{shown.down ? "Down." : shown.turn ? "Their turn now." : shown.spent ? "Has acted this round." : "Still to act this round."}{shown.mine ? " Yours." : ""}</span>
        </div>
      )}
    </div>
  );
}
