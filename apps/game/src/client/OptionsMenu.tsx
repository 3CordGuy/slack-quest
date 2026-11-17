// The game menu: one window for everything that is not the game itself. The
// cog on the bottom bar (or Escape) opens it over whatever view you are in;
// nothing pauses behind it. Down the left are the view's own actions (the
// invite link, your account, leaving) and putting things back; beside them
// the sound and the display.
//
// It closes on Escape, on Resume, or on a press outside the window.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { audio } from "./audio/engine";
import { FADERS, FADER_LABELS } from "./audio/mixer";
import { resetPanels } from "./DragPanel";
import { PixelIcon } from "./PixelIcon";
import { fancy, fancyGrass } from "./render/fancy";
import { units } from "./units";
import { GEAR, GRASS, RULER, SPARKLE, SPEAKER_OFF, SPEAKER_ON } from "./ui/menuIcons";
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, getUiScale, onUiScaleChange, setUiScale, uiZoom } from "./uiScale";

export interface ResetPosition {
  /** Ask the server to put your hero back. */
  run(): void;
  /** Where that is, for the hint: "the landing", "the door". */
  to: string;
}

/** Something the view you are in adds to the menu: its invite link, the way out. */
export interface MenuAction {
  label: ReactNode;
  run(): void;
  hint?: string;
  disabled?: boolean;
  /** Stay in the menu after it runs (copying a link); otherwise the menu closes. */
  stay?: boolean;
  tone?: "primary" | "danger" | "nudge";
}

/** A slider whose rail fills as far as its knob. */
function Slider({ value, disabled, onChange, label }: { value: number; disabled?: boolean; onChange(v: number): void; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <input
      type="range"
      min={0}
      max={100}
      step={5}
      value={pct}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={`${pct}%`}
      style={{ "--fill": `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
    />
  );
}

export function OptionsMenu({ reset, resetBlocked, title = "The Harbor of Heylets", subtitle, actions = [] }: {
  /** Offered where your hero can safely be put back. */
  reset?: ResetPosition;
  /** Why it is not offered here; shown greyed out with this as the reason. */
  resetBlocked?: string;
  /** Where you are: the menu's heading. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** The view's own entries, listed first. */
  actions?: MenuAction[];
}) {
  const [open, setOpen] = useState(false);
  // The sound is the audio engine's mix: a master, and a slider for each group under it.
  const mix = useSyncExternalStore(audio.mix.subscribe, audio.mix.get);
  const muted = mix.muted;
  const fancyOn = useSyncExternalStore(fancy.subscribe, fancy.get);
  const grassOn = useSyncExternalStore(fancyGrass.subscribe, fancyGrass.get);
  const measures = useSyncExternalStore(units.subscribe, units.get);
  const [scale, setScale] = useState(getUiScale);
  const [zoom, setZoom] = useState(uiZoom);
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

  // Escape opens the menu when nothing else is open over the view, and closes it again.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) {
        e.stopPropagation();
        setOpen(false);
        gear.current?.focus();
      } else if (!document.querySelector(".overlay, .look-dialog-backdrop") && !(e.target as HTMLElement | null)?.closest?.("input, textarea, select")) {
        setOpen(true);
      }
    };
    // Heard before anyone else: a view that shuts its own window on Escape must not leave the menu thinking nothing was open.
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [open]);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  // From the live value, so quick presses each count even before a re-render.
  const step = (dir: 1 | -1) => setUiScale(getUiScale() + dir * UI_SCALE_STEP);
  const close = () => setOpen(false);

  return (
    <span className="options">
      <button
        ref={gear}
        className="hud-btn options-gear"
        title="Menu (Esc)"
        aria-label="Menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <PixelIcon rows={GEAR} size={20} />
      </button>
      {/* Drawn into the view itself, not here in the bar: the bar is filtered, and a filtered box would pin the menu inside it. */}
      {open && createPortal(
        <div className="overlay menu-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
          <div className="panel window game-menu" id={menuId} role="dialog" aria-label="Menu">
            <span className="win-plate">Menu</span>
            <header className="menu-head">
              <h2>{title}</h2>
              {subtitle && <p className="muted">{subtitle}</p>}
            </header>
            <div className="menu-cols">
              <section className="menu-col">
                <h3>Game</h3>
                <button ref={first} className="primary menu-action" onClick={close}>Resume</button>
                {actions.map((a, i) => (
                  <button
                    key={i}
                    className={`menu-action ${a.tone ?? ""}`}
                    disabled={a.disabled}
                    title={a.hint}
                    onClick={() => {
                      a.run();
                      if (!a.stay) close();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
                <button
                  className="menu-action"
                  disabled={!reset}
                  title={reset ? `Put your hero back at ${reset.to}` : resetBlocked}
                  onClick={() => {
                    reset?.run();
                    close();
                  }}
                >
                  Reset position
                </button>
                <p className="options-note muted">{reset ? `Stuck or lost? This puts your hero back at ${reset.to}.` : resetBlocked}</p>
              </section>

              <section className="menu-col">
                <h3>Sound</h3>
                <button className="options-sound" role="switch" aria-checked={!muted} onClick={() => audio.mix.setMuted(!muted)}>
                  <PixelIcon rows={muted ? SPEAKER_OFF : SPEAKER_ON} size={18} />
                  <span className="grow">Sound</span>
                  <span className={`options-switch ${muted ? "" : "on"}`} aria-hidden>{muted ? "Off" : "On"}</span>
                </button>
                {FADERS.map((f) => {
                  const level = audio.mix.volume(f);
                  const name = f === "master" ? "Volume" : FADER_LABELS[f];
                  return (
                    <label key={f} className="menu-slider">
                      <span className="options-label">{name}</span>
                      <output className="options-value">{pct(level)}</output>
                      <Slider label={name} value={level} disabled={muted} onChange={(v) => audio.mix.setVolume(f, v)} />
                    </label>
                  );
                })}
                <label className="options-check" title="Places sounds around your head instead of between two speakers. Best on headphones.">
                  <input type="checkbox" checked={mix.headphones} onChange={(e) => audio.mix.setHeadphones(e.target.checked)} /> Headphones (3D sound)
                </label>
                <button className="link" disabled={!audio.mix.changed} onClick={() => audio.mix.reset()}>Reset sound</button>
              </section>

              <section className="menu-col">
                <h3>Display</h3>
                <div className="options-row" role="group" aria-label="UI scale">
                  <span className="options-label">UI scale</span>
                  <button className="small" aria-label="Smaller" title="Smaller" disabled={scale <= UI_SCALE_MIN} onClick={() => step(-1)}>−</button>
                  <output className="options-value" aria-live="polite">{pct(scale)}</output>
                  <button className="small" aria-label="Larger" title="Larger" disabled={scale >= UI_SCALE_MAX} onClick={() => step(1)}>+</button>
                </div>
                {zoom !== scale && <p className="options-note muted">Drawn at {pct(zoom)} on a screen this narrow.</p>}
                <button
                  className="options-sound"
                  role="switch"
                  aria-checked={fancyOn}
                  title="Glowing lights, a soft blur into the distance, and characters lit by the scene. Uses more battery."
                  onClick={() => fancy.set(!fancyOn)}
                >
                  <PixelIcon rows={SPARKLE} size={18} />
                  <span className="grow">Fancy graphics</span>
                  <span className={`options-switch ${fancyOn ? "on" : ""}`} aria-hidden>{fancyOn ? "On" : "Off"}</span>
                </button>
                <button
                  className="options-sound"
                  role="switch"
                  aria-checked={grassOn}
                  title="Thick fields of grass blades and oaks in full leaf. Off, the grass is a few tufts and the trees are plain low-poly: easier on a phone."
                  onClick={() => fancyGrass.set(!grassOn)}
                >
                  <PixelIcon rows={GRASS} size={18} />
                  <span className="grow">Fancy grass</span>
                  <span className={`options-switch ${grassOn ? "on" : ""}`} aria-hidden>{grassOn ? "On" : "Off"}</span>
                </button>
                <button
                  className="options-sound"
                  role="switch"
                  aria-checked={measures === "imperial"}
                  title="How catches are weighed and measured: kilograms and centimetres, or pounds and inches."
                  onClick={() => units.set(measures === "imperial" ? "metric" : "imperial")}
                >
                  <PixelIcon rows={RULER} size={18} />
                  <span className="grow">Measures</span>
                  <span className="options-switch on" aria-hidden>{measures === "imperial" ? "Imperial" : "Metric"}</span>
                </button>
                <button className="menu-action" onClick={resetPanels}>Reset UI windows</button>
              </section>
            </div>
          </div>
        </div>,
        gear.current?.closest(".run") ?? document.body,
      )}
    </span>
  );
}
