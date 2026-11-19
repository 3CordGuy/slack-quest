// The turn bar: what a turn has to spend, on one board directly over the
// bottom rack while a fight is on.
//
//   [ YOUR TURN  ]   (Action)  /Bonus\   Movement  4 / 6  [-3]   [ (42) End Turn ]
//   [ Mira       >                        >>>>>>......           [      Round 2 ]
//
// From the left: a pennant saying whose turn it is; the Action as a round
// token and the Bonus action as a three-cornered one (lit while it is there
// to spend, dark and struck through once spent); the movement left as a run
// of chevrons with its number; and End Turn, with the turn's clock in a ring.
//
// When the turn is yours the board is rimmed in gold and the pennant is gold
// parchment reading "Your turn". When it is not, the pennant is a dull board
// reading "Waiting for <name>", the tokens are greyed and End Turn is dead.
//
// Spending is shown as it happens: a token flares, turns on its edge and
// comes back dark; a chevron flashes out. `moveCost` (the move under the
// pointer) hollows the chevrons it would spend and shows the number, in red
// when it is more than is left. Nothing here knows the rules: it draws what
// it is handed.

import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import "./fight.css";

export interface TurnBarProps {
  /** Whether the turn is this player's to take. */
  myTurn: boolean;
  /** The hero this bar is for (the one being played). */
  actor: string;
  /** Who everyone is waiting on, when it is not `myTurn`. */
  waitingFor?: string;
  round: number;
  /** The Action and the Bonus action: there to spend, or spent. */
  action: boolean;
  bonus: boolean;
  /** Movement left, and what a turn starts with. */
  move: number;
  moveMax: number;
  /** What the move under the pointer would cost, to preview; null or absent with none. */
  moveCost?: number | null;
  /** A charted course: movement good only for steps toward its mark. */
  course?: { now: number; max: number };
  /** Seconds left on the turn's clock; null with no clock. */
  seconds: number | null;
  /** End the turn. Absent when it cannot be ended (not yours). */
  onEnd?: () => void;
  /** Small things for this moment, in a row over the bar: "Join song", "Pick up the torch". */
  extra?: ReactNode;
}

/** More chevrons than this and the movement is drawn as one bar. */
const MAX_PIPS = 24;
const URGENT = 15;
const RING = 2 * Math.PI * 18;

/** The Action: a round brass-rimmed token with a sword on green enamel. */
function ActionArt() {
  const id = useId();
  return (
    <svg viewBox="0 0 56 56" aria-hidden>
      <defs>
        <radialGradient id={`${id}f`} cx="0.36" cy="0.28" r="0.85">
          <stop offset="0" stopColor="#e2ffd8" />
          <stop offset="0.38" stopColor="#7fd88c" />
          <stop offset="1" stopColor="#1f6b3a" />
        </radialGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6e2a1" />
          <stop offset="0.45" stopColor="#c9a24a" />
          <stop offset="0.7" stopColor="#6f5222" />
          <stop offset="1" stopColor="#c9a24a" />
        </linearGradient>
      </defs>
      <circle className="ft-rim" cx="28" cy="28" r="26" fill={`url(#${id}r)`} stroke="#1c0d0e" strokeWidth="2" />
      <circle className="ft-face" cx="28" cy="28" r="20" fill={`url(#${id}f)`} stroke="#1c0d0e" strokeWidth="1.5" />
      <path className="ft-glyph" d="M28 10.5 31.6 16V30H36.5V33.6H30.2V40.2A2.9 2.9 0 1 1 25.8 40.2V33.6H19.5V30H24.4V16Z" />
      <ellipse className="ft-shine" cx="21" cy="17" rx="10" ry="4.6" fill="#fff" opacity="0.3" transform="rotate(-28 21 17)" />
      <line className="ft-strike" x1="11" y1="45" x2="45" y2="11" />
    </svg>
  );
}

/** The Bonus action: three-cornered, a spark on orange enamel. */
function BonusArt() {
  const id = useId();
  return (
    <svg viewBox="0 0 56 56" aria-hidden>
      <defs>
        <radialGradient id={`${id}f`} cx="0.42" cy="0.4" r="0.8">
          <stop offset="0" stopColor="#ffe9c4" />
          <stop offset="0.4" stopColor="#f59a4e" />
          <stop offset="1" stopColor="#8a3a12" />
        </radialGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6e2a1" />
          <stop offset="0.45" stopColor="#c9a24a" />
          <stop offset="0.7" stopColor="#6f5222" />
          <stop offset="1" stopColor="#c9a24a" />
        </linearGradient>
      </defs>
      <path className="ft-rim" d="M28 4 53 49H3Z" fill={`url(#${id}r)`} stroke="#1c0d0e" strokeWidth="2" strokeLinejoin="round" />
      <path className="ft-face" d="M28 14.5 44.5 44H11.5Z" fill={`url(#${id}f)`} stroke="#1c0d0e" strokeWidth="1.5" strokeLinejoin="round" />
      <path className="ft-glyph" d="M28 23.5 30.1 31.4 37 33.5 30.1 35.6 28 42.5 25.9 35.6 19 33.5 25.9 31.4Z" />
      <path className="ft-shine" d="M28 17.5 33 26.5H23Z" fill="#fff" opacity="0.28" />
      <line className="ft-strike" x1="12" y1="50" x2="44" y2="14" />
    </svg>
  );
}

function Token({ kind, on, label, tip }: { kind: "action" | "bonus"; on: boolean; label: string; tip: string }) {
  return (
    <div className={`ft-token ${kind} ${on ? "on" : "spent"}`} role="img" aria-label={`${label}: ${on ? "available" : "spent"}`} tabIndex={0}>
      <span className="ft-token-art">{kind === "action" ? <ActionArt /> : <BonusArt />}</span>
      <span className="ft-token-label">{label}</span>
      <span className="ft-tip" role="tooltip">
        <b>{label} · {on ? "ready" : "spent"}</b>
        <span>{tip}</span>
      </span>
    </div>
  );
}

/** A run of chevrons: `now` lit of `max`, the last `cost` of the lit ones marked as about to go. */
function Track({ now, max, cost = 0 }: { now: number; max: number; cost?: number }) {
  const n = Math.max(max, now, 0);
  if (n > MAX_PIPS) return <div className="ft-track plain"><span style={{ width: `${n > 0 ? (100 * Math.max(0, now)) / n : 0}%` }} /></div>;
  return (
    <div className="ft-track">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={`${i < now ? "on" : "off"} ${i < now && i >= now - cost ? "cost" : ""}`} style={{ "--i": i } as CSSProperties} />
      ))}
    </div>
  );
}

export function TurnBar({ myTurn, actor, waitingFor, round, action, bonus, move, moveMax, moveCost, course, seconds, onEnd, extra }: TurnBarProps) {
  // How long this turn's clock was when it was first seen, for how much of the ring is left.
  const clock = useRef({ key: "", full: 0 });
  const key = `${myTurn}|${actor}|${waitingFor ?? ""}|${round}`;
  if (seconds !== null && (clock.current.key !== key || seconds > clock.current.full)) clock.current = { key, full: seconds };
  const left = seconds === null || clock.current.full <= 0 ? 1 : Math.max(0, Math.min(1, seconds / clock.current.full));
  const urgent = seconds !== null && seconds <= URGENT;

  const cost = myTurn && moveCost != null && moveCost > 0 ? moveCost : null;
  const over = cost !== null && cost > move;

  return (
    <div className={`fight-ui fight-turn ${myTurn ? "mine" : "waiting"} ${urgent ? "urgent" : ""}`} role="group" aria-label={myTurn ? `Your turn: ${actor}, round ${round}` : `Round ${round}: waiting for ${waitingFor ?? "the others"}`}>
      {extra && <div className="fight-turn-extra">{extra}</div>}
      <div className="fight-turn-bar">
        {/* Keyed by whose turn it is, so the pennant is run up afresh each time the turn comes round. */}
        <div className="ft-plate" key={key} aria-live="polite">
          {myTurn ? (
            <div className="ft-plate-in">
              <strong>Your turn</strong>
              <small><span>{actor}</span></small>
            </div>
          ) : (
            <div className="ft-plate-in">
              <small><span>Waiting for</span><em>Round {round}</em></small>
              <strong>{waitingFor ?? "the others"}<span className="ft-dots" aria-hidden><i /><i /><i /></span></strong>
            </div>
          )}
        </div>

        <div className="ft-res">
          <Token kind="action" on={action} label="Action" tip={action ? "One a turn: an attack, most abilities, a dash, a shove." : "Used for this turn. It comes back when your next turn starts."} />
          <Token kind="bonus" on={bonus} label="Bonus" tip={bonus ? "A Bonus action: one a turn, for the quick things marked with it." : "Used for this turn. It comes back when your next turn starts."} />
          <div className={`ft-move ${cost !== null ? "preview" : ""} ${over ? "over" : ""} ${move <= 0 ? "none" : ""} ${course ? "has-course" : ""}`} tabIndex={0} aria-label={`Movement: ${move} of ${moveMax} left${course ? `, and ${course.now} of ${course.max} toward the charted course` : ""}`}>
            <div className="ft-move-head">
              <span className="ft-move-label">Movement</span>
              {cost !== null && <span className="ft-move-cost" title={over ? `${cost - move} more than you have left` : `${move - cost} left after this move`}>−{cost}</span>}
              <span className="ft-move-num"><b key={move}>{move}</b><i>/ {moveMax}</i></span>
            </div>
            <Track now={move} max={moveMax} cost={cost === null ? 0 : Math.min(cost, move)} />
            {course && (
              <div className="ft-course">
                <span>Course</span>
                <Track now={course.now} max={course.max} />
                <b>{course.now} / {course.max}</b>
              </div>
            )}
            <span className="ft-tip" role="tooltip">
              <b>Movement · {move} of {moveMax} left</b>
              <span>Each hex costs one; rough ground costs more. Spend it in pieces, before and after you act.</span>
              {course && <span>Course: {course.now} of {course.max} more, good only for steps that bring you nearer the red X. It is spent first.</span>}
            </span>
          </div>
        </div>

        <button type="button" className="ft-end" disabled={!onEnd} onClick={onEnd} aria-label={onEnd ? `End turn${seconds !== null ? `, ${seconds} seconds left` : ""}` : "Not your turn"}>
          <span className="ft-ring">
            <svg viewBox="0 0 44 44" aria-hidden>
              <circle className="ft-ring-bed" cx="22" cy="22" r="18" />
              <circle className="ft-ring-now" cx="22" cy="22" r="18" strokeDasharray={RING} strokeDashoffset={RING * (1 - left)} />
            </svg>
            {seconds !== null ? <b key={seconds}>{seconds}</b> : (
              <svg className="ft-glass" viewBox="0 0 16 16" aria-hidden><path d="M3 1h10v2.2c0 1.9-1.3 3.2-3 4.8 1.7 1.6 3 2.9 3 4.8V15H3v-2.2c0-1.9 1.3-3.2 3-4.8-1.7-1.6-3-2.9-3-4.8zm2 1.6v.6c0 1.1.9 2.1 3 3.9 2.1-1.8 3-2.8 3-3.9v-.6zM8 10c-1.6 1.3-2.6 2.1-2.9 3.4h5.8C10.600 12.1 9.6 11.300 8 10z" /></svg>
            )}
          </span>
          <span className="ft-end-text">
            <strong>End Turn</strong>
            <small>{!onEnd ? "not your turn" : urgent ? "Hurry!" : `Round ${round}`}</small>
          </span>
        </button>
      </div>
    </div>
  );
}
