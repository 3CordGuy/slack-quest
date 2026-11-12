import { describe, expect, it } from "vitest";
import { DICE_START, PUB_DICE, createDiceGame, diceSplit, diceView, pubPath, pubRoom, poiAt, stepDice, type DiceAction, type DiceGame } from "./index";

const A = { id: "a", name: "Ada" };
const B = { id: "b", name: "Bo" };
const C = { id: "c", name: "Cy" };

function must(state: DiceGame, id: string, action: DiceAction): DiceGame {
  const res = stepDice(state, id, action);
  if (!res.ok) throw new Error(res.error);
  return res.state;
}
const err = (state: DiceGame, id: string, action: DiceAction) => {
  const res = stepDice(state, id, action);
  return res.ok ? null : res.error;
};

function started(seed: number, players = [A, B], ante = 10): DiceGame {
  let g = createDiceGame(seed, ante, players[0]);
  for (const p of players.slice(1)) g = must(g, p.id, { type: "sit", name: p.name });
  return must(g, players[0].id, { type: "start" });
}
const turnId = (g: DiceGame) => g.seats[g.turn].id;
const count = (g: DiceGame, face: number) => g.seats.reduce((n, s) => n + s.dice.filter((d) => d === face).length, 0);

/** Play to the end with a fixed, dull strategy: open on your own first die, otherwise call. */
function playOut(g: DiceGame): DiceGame {
  for (let i = 0; g.phase === "playing"; i++) {
    if (i > 500) throw new Error("game did not end");
    const seat = g.seats[g.turn];
    g = must(g, seat.id, g.bids.length === 0 ? { type: "bid", count: 1, face: seat.dice[0] } : { type: "call" });
  }
  return g;
}

describe("dice table", () => {
  it("puts the table on a free hex a player can walk to", () => {
    const room = pubRoom();
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(poiAt(room, PUB_DICE)?.kind).toBe("dice");
    expect(room.pois.filter((p) => p.pos.q === PUB_DICE.q && p.pos.r === PUB_DICE.r)).toHaveLength(1);
    expect(pubPath(room, door, PUB_DICE)!.at(-1)).toEqual(PUB_DICE);
  });

  it("seats two to four players and only lets the opener start", () => {
    let g = createDiceGame(1, 5, A);
    expect(err(g, "a", { type: "start" })).toMatch(/two/);
    g = must(g, "b", { type: "sit", name: "Bo" });
    expect(err(g, "b", { type: "sit", name: "Bo" })).toMatch(/already/);
    expect(err(g, "b", { type: "start" })).toMatch(/opened/);
    g = must(g, "c", { type: "sit", name: "Cy" });
    g = must(g, "d", { type: "sit", name: "Di" });
    expect(err(g, "e", { type: "sit", name: "Ed" })).toMatch(/full/);
    g = must(g, "a", { type: "start" });
    expect(g.phase).toBe("playing");
    expect(g.pot).toBe(20);
    for (const s of g.seats) {
      expect(s.dice).toHaveLength(DICE_START);
      for (const d of s.dice) expect(d >= 1 && d <= 6).toBe(true);
    }
    expect(err(g, "e", { type: "sit", name: "Ed" })).toMatch(/started/);
  });

  it("hands the table on when someone gets up before the start", () => {
    let g = must(createDiceGame(1, 5, A), "b", { type: "sit", name: "Bo" });
    g = must(g, "a", { type: "leave" });
    expect(g.seats.map((s) => s.id)).toEqual(["b"]);
    expect(g.host).toBe("b");
    expect(g.phase).toBe("open");
    expect(must(g, "b", { type: "leave" }).seats).toHaveLength(0);
  });

  it("plays the same full game from the same seed", () => {
    const one = playOut(started(42, [A, B, C]));
    const two = playOut(started(42, [A, B, C]));
    expect(two).toEqual(one);
    expect(one.phase).toBe("done");
    const left = one.seats.filter((s) => s.dice.length > 0);
    expect(left).toHaveLength(1);
    expect(one.winner).toBe(left[0].id);
    expect(one.pot).toBe(30);
    expect(one.log.at(-1)).toBe(`${left[0].name} wins 27 gold.`);
    // Each call costs exactly one die, and every call but the last deals a new round.
    expect(one.round).toBe(3 * DICE_START - left[0].dice.length);
    // A different seed deals different dice.
    expect(started(43, [A, B, C]).seats.map((s) => s.dice)).not.toEqual(started(42, [A, B, C]).seats.map((s) => s.dice));
    expect(playOut(started(7)).phase).toBe("done");
  });

  it("validates bids", () => {
    let g = started(3);
    expect(err(g, "b", { type: "bid", count: 1, face: 2 })).toMatch(/not your turn/);
    expect(err(g, "a", { type: "call" })).toMatch(/no bid/);
    expect(err(g, "a", { type: "bid", count: 1, face: 7 })).toMatch(/face/);
    expect(err(g, "a", { type: "bid", count: 1, face: 0 })).toMatch(/face/);
    expect(err(g, "a", { type: "bid", count: 0, face: 3 })).toMatch(/between/);
    expect(err(g, "a", { type: "bid", count: 1.5, face: 3 })).toMatch(/between/);
    expect(err(g, "a", { type: "bid", count: 7, face: 3 })).toMatch(/between 1 and 6/);
    g = must(g, "a", { type: "bid", count: 2, face: 3 });
    expect(turnId(g)).toBe("b");
    expect(err(g, "a", { type: "bid", count: 3, face: 3 })).toMatch(/not your turn/);
    expect(err(g, "b", { type: "bid", count: 2, face: 3 })).toMatch(/Raise/);
    expect(err(g, "b", { type: "bid", count: 2, face: 2 })).toMatch(/Raise/);
    expect(err(g, "b", { type: "bid", count: 1, face: 6 })).toMatch(/Raise/);
    expect(must(g, "b", { type: "bid", count: 2, face: 4 }).bids).toHaveLength(2);
    expect(must(g, "b", { type: "bid", count: 3, face: 1 }).bids.at(-1)).toEqual({ by: "b", count: 3, face: 1 });
    expect(err(g, "zed", { type: "call" })).toMatch(/not your turn/);
  });

  it("costs the bidder a die when a called bid does not hold", () => {
    const g0 = started(5);
    // Nobody can have six of anything they do not all share: find a face that falls short.
    const face = [1, 2, 3, 4, 5, 6].find((f) => count(g0, f) < 6)!;
    const g1 = must(g0, "a", { type: "bid", count: 6, face });
    const g2 = must(g1, "b", { type: "call" });
    expect(g2.reveal).toEqual({ bid: { by: "a", count: 6, face }, caller: "b", hands: g0.seats.map((s) => ({ id: s.id, dice: s.dice })), actual: count(g0, face), loser: "a" });
    expect(g2.seats.map((s) => s.dice.length)).toEqual([DICE_START - 1, DICE_START]);
    // The loser opens the next round, with fresh dice and no bid standing.
    expect(turnId(g2)).toBe("a");
    expect(g2.bids).toEqual([]);
    expect(g2.round).toBe(g0.round + 1);
  });

  it("costs the caller a die when a called bid holds", () => {
    const g0 = started(5);
    const face = g0.seats[0].dice[0];
    const g2 = must(must(g0, "a", { type: "bid", count: 1, face }), "b", { type: "call" });
    expect(g2.reveal!.loser).toBe("b");
    expect(g2.reveal!.actual).toBeGreaterThanOrEqual(1);
    expect(g2.seats.map((s) => s.dice.length)).toEqual([DICE_START, DICE_START - 1]);
    expect(turnId(g2)).toBe("b");
  });

  it("passes play on when the player to move forfeits", () => {
    const g0 = must(started(9, [A, B, C]), "a", { type: "bid", count: 1, face: 2 });
    expect(turnId(g0)).toBe("b");
    const g1 = must(g0, "b", { type: "leave" });
    expect(g1.phase).toBe("playing");
    expect(g1.seats[1]).toMatchObject({ dice: [], forfeited: true });
    expect(turnId(g1)).toBe("c");
    // The round starts over without them.
    expect(g1.bids).toEqual([]);
    expect(g1.round).toBe(g0.round + 1);
    expect(err(g1, "b", { type: "leave" })).toMatch(/already out/);
    expect(err(g1, "b", { type: "bid", count: 1, face: 1 })).toMatch(/not your turn/);
  });

  it("keeps the turn where it was when someone else forfeits", () => {
    const g0 = started(9, [A, B, C]);
    const g1 = must(g0, "c", { type: "leave" });
    expect(turnId(g1)).toBe("a");
    // Play skips the empty seat from then on.
    const g2 = must(must(g1, "a", { type: "bid", count: 1, face: 1 }), "b", { type: "bid", count: 2, face: 1 });
    expect(turnId(g2)).toBe("a");
  });

  it("gives the pot to the last player when everyone else leaves", () => {
    const g = must(must(started(9, [A, B, C]), "a", { type: "leave" }), "c", { type: "leave" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("b");
    expect(err(g, "b", { type: "leave" })).toMatch(/over/);
    expect(err(g, "b", { type: "bid", count: 1, face: 1 })).toMatch(/No game/);
  });

  it("keeps a tenth of the pot for the house, rounded down", () => {
    expect(diceSplit(10)).toEqual({ house: 1, prize: 9 });
    expect(diceSplit(15)).toEqual({ house: 1, prize: 14 });
    expect(diceSplit(40)).toEqual({ house: 4, prize: 36 });
    expect(diceSplit(80)).toEqual({ house: 8, prize: 72 });
  });

  it("never shows a player anyone else's hidden dice", () => {
    // Walk a whole game, checking every view at every step.
    let g = started(11, [A, B, C]);
    for (let i = 0; g.phase === "playing" && i < 500; i++) {
      for (const viewer of ["a", "b", "c", "watcher", null]) {
        const view = diceView(g, viewer);
        expect(view).not.toHaveProperty("rng");
        for (const s of g.seats) {
          const seen = view.seats.find((v) => v.id === s.id)!;
          expect(seen.count).toBe(s.dice.length);
          expect(seen.dice).toEqual(s.id === viewer ? s.dice : null);
        }
        // Apart from the viewer's own hand, the only dice anywhere in the view are those of an already resolved call.
        const stripped = { ...view, seats: view.seats.map((s) => ({ ...s, dice: null })), reveal: null };
        expect(JSON.stringify(stripped)).not.toMatch(/"dice":\[/);
        expect(Object.keys(view).sort()).toEqual(["ante", "bids", "host", "log", "phase", "pot", "prize", "reveal", "round", "seats", "turn", "winner"]);
      }
      const before = g;
      const seat = g.seats[g.turn];
      g = must(g, seat.id, g.bids.length === 0 ? { type: "bid", count: 1, face: seat.dice[0] } : { type: "call" });
      // A reveal shows the round that was called, never the one just dealt.
      if (before.bids.length > 0) expect(g.reveal!.hands).toEqual(before.seats.filter((s) => s.dice.length > 0).map((s) => ({ id: s.id, dice: s.dice })));
    }
    expect(g.phase).toBe("done");
  });
});
