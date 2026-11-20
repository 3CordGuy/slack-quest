// The turn bar: what a turn has to spend, on one board directly over the
// bottom rack while a fight is on. Everything in a fight is paid for in
// Action Points, so they are what the board is about.
//
//   [ YOUR TURN  ]   4/6   (o)(o)(o)(o) :(o)(o)             [ (42) End Turn ]
//   [ Mira       >   AP    boot 3 steps left >>>  +2 per AP  11 in reach    [  Round 2 ]
//
// From the left: a pennant saying whose turn it is; the Action Points, as a
// number and a row of brass sockets, each holding a lit orb while its point
// is there to spend and standing dark once it is spent; under them, what
// those points mean for walking; and End Turn, with the turn's clock in a ring.
//
// A fresh turn gives `apTurn` points, and what was not spent last turn is kept
// on top of them, up to `apMax`. The sockets past `apTurn` are the ones only
// saved points can fill: they are bound in rope, and their orbs are gold.
//
// Movement is bought with the same points, a stride at a time: the line under
// the sockets says how many steps are bought and not yet walked, how many one
// more point buys, and how far all of it would carry you.
//
// When the turn is yours the board is rimmed in gold and the pennant is gold
// parchment reading "Your turn". When it is not, the pennant is a dull board
// reading "Waiting for <name>", the sockets are greyed and End Turn is dead.
//
// Spending is shown as it happens: an orb flares and goes out, and a ring of
// its colour blows off the socket. `apCost` (what the thing aimed, or the walk
// under the pointer, would take) sets the orbs it would spend blinking, in red
// when it is more than is left; `moveCost` does the same for the steps bought.
// Nothing here knows the rules: it draws what it is handed.

import { useRef, type CSSProperties, type ReactNode } from "react";
import "./fight.css";

export interface TurnBarProps {
  /** Whether the turn is this player's to take. */
  myTurn: boolean;
  /** The hero this bar is for (the one being played). */
  actor: string;
  /** Who everyone is waiting on, when it is not `myTurn`. */
  waitingFor?: string;
  round: number;
  /** Action Points left, the most that can be held, and how many a fresh turn gives. */
  ap: number;
  apMax: number;
  apTurn: number;
  /** AP the thing being aimed or hovered would take (an ability picked, or the walk under the pointer): those points pulse; more than `ap` shows in the warning colour. */
  apCost?: number | null;
  /** Steps of movement already bought and not yet walked, and how many steps 1 AP buys (0: cannot move this turn). */
  move: number;
  stride: number;
  /** Steps the walk under the pointer would take. */
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

/** More chevrons than this and a run of steps is drawn as one bar. */
const MAX_PIPS = 12;
const URGENT = 15;
const RING = 2 * Math.PI * 18;

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

const steps = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

export function TurnBar({ myTurn, actor, waitingFor, round, ap, apMax, apTurn, apCost, move, stride, moveCost, course, seconds, onEnd, extra }: TurnBarProps) {
  // How long this turn's clock was when it was first seen, for how much of the ring is left.
  const clock = useRef({ key: "", full: 0 });
  const key = `${myTurn}|${actor}|${waitingFor ?? ""}|${round}`;
  if (seconds !== null && (clock.current.key !== key || seconds > clock.current.full)) clock.current = { key, full: seconds };
  const left = seconds === null || clock.current.full <= 0 ? 1 : Math.max(0, Math.min(1, seconds / clock.current.full));
  const urgent = seconds !== null && seconds <= URGENT;

  const sockets = Math.max(apMax, ap, 0);
  const cost = myTurn && apCost != null && apCost > 0 ? apCost : null;
  const over = cost !== null && cost > ap;
  /** How far everything left would carry them: what is bought, and what every point still held would buy. */
  const reach = move + Math.max(0, ap) * stride;
  const walk = myTurn && moveCost != null && moveCost > 0 ? moveCost : null;
  const far = walk !== null && walk > reach;
  const stuck = stride <= 0 && move <= 0;
  /** What ending the turn now would carry into the next: a fresh turn's points fill up to `apMax` and no further. */
  const kept = Math.max(0, Math.min(ap, apMax - apTurn));

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
          {/* The points: the number, and a socket for each that can be held. */}
          <div className={`ft-ap ${cost !== null ? "preview" : ""} ${over ? "over" : ""} ${ap <= 0 ? "none" : ""}`} tabIndex={0} role="img" aria-label={`Action Points: ${ap} of ${apMax}${cost !== null ? `; this would take ${cost}` : ""}`}>
            <div className="ft-ap-num">
              <span><b key={ap}>{ap}</b><i>/{apMax}</i></span>
              {cost !== null ? <em className="ft-ap-cost" title={over ? `${cost - ap} more than you have` : `${ap - cost} left after`}>−{cost}</em> : <small>AP</small>}
            </div>
            <div className="ft-sockets">
              {Array.from({ length: sockets }, (_, i) => (
                <i
                  key={i}
                  className={`${i < ap ? "on" : "off"} ${i >= apTurn ? "bank" : ""} ${i === apTurn ? "first-bank" : ""} ${cost !== null && i < ap && i >= ap - cost ? "cost" : ""}`}
                  style={{ "--i": i } as CSSProperties}
                />
              ))}
            </div>
            <span className="ft-tip" role="tooltip">
              <b>Action Points · {ap} of {apMax}</b>
              <span>Everything is paid for in them: abilities, items, and every stride you walk.</span>
              <span>You get {apTurn} at the start of each turn. What you do not spend is kept for the next, up to {apMax}: the roped sockets hold only points saved that way.</span>
            </span>
          </div>

          {/* What the points mean for walking. */}
          <div className={`ft-walk ${walk !== null ? "preview" : ""} ${far ? "over" : ""} ${stuck ? "stuck" : ""} ${course ? "has-course" : ""}`} tabIndex={0} aria-label={stuck ? "Cannot move this turn" : `Movement: ${steps(move)} bought and left; 1 AP buys ${steps(stride)}; ${steps(reach)} in reach${course ? `; ${course.now} of ${course.max} toward the charted course` : ""}`}>
            <svg className="ft-boot" viewBox="0 0 16 16" aria-hidden><path d="M5 1h5v7.2l3.6 1.5c.9.4 1.4 1.2 1.4 2.1V13H2v-2.3c0-.6.3-1.1.8-1.5L5 7.6z" /><path d="M2 14h13v2H2z" opacity="0.7" /></svg>
            {stuck ? (
              <span className="ft-walk-none">Cannot move this turn</span>
            ) : (
              <>
                <span className="ft-walk-left"><b key={move}>{move}</b> {move === 1 ? "step" : "steps"}<span className="ft-long"> left</span></span>
                {walk !== null && <em className="ft-walk-cost" title={far ? `${walk - reach} further than you can go` : `${reach - walk} in reach after`}>−{walk}</em>}
                <Track now={move} max={Math.max(move, stride)} cost={walk === null ? 0 : Math.min(walk, move)} />
                <span className="ft-walk-rate">{stride > 0 ? <>+{stride}<span className="ft-long"> per</span><span className="ft-short">/</span> AP</> : "no more"}</span>
                <span className="ft-walk-reach"><b>{reach}</b><span className="ft-long"> in</span> reach</span>
                {course && (
                  <span className="ft-course">
                    <span className="ft-course-x" title="Charted course: steps toward the red X">✕</span>
                    <Track now={course.now} max={course.max} />
                    <b>{course.now}</b>
                  </span>
                )}
              </>
            )}
            <span className="ft-tip" role="tooltip">
              <b>Movement · {stuck ? "none this turn" : `${steps(reach)} in reach`}</b>
              {stuck
                ? <span>You cannot move this turn.</span>
                : <span>{steps(move)} bought and not yet walked: they go first, and are lost when the turn ends.{stride > 0 ? ` Each Action Point buys ${steps(stride)} more.` : " Nothing buys more this turn."} Rough ground costs more than one.</span>}
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
            <small>{!onEnd ? "not your turn" : urgent ? "Hurry!" : kept > 0 ? (kept < ap ? `saves ${kept} of ${ap} AP` : `saves ${kept} AP`) : `Round ${round}`}</small>
          </span>
        </button>
      </div>
    </div>
  );
}
