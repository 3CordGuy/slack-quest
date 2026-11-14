// Ship, Captain & Kraken: the pub's third table game, a push-your-luck take
// on the old tavern dice game Ship, Captain & Crew, for two to six.
//
// On your turn you have up to three rolls of five dice. You need a 6 (the
// ship), then a 5 (the captain), in that order: each is set aside as soon as
// a roll turns it up, and a 5 is no use before the ship is in. One roll can
// bring in both. Once both are in, the other three dice are your cargo, and
// the choice is yours: keep the cargo dice you like and roll the rest again
// with any rolls left, or stand on what you have.
//
// A 1 in your cargo is the Kraken. Roll one and you can roll it again, but if
// a Kraken is still in your cargo when your rolls run out, it takes the lot
// and you score nothing; and you cannot stand with one showing. So every
// cargo die you roll again might raise your score or sink it. Never get your
// ship and captain and you score nothing too.
//
// When everyone has had a turn, the highest cargo takes the pot, less the
// house's cut. A tie for the top is rolled off by those tied; if nobody
// scored, everyone still in goes again.
//
// The module, the pub's table and the messages keep the name "crew" from the
// game this one grew out of.
//
// This file is the whole game as a pure reducer. The PubRoom Durable Object
// owns the state and moves the gold. Every die here is rolled in the open, so
// a player's view is the whole game but for the generator's state.

import { makeRng } from "./rng";

export const CREW_ANTES = [5, 10, 20] as const;
export const CREW_MIN_PLAYERS = 2;
export const CREW_MAX_PLAYERS = 6;
/** Dice in a roll, and rolls in a turn. */
export const CREW_DICE = 5;
export const CREW_ROLLS = 3;
/** Ship and captain, in the order they must come in. */
export const CREW_NEEDS = [6, 5] as const;
/** The face that is the Kraken, once it is in your cargo. */
export const CREW_KRAKEN = 1;
/** The best cargo there is: three sixes. */
export const CREW_MAX_CARGO = 18;
/** The house's share of the pot, in percent, rounded down. */
export const CREW_HOUSE_PCT = 10;
const LOG_LINES = 8;

/** Why a turn scored nothing: no ship and captain, or the Kraken took the cargo. */
export type CrewLoss = "adrift" | "kraken";

export interface CrewSeat {
  id: string;
  name: string;
  /** Still in the running this round: everyone at first, only those tied in a roll-off. */
  contending: boolean;
  /** This round's score once their turn is over (0 for nothing), or null before. */
  score: number | null;
  /** Why it was 0, when it was. */
  lost?: CrewLoss | null;
  /** The five dice they last ended a turn on, ship and captain first. Empty before their first turn. */
  hand: number[];
  /** Left mid-game. */
  forfeited: boolean;
}

/** How a round came out, for everyone to see. */
export interface CrewRoundResult {
  round: number;
  scores: { id: string; score: number }[];
  /** "win": `ids` holds the winner. "tie": `ids` are rolling off. "bust": nobody scored, so all of `ids` go again. */
  result: "win" | "tie" | "bust";
  ids: string[];
}

/** One roll, for the table to show: who threw, how many of ship and captain it brought in, which cargo dice were thrown, and whether the Kraken ended the turn. */
export interface CrewThrow {
  n: number;
  by: string;
  fresh: number;
  /** Indexes into the cargo (`dice`) that were thrown; the rest were kept. */
  thrown?: number[];
  kraken?: boolean;
}

export interface CrewGame {
  ante: number;
  /** open: seats are filling. playing: dice are rolling. done: someone won. */
  phase: "open" | "playing" | "done";
  host: string;
  seats: CrewSeat[];
  /** Index into `seats` of whose turn it is. */
  turn: number;
  /** Rolls used so far this turn. */
  rolls: number;
  /** How many of ship and captain are in this turn: 0 to 2. */
  held: number;
  /** The dice that are not held, as last rolled. Once ship and captain are in, the cargo, each in its place. Empty before the turn's first roll. */
  dice: number[];
  round: number;
  /** The last round's outcome, once there has been one. */
  last: CrewRoundResult | null;
  /** The latest roll of the game, numbered from 1. For the table to animate, even a roll that ended a turn. */
  lastThrow: CrewThrow | null;
  winner: string | null;
  /** Gold anted, set when the game starts. */
  pot: number;
  log: string[];
  /** Seeded generator state. Never sent to a client: it would give away every future roll. */
  rng: number;
}

export type CrewAction =
  | { type: "sit"; name: string }
  /** Before the start: give up the seat. During play: forfeit. */
  | { type: "leave" }
  | { type: "start" }
  /** Roll. Once ship and captain are in, `keep` lists the cargo dice (by index) to hold back; the rest are rolled again. */
  | { type: "roll"; keep?: number[] }
  /** Keep the cargo you have and end your turn. */
  | { type: "stand" };

export type CrewResult = { ok: true; state: CrewGame } | { ok: false; error: string };

export function crewSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * CREW_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isCrewAnte = (n: unknown): n is (typeof CREW_ANTES)[number] => (CREW_ANTES as readonly unknown[]).includes(n);

/** The cargo of a turn with ship and captain in: its dice added up, Krakens and all. Null until both are in. */
export const crewCargo = (held: number, dice: readonly number[]): number | null => (held >= CREW_NEEDS.length && dice.length > 0 ? dice.reduce((a, d) => a + d, 0) : null);

/** A Kraken is in the cargo. */
export const crewKraken = (held: number, dice: readonly number[]): boolean => held >= CREW_NEEDS.length && dice.includes(CREW_KRAKEN);

/** What a turn ending now would score: the cargo, unless there is none or the Kraken has it. */
export function crewScore(held: number, dice: readonly number[]): { score: number; lost: CrewLoss | null } {
  const cargo = crewCargo(held, dice);
  if (cargo === null) return { score: 0, lost: "adrift" };
  if (crewKraken(held, dice)) return { score: 0, lost: "kraken" };
  return { score: cargo, lost: null };
}

/**
 * Take ship and captain out of a roll, in order, as far as it goes.
 * Returns how many are held after it, and the dice left over.
 */
export function crewHold(held: number, dice: readonly number[]): { held: number; dice: number[] } {
  const left = [...dice];
  while (held < CREW_NEEDS.length) {
    const ix = left.indexOf(CREW_NEEDS[held]);
    if (ix < 0) break;
    left.splice(ix, 1);
    held++;
  }
  return { held, dice: left };
}

const newSeat = (id: string, name: string): CrewSeat => ({ id, name, contending: false, score: null, lost: null, hand: [], forfeited: false });

/** A fresh table with its opener in the first seat. */
export function createCrewGame(seed: number, ante: number, host: { id: string; name: string }): CrewGame {
  return {
    ante,
    phase: "open",
    host: host.id,
    seats: [newSeat(host.id, host.name)],
    turn: 0,
    rolls: 0,
    held: 0,
    dice: [],
    round: 0,
    last: null,
    lastThrow: null,
    winner: null,
    pot: 0,
    log: [`${host.name} set out the dice cup at ${ante} gold a seat.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): CrewResult => ({ ok: false, error });
const say = (state: CrewGame, line: string): string[] => [...state.log, line].slice(-LOG_LINES);
/** Still to play this round. */
const due = (s: CrewSeat) => s.contending && !s.forfeited && s.score === null;
const fresh = { rolls: 0, held: 0, dice: [] as number[] };

/** The first seat from `from` on (itself included) still to play this round, or -1. */
function nextDue(seats: CrewSeat[], from: number): number {
  for (let i = 0; i < seats.length; i++) {
    const ix = (from + i) % seats.length;
    if (due(seats[ix])) return ix;
  }
  return -1;
}

/** Only one player is left in the running: they take the pot. */
function win(state: CrewGame, id: string): CrewGame {
  const seat = state.seats.find((s) => s.id === id)!;
  const { prize } = crewSplit(state.pot);
  return { ...state, ...fresh, phase: "done", winner: id, log: say(state, `${seat.name} wins ${prize} gold.`) };
}

/** Everyone in the running has played: settle the round, or start another for those still in it. */
function endRound(state: CrewGame): CrewGame {
  const runners = state.seats.filter((s) => s.contending && !s.forfeited);
  const scores = runners.map((s) => ({ id: s.id, score: s.score ?? 0 }));
  const best = Math.max(0, ...scores.map((s) => s.score));
  const top = best > 0 ? scores.filter((s) => s.score === best).map((s) => s.id) : scores.map((s) => s.id);
  const result: CrewRoundResult["result"] = best === 0 ? "bust" : top.length === 1 ? "win" : "tie";
  const last: CrewRoundResult = { round: state.round, scores, result, ids: top };
  if (result === "win") return win({ ...state, last }, top[0]);
  const names = state.seats.filter((s) => top.includes(s.id)).map((s) => s.name);
  const line = result === "bust" ? "Nobody brought a cargo home. Everyone rolls again." : `${names.join(" and ")} tie on ${best}. They roll off.`;
  // Hands stay on the table, so everyone can see how the round went, until each player rolls again.
  const seats = state.seats.map((s) => ({ ...s, contending: top.includes(s.id), score: null, lost: null }));
  const turn = nextDue(seats, 0);
  return { ...state, ...fresh, seats, turn, round: state.round + 1, last, log: say(state, line) };
}

/** The player on turn is done: on to the next, or the end of the round. */
function endTurn(state: CrewGame): CrewGame {
  const { score, lost } = crewScore(state.held, state.dice);
  const hand = [...CREW_NEEDS.slice(0, state.held), ...state.dice];
  const seats = state.seats.map((s, i) => (i === state.turn ? { ...s, score, lost, hand } : s));
  const next = { ...state, ...fresh, seats };
  const ix = nextDue(seats, state.turn);
  return ix < 0 ? endRound(next) : { ...next, turn: ix };
}

export function stepCrew(state: CrewGame, playerId: string, action: CrewAction): CrewResult {
  const ix = state.seats.findIndex((s) => s.id === playerId);
  const seat = ix >= 0 ? state.seats[ix] : undefined;

  switch (action.type) {
    case "sit": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (seat) return fail("You are already seated.");
      if (state.seats.length >= CREW_MAX_PLAYERS) return fail("The table is full.");
      return { ok: true, state: { ...state, seats: [...state.seats, newSeat(playerId, action.name)], log: say(state, `${action.name} sat down.`) } };
    }

    case "leave": {
      if (!seat) return fail("You are not at the table.");
      if (state.phase === "done") return fail("The game is over.");
      if (state.phase === "open") {
        const seats = state.seats.filter((s) => s.id !== playerId);
        return { ok: true, state: { ...state, seats, host: state.host === playerId ? (seats[0]?.id ?? "") : state.host, log: say(state, `${seat.name} got up.`) } };
      }
      if (seat.forfeited || !seat.contending) return fail("You are already out.");
      const seats = state.seats.map((s) => (s.id === playerId ? { ...s, contending: false, forfeited: true } : s));
      const next = { ...state, seats, log: say(state, `${seat.name} walked away and forfeits.`) };
      const runners = seats.filter((s) => s.contending && !s.forfeited);
      if (runners.length === 1) return { ok: true, state: win(next, runners[0].id) };
      if (state.turn !== ix) return { ok: true, state: next };
      // It was their turn: it passes on, and the round may be over.
      const after = nextDue(seats, ix);
      return { ok: true, state: after < 0 ? endRound({ ...next, ...fresh }) : { ...next, ...fresh, turn: after } };
    }

    case "start": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (state.host !== playerId) return fail("Only whoever opened the table can start.");
      if (state.seats.length < CREW_MIN_PLAYERS) return fail("It takes at least two to play.");
      const pot = state.ante * state.seats.length;
      const seats = state.seats.map((s) => ({ ...s, contending: true, score: null, lost: null, hand: [] }));
      return { ok: true, state: { ...state, ...fresh, phase: "playing", seats, turn: 0, round: 1, pot, log: say(state, `The cup goes round. The pot is ${pot} gold.`) } };
    }

    case "roll": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      if (state.rolls >= CREW_ROLLS) return fail("You have no rolls left.");
      const rng = makeRng(state.rng);
      const loading = state.held >= CREW_NEEDS.length;
      let held = state.held;
      let dice: number[];
      let thrown: number[];
      if (loading) {
        // The cargo is in: the dice kept stay where they are, and the rest are rolled again in their places.
        const keep = new Set((action.keep ?? []).filter((k) => Number.isInteger(k) && k >= 0 && k < state.dice.length));
        if (keep.size >= state.dice.length) return fail("Keep fewer dice, or stand.");
        thrown = state.dice.map((_, i) => i).filter((i) => !keep.has(i));
        dice = state.dice.map((d, i) => (keep.has(i) ? d : rng.int(1, 6)));
      } else {
        // Still looking for the ship or the captain: every die not held is rolled.
        const rolled = Array.from({ length: CREW_DICE - state.held }, () => rng.int(1, 6));
        ({ held, dice } = crewHold(state.held, rolled));
        thrown = dice.map((_, i) => i);
      }
      const rolls = state.rolls + 1;
      const cargo = crewCargo(held, dice);
      const got = CREW_NEEDS.slice(state.held, held).map((n) => ({ 6: "ship", 5: "captain" })[n]);
      const krakens = cargo === null ? 0 : dice.filter((d) => d === CREW_KRAKEN).length;
      const rolledNow = loading ? thrown.map((i) => dice[i]) : [...CREW_NEEDS.slice(state.held, held), ...dice];
      const line = `${seat.name} rolls ${rolledNow.join(" ")}${got.length ? `: ${got.join(" and ")} in` : ""}${cargo !== null ? `. Cargo ${cargo}${krakens ? `, with ${krakens === 1 ? "a Kraken" : `${krakens} Krakens`}` : ""}.` : "."}`;
      // Out of rolls, or no better cargo to be had: the turn is over, and the Kraken has whatever it is still holding.
      const over = rolls >= CREW_ROLLS || cargo === CREW_MAX_CARGO;
      const kraken = over && crewKraken(held, dice);
      const lastThrow: CrewThrow = { n: (state.lastThrow?.n ?? 0) + 1, by: playerId, fresh: held - state.held, thrown, kraken };
      let next: CrewGame = { ...state, rolls, held, dice, lastThrow, rng: rng.state(), log: say(state, line) };
      if (!over) return { ok: true, state: next };
      if (cargo === null) next = { ...next, log: say(next, `${seat.name} never got a ship and a captain, and scores nothing.`) };
      else if (kraken) next = { ...next, log: say(next, `The Kraken takes ${seat.name}'s cargo.`) };
      return { ok: true, state: endTurn(next) };
    }

    case "stand": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const cargo = crewCargo(state.held, state.dice);
      if (cargo === null) return fail("You need a ship and a captain before you can stand.");
      if (crewKraken(state.held, state.dice)) return fail("Not with a Kraken in your cargo: roll it away first.");
      return { ok: true, state: endTurn({ ...state, log: say(state, `${seat.name} stands on ${cargo}.`) }) };
    }
  }
}

// ---------- what a player may see ----------

export interface CrewSeatView {
  id: string;
  name: string;
  contending: boolean;
  score: number | null;
  lost: CrewLoss | null;
  hand: number[];
  forfeited: boolean;
}

export interface CrewView {
  ante: number;
  phase: CrewGame["phase"];
  host: string;
  seats: CrewSeatView[];
  /** Player id of whose turn it is, while playing. */
  turn: string | null;
  rolls: number;
  held: number;
  dice: number[];
  /** The cargo the player on turn has now (Krakens counted at face), once ship and captain are in. */
  cargo: number | null;
  /** A Kraken is in that cargo. */
  kraken: boolean;
  round: number;
  last: CrewRoundResult | null;
  lastThrow: CrewThrow | null;
  winner: string | null;
  pot: number;
  /** What the winner takes from the pot once the house has had its cut. */
  prize: number;
  log: string[];
}

/** The table as anyone may see it: everything but the generator. */
export function crewView(state: CrewGame, viewerId?: string | null): CrewView {
  void viewerId;
  const playing = state.phase === "playing";
  return {
    ante: state.ante,
    phase: state.phase,
    host: state.host,
    seats: state.seats.map((s) => ({ id: s.id, name: s.name, contending: s.contending, score: s.score, lost: s.lost ?? null, hand: [...s.hand], forfeited: s.forfeited })),
    turn: playing ? state.seats[state.turn].id : null,
    rolls: state.rolls,
    held: state.held,
    dice: [...state.dice],
    cargo: playing ? crewCargo(state.held, state.dice) : null,
    kraken: playing && crewKraken(state.held, state.dice),
    round: state.round,
    last: state.last,
    lastThrow: state.lastThrow,
    winner: state.winner,
    pot: state.pot,
    prize: crewSplit(state.pot).prize,
    log: state.log,
  };
}

// ---------- wire types (carried inside the pub's messages) ----------

/** What a client may ask of the table. The server fills in names and checks gold. */
export type CrewRequest = { type: "open"; ante: number } | { type: "sit" } | { type: "leave" } | { type: "start" } | { type: "roll"; keep?: number[] } | { type: "stand" };
