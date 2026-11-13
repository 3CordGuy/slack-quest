// Fishing from the piers: a card before a sitting (and after one), and the
// HUD laid over the view while one is under way. The sitting is played in
// the Harbor itself (render/FishingStage.ts): this sends each cast, strike
// and fight on to the server and shows what came of it.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HexPos } from "@gantt-quest/core";
import * as THREE from "three";
import {
  BOOK_TITLE,
  FISH,
  FISH_SPOTS,
  FURNISHINGS,
  PAGE_REWARD,
  HARBOR_SPAWN,
  formatLength,
  formatLoad,
  formatWeight,
  type CaughtFish,
  type FishSpot,
  type Vessel,
  type GatherChoice,
  type GatherView,
  type Resources,
} from "@gantt-quest/world";
import { api, type GatherStatus, type SittingPaid, type XpResult } from "./api";
import { ResourceChips } from "./hutDrops";
import { CatchBookPanel } from "./CatchBook";
import { catchIcon } from "./render/catchArt";
import { FishingStage, type FishHooks, type FishPhase } from "./render/FishingStage";
import { hexToWorld, type WorldRenderer } from "./render/WorldRenderer";
import { StaminaBolts } from "./StaminaBolts";
import { units } from "./units";
import "./quarry.css";
import "./fishing.css";

type Status = GatherStatus & { paid?: Resources; xp?: XpResult; sitting?: SittingPaid };
/** Where the hero fishes from: the spot, and the hex they stand (or float) on. */
type Pier = FishSpot;

const WATER_WORDS: Record<string, string> = {
  shallows: "Weed and sand. Small fish, flatfish, eels, and something old and whiskered.",
  mouth: "Where the harbor meets the tide. Schools, runners and jumpers.",
  deep: "Deep water off the rocks, by the wreck. Heavy fish that dive.",
  sea: "The open sea.",
};


/** A picture of the sea from a pier: the float out on the water, a fish under it. */
function SeaArt() {
  return (
    <svg className="qa-art fish-art" viewBox="0 0 340 100" aria-hidden>
      <rect width="340" height="100" fill="#1a2440" />
      <rect y="46" width="340" height="54" fill="#18344a" />
      {Array.from({ length: 9 }, (_, i) => <rect key={i} className="fa-wave" x={14 + i * 37} y={56 + (i % 3) * 12} width="16" height="2" style={{ animationDelay: `${(i * 0.37) % 2}s` }} />)}
      <circle cx="292" cy="20" r="9" fill="#f4e6b0" opacity="0.85" />
      <g className="fa-float">
        <rect x="206" y="50" width="6" height="4" fill="#d8352a" />
        <rect x="206" y="54" width="6" height="3" fill="#f4f1e8" />
        <rect x="208" y="45" width="2" height="5" fill="#2a2018" />
      </g>
      <path d="M40 100 L60 44 L66 44" stroke="#3a2a1c" strokeWidth="3" fill="none" />
      <path d="M66 44 Q140 60 209 51" stroke="#e8eef2" strokeWidth="1" fill="none" opacity="0.7" />
      <ellipse className="fa-fish" cx="196" cy="78" rx="14" ry="4" fill="#0b1820" opacity="0.6" />
      <rect x="0" y="88" width="120" height="12" fill="#5a4028" />
      {Array.from({ length: 8 }, (_, i) => <rect key={i} x={i * 15 + 2} y="88" width="1" height="12" fill="#3a2a1c" />)}
    </svg>
  );
}

function Rule({ title, sub, glyph }: { title: string; sub: string; glyph: string }) {
  return (
    <li>
      <span className="fish-glyph" aria-hidden>{glyph}</span>
      <span>
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
    </li>
  );
}

/** What a sitting brought home, for the card after it. */
function Summary({ view, paid, xp, sitting }: { view: GatherView; paid?: Resources; xp?: XpResult | null; sitting?: SittingPaid }) {
  const u = useSyncExternalStore(units.subscribe, units.get);
  const s = view.sitting!;
  const kept = s.landed.filter((f) => f.kept && FISH[f.species].kind !== "haul");
  const released = s.landed.filter((f) => f.kept === false).length;
  const heaviest = [...kept].sort((a, b) => b.grams - a.grams)[0];
  return (
    <div className="qa-result fish-summary">
      {s.landed.some((f) => f.kept) && (
        <div className="fish-icons">
          {s.landed.filter((f) => f.kept).map((f, i) => <img key={i} src={catchIcon(f.species)} alt={FISH[f.species].name} title={`${FISH[f.species].name}, ${formatWeight(f.grams, u)}`} width={40} height={40} />)}
        </div>
      )}
      <p>{kept.length === 0 ? "Nothing in the basket this time." : `${kept.length} in the basket, ${formatLoad(s.creelGrams, u)} in all${released ? `, and ${released} thrown back` : ""}.`}</p>
      {heaviest && <p className="muted">Biggest: {FISH[heaviest.species].name}, {formatWeight(heaviest.grams, u)}.</p>}
      {sitting?.book.pages.map((page) => <p key={page} className="fish-record">Catch Book page finished! {FURNISHINGS[PAGE_REWARD[page]].name} is waiting for you at home.</p>)}
      {sitting?.book.full && <p className="fish-record">The whole Catch Book! You are a {BOOK_TITLE}.</p>}
      {(sitting?.newSpecies.length ?? 0) > 0 && <p className="good">New in your Catch Book: {sitting!.newSpecies.map((id) => FISH[id].name).join(", ")}.</p>}
      {(sitting?.records.length ?? 0) > 0 && <p className="fish-record">Crew record: {sitting!.records.map((id) => FISH[id].name).join(", ")}!</p>}
      {paid && Object.keys(paid).length > 0 && <ResourceChips resources={paid} />}
      {(sitting?.sold.length ?? 0) > 0 && <p className="muted">No room in your icebox: {sitting!.sold.map((f) => `${FISH[f.species].name} to ${f.buyer === "tam" ? "Old Tam" : "the fishmonger"}`).join(", ")}, sold as you came in.</p>}
      {(sitting?.gold ?? 0) > 0 && <p className="good">+{sitting!.gold} gold.</p>}
      {s.lost.length > 0 && <p className="muted">Got away: {s.lost.map((id) => FISH[id].name).join(", ")}.</p>}
      {xp?.text && <span className={xp.granted > 0 ? "xp-gain" : "muted"}>{xp.text}</span>}
    </div>
  );
}

/** The card at a pier: how fishing works and the way in, or what the last sitting brought home. */
function FishingIntro({ pier, status, ended, busy, error, onStart, onClose }: {
  pier: Pier;
  status: Status | null;
  ended: Status | null;
  busy: boolean;
  error: string | null;
  onStart(): void;
  onClose(): void;
}) {
  const spot = FISH_SPOTS[pier];
  const left = status?.stamina.left ?? 0;
  return (
    <div className="overlay quarry-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quarry-intro fish-intro" role="dialog" aria-label={spot.name}>
        <SeaArt />
        <button className="qa-close small" onClick={onClose} aria-label="Close">✕</button>
        <div className="qa-head">
          <h2>{spot.name}</h2>
          <span className="qa-sub">{WATER_WORDS[spot.water]}</span>
        </div>
        {ended?.outing?.sitting ? (
          <Summary view={ended.outing} paid={ended.paid} xp={ended.xp} sitting={ended.sitting} />
        ) : (
          <ul className="qa-rules">
            <Rule glyph="⤴" title="Hold, let go" sub="Hold longer to cast further" />
            <Rule glyph="◉" title="Strike on the bite" sub="Not on a nibble" />
            <Rule glyph="⇢" title="Tap when it runs" sub="Holding a run snaps the line" />
            <Rule glyph="⟲" title="Hold when it rests" sub="That is when you reel" />
          </ul>
        )}
        {error && <p className="bad qa-error">{error}</p>}
        <div className="qa-foot">
          {status && (
            <span className="qa-stamina" title={`${left} of ${status.stamina.max} outings left today`}>
              <StaminaBolts left={left} max={status.stamina.max} size={18} />
            </span>
          )}
          <span className="spacer" />
          {status && left > 0 && (
            <button className="primary" disabled={busy} onClick={onStart} autoFocus>
              {ended ? "Fish again" : "Cast a line"}<span className="qa-cost">· 1 stamina when you stop</span>
            </button>
          )}
          {status && left === 0 && <span className="bad qa-tired">Worn out for today. A rest or a meal gives stamina back.</span>}
        </div>
      </div>
    </div>
  );
}

/** The HUD over a sitting under way. */
function Sitting({ outing, world, pier, at: here, vessel, gilded, shipBeside, apply, onRod, onClose }: {
  outing: GatherView;
  gilded: boolean;
  at: HexPos;
  vessel: Vessel | null;
  onRod?(on: boolean): void;
  world: WorldRenderer;
  pier: Pier;
  shipBeside: boolean;
  apply(next: Status): void;
  onClose(): void;
}) {
  const sitting = outing.sitting!;
  const u = useSyncExternalStore(units.subscribe, units.get);
  const stage = useRef<FishingStage | null>(null);
  const [phase, setPhase] = useState<FishPhase>("arrive");
  const [msg, setMsg] = useState<{ text: string; tone: "good" | "bad" | "" } | null>(null);
  const [pending, setPending] = useState<CaughtFish | null>(sitting.pending);
  const [ended, setEnded] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  /** The sitting as the server last sent it. */
  const [view, setView] = useState(outing);
  const [book, setBook] = useState(false);
  const tensionFill = useRef<HTMLDivElement>(null);
  const strengthFill = useRef<HTMLDivElement>(null);
  const lineFill = useRef<HTMLDivElement>(null);
  const chargeFill = useRef<HTMLDivElement>(null);
  const modeWord = useRef<HTMLSpanElement>(null);
  const hookP = useRef<Promise<boolean>>(Promise.resolve(false));
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const msgTimer = useRef(0);

  const say = (text: string | undefined, tone: "good" | "bad" | "" = "") => {
    if (!text) return;
    setMsg({ text, tone });
    clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), 3500);
  };
  const step = async (choice: GatherChoice): Promise<Status> => {
    const next = (await api.gatherStep(choice)) as Status;
    applyRef.current(next);
    if (next.outing?.sitting) setView(next.outing);
    if (next.outing && next.outing.status !== "active") setEnded(next);
    return next;
  };

  useEffect(() => {
    const at = hexToWorld(here);
    const town = hexToWorld(HARBOR_SPAWN);
    const seaward = new THREE.Vector3(at.x - town.x, 0, at.z - town.z).normalize();
    // A crew's ship moored off this pier: cast off the side of it instead.
    if (shipBeside) seaward.applyAxisAngle(new THREE.Vector3(0, 1, 0), (at.x >= town.x ? 1 : -1) * 0.85);
    const hooks: FishHooks = {
      phase: setPhase,
      hud: (h) => {
        if (tensionFill.current) {
          tensionFill.current.style.height = `${Math.min(100, (h.tension / 1.2) * 100)}%`;
          tensionFill.current.dataset.zone = h.tension >= 0.95 ? "red" : h.tension >= 0.7 ? "amber" : "green";
        }
        if (strengthFill.current) strengthFill.current.style.height = `${Math.round(h.strength * 100)}%`;
        if (lineFill.current) {
          lineFill.current.style.width = `${Math.round(Math.min(1, h.lineOut) * 100)}%`;
          lineFill.current.dataset.low = h.lineOut > 0.8 ? "1" : "0";
        }
        if (chargeFill.current) chargeFill.current.style.width = `${Math.round(h.charge * 100)}%`;
        if (modeWord.current) {
          const word = h.mode === "run" ? "It runs! Ease off, tap" : h.mode === "shake" ? "Head-shaking! Ease off" : h.mode === "jump" ? "It jumps!" : h.mode === "drag" ? "Dead weight. Reel steady" : h.mode === "rest" ? "It rests. Hold to reel" : "";
          if (modeWord.current.textContent !== word) {
            modeWord.current.textContent = word;
            modeWord.current.dataset.mode = h.mode ?? "";
          }
        }
      },
      cast: (power) => {
        step({ t: "cast", power, spot: pier })
          .then((next) => {
            const c = next.outing?.sitting?.cast;
            if (c) stage.current?.beginWait(c);
            else stage.current?.reset();
          })
          .catch((e: Error) => {
            say(e.message, "bad");
            stage.current?.reset();
          });
      },
      strike: (at, hooked) => {
        void at;
        hookP.current = step({ t: "hook", at })
          .then((next) => {
            const ok = !!next.outing?.sitting?.cast?.hooked;
            if (hooked && ok) say("Fish on!", "good");
            if (!ok) {
              say(next.outing?.log.at(-1)?.text, "bad");
              if (hooked) stage.current?.reset();
            }
            return ok;
          })
          .catch((e: Error) => {
            say(e.message, "bad");
            stage.current?.reset();
            return false;
          });
      },
      fought: (edges) => {
        void (async () => {
          if (!(await hookP.current)) return;
          for (let attempt = 0; ; attempt++) {
            try {
              const next = await step({ t: "fought", edges });
              const p = next.outing?.sitting?.pending;
              if (p) {
                stage.current?.land(p);
                setPending(p);
              } else {
                say(next.outing?.log.at(-1)?.text, "bad");
                stage.current?.reset();
              }
              return;
            } catch (e) {
              // The server's clock is a little behind ours: give it a moment.
              if (/not over/.test((e as Error).message) && attempt < 4) await new Promise((r) => setTimeout(r, 400));
              else {
                say((e as Error).message, "bad");
                stage.current?.reset();
                return;
              }
            }
          }
        })();
      },
      missed: () => say("Too slow. It spat the hook out.", "bad"),
      left: () => undefined,
    };
    // Afloat, in whatever boat the hero has; ashore, on the pier.
    const boat = FISH_SPOTS[pier].vessel ? vessel ?? FISH_SPOTS[pier].vessel! : null;
    const s = world.startMinigame((g) => new FishingStage(world, g, pier, seaward, hooks, boat, gilded), here, pier === "shore" ? "fishing" : undefined);
    s.ease = sitting.ease;
    stage.current = s;
    document.body.classList.add("fishing");
    onRod?.(true);
    // Back after a reload: a fish still on the line was lost when the page went; a line in the water is wound in.
    if (sitting.cast) {
      const was = sitting.cast.hooked;
      void step({ t: "reel" }).then(() => was && say("The line went slack while you were away.", "bad"), () => undefined);
    }
    if (sitting.pending) s.land(sitting.pending);
    return () => {
      document.body.classList.remove("fishing");
      onRod?.(false);
      clearTimeout(msgTimer.current);
      stage.current = null;
      s.leave();
    };
    // One stage for the life of this sitting's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Space is the button, like a press.
  useEffect(() => {
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || held) return;
      if (document.activeElement instanceof HTMLButtonElement || document.activeElement instanceof HTMLInputElement) return;
      e.preventDefault();
      held = true;
      stage.current?.pressDown();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !held) return;
      e.preventDefault();
      held = false;
      stage.current?.pressUp();
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, []);

  const putAway = async (how: "keep" | "release") => {
    setBusy(true);
    try {
      await step({ t: how });
      stage.current?.stow(how);
      setPending(null);
    } catch (e) {
      say((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await step({ t: "bank" });
    } catch (e) {
      say((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const live = view.sitting!;
  const fighting = phase === "fighting" || phase === "landing";
  const def = pending ? FISH[pending.species] : null;
  const fills = pending && def?.kind !== "haul" ? live.creelGrams + pending.grams >= live.creelLimitG : false;
  const prompt =
    phase === "idle" ? "Hold to wind up a cast, let go to throw"
    : phase === "charging" ? "Let go to cast"
    : phase === "casting" ? ""
    : phase === "waiting" ? "Watch the float. Strike when it goes under"
    : "";

  return (
    <div className={`overlay fish-mode ${phase}`}>
      <div
        className="fish-hit"
        aria-label="The water: hold to cast, press to strike, tap and hold to fight"
        onPointerDown={(e) => {
          if (ended || pending) return;
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // Capture only keeps a hold alive off the layer.
          }
          stage.current?.pressDown();
        }}
        onPointerUp={() => stage.current?.pressUp()}
        onPointerCancel={() => stage.current?.pressUp()}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="fish-top">
        <div className="fish-creel" title="How full your basket is">
          <span>Basket</span>
          <div className="fish-creel-bar"><div style={{ width: `${Math.min(100, (live.creelGrams / live.creelLimitG) * 100)}%` }} /></div>
          <span className="tabular">{formatLoad(live.creelGrams, u)} / {formatLoad(live.creelLimitG, u)}</span>
        </div>
        {prompt && <span className="fish-prompt">{prompt}</span>}
        {phase === "charging" && <div className="fish-charge"><div ref={chargeFill} /></div>}
        {fighting && <span className="fish-mode-word" ref={modeWord} />}
      </div>

      {fighting && (
        <div className="fish-side">
          {/* The fish's strength and the line's tension side by side: tire the one without breaking the other. */}
          <div className="fish-meters">
            <div className="fish-meter">
              <div className="fish-bar fish-strength" aria-label="The fish's strength">
                <div className="fish-strength-fill" ref={strengthFill} />
              </div>
              <span className="fish-side-label">Fish</span>
            </div>
            <div className="fish-meter">
              <div className="fish-bar fish-tension" aria-label="Line tension">
                <div className="fish-tension-zones"><i className="red" /><i className="amber" /></div>
                <div className="fish-tension-fill" ref={tensionFill} />
              </div>
              <span className="fish-side-label">Line</span>
            </div>
          </div>
          <span className="fish-side-label">Line out</span>
          <div className="fish-line" title="Line out"><div ref={lineFill} /></div>
        </div>
      )}

      {msg && <div className={`fish-msg ${msg.tone}`} role="status">{msg.text}</div>}
      {book && <CatchBookPanel onClose={() => setBook(false)} />}

      {pending && def && !ended && (
        <div className={`fish-card ${def.rarity}`} role="dialog" aria-label={def.name}>
          <div className="fish-card-head">
            <img className="fish-icon" src={catchIcon(pending.species)} alt="" width={64} height={64} />
            <div>
              <span className="fish-rarity">{def.rarity}{pending.specimen ? " · specimen" : ""}</span>
              <h3>{def.name}</h3>
            </div>
          </div>
          <p className="fish-size">
            <strong>{formatWeight(pending.grams, u)}</strong>
            {def.kind !== "haul" && <span> · {formatLength(pending.mm, u)}</span>}
          </p>
          <p className="muted fish-blurb">{def.blurb}</p>
          {fills && <p className="fish-fill">That fills your basket. You will head home with it.</p>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void putAway("keep")} autoFocus>{def.kind === "haul" ? "Keep it" : "Into the basket"}</button>
            <button disabled={busy} onClick={() => void putAway("release")}>{def.kind === "haul" ? "Toss it back" : "Throw it back"}</button>
          </div>
        </div>
      )}

      {ended?.outing?.sitting ? (
        <div className="fish-end quarry-intro" role="dialog" aria-label="Done fishing">
          <div className="qa-head"><h2>Done fishing</h2></div>
          <Summary view={ended.outing} paid={ended.paid} xp={ended.xp} sitting={ended.sitting} />
          <div className="qa-foot">
            <span className="spacer" />
            <button className="primary" onClick={onClose} autoFocus>Back to the Harbor</button>
          </div>
        </div>
      ) : (
        <div className="fish-bottom">
          <span className="muted fish-hint">{fighting ? "Tap while it runs · Hold while it rests" : `${live.landed.filter((f) => f.kept).length} kept`}</span>
          <span className="spacer" />
          <button className="small" onClick={() => setBook(true)} title="Every kind you have caught">Catch Book</button>
          <button className="small" disabled={busy} onClick={onClose} title="Leave the sitting open and walk about. It ends by itself after 15 minutes left alone.">Step away</button>
          <button className="small" disabled={busy || fighting || !!pending} onClick={() => void stop()}>Done fishing</button>
        </div>
      )}
    </div>
  );
}

/** Fishing at a pier or the shore: the card, or the sitting under way. */
export function Fishing({ pier, at, vessel = null, gilded = false, world, shipBeside, onRod, onClose, onStamina }: {
  pier: Pier;
  at: HexPos;
  vessel?: Vessel | null;
  gilded?: boolean;
  world: WorldRenderer;
  shipBeside: boolean;
  onRod?(on: boolean): void;
  onClose(): void;
  onStamina?(s: { left: number; max: number }): void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [ended, setEnded] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.gather().then(
      (s) => {
        setStatus(s);
        // Left alone too long: it ended while you were away.
        if (s.sitting && s.outing?.sitting) setEnded(s);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const tell = useRef(onStamina);
  tell.current = onStamina;
  useEffect(() => {
    if (status) tell.current?.({ left: status.stamina.left, max: status.stamina.max });
  }, [status?.stamina.left, status?.stamina.max]);

  const apply = (next: Status) => {
    setStatus(next);
    if (next.outing && next.outing.status !== "active") setEnded(next);
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.gatherStart("fishing", pier);
      setEnded(null);
      setStatus(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Once a sitting is under way its view stays up until the player leaves it, so it can show what came home at the end.
  const outing = status?.outing;
  const active = outing?.sitting && outing.status === "active" ? outing : null;
  const [playing, setPlaying] = useState<GatherView | null>(null);
  useEffect(() => {
    if (active && !playing) setPlaying(active);
  }, [active, playing]);
  const shown = playing ?? active;
  if (shown) return <Sitting outing={shown} world={world} pier={pier} at={at} vessel={vessel} gilded={gilded} shipBeside={shipBeside} apply={apply} onRod={onRod} onClose={onClose} />;
  return <FishingIntro pier={pier} status={status} ended={ended} busy={busy} error={error} onStart={() => void start()} onClose={onClose} />;
}
