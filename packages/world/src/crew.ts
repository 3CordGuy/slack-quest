// Cargo and Krakens: the pub's third table game, a push-your-luck take
// on the old tavern dice game Ship, Captain & Crew, for two to six.
//
// On your turn you have up to three rolls of five dice. First you need a 6,
// the ship: until one comes up nothing else counts, and the first 6 to come
// up is set aside. The other four dice are then yours to play with: keep the
// ones you like and roll the rest again with any rolls left, or stand. A die
// you hold stays held from roll to roll until you let it go.
//
// Among those four you need a 5, the captain. Your cargo is the pip dice
// beside it, the 2s, 3s and 4s, added up for your score (twelve at best): a
// second ship or a second captain carries nothing. You need not keep the
// captain first: land good cargo and gamble your last rolls on a 5 turning
// up. End without a captain and you score nothing.
//
// A 1 is the Kraken. Roll one and you can roll it again, but if a Kraken is
// still among your dice when your rolls run out, it takes the lot and you
// score nothing; and you cannot stand with one showing. So every die you roll
// again might raise your score, bring in your captain, or sink you.
//
// A table is opened for a number of rounds (three unless the opener picks
// otherwise), each a turn for everyone, and each round's cargo adds to a
// running total. After the last round the highest total takes the pot, less
// the house's cut. A tie for the top is rolled off by those tied, a round at
// a time, on that round's cargo alone; if nobody has scored, everyone still in
// goes again.
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
/** How many rounds a table can be opened for, and how many unless the opener says. */
export const CREW_ROUND_CHOICES = [1, 3, 5] as const;
export const CREW_DEFAULT_ROUNDS = 3;
/** The rounds asked for, if they are one of the choices; otherwise the default. */
export const crewRounds = (n: unknown): number => ((CREW_ROUND_CHOICES as readonly unknown[]).includes(n) ? (n as number) : CREW_DEFAULT_ROUNDS);
/** Dice in a roll, and rolls in a turn. */
export const CREW_DICE = 5;
export const CREW_ROLLS = 3;
/** What is set aside as it comes up before anything else counts: the ship. */
export const CREW_NEEDS = [6] as const;
/** The face that is the captain: one is needed among the dice after the ship. */
export const CREW_CAPTAIN = 5;
/** The face that is the Kraken, once the ship is in. */
export const CREW_KRAKEN = 1;
/** The faces that are cargo: the plain pip dice. A ship, a captain or a Kraken beyond the ones that count carries nothing. */
export const CREW_CARGO_FACES = [2, 3, 4] as const;
export const isCrewCargo = (d: number): boolean => (CREW_CARGO_FACES as readonly number[]).includes(d);
/** The best cargo there is: three 4s beside the captain. */
export const CREW_MAX_CARGO = 12;
/** The house's share of the pot, in percent, rounded down. */
export const CREW_HOUSE_PCT = 10;
const LOG_LINES = 8;

/** Why a turn scored nothing: no ship, no captain, the Kraken took the cargo, or a captain with no pip dice beside it. */
export type CrewLoss = "adrift" | "captainless" | "kraken" | "empty";

export interface CrewSeat {
  id: string;
  name: string;
  /** Still in the running this round: everyone at first, only those tied in a roll-off. */
  contending: boolean;
  /** This round's score once their turn is over (0 for nothing), or null before. */
  score: number | null;
  /** The cargo of the rounds played so far, added up (roll-offs aside). Missing in games saved before rounds. */
  total?: number;
  /** Why it was 0, when it was. */
  lost?: CrewLoss | null;
  /** The five dice they last ended a turn on, the ship first. Empty before their first turn. */
  hand: number[];
  /** Left mid-game. */
  forfeited: boolean;
}

/** How a round came out, for everyone to see. */
export interface CrewRoundResult {
  round: number;
  scores: { id: string; score: number }[];
  /** "next": more rounds to come, and `ids` lead on totals. "win": `ids` holds the winner. "tie": `ids` are rolling off. "bust": nobody scored, so all of `ids` go again. */
  result: "next" | "win" | "tie" | "bust";
  ids: string[];
}

/** One roll, for the table to show: who threw, whether it brought in the ship, which of the dice after the ship were thrown, and whether the Kraken ended the turn. */
export interface CrewThrow {
  n: number;
  by: string;
  fresh: number;
  /** Indexes into `dice` that were thrown; the rest were kept. */
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
  /** Whether the ship is in this turn: 0 or 1. */
  held: number;
  /** The dice that are not held, as last rolled. Once the ship is in, the four that make the captain and cargo, each in its place. Empty before the turn's first roll. */
  dice: number[];
  /** Indexes into `dice` held back on the last roll this turn, so the table can show them held and carry them into the next roll. Missing in games saved before holds were recorded. */
  kept?: number[];
  round: number;
  /** The last round's outcome, once there has been one. */
  last: CrewRoundResult | null;
  /** The latest roll of the game, numbered from 1. For the table to animate, even a roll that ended a turn. */
  lastThrow: CrewThrow | null;
  winner: string | null;
  /** How many rounds are played before the totals decide it; after that, any round is a roll-off. Missing in games saved before rounds: one. */
  rounds?: number;
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
  /** Roll. Once the ship is in, `keep` lists the dice (by index) to hold back; the rest are rolled again. */
  | { type: "roll"; keep?: number[] }
  /** Keep the cargo you have and end your turn. */
  | { type: "stand" };

export type CrewResult = { ok: true; state: CrewGame } | { ok: false; error: string };

export function crewSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * CREW_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isCrewAnte = (n: unknown): n is (typeof CREW_ANTES)[number] => (CREW_ANTES as readonly unknown[]).includes(n);

/** The ship is in and a captain is among the dice after it. */
export const crewCaptain = (held: number, dice: readonly number[]): boolean => held >= CREW_NEEDS.length && dice.includes(CREW_CAPTAIN);

/** The cargo: the pip dice (2 to 4) after the ship, added up. Null without ship and captain. */
export const crewCargo = (held: number, dice: readonly number[]): number | null => (crewCaptain(held, dice) ? dice.filter(isCrewCargo).reduce((a, d) => a + d, 0) : null);

/** A Kraken is among the dice after the ship. */
export const crewKraken = (held: number, dice: readonly number[]): boolean => held >= CREW_NEEDS.length && dice.includes(CREW_KRAKEN);

/** What a turn ending now would score: the cargo, unless there is no ship, no captain, the Kraken has it, or there is none. */
export function crewScore(held: number, dice: readonly number[]): { score: number; lost: CrewLoss | null } {
  if (held < CREW_NEEDS.length) return { score: 0, lost: "adrift" };
  if (crewKraken(held, dice)) return { score: 0, lost: "kraken" };
  const cargo = crewCargo(held, dice);
  if (cargo === null) return { score: 0, lost: "captainless" };
  if (cargo === 0) return { score: 0, lost: "empty" };
  return { score: cargo, lost: null };
}

/**
 * Take the ship out of a roll, if it is not in yet and the roll has one.
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

const newSeat = (id: string, name: string): CrewSeat => ({ id, name, contending: false, score: null, total: 0, lost: null, hand: [], forfeited: false });

/** A fresh table with its opener in the first seat, to be played over `rounds` rounds. */
export function createCrewGame(seed: number, ante: number, host: { id: string; name: string }, rounds: number = CREW_DEFAULT_ROUNDS): CrewGame {
  return {
    ante,
    phase: "open",
    host: host.id,
    seats: [newSeat(host.id, host.name)],
    turn: 0,
    rolls: 0,
    held: 0,
    dice: [],
    kept: [],
    round: 0,
    last: null,
    lastThrow: null,
    winner: null,
    rounds,
    pot: 0,
    log: [`${host.name} set out the dice cup at ${ante} gold a seat, for ${rounds === 1 ? "one round" : `${rounds} rounds`}.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): CrewResult => ({ ok: false, error });
const say = (state: CrewGame, line: string): string[] => [...state.log, line].slice(-LOG_LINES);
/** Still to play this round. */
const due = (s: CrewSeat) => s.contending && !s.forfeited && s.score === null;
const fresh = { rolls: 0, held: 0, dice: [] as number[], kept: [] as number[] };

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
  const rounds = state.rounds ?? 1;
  // One of the rounds the table was opened for, not a roll-off after them.
  const regular = state.round <= rounds;
  const runners = state.seats.filter((s) => s.contending && !s.forfeited);
  const ran = new Set(runners.map((s) => s.id));
  const scores = runners.map((s) => ({ id: s.id, score: s.score ?? 0 }));
  // Each of the table's rounds adds its cargo to everyone's total; a roll-off counts on its own.
  const counted = regular ? state.seats.map((s) => (ran.has(s.id) ? { ...s, total: (s.total ?? 0) + (s.score ?? 0) } : s)) : state.seats;
  const marks = counted.filter((s) => ran.has(s.id)).map((s) => ({ id: s.id, n: regular ? (s.total ?? 0) : (s.score ?? 0) }));
  const best = Math.max(0, ...marks.map((m) => m.n));
  const top = best > 0 ? marks.filter((m) => m.n === best).map((m) => m.id) : marks.map((m) => m.id);
  const names = (ids: string[]) => state.seats.filter((s) => ids.includes(s.id)).map((s) => s.name).join(" and ");
  if (regular && state.round < rounds) {
    // More rounds to come: everyone still in plays again, their totals carried.
    const last: CrewRoundResult = { round: state.round, scores, result: "next", ids: best > 0 ? top : [] };
    const lead = best > 0 ? `${names(top)} ${top.length > 1 ? "lead" : "leads"} with ${best}.` : "Nobody has brought a cargo home yet.";
    const seats = counted.map((s) => ({ ...s, score: null, lost: null }));
    const turn = nextDue(seats, 0);
    return { ...state, ...fresh, seats, turn, round: state.round + 1, last, log: say(state, `Round ${state.round} of ${rounds} is over. ${lead}`) };
  }
  const result: CrewRoundResult["result"] = best === 0 ? "bust" : top.length === 1 ? "win" : "tie";
  const last: CrewRoundResult = { round: state.round, scores, result, ids: top };
  if (result === "win") return win({ ...state, seats: counted, last }, top[0]);
  const line = result === "bust" ? "Nobody brought a cargo home. Everyone rolls again." : `${names(top)} tie on ${best}. They roll off.`;
  // Hands stay on the table, so everyone can see how the round went, until each player rolls again.
  const seats = counted.map((s) => ({ ...s, contending: top.includes(s.id), score: null, lost: null }));
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
      const seats = state.seats.map((s) => ({ ...s, contending: true, score: null, total: 0, lost: null, hand: [] }));
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
      let kept: number[] = [];
      if (loading) {
        // The ship is in: the dice kept stay where they are, and the rest are rolled again in their places.
        const keep = new Set((action.keep ?? []).filter((k) => Number.isInteger(k) && k >= 0 && k < state.dice.length));
        if (keep.size >= state.dice.length) return fail("Keep fewer dice, or stand.");
        if ([...keep].some((k) => state.dice[k] === CREW_KRAKEN)) return fail("You cannot hold a Kraken: it has to be rolled away.");
        kept = [...keep].sort((a, b) => a - b);
        thrown = state.dice.map((_, i) => i).filter((i) => !keep.has(i));
        dice = state.dice.map((d, i) => (keep.has(i) ? d : rng.int(1, 6)));
      } else {
        // Still looking for the ship: every die is rolled.
        const rolled = Array.from({ length: CREW_DICE - state.held }, () => rng.int(1, 6));
        ({ held, dice } = crewHold(state.held, rolled));
        thrown = dice.map((_, i) => i);
      }
      const rolls = state.rolls + 1;
      const cargo = crewCargo(held, dice);
      const shipIn = held > state.held;
      const krakens = held < CREW_NEEDS.length ? 0 : dice.filter((d) => d === CREW_KRAKEN).length;
      const rolledNow = loading ? thrown.map((i) => dice[i]) : [...CREW_NEEDS.slice(state.held, held), ...dice];
      const aboard = held < CREW_NEEDS.length ? "" : cargo !== null ? `. Cargo ${cargo}` : ". No captain yet";
      const line = `${seat.name} rolls ${rolledNow.join(" ")}${shipIn ? ": the ship is in" : ""}${aboard}${krakens ? `, with ${krakens === 1 ? "a Kraken" : `${krakens} Krakens`}` : ""}.`;
      // Out of rolls, or no better cargo to be had: the turn is over, and the Kraken has whatever it is still holding.
      const over = rolls >= CREW_ROLLS || cargo === CREW_MAX_CARGO;
      const kraken = over && crewKraken(held, dice);
      const lastThrow: CrewThrow = { n: (state.lastThrow?.n ?? 0) + 1, by: playerId, fresh: held - state.held, thrown, kraken };
      let next: CrewGame = { ...state, rolls, held, dice, kept, lastThrow, rng: rng.state(), log: say(state, line) };
      if (!over) return { ok: true, state: next };
      const { lost } = crewScore(held, dice);
      if (lost === "adrift") next = { ...next, log: say(next, `${seat.name} never got a ship, and scores nothing.`) };
      else if (lost === "kraken") next = { ...next, log: say(next, `The Kraken takes ${seat.name}'s cargo.`) };
      else if (lost === "captainless") next = { ...next, log: say(next, `${seat.name} has no captain, and the cargo goes nowhere.`) };
      else if (lost === "empty") next = { ...next, log: say(next, `${seat.name} has a captain but an empty hold.`) };
      return { ok: true, state: endTurn(next) };
    }

    case "stand": {
      if (state.phase !== "playing") return fail("No game is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const cargo = crewCargo(state.held, state.dice);
      if (state.held < CREW_NEEDS.length) return fail("You need a ship before you can stand.");
      if (crewKraken(state.held, state.dice)) return fail("Not with a Kraken among your dice: roll it away first.");
      if (cargo === null) return fail("You need a captain (a 5) before you can stand.");
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
  /** The cargo of the table's rounds played so far, added up. */
  total: number;
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
  /** Indexes into `dice` the player on turn held back on their last roll: shown held, and held again next roll unless they let them go. */
  kept: number[];
  /** The cargo the player on turn has now (Krakens counted at face), once they have a ship and a captain. */
  cargo: number | null;
  /** The player on turn has a captain among their dice. */
  captain: boolean;
  /** A Kraken is among their dice. */
  kraken: boolean;
  round: number;
  /** How many rounds the table was opened for; a round after those is a roll-off. */
  rounds: number;
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
    seats: state.seats.map((s) => ({ id: s.id, name: s.name, contending: s.contending, score: s.score, total: s.total ?? 0, lost: s.lost ?? null, hand: [...s.hand], forfeited: s.forfeited })),
    turn: playing ? state.seats[state.turn].id : null,
    rolls: state.rolls,
    held: state.held,
    dice: [...state.dice],
    kept: playing ? [...(state.kept ?? [])] : [],
    cargo: playing ? crewCargo(state.held, state.dice) : null,
    captain: playing && crewCaptain(state.held, state.dice),
    kraken: playing && crewKraken(state.held, state.dice),
    round: state.round,
    rounds: state.rounds ?? 1,
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
export type CrewRequest = { type: "open"; ante: number; rounds?: number } | { type: "sit" } | { type: "leave" } | { type: "start" } | { type: "roll"; keep?: number[] } | { type: "stand" };
