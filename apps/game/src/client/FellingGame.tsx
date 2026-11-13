// Felling, played in the Harbor itself: the camera swings down into the
// hero's eyes at the tree line (render/fellingScene.ts) and this draws what
// goes over the view. Two thirty-second rounds, chopping then splitting; the
// server begins each one and is told what happened when it ends.

import { useEffect, useRef, useState, type RefObject } from "react";
import { FELL_ROUND_MS, GATHER_MAX_UNITS, HARBOR_GATHER, HARBOR_SPAWN, RESOURCE_KINDS, SPLIT_ROLLS, TREES, TREE_SLOTS, markerAt, type GatherChoice, type GatherView, type Resources } from "@gantt-quest/world";
import * as THREE from "three";
import type { XpResult } from "./api";
import { label } from "./labels";
import { resourceIcon, ThingIcon } from "./thingIcons";
import { FellingScene, type FellingHud } from "./render/fellingScene";
import { hexToWorld, type WorldRenderer } from "./render/WorldRenderer";
import "./felling.css";

const LOGS: Record<(typeof TREE_SLOTS)[number], string> = {
  small: `${TREES.small.logs} log`,
  medium: `${TREES.medium.logs}–${TREES.medium.logs + TREES.medium.rolls} logs`,
  large: `${TREES.large.logs}–${TREES.large.logs + TREES.large.rolls} logs`,
};

const FELL_SECONDS = Math.round(FELL_ROUND_MS / 1000);
const clock = (ms: number) => `0:${String(Math.ceil(ms / 1000)).padStart(2, "0")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The three trees as small pixel pictures, drawn like the ones in the view: a pine sapling, a pale ash, a broad old oak. */
function TreeGlyph({ size }: { size: (typeof TREE_SLOTS)[number] }) {
  const px = (x: number, y: number, w: number, h: number, fill: string) => <rect key={`${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />;
  const shapes =
    size === "small"
      ? [px(7, 12, 2, 4, "#7a5230"), px(6, 2, 4, 2, "#5cad4f"), px(5, 4, 6, 3, "#5cad4f"), px(4, 7, 8, 3, "#4f9a46"), px(3, 10, 10, 2, "#4f9a46")]
      : size === "medium"
        ? [px(7, 10, 2, 6, "#d6cfbf"), px(5, 1, 6, 2, "#9cc957"), px(3, 3, 10, 4, "#9cc957"), px(3, 7, 10, 2, "#86b84a"), px(5, 9, 6, 2, "#86b84a")]
        : [px(6, 10, 4, 6, "#5e3f22"), px(4, 0, 8, 2, "#3a8743"), px(1, 2, 14, 5, "#3a8743"), px(0, 5, 16, 3, "#2f7a3d"), px(1, 8, 14, 2, "#2a6e36"), px(4, 10, 2, 1, "#2a6e36"), px(10, 10, 2, 1, "#2a6e36")];
  return (
    <svg className="fc-glyph" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      <rect x={2} y={15} width={12} height={1} fill="rgba(0,0,0,0.35)" />
      {shapes}
    </svg>
  );
}

/** A key or a tap, as a little cap. (On a touch screen the keyboard hints, wrapped in `.keys`, are hidden.) */
const Key = ({ k }: { k: string }) => <kbd>{k}</kbd>;

/** The marker over a log, sweeping on its own, to show what a strike is judged by. */
function SplitLegend() {
  return (
    <div className="fc-legend">
      <div className="split-bar demo" aria-hidden>
        <div className="split-zone" style={{ left: "38%", width: "24%" }}>
          <div className="split-sweet" />
        </div>
        <div className="split-dot" />
      </div>
      <ul className="fc-grades">
        <li><b className="perfect"><i className="sw" />Perfect</b><span>dead centre</span><em>{plural(SPLIT_ROLLS.perfect, "roll")}</em></li>
        <li><b className="good"><i className="sw" />Good</b><span>on the mark</span><em>{plural(SPLIT_ROLLS.good, "roll")}</em></li>
        <li><b className="off"><i className="sw" />Off</b><span>missed it</span><em>swing again</em></li>
      </ul>
    </div>
  );
}

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
  const paidOut = paid ?? outing.payout;
  const haul = RESOURCE_KINDS.filter((k) => paidOut[k]).map((k) => [k, paidOut[k]!] as const);

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
        <div className="felling-card intro" key="chop">
          <div className="fc-kicker"><span>Round 1 of 2</span><span className="fc-time">{FELL_SECONDS}s</span></div>
          <h2 className="fc-title">Chop!</h2>
          <p className="fc-lead">Fell what you can before the time is up. Bigger trees take longer but give more logs.</p>
          <ul className="fc-trees">
            {TREE_SLOTS.map((size) => (
              <li key={size}>
                <TreeGlyph size={size} />
                <strong>{TREES[size].name}</strong>
                <span className="fc-chops">{TREES[size].chops} chops</span>
                <span className="fc-yield">{LOGS[size]}</span>
              </li>
            ))}
          </ul>
          <p className="fc-keys"><Key k="Tap" /> a tree to swing <span className="keys">· <Key k="1" /><Key k="2" /><Key k="3" /> · <Key k="Space" /> chops the ringed one</span></p>
          <p className="fc-note">A tree left standing when time runs out gives nothing.</p>
          <button className="primary big fc-go" disabled={busy} onClick={() => begin("chop")} autoFocus>Start chopping</button>
        </div>
      )}

      {f.phase === "ready-split" && (mode === "intro-split" || mode === "chop-over") && (
        <div className="felling-card intro" key="split">
          <div className="fc-kicker"><span>Round 2 of 2</span><span className="fc-time">{FELL_SECONDS}s</span></div>
          <h2 className="fc-title">Split!</h2>
          <p className="fc-lead">
            <span className="fc-logs" aria-hidden>{Array.from({ length: Math.min(f.logs, 10) }, (_, i) => <i key={i} />)}</span>
            <strong>{plural(f.logs, "log")}</strong> to split. Strike when the marker is over the split.
          </p>
          <SplitLegend />
          <p className="fc-keys"><Key k="Tap" /> <span className="keys"><Key k="Space" /></span> to strike</p>
          <button className="primary big fc-go" disabled={busy} onClick={() => begin("split")} autoFocus>Start splitting</button>
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

      {(mode === "chop-over" || mode === "split-over") && !over && f.phase !== "ready-split" && <div className="felling-stamp" role="status">Time!</div>}

      {over && mode !== "leaving" && (
        <div className={`felling-card result ${outing.status}`}>
          <div className="fc-kicker"><span>Felling</span><span>{outing.status === "banked" ? "Done" : "Lost"}</span></div>
          <h2 className="fc-title">{outing.status === "banked" ? "Back with the wood" : "Nothing comes home"}</h2>
          <div className="fc-haul">
            {haul.length > 0 ? (
              haul.map(([kind, n]) => (
                <div key={kind} className="fc-haul-item">
                  <ThingIcon icon={resourceIcon(kind)} size={44} />
                  <strong>+{n}</strong>
                  <span>{label("resource", kind)}</span>
                </div>
              ))
            ) : (
              <p className="fc-note">Nothing to carry this time.</p>
            )}
          </div>
          {(f.felled.length > 0 || f.splits.length + f.misses > 0) && (
            <div className="fc-tally">
              <section>
                <h3>Chopped</h3>
                {f.felled.length === 0 && <p className="fc-note">No trees came down.</p>}
                <ul>
                  {TREE_SLOTS.map((size) => [size, f.felled.filter((t) => t.size === size).length] as const)
                    .filter(([, n]) => n)
                    .map(([size, n]) => (
                      <li key={size}><TreeGlyph size={size} /><span>{TREES[size].name}</span><b>×{n}</b></li>
                    ))}
                </ul>
                <p className="fc-sum">{plural(f.logs, "log")}</p>
              </section>
              <section>
                <h3>Split</h3>
                <ul>
                  <li><span className="perfect">Perfect</span><b>{f.splits.filter((x) => x.grade === "perfect").length}</b></li>
                  <li><span className="good">Good</span><b>{f.splits.filter((x) => x.grade === "good").length}</b></li>
                  <li><span className="off">Off the mark</span><b>{f.misses}</b></li>
                </ul>
                <p className="fc-sum">{plural(wood, "piece")} of wood</p>
              </section>
            </div>
          )}
          {wood > (paidOut.wood ?? 0) && haul.length > 0 && <p className="fc-note">{GATHER_MAX_UNITS} is the most one outing can carry home.</p>}
          {xp?.text && <p className={`fc-xp ${xp.granted > 0 ? "gain" : ""}`}>{xp.text}</p>}
          <div className="fc-actions">
            {staminaLeft > 0 && <button className="primary big" disabled={busy} onClick={again}>Go again <small>· 1 stamina</small></button>}
            <button className="big" onClick={leave} autoFocus={staminaLeft === 0}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
