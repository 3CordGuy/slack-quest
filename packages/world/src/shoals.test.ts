import { describe, expect, it } from "vitest";
import { PUB_SHOALS, SHOALS_PASSAGES, createShoalsGame, pubPath, pubRoom, poiAt, shoalsSplit, shoalsView, stepShoals, type ShoalsAction, type ShoalsGame } from "./index";

const A = { id: "a", name: "Ada" };
const must = (g: ShoalsGame, id: string, action: ShoalsAction): ShoalsGame => {
  const res = stepShoals(g, id, action);
  if (!res.ok) throw new Error(`${id} ${JSON.stringify(action)}: ${res.error}`);
  return res.state;
};
const err = (g: ShoalsGame, id: string, action: ShoalsAction): string => {
  const res = stepShoals(g, id, action);
  return res.ok ? "" : res.error;
};
const turnOf = (g: ShoalsGame) => g.seats[g.turn].id;

function started(seed = 7, players = ["a", "b", "c"]): ShoalsGame {
  let g = createShoalsGame(seed, 10, A);
  for (const id of players.slice(1)) g = must(g, id, { type: "sit", name: id.toUpperCase() });
  return must(g, "a", { type: "start" });
}
/** Everyone lays one marker: `shoalBy` lays their Shoal, the rest a Channel. */
function layRound(g: ShoalsGame, shoalBy: string[] = []): ShoalsGame {
  const n = g.seats.filter((s) => s.own.channel + s.own.shoal > 0).length;
  for (let i = 0; i < n; i++) {
    const id = turnOf(g);
    g = must(g, id, { type: "lay", marker: shoalBy.includes(id) ? "shoal" : "channel" });
  }
  return g;
}

describe("shoals", () => {
  it("has a table in the pub that a customer can walk to", () => {
    const room = pubRoom();
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(poiAt(room, PUB_SHOALS)?.kind).toBe("shoals");
    expect(pubPath(room, door, PUB_SHOALS)!.at(-1)).toEqual(PUB_SHOALS);
  });

  it("seats two to four and only lets the opener start", () => {
    let g = createShoalsGame(1, 5, A);
    expect(err(g, "a", { type: "start" })).toMatch(/takes 2/);
    g = must(g, "b", { type: "sit", name: "Bo" });
    expect(err(g, "b", { type: "start" })).toMatch(/opened/);
    g = must(g, "c", { type: "sit", name: "Cy" });
    g = must(g, "d", { type: "sit", name: "Di" });
    expect(err(g, "e", { type: "sit", name: "Ed" })).toMatch(/full/);
    g = must(g, "a", { type: "start" });
    expect(g.pot).toBe(20);
    expect(g.seats.every((s) => s.own.channel === 3 && s.own.shoal === 1)).toBe(true);
  });

  it("makes everyone lay before a bid, and holds bids to what is on the table", () => {
    let g = started();
    const first = turnOf(g);
    expect(err(g, first, { type: "bid", count: 1 })).toMatch(/Everyone lays/);
    g = layRound(g);
    const bidder = turnOf(g);
    expect(err(g, bidder, { type: "bid", count: 4 })).toMatch(/between 1 and 3/);
    g = must(g, bidder, { type: "bid", count: 1 });
    expect(err(g, turnOf(g), { type: "lay", marker: "channel" })).toMatch(/Bidding has opened/);
    expect(err(g, turnOf(g), { type: "bid", count: 1 })).toMatch(/more than 1/);
  });

  it("a clear run is a passage, and two passages win the pot", () => {
    let g = started();
    for (let run = 1; run <= SHOALS_PASSAGES; run++) {
      g = layRound(g);
      const pilot = turnOf(g);
      // Bidding everything on the table ends the bidding at once.
      g = must(g, pilot, { type: "bid", count: 3 });
      expect(g.step).toBe("sail");
      const others = g.seats.filter((s) => s.id !== pilot).map((s) => s.id);
      expect(err(g, pilot, { type: "flip", seat: others[0] })).toMatch(/your own markers first/);
      g = must(g, pilot, { type: "flip", seat: pilot });
      g = must(g, pilot, { type: "flip", seat: others[0] });
      g = must(g, pilot, { type: "flip", seat: others[1] });
      expect(g.seats.find((s) => s.id === pilot)!.passages).toBe(run);
    }
    expect(g.phase).toBe("done");
    expect(g.last?.result).toBe("clear");
    expect(shoalsSplit(g.pot)).toEqual({ house: 3, prize: 27 });
  });

  it("striking a Shoal costs the pilot a marker, and a pilot with none is out", () => {
    let g = started(3, ["a", "b"]);
    const victim = turnOf(g);
    const trapper = g.seats.find((s) => s.id !== victim)!.id;
    for (let lost = 1; lost <= 4; lost++) {
      // The victim always leads: lay, then bid 2 into the trapper's Shoal.
      g = layRound(g, [trapper]);
      expect(turnOf(g)).toBe(victim);
      g = must(g, victim, { type: "bid", count: 2 });
      g = must(g, victim, { type: "flip", seat: victim });
      g = must(g, victim, { type: "flip", seat: trapper });
      const left = g.seats.find((s) => s.id === victim)!.own;
      expect(left.channel + left.shoal).toBe(4 - lost);
      if (lost < 4) expect(g.last).toEqual({ pilot: victim, bid: 2, result: "aground", at: trapper });
    }
    expect(g.phase).toBe("done");
    expect(g.winner).toBe(trapper);
  });

  it("lets the others pass until one pilot holds the bid", () => {
    let g = layRound(started());
    const [x, y, z] = [turnOf(g), "", ""];
    g = must(g, x, { type: "bid", count: 1 });
    const yId = turnOf(g);
    g = must(g, yId, { type: "bid", count: 2 });
    const zId = turnOf(g);
    g = must(g, zId, { type: "pass" });
    expect(turnOf(g)).toBe(x);
    g = must(g, x, { type: "pass" });
    expect(g.step).toBe("sail");
    expect(turnOf(g)).toBe(yId);
    expect(err(g, yId, { type: "pass" })).toMatch(/no bid to pass|standing bid|Nobody|over/);
    void y;
    void z;
  });

  it("never shows a player what is face down in another stack", () => {
    let g = layRound(started(), ["b"]);
    const text = JSON.stringify(shoalsView(g, "a"));
    expect(shoalsView(g, "a").you!.stack).toHaveLength(1);
    expect(shoalsView(g, "a").seats.find((s) => s.id === "b")).toMatchObject({ laid: 1, shown: [] });
    expect(text).not.toContain("rng");
    expect(text).not.toContain('"stack":["shoal"]');
    // A spectator sees no hand at all.
    expect(shoalsView(g, "zed").you).toBeNull();
    // Once turned over, it is public.
    const pilot = turnOf(g);
    g = must(g, pilot, { type: "bid", count: 3 });
    g = must(g, pilot, { type: "flip", seat: pilot });
    if (g.step === "sail") expect(shoalsView(g, "zed").seats.find((s) => s.id === pilot)!.shown).toHaveLength(1);
  });

  it("a pilot who walks away forfeits, and the last one afloat wins", () => {
    let g = layRound(started(5, ["a", "b"]));
    g = must(g, "b", { type: "leave" });
    expect(g.phase).toBe("done");
    expect(g.winner).toBe("a");
    let h = layRound(started(5));
    h = must(h, turnOf(h), { type: "bid", count: 1 });
    h = must(h, "c", { type: "leave" });
    expect(h.phase).toBe("playing");
    expect(h.step).toBe("lay");
    expect(h.seats.every((s) => s.stack.length === 0)).toBe(true);
    expect(h.seats.find((s) => s.id === "c")).toMatchObject({ forfeited: true, own: { channel: 0, shoal: 0 } });
  });
});
