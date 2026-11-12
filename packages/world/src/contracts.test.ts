import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  CLIENT_ACTIONS,
  CONTRACTS,
  CREW_GOALS,
  PERFECTS_NEEDED,
  STORY_FRAMES,
  SWIFT_DAYS,
  buildBible,
  clientView,
  contractById,
  contractMet,
  createWorld,
  crewGoalProgress,
  generateMap,
  goalPeriod,
  goalPeriodEnd,
  pickCrewGoal,
  poiById,
  rewardText,
  stepWorld,
  tallyBattle,
  upgradeWorld,
  type ContractView,
  type CrewGoalDef,
  type Hero,
  type HeroInit,
  type WorldAction,
  type WorldEffect,
  type WorldEvent,
  type WorldState,
} from "./index";

interface Sink {
  events: WorldEvent[];
  effects: WorldEffect[];
}
const newSink = (): Sink => ({ events: [], effects: [] });

function heroInit(id: string, classId: string, weapon: string): HeroInit {
  return { id, name: id.toUpperCase(), classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, bonus: {}, weapon, weaponPower: 0, armor: 0 };
}

function must(state: WorldState, action: WorldAction, sink?: Sink): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  sink?.events.push(...res.events);
  sink?.effects.push(...res.effects);
  return res.state;
}

/** Two heroes aboard, still in the lobby. */
function lobby(seed = "contracts"): WorldState {
  let s = createWorld("ABCD", seed);
  s = must(s, { type: "join", hero: heroInit("p1", "qa_paladin", "mace") });
  return must(s, { type: "join", hero: heroInit("p2", "devops_mage", "staff") });
}

/** Set sail on the first story frame, whose last objective is winning the fight at the lair. */
function sail(s: WorldState): WorldState {
  s = must(s, { type: "ready", heroId: "p2", ready: true });
  s = must(s, { type: "start", heroId: "p1" });
  return must(s, { type: "begin", bible: buildBible(STORY_FRAMES[0], CANNED_FILLS.stolen_relic[0]) });
}

/** Put the party at the lair, strong (or weak) enough that the fight has one outcome, and play it out. */
function fightLair(s: WorldState, sink: Sink, win = true): WorldState {
  const pos = poiById(s.map, "lair")!.pos;
  const stat = win ? 12 : 1;
  const hp = win ? 200 : 1;
  s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos, base: { str: stat, int_stat: stat, vit: stat, agi: stat, dex: stat }, hp, maxHp: hp })) };
  s = must(s, { type: "interact", heroId: s.turn!.heroId }, sink);
  for (let i = 0; i < 200 && s.phase === "battle"; i++) s = must(s, { type: "timeout" }, sink);
  expect(s.phase).toBe("ended");
  expect(s.result!.outcome).toBe(win ? "victory" : "defeat");
  return s;
}

const goldTo = (sink: Sink, heroId: string) =>
  sink.effects.reduce((a, e) => a + (e.kind === "grant" && e.heroId === heroId ? e.gold : 0), 0);

describe("contract checks", () => {
  const map = generateMap("checks");
  const view = (over: Partial<ContractView> = {}): ContractView => ({ facts: {}, doom: 0, map: structuredClone(map), ...over });
  const hero = (tally: Hero["tally"] = undefined) => ({ id: "p1", tally });
  const prayed = () => {
    const v = view();
    v.map.pois.find((p) => p.kind === "shrine")!.usedBy.push("p1");
    return v;
  };

  // For every contract: a voyage that meets it, and one that does not.
  const cases: Record<string, { met: [ContractView, ReturnType<typeof hero>]; unmet: [ContractView, ReturnType<typeof hero>] }> = {
    scavenger: {
      met: [view({ facts: { "searched:cache1": true, "searched:cache2": true } }), hero()],
      unmet: [view({ facts: { "searched:cache1": true } }), hero()],
    },
    camp: { met: [view({ facts: { "defeated:camp": true } }), hero()], unmet: [view({ facts: { "defeated:lair": true } }), hero()] },
    swift: { met: [view({ doom: SWIFT_DAYS }), hero()], unmet: [view({ doom: SWIFT_DAYS - 1 }), hero()] },
    sober: { met: [view(), hero({ perfects: 2 })], unmet: [view(), hero({ potions: 1 })] },
    flawless: { met: [view(), hero({ perfects: PERFECTS_NEEDED })], unmet: [view(), hero({ perfects: PERFECTS_NEEDED - 1 })] },
    pilgrim: { met: [prayed(), hero()], unmet: [prayed(), { id: "p2", tally: undefined }] },
    unbowed: { met: [view(), hero()], unmet: [view(), hero({ downs: 1 })] },
    silver: { met: [view(), hero({ persuaded: 1 })], unmet: [view(), hero()] },
  };

  it("has a case for every contract, with unique ids and a reward", () => {
    expect(Object.keys(cases).sort()).toEqual(CONTRACTS.map((c) => c.id).sort());
    expect(new Set(CONTRACTS.map((c) => c.id)).size).toBe(CONTRACTS.length);
    expect(CONTRACTS.length).toBeGreaterThanOrEqual(6);
    for (const c of CONTRACTS) expect(c.reward.gold).toBeGreaterThan(0);
  });

  for (const def of CONTRACTS) {
    it(`${def.id}: true when met, false when not`, () => {
      expect(def.check(...cases[def.id].met)).toBe(true);
      expect(def.check(...cases[def.id].unmet)).toBe(false);
    });
  }

  it("describes a reward in words", () => {
    expect(rewardText({ gold: 30, resources: { fur: 2, wood: 1 } })).toBe("30 gold, 1 Wood, 2 Fur");
    expect(rewardText({ gold: 40 })).toBe("40 gold");
  });

  it("can be judged from what a client is shown", () => {
    let s = must(lobby(), { type: "contract", heroId: "p1", contractId: "sober" });
    s = sail(s);
    const seen = clientView(s, "p1");
    expect(contractMet(seen, seen.heroes[0])).toBe(true);
    expect(contractMet(seen, seen.heroes[1])).toBe(false); // took none
  });
});

describe("taking a contract", () => {
  it("is a client action, stored on the hero, and can be swapped or put back in the lobby", () => {
    expect(CLIENT_ACTIONS.has("contract")).toBe(true);
    let s = must(lobby(), { type: "contract", heroId: "p1", contractId: "swift" });
    expect(s.heroes[0].contract).toEqual({ id: "swift" });
    expect(s.heroes[1].contract).toBeUndefined();
    s = must(s, { type: "contract", heroId: "p1", contractId: "camp" });
    expect(s.heroes[0].contract).toEqual({ id: "camp" });
    s = must(s, { type: "contract", heroId: "p1", contractId: null });
    expect(s.heroes[0].contract).toBeUndefined();
  });

  it("refuses an unknown contract and a stranger", () => {
    const s = lobby();
    expect(stepWorld(s, { type: "contract", heroId: "p1", contractId: "free_money" })).toEqual({ ok: false, error: "no such contract" });
    expect(stepWorld(s, { type: "contract", heroId: "nobody", contractId: "swift" }).ok).toBe(false);
  });

  it("is refused once the ship has sailed", () => {
    let s = must(lobby(), { type: "ready", heroId: "p2", ready: true });
    s = must(s, { type: "start", heroId: "p1" });
    expect(stepWorld(s, { type: "contract", heroId: "p1", contractId: "swift" }).ok).toBe(false); // generating
    s = must(s, { type: "begin", bible: buildBible(STORY_FRAMES[0], CANNED_FILLS.stolen_relic[0]) });
    expect(stepWorld(s, { type: "contract", heroId: "p2", contractId: "swift" }).ok).toBe(false); // overworld
    const ended = fightLair(s, newSink());
    expect(stepWorld(ended, { type: "contract", heroId: "p1", contractId: "swift" }).ok).toBe(false);
    expect(stepWorld(ended, { type: "contract", heroId: "p1", contractId: null }).ok).toBe(false);
  });
});

describe("settling contracts", () => {
  // p1 takes one the lair fight always meets (timeouts never drink a potion); p2 takes one it never does.
  function contracted(): WorldState {
    let s = must(lobby(), { type: "contract", heroId: "p1", contractId: "sober" });
    return must(s, { type: "contract", heroId: "p2", contractId: "scavenger" });
  }

  it("pays a met contract through grant on victory, and only that one", () => {
    const base = newSink();
    fightLair(sail(lobby()), base);

    const sink = newSink();
    const s = fightLair(sail(contracted()), sink);
    const reward = contractById("sober")!.reward.gold;
    expect(s.heroes[0].contract).toEqual({ id: "sober", outcome: "met" });
    expect(s.heroes[1].contract).toEqual({ id: "scavenger", outcome: "failed" });
    expect(sink.events.filter((e) => e.t === "contract")).toEqual([
      { t: "contract", heroId: "p1", contractId: "sober", met: true },
      { t: "contract", heroId: "p2", contractId: "scavenger", met: false },
    ]);
    // Same seed and actions as the voyage without contracts: the only difference is the bonus.
    expect(goldTo(sink, "p1")).toBe(goldTo(base, "p1") + reward);
    expect(goldTo(sink, "p2")).toBe(goldTo(base, "p2"));
    expect(s.earned.p1.gold).toBe(goldTo(sink, "p1"));
    expect(sink.effects.filter((e) => e.kind === "grant" && e.heroId === "p1" && e.gold === reward && e.xp === 0)).toHaveLength(1);
  });

  it("hands over a contract's resources with its gold", () => {
    let s = must(lobby(), { type: "contract", heroId: "p1", contractId: "scavenger" });
    s = sail(s);
    s = { ...s, facts: { ...s.facts, "searched:cache1": true, "searched:cache2": true } };
    const sink = newSink();
    s = fightLair(s, sink);
    expect(s.earned.p1.resources).toEqual(contractById("scavenger")!.reward.resources);
    expect(sink.effects).toContainEqual(expect.objectContaining({ kind: "grant", heroId: "p1", gold: 25, resources: { wood: 2 } }));
  });

  it("pays once: nothing after the ending can settle it again", () => {
    const sink = newSink();
    let s = fightLair(sail(contracted()), sink);
    const paid = goldTo(sink, "p1");
    const after = newSink();
    s = must(s, { type: "epilogue", text: "The end." }, after);
    expect(stepWorld(s, { type: "timeout" }).ok).toBe(false);
    expect(after.effects).toEqual([]);
    expect(after.events.filter((e) => e.t === "contract")).toEqual([]);
    expect(s.earned.p1.gold).toBe(paid);
    expect(sink.events.filter((e) => e.t === "contract" && e.heroId === "p1")).toHaveLength(1);
  });

  it("pays nothing on a lost story, even when the terms were met", () => {
    const sink = newSink();
    const s = fightLair(sail(contracted()), sink, false);
    expect(s.heroes[0].tally?.potions ?? 0).toBe(0); // "sober" would have been met
    expect(s.heroes[0].contract).toEqual({ id: "sober", outcome: "failed" });
    expect(sink.events).toContainEqual({ t: "contract", heroId: "p1", contractId: "sober", met: false });
    expect(sink.effects.filter((e) => e.kind === "grant")).toEqual([]);
    expect(s.earned.p1).toBeUndefined();
  });
});

describe("tallies", () => {
  it("counts potions, perfect abilities and falls in battle", () => {
    let s = sail(lobby("tally"));
    const pos = poiById(s.map, "camp")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 200, maxHp: 200, focus: 9, maxFocus: 9 })) };
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    const actor = () => s.battle!.order[s.battle!.turn];
    const first = actor();
    s = must(s, { type: "battle", heroId: first, action: { type: "potion" } });
    expect(s.heroes.find((h) => h.id === first)!.tally).toEqual({ potions: 1 });
    // Focus guarantees every roll, so the result is perfect whatever the seed.
    const second = actor();
    const ability = s.battle!.combatants.find((c) => c.id === second)!.abilities[0];
    const before = s.heroes.find((h) => h.id === second)!.tally?.perfects ?? 0;
    s = must(s, { type: "battle", heroId: second, action: { type: "ability", ability, focus: 2 } });
    expect(s.heroes.find((h) => h.id === second)!.tally?.perfects ?? 0).toBeGreaterThanOrEqual(before + 1);
  });

  it("counts a hero going down, and ignores enemies", () => {
    const heroes = [{ id: "p1" } as Hero, { id: "p2" } as Hero];
    tallyBattle(heroes, [{ t: "down", id: "e0" }, { t: "down", id: "p2" }]);
    expect(heroes[0].tally).toBeUndefined();
    expect(heroes[1].tally).toEqual({ downs: 1 });
  });

  it("counts a successful persuasion for the hero who made it", () => {
    let s = sail(lobby("tally"));
    const pos = poiById(s.map, "hut")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos, focus: 3, maxFocus: 3 })) };
    s = must(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "trust me", persuade: true, focus: 3 });
    expect(s.heroes.find((h) => h.id === "p2")!.tally).toEqual({ persuaded: 1 });
    expect(s.heroes.find((h) => h.id === "p1")!.tally).toBeUndefined();
  });
});

describe("voyages saved before contracts", () => {
  it("still step, fight and end without the new fields", () => {
    let s = sail(lobby("old-save"));
    // What storage held before this change: no contract, no tally.
    const saved = JSON.parse(JSON.stringify(s)) as WorldState;
    for (const h of saved.heroes) {
      delete h.contract;
      delete h.tally;
    }
    s = upgradeWorld(saved);
    s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
    const sink = newSink();
    s = fightLair(s, sink);
    expect(sink.events.filter((e) => e.t === "contract")).toEqual([]);
    expect(s.heroes.every((h) => h.contract === undefined)).toBe(true);
    // And a contract is judged sensibly against a hero with nothing counted.
    expect(contractById("sober")!.check(s, { id: "p1", tally: undefined })).toBe(true);
    expect(contractById("flawless")!.check(s, { id: "p1", tally: undefined })).toBe(false);
  });
});

describe("crew goals", () => {
  const goal = (id: string) => CREW_GOALS.find((g) => g.id === id) as CrewGoalDef;
  const none = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };

  it("names a period by its ISO week, Monday to Sunday in UTC", () => {
    expect(goalPeriod(Date.UTC(2026, 10, 11))).toBe("2026-W46"); // a Wednesday
    expect(goalPeriod(Date.UTC(2026, 10, 9))).toBe("2026-W46"); // that Monday, 00:00
    expect(goalPeriod(Date.UTC(2026, 10, 15, 23, 59))).toBe("2026-W46"); // that Sunday
    expect(goalPeriod(Date.UTC(2026, 10, 16))).toBe("2026-W47");
    expect(goalPeriod(Date.UTC(2027, 0, 1))).toBe("2026-W53"); // a Friday: still the old year's last week
    expect(goalPeriod(Date.UTC(2024, 11, 30))).toBe("2025-W01"); // a Monday that opens the new year's first week
    expect(goalPeriodEnd(Date.UTC(2026, 10, 11, 13))).toBe(Date.UTC(2026, 10, 16));
  });

  it("picks the same goal for a crew and period every time, and never last period's", () => {
    expect(pickCrewGoal("CREWAB", "2026-W46").id).toBe(pickCrewGoal("CREWAB", "2026-W46").id);
    for (let week = 10; week < 40; week++) {
      const first = pickCrewGoal("CREWAB", `2026-W${week}`);
      expect(pickCrewGoal("CREWAB", `2026-W${week}`, first.id).id).not.toBe(first.id);
    }
    const seen = new Set(Array.from({ length: 60 }, (_, i) => pickCrewGoal(`C${i}`, "2026-W46").id));
    expect(seen.size).toBe(CREW_GOALS.length);
  });

  it("counts a won voyage, and not a lost one", () => {
    const won = { ...none, events: [{ t: "ended", outcome: "victory", reason: "" } as WorldEvent] };
    const lost = { ...none, events: [{ t: "ended", outcome: "defeat", reason: "" } as WorldEvent] };
    expect(crewGoalProgress(goal("voyages"), { battle: null }, won)).toBe(1);
    expect(crewGoalProgress(goal("voyages"), { battle: null }, lost)).toBe(0);
    expect(crewGoalProgress(goal("hunt_wolf"), { battle: null }, won)).toBe(0);
  });

  it("counts fulfilled contracts", () => {
    const events: WorldEvent[] = [
      { t: "contract", heroId: "p1", contractId: "sober", met: true },
      { t: "contract", heroId: "p2", contractId: "swift", met: false },
    ];
    expect(crewGoalProgress(goal("contracts"), { battle: null }, { ...none, events })).toBe(1);
  });

  it("counts fallen enemies of the hunted kind only", () => {
    let s = sail(lobby("hunt"));
    const camp = poiById(s.map, "camp")!;
    camp.enemies = ["wolf", "bandit", "wolf"];
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos: camp.pos, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 200, maxHp: 200 })) };
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    let wolves = 0;
    let bandits = 0;
    for (let i = 0; i < 100 && s.phase === "battle"; i++) {
      const res = stepWorld(s, { type: "timeout" });
      if (!res.ok) throw new Error(res.error);
      wolves += crewGoalProgress(goal("hunt_wolf"), s, res);
      bandits += crewGoalProgress(goal("hunt_bandit"), s, res);
      s = res.state;
    }
    expect(s.phase).toBe("overworld");
    expect(wolves).toBe(2);
    expect(bandits).toBe(1);
  });

  it("counts resources brought home", () => {
    const effects: WorldEffect[] = [
      { kind: "grant", heroId: "p1", xp: 0, gold: 5, item: null, resources: { wood: 3, stone: 1 } },
      { kind: "grant", heroId: "p2", xp: 0, gold: 5, item: null, resources: { wood: 1 } },
      { kind: "grant", heroId: "p2", xp: 10, gold: 0, item: null },
    ];
    expect(crewGoalProgress(goal("haul_wood"), { battle: null }, { ...none, effects })).toBe(4);
  });
});
