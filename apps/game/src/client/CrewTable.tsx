// The Ship, Captain & Crew table. You sit at it in the pub, first person
// (render/TableStage.ts draws the table, the model ship, the others round it
// and everyone's dice), and this is what lies over the view: what is
// happening, and the moves open to you. Like the dice table's panel, it only
// shows the view the server sent and asks for moves.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { CREW_ANTES, CREW_MAX_PLAYERS, CREW_MIN_PLAYERS, CREW_NEEDS, CREW_ROLLS, crewHold, type CrewRequest, type CrewView } from "@gantt-quest/world";
import type { SeatInfo } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import { CREW_FACE_NAME, crewFaceUrl } from "./crewArt";
import { drawnSeats, placeSeats, withSelf, seatInfo, useTableStage, type SeatLook, type StageHost } from "./useTableStage";
import "./table.css";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

interface Props {
  table: CrewView | null;
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
  send(action: CrewRequest): void;
}

/** Ship, captain and crew as small pictures, lit as they come in. */
function Needs({ held }: { held: number }) {
  return (
    <span className="crew-needs">
      {CREW_NEEDS.map((face, i) => (
        <img key={face} className={`pixel-icon${i < held ? "" : " crew-missing"}`} src={crewFaceUrl(face)} width={40} height={40} alt={CREW_FACE_NAME[face]} title={`${CREW_FACE_NAME[face]} (${face})${i < held ? ": in" : ""}`} draggable={false} />
      ))}
    </span>
  );
}

export function CrewTable({ table, you, gold, error, lastXp, looks, world, host, send }: Props) {
  const [rules, setRules] = useState(false);
  const name = (id: string) => (id === you ? "You" : (table?.seats.find((s) => s.id === id)?.name ?? "Someone"));
  const short = (id: string) => (id === you ? "You" : firstName(name(id)));
  const seats = table?.seats ?? [];
  const seated = seats.some((s) => s.id === you);
  const mine = seats.find((s) => s.id === you);
  const myTurn = table?.phase === "playing" && table.turn === you;
  const inGame = table?.phase === "playing" && !!mine && mine.contending && !mine.forfeited;
  const left = table ? CREW_ROLLS - table.rolls : 0;

  const confirmStand = () => !inGame || confirm("Walk away? You forfeit your stake.");
  const { stage, standUp } = useTableStage("crew", { ...host, world }, () => undefined, confirmStand);

  const lastLine = (() => {
    const l = table?.last;
    if (!l || table?.phase !== "playing" || l.result === "win") return null;
    return l.result === "bust" ? "Last round nobody found a full crew, so everyone rolls again." : `${l.ids.map(short).join(" and ")} tied last round and roll off.`;
  })();

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table and the others may sit.";
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < CREW_MIN_PLAYERS ? "Waiting for someone to sit." : "Start when everyone is seated.") : `Waiting for ${name(table.host)} to start.`) : `A table is open at ${table.ante} gold a seat.`;
    if (table.phase === "done") {
      const top = table.last?.scores.find((s) => s.id === table.winner)?.score;
      return table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} ${table.prize} gold${top ? ` with a cargo of ${top}` : ""}.` : "The game is over.";
    }
    if (myTurn) {
      if (table.rolls === 0) return "Your turn: roll the dice. You need a 6 (ship), then a 5 (captain), then a 4 (crew).";
      if (table.cargo !== null) return `Ship, captain and crew are in. Your cargo is ${table.cargo}. Stand on it, or roll the two cargo dice again (${left} ${left === 1 ? "roll" : "rolls"} left).`;
      const need = CREW_NEEDS[table.held];
      return `Still looking for a ${need} (${CREW_FACE_NAME[need as 4 | 5 | 6].toLowerCase()}). ${left} ${left === 1 ? "roll" : "rolls"} left.`;
    }
    if (mine && !mine.contending && !mine.forfeited) return `You are out of this roll-off. Waiting for ${name(table.turn!)}.`;
    return mine && mine.contending ? `Waiting for ${name(table.turn!)}.` : "You are watching.";
  })();

  const reading = lastLine ? `${lastLine} ${status}` : status;

  const placement = useMemo(() => placeSeats(drawnSeats(seats, table?.phase, host.hide, you), you, !table || table.phase === "open", CREW_MAX_PLAYERS), [seats, you, table, host.hide.join(",")]);
  useEffect(() => {
    if (!stage) return;
    const infos = placement.placed.map((s): SeatInfo | undefined => {
      if (!s) return undefined;
      const playing = table?.phase === "playing";
      const out = !!table && table.phase !== "open" && (s.forfeited || (playing && !s.contending));
      const won = table?.phase === "done" && table.winner === s.id;
      const turn = playing && table!.turn === s.id;
      const scored = s.score !== null && s.contending ? (s.score > 0 ? `cargo ${s.score}` : "no crew") : null;
      const chip = won ? "winner" : out ? (s.forfeited ? "left" : "out") : table?.phase === "open" && s.id === table.host ? "opened" : turn ? "to play" : scored;
      return seatInfo(s, looks?.[s.id], { turn, out, won, chip });
    });
    stage.setSeats(placement.chairs, withSelf(infos, you, looks));
    stage.syncCrew(
      table && table.phase !== "open"
        ? {
            rollKey: `${table.round}:${table.turn}:${table.rolls}`,
            rolled: table.rolls > 0 ? table.turn : null,
            seats: table.seats.map((s) => {
              // The player rolling now shows this turn's dice; everyone else, the five they last ended a turn on.
              if (table.phase === "playing" && table.turn === s.id && table.rolls > 0) return { id: s.id, held: CREW_NEEDS.slice(0, table.held), free: table.dice };
              const { held } = crewHold(0, s.hand);
              return { id: s.id, held: s.hand.slice(0, held), free: s.hand.slice(held) };
            }),
          }
        : null,
    );
    stage.setPot(table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0);
    // Everything there is to read hangs on the card under your dice, where your eyes already are; the dock below holds only the controls.
    const caption = !table ? "No game" : table.phase === "open" ? `Seating: ${table.ante} gold a seat` : table.phase === "done" ? "Game over" : `${table.round > 1 ? `Round ${table.round}` : "Playing"}: pot ${table.pot} gold`;
    const main = !table || table.phase === "open" ? {}
      : table.phase === "done" ? { main: `${table.prize} gold` }
      : table.cargo !== null ? { main: `cargo ${table.cargo}` }
      : { main: `${left} ${left === 1 ? "roll" : "rolls"} left` };
    const xp = table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 ? `+${lastXp.amount} XP` : undefined;
    stage.setCard({ caption, ...main, prompt: reading, foot: xp, yours: myTurn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks, lastXp, reading]);

  return (
    <div className="table-dock panel dice-table crew-table">
      {/* What is happening is on the card over the table; this copy is for screen readers. */}
      <p className="td-sr" aria-live="polite">{reading}</p>

      {(!table || table.phase === "done") && (
        <div className="td-row">
          <span>{table ? "Another game:" : "Open a table:"}</span>
          {CREW_ANTES.map((a) => (
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
            <button className="primary" disabled={gold < table.ante || seats.length >= CREW_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
              {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
            </button>
          )}
          {table.host === you && (
            <button className="primary" disabled={seats.length < CREW_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
              {seats.length < CREW_MIN_PLAYERS ? "Waiting for a second player" : "Start the game"}
            </button>
          )}
          {seated && <button className="small" onClick={() => send({ type: "leave" })}>Give up the seat</button>}
          {seated && <span className="muted">The ante is taken when the game starts.</span>}
        </div>
      )}

      {myTurn && (
        <div className="td-row">
          <Needs held={table!.rolls > 0 ? table!.held : 0} />
          <button className="primary" disabled={left <= 0} onClick={() => send({ type: "roll" })}>
            {table!.rolls === 0 ? "Roll" : table!.cargo !== null ? "Roll the cargo" : "Roll again"} ({left} left)
          </button>
          <button disabled={table!.cargo === null} title={table!.cargo === null ? "You need a ship, a captain and a crew first" : undefined} onClick={() => send({ type: "stand" })}>
            {table!.cargo === null ? "Stand" : `Stand on ${table!.cargo}`}
          </button>
        </div>
      )}

      {error && <p className="bad">{error}</p>}

      <div className="td-foot">
        <button type="button" className="link" aria-expanded={rules} onClick={() => setRules((r) => !r)}>{rules ? "Hide the rules" : "How to play"}</button>
        <span className="spacer" />
        <button type="button" className={inGame ? "small danger" : "small"} onClick={() => confirmStand() && standUp()}>{inGame ? "Forfeit and stand" : "Stand up"}</button>
      </div>
      {rules && (
        <ol className="td-rules muted">
          <li><strong>The idea:</strong> on your turn you roll five dice, up to {CREW_ROLLS} times. You are trying to load a ship: you need a <em>6 (the ship)</em>, then a <em>5 (the captain)</em>, then a <em>4 (the crew)</em>.</li>
          <li><strong>In order:</strong> each one is set aside as soon as you roll it, and the next roll uses only the dice left. A 5 does not count until you have your 6, and a 4 does not count until you have your 5. A lucky roll can bring in all three at once.</li>
          <li><strong>Cargo:</strong> once ship, captain and crew are in, the other two dice are your cargo, and they add up to your score (2 to 12). If you have rolls left you may roll the two cargo dice again to try for more, or press <strong>Stand</strong> to keep what you have. The new roll counts even if it is lower.</li>
          <li><strong>No crew, no score:</strong> if your three rolls run out before you have all three, you score nothing this round.</li>
          <li><strong>Winning:</strong> when everyone has had a turn, the highest cargo takes the pot (the house keeps 10%). If the best score is tied, only those tied roll again. If nobody scored, everyone rolls again.</li>
        </ol>
      )}
    </div>
  );
}
