// Felling, played in the Harbor itself: the camera swings down into the
// hero's eyes at the tree line (render/fellingScene.ts) and this draws what
// goes over the view. Two thirty-second rounds, chopping then splitting; the
// server begins each one and is told what happened when it ends.

import { useEffect, useRef, useState, type RefObject } from "react";
import { HARBOR_GATHER, HARBOR_SPAWN, SPLIT_ROLLS, TREES, TREE_SLOTS, markerAt, type GatherChoice, type GatherView, type Resources } from "@gantt-quest/world";
import * as THREE from "three";
import type { XpResult } from "./api";
import { resourceText } from "./hutDrops";
import { FellingScene, type FellingHud } from "./render/fellingScene";
import { hexToWorld, type WorldRenderer } from "./render/WorldRenderer";
import "./felling.css";

const LOGS: Record<(typeof TREE_SLOTS)[number], string> = {
  small: `${TREES.small.logs} log`,
  medium: `${TREES.medium.logs}–${TREES.medium.logs + TREES.medium.rolls} logs`,
  large: `${TREES.large.logs}–${TREES.large.logs + TREES.large.rolls} logs`,
};

const clock = (ms: number) => `0:${String(Math.ceil(ms / 1000)).padStart(2, "0")}`;

/** The bar under the view while splitting: the same marker as the one riding the log, for reading it exactly. */
function SplitBar({ marker }: { marker: NonNullable<FellingHud["marker"]> }) {
  const dot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (dot.current) dot.current.style.left = `${markerAt(marker.motion, Math.max(0, performance.now() - marker.startedAt)) * 100}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [marker]);
  const m = marker.motion;
  return (
    <div className="split-bar" aria-hidden>
      <div className="split-zone" style={{ left: `${(m.zone - m.width / 2) * 100}%`, width: `${m.width * 100}%` }}>
        <div className="split-sweet" />
      </div>
      <div className="split-dot" ref={dot} />
    </div>
  );
}

export function FellingGame({ outing, busy, error, paid, xp, staminaLeft, renderer, step, again, onClose }: {
  outing: GatherView;
  busy: boolean;
  error: string | null;
  paid: Resources | null;
  xp: XpResult | null;
  staminaLeft: number;
  renderer: RefObject<WorldRenderer | null>;
  step(choice: GatherChoice): Promise<void>;
  /** Start another outing here. */
  again(): void;
  onClose(): void;
}) {
  const f = outing.felling!;
  const [hud, setHud] = useState<FellingHud | null>(null);
  const scene = useRef<FellingScene | null>(null);
  /** The scene in use, as state too, so a new one (the view remade) is set up for the round the outing is on. */
  const [stage, setStage] = useState<FellingScene | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** The round this panel asked the server to begin, so a round already under way when it opened can be told apart. */
  const begun = useRef<"chop" | "split" | null>(null);
  /** The scene that has been turned to the block for this outing's split round, so it is set up once per scene. */
  const turned = useRef<FellingScene | null>(null);
  /** The scene and round last acted on, so the same round is never started (or given up) twice. */
  const handled = useRef<{ stage: FellingScene | null; phase: string }>({ stage: null, phase: "" });
  const latest = useRef({ step, onClose });
  latest.current = { step, onClose };

  // Into the hero's eyes on mount; back out (and the Harbor's own panels back) on the way out.
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    const at = hexToWorld(HARBOR_GATHER.felling);
    const town = hexToWorld(HARBOR_SPAWN);
    const seaward = new THREE.Vector3(at.x - town.x, 0, at.z - town.z);
    scene.current = r.startMinigame(
      (group) =>
        new FellingScene(group, seaward, (x, z) => r.groundAt(x, z), {
          hud: setHud,
          chopped: (chops) => void latest.current.step({ t: "chopped", chops }),
          split: (strikes) => void latest.current.step({ t: "split", strikes }),
          left: () => latest.current.onClose(),
        }),
      HARBOR_GATHER.felling,
      "felling",
    );
    const clear = scene.current.clearing();
    r.clearTrees(clear.x, clear.z, clear.radius);
    setStage(scene.current);
    const view = root.current?.closest(".harbor-view");
    view?.classList.add("felling");
    return () => {
      view?.classList.remove("felling");
      r.endMinigame();
      scene.current = null;
      setStage(null);
    };
    // The renderer is the Harbor's, for the life of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the server: a round it has begun starts here; one already under way when this opened is given up (its chops
  // were never kept); logs to split turn the view round to the block; a finished outing shows what came of it.
  useEffect(() => {
    const s = stage;
    if (!s) return;
    if (handled.current.stage === s && handled.current.phase === f.phase) return;
    handled.current = { stage: s, phase: f.phase };
    if (f.phase === "ready-chop") {
      turned.current = null;
      if (hud && (hud.mode === "split-over" || hud.mode === "chop-over")) s.reset();
    } else if (f.phase === "chop") {
      if (begun.current === "chop") s.startChop();
      else void step({ t: "chopped", chops: [] });
      begun.current = null;
    } else if (f.phase === "ready-split" && turned.current !== s) {
      turned.current = s;
      s.toSplit(f.logs, f.motions);
    } else if (f.phase === "split") {
      if (turned.current !== s) {
        turned.current = s;
        s.toSplit(f.logs, f.motions);
      }
      if (begun.current === "split") s.startSplit();
      else void step({ t: "split", strikes: [] });
      begun.current = null;
    } else if (f.phase === "done") s.finished();
    // Only the phase moving on calls for anything here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.phase, outing, stage]);

  const begin = (round: "chop" | "split") => {
    begun.current = round;
    void step({ t: "begin" });
  };
  const leave = () => scene.current?.leave();

  const mode = hud?.mode ?? "arrive";
  const over = outing.status !== "active";
  const chopping = mode === "chop";
  const splitting = mode === "split";
  const running = chopping || splitting;
  const wood = f.splits.reduce((a, s) => a + s.wood, 0);

  return (
    <div className="felling-hud" ref={root}>
      <div className="felling-top">
        {running && (
          <div className={`felling-clock ${hud!.leftMs < 5000 ? "late" : ""}`}>
            <span>{chopping ? "Chop" : "Split"}</span>
            <strong>{clock(hud!.leftMs)}</strong>
          </div>
        )}
        <span className="spacer" />
        {!over && mode !== "leaving" && (
          <button className="small" disabled={busy} onClick={() => void step({ t: "bank" })} title="Stop here and take home what you have">Give up</button>
        )}
      </div>

      {error && <p className="bad felling-error">{error}</p>}

      {mode === "intro-chop" && f.phase === "ready-chop" && (
        <div className="felling-card">
          <h2>Chop!</h2>
          <p>Thirty seconds. Tap a tree to swing at it (or press 1, 2, 3; space chops the one ringed).</p>
          <ul>
            {TREE_SLOTS.map((size) => (
              <li key={size}><strong>{TREES[size].name}</strong> {TREES[size].chops} chops · {LOGS[size]}</li>
            ))}
          </ul>
          <p className="muted">A tree still standing when time runs out gives nothing.</p>
          <button className="primary big" disabled={busy} onClick={() => begin("chop")} autoFocus>Start chopping</button>
        </div>
      )}

      {f.phase === "ready-split" && (mode === "intro-split" || mode === "chop-over") && (
        <div className="felling-card">
          <h2>{f.logs} {f.logs === 1 ? "log" : "logs"} to split</h2>
          <p>Thirty seconds at the block. Strike (tap, or space) when the marker is over the split.</p>
          <ul>
            <li><strong className="perfect">Perfect</strong> right in the middle: {SPLIT_ROLLS.perfect} rolls at a piece of wood</li>
            <li><strong className="good">Good</strong> on the mark: {SPLIT_ROLLS.good} roll</li>
            <li><strong>Off the mark</strong>: swing again</li>
          </ul>
          <button className="primary big" disabled={busy} onClick={() => begin("split")} autoFocus>Start splitting</button>
        </div>
      )}

      {chopping && hud && (
        <div className="felling-bottom">
          <div className="felling-trees">
            {TREE_SLOTS.map((size, slot) => {
              const t = hud.trees[slot];
              return (
                <button
                  key={size}
                  className={`felling-tree ${hud.current === slot ? "current" : ""}`}
                  // On the press itself, like an axe: no waiting for the release.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    scene.current?.chopAt(slot);
                  }}
                  disabled={t.growing}
                >
                  <span>{TREES[size].name}</span>
                  <i style={{ width: `${(t.growing ? 0 : t.done / t.need) * 100}%` }} />
                  <small>{t.growing ? "growing…" : `${t.done}/${t.need}`}</small>
                </button>
              );
            })}
          </div>
          <p className="muted">{hud.felled} felled</p>
        </div>
      )}

      {splitting && hud && (
        <div className="felling-bottom">
          {hud.marker && <SplitBar marker={hud.marker} />}
          <div className="row">
            <button className="primary big" onPointerDown={(e) => { e.preventDefault(); scene.current?.strikeNow(); }}>Split!</button>
            <span>{hud.logsLeft} {hud.logsLeft === 1 ? "log" : "logs"} left</span>
            <span className="perfect">{hud.struck.perfect} perfect</span>
            <span className="good">{hud.struck.good} good</span>
            <span className="muted">{hud.struck.miss} missed</span>
          </div>
        </div>
      )}

      {(mode === "chop-over" || mode === "split-over") && !over && f.phase !== "ready-split" && <div className="felling-card small"><p>Time!</p></div>}

      {over && mode !== "leaving" && (
        <div className="felling-card">
          <h2>{outing.status === "banked" ? "Back with the wood" : "Nothing comes home"}</h2>
          {f.felled.length > 0 && (
            <p>
              Felled {TREE_SLOTS.map((size) => [size, f.felled.filter((t) => t.size === size).length] as const).filter(([, n]) => n).map(([size, n]) => `${n} ${n === 1 ? TREES[size].name.toLowerCase() : TREES[size].plural}`).join(", ")}: {f.logs} {f.logs === 1 ? "log" : "logs"}.
            </p>
          )}
          {f.splits.length + f.misses > 0 && (
            <p>
              Split {f.splits.length} ({f.splits.filter((s) => s.grade === "perfect").length} perfect, {f.splits.filter((s) => s.grade === "good").length} good{f.misses ? `, ${f.misses} off the mark` : ""}): {wood} {wood === 1 ? "piece" : "pieces"} of wood.
            </p>
          )}
          <p className="good">Added to your materials: {resourceText(paid ?? outing.payout)}.</p>
          {xp?.text && <p className={xp.granted > 0 ? "xp-gain" : "muted"}>{xp.text}</p>}
          <div className="row">
            {staminaLeft > 0 && <button className="primary" disabled={busy} onClick={again}>Go again · uses 1 stamina</button>}
            <button onClick={leave} autoFocus={staminaLeft === 0}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
