// The Harbor's dice table: a bluffing game for two to four crewmates.
//
// Everyone antes the same stake and rolls three hidden dice. On your turn
// you either raise the bid (a claim about how many dice of one face are on
// the whole table) or call the last bid. A call shows every die: if the bid
// holds, the caller loses a die, otherwise the bidder does. The last player
// with dice takes the pot, less the house's cut.
//
// This file is the whole game as a pure reducer. The HarborRoom Durable
// Object owns the state, moves the gold, and only ever sends a player the
// `diceView` of it, so nobody is told another player's hidden dice.

import { makeRng } from "./rng";

/** Stakes the player who opens a table may pick from. */
export const DICE_ANTES = [5, 10, 20] as const;
/** Dice each player starts with. */
export const DICE_START = 3;
export const DICE_MIN_PLAYERS = 2;
export const DICE_MAX_PLAYERS = 4;
/** The house's share of the pot, in percent, rounded down. */
export const DICE_HOUSE_PCT = 10;
const LOG_LINES = 8;

export interface DiceBid {
  by: string;
  /** "There are at least `count` dice showing `face` on the table." */
  count: number;
  face: number;
}

export interface DiceSeat {
  id: string;
  name: string;
  /** Hidden from the others. Empty once the player is out (or before the game starts). */
  dice: number[];
  /** Left mid-game rather than losing their dice. */
  forfeited: boolean;
}

/** A resolved call: the one moment every die of a round is shown. */
export interface DiceReveal {
  bid: DiceBid;
  caller: string;
  hands: { id: string; dice: number[] }[];
  /** How many dice really showed the bid's face. */
  actual: number;
  /** Who lost a die over it. */
  loser: string;
}

export interface DiceGame {
  ante: number;
  /** open: seats are filling. playing: dice are down. done: someone won. */
  phase: "open" | "playing" | "done";
  /** Opened the table and decides when to start. */
  host: string;
  seats: DiceSeat[];
  /** Index into `seats` of whose turn it is. */
  turn: number;
  /** Bids of the current round, oldest first. */
  bids: DiceBid[];
  round: number;
  reveal: DiceReveal | null;
  winner: string | null;
  /** Gold anted, set when the game starts. */
  pot: number;
  log: string[];
  /** Seeded generator state. Never sent to a client: it would give away every future roll. */
  rng: number;
}

export type DiceAction =
  | { type: "sit"; name: string }
  /** Before the start: give up the seat. During play: forfeit. */
  | { type: "leave" }
  | { type: "start" }
  | { type: "bid"; count: number; face: number }
  | { type: "call" };

export type DiceResult = { ok: true; state: DiceGame } | { ok: false; error: string };

/** How a pot is divided between the house and the winner. */
export function diceSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * DICE_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isDiceAnte = (n: unknown): n is (typeof DICE_ANTES)[number] => (DICE_ANTES as readonly unknown[]).includes(n);

/** A fresh table with its opener in the first seat. */
export function createDiceGame(seed: number, ante: number, host: { id: string; name: string }): DiceGame {
  return {
    ante,
    phase: "open",
    host: host.id,
    seats: [{ id: host.id, name: host.name, dice: [], forfeited: false }],
    turn: 0,
    bids: [],
    round: 0,
    reveal: null,
    winner: null,
    pot: 0,
    log: [`${host.name} opened a table at ${ante} gold a seat.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): DiceResult => ({ ok: false, error });
const say = (state: DiceGame, line: string): string[] => [...state.log, line].slice(-LOG_LINES);
const inPlay = (seats: DiceSeat[]) => seats.filter((s) => s.dice.length > 0);

/** The next seat after `from` that still has dice. */
function nextSeat(seats: DiceSeat[], from: number): number {
  for (let i = 1; i <= seats.length; i++) {
    const ix = (from + i) % seats.length;
    if (seats[ix].dice.length > 0) return ix;
  }
  return from;
}

/** Everyone still in rolls again: a new round with no bid on the table. */
function reroll(state: DiceGame): DiceGame {
  const rng = makeRng(state.rng);
  const seats = state.seats.map((s) => ({ ...s, dice: s.dice.map(() => rng.int(1, 6)) }));
  return { ...state, seats, bids: [], round: state.round + 1, rng: rng.state() };
}

/** End the game if one player is left, otherwise deal the next round with `turn` to open it. */
function settle(state: DiceGame, turn: number): DiceGame {
  const left = inPlay(state.seats);
  if (left.length === 1) {
    const { prize } = diceSplit(state.pot);
    return { ...state, phase: "done", winner: left[0].id, bids: [], log: say(state, `${left[0].name} wins ${prize} gold.`) };
  }
  return reroll({ ...state, turn });
}

const plural = (count: number, face: number) => `${count} × ${face}${count === 1 ? "" : "s"}`;

export function stepDice(state: DiceGame, playerId: string, action: DiceAction): DiceResult {
  const ix = state.seats.findIndex((s) => s.id === playerId);
  const seat = ix >= 0 ? state.seats[ix] : undefined;

  switch (action.type) {
    case "sit": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (seat) return fail("You are already seated.");
      if (state.seats.length >= DICE_MAX_PLAYERS) return fail("The table is full.");
      const name = action.name;
      return { ok: true, state: { ...state, seats: [...state.seats, { id: playerId, name, dice: [], forfeited: false }], log: say(state, `${name} sat down.`) } };
    }

    case "leave": {
      if (!seat) return fail("You are not at the table.");
      if (state.phase === "done") return fail("The game is over.");
      if (state.phase === "open") {
        const seats = state.seats.filter((s) => s.id !== playerId);
        return { ok: true, state: { ...state, seats, host: state.host === playerId ? (seats[0]?.id ?? "") : state.host, log: say(state, `${seat.name} got up.`) } };
      }
      if (seat.dice.length === 0) return fail("You are already out.");
      // A forfeit ends the round: the dice on the table have changed, so any standing bid is void.
      const seats = state.seats.map((s) => (s.id === playerId ? { ...s, dice: [], forfeited: true } : s));
      const next = { ...state, seats, reveal: null, log: say(state, `${seat.name} walked away and forfeits.`) };
      return { ok: true, state: settle(next, state.turn === ix ? nextSeat(seats, ix) : state.turn) };
    }

    case "start": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (state.host !== playerId) return fail("Only whoever opened the table can start.");
      if (state.seats.length < DICE_MIN_PLAYERS) return fail("It takes at least two to play.");
      const seats = state.seats.map((s) => ({ ...s, dice: Array<number>(DICE_START).fill(0) }));
      const pot = state.ante * seats.length;
      return { ok: true, state: reroll({ ...state, phase: "playing", seats, turn: 0, pot, log: say(state, `Dice down. The pot is ${pot} gold.`) }) };
    }

    case "bid": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const { count, face } = action;
      const total = state.seats.reduce((n, s) => n + s.dice.length, 0);
      if (!Number.isInteger(face) || face < 1 || face > 6) return fail("Pick a face from 1 to 6.");
      if (!Number.isInteger(count) || count < 1 || count > total) return fail(`Bid between 1 and ${total} dice.`);
      const last = state.bids[state.bids.length - 1];
      if (last && !(count > last.count || (count === last.count && face > last.face))) return fail("Raise the bid: more dice, or the same number of a higher face.");
      return {
        ok: true,
        state: { ...state, bids: [...state.bids, { by: playerId, count, face }], turn: nextSeat(state.seats, ix), log: say(state, `${seat.name} bids ${plural(count, face)}.`) },
      };
    }

    case "call": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const bid = state.bids[state.bids.length - 1];
      if (!bid) return fail("There is no bid to call yet.");
      const hands = inPlay(state.seats).map((s) => ({ id: s.id, dice: [...s.dice] }));
      const actual = hands.reduce((n, h) => n + h.dice.filter((d) => d === bid.face).length, 0);
      const loser = actual >= bid.count ? playerId : bid.by;
      const loserIx = state.seats.findIndex((s) => s.id === loser);
      const seats = state.seats.map((s, i) => (i === loserIx ? { ...s, dice: s.dice.slice(1) } : s));
      const line = `${seat.name} calls ${plural(bid.count, bid.face)}: there ${actual === 1 ? "is" : "are"} ${actual}. ${seats[loserIx].name} loses a die.`;
      const next = { ...state, seats, reveal: { bid, caller: playerId, hands, actual, loser }, log: say(state, line) };
      // Whoever lost a die opens the next round, if they are still in.
      return { ok: true, state: settle(next, seats[loserIx].dice.length > 0 ? loserIx : nextSeat(seats, loserIx)) };
    }
  }
}

// ---------- what a player may see ----------

export interface DiceSeatView {
  id: string;
  name: string;
  /** Dice they still hold. */
  count: number;
  forfeited: boolean;
  /** The dice themselves: only ever the viewer's own. */
  dice: number[] | null;
}

export interface DiceView {
  ante: number;
  phase: DiceGame["phase"];
  host: string;
  seats: DiceSeatView[];
  /** Player id of whose turn it is, while playing. */
  turn: string | null;
  bids: DiceBid[];
  round: number;
  /** The last resolved call, with that round's dice face up. */
  reveal: DiceReveal | null;
  winner: string | null;
  pot: number;
  /** What the winner takes from the pot once the house has had its cut. */
  prize: number;
  log: string[];
}

/** The table as `viewerId` may see it. A spectator (or null) sees no hidden dice at all. */
export function diceView(state: DiceGame, viewerId: string | null): DiceView {
  return {
    ante: state.ante,
    phase: state.phase,
    host: state.host,
    seats: state.seats.map((s) => ({ id: s.id, name: s.name, count: s.dice.length, forfeited: s.forfeited, dice: s.id === viewerId && state.phase === "playing" ? [...s.dice] : null })),
    turn: state.phase === "playing" ? state.seats[state.turn].id : null,
    bids: state.bids,
    round: state.round,
    reveal: state.reveal,
    winner: state.winner,
    pot: state.pot,
    prize: diceSplit(state.pot).prize,
    log: state.log,
  };
}

// ---------- wire types (carried inside the Harbor's messages) ----------

/** What a client may ask of the table. The server fills in names and checks gold. */
export type DiceRequest = { type: "open"; ante: number } | { type: "sit" } | { type: "leave" } | { type: "start" } | { type: "bid"; count: number; face: number } | { type: "call" };
