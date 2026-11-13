// The Sound button in the top bar: a slider for each volume group, a master
// over them, a mute, a headphones mode, and a way back to the defaults the
// game ships with. While developing it also opens a live readout of the engine.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audio } from "./engine";
import { auditionShipped, setAuditionShipped } from "./library";
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

/** The renderer's own development overrides (render/ambience.ts): a held time of day and a held weather. */
type SkyHold = { __gqTime?: number; __gqWeather?: number; __gqStorm?: number };
const sky = globalThis as SkyHold;
const clock = (t: number) => {
  const mins = Math.round(t * 24 * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};

/**
 * Development only: hold the time of day and the weather where you want them, to hear and see any
 * moment without waiting for it. They change the sky in this tab alone; "Follow the clock" lets go.
 */
function SkyControls() {
  const [time, setTime] = useState<number | undefined>(sky.__gqTime);
  const [weather, setWeather] = useState<number | undefined>(sky.__gqWeather);
  const holdTime = (t: number | undefined) => {
    if (t === undefined) delete sky.__gqTime;
    else sky.__gqTime = t;
    setTime(t);
  };
  const [storm, setStorm] = useState(sky.__gqStorm === 1);
  /** A storm is its own weather: a downpour with thunder and lightning. Any other held weather has none. */
  const holdWeather = (w: number | undefined, stormy = false) => {
    if (w === undefined) delete sky.__gqWeather;
    else sky.__gqWeather = w;
    if (stormy) sky.__gqStorm = 1;
    else delete sky.__gqStorm;
    setWeather(w);
    setStorm(stormy);
  };
  const live = audio.debug().params;
  return (
    <div className="sound-sky">
      <label className="sound-row">
        <span>Time of day</span>
        <input type="range" min={0} max={1} step={0.005} value={time ?? live.time ?? 0.5} onChange={(e) => holdTime(Number(e.target.value))} />
        <span className="sound-value">{clock(time ?? live.time ?? 0.5)}</span>
      </label>
      <div className="sound-presets">
        {(
          [
            ["Dawn", 0.24],
            ["Noon", 0.5],
            ["Dusk", 0.78],
            ["Midnight", 0],
          ] as const
        ).map(([name, t]) => (
          <button key={name} className={`small ${time === t ? "selected" : ""}`} onClick={() => holdTime(t)}>
            {name}
          </button>
        ))}
        <button className="link" disabled={time === undefined} onClick={() => holdTime(undefined)}>
          Follow the clock
        </button>
      </div>
      <label className="sound-row">
        <span>Weather</span>
        <input type="range" min={0} max={1} step={0.01} value={weather ?? 0} onChange={(e) => holdWeather(Number(e.target.value), storm)} />
        <span className="sound-value">{weather === undefined ? "auto" : Math.round(weather * 100)}</span>
      </label>
      <div className="sound-presets">
        {(
          [
            ["Clear", 0],
            ["Overcast", 0.55],
            ["Light rain", 0.72],
            ["Downpour", 1],
          ] as const
        ).map(([name, w]) => (
          <button key={name} className={`small ${weather === w && !storm ? "selected" : ""}`} onClick={() => holdWeather(w)}>
            {name}
          </button>
        ))}
        <button className={`small ${storm ? "selected" : ""}`} onClick={() => holdWeather(1, true)}>
          Storm
        </button>
        <button className="link" disabled={weather === undefined} onClick={() => holdWeather(undefined)}>
          Follow the clock
        </button>
      </div>
    </div>
  );
}

/**
 * Development only: switch between the WAV masters and the encoded files a deployed game plays, to
 * compare them. Playing loops restart from the other source. Placeholders are never encoded, so
 * sounds that are still placeholders fall silent on the encoded side.
 */
function SourceSwitch() {
  const [shipped, setShipped] = useState(auditionShipped);
  const pick = (on: boolean) => {
    setAuditionShipped(on);
    setShipped(on);
    void audio.reload();
  };
  return (
    <div className="sound-presets sound-source">
      <span className="muted">Playing</span>
      <button className={`small ${shipped ? "" : "selected"}`} onClick={() => pick(false)}>
        Masters (WAV)
      </button>
      <button className={`small ${shipped ? "selected" : ""}`} onClick={() => pick(true)}>
        Encoded (as shipped)
      </button>
    </div>
  );
}

/** Development only: what the engine is doing right now, refreshed a few times a second. */
export function AudioReadout({ onClose }: { onClose(): void }) {
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
    ...d.loops.map((l): [string, string] => [`Loop: ${l.id}`, l.rest > 0 ? `resting, plays again in ${Math.floor(l.rest / 60)}:${String(Math.floor(l.rest % 60)).padStart(2, "0")}` : l.parts.join(", ") || "loading"]),
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
      <SkyControls />
      <SourceSwitch />
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
