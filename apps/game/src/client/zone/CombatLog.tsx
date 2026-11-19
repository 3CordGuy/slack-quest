// The combat log: the whole fight, line by line, at the bottom right of the
// view. This is where a player reads what happened: whose turn began, what
// was tried, the dice as they fell, whether it landed, and what it did.
//
//   ── Round 2 ──
//   Mira's turn
//   Mira · Attack roll ▸ Dire Wolf
//     [14] + 5 = 19 vs 13                      HIT
//   Mira hits Dire Wolf with Cleave              9
//     1d8 <6> + 3 = 9
//
// A d20 is a six-sided chip, and both are shown when two were rolled (with
// advantage or disadvantage), the one that did not count struck through.
// Damage and healing dice are chips in the shape of their die: a d4's three
// corners, a square d6, a d8's diamond. Lines are coloured by side: your crew
// warm gold, the enemy red.
//
// The log keeps everything it is handed (the view caps it), scrolls, and
// stays at the newest line unless the player has scrolled up to read; then a
// button brings them back. Folded, it is a single strip showing the last line.
//
// RollToast is the one newest roll shown large for a moment over the turn
// bar: the d20 tumbles in and lands on its number, then the sum, then how it
// came out.

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Roll, Rolled } from "@gantt-quest/world";
import "./fight.css";

export type LogSide = "hero" | "enemy" | "none";

export type LogEntry =
  /** A heading: "Round 2", "Combat begins". */
  | { k: "head"; id: number; text: string }
  /** Whose turn starts. */
  | { k: "turn"; id: number; name: string; side: LogSide }
  /** Anything else. */
  | { k: "note"; id: number; text: string; tone?: "good" | "bad" | "dim" }
  /** A d20: an attack, a save, a shove, initiative. */
  | { k: "roll"; id: number; who: string; side: LogSide; roll: Roll; target?: string }
  | { k: "hit"; id: number; actor?: string; side: LogSide; target: string; what: string; amount: number; dice?: Rolled; crit?: boolean; blocked?: number }
  | { k: "miss"; id: number; actor: string; side: LogSide; target: string; what: string }
  | { k: "heal"; id: number; actor?: string; target: string; what: string; amount: number; dice?: Rolled };

export interface CombatLogProps {
  entries: LogEntry[];
  open: boolean;
  onToggle: () => void;
}

/** How a roll came out, in a word, and how it is coloured: "ok", "no", "crit" (a critical hit) or "flat" (nothing to beat). */
export function rollOutcome(roll: Roll): { word: string; tone: "ok" | "no" | "crit" | "flat" } {
  if (roll.kind === "initiative") return { word: "Initiative", tone: "flat" };
  if (roll.crit && roll.ok) return { word: "Critical", tone: "crit" };
  if (roll.kind === "attack") return roll.ok ? { word: "Hit", tone: "ok" } : { word: "Miss", tone: "no" };
  if (roll.kind === "save") return roll.ok ? { word: "Saved", tone: "ok" } : { word: "Failed", tone: "no" };
  return roll.ok ? { word: "Shoved", tone: "ok" } : { word: "Held firm", tone: "no" };
}

/** Which of the d20s rolled is the one that counted (the first that shows `kept`). */
const keptIndex = (roll: Roll) => Math.max(0, roll.d20.indexOf(roll.kept));
const signed = (n: number) => `${n < 0 ? "−" : "+"} ${Math.abs(n)}`;
const SHAPES = new Set([4, 6, 8, 10, 12, 20]);

/**
 * One die as a chip in its own shape, showing what it rolled. `dropped` strikes it through (the d20 that did not
 * count); the highest and lowest faces of a d20 are tinted, and a damage die that rolled its most is too.
 */
export function Die({ d, n, dropped = false }: { d: number; n: number; dropped?: boolean }) {
  const shape = SHAPES.has(d) ? d : d < 6 ? 4 : d < 8 ? 6 : d < 10 ? 8 : d < 12 ? 10 : d < 20 ? 12 : 20;
  return (
    <span className={`fd d${shape} ${dropped ? "dropped" : n >= d ? "top" : d === 20 && n === 1 ? "low" : ""}`} title={`d${d}: ${n}`}>
      <span>{n}</span>
    </span>
  );
}

/** Damage or healing dice written out: "1d8 <6> + 3 = 9", with what a save or a shield did to it after. */
export function DiceSum({ dice, blocked }: { dice: Rolled; blocked?: number }) {
  return (
    <>
      <span className="fl-nd">{dice.faces.length}d{dice.d}</span>
      {dice.faces.map((n, i) => <Die key={i} d={dice.d} n={n} />)}
      {dice.plus !== 0 && <span>{signed(dice.plus)}</span>}
      <span>= <strong>{dice.total}</strong></span>
      {dice.crit && <span className="fl-mod adv" title="A critical hit rolls twice the dice">crit</span>}
      {dice.halved && <span className="fl-mod half" title="The target saved, and took half">halved</span>}
      {!!blocked && <span className="fl-mod blk" title="Taken by a shield or a guard">({blocked} blocked)</span>}
    </>
  );
}

/** A d20 roll written out: the dice, the bonus, the sum, what it had to reach, and how it came out. */
function RollSum({ roll }: { roll: Roll }) {
  const kept = keptIndex(roll);
  const out = rollOutcome(roll);
  return (
    <div className="fl-math">
      {roll.d20.map((n, i) => <Die key={i} d={20} n={n} dropped={i !== kept} />)}
      <span>{signed(roll.bonus)}</span>
      <span>= <strong>{roll.total}</strong></span>
      {roll.kind !== "initiative" && <i>vs {roll.vs}</i>}
      {roll.adv !== 0 && <span className={`fl-mod ${roll.adv > 0 ? "adv" : "dis"}`} title={roll.adv > 0 ? "Advantage: two dice, the higher counts" : "Disadvantage: two dice, the lower counts"}>{roll.adv > 0 ? "adv" : "dis"}</span>}
      {roll.kind !== "initiative" && <span className={`fl-tag ${out.tone}`}>{out.word}</span>}
    </div>
  );
}

/** One entry as plain words: the folded log's strip, and anything else that wants a line of text. */
export function logLine(e: LogEntry): string {
  switch (e.k) {
    case "head": return e.text;
    case "turn": return `${e.name}'s turn`;
    case "note": return e.text;
    case "roll": return e.roll.kind === "initiative" ? `${e.who} rolls ${e.roll.total} for initiative` : `${e.who}: ${e.roll.label} ${e.roll.total} vs ${e.roll.vs}, ${rollOutcome(e.roll).word.toLowerCase()}`;
    case "hit": return e.actor ? `${e.actor} hits ${e.target} with ${e.what} for ${e.amount}${e.crit ? " (critical)" : ""}` : `${e.target} takes ${e.amount} from ${e.what}`;
    case "miss": return `${e.actor} misses ${e.target} with ${e.what}`;
    case "heal": return e.actor && e.actor !== e.target ? `${e.actor} heals ${e.target} for ${e.amount} with ${e.what}` : `${e.target} recovers ${e.amount} from ${e.what}`;
  }
}

const Row = memo(function Row({ e, fresh }: { e: LogEntry; fresh: boolean }) {
  const cls = (more: string) => `fl-e ${e.k} ${more} ${fresh ? "fresh" : ""}`;
  switch (e.k) {
    case "head":
      return <div className={cls("")} role="separator"><span>{e.text}</span></div>;
    case "turn":
      return <div className={cls(e.side)}>{e.name}'s turn</div>;
    case "note":
      return <div className={cls(e.tone ?? "")}>{e.text}</div>;
    case "roll":
      return (
        <div className={cls(e.side)}>
          <div className="fl-line">
            <span><b>{e.who}</b> <span className="fl-what">· {e.roll.label}</span>{e.target && <> <span className="fl-what">▸</span> <span className="fl-tgt">{e.target}</span></>}</span>
          </div>
          <RollSum roll={e.roll} />
        </div>
      );
    case "hit":
      return (
        <div className={cls(`${e.side} ${e.crit ? "crit" : ""}`)}>
          <div className="fl-line">
            {e.actor
              ? <span><b>{e.actor}</b> {e.crit ? "crits" : "hits"} <span className="fl-tgt">{e.target}</span> <span className="fl-what">with {e.what}</span></span>
              : <span><span className="fl-tgt">{e.target}</span> takes damage <span className="fl-what">from {e.what}</span></span>}
            <strong className="fl-amt" title={`${e.amount} damage`}>{e.amount}</strong>
          </div>
          {e.dice
            ? <div className="fl-math"><DiceSum dice={e.dice} blocked={e.blocked} /></div>
            : !!e.blocked && <div className="fl-math"><span className="fl-mod blk">({e.blocked} blocked)</span></div>}
        </div>
      );
    case "miss":
      return <div className={cls(e.side)}><b>{e.actor}</b> misses <span className="fl-tgt">{e.target}</span> <span className="fl-what">with {e.what}</span></div>;
    case "heal":
      return (
        <div className={cls("hero")}>
          <div className="fl-line">
            {e.actor && e.actor !== e.target
              ? <span><b>{e.actor}</b> heals <span className="fl-tgt">{e.target}</span> <span className="fl-what">with {e.what}</span></span>
              : <span><b>{e.target}</b> recovers <span className="fl-what">· {e.what}</span></span>}
            <strong className="fl-amt heal" title={`${e.amount} healed`}>+{e.amount}</strong>
          </div>
          {e.dice && <div className="fl-math"><DiceSum dice={e.dice} /></div>}
        </div>
      );
  }
});

export function CombatLog({ entries, open, onToggle }: CombatLogProps) {
  const body = useRef<HTMLDivElement>(null);
  /** At the newest line: new ones are followed. Off once the player scrolls up to read. */
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  /** The newest entry there was when the log was first drawn (or last opened): later ones light up as they come. */
  const seen = useRef(entries.length ? entries[entries.length - 1].id : -Infinity);
  const last = entries.length ? entries[entries.length - 1] : null;

  useLayoutEffect(() => {
    const el = body.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [last?.id, entries.length, open]);
  // Opened: start at the newest line again.
  useEffect(() => {
    if (!open) return;
    stuck.current = true;
    setAway(false);
  }, [open]);
  // What has been shown once no longer lights up.
  useEffect(() => {
    if (!last) return;
    const timer = setTimeout(() => { seen.current = last.id; }, 950);
    return () => clearTimeout(timer);
  }, [last?.id]);

  const toLatest = () => {
    const el = body.current;
    if (!el) return;
    stuck.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <section className={`fight-ui fight-log ${open ? "open" : "shut"}`} aria-label="Combat log">
      <button type="button" className="fl-head" aria-expanded={open} onClick={onToggle} title={open ? "Fold the log away" : "Open the combat log"}>
        <span className="fl-title">Combat Log</span>
        {open ? <span className="fl-count">{entries.length ? `${entries.length} line${entries.length === 1 ? "" : "s"}` : ""}</span> : <span className="fl-last">{last ? logLine(last) : "Nothing yet"}</span>}
        <span className="fl-chev" aria-hidden />
      </button>
      {open && (
        <div
          ref={body}
          className="fl-body"
          role="log"
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            const at = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
            stuck.current = at;
            setAway(!at);
          }}
        >
          {entries.length === 0 && <div className="fl-empty">Nothing has happened yet.</div>}
          {entries.map((e) => <Row key={e.id} e={e} fresh={e.id > seen.current} />)}
        </div>
      )}
      {open && away && <button type="button" className="fl-jump" onClick={toLatest}>Latest ↓</button>}
    </section>
  );
}

// ---------- the roll, large ----------

export interface RollToastProps {
  /** The roll to show; null for none. A new roll (a new object) plays it again. */
  roll: Roll | null;
  /** Who rolled. */
  who?: string;
  /** The damage or healing dice that followed it, shown under the outcome. */
  dice?: Rolled | null;
  /** How long it stays before it fades by itself, in milliseconds (the view may take it away sooner by passing null). */
  hold?: number;
}

/** How long the die tumbles before it lands, in milliseconds (fr-tumble in fight.css). */
const TUMBLE_MS = 700;

function BigD20({ n, cls }: { n: number; cls: string }) {
  return (
    <span className={`fr-d20 ${cls}`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <path className="fr-body" d="M50 4 90 27V73L50 96 10 73V27Z" />
        <path className="fr-top" d="M50 4 90 27 50 24 10 27Z" />
        <path className="fr-edge" d="M50 24 76 66H24ZM50 24V4M50 24 10 27M50 24 90 27M76 66 90 27M76 66 90 73M76 66 50 96M24 66 10 27M24 66 10 73M24 66 50 96" />
      </svg>
      <b>{n}</b>
    </span>
  );
}

export function RollToast({ roll, who, dice, hold = 2800 }: RollToastProps) {
  /** The faces the dice show while they tumble, then what they rolled. */
  const [faces, setFaces] = useState<number[]>(roll?.d20 ?? []);
  const [phase, setPhase] = useState<"roll" | "landed" | "out" | "gone">("roll");
  /** The roll being shown, and how many there have been: each new one plays from the start. */
  const [play, setPlay] = useState({ roll, n: 0 });
  if (play.roll !== roll) {
    setPlay({ roll, n: play.n + 1 });
    setPhase("roll");
    setFaces(roll?.d20 ?? []);
  }

  useEffect(() => {
    if (!roll) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let spin: ReturnType<typeof setInterval> | undefined;
    const land = () => {
      if (spin) clearInterval(spin);
      setFaces(roll.d20);
      setPhase("landed");
    };
    if (still) land();
    else {
      setPhase("roll");
      setFaces(roll.d20.map(() => 1 + Math.floor(Math.random() * 20)));
      spin = setInterval(() => setFaces(roll.d20.map(() => 1 + Math.floor(Math.random() * 20))), 60);
      timers.push(setTimeout(land, TUMBLE_MS));
    }
    timers.push(setTimeout(() => setPhase("out"), hold), setTimeout(() => setPhase("gone"), hold + 360));
    return () => {
      if (spin) clearInterval(spin);
      timers.forEach(clearTimeout);
    };
  }, [roll, hold]);

  if (!roll || phase === "gone") return null;
  const out = rollOutcome(roll);
  const kept = keptIndex(roll);
  const botch = roll.kind === "attack" && roll.kept === 1;
  const words: ReactNode = roll.kind === "initiative" ? "Initiative" : out.tone === "crit" ? "Critical hit!" : out.word;
  return (
    <div key={play.n} className={`fight-ui fight-roll ${out.tone} ${botch ? "botch" : ""} ${phase === "roll" ? "" : "landed"} ${phase === "out" ? "out" : ""}`} role="status">
      <div className="fr-dice">
        {roll.d20.map((_, i) => <BigD20 key={i} n={faces[i] ?? roll.d20[i]} cls={i === kept ? "kept" : "dropped"} />)}
      </div>
      <div className="fr-text">
        <div className="fr-who">
          {who && <><b>{who}</b> · </>}{roll.label}
          {roll.adv !== 0 && <em className={roll.adv > 0 ? "adv" : "dis"}>{roll.adv > 0 ? "advantage" : "disadvantage"}</em>}
        </div>
        <div className="fr-line">
          <span className="fr-sum">
            {roll.kept} <i>{signed(roll.bonus)}</i> = <strong>{roll.total}</strong>
            {roll.kind !== "initiative" && <i>vs {roll.vs}</i>}
          </span>
          <span className="fr-out">{words}</span>
        </div>
        {dice && (
          <div className="fr-dmg">
            <i>{dice.faces.length}d{dice.d}</i>
            {dice.faces.map((n, i) => <Die key={i} d={dice.d} n={n} />)}
            {dice.plus !== 0 && <span>{signed(dice.plus)}</span>}
            <span>= <strong>{dice.total}</strong></span>
            {dice.halved && <i>halved</i>}
          </div>
        )}
      </div>
    </div>
  );
}
