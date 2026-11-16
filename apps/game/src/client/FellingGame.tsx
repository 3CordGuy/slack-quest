// Felling, played in the Harbor itself: the camera swings down into the
// hero's eyes at the tree line (render/fellingScene.ts) and this draws what
// goes over the view. One thirty-second round of notching trees down; the
// server begins it and is told every chop when it ends.

import { useEffect, useRef, useState, type RefObject } from "react";
import { FELL_ROUND_MS, GATHER_MAX_UNITS, HARBOR_GATHER, HARBOR_SPAWN, RESOURCE_KINDS, TREES, TREE_SLOTS, type GatherChoice, type GatherView, type Resources } from "@gantt-quest/world";
import * as THREE from "three";
import type { XpResult } from "./api";
import { label } from "./labels";
import { resourceIcon, ThingIcon } from "./thingIcons";
import { FellingScene, THICKNESS, type FellingHud } from "./render/fellingScene";
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

/** How a notch is cut, as a picture: a trunk side on, a cut from above meeting one from below, the wedge between popping out. */
function NotchArt() {
  return (
    <svg className="fc-notch-art" viewBox="0 0 120 64" aria-hidden>
      <rect x="0" y="60" width="120" height="4" fill="#3b2a1a" />
      <rect x="44" y="0" width="34" height="60" fill="#6a4628" />
      <rect x="44" y="0" width="5" height="60" fill="#7e5632" />
      {/* The notch cut out of the right side, pale inside. */}
      <path d="M78 18 L58 34 L78 44 Z" fill="#20180f" />
      <path d="M78 18 L58 34 L60 34 L78 21 Z" fill="#ecd096" />
      <path d="M58 34 L78 44 L78 41 L60 34 Z" fill="#c9a56a" />
      {/* The chunk, flying. */}
      <path className="fc-chunk" d="M92 20 L104 28 L92 34 Z" fill="#e2c27c" />
      {/* The two cuts' lines, carried on out of the bark. */}
      <path d="M58 34 L96 4" stroke="#ffe27a" strokeWidth="1.5" strokeDasharray="3 2" />
      <path d="M58 34 L96 52" stroke="#ffe27a" strokeWidth="1.5" strokeDasharray="3 2" />
      <text x="100" y="10" fill="#ffe27a" fontSize="8">1</text>
      <text x="100" y="58" fill="#ffe27a" fontSize="8">2</text>
    </svg>
  );
}

/** A key or a tap, as a little cap. (On a touch screen the keyboard hints, wrapped in `.keys`, are hidden.) */
const Key = ({ k }: { k: string }) => <kbd>{k}</kbd>;

/** The word in the middle of the view: what the last chop did, or what to do now the axe is stuck. */
function Callout({ hud }: { hud: FellingHud }) {
  const pop = hud.pop;
  const [shown, setShown] = useState<NonNullable<FellingHud["pop"]> | null>(null);
  useEffect(() => {
    if (!pop || pop.kind === "bound") return;
    setShown(pop);
    const t = setTimeout(() => setShown(null), 900);
    return () => clearTimeout(t);
  }, [pop?.n]);
  if (shown) return <div key={shown.n} className={`felling-say ${shown.kind}`} role="status">{shown.kind === "felled" ? "Timber!" : "Chunk out!"}</div>;
  if (hud.bound) {
    const other = hud.angle > 0 ? "below" : "above";
    return <div className="felling-say bound" role="status">{hud.otherCut ? `Keep cutting from ${other}` : `Stuck! Cut from ${other}`}</div>;
  }
  return null;
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
  /** Whether this panel asked the server to begin the round, so a round already under way when it opened can be told apart. */
  const begun = useRef(false);
  /** The scene and phase last acted on, so the same round is never started (or given up) twice. */
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

  // Follow the server: the round it has begun starts here; one already under way when this opened is given up (its
  // chops were never kept); an outing from when felling had a splitting round is carried home; a finished outing
  // shows what came of it.
  useEffect(() => {
    const s = stage;
    if (!s) return;
    if (handled.current.stage === s && handled.current.phase === f.phase) return;
    handled.current = { stage: s, phase: f.phase };
    if (f.phase === "ready-chop") {
      if (hud?.mode === "over") s.reset();
    } else if (f.phase === "chop") {
      if (begun.current) s.startChop();
      else void step({ t: "chopped", chops: [] });
      begun.current = false;
    } else if (f.phase === "ready-split" || f.phase === "split") {
      void step({ t: "bank" });
    } else if (f.phase === "done") s.finished();
    // Only the phase moving on calls for anything here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.phase, outing, stage]);

  const begin = () => {
    begun.current = true;
    void step({ t: "begin" });
  };
  const leave = () => scene.current?.leave();

  const mode = hud?.mode ?? "arrive";
  const over = outing.status !== "active";
  const chopping = mode === "chop";
  const paidOut = paid ?? outing.payout;
  const haul = RESOURCE_KINDS.filter((k) => paidOut[k]).map((k) => [k, paidOut[k]!] as const);

  return (
    <div className="felling-hud" ref={root}>
      <div className="felling-top">
        {chopping && (
          <div className={`felling-clock ${hud!.leftMs < 5000 ? "late" : ""}`}>
            <span>Fell</span>
            <strong>{clock(hud!.leftMs)}</strong>
          </div>
        )}
        <span className="spacer" />
        {!over && mode !== "leaving" && (
          <button className="small" disabled={busy} onClick={() => void step({ t: "bank" })} title="Stop here and head home">Give up</button>
        )}
      </div>

      {error && <p className="bad felling-error">{error}</p>}

      {chopping && hud && <Callout hud={hud} />}

      {mode === "intro" && f.phase === "ready-chop" && (
        <div className="felling-card intro">
          <div className="fc-kicker"><span>Felling</span><span className="fc-time">{FELL_SECONDS}s</span></div>
          <h2 className="fc-title">Fell!</h2>
          <NotchArt />
          <ol className="fc-steps">
            <li><b>Aim</b> above or below the cut: from above it slopes down, from below it slopes up.</li>
            <li><b>Click</b> to chop, as fast as you like. The axe binds once the cut is deep enough.</li>
            <li><b>Notch</b> from the other side to meet it: the chunk pops out, and you can go deeper.</li>
            <li>With an eighth of the trunk left, it <b>topples</b>.</li>
          </ol>
          <p className="fc-note">Flat cuts bite deep but bind early. Steep ones go further before they bind.</p>
          <ul className="fc-trees">
            {TREE_SLOTS.map((size) => (
              <li key={size}>
                <TreeGlyph size={size} />
                <strong>{TREES[size].name}</strong>
                <span className="fc-chops">{THICKNESS[size]}</span>
                <span className="fc-yield">{LOGS[size]}</span>
              </li>
            ))}
          </ul>
          <p className="fc-keys"><Key k="Click" /> chop <span className="keys">· <Key k="↑" /><Key k="↓" /> angle · <Key k="Space" /> chop · <Key k="1" /><Key k="2" /><Key k="3" /> tree</span></p>
          <p className="fc-note">A tree still standing when time runs out gives nothing. Each log is a piece of firewood.</p>
          <button className="primary big fc-go" disabled={busy} onClick={begin} autoFocus>Start felling</button>
        </div>
      )}

      {chopping && hud && (
        <div className="felling-bottom">
          <div className="felling-angle" aria-label="Angle of the cut">
            <span className={`fa-dial ${hud.angle > 0 ? "above" : "below"}`} style={{ ["--a" as string]: `${-hud.angle}deg` }}><i /></span>
            <span><strong>{Math.abs(hud.angle)}°</strong> from {hud.angle > 0 ? "above" : "below"}</span>
            <span className="muted keys">· <Key k="↑" /><Key k="↓" /> or point</span>
          </div>
          <div className="felling-trees">
            {TREE_SLOTS.map((size, slot) => {
              const t = hud.trees[slot];
              return (
                <button
                  key={size}
                  className={`felling-tree ${hud.current === slot ? "current" : ""}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    scene.current?.pick(slot);
                  }}
                >
                  <span>{TREES[size].name}</span>
                  <i style={{ width: `${(t.growing ? 0 : t.progress) * 100}%` }} />
                  <small>{t.growing ? "growing…" : `${Math.round(t.progress * 100)}%`}</small>
                </button>
              );
            })}
          </div>
          <p className="muted">{plural(hud.felled, "tree")} down</p>
        </div>
      )}

      {mode === "over" && !over && <div className="felling-stamp" role="status">Time!</div>}

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
          {f.felled.length > 0 && (
            <div className="fc-tally one">
              <section>
                <h3>Felled</h3>
                <ul>
                  {TREE_SLOTS.map((size) => [size, f.felled.filter((t) => t.size === size).length] as const)
                    .filter(([, n]) => n)
                    .map(([size, n]) => (
                      <li key={size}><TreeGlyph size={size} /><span>{TREES[size].name}</span><b>×{n}</b></li>
                    ))}
                </ul>
                <p className="fc-sum">{plural(f.logs, "log")} · {f.wood}/{GATHER_MAX_UNITS} firewood</p>
              </section>
            </div>
          )}
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
