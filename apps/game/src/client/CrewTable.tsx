// The Cargo and Krakens table. You sit at it in the pub, first person
// (render/TableStage.ts draws the table, the model ship, the others round it
// and everyone's dice), and this is what lies over the view: what is
// happening, and the moves open to you. Like the dice table's panel, it only
// shows the view the server sent and asks for moves. The one choice it holds
// itself is which of your dice you mean to hold on your next roll. What you
// held last roll starts out held again, until you let it go. The ship can't be let go.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { CREW_ANTES, CREW_CAPTAIN, CREW_KRAKEN, CREW_MAX_PLAYERS, CREW_MIN_PLAYERS, CREW_NEEDS, CREW_ROLLS, crewHold, type CrewRequest, type CrewSeatView, type CrewView } from "@gantt-quest/world";
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

/** Ship and captain as small pictures, lit while you have them. */
function Needs({ ship, captain }: { ship: boolean; captain: boolean }) {
  return (
    <span className="crew-needs">
      {([[6, ship], [CREW_CAPTAIN, captain]] as const).map(([face, have]) => (
        <img key={face} className={`pixel-icon${have ? "" : " crew-missing"}`} src={crewFaceUrl(face)} width={40} height={40} alt={CREW_FACE_NAME[face]} title={`${CREW_FACE_NAME[face]} (${face})${have ? ": in" : ""}`} draggable={false} />
      ))}
    </span>
  );
}

/** A turn that came to nothing, said over their head. A cargo goes in a crate by their name instead. */
const lossChip = (s: CrewSeatView) => (s.score === 0 ? (s.lost === "kraken" ? "kraken" : s.lost === "captainless" ? "no captain" : "adrift") : null);

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
  /** The ship is in, so the other four dice are yours to keep or roll: a captain and three of cargo. */
  const loading = !!table && table.phase === "playing" && table.held >= CREW_NEEDS.length && table.rolls > 0;
  /** The best cargo made so far this round, and who made it. */
  const best = Math.max(0, ...seats.filter((s) => s.contending && !s.forfeited).map((s) => s.score ?? 0));
  const leaders = seats.filter((s) => s.contending && !s.forfeited && best > 0 && s.score === best);
  const leadText = leaders.map((l) => short(l.id)).join(" and ");

  // The dice you mean to hold on your next roll. Each throw starts it from what that throw held back, so a die you
  // hold stays held from roll to roll until you click it again.
  const [keep, setKeep] = useState<{ n: number; dice: number[] } | null>(null);
  const throwN = table?.lastThrow?.n ?? 0;
  const heldLast = loading ? (table?.kept ?? []) : [];
  // A choice made before the latest throw no longer counts: start again from what it held.
  const holding = keep && keep.n === throwN ? keep.dice : heldLast;
  const canKeep = myTurn && loading && left > 0;
  const dice = table?.dice ?? [];
  const toggle = (i: number) => {
    if (!canKeep || dice[i] === CREW_KRAKEN) return;
    // At least one die is always rolled: holding them all is standing.
    const k = holding;
    setKeep({ n: throwN, dice: k.includes(i) ? k.filter((x) => x !== i) : k.length + 1 >= dice.length ? k : [...k, i].sort() });
  };
  const rolling = dice.length - holding.length;
  const krakens = loading ? dice.filter((d) => d === CREW_KRAKEN).length : 0;
  /** Which die is the captain: a 5 in the held pool if there is one, else the first 5 showing. The other three are cargo. */
  const captainIx = loading ? (holding.find((i) => dice[i] === CREW_CAPTAIN) ?? dice.indexOf(CREW_CAPTAIN)) : -1;
  const cargoDice = captainIx >= 0 ? dice.filter((_, i) => i !== captainIx) : [];

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
      if (table.rolls === 0) return `Your turn: roll. First you need a 6 (ship).${beat}`;
      if (loading) {
        const kraken = krakens > 0 ? ` ${krakens === 1 ? "A Kraken is" : `${krakens} Krakens are`} among them: roll ${krakens === 1 ? "it" : "them"} away or lose the lot.` : "";
        const aboard = table.captain ? `Captain aboard, cargo ${table.cargo}.` : "No captain yet: you need a 5 among your dice.";
        const end = left > 0 ? ` Tap dice to hold them; they stay held until you tap them again. Roll the rest${table.captain && !krakens ? ", or stand" : ""}. ${rollsLeft(left)}.` : "";
        return `${aboard}${kraken}${beat}${end}`;
      }
      return `Still looking for a 6 (ship). ${rollsLeft(left)}.`;
    }
    if (mine && !mine.contending && !mine.forfeited) return `You are out of this roll-off. Waiting for ${name(table.turn!)}.`;
    // Your own score is not over your head (it would hang in front of your eyes), so it is said here.
    const yours = mine?.score === null || mine?.score === undefined ? ""
      : mine.score > 0 ? `Your cargo is ${mine.score}${leaders.some((l) => l.id === you) ? ", the best so far" : ""}. `
      : mine.lost === "kraken" ? "The Kraken took your cargo. " : mine.lost === "captainless" ? "No captain for your cargo this round. " : "No ship for you this round. ";
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
      // The scoreboard is by everyone's names: each cargo in a crate as it is made, the best of the round gold-banded, and a lost one said in red over their head.
      const lost = s.contending ? lossChip(s) : null;
      const chip = won ? "winner" : out ? (s.forfeited ? "left" : "out") : table?.phase === "open" && s.id === table.host ? "opened" : turn ? "to play" : lost;
      const chipInk = chip && chip === lost ? "#f08a8a" : undefined;
      const crate = (s.contending || won) && s.score !== null && s.score > 0 ? { score: s.score, lead: s.score === best } : undefined;
      return seatInfo(s, looks?.[s.id], { turn, out, won, chip, chipInk, crate });
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
                // Your own held dice are the ones you have picked; anyone else's, what their last roll held back.
                return { id: s.id, held: CREW_NEEDS.slice(0, table.held), free: table.dice, cargo, ...thrown, ...(s.id === you ? { keep: holding, canKeep } : { keep: cargo ? table.kept : [] }) };
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
      : loading ? { main: "no captain" }
      : { main: rollsLeft(left) };
    const xp = table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 ? `+${lastXp.amount} XP` : undefined;
    stage.setCard({ caption, ...main, prompt: reading, foot: xp, yours: myTurn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks, lastXp, reading, holding.join(","), canKeep]);

  /** One of your dice once the ship is in, as a tile: what it is, and whether it is held or to be rolled. */
  const tile = (i: number) => {
    const d = dice[i];
    const kraken = d === CREW_KRAKEN;
    const held = holding.includes(i);
    const role = kraken ? "Kraken" : i === captainIx ? "Captain" : "Cargo";
    const title = kraken ? "A Kraken can't be held: roll it away, or it takes your cargo"
      : held ? `${role}: held, and stays held roll after roll. Click to roll it again`
      : `${role}: click to hold it. It stays held until you click it again`;
    return (
      <button key={i} type="button" className={`crew-die${held ? " held" : " loose"}${kraken ? " kraken" : ""}`} aria-pressed={held} disabled={!canKeep || kraken} title={title} onClick={() => toggle(i)}>
        <span className="crew-die-role">{role}</span>
        <img className="pixel-icon" src={d === 1 || d === 5 || d === 6 ? crewFaceUrl(d) : dieFaceUrl(d, held)} width={28} height={28} alt={kraken ? "Kraken" : String(d)} draggable={false} />
        <span className="crew-die-state">{held ? "held" : kraken ? "must roll" : "↻ roll"}</span>
      </button>
    );
  };

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
          <Needs ship={false} captain={false} />
          <button className="primary" disabled={left <= 0} onClick={() => send({ type: "roll" })}>
            {table!.rolls === 0 ? "Roll" : "Roll again"} ({left} left)
          </button>
        </div>
      )}

      {myTurn && loading && (
        <div className="crew-board">
          <div className="crew-pool" role="group" aria-label="Held: the ship, which stays all turn, and the dice you hold. Click a held die to roll it again">
            <span className="td-label">Held <span className="crew-sum">{captainIx < 0 ? "· no captain yet" : `· cargo ${cargoDice.join("+")} = ${table!.cargo}`}</span></span>
            <div className="crew-pool-dice">
              <span className="crew-die held ship" title="Ship: needed, so it stays held for the rest of your turn">
                <span className="crew-die-role">Ship</span>
                <img className="pixel-icon" src={crewFaceUrl(6)} width={28} height={28} alt="Ship" draggable={false} />
                <span className="crew-die-state">held</span>
              </span>
              {holding.slice().sort((a, b) => a - b).map(tile)}
            </div>
          </div>
          {rolling > 0 && (
            <div className="crew-loose" role="group" aria-label="Your loose dice: click one to hold it">
              <span className="td-label">Rolls next</span>
              <div className="crew-pool-dice">{dice.map((_, i) => i).filter((i) => !holding.includes(i)).map(tile)}</div>
            </div>
          )}
          <div className="crew-moves">
            <button className="primary" disabled={!canKeep || rolling < 1} onClick={() => send({ type: "roll", keep: holding })}>
              Roll {rolling} {rolling === 1 ? "die" : "dice"} <small>({rollsLeft(left)})</small>
            </button>
            <button disabled={krakens > 0 || !table!.captain} title={krakens > 0 ? "Not with a Kraken among your dice: roll it away first" : !table!.captain ? "You need a captain (a 5) first" : undefined} onClick={() => send({ type: "stand" })}>
              {table!.cargo !== null ? `Stand on ${table!.cargo}` : "Stand"}
            </button>
          </div>
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
          <li><strong>The dice:</strong> the 6 is printed with a ship, the 5 with a captain and the 1 with the Kraken; 2, 3 and 4 are plain pips.</li>
          <li><strong>Ship first:</strong> on your turn you roll five dice, up to {CREW_ROLLS} times. Nothing counts until a 6 comes up: the first one is your ship, and it is set aside.</li>
          <li><strong>Then it is up to you:</strong> the other four dice are yours to play with. With rolls left, click the ones you want to hold (on the table or below) and roll the rest again, or press <strong>Stand</strong>. A die you hold joins the ship in the held pool and stays held from roll to roll; click it again to roll it. The ship stays held all turn.</li>
          <li><strong>Captain and cargo:</strong> among those four you need a 5, your captain. The other three are your cargo, added up for your score (up to 18). You need not keep a captain first: land good cargo and gamble your last rolls on a 5 coming up. End without a captain and your cargo goes nowhere: you score nothing.</li>
          <li><strong>The Kraken:</strong> a 1 is the Kraken. It can't be held, but you can roll it again, but if a Kraken is still among your dice when your rolls run out, it takes everything and you score nothing. You cannot stand with one showing, or without a captain. Every die you roll again could raise your score, bring in your captain, or sink you.</li>
          <li><strong>Winning:</strong> when everyone has had a turn, the highest cargo takes the pot (the house keeps 10%). The scores so far are in the crates by everyone's names, the best banded in gold. If the best is tied, only those tied roll again. If nobody scored, everyone rolls again.</li>
        </ol>
      )}
    </div>
  );
}
