// The Sound button in the top bar: a slider for each volume group, a master
// over them, a mute, and a way back to the defaults the game ships with.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audio } from "./engine";
import { FADERS, FADER_LABELS } from "./mixer";
import "./sound.css";

export function SoundButton() {
  const [open, setOpen] = useState(false);
  const settings = useSyncExternalStore(audio.mix.subscribe, audio.mix.get);
  const wrap = useRef<HTMLSpanElement>(null);

  // A click anywhere else, or Escape, closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const changed = settings.muted || Object.keys(settings.volumes).length > 0;
  return (
    <span className="sound" ref={wrap}>
      <button className={`small ${open ? "selected" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {settings.muted ? "Sound off" : "Sound"}
      </button>
      {open && (
        <div className="sound-panel panel" role="dialog" aria-label="Sound">
          {FADERS.map((f) => {
            const value = Math.round(audio.mix.volume(f) * 100);
            return (
              <label key={f} className="sound-row">
                <span>{FADER_LABELS[f]}</span>
                <input type="range" min={0} max={100} step={1} value={value} disabled={settings.muted} onChange={(e) => audio.mix.setVolume(f, Number(e.target.value) / 100)} />
                <span className="sound-value">{value}</span>
              </label>
            );
          })}
          <div className="sound-foot">
            <label className="sound-mute">
              <input type="checkbox" checked={settings.muted} onChange={(e) => audio.mix.setMuted(e.target.checked)} /> Mute all
            </label>
            <button className="link" disabled={!changed} onClick={() => audio.mix.reset()}>
              Reset
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
