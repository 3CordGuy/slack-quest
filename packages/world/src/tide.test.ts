import { describe, expect, it } from "vitest";
import { PUB_TIDE, TIDE_CARDS, TIDE_MAX_PLAYERS, createTideGame, makeRng, poiAt, pubPath, pubRoom, stepTide, tideBest, tideDeck, tideSplit, tideTargets, tideView, tideWins, type TideAction, type TideGame } from "./index";

const A = { id: "a", name: "Ada" };
const B = { id: "b", name: "Bo" };
const C = { id: "c", name: "Cy" };

function must(state: TideGame, id: string, action: TideAction): TideGame {
  const res = stepTide(state, id, action);
  if (!res.ok) throw new Error(res.error);
  return res.state;
}
const err = (state: TideGame, id: string, action: TideAction) => {
  const res = stepTide(state, id, action);
  return res.ok ? null : res.error;
};

function started(seed: number, players = [A, B], wins = 1): TideGame {
  let g = createTideGame(seed, 10, players[0], wins);
  for (const p of players.slice(1)) g = must(g, p.id, { type: "sit", name: p.name });
  return must(g, players[0].id, { type: "start" });
}
const seatOf = (g: TideGame, id: string) => g.seats.find((s) => s.id === id)!;

/** The hand as dealt, but with these cards in these hands (the player on turn holds two) and this deck. */
function rig(g: TideGame, hands: Record<string, number[]>, deck: number[] = [5, 5, 5], extra: Partial<TideGame> = {}): TideGame {
  return { ...g, deck, seats: g.seats.map((s) => ({ ...s, hand: hands[s.id] ?? s.hand })), ...extra };
}

/** Whatever move is legal, picked by `rng`. */
function anyMove(g: TideGame, rng: ReturnType<typeof makeRng>): { id: string; action: TideAction } {
  if (g.stage === "shown") return { id: g.seats.find((s) => !s.forfeited)!.id, action: { type: "deal" } };
  const seat = g.seats[g.turn];
  if (g.stage === "choice") return { id: seat.id, action: { type: "smuggle", swap: rng.chance(0.5) } };
  const card = rng.pick(seat.hand.filter((c) => c !== 9));
  const targets = tideTargets(g.seats, seat.id);
  return { id: seat.id, action: { type: "play", card, target: targets.length ? rng.pick(targets) : undefined, guess: rng.pick([1, 3, 4, 5, 6, 7, 8, 9]) } };
}

describe("turn the tide", () => {
  it("has a table in the pub that a customer can walk to", () => {
    const room = pubRoom();
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(poiAt(room, PUB_TIDE)?.kind).toBe("tide");
    expect(room.pois.filter((p) => p.pos.q === PUB_TIDE.q && p.pos.r === PUB_TIDE.r)).toHaveLength(1);
    expect(pubPath(room, door, PUB_TIDE)!.at(-1)).toEqual(PUB_TIDE);
  });

  it("is twenty cards, ranked 1 to 9", () => {
    expect(tideDeck()).toHaveLength(20);
    expect(TIDE_CARDS.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tideWins(3)).toBe(3);
    expect(tideWins(7)).toBe(2);
    expect(tideSplit(30)).toEqual({ house: 3, prize: 27 });
  });

  it("deals one card each, buries one, and the first player draws", () => {
    const g = started(7, [A, B, C]);
    expect(g.phase).toBe("playing");
    expect(g.pot).toBe(30);
    expect(g.seats.map((s) => s.hand.length)).toEqual([2, 1, 1]);
    expect(g.buried).not.toBeNull();
    expect(g.deck).toHaveLength(20 - 1 - 3 - 1);
    expect([...g.deck, g.buried!, ...g.seats.flatMap((s) => s.hand)].sort()).toEqual(tideDeck().sort());
    expect(g.tide).toBe("high");
  });

  it("seats up to five, and only the opener starts", () => {
    let g = createTideGame(1, 5, A);
    expect(err(g, "a", { type: "start" })).toMatch(/two/);
    for (let i = 1; i < TIDE_MAX_PLAYERS; i++) g = must(g, `p${i}`, { type: "sit", name: `P${i}` });
    expect(err(g, "x", { type: "sit", name: "X" })).toMatch(/full/);
    expect(err(g, "p1", { type: "start" })).toMatch(/opened/);
  });

  it("shows a player their own hand and nobody else's", () => {
    const g = rig(started(3), { a: [1, 5], b: [9] });
    const a = tideView(g, "a");
    expect(a.seats[0].hand).toEqual([1, 5]);
    expect(a.seats[1].hand).toBeNull();
    expect(a.seats[1].cards).toBe(1);
    expect(a.buried).toBeNull();
    expect(JSON.stringify(a)).not.toContain('"rng"');
    expect((a as unknown as { deck: unknown }).deck).toBe(3);
    expect(tideView(g, "nobody").seats.every((s) => s.hand === null)).toBe(true);
  });

  it("only lets the player on turn play a card they hold, and never the Kraken", () => {
    const g = rig(started(3), { a: [9, 5], b: [3] });
    expect(err(g, "b", { type: "play", card: 3, target: "a" })).toMatch(/turn/);
    expect(err(g, "a", { type: "play", card: 6 })).toMatch(/hold/);
    expect(err(g, "a", { type: "play", card: 9 })).toMatch(/Kraken/);
  });

  it("a Gull that names the right card knocks its target out", () => {
    const g = rig(started(3, [A, B, C]), { a: [2, 6], b: [8], c: [4] });
    expect(err(g, "a", { type: "play", card: 2, target: "b", guess: 2 })).toMatch(/Gull/);
    expect(err(g, "a", { type: "play", card: 2, guess: 8 })).toMatch(/Pick/);
    const miss = must(g, "a", { type: "play", card: 2, target: "b", guess: 7 });
    expect(seatOf(miss, "b").out).toBe(false);
    expect(miss.lastPlay).toMatchObject({ by: "a", card: 2, target: "b", guess: 7, hit: false });
    expect(miss.seats[miss.turn].id).toBe("b");
    const hit = must(g, "a", { type: "play", card: 2, target: "b", guess: 8 });
    expect(seatOf(hit, "b")).toMatchObject({ out: true, hand: [], played: [8] });
    expect(hit.seats[hit.turn].id).toBe("c");
  });

  it("the last player left wins the hand", () => {
    const g = rig(started(3), { a: [2, 6], b: [8] });
    const n = must(g, "a", { type: "play", card: 2, target: "b", guess: 8 });
    expect(n.last).toMatchObject({ how: "last", winners: ["a"] });
    expect(n.phase).toBe("done");
    expect(n.winner).toBe("a");
  });

  it("a Spyglass shows its player the card, until that card is played", () => {
    let g = rig(started(3, [A, B, C]), { a: [3, 6], b: [5], c: [4] }, [1, 2, 2, 2]);
    g = must(g, "a", { type: "play", card: 3, target: "b" });
    expect(tideView(g, "a").seats[1].known).toBe(5);
    expect(tideView(g, "c").seats[1].known).toBeNull();
    // Bo drew the Stowaway and plays it: Ada still knows the Moon is there.
    g = must(g, "b", { type: "play", card: 1 });
    expect(tideView(g, "a").seats[1].known).toBe(5);
    g = must(g, "c", { type: "play", card: 2, target: "a", guess: 9 });
    g = must(g, "a", { type: "play", card: 2, target: "c", guess: 9 });
    g = must(g, "b", { type: "play", card: 5 });
    expect(tideView(g, "a").seats[1].known).toBeNull();
  });

  it("a Cutlass sends out whoever the tide is against", () => {
    const g = rig(started(3, [A, B, C]), { a: [4, 7], b: [3], c: [1] });
    const high = must(g, "a", { type: "play", card: 4, target: "b" });
    expect(seatOf(high, "b").out).toBe(true);
    const low = must({ ...g, tide: "low" }, "a", { type: "play", card: 4, target: "b" });
    expect(seatOf(low, "a")).toMatchObject({ out: true, played: [4, 7] });
    expect(seatOf(low, "b").out).toBe(false);
    const tie = must(rig(g, { a: [4, 3] }), "a", { type: "play", card: 4, target: "b" });
    expect(tie.lastPlay?.tie).toBe(true);
    expect(tie.seats.filter((s) => s.out)).toHaveLength(0);
    expect(tideView(tie, "b").seats[0].known).toBe(3);
  });

  it("the Moon turns the tide, and the tide decides the hand when the deck runs out", () => {
    const g = rig(started(3), { a: [5, 3], b: [8] }, []);
    const n = must(g, "a", { type: "play", card: 5 });
    expect(n.tide).toBe("low");
    expect(n.last).toMatchObject({ how: "shown", tide: "low", winners: ["a"] });
    const high = must(rig(started(3), { a: [1, 3], b: [8] }, []), "a", { type: "play", card: 1 });
    expect(high.last?.winners).toEqual(["b"]);
    // Once it is over the cards are no secret, the buried one included.
    const v = tideView(high, "a");
    expect(v.seats[1].hand).toEqual([8]);
    expect(v.buried).toBe(high.buried);
  });

  it("breaks a tie on the cards played, and shares the hand if that ties too", () => {
    expect(tideBest("high", [{ id: "a", card: 6, played: 3 }, { id: "b", card: 6, played: 7 }, { id: "c", card: 2, played: 9 }])).toEqual(["b"]);
    expect(tideBest("low", [{ id: "a", card: 6, played: 3 }, { id: "c", card: 2, played: 9 }])).toEqual(["c"]);
    expect(tideBest("high", [{ id: "a", card: 6, played: 3 }, { id: "b", card: 6, played: 3 }])).toEqual(["a", "b"]);
    // A shared hand settles nothing: nobody is alone in the lead, so another is dealt.
    const even = rig(started(3), { a: [2, 2], b: [2] }, []);
    const g = must({ ...even, seats: even.seats.map((s) => ({ ...s, played: s.id === "b" ? [2] : [] })) }, "a", { type: "play", card: 2, target: "b", guess: 9 });
    expect(g.last?.winners).toEqual(["a", "b"]);
    expect(g.phase).toBe("playing");
    expect(g.stage).toBe("shown");
  });

  it("nobody can play a card on a player at anchor, and the anchor comes up on their turn", () => {
    let g = rig(started(3, [A, B, C]), { a: [6, 1], b: [2], c: [3] }, [2, 4, 5, 5]);
    g = must(g, "a", { type: "play", card: 6 });
    expect(tideTargets(g.seats, "b")).toEqual(["c"]);
    expect(err(g, "b", { type: "play", card: 2, target: "a", guess: 1 })).toMatch(/anchor/);
    g = must(g, "b", { type: "play", card: 2, target: "c", guess: 9 });
    g = must(g, "c", { type: "play", card: 3, target: "b" });
    expect(seatOf(g, "a").anchored).toBe(false);
    // With everyone else at anchor, an aimed card is played on nobody.
    const two = must(rig(started(3), { a: [6, 1], b: [2] }, [2, 5]), "a", { type: "play", card: 6 });
    const wasted = must(two, "b", { type: "play", card: 2 });
    expect(wasted.lastPlay?.wasted).toBe(true);
  });

  it("a Storm passes every card on, but for those at anchor", () => {
    let g = rig(started(3, [A, B, C]), { a: [7, 1], b: [9], c: [4] });
    const all = must(g, "a", { type: "play", card: 7 });
    expect(all.seats.map((s) => s.hand.filter((_, i) => i === 0)[0])).toEqual([4, 1, 9]);
    expect(all.lastPlay?.moved).toEqual(["a", "b", "c"]);
    expect(tideView(all, "a").seats[1].known).toBe(1);
    expect(tideView(all, "c").seats[0].known).toBe(4);
    g = { ...g, seats: g.seats.map((s) => (s.id === "b" ? { ...s, anchored: true } : s)) };
    const some = must(g, "a", { type: "play", card: 7 });
    expect(seatOf(some, "a").hand).toEqual([4]);
    expect(seatOf(some, "b").hand[0]).toBe(9);
    expect(seatOf(some, "c").hand).toEqual([1]);
  });

  it("the Smuggler looks at the buried card and may swap for it", () => {
    const g = rig(started(3), { a: [8, 9], b: [3] }, [5, 5], { buried: 1, tide: "low" });
    const looking = must(g, "a", { type: "play", card: 8 });
    expect(looking.stage).toBe("choice");
    expect(tideView(looking, "a")).toMatchObject({ buried: 1, choice: true });
    expect(tideView(looking, "b")).toMatchObject({ buried: null, choice: false });
    expect(err(looking, "b", { type: "smuggle", swap: true })).toMatch(/turn/);
    expect(err(looking, "a", { type: "play", card: 9 })).toMatch(/buried/);
    const swapped = must(looking, "a", { type: "smuggle", swap: true });
    expect(seatOf(swapped, "a").hand).toEqual([1]);
    expect(swapped.buried).toBe(9);
    expect(swapped.lastPlay).toMatchObject({ card: 8, swapped: true });
    expect(swapped.seats[swapped.turn].id).toBe("b");
    const kept = must(looking, "a", { type: "smuggle", swap: false });
    expect(seatOf(kept, "a").hand).toEqual([9]);
    expect(kept.buried).toBe(1);
    expect(kept.lastPlay?.swapped).toBe(false);
  });

  it("plays hands until someone is alone in the lead with enough, the winner leading the next", () => {
    let g = rig(started(3, [A, B], 2), { a: [1, 3], b: [8] }, []);
    g = must(g, "a", { type: "play", card: 1 });
    expect(g.phase).toBe("playing");
    expect(seatOf(g, "b").wins).toBe(1);
    expect(err(g, "a", { type: "play", card: 3 })).toMatch(/No hand/);
    g = must(g, "a", { type: "deal" });
    expect(g.hand).toBe(2);
    expect(g.stage).toBe("play");
    expect(g.seats[g.turn].id).toBe("b");
    expect(g.tide).toBe("high");
    g = must(rig(g, { a: [2], b: [1, 4] }, []), "b", { type: "play", card: 1 });
    expect(g.winner).toBe("b");
    expect(g.phase).toBe("done");
  });

  it("walking away forfeits: the hand goes on, or the last one left takes the pot", () => {
    const g = rig(started(3, [A, B, C]), { a: [2, 6], b: [8], c: [4] });
    const mid = must(g, "a", { type: "leave" });
    expect(seatOf(mid, "a")).toMatchObject({ forfeited: true, out: true, hand: [] });
    expect(mid.seats[mid.turn].id).toBe("b");
    expect(seatOf(mid, "b").hand).toHaveLength(2);
    const end = must(mid, "c", { type: "leave" });
    expect(end.winner).toBe("b");
    // Someone not on turn leaves a two-player hand: the other wins the game.
    expect(must(rig(started(3), { a: [2, 6], b: [8] }), "b", { type: "leave" }).winner).toBe("a");
    // Leaving while choosing passes the turn on.
    const choosing = must(rig(g, { a: [8, 6] }), "a", { type: "play", card: 8 });
    const left = must(choosing, "a", { type: "leave" });
    expect(left.stage).toBe("play");
    expect(left.seats[left.turn].id).toBe("b");
  });

  it("always comes to an end, whatever is played", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = makeRng(seed * 977);
      let g = started(seed, [A, B, C, { id: "d", name: "Di" }].slice(0, 2 + (seed % 3)), 1 + (seed % 3));
      for (let i = 0; g.phase === "playing"; i++) {
        if (i > 3000) throw new Error("game did not end");
        const { id, action } = anyMove(g, rng);
        g = must(g, id, action);
        // Every card is somewhere, exactly once.
        if (g.stage !== "shown") expect([...g.deck, g.buried!, ...g.seats.flatMap((s) => [...s.hand, ...s.played])].sort()).toEqual(tideDeck().sort());
      }
      expect(g.winner).not.toBeNull();
    }
  });
});
