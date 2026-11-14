// Turn the Tide: the pub's card game, a short game of one-card hands for two
// to five.
//
// The deck is twenty cards, ranked 1 to 9. Each hand, one card is buried face
// down and everyone is dealt one. On your turn you draw a card and play one of
// your two, face up, and do what it says. Cards knock players out of the hand,
// show you what someone holds, or move cards about.
//
// The hand ends when the deck runs out or only one player is left. If the
// deck ran out, everyone left shows their card, and the tide decides: at high
// tide the highest card wins the hand, at low tide the lowest. The tide starts
// high and the Moon turns it, so the card worth holding can change under you.
// The Kraken (9) is the best card at high tide and can never be played: once
// you hold it, only a Storm or a Smuggler gets it off your hands.
//
// A table is opened for a number of hands to win (two unless the opener picks
// otherwise). The first player alone in the lead with that many takes the
// pot, less the house's cut.
//
// This file is the whole game as a pure reducer. The PubRoom Durable Object
// owns the state and moves the gold. Hands, the deck and the buried card are
// secret: tideView gives each player only what they may see.

import { makeRng } from "./rng";

export const TIDE_ANTES = [5, 10, 20] as const;
export const TIDE_MIN_PLAYERS = 2;
export const TIDE_MAX_PLAYERS = 5;
/** How many hands it can take to win a table, and how many unless the opener says. */
export const TIDE_WIN_CHOICES = [1, 2, 3] as const;
export const TIDE_DEFAULT_WINS = 2;
/** The hands asked for, if they are one of the choices; otherwise the default. */
export const tideWins = (n: unknown): number => ((TIDE_WIN_CHOICES as readonly unknown[]).includes(n) ? (n as number) : TIDE_DEFAULT_WINS);
/** The house's share of the pot, in percent, rounded down. */
export const TIDE_HOUSE_PCT = 10;
const LOG_LINES = 8;

export const TIDE_STOWAWAY = 1;
export const TIDE_GULL = 2;
export const TIDE_SPYGLASS = 3;
export const TIDE_CUTLASS = 4;
export const TIDE_MOON = 5;
export const TIDE_ANCHOR = 6;
export const TIDE_STORM = 7;
export const TIDE_SMUGGLER = 8;
export const TIDE_KRAKEN = 9;

export interface TideCardDef {
  rank: number;
  name: string;
  /** How many are in the deck. */
  count: number;
  /** What playing it does, as printed in the rules. */
  text: string;
  /** It is played on another player. */
  aimed?: boolean;
}

export const TIDE_CARDS: readonly TideCardDef[] = [
  { rank: TIDE_STOWAWAY, name: "Stowaway", count: 1, text: "Does nothing when played. The lowest card: nothing beats it at low tide." },
  { rank: TIDE_GULL, name: "Gull", count: 5, text: "Name another player and a card that is not a Gull. If they hold it, they are out of the hand.", aimed: true },
  { rank: TIDE_SPYGLASS, name: "Spyglass", count: 3, text: "Look at another player's card.", aimed: true },
  { rank: TIDE_CUTLASS, name: "Cutlass", count: 3, text: "Compare cards with another player, in secret. Whoever the tide is against (the lower card at high tide, the higher at low) is out of the hand.", aimed: true },
  { rank: TIDE_MOON, name: "Moon", count: 3, text: "Turn the tide: high to low, or low to high." },
  { rank: TIDE_ANCHOR, name: "Anchor", count: 2, text: "Until your next turn nobody can play a card on you, and a Storm passes you by." },
  { rank: TIDE_STORM, name: "Storm", count: 1, text: "Everyone still in, but for those at anchor, passes their card to the next player round the table." },
  { rank: TIDE_SMUGGLER, name: "Smuggler", count: 1, text: "Look at the buried card. You may swap your own card for it." },
  { rank: TIDE_KRAKEN, name: "Kraken", count: 1, text: "Cannot be played. The highest card: nothing beats it at high tide." },
];

export const tideCard = (rank: number): TideCardDef | undefined => TIDE_CARDS.find((c) => c.rank === rank);
const cardName = (rank: number): string => tideCard(rank)?.name ?? "card";
/** "a Gull", "an Anchor", "the Kraken": how a card is spoken of. */
export const tideCardPhrase = (rank: number): string => {
  const def = tideCard(rank);
  if (!def) return "a card";
  return def.count === 1 ? `the ${def.name}` : `${/^[AEIOU]/.test(def.name) ? "an" : "a"} ${def.name}`;
};
/** Every card in the deck, in rank order. */
export const tideDeck = (): number[] => TIDE_CARDS.flatMap((c) => Array<number>(c.count).fill(c.rank));

export type Tide = "high" | "low";

export interface TideSeat {
  id: string;
  name: string;
  /** One card, or two on their turn. Empty once out of the hand. */
  hand: number[];
  /** What they have played this hand, in order, and the card they were knocked out holding. Face up for all to see. */
  played: number[];
  /** Out of this hand. */
  out: boolean;
  /** Played an Anchor since their last turn. */
  anchored: boolean;
  /** Hands won. */
  wins: number;
  /** Left mid-game: out for good. */
  forfeited: boolean;
  /** What this player knows someone else is holding, by that player's id. */
  knows: Record<string, number>;
}

/** The last card played, for the table to show. */
export interface TidePlay {
  n: number;
  by: string;
  card: number;
  target?: string;
  /** The card a Gull named. */
  guess?: number;
  /** A Gull's guess was right. */
  hit?: boolean;
  /** Who it knocked out. */
  out?: string[];
  /** A Cutlass met its match: nobody is out. */
  tie?: boolean;
  /** A Moon: what the tide turned to. */
  tide?: Tide;
  /** Played on nobody: everyone else was at anchor. */
  wasted?: boolean;
  /** A Storm: whose cards moved, in the order they were passed (each to the one after, the last to the first). */
  moved?: string[];
  /** A Smuggler, once its player has decided: whether they took the buried card. */
  swapped?: boolean;
}

/** How a hand came out. */
export interface TideHandResult {
  hand: number;
  tide: Tide;
  /** Why it ended: the deck ran out and cards were shown, or one player was left. */
  how: "shown" | "last";
  /** The cards shown, for those still in. */
  shown: { id: string; card: number; played: number }[];
  winners: string[];
  /** The card that was buried all hand. */
  buried: number | null;
}

export interface TideGame {
  ante: number;
  /** open: seats are filling. playing: hands are being played. done: someone won. */
  phase: "open" | "playing" | "done";
  /** Within a game. play: someone is to play a card. choice: the Smuggler's player is deciding. shown: a hand is over and the next is to be dealt. */
  stage: "play" | "choice" | "shown";
  host: string;
  seats: TideSeat[];
  /** Index into `seats` of whose turn it is. */
  turn: number;
  deck: number[];
  buried: number | null;
  tide: Tide;
  /** Which hand this is, from 1. */
  hand: number;
  /** Hands it takes to win. */
  wins: number;
  last: TideHandResult | null;
  lastPlay: TidePlay | null;
  /** Cards played all game, so each play has a number of its own. */
  plays: number;
  winner: string | null;
  /** Gold anted, set when the game starts. */
  pot: number;
  log: string[];
  /** Seeded generator state. Never sent to a client: it would give away every shuffle. */
  rng: number;
}

export type TideAction =
  | { type: "sit"; name: string }
  /** Before the start: give up the seat. During play: forfeit. */
  | { type: "leave" }
  | { type: "start" }
  /** Play a card from your hand, on `target` if it is aimed, with the card a Gull names in `guess`. */
  | { type: "play"; card: number; target?: string; guess?: number }
  /** The Smuggler's choice: take the buried card and bury your own, or leave it. */
  | { type: "smuggle"; swap: boolean }
  /** Deal the next hand, once one is over. */
  | { type: "deal" };

export type TideResult = { ok: true; state: TideGame } | { ok: false; error: string };

export function tideSplit(pot: number): { house: number; prize: number } {
  const house = Math.floor((pot * TIDE_HOUSE_PCT) / 100);
  return { house, prize: pot - house };
}

export const isTideAnte = (n: unknown): n is (typeof TIDE_ANTES)[number] => (TIDE_ANTES as readonly unknown[]).includes(n);

const newSeat = (id: string, name: string): TideSeat => ({ id, name, hand: [], played: [], out: false, anchored: false, wins: 0, forfeited: false, knows: {} });

/** A fresh table with its opener in the first seat, won by the first to `wins` hands. */
export function createTideGame(seed: number, ante: number, host: { id: string; name: string }, wins: number = TIDE_DEFAULT_WINS): TideGame {
  return {
    ante,
    phase: "open",
    stage: "play",
    host: host.id,
    seats: [newSeat(host.id, host.name)],
    turn: 0,
    deck: [],
    buried: null,
    tide: "high",
    hand: 0,
    wins,
    last: null,
    lastPlay: null,
    plays: 0,
    winner: null,
    pot: 0,
    log: [`${host.name} set out the cards at ${ante} gold a seat, first to ${wins === 1 ? "one hand" : `${wins} hands`}.`],
    rng: seed >>> 0,
  };
}

const fail = (error: string): TideResult => ({ ok: false, error });
const say = (state: TideGame, line: string): string[] => [...state.log, line].slice(-LOG_LINES);
const alive = (s: TideSeat) => !s.out && !s.forfeited;
const names = (state: TideGame, ids: string[]) => state.seats.filter((s) => ids.includes(s.id)).map((s) => s.name).join(" and ");

/** The first seat after `from` still in the hand, or -1. */
function nextAlive(seats: TideSeat[], from: number): number {
  for (let i = 1; i <= seats.length; i++) {
    const ix = (from + i) % seats.length;
    if (alive(seats[ix])) return ix;
  }
  return -1;
}

/** Whoever may have a card played on them by `by`: still in, not at anchor, and not `by`. */
export const tideTargets = (seats: readonly { id: string; out: boolean; anchored: boolean; forfeited: boolean }[], by: string): string[] =>
  seats.filter((s) => s.id !== by && !s.out && !s.forfeited && !s.anchored).map((s) => s.id);

const without = (knows: Record<string, number>, id: string): Record<string, number> => Object.fromEntries(Object.entries(knows).filter(([k]) => k !== id));

/** Take `id` out of the hand: their card goes face up with the ones they played, and nobody knows anything of them any more. */
function knockOut(seats: TideSeat[], id: string): TideSeat[] {
  return seats.map((s) => {
    if (s.id === id) return { ...s, out: true, anchored: false, played: [...s.played, ...s.hand], hand: [], knows: {} };
    return id in s.knows ? { ...s, knows: without(s.knows, id) } : s;
  });
}

/** Nobody knows what `id` holds any more. */
function forget(seats: TideSeat[], id: string): TideSeat[] {
  return seats.map((s) => (id in s.knows ? { ...s, knows: without(s.knows, id) } : s));
}

/** The start of a seat's turn: their anchor comes up and they draw. */
function draw(state: TideGame, ix: number): TideGame {
  const [top, ...deck] = state.deck;
  const seats = state.seats.map((s, i) => (i === ix ? { ...s, anchored: false, hand: [...s.hand, top] } : s));
  return { ...state, seats, deck, turn: ix, stage: "play" };
}

/** Shuffle and deal hand number `hand`, `first` to play. */
function deal(state: TideGame, hand: number, first: number): TideGame {
  const rng = makeRng(state.rng);
  const deck = tideDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const buried = deck.pop()!;
  const seats = state.seats.map((s) => ({ ...s, hand: s.forfeited ? [] : [deck.pop()!], played: [], out: s.forfeited, anchored: false, knows: {} }));
  const start = alive(seats[first]) ? first : nextAlive(seats, first);
  return draw({ ...state, seats, deck, buried, tide: "high", hand, lastPlay: null, rng: rng.state() }, start);
}

/** The best of those still in, as the tide has it: the highest card at high tide, the lowest at low. Ties go to whoever played the most, by rank; still tied, they all win. */
export function tideBest(tide: Tide, shown: readonly { id: string; card: number; played: number }[]): string[] {
  if (shown.length === 0) return [];
  const best = tide === "high" ? Math.max(...shown.map((s) => s.card)) : Math.min(...shown.map((s) => s.card));
  const top = shown.filter((s) => s.card === best);
  const most = Math.max(...top.map((s) => s.played));
  return top.filter((s) => s.played === most).map((s) => s.id);
}

/** The hand is over: mark who won it, and the game if that settles it. */
function endHand(state: TideGame, how: TideHandResult["how"]): TideGame {
  const inIt = state.seats.filter(alive);
  const shown = inIt.map((s) => ({ id: s.id, card: s.hand[0], played: s.played.reduce((a, c) => a + c, 0) }));
  const winners = how === "last" ? inIt.map((s) => s.id) : tideBest(state.tide, shown);
  const seats = state.seats.map((s) => (winners.includes(s.id) ? { ...s, wins: s.wins + 1 } : s));
  const last: TideHandResult = { hand: state.hand, tide: state.tide, how, shown, winners, buried: state.buried };
  const won = `${names(state, winners)} ${winners.length > 1 ? "share" : "wins"} the hand`;
  const line = how === "last" ? `${won}: the last one in.` : winners.length > 1 ? `${won}, tied at ${state.tide} tide.` : `${won} with ${tideCardPhrase(shown.find((s) => s.id === winners[0])!.card)} at ${state.tide} tide.`;
  const next: TideGame = { ...state, seats, last, stage: "shown", log: say(state, line) };
  // The game is won by whoever is alone in the lead with enough hands.
  const still = seats.filter((s) => !s.forfeited);
  const most = Math.max(...still.map((s) => s.wins));
  const lead = still.filter((s) => s.wins === most);
  if (most >= state.wins && lead.length === 1) return win(next, lead[0].id);
  return next;
}

function win(state: TideGame, id: string): TideGame {
  const seat = state.seats.find((s) => s.id === id)!;
  return { ...state, phase: "done", stage: "shown", winner: id, log: say(state, `${seat.name} wins ${tideSplit(state.pot).prize} gold.`) };
}

/** The player on turn is done: the hand may be over, or the next player draws. */
function endTurn(state: TideGame): TideGame {
  if (state.seats.filter(alive).length <= 1) return endHand(state, "last");
  if (state.deck.length === 0) return endHand(state, "shown");
  return draw(state, nextAlive(state.seats, state.turn));
}

export function stepTide(state: TideGame, playerId: string, action: TideAction): TideResult {
  const ix = state.seats.findIndex((s) => s.id === playerId);
  const seat = ix >= 0 ? state.seats[ix] : undefined;

  switch (action.type) {
    case "sit": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (seat) return fail("You are already seated.");
      if (state.seats.length >= TIDE_MAX_PLAYERS) return fail("The table is full.");
      return { ok: true, state: { ...state, seats: [...state.seats, newSeat(playerId, action.name)], log: say(state, `${action.name} sat down.`) } };
    }

    case "leave": {
      if (!seat) return fail("You are not at the table.");
      if (state.phase === "done") return fail("The game is over.");
      if (state.phase === "open") {
        const seats = state.seats.filter((s) => s.id !== playerId);
        return { ok: true, state: { ...state, seats, host: state.host === playerId ? (seats[0]?.id ?? "") : state.host, log: say(state, `${seat.name} got up.`) } };
      }
      if (seat.forfeited) return fail("You are already out.");
      const wasIn = alive(seat);
      const seats = knockOut(state.seats, playerId).map((s) => (s.id === playerId ? { ...s, forfeited: true } : s));
      const next: TideGame = { ...state, seats, log: say(state, `${seat.name} walked away and forfeits.`) };
      const still = seats.filter((s) => !s.forfeited);
      if (still.length === 1) return { ok: true, state: win(next, still[0].id) };
      // Between hands, or already out of this one: nothing else changes.
      if (state.stage === "shown" || !wasIn) return { ok: true, state: next };
      if (state.turn === ix) return { ok: true, state: endTurn({ ...next, stage: "play" }) };
      return { ok: true, state: seats.filter(alive).length <= 1 ? endHand(next, "last") : next };
    }

    case "start": {
      if (state.phase !== "open") return fail("The game has already started.");
      if (state.host !== playerId) return fail("Only whoever opened the table can start.");
      if (state.seats.length < TIDE_MIN_PLAYERS) return fail("It takes at least two to play.");
      const pot = state.ante * state.seats.length;
      const seats = state.seats.map((s) => ({ ...s, wins: 0, forfeited: false }));
      return { ok: true, state: deal({ ...state, phase: "playing", seats, pot, log: say(state, `The cards are dealt. The pot is ${pot} gold.`) }, 1, 0) };
    }

    case "deal": {
      if (state.phase !== "playing" || state.stage !== "shown") return fail("There is no hand to deal.");
      if (!seat || seat.forfeited) return fail("You are not in the game.");
      // Whoever won the last hand leads the next: the first of them round the table.
      const lead = state.seats.findIndex((s) => !s.forfeited && state.last?.winners.includes(s.id));
      return { ok: true, state: deal({ ...state, log: say(state, `${seat.name} deals hand ${state.hand + 1}.`) }, state.hand + 1, lead >= 0 ? lead : 0) };
    }

    case "smuggle": {
      if (state.phase !== "playing" || state.stage !== "choice") return fail("There is nothing to choose.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      const lastPlay = state.lastPlay && { ...state.lastPlay, swapped: action.swap && state.buried !== null };
      if (!action.swap || state.buried === null) return { ok: true, state: endTurn({ ...state, stage: "play", lastPlay, log: say(state, `${seat.name} leaves the buried card where it lies.`) }) };
      const mine = seat.hand[0];
      const seats = forget(state.seats, playerId).map((s) => (s.id === playerId ? { ...s, hand: [state.buried!] } : s));
      return { ok: true, state: endTurn({ ...state, stage: "play", seats, buried: mine, lastPlay, log: say(state, `${seat.name} swaps cards with the buried one.`) }) };
    }

    case "play": {
      if (state.phase !== "playing" || state.stage === "shown") return fail("No hand is being played.");
      if (state.turn !== ix || !seat) return fail("It is not your turn.");
      if (state.stage === "choice") return fail("Decide about the buried card first.");
      const card = action.card;
      const at = seat.hand.indexOf(card);
      const def = tideCard(card);
      if (at < 0 || !def) return fail("You do not hold that card.");
      if (card === TIDE_KRAKEN) return fail("The Kraken cannot be played.");
      const targets = tideTargets(state.seats, playerId);
      const aimed = !!def.aimed && targets.length > 0;
      if (aimed && (!action.target || !targets.includes(action.target))) return fail(state.seats.some((s) => s.id === action.target && s.anchored) ? "They are at anchor: pick someone else." : "Pick another player still in the hand.");
      if (aimed && card === TIDE_GULL && (!tideCard(action.guess ?? 0) || action.guess === TIDE_GULL)) return fail("Name a card that is not a Gull.");

      // The card goes down. Anyone who knew you held it no longer knows what you hold.
      const kept = seat.hand.filter((_, i) => i !== at);
      let seats = state.seats.map((s) => {
        if (s.id === playerId) return { ...s, hand: kept, played: [...s.played, card] };
        return s.knows[playerId] === card ? { ...s, knows: without(s.knows, playerId) } : s;
      });
      const play: TidePlay = { n: state.plays + 1, by: playerId, card };
      const target = aimed ? seats.find((s) => s.id === action.target)! : undefined;
      if (target) play.target = target.id;
      let next: TideGame = { ...state, seats, plays: play.n };
      let line = `${seat.name} plays ${tideCardPhrase(card)}`;

      if (def.aimed && !target) {
        play.wasted = true;
        line += ", but everyone else is at anchor.";
      } else if (card === TIDE_GULL && target) {
        play.guess = action.guess;
        play.hit = target.hand[0] === action.guess;
        line += ` and calls ${target.name}'s card ${tideCardPhrase(action.guess!)}. ${play.hit ? `Right: ${target.name} is out.` : "Wrong."}`;
        if (play.hit) {
          play.out = [target.id];
          seats = knockOut(seats, target.id);
        }
      } else if (card === TIDE_SPYGLASS && target) {
        seats = seats.map((s) => (s.id === playerId ? { ...s, knows: { ...s.knows, [target.id]: target.hand[0] } } : s));
        line += ` and looks at ${target.name}'s card.`;
      } else if (card === TIDE_CUTLASS && target) {
        const mine = kept[0];
        const theirs = target.hand[0];
        if (mine === theirs) {
          play.tie = true;
          seats = seats.map((s) => (s.id === playerId ? { ...s, knows: { ...s.knows, [target.id]: theirs } } : s.id === target.id ? { ...s, knows: { ...s.knows, [playerId]: mine } } : s));
          line += ` on ${target.name}. Their cards match: nobody is out.`;
        } else {
          const loser = (state.tide === "high") === (mine < theirs) ? seat : target;
          play.out = [loser.id];
          // The one left standing has shown their card to the one who is out, and to nobody else.
          seats = knockOut(seats, loser.id);
          line += ` on ${target.name}. The ${state.tide} tide is against ${loser.name}, who is out.`;
        }
      } else if (card === TIDE_MOON) {
        play.tide = state.tide === "high" ? "low" : "high";
        next = { ...next, tide: play.tide };
        line += `: the tide turns ${play.tide}.`;
      } else if (card === TIDE_ANCHOR) {
        seats = seats.map((s) => (s.id === playerId ? { ...s, anchored: true } : s));
        line += " and lies at anchor.";
      } else if (card === TIDE_STORM) {
        const movers = seats.filter((s) => alive(s) && !s.anchored).map((s) => s.id);
        if (movers.length < 2) line += ", but there is nobody to pass a card to.";
        else {
          play.moved = movers;
          const to = (id: string) => movers[(movers.indexOf(id) + 1) % movers.length];
          const from = (id: string) => movers[(movers.indexOf(id) + movers.length - 1) % movers.length];
          const held = new Map(seats.map((s) => [s.id, s.hand[0]]));
          seats = seats.map((s) => {
            // What you knew of a card follows it round the table, and you know what you passed on.
            const knows: Record<string, number> = {};
            for (const [id, c] of Object.entries(s.knows)) {
              const now = movers.includes(id) ? to(id) : id;
              if (now !== s.id) knows[now] = c;
            }
            if (!movers.includes(s.id)) return { ...s, knows };
            knows[to(s.id)] = held.get(s.id)!;
            return { ...s, hand: [held.get(from(s.id))!], knows };
          });
          line += `: every card ${movers.length < seats.filter(alive).length ? "not at anchor " : ""}moves one place round the table.`;
        }
      } else if (card === TIDE_SMUGGLER) {
        line += " and looks at the buried card.";
        return { ok: true, state: { ...next, seats, stage: "choice", lastPlay: play, log: say(state, line) } };
      } else if (card === TIDE_STOWAWAY) {
        line += ".";
      }
      return { ok: true, state: endTurn({ ...next, seats, lastPlay: play, log: say(state, line) }) };
    }
  }
}

// ---------- what a player may see ----------

export interface TideSeatView {
  id: string;
  name: string;
  out: boolean;
  anchored: boolean;
  forfeited: boolean;
  wins: number;
  played: number[];
  /** How many cards they hold. */
  cards: number;
  /** The cards themselves: your own, and everyone's once a hand is over. */
  hand: number[] | null;
  /** What you know they hold: a card you looked at, fought, or passed them. */
  known: number | null;
}

export interface TideView {
  ante: number;
  phase: TideGame["phase"];
  stage: TideGame["stage"];
  host: string;
  seats: TideSeatView[];
  /** Player id of whose turn it is, while a hand is being played. */
  turn: string | null;
  tide: Tide;
  /** Cards left to draw. */
  deck: number;
  /** The buried card: shown only to the Smuggler's player while they choose, and to everyone once the hand is over. */
  buried: number | null;
  /** You are to decide whether to swap with the buried card. */
  choice: boolean;
  hand: number;
  wins: number;
  last: TideHandResult | null;
  lastPlay: TidePlay | null;
  winner: string | null;
  pot: number;
  /** What the winner takes from the pot once the house has had its cut. */
  prize: number;
  log: string[];
}

/** The table as `viewerId` may see it: their own hand and what they have learned, never the deck, and the buried card only when it is theirs to see. */
export function tideView(state: TideGame, viewerId?: string | null): TideView {
  const playing = state.phase === "playing";
  const over = state.phase !== "open" && state.stage === "shown";
  const me = state.seats.find((s) => s.id === viewerId);
  const choosing = playing && state.stage === "choice" && state.seats[state.turn]?.id === viewerId;
  return {
    ante: state.ante,
    phase: state.phase,
    stage: state.stage,
    host: state.host,
    seats: state.seats.map((s) => ({
      id: s.id,
      name: s.name,
      out: s.out,
      anchored: s.anchored,
      forfeited: s.forfeited,
      wins: s.wins,
      played: [...s.played],
      cards: s.hand.length,
      hand: over || s.id === viewerId ? [...s.hand] : null,
      known: s.id !== viewerId && me && !over ? (me.knows[s.id] ?? null) : null,
    })),
    turn: playing && state.stage !== "shown" ? (state.seats[state.turn]?.id ?? null) : null,
    tide: state.tide,
    deck: state.deck.length,
    buried: over || choosing ? state.buried : null,
    choice: choosing,
    hand: state.hand,
    wins: state.wins,
    // The last hand's cards are no secret once it is over.
    last: state.last,
    lastPlay: state.lastPlay,
    winner: state.winner,
    pot: state.pot,
    prize: tideSplit(state.pot).prize,
    log: state.log,
  };
}

// ---------- wire types (carried inside the pub's messages) ----------

/** What a client may ask of the table. The server fills in names and checks gold. */
export type TideRequest =
  | { type: "open"; ante: number; wins?: number }
  | { type: "sit" }
  | { type: "leave" }
  | { type: "start" }
  | { type: "play"; card: number; target?: string; guess?: number }
  | { type: "smuggle"; swap: boolean }
  | { type: "deal" };
