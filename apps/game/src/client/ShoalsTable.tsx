// The Shoals table's panel: the round table seen from above, with the
// pilots seated around it, each one's stack of markers in front of them
// and the pot in the middle. Below it, your hand and the bid. The server
// runs the game; this only shows the view it was sent and asks for moves.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SHOALS_ANTES, SHOALS_MAX_PLAYERS, SHOALS_MIN_PLAYERS, SHOALS_PASSAGES, SHOALS_START, type Marker, type Outfit, type ShoalsRequest, type ShoalsSeatView, type ShoalsView } from "@gantt-quest/world";
import { DragPanel } from "./DragPanel";
import { spriteDataUrl, spriteKey } from "./render/sprites";
import { coinPile, markerUrl, nameUrl, starUrl, tableUrl, type MarkerFace } from "./shoalsArt";
import "./shoals.css";

const NAME: Record<Marker, string> = { channel: "Channel", shoal: "Shoal" };
const START = SHOALS_START.channel + SHOALS_START.shoal;

/** How someone at the table is drawn. */
export interface SeatLook {
  classId: string;
  outfit?: Outfit;
}

interface Props {
  table: ShoalsView | null;
  you: string;
  gold: number;
  error: string | null;
  /** The last XP anyone in the pub earned: the winner's, just after a game. */
  lastXp?: { id: string; amount: number } | null;
  /** What each player in the pub looks like, by id. */
  looks?: Record<string, SeatLook>;
  send(action: ShoalsRequest): void;
}

/** A marker as a pixel disc. `peek`: face down, but yours, so you see its face through a rope ring. */
function Disc({ face, size = 24, peek, title }: { face: MarkerFace; size?: number; peek?: boolean; title?: string }) {
  return <img className={`sh-disc pixel-icon${peek ? " peek" : ""}`} src={markerUrl(face)} width={size} height={size} alt="" title={title ?? (face === "back" ? "Face down" : NAME[face])} draggable={false} />;
}

// toDataURL is not free: draw each look once.
const faces = new Map<string, string>();
function face(look: SeatLook | undefined): string {
  const classId = look?.classId ?? "npc";
  const key = spriteKey(classId, look?.outfit);
  let url = faces.get(key);
  if (!url) faces.set(key, (url = spriteDataUrl(classId, look?.outfit)));
  return url;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** A name in the bitmap font at twice its size, or plain text where the font cannot draw it. */
function PixelName({ text, gold }: { text: string; gold?: boolean }) {
  const art = nameUrl(text, gold ? "#ffd23f" : "#f1eee4");
  if (!art) return <span className={`sh-name-text${gold ? " gold" : ""}`}>{text}</span>;
  return <img className="pixel-icon sh-name-img" src={art.url} width={art.w * 2} height={art.h * 2} alt={text} draggable={false} />;
}

/** Where a sail that just ended left every stack: what was turned over, the marker that ended it, and what stayed face down. */
interface Reveal {
  round: number;
  stacks: Record<string, { shown: Marker[]; down: number; struck: boolean }>;
}

export function ShoalsTable({ table, you, gold, error, lastXp, looks, send }: Props) {
  const [count, setCount] = useState(1);
  const [rules, setRules] = useState(false);
  const [fullLog, setFullLog] = useState(false);
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

  // Seats go round the table clockwise from yours at the bottom. Before a game,
  // every chair is set out, empty ones too.
  const seats = table?.seats ?? [];
  const chairs = !table || table.phase === "open" ? SHOALS_MAX_PLAYERS : seats.length;
  const start = Math.max(0, seats.findIndex((s) => s.id === you));
  const placed: (ShoalsSeatView | undefined)[] = Array.from({ length: chairs }, (_, i) => (i < seats.length ? seats[(i + start) % seats.length] : undefined));

  const outcome = last && (last.result === "clear"
    ? `${name(last.pilot)} sailed ${last.bid} clear.`
    : last.result === "aground"
      ? `${name(last.pilot)} ran aground on ${last.at === last.pilot ? (last.pilot === you ? "your own" : "their own") : last.at === you ? "your" : `${name(last.at ?? "")}'s`} Shoal.`
      : "The round was called off.");

  const status = (() => {
    if (!table) return "Nobody is playing. Open a table to set out the markers.";
    if (table.phase === "open") return seated ? (table.host === you ? (seats.length < SHOALS_MIN_PLAYERS ? "Waiting for a second pilot to sit." : "Start when everyone is seated.") : `Waiting for ${name(table.host)} to start.`) : `A table is open at ${table.ante} gold a seat.`;
    if (table.phase === "done") return table.winner ? `${name(table.winner)} ${table.winner === you ? "win" : "wins"} the table!` : "The game is over.";
    const who = table.turn ? short(table.turn) : "";
    const bid = table.bid;
    if (table.step === "lay") {
      if (!myTurn) return `${who} is laying a marker.`;
      return everyoneLaid ? "Your turn: lay another marker, or open the bidding." : "Your turn: lay a marker face down.";
    }
    if (table.step === "bid" && bid) return myTurn ? `${short(bid.by)} ${bid.by === you ? "say" : "says"} ${bid.count}. Raise or pass.` : `${who} to raise ${shorts(bid.by)} ${bid.count}, or pass.`;
    if (table.step === "sail" && bid) {
      const left = bid.count - table.sailed;
      return myTurn ? `At the helm: turn over ${left} more. ${ownLeft > 0 ? "Your own stack first." : "Pick any stack."}` : `${who} ${table.turn === you ? "are" : "is"} at the helm: ${table.sailed} of ${bid.count} clear.`;
    }
    return "";
  })();

  const phaseLabel = !table ? "No game" : table.phase === "open" ? "Seating" : table.phase === "done" ? "Game over" : table.step === "lay" ? "Laying" : table.step === "bid" ? "Bidding" : "Sailing";
  const potGold = table ? (table.phase === "open" ? table.ante * seats.length : table.phase === "done" ? table.prize : table.pot) : 0;

  return (
    <DragPanel id="pub.shoals" title="Shoals" className="panel shoals-table">
      <div className="sh-status" aria-live="polite">
        <span className={`sh-phase ${table?.phase ?? "none"} ${table?.step ?? ""}`}>{phaseLabel}</span>
        <span className="sh-status-text">{status}</span>
      </div>

      <div className="sh-board">
        <img className="sh-felt pixel-icon" src={tableUrl()} alt="" draggable={false} />

        {placed.map((s, i) => {
          const angle = (90 + (i * 360) / chairs) * (Math.PI / 180);
          const pos = { "--cx": Math.cos(angle).toFixed(3), "--cy": Math.sin(angle).toFixed(3) } as CSSProperties;
          // Which side of the table the chair is on, for how the seat lays itself out.
          const where = Math.sin(angle) < -0.5 ? "at-top" : Math.sin(angle) > 0.5 ? "at-bottom" : "at-side";
          if (!s) return <EmptyChair key={`empty${i}`} style={pos} where={where} />;
          return (
            <SeatSpot
              key={s.id}
              s={s}
              style={pos}
              where={where}
              table={table!}
              you={you}
              look={looks?.[s.id]}
              reveal={shownReveal && s.laid === 0 ? shownReveal.stacks[s.id] : undefined}
              canFlip={!!myTurn && table!.step === "sail" && s.laid - s.shown.length > 0 && (s.id === you || ownLeft === 0)}
              hand={s.id === you ? table!.you?.stack : undefined}
              flip={() => {
                myFlip.current = s.id;
                send({ type: "flip", seat: s.id });
              }}
            />
          );
        })}

        <div className="sh-pot" title={table ? `Pot: ${table.phase === "done" ? `${table.prize} gold paid out of ${table.pot}` : `${potGold} gold`}. The house keeps 10%.` : undefined}>
          {playing && table!.step === "sail" && table!.bid && (
            <span className="sh-course" title={`${table!.sailed} of ${table!.bid.count} turned clear`}>
              {Array.from({ length: table!.bid.count }, (_, i) => <i key={i} className={i < table!.sailed ? "on" : ""} />)}
            </span>
          )}
          {table && <Coins n={Math.ceil(Math.max(1, potGold) / 5)} />}
          <strong>{table ? `${potGold} gold` : "—"}</strong>
          <span>{!table ? "no game" : table.phase === "open" ? `ante ${table.ante}` : table.phase === "done" ? "paid out" : `round ${table.round}`}</span>
        </div>

      </div>

      {playing && last && table!.step === "lay" && <p className={`sh-outcome ${last.result}`}>Last round: {outcome}</p>}
      {table?.phase === "done" && table.winner && (
        <p className="sh-winner">
          <strong>{name(table.winner)}</strong> {table.winner === you ? "take" : "takes"} {table.prize} gold from a pot of {table.pot}.
          {lastXp?.id === table.winner && lastXp.amount > 0 && <> <span className="xp-gain">+{lastXp.amount} XP</span></>}
        </p>
      )}

      {/* Your hand and your call. */}
      {playing && mine && mine.count > 0 && table!.you && (
        <div className={`sh-dock${myTurn ? " live" : ""}`}>
          <div className="sh-hand">
            <span className="sh-label">Your hand</span>
            <div className="sh-hand-discs">
              {(["channel", "shoal"] as Marker[]).flatMap((m) =>
                Array.from({ length: table!.you!.hand[m] }, (_, i) => (
                  <button
                    key={`${m}${i}`}
                    type="button"
                    className={`sh-lay ${m}`}
                    disabled={!myTurn || table!.step !== "lay"}
                    title={myTurn && table!.step === "lay" ? `Lay a ${NAME[m]} face down` : NAME[m]}
                    aria-label={`Lay a ${NAME[m]}`}
                    onClick={() => send({ type: "lay", marker: m })}
                  >
                    <Disc face={m} size={36} title="" />
                  </button>
                )),
              )}
              {table!.you.hand.channel + table!.you.hand.shoal === 0 && <span className="muted">All down.</span>}
            </div>
          </div>

          {myTurn && table!.step !== "sail" && (everyoneLaid || table!.step === "bid") && (
            <div className="sh-bid">
              <span className="sh-label">I can sail</span>
              <div className="sh-stepper">
                <button type="button" className="small" aria-label="One fewer" disabled={count <= (table!.bid?.count ?? 0) + 1} onClick={() => setCount((n) => n - 1)}>−</button>
                <output aria-label="Markers to sail">{count}</output>
                <button type="button" className="small" aria-label="One more" disabled={count >= table!.total} onClick={() => setCount((n) => n + 1)}>+</button>
              </div>
              <button className="primary" disabled={count <= (table!.bid?.count ?? 0) || count > table!.total} onClick={() => send({ type: "bid", count })}>Bid</button>
              {table!.step === "bid" && <button onClick={() => send({ type: "pass" })}>Pass</button>}
            </div>
          )}
        </div>
      )}

      {/* Before and after a game: the stakes and the seats. */}
      {(!table || table.phase === "done") && (
        <div className="sh-actions">
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
        <div className="sh-actions">
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
          {seated && <button className="small" onClick={() => send({ type: "leave" })}>Get up</button>}
          {seated && <span className="muted">The ante is taken when the game starts.</span>}
        </div>
      )}

      {error && <p className="bad">{error}</p>}

      {table && table.log.length > 0 && (
        <div className={`sh-log${fullLog ? " open" : ""}`}>
          <ul>
            {(fullLog ? table.log : table.log.slice(-1)).map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}

      <div className="sh-foot">
        <button type="button" className="link" aria-expanded={rules} onClick={() => setRules((r) => !r)}>{rules ? "Hide the rules" : "How to play"}</button>
        {table && table.log.length > 1 && (
          <button type="button" className="link" aria-expanded={fullLog} onClick={() => setFullLog((f) => !f)}>{fullLog ? "Less" : `Log (${table.log.length})`}</button>
        )}
        <span className="spacer" />
        {inGame && <button type="button" className="small danger" onClick={() => confirm("Walk away? You forfeit your stake.") && send({ type: "leave" })}>Forfeit</button>}
      </div>
      {rules && (
        <ol className="sh-rules">
          <li>Each pilot holds three <strong>Channels</strong> <Disc face="channel" size={18} /> and one <strong>Shoal</strong> <Disc face="shoal" size={18} />. In turn, lay one face down on your own stack.</li>
          <li>Once everyone has laid, bid how many markers you can turn over without striking a Shoal. The others raise or pass.</li>
          <li>The high bidder sails: their own stack first, then anyone's. A clear run is a passage; {SHOALS_PASSAGES} win. Strike a Shoal and you lose a marker for good. The house keeps 10%.</li>
        </ol>
      )}
    </DragPanel>
  );
}

/** The pot as a heap of coins, a coin for every five gold or so, at three times its size. */
function Coins({ n }: { n: number }) {
  const art = coinPile(n);
  return <img className="pixel-icon" src={art.url} width={art.w * 3} height={art.h * 3} alt="" draggable={false} />;
}

function EmptyChair({ style, where }: { style: CSSProperties; where: string }) {
  return (
    <div className={`sh-seat empty ${where}`} style={style}>
      <span className="sh-chair" />
      <span className="sh-empty-label">empty</span>
    </div>
  );
}

interface SeatProps {
  s: ShoalsSeatView;
  style: CSSProperties;
  where: string;
  table: ShoalsView;
  you: string;
  look?: SeatLook;
  /** The stack as the last sail left it, shown until this pilot lays again. */
  reveal?: Reveal["stacks"][string];
  canFlip: boolean;
  /** Your own stack, bottom first, when this seat is yours. */
  hand?: Marker[];
  flip(): void;
}

function SeatSpot({ s, style, where, table, you, look, reveal, canFlip, hand, flip }: SeatProps) {
  const mine = s.id === you;
  const turn = table.phase === "playing" && table.turn === s.id;
  const out = table.phase !== "open" && s.count === 0;
  const won = table.phase === "done" && table.winner === s.id;
  const bidder = table.phase === "playing" && table.bid?.by === s.id;
  const chip = won ? "winner"
    : out ? (s.forfeited ? "left" : "out")
    : table.phase === "open" && s.id === table.host ? "opened"
    : turn && table.step === "sail" ? "helm"
    : bidder ? `says ${table.bid!.count}`
    : s.passed ? "passed"
    : turn ? "to play"
    : null;

  // Your face-down markers, top first, so you can see what you laid.
  const down = s.laid - s.shown.length;
  const peeks = hand ? hand.slice(0, down).reverse() : [];

  return (
    <>
      <div className={`sh-seat ${where}${turn ? " turn" : ""}${out ? " out" : ""}${won ? " won" : ""}${mine ? " mine" : ""}`} style={style}>
        {chip && <span className={`sh-chip ${chip.split(" ")[0]}`}>{chip}</span>}
        <span className="sh-portrait">
          <img className="pixel-icon" src={face(look)} width={54} height={66} alt="" draggable={false} />
        </span>
        <span className="sh-plate" title={`${s.name}${mine ? " (you)" : ""}`}>
          <PixelName text={firstName(s.name)} gold={mine} />
        </span>
        {table.phase !== "open" && (
          <span className="sh-tally">
            <span className="sh-pips" title={`${s.count} of ${START} markers left`}>
              {Array.from({ length: START }, (_, i) => <i key={i} className={i < s.count ? "on" : ""} />)}
            </span>
            <span className="sh-stars" title={`${s.passages} of ${SHOALS_PASSAGES} passages`}>
              {Array.from({ length: SHOALS_PASSAGES }, (_, i) => <img key={i} className="pixel-icon" src={starUrl(i < s.passages)} width={14} height={14} alt="" draggable={false} />)}
            </span>
          </span>
        )}
      </div>

      {table.phase !== "open" && (s.laid > 0 || reveal) && (
        <Stack style={style} where={where} canFlip={canFlip} flip={flip} name={mine ? "your" : `${firstName(s.name)}'s`}
          down={reveal ? reveal.down : down} shown={reveal ? reveal.shown : s.shown} peeks={reveal ? [] : peeks} struck={!!reveal?.struck || (table.phase === "done" && table.last?.result === "aground" && table.last.at === s.id)} ghost={!!reveal} />
      )}
    </>
  );
}

/** A pilot's stack on the felt: face-down markers piled up, and the ones turned over laid out beside it. */
function Stack({ style, where, down, shown, peeks, canFlip, flip, struck, ghost, name }: { style: CSSProperties; where: string; down: number; shown: Marker[]; peeks: Marker[]; canFlip: boolean; flip(): void; struck: boolean; ghost: boolean; name: string }) {
  const pile = (
    <span className="sh-pile" style={{ height: 24 + Math.max(0, down - 1) * 6 }} title={`${down} face down`}>
      {down > 1 && <span className="sh-pile-count">{down}</span>}
      {Array.from({ length: down }, (_, i) => {
        const peek = peeks[down - 1 - i];
        return (
          <span key={i} className="sh-pile-disc" style={{ bottom: i * 6 }}>
            {peek ? <Disc face={peek} peek title={`${NAME[peek]}, face down: only you can see it`} /> : <Disc face="back" />}
          </span>
        );
      })}
    </span>
  );
  return (
    <div className={`sh-stack ${where}${canFlip ? " can-flip" : ""}${ghost ? " ghost" : ""}`} style={style}>
      {down > 0 && (canFlip ? (
        <button type="button" className="sh-flip" title={`Turn over the top of ${name} stack`} aria-label={`Turn over the top of ${name} stack`} onClick={flip}>
          {pile}
        </button>
      ) : pile)}
      {shown.length > 0 && (
        <span className="sh-shown">
          {shown.map((m, i) => (
            <span key={i} className={struck && m === "shoal" && i === shown.length - 1 ? "struck" : ""}>
              <Disc face={m} size={20} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
