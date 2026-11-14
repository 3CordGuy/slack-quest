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
const seatOf = (g: CrewGame, id: string) => g.seats.find((s) => s.id === id)!;
/** A player's dice this round. */
const playOf = (g: CrewGame, id: string) => seatOf(g, id).play!;
/** Still to play this round. */
const dueIds = (g: CrewGame) => crewView(g).due;

/** Play to the end, everyone a roll at a time in seat order: keep dice of 4 and up, and stand once a captain is in and nothing is worth rolling again. */
function playOut(g: CrewGame): CrewGame {
  for (let i = 0; g.phase === "playing"; i++) {
    if (i > 2000) throw new Error("game did not end");
    const id = dueIds(g)[i % dueIds(g).length];
    const p = playOf(g, id);
    const keep = p.held === 1 ? p.dice.flatMap((d, k) => (d >= 4 ? [k] : [])) : [];
    const done = p.held === 1 && keep.length === p.dice.length;
    g = done && crewCaptain(p.held, p.dice) ? must(g, id, { type: "stand" }) : must(g, id, { type: "roll", keep: done ? p.kept : keep });
  }
  return g;
}

/** A game state with this player already holding these dice, for testing what follows. */
const holding = (g: CrewGame, id: string, held: number, dice: number[], rolls: number, kept: number[] = []): CrewGame => ({
  ...g,
  seats: g.seats.map((s) => (s.id === id ? { ...s, play: { held, dice, rolls, kept } } : s)),
});

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

  it("scores the pip dice beside a captain, and nothing without a ship, a captain, or with a Kraken", () => {
    expect(crewCaptain(1, [6, 5, 3, 4])).toBe(true);
    // A second ship carries nothing: only the 3 and the 4 are cargo.
    expect(crewCargo(1, [6, 5, 3, 4])).toBe(7);
    // Nor does a second captain.
    expect(crewCargo(1, [5, 5, 4, 2])).toBe(6);
    expect(crewCargo(1, [4, 4, 5, 4])).toBe(12);
    expect(crewCargo(1, [6, 6, 6, 4])).toBeNull();
    expect(crewScore(1, [6, 5, 3, 4])).toEqual({ score: 7, lost: null });
    // A captain with nothing but ships and captains beside it brings home an empty hold.
    expect(crewCargo(1, [5, 5, 6, 6])).toBe(0);
    expect(crewScore(1, [5, 5, 6, 6])).toEqual({ score: 0, lost: "empty" });
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

  it("lets everyone roll at once, each with their own dice and three rolls", () => {
    let g = started(7, [A, B, C]);
    expect(dueIds(g)).toEqual(["a", "b", "c"]);
    // Anyone may roll first, and in any order.
    g = must(g, "c", { type: "roll" });
    g = must(g, "a", { type: "roll" });
    for (const id of ["a", "c"]) {
      expect(playOf(g, id).rolls).toBe(1);
      expect(playOf(g, id).held + playOf(g, id).dice.length).toBe(5);
    }
    expect(playOf(g, "b").rolls).toBe(0);
    expect(g.lastThrow).toMatchObject({ n: 2, by: "a" });
    // From a hand with nothing held, three rolls always end a player's round; the others play on.
    g = holding(g, "a", 0, [1, 1, 1, 1, 1], 0);
    for (let i = 0; i < CREW_ROLLS; i++) g = must(g, "a", { type: "roll" });
    expect(seatOf(g, "a").score).not.toBeNull();
    expect(seatOf(g, "a").hand).toHaveLength(5);
    expect(playOf(g, "a")).toEqual({ rolls: 0, held: 0, dice: [], kept: [] });
    expect(err(g, "a", { type: "roll" })).toMatch(/played this round/);
    expect(dueIds(g)).toEqual(["b", "c"]);
    expect(g.phase).toBe("playing");
    expect(err(g, "x", { type: "roll" })).toMatch(/not at the table/);
  });

  it("shows each player their own dice, and everyone everyone's", () => {
    let g = started(7);
    g = holding(holding(g, "a", 1, [4, 5, 3, 2], 1, [0]), "b", 1, [6, 1, 2, 2], 2);
    const a = crewView(g, "a");
    expect(a).toMatchObject({ rolls: 1, held: 1, dice: [4, 5, 3, 2], kept: [0], cargo: 9, captain: true, kraken: false });
    const b = crewView(g, "b");
    expect(b).toMatchObject({ rolls: 2, dice: [6, 1, 2, 2], cargo: null, captain: false, kraken: true });
    expect(b.seats.find((s) => s.id === "a")!.play).toEqual({ rolls: 1, held: 1, dice: [4, 5, 3, 2], kept: [0] });
    expect(crewView(g, "x")).toMatchObject({ rolls: 0, dice: [], cargo: null });
  });

  it("carries a game saved when players took turns onto the seat that was on turn", () => {
    const g = started(7);
    const old = { ...g, seats: g.seats.map(({ play: _, ...s }) => s), turn: 1, rolls: 2, held: 1, dice: [4, 5, 3, 2], kept: [0] } as CrewGame;
    expect(crewView(old, "b")).toMatchObject({ rolls: 2, held: 1, dice: [4, 5, 3, 2], kept: [0], cargo: 9 });
    expect(crewView(old, "a")).toMatchObject({ rolls: 0, dice: [] });
    const next = must(old, "b", { type: "stand" });
    expect(seatOf(next, "b").score).toBe(9);
    expect(next).not.toHaveProperty("turn");
  });

  it("keeps the dice you choose where they are and rolls only the rest", () => {
    let g = started(11);
    const first = "a";
    g = holding(g, first, 1, [6, 2, 5, 4], 1);
    g = must(g, first, { type: "roll", keep: [0, 2, 3] });
    expect(dueIds(g)).toContain(first);
    const { dice } = playOf(g, first);
    expect(dice[0]).toBe(6);
    expect(dice[2]).toBe(5);
    expect(dice[3]).toBe(4);
    expect(dice).toHaveLength(4);
    expect(g.lastThrow).toMatchObject({ by: first, fresh: 0, thrown: [1] });
    // Keeping every die is standing, and nonsense indexes are ignored.
    expect(err(holding(g, first, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [0, 1, 2, 3] })).toMatch(/stand/);
    g = must(holding(g, first, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [9, -1, 0] });
    expect(g.lastThrow!.thrown).toEqual([1, 2, 3]);
  });

  it("remembers the dice you held, and lets you let them go", () => {
    let g = started(11);
    const first = "a";
    g = must(holding(g, first, 1, [6, 2, 5, 4], 1), first, { type: "roll", keep: [0, 2] });
    expect(playOf(g, first).kept).toEqual([0, 2]);
    expect(crewView(g, first).kept).toEqual([0, 2]);
    // Next roll, let the 6 go and hold the last 2 instead (a cargo that cannot reach 12, so the round goes on).
    g = must(holding(g, first, 1, [6, 2, 5, 2], 1, [0, 2]), first, { type: "roll", keep: [2, 3] });
    expect(g.lastThrow!.thrown).toEqual([0, 1]);
    expect(playOf(g, first).kept).toEqual([2, 3]);
    // Once they stand, nothing is held.
    const next = must(holding(g, first, 1, [6, 3, 5, 4], 2, [2, 3]), first, { type: "stand" });
    expect(playOf(next, first).kept).toEqual([]);
  });

  it("will not hold a Kraken", () => {
    const g = started(11);
    const first = "a";
    expect(err(holding(g, first, 1, [6, 1, 5, 4], 1), first, { type: "roll", keep: [1] })).toMatch(/Kraken/);
  });

  it("will not stand without a ship, without a captain, or with a Kraken showing, and stands on the cargo otherwise", () => {
    let g = started(3);
    const first = "a";
    expect(err(holding(g, first, 0, [4, 3, 1, 2, 5], 1), first, { type: "stand" })).toMatch(/ship/);
    expect(err(holding(g, first, 1, [6, 6, 6, 4], 1), first, { type: "stand" })).toMatch(/captain/);
    expect(err(holding(g, first, 1, [6, 1, 5, 3], 1), first, { type: "stand" })).toMatch(/Kraken/);
    g = must(holding(g, first, 1, [3, 5, 4, 5], 1), first, { type: "stand" });
    expect(seatOf(g, first)).toMatchObject({ score: 7, lost: null, hand: [6, 3, 5, 4, 5] });
    expect(dueIds(g)).toEqual(["b"]);
    expect(playOf(g, first).rolls).toBe(0);
  });

  it("lets you gamble good cargo on a captain coming up", () => {
    const g = started(3);
    const first = "a";
    // Three 4s of cargo and no captain, one roll left: roll the fourth die and hope for a 5.
    const before = holding(g, first, 1, [4, 4, 4, 2], CREW_ROLLS - 1);
    const won = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).score === 12);
    expect(seatOf(won, first).hand).toEqual([6, 4, 4, 4, 5]);
    const lost = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).lost === "captainless");
    expect(seatOf(lost, first).score).toBe(0);
  });

  it("ends a player's round at once on the best cargo there is", () => {
    const g = started(3);
    const first = "a";
    const best = rollUntil(holding(g, first, 1, [4, 4, 4, 2], 1), first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).score === 12);
    expect(dueIds(best)).not.toContain(first);
  });

  it("lets the Kraken take a cargo still holding one when the rolls run out", () => {
    const g = started(3);
    const first = "a";
    const before = holding(g, first, 1, [4, 4, 5, 1], CREW_ROLLS - 1);
    // Keep the 4s and the captain, roll the Kraken again, and get another.
    const sunk = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => seatOf(n, first).lost === "kraken");
    expect(seatOf(sunk, first)).toMatchObject({ score: 0, lost: "kraken", hand: [6, 4, 4, 5, 1] });
    expect(sunk.lastThrow).toMatchObject({ kraken: true, thrown: [3] });
    // Or roll it away.
    const saved = rollUntil(before, first, { type: "roll", keep: [0, 1, 2] }, (n) => (seatOf(n, first).score ?? 0) > 0);
    expect(seatOf(saved, first).score).toBeGreaterThanOrEqual(8);
    expect(saved.lastThrow!.kraken).toBe(false);
  });

  it("scores nothing without a ship", () => {
    const g = started(3);
    const first = "a";
    const adrift = rollUntil(holding(g, first, 0, [2, 2, 2, 2, 2], CREW_ROLLS - 1), first, { type: "roll" }, (n) => seatOf(n, first).lost === "adrift");
    expect(seatOf(adrift, first).score).toBe(0);
  });

  it("the highest cargo wins the pot, less the house's cut", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, "a", 1, [4, 4, 5, 4], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [3, 2, 5, 2], 1), "b", { type: "stand" });
    g = must(holding(g, "c", 1, [5, 6, 5, 4], 1), "c", { type: "stand" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    expect(g.last?.result).toBe("win");
    expect(crewSplit(g.pot)).toEqual({ house: 3, prize: 27 });
  });

  it("rolls off a tie among only those tied", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, "a", 1, [5, 5, 4, 3], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    g = must(holding(g, "c", 1, [3, 4, 5, 6], 1), "c", { type: "stand" });
    expect(g.phase).toBe("playing");
    expect(g.last).toMatchObject({ result: "tie", ids: ["a", "c"] });
    expect(g.round).toBe(2);
    expect(g.seats.map((s) => s.contending)).toEqual([true, false, true]);
    expect(dueIds(g)).toEqual(["a", "c"]);
    expect(err(g, "b", { type: "leave" })).toMatch(/already out/);
    expect(err(g, "b", { type: "roll" })).toMatch(/out of this round/);
    g = must(holding(g, "a", 1, [2, 2, 5, 2], 1), "a", { type: "stand" });
    expect(dueIds(g)).toEqual(["c"]);
    g = must(holding(g, "c", 1, [2, 2, 5, 3], 1), "c", { type: "stand" });
    expect(g.winner).toBe("c");
  });

  it("plays everyone again when nobody scores", () => {
    // A's round is over on nothing; B is on their last roll with no captain. Find a roll that brings none in.
    const base = started(5);
    const done: CrewGame = { ...base, seats: base.seats.map((s, i) => (i === 0 ? { ...s, score: 0, lost: "adrift", hand: [2, 2, 2, 2, 2] } : s)) };
    const at = holding(done, "b", 1, [2, 2, 2, 2], CREW_ROLLS - 1);
    const g = rollUntil(at, "b", { type: "roll", keep: [0] }, (n) => n.last?.result === "bust");
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(2);
    expect(g.seats.every((s) => s.contending && s.score === null && !s.lost)).toBe(true);
    expect(dueIds(g)).toEqual(["a", "b"]);
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
    // Round 1: a 7, b 6.
    g = must(holding(g, "a", 1, [3, 5, 4, 5], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(2);
    expect(g.last).toMatchObject({ round: 1, result: "next", ids: ["a"] });
    expect(crewView(g).seats.map((s) => [s.total, s.score])).toEqual([[7, null], [6, null]]);
    expect(dueIds(g)).toEqual(["a", "b"]);
    // Round 2: a 6, b 11. b leads, 17 to 13.
    g = must(holding(g, "a", 1, [2, 5, 2, 2], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [4, 5, 4, 3], 1), "b", { type: "stand" });
    expect(g.round).toBe(3);
    expect(g.last).toMatchObject({ round: 2, result: "next", ids: ["b"] });
    expect(g.seats.map((s) => s.total)).toEqual([13, 17]);
    // Round 3: a 12, b 6. a wins on the total, 25 to 23, though b led going into it.
    g = must(holding(g, "a", 1, [4, 4, 5, 4], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [2, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.seats.map((s) => s.total)).toEqual([25, 23]);
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    expect(g.last).toMatchObject({ round: 3, result: "win", ids: ["a"] });
  });

  it("rolls off a tie on totals after the last round, on the roll-off's own cargo", () => {
    let g = started(5, [A, B], 10, 3);
    for (let round = 1; round <= 3; round++) {
      g = must(holding(g, "a", 1, [3, 5, 4, 5], 1), "a", { type: "stand" });
      g = must(holding(g, "b", 1, [4, 5, 3, 5], 1), "b", { type: "stand" });
    }
    expect(g.seats.map((s) => s.total)).toEqual([21, 21]);
    expect(g.last).toMatchObject({ round: 3, result: "tie", ids: ["a", "b"] });
    expect(g.round).toBe(4);
    expect(crewView(g).rounds).toBe(3);
    // The roll-off is on its own cargo, and leaves the totals as they were.
    g = must(holding(g, "a", 1, [2, 5, 2, 2], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [3, 5, 2, 2], 1), "b", { type: "stand" });
    expect(g.winner).toBe("b");
    expect(g.seats.map((s) => s.total)).toEqual([21, 21]);
  });

  it("a forfeit leaves the others playing, and the last one left wins", () => {
    let g = started(9, [A, B, C]);
    g = must(g, "a", { type: "leave" });
    expect(g.seats[0].forfeited).toBe(true);
    expect(dueIds(g)).toEqual(["b", "c"]);
    g = must(g, "c", { type: "leave" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("b");
  });

  it("settles the round when the last one still playing walks away", () => {
    let g = started(9, [A, B, C]);
    g = must(holding(g, "a", 1, [4, 4, 5, 2], 1), "a", { type: "stand" });
    g = must(holding(g, "b", 1, [3, 3, 5, 2], 1), "b", { type: "stand" });
    expect(dueIds(g)).toEqual(["c"]);
    g = must(g, "c", { type: "leave" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
  });

  it("numbers every throw, with who threw and what it brought in, even one that ends their round", () => {
    let g = started(4);
    const first = "a";
    g = must(holding(g, first, 0, [4, 4, 4, 4, 4], CREW_ROLLS - 1), first, { type: "roll" });
    expect(dueIds(g)).not.toContain(first);
    expect(g.lastThrow).toMatchObject({ n: 1, by: first });
    expect(g.lastThrow!.fresh).toBe(seatOf(g, first).lost === "adrift" ? 0 : 1);
    g = must(g, "b", { type: "roll" });
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
    const view = crewView(holding(g, "a", 1, [1, 5, 4, 4], 1), "a");
    expect(view).not.toHaveProperty("rng");
    expect(view.due).toEqual(["a", "b"]);
    expect(view.kraken).toBe(true);
    expect(view.captain).toBe(true);
    // The Kraken is no cargo: 4 and 4.
    expect(view.cargo).toBe(8);
  });
});
