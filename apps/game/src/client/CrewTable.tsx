// The Ship, Captain & Kraken table. You sit at it in the pub, first person
// (render/TableStage.ts draws the table, the model ship, the others round it
// and everyone's dice), and this is what lies over the view: what is
// happening, and the moves open to you. Like the dice table's panel, it only
// shows the view the server sent and asks for moves. The one choice it holds
// itself is which of your cargo dice you mean to keep, until you roll.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { CREW_ANTES, CREW_KRAKEN, CREW_MAX_PLAYERS, CREW_MIN_PLAYERS, CREW_NEEDS, CREW_ROLLS, crewHold, type CrewRequest, type CrewSeatView, type CrewView } from "@gantt-quest/world";
import type { SeatInfo } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import { CREW_FACE_NAME, crewFaceUrl, dieFaceUrl } from "./crewArt";
import { drawnSeats, placeSeats, withSelf, seatInfo, useTableCues, useTableStage, type SeatLook, type StageHost } from "./useTableStage";
import "./table.css";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const rollsLeft = (n: number) => `${n} ${n === 1 ? "roll" : "rolls"} left`;

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

/** Ship and captain as small pictures, lit as they come in. */
function Needs({ held }: { held: number }) {
  return (
    <span className="crew-needs">
      {CREW_NEEDS.map((face, i) => (
        <img key={face} className={`pixel-icon${i < held ? "" : " crew-missing"}`} src={crewFaceUrl(face)} width={40} height={40} alt={CREW_FACE_NAME[face]} title={`${CREW_FACE_NAME[face]} (${face})${i < held ? ": in" : ""}`} draggable={false} />
      ))}
    </span>
  );
}

/** What a seat's last turn came to, over their head: the scoreboard. */
const scoreChip = (s: CrewSeatView) => (s.score === null ? null : s.score > 0 ? `cargo ${s.score}` : s.lost === "kraken" ? "kraken" : "adrift");

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
  /** Ship and captain are in, so the other three dice are cargo. */
  const loading = !!table && table.phase === "playing" && table.held >= CREW_NEEDS.length && table.rolls > 0;
  /** The best cargo made so far this round, and who made it. */
  const best = Math.max(0, ...seats.filter((s) => s.contending && !s.forfeited).map((s) => s.score ?? 0));
  const leaders = seats.filter((s) => s.contending && !s.forfeited && best > 0 && s.score === best);
  const leadText = leaders.map((l) => short(l.id)).join(" and ");

  // The cargo dice you mean to keep on your next roll. A new throw clears it.
  const [keep, setKeep] = useState<number[]>([]);
  const throwN = table?.lastThrow?.n ?? 0;
  useEffect(() => setKeep([]), [throwN, table?.turn]);
  const canKeep = myTurn && loading && left > 0;
  const toggle = (i: number) => {
    if (!canKeep) return;
    // At least one die is always rolled: keeping all three is standing.
    setKeep((k) => (k.includes(i) ? k.filter((x) => x !== i) : k.length + 1 >= (table?.dice.length ?? 0) ? k : [...k, i].sort()));
  };
  const rolling = (table?.dice.length ?? 0) - keep.length;
  const krakens = loading ? (table?.dice.filter((d) => d === CREW_KRAKEN).length ?? 0) : 0;

  const confirmStand = () => !inGame || confirm("Walk away? You forfeit your stake.");
  const { stage, standUp } = useTableStage("crew", { ...host, world }, (a) => a.type === "keep" && toggle(a.index), confirmStand);
  useTableCues({ phase: table?.phase ?? null, myTurn, winner: table?.winner ?? null, you });

  const lastLine = (() => {
    const l = table?.last;
    if (!l || table?.phase !== "playing" || l.result === "win") return null;
    return l.result === "bust" ? "Last round nobody brought a cargo home, so everyone rolls again." : `${l.ids.map(short).join(" and ")} tied last round and roll off.`;
  })();

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table and the others may sit.";
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < CREW_MIN_PLAYERS ? "Waiting for someone to sit." : "Start when everyone is seated.") : `Waiting for ${name(table.host)} to start.`) : `A table is open at ${table.ante} gold a seat.`;
    if (table.phase === "done") {
      const top = table.last?.scores.find((s) => s.id === table.winner)?.score;
      return table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} ${table.prize} gold${top ? ` with a cargo of ${top}` : ""}.` : "The game is over.";
    }
    if (myTurn) {
      const beat = best > 0 ? ` ${leadText} ${leaders.length > 1 ? "have" : "has"} ${best} to beat.` : "";
      if (table.rolls === 0) return `Your turn: roll. You need a 6 (ship), then a 5 (captain).${beat}`;
      if (loading) {
        const kraken = krakens > 0 ? ` ${krakens === 1 ? "A Kraken is" : `${krakens} Krakens are`} in it: roll ${krakens === 1 ? "it" : "them"} away or lose the lot.` : "";
        return `Cargo ${table.cargo}.${kraken}${beat} Pick dice to keep and roll the rest, or stand. ${rollsLeft(left)}.`;
      }
      const need = CREW_NEEDS[table.held];
      return `Still looking for a ${need} (${CREW_FACE_NAME[need].toLowerCase()}). ${rollsLeft(left)}.`;
    }
    if (mine && !mine.contending && !mine.forfeited) return `You are out of this roll-off. Waiting for ${name(table.turn!)}.`;
    // Your own score is not over your head (it would hang in front of your eyes), so it is said here.
    const yours = mine?.score === null || mine?.score === undefined ? ""
      : mine.score > 0 ? `Your cargo is ${mine.score}${leaders.some((l) => l.id === you) ? ", the best so far" : ""}. `
      : mine.lost === "kraken" ? "The Kraken took your cargo. " : "No ship and captain for you this round. ";
    const toBeat = best > 0 && !leaders.some((l) => l.id === you) ? `${leadText} ${leaders.length > 1 ? "lead" : "leads"} with ${best}. ` : "";
    return mine && mine.contending ? `${yours}${toBeat}Waiting for ${name(table.turn!)}.` : "You are watching.";
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
      // The scoreboard is over everyone's heads: each cargo as it is made, the best of the round so far in gold, a lost one in red.
      const scored = s.contending ? scoreChip(s) : null;
      const chip = won ? "winner" : out ? (s.forfeited ? "left" : "out") : table?.phase === "open" && s.id === table.host ? "opened" : turn ? "to play" : scored;
      const chipInk = chip !== scored || s.score === null ? undefined : s.score === 0 ? "#f08a8a" : s.score === best ? "#ffd23f" : "#a9d4fb";
      return seatInfo(s, looks?.[s.id], { turn, out, won, chip, chipInk });
    });
    stage.setSeats(placement.chairs, withSelf(infos, you, looks));
    const lt = table?.lastThrow;
    stage.syncCrew(
      table && table.phase !== "open"
        ? {
            // Every throw is seen, even one that ended a turn (the turn has already passed on): its dice are then the hand the player ended on.
            rollKey: String(lt?.n ?? 0),
            rolled: lt?.by ?? null,
            sunk: !!lt?.kraken,
            seats: table.seats.map((s) => {
              const theirs = lt?.by === s.id;
              const thrown = { fresh: theirs ? lt.fresh : 0, thrown: theirs ? lt.thrown : undefined };
              // The player rolling now shows this turn's dice; everyone else, the five they last ended a turn on.
              if (table.phase === "playing" && table.turn === s.id && table.rolls > 0) {
                const cargo = table.held >= CREW_NEEDS.length;
                return { id: s.id, held: CREW_NEEDS.slice(0, table.held), free: table.dice, cargo, ...thrown, ...(s.id === you ? { keep, canKeep } : {}) };
              }
              const { held } = crewHold(0, s.hand);
              return { id: s.id, held: s.hand.slice(0, held), free: s.hand.slice(held), cargo: held >= CREW_NEEDS.length, ...thrown };
            }),
          }
        : null,
    );
    stage.setPot(table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0);
    // Everything there is to read hangs on the card under your dice, where your eyes already are; the dock below holds only the controls.
    const caption = !table ? "No game" : table.phase === "open" ? `Seating: ${table.ante} gold a seat` : table.phase === "done" ? "Game over" : `${table.round > 1 ? `Round ${table.round}` : "Playing"}: pot ${table.pot} gold`;
    const main = !table || table.phase === "open" ? {}
      : table.phase === "done" ? { main: `${table.prize} gold` }
      : table.cargo !== null ? { main: table.kraken ? `cargo ${table.cargo}?` : `cargo ${table.cargo}` }
      : { main: rollsLeft(left) };
    const xp = table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 ? `+${lastXp.amount} XP` : undefined;
    stage.setCard({ caption, ...main, prompt: reading, foot: xp, yours: myTurn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks, lastXp, reading, keep, canKeep]);

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

      {myTurn && !loading && (
        <div className="td-row">
          <Needs held={table!.rolls > 0 ? table!.held : 0} />
          <button className="primary" disabled={left <= 0} onClick={() => send({ type: "roll" })}>
            {table!.rolls === 0 ? "Roll" : "Roll again"} ({left} left)
          </button>
        </div>
      )}

      {myTurn && loading && (
        <div className="td-row">
          <span className="td-label">Cargo</span>
          <span className="crew-cargo" role="group" aria-label="Your cargo dice: pick the ones to keep">
            {table!.dice.map((d, i) => {
              const kraken = d === CREW_KRAKEN;
              const kept = keep.includes(i);
              return (
                <button key={i} type="button" className={`crew-die${kept ? " kept" : ""}${kraken ? " kraken" : ""}`} aria-pressed={kept} disabled={!canKeep} title={kraken ? "A Kraken: roll it away, or it takes your cargo" : kept ? "Kept: click to roll it again" : "Click to keep this die"} onClick={() => toggle(i)}>
                  <img className="pixel-icon" src={kraken ? crewFaceUrl(1) : dieFaceUrl(d, kept)} width={36} height={36} alt={kraken ? "Kraken" : String(d)} draggable={false} />
                  <span>{kept ? "keep" : "roll"}</span>
                </button>
              );
            })}
          </span>
          <button className="primary" disabled={!canKeep || rolling < 1} onClick={() => send({ type: "roll", keep })}>
            Roll {rolling === table!.dice.length ? "all" : rolling} ({left} left)
          </button>
          <button disabled={krakens > 0} title={krakens > 0 ? "Not with a Kraken in your cargo: roll it away first" : undefined} onClick={() => send({ type: "stand" })}>
            Stand on {table!.cargo}
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
          <li><strong>The idea:</strong> on your turn you roll five dice, up to {CREW_ROLLS} times. First you need a <em>6 (the ship)</em>, then a <em>5 (the captain)</em>. Each is set aside as soon as you roll it, and a 5 does not count until you have your 6. A lucky roll brings in both at once.</li>
          <li><strong>Cargo:</strong> once ship and captain are in, your other three dice are the cargo, and they add up to your score (up to 18).</li>
          <li><strong>The choice:</strong> with rolls left, click the cargo dice you want to keep (on the table or below), and roll the rest again. Or press <strong>Stand</strong> to end your turn on what you have.</li>
          <li><strong>The Kraken:</strong> a 1 in your cargo is the Kraken. You can roll it again, but if a Kraken is still there when your rolls run out, it takes your whole cargo and you score nothing. You cannot stand with one showing. Every die you roll again could raise your score or bring up a Kraken, so the more you chase, the more you risk.</li>
          <li><strong>No ship and captain, no score:</strong> run out of rolls before you have both, and you score nothing too.</li>
          <li><strong>Winning:</strong> when everyone has had a turn, the highest cargo takes the pot (the house keeps 10%). The scores so far are over everyone's heads, the best in gold. If the best is tied, only those tied roll again. If nobody scored, everyone rolls again.</li>
        </ol>
      )}
    </div>
  );
}
