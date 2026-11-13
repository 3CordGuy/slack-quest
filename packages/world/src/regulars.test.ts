import { describe, expect, it } from "vitest";
import {
  ERRANDS_PER_DAY,
  FETCH_GOLD_MAX,
  MATERIAL_WORTH,
  NO_FACTS,
  REGULARS,
  REGULARS_PER_DAY,
  TRADES_PER_DAY,
  acceptProblem,
  errandFor,
  errandProgress,
  errandsOn,
  handInProblem,
  parseErrand,
  questMet,
  regular,
  regularsAt,
  regularsOn,
  swapProblem,
  type Errand,
  type ErrandRecord,
} from "./regulars";
import { RESOURCE_KINDS, type Resources } from "./hut";
import { PUB_REGULAR_SPOTS, pubPath, pubRoom } from "./pub";

const days = (n: number, from = Date.UTC(2026, 10, 1)) => Array.from({ length: n }, (_, i) => new Date(from + i * 86_400_000).toISOString().slice(0, 10));
const units = (r: Resources) => RESOURCE_KINDS.reduce((n, k) => n + (r[k] ?? 0), 0);
const worth = (r: Resources) => RESOURCE_KINDS.reduce((n, k) => n + (r[k] ?? 0) * MATERIAL_WORTH[k], 0);
/** Every offer over many crews and days: enough to see each kind from each regular. */
const ALL: Errand[] = ["CREWAA", "CREWBB", "PMQVTH", "FKJMGK"].flatMap((crew) => days(120).flatMap((day) => REGULARS.map((r) => errandFor(crew, day, r))));
const record = (errand: Errand, over: Partial<ErrandRecord> = {}): ErrandRecord => ({ errand, acceptedAt: 1, doneAt: null, count: 0, ...over });

describe("who is in", () => {
  it("is the same for the same crew and day, and three different regulars", () => {
    for (const day of days(30)) {
      const a = regularsOn("CREWAA", day);
      expect(a.map((r) => r.id)).toEqual(regularsOn("CREWAA", day).map((r) => r.id));
      expect(new Set(a.map((r) => r.id)).size).toBe(REGULARS_PER_DAY);
    }
  });

  it("rotates from day to day and differs between crews", () => {
    const cast = (crew: string, day: string) => regularsOn(crew, day).map((r) => r.id).join(",");
    const week = days(14).map((d) => cast("CREWAA", d));
    expect(new Set(week).size).toBeGreaterThan(3);
    expect(days(14).some((d) => cast("CREWAA", d) !== cast("CREWBB", d))).toBe(true);
    // Over a month everyone comes in.
    const seen = new Set(days(30).flatMap((d) => regularsOn("CREWAA", d).map((r) => r.id)));
    expect(seen.size).toBe(REGULARS.length);
  });

  it("changes at UTC midnight", () => {
    const midnight = Date.UTC(2026, 10, 12);
    expect(regularsAt("CREWAA", midnight - 1).map((r) => r.id)).toEqual(regularsOn("CREWAA", "2026-11-11").map((r) => r.id));
    expect(regularsAt("CREWAA", midnight).map((r) => r.id)).toEqual(regularsOn("CREWAA", "2026-11-12").map((r) => r.id));
  });

  it("has a spot for every regular in, which nobody can walk onto", () => {
    expect(PUB_REGULAR_SPOTS).toHaveLength(REGULARS_PER_DAY);
    const room = pubRoom();
    const floor = (p: { q: number; r: number }) => room.tiles.some((t) => t.q === p.q && t.r === p.r && t.biome === "floor");
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    for (const s of PUB_REGULAR_SPOTS) {
      expect(floor(s.pos)).toBe(true);
      expect(pubPath(room, door, s.pos)).toBeNull();
      expect(pubPath(room, door, s.stand)).not.toBeNull();
    }
  });
});

describe("the jobs", () => {
  it("are fixed by crew, day and regular", () => {
    const who = REGULARS[0];
    expect(errandFor("CREWAA", "2026-11-12", who)).toEqual(errandFor("CREWAA", "2026-11-12", who));
    expect(errandsOn("CREWAA", "2026-11-12").map((e) => e.regular)).toEqual(regularsOn("CREWAA", "2026-11-12").map((r) => r.id));
  });

  it("come in every kind a regular hands out", () => {
    for (const who of REGULARS) {
      const kinds = new Set(ALL.filter((e) => e.regular === who.id).map((e) => e.kind));
      expect([...kinds].sort()).toEqual([...new Set(who.kinds)].sort());
    }
  });

  it("fetch: three to six of what the regular wants, paid in gold and a few XP", () => {
    const fetches = ALL.filter((e) => e.kind === "fetch");
    expect(fetches.length).toBeGreaterThan(50);
    for (const e of fetches) {
      if (e.kind !== "fetch") continue;
      const who = regular(e.regular)!;
      expect(units(e.need)).toBeGreaterThanOrEqual(3);
      expect(units(e.need)).toBeLessThanOrEqual(6);
      for (const k of RESOURCE_KINDS) if (e.need[k]) expect(who.wants).toContain(k);
      expect(Object.values(e.need).every((n) => n! > 0)).toBe(true);
      expect(e.reward.xp).toBeGreaterThan(0);
      expect(e.reward.xp).toBeLessThanOrEqual(8);
      expect(e.reward.gold).toBeGreaterThanOrEqual(Math.min(FETCH_GOLD_MAX, worth(e.need) * 4));
      expect(e.reward.gold).toBeLessThanOrEqual(FETCH_GOLD_MAX);
      if (e.reward.resources) expect(units(e.reward.resources)).toBe(1);
    }
    // Some pay a piece of material on top.
    expect(fetches.some((e) => e.reward.resources)).toBe(true);
  });

  it("trade: one material for another, never worse than fair, a few times a day", () => {
    const trades = ALL.filter((e) => e.kind === "trade");
    expect(trades.length).toBeGreaterThan(50);
    for (const e of trades) {
      if (e.kind !== "trade") continue;
      const who = regular(e.regular)!;
      const [take] = RESOURCE_KINDS.filter((k) => e.give[k]);
      const [back] = RESOURCE_KINDS.filter((k) => e.get[k]);
      expect(who.wants).toContain(take);
      expect(who.gives).toContain(back);
      expect(take).not.toBe(back);
      expect(units(e.get)).toBeGreaterThanOrEqual(1);
      // Rounded to whole pieces, it still pays at least what it takes.
      expect(worth(e.get)).toBeGreaterThanOrEqual(worth(e.give));
      expect(worth(e.get)).toBeLessThanOrEqual(worth(e.give) * 1.5);
      expect(e.times).toBe(TRADES_PER_DAY);
    }
  });

  it("quest: something the regular cares about, voyage work paying the most", () => {
    const quests = ALL.filter((e) => e.kind === "quest");
    const goals = new Set(quests.map((e) => (e.kind === "quest" ? e.goal : "")));
    expect([...goals].sort()).toEqual(["contract", "give", "rest", "voyage"]);
    for (const e of quests) {
      if (e.kind !== "quest") continue;
      expect(regular(e.regular)!.quests).toContain(e.goal);
      expect(e.text.length).toBeGreaterThan(10);
    }
    const pay = (goal: string) => Math.max(...quests.filter((e) => e.kind === "quest" && e.goal === goal).map((e) => e.reward.xp));
    expect(pay("voyage")).toBeGreaterThan(pay("rest"));
  });

  it("stay modest: no job pays more than a notice-board contract", () => {
    // A third of the day's Harbor XP at most, and no more gold than a contract (25 to 40).
    for (const e of ALL) expect(e.reward.xp).toBeLessThanOrEqual(10);
    for (const e of ALL) expect(e.reward.gold).toBeLessThanOrEqual(35);
  });

  it("survive being stored and read back", () => {
    for (const e of ALL.slice(0, 40)) expect(parseErrand(JSON.stringify(e))).toEqual(e);
    expect(parseErrand("not json")).toBeNull();
    expect(parseErrand(JSON.stringify({ ...ALL[0], regular: "nobody" }))).toBeNull();
    expect(parseErrand(JSON.stringify({ ...ALL[0], kind: "heist" }))).toBeNull();
  });
});

describe("doing them", () => {
  const fetch = ALL.find((e) => e.kind === "fetch")! as Extract<Errand, { kind: "fetch" }>;
  const quest = ALL.find((e) => e.kind === "quest" && e.goal === "rest")! as Extract<Errand, { kind: "quest" }>;
  const trade = ALL.find((e) => e.kind === "trade")! as Extract<Errand, { kind: "trade" }>;
  const plenty: Resources = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, 20]));

  it("takes on a job once, and one at a time with each regular", () => {
    expect(acceptProblem(fetch, null, null)).toBeNull();
    expect(acceptProblem(undefined, null, null)).toMatch(/nothing/);
    expect(acceptProblem(fetch, record(fetch), record(fetch))).toMatch(/already on it/);
    const older = { ...quest, id: "2026-01-01:x" };
    expect(acceptProblem(fetch, record(older), null)).toMatch(/Finish the job/);
    expect(acceptProblem(fetch, null, record(fetch, { doneAt: 5 }))).toMatch(/tomorrow/);
    expect(acceptProblem(trade, null, null)).toMatch(/trade/);
  });

  it("hands in a fetch only with every piece in hand", () => {
    const short: Resources = { ...fetch.need };
    const k = RESOURCE_KINDS.find((x) => fetch.need[x])!;
    short[k] = fetch.need[k]! - 1;
    const player = (resources: Resources, handedInToday = 0) => ({ resources, handedInToday, facts: NO_FACTS });
    expect(handInProblem(record(fetch), player(short))).toMatch(/You need 1 more/);
    expect(handInProblem(record(fetch), player(fetch.need))).toBeNull();
    expect(handInProblem(record(fetch, { doneAt: 9 }), player(plenty))).toMatch(/no job/);
    expect(handInProblem(null, player(plenty))).toMatch(/no job/);
  });

  it("hands in a quest only once the deed is done", () => {
    expect(handInProblem(record(quest), { resources: {}, handedInToday: 0, facts: NO_FACTS })).toMatch(/Not done yet/);
    expect(handInProblem(record(quest), { resources: {}, handedInToday: 0, facts: { ...NO_FACTS, rested: true } })).toBeNull();
    expect(questMet("give", { ...NO_FACTS, gave: true })).toBe(true);
    expect(questMet("voyage", { ...NO_FACTS, metContract: true })).toBe(false);
    expect(questMet("contract", { ...NO_FACTS, metContract: true })).toBe(true);
    expect(questMet("voyage", { ...NO_FACTS, wonVoyage: true })).toBe(true);
  });

  it("stops at the day's cap", () => {
    expect(handInProblem(record(fetch), { resources: plenty, handedInToday: ERRANDS_PER_DAY - 1, facts: NO_FACTS })).toBeNull();
    expect(handInProblem(record(fetch), { resources: plenty, handedInToday: ERRANDS_PER_DAY, facts: NO_FACTS })).toMatch(/tomorrow/);
  });

  it("trades only with the materials, and only so many times", () => {
    expect(swapProblem(trade, null, plenty)).toBeNull();
    expect(swapProblem(trade, null, {})).toMatch(/You need/);
    expect(swapProblem(trade, record(trade, { count: TRADES_PER_DAY - 1 }), plenty)).toBeNull();
    expect(swapProblem(trade, record(trade, { count: TRADES_PER_DAY }), plenty)).toMatch(/tomorrow/);
    expect(swapProblem(fetch, null, plenty)).toMatch(/not trading/);
  });

  it("shows what is held toward a job", () => {
    const k = RESOURCE_KINDS.find((x) => fetch.need[x])!;
    const p = errandProgress(fetch, { [k]: 1 }, NO_FACTS);
    expect(p.have[k]).toBe(1);
    expect(p.ready).toBe(false);
    expect(errandProgress(fetch, plenty, NO_FACTS)).toMatchObject({ ready: true, have: fetch.need });
    expect(errandProgress(quest, {}, { ...NO_FACTS, rested: true }).ready).toBe(true);
  });
});
