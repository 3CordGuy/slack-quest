import { describe, expect, it } from "vitest";
import { STAKE_MAX, STAKE_PICKS, createCrewGame, createDiceGame, createShoalsGame, createTideGame, crewSplit, diceSplit, isCrewAnte, isDiceAnte, isShoalsAnte, isStake, isTideAnte, shoalsSplit, tideSplit, stakeLabel, stakeText, stepDice, type DiceAction, type DiceGame } from "./index";

const A = { id: "a", name: "Ada" };
const B = { id: "b", name: "Bo" };

function must(state: DiceGame, id: string, action: DiceAction): DiceGame {
  const res = stepDice(state, id, action);
  if (!res.ok) throw new Error(res.error);
  return res.state;
}

describe("table stakes", () => {
  it("takes free, or any whole amount of gold up to the most", () => {
    for (const n of [0, 1, 5, 37, 250, STAKE_MAX]) expect(isStake(n)).toBe(true);
    for (const n of [-1, STAKE_MAX + 1, 2.5, NaN, Infinity, "10", null, undefined]) expect(isStake(n)).toBe(false);
    expect(STAKE_PICKS.every(isStake)).toBe(true);
    expect(STAKE_PICKS[0]).toBe(0);
  });

  it("is the same rule at all four tables", () => {
    for (const n of [0, 37, STAKE_MAX, STAKE_MAX + 1, -5, 1.5]) {
      expect([isDiceAnte(n), isShoalsAnte(n), isCrewAnte(n), isTideAnte(n)]).toEqual([isStake(n), isStake(n), isStake(n), isStake(n)]);
    }
  });

  it("says a free table is free", () => {
    expect([stakeLabel(0), stakeLabel(25)]).toEqual(["free", "25 gold"]);
    expect([stakeText(0), stakeText(25)]).toEqual(["no charge", "25 gold a seat"]);
    expect(createDiceGame(1, 0, A).log[0]).toBe("Ada opened a table at no charge.");
    expect(createShoalsGame(1, 0, A).log[0]).toBe("Ada set out the markers at no charge.");
    expect(createCrewGame(1, 0, A, 1).log[0]).toBe("Ada set out the dice cup at no charge, for one round.");
    expect(createTideGame(1, 0, A, 2).log[0]).toBe("Ada set out the cards at no charge, first to 2 hands.");
    expect(createDiceGame(1, 250, A).log[0]).toBe("Ada opened a table at 250 gold a seat.");
  });

  it("plays a free game to the end with nothing in the pot and nothing to win", () => {
    let g = must(createDiceGame(3, 0, A), "b", { type: "sit", name: B.name });
    g = must(g, "a", { type: "start" });
    expect(g.pot).toBe(0);
    expect(g.log.at(-1)).toBe("Dice down. Playing for the glory of it.");
    for (let i = 0; g.phase === "playing"; i++) {
      if (i > 500) throw new Error("game did not end");
      const seat = g.seats[g.turn];
      g = must(g, seat.id, g.bids.length === 0 ? { type: "bid", count: 1, face: seat.dice[0] } : { type: "call" });
    }
    expect(g.winner).not.toBeNull();
    expect(g.log.at(-1)).toMatch(/^(Ada|Bo) wins the game\.$/);
  });

  it("splits any pot, the house keeping its cut rounded down", () => {
    for (const split of [diceSplit, shoalsSplit, crewSplit, tideSplit]) {
      expect(split(0)).toEqual({ house: 0, prize: 0 });
      expect(split(74)).toEqual({ house: 7, prize: 67 });
      expect(split(2 * STAKE_MAX).prize).toBe(1800);
    }
  });
});
