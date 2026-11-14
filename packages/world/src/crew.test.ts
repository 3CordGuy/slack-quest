import { describe, expect, it } from "vitest";
import { CREW_MAX_PLAYERS, CREW_ROLLS, PUB_CREW, createCrewGame, crewCargo, crewHold, crewSplit, crewView, poiAt, pubPath, pubRoom, stepCrew, type CrewAction, type CrewGame } from "./index";

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

function started(seed: number, players = [A, B], ante = 10): CrewGame {
  let g = createCrewGame(seed, ante, players[0]);
  for (const p of players.slice(1)) g = must(g, p.id, { type: "sit", name: p.name });
  return must(g, players[0].id, { type: "start" });
}
const turnId = (g: CrewGame) => g.seats[g.turn].id;

/** Play to the end: roll until the turn passes, never standing early. */
function playOut(g: CrewGame): CrewGame {
  for (let i = 0; g.phase === "playing"; i++) {
    if (i > 2000) throw new Error("game did not end");
    g = must(g, turnId(g), { type: "roll" });
  }
  return g;
}

/** A game state with the player on turn already holding these dice, for testing what follows. */
const holding = (g: CrewGame, held: number, dice: number[], rolls: number): CrewGame => ({ ...g, held, dice, rolls });

describe("ship, captain and crew", () => {
  it("has a table in the pub that a customer can walk to", () => {
    const room = pubRoom();
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(poiAt(room, PUB_CREW)?.kind).toBe("crew");
    expect(room.pois.filter((p) => p.pos.q === PUB_CREW.q && p.pos.r === PUB_CREW.r)).toHaveLength(1);
    expect(pubPath(room, door, PUB_CREW)!.at(-1)).toEqual(PUB_CREW);
  });

  it("holds ship, captain and crew only in order", () => {
    expect(crewHold(0, [5, 4, 3, 2, 1])).toEqual({ held: 0, dice: [5, 4, 3, 2, 1] });
    expect(crewHold(0, [4, 5, 6, 2, 1])).toEqual({ held: 3, dice: [2, 1] });
    expect(crewHold(0, [6, 4, 4, 2, 1])).toEqual({ held: 1, dice: [4, 4, 2, 1] });
    expect(crewHold(1, [4, 5, 3, 3])).toEqual({ held: 3, dice: [3, 3] });
    expect(crewHold(2, [6, 6, 6])).toEqual({ held: 2, dice: [6, 6, 6] });
    // Two sixes: one is the ship, the other may be cargo.
    expect(crewHold(0, [6, 6, 5, 4, 3])).toEqual({ held: 3, dice: [6, 3] });
    expect(crewCargo(3, [6, 3])).toBe(9);
    expect(crewCargo(2, [6, 3, 1])).toBeNull();
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
    // From a hand with nothing held, three rolls always end the turn.
    g = { ...g, held: 0, dice: [1, 1, 1, 1, 1], rolls: 0 };
    for (let i = 0; i < CREW_ROLLS && turnId(g) === first; i++) g = must(g, first, { type: "roll" });
    expect(turnId(g)).not.toBe(first);
    expect(g.seats.find((s) => s.id === first)!.score).not.toBeNull();
    expect(g.seats.find((s) => s.id === first)!.hand).toHaveLength(5);
  });

  it("will not stand without a full crew, and stands on the cargo once there is one", () => {
    let g = started(3);
    const first = turnId(g);
    g = holding(g, 2, [6, 3, 1], 1);
    expect(err(g, first, { type: "stand" })).toMatch(/ship, a captain and a crew/);
    g = holding(g, 3, [5, 3], 1);
    g = must(g, first, { type: "stand" });
    const seat = g.seats.find((s) => s.id === first)!;
    expect(seat.score).toBe(8);
    expect(seat.hand).toEqual([6, 5, 4, 5, 3]);
    expect(turnId(g)).not.toBe(first);
    expect(g.rolls).toBe(0);
  });

  it("rerolls only the cargo once the crew is in", () => {
    let g = started(11);
    const first = turnId(g);
    g = holding(g, 3, [1, 1], 1);
    g = must(g, first, { type: "roll" });
    if (turnId(g) === first) {
      expect(g.held).toBe(3);
      expect(g.dice).toHaveLength(2);
    } else {
      expect(g.seats.find((s) => s.id === first)!.hand.slice(0, 3)).toEqual([6, 5, 4]);
    }
  });

  it("the highest cargo wins the pot, less the house's cut", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, 3, [6, 6], 1), "a", { type: "stand" });
    g = must(holding(g, 3, [3, 2], 1), "b", { type: "stand" });
    g = must(holding(g, 3, [5, 6], 1), "c", { type: "stand" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    expect(g.last?.result).toBe("win");
    expect(crewSplit(g.pot)).toEqual({ house: 3, prize: 27 });
  });

  it("rolls off a tie among only those tied", () => {
    let g = started(5, [A, B, C]);
    g = must(holding(g, 3, [5, 4], 1), "a", { type: "stand" });
    g = must(holding(g, 3, [2, 2], 1), "b", { type: "stand" });
    g = must(holding(g, 3, [6, 3], 1), "c", { type: "stand" });
    expect(g.phase).toBe("playing");
    expect(g.last).toMatchObject({ result: "tie", ids: ["a", "c"] });
    expect(g.round).toBe(2);
    expect(g.seats.map((s) => s.contending)).toEqual([true, false, true]);
    expect(turnId(g)).toBe("a");
    expect(err(g, "b", { type: "leave" })).toMatch(/already out/);
    g = must(holding(g, 3, [1, 1], 1), "a", { type: "stand" });
    expect(turnId(g)).toBe("c");
    g = must(holding(g, 3, [1, 2], 1), "c", { type: "stand" });
    expect(g.winner).toBe("c");
  });

  it("plays everyone again when nobody scores", () => {
    // A's turn is over on nothing; B is on their last roll with nothing held. Find a roll that brings no ship in.
    const base = started(5);
    let g: CrewGame | null = null;
    for (let seed = 1; seed < 200 && !g; seed++) {
      const at: CrewGame = { ...base, rng: seed, turn: 1, held: 0, dice: [1, 1, 1, 1, 1], rolls: CREW_ROLLS - 1, seats: base.seats.map((s, i) => (i === 0 ? { ...s, score: 0, hand: [1, 1, 1, 1, 1] } : s)) };
      const next = must(at, "b", { type: "roll" });
      if (!next.log.at(-2)?.includes("ship")) g = next;
    }
    expect(g!.phase).toBe("playing");
    expect(g!.last?.result).toBe("bust");
    expect(g!.round).toBe(2);
    expect(g!.seats.every((s) => s.contending && s.score === null)).toBe(true);
    expect(turnId(g!)).toBe("a");
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

  it("never shows the generator", () => {
    const view = crewView(started(1), "a");
    expect(view).not.toHaveProperty("rng");
    expect(view.turn).toBe("a");
  });
});
