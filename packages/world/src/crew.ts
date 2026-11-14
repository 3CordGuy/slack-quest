// Ship, Captain & Crew: the pub's third table game, the old tavern dice game,
// for two to six crewmates.
//
// On your turn you have up to three rolls of five dice. You need a 6 (the
// ship), then a 5 (the captain), then a 4 (the crew), in that order: each is
// set aside as soon as a roll turns it up, and a 5 is no use before the ship
// is in, nor a 4 before the captain. One roll can bring in all three. Once
// all three are in, the other two dice are your cargo, and any rolls you have
// left may go on rolling the cargo again to raise it, or you can stand on it.
// Never get the three and you score nothing.
//
// When everyone has had a turn, the highest cargo takes the pot, less the
// house's cut. A tie for the top is rolled off by those tied; if nobody
// scored, everyone still in goes again.
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
/** Ship, captain and crew, in the order they must come in. */
export const CREW_NEEDS = [6, 5, 4] as const;
/** The best cargo there is: two sixes. */
export const CREW_MAX_CARGO = 12;
/** The house's share of the pot, in percent, rounded down. */
export const CREW_HOUSE_PCT = 10;
const LOG_LINES = 8;

export interface CrewSeat {
  id: string;
  name: string;
  /** Still in the running this round: everyone at first, only those tied in a roll-off. */
  contending: boolean;
  /** This round's score once their turn is over (0 for no ship, captain and crew), or null before. */
  score: number | null;
  /** The five dice they last ended a turn on, held ones first. Empty before their first turn. */
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
  /** How many of ship, captain and crew are in this turn: 0 to 3. */
  held: number;
  /** The dice that are not held, as last rolled. Empty before the turn's first roll. */
  dice: number[];
  round: number;
  /** The last round's outcome, once there has been one. */
  last: CrewRoundResult | null;
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
  | { type: "roll" }
  /** Keep the cargo you have and end your turn. */
  | { type: "stand" };

export type CrewResult = { ok: true; state: CrewGame } | { ok: false; error: string };

export function crewSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * CREW_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isCrewAnte = (n: unknown): n is (typeof CREW_ANTES)[number] => (CREW_ANTES as readonly unknown[]).includes(n);

/** The cargo of a turn with ship, captain and crew in: the free dice added up. Null until all three are in. */
export const crewCargo = (held: number, dice: readonly number[]): number | null => (held >= CREW_NEEDS.length && dice.length > 0 ? dice.reduce((a, d) => a + d, 0) : null);

/**
 * Take ship, captain and crew out of a roll, in order, as far as it goes.
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

const newSeat = (id: string, name: string): CrewSeat => ({ id, name, contending: false, score: null, hand: [], forfeited: false });

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
  const line = result === "bust" ? "Nobody brought in a cargo. Everyone rolls again." : `${names.join(" and ")} tie on ${best}. They roll off.`;
  // Hands stay on the table, so everyone can see how the round went, until each player rolls again.
  const seats = state.seats.map((s) => ({ ...s, contending: top.includes(s.id), score: null }));
  const turn = nextDue(seats, 0);
  return { ...state, ...fresh, seats, turn, round: state.round + 1, last, log: say(state, line) };
}

/** The player on turn is done, on `score`, with these five dice: on to the next, or the end of the round. */
function endTurn(state: CrewGame, score: number, hand: number[]): CrewGame {
  const seats = state.seats.map((s, i) => (i === state.turn ? { ...s, score, hand } : s));
  const next = { ...state, ...fresh, seats };
  const ix = nextDue(seats, state.turn);
  return ix < 0 ? endRound(next) : { ...next, turn: ix };
}

/** The five dice a turn ends on, held ship, captain and crew first. */
const handOf = (held: number, dice: readonly number[]) => [...CREW_NEEDS.slice(0, held), ...dice];

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
      const seats = state.seats.map((s) => ({ ...s, contending: true, score: null, hand: [] }));
      return { ok: true, state: { ...state, ...fresh, phase: "playing", seats, turn: 0, round: 1, pot, log: say(state, `The cup goes round. The pot is ${pot} gold.`) } };
    }

    case "roll": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      if (state.rolls >= CREW_ROLLS) return fail("You have no rolls left.");
      const rng = makeRng(state.rng);
      const free = state.held >= CREW_NEEDS.length ? state.dice.length : CREW_DICE - state.held;
      const rolled = Array.from({ length: free }, () => rng.int(1, 6));
      const { held, dice } = crewHold(state.held, rolled);
      const rolls = state.rolls + 1;
      const cargo = crewCargo(held, dice);
      const got = CREW_NEEDS.slice(state.held, held).map((n) => ({ 6: "ship", 5: "captain", 4: "crew" })[n]);
      const line = `${seat.name} rolls ${rolled.join(" ")}${got.length ? `: ${got.join(", ")} in` : ""}${cargo !== null ? `. Cargo ${cargo}.` : "."}`;
      const next = { ...state, rolls, held, dice, rng: rng.state(), log: say(state, line) };
      // Out of rolls, or no better cargo to be had: the turn is over.
      if (rolls >= CREW_ROLLS || cargo === CREW_MAX_CARGO) {
        const done = cargo === null ? { ...next, log: say(next, `${seat.name} never found a full crew and scores nothing.`) } : next;
        return { ok: true, state: endTurn(done, cargo ?? 0, handOf(held, dice)) };
      }
      return { ok: true, state: next };
    }

    case "stand": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const cargo = crewCargo(state.held, state.dice);
      if (cargo === null) return fail("You need a ship, a captain and a crew before you can stand.");
      return { ok: true, state: endTurn({ ...state, log: say(state, `${seat.name} stands on ${cargo}.`) }, cargo, handOf(state.held, state.dice)) };
    }
  }
}

// ---------- what a player may see ----------

export interface CrewSeatView {
  id: string;
  name: string;
  contending: boolean;
  score: number | null;
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
  /** The cargo the player on turn has now, once ship, captain and crew are in. */
  cargo: number | null;
  round: number;
  last: CrewRoundResult | null;
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
    seats: state.seats.map((s) => ({ id: s.id, name: s.name, contending: s.contending, score: s.score, hand: [...s.hand], forfeited: s.forfeited })),
    turn: playing ? state.seats[state.turn].id : null,
    rolls: state.rolls,
    held: state.held,
    dice: [...state.dice],
    cargo: playing ? crewCargo(state.held, state.dice) : null,
    round: state.round,
    last: state.last,
    winner: state.winner,
    pot: state.pot,
    prize: crewSplit(state.pot).prize,
    log: state.log,
  };
}

// ---------- wire types (carried inside the pub's messages) ----------

/** What a client may ask of the table. The server fills in names and checks gold. */
export type CrewRequest = { type: "open"; ante: number } | { type: "sit" } | { type: "leave" } | { type: "start" } | { type: "roll" } | { type: "stand" };
