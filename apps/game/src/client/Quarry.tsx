// The quarry, played in the Harbor itself: the camera flies down into the
// rock face (render/MineStage.ts) and this is the little HUD laid over it.
// The clock, how charged the swing is, what has come out so far, and the way
// out. Every blow is played on the stage at once; this sends them on to the
// server, one report at a time, whenever one breaks a rock.

import { useEffect, useRef, useState } from "react";
import { HARBOR_GATHER, RESOURCE_KINDS, type Blow, type GatherChoice, type GatherView, type Resources } from "@gantt-quest/world";
import { api, type GatherStatus, type XpResult } from "./api";
import { ResourceChips } from "./hutDrops";
import { MineStage, type MineCallbacks } from "./render/MineStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import "./quarry.css";

type Status = GatherStatus & { paid?: Resources; xp?: XpResult };

/** How long "Time!" shows before the haul is carried out. */
const TIME_UP_MS = 1300;


export function Quarry({ outing, world, apply, onLeave }: {
  outing: GatherView;
  world: WorldRenderer;
  /** Take a new status from the server (and what an ended outing paid). */
  apply(next: Status): void;
  /** Step away from the face, leaving the outing open. */
  onLeave(): void;
}) {
  const mine = outing.mine!;
  const stage = useRef<MineStage | null>(null);
  const [phase, setPhase] = useState<"ready" | "digging" | "time" | "hauling">(mine.leftMs === null ? "ready" : mine.leftMs > 0 ? "digging" : "time");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timerBar = useRef<HTMLDivElement>(null);
  const timerText = useRef<HTMLSpanElement>(null);
  const chargeFill = useRef<HTMLDivElement>(null);
  const chargeWord = useRef<HTMLSpanElement>(null);
  const hit = useRef<HTMLDivElement>(null);

  // Blows not yet sent, whether one of them broke a rock (and so must be sent), and whether a report is on its way.
  const pending = useRef<Blow[]>([]);
  const due = useRef(false);
  const sending = useRef<Promise<void> | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const send = (): Promise<void> => {
    if (sending.current) return sending.current;
    if (!due.current || pending.current.length === 0) return Promise.resolve();
    const blows = pending.current.splice(0);
    due.current = false;
    const go = (async () => {
      try {
        const next = await api.gatherStep({ t: "blows", blows } as GatherChoice);
        applyRef.current(next);
        if (next.outing?.mine) stage.current?.sync(next.outing.mine);
      } catch (e) {
        // Refused: show the face as the server has it and carry on from there.
        setError((e as Error).message);
        pending.current = [];
        const fresh = await api.gather().catch(() => null);
        if (fresh) {
          applyRef.current(fresh);
          if (fresh.outing?.mine) stage.current?.sync(fresh.outing.mine, true);
        }
      } finally {
        sending.current = null;
      }
      if (due.current) await send();
    })();
    sending.current = go;
    return go;
  };

  const haulOut = async (wait: number) => {
    setPhase((p) => (p === "hauling" ? p : wait > 0 ? "time" : "hauling"));
    stage.current?.stop();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    setPhase("hauling");
    // Whatever was struck before the end still counts.
    if (pending.current.length > 0) due.current = true;
    await send();
    try {
      applyRef.current(await api.gatherStep({ t: "bank" }));
    } catch (e) {
      setError((e as Error).message);
      setPhase("time");
    }
  };
  const haulRef = useRef(haulOut);
  haulRef.current = haulOut;

  // The set goes up at the quarry when the panel opens on an outing there, and the camera flies down into it.
  useEffect(() => {
    const callbacks: MineCallbacks = {
      onBlow: (blow, broken) => {
        pending.current.push(blow);
        if (broken.length > 0) {
          due.current = true;
          void send();
        }
      },
      onTimeUp: () => void haulRef.current(TIME_UP_MS),
      onCharge: (charge, ready) => {
        if (chargeFill.current) {
          chargeFill.current.style.width = `${Math.round(charge * 100)}%`;
          chargeFill.current.dataset.level = charge >= 1 ? "full" : charge >= 0.5 ? "half" : "tap";
        }
        if (chargeWord.current) chargeWord.current.textContent = !ready ? "…" : charge >= 1 ? "Heavy! (3 + knocks)" : charge >= 0.5 ? "Hard (2)" : charge > 0 ? "Charging" : "Tap (1)";
      },
    };
    // The set goes up on the quarry's hex (whose own model it stands in for) and the camera orbits down into it.
    const s = world.startMinigame((group) => new MineStage(world, group, mine, callbacks), HARBOR_GATHER.quarry, "quarry");
    stage.current = s;
    // The Harbor's own panels (docks, chat, crew) step aside while the face fills the screen.
    document.body.classList.add("mining");
    // Back after a reload part way through: pick the clock up where the server has it.
    if (mine.leftMs !== null) s.start(mine.ms - mine.leftMs);
    return () => {
      document.body.classList.remove("mining");
      stage.current = null;
      // Fly back out to the map; the set comes down once the camera is clear of it.
      s.leave();
    };
    // One stage for the life of this view of the outing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // The clock, drawn straight into the bar.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const left = stage.current?.leftMs ?? mine.leftMs ?? mine.ms;
      const frac = Math.max(0, Math.min(1, left / mine.ms));
      if (timerBar.current) {
        timerBar.current.style.width = `${frac * 100}%`;
        timerBar.current.dataset.low = left < 5000 ? "1" : "0";
      }
      if (timerText.current) timerText.current.textContent = `${(left / 1000).toFixed(1)}s`;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [mine.ms, mine.leftMs]);

  // Space swings at the rock under the pointer, like a press.
  useEffect(() => {
    let held = false;
    let at = { x: innerWidth / 2, y: innerHeight / 2 };
    const move = (e: PointerEvent) => (at = { x: e.clientX, y: e.clientY });
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || held) return;
      e.preventDefault();
      held = true;
      stage.current?.pressDown(at.x, at.y);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !held) return;
      held = false;
      stage.current?.pressUp(at.x, at.y);
    };
    addEventListener("pointermove", move);
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, []);

  const begin = async () => {
    setStarting(true);
    setError(null);
    try {
      const next = await api.gatherStep({ t: "dig" });
      applyRef.current(next);
      stage.current?.start(0);
      setPhase("digging");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const finds = outing.log.filter((e) => Object.keys(e.gained).length > 0).slice(-3);
  const haul = outing.haul;
  const any = RESOURCE_KINDS.some((k) => (haul[k] ?? 0) > 0);

  return (
    <div className={`overlay mine-mode ${phase}`}>
      <div
        ref={hit}
        className="mine-hit"
        aria-label="The rock face: press on a rock to swing, hold to charge"
        onPointerDown={(e) => {
          if (phase !== "digging") return;
          try {
            hit.current?.setPointerCapture(e.pointerId);
          } catch {
            // Capture only keeps a held swing alive off the layer; swing without it.
          }
          stage.current?.pressDown(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => stage.current?.pointerMove(e.clientX, e.clientY)}
        onPointerUp={(e) => stage.current?.pressUp(e.clientX, e.clientY)}
        onPointerCancel={() => stage.current?.pointerLeave()}
        onPointerLeave={() => stage.current?.pointerLeave()}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="mine-top">
        <div className="mine-clock" aria-label="Time left">
          <div className="mine-clock-fill" ref={timerBar} />
          <span ref={timerText} className="mine-clock-text">{(mine.ms / 1000).toFixed(1)}s</span>
        </div>
        {any && (
          <div className="mine-haul">
            <ResourceChips resources={haul} />
          </div>
        )}
      </div>

      <div className="mine-side">
        <ul className="mine-finds">
          {finds.map((f, i) => <li key={`${outing.log.length}-${i}`} className={f.gained.gem ? "gem" : ""}>{f.text}</li>)}
        </ul>
      </div>

      {phase === "ready" && (
        <div className="mine-ready">
          <span className="mine-kicker">Find the seam</span>
          <div className="mine-keys">
            <span><kbd>Tap</kbd> strike</span>
            <span><kbd>Hold</kbd> heavy swing</span>
            <span className="warn"><kbd>▼</kbd> falling rocks crush finds</span>
          </div>
          <button className="primary big" disabled={starting} onClick={() => void begin()} autoFocus>Start · {Math.round(mine.ms / 1000)}s</button>
          <button className="link" onClick={onLeave}>Step away</button>
          {error && <p className="bad">{error}</p>}
        </div>
      )}

      {phase === "time" && (
        <div className="mine-banner" role="status">
          <strong>Time!</strong>
          {mine.leftMs === 0 && !starting && <button className="primary" onClick={() => void haulRef.current(0)}>Haul it out</button>}
        </div>
      )}
      {phase === "hauling" && <div className="mine-banner" role="status"><strong>Hauling it out…</strong></div>}

      {phase === "digging" && (
        <div className="mine-bottom">
          <div className="mine-charge" aria-label="Swing charge">
            <div className="mine-charge-fill" ref={chargeFill} />
            <span className="mine-charge-marks"><i /><i /></span>
          </div>
          <span className="mine-charge-word" ref={chargeWord}>Tap (1)</span>
          <span className="spacer" />
          <button className="small" onClick={() => void haulRef.current(0)}>Haul it out now</button>
        </div>
      )}
      {error && phase !== "ready" && <p className="bad mine-error">{error}</p>}
    </div>
  );
}
