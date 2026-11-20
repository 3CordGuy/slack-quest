// The muster, as a player sees it: someone of the crew is setting out for a
// place on the atlas and asks who is coming (packages/world/src/muster.ts).
//
// `useMuster` keeps the crew's muster as it now stands. In town it is pushed
// down the Harbor's socket (`pushed`); on the atlas, which has no socket, it
// is asked for every so often (`poll`). When it starts, whoever said they
// were ready is taken to the map; nobody else is.
//
// `MusterPanel` is the card: where to, how long is left, who has said what,
// and the two buttons that are yours to press. The one who called it gets
// "Start anyway" and "Call it off"; everyone else "Ready up" and "Not this
// time". It draws what it is handed, and knows no rules.

import { useCallback, useEffect, useRef, useState } from "react";
import { MUSTER_LINGER_MS, MUSTER_MS, musterOpen, type Muster, type MusterAnswer } from "@gantt-quest/world";
import { api } from "../api";
import { useCountdown } from "../ui/useCountdown";
import "./muster.css";

const WENT_KEY = "gq.muster.went";

export interface MusterState {
  muster: Muster | null;
  /** Answer it (or, for whoever called it, start it or call it off). */
  say: (answer: MusterAnswer) => void;
  /** Take a muster the server just handed back (calling one gives it). */
  take: (muster: Muster | null) => void;
  busy: boolean;
  error: string | null;
}

/**
 * The crew's muster for the player `me`. `pushed`: the muster as the Harbor's socket last told it (undefined where
 * there is no socket). `poll`: how often to ask for it, in ms (0: never). `onStart`: called once when a muster this
 * player is ready for starts, with the map's code, just before they are taken there.
 */
export function useMuster(me: string | null, { pushed, poll = 0, onStart }: { pushed?: Muster | null; poll?: number; onStart?: (muster: Muster) => void }): MusterState {
  const [muster, setMuster] = useState<Muster | null>(pushed ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (pushed !== undefined) setMuster(pushed);
  }, [pushed]);
  useEffect(() => {
    if (!poll) return;
    let live = true;
    const ask = () => api.muster().then((r) => live && setMuster(r.muster), () => {});
    ask();
    const every = setInterval(ask, poll);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [poll]);
  // One that has ended is shown a little while and then put away, whether or not anyone says it is gone.
  useEffect(() => {
    if (!muster?.endedAt) return;
    const id = muster.id;
    const t = setTimeout(() => setMuster((m) => (m?.id === id ? null : m)), Math.max(0, muster.endedAt + MUSTER_LINGER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [muster?.id, muster?.endedAt]);
  // It has started, and this player said they were coming: off they go, once.
  const started = useRef(onStart);
  started.current = onStart;
  useEffect(() => {
    if (!muster?.code || !me || !muster.ready.some((r) => r.id === me)) return;
    try {
      if (sessionStorage.getItem(WENT_KEY) === muster.id) return;
      sessionStorage.setItem(WENT_KEY, muster.id);
    } catch {
      // Storage is off: they are taken there each time it is told, which is once or twice.
    }
    started.current?.(muster);
    location.hash = `zone/${muster.code}`;
  }, [muster, me]);
  const say = useCallback((answer: MusterAnswer) => {
    setBusy(true);
    setError(null);
    api.answerMuster(answer).then(
      (r) => setMuster(r.muster),
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(false));
  }, []);
  return { muster, say, take: setMuster, busy, error };
}

const RING = 2 * Math.PI * 20;

export function MusterPanel({ muster, me, onSay, busy, error }: { muster: Muster; me: string | null; onSay: (answer: MusterAnswer) => void; busy?: boolean; error?: string | null }) {
  const left = useCountdown(muster.deadline) ?? 0;
  const open = musterOpen(muster);
  const mine = muster.by.id === me;
  const ready = muster.ready.some((r) => r.id === me);
  const declined = !!me && muster.declined.includes(me);
  // Everyone it concerns: whoever called it, whoever was asked, and anyone who turned up and said they were coming.
  const people = [muster.by, ...muster.asked, ...muster.ready.filter((r) => r.id !== muster.by.id && !muster.asked.some((a) => a.id === r.id))];
  const stateOf = (id: string) => (id === muster.by.id ? "caller" : muster.ready.some((r) => r.id === id) ? "ready" : muster.declined.includes(id) ? "no" : "asked");
  const waiting = muster.asked.filter((a) => stateOf(a.id) === "asked").length;
  const what = [muster.site, muster.level !== undefined ? `level ${muster.level}` : null].filter(Boolean).join(" · ");

  let line: string;
  if (muster.failed) line = muster.failed;
  else if (muster.code) line = ready ? "Through the waygate you go." : `${muster.by.name} has set out. The waygate in the square will take you after them, if you change your mind.`;
  else if (mine) line = waiting > 0 ? `Asking the crew. Waiting on ${waiting}.` : "Everyone has answered.";
  else if (ready) line = `You are coming. Waiting for ${muster.by.name} to start.`;
  else if (declined) line = "You are staying in town. You can still follow through the waygate later.";
  else line = `${muster.by.name} is setting out, and asks who is coming.`;

  return (
    <section className={`muster panel ${open ? "open" : muster.code ? "gone" : "off"} ${open && left <= 10 ? "urgent" : ""}`} role="dialog" aria-label={`Muster for ${muster.place}`} aria-live="polite">
      <div className="muster-clock" aria-hidden={!open}>
        <svg viewBox="0 0 48 48" aria-hidden>
          <circle className="muster-clock-bed" cx="24" cy="24" r="20" />
          {open && <circle className="muster-clock-now" cx="24" cy="24" r="20" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0, Math.min(1, (left * 1000) / MUSTER_MS)))} />}
        </svg>
        <b>{open ? left : muster.code ? "✓" : "✕"}</b>
      </div>
      <div className="muster-body">
        <div className="muster-head">
          <small>Muster</small>
          <strong>{muster.place}</strong>
          {what && <span>{what}</span>}
        </div>
        <p className="muster-line">{line}</p>
        <ul className="muster-crew">
          {people.map((p) => {
            const s = stateOf(p.id);
            return (
              <li key={p.id} className={s}>
                <i aria-hidden>{s === "caller" ? "⚑" : s === "ready" ? "✓" : s === "no" ? "✕" : "…"}</i>
                <span>{p.id === me ? "You" : p.name}</span>
                <em>{s === "caller" ? "setting out" : s === "ready" ? "ready" : s === "no" ? "staying" : "deciding"}</em>
              </li>
            );
          })}
        </ul>
        {error && <p className="bad muster-error" role="alert">{error}</p>}
        {open && (
          <div className="muster-buttons">
            {mine ? (
              <>
                <button className="primary" disabled={busy} onClick={() => onSay("start")} title="Set out now, with whoever has said they are ready">Start anyway</button>
                <button disabled={busy} onClick={() => onSay("cancel")} title="Nobody goes anywhere. Your lodestone stays in your pack.">Call it off</button>
              </>
            ) : ready ? (
              <>
                <span className="muster-said">You are ready</span>
                <button disabled={busy} onClick={() => onSay("no")}>Stand down</button>
              </>
            ) : (
              <>
                <button className="primary" disabled={busy} onClick={() => onSay("ready")} title="You are taken to the map with them when it starts">Ready up</button>
                {!declined && <button disabled={busy} onClick={() => onSay("no")} title="Stay in town. Nothing happens to you.">Not this time</button>}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
