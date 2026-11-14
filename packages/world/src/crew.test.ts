import { describe, expect, it } from "vitest";
import { CREW_DEFAULT_ROUNDS, CREW_MAX_PLAYERS, CREW_ROLLS, PUB_CREW, createCrewGame, crewRounds, crewCaptain, crewCargo, crewHold, crewKraken, crewScore, crewSplit, crewView, poiAt, pubPath, pubRoom, stepCrew, type CrewAction, type CrewGame } from "./index";

const A = { id: "a", name: "Ada" };
const B = { id: "b", name: "Bo" };
const C = { id: "c", name: "Cy" };

function must(state: CrewGame, id: string, action: CrewAction): CrewGame {
  const res = stepCrew(state, id, action);
  if (!res.ok) throw new Error(res.error);
  return res.state;
}
const err = (state: CrewGame, id: string, action: CrewAction) => {
  const res = stepCrew(state, id, action);
  return res.ok ? null : res.error;
};

/** A game under way. One round unless asked for more, so a round's cargo decides it. */
function started(seed: number, players = [A, B], ante = 10, rounds = 1): CrewGame {
  let g = createCrewGame(seed, ante, players[0], rounds);
  for (const p of players.slice(1)) g = must(g, p.id, { type: "sit", name: p.name });
  return must(g, players[0].id, { type: "start" });
}
const turnId = (g: CrewGame) => g.seats[g.turn].id;
const seatOf = (g: CrewGame, id: string) => g.seats.find((s) => s.id === id)!;

/** Play to the end: roll until the turn passes, keeping dice of 4 and up and standing once a captain is in and nothing is worth rolling again. */
function playOut(g: CrewGame): CrewGame {
  for (let i = 0; g.phase === "playing"; i++) {
    if (i > 2000) throw new Error("game did not end");
    const id = turnId(g);
    const keep = g.held === 1 ? g.dice.flatMap((d, k) => (d >= 4 ? [k] : [])) : [];
    const done = g.held === 1 && keep.length === g.dice.length;
    g = done && crewCaptain(g.held, g.dice) ? must(g, id, { type: "stand" }) : must(g, id, { type: "roll", keep: done ? (g.kept ?? []) : keep });
  }
  return g;
}

/** A game state with the player on turn already holding these dice, for testing what follows. */
const holding = (g: CrewGame, held: number, dice: number[], rolls: number, kept: number[] = []): CrewGame => ({ ...g, held, dice, rolls, kept });

/** Roll from `g` with seeds until the result passes `ok`. */
function rollUntil(g: CrewGame, id: string, action: CrewAction, ok: (n: CrewGame) => boolean): CrewGame {
  for (let seed = 1; seed < 500; seed++) {
    const n = must({ ...g, rng: seed }, id, action);
    if (ok(n)) return n;
  }
  throw new Error("no seed gave that roll");
}

describe("ship, captain and kraken", () => {
  it("has a table in the pub that a customer can walk to", () => {
    const room = pubRoom();
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(poiAt(room, PUB_CREW)?.kind).toBe("crew");
    expect(room.pois.filter((p) => p.pos.q === PUB_CREW.q && p.pos.r === PUB_CREW.r)).toHaveLength(1);
    expect(pubPath(room, door, PUB_CREW)!.at(-1)).toEqual(PUB_CREW);
  });

  it("sets the ship aside and leaves the other four to play with, captain or not", () => {
    expect(crewHold(0, [5, 4, 3, 2, 1])).toEqual({ held: 0, dice: [5, 4, 3, 2, 1] });
    expect(crewHold(0, [4, 5, 6, 2, 1])).toEqual({ held: 1, dice: [4, 5, 2, 1] });
    // Two sixes: one is the ship, the other may be cargo.
    expect(crewHold(0, [6, 6, 5, 6, 3])).toEqual({ held: 1, dice: [6, 5, 6, 3] });
    expect(crewHold(1, [5, 4, 3, 3])).toEqual({ held: 1, dice: [5, 4, 3, 3] });
  });

  it("scores the three beside a captain, and nothing without a ship, a captain, or with a Kraken", () => {
    expect(crewCaptain(1, [6, 5, 3, 4])).toBe(true);
    expect(crewCargo(1, [6, 5, 3, 4])).toBe(13);
    // Two fives: one is the captain, the other cargo.
    expect(crewCargo(1, [5, 5, 6, 6])).toBe(17);
    expect(crewCargo(1, [6, 6, 6, 4])).toBeNull();
    expect(crewScore(1, [6, 5, 3, 4])).toEqual({ score: 13, lost: null });
    expect(crewScore(1, [6, 6, 6, 4])).toEqual({ score: 0, lost: "captainless" });
    expect(crewScore(1, [6, 5, 1, 4])).toEqual({ score: 0, lost: "kraken" });
    expect(crewScore(0, [6, 5, 3, 4, 2])).toEqual({ score: 0, lost: "adrift" });
    // A 1 is only the Kraken once the ship is in.
    expect(crewKraken(0, [1, 2, 3, 4, 5])).toBe(false);
    expect(crewKraken(1, [1, 2, 3, 5])).toBe(true);
  });

  it("seats two to six and only lets the opener start", () => {
    let g = createCrewGame(1, 5, A);
    expect(err(g, "a", { type: "start" })).toMatch(/two/);
    for (let i = 1; i < CREW_MAX_PLAYERS; i++) g = must(g, `p${i}`, { type: "sit", name: `P${i}` });
    expect(err(g, "x", { type: "sit", name: "X" })).toMatch(/full/);
    expect(err(g, "p1", { type: "start" })).toMatch(/opened/);
    g = must(g, "a", { type: "start" });
    expect(g.phase).toBe("playing");
    expect(g.pot).toBe(30);
    expect(g.seats.every((s) => s.contending && s.score === null)).toBe(true);
    expect(err(g, "x", { type: "sit", name: "X" })).toMatch(/started/);
  });

  it("only lets the player on turn roll, and gives each turn three rolls", () => {
    let g = started(7);
    const other = g.seats.find((s) => s.id !== turnId(g))!.id;
    expect(err(g, other, { type: "roll" })).toMatch(/not your turn/);
    const first = turnId(g);
    g = must(g, first, { type: "roll" });
    expect(g.held + g.dice.length).toBe(5);
    expect(g.held).toBeLessThanOrEqual(1);
    // From a hand with nothing held, three rolls always end the turn.
    g = { ...g, held: 0, dice: [1, 1, 1, 1, 1], rolls: 0 };
    for (let i = 0; i < CREW_ROLLS && turnId(g) === first; i++) g = must(g, first, { type: "roll" });
    expect(turnId(g)).not.toBe(first);
    expect(seatOf(g, first).score).not.toBeNull();
    expect(seatOf(g, first).hand).toHaveLength(5);
  });

  it("keeps the dice you choose where they are and rolls only the rest", () => {
    let g = started(11);
    const first = turnId(g);
    g = holding(g, 1, [6, 2, 5, 4], 1);
    g = must(g, first, { type: "roll", keep: [0, 2, 3] });
    expect(turnId(g)).toBe(first);
    expect(g.dice[0]).toBe(6);
    expect(g.dice[2]).toBe(5);
    expect(g.dice[3]).toBe(4);
    expect(g.dice).toHaveLength(4);
    expect(g.lastThrow).toMatchObject({ by: first, fresh: 0, thrown: [1] });
    // Keeping every die is standing, and nonsense indexes are ignored.
    expect(err(holding(g, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [0, 1, 2, 3] })).toMatch(/stand/);
    g = must(holding(g, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [9, -1, 0] });
    expect(g.lastThrow!.thrown).toEqual([1, 2, 3]);
  });

  it("remembers the dice you held, and lets you let them go", () => {
    let g = started(11);
    const first = turnId(g);
    g = must(holding(g, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [0, 2] });
    expect(g.kept).toEqual([0, 2]);
    expect(crewView(g).kept).toEqual([0, 2]);
    // Next roll, let the 6 go and hold the 4 instead.
    g = must(holding(g, 1, [6, 2, 5, 4], 1, [0, 2]), first, { type: "roll", keep: [2, 3] });
    expect(g.lastThrow!.thrown).toEqual([0, 1]);
    expect(g.kept).toEqual([2, 3]);
    // The next player starts with nothing held.
    const next = must(holding(g, 1, [6, 3, 5, 4], 2, [2, 3]), first, { type: "stand" });
    expect(next.kept).toEqual([]);
  });

  it("will not hold a Kraken", () => {
    const g = started(11);
    const first = turnId(g);
    expect(err(holding(g, 1, [6, 1, 5, 4], 1), first, { type: "roll", keep: [1] })).toMatch(/Kraken/);
  });

  it("will not stand without a ship, without a captain, or with a Kraken showing, and stands on the cargo otherwise", () => {
    let g = started(3);
    const first = turnId(g);
    expect(err(holding(g, 0, [4, 3, 1, 2, 5], 1), first, { type: "stand" })).toMatch(/ship/);
    expect(err(holding(g, 1, [6, 6, 6, 4], 1), first, { type: "stand" })).toMatch(/captain/);
    expect(err(holding(g, 1, [6, 1, 5, 3], 1), first, { type: "stand" })).toMatch(/Kraken/);
    g = must(holding(g, 1, [3, 5, 4, 5], 1), first, { type: "stand" });
    expect(seatOf(g, first)).toMatchObject({ score: 12, lost: null, hand: [6, 3, 5, 4, 5] });
    expect(turnId(g)).not.toBe(first);
    expect(g.rolls).toBe(0);
  });

  it("lets you gamble good cargo on a captain coming up", () => {
    const g = started(3);
    const first = turnId(g);
    // Three sixes of cargo and no captain, one roll left: roll the fourth die and hope for a 5.
    const before = holding(g, 1, [6, 6, 6, 2], CREW_ROLLS - 1);
    const won = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).score === 18);
    expect(seatOf(won, first).hand).toEqual([6, 6, 6, 6, 5]);
    const lost = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).lost === "captainless");
    expect(seatOf(lost, first).score).toBe(0);
  });

  it("ends the turn at once on the best cargo there is", () => {
    const g = started(3);
    const first = turnId(g);
    const best = rollUntil(holding(g, 1, [6, 6, 6, 2], 1), first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).score === 18);
    expect(turnId(best)).not.toBe(first);
  });

  it("lets the Kraken take a cargo still holding one when the rolls run out", () => {
    const g = started(3);
    const first = turnId(g);
    const before = holding(g, 1, [6, 6, 5, 1], CREW_ROLLS - 1);
    // Keep the sixes and the captain, roll the Kraken again, and get another.
    const sunk = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).lost === "kraken");
    expect(seatOf(sunk, first)).toMatchObject({ score: 0, lost: "kraken", hand: [6, 6, 6, 5, 1] });
    expect(sunk.lastThrow).toMatchObject({ kraken: true, thrown: [3] });
    // Or roll it away.
    const saved = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => (seatOf(n, first).score ?? 0) > 0);
    expect(seatOf(saved, first).score).toBeGreaterThanOrEqual(14);
    expect(saved.lastThrow!.kraken).toBe(false);
  });

  it("scores nothing without a ship", () => {
    const g = started(3);
    const first = turnId(g);
    const adrift = rollUntil(holding(g, 0, [2, 2, 2, 2, 2], CREW_ROLLS - 1), first, { type: "roll" }, (n) => seatOf(n, first).lost === "adrift");
    expect(seatOf(adrift, first).score).toBe(0);
  });

  it("the highest cargo wins the pot, less the house's cut", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, 1, [6, 6, 5, 6], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [3, 2, 5, 2], 1), "b", { type: "stand" });
    g = must(holding(g, 1, [5, 6, 5, 4], 1), "c", { type: "stand" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    expect(g.last?.result).toBe("win");
    expect(crewSplit(g.pot)).toEqual({ house: 3, prize: 27 });
  });

  it("rolls off a tie among only those tied", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, 1, [5, 5, 4, 3], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    g = must(holding(g, 1, [6, 3, 5, 3], 1), "c", { type: "stand" });
    expect(g.phase).toBe("playing");
    expect(g.last).toMatchObject({ result: "tie", ids: ["a", "c"] });
    expect(g.round).toBe(2);
    expect(g.seats.map((s) => s.contending)).toEqual([true, false, true]);
    expect(turnId(g)).toBe("a");
    expect(err(g, "b", { type: "leave" })).toMatch(/already out/);
    g = must(holding(g, 1, [2, 2, 5, 2], 1), "a", { type: "stand" });
    expect(turnId(g)).toBe("c");
    g = must(holding(g, 1, [2, 2, 5, 3], 1), "c", { type: "stand" });
    expect(g.winner).toBe("c");
  });

  it("plays everyone again when nobody scores", () => {
    // A's turn is over on nothing; B is on their last roll with no captain. Find a roll that brings none in.
    const base = started(5);
    const at: CrewGame = { ...base, turn: 1, held: 1, dice: [2, 2, 2, 2], rolls: CREW_ROLLS - 1, seats: base.seats.map((s, i) => (i === 0 ? { ...s, score: 0, lost: "adrift", hand: [2, 2, 2, 2, 2] } : s)) };
    const g = rollUntil(at, "b", { type: "roll", keep: [0] }, (n) => n.last?.result === "bust");
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(2);
    expect(g.seats.every((s) => s.contending && s.score === null && !s.lost)).toBe(true);
    expect(turnId(g)).toBe("a");
  });

  it("opens for three rounds unless one of the other choices is asked for", () => {
    expect(createCrewGame(1, 5, A).rounds).toBe(CREW_DEFAULT_ROUNDS);
    expect(CREW_DEFAULT_ROUNDS).toBe(3);
    expect(crewRounds(5)).toBe(5);
    expect(crewRounds(1)).toBe(1);
    expect(crewRounds(2)).toBe(3);
    expect(crewRounds("5")).toBe(3);
    expect(crewRounds(undefined)).toBe(3);
    // A game saved before rounds is a one-round game.
    const { rounds: _, ...old } = started(5);
    expect(crewView(old as CrewGame).rounds).toBe(1);
  });

  it("adds up the cargo of every round, and the highest total after the last takes the pot", () => {
    let g = started(5, [A, B], 10, 3);
    // Round 1: a 12, b 6.
    g = must(holding(g, 1, [3, 5, 4, 5], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(2);
    expect(g.last).toMatchObject({ round: 1, result: "next", ids: ["a"] });
    expect(crewView(g).seats.map((s) => [s.total, s.score])).toEqual([[12, null], [6, null]]);
    expect(turnId(g)).toBe("a");
    // Round 2: a 6, b 15. b leads, 21 to 18.
    g = must(holding(g, 1, [2, 5, 2, 2], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [6, 5, 6, 3], 1), "b", { type: "stand" });
    expect(g.round).toBe(3);
    expect(g.last).toMatchObject({ round: 2, result: "next", ids: ["b"] });
    expect(g.seats.map((s) => s.total)).toEqual([18, 21]);
    // Round 3: a 18, b 6. a wins on the total, 36 to 27, though b had the best single round going into it.
    g = must(holding(g, 1, [6, 6, 5, 6], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.seats.map((s) => s.total)).toEqual([36, 27]);
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    expect(g.last).toMatchObject({ round: 3, result: "win", ids: ["a"] });
  });

  it("rolls off a tie on totals after the last round, on the roll-off's own cargo", () => {
    let g = started(5, [A, B], 10, 3);
    for (let round = 1; round <= 3; round++) {
      g = must(holding(g, 1, [3, 5, 4, 5], 1), "a", { type: "stand" });
      g = must(holding(g, 1, [4, 5, 3, 5], 1), "b", { type: "stand" });
    }
    expect(g.seats.map((s) => s.total)).toEqual([36, 36]);
    expect(g.last).toMatchObject({ round: 3, result: "tie", ids: ["a", "b"] });
    expect(g.round).toBe(4);
    expect(crewView(g).rounds).toBe(3);
    // The roll-off is on its own cargo, and leaves the totals as they were.
    g = must(holding(g, 1, [2, 5, 2, 2], 1), "a", { type: "stand" });
    g = must(holding(g, 1, [3, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.winner).toBe("b");
    expect(g.seats.map((s) => s.total)).toEqual([36, 36]);
  });

  it("a forfeit on turn passes the turn, and the last one left wins", () => {
    let g = started(9, [A, B, C]);
    expect(turnId(g)).toBe("a");
    g = must(g, "a", { type: "leave" });
    expect(g.seats[0].forfeited).toBe(true);
    expect(turnId(g)).toBe("b");
    g = must(g, "c", { type: "leave" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("b");
  });

  it("numbers every throw, with who threw and what it brought in, even one that ends a turn", () => {
    let g = started(4);
    const first = turnId(g);
    g = must({ ...g, held: 0, dice: [4, 4, 4, 4, 4], rolls: CREW_ROLLS - 1 }, first, { type: "roll" });
    expect(turnId(g)).not.toBe(first);
    expect(g.lastThrow).toMatchObject({ n: 1, by: first });
    expect(g.lastThrow!.fresh).toBe(seatOf(g, first).lost === "adrift" ? 0 : 1);
    g = must(g, turnId(g), { type: "roll" });
    expect(g.lastThrow!.n).toBe(2);
    expect(crewView(g, null).lastThrow).toEqual(g.lastThrow);
  });

  it("plays the same full game from the same seed", () => {
    const one = playOut(started(42, [A, B, C]));
    const two = playOut(started(42, [A, B, C]));
    expect(two).toEqual(one);
    expect(one.phase).toBe("done");
    expect(one.winner).not.toBeNull();
    const top = one.last!.scores.find((s) => s.id === one.winner)!.score;
    expect(top).toBeGreaterThan(0);
    for (const s of one.last!.scores) if (s.id !== one.winner) expect(s.score).toBeLessThan(top);
  });

  it("shows the Kraken, and never the generator", () => {
    const g = started(1);
    const view = crewView(holding(g, 1, [1, 5, 4, 4], 1), "a");
    expect(view).not.toHaveProperty("rng");
    expect(view.turn).toBe("a");
    expect(view.kraken).toBe(true);
    expect(view.captain).toBe(true);
    expect(view.cargo).toBe(9);
  });
});
