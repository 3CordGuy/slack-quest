// The dice table's panel: open a table, sit, start, bid and call. The server
// runs the game; this only shows the view it was sent and asks for moves.

import { useEffect, useState } from "react";
import { DICE_ANTES, DICE_MAX_PLAYERS, DICE_MIN_PLAYERS, DICE_START, type DiceBid, type DiceRequest, type DiceView } from "@gantt-quest/world";
import { DragPanel } from "./DragPanel";
import "./dice.css";

const PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const Dice = ({ faces }: { faces: number[] }) => <span className="dice-faces">{faces.map((f, i) => <i key={i} title={String(f)}>{PIPS[f]}</i>)}</span>;
const Hidden = ({ count }: { count: number }) => <span className="dice-faces hidden">{Array.from({ length: count }, (_, i) => <i key={i}>▢</i>)}</span>;
const bidText = (b: DiceBid) => `${b.count} × ${PIPS[b.face]}`;

interface Props {
  table: DiceView | null;
  you: string;
  gold: number;
  error: string | null;
  send(action: DiceRequest): void;
}

export function DiceTable({ table, you, gold, error, send }: Props) {
  const last = table?.bids[table.bids.length - 1];
  const total = table?.seats.reduce((n, s) => n + s.count, 0) ?? 0;
  const [count, setCount] = useState(1);
  const [face, setFace] = useState(1);
  // Each time the bid changes, offer the smallest raise.
  useEffect(() => {
    if (!last) return (setCount(1), setFace(1));
    if (last.face < 6) return (setCount(last.count), setFace(last.face + 1));
    setCount(Math.min(total, last.count + 1));
    setFace(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.count, last?.face, table?.round]);

  const name = (id: string) => (id === you ? "You" : (table?.seats.find((s) => s.id === id)?.name ?? "Someone"));
  const seated = !!table?.seats.some((s) => s.id === you);
  const mine = table?.seats.find((s) => s.id === you);
  const myTurn = table?.turn === you;
  const legal = !last || count > last.count || (count === last.count && face > last.face);

  return (
    <DragPanel id="harbor.dice" title="Dice table" className="panel dice-table">
      <ol className="dice-rules muted">
        <li>Everyone antes the same stake and rolls {DICE_START} hidden dice.</li>
        <li>On your turn, raise the bid (how many dice of one face are on the whole table) or call the last bid.</li>
        <li>A call shows every die and whoever was wrong loses one. Last with dice takes the pot; the house keeps 10%.</li>
      </ol>

      {(!table || table.phase === "done") && (
        <>
          {table?.phase === "done" && table.winner && (
            <p className="dice-result">
              <strong>{name(table.winner)}</strong> won {table.prize} gold from a pot of {table.pot}.
            </p>
          )}
          {table?.reveal && <Reveal table={table} you={you} name={name} />}
          <div className="row">
            <span>Open a table:</span>
            {DICE_ANTES.map((a) => (
              <button key={a} className="small" disabled={gold < a} title={gold < a ? "You cannot afford this ante" : undefined} onClick={() => send({ type: "open", ante: a })}>
                {a} gold
              </button>
            ))}
            <span className="muted">You have {gold}.</span>
          </div>
        </>
      )}

      {table?.phase === "open" && (
        <>
          <p>
            Ante <strong>{table.ante} gold</strong> a seat · {table.seats.length}/{DICE_MAX_PLAYERS} seated
          </p>
          <ul className="dice-seats">
            {table.seats.map((s) => (
              <li key={s.id}>
                <strong>{name(s.id)}</strong>
                {s.id === table.host && <span className="tag">opened</span>}
              </li>
            ))}
          </ul>
          <div className="row">
            {!seated && (
              <button className="primary" disabled={gold < table.ante || table.seats.length >= DICE_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
                {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
              </button>
            )}
            {table.host === you && (
              <button className="primary" disabled={table.seats.length < DICE_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
                {table.seats.length < DICE_MIN_PLAYERS ? "Waiting for a second player" : "Start the game"}
              </button>
            )}
            {seated && <button className="small" onClick={() => send({ type: "leave" })}>Get up</button>}
            {seated && table.host !== you && <span className="muted">Waiting for {name(table.host)} to start. The ante is taken then.</span>}
          </div>
        </>
      )}

      {table?.phase === "playing" && (
        <>
          <p>
            Pot <strong>{table.pot} gold</strong> · round {table.round} · {total} dice on the table
          </p>
          <ul className="dice-seats">
            {table.seats.map((s) => (
              <li key={s.id} className={`${s.id === table.turn ? "turn" : ""} ${s.count === 0 ? "out" : ""}`}>
                <span>
                  <strong>{name(s.id)}</strong>
                  {s.id === table.turn && <span className="tag">to play</span>}
                </span>
                {s.count === 0 ? <span className="muted">{s.forfeited ? "forfeited" : "out"}</span> : s.dice ? <Dice faces={s.dice} /> : <Hidden count={s.count} />}
              </li>
            ))}
          </ul>
          {table.reveal && table.bids.length === 0 && <Reveal table={table} you={you} name={name} />}
          <p className="dice-bid">
            {last ? (
              <>
                {name(last.by)} bid <strong>{bidText(last)}</strong>
                <span className="muted"> · at least {last.count} showing {last.face}</span>
              </>
            ) : (
              <span className="muted">No bid yet this round.</span>
            )}
          </p>
          {myTurn ? (
            <div className="row">
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
          ) : (
            <p className="muted">{mine && mine.count > 0 ? `Waiting for ${name(table.turn!)}.` : "You are watching."}</p>
          )}
          {mine && mine.count > 0 && (
            <div className="row">
              <button className="small" onClick={() => send({ type: "leave" })}>Forfeit and get up</button>
              <span className="muted">Walking away from the table forfeits too.</span>
            </div>
          )}
        </>
      )}

      {table && table.log.length > 0 && (
        <ul className="dice-log muted">
          {table.log.slice(-4).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      {error && <p className="bad">{error}</p>}
    </DragPanel>
  );
}

function Reveal({ table, you, name }: { table: DiceView; you: string; name(id: string): string }) {
  const r = table.reveal!;
  return (
    <div className="dice-reveal">
      <div>
        {name(r.caller)} called {r.bid.by === you ? "your" : `${name(r.bid.by)}'s`} <strong>{bidText(r.bid)}</strong>: there {r.actual === 1 ? "was" : "were"} {r.actual}. <strong>{name(r.loser)}</strong> lost a die.
      </div>
      {r.hands.map((h) => (
        <div key={h.id} className="dice-hand">
          <span>{name(h.id)}</span>
          <Dice faces={h.dice} />
        </div>
      ))}
    </div>
  );
}
