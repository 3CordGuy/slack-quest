// Cargo and Krakens: the pub's third table game, a push-your-luck take
// on the old tavern dice game Ship, Captain & Crew, for two to six.
//
// Everyone plays each round at once, each with their own dice: up to three
// rolls of five. First you need a 6,
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
// otherwise), each played by everyone at once, and each round's cargo adds to a
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
import { isStake, potText, prizeText, stakeText } from "./stakes";

export const CREW_MIN_PLAYERS = 2;
export const CREW_MAX_PLAYERS = 6;
/** How many rounds a table can be opened for, and how many unless the opener says. */
export const CREW_ROUND_CHOICES = [1, 3, 5] as const;
export const CREW_DEFAULT_ROUNDS = 3;
/** The rounds asked for, if they are one of the choices; otherwise the default. */
export const crewRounds = (n: unknown): number => ((CREW_ROUND_CHOICES as readonly unknown[]).includes(n) ? (n as number) : CREW_DEFAULT_ROUNDS);
/** Dice in a roll, and rolls in a round. */
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

/** Why a round scored nothing: no ship, no captain, the Kraken took the cargo, or a captain with no pip dice beside it. */
export type CrewLoss = "adrift" | "captainless" | "kraken" | "empty";

/** One player's dice in the round under way. Everyone plays at once, so each seat keeps its own. */
export interface CrewPlay {
  /** Rolls used so far this round. */
  rolls: number;
  /** Whether the ship is in: 0 or 1. */
  held: number;
  /** The dice not taken as the ship, as last rolled. Once the ship is in, the four that make the captain and cargo, each in its place. Empty before the first roll. */
  dice: number[];
  /** Indexes into `dice` held back on the last roll, carried into the next unless let go. */
  kept: number[];
}
const noPlay = (): CrewPlay => ({ rolls: 0, held: 0, dice: [], kept: [] });

export interface CrewSeat {
  id: string;
  name: string;
  /** Still in the running this round: everyone at first, only those tied in a roll-off. */
  contending: boolean;
  /** This round's score once their play is over (0 for nothing), or null before. */
  score: number | null;
  /** The cargo of the rounds played so far, added up (roll-offs aside). Missing in games saved before rounds. */
  total?: number;
  /** Why it was 0, when it was. */
  lost?: CrewLoss | null;
  /** The five dice they last finished a round on, the ship first. Empty before their first. */
  hand: number[];
  /** Left mid-game. */
  forfeited: boolean;
  /** Their dice this round while they play. Missing in games saved before everyone played at once. */
  play?: CrewPlay;
}

/** How a round came out, for everyone to see. */
export interface CrewRoundResult {
  round: number;
  scores: { id: string; score: number }[];
  /** "next": more rounds to come, and `ids` lead on totals. "win": `ids` holds the winner. "tie": `ids` are rolling off. "bust": nobody scored, so all of `ids` go again. */
  result: "next" | "win" | "tie" | "bust";
  ids: string[];
}

/** One roll, for the table to show: who threw, whether it brought in the ship, which of the dice after the ship were thrown, and whether the Kraken ended their round. */
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
  round: number;
  /** The last round's outcome, once there has been one. */
  last: CrewRoundResult | null;
  /** The latest roll of the game, anyone's, numbered from 1. For the table to animate, even a roll that ended someone's round. */
  lastThrow: CrewThrow | null;
  winner: string | null;
  /** How many rounds are played before the totals decide it; after that, any round is a roll-off. Missing in games saved before rounds: one. */
  rounds?: number;
  /** Gold anted, set when the game starts. */
  pot: number;
  log: string[];
  /** Seeded generator state. Never sent to a client: it would give away every future roll. */
  rng: number;
  /** Games saved when players took turns kept the one player's dice here, with whose turn it was. `upgrade` moves them onto that seat. */
  turn?: number;
  rolls?: number;
  held?: number;
  dice?: number[];
  kept?: number[];
}

export type CrewAction =
  | { type: "sit"; name: string }
  /** Before the start: give up the seat. During play: forfeit. */
  | { type: "leave" }
  | { type: "start" }
  /** Roll. Once the ship is in, `keep` lists the dice (by index) to hold back; the rest are rolled again. */
  | { type: "roll"; keep?: number[] }
  /** Keep the cargo you have and finish your round. */
  | { type: "stand" };

export type CrewResult = { ok: true; state: CrewGame } | { ok: false; error: string };

export function crewSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * CREW_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

/** Free, or any whole stake up to STAKE_MAX (see stakes.ts). */
export const isCrewAnte = isStake;

/** The ship is in and a captain is among the dice after it. */
export const crewCaptain = (held: number, dice: readonly number[]): boolean => held >= CREW_NEEDS.length && dice.includes(CREW_CAPTAIN);

/** The cargo: the pip dice (2 to 4) after the ship, added up. Null without ship and captain. */
export const crewCargo = (held: number, dice: readonly number[]): number | null => (crewCaptain(held, dice) ? dice.filter(isCrewCargo).reduce((a, d) => a + d, 0) : null);

/** A Kraken is among the dice after the ship. */
export const crewKraken = (held: number, dice: readonly number[]): boolean => held >= CREW_NEEDS.length && dice.includes(CREW_KRAKEN);

/** What a round finished now would score: the cargo, unless there is no ship, no captain, the Kraken has it, or there is none. */
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

const newSeat = (id: string, name: string): CrewSeat => ({ id, name, contending: false, score: null, total: 0, lost: null, hand: [], forfeited: false, play: noPlay() });

/** A game saved when players took turns: the dice of whoever was on turn go onto their seat, and everyone else starts this round fresh. */
function upgrade(state: CrewGame): CrewGame {
  if (state.seats.every((s) => s.play) && state.turn === undefined) return state;
  const { turn, rolls, held, dice, kept, ...rest } = state;
  const seats = state.seats.map((s, i): CrewSeat =>
    s.play ? s : { ...s, play: i === turn && state.phase === "playing" ? { rolls: rolls ?? 0, held: held ?? 0, dice: [...(dice ?? [])], kept: [...(kept ?? [])] } : noPlay() },
  );
  return { ...rest, seats };
}

/** A fresh table with its opener in the first seat, to be played over `rounds` rounds. */
export function createCrewGame(seed: number, ante: number, host: { id: string; name: string }, rounds: number = CREW_DEFAULT_ROUNDS): CrewGame {
  return {
    ante,
    phase: "open",
    host: host.id,
    seats: [newSeat(host.id, host.name)],
    round: 0,
    last: null,
    lastThrow: null,
    winner: null,
    rounds,
    pot: 0,
    log: [`${host.name} set out the dice cup at ${stakeText(ante)}, for ${rounds === 1 ? "one round" : `${rounds} rounds`}.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): CrewResult => ({ ok: false, error });
const say = (state: CrewGame, line: string): string[] => [...state.log, line].slice(-LOG_LINES);
/** Still to play this round. */
const due = (s: CrewSeat) => s.contending && !s.forfeited && s.score === null;

/** Only one player is left in the running: they take the pot. */
function win(state: CrewGame, id: string): CrewGame {
  const seat = state.seats.find((s) => s.id === id)!;
  const { prize } = crewSplit(state.pot);
  return { ...state, phase: "done", winner: id, log: say(state, `${seat.name} wins ${prizeText(prize)}.`) };
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
    const seats = counted.map((s) => ({ ...s, score: null, lost: null, play: noPlay() }));
    return { ...state, seats, round: state.round + 1, last, log: say(state, `Round ${state.round} of ${rounds} is over. ${lead}`) };
  }
  const result: CrewRoundResult["result"] = best === 0 ? "bust" : top.length === 1 ? "win" : "tie";
  const last: CrewRoundResult = { round: state.round, scores, result, ids: top };
  if (result === "win") return win({ ...state, seats: counted, last }, top[0]);
  const line = result === "bust" ? "Nobody brought a cargo home. Everyone rolls again." : `${names(top)} tie on ${best}. They roll off.`;
  // Hands stay on the table, so everyone can see how the round went, until each player rolls again.
  const seats = counted.map((s) => ({ ...s, contending: top.includes(s.id), score: null, lost: null, play: noPlay() }));
  return { ...state, seats, round: state.round + 1, last, log: say(state, line) };
}

/** A player's round is over: score their dice, and settle the round once nobody is left to play. */
function finish(state: CrewGame, ix: number): CrewGame {
  const p = state.seats[ix].play ?? noPlay();
  const { score, lost } = crewScore(p.held, p.dice);
  const hand = [...CREW_NEEDS.slice(0, p.held), ...p.dice];
  const seats = state.seats.map((s, i) => (i === ix ? { ...s, score, lost, hand, play: noPlay() } : s));
  const next = { ...state, seats };
  return seats.some(due) ? next : endRound(next);
}

/** Why a seated player cannot roll or stand just now, if they cannot. */
function cannotPlay(state: CrewGame, seat: CrewSeat | undefined): string | null {
  if (state.phase !== "playing") return "No game is being played.";
  if (!seat) return "You are not at the table.";
  if (seat.forfeited || !seat.contending) return "You are out of this round.";
  if (seat.score !== null) return "You have played this round: wait for the others.";
  return null;
}

export function stepCrew(saved: CrewGame, playerId: string, action: CrewAction): CrewResult {
  const state = upgrade(saved);
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
      // If they were the last still playing, the round is over.
      return { ok: true, state: seats.some(due) ? next : endRound(next) };
    }

    case "start": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (state.host !== playerId) return fail("Only whoever opened the table can start.");
      if (state.seats.length < CREW_MIN_PLAYERS) return fail("It takes at least two to play.");
      const pot = state.ante * state.seats.length;
      const seats = state.seats.map((s) => ({ ...s, contending: true, score: null, total: 0, lost: null, hand: [], play: noPlay() }));
      return { ok: true, state: { ...state, phase: "playing", seats, round: 1, pot, log: say(state, `Everyone has a cup. ${potText(pot)}`) } };
    }

    case "roll": {
      const why = cannotPlay(state, seat);
      if (why || !seat) return fail(why ?? "You are not at the table.");
      const p = seat.play ?? noPlay();
      if (p.rolls >= CREW_ROLLS) return fail("You have no rolls left.");
      const rng = makeRng(state.rng);
      const loading = p.held >= CREW_NEEDS.length;
      let held = p.held;
      let dice: number[];
      let thrown: number[];
      let kept: number[] = [];
      if (loading) {
        // The ship is in: the dice kept stay where they are, and the rest are rolled again in their places.
        const keep = new Set((action.keep ?? []).filter((k) => Number.isInteger(k) && k >= 0 && k < p.dice.length));
        if (keep.size >= p.dice.length) return fail("Keep fewer dice, or stand.");
        if ([...keep].some((k) => p.dice[k] === CREW_KRAKEN)) return fail("You cannot hold a Kraken: it has to be rolled away.");
        kept = [...keep].sort((a, b) => a - b);
        thrown = p.dice.map((_, i) => i).filter((i) => !keep.has(i));
        dice = p.dice.map((d, i) => (keep.has(i) ? d : rng.int(1, 6)));
      } else {
        // Still looking for the ship: every die is rolled.
        const rolled = Array.from({ length: CREW_DICE - p.held }, () => rng.int(1, 6));
        ({ held, dice } = crewHold(p.held, rolled));
        thrown = dice.map((_, i) => i);
      }
      const rolls = p.rolls + 1;
      const cargo = crewCargo(held, dice);
      const shipIn = held > p.held;
      const krakens = held < CREW_NEEDS.length ? 0 : dice.filter((d) => d === CREW_KRAKEN).length;
      const rolledNow = loading ? thrown.map((i) => dice[i]) : [...CREW_NEEDS.slice(p.held, held), ...dice];
      const aboard = held < CREW_NEEDS.length ? "" : cargo !== null ? `. Cargo ${cargo}` : ". No captain yet";
      const line = `${seat.name} rolls ${rolledNow.join(" ")}${shipIn ? ": the ship is in" : ""}${aboard}${krakens ? `, with ${krakens === 1 ? "a Kraken" : `${krakens} Krakens`}` : ""}.`;
      // Out of rolls, or no better cargo to be had: their round is over, and the Kraken has whatever it is still holding.
      const over = rolls >= CREW_ROLLS || cargo === CREW_MAX_CARGO;
      const kraken = over && crewKraken(held, dice);
      const lastThrow: CrewThrow = { n: (state.lastThrow?.n ?? 0) + 1, by: playerId, fresh: held - p.held, thrown, kraken };
      const seats = state.seats.map((s, i) => (i === ix ? { ...s, play: { rolls, held, dice, kept } } : s));
      let next: CrewGame = { ...state, seats, lastThrow, rng: rng.state(), log: say(state, line) };
      if (!over) return { ok: true, state: next };
      const { lost } = crewScore(held, dice);
      if (lost === "adrift") next = { ...next, log: say(next, `${seat.name} never got a ship, and scores nothing.`) };
      else if (lost === "kraken") next = { ...next, log: say(next, `The Kraken takes ${seat.name}'s cargo.`) };
      else if (lost === "captainless") next = { ...next, log: say(next, `${seat.name} has no captain, and the cargo goes nowhere.`) };
      else if (lost === "empty") next = { ...next, log: say(next, `${seat.name} has a captain but an empty hold.`) };
      return { ok: true, state: finish(next, ix) };
    }

    case "stand": {
      const why = cannotPlay(state, seat);
      if (why || !seat) return fail(why ?? "You are not at the table.");
      const p = seat.play ?? noPlay();
      const cargo = crewCargo(p.held, p.dice);
      if (p.held < CREW_NEEDS.length) return fail("You need a ship before you can stand.");
      if (crewKraken(p.held, p.dice)) return fail("Not with a Kraken among your dice: roll it away first.");
      if (cargo === null) return fail("You need a captain (a 5) before you can stand.");
      return { ok: true, state: finish({ ...state, log: say(state, `${seat.name} stands on ${cargo}.`) }, ix) };
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
  /** Still to play this round. */
  due: boolean;
  /** Their dice this round while they play (no rolls yet, or their round over: empty). Everyone sees everyone's. */
  play: CrewPlay;
}

export interface CrewView {
  ante: number;
  phase: CrewGame["phase"];
  host: string;
  seats: CrewSeatView[];
  /** Who is still to play this round, while playing. Everyone plays at once. */
  due: string[];
  /** The viewer's own dice this round (all empty if they are not playing it): rolls used, whether the ship is in, the other dice, and those held back on their last roll. */
  rolls: number;
  held: number;
  dice: number[];
  kept: number[];
  /** The viewer's cargo now, once they have a ship and a captain. */
  cargo: number | null;
  /** The viewer has a captain among their dice. */
  captain: boolean;
  /** A Kraken is among the viewer's dice. */
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

/** The table as `viewerId` sees it: everything but the generator, with their own dice at the top. */
export function crewView(saved: CrewGame, viewerId?: string | null): CrewView {
  const state = upgrade(saved);
  const playing = state.phase === "playing";
  const playOf = (s: CrewSeat): CrewPlay => {
    const p = playing && due(s) ? (s.play ?? noPlay()) : noPlay();
    return { rolls: p.rolls, held: p.held, dice: [...p.dice], kept: [...p.kept] };
  };
  const mine = state.seats.find((s) => s.id === viewerId);
  const own = mine ? playOf(mine) : noPlay();
  return {
    ante: state.ante,
    phase: state.phase,
    host: state.host,
    seats: state.seats.map((s) => ({ id: s.id, name: s.name, contending: s.contending, score: s.score, total: s.total ?? 0, lost: s.lost ?? null, hand: [...s.hand], forfeited: s.forfeited, due: playing && due(s), play: playOf(s) })),
    due: playing ? state.seats.filter(due).map((s) => s.id) : [],
    ...own,
    cargo: playing && mine ? crewCargo(own.held, own.dice) : null,
    captain: playing && crewCaptain(own.held, own.dice),
    kraken: playing && crewKraken(own.held, own.dice),
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
