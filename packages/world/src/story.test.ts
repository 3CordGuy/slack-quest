import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  ENEMIES,
  STORY_FRAMES,
  buildBible,
  clientView,
  createWorld,
  demandMet,
  factPoi,
  frameById,
  generateMap,
  makeRng,
  poiById,
  requiredDoom,
  seedFromString,
  stepWorld,
  storyHints,
  validateBible,
  type Demand,
  type HeroInit,
  type StoryFrame,
  type WorldAction,
  type WorldState,
} from "./index";

const hero = (id: string, classId: string, weapon: string): HeroInit => ({
  id, name: id.toUpperCase(), classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, bonus: {}, weapon, weaponPower: 0, armor: 0,
});

function must(state: WorldState, action: WorldAction): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  return res.state;
}

function begin(frame: StoryFrame, demand: Demand, seed: string): WorldState {
  let s = createWorld("TEST", seed);
  s = must(s, { type: "join", hero: hero("p1", "qa_paladin", "mace") });
  s = must(s, { type: "join", hero: hero("p2", "devops_mage", "staff") });
  s = must(s, { type: "ready", heroId: "p2", ready: true });
  s = must(s, { type: "start", heroId: "p1" });
  const rng = makeRng(seedFromString(`story|${seed}`));
  const fill = rng.pick(CANNED_FILLS[frame.id]);
  s = must(s, { type: "begin", bible: buildBible(frame, fill, demand, rng) });
  // Strong enough that fights are won whatever the dice do: these tests are about the story's shape.
  return { ...s, heroes: s.heroes.map((h) => ({ ...h, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 900, maxHp: 900 })) };
}

/**
 * Play a story to its end the way a party would, one unmet objective at a
 * time, teleporting instead of walking. Returns the final state and the
 * order things were done in.
 */
function playThrough(frame: StoryFrame, demand: Demand, seed: string): { state: WorldState; steps: string[] } {
  let s = begin(frame, demand, seed);
  const steps: string[] = [];
  const goTo = (poiId: string) => {
    const pos = poiById(s.map, poiId)!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
  };
  const act = (poiId: string) => {
    goTo(poiId);
    if (s.turn!.acted) s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    for (let i = 0; i < 200 && s.phase === "battle"; i++) s = must(s, { type: "timeout" });
    steps.push(`act:${poiId}`);
  };
  const talk = (intent: { verb: string; args: Record<string, unknown> } | null) => {
    goTo("hut");
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "hello" });
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "…", intent, attitudeDelta: 0 } });
    steps.push(intent ? `talk:${intent.verb}` : "talk");
  };
  const earn = (fact: string) => {
    const [kind, ref] = fact.split(":");
    if (kind === "met") return talk(null);
    if (kind === "defeated" || kind === "searched" || kind === "prayed") return act(ref);
    if (kind === "revealed") {
      // Told by the NPC, once whatever they asked for is done.
      const bible = s.bible!;
      if (!demandMet(bible, s.facts, s.npcs.npc1.persuaded)) {
        if (bible.demand.fact) earn(bible.demand.fact);
        else s = { ...s, npcs: { npc1: { ...s.npcs.npc1, persuaded: true } } };
      }
      return talk({ verb: "reveal_location", args: { poi: ref } });
    }
    const rite = s.bible!.rites.find((r) => r.sets === fact);
    if (!rite) throw new Error(`nothing sets ${fact}`);
    return act(rite.poi);
  };
  for (let i = 0; i < 30 && s.phase !== "ended"; i++) {
    const next = s.bible!.objectives.find((o) => !s.facts[o.fact]);
    if (!next) break;
    earn(next.fact);
  }
  return { state: s, steps };
}

describe("story shapes", () => {
  it("offers several different kinds of story", () => {
    expect(STORY_FRAMES.map((f) => f.id)).toEqual(["stolen_relic", "rescue", "beast_hunt", "broken_relic"]);
    // They differ in how they end, not only in their words.
    const finals = STORY_FRAMES.map((f) => {
      const b = buildBible(f, CANNED_FILLS[f.id][0]);
      return b.objectives.find((o) => o.id === b.finalObjective)!.fact.split(":")[0];
    });
    expect(new Set(finals).size).toBeGreaterThanOrEqual(3);
    for (const f of STORY_FRAMES) expect(CANNED_FILLS[f.id].length).toBeGreaterThanOrEqual(2);
  });

  it("builds a completable story for every shape, demand and island", () => {
    for (const frame of STORY_FRAMES) {
      for (const demand of frame.demands) {
        for (let i = 0; i < 12; i++) {
          const seed = `${frame.id}-${demand.id}-${i}`;
          const map = generateMap(seed);
          const rng = makeRng(seedFromString(seed));
          for (const fill of CANNED_FILLS[frame.id]) {
            const bible = buildBible(frame, fill, demand, rng);
            expect(validateBible(bible, map), seed).toEqual([]);
            for (const enemies of Object.values(bible.encounters)) expect(enemies.every((k) => ENEMIES[k])).toBe(true);
          }
        }
      }
    }
  });

  it("can be played to victory, whatever the shape and whatever the islander asks", () => {
    for (const frame of STORY_FRAMES) {
      for (const demand of frame.demands) {
        const { state, steps } = playThrough(frame, demand, `play-${frame.id}-${demand.id}`);
        expect(state.result?.outcome, `${frame.id} / ${demand.id}: ${steps.join(" ")}`).toBe("victory");
        expect(state.bible!.objectives.every((o) => state.facts[o.fact])).toBe(true);
        expect(state.result!.reason).toBe(state.bible!.victoryLine);
      }
    }
  });

  it("gives the shapes different things to do", () => {
    const stepsOf = (id: string) => playThrough(frameById(id)!, frameById(id)!.demands.find((d) => d.id === "earn_trust")!, `shape-${id}`).steps.join(" ");
    expect(stepsOf("stolen_relic")).toBe("talk talk:reveal_location act:lair");
    // The rescue's last step is a walk home, not a fight.
    expect(stepsOf("rescue")).toBe("talk talk:reveal_location act:lair act:hut");
    // The hunt never asks anyone the way.
    expect(stepsOf("beast_hunt")).toBe("talk act:cache1 act:cache2 act:lair");
    // Three pieces, then the shrine.
    expect(stepsOf("broken_relic")).toBe("talk act:camp act:cache2 talk:reveal_location act:lair act:shrine");
  });

  it("sizes the doom clock to each story's own route", () => {
    for (const frame of STORY_FRAMES) {
      for (const demand of frame.demands) {
        const s = begin(frame, demand, `doom-${frame.id}-${demand.id}`);
        expect(s.doom).toBeGreaterThanOrEqual(frame.doomRounds);
        expect(s.doom).toBeGreaterThanOrEqual(requiredDoom(s.map, s.bible!, s.heroes));
        // An errand for the islander puts the trip out and back on the route.
        const errand = factPoi(demand.fact);
        if (errand && !frame.plan(CANNED_FILLS[frame.id][0], makeRng(1)).route.includes(errand)) {
          const route = s.bible!.route;
          expect(route.slice(route.indexOf("hut"), route.indexOf("hut") + 3)).toEqual(["hut", errand, "hut"]);
        }
      }
    }
  });
});

describe("rites and triggers", () => {
  const rescue = frameById("rescue")!;
  const hunt = frameById("beast_hunt")!;
  const broken = frameById("broken_relic")!;

  it("does not let a rite happen before what it needs", () => {
    let s = begin(rescue, rescue.demands[1], "rite-early");
    const pos = poiById(s.map, "hut")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
    expect(clientView(s, "p1").story!.rites).toEqual([{ id: "return", poi: "hut", label: expect.stringContaining("home"), ready: false, done: false }]);
    expect(stepWorld(s, { type: "interact", heroId: s.turn!.heroId }).ok).toBe(false);
    s = { ...s, facts: { ...s.facts, "defeated:lair": true } };
    expect(clientView(s, "p1").story!.rites[0].ready).toBe(true);
    const res = stepWorld(s, { type: "interact", heroId: s.turn!.heroId });
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toContainEqual(expect.objectContaining({ t: "rite" }));
    expect(res.state.result?.outcome).toBe("victory");
  });

  it("restores the relic at the shrine only with all three pieces, and otherwise just prays", () => {
    let s = begin(broken, broken.demands[0], "shrine");
    const pos = poiById(s.map, "shrine")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })), facts: { ...s.facts, "defeated:camp": true, "searched:cache2": true } };
    const pray = stepWorld(s, { type: "interact", heroId: s.turn!.heroId });
    if (!pray.ok) throw new Error(pray.error);
    expect(pray.state.facts["prayed:shrine"]).toBe(true);
    expect(pray.state.phase).toBe("overworld");
    s = { ...pray.state, facts: { ...pray.state.facts, "defeated:lair": true } };
    s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    expect(s.result?.outcome).toBe("victory");
  });

  it("reveals the den once both sets of signs are found", () => {
    let s = begin(hunt, hunt.demands[1], "signs");
    expect(s.bible!.npcs[0].capabilities.some((c) => c.verb === "reveal_location")).toBe(false);
    for (const cache of ["cache1", "cache2"]) {
      expect(poiById(s.map, "lair")!.hidden).toBe(true);
      const pos = poiById(s.map, cache)!.pos;
      s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
      if (s.turn!.acted) s = must(s, { type: "end_turn", heroId: s.turn!.heroId });
      s = must(s, { type: "interact", heroId: s.turn!.heroId });
    }
    expect(poiById(s.map, "lair")!.hidden).toBe(false);
    expect(poiById(s.map, "lair")!.enemies).toEqual(["alpha", "wolf"]);
    expect(clientView(s, "p1").story!.poiNames.cache1).toBe("Tracks near the shore");
  });

  it("names a beast or guardian boss after the story's villain", () => {
    let s = begin(hunt, hunt.demands[1], "boss-name");
    const pos = poiById(s.map, "lair")!.pos;
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
    s = must(s, { type: "interact", heroId: s.turn!.heroId });
    expect(s.battle!.combatants.find((c) => c.kind === "alpha")!.name).toBe(s.bible!.villain.name);
    expect(s.battle!.boss).toBe(true);
  });

  it("rejects a story whose ending nothing can reach", () => {
    const map = generateMap("broken");
    const bible = buildBible(rescue, CANNED_FILLS.rescue[0]);
    expect(validateBible({ ...bible, rites: [] }, map).some((p) => p.includes("nothing sets returned:hut"))).toBe(true);
    expect(validateBible({ ...bible, encounters: { lair: ["dragon"] } }, map).some((p) => p.includes("unknown enemy"))).toBe(true);
    expect(validateBible({ ...bible, rites: [{ ...bible.rites[0], requires: ["searched:nowhere"] }] }, map).some((p) => p.includes("no cache nowhere"))).toBe(true);
  });
});

describe("hints", () => {
  it("draws what was taken and who took it from the story's own lists", () => {
    const rescue = frameById("rescue")!;
    for (let i = 0; i < 30; i++) {
      const h = storyHints(makeRng(i), rescue);
      expect(rescue.hints!.relic).toContain(h.relic);
      expect(rescue.hints!.villain).toContain(h.villain);
    }
  });
});
