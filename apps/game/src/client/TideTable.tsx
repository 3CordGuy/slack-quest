// The Turn the Tide table. You sit at it in the pub, first person
// (render/TableStage.ts draws the table, the others round it, everyone's
// cards, the deck and the tide token), and this is what lies over the view:
// your hand, large enough to read, and the moves open to you. Like the other
// tables' panels it only shows the view the server sent and asks for moves.
// What it holds itself is the move you are putting together: which card,
// on whom, and the card a Gull names.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { TIDE_ANTES, TIDE_CARDS, TIDE_CUTLASS, TIDE_DEFAULT_WINS, TIDE_GULL, TIDE_KRAKEN, TIDE_MAX_PLAYERS, TIDE_MIN_PLAYERS, TIDE_MOON, TIDE_SMUGGLER, TIDE_SPYGLASS, TIDE_STORM, TIDE_ANCHOR, TIDE_WIN_CHOICES, tideCard, tideCardPhrase, tideTargets, type TideRequest, type TideView } from "@gantt-quest/world";
import type { SeatInfo } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";
import { TIDE_CARD_H, TIDE_CARD_W, tideCardUrl, tideTokenUrl, type TideFace } from "./tideArt";
import { drawnSeats, placeSeats, withSelf, seatInfo, useTableCues, useTableStage, type SeatLook, type StageHost } from "./useTableStage";
import "./table.css";
import "./tide.css";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const hands = (n: number) => (n === 1 ? "one hand" : `${n} hands`);

interface Props {
  table: TideView | null;
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
  send(action: TideRequest): void;
}

/** A card as a picture, `scale` screen pixels to each of its own. */
function CardArt({ face, scale = 2, title }: { face: TideFace; scale?: number; title?: string }) {
  const def = face === "back" ? undefined : tideCard(face);
  return <img className="pixel-icon tide-art" src={tideCardUrl(face)} width={TIDE_CARD_W * scale} height={TIDE_CARD_H * scale} alt={def ? `${def.name} (${def.rank})` : "A card, face down"} title={title ?? (def ? `${def.name} (${def.rank}): ${def.text}` : undefined)} draggable={false} />;
}

/** The move being put together: valid for one turn only. */
interface Move {
  key: string;
  index: number | null;
  target: string | null;
  guess: number | null;
}

export function TideTable({ table, you, gold, error, lastXp, looks, world, host, send }: Props) {
  const [rules, setRules] = useState(false);
  const name = (id: string) => (id === you ? "You" : (table?.seats.find((s) => s.id === id)?.name ?? "Someone"));
  const short = (id: string) => (id === you ? "you" : firstName(name(id)));
  const seats = table?.seats ?? [];
  const seated = seats.some((s) => s.id === you);
  const mine = seats.find((s) => s.id === you);
  const playing = table?.phase === "playing";
  const myTurn = playing && table.stage !== "shown" && table.turn === you;
  const inGame = playing && !!mine && !mine.forfeited;
  const choosing = !!table?.choice;
  const canPlay = myTurn && table!.stage === "play";
  const between = playing && table.stage === "shown";
  const [pickWins, setPickWins] = useState<number>(TIDE_DEFAULT_WINS);

  // The move you are putting together. A choice made on an earlier turn no longer counts.
  const turnKey = `${table?.hand}:${table?.lastPlay?.n ?? 0}:${canPlay}`;
  const [move, setMove] = useState<Move | null>(null);
  const myHand = mine?.hand ?? [];
  const targets = table ? tideTargets(seats, you) : [];
  const live = move && move.key === turnKey ? move : null;
  // Holding the Kraken there is nothing to choose: the other card is the one you play.
  const forced = canPlay && myHand.includes(TIDE_KRAKEN) ? myHand.findIndex((c) => c !== TIDE_KRAKEN) : -1;
  const index = canPlay ? (live?.index ?? (forced >= 0 ? forced : null)) : null;
  const card = index !== null ? myHand[index] : null;
  const def = card !== null ? tideCard(card) : undefined;
  const aimed = !!def?.aimed && targets.length > 0;
  const target = aimed ? (live?.target && targets.includes(live.target) ? live.target : targets.length === 1 ? targets[0] : null) : null;
  const guess = card === TIDE_GULL && aimed ? (live?.guess ?? null) : null;
  const ready = card !== null && card !== TIDE_KRAKEN && (!aimed || (!!target && (card !== TIDE_GULL || guess !== null)));
  const choose = (patch: Partial<Move>) => setMove({ key: turnKey, index, target, guess, ...patch });
  const pickCard = (i: number) => canPlay && myHand[i] !== TIDE_KRAKEN && choose({ index: i === index && forced < 0 ? null : i, target: null, guess: null });
  const play = () => ready && send({ type: "play", card: card!, ...(target ? { target } : {}), ...(guess !== null ? { guess } : {}) });

  const confirmStand = () => !inGame || confirm("Walk away? You forfeit your stake.");
  const { stage, standUp } = useTableStage("tide", { ...host, world }, (a) => a.type === "card" && pickCard(a.index), confirmStand);
  useTableCues({ phase: table?.phase ?? null, myTurn: !!myTurn, winner: table?.winner ?? null, you });
  // Dev-only handle for acting out a scene on the table from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __tideStage: unknown }).__tideStage = stage;

  /** How many of each card are face up on the table, your own hand counted too: what is left is what the others can hold. */
  const seen = useMemo(() => {
    const n: Record<number, number> = {};
    for (const s of seats) for (const c of s.played) n[c] = (n[c] ?? 0) + 1;
    for (const c of myHand) n[c] = (n[c] ?? 0) + 1;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const playLabel = (() => {
    if (card === null || !def) return "Pick a card to play";
    if (def.aimed && !aimed) return `Play ${tideCardPhrase(card)} on nobody: everyone is at anchor`;
    const who = target ? firstName(name(target)) : "someone";
    if (card === TIDE_GULL) return guess !== null ? `Call ${who}'s card ${tideCardPhrase(guess)}` : target ? `Name ${who}'s card` : "Pick a player, and name their card";
    if (card === TIDE_SPYGLASS) return target ? `Look at ${who}'s card` : "Pick a player to look at";
    if (card === TIDE_CUTLASS) return target ? `Cross blades with ${who}` : "Pick a player to fight";
    if (card === TIDE_MOON) return `Turn the tide ${table!.tide === "high" ? "low" : "high"}`;
    if (card === TIDE_ANCHOR) return "Drop anchor";
    if (card === TIDE_STORM) return "Raise the Storm";
    if (card === TIDE_SMUGGLER) return "Look at the buried card";
    return `Play ${tideCardPhrase(card)}`;
  })();

  const tideLine = table ? (table.tide === "high" ? "High tide: the highest card wins." : "Low tide: the lowest card wins.") : "";
  const lastHand = (() => {
    const l = table?.last;
    if (!l) return null;
    const who = l.winners.map((id) => (id === you ? "You" : firstName(name(id)))).join(" and ");
    const verb = l.winners.length > 1 ? "share" : l.winners[0] === you ? "win" : "wins";
    if (l.how === "last") return `${who} ${verb} hand ${l.hand}: the last one in.`;
    const top = l.shown.find((s) => s.id === l.winners[0]);
    return `${who} ${verb} hand ${l.hand}${top ? ` with ${tideCardPhrase(top.card)}` : ""} at ${l.tide} tide.`;
  })();

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table and the others may sit.";
    const goal = `First to ${hands(table.wins)}.`;
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < TIDE_MIN_PLAYERS ? "Waiting for someone to sit." : `Start when everyone is seated. ${goal}`) : `Waiting for ${name(table.host)} to start. ${goal}`) : `A table is open at ${table.ante} gold a seat. ${goal}`;
    if (table.phase === "done") return `${lastHand ?? ""} ${table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} ${table.prize} gold.` : "The game is over."}`.trim();
    if (between) return `${lastHand ?? ""} ${inGame ? "Deal the next hand when you are ready." : "Waiting for the next hand."}`.trim();
    const said = table.log[table.log.length - 1] ?? "";
    if (choosing) return `The buried card is ${tideCardPhrase(table.buried!)}. Swap your ${tideCard(myHand[0])?.name ?? "card"} for it, or leave it buried?`;
    if (table.stage === "choice") return `${said} Waiting for ${name(table.turn!)} to decide.`;
    if (myTurn) return `${table.lastPlay ? `${said} ` : ""}Your turn: play one of your two cards. ${tideLine}`;
    if (mine?.out && !mine.forfeited) return `${said} You are out of this hand. Waiting for ${name(table.turn!)}.`;
    return `${table.lastPlay ? `${said} ` : ""}Waiting for ${name(table.turn!)}. ${tideLine}`;
  })();

  /** What you have learned about the others' cards. */
  const known = seats.filter((s) => s.known !== null && !s.out);

  const placement = useMemo(() => placeSeats(drawnSeats(seats, table?.phase, host.hide, you), you, !table || table.phase === "open", TIDE_MAX_PLAYERS), [seats, you, table, host.hide.join(",")]);
  useEffect(() => {
    if (!stage) return;
    const infos = placement.placed.map((s): SeatInfo | undefined => {
      if (!s) return undefined;
      const won = table?.phase === "done" && table.winner === s.id;
      const turn = !!playing && table!.turn === s.id;
      const tookHand = between && !!table!.last?.winners.includes(s.id);
      const out = !!table && table.phase !== "open" && (s.forfeited || (s.out && !between));
      const chip = won ? "winner" : s.forfeited && table?.phase !== "open" ? "left" : tookHand ? "won the hand" : out ? "out" : s.anchored ? "anchored" : table?.phase === "open" && s.id === table.host ? "opened" : turn ? "to play" : null;
      const stars = table && table.phase !== "open" && table.wins > 1 ? { on: s.wins, of: table.wins } : undefined;
      return seatInfo(s, looks?.[s.id], { turn, out, won, chip, chipInk: tookHand ? "#ffd23f" : undefined, stars });
    });
    stage.setSeats(placement.chairs, withSelf(infos, you, looks));
    const backs = (n: number): TideFace[] => Array<TideFace>(Math.max(0, n)).fill("back");
    stage.syncTide(
      table && table.phase !== "open"
        ? {
            hand: table.hand,
            playKey: `${table.hand}:${table.lastPlay?.n ?? 0}`,
            play: table.lastPlay,
            shown: table.stage === "shown",
            winners: table.stage === "shown" ? (table.last?.winners ?? []) : [],
            tide: table.tide,
            deck: table.deck,
            buried: table.buried,
            dealt: true,
            seats: table.seats.map((s) => ({
              id: s.id,
              // A card you know of lies face up among their others, dimmer than one shown to everyone.
              hand: s.hand ?? (s.known !== null && s.cards > 0 ? [s.known, ...backs(s.cards - 1)] : backs(s.cards)),
              known: !s.hand && s.known !== null,
              played: s.played,
              pick: s.id === you ? { can: !!canPlay, index } : undefined,
            })),
          }
        : null,
    );
    stage.setPot(table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0);
    const caption = !table ? "No game" : table.phase === "open" ? `Seating: ${table.ante} gold a seat` : table.phase === "done" ? "Game over" : `Hand ${table.hand}: pot ${table.pot} gold`;
    const main = !table || table.phase === "open" ? {} : table.phase === "done" ? { main: `${table.prize} gold` } : { main: `${table.tide} tide` };
    const xp = table?.phase === "done" && lastXp?.id === table.winner && lastXp.amount > 0 ? `+${lastXp.amount} XP` : undefined;
    // The card over the table is kept short: the dock, with your hand in it, lies over the rest.
    stage.setCard({ caption, ...main, foot: xp, yours: !!myTurn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, table, placement, looks, lastXp, index, canPlay, myTurn]);

  return (
    <div className="table-dock panel dice-table tide-table">
      {/* Your hand takes the room under the table where the other games hang their card, so what is happening is said here. */}
      <p key={status} className={`tide-status${myTurn ? " yours" : ""}`} aria-live="polite">{status}</p>

      {(!table || table.phase === "done") && (
        <div className="td-row">
          <span className="crew-rounds" role="group" aria-label="How many hands to win">
            <span className="td-label">First to</span>
            {TIDE_WIN_CHOICES.map((n) => (
              <button key={n} type="button" className={`small${pickWins === n ? " on" : ""}`} aria-pressed={pickWins === n} title={`The first to win ${hands(n)} takes the pot`} onClick={() => setPickWins(n)}>
                {n}
              </button>
            ))}
          </span>
          <span>{table ? "Another game:" : "Open a table:"}</span>
          {TIDE_ANTES.map((a) => (
            <button key={a} className="small" disabled={gold < a} title={gold < a ? "You cannot afford this ante" : `Open a table at ${a} gold a seat, first to ${hands(pickWins)}`} onClick={() => send({ type: "open", ante: a, wins: pickWins })}>
              {a} gold
            </button>
          ))}
          <span className="muted">You have {gold}.</span>
        </div>
      )}

      {table?.phase === "open" && (
        <div className="td-row">
          {!seated && (
            <button className="primary" disabled={gold < table.ante || seats.length >= TIDE_MAX_PLAYERS} onClick={() => send({ type: "sit" })}>
              {gold < table.ante ? `You need ${table.ante} gold to sit` : `Sit (${table.ante} gold)`}
            </button>
          )}
          {table.host === you && (
            <button className="primary" disabled={seats.length < TIDE_MIN_PLAYERS} onClick={() => send({ type: "start" })}>
              {seats.length < TIDE_MIN_PLAYERS ? "Waiting for a second player" : "Deal the cards"}
            </button>
          )}
          {seated && <button className="small" onClick={() => send({ type: "leave" })}>Give up the seat</button>}
          {seated && <span className="muted">The ante is taken when the game starts.</span>}
        </div>
      )}

      {table && table.phase !== "open" && mine && (
        <div className="tide-board">
          <div className="tide-hand" role="group" aria-label="Your hand">
            {myHand.length === 0 && <span className="muted tide-none">{mine.forfeited ? "You walked away." : "You are out of this hand."}</span>}
            {myHand.map((c, i) => {
              const kraken = c === TIDE_KRAKEN;
              return (
                <button key={`${i}:${c}`} type="button" className={`tide-card${index === i ? " picked" : ""}${kraken && canPlay ? " stuck" : ""}`} aria-pressed={index === i} disabled={!canPlay || kraken} title={kraken && canPlay ? "The Kraken cannot be played" : `${tideCard(c)?.name}: ${tideCard(c)?.text}`} onClick={() => pickCard(i)}>
                  <CardArt face={c} />
                </button>
              );
            })}
            {choosing && (
              <span className="tide-buried">
                <span className="td-label">Buried</span>
                <CardArt face={table.buried!} />
              </span>
            )}
          </div>

          <div className="tide-side">
            <span className={`tide-token ${table.tide}`} title={tideLine}>
              <img className="pixel-icon" src={tideTokenUrl(table.tide)} width={32} height={32} alt="" draggable={false} />
              <span><strong>{table.tide === "high" ? "High tide" : "Low tide"}</strong><br />{table.tide === "high" ? "highest card wins" : "lowest card wins"}</span>
              <span className="muted">{table.deck} to draw</span>
            </span>

            {canPlay && def && <p className="tide-text"><strong>{def.name} ({def.rank}).</strong> {def.text}</p>}

            {canPlay && aimed && (
              <div className="td-row" role="group" aria-label="On whom">
                <span className="td-label">On</span>
                {seats.filter((s) => s.id !== you && !s.out).map((s) => (
                  <button key={s.id} type="button" className={`small${target === s.id ? " on" : ""}`} aria-pressed={target === s.id} disabled={s.anchored} title={s.anchored ? `${s.name} is at anchor` : s.known !== null ? `You know ${s.name} holds ${tideCardPhrase(s.known)}` : s.name} onClick={() => choose({ target: s.id })}>
                    {firstName(s.name)}{s.anchored ? " (anchored)" : s.known !== null ? ` (${tideCard(s.known)?.name})` : ""}
                  </button>
                ))}
              </div>
            )}

            {canPlay && aimed && card === TIDE_GULL && (
              <div className="td-row tide-guess" role="group" aria-label="Name their card">
                <span className="td-label">Is</span>
                {TIDE_CARDS.filter((c) => c.rank !== TIDE_GULL).map((c) => {
                  const left = c.count - (seen[c.rank] ?? 0);
                  return (
                    <button key={c.rank} type="button" className={`small${guess === c.rank ? " on" : ""}`} aria-pressed={guess === c.rank} disabled={left <= 0} title={left <= 0 ? `Every ${c.name} is accounted for` : `${c.name} (${c.rank}): ${left} of ${c.count} unseen`} onClick={() => choose({ guess: c.rank })}>
                      {c.rank} {c.name}
                    </button>
                  );
                })}
              </div>
            )}

            {canPlay && <button className="primary" disabled={!ready} onClick={play}>{playLabel}</button>}

            {choosing && (
              <div className="td-row">
                <button className="primary" onClick={() => send({ type: "smuggle", swap: true })}>Swap for {tideCardPhrase(table.buried!)}</button>
                <button onClick={() => send({ type: "smuggle", swap: false })}>Leave it buried</button>
              </div>
            )}

            {between && inGame && <button className="primary" onClick={() => send({ type: "deal" })}>Deal hand {table.hand + 1}</button>}

            {playing && !between && known.length > 0 && (
              <p className="tide-known">You know: {known.map((s) => `${firstName(s.name)} holds ${tideCardPhrase(s.known!)}`).join("; ")}.</p>
            )}
          </div>
        </div>
      )}

      {playing && (
        <p className="tide-seen muted" title="Cards face up on the table and in your hand, of how many are in the deck">
          <span className="td-label">Seen</span>
          {TIDE_CARDS.map((c) => (
            <span key={c.rank} className={(seen[c.rank] ?? 0) >= c.count ? "gone" : ""}>{c.rank} {c.name} {seen[c.rank] ?? 0}/{c.count}</span>
          ))}
        </p>
      )}

      {error && <p className="bad">{error}</p>}

      <div className="td-foot">
        <button type="button" className="link" aria-expanded={rules} onClick={() => setRules((r) => !r)}>{rules ? "Hide the rules" : "How to play"}</button>
        <span className="spacer" />
        <button type="button" className={inGame ? "small danger" : "small"} onClick={() => confirmStand() && standUp()}>{inGame ? "Forfeit and stand" : "Stand up"}</button>
      </div>
      {rules && (
        <div className="td-rules muted tide-rules">
          <ol>
            <li><strong>One card each:</strong> the deck is twenty cards, ranked 1 to 9. Each hand one card is buried face down and everyone is dealt one.</li>
            <li><strong>Draw one, play one:</strong> on your turn you draw a card, then play one of your two face up and do what it says.</li>
            <li><strong>The tide:</strong> when the deck runs out, everyone still in shows their card. At high tide the highest wins the hand; at low tide the lowest. It starts high, and a Moon turns it. A tie goes to whoever played the most, adding up their cards; if that ties too, they share the hand.</li>
            <li><strong>Out of the hand:</strong> a Gull or a Cutlass can put a player out. The last one left wins the hand at once.</li>
            <li><strong>Winning:</strong> whoever opens the table picks how many hands it takes ({TIDE_WIN_CHOICES.join(", ")}; {TIDE_DEFAULT_WINS} unless they say). The first player alone in the lead with that many takes the pot (the house keeps 10%).</li>
          </ol>
          <ul className="tide-cards">
            {TIDE_CARDS.map((c) => (
              <li key={c.rank}>
                <CardArt face={c.rank} scale={1} />
                <span><strong>{c.rank} {c.name}</strong> ×{c.count}<br />{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
