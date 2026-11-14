// The Shoals table. You sit at it in the pub, first person (render/TableStage.ts
// draws the table, the pilots round it, each one's stack of markers and the
// pot), and this is what lies over the view: what is happening, the bid, and
// the way to get up. Markers are laid and stacks turned by clicking them in the
// scene. The server runs the game; this only shows the view it was sent and
// asks for moves.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SHOALS_ANTES, SHOALS_MAX_PLAYERS, SHOALS_MIN_PLAYERS, SHOALS_PASSAGES, SHOALS_START, type Marker, type ShoalsRequest, type ShoalsView } from "@gantt-quest/world";
import type { SeatInfo } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import { markerUrl, type MarkerFace } from "./shoalsArt";
import { placeSeats, withSelf, seatInfo, useTableStage, type SeatLook, type StageHost } from "./useTableStage";
import "./table.css";
import "./shoals.css";

export type { SeatLook } from "./useTableStage";

const NAME: Record<Marker, string> = { channel: "Channel", shoal: "Shoal" };
const START = SHOALS_START.channel + SHOALS_START.shoal;

interface Props {
  table: ShoalsView | null;
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
  send(action: ShoalsRequest): void;
}

/** A marker as a pixel disc, in the rules. */
function Disc({ face, size = 18 }: { face: MarkerFace; size?: number }) {
  return <img className="sh-disc pixel-icon" src={markerUrl(face)} width={size} height={size} alt="" title={face === "back" ? "Face down" : NAME[face]} draggable={false} />;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Where a sail that just ended left every stack: what was turned over, the marker that ended it, and what stayed face down. */
interface Reveal {
  round: number;
  stacks: Record<string, { shown: Marker[]; down: number; struck: boolean }>;
}

export function ShoalsTable({ table, you, gold, error, lastXp, looks, world, host, send }: Props) {
  const [count, setCount] = useState(1);
  const [rules, setRules] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const prev = useRef<ShoalsView | null>(null);
  /** The stack you last turned a marker from, so a sail of yours that ends the round can show where. */
  const myFlip = useRef<string | null>(null);

  // Each time the bid or the table changes, offer the smallest legal bid.
  useEffect(() => {
    setCount(Math.min(table?.total ?? 1, (table?.bid?.count ?? 0) + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.bid?.count, table?.round, table?.total]);

  // A sail's last turn ends the round, and the stacks are taken back at once. Keep the
  // table as it was a moment before, plus the marker that ended it, to leave on the
  // felt until each pilot lays again.
  useEffect(() => {
    const before = prev.current;
    prev.current = table;
    if (!table || !before || before.phase !== "playing" || table.phase !== "playing" || table.round === before.round) return;
    const last = table.last;
    if (!last || last.result === "void") return setReveal(null);
    const stacks: Reveal["stacks"] = {};
    for (const s of before.seats) stacks[s.id] = { shown: [...s.shown], down: s.laid - s.shown.length, struck: false };
    // Where the last marker came from: the struck Shoal's stack; for a clear run, the
    // pilot's own while any of it was face down, or else the only stack left to turn.
    // Otherwise nobody can say which, and it is left out.
    const open = Object.keys(stacks).filter((id) => stacks[id].down > 0);
    const from = last.result === "aground" ? last.at
      : (stacks[last.pilot]?.down ?? 0) > 0 ? last.pilot
      : last.pilot === you && myFlip.current && stacks[myFlip.current] ? myFlip.current
      : open.length === 1 ? open[0]
      : undefined;
    if (from && stacks[from]) {
      stacks[from].shown.push(last.result === "aground" ? "shoal" : "channel");
      stacks[from].down -= 1;
      stacks[from].struck = last.result === "aground";
    }
    setReveal({ round: table.round, stacks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const seat = (id: string) => table?.seats.find((s) => s.id === id);
  const name = (id: string) => (id === you ? "You" : (seat(id)?.name ?? "Someone"));
  const short = (id: string) => (id === you ? "You" : firstName(seat(id)?.name ?? "Someone"));
  const shorts = (id: string) => (id === you ? "your" : `${short(id)}'s`);
  const seated = !!seat(you);
  const mine = seat(you);
  const playing = table?.phase === "playing";
  const myTurn = playing && table?.turn === you;
  const everyoneLaid = !!table && table.seats.every((s) => s.count === 0 || s.laid > 0);
  const ownLeft = mine ? mine.laid - mine.shown.length : 0;
  const last = table?.last;
  const shownReveal = playing && reveal && reveal.round === table!.round && table!.step === "lay" ? reveal : null;
  const inGame = playing && !!mine && mine.count > 0;
  const seats = table?.seats ?? [];

  const confirmStand = () => !inGame || confirm("Walk away? You forfeit your stake.");
  const { stage, standUp } = useTableStage("shoals", { ...host, world }, (a) => {
    if (a.type === "lay") send({ type: "lay", marker: a.marker });
    else {
      myFlip.current = a.seat;
      send({ type: "flip", seat: a.seat });
    }
  }, confirmStand);

  const potGold = table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0;
  const placement = useMemo(() => placeSeats(seats, you, !table || table.phase === "open", SHOALS_MAX_PLAYERS), [seats, you, table]);

  // Everyone round the table from your seat, and what is on it.
  useEffect(() => {
    if (!stage) return;
    const infos = placement.placed.map((s): SeatInfo | undefined => {
      if (!s) return undefined;
      const out = !!table && table.phase !== "open" && s.count === 0;
      const won = table?.phase === "done" && table.winner === s.id;
      const turn = !!table && table.phase === "playing" && table.turn === s.id;
      const bidder = !!table && table.phase === "playing" && table.bid?.by === s.id;
      const chip = won ? "winner"
        : out ? (s.forfeited ? "left" : "out")
        : table?.phase === "open" && s.id === table.host ? "opened"
        : turn && table?.step === "sail" ? "helm"
        : bidder ? `says ${table!.bid!.count}`
        : s.passed ? "passed"
        : turn ? "to play"
        : null;
      return seatInfo(s, looks?.[s.id], {
        turn, out, won, chip,
        pips: table && table.phase !== "open" ? { on: s.count, of: START } : undefined,
        stars: table && table.phase !== "open" ? { on: s.passages, of: SHOALS_PASSAGES } : undefined,
      });
    });
    stage.setSeats(placement.chairs, withSelf(infos, you, looks));
    if (!table || table.phase === "open") {
      stage.syncShoals(null);
    } else {
      const myHand = table.you?.stack ?? [];
      stage.syncShoals({
        hand: inGame ? table.you!.hand : null,
        canLay: !!myTurn && table.step === "lay",
        seats: table.seats.map((s) => {
          const ghost = shownReveal && s.laid === 0 ? shownReveal.stacks[s.id] : undefined;
          const down = ghost ? ghost.down : s.laid - s.shown.length;
          return {
            id: s.id,
            down,
            shown: ghost ? ghost.shown : s.shown,
            // Your face-down markers, top first, so you can see what you laid.
            peeks: !ghost && s.id === you ? myHand.slice(0, down).reverse() : [],
            struck: !!ghost?.struck || (table.phase === "done" && table.last?.result === "aground" && table.last.at === s.id),
            ghost: !!ghost,
            canFlip: !!myTurn && table.step === "sail" && s.laid - s.shown.length > 0 && (s.id === you || ownLeft === 0),
          };
        }),
      });
    }
    stage.setPot(potGold);
    stage.setCard(
      !table || table.phase === "open" ? null
        : table.phase === "done" ? { caption: "Pot paid out", main: `${table.prize} gold` }
        : table.step === "sail" && table.bid ? { caption: `${short(table.bid.by)} sails ${table.bid.count}`, main: `${table.sailed} / ${table.bid.count}` }
        : table.bid ? { caption: "Bid", main: `${table.bid.count}` }
        : { caption: `Round ${table.round}`, main: `${table.total} laid` },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks, reveal]);

  const outcome = last && (last.result === "clear"
    ? `${name(last.pilot)} sailed ${last.bid} clear.`
    : last.result === "aground"
      ? `${name(last.pilot)} ran aground on ${last.at === last.pilot ? (last.pilot === you ? "your own" : "their own") : last.at === you ? "your" : `${name(last.at ?? "")}'s`} Shoal.`
      : "The round was called off.");

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table to set out the markers.";
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < SHOALS_MIN_PLAYERS ? "Waiting for a second pilot to sit." : "Start when everyone is seated.") : `Waiting for ${name(table.host)} to start.`) : `A table is open at ${table.ante} gold a seat.`;
    if (table.phase === "done") return table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} the table! ${table.winner === you ? "You take" : "They take"} ${table.prize} gold from a pot of ${table.pot}.` : "The game is over.";
    const who = table.turn ? short(table.turn) : "";
    const bid = table.bid;
    if (table.step === "lay") {
      if (!myTurn) return `${who} is laying a marker.`;
      return everyoneLaid ? "Your turn: click a marker in your hand to lay another, or open the bidding." : "Your turn: click a marker in your hand to lay it face down.";
    }
    if (table.step === "bid" && bid) return myTurn ? `${short(bid.by)} ${bid.by === you ? "say" : "says"} ${bid.count}. Raise or pass.` : `${who} to raise ${shorts(bid.by)} ${bid.count}, or pass.`;
    if (table.step === "sail" && bid) {
      const left = bid.count - table.sailed;
      return myTurn ? `At the helm: click a stack to turn over ${left} more. ${ownLeft > 0 ? "Your own stack first." : "Pick any stack."}` : `${who} ${table.turn === you ? "are" : "is"} at the helm: ${table.sailed} of ${bid.count} clear.`;
    }
    return "";
  })();

  const phaseLabel = !table ? "No game" : table.phase === "open" ? "Seating" : table.phase === "done" ? "Game over" : table.step === "lay" ? "Laying" : table.step === "bid" ? "Bidding" : "Sailing";

  return (
    <div className="table-dock panel shoals-table">
      <div className="td-status" aria-live="polite">
        <span className={`td-phase ${table?.phase ?? "none"} ${table?.step ?? ""}`}>{phaseLabel}</span>
        <span className="td-status-text">{status}</span>
        {inGame && <span className="td-pot" title="Your markers left, and passages sailed">markers {mine!.count}/{START} · passages {mine!.passages}/{SHOALS_PASSAGES}</span>}
        {table && table.phase !== "open" && <span className="td-pot" title="The house keeps 10%">pot {potGold} gold</span>}
      </div>
      {playing && last && table!.step === "lay" && <p className={`sh-outcome ${last.result}`}>Last round: {outcome}</p>}
      {table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 && <p className="xp-gain">+{lastXp.amount} XP</p>}

      {myTurn && table!.step !== "sail" && (everyoneLaid || table!.step === "bid") && (
        <div className="td-row sh-bid">
          <span className="td-label">I can sail</span>
          <div className="sh-stepper">
            <button type="button" className="small" aria-label="One fewer" disabled={count <= (table!.bid?.count ?? 0) + 1} onClick={() => setCount((n) => n - 1)}>−</button>
            <output aria-label="Markers to sail">{count}</output>
            <button type="button" className="small" aria-label="One more" disabled={count >= table!.total} onClick={() => setCount((n) => n + 1)}>+</button>
          </div>
          <button className="primary" disabled={count <= (table!.bid?.count ?? 0) || count > table!.total} onClick={() => send({ type: "bid", count })}>Bid</button>
          {table!.step === "bid" && <button onClick={() => send({ type: "pass" })}>Pass</button>}
        </div>
      )}

      {/* Before and after a game: the stakes and the seats. */}
      {(!table || table.phase === "done") && (
        <div className="td-row">
          <span>{table ? "Another game:" : "Open a table:"}</span>
          {SHOALS_ANTES.map((a) => (
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
            <button className="primary" disabled={gold < table.ante || seats.length >= SHOALS_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
              {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
            </button>
          )}
          {table.host === you && (
            <button className="primary" disabled={seats.length < SHOALS_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
              {seats.length < SHOALS_MIN_PLAYERS ? "Waiting for a second pilot" : "Start the game"}
            </button>
          )}
          {seated && <button className="small" onClick={() => send({ type: "leave" })}>Give up the seat</button>}
          {seated && <span className="muted">The ante is taken when the game starts.</span>}
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
          <li>Each pilot holds three <strong>Channels</strong> <Disc face="channel" /> and one <strong>Shoal</strong> <Disc face="shoal" />. In turn, click one of yours to lay it face down on your own stack.</li>
          <li>Once everyone has laid, bid how many markers you can turn over without striking a Shoal. The others raise or pass.</li>
          <li>The high bidder sails: their own stack first, then anyone's. A clear run is a passage; {SHOALS_PASSAGES} win. Strike a Shoal and you lose a marker for good. The house keeps 10%.</li>
        </ol>
      )}
    </div>
  );
}
