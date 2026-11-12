// Shoals: the pub's second table game, for two to four crewmates.
//
// Every pilot holds four markers: three Channels (safe water) and one Shoal.
// A round has three parts.
//   Laying: in turn, each pilot lays a marker face down on their own stack.
//     Once everyone has laid at least one, a pilot may open the bidding
//     instead of laying another.
//   Bidding: "I can sail N": a claim to turn over N markers without
//     striking a Shoal. The others raise or pass. The last bidder sails.
//   Sailing: the bidder turns markers over one at a time: all of their own
//     stack first, then the top of anyone else's, their choice.
// Turn over N Channels and the run is clear: that is a passage, and two
// passages win. Strike a Shoal and you are aground: you lose one of your
// markers at random for the rest of the game. A pilot with no markers is
// out, and the last pilot afloat also wins. The winner takes the pot, less
// the house's cut.
//
// This file is the whole game as a pure reducer. The PubRoom Durable Object
// owns the state, moves the gold, and only ever sends a player the
// `shoalsView` of it, so nobody is told what is face down in another stack.

import { makeRng } from "./rng";

export const SHOALS_ANTES = [5, 10, 20] as const;
export const SHOALS_MIN_PLAYERS = 2;
export const SHOALS_MAX_PLAYERS = 4;
/** Markers each pilot starts with. */
export const SHOALS_START = { channel: 3, shoal: 1 } as const;
/** Clear runs needed to win. */
export const SHOALS_PASSAGES = 2;
/** The house's share of the pot, in percent, rounded down. */
export const SHOALS_HOUSE_PCT = 10;
const LOG_LINES = 8;

export type Marker = "channel" | "shoal";

export interface ShoalsSeat {
  id: string;
  name: string;
  /** Markers this pilot still owns, wherever they are. Zero of both once they are out. */
  own: Record<Marker, number>;
  /** Laid this round, bottom first. Hidden from the others until turned over. */
  stack: Marker[];
  /** How many of the stack, counted from the top, have been turned over. */
  flipped: number;
  passages: number;
  /** Dropped out of this round's bidding. */
  passed: boolean;
  /** Left mid-game rather than running out of markers. */
  forfeited: boolean;
}

/** How the last round ended, for everyone to see. */
export interface ShoalsOutcome {
  pilot: string;
  bid: number;
  /** "clear": the run was made. "aground": a Shoal was struck, in `at`'s stack. "void": someone left the table. */
  result: "clear" | "aground" | "void";
  at?: string;
}

export interface ShoalsGame {
  ante: number;
  /** open: seats are filling. playing: markers are down. done: someone won. */
  phase: "open" | "playing" | "done";
  host: string;
  seats: ShoalsSeat[];
  step: "lay" | "bid" | "sail";
  /** Index into `seats` of whose turn it is. */
  turn: number;
  /** The standing bid, once bidding has opened. */
  bid: { by: string; count: number } | null;
  /** Channels turned over so far in this sailing. */
  sailed: number;
  round: number;
  last: ShoalsOutcome | null;
  winner: string | null;
  /** Gold anted, set when the game starts. */
  pot: number;
  log: string[];
  /** Seeded generator state. Never sent to a client. */
  rng: number;
}

export type ShoalsAction =
  | { type: "sit"; name: string }
  /** Before the start: give up the seat. During play: forfeit. */
  | { type: "leave" }
  | { type: "start" }
  | { type: "lay"; marker: Marker }
  | { type: "bid"; count: number }
  | { type: "pass" }
  /** Turn over the top face-down marker of this pilot's stack. */
  | { type: "flip"; seat: string };

export type ShoalsResult = { ok: true; state: ShoalsGame } | { ok: false; error: string };

export function shoalsSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * SHOALS_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isShoalsAnte = (n: unknown): n is (typeof SHOALS_ANTES)[number] => (SHOALS_ANTES as readonly unknown[]).includes(n);

const newSeat = (id: string, name: string): ShoalsSeat => ({ id, name, own: { channel: 0, shoal: 0 }, stack: [], flipped: 0, passages: 0, passed: false, forfeited: false });

/** A fresh table with its opener in the first seat. */
export function createShoalsGame(seed: number, ante: number, host: { id: string; name: string }): ShoalsGame {
  return {
    ante,
    phase: "open",
    host: host.id,
    seats: [newSeat(host.id, host.name)],
    step: "lay",
    turn: 0,
    bid: null,
    sailed: 0,
    round: 0,
    last: null,
    winner: null,
    pot: 0,
    log: [`${host.name} set out the markers at ${ante} gold a seat.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): ShoalsResult => ({ ok: false, error });
const owned = (s: ShoalsSeat) => s.own.channel + s.own.shoal;
const afloat = (s: ShoalsSeat) => owned(s) > 0;
const laid = (seats: ShoalsSeat[]) => seats.reduce((a, s) => a + s.stack.length, 0);
/** Markers of this kind still in the pilot's hand, not on their stack. */
export const shoalsInHand = (s: Pick<ShoalsSeat, "own" | "stack">, marker: Marker) => s.own[marker] - s.stack.filter((m) => m === marker).length;

/** The next seat after `from` that is still afloat and passes `ok`. */
function nextSeat(seats: ShoalsSeat[], from: number, ok: (s: ShoalsSeat) => boolean = () => true): number {
  for (let i = 1; i <= seats.length; i++) {
    const ix = (from + i) % seats.length;
    if (afloat(seats[ix]) && ok(seats[ix])) return ix;
  }
  return from;
}

/** Everyone takes their markers back and a new round begins with `starter` (or the next pilot afloat). */
function newRound(state: ShoalsGame, starter: number, last: ShoalsOutcome | null): void {
  for (const s of state.seats) {
    s.stack = [];
    s.flipped = 0;
    s.passed = false;
  }
  state.step = "lay";
  state.bid = null;
  state.sailed = 0;
  state.round += 1;
  state.last = last;
  state.turn = afloat(state.seats[starter]) ? starter : nextSeat(state.seats, starter);
}

/** If the game is over (two passages, or one pilot left), mark the winner. */
function settle(state: ShoalsGame): boolean {
  const left = state.seats.filter(afloat);
  const champion = state.seats.find((s) => s.passages >= SHOALS_PASSAGES) ?? (left.length === 1 ? left[0] : undefined);
  if (!champion) return false;
  state.phase = "done";
  state.winner = champion.id;
  state.log.push(`${champion.name} wins the table: ${shoalsSplit(state.pot).prize} gold.`);
  return true;
}

export function stepShoals(prev: ShoalsGame, playerId: string, action: ShoalsAction): ShoalsResult {
  const state: ShoalsGame = structuredClone(prev);
  const seatIx = state.seats.findIndex((s) => s.id === playerId);
  const seat = state.seats[seatIx];
  const done = (): ShoalsResult => ({ ok: true, state: { ...state, log: state.log.slice(-LOG_LINES) } });

  if (action.type === "sit") {
    if (state.phase !== "open") return fail("That game has already started.");
    if (seat) return fail("You are already seated.");
    if (state.seats.length >= SHOALS_MAX_PLAYERS) return fail("The table is full.");
    const name = String(action.name ?? "").trim().slice(0, 24) || "Sailor";
    state.seats.push(newSeat(playerId, name));
    state.log.push(`${name} sat down.`);
    return done();
  }
  if (!seat) return fail("You are not at this table.");

  if (action.type === "leave") {
    if (state.phase === "done") return fail("The game is over.");
    if (state.phase === "open") {
      state.seats.splice(seatIx, 1);
      state.log.push(`${seat.name} got up.`);
      if (state.host === playerId && state.seats.length > 0) state.host = state.seats[0].id;
      return done();
    }
    if (!afloat(seat)) return fail("You are already out.");
    seat.own = { channel: 0, shoal: 0 };
    seat.forfeited = true;
    state.log.push(`${seat.name} walked away from the table and forfeits.`);
    if (!settle(state)) newRound(state, seatIx, state.bid ? { pilot: state.bid.by, bid: state.bid.count, result: "void" } : null);
    return done();
  }

  if (action.type === "start") {
    if (state.phase !== "open") return fail("That game has already started.");
    if (state.host !== playerId) return fail("Only whoever opened the table can start it.");
    if (state.seats.length < SHOALS_MIN_PLAYERS) return fail(`It takes ${SHOALS_MIN_PLAYERS} to play.`);
    for (const s of state.seats) s.own = { ...SHOALS_START };
    state.phase = "playing";
    state.pot = state.ante * state.seats.length;
    const rng = makeRng(state.rng);
    const first = rng.int(0, state.seats.length - 1);
    state.rng = rng.state();
    state.round = 0;
    newRound(state, first, null);
    state.log.push(`Markers out. ${state.seats[state.turn].name} lays first.`);
    return done();
  }

  if (state.phase !== "playing") return fail(state.phase === "open" ? "The game has not started." : "The game is over.");
  if (state.turn !== seatIx) return fail("It is not your turn.");

  if (action.type === "lay") {
    if (state.step !== "lay") return fail("Bidding has opened: no more markers go down.");
    if (action.marker !== "channel" && action.marker !== "shoal") return fail("That is not a marker.");
    if (shoalsInHand(seat, action.marker) <= 0) return fail("You have none of those left in your hand.");
    seat.stack.push(action.marker);
    state.turn = nextSeat(state.seats, seatIx);
    return done();
  }

  if (action.type === "bid") {
    if (state.step === "sail") return fail("The bidding is over.");
    const count = Math.floor(Number(action.count));
    const total = laid(state.seats);
    if (state.step === "lay" && state.seats.some((s) => afloat(s) && s.stack.length === 0)) return fail("Everyone lays a marker before the bidding opens.");
    if (!Number.isFinite(count) || count < 1 || count > total) return fail(`Bid between 1 and ${total}.`);
    if (state.bid && count <= state.bid.count) return fail(`Bid more than ${state.bid.count}, or pass.`);
    if (seat.passed) return fail("You have passed this round.");
    state.step = "bid";
    state.bid = { by: seat.id, count };
    state.log.push(`${seat.name} says they can sail ${count}.`);
    const rivals = state.seats.filter((s) => afloat(s) && !s.passed && s.id !== seat.id);
    if (count === total || rivals.length === 0) {
      state.step = "sail";
      state.log.push(`${seat.name} takes the helm.`);
    } else {
      state.turn = nextSeat(state.seats, seatIx, (s) => !s.passed);
    }
    return done();
  }

  if (action.type === "pass") {
    if (state.step !== "bid" || !state.bid) return fail("There is no bid to pass on.");
    if (state.bid.by === seat.id) return fail("Yours is the standing bid.");
    seat.passed = true;
    state.log.push(`${seat.name} passes.`);
    const still = state.seats.filter((s) => afloat(s) && !s.passed);
    if (still.length === 1) {
      state.step = "sail";
      state.turn = state.seats.indexOf(still[0]);
      state.log.push(`${still[0].name} takes the helm.`);
    } else {
      state.turn = nextSeat(state.seats, seatIx, (s) => !s.passed);
    }
    return done();
  }

  // flip
  if (state.step !== "sail" || !state.bid) return fail("Nobody is sailing yet.");
  const target = state.seats.find((s) => s.id === action.seat);
  if (!target) return fail("Nobody by that name is at the table.");
  if (target.id !== seat.id && seat.flipped < seat.stack.length) return fail("Turn over your own markers first.");
  if (target.flipped >= target.stack.length) return fail("That stack has nothing left face down.");
  const marker = target.stack[target.stack.length - 1 - target.flipped];
  target.flipped += 1;
  if (marker === "shoal") {
    // Aground: one of the pilot's markers, picked blind, is gone for good.
    const rng = makeRng(state.rng);
    const lost: Marker = rng.next() * owned(seat) < seat.own.shoal ? "shoal" : "channel";
    state.rng = rng.state();
    seat.own[lost] -= 1;
    state.log.push(target.id === seat.id ? `${seat.name} runs aground on their own Shoal and loses a marker.` : `${seat.name} runs aground on ${target.name}'s Shoal and loses a marker.`);
    if (!afloat(seat)) state.log.push(`${seat.name} has no markers left and is out.`);
    const outcome: ShoalsOutcome = { pilot: seat.id, bid: state.bid.count, result: "aground", at: target.id };
    if (settle(state)) state.last = outcome;
    else newRound(state, seatIx, outcome);
    return done();
  }
  state.sailed += 1;
  if (state.sailed >= state.bid.count) {
    seat.passages += 1;
    state.log.push(`${seat.name} sails ${state.bid.count} clear. That is passage ${seat.passages} of ${SHOALS_PASSAGES}.`);
    const outcome: ShoalsOutcome = { pilot: seat.id, bid: state.bid.count, result: "clear" };
    if (settle(state)) state.last = outcome;
    else newRound(state, seatIx, outcome);
  }
  return done();
}

// ---------- what a player may see ----------

export interface ShoalsSeatView {
  id: string;
  name: string;
  /** Markers still owned; 0 means out. */
  count: number;
  /** Markers on their stack this round. */
  laid: number;
  /** The ones turned over so far, top first. */
  shown: Marker[];
  passages: number;
  passed: boolean;
  forfeited: boolean;
}

export interface ShoalsView {
  ante: number;
  phase: ShoalsGame["phase"];
  host: string;
  seats: ShoalsSeatView[];
  step: ShoalsGame["step"];
  /** Id of whoever is to act, or null when nobody is. */
  turn: string | null;
  bid: ShoalsGame["bid"];
  sailed: number;
  /** Markers on the table this round: the most anyone can bid. */
  total: number;
  round: number;
  last: ShoalsOutcome | null;
  winner: string | null;
  pot: number;
  prize: number;
  log: string[];
  /** The viewer's own markers, or null for a spectator. */
  you: { hand: Record<Marker, number>; stack: Marker[] } | null;
}

/** The table as `viewerId` may see it: every stack's size, but only their own faces and whatever has been turned over. */
export function shoalsView(state: ShoalsGame, viewerId: string): ShoalsView {
  const me = state.seats.find((s) => s.id === viewerId);
  return {
    ante: state.ante,
    phase: state.phase,
    host: state.host,
    seats: state.seats.map((s) => ({
      id: s.id,
      name: s.name,
      count: owned(s),
      laid: s.stack.length,
      shown: s.stack.slice(s.stack.length - s.flipped).reverse(),
      passages: s.passages,
      passed: s.passed,
      forfeited: s.forfeited,
    })),
    step: state.step,
    turn: state.phase === "playing" ? (state.seats[state.turn]?.id ?? null) : null,
    bid: state.bid,
    sailed: state.sailed,
    total: laid(state.seats),
    round: state.round,
    last: state.last,
    winner: state.winner,
    pot: state.pot,
    prize: shoalsSplit(state.pot).prize,
    log: state.log,
    you: me ? { hand: { channel: shoalsInHand(me, "channel"), shoal: shoalsInHand(me, "shoal") }, stack: [...me.stack] } : null,
  };
}

/** What a client may ask of the table. The server turns these into actions. */
export type ShoalsRequest =
  | { type: "open"; ante: number }
  | { type: "sit" }
  | { type: "leave" }
  | { type: "start" }
  | { type: "lay"; marker: Marker }
  | { type: "bid"; count: number }
  | { type: "pass" }
  | { type: "flip"; seat: string };
