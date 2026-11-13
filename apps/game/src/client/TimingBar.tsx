// The timing bar for a gathering outing: a marker moving along it and the
// mark to stop it on. It starts moving when it is shown, and the player stops
// it with the button, a press on the bar, or the space bar. What is sent is
// how long after it started they pressed; the server checks that against its
// own clock.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { TIMING, TIMING_LIMIT_MS, markerAt, timingGrade, type GatherSpot, type GatherView, type TimingGrade } from "@gantt-quest/world";

const LOOK: Record<GatherSpot, { marker: string; button: string }> = {
  fishing: { marker: "🐟", button: "Reel!" },
  quarry: { marker: "⛏", button: "Strike!" },
  felling: { marker: "🪓", button: "Swing!" },
};

export function TimingBar({ aim, spot, busy, stop, onStart, onPressed, pressRef }: {
  aim: NonNullable<GatherView["aim"]>;
  spot: GatherSpot;
  busy: boolean;
  stop(at: number): void;
  /** Told when the marker starts, by `performance.now()`, so a picture of it elsewhere keeps the same time. */
  onStart?(startedAt: number): void;
  /** Told the moment the player presses, before the server has a say. */
  onPressed?(at: number, grade: TimingGrade): void;
  /** Filled with a press, for something else (the grove's canvas) to press with. */
  pressRef?: MutableRefObject<(() => void) | null>;
}) {
  const marker = useRef<HTMLDivElement>(null);
  const started = useRef(performance.now());
  /** When the player pressed, in ms after the marker started; null until they do. The marker stops there at once. */
  const stopped = useRef<number | null>(null);
  const [verdict, setVerdict] = useState<TimingGrade | null>(null);
  /** Past the time limit: any stop now counts as too slow, so say so instead of letting the marker run on silently. */
  const [overdue, setOverdue] = useState(false);
  const { motion } = aim;
  const told = useRef(onStart);
  told.current = onStart;
  useEffect(() => {
    started.current = performance.now();
    stopped.current = null;
    setVerdict(null);
    setOverdue(false);
    told.current?.(started.current);
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const at = stopped.current ?? performance.now() - started.current;
      if (stopped.current === null && at > TIMING_LIMIT_MS) setOverdue(true);
      if (marker.current) marker.current.style.left = `${markerAt(motion, at) * 100}%`;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [motion]);
  // On a short screen the bar can open below the fold: bring it into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [motion]);
  // Acts on the press itself (pointer down, key down), not the release, and freezes the marker where it was.
  const press = (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (stopped.current !== null || busy) return;
    const at = Math.round(performance.now() - started.current);
    stopped.current = at;
    // What it looks like from here; the server decides, on the same moment.
    const grade = timingGrade(motion, at);
    setVerdict(grade);
    onPressed?.(at, grade);
    stop(at);
  };
  if (pressRef) pressRef.current = () => press();
  useEffect(() => () => {
    if (pressRef) pressRef.current = null;
  }, [pressRef]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || (e.target as HTMLElement)?.closest?.("input, textarea")) return;
      press(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const left = (motion.zone - motion.width / 2) * 100;
  return (
    <div className={`timing ${spot}`} ref={box}>
      <div className="timing-bar" onPointerDown={press}>
        <div className="timing-zone" style={{ left: `${left}%`, width: `${motion.width * 100}%` }}>
          <div className="timing-sweet" />
        </div>
        <div className={`timing-marker ${verdict ? "stopped" : ""}`} ref={marker}>{LOOK[spot].marker}</div>
        {verdict && <div className={`timing-verdict timing-${verdict}`}>{TIMING[verdict].label}!</div>}
      </div>
      <div className="row">
        <button className="primary" disabled={busy || verdict !== null} onPointerDown={press} onKeyDown={(e) => (e.key === "Enter" ? press(e) : undefined)}>{LOOK[spot].button}</button>
        {overdue && !verdict && <span className="bad">Too slow now: whenever you stop it, the roll is {TIMING.late.bonus}%.</span>}
        <span className="muted">Stop it on the mark (or press space). Bang on the middle: +{TIMING.perfect.bonus}% a roll{spot === "felling" ? " and it falls true" : ""}. On the mark: +{TIMING.good.bonus}%. Off it: {TIMING.miss.bonus}%.</span>
      </div>
    </div>
  );
}
