// The gear at the right end of every view's top bar, and the small menu it
// opens: the sound, how big the HTML is drawn, fancy graphics, putting the panels back, and
// getting a lost or stuck hero back to somewhere safe.
//
// The menu closes on a press anywhere outside it, or on Escape (which hands
// focus back to the gear).

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { audio } from "./audio/engine";
import { AudioReadout } from "./audio/SoundButton";
import { FADERS, FADER_LABELS } from "./audio/mixer";
import { resetPanels } from "./DragPanel";
import { PixelIcon } from "./PixelIcon";
import { fancy } from "./render/fancy";
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, getUiScale, onUiScaleChange, setUiScale, uiZoom } from "./uiScale";

const GEAR = [
  "....##....",
  ".##.##.##.",
  ".########.",
  "..##..##..",
  "####..####",
  "####..####",
  "..##..##..",
  ".########.",
  ".##.##.##.",
  "....##....",
];

const SPEAKER_ON = [
  ".....#......",
  "....##...#..",
  "...###....#.",
  "######.#...#",
  "######..#..#",
  "######..#..#",
  "######.#...#",
  "...###....#.",
  "....##...#..",
  ".....#......",
];

const SPEAKER_OFF = [
  ".....#......",
  "....##......",
  "...###......",
  "######.#...#",
  "######..#.#.",
  "######...#..",
  "######..#.#.",
  "...###.#...#",
  "....##......",
  ".....#......",
];

const SPARKLE = [
  "....#.......",
  "....#.......",
  "...###...#..",
  "#########...",
  "...###......",
  "....#...#...",
  "....#..###..",
  "........#...",
  "..#.........",
  ".###........",
];

const READOUT_KEY = "gq.dev.readout";
function readoutOpen(): boolean {
  try {
    return localStorage.getItem(READOUT_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ResetPosition {
  /** Ask the server to put your hero back. */
  run(): void;
  /** Where that is, for the hint: "the landing", "the door". */
  to: string;
}

export function OptionsMenu({ reset, resetBlocked }: {
  /** Offered where your hero can safely be put back. */
  reset?: ResetPosition;
  /** Why it is not offered here; shown greyed out with this as the reason. */
  resetBlocked?: string;
}) {
  const [open, setOpen] = useState(false);
  // The sound is the audio engine's mix: a master, and a slider for each group under it.
  const mix = useSyncExternalStore(audio.mix.subscribe, audio.mix.get);
  const muted = mix.muted;
  const volume = audio.mix.volume("master");
  const fancyOn = useSyncExternalStore(fancy.subscribe, fancy.get);
  // Dev server only: the audio engine's readout, with the time-of-day and weather holds. It stays open from view to view.
  const [readout, setReadout] = useState(() => import.meta.env.DEV && readoutOpen());
  const showReadout = (on: boolean) => {
    try {
      if (on) localStorage.setItem(READOUT_KEY, "1");
      else localStorage.removeItem(READOUT_KEY);
    } catch {
      // Blocked storage: it stays open until this view closes.
    }
    setReadout(on);
  };
  const [scale, setScale] = useState(getUiScale);
  const [zoom, setZoom] = useState(uiZoom);
  const wrap = useRef<HTMLSpanElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(
    () =>
      onUiScaleChange(() => {
        setScale(getUiScale());
        setZoom(uiZoom());
      }),
    [],
  );

  // Close on a press outside, or Escape.
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      gear.current?.focus();
    };
    addEventListener("pointerdown", onDown, { capture: true });
    addEventListener("keydown", onKey, { capture: true });
    return () => {
      removeEventListener("pointerdown", onDown, { capture: true });
      removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  // From the live value, so quick presses each count even before a re-render.
  const step = (dir: 1 | -1) => setUiScale(getUiScale() + dir * UI_SCALE_STEP);

  return (
    <span className="options" ref={wrap}>
      <button
        ref={gear}
        className="small icon-btn options-gear"
        title="Options"
        aria-label="Options"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <PixelIcon rows={GEAR} />
      </button>
      {open && (
        <div className="options-menu panel" id={menuId} role="dialog" aria-label="Options">
          <h4>Options</h4>

          <div className="options-row">
            <button ref={first} className="options-sound" role="switch" aria-checked={!muted} onClick={() => audio.mix.setMuted(!muted)}>
              <PixelIcon rows={muted ? SPEAKER_OFF : SPEAKER_ON} size={18} />
              <span className="grow">Sound</span>
              <span className={`options-switch ${muted ? "" : "on"}`} aria-hidden>
                {muted ? "Off" : "On"}
              </span>
            </button>
          </div>
          <label className="options-row">
            <span className="options-label">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              disabled={muted}
              aria-valuetext={pct(volume)}
              onChange={(e) => audio.mix.setVolume("master", Number(e.target.value) / 100)}
            />
            <output className="options-value">{pct(volume)}</output>
          </label>
          {FADERS.filter((f) => f !== "master").map((f) => {
            const level = audio.mix.volume(f);
            return (
              <label key={f} className="options-row options-sub">
                <span className="options-label">{FADER_LABELS[f]}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(level * 100)}
                  disabled={muted}
                  aria-valuetext={pct(level)}
                  onChange={(e) => audio.mix.setVolume(f, Number(e.target.value) / 100)}
                />
                <output className="options-value">{pct(level)}</output>
              </label>
            );
          })}
          <div className="options-row options-sub">
            <label className="options-check" title="Places sounds around your head instead of between two speakers. Best on headphones.">
              <input type="checkbox" checked={mix.headphones} onChange={(e) => audio.mix.setHeadphones(e.target.checked)} /> Headphones (3D sound)
            </label>
            <button className="link" disabled={!audio.mix.changed} onClick={() => audio.mix.reset()}>
              Reset sound
            </button>
          </div>

          <div className="options-row" role="group" aria-label="UI scale">
            <span className="options-label">UI scale</span>
            <button className="small" aria-label="Smaller" title="Smaller" disabled={scale <= UI_SCALE_MIN} onClick={() => step(-1)}>
              −
            </button>
            <output className="options-value" aria-live="polite">{pct(scale)}</output>
            <button className="small" aria-label="Larger" title="Larger" disabled={scale >= UI_SCALE_MAX} onClick={() => step(1)}>
              +
            </button>
          </div>
          {zoom !== scale && <p className="options-note muted">Drawn at {pct(zoom)} on a screen this narrow.</p>}

          <div className="options-row">
            <button
              className="options-sound"
              role="switch"
              aria-checked={fancyOn}
              title="Glowing lights, a soft blur into the distance, and characters lit by the scene. Uses more battery."
              onClick={() => fancy.set(!fancyOn)}
            >
              <PixelIcon rows={SPARKLE} size={18} />
              <span className="grow">Fancy graphics</span>
              <span className={`options-switch ${fancyOn ? "on" : ""}`} aria-hidden>
                {fancyOn ? "On" : "Off"}
              </span>
            </button>
          </div>

          {import.meta.env.DEV && (
            <button className="options-action" onClick={() => showReadout(!readout)}>
              {readout ? "Hide" : "Show"} audio engine and sky (dev)
            </button>
          )}
          <button
            className="options-action"
            onClick={() => {
              resetPanels();
              setOpen(false);
            }}
          >
            Reset UI windows
          </button>
          <button
            className="options-action"
            disabled={!reset}
            title={reset ? `Put your hero back at ${reset.to}` : resetBlocked}
            onClick={() => {
              reset?.run();
              setOpen(false);
            }}
          >
            Reset position
          </button>
          <p className="options-note muted">{reset ? `Stuck or lost? This puts your hero back at ${reset.to}.` : resetBlocked}</p>
        </div>
      )}
      {import.meta.env.DEV && readout && <AudioReadout onClose={() => showReadout(false)} />}
    </span>
  );
}
