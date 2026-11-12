// The Shoals table's panel: open a table, sit, lay markers, bid, pass and
// sail. The server runs the game; this only shows the view it was sent and
// asks for moves.

import { useEffect, useState } from "react";
import { SHOALS_ANTES, SHOALS_MAX_PLAYERS, SHOALS_MIN_PLAYERS, SHOALS_PASSAGES, type Marker, type ShoalsRequest, type ShoalsView } from "@gantt-quest/world";
import { DragPanel } from "./DragPanel";
import "./dice.css";
import "./shoals.css";

const NAME: Record<Marker, string> = { channel: "Channel", shoal: "Shoal" };
/** A marker, face up. */
const Face = ({ marker, small }: { marker: Marker; small?: boolean }) => <i className={`marker ${marker} ${small ? "small" : ""}`} title={NAME[marker]} />;
/** A marker, face down. */
const Back = ({ small }: { small?: boolean }) => <i className={`marker back ${small ? "small" : ""}`} title="Face down" />;

interface Props {
  table: ShoalsView | null;
  you: string;
  gold: number;
  error: string | null;
  /** The last XP anyone in the pub earned: the winner's, just after a game. */
  lastXp?: { id: string; amount: number } | null;
  send(action: ShoalsRequest): void;
}

export function ShoalsTable({ table, you, gold, error, lastXp, send }: Props) {
  const [count, setCount] = useState(1);
  // Each time the bid or the table changes, offer the smallest legal bid.
  useEffect(() => {
    setCount(Math.min(table?.total ?? 1, (table?.bid?.count ?? 0) + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.bid?.count, table?.round, table?.total]);

  const name = (id: string) => (id === you ? "You" : (table?.seats.find((s) => s.id === id)?.name ?? "Someone"));
  const seated = !!table?.seats.some((s) => s.id === you);
  const mine = table?.seats.find((s) => s.id === you);
  const myTurn = table?.turn === you;
  const everyoneLaid = !!table && table.seats.every((s) => s.count === 0 || s.laid > 0);
  const ownLeft = mine ? mine.laid - mine.shown.length : 0;
  const last = table?.last;

  return (
    <DragPanel id="pub.shoals" title="Shoals" className="panel dice-table shoals-table">
      <ol className="dice-rules muted">
        <li>Each pilot holds three <strong>Channels</strong> and one <strong>Shoal</strong>. In turn, lay one face down on your own stack.</li>
        <li>Once everyone has laid, bid how many markers you can turn over without striking a Shoal. The others raise or pass.</li>
        <li>The high bidder sails: their own stack first, then anyone's. A clear run is a passage; {SHOALS_PASSAGES} win. Strike a Shoal and you lose a marker for good. The house keeps 10%.</li>
      </ol>

      {(!table || table.phase === "done") && (
        <>
          {table?.phase === "done" && table.winner && (
            <p className="dice-result">
              <strong>{name(table.winner)}</strong> won {table.prize} gold from a pot of {table.pot}.
              {lastXp?.id === table.winner && lastXp.amount > 0 && <> <span className="xp-gain">+{lastXp.amount} XP</span></>}
            </p>
          )}
          <div className="row">
            <span>Open a table:</span>
            {SHOALS_ANTES.map((a) => (
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
            Ante <strong>{table.ante} gold</strong> a seat · {table.seats.length}/{SHOALS_MAX_PLAYERS} seated
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
              <button className="primary" disabled={gold < table.ante || table.seats.length >= SHOALS_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
                {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
              </button>
            )}
            {table.host === you && (
              <button className="primary" disabled={table.seats.length < SHOALS_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
                {table.seats.length < SHOALS_MIN_PLAYERS ? "Waiting for a second pilot" : "Start the game"}
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
            Pot <strong>{table.pot} gold</strong> · round {table.round} · {table.total} marker{table.total === 1 ? "" : "s"} down
            {table.bid && <> · <strong>{name(table.bid.by)}</strong> bid {table.bid.count}{table.step === "sail" && ` (${table.sailed} sailed)`}</>}
          </p>
          {last && (
            <p className="muted">
              Last round: {name(last.pilot)} bid {last.bid} and {last.result === "clear" ? "sailed clear" : last.result === "aground" ? `ran aground on ${last.at === last.pilot ? "their own Shoal" : `${name(last.at ?? "")}'s Shoal`.replace("You's", "your")}` : "the round was called off"}.
            </p>
          )}
          <ul className="dice-seats">
            {table.seats.map((s) => {
              const down = s.laid - s.shown.length;
              // The helm may turn this stack: their own while any of it is face down, anyone's after that.
              const canFlip = myTurn && table.step === "sail" && down > 0 && (s.id === you || ownLeft === 0);
              return (
                <li key={s.id} className={`${s.id === table.turn ? "turn" : ""} ${s.count === 0 ? "out" : ""}`}>
                  <span>
                    <strong>{name(s.id)}</strong>
                    {s.id === table.turn && <span className="tag">{table.step === "sail" ? "at the helm" : "to play"}</span>}
                    {s.passed && <span className="tag">passed</span>}
                    {s.count === 0 && <span className="tag">{s.forfeited ? "left" : "out"}</span>}
                    <span className="muted"> · {s.count} marker{s.count === 1 ? "" : "s"} · {"★".repeat(s.passages)}{"☆".repeat(Math.max(0, SHOALS_PASSAGES - s.passages))}</span>
                  </span>
                  <span className="stack">
                    {s.shown.map((m, i) => <Face key={`s${i}`} marker={m} small />)}
                    {Array.from({ length: down }, (_, i) => <Back key={`d${i}`} small />)}
                    {canFlip && <button className="small primary" onClick={() => send({ type: "flip", seat: s.id })}>Turn one</button>}
                  </span>
                </li>
              );
            })}
          </ul>

          {mine && mine.count > 0 && table.you && (
            <div className="shoals-hand">
              <span className="muted">In your hand:</span>
              {(["channel", "shoal"] as Marker[]).map((m) => (
                <button key={m} className="lay" disabled={!myTurn || table.step !== "lay" || table.you!.hand[m] === 0} title={`Lay a ${NAME[m]} face down`} onClick={() => send({ type: "lay", marker: m })}>
                  <Face marker={m} /> {NAME[m]} × {table.you!.hand[m]}
                </button>
              ))}
              {table.you.stack.length > 0 && (
                <span className="muted" title="Your own stack, bottom first. Only you can see this.">
                  Your stack: {table.you.stack.map((m, i) => <Face key={i} marker={m} small />)}
                </span>
              )}
            </div>
          )}

          {myTurn && table.step !== "sail" && (
            <div className="row">
              {table.step === "lay" && !everyoneLaid ? (
                <span className="muted">Lay a marker. Bidding opens once everyone has one down.</span>
              ) : (
                <>
                  <span>I can sail</span>
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                    {Array.from({ length: Math.max(0, table.total - (table.bid?.count ?? 0)) }, (_, i) => (table.bid?.count ?? 0) + 1 + i).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button className="primary" disabled={count <= (table.bid?.count ?? 0) || count > table.total} onClick={() => send({ type: "bid", count })}>Bid</button>
                  {table.step === "bid" && <button onClick={() => send({ type: "pass" })}>Pass</button>}
                  {table.step === "lay" && <span className="muted">or lay another marker</span>}
                </>
              )}
            </div>
          )}
          {myTurn && table.step === "sail" && (
            <p className="dice-result">You are at the helm: turn over {table.bid!.count - table.sailed} more. {ownLeft > 0 ? "Your own stack comes first." : "Pick any stack."}</p>
          )}
          {!myTurn && table.turn && <p className="muted">Waiting for {name(table.turn)}.</p>}
          {seated && mine && mine.count > 0 && <div className="row"><button className="small danger" onClick={() => confirm("Walk away? You forfeit your stake.") && send({ type: "leave" })}>Forfeit</button></div>}
        </>
      )}

      {error && <p className="bad">{error}</p>}
      {table && table.log.length > 0 && (
        <ul className="dice-log muted">
          {table.log.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
    </DragPanel>
  );
}
