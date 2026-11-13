// The Sound button in the top bar: a slider for each volume group, a master
// over them, a mute, a headphones mode, and a way back to the defaults the
// game ships with. While developing it also opens a live readout of the engine.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audio } from "./engine";
import { FADERS, FADER_LABELS } from "./mixer";
import "./sound.css";

export function SoundButton() {
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
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
          <label className="sound-check" title="Places sounds around your head instead of between two speakers. Best on headphones.">
            <input type="checkbox" checked={settings.headphones} onChange={(e) => audio.mix.setHeadphones(e.target.checked)} /> Headphones (3D sound)
          </label>
          <div className="sound-foot">
            <label className="sound-check">
              <input type="checkbox" checked={settings.muted} onChange={(e) => audio.mix.setMuted(e.target.checked)} /> Mute all
            </label>
            <button className="link" disabled={!audio.mix.changed} onClick={() => audio.mix.reset()}>
              Reset
            </button>
          </div>
          {import.meta.env.DEV && (
            <button className="link sound-debug-toggle" onClick={() => setDebug((d) => !d)}>
              {debug ? "Hide" : "Show"} engine readout
            </button>
          )}
        </div>
      )}
      {import.meta.env.DEV && debug && <AudioReadout onClose={() => setDebug(false)} />}
    </span>
  );
}

/** Development only: what the engine is doing right now, refreshed a few times a second. */
function AudioReadout({ onClose }: { onClose(): void }) {
  const [d, setD] = useState(() => audio.debug());
  useEffect(() => {
    const t = setInterval(() => setD(audio.debug()), 250);
    return () => clearInterval(t);
  }, []);
  const num = (n: number | undefined) => (n === undefined ? "–" : n.toFixed(2));
  const rows: [string, string][] = [
    ["Engine", d.state],
    ["Scene", d.scene ?? "none"],
    ["Ground", d.ground ?? "none"],
    ["Reverb", d.reverb ?? "none"],
    ["Night · rain · time", `${num(d.params.night)} · ${num(d.params.rain)} · ${num(d.params.time)}`],
    ["Placing", d.headphones ? "headphones (HRTF)" : "speakers (pan)"],
    ["Sea", d.sea ? `${d.sea.distance.toFixed(1)} away, ${Math.round(d.sea.spread * 100)}% around` : "none in reach"],
    ...Object.entries(d.emitters).map(([kind, slots]): [string, string] => [`Emitter: ${kind}`, slots.join(", ") || "loading"]),
    ...d.loops.map((l): [string, string] => [`Loop: ${l.id}`, l.parts.join(", ") || "loading"]),
    ["One-shots", d.voices.length ? d.voices.join(", ") : "none"],
    ["Memory", d.library ? `${d.library.megabytes} of ${d.library.budget} MB, ${d.library.decoded}/${d.library.files} files, ${d.library.format}` : "–"],
  ];
  return (
    <div className="sound-readout panel">
      <div className="sound-readout-head">
        <strong>Audio engine</strong>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
