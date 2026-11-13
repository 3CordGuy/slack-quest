// The dice table. You sit at it in the pub, first person (render/TableStage.ts
// draws the table, the others round it and the dice), and this is what lies over
// the view: what is happening, and the moves open to you. The server runs the
// game; this only shows the view it was sent and asks for moves.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { DICE_ANTES, DICE_MAX_PLAYERS, DICE_MIN_PLAYERS, DICE_START, type DiceBid, type DiceRequest, type DiceView } from "@gantt-quest/world";
import type { SeatInfo } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import { placeSeats, seatInfo, useTableStage, type SeatLook, type StageHost } from "./useTableStage";
import "./table.css";

const PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const bidText = (b: DiceBid) => `${b.count} × ${PIPS[b.face]}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

interface Props {
  table: DiceView | null;
  you: string;
  gold: number;
  error: string | null;
  /** The last XP anyone in the pub earned: the winner's, just after a game. */
  lastXp?: { id: string; amount: number } | null;
  /** What each player in the pub looks like, by id. */
  looks?: Record<string, SeatLook>;
  world: RefObject<WorldRenderer | null>;
  /** The table's hex, who stands on it, and what to do once you have got up. */
  host: Omit<StageHost, "world">;
  send(action: DiceRequest): void;
}

export function DiceTable({ table, you, gold, error, lastXp, looks, world, host, send }: Props) {
  const last = table?.bids[table.bids.length - 1];
  const total = table?.seats.reduce((n, s) => n + s.count, 0) ?? 0;
  const [count, setCount] = useState(1);
  const [face, setFace] = useState(1);
  const [rules, setRules] = useState(false);
  // Each time the bid changes, offer the smallest raise.
  useEffect(() => {
    if (!last) return (setCount(1), setFace(1));
    if (last.face < 6) return (setCount(last.count), setFace(last.face + 1));
    setCount(Math.min(total, last.count + 1));
    setFace(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.count, last?.face, table?.round]);

  const name = (id: string) => (id === you ? "You" : (table?.seats.find((s) => s.id === id)?.name ?? "Someone"));
  const short = (id: string) => (id === you ? "You" : firstName(name(id)));
  const seated = !!table?.seats.some((s) => s.id === you);
  const mine = table?.seats.find((s) => s.id === you);
  const myTurn = table?.turn === you;
  const legal = !last || count > last.count || (count === last.count && face > last.face);
  const inGame = table?.phase === "playing" && !!mine && mine.count > 0;
  const showReveal = !!table?.reveal && (table.phase === "done" || table.bids.length === 0);

  const confirmStand = () => !inGame || confirm("Walk away? You forfeit your stake.");
  const { stage, standUp } = useTableStage("dice", { ...host, world }, () => undefined, confirmStand);

  // Everyone round the table, from your seat.
  const seats = table?.seats ?? [];
  const placement = useMemo(() => placeSeats(seats, you, !table || table.phase === "open", DICE_MAX_PLAYERS), [seats, you, table]);
  useEffect(() => {
    if (!stage) return;
    const infos = placement.placed.map((s): SeatInfo | undefined => {
      if (!s) return undefined;
      const out = !!table && table.phase !== "open" && s.count === 0;
      const won = table?.phase === "done" && table.winner === s.id;
      const turn = table?.phase === "playing" && table.turn === s.id;
      const chip = won ? "winner" : out ? (s.forfeited ? "left" : "out") : table?.phase === "open" && s.id === table.host ? "opened" : turn ? "to play" : null;
      return seatInfo(s, looks?.[s.id], { turn, out, won, chip, pips: table && table.phase !== "open" ? { on: s.count, of: DICE_START } : undefined });
    });
    stage.setSeats(placement.chairs, infos);
    stage.syncDice(
      table && table.phase !== "open"
        ? { round: table.round, seats: table.seats.map((s) => ({ id: s.id, count: s.count, dice: s.dice })), reveal: showReveal ? { hands: table.reveal!.hands, face: table.reveal!.bid.face } : null }
        : null,
    );
    stage.setPot(table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0);
    stage.setCard(
      !table || table.phase === "open" ? null
        : showReveal ? { caption: `${table.reveal!.actual} showed`, main: `${table.reveal!.actual} x`, die: table.reveal!.bid.face }
        : last ? { caption: `${short(last.by)} bid`, main: `${last.count} x`, die: last.face }
        : table.phase === "playing" ? { caption: `Round ${table.round}`, main: "no bid" } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks]);

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table and the others may sit.";
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < DICE_MIN_PLAYERS ? "Waiting for someone to sit." : "Start when everyone is seated.") : `Waiting for ${name(table.host)} to start.`) : `A table is open at ${table.ante} gold a seat.`;
    if (table.phase === "done") return table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} ${table.prize} gold from a pot of ${table.pot}.` : "The game is over.";
    if (showReveal) {
      const r = table.reveal!;
      return `${short(r.caller)} called ${r.bid.by === you ? "your" : `${short(r.bid.by)}'s`} ${bidText(r.bid)}: there ${r.actual === 1 ? "was" : "were"} ${r.actual}. ${name(r.loser)} lost a die.`;
    }
    if (myTurn) return last ? `Your turn: raise ${short(last.by)}'s ${bidText(last)}, or call it.` : "Your turn: open the bidding.";
    return mine && mine.count > 0 ? `Waiting for ${name(table.turn!)}.` : "You are watching.";
  })();

  return (
    <div className="table-dock panel dice-table">
      <div className="td-status" aria-live="polite">
        <span className={`td-phase ${table?.phase ?? "none"}`}>{!table ? "No game" : table.phase === "open" ? "Seating" : table.phase === "done" ? "Game over" : `Round ${table.round}`}</span>
        <span className="td-status-text">{status}</span>
        {table?.phase === "playing" && <span className="td-pot" title="The house keeps 10%">pot {table.pot} gold · {total} dice</span>}
      </div>
      {table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 && <p className="xp-gain">+{lastXp.amount} XP</p>}

      {(!table || table.phase === "done") && (
        <div className="td-row">
          <span>{table ? "Another game:" : "Open a table:"}</span>
          {DICE_ANTES.map((a) => (
            <button key={a} className="small" disabled={gold < a} title={gold < a ? "You cannot afford this ante" : `Open a table at ${a} gold a seat`} onClick={() => send({ type: "open", ante: a })}>
              {a} gold
            </button>
          ))}
          <span className="muted">You have {gold}.</span>
        </div>
      )}

      {table?.phase === "open" && (
        <div className="td-row">
          {!seated && (
            <button className="primary" disabled={gold < table.ante || seats.length >= DICE_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
              {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
            </button>
          )}
          {table.host === you && (
            <button className="primary" disabled={seats.length < DICE_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
              {seats.length < DICE_MIN_PLAYERS ? "Waiting for a second player" : "Start the game"}
            </button>
          )}
          {seated && <button className="small" onClick={() => send({ type: "leave" })}>Give up the seat</button>}
          {seated && <span className="muted">The ante is taken when the game starts.</span>}
        </div>
      )}

      {table?.phase === "playing" && myTurn && (
        <div className="td-row">
          <span className="td-label">{last ? "Raise to" : "Bid"}</span>
          <select aria-label="How many dice" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: total }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
          <span>×</span>
          <select aria-label="Which face" value={face} onChange={(e) => setFace(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((f) => <option key={f} value={f}>{PIPS[f]} {f}</option>)}
          </select>
          <button className="primary" disabled={!legal} title={legal ? undefined : "More dice, or the same number of a higher face"} onClick={() => send({ type: "bid", count, face })}>
            {last ? "Raise" : "Bid"}
          </button>
          <button disabled={!last} onClick={() => send({ type: "call" })}>Call</button>
        </div>
      )}

      {error && <p className="bad">{error}</p>}
      {table && table.log.length > 0 && <p className="td-log muted">{table.log[table.log.length - 1]}</p>}

      <div className="td-foot">
        <button type="button" className="link" aria-expanded={rules} onClick={() => setRules((r) => !r)}>{rules ? "Hide the rules" : "How to play"}</button>
        <span className="spacer" />
        <button type="button" className={inGame ? "small danger" : "small"} onClick={() => confirmStand() && standUp()}>{inGame ? "Forfeit and stand" : "Stand up"}</button>
      </div>
      {rules && (
        <ol className="td-rules muted">
          <li>Everyone antes the same stake and rolls {DICE_START} hidden dice. You see yours; the others are under their hands.</li>
          <li>On your turn, raise the bid (how many dice of one face are on the whole table) or call the last bid.</li>
          <li>A call shows every die and whoever was wrong loses one. Last with dice takes the pot; the house keeps 10%.</li>
        </ol>
      )}
    </div>
  );
}
